# cloudmail (Python)

A typed Python client for the cloudmail API. It is synchronous, built on `httpx` and `pydantic` v2, and needs Python 3.10+.

It covers the REST API that API tokens can use: sending and reading mail, mailboxes, agent inboxes, approvals, webhooks, labels, threads, folders, rules, templates, sequences, domains, analytics and the rest. It sends idempotency keys automatically, retries safely, and includes `verify_webhook` and an SSE event-stream iterator.

This package was previously `tapetide-mail`, imported as `tapetide`. `import tapetide` still works but emits a `DeprecationWarning`; switch to `import cloudmail`. The client class is `Tapetide`, and `Cloudmail` is the same class under the new name.

## Install

Not on PyPI yet. Install from a checkout:

```bash
pip install ./sdk/python
```

## Usage

```python
from cloudmail import Cloudmail, is_pending_approval

cm = Cloudmail("https://mail.example.com", token="ttk_...")

result = cm.mail.send(
    "support@example.com",
    to="customer@example.org",
    subject="Your order shipped",
    text="It's on the way.",
)
if is_pending_approval(result):
    print("Waiting for approval:", result.approval_url)  # nothing was sent; don't retry
else:
    print("Sent:", result.id)

page = cm.mail.list("support@example.com", folder="inbox", unread=True, limit=20)
email = cm.mail.get("support@example.com", page.emails[0].id)
cm.mail.reply("support@example.com", email.id, to=email.sender, subject=f"Re: {email.subject}", text="Thanks!")

label = cm.labels.create("support@example.com", "Billing", color="#0a7")
cm.labels.add_to_email("support@example.com", email.id, label["id"])
thread = cm.threads.get("support@example.com", email.thread_id)

for msg in cm.mail.iter_unified(unread=True):  # follows nextCursor across mailboxes
    ...
```

## Agent flow: send, held for approval, revise, wait

```python
from cloudmail import Cloudmail, is_pending_approval

agent = Cloudmail("https://mail.example.com", token=AGENT_TOKEN)
mailbox = "agent-7@example.com"

sent = agent.mail.send(mailbox, to="lead@example.org", subject="Quote", html="<p>EUR 1,200</p>")
if is_pending_approval(sent):
    # Held for a person. Change it in place instead of sending again.
    revised = agent.approvals.revise(mailbox, sent.approval_id, html="<p>EUR 1,150, valid 30 days</p>")
    print("revision", revised.revision, revised.revised_by)  # 2 requester

    decided = agent.approvals.wait_for_decision(mailbox, sent.approval_id, interval=10, timeout=600)
    print(decided.status)  # sent, rejected, failed, sent_unconfirmed, or still pending after the timeout
```

The reviewer approves the revision they read. A newer one raises `ApprovalChangedError`, and nothing is sent:

```python
from cloudmail import ApprovalChangedError

held = reviewer.approvals.get(mailbox, approval_id)
try:
    reviewer.approvals.approve(mailbox, approval_id, revision=held.revision)
except ApprovalChangedError as err:
    print("changed; review revision", err.approval.revision)
```

## Resources

`mail`, `mailboxes`, `agent_inboxes`, `approvals`, `webhooks` and `events` return pydantic models, as in 0.1. The other resources return the decoded JSON (dicts and lists), so a field the server adds is never lost:

`threads`, `folders`, `labels`, `signatures`, `snooze`, `followups`, `triage`, `screener`, `scheduled_sends`, `senders`, `rules`, `imports`, `delegates`, `audit`, `templates`, `sequences`, `suppressions`, `sending_health`, `domains`, `products`, `people`, `analytics`, `usage`, `ai`, `assistant`, `cloudflare`, `licence`, `privacy`, `access`, `branding`, `preferences`, `notifications`, `meta`, `migration`.

Each method's docstring names the OpenAPI operation it calls. Downloads (`mail.attachment`, `mailboxes.export`, `privacy.download_export`, `branding.logo`) return bytes, or stream into a binary file passed as `dest=`. `tests/test_coverage.py` fails if an operation in `sdk/typescript/openapi.json` has no method and no listed reason.

### Not in the SDK

These operations refuse API tokens, so they have no methods:

- Cloudflare connect, verify, disconnect, apply and revert; account deletion; starting an account export. These need a browser session that re-confirmed its password or passkey in the last 15 minutes.
- Licence activate and deactivate. These need a browser session.
- Web Push subscriptions, push preferences and test pushes. These belong to a browser device.
- Creating, changing or deleting AI providers, model lists and routing. These need a person in the app.
- The WebSocket event stream. Use `events.iter_sse` instead.

For any other route, use `cm.request(method, path, params=..., json=...)`.

### Retries and idempotency

- Sends, creates and `approvals.approve` carry an `Idempotency-Key`: a fresh UUID, or the one you pass as `idempotency_key=`.
- GETs and keyed requests are retried up to `max_retries` times (default 2, exponential backoff with jitter), always with the same key, after:
  - network errors
  - 429 and `409 idempotency_request_in_progress` (honouring `Retry-After`)
  - 408 and 5xx, except on sends
- Sends (`SEND_POST_PATHS`: send, reply, forward, scheduled sends, send-now, template sends, sequence enrollment, approve) are not retried on a 5xx or 408, because the message may already have gone out and the server doesn't store a 5xx against the key. A 503 the server returns before running anything (`idempotency_unavailable`, `licence_unavailable`) is still retried.
- Other writes are not retried.

### Errors

Non-2xx responses raise `TapetideError` (also exported as `CloudmailError`) with `status`, `code`, `message`, `body` and `headers`:

| Class | When |
|---|---|
| `ValidationError` | 400, 422 |
| `AuthenticationError` | 401 |
| `PermissionDeniedError` | 403 (`code` says why, e.g. `insufficient_scope`, `self_approval`) |
| `NotFoundError` | 404 |
| `ConflictError` | 409 |
| `ApprovalChangedError` | 409 from `approve` when the held send changed; `approval` is the current version |
| `RateLimitError` | 429; `retry_after` is the server's hint in seconds, or None |
| `ServerError` | 5xx |
| `APIConnectionError` | network failure after retries |

## Verifying webhooks

Each delivery carries `X-Tapetide-Timestamp` and `X-Tapetide-Signature: v1=<hex hmac-sha256 of "{timestamp}.{body}">`. The header names are part of the wire format and haven't changed. Pass the raw body bytes, not re-serialised JSON.

```python
from fastapi import FastAPI, HTTPException, Request
from cloudmail import WebhookVerificationError, verify_webhook

app = FastAPI()

@app.post("/hooks/mail")
async def mail_hook(request: Request):
    try:
        event = verify_webhook(await request.body(), request.headers, "whsec_...")
    except WebhookVerificationError:
        raise HTTPException(status_code=400)
    return {"ok": True}
```

The default tolerance is 300 seconds (`tolerance=` changes it).

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

It reconnects with `Last-Event-ID` after a dropped connection and resumes from the last id it yielded. See `docs/realtime.md` for the frames.

## Development

```bash
cd sdk/python
uv venv && uv pip install -e '.[dev]'
uv run pytest
```

## Publishing (not done automatically)

1. Bump `version` in `pyproject.toml` and `src/cloudmail/_version.py`.
2. Run `uv build`. It writes the wheel and sdist to `dist/`; the wheel contains `cloudmail` and the `tapetide` shim.
3. Run `uv publish` with a PyPI token for the `cloudmail` project. Try TestPyPI first with `--publish-url https://test.pypi.org/legacy/`.
