# Webhooks

> Get a signed HTTP POST when mail arrives, is sent, bounces, is opened or clicked, and manage the endpoints through the API.

A webhook lets your backend react to mail without polling. You register an `https://` URL, pick the events you want, and the deployment POSTs a signed JSON event to it.

Managing webhooks needs a token with the `webhooks:manage` scope (or `admin`). Administrators can manage every webhook. A member can manage webhooks limited to mailboxes they hold the settings capability on, and cannot create one that covers every mailbox. A token limited to particular mailboxes can only manage webhooks inside those mailboxes.

## Events

| Event | Fires when |
| --- | --- |
| `message.received` | Inbound mail was stored in a mailbox. Mail filed to Spam is included with `data.spam: true`. Mail from blocked senders is not sent. |
| `message.sent` | The mail provider accepted an outgoing message. |
| `message.delivery_failed` | The send was refused or failed before reaching the recipient's server. |
| `message.bounced` | The recipient's server permanently rejected the message. |
| `message.opened` | The tracking pixel was loaded. |
| `message.clicked` | A tracked link was followed. `data.detail.url` names it. |
| `deliverability.warning` | A sending domain's 7-day spam complaint rate crossed 0.1%, or its bulk sending was paused at 0.3%. |
| `usage.budget_exceeded` | The projected monthly AI or email cost passed the budget an administrator set. Sent once per month per kind. |

[List event types](/docs/api/webhooks/list-webhook-events) returns this list and the retry policy, so you do not have to hardcode either.

## Create an endpoint

[Create a webhook](/docs/api/webhooks/create-webhook):

```bash
curl -X POST "{{BASE_URL}}/api/v1/webhooks" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: create-billing-webhook" \
  -d '{
    "name": "Billing",
    "url": "https://api.example.org/hooks/mail",
    "events": ["message.received", "message.bounced"],
    "mailboxes": ["support@example.com"]
  }'
```

```json
{
  "webhook": {
    "id": "wh_3f9a1c2b4d5e6f708192a3b4c5d6e7f8",
    "name": "Billing",
    "url": "https://api.example.org/hooks/mail",
    "events": ["message.received", "message.bounced"],
    "mailboxes": ["support@example.com"],
    "enabled": true,
    "disabledReason": null,
    "secretHint": "9c1d",
    "consecutiveFailures": 0
  },
  "secret": "whsec_5b0c..."
}
```

| Field | Meaning |
| --- | --- |
| `name` | A label, up to 100 characters. |
| `url` | A public `https://` URL. Private, loopback, link-local and internal hosts are refused, and redirects are not followed. |
| `events` | At least one event type. |
| `mailboxes` | Up to 100 mailbox addresses. Omit it or send `null` for every mailbox; only an administrator can do that. |
| `enabled` | Defaults to `true`. |

`secret` is the signing secret. It is returned only here and on rotate. Store it now. Later reads show only `secretHint`, its last four characters.

## The payload

The body never includes the message itself, only a summary:

```json
{
  "id": "evt_support@example.com_42",
  "type": "message.bounced",
  "created_at": "2026-11-24T12:00:00.000Z",
  "mailbox": "support@example.com",
  "data": {
    "id": "8c0e6a52-5d0f-4c8e-9a43-1f2f0c1f7b11",
    "thread_id": "8c0e6a52-5d0f-4c8e-9a43-1f2f0c1f7b11",
    "from": "support@example.com",
    "from_name": "Example Support",
    "to": ["customer@example.org"],
    "cc": [],
    "subject": "Your invoice",
    "snippet": "Hi, your invoice for October",
    "has_attachments": true,
    "labels": ["Billing"],
    "folder": "sent",
    "spam": false,
    "detail": { "recipient": "customer@example.org", "reason": "550 5.1.1 user unknown" }
  }
}
```

To get the body or the attachments, fetch the message with `data.id`; see [Reading mail](/docs/guides/reading-mail). `detail` appears on delivery and tracking events and can carry `recipient`, `reason`, `cause`, `url` and `source`.

Two events have a different `data` object:

- `deliverability.warning`: `{domain, level, spam_rate, complaints, delivered, window_days, bulk_paused, reason, source}`
- `usage.budget_exceeded`: `{kind, month, projected_usd, threshold_usd, used, unit}`

A test delivery has the same shape with `"test": true` at the top level.

## Headers

| Header | Value |
| --- | --- |
| `X-Tapetide-Event` | The event type. |
| `X-Tapetide-Delivery` | The delivery id. It is the same on every retry, so use it to drop repeats. |
| `X-Tapetide-Timestamp` | Unix time in seconds when this attempt was signed. |
| `X-Tapetide-Attempt` | The attempt number, starting at 1. |
| `X-Tapetide-Signature` | `v1=<hex>`, the signature described below. |

## Verify the signature

The signature is HMAC-SHA256 of `<timestamp>.<raw body>`, keyed with the whole endpoint secret (including the `whsec_` prefix), written as hex after `v1=`.

To verify a delivery:

1. Read the raw request body as bytes. Do not parse and re-serialise the JSON first; that changes the bytes and breaks the signature.
2. Reject it if `X-Tapetide-Timestamp` is more than five minutes from your clock.
3. Compute the HMAC and compare it to the header in constant time.

**Node:**

```ts
import crypto from "node:crypto";

export function verify(rawBody: string, headers: Record<string, string>, secret: string): boolean {
	const timestamp = headers["x-tapetide-timestamp"];
	const signature = headers["x-tapetide-signature"];
	if (!timestamp || !signature) return false;
	const age = Math.abs(Date.now() / 1000 - Number(timestamp));
	if (!(age <= 300)) return false; // also false when the header is not a number

	const expected = "v1=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
	const a = Buffer.from(signature);
	const b = Buffer.from(expected);
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

In Express, read the raw body with `express.raw({ type: "application/json" })`.

**Python:**

```python
import hashlib
import hmac
import time


def verify(raw_body: bytes, headers: dict, secret: str) -> bool:
    timestamp = headers.get("x-tapetide-timestamp")
    signature = headers.get("x-tapetide-signature")
    if not timestamp or not signature:
        return False
    try:
        age = abs(time.time() - int(timestamp))
    except ValueError:
        return False
    if age > 300:
        return False

    signed = timestamp.encode() + b"." + raw_body
    expected = "v1=" + hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, expected)
```

Both SDKs ship this check: `verifyWebhook` in the [TypeScript SDK](/docs/sdks/typescript) and `verify_webhook` in the [Python SDK](/docs/sdks/python).

## Delivery and retries

Answer with any `2xx` within 10 seconds. Do the real work after you respond.

Anything else counts as a failure and is retried after 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours. That is six attempts in all. Because a delivery can be retried, make your handler safe to run twice: keep the `X-Tapetide-Delivery` ids you have processed and skip one you have seen.

An endpoint that fails 20 times in a row over at least 12 hours is switched off. Its `enabled` becomes `false` and `disabledReason` says why. Switching it back on resets the count.

Events are handed off in the background, so a slow or broken endpoint never delays mail handling.

## Manage endpoints

All of these are under `/api/v1/webhooks`.

| Call | What it does |
| --- | --- |
| [List webhooks](/docs/api/webhooks/list-webhooks) | Returns `{"webhooks": [...]}` with the endpoints you can manage. |
| [Get a webhook](/docs/api/webhooks/get-webhook) | Returns `{"webhook": {...}}`. |
| [Update a webhook](/docs/api/webhooks/update-webhook) | `PATCH` any of `name`, `url`, `events`, `mailboxes`, `enabled`. |
| [Delete a webhook](/docs/api/webhooks/delete-webhook) | Removes the endpoint and its delivery log. |
| [Rotate the secret](/docs/api/webhooks/rotate-webhook-secret) | Returns a new `secret` once. The old one stops working at once. |
| [Send a test event](/docs/api/webhooks/test-webhook) | Sends a sample event now and returns the result. It is not retried. |
| [List deliveries](/docs/api/webhooks/list-webhook-deliveries) | Recent deliveries, newest first, with every attempt. |
| [Retry a delivery](/docs/api/webhooks/retry-webhook-delivery) | Re-sends one delivery now. |

Pause an endpoint without deleting it:

```bash
curl -X PATCH "{{BASE_URL}}/api/v1/webhooks/wh_3f9a1c2b4d5e6f708192a3b4c5d6e7f8" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "enabled": false }'
```

## Debug deliveries

Each endpoint keeps its last 100 deliveries. `limit` defaults to 50.

```bash
curl "{{BASE_URL}}/api/v1/webhooks/wh_3f9a1c2b4d5e6f708192a3b4c5d6e7f8/deliveries?limit=10" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN"
```

```json
{
  "deliveries": [
    {
      "id": "whd_7a1b2c3d4e5f60718293a4b5c6d7e8f9",
      "endpointId": "wh_3f9a1c2b4d5e6f708192a3b4c5d6e7f8",
      "eventId": "evt_support@example.com_42",
      "eventType": "message.bounced",
      "mailbox": "support@example.com",
      "status": "retrying",
      "attempts": 2,
      "nextAttemptAt": 1795521900000,
      "lastStatusCode": 500,
      "lastError": null,
      "lastDurationMs": 212,
      "test": false,
      "attemptLog": [
        { "attempt": 1, "statusCode": 500, "durationMs": 180, "error": null, "at": 1795521540000 },
        { "attempt": 2, "statusCode": 500, "durationMs": 212, "error": null, "at": 1795521600000 }
      ]
    }
  ]
}
```

`status` is `pending`, `retrying`, `delivered` or `failed`. Times are Unix milliseconds. A delivery that timed out has an `error` such as `Timed out after 10s` and no status code.

If you would rather hold a connection open than run a public endpoint, the [realtime event stream](/docs/guides/realtime-events) carries the same payloads.
