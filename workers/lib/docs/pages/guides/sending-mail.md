# Sending mail

> Send, reply and forward, attach files, keep drafts, schedule a message for later, and read the responses each call returns.

Sending needs a token with the `mail:send` scope and a grant on the mailbox that includes `sendAs` or `sendOnBehalf`. Drafts need `mail:draft`. See [Authentication](/docs/authentication).

By default, a send made with an API token is not delivered straight away. It is held until a person approves it. Read [Agent sends and approval](/docs/guides/approvals) before you build on the examples below, and send an `Idempotency-Key` with every send so a retry cannot deliver twice; see [Idempotency keys](/docs/guides/idempotency).

## Send a message

[Send a message](/docs/api/emails/send-email) takes a JSON body.

```bash
curl -X POST "{{BASE_URL}}/api/v1/mailboxes/support@example.com/emails" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-1234-confirmation" \
  -d '{
    "from": "support@example.com",
    "to": "customer@example.org",
    "subject": "Your order shipped",
    "html": "<p>It is on the way.</p>",
    "text": "It is on the way."
  }'
```

| Field | Required | Meaning |
| --- | --- | --- |
| `from` | yes | The mailbox address in the path, or one of its aliases. Either a string, or `{"email": "...", "name": "..."}` to set a display name. Any other address is refused with `400`. |
| `to` | yes | One address, or a non-empty array of addresses. |
| `subject` | yes | The subject line. |
| `html`, `text` | one of them | The message body. Send both when you can. |
| `cc`, `bcc` | no | One address or an array. |
| `attachments` | no | Files to attach; see below. |
| `in_reply_to`, `references`, `thread_id` | no | Threading for a message you build yourself. To answer a stored message, use the reply call instead. |
| `transactional` | no | `false` marks bulk mail. `list: true` is shorthand for the same thing. |
| `track` | no | `false` sends this message without open and click tracking. `true` cannot turn tracking on for a mailbox that has it off. |
| `followup` | no | A reminder if nobody replies: `{"mode": "off"}`, `{"mode": "auto"}`, or `{"mode": "manual", "delay_seconds": 259200}`. Omit it to use the mailbox default. |

One message can have up to 50 recipients across `to`, `cc` and `bcc`, up to 32 attachments, and a total size of 5 MiB. Base64 adds about 37% to an attachment's size. A message over the limit is refused with `413`.

## What comes back

A send answers `202` in two different ways. Branch on `status`.

**Accepted for delivery:**

```json
{ "id": "5f0a2c1e-8d7b-4f1a-9c3e-2b6d4e8f1a90", "status": "sent" }
```

`id` is the stored copy in the Sent folder. Delivery to the mail provider happens after the response. The copy starts with `delivery_status` `queued` and moves to `sent`, or to `failed` if the provider refused it. Read it back with [Get a message](/docs/api/emails/get-email), or see every step with [Delivery events](/docs/api/emails/list-delivery-events).

**Held for approval:**

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

Nothing was sent. Do not send it again. A person approves or rejects it; see [Agent sends and approval](/docs/guides/approvals).

### Suppressed recipients

The response to a delivered send can carry two more arrays. Each entry is `{"address", "reason", "scope"}`.

| Field | Meaning |
| --- | --- |
| `suppressed` | Recipients that were dropped. On a transactional send these are addresses that hard-bounced or complained. On a bulk send, every suppressed address. |
| `suppression_warnings` | Transactional sends only: recipients who unsubscribed or were suppressed by hand. The message was still sent to them. |

### Refusals

| Status | `code` | Meaning |
| --- | --- | --- |
| `400` | | The body failed validation, `from` is not this mailbox, or an attachment has a blocked file type. |
| `403` | `draft_only` | The mailbox only lets agents write drafts. |
| `413` | | The message is too large. |
| `422` | `all_suppressed` | No deliverable `to` recipient is left. The body lists them in `suppressed`. |
| `423` | `bulk_paused` | Bulk sending is paused for this domain. Applies to bulk mail only. |
| `429` | `rate_limited` | The mailbox reached its send cap. |

The full list of error shapes is in [Errors](/docs/errors).

## Attachments

Each attachment is an object with the file as base64:

```json
{
  "from": "support@example.com",
  "to": "customer@example.org",
  "subject": "Your invoice",
  "text": "Attached.",
  "attachments": [
    {
      "filename": "invoice.pdf",
      "type": "application/pdf",
      "disposition": "attachment",
      "content": "JVBERi0xLjQKJ..."
    }
  ]
}
```

`filename`, `type`, `disposition` and `content` are all required. `disposition` is `attachment` or `inline`. For an inline image, set `contentId` and refer to it from the HTML as `cid:<contentId>`. Executable and other blocked file types are refused with `400`, and the error names the file.

## Reply and forward

[Reply](/docs/api/emails/reply-to-email) and [Forward](/docs/api/emails/forward-email) take the same body as a send, with the id of the stored message in the path.

```bash
curl -X POST "{{BASE_URL}}/api/v1/mailboxes/support@example.com/emails/8c0e6a52-5d0f-4c8e-9a43-1f2f0c1f7b11/reply" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: reply-8c0e6a52-1" \
  -d '{
    "from": "support@example.com",
    "to": "customer@example.org",
    "subject": "Re: Question about my invoice",
    "html": "<p>We refunded the second charge.</p>"
  }'
```

The server works out the threading from the original message: `In-Reply-To`, the `References` chain and the conversation the copy is filed under. You do not send those fields. The id in the path can be the message's `id` or its `message_id`.

The body is sent as you post it. The API does not add the quoted original, and a forward does not copy the original's body or attachments. Put whatever the recipient should see in `html`, `text` and `attachments`. `to` is still required, so set it to the person you are answering or forwarding to.

A reply also marks the conversation read. A forward does not. Responses and refusals are the same as for a send.

## Drafts

[Save a draft](/docs/api/drafts/save-draft) creates a draft, or updates one when you pass its id.

```bash
curl -X POST "{{BASE_URL}}/api/v1/mailboxes/support@example.com/drafts" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "customer@example.org",
    "subject": "Refund update",
    "body": "Hi, the refund was issued today."
  }'
```

```json
{
  "id": "0b7e1d2c-3a4f-4e5b-8c6d-7e8f9a0b1c2d",
  "status": "draft",
  "subject": "Refund update",
  "recipient": "customer@example.org",
  "date": "2026-11-24T10:02:11.000Z"
}
```

Only `body` is required. `to`, `cc` and `bcc` are strings here, not arrays; separate several addresses with commas. A plain-text `body` is stored as HTML paragraphs.

To update, send the same call with `"draft_id": "<id>"`. A create answers `201` and an update `200`. To change the files on a draft, send `attachments` together with `"replace_attachments": true`; the stored set is replaced by what you send.

Drafts live in the `draft` folder, so you can list them with [List messages](/docs/api/emails/list-emails) and `folder=draft`. To send one, post its content to a scheduled send with `supersedes_draft_id` (next section); the draft is removed once the message is queued.

## Scheduled sends and undo

[Queue a message](/docs/api/scheduled-sends/schedule-send) takes the send body plus exactly one of `send_at` or `delay_seconds`.

```bash
curl -X POST "{{BASE_URL}}/api/v1/mailboxes/support@example.com/scheduled-sends" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: reminder-2026-11-25" \
  -d '{
    "from": "support@example.com",
    "to": "customer@example.org",
    "subject": "Reminder",
    "text": "As discussed.",
    "send_at": "2026-11-25T09:00:00Z"
  }'
```

```json
{
  "id": "c41d9e70-2b1a-4f6e-8d3c-5a7b9c0d1e2f",
  "status": "scheduled",
  "send_at": "2026-11-25T09:00:00.000Z",
  "superseded_draft": false
}
```

| Extra field | Meaning |
| --- | --- |
| `send_at` | An ISO 8601 time. |
| `delay_seconds` | Seconds from now, from 1 up to 7776000 (90 days). |
| `reply_to_email_id` | The stored message this one answers or forwards. Threading is then derived by the server. |
| `threaded_mode` | `reply` or `forward`, with `reply_to_email_id`. Only a reply marks the conversation read. |
| `supersedes_draft_id` | A draft to remove once the message is queued. Needs the `draft` capability on the mailbox. |

A queued message answers `201`. With a token on a mailbox that holds agent sends, it answers `202` `pending_approval` instead; the message keeps its send time and is queued when a person approves it. The per-message limits are checked when you queue it, not when it goes out.

[List scheduled sends](/docs/api/scheduled-sends/list-scheduled-sends) returns the queue. Each entry has `email_id`, `send_at`, `status` (`pending`, `sent` or `failed`), `attempts` and `last_error`.

[Cancel a scheduled send](/docs/api/scheduled-sends/cancel-scheduled-send) stops a pending message and moves it to Drafts:

```bash
curl -X DELETE "{{BASE_URL}}/api/v1/mailboxes/support@example.com/scheduled-sends/c41d9e70-2b1a-4f6e-8d3c-5a7b9c0d1e2f" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN"
```

It answers `{"status": "cancelled"}`, or `409` when the message has already gone.

[Send now](/docs/api/scheduled-sends/send-scheduled-now) skips the rest of the wait and answers `{"status": "sent"}`. It answers `409` if the message already went, `503` if the mailbox is over its send cap (the message stays queued), and `502` if delivery failed.

**Undo send.** To give yourself a window to take a message back, queue it with a short `delay_seconds`, such as 30, and cancel it inside that window.

## Send caps

Each mailbox has an hourly and a daily cap on outgoing mail. The defaults are 20 an hour and 100 a day. An administrator can raise them, up to 1,000 an hour and 10,000 a day. A send over the cap is refused with `429` and `code: rate_limited`.

[Get send limits](/docs/api/sending-health/get-send-limits) shows the caps and how much is used:

```json
{
  "caps": { "hourly": 20, "daily": 100 },
  "default": true,
  "sent_last_hour": 4,
  "sent_last_day": 31
}
```

These caps are separate from the API request limit described in [Rate limits](/docs/rate-limits).
