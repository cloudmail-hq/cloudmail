# Authentication

> Create an API token, send it as a Bearer token, and limit what it can do with scopes and a mailbox list.

Every request to `{{BASE_URL}}/api/v1` carries an API token:

```http
Authorization: Bearer ttk_<id>_<secret>
```

Four endpoints answer without one: the [health check](/docs/api/meta/get-health), the [OpenAPI document](/docs/api/meta/get-open-api-document), and the deployment's [name and colour](/docs/api/branding/get-branding) and [logo](/docs/api/branding/get-branding-logo), which the sign-in page shows.

## Create a token

Open [Settings, Account & security, API tokens](/settings/account?new-token=1). The form asks for four things:

| Field | Meaning |
| --- | --- |
| Name | A label for you, such as `billing-service` or `ci`. It is shown in the token list and the access log. |
| Expires | 30 days, 90 days, 1 year, or no expiry. An expired token answers `401`. |
| Scopes | What the token may do. Presets: **Read only**, **Send only** and **Full access**. |
| Mailboxes | Every mailbox you can reach, or only the ones you tick. |

The token is shown once, when you create it. Only a hash is stored, so a lost token cannot be recovered: revoke it and create another.

Tokens are created from a signed-in browser session. If your deployment requires two-factor sign-in, set that up first.

## What a token can do

A token never has more access than the person who created it. Its effective permission is the overlap of three things:

- your own access to each mailbox,
- the token's scopes,
- the token's mailbox list.

A scope you do not have the access for does nothing. To check what a token ends up with, call [Get the current caller](/docs/api/me-config/get-me): `capabilities` lists what it may do in each mailbox, and `token` shows its scopes and mailbox list.

## Scopes

| Scope | Allows |
| --- | --- |
| `mail:read` | List, read and search messages, download attachments, export; people and analytics; read templates and sequences. |
| `mail:send` | Send, reply, forward and schedule mail; sequence writes and enrollment. |
| `mail:send:auto` | With `mail:send`: sends skip approval on mailboxes set to send automatically. See [Agent sends and approval](/docs/guides/approvals). |
| `approvals:manage` | Approve or reject sends that are waiting for approval. Never for sends the token itself asked for. |
| `mail:draft` | Create and edit drafts; template writes. |
| `mail:organize` | Move, label, mark read or starred, snooze, mute, set priority, delete and empty Trash. |
| `mailboxes:manage` | Mailbox settings, signatures, rules, sender lists and delegates; create or delete mailboxes (administrators). |
| `domains:manage` | Domains, DNS checks, catch-all and aliases (administrators). |
| `webhooks:manage` | Create and manage webhooks. |
| `admin` | Administrator routes: users, access grants, the audit log, branding, preferences. |

The presets are **Read only** (`mail:read`), **Send only** (`mail:send`) and **Full access** (every scope except `mail:send:auto` and `approvals:manage`, which you always tick yourself).

Each endpoint page in the [API reference](/docs/api) names the scope it needs. A call without it answers `403`.

On a mailbox route, the body names the capability the token is missing in that mailbox:

```json
{
  "error": "You do not have permission to do this in this mailbox (sendAs or sendOnBehalf)",
  "capability": "sendAs",
  "capabilities": ["sendAs", "sendOnBehalf"]
}
```

On every other route, it names the scope:

```json
{
  "error": "This API token does not have the \"webhooks:manage\" scope.",
  "code": "insufficient_scope",
  "scope": "webhooks:manage"
}
```

## Limit a token to mailboxes

Tick **Only these mailboxes** in the form and choose them. The token then cannot see or touch any other mailbox, whatever its scopes.

A token limited to mailboxes holds only the `mail:*` scopes you gave it. `admin`, `domains:manage`, `webhooks:manage` and `mailboxes:manage` are never implied; tick them if the token needs them.

## Tokens that create tokens

A token with scopes can create child tokens through `POST {{BASE_URL}}/api/auth/tokens`. A child can only be narrower: its scopes and mailboxes must be a subset of the parent's, and it expires no later than the parent. Revoking the parent revokes its children.

```bash
curl -X POST "{{BASE_URL}}/api/auth/tokens" \
  -H "Authorization: Bearer $CLOUDMAIL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "nightly-report",
    "expiresInDays": 30,
    "scopes": ["mail:read"],
    "mailboxes": ["support@example.com"]
  }'
```

```json
{
  "token": {
    "id": "a1B2c3D4e5F6",
    "name": "nightly-report",
    "scopes": ["mail:read"],
    "mailboxes": ["support@example.com"],
    "expiresAt": 1802736000000
  },
  "secret": "ttk_a1B2c3D4e5F6_..."
}
```

`secret` is the token, returned once. `GET {{BASE_URL}}/api/auth/tokens` lists the calling token and the tokens it created, and `DELETE {{BASE_URL}}/api/auth/tokens/<id>` revokes one.

## Rotate and revoke

Tokens are independent, so you can rotate without downtime:

1. Create a new token with the same scopes and mailboxes.
2. Deploy it alongside the old one.
3. Watch the old token in the token list until its "used" time stops changing.
4. Revoke the old token. Requests with it answer `401` at once.

The token list shows when and from which IP address each token was last used. Disabling or deleting a user also stops every token that user created.

## Keep tokens off the client

A token can read mail, so it belongs on a server you control. Do not put one in a web page or a mobile app. Call your own backend from there and have the backend call this API.

The API does not send CORS headers for other origins, so a browser on another site cannot read its responses.

## Other ways to sign in

- **MCP clients** sign in through the browser with OAuth and need no token. See [MCP server](/docs/mcp).
- **The web app** uses a session cookie. It is not meant for scripts: cross-site writes are refused.
- **Cloudflare Access mode.** If this deployment sits behind Cloudflare Access, API tokens are not used. Machines send an Access service token in the `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers, and an administrator grants that service its mailboxes in Settings.
