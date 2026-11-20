// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Web Push storage in the AuthDO (migration `0018_web_push`): subscriptions
 * per user and device, each user's notification preferences, the throttle
 * counters, and spent action tokens.
 *
 * Pure SQL over the AuthDO's database, kept out of `store-core.ts` like
 * `SendingHealthStore`, so it runs on `node:sqlite` in tests. Every method is
 * synchronous inside, so a check-then-write (throttle, single-use tokens) is
 * one transaction no other request can interleave with.
 *
 * Users are keyed by their authz identity id (the lowercase email for a
 * person, the Client ID for a service token), which is what grants are keyed
 * by too. The endpoint is the device: a browser profile has exactly one per
 * application server key.
 */

import {
	decideThrottle,
	mergePushPrefs,
	normalizePushPrefs,
	type PushPrefs,
	type PushPrefsPatch,
	type ThrottleDecision,
} from "../../shared/push-policy";

export interface PushSql {
	exec(query: string, ...bindings: unknown[]): { toArray(): any[] };
}
export type PushTransaction = <T>(fn: () => T) => T;

export const PUSH_MIGRATION_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS push_subscriptions (
		id TEXT PRIMARY KEY,
		user_key TEXT NOT NULL,
		endpoint TEXT NOT NULL UNIQUE,
		p256dh TEXT NOT NULL,
		auth TEXT NOT NULL,
		user_agent TEXT,
		created_at INTEGER NOT NULL,
		last_success_at INTEGER,
		failures INTEGER NOT NULL DEFAULT 0,
		last_failure_at INTEGER,
		last_error TEXT
	)`,
	`CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_key)`,
	`CREATE TABLE IF NOT EXISTS push_prefs (
		user_key TEXT PRIMARY KEY,
		prefs TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	)`,
	// One row per user ("u:<user>") for the rate-limit window and one per
	// user and thread ("t:<user>:<thread>") for coalescing.
	`CREATE TABLE IF NOT EXISTS push_throttle (
		key TEXT PRIMARY KEY,
		at INTEGER NOT NULL,
		count INTEGER NOT NULL DEFAULT 0
	)`,
	`CREATE TABLE IF NOT EXISTS push_spent_tokens (
		jti TEXT PRIMARY KEY,
		expires_at INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_push_spent_tokens_exp ON push_spent_tokens(expires_at)`,
];

/** Most devices one user may register; the oldest is dropped past it. */
export const MAX_DEVICES_PER_USER = 20;

export interface PushSubscriptionRecord {
	id: string;
	userKey: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	userAgent: string | null;
	createdAt: number;
	lastSuccessAt: number | null;
	failures: number;
	lastFailureAt: number | null;
	lastError: string | null;
}

/** A user with at least one device, as the dispatcher needs them. */
export interface PushTarget {
	userKey: string;
	/** Password-mode account flags; null when the user has no account row (Access mode). */
	isOwner: boolean;
	disabled: boolean;
	prefs: PushPrefs;
	subscriptions: PushSubscriptionRecord[];
}

function toSubscription(row: any): PushSubscriptionRecord {
	const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
	return {
		id: String(row.id),
		userKey: String(row.user_key),
		endpoint: String(row.endpoint),
		p256dh: String(row.p256dh),
		auth: String(row.auth),
		userAgent: row.user_agent ?? null,
		createdAt: Number(row.created_at),
		lastSuccessAt: n(row.last_success_at),
		failures: Number(row.failures ?? 0),
		lastFailureAt: n(row.last_failure_at),
		lastError: row.last_error ?? null,
	};
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export class PushStore {
	constructor(
		private readonly sql: PushSql,
		private readonly transaction: PushTransaction,
	) {}

	private all(query: string, ...bindings: unknown[]): any[] {
		return this.sql.exec(query, ...bindings).toArray();
	}

	private one(query: string, ...bindings: unknown[]): any | null {
		return this.all(query, ...bindings)[0] ?? null;
	}

	// -- subscriptions ---------------------------------------------------------

	/**
	 * Register (or refresh) a device. An endpoint already registered to another
	 * user moves to this one: the browser that holds it is the one signed in now,
	 * so the previous user must stop receiving on it.
	 */
	upsertSubscription(input: {
		userKey: string;
		endpoint: string;
		p256dh: string;
		auth: string;
		userAgent: string | null;
		now: number;
	}): PushSubscriptionRecord {
		const userKey = input.userKey.toLowerCase();
		return this.transaction(() => {
			const existing = this.one(`SELECT id FROM push_subscriptions WHERE endpoint = ?`, input.endpoint);
			if (existing) {
				this.sql.exec(
					`UPDATE push_subscriptions SET user_key = ?, p256dh = ?, auth = ?, user_agent = ?, failures = 0, last_error = NULL WHERE id = ?`,
					userKey,
					input.p256dh,
					input.auth,
					input.userAgent,
					existing.id,
				);
			} else {
				this.sql.exec(
					`INSERT INTO push_subscriptions (id, user_key, endpoint, p256dh, auth, user_agent, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					crypto.randomUUID(),
					userKey,
					input.endpoint,
					input.p256dh,
					input.auth,
					input.userAgent,
					input.now,
				);
				// Bounded per user: the oldest device goes first.
				const extra = this.all(
					`SELECT id FROM push_subscriptions WHERE user_key = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?`,
					userKey,
					MAX_DEVICES_PER_USER,
				);
				for (const row of extra) this.sql.exec(`DELETE FROM push_subscriptions WHERE id = ?`, row.id);
			}
			return toSubscription(this.one(`SELECT * FROM push_subscriptions WHERE endpoint = ?`, input.endpoint));
		});
	}

	listSubscriptions(userKey: string): PushSubscriptionRecord[] {
		return this.all(
			`SELECT * FROM push_subscriptions WHERE user_key = ? ORDER BY created_at DESC`,
			userKey.toLowerCase(),
		).map(toSubscription);
	}

	getSubscription(id: string): PushSubscriptionRecord | null {
		const row = this.one(`SELECT * FROM push_subscriptions WHERE id = ?`, id);
		return row ? toSubscription(row) : null;
	}

	/** Remove one of the user's own devices, by id or endpoint. */
	deleteSubscription(userKey: string, ref: { id?: string; endpoint?: string }): boolean {
		const key = userKey.toLowerCase();
		const row = ref.id
			? this.one(`SELECT id FROM push_subscriptions WHERE id = ? AND user_key = ?`, ref.id, key)
			: ref.endpoint
				? this.one(`SELECT id FROM push_subscriptions WHERE endpoint = ? AND user_key = ?`, ref.endpoint, key)
				: null;
		if (!row) return false;
		this.sql.exec(`DELETE FROM push_subscriptions WHERE id = ?`, row.id);
		return true;
	}

	/** Every device and preference of a user: account deletion. */
	deleteUserPushData(userKey: string): void {
		const key = userKey.toLowerCase();
		this.sql.exec(`DELETE FROM push_subscriptions WHERE user_key = ?`, key);
		this.sql.exec(`DELETE FROM push_prefs WHERE user_key = ?`, key);
	}

	/**
	 * `pushsubscriptionchange` from a service worker that has no session: the
	 * old endpoint and its auth secret (known only to that browser and to us)
	 * prove it is the same device. The new subscription keeps the owner.
	 */
	replaceSubscription(input: {
		oldEndpoint: string;
		oldAuth: string;
		endpoint: string;
		p256dh: string;
		auth: string;
		userAgent: string | null;
		now: number;
	}): PushSubscriptionRecord | null {
		const old = this.one(`SELECT * FROM push_subscriptions WHERE endpoint = ?`, input.oldEndpoint);
		if (!old || !timingSafeEqual(String(old.auth), input.oldAuth)) return null;
		return this.transaction(() => {
			this.sql.exec(`DELETE FROM push_subscriptions WHERE id = ?`, old.id);
			return this.upsertSubscription({
				userKey: String(old.user_key),
				endpoint: input.endpoint,
				p256dh: input.p256dh,
				auth: input.auth,
				userAgent: input.userAgent ?? old.user_agent ?? null,
				now: input.now,
			});
		});
	}

	/**
	 * The push service's answer for one delivery. 404 and 410 mean the
	 * subscription is gone for good (RFC 8030 section 7.3), so the row is
	 * deleted; anything else counts a failure.
	 */
	recordDelivery(
		id: string,
		outcome: { ok: true } | { ok: false; status: number; error: string },
		now: number,
	): "ok" | "removed" | "failed" {
		if (outcome.ok) {
			this.sql.exec(
				`UPDATE push_subscriptions SET last_success_at = ?, failures = 0, last_error = NULL WHERE id = ?`,
				now,
				id,
			);
			return "ok";
		}
		if (outcome.status === 404 || outcome.status === 410) {
			this.sql.exec(`DELETE FROM push_subscriptions WHERE id = ?`, id);
			return "removed";
		}
		this.sql.exec(
			`UPDATE push_subscriptions SET failures = failures + 1, last_failure_at = ?, last_error = ? WHERE id = ?`,
			now,
			outcome.error.slice(0, 200),
			id,
		);
		return "failed";
	}

	/**
	 * Users with at least one device, with their preferences and, where the
	 * deployment has accounts, whether each is the owner or disabled. One call
	 * per delivery, so the dispatcher never asks per user.
	 */
	listTargets(): PushTarget[] {
		const subs = this.all(`SELECT * FROM push_subscriptions ORDER BY user_key, created_at`).map(toSubscription);
		if (subs.length === 0) return [];
		const byUser = new Map<string, PushSubscriptionRecord[]>();
		for (const s of subs) {
			const list = byUser.get(s.userKey) ?? [];
			list.push(s);
			byUser.set(s.userKey, list);
		}
		const out: PushTarget[] = [];
		for (const [userKey, subscriptions] of byUser) {
			const account = this.accountFlags(userKey);
			out.push({
				userKey,
				isOwner: account.isOwner,
				disabled: account.disabled,
				prefs: this.getPrefs(userKey),
				subscriptions,
			});
		}
		return out;
	}

	/** `users` exists in every AuthDO (0001); Access deployments simply have no row. */
	accountFlags(userKey: string): { isOwner: boolean; disabled: boolean } {
		try {
			const row = this.one(`SELECT is_owner, disabled FROM users WHERE email = ?`, userKey);
			return { isOwner: Number(row?.is_owner) === 1, disabled: Number(row?.disabled) === 1 };
		} catch {
			return { isOwner: false, disabled: false };
		}
	}

	// -- preferences -----------------------------------------------------------

	getPrefs(userKey: string): PushPrefs {
		const row = this.one(`SELECT prefs FROM push_prefs WHERE user_key = ?`, userKey.toLowerCase());
		if (!row) return normalizePushPrefs(null);
		try {
			return normalizePushPrefs(JSON.parse(String(row.prefs)));
		} catch {
			return normalizePushPrefs(null);
		}
	}

	updatePrefs(userKey: string, patch: PushPrefsPatch, now: number): PushPrefs {
		const key = userKey.toLowerCase();
		return this.transaction(() => {
			const next = mergePushPrefs(this.getPrefs(key), patch);
			this.sql.exec(
				`INSERT INTO push_prefs (user_key, prefs, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT(user_key) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at`,
				key,
				JSON.stringify(next),
				now,
			);
			return next;
		});
	}

	// -- throttling ------------------------------------------------------------

	/**
	 * Claim a send slot for a user: at most one push per thread per minute
	 * (`threadKey` null skips that) and a per-user cap per window. Claimed
	 * before the send, so a burst of deliveries racing each other cannot all
	 * pass.
	 */
	claimSlot(userKey: string, threadKey: string | null, now: number): ThrottleDecision {
		const key = userKey.toLowerCase();
		const userRow = `u:${key}`;
		const threadRow = threadKey ? `t:${key}:${threadKey}` : null;
		return this.transaction(() => {
			const u = this.one(`SELECT at, count FROM push_throttle WHERE key = ?`, userRow);
			const t = threadRow ? this.one(`SELECT at FROM push_throttle WHERE key = ?`, threadRow) : null;
			const decision = decideThrottle(
				{
					threadLastAt: t ? Number(t.at) : null,
					windowStart: u ? Number(u.at) : null,
					windowCount: u ? Number(u.count) : 0,
				},
				now,
				{ coalesce: threadRow !== null },
			);
			if (!decision.allow) return decision;
			this.sql.exec(
				`INSERT INTO push_throttle (key, at, count) VALUES (?, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET at = excluded.at, count = excluded.count`,
				userRow,
				decision.windowStart,
				decision.windowCount,
			);
			if (threadRow) {
				this.sql.exec(
					`INSERT INTO push_throttle (key, at, count) VALUES (?, ?, 1)
					 ON CONFLICT(key) DO UPDATE SET at = excluded.at`,
					threadRow,
					now,
				);
			}
			// Coalescing rows are only meaningful for a minute; keep the table small.
			this.sql.exec(`DELETE FROM push_throttle WHERE key LIKE 't:%' AND at < ?`, now - 60 * 60_000);
			return decision;
		});
	}

	// -- action tokens ---------------------------------------------------------

	/**
	 * Spend an action token's id. True exactly once per `jti`; the row lives
	 * until the token would have expired anyway, then is swept.
	 */
	spendToken(jti: string, expiresAt: number, now: number): boolean {
		return this.transaction(() => {
			this.sql.exec(`DELETE FROM push_spent_tokens WHERE expires_at < ?`, now);
			if (this.one(`SELECT 1 AS x FROM push_spent_tokens WHERE jti = ?`, jti)) return false;
			this.sql.exec(`INSERT INTO push_spent_tokens (jti, expires_at) VALUES (?, ?)`, jti, expiresAt);
			return true;
		});
	}
}
