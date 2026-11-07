// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The per-isolate credential cache (`workers/auth/session-cache.ts`).
 *
 * Unit tests pin the cache's own rules (TTL, LRU bound, epoch ageing). The
 * integration tests run the real `createAuthenticate` over the real
 * `AuthStore` (node:sqlite) with *two* caches, each wrapped as its isolate
 * would wrap it, to show the revocation bound across isolates: a change made
 * through isolate A is refused in A at once and in B within `epochHardMs`.
 */

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { createAuthenticate, type AuthDeps } from "../workers/auth/middleware";
import {
	AUTH_CACHE_MAX_ENTRIES,
	AUTH_CACHE_TTL_MS,
	AUTH_EPOCH_HARD_MS,
	AUTH_EPOCH_METHODS,
	AUTH_EPOCH_SOFT_MS,
	AuthCache,
	withAuthCacheInvalidation,
} from "../workers/auth/session-cache";
import { AuthStore, type AuthSql } from "../workers/auth/store-core";
import { sha256Hex } from "../workers/auth/crypto";
import type { AuthStoreApi, AuthUser } from "../workers/auth/types";
import type { MailboxContext } from "../workers/lib/mailbox";
import { serverTiming, timedMiddleware } from "../workers/lib/server-timing";
import type { Env } from "../workers/types";

// -- AuthCache, unit -----------------------------------------------------------

describe("AuthCache", () => {
	let clock: { now: number };
	let cache: AuthCache;
	beforeEach(() => {
		clock = { now: 1_000_000 };
		cache = new AuthCache({ now: () => clock.now });
	});

	/** What a successful validation does: learn the epoch, then cache under it. */
	function validated(key: string, value: unknown, epoch: number, expiresAt: number | null = null) {
		const generation = cache.generation;
		const sentAt = cache.clock();
		cache.noteEpoch(epoch, sentAt, generation);
		cache.set(key, value, epoch, generation, sentAt, expiresAt);
	}

	it("uses the documented defaults", () => {
		expect(AUTH_CACHE_TTL_MS).toBe(30_000);
		expect(AUTH_CACHE_MAX_ENTRIES).toBe(1_000);
		expect(AUTH_EPOCH_SOFT_MS).toBe(1_000);
		expect(AUTH_EPOCH_HARD_MS).toBe(5_000);
	});

	it("misses before anything is cached, then hits", () => {
		expect(cache.epochView()).toBeNull();
		validated("s:a", { id: 1 }, 7);
		expect(cache.epochView()).toEqual({ epoch: 7, stale: false });
		expect(cache.get("s:a", 7)).toEqual({ id: 1 });
		expect(cache.get("s:b", 7)).toBeNull();
	});

	it("never serves an entry validated under another epoch", () => {
		validated("s:a", { id: 1 }, 7);
		expect(cache.get("s:a", 8)).toBeNull();
		// And the mismatch evicts it.
		expect(cache.get("s:a", 7)).toBeNull();
	});

	it("expires entries at the TTL, counted from when the validation was sent", () => {
		validated("s:a", 1, 1);
		clock.now += AUTH_CACHE_TTL_MS - 1;
		expect(cache.get("s:a", 1)).toBe(1);
		clock.now += 1;
		expect(cache.get("s:a", 1)).toBeNull();
	});

	it("never outlives the credential's own deadline", () => {
		validated("t:a", 1, 1, clock.now + 2_000);
		clock.now += 1_999;
		expect(cache.get("t:a", 1)).toBe(1);
		clock.now += 1;
		expect(cache.get("t:a", 1)).toBeNull();
	});

	it("stays within its LRU bound and evicts the least recently used", () => {
		const small = new AuthCache({ now: () => clock.now, maxEntries: 3 });
		const put = (k: string) => small.set(k, k, 1, small.generation, clock.now);
		put("a");
		put("b");
		put("c");
		expect(small.get("a", 1)).toBe("a"); // a is now the most recent
		put("d");
		expect(small.size).toBe(3);
		expect(small.get("b", 1)).toBeNull();
		expect(small.get("a", 1)).toBe("a");
		expect(small.get("c", 1)).toBe("c");
		expect(small.get("d", 1)).toBe("d");
	});

	it("holds at most 1,000 entries by default", () => {
		for (let i = 0; i < AUTH_CACHE_MAX_ENTRIES + 250; i++) cache.set(`s:${i}`, i, 1, cache.generation, clock.now);
		expect(cache.size).toBe(AUTH_CACHE_MAX_ENTRIES);
		expect(cache.get("s:0", 1)).toBeNull();
		expect(cache.get(`s:${AUTH_CACHE_MAX_ENTRIES + 249}`, 1)).toBe(AUTH_CACHE_MAX_ENTRIES + 249);
	});

	it("marks the epoch stale after the soft age and refuses it after the hard age", () => {
		validated("s:a", 1, 3);
		clock.now += AUTH_EPOCH_SOFT_MS;
		expect(cache.epochView()).toEqual({ epoch: 3, stale: true });
		clock.now += AUTH_EPOCH_HARD_MS - AUTH_EPOCH_SOFT_MS - 1;
		expect(cache.epochView()).toEqual({ epoch: 3, stale: true });
		clock.now += 1;
		expect(cache.epochView()).toBeNull();
	});

	it("refreshEpoch renews the view, one read at a time, and never moves it backwards", async () => {
		validated("s:a", 1, 5);
		clock.now += AUTH_EPOCH_SOFT_MS;
		let reads = 0;
		const fetch = async () => {
			reads++;
			return 5;
		};
		await Promise.all([cache.refreshEpoch(fetch), cache.refreshEpoch(fetch)]);
		expect(reads).toBe(1);
		expect(cache.epochView()).toEqual({ epoch: 5, stale: false });

		cache.noteEpoch(4, clock.now, cache.generation);
		expect(cache.epochView()?.epoch).toBe(5);
	});

	it("survives a failed epoch read by letting the view age out", async () => {
		validated("s:a", 1, 5);
		clock.now += AUTH_EPOCH_SOFT_MS;
		await cache.refreshEpoch(async () => {
			throw new Error("down");
		});
		expect(cache.epochView()).toEqual({ epoch: 5, stale: true });
		clock.now += AUTH_EPOCH_HARD_MS;
		expect(cache.epochView()).toBeNull();
	});

	it("invalidateLocal drops entries and the epoch, and rejects work begun before it", async () => {
		const generation = cache.generation;
		const sentAt = cache.clock();
		validated("s:a", 1, 1);
		cache.invalidateLocal();
		expect(cache.size).toBe(0);
		expect(cache.epochView()).toBeNull();
		// A validation that was in flight across the invalidation cannot repopulate.
		cache.noteEpoch(1, sentAt, generation);
		cache.set("s:b", 2, 1, generation, sentAt);
		expect(cache.epochView()).toBeNull();
		expect(cache.size).toBe(0);
		// Nor can an epoch read that started before it.
		validated("s:c", 3, 1);
		clock.now += AUTH_EPOCH_SOFT_MS;
		let release!: (n: number) => void;
		const pending = cache.refreshEpoch(() => new Promise<number>((r) => (release = r)));
		cache.invalidateLocal();
		release(1);
		await pending;
		expect(cache.epochView()).toBeNull();
	});
});

describe("withAuthCacheInvalidation", () => {
	it("invalidates on every epoch method, before and after the call, even when it throws", async () => {
		const cache = new AuthCache();
		const seen: number[] = [];
		const store = Object.fromEntries(
			AUTH_EPOCH_METHODS.map((m) => [
				m,
				async () => {
					seen.push(cache.size);
					throw new Error("boom");
				},
			]),
		) as Record<string, () => Promise<unknown>>;
		const wrapped = withAuthCacheInvalidation(() => store, cache)({});
		for (const method of AUTH_EPOCH_METHODS) {
			cache.set("s:x", 1, 1, cache.generation, Date.now());
			await expect(wrapped[method]()).rejects.toThrow("boom");
			expect(cache.size, method).toBe(0);
		}
		// Cleared before the call ran, too.
		expect(seen.every((n) => n === 0)).toBe(true);
	});

	it("leaves other methods alone", async () => {
		const cache = new AuthCache();
		const store = { validateSession: async (h: string) => `ok:${h}`, getAuthEpoch: async () => 3 };
		const wrapped = withAuthCacheInvalidation(() => store, cache)({});
		cache.set("s:x", 1, 1, cache.generation, Date.now());
		expect(await wrapped.validateSession("abc")).toBe("ok:abc");
		expect(await wrapped.getAuthEpoch()).toBe(3);
		expect(cache.size).toBe(1);
	});
});

// -- AuthStore epoch -----------------------------------------------------------

function sqliteDb(): { sql: AuthSql; tx: <T>(fn: () => T) => T } {
	const db = new DatabaseSync(":memory:");
	const sql: AuthSql = {
		exec(query: string, ...bindings: unknown[]) {
			const rows = db.prepare(query).all(...(bindings as never[])) as unknown[];
			return { toArray: () => rows };
		},
	};
	const tx = <T>(fn: () => T): T => {
		db.exec("SAVEPOINT tx");
		try {
			const out = fn();
			db.exec("RELEASE tx");
			return out;
		} catch (e) {
			db.exec("ROLLBACK TO tx");
			db.exec("RELEASE tx");
			throw e;
		}
	};
	return { sql, tx };
}

describe("AuthStore auth epoch", () => {
	it("advances on every credential-ending or user-changing method and survives a restart", async () => {
		const { sql, tx } = sqliteDb();
		const store = new AuthStore(sql, tx);
		const now = Date.now();
		const owner = await store.createOwner({ email: "o@example.com", name: "O", passwordHash: "h", now });
		if (!owner.ok) throw new Error("setup");
		const uid = owner.user.id;
		const start = await store.getAuthEpoch();

		const calls: Record<(typeof AUTH_EPOCH_METHODS)[number], () => Promise<unknown>> = {
			deleteSession: () => store.deleteSession("x"),
			revokeSession: () => store.revokeSession(uid, "ses_x"),
			revokeOtherSessions: () => store.revokeOtherSessions(uid, null),
			updatePassword: () => store.updatePassword(uid, "h2", now),
			updateProfile: () => store.updateProfile(uid, { name: "P" }),
			setDisabled: () => store.setDisabled(uid, false),
			deleteUser: () => store.deleteUser("usr_missing"),
			recoverOwner: () => store.recoverOwner({ passwordHash: "h3", now }),
			consumePasswordReset: () => store.consumePasswordReset({ tokenHash: "x", passwordHash: "h", now }),
			enableTotp: () => store.enableTotp(uid, 1, []).catch(() => {}),
			disableTotp: () => store.disableTotp(uid),
			revokeApiToken: () => store.revokeApiToken(uid, "tokx"),
			createOAuthGrant: () =>
				store.createOAuthGrant({ userId: uid, clientId: "c", clientName: "C", redirectHost: "h", now }),
			revokeOAuthGrant: () => store.revokeOAuthGrant(uid, "ogr_x"),
			scheduleAccountDeletion: () => store.scheduleAccountDeletion({ userId: "usr_missing", now, graceMs: 1, mailboxes: [] }),
			completeAccountDeletion: () => store.completeAccountDeletion("usr_missing", now),
			setOAuthGrantSendAuto: () => store.setOAuthGrantSendAuto(uid, "ogr_x", true),
		};
		let expected = start;
		for (const method of AUTH_EPOCH_METHODS) {
			await calls[method]();
			expected++;
			expect(await store.getAuthEpoch(), method).toBe(expected);
		}

		// A new instance over the same storage (a Durable Object restart) resumes.
		expect(await new AuthStore(sql, tx).getAuthEpoch()).toBe(expected);
	});

	it("returns the epoch with every successful validation", async () => {
		const { sql, tx } = sqliteDb();
		const store = new AuthStore(sql, tx);
		const now = Date.now();
		const owner = await store.createOwner({ email: "o@example.com", name: "O", passwordHash: "h", now });
		if (!owner.ok) throw new Error("setup");
		await store.createSession({ userId: owner.user.id, tokenHash: "th", ip: null, userAgent: null, now });
		await store.updateProfile(owner.user.id, { name: "Renamed" });
		const epoch = await store.getAuthEpoch();
		expect((await store.validateSession("th", now))?.epoch).toBe(epoch);
	});
});

// -- two isolates over one AuthDO ---------------------------------------------------

const ORIGIN = "https://mail.example.com";

interface Isolate {
	cache: AuthCache;
	deps: AuthDeps;
	app: Hono<MailboxContext>;
	request(path: string, init?: { cookie?: string; bearer?: string; ip?: string }): Promise<Response>;
	/** Run what the middleware handed to `waitUntil` (background epoch refreshes). */
	settle(): Promise<void>;
}

/**
 * An isolate as `workers/app.ts` assembles one: its own cache and its own
 * wrapped accessor over the shared store. The store also counts RPCs, so a
 * test can tell a cache hit from a round trip.
 */
function isolate(store: AuthStoreApi, clock: { now: number }, rpcs: string[]): Isolate {
	const counted = new Proxy(store, {
		get(target, prop) {
			const value = Reflect.get(target, prop);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				rpcs.push(String(prop));
				return (value as (...a: unknown[]) => unknown).apply(target, args);
			};
		},
	});
	const cache = new AuthCache({ now: () => clock.now });
	const deps: AuthDeps = {
		getStore: withAuthCacheInvalidation(() => counted, cache),
		authCache: cache,
		now: () => clock.now,
	};
	const app = new Hono<MailboxContext>();
	app.use("*", serverTiming);
	app.use(
		"*",
		timedMiddleware("auth", createAuthenticate(deps), (c) => {
			const status = (c as unknown as { var: { authCacheStatus?: string } }).var.authCacheStatus;
			return status ? `cache=${status}` : undefined;
		}),
	);
	app.get("/api/v1/me", (c) =>
		c.var.authUser
			? c.json({ id: c.var.authUser.id, name: c.var.authUser.name, scopes: c.var.authToken?.scopes ?? null })
			: c.json({ error: "unauthenticated" }, 401),
	);
	const pending: Promise<unknown>[] = [];
	const executionCtx = {
		waitUntil: (p: Promise<unknown>) => void pending.push(p),
		passThroughOnException: () => undefined,
	} as unknown as ExecutionContext;
	const env = { AUTH_SECRET: "x", AUTH_STORE: {} } as unknown as Env;
	return {
		cache,
		deps,
		app,
		request: (path, init = {}) => {
			const headers: Record<string, string> = { "cf-connecting-ip": init.ip ?? "203.0.113.7" };
			if (init.cookie) headers.Cookie = `__Host-tt_session=${init.cookie}`;
			if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
			return Promise.resolve(app.fetch(new Request(`${ORIGIN}${path}`, { headers }), env, executionCtx));
		},
		settle: async () => {
			while (pending.length) await Promise.all(pending.splice(0));
		},
	};
}

describe("credential cache across isolates", () => {
	let clock: { now: number };
	let store: AuthStore;
	let rpcs: string[];
	let a: Isolate;
	let b: Isolate;
	let user: AuthUser;
	const SESSION = "session-token-0123456789abcdef";

	beforeEach(async () => {
		clock = { now: Date.UTC(2026, 9, 26) };
		const { sql, tx } = sqliteDb();
		store = new AuthStore(sql, tx);
		const owner = await store.createOwner({ email: "o@example.com", name: "Olivia", passwordHash: "h", now: clock.now });
		if (!owner.ok) throw new Error("setup");
		user = owner.user;
		await store.createSession({
			userId: user.id,
			tokenHash: await sha256Hex(SESSION),
			ip: null,
			userAgent: null,
			now: clock.now,
		});
		rpcs = [];
		a = isolate(store, clock, rpcs);
		b = isolate(store, clock, rpcs);
	});

	const validations = () => rpcs.filter((r) => r.startsWith("validate")).length;
	const timing = (res: Response) => res.headers.get("server-timing") ?? "";

	it("validates once, then serves from the cache with cache=hit", async () => {
		const first = await a.request("/api/v1/me", { cookie: SESSION });
		expect(first.status).toBe(200);
		expect(timing(first)).toMatch(/auth;dur=[\d.]+;desc="cache=miss"/);
		expect(validations()).toBe(1);

		const second = await a.request("/api/v1/me", { cookie: SESSION });
		expect(second.status).toBe(200);
		expect(timing(second)).toMatch(/auth;dur=[\d.]+;desc="cache=hit"/);
		expect(validations()).toBe(1);
		// A cold miss costs one round trip, the same as with no cache: the epoch
		// came back with the validation.
		expect(rpcs).toEqual(["validateSession"]);
	});

	it("keys by a hash of the token, never the token itself", async () => {
		await a.request("/api/v1/me", { cookie: SESSION });
		const keys = [...(a.cache as unknown as { entries: Map<string, unknown> }).entries.keys()];
		expect(keys).toEqual([`s:${await sha256Hex(SESSION)}`]);
		expect(keys.join()).not.toContain(SESSION);
	});

	it("never caches a failed validation", async () => {
		expect((await a.request("/api/v1/me", { cookie: "wrong-token-0123456789abcdef" })).status).toBe(401);
		expect((await a.request("/api/v1/me", { cookie: "wrong-token-0123456789abcdef" })).status).toBe(401);
		expect(validations()).toBe(2);
	});

	it("revocation through the same isolate is immediate", async () => {
		expect((await a.request("/api/v1/me", { cookie: SESSION })).status).toBe(200);
		const [session] = await store.listSessions(user.id, clock.now);
		await a.deps.getStore({} as Env).revokeSession(user.id, session.id);
		expect((await a.request("/api/v1/me", { cookie: SESSION })).status).toBe(401);
	});

	it("revocation through another isolate is honoured within the hard epoch age", async () => {
		expect((await a.request("/api/v1/me", { cookie: SESSION })).status).toBe(200);
		expect((await b.request("/api/v1/me", { cookie: SESSION })).status).toBe(200);

		// Logout handled by isolate A: the AuthDO bumps the epoch.
		await a.deps.getStore({} as Env).deleteSession(await sha256Hex(SESSION));
		expect((await a.request("/api/v1/me", { cookie: SESSION })).status).toBe(401);

		// B still has a fresh view of the old epoch: within the window it may serve.
		clock.now += AUTH_EPOCH_SOFT_MS - 1;
		expect((await b.request("/api/v1/me", { cookie: SESSION })).status).toBe(200);

		// Past the soft age B serves once more while it re-reads the epoch in the
		// background; once that lands, the entry is dead.
		clock.now += 1;
		expect((await b.request("/api/v1/me", { cookie: SESSION })).status).toBe(200);
		await b.settle();
		expect((await b.request("/api/v1/me", { cookie: SESSION })).status).toBe(401);
	});

	it("holds the bound even when no background refresh ever lands", async () => {
		expect((await b.request("/api/v1/me", { cookie: SESSION })).status).toBe(200);
		await a.deps.getStore({} as Env).deleteSession(await sha256Hex(SESSION));
		// B's `waitUntil` work is never run.
		clock.now += AUTH_EPOCH_HARD_MS - 1;
		expect((await b.request("/api/v1/me", { cookie: SESSION })).status).toBe(200);
		clock.now += 1;
		expect((await b.request("/api/v1/me", { cookie: SESSION })).status).toBe(401);
	});

	it("an unrelated change elsewhere costs B one revalidation, not a refusal", async () => {
		expect((await b.request("/api/v1/me", { cookie: SESSION })).status).toBe(200);
		await a.deps.getStore({} as Env).updateProfile(user.id, { name: "Renamed" });
		clock.now += AUTH_EPOCH_SOFT_MS;
		await b.request("/api/v1/me", { cookie: SESSION });
		await b.settle();
		const res = await b.request("/api/v1/me", { cookie: SESSION });
		expect(res.status).toBe(200);
		// And the revalidation picked up the change.
		expect(await res.json()).toMatchObject({ name: "Renamed" });
		expect(timing(res)).toContain("cache=miss");
	});

	it("re-validates at the TTL even when the epoch never changes", async () => {
		await a.request("/api/v1/me", { cookie: SESSION });
		for (let t = 0; t < AUTH_CACHE_TTL_MS; t += AUTH_EPOCH_SOFT_MS) {
			clock.now += AUTH_EPOCH_SOFT_MS;
			await a.request("/api/v1/me", { cookie: SESSION });
			await a.settle();
		}
		// 30 one-second steps: the epoch stayed fresh throughout, so only the TTL
		// forced the second validation.
		expect(validations()).toBe(2);
	});

	it("a disabled user is refused in the other isolate within the bound", async () => {
		expect((await b.request("/api/v1/me", { cookie: SESSION })).status).toBe(200);
		// Owners cannot be disabled; use a member with their own session.
		const invite = await store.createInvite({
			tokenHash: "inv",
			email: "m@example.com",
			role: "member",
			mailboxes: [],
			createdBy: user.id,
			expiresAt: clock.now + 60_000,
			now: clock.now,
		});
		expect(invite).toBeTruthy();
		const accepted = await store.acceptInvite({ tokenHash: "inv", name: "M", passwordHash: "h", now: clock.now });
		if (!accepted.ok) throw new Error("invite");
		await store.createSession({
			userId: accepted.user.id,
			tokenHash: await sha256Hex("member-session-0123456789abcdef"),
			ip: null,
			userAgent: null,
			now: clock.now,
		});
		expect((await b.request("/api/v1/me", { cookie: "member-session-0123456789abcdef" })).status).toBe(200);
		await a.deps.getStore({} as Env).setDisabled(accepted.user.id, true);
		clock.now += AUTH_EPOCH_HARD_MS;
		expect((await b.request("/api/v1/me", { cookie: "member-session-0123456789abcdef" })).status).toBe(401);
	});

	describe("API tokens", () => {
		const SECRET = "s".repeat(32);
		const ID = "abcdefghijkl";
		const bearer = `ttk_${ID}_${SECRET}`;

		beforeEach(async () => {
			await store.createApiToken({
				id: ID,
				userId: user.id,
				name: "cli",
				secretHash: await sha256Hex(SECRET),
				expiresAt: null,
				now: clock.now,
				scopes: ["mail:read"],
			});
		});

		it("caches a token, with its scopes, and keys by id, secret hash and IP", async () => {
			const first = await a.request("/api/v1/me", { bearer });
			expect(await first.json()).toMatchObject({ scopes: ["mail:read"] });
			const second = await a.request("/api/v1/me", { bearer });
			expect(timing(second)).toContain("cache=hit");
			expect(await second.json()).toMatchObject({ scopes: ["mail:read"] });
			// A new address reaches the store, so "last used from" stays accurate.
			expect(timing(await a.request("/api/v1/me", { bearer, ip: "198.51.100.1" }))).toContain("cache=miss");
			// A wrong secret for the same id never matches the cached entry.
			expect((await a.request("/api/v1/me", { bearer: `ttk_${ID}_${"x".repeat(32)}` })).status).toBe(401);
		});

		it("revoking a token stops it at once here and within the bound elsewhere", async () => {
			await a.request("/api/v1/me", { bearer });
			await b.request("/api/v1/me", { bearer });
			await a.deps.getStore({} as Env).revokeApiToken(user.id, ID);
			expect((await a.request("/api/v1/me", { bearer })).status).toBe(401);
			clock.now += AUTH_EPOCH_HARD_MS;
			expect((await b.request("/api/v1/me", { bearer })).status).toBe(401);
		});

		it("a scope change (revoke and re-mint) takes effect within the bound", async () => {
			expect(await (await b.request("/api/v1/me", { bearer })).json()).toMatchObject({ scopes: ["mail:read"] });
			// Scopes are immutable on a token; changing them is revoke + mint, and
			// the revoke advances the epoch.
			await a.deps.getStore({} as Env).revokeApiToken(user.id, ID);
			const NEW_ID = "mnopqrstuvwx";
			await store.createApiToken({
				id: NEW_ID,
				userId: user.id,
				name: "cli",
				secretHash: await sha256Hex(SECRET),
				expiresAt: null,
				now: clock.now,
				scopes: ["mail:send"],
			});
			clock.now += AUTH_EPOCH_HARD_MS;
			expect((await b.request("/api/v1/me", { bearer })).status).toBe(401);
			const next = await b.request("/api/v1/me", { bearer: `ttk_${NEW_ID}_${SECRET}` });
			expect(await next.json()).toMatchObject({ scopes: ["mail:send"] });
		});

		it("never serves a token past its expiry", async () => {
			const SHORT = "shortlivedid";
			await store.createApiToken({
				id: SHORT,
				userId: user.id,
				name: "short",
				secretHash: await sha256Hex(SECRET),
				expiresAt: clock.now + 500,
				now: clock.now,
			});
			expect((await a.request("/api/v1/me", { bearer: `ttk_${SHORT}_${SECRET}` })).status).toBe(200);
			clock.now += 500;
			expect((await a.request("/api/v1/me", { bearer: `ttk_${SHORT}_${SECRET}` })).status).toBe(401);
		});
	});

	describe("MCP OAuth grants", () => {
		/** A provider stub: one access token mapped to one AuthDO grant. */
		function withOAuth(iso: Isolate, grantId: string, expiresAt?: number) {
			iso.deps.mcpOAuth = {
				resolveAccessToken: async (_env, _origin, token) =>
					token === "oauth-access-token" ? { userId: user.id, grantId, expiresAt } : null,
				revokeProviderGrants: async () => {},
			};
		}

		async function mcp(iso: Isolate): Promise<Response> {
			const env = { AUTH_SECRET: "x", AUTH_STORE: {}, OAUTH_KV: {} } as unknown as Env;
			return iso.app.fetch(
				new Request(`${ORIGIN}/mcp`, { headers: { Authorization: "Bearer oauth-access-token" } }),
				env,
				{ waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
			);
		}

		it("revoking a grant bumps the epoch and ends cached OAuth identities", async () => {
			const grant = await store.createOAuthGrant({
				userId: user.id,
				clientId: "c",
				clientName: "Claude",
				redirectHost: "claude.ai",
				now: clock.now,
			});
			for (const iso of [a, b]) {
				withOAuth(iso, grant.id);
				iso.app.all("/mcp", (c) => (c.var.authUser ? c.text("ok") : c.text("no", 401)));
			}
			expect((await mcp(a)).status).toBe(200);
			expect((await mcp(b)).status).toBe(200);
			const before = validations();
			expect((await mcp(b)).status).toBe(200);
			expect(validations()).toBe(before); // served from B's cache

			await a.deps.getStore({} as Env).revokeOAuthGrant(user.id, grant.id);
			expect((await mcp(a)).status).toBe(401);
			clock.now += AUTH_EPOCH_HARD_MS;
			expect((await mcp(b)).status).toBe(401);
		});
	});
});
