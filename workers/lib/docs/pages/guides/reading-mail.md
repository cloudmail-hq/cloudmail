# Reading mail

> List messages in a folder, read one with its body and attachments, follow a conversation, search, and poll for changes.

Every call on this page needs a token with the `mail:read` scope and a grant that includes the `read` capability on the mailbox. See [Authentication](/docs/authentication).

The mailbox id in the path is the mailbox address.

## List messages

[List messages](/docs/api/emails/list-emails) returns one page of a folder, newest first.

```bash
curl "{{BASE_URL}}/api/v1/mailboxes/support@example.com/emails?folder=inbox&limit=20" \
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
      "date": "2026-11-24T09:12:44.000Z",
      "read": false,
      "starred": false,
      "snippet": "Hi, I was charged twice for October",
      "has_attachment": true
    }
  ],
  "totalCount": 132
}
```

List rows leave out `body` and `attachments`. Fetch the message to get them.

Always pass `folder`. With it, the response is `{ "emails": [...], "totalCount": n }`. Without it, the response is a bare array with no count.

| Query parameter | Meaning |
| --- | --- |
| `folder` | Folder id. System folders are `inbox`, `sent`, `draft`, `archive`, `trash`, `spam`, `snoozed`, `scheduled` and `screener`. [List folders](/docs/api/folders/list-folders) returns these plus your custom folders, with unread counts. |
| `page` | 1-based page number. Default 1. |
| `limit` | Page size. Default 25, maximum 100. |
| `unread` | `true` or `1` for unread messages only. |
| `starred` | `true` or `1` for starred messages only. |
| `has_attachment` | `true` or `1` for messages with attachments only. |
| `threaded` | `true` groups the folder by conversation. Each row is the latest message of a thread and carries `thread_count` and `thread_unread_count`. Needs `folder`. |
| `thread_id` | Only messages in this conversation. |
| `sortColumn` | `date` (default), `id`, `subject`, `sender`, `recipient`, `read` or `starred`. Anything else falls back to `date`. |
| `sortDirection` | `desc` (default) or `asc`. |

To walk a whole folder, request `page=1`, `page=2` and so on until you have read `totalCount` rows. `totalCount` uses the same filters as the list.

## Read one message

[Get a message](/docs/api/emails/get-email) returns the full record, with `body` and `attachments`.

```bash
curl "{{BASE_URL}}/api/v1/mailboxes/support@example.com/emails/8c0e6a52-5d0f-4c8e-9a43-1f2f0c1f7b11" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN"
```

```json
{
  "id": "8c0e6a52-5d0f-4c8e-9a43-1f2f0c1f7b11",
  "thread_id": "8c0e6a52-5d0f-4c8e-9a43-1f2f0c1f7b11",
  "folder_id": "inbox",
  "subject": "Question about my invoice",
  "sender": "customer@example.org",
  "recipient": "support@example.com",
  "cc": "",
  "date": "2026-11-24T09:12:44.000Z",
  "read": false,
  "starred": false,
  "body": "<p>Hi, I was charged twice for October.</p>",
  "message_id": "CAF3k2n1@mail.example.org",
  "in_reply_to": null,
  "attachments": [
    { "id": "a1f4", "filename": "invoice.pdf", "mimetype": "application/pdf", "size": 48213 }
  ]
}
```

`body` is the stored HTML. `sender`, `recipient`, `cc` and `bcc` are strings; several addresses are comma-separated. Sent messages also carry `delivery_status` (`queued`, `sent`, `delivered`, `failed` or `bounced`) and the open and click counters.

Reading a message does not mark it read. To do that, call [Set read / starred](/docs/api/emails/update-email) with `{"read": true}`. That call needs the `mail:organize` scope.

## Read a conversation

[Get a thread](/docs/api/threads/get-thread) returns every message in a conversation as an array, each with its body. Use the `thread_id` from any message in it.

```bash
curl "{{BASE_URL}}/api/v1/mailboxes/support@example.com/threads/8c0e6a52-5d0f-4c8e-9a43-1f2f0c1f7b11" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN"
```

Add `?folder=inbox` to keep only the messages of the thread that sit in one folder.

## Download an attachment

[Download an attachment](/docs/api/emails/get-attachment) returns the file bytes. Take the attachment `id` from the message's `attachments` array.

```bash
curl "{{BASE_URL}}/api/v1/mailboxes/support@example.com/emails/8c0e6a52-5d0f-4c8e-9a43-1f2f0c1f7b11/attachments/a1f4" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN" \
  -o invoice.pdf
```

The response has the attachment's own `Content-Type` and a `Content-Disposition: attachment` header with the filename. Add `?disposition=inline` to ask for inline display; it is honoured for safe types only.

An attachment whose file type can run code is refused at delivery and never stored. Its entry has `"blocked": true`, and downloading it returns `403` with `{"error": "...", "blocked": true}`.

## Search

[Search a mailbox](/docs/api/search/search-emails) takes the query in the `query` parameter. Let curl encode it:

```bash
curl -G "{{BASE_URL}}/api/v1/mailboxes/support@example.com/search" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN" \
  --data-urlencode "query=from:customer@example.org has:attachment newer_than:7d" \
  --data-urlencode "limit=20"
```

The response is `{ "emails": [...], "totalCount": n }`, the same shape as a folder list. `page` and `limit` work the same way (default 25, maximum 100). `folder` scopes the search when the query itself names no folder.

### Query syntax

Words match the message text. Quote a phrase to match it exactly. Terms next to each other are combined with AND.

| Operator | Matches |
| --- | --- |
| `from:` `cc:` `bcc:` | An address or part of one in that field |
| `to:` | An address or part of one in To, Cc or Bcc |
| `subject:` | Text in the subject |
| `label:` | Messages carrying a label |
| `filename:` | An attachment filename |
| `in:` | A folder id or name. `in:anywhere` searches every folder, including Trash and Spam |
| `is:` | `read`, `unread`, `starred`, `unstarred`, `muted`, `important` or `snoozed` |
| `has:attachment` | Messages with attachments |
| `before:` `after:` | A date, for example `after:2026-11-01` |
| `older_than:` `newer_than:` | An age: `7d` (days), `2m` (months) or `1y` (years) |
| `larger:` `smaller:` | A size in bytes, or with a `k` or `m` suffix, for example `larger:5m` |
| `OR` | Either side: `from:a@example.org OR from:b@example.org` |
| `-` | Negation: `-from:noreply@example.org` |
| `( )` | Grouping: `(invoice OR receipt) is:unread` |
| `{ }` | The terms inside are combined with OR |

A query is read up to 512 characters. An operator with a value that makes no sense, such as `larger:banana`, is searched as plain text instead of failing the request.

### Semantic search

Add `mode=hybrid` to merge full-text results with semantic (vector) results. The response then also has `semantic` (false when the search fell back to full-text only) and `fallback`, and it is not paged.

[Search every mailbox](/docs/api/search/search-all-mailboxes) runs one query across all the mailboxes the token can read. It takes `q`, and optionally `mailbox`, `folder`, `mode` and `limit` (default 25, maximum 50), and returns `results`, each with its `mailboxId`.

```bash
curl -G "{{BASE_URL}}/api/v1/search" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN" \
  --data-urlencode "q=renewal pricing"
```

## Poll for changes

[Mailbox state](/docs/api/mailboxes/get-mailbox-state) is a small, cheap call that tells you whether anything changed, so you do not have to refetch lists.

```bash
curl -i "{{BASE_URL}}/api/v1/mailboxes/support@example.com/state" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN"
```

```json
{ "version": 1841, "inboxUnread": 3, "inboxUnreadHighPriority": 1 }
```

`version` goes up on every write to the mailbox's messages: new mail, a send, a move, a read flag. Keep the last value you saw. When it changes, fetch the lists you care about again.

The response carries an `ETag`. Send it back as `If-None-Match` and an unchanged mailbox answers `304` with no body:

```bash
curl -i "{{BASE_URL}}/api/v1/mailboxes/support@example.com/state" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN" \
  -H 'If-None-Match: W/"s1841-3-1"'
```

Polling counts against the API rate limit; see [Rate limits](/docs/rate-limits). If you want to be told about new mail instead of asking, use [Webhooks](/docs/guides/webhooks) or the [realtime event stream](/docs/guides/realtime-events).
