# Realtime event stream

`GET /api/v1/events/stream` is a WebSocket that pushes mail events as they happen. `GET /api/v1/events/sse` is the same stream as Server-Sent Events, for clients that cannot open a WebSocket.

The events are the webhook events, with the same JSON payloads:

| Type | When |
|---|---|
| `message.received` | Inbound mail was stored |
| `message.sent` | A message was handed to the provider |
| `message.delivery_failed` | The provider refused or failed it |
| `message.bounced` | A bounce came back |
| `message.opened` / `message.clicked` | Tracking recorded an open or a click |

Webhooks remain the durable channel: a webhook delivery is retried for hours. The stream is for clients that are connected and want low latency. It keeps 24 hours of events, so a client that drops can catch up.

## Authentication and authorization

- Use the usual credentials: `Authorization: Bearer ttk_…` or the session cookie. Browsers can't set headers on a WebSocket, so the web app uses the cookie.
- An API token needs the `mail:read` scope.
- You only receive events for mailboxes you can read. That means your grant, intersected with the token's mailbox list, with `read` not revoked. This is checked for every event, whatever you subscribed to.
- Authorization is re-checked while the connection is open, not only when it opens:
  - The object polls the auth epoch every 5 seconds, the same counter that bounds the request path's credential cache. When the epoch changes, every session and token is re-validated. They're also re-validated every 30 seconds regardless. Each distinct credential is checked once, however many connections share it.
  - A revoked or expired session or token, or a disabled user, gets `{"type":"credential_revoked"}` and a close with code `4401`.
  - Mailbox grants are re-read on the same cadence. A mailbox you can no longer read gets `{"type":"subscription_revoked","mailbox":…}`, and its events stop. The connection stays open for the others.
  - If the check itself can't run (the auth store is unreachable), every connection gets `{"type":"auth_unavailable"}` and a close with code `4503`. Reconnect with `since`.
- Every connection is also closed with code `4001` after an hour, or when its token expires, so a client re-authenticates at least that often. Cloudflare Access callers have no server-side session to re-check, so for them that hour is the bound, while their mailbox grants are still re-read every 30 seconds.

## WebSocket protocol

Connect, then subscribe:

```json
{ "type": "subscribe", "mailboxes": ["support@example.com"], "events": ["message.received"] }
```

- Omit `mailboxes` (or pass `[]`) for every mailbox you can read.
- Omit `events` for every type.
- Mailboxes you can't read are left out and listed in `denied`. They're never widened to anything else.
- Sending `subscribe` again replaces the subscription. `{"type":"unsubscribe"}` stops events, and `{"type":"ping"}` gets a `pong`.

Server frames:

| Frame | Meaning |
|---|---|
| `{"type":"hello","latest_id":N,"oldest_id":M,"readable":[…] \| "all","expires_at":ms,"limits":{…}}` | Sent on connect |
| `{"type":"subscribed","mailboxes":[…] \| "all","events":[…] \| "all","denied":[…]}` | Your subscription |
| `{"type":"event","id":N,"event":{…webhook payload…}}` | One event |
| `{"type":"replayed","count":N,"latest_id":N}` | Replay finished |
| `{"type":"replay_truncated","resume_from":N}` | More than 1000 to replay; reconnect with `since=resume_from` |
| `{"type":"cursor_expired","since":N,"oldest_id":M}` | Some events after your cursor are older than 24 hours and gone |
| `{"type":"overflow","resume_from":N}` | You fell behind; the server closes with `1013` |
| `{"type":"subscription_revoked","mailbox":…}` | You can no longer read that mailbox; its events stop |
| `{"type":"credential_revoked"}` | Your session or token was revoked or expired; the server closes with `4401` |
| `{"type":"auth_unavailable"}` | Authorization couldn't be re-checked; the server closes with `4503`. Reconnect with `since` |
| `{"type":"error","code":…,"error":…}` | A bad message from you; the connection stays open |

Event ids are monotonic across the whole deployment. Keep the highest `id` you've processed.

## Replay with `since`

`?since=<id>` on the URL (or `"since"` in the `subscribe` message) replays every retained event after that id that matches your subscription, then continues live. For SSE, the browser's automatic `Last-Event-ID` header does the same.

```js
let last = Number(localStorage.getItem("events:last") ?? 0);
function connect() {
  const ws = new WebSocket(`wss://mail.example.com/api/v1/events/stream?since=${last}`);
  ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", events: ["message.received"] }));
  ws.onmessage = (m) => {
    const frame = JSON.parse(m.data);
    if (frame.type === "event") {
      handle(frame.event);
      last = frame.id;
      localStorage.setItem("events:last", String(last));
    }
  };
  ws.onclose = () => setTimeout(connect, 2000);
}
connect();
```

## SSE

```bash
curl -N -H "Authorization: Bearer $CLOUDMAIL_TOKEN" \
  "https://mail.example.com/api/v1/events/sse?mailbox=support@example.com&event=message.received"
```

Each event arrives as `id: N`, `event: <type>`, `data: <webhook payload>`. Repeat `mailbox` and `event` to filter. A comment line every 25 seconds keeps proxies from closing the connection.

## Limits and backpressure

- Each user can hold 5 open connections (WebSocket and SSE together). The 6th is refused with `429`.
- A deployment can hold 500 connections. Past that, new connections get `503`.
- A subscription can name up to 100 mailboxes.
- Client messages are capped at 16 KiB.
- Each connection has a send budget of 500 events in a burst, refilling at 100 a second. A WebSocket that exceeds it, or has more than 1 MiB queued, gets an `overflow` frame with `resume_from` and is closed with `1013`. A full SSE stream is closed the same way. The client reconnects with `since` and replays, so slow clients catch up from the log rather than being buffered in memory.

## CLI

```bash
cloudmail events tail --mailbox support@example.com
cloudmail events tail --event message.received --output ndjson | jq .event.data.subject
cloudmail events tail --since 1042
```

`tail` reconnects on its own and resumes from the last id it printed. It stops on an auth or scope error, since a retry can't fix those.

## Deployment

The stream needs the `EVENTS` Durable Object binding (`EventsDO`, migration `v7` in `wrangler.jsonc`), which `wrangler deploy` creates. It needs no secret or variable. Without the binding, `/api/v1/events/*` answers `503` and mail handling is unaffected.

There is one `EventsDO` per deployment. MailboxDO feeds it from the same delivery ledger that feeds webhooks, but with its own cursor, so turning the stream on or off never affects webhook delivery. The inbound handler publishes `message.received` directly. WebSockets use the hibernation API, so idle connections don't keep the object in memory.

## OpenAPI

`/api/v1/openapi.json` lists both endpoints with their parameters and status codes. OpenAPI 3.1 can't describe the message exchange over a WebSocket, so the frames above are documented here only.
