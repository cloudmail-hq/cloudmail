# Rate limits

> How many requests a caller can make, how much mail a mailbox can send, and how to back off when you reach either limit.

## Request limit

| Surface | Limit |
| --- | --- |
| The API, `{{BASE_URL}}/api` | 600 requests a minute for each caller |
| The MCP server, `{{BASE_URL}}/mcp` | 120 requests a minute for each caller |

The limit is counted for each user, not for each IP address, so two people in one office do not share it. All of one user's tokens share that user's budget.

Over the limit, the answer is `429` with a `Retry-After` header:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 60
Content-Type: application/json

{"error":"Too many requests. Slow down and retry."}
```

Wait for the number of seconds in `Retry-After`, then carry on.

These are the limits a deployment ships with. The person who runs this deployment can change them in its configuration.

## Send caps

Each mailbox can send a set amount of mail, counted exactly:

| | Default | Highest an administrator can set |
| --- | --- | --- |
| Each hour | 20 messages | 1,000 |
| Each day | 100 messages | 10,000 |

A send over the cap answers `429` with `"code": "rate_limited"`. Nothing is sent.

[Get send limits](/docs/api/sending-health/get-send-limits) returns a mailbox's caps and how much of them is used. An administrator changes them in the mailbox's settings under **Send caps**, or with [Update send limits](/docs/api/sending-health/update-send-limits).

## Other limits

| Limit | Value |
| --- | --- |
| Rows in one message list page | 100 |
| Messages in one bulk action | 500 |
| Realtime connections for one user | 5 |
| Mailboxes one token can be limited to | 500 |

## Staying under the limit

- Do not poll message lists in a loop. Poll [the mailbox state](/docs/api/mailboxes/get-mailbox-state), which is small and tells you whether anything changed, or use [webhooks](/docs/guides/webhooks).
- Use [the bulk action](/docs/api/emails/bulk-email-action) to change many messages in one call.
- Ask for the page size you need with `limit`, up to 100, instead of many small pages.
- On `429`, wait for `Retry-After`. On `500`, `502` and `503`, back off from about a second and double each time.
- Send an [idempotency key](/docs/guides/idempotency) with every send, so a retry after a timeout cannot send twice.
