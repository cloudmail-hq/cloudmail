# MCP server

cloudmail serves the [Model Context Protocol](https://modelcontextprotocol.io) at `https://<host>/mcp` over Streamable HTTP. Any MCP client can read, organise, draft and send mail with the same authority as the user who connected it.

## Connecting

Two ways to authenticate:

- **OAuth** (password mode, needs the `OAUTH_KV` binding). The client opens a browser on `/oauth/authorize`, you approve it, and it acts as you on `/mcp` only. Manage connected apps under **Settings → Account & security → Connected apps**.
- **API token**. Create one under **Settings → Account & security → API tokens** and send `Authorization: Bearer ttk_...`. Use this for headless agents, or for clients without OAuth support. For a bot, create a dedicated user, grant it only the mailboxes and role it needs, and mint the token as that user.

### Claude Code

```bash
# OAuth
claude mcp add --transport http tapetide https://mail.example.com/mcp

# Token
claude mcp add --transport http tapetide https://mail.example.com/mcp \
  --header "Authorization: Bearer ttk_..."
```

### Claude Desktop

Use **Settings → Connectors → Add custom connector** with the URL `https://mail.example.com/mcp`. Claude Desktop signs in through OAuth.

To use a token instead, bridge the server with `mcp-remote` in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tapetide": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "https://mail.example.com/mcp",
        "--header", "Authorization: Bearer ${TAPETIDE_TOKEN}"
      ],
      "env": { "TAPETIDE_TOKEN": "ttk_..." }
    }
  }
}
```

### Cursor

In `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "tapetide": {
      "url": "https://mail.example.com/mcp",
      "headers": { "Authorization": "Bearer ttk_..." }
    }
  }
}
```

Leave out `headers` to sign in with OAuth instead.

### Checking the connection

`curl -si -X POST https://<host>/mcp` returns `401` with a `WWW-Authenticate` header that points at `/.well-known/oauth-protected-resource/mcp`. If that header is missing, OAuth is off: you're in Access mode, or `OAUTH_KV` is not bound. Use a token until it's fixed.

## Safety model

- **Same gates as the REST API.** Every mailbox-scoped tool checks the capability its REST route needs (`read`, `organise`, `draft`, `delete`, `sendAs`/`sendOnBehalf`, `manageRules`). A `viewer` can read but not send. `list_mailboxes` shows only the mailboxes the session can use, and each one lists the session's capabilities in that mailbox.
- **No permanent deletion.** `delete_email`, `trash_email` and `bulk_update` with `trash` only move mail to Trash. They never destroy a message that is already in Trash or Spam, and no tool empties Trash. Trash is purged automatically after 30 days.
- **Sends respect attribution.** Send tools need `sendAs` or `sendOnBehalf` and resolve attribution the same way the REST send path does. Agent-written bodies pass the draft verifier, and a send is refused if the verifier is unavailable. Templates skip the verifier because a person wrote them. Their variables are HTML-escaped.
- **Annotations.** Every tool sets `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`. Clients can use these to ask before a send. The annotations are hints; the capability gates are what actually enforce access.
- **Sends can be held for approval.** By default (`approve` mode) a send tool does not send: it returns `{"status":"pending_approval","approval_id":"apr_…","approval_url":"…"}` and the user approves or rejects it in the app or with `cloudmail approval`. Treat that as success-pending, tell the user, and do not retry or send another way. A mailbox in `draft_only` mode refuses with `code: "draft_only"`; suppressed recipients are refused. Sending without approval needs the mailbox in `auto` mode **and** a token with `mail:send:auto` (or a connected app marked "Send without approval"), or recipients on the mailbox's allowlist. The same rule applies to the REST API with the same credential (202 `pending_approval`). What is held is the composed message, so approving sends exactly what the user previewed. There is no MCP tool to approve or reject a send, and a connected app can never approve one. An agent can check what became of its held sends with `list_pending_sends` and `get_pending_send`, and change one with `revise_pending_send`. `enroll_in_sequence` is held the same way, with every rendered step in the preview. See [Agent sends and approval](../README.md#agent-sends-and-approval).
- **Untrusted content.** `get_email`, `get_thread` and `get_pending_send` return sender-written fields (subject, body, snippet) wrapped in `<<<UNTRUSTED_EMAIL boundary=…>>>` markers and tag the result `"untrusted": true`. When the injection detector flags what was read, the result carries `"injection_suspected": true` and this session's sends are held for approval for 30 minutes, whatever the mode. The server instructions and the `triage_inbox` prompt tell the model to treat email content as data, not instructions.
- **Audited.** Every write (drafts, moves, labels, trash, rules) and every send outcome is in the mailbox's access log with the user and the API token or connected app.
- **Rate limits.** 120 requests a minute per caller (`MCP_RATE_LIMITER`), plus the mailbox's hourly and daily send quota.
- **Safe retries.** Send, create and schedule tools take an optional `idempotency_key`. See [Idempotency keys](#idempotency-keys).

## Idempotency keys

`send_email`, `send_reply`, `forward_email`, `schedule_send`, `send_template`, `enroll_in_sequence`, `create_signature`, `create_draft`, `draft_reply`, `create_folder`, `create_label` and `create_rule` accept an optional `idempotency_key` (1–256 printable ASCII characters). Pass a fresh one for each action you mean to take, and the same one when you retry it.

- The first call with a key runs. A successful result is kept for 24 hours in the mailbox.
- A repeat with the same key and the same arguments returns that result without acting again, with an extra `{"idempotent_replayed": true}` content item.
- The same key with different arguments is refused with `code: idempotency_key_reused`.
- A repeat while the first call is still running is refused with `code: idempotency_request_in_progress`. Retry after a second. A reservation abandoned by a crash frees itself after 2 minutes.
- An error result is not kept, so a retry with the same key runs again.

Keys are scoped to the session's user and API token and to the tool, and stored in the target mailbox's Durable Object, the same table the REST `Idempotency-Key` header uses (but a separate scope, so a REST key never replays an MCP call).

## Output conventions

- Results are compact JSON. Message lists return `id`, `thread_id`, `folder`, `subject`, `from`, `to`, `date`, `read`, `starred`, a plain-text `snippet`, and triage flags (`needs_reply`, `has_attachment`, `priority`) when they're set.
- `get_email` and `get_thread` return `body_text`, capped by `max_chars`, with `body_truncated` set when the cap is hit. Pass `include_body: true` for the raw HTML.
- Lists paginate with `page` / `limit`. Pass `next_page` from the response to continue; `null` means there are no more pages.
- Errors come back with `isError: true` and `{"error": "..."}`. A missing capability is reported by name and says not to retry.

## Tools

| Tool | What it does | Capability |
| --- | --- | --- |
| `list_mailboxes` | Mailboxes this session can use, with its capabilities in each | (filtered) |
| `get_mailbox_summary` | Unread per folder, needs-reply count, pending scheduled, snoozed, top senders | read |
| `list_emails` | Messages in a folder, newest first; filters `unread`, `starred` | read |
| `get_email` | One message as text, plus attachment metadata | read |
| `get_thread` | A whole conversation, oldest first | read |
| `search_emails` | Full-text search with `from:`, `to:`, `subject:`, `in:`, `is:`, `has:`, `label:`, `before:`/`after:`, `OR`, `-` | read |
| `list_folders` | Folders with unread counts | read |
| `create_folder` | New custom folder (id is a slug of the name) | organise |
| `list_labels` | Labels with ids and colours | read |
| `create_label` | New label | organise |
| `apply_label` / `remove_label` | Tag or untag a message | organise |
| `star_email` | Star or unstar | organise |
| `mark_email_read` | Read or unread | organise |
| `snooze_email` / `unsnooze_email` | Hide until a time, or bring back now | organise |
| `set_priority` | `high`, `low` or `none` | organise |
| `archive_email` | Move to Archive | organise |
| `move_email` | Move to any folder except Drafts and Scheduled | organise |
| `mark_not_spam` | Back to the inbox, unblock and allowlist the sender | organise |
| `trash_email` / `delete_email` | Move to Trash (never permanent) | delete |
| `restore_email` | Out of Trash, back where it came from | delete |
| `bulk_update` | Up to 100 ids: `read`, `unread`, `star`, `unstar`, `archive`, `move`, `label`, `unlabel`, `trash`, `restore` | per action |
| `draft_reply` | Save a reply to Drafts, with the original quoted | draft |
| `create_draft` / `update_draft` | New or edited draft | draft |
| `send_reply` | Send a threaded reply now | sendAs or sendOnBehalf |
| `send_email` | Send a new message now | sendAs or sendOnBehalf |
| `forward_email` | Forward with an optional note and the original's attachments | sendAs or sendOnBehalf |
| `schedule_send` | Queue a message, reply or forward for later (up to 90 days) | sendAs or sendOnBehalf |
| `list_scheduled` | Queued sends, soonest first | read |
| `cancel_scheduled` | Cancel a queued send; it returns to Drafts | sendAs or sendOnBehalf |
| `list_attachments` | A message's attachments | read |
| `get_attachment` | Text for text-like types; base64 up to `max_bytes` (default 256 KB, max 1 MB) otherwise; metadata only above that | read |
| `list_templates` | Saved templates and the `{{variables}}` each needs | (instance-wide) |
| `send_template` | Render a template with variables and send it | sendAs or sendOnBehalf |
| `list_people` | Correspondents merged across readable mailboxes | read |
| `get_person_history` | Everything exchanged with one address | read |
| `list_rules` | Inbound filter rules, in run order | read |
| `create_rule` | New inbound filter rule | manageRules |
| `list_signatures` | Signatures as text | read |
| `create_signature` | New signature (remote images and unsafe links removed) | manageSettings |
| `list_pending_sends` | Sends held for approval, with status, revision and `yours`; read-only | read |
| `get_pending_send` | One held send: what approval would send, rejection note, result | read |
| `list_sequences` | Drip sequences and their steps | (instance-wide, `mail:read`) |
| `enroll_in_sequence` | Enroll one person; held for approval like any send | sendAs or sendOnBehalf |
| `create_template` / `update_template` | Save or edit a shared template; one a sequence uses is refused | (instance-wide, `mail:draft`; `admin` for a mailbox-limited token) |
| `check_suppressions` | Which addresses are suppressed for mail from this mailbox, and for what kind of mail | read |
| `list_suppressions` | The deployment's suppression list | admin + `mailboxes:manage` |
| `get_thread_summary` | AI summary of a conversation; `generate` makes one within the daily cap | read |
| `get_analytics` | Delivery and engagement for this mailbox's sent mail | read |
| `list_imports` | Mail import progress | read |
| `get_usage` | Month-to-date usage, cost and budget alerts | admin + `admin` |
| `create_agent_inbox` | New mailbox for an agent, with a token confined to it (secret shown once) | admin + `mailboxes:manage` |
| `list_agent_inboxes` | Agent inboxes with send mode, allowed recipients and time left | admin + `mailboxes:manage` |
| `delete_agent_inbox` | Revoke, archive to R2 as mbox, delete | admin + `mailboxes:manage` |

Every send passes the pre-send gate, which also applies the sending mailbox's agent inbox policy, if it has one: `allowed_recipients`, and the send mode when the call uses the agent's own token. See the README's "Agent inboxes" section.

## Prompts

- `triage_inbox(mailboxId, limit?)` summarises the inbox, archives noise, stars anything that needs action, and leaves reply drafts for you to approve. It never sends.
- `catch_up_with_person(person)` summarises the history with one address and drafts the next reply if one is owed.
