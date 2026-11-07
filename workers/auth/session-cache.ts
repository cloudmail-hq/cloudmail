// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-isolate cache of validated credentials (session cookies, `ttk_` API
 * tokens, MCP OAuth access tokens), so a warm API request does not pay an
 * AuthDO round trip just to learn who is calling.
 *
 * ## Soundness: the auth epoch
 *
 * The AuthDO keeps one global counter, the **auth epoch** (in memory, persisted
 * in `meta`). Every store method that ends a credential or changes what a
 * cached identity says (`AUTH_EPOCH_METHODS`) increments it, synchronously and
 * before its own write, inside the same Durable Object call. Every successful
 * validation returns the epoch it ran under, read atomically with the rows it
 * checked.
 *
 * A cached entry records that epoch and is served only while it equals the
 * isolate's current view of the epoch. That view is refreshed:
 *
 * - by every validation that misses the cache (no extra round trip);
 * - in the background (`waitUntil`) once it is older than `epochSoftMs` (1 s);
 * - and it is not trusted at all once older than `epochHardMs` (5 s): the
 *   request skips the cache and validates against the AuthDO.
 *
 * Worst case, a credential revoked through another isolate keeps working here
 * for under `epochHardMs` (5 s) after the revoking call returns: the view's age
 * counts from when the read that produced it was *sent*, which is before the
 * AuthDO answered, so any revocation it missed happened after that moment.
 * Both ends of that age are this isolate's clock; no cross-isolate clock is
 * involved. Whatever the epoch reads do, no entry outlives `ttlMs` (30 s).
 * Through this isolate the credential stops at once: `withAuthCacheInvalidation`
 * clears the cache and forgets the epoch as soon as the write is issued.
 *
 * Not cached here: roles and mailbox grants. Those live in R2 and
 * `resolvePrincipal` reads them on every request, so a role change applies to
 * the next request regardless of this cache.
 *
 * Keys are hashes of the credential (the session token's sha256, the token id
 * plus its secret's sha256, the OAuth bearer's sha256), never the credential.
 * Failed validations are never cached.
 *
 * No `cloudflare:workers` import, so it is unit-testable.
 */

/** Store methods that end a credential or change what a cached identity says. */
export const AUTH_EPOCH_METHODS = [
	"deleteSession",
	"revokeSession",
	"revokeOtherSessions",
	"updatePassword",
	"updateProfile",
	"setDisabled",
	"deleteUser",
	"recoverOwner",
	"consumePasswordReset",
	"enableTotp",
	"disableTotp",
	"revokeApiToken",
	"createOAuthGrant",
	"revokeOAuthGrant",
	"scheduleAccountDeletion",
	"completeAccountDeletion",
	// A cached OAuth identity carries the grant, including "send without approval".
	"setOAuthGrantSendAuto",
] as const;

export type AuthEpochMethod = (typeof AUTH_EPOCH_METHODS)[number];

export const AUTH_CACHE_TTL_MS = 30_000;
export const AUTH_CACHE_MAX_ENTRIES = 1_000;
export const AUTH_EPOCH_SOFT_MS = 1_000;
export const AUTH_EPOCH_HARD_MS = 5_000;

export interface AuthCacheOptions {
	ttlMs?: number;
	maxEntries?: number;
	epochSoftMs?: number;
	epochHardMs?: number;
	now?: () => number;
}

interface Entry {
	value: unknown;
	epoch: number;
	at: number;
	/** The credential's own deadline (ms since epoch), or null for none. */
	expiresAt: number | null;
}

/** The isolate's view of the epoch, as `epochView` reports it. */
export interface EpochView {
	epoch: number;
	/** Older than `epochSoftMs`: usable, but refresh it in the background. */
	stale: boolean;
}

export class AuthCache {
	readonly ttlMs: number;
	readonly maxEntries: number;
	readonly epochSoftMs: number;
	readonly epochHardMs: number;
	private readonly now: () => number;

	/** Map insertion order is recency order: a hit is moved to the end. */
	private readonly entries = new Map<string, Entry>();
	private epoch: number | null = null;
	/** When the read that produced `epoch` was *sent*: the oldest moment it can describe. */
	private epochAt = 0;
	/**
	 * Bumped by `invalidateLocal`. Work that started before an invalidation may
	 * carry a pre-revocation answer, so it may neither set the epoch nor cache.
	 */
	private gen = 0;
	private refreshing: Promise<void> | null = null;

	constructor(options: AuthCacheOptions = {}) {
		this.ttlMs = options.ttlMs ?? AUTH_CACHE_TTL_MS;
		this.maxEntries = options.maxEntries ?? AUTH_CACHE_MAX_ENTRIES;
		this.epochSoftMs = options.epochSoftMs ?? AUTH_EPOCH_SOFT_MS;
		this.epochHardMs = options.epochHardMs ?? AUTH_EPOCH_HARD_MS;
		this.now = options.now ?? Date.now;
	}

	get size(): number {
		return this.entries.size;
	}

	/** Capture before starting a validation; hand back to `noteEpoch` / `set`. */
	get generation(): number {
		return this.gen;
	}

	/** Clock reading for `noteEpoch`'s `sentAt`. */
	clock(): number {
		return this.now();
	}

	/** The epoch to look entries up under, or null when the view is too old to trust. */
	epochView(): EpochView | null {
		if (this.epoch === null) return null;
		const age = this.now() - this.epochAt;
		if (age >= this.epochHardMs) return null;
		return { epoch: this.epoch, stale: age >= this.epochSoftMs };
	}

	/**
	 * Record an epoch read from the AuthDO by a call sent at `sentAt`. The epoch
	 * only grows, so an older answer arriving late never moves the view back.
	 */
	noteEpoch(epoch: number, sentAt: number, generation: number): void {
		if (generation !== this.gen || !Number.isFinite(epoch)) return;
		if (this.epoch === null || epoch > this.epoch) {
			this.epoch = epoch;
			this.epochAt = sentAt;
		} else if (epoch === this.epoch && sentAt > this.epochAt) {
			this.epochAt = sentAt;
		}
	}

	/** Re-read the epoch, at most one read in flight. Never throws. */
	refreshEpoch(fetchEpoch: () => Promise<number>): Promise<void> {
		if (this.refreshing) return this.refreshing;
		const generation = this.gen;
		const sentAt = this.now();
		const work = (async () => {
			try {
				this.noteEpoch(await fetchEpoch(), sentAt, generation);
			} catch (e) {
				// The view simply ages out; past `epochHardMs` requests stop using it.
				console.error("[auth] epoch refresh failed:", (e as Error).message);
			} finally {
				this.refreshing = null;
			}
		})();
		this.refreshing = work;
		return work;
	}

	/** A value cached under `epoch`, still inside its TTL and its credential's deadline. */
	get<T>(key: string, epoch: number): T | null {
		const entry = this.entries.get(key);
		if (!entry) return null;
		const now = this.now();
		this.entries.delete(key);
		if (
			entry.epoch !== epoch ||
			now - entry.at >= this.ttlMs ||
			(entry.expiresAt !== null && now >= entry.expiresAt)
		) {
			return null;
		}
		this.entries.set(key, entry);
		return entry.value as T;
	}

	/**
	 * Cache a successful validation that ran under `epoch`. `sentAt` is when the
	 * validation was sent, so the TTL counts from before the AuthDO answered.
	 */
	set(
		key: string,
		value: unknown,
		epoch: number,
		generation: number,
		sentAt: number,
		expiresAt: number | null = null,
	): void {
		if (generation !== this.gen || !Number.isFinite(epoch)) return;
		this.entries.delete(key);
		this.entries.set(key, { value, epoch, at: sentAt, expiresAt });
		while (this.entries.size > this.maxEntries) {
			this.entries.delete(this.entries.keys().next().value as string);
		}
	}

	/**
	 * A credential or account changed through this isolate: drop every entry
	 * and forget the epoch, so nothing is served until a validation has seen the
	 * new one.
	 */
	invalidateLocal(): void {
		this.entries.clear();
		this.epoch = null;
		this.epochAt = 0;
		this.gen++;
	}
}

const EPOCH_METHOD_SET: ReadonlySet<string> = new Set(AUTH_EPOCH_METHODS);

/**
 * Wrap a store accessor so every `AUTH_EPOCH_METHODS` call made through it
 * invalidates `cache` in this isolate. The AuthDO bumps the epoch itself; this
 * only closes the epoch-refresh window for the isolate that made the change.
 *
 * Invalidates before the call (so a request racing it cannot be served from
 * an entry about to be revoked) and again after it (so a validation that read
 * the old state while the write was in flight cannot repopulate it).
 */
export function withAuthCacheInvalidation<E, S extends object>(
	getStore: (env: E) => S,
	cache: AuthCache,
): (env: E) => S {
	return (env) => {
		const store = getStore(env);
		return new Proxy(store, {
			get(target, prop) {
				if (typeof prop !== "string" || !EPOCH_METHOD_SET.has(prop)) {
					// Plain passthrough, read off the target itself: a Durable Object stub
					// answers any property name, so nothing here may assume more.
					const value = Reflect.get(target, prop);
					return typeof value === "function" && prop !== "then"
						? (...args: unknown[]) => (target as Record<string, (...a: unknown[]) => unknown>)[prop as string](...args)
						: value;
				}
				return async (...args: unknown[]) => {
					cache.invalidateLocal();
					try {
						return await (target as Record<string, (...a: unknown[]) => unknown>)[prop](...args);
					} finally {
						cache.invalidateLocal();
					}
				};
			},
		});
	};
}
