# Quickstart

> From a new API token to a sent message in five calls: check the token, list your mailboxes, read the inbox, open a message and send one.

You need an account on this deployment and a terminal with `curl`.

## 1. Create a token

Open [Settings, Account & security, API tokens](/settings/account?new-token=1) and fill in the form:

| Field | What to enter |
| --- | --- |
| Name | Where the token will live, such as `laptop` or `billing-service`. |
| Expires | 30 days, 90 days, 1 year, or no expiry. |
| Scopes | **Read only** is enough for steps 2 to 5. Add **Send mail** for step 6. |
| Mailboxes | Every mailbox you can reach, or only the ones you tick. |

The token looks like `ttk_<id>_<secret>` and is shown once. Put it in an environment variable:

```bash
export CLOUDMAIL_TOKEN="ttk_..."
```

[Authentication](/docs/authentication) explains scopes and mailbox limits.

## 2. Check the token

[Get the current caller](/docs/api/me-config/get-me) answers with who the token acts as and what it may do.

```bash
curl "{{BASE_URL}}/api/v1/me" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN"
```

```json
{
  "email": "you@example.com",
  "name": "You",
  "authenticated": true,
  "role": "member",
  "authMethod": "token",
  "mailboxes": ["support@example.com"],
  "capabilities": [
    { "mailboxId": "support@example.com", "role": "owner", "capabilities": ["read"] }
  ],
  "token": { "id": "a1B2c3D4e5F6", "scopes": ["mail:read"], "mailboxes": null }
}
```

`capabilities` is what this token can do in each mailbox, after your own access and the token's scopes are combined. A `401` here means the token is wrong, expired or revoked.

## 3. List your mailboxes

[List mailboxes](/docs/api/mailboxes/list-mailboxes) returns the mailboxes the token can reach.

```bash
curl "{{BASE_URL}}/api/v1/mailboxes" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN"
```

```json
[
  { "id": "support@example.com", "email": "support@example.com", "name": "support@example.com", "domain": "example.com" }
]
```

A mailbox's `id` is its address. It goes in the path of every mailbox call.

## 4. Read the inbox

[List messages](/docs/api/emails/list-emails) with a `folder` returns a page of messages and the total.

```bash
curl "{{BASE_URL}}/api/v1/mailboxes/support@example.com/emails?folder=inbox&limit=5" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN"
```

```json
{
  "emails": [
    {
      "id": "8c0e6a52-5d0f-4c8e-9a43-1f2f0c1f7b11",
      "thread_id": "8c0e6a52-5d0f-4c8e-9a43-1f2f0c1f7b11",
      "folder_id": "inbox",
      "subject": "Question about my invoice",
      "sender": "customer@example.org",
      "recipient": "support@example.com",
      "date": "2027-01-15T09:12:44.000Z",
      "read": false,
      "starred": false,
      "snippet": "Hi, I was charged twice for October"
    }
  ],
  "totalCount": 132
}
```

List rows have no `body`. Step 5 fetches it.

## 5. Open a message

[Get a message](/docs/api/emails/get-email) returns the full record, with `body` and `attachments`.

```bash
curl "{{BASE_URL}}/api/v1/mailboxes/support@example.com/emails/8c0e6a52-5d0f-4c8e-9a43-1f2f0c1f7b11" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN"
```

[Reading mail](/docs/guides/reading-mail) covers threads, search, attachments and polling for new mail.

## 6. Send a message

Sending needs the `mail:send` scope. [Send a message](/docs/api/emails/send-email):

```bash
curl -X POST "{{BASE_URL}}/api/v1/mailboxes/support@example.com/emails" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "from": "support@example.com",
    "to": "customer@example.org",
    "subject": "Re: Question about my invoice",
    "text": "We have refunded the second charge."
  }'
```

The answer is `202`, with one of two bodies.

Sent:

```json
{ "id": "5b1f0c9e-7a53-4f0e-a2c7-0d7c5a1e9b42", "status": "sent" }
```

Held for a person to approve, which is what a new token gets by default:

```json
{
  "status": "pending_approval",
  "approval_id": "apr_0123456789abcdef0123",
  "approval_url": "{{BASE_URL}}/mail/support%40example.com/approvals?id=apr_0123456789abcdef0123"
}
```

A held message has not been sent. Do not retry it. Someone approves it in the app under **Pending approval**, or you set the mailbox and the token up to send without approval. [Agent sends and approval](/docs/guides/approvals) explains both.

## Next

- [Sending mail](/docs/guides/sending-mail): replies, attachments, drafts and scheduled sends.
- [Webhooks](/docs/guides/webhooks): be told when mail arrives instead of polling.
- [API reference](/docs/api): every endpoint.
