# Python SDK

> A typed, synchronous Python client built on httpx and pydantic, with safe retries, webhook verification and an event-stream iterator.

The SDK covers the REST API that API tokens can use: sending and reading mail, mailboxes, approvals, webhooks, labels, threads, folders, rules, templates, sequences, domains, analytics and the rest. It needs Python 3.10 or later.

## Install

The package is named `cloudmail`. It is not on PyPI yet, so install it from the `sdk/python` folder of the cloudmail source you deployed from. From the root of that source:

```bash
pip install ./sdk/python
```

That also installs its two dependencies, `httpx` and `pydantic` v2.

## Configure

Pass the base URL of your deployment and an API token. Create the token at [Settings, API tokens](/settings/account?new-token=1); see [Authentication](/docs/authentication) for scopes.

```python
import os

from cloudmail import Cloudmail

cm = Cloudmail("{{BASE_URL}}", token=os.environ["CLOUDMAIL_TOKEN"])
```

The client does not read environment variables on its own.

| Argument | Meaning |
| --- | --- |
| `base_url` | Your deployment's origin. Required. |
| `token` | An API token, `ttk_<id>_<secret>`. Required. |
| `max_retries` | Retries for requests that are safe to repeat. Default 2. |
| `timeout` | Seconds per attempt. Default 30. |
| `http_client` | Your own `httpx.Client`, for tests or a proxy. |

The client is a context manager: `with Cloudmail(...) as cm:` closes its connections when the block ends.

## Send mail

```python
from cloudmail import Cloudmail, is_pending_approval

result = cm.mail.send(
    "support@example.com",
    to="customer@example.org",
    subject="Your order shipped",
    text="It is on the way.",
)

if is_pending_approval(result):
    # Nothing was sent. A person approves it in the app. Do not send it again.
    print("held:", result.approval_url)
else:
    print("sent:", result.id)
```

`from` defaults to the mailbox address; pass `from_=` to set a display name. `to`, `cc` and `bcc` take one address or a list. `cm.mail.reply(mailbox, email_id, ...)` and `cm.mail.forward(mailbox, email_id, ...)` take the same arguments. Extra keyword arguments such as `track=False` go into the request body as they are. The fields are described in [Sending mail](/docs/guides/sending-mail).

A send made with a token is held for a person by default. A held send comes back as a `PendingApproval` model; the client does not raise. See [Agent sends and approval](/docs/guides/approvals).

## Read mail

```python
page = cm.mail.list("support@example.com", folder="inbox", unread=True, limit=20)
for row in page.emails:
    print(row.date, row.sender, row.subject)

email = cm.mail.get("support@example.com", page.emails[0].id)
thread = cm.threads.get("support@example.com", email.thread_id)

found = cm.mail.search("support@example.com", "from:customer@example.org has:attachment")

with open("invoice.pdf", "wb") as fh:
    cm.mail.attachment("support@example.com", email.id, email.attachments[0].id, dest=fh)
```

`cm.mail.list` defaults to the `inbox` folder. Downloads return bytes, or stream into the binary file you pass as `dest=`. `cm.mailboxes.state(mailbox)` returns the change counter described in [Reading mail](/docs/guides/reading-mail).

## Drafts and scheduled sends

```python
draft = cm.mail.save_draft(
    "support@example.com",
    body="Hi, the refund was issued today.",
    to="customer@example.org",
    subject="Refund update",
)

queued = cm.scheduled_sends.schedule(
    "support@example.com",
    to="customer@example.org",
    subject="Reminder",
    text="As discussed.",
    delay_seconds=3600,
)

# A send made with a token can be held for approval. Then there is no id to cancel.
if queued.get("status") != "pending_approval":
    cm.scheduled_sends.cancel("support@example.com", queued["id"])
```

`schedule` returns the decoded JSON as a dict. On a mailbox that holds agent sends, that dict has `"status": "pending_approval"` instead of an `id`, which is why the example checks before it reads `id`.

## Held sends

```python
sent = cm.mail.send("support@example.com", to="customer@example.org", subject="Quote", html="<p>EUR 1,200</p>")

if is_pending_approval(sent):
    # Change it in place instead of sending a second copy.
    revised = cm.approvals.revise("support@example.com", sent.approval_id, html="<p>EUR 1,150, valid 30 days</p>")
    print("revision", revised.revision, revised.revised_by)

    decided = cm.approvals.wait_for_decision("support@example.com", sent.approval_id, interval=10, timeout=600)
    print(decided.status)  # sent, rejected, failed, sent_unconfirmed, or still pending after the timeout
```

`cm.approvals.policies()` says what a send from this token will do in each mailbox. `cm.approvals.list_all()` finds held sends in every mailbox the token can read.

A reviewer with an `approvals:manage` token approves the revision they read:

```python
from cloudmail import ApprovalChangedError

held = reviewer.approvals.get("support@example.com", approval_id)
try:
    reviewer.approvals.approve("support@example.com", approval_id, revision=held.revision)
except ApprovalChangedError as err:
    print("it changed; review revision", err.approval.revision)
```

## Retries and idempotency

- Sends, creates and `approvals.approve` carry an `Idempotency-Key`: a fresh UUID, or the one you pass as `idempotency_key=`.
- GETs and keyed requests are retried with exponential backoff and jitter, always with the same key, after a network error, a `429`, a `409` `idempotency_request_in_progress`, a `408` or a `5xx`.
- Sends are the exception: they are not retried on a `5xx` or `408`, because the message may already have gone out and the server does not store a `5xx` against the key.
- Other writes are not retried.

The rules behind this are in [Idempotency keys](/docs/guides/idempotency).

## Errors

A non-2xx response raises a `CloudmailError` with `status`, `code`, `message`, `body` and `headers`.

| Class | When |
| --- | --- |
| `ValidationError` | `400`, `422` |
| `AuthenticationError` | `401` |
| `PermissionDeniedError` | `403`. `code` says why, for example `insufficient_scope` or `self_approval`. |
| `NotFoundError` | `404` |
| `ConflictError` | `409` |
| `ApprovalChangedError` | `409` from `approve` when the held send changed |
| `RateLimitError` | `429`. `retry_after` is the server's hint in seconds, or `None`. |
| `ServerError` | `5xx` |
| `APIConnectionError` | A network failure after the retries |

See [Errors](/docs/errors) for the response bodies.

## Verify webhooks

```python
from fastapi import FastAPI, HTTPException, Request

from cloudmail import WebhookVerificationError, verify_webhook

app = FastAPI()


@app.post("/hooks/mail")
async def mail_hook(request: Request):
    try:
        event = verify_webhook(await request.body(), request.headers, WEBHOOK_SECRET)
    except WebhookVerificationError:
        raise HTTPException(status_code=400)
    print(event["type"], event["mailbox"])
    return {"ok": True}
```

It checks the signature and the timestamp (300 seconds of tolerance by default; `tolerance=` changes it) and returns the parsed payload. Pass the raw body bytes, not re-serialised JSON. The signature format is in [Webhooks](/docs/guides/webhooks).

## Event stream

```python
from cloudmail import StreamRevoked

try:
    for ev in cm.events.iter_sse(mailboxes=["support@example.com"], events=["message.received"], since=last_id):
        handle(ev.event)
        last_id = ev.id
except StreamRevoked:
    ...  # the token was revoked or expired
```

The iterator uses Server-Sent Events. After a dropped connection it reconnects and resumes from the last id it yielded. The WebSocket stream has no Python method. See [Realtime events](/docs/guides/realtime-events) for the frames and limits.

## Everything else

`mail`, `mailboxes`, `agent_inboxes`, `approvals`, `webhooks` and `events` return pydantic models. The other resources return the decoded JSON as dicts and lists, so a field the server adds is never lost:

`threads`, `folders`, `labels`, `signatures`, `snooze`, `followups`, `triage`, `screener`, `scheduled_sends`, `senders`, `rules`, `imports`, `delegates`, `audit`, `templates`, `sequences`, `suppressions`, `sending_health`, `domains`, `products`, `people`, `analytics`, `usage`, `ai`, `assistant`, `cloudflare`, `licence`, `privacy`, `access`, `branding`, `preferences`, `notifications`, `meta`.

Each method's docstring names the operation it calls, which you can look up in the [API reference](/docs/api).

For a route with no method, call it directly:

```python
response = cm.request("GET", "/api/v1/mailboxes/support@example.com/send-limits")
```

A few operations refuse API tokens and so have no methods: connecting Cloudflare, activating a licence, deleting an account, starting an account export, Web Push subscriptions, and changing AI providers. Those need a person signed in to the app.
