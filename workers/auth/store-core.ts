// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Storage logic for built-in authentication, independent of the Durable Object.
 *
 * `AuthStore` runs over a minimal SQL interface so the same code is exercised by
 * unit tests against `node:sqlite` and by `AuthDO` against `ctx.storage.sql`.
 * Keeping it out of `store.ts` means tests never import `cloudflare:workers`.
 *
 * Every method is synchronous inside (SQLite in a Durable Object is), and is
 * declared `async` only to satisfy the RPC-shaped `AuthStoreApi`. That matters
 * for correctness: a check-then-write such as "only if no users exist" runs
 * inside one `transaction()` with no await in between, so no other request can
 * interleave with it.
 *
 * Secrets never arrive in plaintext. Session, invite, reset, challenge and API
 * token secrets are hashed by the caller; passwords arrive as scrypt hashes.
 */

import { normalizeEmail, randomId, randomToken, timingSafeEqualString } from "./crypto";
import { normalizeTokenMailboxes, normalizeTokenScopes } from "../../shared/token-scopes";
import {
	IDEMPOTENCY_INDEX_SQL,
	IDEMPOTENCY_TABLE_SQL,
	sweepIdempotencyKeys,
} from "../lib/idempotency-store";
import { PUSH_MIGRATION_STATEMENTS } from "../lib/push-store";
import type {
	AcceptInviteResult,
	ApiTokenInfo,
	AuthStoreApi,
	AuthUser,
	CreateOwnerResult,
	InviteInfo,
	IssueEmailResetResult,
	InviteRole,
	LoginCandidate,
	LockState,
	OAuthGrantInfo,
	PasskeyCredential,
	PasskeyInfo,
	SessionInfo,
	SuppressionEntryInput,
	SuppressionListOptions,
	SuppressionPage,
	SuppressionRecord,
	SuppressionStoreApi,
	TotpState,
	WebAuthnPurpose,
	ExportJobRecord,
	PrivacyStoreApi,
} from "./types";

/** The slice of `SqlStorage` this module uses. */
export interface AuthSql {
	exec(query: string, ...bindings: unknown[]): { toArray(): any[] };
}

/** Runs `fn` atomically (`ctx.storage.transactionSync` in the Durable Object). */
export type AuthTransaction = <T>(fn: () => T) => T;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Sessions die after this long without use. */
export const SESSION_IDLE_MS = 14 * DAY;
/** ...and after this long regardless, so a stolen cookie cannot live forever. */
export const SESSION_ABSOLUTE_MS = 30 * DAY;
/**
 * The idle deadline and API token `last_used_at` are written at most this
 * often. Every authenticated request validates; writing on each one would turn
 * reads into writes on the single global object for no security benefit.
 */
export const TOUCH_INTERVAL_MS = HOUR;

export const MFA_CHALLENGE_MS = 5 * MINUTE;
export const MFA_MAX_ATTEMPTS = 5;

/**
 * Consecutive failures allowed before locking starts. Shared by the password
 * lock (per email + IP) and the second-factor lock (per account).
 */
export const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_BASE_MS = 30_000;
const LOCKOUT_MAX_MS = 15 * MINUTE;

/**
 * Lock duration after `failures` consecutive failures: 30s at the 5th, doubling
 * each time, capped at 15 minutes. Exponential so online guessing becomes
 * useless quickly; capped so an attacker cannot lock the real owner out for
 * long by failing on purpose.
 */
export function lockoutDuration(failures: number): number {
	if (failures < LOCKOUT_THRESHOLD) return 0;
	const exp = Math.min(failures - LOCKOUT_THRESHOLD, 30);
	return Math.min(2 ** exp * LOCKOUT_BASE_MS, LOCKOUT_MAX_MS);
}

/**
 * Failures from one account across every address, within an hour, beyond which
 * the store reports a distributed guessing attempt. Reported, not enforced:
 * locking the account here would hand anyone who knows the owner's address a
 * way to lock the owner out from a botnet.
 */
export const ACCOUNT_ALERT_THRESHOLD = 100;
const ACCOUNT_ALERT_WINDOW_MS = HOUR;

/**
 * `(email, ip)` rows idle this long are dropped. Long enough that a slow
 * attacker keeps climbing the backoff, short enough that the table stays small.
 */
const LOGIN_ATTEMPT_RETENTION_MS = DAY;

/** A WebAuthn ceremony must finish within this long of its options being issued. */
export const WEBAUTHN_CHALLENGE_MS = 5 * MINUTE;
/**
 * Outstanding challenges across everyone, beyond which no more are issued.
 * Usernameless sign-in hands challenges to anonymous callers; the rate limiter
 * normally bounds that, but it fails open, and this keeps the table bounded
 * without it.
 */
export const WEBAUTHN_MAX_OUTSTANDING = 10_000;
/** Passkeys one account may hold. Generous; it only bounds storage. */
export const PASSKEY_MAX_PER_USER = 20;

/** Break-glass recovery: this many wrong setup tokens in an hour... */
export const RECOVERY_MAX_FAILURES = 10;
/** ...closes `/recover` for this long, for everyone. */
export const RECOVERY_LOCK_MS = HOUR;
const RECOVERY_KEY = "recover:global";

/**
 * Reset emails per account per window. The endpoint is public and takes any
 * address, so without this it would be a free way to fill someone's inbox;
 * three an hour still covers "the first one went to spam".
 */
export const RESET_EMAIL_MAX_PER_WINDOW = 3;
export const RESET_EMAIL_WINDOW_MS = HOUR;

/**
 * Schema migrations, each identified by a unique name and recorded in
 * `applied_migrations` once it has run.
 *
 * Named rather than numbered so that features developed in parallel can each
 * append one without renumbering another's on merge. They still run in array
 * order, so a migration may depend on anything listed before it. Append only:
 * never rename, reorder or edit a migration that has shipped.
 *
 * The first entries predate naming; a deployment that recorded them only as a
 * `schema_version` count is translated on first start (see `migrate`).
 *
 * No FOREIGN KEY clauses: deletes cascade explicitly in `deleteUser`, which
 * keeps behaviour identical whether or not the SQLite build enforces them.
 */
interface AuthMigration {
	name: string;
	statements: string[];
}

/** `meta` key holding the persisted auth epoch. A plain row: no migration needed. */
const AUTH_EPOCH_KEY = "auth_epoch";

const MIGRATIONS: AuthMigration[] = [
	{ name: "0001_initial", statements: [
		`CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			email TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			password_hash TEXT NOT NULL,
			is_owner INTEGER NOT NULL DEFAULT 0,
			disabled INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			last_login_at INTEGER,
			password_changed_at INTEGER,
			failed_logins INTEGER NOT NULL DEFAULT 0,
			locked_until INTEGER NOT NULL DEFAULT 0,
			totp_secret_enc TEXT,
			totp_enabled INTEGER NOT NULL DEFAULT 0,
			totp_last_step INTEGER
		)`,
		// At most one owner, enforced by the database rather than by convention.
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_owner ON users(is_owner) WHERE is_owner = 1`,
		`CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			token_hash TEXT NOT NULL UNIQUE,
			user_id TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			last_seen_at INTEGER NOT NULL,
			idle_expires_at INTEGER NOT NULL,
			absolute_expires_at INTEGER NOT NULL,
			ip TEXT,
			user_agent TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
		`CREATE TABLE IF NOT EXISTS mfa_challenges (
			challenge_hash TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			expires_at INTEGER NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE INDEX IF NOT EXISTS idx_mfa_challenges_user ON mfa_challenges(user_id)`,
		`CREATE TABLE IF NOT EXISTS recovery_codes (
			user_id TEXT NOT NULL,
			code_hash TEXT NOT NULL,
			PRIMARY KEY (user_id, code_hash)
		)`,
		`CREATE TABLE IF NOT EXISTS invites (
			id TEXT PRIMARY KEY,
			token_hash TEXT NOT NULL UNIQUE,
			email TEXT NOT NULL,
			role TEXT NOT NULL,
			mailboxes TEXT NOT NULL DEFAULT '[]',
			created_by TEXT,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			used_at INTEGER
		)`,
		`CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email)`,
		`CREATE TABLE IF NOT EXISTS password_resets (
			token_hash TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			expires_at INTEGER NOT NULL,
			used_at INTEGER
		)`,
		`CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id)`,
		`CREATE TABLE IF NOT EXISTS api_tokens (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			secret_hash TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			last_used_at INTEGER,
			expires_at INTEGER,
			revoked_at INTEGER
		)`,
		`CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id)`,
	] },
	{ name: "0002_login_attempts_and_mfa_lockout", statements: [
		/**
		 * Second-factor failures, counted per account across challenges. A
		 * challenge's own cap is not enough on its own: a fresh one costs only the
		 * password, so without this the 10^6 code space is five guesses at a time,
		 * forever.
		 */
		`ALTER TABLE users ADD COLUMN mfa_failures INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE users ADD COLUMN mfa_locked_until INTEGER NOT NULL DEFAULT 0`,
		/**
		 * Password failures keyed by (normalized email, client IP), replacing the
		 * per-account counter on `users` (whose columns stay, unused, since
		 * shipped migrations are never edited). Per pair, so one address cannot
		 * lock the real user out from everywhere, and keyed by the email string
		 * rather than a user id, so an unknown address locks exactly like a real
		 * one and the lockout reveals nothing about which accounts exist.
		 */
		`CREATE TABLE IF NOT EXISTS login_attempts (
			email TEXT NOT NULL,
			ip TEXT NOT NULL,
			failures INTEGER NOT NULL DEFAULT 0,
			locked_until INTEGER NOT NULL DEFAULT 0,
			last_failure_at INTEGER NOT NULL,
			PRIMARY KEY (email, ip)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_login_attempts_last ON login_attempts(last_failure_at)`,
		/** Fixed-window counters: the account-wide alert and the global recovery limit. */
		`CREATE TABLE IF NOT EXISTS failure_windows (
			key TEXT PRIMARY KEY,
			window_start INTEGER NOT NULL,
			failures INTEGER NOT NULL DEFAULT 0,
			locked_until INTEGER NOT NULL DEFAULT 0
		)`,
	] },
	{ name: "0005_mcp_oauth", statements: [
		/**
		 * One row per MCP client a user approved on the OAuth consent page.
		 *
		 * The tokens themselves live in the OAuth provider's KV namespace, which is
		 * eventually consistent and outside this object's transactions. This row is
		 * what makes revocation immediate: every `/mcp` request and every token
		 * exchange checks it here, in the same object that disables users and
		 * deletes sessions, so "disable", "delete" and "sign out everywhere" take
		 * effect on the next request rather than whenever KV catches up.
		 */
		`CREATE TABLE IF NOT EXISTS oauth_grants (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			client_id TEXT NOT NULL,
			client_name TEXT NOT NULL,
			redirect_host TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			last_used_at INTEGER
		)`,
		`CREATE INDEX IF NOT EXISTS idx_oauth_grants_user ON oauth_grants(user_id)`,
	] },
	/**
	 * Listed after 0005 although its label is lower: it was developed in
	 * parallel and merged later, and 0005 had already run in production.
	 * Names, not positions, record what has run, so the label is just a name.
	 */
	{ name: "0003_passkeys", statements: [
		/**
		 * WebAuthn credentials. `credential_id` and `public_key` are base64url.
		 * The public key is not a secret, so unlike every other credential here
		 * it is stored as is: a copy of it lets nobody sign anything.
		 */
		`CREATE TABLE IF NOT EXISTS passkeys (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			credential_id TEXT NOT NULL UNIQUE,
			public_key TEXT NOT NULL,
			counter INTEGER NOT NULL DEFAULT 0,
			transports TEXT NOT NULL DEFAULT '[]',
			aaguid TEXT NOT NULL DEFAULT '',
			device_type TEXT NOT NULL,
			backed_up INTEGER NOT NULL DEFAULT 0,
			name TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			last_used_at INTEGER
		)`,
		`CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id)`,
		/**
		 * Outstanding ceremony challenges, by hash. `user_id` is null only for a
		 * usernameless sign-in, where nobody is known until the assertion names
		 * its credential.
		 */
		`CREATE TABLE IF NOT EXISTS webauthn_challenges (
			challenge_hash TEXT PRIMARY KEY,
			purpose TEXT NOT NULL,
			user_id TEXT,
			expires_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires ON webauthn_challenges(expires_at)`,
		`CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_user ON webauthn_challenges(user_id)`,
		/**
		 * When a session last re-proved its user (password or passkey) after the
		 * sign-in that created it. A side table rather than a column on
		 * `sessions` so this migration is pure CREATE ... IF NOT EXISTS, which is
		 * safe to replay however a deployment's migration record was rebuilt.
		 */
		`CREATE TABLE IF NOT EXISTS session_step_ups (
			session_id TEXT PRIMARY KEY,
			authenticated_at INTEGER NOT NULL
		)`,
	] },
	/**
	 * Managed domains and mailbox aliases. Read and written by `DomainStore`
	 * (`workers/lib/domain-store.ts`), which shares this database so a domain,
	 * its catch-all and every alias pointing at it change in one transaction.
	 *
	 * `hostname` is unique and lowercase. JSON columns (`sending_dns`,
	 * `last_audit`, `last_provision`) are caches of the last Cloudflare or DNS
	 * answer, never authoritative: losing one costs a re-check, nothing more.
	 */
	{ name: "0006_domains", statements: [
		`CREATE TABLE IF NOT EXISTS domains (
			id TEXT PRIMARY KEY,
			hostname TEXT NOT NULL UNIQUE,
			display_name TEXT NOT NULL,
			zone_id TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			routing_status TEXT,
			sending_status TEXT,
			sending_subdomain_id TEXT,
			dkim_selector TEXT,
			dkim_name TEXT,
			dkim_value TEXT,
			sending_dns TEXT,
			catch_all_mailbox TEXT,
			last_error TEXT,
			last_audit TEXT,
			last_provision TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			last_checked_at INTEGER
		)`,
		`CREATE TABLE IF NOT EXISTS mailbox_aliases (
			address TEXT PRIMARY KEY,
			mailbox_id TEXT NOT NULL,
			created_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_mailbox_aliases_mailbox ON mailbox_aliases(mailbox_id)`,
	] },
	{ name: "0007_api_token_scopes", statements: [
		/**
		 * Per-token extras, in a side table rather than new `api_tokens` columns so
		 * the migration is pure CREATE ... IF NOT EXISTS and safe to replay (see
		 * `session_step_ups` above).
		 *
		 * - `scopes`, `mailboxes`: JSON arrays narrowing the token. NULL — and a
		 *   missing row, which is every token minted before this migration — means
		 *   "not restricted": the token keeps its user's full authority.
		 * - `parent_id`: the token that minted this one. Revoking a parent revokes
		 *   its descendants, so a leaked token cannot leave working children behind.
		 * - `last_used_ip`: where `last_used_at` was last written from.
		 */
		`CREATE TABLE IF NOT EXISTS api_token_meta (
			token_id TEXT PRIMARY KEY,
			scopes TEXT,
			mailboxes TEXT,
			parent_id TEXT,
			last_used_ip TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS idx_api_token_meta_parent ON api_token_meta(parent_id)`,
	] },
	/**
	 * The sending suppression list: addresses that must not receive
	 * non-transactional mail. Global rather than per mailbox because a
	 * suppression is about a recipient and a sending domain, not about whose
	 * inbox the mail came from. `scope` is `'global'` or a sending domain. One
	 * row per (address, scope); a repeat add is a no-op. See
	 * `workers/lib/suppressions.ts`.
	 *
	 * Follows `0007_api_token_scopes`. Append-only: never reorder or rename.
	 */
	{ name: "0008_suppressions", statements: [
		`CREATE TABLE IF NOT EXISTS suppressions (
			id TEXT PRIMARY KEY,
			address TEXT NOT NULL,
			scope TEXT NOT NULL DEFAULT 'global',
			reason TEXT NOT NULL,
			source TEXT NOT NULL,
			created_at INTEGER NOT NULL
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_suppressions_address_scope ON suppressions(address, scope)`,
		`CREATE INDEX IF NOT EXISTS idx_suppressions_created ON suppressions(created_at)`,
	] },
	/**
	 * Idempotency keys for instance-level creates (mailboxes, webhooks, domains,
	 * suppressions, sequence enrollments, API tokens). Same table as MailboxDO
	 * migration 29; see workers/lib/idempotency-store.ts.
	 *
	 * Follows `0008_suppressions`. Append-only.
	 */
	{ name: "0009_idempotency_keys", statements: [IDEMPOTENCY_TABLE_SQL, IDEMPOTENCY_INDEX_SQL] },
	/**
	 * Products: the identity (name, signature, branding, agent voice) a group of
	 * domains and aliases presents. Read and written by `ProductStore`
	 * (`workers/lib/product-store.ts`). A domain or alias belongs to at most one
	 * product, enforced by the primary keys of the two link tables.
	 *
	 * Number reserved by the coordinator; lower numbers may land later from
	 * parallel PRs. Append-only.
	 */
	{ name: "0011_products", statements: [
		`CREATE TABLE IF NOT EXISTS products (
			id TEXT PRIMARY KEY,
			slug TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			settings TEXT NOT NULL DEFAULT '{}',
			logo_mime_type TEXT,
			logo_updated_at INTEGER,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS product_domains (
			hostname TEXT PRIMARY KEY,
			product_id TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_product_domains_product ON product_domains(product_id)`,
		`CREATE TABLE IF NOT EXISTS product_aliases (
			address TEXT PRIMARY KEY,
			product_id TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_product_aliases_product ON product_aliases(product_id)`,
	] },
	/**
	 * Privacy controls. Numbered 0013 by reservation (parallel PRs hold
	 * 0010-0012); the name, not the number, records whether it ran.
	 *
	 * - `tracking_opt_outs`: recipients who asked to stop open/click tracking of
	 *   mail from a sending domain (the `/u/:token` page). Beside the
	 *   suppression list for the same reason it is global: it is about a
	 *   recipient and a sender, not a mailbox. Unlike a suppression it never
	 *   blocks a send; it only strips instrumentation.
	 * - `account_deletions`: self-service deletes inside their 7-day grace
	 *   period. Sessions and tokens are revoked when the row is written; the
	 *   purge runs when `purge_after` passes (cron). Cancelling deletes the row.
	 * - `export_jobs`: account exports, built in the background into R2 and
	 *   fetched by a signed, expiring link.
	 */
	{ name: "0013_privacy_controls", statements: [
		`CREATE TABLE IF NOT EXISTS tracking_opt_outs (
			address TEXT NOT NULL,
			scope TEXT NOT NULL DEFAULT 'global',
			source TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (address, scope)
		)`,
		`CREATE TABLE IF NOT EXISTS account_deletions (
			user_id TEXT PRIMARY KEY,
			email TEXT NOT NULL,
			requested_at INTEGER NOT NULL,
			purge_after INTEGER NOT NULL,
			mailboxes TEXT NOT NULL DEFAULT '[]'
		)`,
		`CREATE INDEX IF NOT EXISTS idx_account_deletions_due ON account_deletions(purge_after)`,
		`CREATE TABLE IF NOT EXISTS export_jobs (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			status TEXT NOT NULL,
			object_key TEXT,
			size INTEGER,
			error TEXT,
			state TEXT,
			created_at INTEGER NOT NULL,
			completed_at INTEGER,
			expires_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_export_jobs_user ON export_jobs(user_id, created_at)`,
	] },
	/**
	 * Spam-rate circuit breaker state, one row per sending domain: the last 7-day
	 * evaluation, whether bulk sends are paused, and who resumed them. See
	 * `shared/sending-health.ts` and `workers/lib/sending-health-store.ts`.
	 *
	 * Numbered 0012 by reservation and appended after 0013_privacy_controls,
	 * which merged first; the name, not the number, records whether it ran.
	 * Append-only.
	 */
	{ name: "0012_sending_health", statements: [
		`CREATE TABLE IF NOT EXISTS sending_health (
			domain TEXT PRIMARY KEY,
			level TEXT NOT NULL DEFAULT 'ok',
			spam_rate REAL,
			complaints INTEGER NOT NULL DEFAULT 0,
			delivered INTEGER NOT NULL DEFAULT 0,
			source TEXT,
			provider_status TEXT,
			evaluated_at INTEGER,
			bulk_paused INTEGER NOT NULL DEFAULT 0,
			paused_at INTEGER,
			paused_reason TEXT,
			resumed_at INTEGER,
			resumed_by TEXT,
			notified_level TEXT
		)`,
	] },
	/**
	 * Per-grant "send without approval" for MCP OAuth apps: the OAuth
	 * counterpart of the `mail:send:auto` token scope (see
	 * `shared/agent-send-policy.ts`). Off for every existing grant, so apps
	 * that were connected before this keep needing approval.
	 *
	 * Reserved number 0010, listed after 0011 because it merged later; names,
	 * not positions, record what has run. Append-only.
	 */
	{ name: "0010_oauth_grant_send_auto", statements: [
		// A side table rather than ALTER TABLE ADD COLUMN, so the migration is
		// idempotent like its neighbours. A grant with no row is "off".
		`CREATE TABLE IF NOT EXISTS oauth_grant_settings (
			grant_id TEXT PRIMARY KEY,
			send_auto INTEGER NOT NULL DEFAULT 0
		)`,
	] },
	/**
	 * The Usage tab: Workers AI calls per UTC day and feature (summaries,
	 * triage, …), the admin's budget thresholds (one row, id 1), and which
	 * `usage.budget_exceeded` alerts have fired (once per month per kind).
	 * See `workers/lib/usage-store.ts`. Append-only.
	 */
	{ name: "0019_ai_usage_and_budget", statements: [
		`CREATE TABLE IF NOT EXISTS ai_usage_daily (
			day TEXT NOT NULL,
			feature TEXT NOT NULL,
			calls INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (day, feature)
		)`,
		`CREATE TABLE IF NOT EXISTS usage_budget (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			ai_usd REAL,
			email_usd REAL,
			updated_at INTEGER,
			updated_by TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS usage_budget_alerts (
			month TEXT NOT NULL,
			kind TEXT NOT NULL,
			fired_at INTEGER NOT NULL,
			projected_usd REAL NOT NULL,
			threshold_usd REAL NOT NULL,
			PRIMARY KEY (month, kind)
		)`,
	] },
	/**
	 * Web Push: subscriptions per user and device, notification preferences,
	 * throttle counters and spent action-token ids. See
	 * `workers/lib/push-store.ts`. VAPID keys live in `meta`. Append-only.
	 */
	{ name: "0018_web_push", statements: PUSH_MIGRATION_STATEMENTS },
	/**
	 * IMAP import credentials (`workers/lib/import-credential-store.ts`): the
	 * app password a running IMAP import logs in with, encrypted with
	 * AUTH_SECRET-derived key material (AES-256-GCM, AAD bound to the job id).
	 * A row lives only while its job is active and is deleted when the job
	 * completes, fails or is cancelled. Kept here, not in the MailboxDO, so the
	 * mailbox database (exports, backups) never holds a credential.
	 *
	 * Number reserved by the coordinator. Append-only.
	 */
	{ name: "0020_import_credentials", statements: [
		`CREATE TABLE IF NOT EXISTS import_credentials (
			job_id TEXT PRIMARY KEY,
			mailbox_id TEXT NOT NULL,
			secret_enc TEXT NOT NULL,
			created_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_import_credentials_mailbox ON import_credentials(mailbox_id)`,
	] },
	/**
	 * The Usage tab's provider and role tables: model requests per UTC day,
	 * provider (a gateway id or "workers-ai") and role. Token and cost columns
	 * stay NULL until a call reports them. See `workers/lib/usage-store.ts`.
	 * Append-only.
	 */
	{ name: "0021_ai_usage_by_provider", statements: [
		`CREATE TABLE IF NOT EXISTS ai_usage_provider_daily (
			day TEXT NOT NULL,
			provider_id TEXT NOT NULL,
			role TEXT NOT NULL,
			calls INTEGER NOT NULL DEFAULT 0,
			input_tokens INTEGER,
			output_tokens INTEGER,
			cost_usd REAL,
			fallback_calls INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (day, provider_id, role)
		)`,
	] },
	/**
	 * The Cloudflare connection (`workers/lib/cf-connection-store.ts`): one
	 * API token pasted in Settings → Cloudflare connection, encrypted with
	 * AUTH_SECRET-derived key material (purpose `tapetide/cf-connection/v1`).
	 * A single row (`id = 'default'`). `last4` is kept in clear for display
	 * and audit so reading the view never decrypts. `CF_API_TOKEN` in env
	 * still wins over this row (`workers/lib/cf-connection.ts`). Append-only.
	 */
	{ name: "0022_cloudflare_connection", statements: [
		`CREATE TABLE IF NOT EXISTS cloudflare_connection (
			id TEXT PRIMARY KEY CHECK (id = 'default'),
			token_enc TEXT NOT NULL,
			last4 TEXT NOT NULL DEFAULT '',
			account_id TEXT,
			account_name TEXT,
			worker_script_name TEXT,
			token_kind TEXT,
			capabilities TEXT,
			verified_at INTEGER,
			created_by TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
	] },
	/**
	 * Every change Cloudflare onboarding apply makes (`workers/lib/dns-change-log.ts`):
	 * DNS records created, updated or deleted, and catch-all rules overwritten
	 * (`record_type = 'catch_all'`), with the exact before/after so each can be
	 * reverted. Append-only.
	 */
	{ name: "0023_dns_change_log", statements: [
		`CREATE TABLE IF NOT EXISTS dns_change_log (
			id TEXT PRIMARY KEY,
			zone_id TEXT NOT NULL,
			zone_name TEXT,
			record_type TEXT NOT NULL,
			name TEXT NOT NULL,
			action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
			before_json TEXT,
			after_json TEXT,
			plan_item TEXT,
			applied_at INTEGER NOT NULL,
			applied_by TEXT,
			reverted_at INTEGER,
			reverted_by TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS dns_change_log_applied ON dns_change_log (applied_at DESC)`,
		`CREATE INDEX IF NOT EXISTS dns_change_log_zone ON dns_change_log (zone_id, applied_at DESC)`,
	] },
	/**
	 * The deployment's own public origin (`workers/lib/deployment-origin.ts`),
	 * recorded from authenticated requests and `/setup`, for work with no
	 * request (cron and alarm sends). `rank`: 2 https custom domain, 1 https
	 * `*.workers.dev`, 0 localhost. One row. Append-only.
	 */
	{ name: "0024_deployment_origin", statements: [
		`CREATE TABLE IF NOT EXISTS deployment_origin (
			id TEXT PRIMARY KEY CHECK (id = 'default'),
			origin TEXT NOT NULL,
			rank INTEGER NOT NULL,
			source TEXT NOT NULL,
			first_seen_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
	] },
	/**
	 * The licence (`workers/lib/licence-store.ts`): the deployment id,
	 * generated once, and the signed token the licence server issued for it.
	 * Never the licence key. Times are Unix seconds. One row. Append-only.
	 */
	{ name: "0025_licence", statements: [
		`CREATE TABLE IF NOT EXISTS licence (
			id TEXT PRIMARY KEY CHECK (id = 'default'),
			deployment_id TEXT NOT NULL,
			token TEXT,
			refresh_after INTEGER,
			last_refresh_at INTEGER,
			last_attempt_at INTEGER,
			failure_count INTEGER NOT NULL DEFAULT 0,
			server_status TEXT,
			server_reason TEXT,
			updated_at INTEGER NOT NULL
		)`,
	] },
];

/** Migrations that existed before naming, in the order their count recorded them. */
const LEGACY_NUMBERED = 2;

/** Names of every migration this build knows, in run order. */
export const AUTH_MIGRATION_NAMES = MIGRATIONS.map((m) => m.name);

const USER_COLUMNS = `id, email, name, is_owner, disabled, totp_enabled, created_at, last_login_at, password_changed_at`;
/** User columns prefixed `u_`, for joins whose other side has `id`/`created_at` too. */
const USER_COLUMNS_JOINED = USER_COLUMNS.split(", ")
	.map((c) => `u.${c} AS u_${c}`)
	.join(", ");

/** Strip the `u_` prefix from a joined row back into a user row. */
function joinedUser(row: any): AuthUser {
	const u: Record<string, unknown> = {};
	for (const c of USER_COLUMNS.split(", ")) u[c] = row[`u_${c}`];
	return toUser(u);
}

/** SQLite booleans arrive as 0/1 (number or bigint depending on the driver). */
function bool(v: unknown): boolean {
	return Number(v) === 1;
}

function num(v: unknown): number {
	return Number(v);
}

function numOrNull(v: unknown): number | null {
	return v === null || v === undefined ? null : Number(v);
}

function toUser(row: any): AuthUser {
	return {
		id: row.id,
		email: row.email,
		name: row.name,
		isOwner: bool(row.is_owner),
		disabled: bool(row.disabled),
		totpEnabled: bool(row.totp_enabled),
		createdAt: num(row.created_at),
		lastLoginAt: numOrNull(row.last_login_at),
		passwordChangedAt: numOrNull(row.password_changed_at),
	};
}

function toSession(row: any): SessionInfo {
	return {
		id: row.id,
		userId: row.user_id,
		createdAt: num(row.created_at),
		lastSeenAt: num(row.last_seen_at),
		expiresAt: Math.min(num(row.idle_expires_at), num(row.absolute_expires_at)),
		ip: row.ip ?? null,
		userAgent: row.user_agent ?? null,
	};
}

function toInvite(row: any): InviteInfo {
	let mailboxes: string[] = [];
	try {
		const parsed = JSON.parse(row.mailboxes ?? "[]");
		if (Array.isArray(parsed)) mailboxes = parsed.filter((m) => typeof m === "string");
	} catch {
		// A corrupt column grants nothing rather than failing the listing.
	}
	return {
		id: row.id,
		email: row.email,
		role: row.role as InviteRole,
		mailboxes,
		createdBy: row.created_by ?? null,
		createdAt: num(row.created_at),
		expiresAt: num(row.expires_at),
	};
}

/** Grants with their per-grant settings (0010). No settings row reads as off. */
const OAUTH_GRANT_SELECT = `SELECT g.*, COALESCE(s.send_auto, 0) AS send_auto
	 FROM oauth_grants g LEFT JOIN oauth_grant_settings s ON s.grant_id = g.id`;

function toOAuthGrant(row: any): OAuthGrantInfo {
	return {
		id: row.id,
		userId: row.user_id,
		clientId: row.client_id,
		clientName: row.client_name,
		redirectHost: row.redirect_host,
		createdAt: num(row.created_at),
		lastUsedAt: numOrNull(row.last_used_at),
		sendAuto: num(row.send_auto ?? 0) === 1,
	};
}

function toPasskey(row: any): PasskeyInfo {
	let transports: string[] = [];
	try {
		const parsed = JSON.parse(row.transports ?? "[]");
		if (Array.isArray(parsed)) transports = parsed.filter((t) => typeof t === "string");
	} catch {
		// Transports are only a hint to the browser; losing them costs nothing.
	}
	return {
		id: row.id,
		userId: row.user_id,
		name: row.name,
		createdAt: num(row.created_at),
		lastUsedAt: numOrNull(row.last_used_at),
		deviceType: row.device_type === "multiDevice" ? "multiDevice" : "singleDevice",
		backedUp: bool(row.backed_up),
		transports,
		aaguid: row.aaguid ?? "",
	};
}

function toPasskeyCredential(row: any): PasskeyCredential {
	return {
		...toPasskey(row),
		credentialId: row.credential_id,
		publicKey: row.public_key,
		counter: num(row.counter),
	};
}

/** An API token row joined with its optional `api_token_meta` row. */
const API_TOKEN_SELECT = `SELECT t.*, m.scopes AS scopes, m.mailboxes AS mailboxes, m.parent_id AS parent_id,
	m.last_used_ip AS last_used_ip
	FROM api_tokens t LEFT JOIN api_token_meta m ON m.token_id = t.id`;

function toApiToken(row: any): ApiTokenInfo {
	return {
		id: row.id,
		userId: row.user_id,
		name: row.name,
		createdAt: num(row.created_at),
		lastUsedAt: numOrNull(row.last_used_at),
		lastUsedIp: typeof row.last_used_ip === "string" ? row.last_used_ip : null,
		expiresAt: numOrNull(row.expires_at),
		scopes: normalizeTokenScopes(parseJsonColumn(row.scopes)),
		mailboxes: normalizeTokenMailboxes(parseJsonColumn(row.mailboxes)),
		parentId: typeof row.parent_id === "string" ? row.parent_id : null,
	};
}

/**
 * A JSON column, or null when absent. An unreadable value reads as `[]` — "no
 * scopes" — never as null, so corruption can only narrow a token.
 */
function parseJsonColumn(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	try {
		return JSON.parse(String(value));
	} catch {
		return [];
	}
}

export class AuthStore implements AuthStoreApi, SuppressionStoreApi, PrivacyStoreApi {
	constructor(
		private readonly sql: AuthSql,
		private readonly transaction: AuthTransaction,
	) {
		this.migrate();
		this.authEpoch = Number(this.one(`SELECT value FROM meta WHERE key = ?`, AUTH_EPOCH_KEY)?.value) || 0;
	}

	/**
	 * The auth epoch (see `workers/auth/session-cache.ts`). Held in memory, so
	 * reading it costs nothing beyond the RPC; persisted in `meta` so a restart
	 * never moves it backwards onto a value an isolate has cached entries under.
	 */
	private authEpoch: number;

	/**
	 * Advance the auth epoch. Called first thing, synchronously, by every method
	 * that ends a credential or changes a user (`AUTH_EPOCH_METHODS`), so no
	 * validation can observe the new state paired with the old epoch.
	 */
	bumpAuthEpoch(): number {
		this.authEpoch += 1;
		this.sql.exec(
			`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			AUTH_EPOCH_KEY,
			String(this.authEpoch),
		);
		return this.authEpoch;
	}

	async getAuthEpoch(): Promise<number> {
		return this.authEpoch;
	}

	// -- internals -------------------------------------------------------------

	private all(query: string, ...bindings: unknown[]): any[] {
		return this.sql.exec(query, ...bindings).toArray();
	}

	private one(query: string, ...bindings: unknown[]): any | null {
		return this.all(query, ...bindings)[0] ?? null;
	}

	/** Bring the schema up to date. Idempotent; each step commits atomically. */
	private migrate(): void {
		this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
		this.sql.exec(
			`CREATE TABLE IF NOT EXISTS applied_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`,
		);

		// A deployment from before named migrations recorded only how many had
		// run. Those were always the first entries, so the count names them.
		const legacy = this.one(`SELECT value FROM meta WHERE key = 'schema_version'`);
		if (legacy) {
			const count = Math.min(Number(legacy.value) || 0, LEGACY_NUMBERED);
			this.transaction(() => {
				for (const m of MIGRATIONS.slice(0, count)) {
					this.sql.exec(
						`INSERT OR IGNORE INTO applied_migrations (name, applied_at) VALUES (?, 0)`,
						m.name,
					);
				}
				this.sql.exec(`DELETE FROM meta WHERE key = 'schema_version'`);
			});
		}

		const applied = new Set(
			this.all(`SELECT name FROM applied_migrations`).map((row) => String(row.name)),
		);
		for (const m of MIGRATIONS) {
			if (applied.has(m.name)) continue;
			this.transaction(() => {
				for (const stmt of m.statements) this.sql.exec(stmt);
				this.sql.exec(
					`INSERT INTO applied_migrations (name, applied_at) VALUES (?, ?)`,
					m.name,
					Date.now(),
				);
			});
		}
	}

	private userById(userId: string): AuthUser | null {
		const row = this.one(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, userId);
		return row ? toUser(row) : null;
	}

	private userByEmail(email: string): AuthUser | null {
		const row = this.one(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`, normalizeEmail(email));
		return row ? toUser(row) : null;
	}

	/** Drop rows that can no longer authenticate anything. Cheap with the indexes. */
	private purgeExpired(now: number): void {
		this.sql.exec(
			`DELETE FROM sessions WHERE idle_expires_at <= ? OR absolute_expires_at <= ?`,
			now,
			now,
		);
		this.sql.exec(`DELETE FROM mfa_challenges WHERE expires_at <= ?`, now);
		this.sql.exec(`DELETE FROM password_resets WHERE expires_at <= ? OR used_at IS NOT NULL`, now);
		this.sql.exec(`DELETE FROM webauthn_challenges WHERE expires_at <= ?`, now);
		// Session ids are random and never reused, so an orphan is harmless; this
		// only keeps the table small.
		this.sql.exec(`DELETE FROM session_step_ups WHERE session_id NOT IN (SELECT id FROM sessions)`);
		// Expired idempotency keys; also swept lazily on every keyed request.
		sweepIdempotencyKeys(this.sql, now);
	}

	/**
	 * Every path that signs a user out everywhere — disable, delete, password
	 * reset, owner recovery — comes through here, so connected MCP clients are
	 * cut off by the same statement that ends the browser sessions. Pending
	 * passkey ceremonies end too; the passkeys themselves stay (disable and
	 * delete remove them separately).
	 */
	private deleteUserSessions(userId: string): void {
		this.sql.exec(
			`DELETE FROM session_step_ups WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ?)`,
			userId,
		);
		this.sql.exec(`DELETE FROM sessions WHERE user_id = ?`, userId);
		this.sql.exec(`DELETE FROM mfa_challenges WHERE user_id = ?`, userId);
		this.sql.exec(`DELETE FROM oauth_grants WHERE user_id = ?`, userId);
		this.sql.exec(`DELETE FROM webauthn_challenges WHERE user_id = ?`, userId);
	}

	/** A deleted account's devices stop receiving, and its preferences go (0018). */
	private deleteUserPush(email: string): void {
		const key = normalizeEmail(email);
		this.sql.exec(`DELETE FROM push_subscriptions WHERE user_key = ?`, key);
		this.sql.exec(`DELETE FROM push_prefs WHERE user_key = ?`, key);
	}

	/** Drop failure rows that are neither locking anything nor recent. */
	private purgeStaleAttempts(now: number): void {
		this.sql.exec(
			`DELETE FROM login_attempts WHERE last_failure_at <= ? AND locked_until <= ?`,
			now - LOGIN_ATTEMPT_RETENTION_MS,
			now,
		);
		this.sql.exec(
			`DELETE FROM failure_windows WHERE window_start <= ? AND locked_until <= ?`,
			now - HOUR,
			now,
		);
	}

	/**
	 * Count one failure in a fixed one-hour window under `key`, opening a new
	 * window when the current one has passed. Returns the count in the window.
	 */
	private bumpWindow(key: string, now: number, windowMs: number): number {
		const row = this.one(`SELECT window_start, failures FROM failure_windows WHERE key = ?`, key);
		if (!row || now - num(row.window_start) >= windowMs) {
			this.sql.exec(
				`INSERT INTO failure_windows (key, window_start, failures, locked_until) VALUES (?, ?, 1, 0)
				 ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, failures = 1`,
				key,
				now,
			);
			return 1;
		}
		const failures = num(row.failures) + 1;
		this.sql.exec(`UPDATE failure_windows SET failures = ? WHERE key = ?`, failures, key);
		return failures;
	}

	/** Clear every password-failure row for an address, on all IPs. */
	private clearLoginAttempts(email: string): void {
		this.sql.exec(`DELETE FROM login_attempts WHERE email = ?`, normalizeEmail(email));
	}

	// -- setup -----------------------------------------------------------------

	async isSetupRequired(): Promise<boolean> {
		const row = this.one(`SELECT COUNT(*) AS n FROM users`);
		return Number(row?.n ?? 0) === 0;
	}

	async ensureGeneratedSetupToken(): Promise<string> {
		return this.getOrInitMeta("setup_token", randomToken(32));
	}

	async createOwner(input: {
		email: string;
		name: string;
		passwordHash: string;
		now: number;
	}): Promise<CreateOwnerResult> {
		return this.transaction((): CreateOwnerResult => {
			const row = this.one(`SELECT COUNT(*) AS n FROM users`);
			if (Number(row?.n ?? 0) > 0) return { ok: false, reason: "already_setup" };
			const id = randomId("usr");
			this.sql.exec(
				`INSERT INTO users (id, email, name, password_hash, is_owner, created_at, password_changed_at)
				 VALUES (?, ?, ?, ?, 1, ?, ?)`,
				id,
				normalizeEmail(input.email),
				input.name,
				input.passwordHash,
				input.now,
				input.now,
			);
			return { ok: true, user: this.userById(id)! };
		});
	}

	/**
	 * Break-glass for a lost owner password or authenticator. Clears the
	 * owner's password and second-factor lockouts too, since an attacker
	 * hammering the account is a likely reason the owner is here. API tokens are left alone: they are revoked from the
	 * UI once the owner is back in, and killing them would break integrations
	 * that were never compromised.
	 *
	 * Passkeys stay for the same reason: recovery is for a lost password or
	 * authenticator app, and the owner's other devices were not lost. One they
	 * no longer trust is deleted from Account & security once they are back in.
	 * Sessions do end, including any a stolen passkey had opened.
	 */
	async recoverOwner(input: { passwordHash: string; now: number }): Promise<{ email: string } | null> {
		this.bumpAuthEpoch();
		return this.transaction(() => {
			const owner = this.one(`SELECT id, email FROM users WHERE is_owner = 1`);
			if (!owner) return null;
			this.sql.exec(
				`UPDATE users SET password_hash = ?, password_changed_at = ?, mfa_failures = 0,
				 mfa_locked_until = 0, totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = NULL
				 WHERE id = ?`,
				input.passwordHash,
				input.now,
				owner.id,
			);
			this.sql.exec(`DELETE FROM recovery_codes WHERE user_id = ?`, owner.id);
			this.sql.exec(`DELETE FROM password_resets WHERE user_id = ?`, owner.id);
			this.clearLoginAttempts(owner.email as string);
			this.sql.exec(`DELETE FROM failure_windows WHERE key = ?`, RECOVERY_KEY);
			this.deleteUserSessions(owner.id);
			return { email: owner.email as string };
		});
	}

	// -- login -----------------------------------------------------------------

	async getLoginCandidate(email: string): Promise<LoginCandidate | null> {
		const row = this.one(
			`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE email = ?`,
			normalizeEmail(email),
		);
		if (!row) return null;
		return { user: toUser(row), passwordHash: row.password_hash };
	}

	async getLoginLock(email: string, ip: string, now: number): Promise<LockState> {
		const row = this.one(
			`SELECT locked_until FROM login_attempts WHERE email = ? AND ip = ?`,
			normalizeEmail(email),
			ip,
		);
		const lockedUntil = row ? num(row.locked_until) : 0;
		return { lockedUntil: lockedUntil > now ? lockedUntil : 0 };
	}

	/**
	 * Count a failed password for `(email, ip)`. Works the same whether or not
	 * an account exists for `email`, which is what keeps the lockout from
	 * answering "is this a real account".
	 */
	async recordLoginFailure(
		email: string,
		ip: string,
		now: number,
	): Promise<LockState & { accountAlert: boolean }> {
		const address = normalizeEmail(email);
		return this.transaction(() => {
			this.purgeStaleAttempts(now);
			const row = this.one(
				`SELECT failures FROM login_attempts WHERE email = ? AND ip = ?`,
				address,
				ip,
			);
			const failures = (row ? num(row.failures) : 0) + 1;
			const duration = lockoutDuration(failures);
			const lockedUntil = duration > 0 ? now + duration : 0;
			this.sql.exec(
				`INSERT INTO login_attempts (email, ip, failures, locked_until, last_failure_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(email, ip) DO UPDATE SET failures = excluded.failures,
				   locked_until = excluded.locked_until, last_failure_at = excluded.last_failure_at`,
				address,
				ip,
				failures,
				lockedUntil,
				now,
			);
			// True exactly once per window, on the failure that crosses the line.
			const accountFailures = this.bumpWindow(`account:${address}`, now, ACCOUNT_ALERT_WINDOW_MS);
			return { lockedUntil, accountAlert: accountFailures === ACCOUNT_ALERT_THRESHOLD + 1 };
		});
	}

	/**
	 * A complete sign-in (password, and second factor if on) from `ip`. Clears
	 * only that address's failures: someone guessing from elsewhere keeps their
	 * backoff. Also clears the second-factor counter, which a successful second
	 * factor is the only way to reach here with.
	 */
	async recordLoginSuccess(userId: string, ip: string, now: number): Promise<void> {
		this.transaction(() => {
			const user = this.userById(userId);
			if (!user) return;
			this.sql.exec(`DELETE FROM login_attempts WHERE email = ? AND ip = ?`, user.email, ip);
			this.sql.exec(
				`UPDATE users SET mfa_failures = 0, mfa_locked_until = 0, last_login_at = ? WHERE id = ?`,
				now,
				userId,
			);
		});
	}

	// -- break-glass recovery ----------------------------------------------------

	async getRecoveryLock(now: number): Promise<LockState> {
		const row = this.one(`SELECT locked_until FROM failure_windows WHERE key = ?`, RECOVERY_KEY);
		const lockedUntil = row ? num(row.locked_until) : 0;
		return { lockedUntil: lockedUntil > now ? lockedUntil : 0 };
	}

	/**
	 * Count a wrong setup token at `/recover`, globally. The endpoint resets the
	 * owner, so it gets a ceiling no number of IPs can lift.
	 */
	async recordRecoveryFailure(now: number): Promise<LockState & { failures: number }> {
		return this.transaction(() => {
			const failures = this.bumpWindow(RECOVERY_KEY, now, HOUR);
			let lockedUntil = 0;
			if (failures >= RECOVERY_MAX_FAILURES) {
				lockedUntil = now + RECOVERY_LOCK_MS;
				this.sql.exec(`UPDATE failure_windows SET locked_until = ? WHERE key = ?`, lockedUntil, RECOVERY_KEY);
			}
			return { lockedUntil, failures };
		});
	}

	// -- sessions --------------------------------------------------------------

	async createSession(input: {
		userId: string;
		tokenHash: string;
		ip: string | null;
		userAgent: string | null;
		now: number;
	}): Promise<SessionInfo> {
		return this.transaction(() => {
			// Login is infrequent enough that sweeping here keeps the tables small
			// without needing an alarm.
			this.purgeExpired(input.now);
			const id = randomId("ses");
			this.sql.exec(
				`INSERT INTO sessions (id, token_hash, user_id, created_at, last_seen_at,
				 idle_expires_at, absolute_expires_at, ip, user_agent)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				id,
				input.tokenHash,
				input.userId,
				input.now,
				input.now,
				input.now + SESSION_IDLE_MS,
				input.now + SESSION_ABSOLUTE_MS,
				input.ip,
				input.userAgent,
			);
			return toSession(this.one(`SELECT * FROM sessions WHERE id = ?`, id));
		});
	}

	async validateSession(
		tokenHash: string,
		now: number,
	): Promise<{ user: AuthUser; session: SessionInfo; epoch: number } | null> {
		const row = this.one(
			`SELECT s.*, ${USER_COLUMNS_JOINED}
			 FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
			tokenHash,
		);
		if (!row) return null;
		if (num(row.idle_expires_at) <= now || num(row.absolute_expires_at) <= now) {
			this.sql.exec(`DELETE FROM sessions WHERE id = ?`, row.id);
			return null;
		}
		const user = joinedUser(row);
		if (user.disabled) return null;
		if (now - num(row.last_seen_at) >= TOUCH_INTERVAL_MS) {
			row.last_seen_at = now;
			row.idle_expires_at = now + SESSION_IDLE_MS;
			this.sql.exec(
				`UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ?`,
				row.last_seen_at,
				row.idle_expires_at,
				row.id,
			);
		}
		return { user, session: toSession(row), epoch: this.authEpoch };
	}

	async deleteSession(tokenHash: string): Promise<void> {
		this.bumpAuthEpoch();
		this.sql.exec(`DELETE FROM sessions WHERE token_hash = ?`, tokenHash);
	}

	async listSessions(userId: string, now: number): Promise<SessionInfo[]> {
		return this.all(
			`SELECT * FROM sessions WHERE user_id = ? AND idle_expires_at > ? AND absolute_expires_at > ?
			 ORDER BY last_seen_at DESC`,
			userId,
			now,
			now,
		).map(toSession);
	}

	async revokeSession(userId: string, sessionId: string): Promise<boolean> {
		this.bumpAuthEpoch();
		// Scoped by user so one account cannot revoke another's session by id.
		return (
			this.all(`DELETE FROM sessions WHERE id = ? AND user_id = ? RETURNING id`, sessionId, userId)
				.length > 0
		);
	}

	/**
	 * Also disconnects every OAuth client: "sign out everywhere else" is the
	 * button a user reaches for when a device may be compromised, and an MCP
	 * client on that device holds a refresh token, not a session.
	 */
	async revokeOtherSessions(userId: string, keepTokenHash: string | null): Promise<number> {
		this.bumpAuthEpoch();
		this.sql.exec(`DELETE FROM oauth_grants WHERE user_id = ?`, userId);
		const rows =
			keepTokenHash === null
				? this.all(`DELETE FROM sessions WHERE user_id = ? RETURNING id`, userId)
				: this.all(
						`DELETE FROM sessions WHERE user_id = ? AND token_hash != ? RETURNING id`,
						userId,
						keepTokenHash,
					);
		return rows.length;
	}

	// -- second factor ---------------------------------------------------------

	async createMfaChallenge(input: { userId: string; challengeHash: string; now: number }): Promise<void> {
		this.sql.exec(`DELETE FROM mfa_challenges WHERE expires_at <= ?`, input.now);
		this.sql.exec(
			`INSERT INTO mfa_challenges (challenge_hash, user_id, expires_at, attempts) VALUES (?, ?, ?, 0)`,
			input.challengeHash,
			input.userId,
			input.now + MFA_CHALLENGE_MS,
		);
	}

	/**
	 * Count one attempt against the challenge. The per-challenge cap only bounds
	 * one sign-in attempt; what keeps a 6-digit code (10^6 space) out of reach is
	 * the per-account counter in `recordMfaFailure`, which a fresh challenge does
	 * not reset.
	 */
	async useMfaChallenge(challengeHash: string, now: number): Promise<{ userId: string } | null> {
		return this.transaction(() => {
			const row = this.one(`SELECT * FROM mfa_challenges WHERE challenge_hash = ?`, challengeHash);
			if (!row) return null;
			if (num(row.expires_at) <= now || num(row.attempts) >= MFA_MAX_ATTEMPTS) {
				this.sql.exec(`DELETE FROM mfa_challenges WHERE challenge_hash = ?`, challengeHash);
				return null;
			}
			this.sql.exec(
				`UPDATE mfa_challenges SET attempts = attempts + 1 WHERE challenge_hash = ?`,
				challengeHash,
			);
			return { userId: row.user_id as string };
		});
	}

	async deleteMfaChallenge(challengeHash: string): Promise<void> {
		this.sql.exec(`DELETE FROM mfa_challenges WHERE challenge_hash = ?`, challengeHash);
	}

	async getMfaLock(userId: string, now: number): Promise<LockState> {
		const row = this.one(`SELECT mfa_locked_until FROM users WHERE id = ?`, userId);
		const lockedUntil = row ? num(row.mfa_locked_until) : 0;
		return { lockedUntil: lockedUntil > now ? lockedUntil : 0 };
	}

	/**
	 * Count a wrong second factor against the account, across challenges, with
	 * the same backoff as passwords. Reset only by a successful second factor
	 * (`recordLoginSuccess`) or by turning 2FA off.
	 */
	async recordMfaFailure(userId: string, now: number): Promise<LockState> {
		return this.transaction(() => {
			const row = this.one(`SELECT mfa_failures FROM users WHERE id = ?`, userId);
			if (!row) return { lockedUntil: 0 };
			const failures = num(row.mfa_failures) + 1;
			const duration = lockoutDuration(failures);
			const lockedUntil = duration > 0 ? now + duration : 0;
			this.sql.exec(
				`UPDATE users SET mfa_failures = ?, mfa_locked_until = ? WHERE id = ?`,
				failures,
				lockedUntil,
				userId,
			);
			return { lockedUntil };
		});
	}

	async getTotp(userId: string): Promise<TotpState> {
		const row = this.one(
			`SELECT totp_secret_enc, totp_enabled, totp_last_step FROM users WHERE id = ?`,
			userId,
		);
		if (!row) return { secretEnc: null, enabled: false, lastStep: null };
		return {
			secretEnc: row.totp_secret_enc ?? null,
			enabled: bool(row.totp_enabled),
			lastStep: numOrNull(row.totp_last_step),
		};
	}

	/**
	 * Store a not-yet-confirmed secret. Throws `Error("totp_enabled")` when 2FA
	 * is already on: overwriting the active secret would silently swap the
	 * user's authenticator for one they have not proven they hold.
	 */
	async setPendingTotp(userId: string, secretEnc: string): Promise<void> {
		const rows = this.all(
			`UPDATE users SET totp_secret_enc = ?, totp_last_step = NULL
			 WHERE id = ? AND totp_enabled = 0 RETURNING id`,
			secretEnc,
			userId,
		);
		if (rows.length === 0) throw new Error(this.userById(userId) ? "totp_enabled" : "not_found");
	}

	/**
	 * Activate the pending secret. `step` is the step of the code that proved
	 * possession, recorded so that same code cannot then be replayed to log in.
	 */
	async enableTotp(userId: string, step: number, recoveryCodeHashes: string[]): Promise<void> {
		this.bumpAuthEpoch();
		this.transaction(() => {
			const rows = this.all(
				`UPDATE users SET totp_enabled = 1, totp_last_step = ?
				 WHERE id = ? AND totp_secret_enc IS NOT NULL RETURNING id`,
				step,
				userId,
			);
			if (rows.length === 0) throw new Error("no_pending_totp");
			this.writeRecoveryCodes(userId, recoveryCodeHashes);
		});
	}

	async disableTotp(userId: string): Promise<void> {
		this.bumpAuthEpoch();
		this.transaction(() => {
			this.sql.exec(
				`UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = NULL,
				 mfa_failures = 0, mfa_locked_until = 0 WHERE id = ?`,
				userId,
			);
			this.sql.exec(`DELETE FROM recovery_codes WHERE user_id = ?`, userId);
		});
	}

	/** Compare-and-set in one statement, so two concurrent logins cannot both use a step. */
	async recordTotpStep(userId: string, step: number): Promise<boolean> {
		return (
			this.all(
				`UPDATE users SET totp_last_step = ?
				 WHERE id = ? AND totp_enabled = 1 AND (totp_last_step IS NULL OR totp_last_step < ?)
				 RETURNING id`,
				step,
				userId,
				step,
			).length > 0
		);
	}

	private writeRecoveryCodes(userId: string, hashes: string[]): void {
		this.sql.exec(`DELETE FROM recovery_codes WHERE user_id = ?`, userId);
		for (const hash of hashes) {
			this.sql.exec(
				`INSERT OR IGNORE INTO recovery_codes (user_id, code_hash) VALUES (?, ?)`,
				userId,
				hash,
			);
		}
	}

	async replaceRecoveryCodes(userId: string, hashes: string[]): Promise<void> {
		this.transaction(() => this.writeRecoveryCodes(userId, hashes));
	}

	/** Delete-returning makes the check and the burn one step: a code works once. */
	async consumeRecoveryCode(userId: string, hash: string): Promise<boolean> {
		return (
			this.all(
				`DELETE FROM recovery_codes WHERE user_id = ? AND code_hash = ? RETURNING code_hash`,
				userId,
				hash,
			).length > 0
		);
	}

	async countRecoveryCodes(userId: string): Promise<number> {
		return num(this.one(`SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?`, userId)?.n ?? 0);
	}

	// -- account ---------------------------------------------------------------

	async getUser(userId: string): Promise<AuthUser | null> {
		return this.userById(userId);
	}

	async getUserByEmail(email: string): Promise<AuthUser | null> {
		return this.userByEmail(email);
	}

	async listUsers(): Promise<AuthUser[]> {
		return this.all(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at ASC, email ASC`).map(toUser);
	}

	/**
	 * Leaves sign-in failure rows alone: this also runs to upgrade a hash during
	 * a successful login, and that must not wipe the backoff of someone guessing
	 * the same account from another address.
	 */
	async updatePassword(userId: string, passwordHash: string, now: number): Promise<void> {
		this.bumpAuthEpoch();
		this.sql.exec(
			`UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?`,
			passwordHash,
			now,
			userId,
		);
	}

	async updateProfile(userId: string, patch: { name?: string }): Promise<AuthUser | null> {
		this.bumpAuthEpoch();
		if (typeof patch.name === "string") {
			this.sql.exec(`UPDATE users SET name = ? WHERE id = ?`, patch.name, userId);
		}
		return this.userById(userId);
	}

	/**
	 * Disabling revokes every credential at once: sessions, pending MFA
	 * challenges, reset links, passkeys and API tokens. Re-enabling restores none of them,
	 * so a disabled-then-enabled account starts from a clean slate.
	 */
	async setDisabled(userId: string, disabled: boolean): Promise<boolean> {
		this.bumpAuthEpoch();
		return this.transaction(() => {
			const user = this.userById(userId);
			if (!user || user.isOwner) return false;
			this.sql.exec(`UPDATE users SET disabled = ? WHERE id = ?`, disabled ? 1 : 0, userId);
			if (disabled) {
				this.deleteUserSessions(userId);
				this.sql.exec(`DELETE FROM password_resets WHERE user_id = ?`, userId);
				this.sql.exec(`DELETE FROM passkeys WHERE user_id = ?`, userId);
				this.sql.exec(`DELETE FROM push_subscriptions WHERE user_key = ?`, normalizeEmail(user.email));
				this.sql.exec(
					`UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
					Date.now(),
					userId,
				);
			}
			return true;
		});
	}

	async deleteUser(userId: string): Promise<boolean> {
		this.bumpAuthEpoch();
		return this.transaction(() => {
			const user = this.userById(userId);
			if (!user || user.isOwner) return false;
			this.deleteUserSessions(userId);
			this.sql.exec(`DELETE FROM recovery_codes WHERE user_id = ?`, userId);
			this.sql.exec(`DELETE FROM password_resets WHERE user_id = ?`, userId);
			this.sql.exec(
				`DELETE FROM api_token_meta WHERE token_id IN (SELECT id FROM api_tokens WHERE user_id = ?)`,
				userId,
			);
			this.sql.exec(`DELETE FROM api_tokens WHERE user_id = ?`, userId);
			this.sql.exec(`DELETE FROM passkeys WHERE user_id = ?`, userId);
			this.deleteUserPush(user.email);
			this.sql.exec(`DELETE FROM users WHERE id = ?`, userId);
			return true;
		});
	}

	// -- invites ---------------------------------------------------------------

	/**
	 * Throws `Error("email_taken")` when an account already exists for the
	 * address: an invite could never be accepted, and silently issuing one would
	 * hide the admin's mistake. Re-inviting the same address supersedes any
	 * earlier unused invite, so only the newest link works.
	 */
	async createInvite(input: {
		tokenHash: string;
		email: string;
		role: InviteRole;
		mailboxes: string[];
		createdBy: string | null;
		expiresAt: number;
		now: number;
	}): Promise<InviteInfo> {
		return this.transaction(() => {
			const email = normalizeEmail(input.email);
			if (this.userByEmail(email)) throw new Error("email_taken");
			this.sql.exec(`DELETE FROM invites WHERE email = ? AND used_at IS NULL`, email);
			const id = randomId("inv");
			this.sql.exec(
				`INSERT INTO invites (id, token_hash, email, role, mailboxes, created_by, created_at, expires_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				id,
				input.tokenHash,
				email,
				input.role,
				JSON.stringify(input.mailboxes ?? []),
				input.createdBy,
				input.now,
				input.expiresAt,
			);
			return toInvite(this.one(`SELECT * FROM invites WHERE id = ?`, id));
		});
	}

	private pendingInvite(tokenHash: string, now: number): any | null {
		return this.one(
			`SELECT * FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
			tokenHash,
			now,
		);
	}

	async getInvite(tokenHash: string, now: number): Promise<InviteInfo | null> {
		const row = this.pendingInvite(tokenHash, now);
		return row ? toInvite(row) : null;
	}

	/** Pending invites only; accepted and expired ones are not actionable. */
	async listInvites(now: number): Promise<InviteInfo[]> {
		return this.all(
			`SELECT * FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
			now,
		).map(toInvite);
	}

	async revokeInvite(inviteId: string): Promise<boolean> {
		return (
			this.all(`DELETE FROM invites WHERE id = ? AND used_at IS NULL RETURNING id`, inviteId).length > 0
		);
	}

	async acceptInvite(input: {
		tokenHash: string;
		name: string;
		passwordHash: string;
		now: number;
	}): Promise<AcceptInviteResult> {
		return this.transaction((): AcceptInviteResult => {
			const row = this.pendingInvite(input.tokenHash, input.now);
			if (!row) return { ok: false, reason: "invalid" };
			if (this.userByEmail(row.email)) return { ok: false, reason: "email_taken" };
			const id = randomId("usr");
			this.sql.exec(
				`INSERT INTO users (id, email, name, password_hash, is_owner, created_at, password_changed_at)
				 VALUES (?, ?, ?, ?, 0, ?, ?)`,
				id,
				row.email,
				input.name,
				input.passwordHash,
				input.now,
				input.now,
			);
			this.sql.exec(`UPDATE invites SET used_at = ? WHERE id = ?`, input.now, row.id);
			return { ok: true, user: this.userById(id)!, invite: toInvite(row) };
		});
	}

	// -- password reset links --------------------------------------------------

	async createPasswordReset(input: {
		userId: string;
		tokenHash: string;
		expiresAt: number;
		now: number;
	}): Promise<void> {
		this.transaction(() => {
			this.sql.exec(`DELETE FROM password_resets WHERE user_id = ?`, input.userId);
			this.sql.exec(
				`INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)`,
				input.tokenHash,
				input.userId,
				input.expiresAt,
			);
		});
	}

	/**
	 * Self-service reset by email: one atomic step that finds the account,
	 * applies the per-account cap and issues the link.
	 *
	 * One call, not a lookup then a write, so the Worker does identical work for
	 * an unknown address and a real one, and two concurrent requests cannot both
	 * slip under the cap. The cap counts only links actually issued: unknown or
	 * disabled accounts spend nothing, and a capped request does not replace
	 * (and so invalidate) the link already sitting in the inbox.
	 */
	async issueEmailPasswordReset(input: {
		email: string;
		tokenHash: string;
		expiresAt: number;
		now: number;
	}): Promise<IssueEmailResetResult> {
		return this.transaction((): IssueEmailResetResult => {
			const user = this.userByEmail(input.email);
			if (!user) return { ok: false, reason: "unknown" };
			if (user.disabled) return { ok: false, reason: "disabled" };
			const key = `reset-email:${user.id}`;
			const row = this.one(`SELECT window_start, failures FROM failure_windows WHERE key = ?`, key);
			const inWindow = row !== null && input.now - num(row.window_start) < RESET_EMAIL_WINDOW_MS;
			if (inWindow && num(row.failures) >= RESET_EMAIL_MAX_PER_WINDOW) {
				return { ok: false, reason: "capped" };
			}
			// `failure_windows` is the store's generic fixed-window counter; here
			// "failures" counts emails sent. Reusing it means no schema change, and
			// `purgeStaleAttempts` already drops windows older than an hour.
			this.bumpWindow(key, input.now, RESET_EMAIL_WINDOW_MS);
			this.sql.exec(`DELETE FROM password_resets WHERE user_id = ?`, user.id);
			this.sql.exec(
				`INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)`,
				input.tokenHash,
				user.id,
				input.expiresAt,
			);
			return { ok: true, user };
		});
	}

	/** Valid link for an enabled user, or null. */
	private pendingReset(tokenHash: string, now: number): { userId: string; email: string } | null {
		const row = this.one(
			`SELECT r.user_id, u.email FROM password_resets r JOIN users u ON u.id = r.user_id
			 WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ? AND u.disabled = 0`,
			tokenHash,
			now,
		);
		return row ? { userId: row.user_id, email: row.email } : null;
	}

	async getPasswordReset(tokenHash: string, now: number): Promise<{ userId: string; email: string } | null> {
		return this.pendingReset(tokenHash, now);
	}

	/**
	 * Single use, and revokes every session: whoever might have had the old
	 * password is signed out. Clears the address's sign-in failures (on every
	 * IP) so the user can sign in at once.
	 */
	async consumePasswordReset(input: {
		tokenHash: string;
		passwordHash: string;
		now: number;
	}): Promise<{ userId: string } | null> {
		this.bumpAuthEpoch();
		return this.transaction(() => {
			const reset = this.pendingReset(input.tokenHash, input.now);
			if (!reset) return null;
			this.sql.exec(`DELETE FROM password_resets WHERE user_id = ?`, reset.userId);
			this.sql.exec(
				`UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?`,
				input.passwordHash,
				input.now,
				reset.userId,
			);
			this.clearLoginAttempts(reset.email);
			this.deleteUserSessions(reset.userId);
			return { userId: reset.userId };
		});
	}

	// -- API tokens ------------------------------------------------------------

	async createApiToken(input: {
		id: string;
		userId: string;
		name: string;
		secretHash: string;
		expiresAt: number | null;
		now: number;
		scopes?: string[] | null;
		mailboxes?: string[] | null;
		parentId?: string | null;
	}): Promise<ApiTokenInfo> {
		const scopes = normalizeTokenScopes(input.scopes);
		const mailboxes = normalizeTokenMailboxes(input.mailboxes);
		this.transaction(() => {
			// The parent was validated at the start of the request, but it can be
			// revoked (or expire) before this runs. Re-check here, in the same
			// transaction as the insert, so a child can never outlive a parent
			// revoked mid-request: revocation's cascade and this insert serialize.
			if (input.parentId) {
				const parent = this.one(
					`SELECT revoked_at, expires_at FROM api_tokens WHERE id = ? AND user_id = ?`,
					input.parentId,
					input.userId,
				);
				const live =
					parent &&
					(parent.revoked_at === null || parent.revoked_at === undefined) &&
					(parent.expires_at === null || parent.expires_at === undefined || num(parent.expires_at) > input.now);
				if (!live) throw new Error("parent_token_inactive");
			}
			this.sql.exec(
				`INSERT INTO api_tokens (id, user_id, name, secret_hash, created_at, expires_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				input.id,
				input.userId,
				input.name,
				input.secretHash,
				input.now,
				input.expiresAt,
			);
			// No row for an unrestricted token with no parent: it reads exactly like
			// every token minted before scopes existed.
			if (scopes !== null || mailboxes !== null || input.parentId) {
				this.sql.exec(
					`INSERT INTO api_token_meta (token_id, scopes, mailboxes, parent_id) VALUES (?, ?, ?, ?)`,
					input.id,
					scopes === null ? null : JSON.stringify(scopes),
					mailboxes === null ? null : JSON.stringify(mailboxes),
					input.parentId ?? null,
				);
			}
		});
		return toApiToken(this.one(`${API_TOKEN_SELECT} WHERE t.id = ?`, input.id));
	}

	/** Unrevoked tokens, including expired ones so the user can see why one stopped working. */
	async listApiTokens(userId: string): Promise<ApiTokenInfo[]> {
		return this.all(
			`${API_TOKEN_SELECT} WHERE t.user_id = ? AND t.revoked_at IS NULL ORDER BY t.created_at DESC`,
			userId,
		).map(toApiToken);
	}

	/** Revokes the token and every token it (transitively) minted. */
	async revokeApiToken(userId: string, tokenId: string): Promise<boolean> {
		this.bumpAuthEpoch();
		return this.transaction(() => {
			const t = Date.now();
			const revoked =
				this.all(
					`UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL
					 RETURNING id`,
					t,
					tokenId,
					userId,
				).length > 0;
			if (revoked) {
				this.sql.exec(
					`WITH RECURSIVE descendants(id) AS (
						SELECT token_id FROM api_token_meta WHERE parent_id = ?
						UNION SELECT m.token_id FROM api_token_meta m JOIN descendants d ON m.parent_id = d.id
					)
					UPDATE api_tokens SET revoked_at = ?
					WHERE id IN (SELECT id FROM descendants) AND user_id = ? AND revoked_at IS NULL`,
					tokenId,
					t,
					userId,
				);
			}
			return revoked;
		});
	}

	/**
	 * Lookup is by the public id; the secret hash is then compared in constant
	 * time, so response timing cannot be used to walk a hash prefix.
	 */
	async validateApiToken(
		tokenId: string,
		secretHash: string,
		now: number,
		ip: string | null = null,
	): Promise<{ user: AuthUser; token: ApiTokenInfo; epoch: number } | null> {
		const row = this.one(`${API_TOKEN_SELECT} WHERE t.id = ?`, tokenId);
		if (!row) return null;
		if (!timingSafeEqualString(String(row.secret_hash), String(secretHash))) return null;
		if (row.revoked_at !== null && row.revoked_at !== undefined) return null;
		if (row.expires_at !== null && row.expires_at !== undefined && num(row.expires_at) <= now) return null;
		const user = this.userById(row.user_id);
		if (!user || user.disabled) return null;
		// Also written when the address changes, so "last used from" is not up to
		// an hour stale after a token moves machines. None on the common
		// same-place-within-the-hour path.
		const lastIp = typeof row.last_used_ip === "string" ? row.last_used_ip : null;
		const ipChanged = ip !== null && ip !== lastIp;
		if (row.last_used_at === null || ipChanged || now - num(row.last_used_at) >= TOUCH_INTERVAL_MS) {
			row.last_used_at = now;
			this.sql.exec(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`, now, tokenId);
			if (ip !== null) {
				row.last_used_ip = ip;
				this.sql.exec(
					`INSERT INTO api_token_meta (token_id, last_used_ip) VALUES (?, ?)
					 ON CONFLICT(token_id) DO UPDATE SET last_used_ip = excluded.last_used_ip`,
					tokenId,
					ip,
				);
			}
		}
		return { user, token: toApiToken(row), epoch: this.authEpoch };
	}

	// -- MCP OAuth grants ------------------------------------------------------

	/**
	 * Record an approval. Earlier approvals of the same client by the same user
	 * are dropped, mirroring the provider, which revokes that client's previous
	 * KV grant when the new one is stored: re-connecting replaces, not stacks.
	 */
	async createOAuthGrant(input: {
		userId: string;
		clientId: string;
		clientName: string;
		redirectHost: string;
		now: number;
	}): Promise<OAuthGrantInfo> {
		this.bumpAuthEpoch();
		return this.transaction(() => {
			const user = this.userById(input.userId);
			if (!user || user.disabled) throw new Error("user_unavailable");
			this.sql.exec(
				`DELETE FROM oauth_grants WHERE user_id = ? AND client_id = ?`,
				input.userId,
				input.clientId,
			);
			const id = randomId("ogr");
			this.sql.exec(
				`INSERT INTO oauth_grants (id, user_id, client_id, client_name, redirect_host, created_at, last_used_at)
				 VALUES (?, ?, ?, ?, ?, ?, NULL)`,
				id,
				input.userId,
				input.clientId,
				input.clientName.slice(0, 200),
				input.redirectHost.slice(0, 255),
				input.now,
			);
			return toOAuthGrant(this.one(`${OAUTH_GRANT_SELECT} WHERE g.id = ?`, id));
		});
	}

	/**
	 * Null unless the grant is still recorded for exactly this user and the user
	 * exists and is enabled. Touches `lastUsedAt` at most once an hour, like API
	 * tokens, so a busy MCP client does not turn reads into writes.
	 */
	async validateOAuthGrant(
		grantId: string,
		userId: string,
		now: number,
	): Promise<{ user: AuthUser; grant: OAuthGrantInfo; epoch: number } | null> {
		const row = this.one(`${OAUTH_GRANT_SELECT} WHERE g.id = ? AND g.user_id = ?`, grantId, userId);
		if (!row) return null;
		const user = this.userById(userId);
		if (!user || user.disabled) return null;
		if (row.last_used_at === null || row.last_used_at === undefined || now - num(row.last_used_at) >= TOUCH_INTERVAL_MS) {
			row.last_used_at = now;
			this.sql.exec(`UPDATE oauth_grants SET last_used_at = ? WHERE id = ?`, now, grantId);
		}
		return { user, grant: toOAuthGrant(row), epoch: this.authEpoch };
	}

	async listOAuthGrants(userId: string): Promise<OAuthGrantInfo[]> {
		return this.all(
			`${OAUTH_GRANT_SELECT} WHERE g.user_id = ? ORDER BY g.created_at DESC`,
			userId,
		).map(toOAuthGrant);
	}

	async revokeOAuthGrant(userId: string, grantId: string): Promise<boolean> {
		this.bumpAuthEpoch();
		const gone =
			this.all(`DELETE FROM oauth_grants WHERE id = ? AND user_id = ? RETURNING id`, grantId, userId).length > 0;
		if (gone) this.sql.exec(`DELETE FROM oauth_grant_settings WHERE grant_id = ?`, grantId);
		return gone;
	}

	/** Mark one of the user's connected apps as allowed (or not) to send without approval. */
	async setOAuthGrantSendAuto(userId: string, grantId: string, sendAuto: boolean): Promise<OAuthGrantInfo | null> {
		this.bumpAuthEpoch();
		return this.transaction(() => {
			if (!this.one(`SELECT id FROM oauth_grants WHERE id = ? AND user_id = ?`, grantId, userId)) return null;
			this.sql.exec(
				`INSERT INTO oauth_grant_settings (grant_id, send_auto) VALUES (?, ?)
				 ON CONFLICT(grant_id) DO UPDATE SET send_auto = excluded.send_auto`,
				grantId,
				sendAuto ? 1 : 0,
			);
			return toOAuthGrant(this.one(`${OAUTH_GRANT_SELECT} WHERE g.id = ?`, grantId));
		});
	}

	// -- passkeys ---------------------------------------------------------------

	/**
	 * Store a ceremony challenge. False when too many are outstanding (see
	 * `WEBAUTHN_MAX_OUTSTANDING`), so anonymous callers cannot grow the table
	 * without bound even when the rate limiter is missing.
	 */
	async createWebAuthnChallenge(input: {
		challengeHash: string;
		purpose: WebAuthnPurpose;
		userId: string | null;
		now: number;
	}): Promise<boolean> {
		return this.transaction(() => {
			this.sql.exec(`DELETE FROM webauthn_challenges WHERE expires_at <= ?`, input.now);
			const row = this.one(`SELECT COUNT(*) AS n FROM webauthn_challenges`);
			if (num(row?.n ?? 0) >= WEBAUTHN_MAX_OUTSTANDING) return false;
			this.sql.exec(
				`INSERT INTO webauthn_challenges (challenge_hash, purpose, user_id, expires_at) VALUES (?, ?, ?, ?)`,
				input.challengeHash,
				input.purpose,
				input.userId,
				input.now + WEBAUTHN_CHALLENGE_MS,
			);
			return true;
		});
	}

	/**
	 * Single use: the row is deleted whatever the outcome, so a challenge
	 * presented for the wrong purpose or user is burnt rather than left for a
	 * second try. True only when it was live, for `purpose`, and bound to
	 * `userId` (null = must be unbound).
	 */
	async consumeWebAuthnChallenge(
		challengeHash: string,
		purpose: WebAuthnPurpose,
		userId: string | null,
		now: number,
	): Promise<boolean> {
		const row = this.one(
			`DELETE FROM webauthn_challenges WHERE challenge_hash = ? RETURNING purpose, user_id, expires_at`,
			challengeHash,
		);
		if (!row) return false;
		if (num(row.expires_at) <= now) return false;
		if (row.purpose !== purpose) return false;
		return (row.user_id ?? null) === userId;
	}

	/**
	 * Throws `Error("passkey_exists")` when the credential is already
	 * registered (to anyone) and `Error("passkey_limit")` at the per-user cap.
	 */
	async addPasskey(input: {
		userId: string;
		credentialId: string;
		publicKey: string;
		counter: number;
		transports: string[];
		aaguid: string;
		deviceType: "singleDevice" | "multiDevice";
		backedUp: boolean;
		name: string;
		now: number;
	}): Promise<PasskeyInfo> {
		return this.transaction(() => {
			if (this.one(`SELECT id FROM passkeys WHERE credential_id = ?`, input.credentialId)) {
				throw new Error("passkey_exists");
			}
			const count = num(
				this.one(`SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?`, input.userId)?.n ?? 0,
			);
			if (count >= PASSKEY_MAX_PER_USER) throw new Error("passkey_limit");
			const id = randomId("pk");
			this.sql.exec(
				`INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, aaguid,
				 device_type, backed_up, name, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				id,
				input.userId,
				input.credentialId,
				input.publicKey,
				input.counter,
				JSON.stringify(input.transports ?? []),
				input.aaguid,
				input.deviceType,
				input.backedUp ? 1 : 0,
				input.name,
				input.now,
			);
			return toPasskey(this.one(`SELECT * FROM passkeys WHERE id = ?`, id));
		});
	}

	async listPasskeys(userId: string): Promise<PasskeyInfo[]> {
		return (await this.listPasskeyCredentials(userId)).map(
			({ credentialId: _c, publicKey: _p, counter: _n, ...info }) => info,
		);
	}

	/** With key material, for `excludeCredentials` and second-factor `allowCredentials`. */
	async listPasskeyCredentials(userId: string): Promise<PasskeyCredential[]> {
		return this.all(`SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at ASC`, userId).map(
			toPasskeyCredential,
		);
	}

	async getPasskeyByCredentialId(
		credentialId: string,
	): Promise<{ passkey: PasskeyCredential; user: AuthUser } | null> {
		const row = this.one(
			`SELECT p.*, ${USER_COLUMNS_JOINED} FROM passkeys p JOIN users u ON u.id = p.user_id
			 WHERE p.credential_id = ?`,
			credentialId,
		);
		if (!row) return null;
		return { passkey: toPasskeyCredential(row), user: joinedUser(row) };
	}

	/**
	 * Record a verified assertion, compare-and-set on the signature counter.
	 *
	 * The library already refuses a counter that did not advance past the value
	 * it was handed, but two concurrent assertions can both pass that check
	 * against the same stored value. Repeating the comparison in the UPDATE
	 * makes the store the single arbiter. Authenticators that do not count
	 * (always 0, as synced passkeys usually are) stay at 0 and always pass.
	 */
	async recordPasskeyUse(input: {
		credentialId: string;
		newCounter: number;
		backedUp: boolean;
		now: number;
	}): Promise<boolean> {
		return (
			this.all(
				`UPDATE passkeys SET counter = ?, backed_up = ?, last_used_at = ?
				 WHERE credential_id = ? AND ((counter = 0 AND ? = 0) OR counter < ?)
				 RETURNING id`,
				input.newCounter,
				input.backedUp ? 1 : 0,
				input.now,
				input.credentialId,
				input.newCounter,
				input.newCounter,
			).length > 0
		);
	}

	async renamePasskey(userId: string, passkeyId: string, name: string): Promise<PasskeyInfo | null> {
		const row = this.one(
			`UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ? RETURNING *`,
			name,
			passkeyId,
			userId,
		);
		return row ? toPasskey(row) : null;
	}

	/** Scoped by user, like sessions and tokens. */
	async deletePasskey(userId: string, passkeyId: string): Promise<boolean> {
		return (
			this.all(`DELETE FROM passkeys WHERE id = ? AND user_id = ? RETURNING id`, passkeyId, userId)
				.length > 0
		);
	}

	/**
	 * When the session's user last proved who they are: the later of the
	 * sign-in that created it and any step-up since. Null for an unknown
	 * session.
	 */
	async getSessionAuthenticatedAt(tokenHash: string): Promise<number | null> {
		const row = this.one(
			`SELECT s.created_at, r.authenticated_at FROM sessions s
			 LEFT JOIN session_step_ups r ON r.session_id = s.id WHERE s.token_hash = ?`,
			tokenHash,
		);
		if (!row) return null;
		return Math.max(num(row.created_at), num(row.authenticated_at ?? 0));
	}

	async markSessionAuthenticated(tokenHash: string, now: number): Promise<boolean> {
		return this.transaction(() => {
			const session = this.one(`SELECT id FROM sessions WHERE token_hash = ?`, tokenHash);
			if (!session) return false;
			this.sql.exec(
				`INSERT INTO session_step_ups (session_id, authenticated_at) VALUES (?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET authenticated_at = excluded.authenticated_at`,
				session.id,
				now,
			);
			return true;
		});
	}

	// -- privacy: tracking opt-outs --------------------------------------------

	/** Record that `address` does not want tracked mail from `scope`. Idempotent. */
	async addTrackingOptOut(input: { address: string; scope: string; source: string; now: number }): Promise<boolean> {
		const address = input.address.trim().toLowerCase();
		const scope = (input.scope || "global").trim().toLowerCase();
		const rows = this.all(
			`INSERT INTO tracking_opt_outs (address, scope, source, created_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(address, scope) DO NOTHING RETURNING address`,
			address,
			scope,
			input.source,
			input.now,
		);
		return rows.length > 0;
	}

	/**
	 * Opt-outs covering any of `addresses` for mail from `domain`: global ones
	 * plus those scoped to that domain. With no domain, every entry.
	 */
	async findTrackingOptOuts(
		addresses: string[],
		domain?: string | null,
	): Promise<{ address: string; scope: string }[]> {
		const unique = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))];
		const out: { address: string; scope: string }[] = [];
		for (let i = 0; i < unique.length; i += 90) {
			const chunk = unique.slice(i, i + 90);
			const marks = chunk.map(() => "?").join(", ");
			const rows = domain
				? this.all(
						`SELECT address, scope FROM tracking_opt_outs
						  WHERE address IN (${marks}) AND (scope = 'global' OR scope = ?)`,
						...chunk,
						domain.toLowerCase(),
					)
				: this.all(`SELECT address, scope FROM tracking_opt_outs WHERE address IN (${marks})`, ...chunk);
			out.push(...rows.map((r) => ({ address: String(r.address), scope: String(r.scope) })));
		}
		return out;
	}

	// -- privacy: self-service account deletion --------------------------------

	/**
	 * Start the grace period for deleting `userId`'s own account.
	 *
	 * Refuses the owner: the database allows exactly one, so the owner is always
	 * the sole owner, and deleting them would leave a deployment nobody can
	 * administer. Everything that can act as the account (sessions, MFA
	 * challenges, OAuth grants, API tokens, pending resets) is revoked now; the
	 * data itself is purged when `purge_after` passes. Signing in again during
	 * the grace period is allowed, so the user can cancel.
	 */
	async scheduleAccountDeletion(input: {
		userId: string;
		now: number;
		graceMs: number;
		mailboxes: string[];
	}): Promise<
		| { ok: true; requestedAt: number; purgeAfter: number }
		| { ok: false; reason: "not_found" | "sole_owner" }
	> {
		this.bumpAuthEpoch();
		return this.transaction(() => {
			const user = this.userById(input.userId);
			if (!user) return { ok: false as const, reason: "not_found" as const };
			if (user.isOwner) return { ok: false as const, reason: "sole_owner" as const };
			const existing = this.one(
				`SELECT requested_at, purge_after FROM account_deletions WHERE user_id = ?`,
				input.userId,
			);
			const requestedAt = existing ? num(existing.requested_at) : input.now;
			const purgeAfter = existing ? num(existing.purge_after) : input.now + input.graceMs;
			if (!existing) {
				this.sql.exec(
					`INSERT INTO account_deletions (user_id, email, requested_at, purge_after, mailboxes)
					 VALUES (?, ?, ?, ?, ?)`,
					input.userId,
					user.email,
					requestedAt,
					purgeAfter,
					JSON.stringify(input.mailboxes),
				);
			}
			this.deleteUserSessions(input.userId);
			this.sql.exec(`DELETE FROM password_resets WHERE user_id = ?`, input.userId);
			this.sql.exec(
				`UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
				input.now,
				input.userId,
			);
			return { ok: true as const, requestedAt, purgeAfter };
		});
	}

	async getAccountDeletion(userId: string): Promise<{ requestedAt: number; purgeAfter: number } | null> {
		const row = this.one(`SELECT requested_at, purge_after FROM account_deletions WHERE user_id = ?`, userId);
		return row ? { requestedAt: num(row.requested_at), purgeAfter: num(row.purge_after) } : null;
	}

	/** Cancel a pending deletion. Revoked tokens stay revoked. */
	async cancelAccountDeletion(userId: string): Promise<boolean> {
		return this.all(`DELETE FROM account_deletions WHERE user_id = ? RETURNING user_id`, userId).length > 0;
	}

	/** Deletions whose grace period has passed, oldest first. */
	async listDueAccountDeletions(
		now: number,
		limit = 10,
	): Promise<{ userId: string; email: string; mailboxes: string[]; purgeAfter: number }[]> {
		return this.all(
			`SELECT user_id, email, mailboxes, purge_after FROM account_deletions
			  WHERE purge_after <= ? ORDER BY purge_after ASC LIMIT ?`,
			now,
			Math.max(1, Math.min(limit, 100)),
		).map((row) => {
			let mailboxes: string[] = [];
			try {
				const parsed = JSON.parse(row.mailboxes ?? "[]");
				if (Array.isArray(parsed)) mailboxes = parsed.filter((m) => typeof m === "string");
			} catch {
				// An unreadable list purges no mailbox, which is the safe direction.
			}
			return { userId: String(row.user_id), email: String(row.email), mailboxes, purgeAfter: num(row.purge_after) };
		});
	}

	/**
	 * Remove the account itself once its data has been purged. Re-checks the
	 * grace period and the owner guard, so a cancelled or racing request cannot
	 * delete anyone early.
	 */
	async completeAccountDeletion(userId: string, now: number): Promise<boolean> {
		this.bumpAuthEpoch();
		return this.transaction(() => {
			const due = this.one(`SELECT purge_after FROM account_deletions WHERE user_id = ?`, userId);
			if (!due || num(due.purge_after) > now) return false;
			const user = this.userById(userId);
			if (user?.isOwner) return false;
			if (user) {
				this.deleteUserSessions(userId);
				this.sql.exec(`DELETE FROM recovery_codes WHERE user_id = ?`, userId);
				this.sql.exec(`DELETE FROM password_resets WHERE user_id = ?`, userId);
				this.sql.exec(
					`DELETE FROM api_token_meta WHERE token_id IN (SELECT id FROM api_tokens WHERE user_id = ?)`,
					userId,
				);
				this.sql.exec(`DELETE FROM api_tokens WHERE user_id = ?`, userId);
				this.sql.exec(`DELETE FROM passkeys WHERE user_id = ?`, userId);
				this.deleteUserPush(user.email);
				this.sql.exec(`DELETE FROM users WHERE id = ?`, userId);
			}
			this.sql.exec(`DELETE FROM export_jobs WHERE user_id = ?`, userId);
			this.sql.exec(`DELETE FROM account_deletions WHERE user_id = ?`, userId);
			return true;
		});
	}

	// -- privacy: account exports ----------------------------------------------

	async createExportJob(input: {
		id: string;
		userId: string;
		now: number;
		expiresAt: number;
		state: string;
	}): Promise<ExportJobRecord> {
		this.sql.exec(
			`INSERT INTO export_jobs (id, user_id, status, state, created_at, expires_at)
			 VALUES (?, ?, 'pending', ?, ?, ?)`,
			input.id,
			input.userId,
			input.state,
			input.now,
			input.expiresAt,
		);
		return this.exportJob(input.id)!;
	}

	private exportJob(id: string): ExportJobRecord | null {
		const row = this.one(`SELECT * FROM export_jobs WHERE id = ?`, id);
		return row ? toExportJob(row) : null;
	}

	async getExportJob(id: string): Promise<ExportJobRecord | null> {
		return this.exportJob(id);
	}

	async listExportJobs(userId: string): Promise<ExportJobRecord[]> {
		return this.all(
			`SELECT * FROM export_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`,
			userId,
		).map(toExportJob);
	}

	/** Jobs still being built, for the cron to advance. */
	async listActiveExportJobs(limit = 5): Promise<ExportJobRecord[]> {
		return this.all(
			`SELECT * FROM export_jobs WHERE status IN ('pending', 'running') ORDER BY created_at ASC LIMIT ?`,
			Math.max(1, Math.min(limit, 50)),
		).map(toExportJob);
	}

	async updateExportJob(
		id: string,
		patch: { status?: ExportJobRecord["status"]; state?: string; objectKey?: string; error?: string | null; size?: number; completedAt?: number; expiresAt?: number },
	): Promise<ExportJobRecord | null> {
		const current = this.exportJob(id);
		if (!current) return null;
		this.sql.exec(
			`UPDATE export_jobs SET status = ?, state = ?, object_key = ?, error = ?, size = ?, completed_at = ?, expires_at = ? WHERE id = ?`,
			patch.status ?? current.status,
			patch.state ?? current.state,
			patch.objectKey ?? current.objectKey,
			patch.error === undefined ? current.error : patch.error,
			patch.size ?? current.size,
			patch.completedAt ?? current.completedAt,
			patch.expiresAt ?? current.expiresAt,
			id,
		);
		return this.exportJob(id);
	}

	/** Expired jobs, removed from the table and returned so their R2 objects can go. */
	async takeExpiredExportJobs(now: number, limit = 20): Promise<ExportJobRecord[]> {
		const rows = this.all(
			`SELECT * FROM export_jobs WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT ?`,
			now,
			Math.max(1, Math.min(limit, 100)),
		).map(toExportJob);
		for (const job of rows) this.sql.exec(`DELETE FROM export_jobs WHERE id = ?`, job.id);
		return rows;
	}

	// -- metadata --------------------------------------------------------------

	async getOrInitMeta(key: string, fallback: string): Promise<string> {
		this.sql.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)`, key, fallback);
		return String(this.one(`SELECT value FROM meta WHERE key = ?`, key)!.value);
	}

	// -- suppressions ----------------------------------------------------------

	/**
	 * Page through the suppression list, newest first. `query` is a substring
	 * match on the address (addresses are stored lowercased), with LIKE
	 * wildcards in the input escaped so `_` matches only an underscore.
	 */
	async listSuppressions(options: SuppressionListOptions = {}): Promise<SuppressionPage> {
		const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 500);
		const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
		const where: string[] = [];
		const bindings: unknown[] = [];
		const query = options.query?.trim().toLowerCase();
		if (query) {
			where.push(`address LIKE ? ESCAPE '!'`);
			bindings.push(`%${query.replace(/[!%_]/g, (ch) => `!${ch}`)}%`);
		}
		if (options.scope) {
			where.push(`scope = ?`);
			bindings.push(options.scope);
		}
		if (options.reason) {
			where.push(`reason = ?`);
			bindings.push(options.reason);
		}
		const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
		const total = Number(
			this.one(`SELECT COUNT(*) AS n FROM suppressions ${clause}`, ...bindings)?.n ?? 0,
		);
		const items = this.all(
			`SELECT ${SUPPRESSION_COLUMNS} FROM suppressions ${clause}
			  ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
			...bindings,
			limit,
			offset,
		).map(suppressionFromRow);
		return { items, total, limit, offset };
	}

	/**
	 * Add entries, skipping any (address, scope) already present. Atomic, so a
	 * bulk import lands whole or not at all. Inputs are expected to be
	 * normalised by the caller (`shared/suppressions.ts`).
	 */
	async addSuppressions(
		entries: SuppressionEntryInput[],
		now: number,
	): Promise<{ added: number; existing: number; items: SuppressionRecord[] }> {
		return this.transaction(() => {
			let added = 0;
			const items: SuppressionRecord[] = [];
			for (const entry of entries) {
				const id = randomId("sup");
				this.sql.exec(
					`INSERT OR IGNORE INTO suppressions (id, address, scope, reason, source, created_at)
					 VALUES (?, ?, ?, ?, ?, ?)`,
					id,
					entry.address,
					entry.scope,
					entry.reason,
					entry.source,
					now,
				);
				const row = this.one(
					`SELECT ${SUPPRESSION_COLUMNS} FROM suppressions WHERE address = ? AND scope = ?`,
					entry.address,
					entry.scope,
				);
				if (!row) continue;
				if (String(row.id) === id) added += 1;
				items.push(suppressionFromRow(row));
			}
			return { added, existing: entries.length - added, items };
		});
	}

	/**
	 * Raise an existing (address, scope) entry to `reason` when its current
	 * reason is weaker: a complaint or hard bounce arriving for someone who had
	 * only unsubscribed must start blocking transactional mail too. Returns
	 * whether a row changed. No-op when there is no entry.
	 */
	async escalateSuppression(entry: SuppressionEntryInput): Promise<boolean> {
		const strength: Record<string, number> = { manual: 0, unsubscribed: 0, hard_bounce: 1, complaint: 2 };
		const row = this.one(
			`SELECT id, reason FROM suppressions WHERE address = ? AND scope = ?`,
			entry.address,
			entry.scope,
		);
		if (!row) return false;
		if ((strength[String(row.reason)] ?? 0) >= (strength[entry.reason] ?? 0)) return false;
		this.sql.exec(`UPDATE suppressions SET reason = ?, source = ? WHERE id = ?`, entry.reason, entry.source, row.id);
		return true;
	}

	async deleteSuppression(id: string): Promise<boolean> {
		if (!this.one(`SELECT id FROM suppressions WHERE id = ?`, id)) return false;
		this.sql.exec(`DELETE FROM suppressions WHERE id = ?`, id);
		return true;
	}

	/**
	 * Entries that block any of `addresses` when sending from `domain`: global
	 * ones plus those scoped to that domain. With no domain, every entry for the
	 * addresses is returned (the composer's "suppressed anywhere?" check).
	 */
	async findSuppressions(addresses: string[], domain?: string | null): Promise<SuppressionRecord[]> {
		const unique = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))];
		const out: SuppressionRecord[] = [];
		// Chunked to stay well under SQLite's bound-parameter limit.
		for (let i = 0; i < unique.length; i += 90) {
			const chunk = unique.slice(i, i + 90);
			const placeholders = chunk.map(() => "?").join(", ");
			const rows = domain
				? this.all(
						`SELECT ${SUPPRESSION_COLUMNS} FROM suppressions
						  WHERE address IN (${placeholders}) AND (scope = 'global' OR scope = ?)`,
						...chunk,
						domain.toLowerCase(),
					)
				: this.all(
						`SELECT ${SUPPRESSION_COLUMNS} FROM suppressions WHERE address IN (${placeholders})`,
						...chunk,
					);
			out.push(...rows.map(suppressionFromRow));
		}
		return out;
	}
}

const SUPPRESSION_COLUMNS = `id, address, scope, reason, source, created_at`;

function suppressionFromRow(row: any): SuppressionRecord {
	return {
		id: String(row.id),
		address: String(row.address),
		scope: String(row.scope),
		reason: String(row.reason),
		source: String(row.source),
		created_at: Number(row.created_at),
	};
}

function toExportJob(row: any): ExportJobRecord {
	const status = String(row.status);
	return {
		id: String(row.id),
		userId: String(row.user_id),
		status: (["pending", "running", "ready", "failed"].includes(status) ? status : "failed") as ExportJobRecord["status"],
		objectKey: row.object_key ?? null,
		size: numOrNull(row.size),
		error: row.error ?? null,
		state: row.state ?? null,
		createdAt: num(row.created_at),
		completedAt: numOrNull(row.completed_at),
		expiresAt: num(row.expires_at),
	};
}
