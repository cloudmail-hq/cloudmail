# Idempotency keys

> Send an Idempotency-Key header with every send and create, so a retry after a lost response never acts twice.

A request that timed out on the way back has usually already run. If it was a send, sending it again reaches the customer twice. An idempotency key lets you retry safely: the server runs the first request and answers every repeat with the stored result.

## Send the header

Add `Idempotency-Key` to the request. Use one key per logical operation, and reuse the same key when you retry that operation.

```bash
curl -X POST "{{BASE_URL}}/api/v1/mailboxes/support@example.com/emails" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-1234-confirmation" \
  -d '{
    "from": "support@example.com",
    "to": "customer@example.org",
    "subject": "Your order",
    "html": "<p>Thanks for your order.</p>"
  }'
```

A key is 1 to 256 printable ASCII characters. A UUID works well. So does an id from your own system, such as a job id or an order number, which makes a retry of the whole job safe. A key that breaks the format is refused with `400` and `code: invalid_idempotency_key`.

The header is optional. A request without it runs as usual, with no protection against a repeat.

## The rules

| Situation | Result |
| --- | --- |
| First request with a key | It runs. The status code and body are kept for 24 hours. |
| Same key, same body | The stored response is returned with the header `Idempotent-Replayed: true`. Nothing runs again. |
| Same key, different body | `409` with `code: idempotency_key_reused`. |
| Same key while the first request is still running | `409` with `code: idempotency_request_in_progress` and `Retry-After: 1`. Wait a second and retry. |
| The key store cannot be reached | `503` with `code: idempotency_unavailable` and `Retry-After: 1`. Nothing ran. Retry with the same key. |

### Which responses are kept

- `2xx` responses are kept and replayed. That includes a `202` `pending_approval`, so a retried send that was held returns the same hold instead of creating a second one.
- `4xx` responses are kept and replayed too, because the same request would fail the same way. The exceptions are `401`, `403`, `408` and `429`. Those describe your situation at that moment (a missing grant, a rate limit) and may change, so a retry runs again.
- `5xx` responses are not kept, so a retry can succeed.

Be careful with a `5xx` on a send. The server did not store a result, so a retry runs the send again, and the first attempt may already have gone out. Check whether the message is in the Sent folder before you retry.

### Scope of a key

A key belongs to the caller and the route:

- The caller is the user plus the API token. Two tokens never collide, even with the same key.
- The route is part of the key's scope, so the same key on two different endpoints is two separate operations.
- The exact path and query are compared along with the body. The same key on another mailbox or another message id is a mismatch.

The body is compared as canonical JSON, so the order of the keys in your JSON does not matter.

## Routes that accept a key

All of these are `POST`.

| Route | Endpoint |
| --- | --- |
| `/api/v1/mailboxes/{mailboxId}/emails` | [Send a message](/docs/api/emails/send-email) |
| `/api/v1/mailboxes/{mailboxId}/emails/{id}/reply` | [Reply](/docs/api/emails/reply-to-email) |
| `/api/v1/mailboxes/{mailboxId}/emails/{id}/forward` | [Forward](/docs/api/emails/forward-email) |
| `/api/v1/mailboxes/{mailboxId}/drafts` | [Save a draft](/docs/api/drafts/save-draft) |
| `/api/v1/mailboxes/{mailboxId}/scheduled-sends` | [Queue a message](/docs/api/scheduled-sends/schedule-send) |
| `/api/v1/mailboxes/{mailboxId}/scheduled-sends/{emailId}/send-now` | [Send a queued message now](/docs/api/scheduled-sends/send-scheduled-now) |
| `/api/v1/mailboxes/{mailboxId}/template-sends` | [Send a template](/docs/api/suppressions/send-template) |
| `/api/v1/mailboxes/{mailboxId}/emails/{id}/followup` | [Set a follow-up reminder](/docs/api/follow-ups/set-followup) |
| `/api/v1/mailboxes/{mailboxId}/emails/{id}/followup/cancel` | [Cancel a reminder](/docs/api/follow-ups/cancel-followup) |
| `/api/v1/mailboxes/{mailboxId}/screener/{sender}` | [Decide a screened sender](/docs/api/screener/screen-sender) |
| `/api/v1/mailboxes/{mailboxId}/approvals/{id}/approve` | [Approve a held send](/docs/api/approvals/approve-send-approval) |
| `/api/v1/mailboxes/{mailboxId}/imports` | [Start a mail import](/docs/api/import/create-import) |
| `/api/v1/mailboxes` | [Create a mailbox](/docs/api/mailboxes/create-mailbox) |
| `/api/v1/webhooks` | [Create a webhook](/docs/api/webhooks/create-webhook) |
| `/api/v1/domains` | [Add a domain](/docs/api/domains/create-domain) |
| `/api/v1/suppressions` | [Add suppressions](/docs/api/suppressions/add-suppressions) |
| `/api/v1/sequences/{id}/enroll` | [Enroll in a sequence](/docs/api/sequences/enroll-in-sequence) |
| `/api/v1/agent-inboxes` | [Create an agent inbox](/docs/api/agent-inboxes/create-agent-inbox) |
| `/api/v1/ai/providers` | [Add an AI provider](/docs/api/ai/create-ai-provider) |
| `/api/auth/tokens` | Creating an API token |

On any other route the header is ignored.

## Replays and secrets

Some creates return a secret once: a webhook's signing secret, an API token, an agent inbox's token and webhook secret. Those secrets are never kept in the replay store.

A replayed create returns the same record with the secret removed and a flag that says so:

```json
{
  "webhook": { "id": "wh_3f9a", "name": "Billing", "url": "https://api.example.org/hooks/mail" },
  "secret": null,
  "secret_redacted": true
}
```

For an agent inbox, `token.secret` and `webhook.secret` are the fields that come back as `null`.

If you lost the first response, you cannot get the secret back. Rotate the webhook secret with [Rotate a webhook secret](/docs/api/webhooks/rotate-webhook-secret), or revoke the token and create a new one.

## A retry loop

```ts
const key = crypto.randomUUID();

async function sendOnce(body: unknown) {
	for (let attempt = 0; attempt < 3; attempt++) {
		const res = await fetch("{{BASE_URL}}/api/v1/mailboxes/support@example.com/emails", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.CLOUDMAIL_TOKEN}`,
				"Content-Type": "application/json",
				"Idempotency-Key": key,
			},
			body: JSON.stringify(body),
		}).catch(() => null);

		// No response at all: the request may or may not have run. Same key, try again.
		if (!res) continue;

		// Still running, rate limited, or the key store was unavailable: wait, then retry.
		if (res.status === 429 || res.status === 503 || (res.status === 409 && res.headers.has("Retry-After"))) {
			await new Promise((r) => setTimeout(r, 1000 * Number(res.headers.get("Retry-After") ?? 1)));
			continue;
		}
		return res;
	}
	throw new Error("send did not complete");
}
```

Generate the key once, outside the loop. A new key on each attempt defeats the purpose.

The [TypeScript SDK](/docs/sdks/typescript), the [Python SDK](/docs/sdks/python) and the [CLI](/docs/sdks/cli) send a key with every send and create, and retry with the same key.

## MCP tools

The MCP send, create and schedule tools take an optional `idempotency_key` argument with the same rules. MCP keys are kept in a separate scope, so a key used over REST never replays an MCP call. See [MCP server](/docs/mcp).
