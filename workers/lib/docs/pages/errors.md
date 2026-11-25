# Errors

> The error body, every status code the API returns and what to do about each, and the error codes worth handling in code.

## The error body

Every error is JSON with an `error` message for people. Many also carry a `code` for programs:

```json
{
  "error": "This API token does not have the \"webhooks:manage\" scope.",
  "code": "insufficient_scope",
  "scope": "webhooks:manage"
}
```

Branch on the status code and, where there is one, on `code`. Do not match on the `error` text; it can change.

A request body that fails validation answers `400` with the fields that were wrong:

```json
{
  "error": "Invalid request body",
  "details": [
    { "path": "to", "message": "Invalid email" },
    { "path": "subject", "message": "Required" }
  ]
}
```

## Status codes

| Status | Meaning | What to do |
| --- | --- | --- |
| `200`, `201`, `204` | Success. | |
| `202` | A send was accepted, or was held for approval. | Read `status` in the body. See [Sending mail](/docs/guides/sending-mail). |
| `400` | The request is malformed or failed validation. | Fix the request. Do not retry it unchanged. |
| `401` | The token is missing, wrong, expired or revoked. | Create a new token. See [Authentication](/docs/authentication). |
| `402` | The deployment has no active licence. | An administrator activates it in Settings. |
| `403` | The token is valid but may not do this. | Read `code` or `capability`: a missing scope, no access to the mailbox, or an action only a signed-in person can take. |
| `404` | The mailbox, message or other resource does not exist. | Check the id. |
| `409` | A conflict with existing state, or an idempotency key problem. | See [Idempotency keys](/docs/guides/idempotency). |
| `412` | Something this call depends on is not set up, such as the Cloudflare connection. | Set it up, then retry. |
| `413` | The message or upload is too large. | Send less. |
| `422` | The request is valid but cannot be carried out, for example every recipient is suppressed. | Read `code`. |
| `423` | Bulk sending is paused for the domain. | An administrator resumes it. |
| `428` | The call needs an explicit confirmation flag. | Resend with the flag the message names. |
| `429` | Too many requests, or the mailbox reached its send cap. | Wait for `Retry-After`. See [Rate limits](/docs/rate-limits). |
| `500` | An error on the server. | Retry with backoff. For sends, retry with the same idempotency key. |
| `502`, `503` | A service this deployment depends on is unavailable. | Retry with backoff. |

## Error codes

These are the codes you are most likely to handle.

| Code | Status | Meaning |
| --- | --- | --- |
| `unauthenticated` | `401` | No valid token was sent. |
| `insufficient_scope` | `403` | The token lacks the scope named in `scope`. Sent by routes that are not about one mailbox. |
| `person_required` | `403` | Only a signed-in person can do this, not a token. |
| `session_required` | `403` | The call needs a browser session, for example creating a token from a token that has no scopes. |
| `scope_exceeds_parent`, `mailbox_exceeds_parent` | `403` | A token tried to create a child token broader than itself. |
| `mfa_enrollment_required` | `403` | The deployment requires two-factor sign-in and the account has not set it up. |
| `draft_only` | `403` | The mailbox only lets tokens write drafts, not send. |
| `licence_required` | `402` | The deployment has no active licence. |
| `idempotency_key_reused` | `409` | The key was already used with a different request body. |
| `idempotency_request_in_progress` | `409` | A request with this key is still running. Retry after `Retry-After`. |
| `all_suppressed` | `422` | No deliverable recipient is left. The body lists them in `suppressed`. |
| `recipient_not_allowed` | `422` | The mailbox may only send to an allowlist, and a recipient is not on it. |
| `bulk_paused` | `423` | Bulk sending from this domain is paused. |
| `rate_limited` | `429` | The mailbox reached its hourly or daily send cap. |

A `403` on a mailbox route usually has no `code`. Instead it carries `capability`, the mailbox capability the caller is missing, for example `read`, `sendAs` or `organise`:

```json
{
  "error": "You do not have permission to do this in this mailbox (organise)",
  "capability": "organise",
  "capabilities": ["organise"]
}
```

That means either the token lacks the matching scope, or the person who created it does not have that capability in the mailbox. A `403` with neither field means the caller cannot reach the mailbox at all, or the call is for administrators.

## A send that is held is not an error

A send made with a token can answer `202` with `"status": "pending_approval"`. Nothing was sent, and nothing is wrong: the message is waiting for a person. Do not retry it. See [Agent sends and approval](/docs/guides/approvals).

## Retrying

- Retry `429`, `500`, `502` and `503` with backoff, starting at about a second and doubling.
- Do not retry other `4xx` answers without changing the request.
- Send an `Idempotency-Key` with every send and create. A retry with the same key and body returns the first answer and does nothing twice. See [Idempotency keys](/docs/guides/idempotency).
