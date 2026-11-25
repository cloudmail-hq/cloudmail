# Agent sends and approval

> Why a send made with an API token is held for a person by default, how to send unattended, and how to revise or decide a held send.

Anyone can email a mailbox, and software that reads that email can be steered by it. So every send made with an API token or a connected app is checked on the server before it leaves. Mail that a person sends from the app with a browser session is never held.

The check covers every way a token can send: [send](/docs/api/emails/send-email), [reply](/docs/api/emails/reply-to-email), [forward](/docs/api/emails/forward-email), [scheduled sends](/docs/api/scheduled-sends/schedule-send), [template sends](/docs/api/suppressions/send-template), [sequence enrollment](/docs/api/sequences/enroll-in-sequence) and the MCP send tools.

## Send modes

Each mailbox has an agent send mode. The default is `approve`.

| Mode | What a token's send does |
| --- | --- |
| `draft_only` | Refused with `403` and `code: draft_only`. The token can still [save drafts](/docs/api/drafts/save-draft). |
| `approve` | Held. The call answers `202` with `status: pending_approval`, and nothing is sent until a person approves it. |
| `auto` | Sent directly, but only by a token that holds both `mail:send` and `mail:send:auto`. Any other token is still held. |

Only a signed-in person can change the mode, in the app under Mailbox settings, Agent and MCP sends. A token that tries to change it through the API is refused with `403` and `code: person_required`, so a credential cannot release its own sends.

Two more rules apply in every mode except `draft_only`:

- A mailbox has a **skip-approval list** of addresses and domains. A send where every recipient is on the list goes straight out, even in `approve` mode.
- A send that follows a read the injection detector flagged is always held, whatever the mode. Its `reason` is `injection_suspected`.

## Check what will happen

[List send policies](/docs/api/approvals/list-send-policies) tells you, for each mailbox the token can read, what a send from this token will do.

```bash
curl "{{BASE_URL}}/api/v1/send-policies" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN"
```

```json
{
  "credential_may_auto_send": false,
  "policies": [
    {
      "mailbox": "support@example.com",
      "mode": "approve",
      "skip_approval": ["@partner.example.org"],
      "allowed_recipients": null,
      "your_sends": "held"
    }
  ]
}
```

`your_sends` is `sent`, `held`, `refused` (draft only) or `not_allowed` (no send capability on the mailbox). `held` still lets through a send whose recipients are all on `skip_approval`.

## A held send

```json
{
  "status": "pending_approval",
  "approval_id": "apr_0123456789abcdef0123",
  "approval_url": "{{BASE_URL}}/mail/support%40example.com/approvals?id=apr_0123456789abcdef0123",
  "expires_at": "2026-12-01T12:00:00.000Z",
  "reason": "approval_required",
  "message": "Not sent yet. This mailbox requires the user to approve agent sends. Tell the user it is waiting in Pending approval; do not retry or send it another way."
}
```

The status code is `202`, the same as an accepted send, so branch on `status`. Then:

- Treat it as success that is waiting. Do not retry, and do not try another route to send the same message.
- Give `approval_url` to the person who should decide. It opens the held send in the app.
- A hold expires 7 days after it was created. Approving an expired one answers `410`.

What is stored is the fully composed message: the body, the recipients and the attachments. Approving sends exactly that. Only open and click tracking is added at send time.

## Send without approval

There are two ways to let an integration send unattended.

**Auto mode plus a trusted token.**

1. A person sets the mailbox to send automatically, in Mailbox settings, Agent and MCP sends.
2. Create a token with **Send mail** and **Send without approval** ticked, at [Settings, API tokens](/settings/account?new-token=1). Those are the `mail:send` and `mail:send:auto` scopes.

Both are needed. In `approve` mode, `mail:send:auto` does not skip approval. No scope preset includes `mail:send:auto`, and a token created without scopes never qualifies.

**The skip-approval list.** If the integration only ever writes to a known set of recipients, a person can add those addresses or domains to the mailbox's skip-approval list instead. Sends to listed recipients go out in `approve` mode with an ordinary `mail:send` token. Prefer this when it fits.

## Follow a held send

[Get a held send](/docs/api/approvals/get-send-approval) returns its current state.

```bash
curl "{{BASE_URL}}/api/v1/mailboxes/support@example.com/approvals/apr_0123456789abcdef0123" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN"
```

```json
{
  "approval": {
    "id": "apr_0123456789abcdef0123",
    "kind": "rest_send",
    "status": "pending",
    "reason": "approval_required",
    "recipients": ["customer@example.org"],
    "subject": "Your quote",
    "messages": [
      { "to": ["customer@example.org"], "cc": [], "bcc": [], "from": "support@example.com", "subject": "Your quote", "html": "<p>EUR 1,200</p>" }
    ],
    "editable": true,
    "revision": 1,
    "revised_by": null,
    "created_at": "2026-11-24T12:00:00.000Z",
    "expires_at": "2026-12-01T12:00:00.000Z",
    "sent_messages": []
  }
}
```

| `status` | Meaning |
| --- | --- |
| `pending` | Waiting for a person. |
| `sending` | Approved; delivery is in progress. |
| `sent` | Approved and accepted by the mail provider. `sent_messages` lists the Sent copy and the provider's id. |
| `rejected` | A person rejected it. `note` may say why. Nothing was sent. |
| `failed` | The provider refused it before accepting. It was not sent and can be retried. |
| `sent_unconfirmed` | A timeout or an ambiguous error. It may have been delivered, so it is final and is never sent again. |

Other read calls, all with the `mail:read` scope:

- [List held sends in a mailbox](/docs/api/approvals/list-send-approvals). `status` filters (default `pending`; `all` for everything) and `limit` defaults to 50.
- [Count pending sends](/docs/api/approvals/count-send-approvals) returns `{"pending": n}`.
- [List held sends across mailboxes](/docs/api/approvals/list-all-send-approvals) checks every mailbox the token can read.
- [Find a held send by id](/docs/api/approvals/find-send-approval) when you do not know which mailbox holds it.

To wait for a decision, poll the single approval every few seconds until `status` is no longer `pending`.

## Revise your own held send

The token that asked for a send can change it while it is still pending, with [Revise a held send](/docs/api/approvals/revise-send-approval). This is not a decision, so it needs no extra scope.

```bash
curl -X POST "{{BASE_URL}}/api/v1/mailboxes/support@example.com/approvals/apr_0123456789abcdef0123/revise" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "html": "<p>EUR 1,150, valid for 30 days</p>" }'
```

The body takes any of `to`, `cc`, `subject` and `html`. Unknown fields are refused. The response is the updated approval, with `revision` one higher and `revised_by: "requester"`.

| Status | Meaning |
| --- | --- |
| `403` | Another credential asked for this send. Only the requester can revise it. |
| `409` | It has already been decided. Send a new message if it is still needed. |
| `422` | It cannot be revised: it holds more than one message, it has no recipient left, or the new recipients are not allowed. |

## Decide a held send

Approving and rejecting are for people. From the API, they need a token with the `approvals:manage` scope. That scope is never in a preset, and it has limits:

- A token cannot decide a send that it asked for, that a token it was created from asked for, or that a token it created asked for. That answers `403` with `code: self_approval`.
- A connected app can never decide. That answers `403` with `code: person_required`.
- A token without the scope gets `403` with `code: insufficient_scope`.

[Approve](/docs/api/approvals/approve-send-approval) sends the stored message, at most once. Pass the `revision` you reviewed:

```bash
curl -X POST "{{BASE_URL}}/api/v1/mailboxes/support@example.com/approvals/apr_0123456789abcdef0123/approve" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: approve-apr_0123456789abcdef0123" \
  -d '{ "revision": 2 }'
```

The response is `{"approval": {...}, "result": {...}}`. If the send was revised after the revision you named, the call answers `409`, sends nothing, and includes the current `approval` so you can review it again.

[Reject](/docs/api/approvals/reject-send-approval) takes an optional `{"note": "..."}` of up to 500 characters. Nothing is sent.

[Edit](/docs/api/approvals/edit-send-approval) is the reviewer's version of revise: a `PATCH` with the same fields plus an optional `revision`. The edited message replaces what will be sent.

[Retry](/docs/api/approvals/retry-send-approval) puts a `failed` send back to `pending`. A `sent_unconfirmed` send cannot be retried.

| Status on a decision | Meaning |
| --- | --- |
| `409` | Already decided, or revised since the revision you named. |
| `410` | The hold expired. |
| `502` | Approved, but the provider refused the message. The approval is now `failed`. |

Every hold, send, refusal, approval and rejection is written to the mailbox's access log, with the user and the token that acted.
