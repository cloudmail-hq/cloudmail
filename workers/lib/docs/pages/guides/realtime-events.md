# Realtime events

> Hold a WebSocket or Server-Sent Events connection open and receive mail events as they happen, with replay after a dropped connection.

The event stream pushes the same events as [webhooks](/docs/guides/webhooks), with the same JSON payloads, to a client that is connected.

| Endpoint | Transport |
| --- | --- |
| `GET /api/v1/events/stream` | [WebSocket](/docs/api/events/stream-events) |
| `GET /api/v1/events/sse` | [Server-Sent Events](/docs/api/events/stream-events-sse), for clients that cannot open a WebSocket |

Webhooks stay the durable channel: a webhook delivery is retried for hours. The stream is for clients that are online and want low latency. It keeps 24 hours of events, so a client that drops can catch up.

## Event types

| Type | When |
| --- | --- |
| `message.received` | Inbound mail was stored |
| `message.sent` | A message was handed to the mail provider |
| `message.delivery_failed` | The provider refused or failed it |
| `message.bounced` | A bounce came back |
| `message.opened`, `message.clicked` | Tracking recorded an open or a click |

## Who receives what

- Authenticate with `Authorization: Bearer $CLOUDMAIL_TOKEN`. The token needs the `mail:read` scope. Without it the endpoint answers `403` with `code: insufficient_scope`.
- You only receive events for mailboxes the token can read. That is checked for every event, whatever you subscribed to.
- Access is checked again while the connection is open, not only when it opens. A revoked token is cut off within seconds.

## Server-Sent Events

SSE is the simpler transport. The filter goes in the query string.

```bash
curl -N "{{BASE_URL}}/api/v1/events/sse?mailbox=support@example.com&event=message.received" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN"
```

- Repeat `mailbox` and `event` to follow several. Leave them out for every mailbox you can read and every type.
- Each event arrives as three lines: `id: N`, `event: <type>` and `data: <webhook payload>`.
- A comment line every 25 seconds keeps proxies from closing the connection.

```text
id: 1043
event: message.received
data: {"id":"evt_support@example.com_42","type":"message.received","created_at":"2026-11-24T12:00:00.000Z","mailbox":"support@example.com","data":{"id":"8c0e6a52","subject":"Question about my invoice"}}
```

## WebSocket

Connect, then send a subscribe message.

```json
{ "type": "subscribe", "mailboxes": ["support@example.com"], "events": ["message.received"] }
```

- Omit `mailboxes`, or pass `[]`, for every mailbox you can read.
- Omit `events` for every type.
- A subscription can name up to 100 mailboxes. Mailboxes you cannot read are left out and listed back to you in `denied`.
- Sending `subscribe` again replaces the subscription. `{"type":"unsubscribe"}` stops events. `{"type":"ping"}` gets a `pong`.

A plain `GET` to `/api/v1/events/stream` without a WebSocket upgrade answers `426`.

### Frames the server sends

| Frame | Meaning |
| --- | --- |
| `{"type":"hello","latest_id":N,"oldest_id":M,"readable":[...],"expires_at":ms,"limits":{...}}` | Sent on connect. `readable` is a list of mailboxes or `"all"`. |
| `{"type":"subscribed","mailboxes":[...],"events":[...],"denied":[...]}` | Your subscription. `mailboxes` and `events` can be `"all"`. |
| `{"type":"event","id":N,"event":{...}}` | One event. `event` is the webhook payload. |
| `{"type":"replayed","count":N,"latest_id":N}` | A replay finished. |
| `{"type":"replay_truncated","resume_from":N}` | More than 1,000 events to replay. Reconnect with `since=resume_from`. |
| `{"type":"cursor_expired","since":N,"oldest_id":M}` | Some events after your cursor are older than 24 hours and gone. |
| `{"type":"overflow","resume_from":N}` | You fell behind. The server closes with `1013`. |
| `{"type":"subscription_revoked","mailbox":"..."}` | You can no longer read that mailbox. Its events stop; the connection stays open. |
| `{"type":"credential_revoked"}` | Your token was revoked or expired. The server closes with `4401`. |
| `{"type":"auth_unavailable"}` | Access could not be re-checked. The server closes with `4503`. |
| `{"type":"error","code":"...","error":"..."}` | A bad message from you. The connection stays open. |

## Replay with since

Event ids are monotonic across the whole deployment. Keep the highest `id` you have processed.

Pass `?since=<id>` on the URL, or `"since"` in the `subscribe` message, to replay every retained event after that id that matches your subscription. The stream then continues live. With SSE, the `Last-Event-ID` header does the same, and browsers send it on their own when they reconnect.

```ts
import WebSocket from "ws";

let last = 0; // load this from your own storage

function connect() {
	// https:// becomes wss://
	const url = "{{BASE_URL}}".replace(/^http/, "ws") + "/api/v1/events/stream?since=" + last;
	const ws = new WebSocket(url, {
		headers: { Authorization: `Bearer ${process.env.CLOUDMAIL_TOKEN}` },
	});

	ws.on("open", () => {
		ws.send(JSON.stringify({ type: "subscribe", events: ["message.received"] }));
	});

	ws.on("message", (raw) => {
		const frame = JSON.parse(raw.toString());
		if (frame.type === "event") {
			handle(frame.event);
			last = frame.id; // save it
		}
		if (frame.type === "replay_truncated" || frame.type === "overflow") last = frame.resume_from;
	});

	ws.on("close", (code) => {
		if (code === 4401) return; // the token is no longer valid; a retry cannot fix that
		setTimeout(connect, 2000);
	});
}

connect();
```

Browsers cannot set headers on a WebSocket, so a browser client uses the session cookie. From a server, send the token as above.

## Close codes

| Code | Meaning | What to do |
| --- | --- | --- |
| `1013` | You fell behind and the send buffer filled. | Reconnect with `since` set to `resume_from`. |
| `4001` | The connection reached one hour, or the token's expiry. | Reconnect. Every connection is closed at least this often. |
| `4401` | The token or session was revoked or expired, or the user was disabled. | Stop. Get a new token. |
| `4503` | Access could not be re-checked. | Reconnect with `since`. |

## Limits

- Each user can hold 5 open connections, WebSocket and SSE together. The sixth is refused with `429`.
- A deployment can hold 500 connections. Past that, new connections get `503`.
- A message from the client can be up to 16 KiB.
- Each connection can receive a burst of 500 events, refilling at 100 a second. A WebSocket that goes over that, or has more than 1 MiB queued, gets an `overflow` frame and is closed with `1013`. A full SSE stream is closed the same way. Reconnect with `since` and the missed events are replayed.
- A replay returns at most 1,000 events at a time.

If the deployment was set up without the event stream, both endpoints answer `503` and nothing else changes.

## SDKs and the CLI

- [TypeScript SDK](/docs/sdks/typescript): `events.subscribe(...)` reconnects and resumes on its own. It uses SSE by default and can use a WebSocket.
- [Python SDK](/docs/sdks/python): `events.iter_sse(...)` yields events and reconnects with the last id.
- [CLI](/docs/sdks/cli): `cloudmail events tail --mailbox support@example.com`.
