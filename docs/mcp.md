# MCP server

cloudmail serves the [Model Context Protocol](https://modelcontextprotocol.io) at `https://<host>/mcp` over Streamable HTTP. Any MCP client can read, organise, draft and send mail with the same authority as the user who connected it.

## Connecting

Two ways to authenticate:

- **OAuth** (password mode, needs the `OAUTH_KV` binding). The client opens a browser on `/oauth/authorize`, you approve it, and it acts as you on `/mcp` only. Manage connected apps under **Settings → Account & security → Connected apps**.
- **API token**. Create one under **Settings → Account & security → API tokens** and send `Authorization: Bearer ttk_...`. Use this for headless agents, or for clients without OAuth support. For a bot, create a dedicated user, grant it only the mailboxes and role it needs, and mint the token as that user.

### Claude Code

```bash
# OAuth
claude mcp add --transport http cloudmail https://mail.example.com/mcp

# Token
claude mcp add --transport http cloudmail https://mail.example.com/mcp \
  --header "Authorization: Bearer ttk_..."
```

### Claude Desktop

Use **Settings → Connectors → Add custom connector** with the URL `https://mail.example.com/mcp`. Claude Desktop signs in through OAuth.

To use a token instead, bridge the server with `mcp-remote` in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cloudmail": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "https://mail.example.com/mcp",
        "--header", "Authorization: Bearer ${CLOUDMAIL_TOKEN}"
      ],
      "env": { "CLOUDMAIL_TOKEN": "ttk_..." }
    }
  }
}
```

### Cursor

In `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "cloudmail": {
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

- **Same gates as the REST API.** Every mailbox-scoped tool checks the capability its REST route needs (`read`, `organise`, `draft`, `delete`, `sendAs`/`sendOnBehalf`, `manageRules`, `manageSettings`). A `viewer` can read but not send. Tools that are not tied to one mailbox check the API token's scope instead, and some are for administrators only; the [Tools](#tools) table says which. `list_mailboxes` shows only the mailboxes the session can use, and each one lists the session's capabilities in that mailbox.
- **No permanent deletion.** `delete_email`, `trash_email` and `bulk_update` with `trash` only move mail to Trash. They never destroy a message that is already in Trash or Spam, and no tool empties Trash. Trash is purged automatically after 30 days.
- **Sends respect attribution.** Send tools need `sendAs` or `sendOnBehalf` and resolve attribution the same way the REST send path does. Agent-written bodies pass the draft verifier, and a send is refused if the verifier is unavailable. Templates skip the verifier because a person wrote them. Their variables are HTML-escaped.
- **Annotations.** Every tool sets `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`. Clients can use these to ask before a send. The annotations are hints; the capability gates are what actually enforce access.
- **Sends can be held for approval.** By default (`approve` mode) a send tool does not send: it returns `{"status":"pending_approval","approval_id":"apr_…","approval_url":"…"}` and the user approves or rejects it in the app or with `cloudmail approval`. Treat that as success-pending, tell the user, and do not retry or send another way. A mailbox in `draft_only` mode refuses with `code: "draft_only"`; suppressed recipients are refused. Sending without approval needs the mailbox in `auto` mode **and** a token with `mail:send:auto` (or a connected app marked "Send without approval"), or recipients on the mailbox's allowlist. The same rule applies to the REST API with the same credential (202 `pending_approval`). What is held is the composed message, so approving sends exactly what the user previewed. There is no MCP tool to approve or reject a send, and a connected app can never approve one. An agent can check what became of its held sends with `list_pending_sends` and `get_pending_send`, and change one with `revise_pending_send`. `enroll_in_sequence` is held the same way, with every rendered step in the preview. See [Agent sends and approval](reference.md#agent-sends-and-approval).
- **Untrusted content.** `get_email`, `get_thread` and `get_pending_send` return sender-written fields (subject, body, snippet) wrapped in `<<<UNTRUSTED_EMAIL boundary=…>>>` markers and tag the result `"untrusted": true`. The rows of `semantic_search` and `list_pending_sends`, the top messages in `get_analytics` and the text of `get_thread_summary` are wrapped the same way, and an `ask_inbox` answer is tagged `"untrusted": true`. When the injection detector flags what `get_email`, `get_thread`, `get_pending_send` or `get_thread_summary` returned, the result carries `"injection_suspected": true` and this session's sends are held for approval for 30 minutes, whatever the mode. The server instructions and the `triage_inbox` prompt tell the model to treat email content as data, not instructions.
- **Audited.** Every write (drafts, moves, labels, trash, rules) and every send outcome is in the mailbox's access log with the user and the API token or connected app.
- **Rate limits.** 120 requests a minute per caller (`MCP_RATE_LIMITER`), plus the mailbox's hourly and daily send quota.
- **Webhook secrets stay out.** `list_webhooks` never returns a signing secret, and no tool creates a webhook endpoint, because creating one returns its secret. Create endpoints in the app, with the REST API or with the CLI.
- **Safe retries.** Send, create and schedule tools, and a few tools that set state, take an optional `idempotency_key`. See [Idempotency keys](#idempotency-keys).

## Idempotency keys

`send_email`, `send_reply`, `forward_email`, `schedule_send`, `send_template`, `enroll_in_sequence`, `create_signature`, `create_draft`, `draft_reply`, `create_folder`, `create_label`, `create_rule`, `set_followup`, `set_label_prompt` and `screen_sender` accept an optional `idempotency_key` (1–256 printable ASCII characters). Pass a fresh one for each action you mean to take, and the same one when you retry it.

- The first call with a key runs. A successful result is kept for 24 hours in the mailbox.
- A repeat with the same key and the same arguments returns that result without acting again, with an extra `{"idempotent_replayed": true}` content item.
- The same key with different arguments is refused with `code: idempotency_key_reused`.
- A repeat while the first call is still running is refused with `code: idempotency_request_in_progress`. Retry after a second. A reservation abandoned by a crash frees itself after 2 minutes.
- An error result is not kept, so a retry with the same key runs again.

Keys are scoped to the session's user and API token and to the tool, and stored in the target mailbox's Durable Object, the same table the REST `Idempotency-Key` header uses (but a separate scope, so a REST key never replays an MCP call).

## Message bodies

`draft_reply`, `create_draft`, `update_draft`, `send_reply`, `send_email`, `schedule_send` and `revise_pending_send` take the body as `bodyMarkdown` or `bodyHtml`, not both. Use `bodyMarkdown`. The server checks it for agent artifacts as text, then renders it into email HTML and a matching plain-text part, so the message reads the same in every client and in the composer when a person opens the draft.

- Paragraphs are separated by a blank line. A single line break stays a line break, so a sign-off such as `Thanks,` then `Maya` keeps its two lines, and `--` under a name stays a signature dash.
- `#` headings, `-` and `1.` lists (nested by indenting), `- [ ]` task items, `**bold**`, `*italic*`, `~~strike~~`, `[links](https://…)`, bare URLs, tables, `>` quotes, `` `code` `` and fenced code blocks.
- Raw HTML is shown as text. Links work for `http`, `https` and `mailto`. An image becomes a link to it, because remote images in mail are blocked or tracked.
- The rendered HTML has no colours, so it works in dark mode. Headings, tables, code and quotes carry small inline styles.
- A link or footnote definition is hidden only when a link or note in the message uses it. Any other is shown as written, so no text you wrote disappears.
- A Markdown body can be up to 100,000 characters. A body with quotes and lists nested more than 32 deep, counted together, is sent as plain text.

`forward_email` takes its `note` as plain text or Markdown, rendered the same way. The REST API, the CLI (`--markdown`, `--markdown-file`) and both SDKs (`markdown`) take Markdown bodies too.

## Output conventions

- Results are compact JSON. Message lists return `id`, `thread_id`, `folder`, `subject`, `from`, `to`, `date`, `read`, `starred`, a plain-text `snippet`, and triage flags (`needs_reply`, `has_attachment`, `priority`) when they're set.
- `get_email` and `get_thread` return `body_text`, capped by `max_chars`, with `body_truncated` set when the cap is hit. Pass `include_body: true` for the raw HTML.
- Lists paginate with `page` / `limit`. Pass `next_page` from the response to continue; `null` means there are no more pages. `list_emails` with `mailboxId` `"*"` pages with `cursor` instead: pass `next_cursor` from the response.
- Errors come back with `isError: true` and `{"error": "..."}`. A missing capability is reported by name and says not to retry.

## Tools

The Capability column names what the session needs. A plain word such as `read` is a capability on the mailbox passed as `mailboxId`. A value such as `mail:read` is a scope that an API token created with scopes must hold; a session that signed in through OAuth is not limited by scopes. "admin +" means the user must be an administrator, and a scoped token must hold the scope named or `admin`.

| Tool | What it does | Capability |
| --- | --- | --- |
| `list_mailboxes` | Mailboxes this session can use, with its capabilities in each | (filtered) |
| `list_products` | The products (brands) this deployment sends as: domains, aliases, accent colour, default templates, and the readable mailboxes that send as each | (instance-wide) |
| `get_mailbox_summary` | Unread per folder, needs-reply count, pending scheduled, snoozed, top senders | read |
| `get_daily_brief` | Morning brief for one mailbox or every readable one: new mail since the last brief time grouped by importance, conversations that need a reply, sent mail waiting on others, top senders | read |
| `list_emails` | Messages in a folder, newest first; filters `unread`, `starred`. `mailboxId` `"*"` lists every readable mailbox at once (up to 20), one row per conversation, optionally narrowed by `product` | read |
| `get_email` | One message as text, plus attachment metadata, reader `warnings` and `sender_trust` | read |
| `get_thread` | A whole conversation, oldest first, with the stored AI summary when there is one | read |
| `search_emails` | Full-text search with `from:`, `to:`, `cc:`, `bcc:`, `subject:`, `in:`, `is:`, `has:`, `label:`, `filename:`, `before:`/`after:`, `older_than:`/`newer_than:`, `larger:`/`smaller:`, `OR`, `-` | read |
| `semantic_search` | Search by meaning: full-text and vector results merged by rank, across one mailbox or every readable one (up to 20). `semantic` is `false` when only full-text results came back | read |
| `ask_inbox` | Answer a question from the mail the session can read, with `[n]` citations; `insufficient` is `true` when the mail does not answer it. Needs Workers AI | read |
| `list_folders` | Folders with unread counts | read |
| `create_folder` | New custom folder (id is a slug of the name) | organise |
| `list_labels` | Labels with ids and colours | read |
| `create_label` | New label | organise |
| `apply_label` | Add a label to a message | organise |
| `remove_label` | Remove a label from a message; the label itself is kept | organise |
| `list_label_prompts` | AI triage setup: each label's prompt, auto-archive and inbox-tab settings, the built-in presets, and today's AI calls against the daily cap | read |
| `set_label_prompt` | Give a label a prompt so it is applied to new mail automatically, or turn a preset on or off; `backfill` also classifies one batch of the last 14 days' mail | manageRules |
| `star_email` | Star or unstar | organise |
| `mark_email_read` | Read or unread | organise |
| `snooze_email` | Hide a message until a time, then return it to its folder as unread | organise |
| `unsnooze_email` | Bring a snoozed message back now | organise |
| `set_priority` | `high`, `low` or `none` | organise |
| `archive_email` | Move to Archive | organise |
| `move_email` | Move to any folder except Drafts and Scheduled | organise |
| `mark_not_spam` | Back to the inbox, unblock and allowlist the sender | organise |
| `list_screener` | First-time senders waiting in the Screener, one row per sender with message count, latest subject and an AI pre-verdict | read |
| `screen_sender` | `allow` a screened sender (allowlist, backlog to the inbox) or `block` them (blocklist, backlog to Spam or Trash) | manageRules |
| `trash_email` | Move to Trash (never permanent) | delete |
| `delete_email` | Same as `trash_email`: moves to Trash, and refuses a message already in Trash or Spam | delete |
| `restore_email` | Out of Trash, back where it came from | delete |
| `bulk_update` | Up to 100 ids: `read`, `unread`, `star`, `unstar`, `archive`, `move`, `label`, `unlabel`, `trash`, `restore` | per action |
| `draft_reply` | Save a reply to Drafts, with the original quoted | draft |
| `create_draft` | New draft in Drafts, optionally attached to a thread | draft |
| `update_draft` | Replace fields of a draft; the draft gets a new id, returned as `newDraftId` | draft |
| `send_reply` | Send a threaded reply now | sendAs or sendOnBehalf |
| `send_email` | Send a new message now | sendAs or sendOnBehalf |
| `forward_email` | Forward now in the original thread, with an optional note above it. Attachments are re-attached where they fit the 5 MiB message limit; ones that do not fit are named in the forwarded header instead, and blocked ones are left out. `include_attachments: false` forwards without them | sendAs or sendOnBehalf |
| `schedule_send` | Queue a message, reply or forward for later (up to 90 days) | sendAs or sendOnBehalf |
| `list_scheduled` | Queued sends, soonest first | read |
| `cancel_scheduled` | Cancel a queued send; it returns to Drafts | sendAs or sendOnBehalf |
| `list_awaiting_reply` | Sent mail still waiting on a reply: fired follow-up reminders first, then pending ones by due date | read |
| `set_followup` | Set, move or cancel a reminder on a sent message: if nobody replies by the time given (within 90 days), the thread returns to the inbox unread with a Follow up label | organise |
| `list_attachments` | A message's attachments | read |
| `get_attachment` | Text for text-like types; base64 up to `max_bytes` (default 256 KB, max 1 MB) otherwise; metadata only above that | read |
| `list_templates` | Saved templates and the `{{variables}}` each needs | (instance-wide, `mail:read`) |
| `send_template` | Render a template with variables and send it | sendAs or sendOnBehalf |
| `create_template` | Save a shared template; a slug a sequence already refers to is refused | admin + `mail:draft` (`admin` for a mailbox-limited token) |
| `update_template` | Change a shared template's name, subject or body; one a sequence uses is refused | admin + `mail:draft` (`admin` for a mailbox-limited token) |
| `list_people` | Correspondents merged across readable mailboxes | read |
| `get_person_history` | Everything exchanged with one address | read |
| `list_rules` | Inbound filter rules, in run order | read |
| `create_rule` | New inbound filter rule | manageRules |
| `list_signatures` | Signatures as text | read |
| `create_signature` | New signature (remote images and unsafe links removed) | manageSettings |
| `list_pending_sends` | Sends held for approval, with status, revision and `yours`; read-only | read |
| `get_pending_send` | One held send: what approval would send, rejection note, result | read |
| `revise_pending_send` | Change the recipients, subject or body of a send this session asked for that is still waiting for approval. It stays held; a held sequence enrollment cannot be revised | sendAs or sendOnBehalf |
| `list_sequences` | Drip sequences and their steps | (instance-wide, `mail:read`) |
| `enroll_in_sequence` | Enroll one person; held for approval like any send | sendAs or sendOnBehalf |
| `check_suppressions` | Which addresses are suppressed for mail from this mailbox, and for what kind of mail | read |
| `list_suppressions` | The deployment's suppression list | admin + `mailboxes:manage` |
| `get_thread_summary` | AI summary of a conversation; `generate` makes one within the daily cap | read |
| `get_analytics` | Delivery and engagement for this mailbox's sent mail | read |
| `list_imports` | Mail import progress | read |
| `get_usage` | Month-to-date usage, cost and budget alerts | admin + `admin` |
| `list_domains` | The mail domains this deployment serves, with status, routing and sending status, catch-all mailbox, and whether each comes from config or was added at runtime | admin + `domains:manage` |
| `get_domain_status` | One domain in detail: routing, sending, DKIM, catch-all, the last DNS audit and the DNS records it needs. Does not re-run the audit | admin + `domains:manage` |
| `list_webhooks` | Outbound webhook endpoints the session can manage, each with its last 10 deliveries; never a secret | `webhooks:manage`; see below |
| `test_webhook` | Send a sample signed event to one endpoint now and report the delivery | `webhooks:manage`; see below |
| `create_agent_inbox` | New mailbox for an agent, with a token confined to it (secret shown once) | admin + `mailboxes:manage` |
| `list_agent_inboxes` | Agent inboxes with send mode, allowed recipients and time left | admin + `mailboxes:manage` |
| `delete_agent_inbox` | Revoke, archive to R2 as mbox, delete | admin + `mailboxes:manage` |

The webhook tools need a token with `webhooks:manage` or `admin`. An endpoint limited to some mailboxes is visible to an administrator, or to a user with `manageSettings` on every mailbox it names, and a mailbox-limited token must reach each of them. An endpoint for all mailboxes is visible only to an administrator whose token is not limited to particular mailboxes. `test_webhook` calls the endpoint's URL; it sends no mail.

Every send passes the pre-send gate, which also applies the sending mailbox's agent inbox policy, if it has one: `allowed_recipients`, and the send mode when the call uses the agent's own token. See [Agent inboxes](reference.md#agent-inboxes).

## Prompts

- `triage_inbox(mailboxId, limit?)` summarises the inbox, archives noise, stars anything that needs action, and leaves reply drafts for you to approve. It never sends.
- `catch_up_with_person(person)` summarises the history with one address and drafts the next reply if one is owed.
