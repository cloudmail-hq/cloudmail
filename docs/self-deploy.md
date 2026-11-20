# Deploy cloudmail on your Cloudflare account

This guide takes you from nothing to a working mailbox. It covers the
**Deploy to Cloudflare** button, the first-run setup, the guided Cloudflare
setup, and a deploy from the command line. If something goes wrong, see
[troubleshooting.md](troubleshooting.md).

## Before you start

You need:

- **A Cloudflare account** with your domain on Cloudflare DNS (the domain's
  nameservers point at Cloudflare). A domain that is still "pending" can't
  receive mail yet.
- **R2 turned on.** Open the dashboard → **R2** once and complete the sign-up.
  Cloudflare may ask for a payment method even though small usage is free.
  Without it the deploy can't create the bucket.
- **A plan for sending.** Cloudflare Email Sending to any recipient needs
  **Workers Paid** ($5 a month per account). On the Free plan you can still
  receive mail, and you can send through your own
  [Resend](https://resend.com) or [Amazon SES](https://aws.amazon.com/ses/)
  account instead. See [Cost and plan requirements](../README.md#cost-and-plan-requirements).
- **A licence key** from your purchase email
  ([buy one](https://licence.tapetide.com/cloudmail/buy/solo)).
- **A GitHub or GitLab account.** The button copies the repository into it and
  builds from there.

If another provider (Google Workspace, Microsoft 365, Zoho, …) handles mail
for the domain today, **move your old mail first** (see
[Importing mail](reference.md#importing-mail)). Switching the MX records
moves new mail to cloudmail at once.

## 1. Deploy

Click **Deploy to Cloudflare** in the [README](../README.md). Cloudflare asks
you to sign in, copies the repository to your GitHub or GitLab account, and
shows a form.

| Field | What to put |
| --- | --- |
| Worker name | Keep `cloudmail`. If you change it, also set the `WORKER_SCRIPT_NAME` variable to the new name (or connect a token later and the app finds it). |
| R2 bucket, KV namespace, Vectorize index | Keep the suggested names. If you rename the Vectorize index, also set `SEMANTIC_INDEX_NAME`; if you rename the bucket, set `R2_BUCKET_NAME`. |
| `SETUP_TOKEN` | Paste the output of `openssl rand -base64 32` and keep it in a password manager. It creates the owner account and is the break-glass key for `/recover`. You can leave it empty: the Worker then writes a one-time token to its logs. |
| `AUTH_SECRET` | Another `openssl rand -base64 32`. Set it now; changing it later breaks two-factor codes. |
| `CF_API_TOKEN` | Leave empty. You connect a token inside the app in step 3, where you can see what it is used for. |
| `DOMAINS` | Leave empty if you will connect a token. |

Press **Create and deploy**. Cloudflare creates:

- the Worker and its seven Durable Object classes (one SQLite database per mailbox, plus accounts, webhooks, assistant and events),
- the R2 bucket for attachments and raw messages,
- a KV namespace for MCP sign-in (OAuth),
- the Vectorize index for semantic search,
- the Workers AI binding, three rate-limit bindings and a 5-minute cron trigger,
- a Workers Builds connection, so pushes to your copy of the repository redeploy.

After the Worker is up, the deploy script creates the Vectorize **metadata
index** that semantic search needs (`scripts/ensure-vectorize-metadata.mjs`).
If the build token isn't allowed to, the build log says so and the guided
setup creates it in step 3 instead. Nothing else is affected.

The first build takes a few minutes. When it finishes you get a
`https://cloudmail.<your-subdomain>.workers.dev` address.

## 2. Create the owner account

Open the address. The first visit goes to `/setup`.

1. Enter the setup token. If you left `SETUP_TOKEN` empty, open the dashboard →
   **Workers & Pages** → your Worker → **Logs**, reload `/setup`, and copy the
   token from the line that starts with `[cloudmail] First-run setup is pending`.
   (`npx wrangler tail cloudmail` shows the same line.)
2. Enter your name, email address and a password. This is the owner account,
   the only one that can use `/recover`.

## 3. Guided setup

After setup you land on **Guided setup** (also at `/onboarding`).

1. **Connect Cloudflare.** Press **Create token**. The Cloudflare dashboard
   opens with the permissions already chosen: Zone Read, DNS Edit, Zone
   Settings Edit, Email Routing Rules Edit, Email Routing Addresses Read,
   Email Sending Edit, Analytics Read, DMARC Reports Read, Vectorize Edit,
   Workers Scripts Read and Account Settings Read. Limit it to the zones you
   want to use, create it, and paste it back. The app checks every permission
   and lists any that are missing.

   On a Workers Free account the app says Email Sending is not enabled. That
   is the plan, not the token; see step 5.
2. **Activate your licence.** Paste the key from your purchase email. The app
   sends it to the licence server once and stores only the signed token it
   gets back.
3. **Pick domains.** Every zone the token can see is listed with a one-line
   status, such as "Gmail handles mail here today" or "Nameservers pending".
4. **Review the plan.** Nothing changes until you press Apply.
   - **We'll do this:** safe additions, such as turning on Email Routing on
     a domain with no mail yet, a catch-all to this Worker, a sending domain,
     a monitor-only DMARC record (`p=none`), and the Vectorize metadata index.
   - **Needs your OK:** anything that changes or removes a record you already
     have, each with the exact records before and after: another provider's
     MX records, an existing catch-all rule, an SPF record to merge.
   - **You do this:** steps the API can't do, with numbered instructions and
     a **Re-check** button.
   - The app never turns on Email Routing while a non-Cloudflare SPF record
     exists without merging it first: two SPF records break all outbound mail.
5. **Apply.** Each change shows what Cloudflare accepted. DNS changes and a replaced
   catch-all rule are logged and can be undone from the result screen.
6. **Create your first mailbox** and send it a message from another account.
   The screen shows "Your first message arrived" when it does.

### Sending on Workers Free

If the plan shows **Choose how example.com sends mail**, the account is on
Workers Free. Either:

- upgrade to Workers Paid (dashboard → **Workers & Pages** → **Plans**), then
  press **Re-check**; or
- go to **Settings → Domains → your domain → Sending**, choose **Resend** or
  **Amazon SES**, paste the key and press **Test connection**. The domain
  must be verified in that provider first (it gives you the DNS records to
  add). Sending switches over only after the test passes.

## 4. Afterwards

- **Custom address.** Dashboard → your Worker → **Settings → Domains & Routes**
  → add a custom domain such as `mail.example.com`. Sign in there once; the
  app then uses it for links. Passkeys are tied to the address you register
  them on.
- **Invite people** at Settings → Users & invites.
- **Phone.** Open the app in your phone's browser and add it to the home
  screen. It supports Web Push notifications. There is no IMAP, so phone and
  desktop mail apps can't connect.
- **Back up** regularly: Settings → Account & security → Your data → Export. See [upgrade.md](upgrade.md#back-up).

## Deploy from the command line

For people who prefer a terminal, or an AI agent with terminal access.

```bash
git clone https://github.com/cloudmail-hq/cloudmail && cd cloudmail
npm ci
export CLOUDFLARE_ACCOUNT_ID=…   # your account id
# CLOUDFLARE_API_TOKEN: a token with Workers Scripts Edit, Workers R2 Storage Edit,
# Workers KV Storage Edit, Vectorize Edit and Account Settings Read. Set it
# without echoing it, for example:  read -rs CLOUDFLARE_API_TOKEN; export CLOUDFLARE_API_TOKEN

# wrangler deploy creates the R2 bucket and the KV namespace, but not the
# Vectorize index, so create that first:
npx wrangler vectorize create cloudmail-semantic --dimensions=1024 --metric=cosine
npm run deploy                 # build, deploy, then add the metadata index
npm run secrets -- --deploy    # generate and upload SETUP_TOKEN and AUTH_SECRET; prints the setup token once
```

If you need the bucket before the first deploy (for example to restore a
backup into it), `npx wrangler r2 bucket create cloudmail` creates it.

Then continue with [step 2](#2-create-the-owner-account).

Notes:

- If a first deploy fails halfway, the retry can stop with
  `a namespace with this account ID and title already exists [code: 10014]`.
  The KV namespace was created but never linked. See
  [troubleshooting.md](troubleshooting.md#a-namespace-with-this-account-id-and-title-already-exists).
- Two cloudmail deployments on one account should use different
  `namespace_id` values in `ratelimits`, or they share rate-limit counters.

## Uninstall

See [upgrade.md](upgrade.md#uninstall).
