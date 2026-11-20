# Troubleshooting

Problems people hit when deploying, setting up and running cloudmail, with the
exact message you see and what to do. Start with the Worker's logs: dashboard →
**Workers & Pages** → your Worker → **Logs**, or `npx wrangler tail cloudmail`.

- [Deploying](#deploying)
- [First run](#first-run)
- [Guided setup](#guided-setup)
- [Receiving mail](#receiving-mail)
- [Sending mail](#sending-mail)
- [Workers Free plan limits](#workers-free-plan-limits)
- [Signing in](#signing-in)
- [API, CLI and MCP clients](#api-cli-and-mcp-clients)

## Deploying

### The build can't create the R2 bucket

R2 has to be turned on once per account. Open the dashboard → **R2**, complete
the sign-up (Cloudflare may ask for a payment method even for the free tier),
then retry the deploy.

### `a namespace with this account ID and title already exists`

```
A request to the Cloudflare API (/accounts/…/storage/kv/namespaces) failed.
a namespace with this account ID and title already exists [code: 10014]
```

An earlier deploy created the KV namespace (`cloudmail-oauth-kv`) and then
failed before the Worker was uploaded, so the namespace exists but isn't linked.
Either delete it (dashboard → **Storage & Databases** → **KV**, or
`npx wrangler kv namespace delete --namespace-id <id>`), or put its id in
`wrangler.jsonc`:

```jsonc
"kv_namespaces": [{ "binding": "OAUTH_KV", "id": "<the namespace id>" }]
```

Then deploy again.

### `Vectorize binding 'SEMANTIC_INDEX' references index 'cloudmail-semantic' which was not found [code: 10159]`

You deployed with `wrangler deploy`, which does not create Vectorize indexes
(the Deploy button does). Create it, then deploy again:

```bash
npx wrangler vectorize create cloudmail-semantic --dimensions=1024 --metric=cosine
```

### The build log says it could not create the metadata index

```
[vectorize] WARNING: could not create the "mailbox" metadata index on cloudmail-semantic.
```

The deploy finished; only semantic search is waiting. Connect a Cloudflare
token in the guided setup and apply the **semantic search index** item, or run
the command the warning prints. Do it before mail arrives: Vectorize can only
filter messages indexed after the metadata index exists. Creation is queued and
takes a minute or so to show up.

### I renamed the Worker, bucket or index in the deploy form

The app finds its resources by name for a few things: the catch-all rule
targets the Worker by name, the guided setup checks the Vectorize index by
name, and the usage page reads the bucket by name. Set the matching variable on
the Worker (dashboard → your Worker → **Settings → Variables and Secrets**):

| You renamed | Set |
| --- | --- |
| the Worker | `WORKER_SCRIPT_NAME` (or connect a token; the app detects the Worker) |
| the Vectorize index | `SEMANTIC_INDEX_NAME` |
| the R2 bucket | `R2_BUCKET_NAME` |

## First run

### Where is the setup token?

If you set `SETUP_TOKEN` in the deploy form, that is the token. If you left it
empty, the Worker generated one: open `/setup`, then look in the Worker's logs
for

```
[cloudmail] First-run setup is pending. Setup token: … — enter it at /setup …
```

`npx wrangler tail cloudmail` shows it too while you reload `/setup`. To choose
your own instead, set the `SETUP_TOKEN` secret (`npx wrangler secret put SETUP_TOKEN`).
A generated token can't be used for `/recover`; set a secret of 16 or more
characters if you want recovery.

### "Invalid setup token"

Copy the token again without spaces. If you set `SETUP_TOKEN` after the first
visit, the secret now wins over the generated one.

### "Activate your licence" and 402 `licence_required`

Until a licence is active, the app shows only the activation screen and the API
answers 402. Incoming mail is still received and stored. Paste the key from
your purchase email at the **Licence** step of the guided setup or at
**Settings → Licence**.

- "That licence key wasn't recognised": check for missing characters, or that
  you copied the key and not the order number.
- A key already used on another deployment: deactivate it there first
  (**Settings → Licence → Deactivate**), or contact support.

## Guided setup

### "The token is missing access to …"

The list says which permission is missing and what Cloudflare answered (for
example `HTTP 403 (code 10000)`). Open the dashboard → **My Profile → API
Tokens** (or **Manage Account → API Tokens** for an account token), edit the
token, add the permission, then press **Verify** at **Settings → Cloudflare
connection**. The **Create token** button there opens a token with every
permission already chosen. You can continue without the missing ones; the plan
shows those steps as manual.

### "Email Sending is not enabled on this account"

That is the Cloudflare plan, not your token: Email Sending to any recipient
needs Workers Paid. See [Sending mail](#sending-mail).

### A domain shows "Nameservers pending"

The zone isn't active on Cloudflare yet. Change the nameservers at your
registrar to the two Cloudflare shows, wait for the zone to turn active, then
press **Refresh**.

### Turning on Email Routing needs my confirmation

The domain already has MX records from another provider, or an SPF record
without `include:_spf.mx.cloudflare.net`. Turning on Email Routing would move
mail away from the other provider at once, or leave two SPF records (which
makes receivers reject your mail). The plan shows the exact records before and
after. Move or export old mail first.

### "Something changed since you reviewed"

DNS or routing changed between showing the plan and applying it (or another
admin applied it). Review the new plan and apply again.

## Receiving mail

1. **Is Email Routing on?** Dashboard → your domain → **Email** → **Email
   Routing**: the status should be "Enabled" and the MX records Cloudflare's.
2. **Does the catch-all go to this Worker?** Under **Routing rules** →
   **Catch-all address**, the action must be "Send to a Worker" and the Worker
   this deployment's name. A rule pointing at another name (for example after
   renaming the Worker) drops your mail.
3. **Does a mailbox exist for the address?** Mail to an address with no
   mailbox, alias or catch-all mailbox is dropped, not bounced. Set a catch-all
   mailbox under **Settings → Domains** if you want everything.
4. **Logs.** Each delivery shows in the Worker's logs as an `email` event.

## Sending mail

### On Workers Free

Cloudflare Email Sending delivers only to your own verified addresses on the
Free plan. A send to anyone else fails, typically with
`E_RECIPIENT_PLAN_RESTRICTED` or `E_RECIPIENT_NOT_ALLOWED`, and the guided setup
shows **Choose how example.com sends mail**. Either:

- upgrade the account to **Workers Paid** ($5 a month, includes 3,000 sends a
  month) and press **Re-check** in the guided setup; or
- send through your own **Resend** or **Amazon SES** account: **Settings →
  Domains → your domain → Sending**, pick the provider, paste the key, press
  **Test connection**. Verify the domain in the provider first.

### Sent mail lands in spam

Check **Settings → Domains → your domain**: SPF, DKIM and DMARC should all pass.
Keep exactly one SPF record and one DMARC record. New sending domains start
with a low daily quota and a reputation to build; cloudmail is not built for
bulk or cold outreach.

### Password reset emails never arrive

Reset by email needs a sending domain (see above) and uses
`no-reply@<first domain>` unless `AUTH_EMAIL_FROM` is set. Until then an admin
can create a reset link at **Settings → Users & invites**.

## Workers Free plan limits

cloudmail deploys and runs on Workers Free, but these limits can bite:

- **CPU time.** Cloudflare documents 10 ms of CPU per request on Free. In a
  test on a Free account (2026-11), creating the owner used about 200 ms and a
  sign-in about 110 ms, and both succeeded. If you see error 1102 ("Worker
  exceeded resource limits") on sign-in or when large messages arrive, move to
  Workers Paid.
- **Daily quotas** reset at 00:00 UTC: 100,000 Worker requests, 100,000 Durable
  Object requests and 100,000 rows written, and 10,000 Workers AI neurons. When
  Workers AI runs out, summaries, triage and semantic indexing pause until the
  next day; mail keeps flowing.
- **Sending:** see [On Workers Free](#on-workers-free).

## Signing in

- **Owner locked out** (forgotten password or lost authenticator). Open
  `/recover`, enter `SETUP_TOKEN` and a new password. This also disables the
  owner's 2FA and signs out every owner session. Another admin can instead
  generate a reset link at **Settings → Users & invites**.
- **Too many attempts / sign-in locked.** Password lockout is per email and
  network address, so signing in from another network (or after the
  `retryAfter` period) works; an admin reset link also clears it. A locked
  second factor clears after `retryAfter` or after the owner runs `/recover`.
- **"Authenticator codes can't be checked" after changing `AUTH_SECRET`.** TOTP
  secrets are encrypted under `AUTH_SECRET`, so setting it for the first time
  or changing it after users enabled 2FA makes their secrets undecryptable (the
  Worker logs `Cannot decrypt the 2FA secret`). Affected users sign in with a
  recovery code, then turn 2FA off and on again under **Account & security**;
  the owner without codes can use `/recover`. Restoring the previous
  `AUTH_SECRET` also fixes it. A stored Cloudflare token is encrypted the same
  way: reconnect it at **Settings → Cloudflare connection**.
- **`/recover` says recovery is unavailable.** `SETUP_TOKEN` is unset, was only
  generated, or is shorter than 16 characters (the Worker log says which). Set
  a longer one with `npx wrangler secret put SETUP_TOKEN`. If it answers
  "locked", 10 wrong tokens were tried within an hour; wait an hour.
- **Passkeys stopped working after moving to a custom domain.** Passkeys are
  bound to the host name. Sign in with your password and register a new passkey.

## API, CLI and MCP clients

- **An MCP client says it cannot authenticate, or never opens a browser.**
  `curl -si -X POST https://<host>/mcp` should return `401` with
  `WWW-Authenticate: Bearer ... resource_metadata="https://<host>/.well-known/oauth-protected-resource/mcp"`.
  No such header means OAuth is off: the deployment is in Access mode, or the
  `OAUTH_KV` binding is missing (redeploy with `wrangler deploy` so it is
  created). Use a `ttk_` header meanwhile.
- **"Can't connect this app" on the consent page.** The request was malformed,
  or its redirect URI isn't one the client registered, so the page refuses to
  send anything back. Start the connection again from the client. "Expired or
  was already used" means the page sat open for more than ten minutes, or was
  approved in another tab.
- **"Connecting an app needs a signed-in browser session."** The authorize page
  was opened with an API token. Open it in a browser where you are signed in.
- **A connected app stopped working.** It was disconnected under **Connected
  apps**, or the account was disabled, reset or signed out everywhere.
  Approvals also end 30 days after they were made. Reconnect from the client,
  for example with `/mcp` in Claude Code.
- **`Sign in required` from the CLI, curl or an MCP client.** The request
  carried no valid credential. Check the `Authorization: Bearer ttk_...` header
  or `CLOUDMAIL_TOKEN`, and confirm the token has not expired or been revoked
  under **Account & security**. Session cookies do not work for these clients.

Cloudflare Access mode has its own section in the
[reference](reference.md#troubleshooting-access).

Still stuck? See [Support](../README.md#support).
