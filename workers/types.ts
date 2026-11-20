// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Zone configuration for multi-domain support.
 * Each zone represents a Cloudflare zone (domain) that can have its own mailboxes.
 */
export interface ZoneConfig {
	/** Cloudflare zone ID (optional - for future API integration) */
	zoneId?: string;
	/** Domain name (e.g., "example.com") */
	domain: string;
	/** Display name for the zone (e.g., "Example Corp") */
	name?: string;
}

export interface Env extends Cloudflare.Env {
	/**
	 * Cloudflare Access application audience tag. Only read in `"access"` auth
	 * mode, and its presence (with `TEAM_DOMAIN`) is what selects that mode when
	 * `AUTH_MODE` is unset. See `workers/auth/config.ts`.
	 */
	POLICY_AUD?: string;
	/** Access team URL (base or full `/cdn-cgi/access/certs`). Access mode only. */
	TEAM_DOMAIN?: string;
	/**
	 * `"password"` (built-in accounts) or `"access"` (Cloudflare Access). Unset
	 * means "access" when POLICY_AUD and TEAM_DOMAIN are both set, so existing
	 * Access deployments keep working, and "password" otherwise.
	 */
	AUTH_MODE?: string;
	/**
	 * Secret required to create the owner account, and the break-glass key for
	 * `POST /api/auth/recover`. When unset a token is generated, persisted in the
	 * AuthDO and printed to the logs while setup is pending; recovery is then
	 * unavailable, because a logged value is not a secret worth trusting twice.
	 */
	SETUP_TOKEN?: string;
	/** Key material for encrypting TOTP secrets at rest. Generated if unset. */
	AUTH_SECRET?: string;
	/** Turnstile widget key. With `TURNSTILE_SECRET_KEY`, turns the challenge on. */
	TURNSTILE_SITE_KEY?: string;
	TURNSTILE_SECRET_KEY?: string;
	/** Base URL for invite and reset links. Defaults to the request origin. */
	APP_URL?: string;
	// LICENCE_ENFORCEMENT comes from the generated Cloudflare.Env (wrangler.jsonc
	// vars): `enforce` locks the app without a valid licence (the public
	// template); anything else is off (this repo). See workers/lib/licence.ts.
	/** Licence server base URL. Default https://licence.tapetide.com. */
	LICENCE_SERVER_URL?: string;
	/**
	 * From address for password reset emails, `Name <addr>` or a bare address.
	 * Unset means `no-reply@<first configured domain>`. See
	 * `resolveAuthEmailSender` in `workers/auth/config.ts`.
	 */
	AUTH_EMAIL_FROM?: string;
	/**
	 * `"1"` restores the old all-admin localhost bypass. Honoured only in local
	 * development (`import.meta.env.DEV`); a production build ignores it.
	 */
	DEV_AUTH_BYPASS?: string;
	// DOMAINS is supplied by the generated Cloudflare.Env (a literal type derived
	// from wrangler.jsonc vars), so it must not be redeclared here - widening it
	// to `string | undefined` breaks the `extends Cloudflare.Env` constraint and
	// every generic that is bound by Env.
	/** JSON array of zone configurations for multi-domain support (unset by default) */
	ZONES?: string;
	/**
	 * Comma-separated addresses that are unconditionally administrators, and the
	 * switch that turns per-mailbox authorization on.
	 *
	 * While unset, every caller who passes the Cloudflare Access policy is
	 * treated as an admin — the behaviour this app shipped with. Setting it
	 * begins enforcement, and the listed addresses are the accounts that cannot
	 * be locked out by a bad grant, which is why they live in configuration
	 * rather than in the bucket beside the grants. See `workers/lib/authz.ts`.
	 */
	ADMIN_EMAILS?: string;
	/**
	 * Shared secret gating the one-off `/api/v1/_migrate/*` routes used to
	 * consolidate per-domain deployments. Unset on a normal deployment, in which
	 * case those routes 404. Set as a Worker secret, never in wrangler.jsonc.
	 */
	MIGRATION_TOKEN?: string;
	/**
	 * API token with **Analytics Read** on the zone, used by the cron reconciler
	 * to pull delivery verdicts from Cloudflare Email Service's
	 * `emailSendingAdaptive` GraphQL dataset. A Worker secret, never in
	 * wrangler.jsonc. When unset the reconciler is inert — the app still sends and
	 * records send-time outcomes, it just does not learn what happened downstream.
	 */
	EMAIL_ANALYTICS_TOKEN?: string;
	/**
	 * Zone tag (id) the reconciler queries. Email Service analytics datasets are
	 * zone-level, so this is the tapetide.com zone id. Optional: when unset the
	 * reconciler derives nothing and stays inert.
	 */
	EMAIL_ANALYTICS_ZONE_TAG?: string;
	/**
	 * Cloudflare API token for domain provisioning (`/api/v1/domains/:id/provision`).
	 * Needs Zone Read, Zone Settings Write, Email Routing Rules Write, Email
	 * Sending Edit and DNS Read. A Worker secret. When set it always wins over a
	 * token saved in Settings → Cloudflare connection (`lib/cf-connection.ts`).
	 * With neither, manual mode: the domains UI shows the DNS records and
	 * dashboard steps instead.
	 */
	CF_API_TOKEN?: string;
	/** Optional account id that scopes zone lookups when the token spans accounts. */
	CF_ACCOUNT_ID?: string;
	/**
	 * Workers AI model id for thread summaries (one call for the one-liner and
	 * the bullets). Unset means `@cf/meta/llama-3.1-8b-instruct-fp8`. Pick a
	 * model that supports JSON mode; others fall back to a plain-text retry.
	 */
	SUMMARY_MODEL?: string;
	/**
	 * Read-only Cloudflare token for the analytics console (`/api/v1/analytics/*`):
	 * Account Analytics Read, Analytics Read (zone), Email Sending Read, Email
	 * Routing Rules/Addresses/Suppressions Read, DMARC Reports Read. A Worker
	 * secret. GraphQL falls back to `EMAIL_ANALYTICS_TOKEN`; with neither, the
	 * console shows local data only.
	 */
	CF_ANALYTICS_TOKEN?: string;
	// WORKER_SCRIPT_NAME (script name catch-all routing rules point at, default
	// `cloudmail`) and SEMANTIC_INDEX_NAME (Vectorize index the SEMANTIC_INDEX
	// binding names, default `cloudmail-semantic`) are optional vars. This
	// repo's wrangler.jsonc sets both to its production names, so the generated
	// Cloudflare.Env declares them as literals and they must not be redeclared
	// here (same reason as DOMAINS below). Readers cast the env, so they also
	// compile where the vars are absent. See workerScriptName in
	// ./lib/cloudflare-api.ts and semanticIndexName in ../shared/semantic.ts.
	/**
	 * MailboxDO namespace of a retired deployment, bound only while a
	 * consolidation is in progress. Declared here rather than in wrangler.jsonc
	 * because it is absent from ordinary deployments; the migration routes report
	 * a 409 when it is missing.
	 */
	LEGACY_MAILBOX?: DurableObjectNamespace<import("./durableObject").MailboxDO>;
	/**
	 * HMAC key for the `/u/:token` unsubscribe links. Optional Worker secret:
	 * when unset a key is generated once and kept in the AuthDO. Rotating it
	 * invalidates every unsubscribe link already sent.
	 */
	UNSUBSCRIBE_SECRET?: string;
	/**
	 * Web Push application server key pair (VAPID, RFC 8292), base64url: the
	 * 65-byte uncompressed public point and the 32-byte private scalar. Optional
	 * Worker secrets: when unset a pair is generated once and kept in the
	 * AuthDO. Changing them invalidates every device subscription.
	 */
	VAPID_PUBLIC_KEY?: string;
	VAPID_PRIVATE_KEY?: string;
	/** Contact for push services (`mailto:` or `https:`). Defaults to APP_URL. */
	VAPID_SUBJECT?: string;
	/**
	 * HMAC key for `/img/:sig` remote-image proxy URLs. Optional Worker secret:
	 * when unset a key is generated once and kept in the AuthDO. Rotating it only
	 * means open messages re-sign their images on the next read.
	 */
	IMAGE_PROXY_SECRET?: string;
	/**
	 * `"off"` disables the visible unsubscribe footer on bulk sends. The
	 * List-Unsubscribe headers are sent either way.
	 */
	UNSUBSCRIBE_FOOTER?: string;
}
