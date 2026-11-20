# Breach runbook

For the operator of a cloudmail deployment. Work top to bottom and keep a written log as you go: note who did what and when. The log becomes your notification and your review. This runbook is not legal advice. Have your counsel confirm your notification duties.

Clocks start when you become aware of the breach:

- DPDP Act 2023 / Rules 2025 (India): notify affected Data Principals and the Data Protection Board without delay, with a detailed report to the Board within 72 hours.
- GDPR Art. 33/34 (if you serve EU/UK users): notify the supervisory authority within 72 hours, and notify individuals without undue delay when the risk to them is high.

## 1. Detect

Signals worth acting on:

- Access log (Settings → Access log, `/api/v1/audit`): sends, deletions, token creation or settings changes nobody recognises.
- Worker logs (`wrangler tail`, or dashboard → Workers → Logs) showing repeated `/recover` failures, a possible cloned-authenticator warning, or more than 100 failed sign-ins for one account.
- Sessions or API tokens no one remembers creating (Settings → Account & security).
- Mail sent that nobody wrote, or bounce or abuse reports from Cloudflare Email Service.
- A leaked secret: in a public repo, a paste site, or a lost laptop with `wrangler` logged in.

Write down what you saw, when, and how you found it.

## 2. Contain

Do these in order. Each one is reversible.

1. **Stop sign-ins and API access for the affected accounts.** As an admin, use Settings → Users & invites → Disable. This revokes their sessions and API tokens at once. For your own account, use Account & security → Sign out other sessions and revoke tokens.
2. **If the owner account itself is compromised,** use `/recover` with `SETUP_TOKEN`. It resets the password, turns off 2FA and revokes every owner session.
3. **If the whole deployment is in doubt,** take it offline. Remove the Worker's routes or custom domain in the dashboard, and turn off the Email Routing catch-all rule so inbound mail stops reaching the Worker. Cloudflare keeps mail for routing failures. Check the bounce behaviour for your zone first.
4. **Revoke the Cloudflare credentials** that can deploy or read the Worker: `wrangler logout` on every machine you suspect, and roll any API tokens in the Cloudflare dashboard (My Profile → API Tokens) that have Workers or R2 access.
5. **Preserve evidence before you clean up.** Export the access log, save the `wrangler tail` output, and take an R2 listing of `audit/`. Don't delete the attacker's tokens or sessions until you've noted their IDs, IPs and times.

## 3. Rotate secrets

Rotate every secret the attacker could have seen. Set each with `wrangler secret put NAME`, or in the dashboard under Worker → Settings → Variables and Secrets. Check the side effects before you rotate:

| Secret | What rotating it does |
| --- | --- |
| `SETUP_TOKEN` | No user impact. Use a new value of at least 16 characters (`openssl rand -base64 24`). |
| `AUTH_SECRET` | **Breaks existing TOTP secrets.** Every 2FA user has to re-enrol. If it leaked, rotate anyway and tell users to set up 2FA again. |
| `UNSUBSCRIBE_SECRET` | Every unsubscribe link already sent stops working, and so does every account-export download link (they're derived from it). Recipients can still reply to opt out. |
| `IMAGE_PROXY_SECRET` | Existing proxied image URLs stop loading until the message is reopened. |
| `MIGRATION_TOKEN` | Delete it unless a migration is in progress. |
| `CF_API_TOKEN` | Roll it in the Cloudflare dashboard, then set the new value. |
| `EMAIL_ANALYTICS_TOKEN`, `CF_ANALYTICS_TOKEN` | Read-only. Roll them in the dashboard. |
| `TURNSTILE_SECRET_KEY` | Rotate it in the Turnstile dashboard, then set the new value. |
| `POLICY_AUD` / `TEAM_DOMAIN` | Legacy Access mode only. Rotate them in Zero Trust. |

Secrets the app generated itself (when the variables above were unset) live in the auth Durable Object. To rotate one, set the variable explicitly.

Also:

- **API tokens and sessions:** have every user revoke their tokens and sign out other sessions. An admin can also disable and re-enable a user, which revokes everything for that user.
- **Webhook signing secrets:** rotate each endpoint's secret (Settings → Webhooks) and update the receivers.
- **Per-mailbox tracking secrets:** these sign open and click URLs and are stored in each mailbox's Durable Object. A leak lets someone forge opens and clicks; it doesn't expose mail. Note it in the assessment. Turning tracking off for the mailbox stops new tracked URLs being minted.
- **Passwords:** if the password hashes may have been read, force a reset (Settings → Users & invites → Password reset link) for every account.

## 4. Assess

Answer these and write the answers down:

- **What data was involved?** Account data (emails, names, password hashes, IPs), mail content and attachments (R2 `attachments/` and the mailbox Durable Objects), tracking events about recipients, agent chat history, and exports (`exports/` in R2).
- **Whose data?** List the account holders, the mailboxes, and the external correspondents in those mailboxes. Correspondents are Data Principals too.
- **When?** The first malicious action in the access log, and the last.
- **How did they get in?** A leaked secret, a phished password, a stolen session, a bug, or a compromised Cloudflare account.
- **Is it still happening?** Re-check the access log after containment.
- **What's the likely harm?** Account takeover, exposure of mail content, impersonation sent from your domain.

## 5. Notify

1. **The Data Protection Board of India,** through the Board's online channel. Do this without delay, and send a detailed report within 72 hours. The report covers the nature, extent, timing and location of the breach, its likely impact, the containment done so far, and the findings about the cause.
2. **Affected users:** without delay, in plain language. Tell them what happened, what data was involved, what you've done, what they should do (change passwords, re-enrol 2FA, watch for phishing from your domain), and your Grievance Officer's contact (from `/privacy`).
3. **EU/UK supervisory authority,** if the GDPR applies: within 72 hours (Art. 33).
4. **Cloudflare:** if you suspect their side, or need their logs, contact Cloudflare support or their abuse and trust contacts.
5. **Mail recipients** who were sent mail impersonating you: a short notice from a clean address.

Keep copies of every notice and the time it was sent.

## 6. Review

Within two weeks:

- Write a timeline from detection through containment, rotation and notification.
- Name the root cause and the fix, with an owner and a date.
- Check that retention settings (Settings → Privacy & retention) aren't keeping more than you need. Less stored means less to leak.
- Update this runbook with anything that was missing or wrong.
- Record the breach in your internal register, even if notification turned out not to be required.
