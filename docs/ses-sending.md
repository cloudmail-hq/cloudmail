# Sending through Amazon SES or Resend

Each domain sends its outgoing mail through Cloudflare Email Service unless an administrator switches it to their own Amazon SES account or Resend account. Receiving stays on Cloudflare Email Routing either way: neither provider touches the apex MX.

The setting is per domain, in **Settings → Domains → (domain) → Sending**, `cloudmail domain sending`, or `/api/v1/domains/:id/sending`.

## Rules that apply to both

- **No silent fallback.** A domain set to SES or Resend sends only through that provider. If it can't (bad key, unverified domain, settings unreadable), the send fails with a reason and nothing goes out through Cloudflare.
- **Test before switching.** Saving SES or Resend settings stores them, but the domain switches only once **Test connection** has passed for exactly those settings: for SES, the identity is verified with DKIM `SUCCESS` and signing on; for Resend, the domain is `verified` (or the key is sending-only and cannot check). Until then the save reports `blockedReason` and mail keeps going through Cloudflare. Changing the key, region or configuration set needs a new test.
- **Changes reach every Worker isolate within 10 seconds.**
- **Secrets are write-only.** The SES secret access key, the Resend API key and the Resend webhook signing secret are encrypted with AES-GCM under `AUTH_SECRET`, bound to the domain, and never returned, logged or audited. The UI and API show only the last 4 characters of a key.
- **Tracking is applied once.** cloudmail adds its own open pixel and link rewriting before handing the message over. Turn off the provider's own open and click tracking, or links are rewritten twice and opens counted twice. Test connection warns when they are on.
- **Events.** Each provider posts events to a webhook URL shown on the settings card (`/hooks/ses/<id>` or `/hooks/resend/<id>`). Deliveries, bounces, delays, complaints and rejections go into the message's delivery timeline. Permanent bounces and complaints add suppressions, and they count toward the spam-rate breaker the same way Cloudflare's do.
- **Duplicate-send safety.** A send that may have reached the provider (an SES 5xx or timeout, or Resend still failing after its retries) is marked "may have been sent", stays out of the failed state and is never retried automatically. Scheduled sends stop retrying it too. The provider's first event for the message (matched by a `cm_send` tag carrying the message's own id) settles its status.

## Amazon SES

### 1. Verify the domain in SES

In the SES console, in the region you will send from, create a **domain identity** for the domain with Easy DKIM (RSA 2048). Run **Test connection**: it lists the three DKIM CNAMEs (`<token>._domainkey.<domain>` pointing to `<token>.<SigningHostedZone>`) to add in Cloudflare DNS. Make them **DNS only**, not proxied.

Recommended: a custom MAIL FROM domain on `bounce-ses.<domain>`, so SPF aligns for DMARC:

| Type | Name | Value |
|---|---|---|
| MX | `bounce-ses.<domain>` | `10 feedback-smtp.<region>.amazonses.com` |
| TXT | `bounce-ses.<domain>` | `v=spf1 include:amazonses.com ~all` |

Set "Behavior on MX failure" to "Use default MAIL FROM". Leave the apex MX and SPF as they are: SES mail is checked against the MAIL FROM domain, so the apex SPF never needs `include:amazonses.com`. Don't enable Email Routing on `bounce-ses.<domain>`.

### 2. Configuration set and SNS topic (bounces and complaints)

1. In SES, create a configuration set, by default named `cloudmail`.
2. In SNS, in the same region, create a **Standard** topic. Under message signing, set **SignatureVersion 2** (SHA256). cloudmail accepts version 1 too.
3. Add an **HTTPS subscription** to the topic with the webhook URL from the settings card. cloudmail confirms it automatically, but only after verifying the message signature, and only if the confirmation URL is on `sns.<region>.amazonaws.com`.
4. In the configuration set, add an **SNS event destination** for Send, Delivery, Bounce, Complaint, Reject and Delivery delay, pointing at the topic. Leave Open and Click off.
5. Enter the configuration set name and the topic ARN in the settings card. Messages from any other topic are refused.

### 3. IAM user and policy

Create an IAM user with no console access and attach the policy shown on the settings card. It has the account ID filled in once the topic ARN is saved. The policy grants:

- `ses:SendEmail` (and `ses:SendRawEmail`) on the domain identity and the configuration set only, with `ses:FromAddress` limited to `*@<domain>` and `aws:SecureTransport` required;
- `ses:GetEmailIdentity` on the identity, and `ses:GetConfigurationSet` on the configuration set, for Test connection;
- `ses:GetAccount` on `*`, which has no resource type.

Create an access key for the user (long-term `AKIA…` keys only), and enter the region, key ID and secret in cloudmail. To rotate, create a second key, paste it in, run Test connection, then deactivate and delete the old one.

### 4. Test, then save

**Test connection** calls GetAccount, GetEmailIdentity and GetConfigurationSet one at a time, because SES limits these calls to 1 per second. It shows:

- sending enabled, sandbox, quota;
- identity and DKIM status;
- MAIL FROM status;
- the DNS records to add;
- configuration-set event types and tracking warnings.

**Test and send one** also sends a message from `postmaster@<domain>` to the SES mailbox simulator (`success@simulator.amazonses.com`), which proves the send permission. That message is billed by AWS but doesn't count against reputation. When the test passes, save again to switch.

### Limits and behaviour

- **Size and recipients:** 40 MB per message after base64; 50 recipients across To, Cc and Bcc.
- **Headers:** 15 custom headers. Values are printable ASCII, up to 995 characters, and name plus value up to 996. Long `References` chains are trimmed to fit.
- **Attachments:** at most 500 MIME parts. SES refuses executable extensions (`.exe`, `.js`, `.bat` and about 90 others), so they are rejected before sending.
- **Message-ID:** SES sets its own. cloudmail stores `<MessageId>@<region>.amazonses.com` (`@email.amazonses.com` in us-east-1) for threading. If a reply cites another `amazonses.com` domain, it is matched on the SES message id.
- **Retries:** only throttling (429 or `ThrottlingException`, except "Daily message quota exceeded") and 408 are retried, at most twice, with full-jitter backoff capped at 20 s. Every other 4xx is a definite failure with an `E_SES_*` code. A 5xx, `RequestAbortedException`, a timeout or a network error is "may have been sent" (`E_SES_UNCONFIRMED`) and is never retried.
- **Regions:** the 33 commercial regions. GovCloud, China and FIPS endpoints are not supported.

## Resend

1. In Resend, add the domain and publish its DNS records: DKIM `resend._domainkey`, plus the SPF MX and TXT on the `send` subdomain. The apex is untouched.
2. Turn off **open and click tracking** for the domain.
3. Create an API key. A **sending-only key restricted to this domain** is enough. A full-access key also lets Test connection show the domain status, DNS records and tracking settings.
4. In cloudmail, choose Resend and enter the key. Save once to get the webhook URL.
5. In Resend → Webhooks, add an endpoint with that URL. Select `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed` and `email.suppressed`. Copy its signing secret (`whsec_…`) into cloudmail.
6. Run Test connection (optionally **Test and send one**, to `delivered@resend.dev`), then save again to switch.

### Behaviour

- **Requests and idempotency:** plain `POST https://api.resend.com/emails`, no SDK. Every request carries `Idempotency-Key: cm-<message id>-<sha256(body)[0..16]>`, so cloudmail's own retries can't send twice within Resend's 24-hour window.
- **Retries:** rate limiting (429), `concurrent_idempotent_requests` (409), 5xx and network errors are retried at most twice. A send still failing after that is "may have been sent" (`E_RESEND_UNCONFIRMED`). Quota errors and other 4xx are definite failures (`E_RESEND_*`).
- **Webhook verification:** Svix signatures are checked by hand. The signed content is `id.timestamp.body` with HMAC-SHA256, any `v1` signature in the list may match, the timestamp tolerance is 5 minutes, and the comparison is constant time. Each `svix-id` is processed once.
- **Message-ID:** Resend's send response has only an id. The `email.sent` webhook supplies the RFC Message-ID, which cloudmail then stores for threading. Without the webhook, replies fall back to subject threading.
- **Suppressions:** Resend's bounce, complaint and suppression payloads don't say which recipient they are about, and list only To. They are recorded once for the message, and a suppression is added only when the stored message had exactly one recipient across To, Cc and Bcc.
- **Limits:** the same as SES (40 MB, 50 recipients, 15 headers, blocked extensions). The Free plan allows 100 emails a day and 3,000 a month, and test sends count toward it.

## Event mapping

| Provider event | Timeline | Suppression |
|---|---|---|
| SES Send, Resend `email.sent` | sent | no |
| SES Delivery, Resend `email.delivered` | delivered | no |
| SES DeliveryDelay, Resend `email.delivery_delayed` | temporary delivery issue | no |
| SES Bounce Permanent, Resend bounce `Permanent` | bounced | yes (`hard_bounce`) |
| SES Bounce Transient or Undetermined, other Resend bounces | temporary delivery issue | no |
| SES Complaint (except `not-spam`), Resend `email.complained` | marked as spam | yes (`complaint`, domain-scoped) |
| SES Reject or Rendering Failure, Resend `email.failed` | couldn't be sent | no |
| Resend `email.suppressed` | rejected | yes (`hard_bounce`) |
| Open and Click events | ignored: cloudmail tracks these itself | no |

Events are idempotent per provider event id and safe to receive out of order: the status comes from the latest event in time. An event for a message cloudmail didn't send is acknowledged and dropped.

## Webhook security

- `/hooks/ses/<id>` and `/hooks/resend/<id>` are public (AWS and Resend have no session). The 128-bit id only selects the domain. The signature is the credential.
- **SNS:** the `TopicArn` must equal the stored ARN. The certificate URL must be `https://sns.<topic region>.amazonaws.com/SimpleNotificationService-<hex>.pem`, with no port, credentials or query. The certificate must be within its validity dates. The signature is verified over the exact string to sign, with RSA-SHA1 for v1 and RSA-SHA256 for v2. Certificates are cached per isolate by URL.
- Bodies over 256 KB are refused, and requests are rate-limited per IP with `API_RATE_LIMITER`.
- If storing an event fails, the webhook answers 500 so the provider retries.

## Not yet checked against a live account

These were built from the documentation and tested against fakes. Check them on a real account before relying on them:

- the Message-ID domain SES writes in each region;
- whether `ses:FromAddress` matches the bare address;
- how SES encodes non-ASCII attachment file names;
- whether SES brackets an inline `ContentId`;
- a real SNS certificate and message through `node:crypto` in workerd;
- whether Resend replays a cached 4xx for the same idempotency key.
