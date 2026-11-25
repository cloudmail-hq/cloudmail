# MCP server

> Connect Claude, Cursor or any other MCP client to your mailboxes at /mcp, signing in with OAuth or an API token.

This deployment serves the [Model Context Protocol](https://modelcontextprotocol.io) at `{{BASE_URL}}/mcp` over Streamable HTTP. An MCP client can read, organise, draft and send mail with the same access as the user who connected it.

## Two ways to sign in

| | OAuth | API token |
| --- | --- | --- |
| How | The client opens a browser, you sign in and approve it | You send `Authorization: Bearer ttk_...` |
| Best for | Desktop and chat clients a person uses | Headless agents, and clients without OAuth support |
| Acts on | `/mcp` only, never `/api/*` | `/mcp` and the REST API |
| Limited by | Your own mailbox access | Your access, narrowed by the token's scopes and mailboxes |
| Manage it | Settings, Account & security, Connected apps | [Settings, API tokens](/settings/account?new-token=1) |

For a bot, create a dedicated user, grant it only the mailboxes and role it needs, and make the token as that user.

## Connect with OAuth

Give the client the URL `{{BASE_URL}}/mcp`. The first time it connects, a browser opens on this deployment. Sign in if you are asked to. The page shows the app's name and where access will be sent. Choose **Approve**.

The app then acts as you, with your mailbox access. Clients that follow the MCP authorization specification work without extra setup: OAuth 2.1 with PKCE, dynamic client registration, and discovery through `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`. Refresh tokens rotate on every use and last up to 30 days.

Connected apps are listed under Settings, Account & security, Connected apps, where you can disconnect each one. Disabling or deleting a user, resetting their password, or signing out all other sessions also disconnects every app.

### Claude Code

```bash
claude mcp add --transport http cloudmail {{BASE_URL}}/mcp
```

### Claude Desktop

Open Settings, Connectors, Add custom connector, and enter `{{BASE_URL}}/mcp`. Claude Desktop signs in through OAuth.

### Cursor

In `~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "cloudmail": {
      "url": "{{BASE_URL}}/mcp"
    }
  }
}
```

## Connect with an API token

Create a token at [Settings, API tokens](/settings/account?new-token=1) with the scopes the agent needs; see [Authentication](/docs/authentication). Then pass it as a header.

### Claude Code

```bash
claude mcp add --transport http cloudmail {{BASE_URL}}/mcp --header "Authorization: Bearer $CLOUDMAIL_TOKEN"
```

### Cursor

```json
{
  "mcpServers": {
    "cloudmail": {
      "url": "{{BASE_URL}}/mcp",
      "headers": { "Authorization": "Bearer ttk_..." }
    }
  }
}
```

### Claude Desktop

Bridge the server with `mcp-remote` in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cloudmail": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "{{BASE_URL}}/mcp",
        "--header", "Authorization: Bearer ${CLOUDMAIL_TOKEN}"
      ],
      "env": { "CLOUDMAIL_TOKEN": "ttk_..." }
    }
  }
}
```

## Check the connection

```bash
curl -si -X POST "{{BASE_URL}}/mcp"
```

This answers `401` with a `WWW-Authenticate` header that points at `/.well-known/oauth-protected-resource/mcp`. If that header is missing, OAuth is switched off on this deployment and `/mcp` accepts only API tokens. Use a token until an administrator fixes it.

## Where the tool list lives

Your MCP client asks the server for its tools when it connects and shows them to you, so the list in the client is always the one this deployment serves. Call `list_mailboxes` first: most tools take a mailbox from it, and each mailbox lists what the session may do there.

The tools fall into these groups:

| Group | Tools |
| --- | --- |
| Find your way | `list_mailboxes`, `get_mailbox_summary`, `list_folders`, `list_labels` |
| Read | `list_emails`, `get_email`, `get_thread`, `search_emails`, `semantic_search`, `ask_inbox`, `list_attachments`, `get_attachment`, `get_thread_summary`, `list_people`, `get_person_history` |
| Organise | `star_email`, `mark_email_read`, `archive_email`, `move_email`, `apply_label`, `remove_label`, `snooze_email`, `unsnooze_email`, `set_priority`, `mark_not_spam`, `bulk_update`, `create_folder`, `create_label` |
| Trash | `trash_email`, `delete_email`, `restore_email` |
| Draft | `create_draft`, `update_draft`, `draft_reply` |
| Send | `send_email`, `send_reply`, `forward_email`, `schedule_send`, `list_scheduled`, `cancel_scheduled`, `send_template`, `enroll_in_sequence` |
| Held sends | `list_pending_sends`, `get_pending_send`, `revise_pending_send` |
| Follow-ups and screening | `set_followup`, `list_awaiting_reply`, `list_screener`, `screen_sender` |
| Rules, signatures, templates | `list_rules`, `create_rule`, `list_signatures`, `create_signature`, `list_templates`, `create_template`, `update_template`, `list_sequences` |
| Suppressions and reporting | `check_suppressions`, `list_suppressions`, `get_analytics`, `get_usage`, `list_imports`, `get_daily_brief` |
| Administration | `list_domains`, `get_domain_status`, `list_webhooks`, `test_webhook`, `create_agent_inbox`, `list_agent_inboxes`, `delete_agent_inbox`, `list_products`, `list_label_prompts`, `set_label_prompt` |

There are two prompts: `triage_inbox`, which summarises the inbox, archives noise and leaves reply drafts without sending, and `catch_up_with_person`, which summarises the history with one address.

Each tool's description and input schema come from the server. The full reference, with the capability each tool needs, is `docs/mcp.md` in the cloudmail source you deployed from.

## What a client can and cannot do

- **Same checks as the REST API.** Every mailbox tool checks the capability its REST route needs. A viewer can read but not send. With a token, the token's scopes and mailbox list apply too.
- **No permanent deletion.** `trash_email`, `delete_email` and `bulk_update` only move mail to Trash. No tool empties Trash.
- **Sends can be held.** By default a send tool does not send. It returns `{"status": "pending_approval", "approval_id": "...", "approval_url": "..."}` and a person approves or rejects it in the app. The agent should report that and not retry. There is no tool to approve or reject a send, and a connected app can never approve one. See [Agent sends and approval](/docs/guides/approvals).
- **Sending without approval** needs the mailbox set to send automatically, and either a token with `mail:send:auto` or a connected app with "Send without approval" ticked in Connected apps. Recipients on the mailbox's skip-approval list also go straight out.
- **Email content is untrusted.** `get_email`, `get_thread` and `get_pending_send` wrap sender-written text in untrusted-content markers. When the injection detector flags what was read, the session's sends are held for approval for 30 minutes, whatever the mode.
- **Webhook secrets stay out.** Creating a webhook is not an MCP tool, so a signing secret never lands in a model transcript. Create webhooks through the [API](/docs/guides/webhooks) or the app.
- **Audited.** Every write and every send outcome is in the mailbox's access log, with the user and the token or connected app.

## Results and paging

- Results are compact JSON. Message lists return `id`, `thread_id`, `folder`, `subject`, `from`, `to`, `date`, `read`, `starred` and a plain-text `snippet`.
- `get_email` and `get_thread` return `body_text`, capped by `max_chars`, with `body_truncated` set when the cap is hit. Pass `include_body: true` for the raw HTML.
- Lists page with `page` and `limit`. Pass `next_page` from the response to continue; `null` means there are no more pages.
- Errors come back with `isError: true` and `{"error": "..."}`. A missing capability is named, and the message says not to retry.

## Safe retries

The send, create and schedule tools take an optional `idempotency_key` of 1 to 256 printable ASCII characters. Pass a fresh one for each action, and the same one when you retry it.

- The first call with a key runs, and a successful result is kept for 24 hours.
- A repeat with the same key and the same arguments returns that result without acting again.
- The same key with different arguments is refused with `code: idempotency_key_reused`.
- An error result is not kept, so a retry with the same key runs again.

MCP keys are kept apart from REST keys, so a key used with the `Idempotency-Key` header never replays an MCP call. See [Idempotency keys](/docs/guides/idempotency).

## Rate limit

MCP requests are limited to 120 a minute per caller. Sends also count against the mailbox's hourly and daily send caps. See [Rate limits](/docs/rate-limits).
