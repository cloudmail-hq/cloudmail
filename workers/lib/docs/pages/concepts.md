# Core concepts

> Mailboxes, messages, folders, threads and labels, how lists are paged, and how a person's role in a mailbox limits what a token can do there.

## Mailboxes

A mailbox is one address, such as `support@example.com`, with its own mail, folders, labels, rules and settings. A mailbox's `id` is its address.

Almost every call names the mailbox in the path:

```text
{{BASE_URL}}/api/v1/mailboxes/support@example.com/emails
```

The `@` can go in the path as it is. [List mailboxes](/docs/api/mailboxes/list-mailboxes) returns the mailboxes your token can reach. A mailbox you cannot reach answers `403`, and an address that is not a mailbox answers `404`.

## Messages

A message has an `id`, a `thread_id`, the folder it is in (`folder_id`), `subject`, `sender`, `recipient`, `cc`, `bcc`, `date`, and the flags `read` and `starred`.

List calls return rows without `body` and `attachments`, with a short `snippet` instead. [Get a message](/docs/api/emails/get-email) returns the whole record. Sent messages also carry delivery fields such as `delivery_status`, `opened_at` and `click_count`.

Message ids are opaque strings. Do not parse them.

## Folders

A message is in exactly one folder. The system folders are:

| Folder id | Holds |
| --- | --- |
| `inbox` | Incoming mail. |
| `sent` | Mail sent from the mailbox. |
| `draft` | Drafts. |
| `archive` | Mail moved out of the inbox to keep. |
| `trash` | Deleted mail. Deleting a message that is already here destroys it. |
| `spam` | Mail filed as spam. Deleting a message here destroys it too. |
| `snoozed` | Mail hidden until a set time. |
| `scheduled` | Mail queued to send later. |
| `screener` | Mail from first-time senders, when the mailbox uses the screener. |

A mailbox can also have custom folders. [List folders](/docs/api/folders/list-folders) returns all of them with unread counts, and [Move a message](/docs/api/emails/move-email) changes a message's folder.

## Threads

Messages in one conversation share a `thread_id`. [Get a thread](/docs/api/threads/get-thread) returns every message in it. Replies made through the API are threaded for you; see [Sending mail](/docs/guides/sending-mail).

## Labels

A label is a tag you define. A message can carry any number of labels, in any folder. See [Create a label](/docs/api/labels/create-label) and [List messages with a label](/docs/api/labels/list-label-emails).

## Paging

List calls take `page` and `limit`:

| Parameter | Meaning |
| --- | --- |
| `page` | 1-based page number. Default 1. |
| `limit` | Rows per page. For message lists the default is 25 and the maximum is 100. |

A message list for a folder answers with the page and the total:

```json
{ "emails": [], "totalCount": 132 }
```

Read pages until you have `totalCount` rows. Always pass `folder` when you list messages: without it the answer is a bare array with no count.

## Dates

Message dates are ISO 8601 strings in UTC, such as `2027-01-15T09:12:44.000Z`. Some other records, such as API tokens and agent inboxes, use Unix milliseconds. Each field's description in the [API reference](/docs/api) says which.

## Roles and capabilities

Each person has a role in each mailbox they can reach, and the role decides what they can do there. A token inherits that limit; see [Authentication](/docs/authentication).

| Role | Can |
| --- | --- |
| `viewer` | Read mail. |
| `agent` | Read, send on behalf of the mailbox, write drafts, organise mail and move it to Trash. |
| `manager` | Everything an agent can, plus send as the mailbox, delete permanently and manage rules. |
| `owner` | Everything, including the mailbox's settings and who else can reach it. |

Endpoint pages name the capability a call needs, for example `read`, `sendAs` or `organise`. [Get the current caller](/docs/api/me-config/get-me) lists the capabilities your token has in each mailbox.

Administrators can reach every mailbox. Some endpoints, such as domains and access grants, are for administrators only and say so on their page.

## Changing more than one message

[Apply an action to many messages](/docs/api/emails/bulk-email-action) marks, moves, labels or deletes up to 500 messages in one call. Use it instead of one call per message.

## Finding out about new mail

There are three ways, from simplest to fastest:

- Poll [the mailbox state](/docs/api/mailboxes/get-mailbox-state), which is cheap and changes whenever the mailbox does. See [Reading mail](/docs/guides/reading-mail).
- Register a [webhook](/docs/guides/webhooks) and receive a signed POST for each event.
- Hold a [realtime stream](/docs/guides/realtime-events) open.
