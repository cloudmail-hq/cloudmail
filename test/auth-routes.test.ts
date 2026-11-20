// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Built-in password auth, end to end over HTTP.
 *
 * The app is assembled the way `workers/app.ts` assembles it — CSRF guard,
 * `authenticate`, the `/api/auth` routes, the gate, then the real API app from
 * `workers/index.ts` and a stub SSR handler — but without importing app.ts,
 * which pulls in `virtual:react-router`. Storage is the real `AuthStore` over
 * `node:sqlite`, so lockout, single-use links and session expiry are the
 * production logic rather than a fake's approximation of it.
 */

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { app as apiApp } from "../workers/index";
import { createAuthGate, createAuthenticate, type AuthDeps } from "../workers/auth/middleware";
import { createAuthRoutes } from "../workers/auth/routes";
import { AuthCache, withAuthCacheInvalidation } from "../workers/auth/session-cache";
import { AuthStore, type AuthSql } from "../workers/auth/store-core";
import { hotp, base32Decode, totpStep } from "../workers/auth/totp";
import { csrfGuard } from "../workers/lib/csrf";
import type { MailboxContext } from "../workers/lib/mailbox";
import type { Env } from "../workers/types";

const ORIGIN = "https://mail.example.com";
const SETUP_TOKEN = "correct-horse-battery-staple";
const OWNER = { email: "owner@example.com", name: "Olivia Owner", password: "owner-password-1" };
const SUPPORT = "support@example.com";
const SALES = "sales@example.com";

// -- harness -----------------------------------------------------------------

function sqliteStore(): AuthStore {
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
	return new AuthStore(sql, tx);
}

function fakeBucket(initial: Record<string, unknown> = {}) {
	const store = new Map<string, string>(
		Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]),
	);
	return {
		async head(key: string) {
			return store.has(key) ? { key } : null;
		},
		async get(key: string) {
			const raw = store.get(key);
			return raw === undefined ? null : { json: async () => JSON.parse(raw) };
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async delete(key: string | string[]) {
			for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
		},
		async list({ prefix = "" }: { prefix?: string } = {}) {
			return {
				objects: [...store.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
				truncated: false as const,
			};
		},
		_store: store,
	};
}

interface Harness {
	request: (path: string, init?: RequestInit & { cookie?: string | null; bearer?: string }) => Promise<Response>;
	store: AuthStore;
	bucket: ReturnType<typeof fakeBucket>;
	clock: { now: number };
	env: Env;
	/** Every message handed to the fake `EMAIL` binding, in order. */
	sent: SentMessage[];
	/** Wait for everything the routes passed to `waitUntil`. */
	settle: () => Promise<void>;
}

interface SentMessage {
	to: string;
	from: { email: string; name: string };
	subject: string;
	text: string;
	html: string;
}

/** The token from the reset link in a captured email. */
function resetTokenFrom(message: SentMessage): string {
	const match = /\/reset\/([A-Za-z0-9_-]+)/.exec(message.text);
	if (!match) throw new Error("no reset link in the email");
	return match[1];
}

function build(
	options: { env?: Partial<Env>; limiter?: (key: string) => boolean; isDev?: boolean } = {},
): Harness {
	const store = sqliteStore();
	const bucket = fakeBucket({
		[`mailboxes/${SUPPORT}.json`]: { fromName: "Support" },
		[`mailboxes/${SALES}.json`]: { fromName: "Sales" },
	});
	const clock = { now: Date.UTC(2026, 5, 1) };
	const sent: SentMessage[] = [];
	const env = {
		EMAIL: {
			async send(message: SentMessage) {
				sent.push(message);
				return { messageId: `msg-${sent.length}` };
			},
		},
		DOMAINS: "example.com",
		SETUP_TOKEN,
		AUTH_SECRET: "test-auth-secret",
		BUCKET: bucket,
		MAILBOX: { idFromName: (name: string) => ({ name }), get: () => ({}) },
		AUTH_STORE: {},
		...(options.limiter
			? { AUTH_RATE_LIMITER: { limit: async ({ key }: { key: string }) => ({ success: options.limiter!(key) }) } }
			: {}),
		...options.env,
	} as unknown as Env;

	// The credential cache is on, as in production, so every flow below also
	// proves that revocation through the routes is immediate.
	const authCache = new AuthCache({ now: () => clock.now });
	const deps: AuthDeps = {
		getStore: withAuthCacheInvalidation(() => store, authCache),
		authCache,
		isDev: options.isDev ?? false,
		now: () => clock.now,
	};
	const app = new Hono<MailboxContext>();
	app.use("*", csrfGuard);
	app.use("*", createAuthenticate(deps));
	app.route("/api/auth", createAuthRoutes(deps));
	app.use("*", createAuthGate(deps));
	app.all("/mcp", (c) => c.text("mcp"));
	// Echoes who the request resolved to, for checking identity on odd paths.
	app.all("/mcp/*", (c) => c.json({ identity: c.var.accessIdentity ?? null }));
	app.route("/", apiApp);
	app.all("*", (c) => c.html("<html>page</html>"));

	const pending: Promise<unknown>[] = [];
	const executionCtx = {
		waitUntil: (promise: Promise<unknown>) => {
			pending.push(promise);
		},
		passThroughOnException: () => undefined,
	} as unknown as ExecutionContext;

	const request: Harness["request"] = (path, init = {}) => {
		const { cookie, bearer, ...rest } = init;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"Sec-Fetch-Site": "same-origin",
			"cf-connecting-ip": "203.0.113.7",
			...(rest.headers as Record<string, string>),
		};
		if (cookie) headers.Cookie = cookie;
		if (bearer) headers.Authorization = `Bearer ${bearer}`;
		return Promise.resolve(app.fetch(new Request(`${ORIGIN}${path}`, { ...rest, headers }), env, executionCtx));
	};

	const settle = async () => {
		while (pending.length) await Promise.all(pending.splice(0));
	};

	return { request, store, bucket, clock, env, sent, settle };
}

function post(body: unknown, extra: RequestInit & { cookie?: string | null; bearer?: string } = {}) {
	return { method: "POST", body: JSON.stringify(body), ...extra };
}

/** `name=value` from a Set-Cookie header, for sending back. */
function cookieFrom(res: Response): string {
	const header = res.headers.get("set-cookie");
	if (!header) throw new Error("no Set-Cookie");
	return header.split(";")[0];
}

async function setupOwner(h: Harness): Promise<string> {
	const res = await h.request("/api/auth/setup", post({ setupToken: SETUP_TOKEN, ...OWNER }));
	expect(res.status).toBe(201);
	return cookieFrom(res);
}

/** Invite a member via the admin API and accept it; returns the member's cookie. */
async function inviteMember(
	h: Harness,
	ownerCookie: string,
	member: { email: string; role?: "admin" | "member"; mailboxes?: string[] },
): Promise<string> {
	const created = await h.request(
		"/api/auth/admin/invites",
		post({ email: member.email, role: member.role ?? "member", mailboxes: member.mailboxes ?? [] }, { cookie: ownerCookie }),
	);
	expect(created.status).toBe(201);
	const { url } = (await created.json()) as { url: string };
	const token = url.split("/invite/")[1];
	const accepted = await h.request(
		"/api/auth/invites/accept",
		post({ token, name: "Member", password: "member-password-1" }),
	);
	expect(accepted.status).toBe(200);
	return cookieFrom(accepted);
}

async function currentTotp(secret: string, nowMs: number): Promise<string> {
	return hotp(base32Decode(secret), totpStep(nowMs));
}

// -- setup -------------------------------------------------------------------

describe("first-run setup", () => {
	let h: Harness;
	beforeEach(() => {
		h = build();
	});

	it("reports setup as required and never returns the token", async () => {
		const res = await h.request("/api/auth/state");
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			mode: "password",
			setupRequired: true,
			authenticated: false,
			user: null,
			setupTokenConfigured: true,
		});
		expect(JSON.stringify(body)).not.toContain(SETUP_TOKEN);
	});

	it("refuses a wrong setup token", async () => {
		const res = await h.request("/api/auth/setup", post({ setupToken: "nope", ...OWNER }));
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ code: "bad_setup_token" });
		expect(await h.store.isSetupRequired()).toBe(true);
	});

	it("refuses a weak password", async () => {
		const res = await h.request("/api/auth/setup", post({ setupToken: SETUP_TOKEN, ...OWNER, password: "short" }));
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "weak_password" });
	});

	it("refuses malformed input", async () => {
		const res = await h.request("/api/auth/setup", post({ setupToken: SETUP_TOKEN, email: "not-an-email" }));
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "invalid_input" });
	});

	it("creates the owner, signs them in, and closes setup", async () => {
		const res = await h.request("/api/auth/setup", post({ setupToken: SETUP_TOKEN, ...OWNER }));
		expect(res.status).toBe(201);
		const body = (await res.json()) as { user: Record<string, unknown> };
		expect(body.user).toMatchObject({ email: OWNER.email, isOwner: true, isAdmin: true });

		const again = await h.request("/api/auth/setup", post({ setupToken: SETUP_TOKEN, ...OWNER }));
		expect(again.status).toBe(409);
		expect(await again.json()).toMatchObject({ code: "already_setup" });
	});

	it("uses a generated token when no SETUP_TOKEN is configured", async () => {
		const g = build({ env: { SETUP_TOKEN: undefined } });
		const state = (await (await g.request("/api/auth/state")).json()) as Record<string, unknown>;
		expect(state.setupTokenConfigured).toBe(false);
		const generated = await g.store.ensureGeneratedSetupToken();
		expect(JSON.stringify(state)).not.toContain(generated);

		const res = await g.request("/api/auth/setup", post({ setupToken: generated, ...OWNER }));
		expect(res.status).toBe(201);
	});
});

// -- login -------------------------------------------------------------------

describe("login", () => {
	let h: Harness;
	beforeEach(async () => {
		h = build();
		await setupOwner(h);
	});

	it("sets a hardened session cookie", async () => {
		const res = await h.request("/api/auth/login", post({ email: "OWNER@example.com", password: OWNER.password }));
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ status: "ok", user: { email: OWNER.email } });

		const cookie = res.headers.get("set-cookie")!;
		expect(cookie).toMatch(/^__Host-tt_session=[A-Za-z0-9_-]{40,};/);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Secure");
		expect(cookie).toContain("SameSite=Lax");
		expect(cookie).toContain("Path=/");
		expect(cookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
		expect(cookie).not.toContain("Domain=");
	});

	it("uses a plain, non-Secure cookie name on http (localhost dev)", async () => {
		const { buildSessionCookie } = await import("../workers/auth/cookies");
		const cookie = buildSessionCookie("abc", "http://localhost:5173/api/auth/login");
		expect(cookie.startsWith("tt_session=abc;")).toBe(true);
		expect(cookie).not.toContain("Secure");
	});

	it("answers a wrong password and an unknown email identically", async () => {
		const wrong = await h.request("/api/auth/login", post({ email: OWNER.email, password: "wrong-password-1" }));
		const unknown = await h.request("/api/auth/login", post({ email: "nobody@example.com", password: "wrong-password-1" }));
		expect(wrong.status).toBe(401);
		expect(unknown.status).toBe(401);
		const a = await wrong.json();
		const b = await unknown.json();
		expect(a).toEqual({ error: "Invalid email or password", code: "invalid_credentials" });
		expect(b).toEqual(a);
		expect(wrong.headers.get("set-cookie")).toBeNull();
	});

	it("locks the account after repeated failures, even for the right password", async () => {
		let last: Response | undefined;
		for (let i = 0; i < 5; i++) {
			last = await h.request("/api/auth/login", post({ email: OWNER.email, password: "wrong-password-1" }));
		}
		expect(last!.status).toBe(423);
		const body = (await last!.json()) as { code: string; retryAfter: number };
		expect(body.code).toBe("locked");
		// Seconds, not a timestamp.
		expect(body.retryAfter).toBeGreaterThan(0);
		expect(body.retryAfter).toBeLessThanOrEqual(15 * 60);

		const right = await h.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password }));
		expect(right.status).toBe(423);

		h.clock.now += 60 * 60 * 1000;
		const later = await h.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password }));
		expect(later.status).toBe(200);
	});

	it("never uses a global per-email rate limit key", async () => {
		const keys: string[] = [];
		const r = build({
			limiter: (key) => {
				keys.push(key);
				return true;
			},
		});
		await setupOwner(r);
		keys.length = 0;
		await r.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password }));
		expect(keys.sort()).toEqual(
			["auth:login:email-ip:owner@example.com:203.0.113.7", "auth:login:ip:203.0.113.7"].sort(),
		);
	});

	it("does not let failures from one IP lock the owner out from another", async () => {
		const attacker = { headers: { "cf-connecting-ip": "198.51.100.66" } };
		for (let i = 0; i < 20; i++) {
			await h.request("/api/auth/login", post({ email: OWNER.email, password: "wrong-password-1" }, attacker));
		}
		const blocked = await h.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password }, attacker));
		expect(blocked.status).toBe(423);
		// The owner, from their own address, is unaffected.
		const owner = await h.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password }));
		expect(owner.status).toBe(200);
	});

	it("locks unknown emails identically, so lockout does not reveal accounts", async () => {
		const real: Array<{ status: number; body: unknown; retryAfter: string | null }> = [];
		const unknown: typeof real = [];
		for (let i = 0; i < 7; i++) {
			for (const [email, out] of [
				[OWNER.email, real],
				["nobody@example.com", unknown],
			] as const) {
				const res = await h.request("/api/auth/login", post({ email, password: "wrong-password-1" }));
				out.push({ status: res.status, body: await res.json(), retryAfter: res.headers.get("retry-after") });
			}
		}
		expect(unknown).toEqual(real);
		expect(real.map((r) => r.status)).toEqual([401, 401, 401, 401, 423, 423, 423]);
	});

	it("runs a password hash even while locked, so timing matches for known and unknown", async () => {
		const crypto = await import("../workers/auth/crypto");
		const { vi } = await import("vitest");
		for (let i = 0; i < 5; i++) {
			await h.request("/api/auth/login", post({ email: OWNER.email, password: "wrong-password-1" }));
			await h.request("/api/auth/login", post({ email: "nobody@example.com", password: "wrong-password-1" }));
		}
		const spy = vi.spyOn(crypto, "dummyVerifyPassword");
		try {
			const a = await h.request("/api/auth/login", post({ email: OWNER.email, password: "wrong-password-1" }));
			const b = await h.request("/api/auth/login", post({ email: "nobody@example.com", password: "wrong-password-1" }));
			expect([a.status, b.status]).toEqual([423, 423]);
			// One dummy hash each: the lock never short-circuits the scrypt cost.
			expect(spy).toHaveBeenCalledTimes(2);
		} finally {
			spy.mockRestore();
		}
	});

	it("warns, without locking, when one account sees more than 100 failures in an hour", async () => {
		const { vi } = await import("vitest");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			// 100 failures from 100 addresses; the request below is the 101st.
			for (let i = 0; i < 100; i++) {
				await h.store.recordLoginFailure(OWNER.email, `10.0.${i >> 8}.${i & 255}`, h.clock.now);
			}
			expect(warn).not.toHaveBeenCalled();
			const res = await h.request(
				"/api/auth/login",
				post({ email: OWNER.email, password: "wrong-password-1" }, { headers: { "cf-connecting-ip": "10.1.0.1" } }),
			);
			expect(res.status).toBe(401);
			expect(warn.mock.calls.some((c) => String(c[0]).includes("failed sign-ins for owner@example.com"))).toBe(true);
			// And the owner can still sign in.
			expect((await h.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password }))).status).toBe(200);
		} finally {
			warn.mockRestore();
		}
	});

	it("rate limits per (email, IP) with retryAfter in seconds", async () => {
		const r = build({ limiter: (key) => !key.includes("login:email-ip:owner@example.com:203.0.113.7") });
		await setupOwner(r);
		const res = await r.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password }));
		expect(res.status).toBe(429);
		expect(await res.json()).toMatchObject({ code: "rate_limited", retryAfter: 60 });
		expect(res.headers.get("retry-after")).toBe("60");
	});

	it("logs out: the cookie is cleared and the session no longer works", async () => {
		const login = await h.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password }));
		const cookie = cookieFrom(login);
		expect((await h.request("/api/v1/me", { cookie })).status).toBe(200);

		const out = await h.request("/api/auth/logout", post({}, { cookie }));
		expect(out.status).toBe(204);
		expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
		expect((await h.request("/api/v1/me", { cookie })).status).toBe(401);
	});

	it("refuses a cross-site login POST", async () => {
		const res = await h.request(
			"/api/auth/login",
			post({ email: OWNER.email, password: OWNER.password }, { headers: { "Sec-Fetch-Site": "cross-site" } }),
		);
		expect(res.status).toBe(403);
	});
});

// -- second factor ----------------------------------------------------------

describe("two-factor sign-in", () => {
	it("enrols, then requires a code, and refuses a replayed one", async () => {
		const h = build();
		const cookie = await setupOwner(h);

		const setup = await h.request("/api/auth/2fa/setup", post({ password: OWNER.password }, { cookie }));
		expect(setup.status).toBe(200);
		const { secret, otpauthUrl } = (await setup.json()) as { secret: string; otpauthUrl: string };
		expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\//);

		const enable = await h.request(
			"/api/auth/2fa/enable",
			post({ code: await currentTotp(secret, h.clock.now) }, { cookie }),
		);
		expect(enable.status).toBe(200);
		const { recoveryCodes } = (await enable.json()) as { recoveryCodes: string[] };
		expect(recoveryCodes).toHaveLength(10);

		h.clock.now += 60_000;
		const login = await h.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password }));
		const first = (await login.json()) as { status: string; challenge: string };
		expect(first.status).toBe("mfa_required");
		expect(login.headers.get("set-cookie")).toBeNull();

		const bad = await h.request("/api/auth/login/mfa", post({ challenge: first.challenge, code: "000000" }));
		expect(bad.status).toBe(401);
		expect(await bad.json()).toMatchObject({ code: "invalid_code" });

		const code = await currentTotp(secret, h.clock.now);
		const good = await h.request("/api/auth/login/mfa", post({ challenge: first.challenge, code }));
		expect(good.status).toBe(200);
		expect(good.headers.get("set-cookie")).toContain("__Host-tt_session=");

		// Same code again, fresh challenge: refused as a replay.
		const again = (await (
			await h.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password }))
		).json()) as { challenge: string };
		const replay = await h.request("/api/auth/login/mfa", post({ challenge: again.challenge, code }));
		expect(replay.status).toBe(401);

		// A recovery code works once.
		const rc = await h.request("/api/auth/login/mfa", post({ challenge: again.challenge, code: recoveryCodes[0] }));
		expect(rc.status).toBe(200);
	});

	async function enrolledOwner(h: Harness): Promise<{ secret: string; recoveryCodes: string[] }> {
		const cookie = await setupOwner(h);
		const setup = await h.request("/api/auth/2fa/setup", post({ password: OWNER.password }, { cookie }));
		const { secret } = (await setup.json()) as { secret: string };
		const enable = await h.request(
			"/api/auth/2fa/enable",
			post({ code: await currentTotp(secret, h.clock.now) }, { cookie }),
		);
		const { recoveryCodes } = (await enable.json()) as { recoveryCodes: string[] };
		h.clock.now += 60_000;
		return { secret, recoveryCodes };
	}

	async function challenge(h: Harness): Promise<string> {
		const res = await h.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password }));
		const body = (await res.json()) as { status: string; challenge: string };
		expect(body.status).toBe("mfa_required");
		return body.challenge;
	}

	it("locks the second factor across challenges, without the rate limiter", async () => {
		const h = build();
		const { secret } = await enrolledOwner(h);
		// Four wrong codes, each on a fresh challenge: the per-challenge cap never trips.
		for (let i = 0; i < 4; i++) {
			const res = await h.request("/api/auth/login/mfa", post({ challenge: await challenge(h), code: "000000" }));
			expect(res.status).toBe(401);
		}
		const fifth = await h.request("/api/auth/login/mfa", post({ challenge: await challenge(h), code: "000000" }));
		expect(fifth.status).toBe(423);
		expect(await fifth.json()).toMatchObject({ code: "locked", retryAfter: 30 });

		// Even the right code is refused while locked, on a new challenge too.
		const right = await h.request(
			"/api/auth/login/mfa",
			post({ challenge: await challenge(h), code: await currentTotp(secret, h.clock.now) }),
		);
		expect(right.status).toBe(423);
		expect(right.headers.get("retry-after")).toBeTruthy();

		// Backoff doubles on the next failure after the lock expires.
		h.clock.now += 31_000;
		const sixth = await h.request("/api/auth/login/mfa", post({ challenge: await challenge(h), code: "000000" }));
		expect(sixth.status).toBe(423);
		expect(await sixth.json()).toMatchObject({ retryAfter: 60 });

		// A correct second factor resets the counter.
		h.clock.now += 61_000;
		const ok = await h.request(
			"/api/auth/login/mfa",
			post({ challenge: await challenge(h), code: await currentTotp(secret, h.clock.now) }),
		);
		expect(ok.status).toBe(200);
		const after = await h.request("/api/auth/login/mfa", post({ challenge: await challenge(h), code: "000000" }));
		expect(after.status).toBe(401);
	});

	it("tells the user to use a recovery code when the TOTP secret cannot be decrypted", async () => {
		const h = build();
		const { recoveryCodes } = await enrolledOwner(h);
		// AUTH_SECRET changed after enrolment.
		(h.env as unknown as Record<string, string>).AUTH_SECRET = "a-different-secret";
		const { vi } = await import("vitest");
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const ch = await challenge(h);
			const res = await h.request("/api/auth/login/mfa", post({ challenge: ch, code: "123456" }));
			expect(res.status).toBe(401);
			const body = (await res.json()) as { code: string; error: string };
			expect(body.code).toBe("totp_unavailable");
			expect(body.error).toMatch(/recovery code/);
			expect(error.mock.calls.some((c) => String(c[0]).includes("AUTH_SECRET"))).toBe(true);

			// Not counted as a guess, and a recovery code still gets in.
			const rc = await h.request("/api/auth/login/mfa", post({ challenge: ch, code: recoveryCodes[0] }));
			expect(rc.status).toBe(200);
		} finally {
			error.mockRestore();
		}
	});

	it("treats an unknown challenge as expired", async () => {
		const h = build();
		await setupOwner(h);
		const res = await h.request("/api/auth/login/mfa", post({ challenge: "x".repeat(43), code: "123456" }));
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({ code: "challenge_expired" });
	});
});

// -- the gate ---------------------------------------------------------------

describe("unauthenticated requests", () => {
	it("401s the API surfaces with the contract body", async () => {
		const h = build();
		await setupOwner(h);
		for (const path of ["/api/v1/me", "/api/v1/mailboxes", "/mcp", "/agents/email-agent/support@example.com"]) {
			const res = await h.request(path);
			expect(res.status, path).toBe(401);
			expect(await res.json()).toEqual({ error: "Sign in required", code: "unauthenticated" });
		}
	});

	it("leaves branding readable so the sign-in page can render it", async () => {
		const h = build();
		await setupOwner(h);
		expect((await h.request("/api/v1/branding")).status).toBe(200);
	});

	it("sends a fresh deployment to /setup", async () => {
		const h = build();
		const res = await h.request("/mail/support@example.com/inbox");
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/setup");
		expect((await h.request("/setup")).status).toBe(200);
	});

	it("sends a signed-out page request to /login with next", async () => {
		const h = build();
		await setupOwner(h);
		const res = await h.request("/mail/support@example.com/inbox?q=x");
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe(
			`/login?next=${encodeURIComponent("/mail/support@example.com/inbox?q=x")}`,
		);
		expect((await h.request("/")).headers.get("location")).toBe("/login");
		expect((await h.request("/setup")).headers.get("location")).toBe("/login");
	});

	it("answers React Router data requests with a single-fetch redirect", async () => {
		const h = build();
		await setupOwner(h);
		const res = await h.request("/settings.data");
		expect(res.status).toBe(204);
		expect(res.headers.get("x-remix-redirect")).toBe(`/login?next=${encodeURIComponent("/settings")}`);
	});

	it("renders the public pages and static files without a session", async () => {
		const h = build();
		await setupOwner(h);
		for (const path of [
			"/login",
			"/recover",
			"/forgot",
			"/invite/abc",
			"/reset/abc",
			"/login.data",
			"/__manifest?p=/login",
		]) {
			expect((await h.request(path)).status, path).toBe(200);
		}
	});

	it("passes static files through in dev, where Vite rather than the assets layer serves them", async () => {
		const h = build({ isDev: true });
		await setupOwner(h);
		for (const path of ["/assets/entry.client-abc.js", "/favicon.ico", "/icon-192.png"]) {
			expect((await h.request(path)).status, path).toBe(200);
		}
	});

	it("does not render a page dressed up as a static file", async () => {
		// In production a real asset never reaches the Worker, so these can only be
		// attempts to reach the SSR catch-all without a session.
		const h = build();
		await setupOwner(h);
		for (const path of ["/settings.js", "/mail/x.css", "/settings;.css", "/assets/x.js"]) {
			const res = await h.request(path);
			expect(res.status, path).toBe(404);
			expect(await res.text(), path).not.toContain("page");
		}
	});

	it("never treats API paths as static, whatever their extension", async () => {
		for (const isDev of [false, true]) {
			const h = build({ isDev });
			const cookie = await setupOwner(h);
			const { secret } = (await (await h.request("/api/auth/tokens", post({ name: "CLI" }, { cookie }))).json()) as {
				secret: string;
			};
			for (const path of ["/api/v1/mailboxes.js", "/mcp/x.css", "/agents/a/b/x.png", "/api/v1/x.map"]) {
				const anon = await h.request(path);
				expect(anon.status, `${path} dev=${isDev}`).toBe(401);
				expect(await anon.json()).toEqual({ error: "Sign in required", code: "unauthenticated" });
			}
			// And identity is resolved on them rather than stripped.
			const echoed = await h.request("/mcp/x.css", { bearer: secret });
			expect(await echoed.json()).toMatchObject({ identity: { kind: "user", id: OWNER.email } });
			const viaCookie = await h.request("/mcp/x.js", { cookie });
			expect(await viaCookie.json()).toMatchObject({ identity: { kind: "user", id: OWNER.email } });
		}
	});

	it("bounces a signed-in user away from /login", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const res = await h.request("/login", { cookie });
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/");
		expect((await h.request("/settings", { cookie })).status).toBe(200);
	});

	it("ignores a forged or stale cookie", async () => {
		const h = build();
		await setupOwner(h);
		const res = await h.request("/api/v1/me", { cookie: `__Host-tt_session=${"A".repeat(43)}` });
		expect(res.status).toBe(401);
	});
});

// -- identity in the API -----------------------------------------------------

describe("/api/v1/me", () => {
	it("describes the built-in account", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const me = (await (await h.request("/api/v1/me", { cookie })).json()) as Record<string, unknown>;
		expect(me).toMatchObject({
			email: OWNER.email,
			name: OWNER.name,
			role: "admin",
			enforced: true,
			authenticated: true,
			authMode: "password",
			authMethod: "session",
			isOwner: true,
			totpEnabled: false,
		});
		expect(me.userId).toMatch(/^usr_/);
	});
});

// -- API tokens ----------------------------------------------------------------

describe("API tokens", () => {
	it("authenticate as the user and cannot mint further tokens", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const created = await h.request("/api/auth/tokens", post({ name: "CLI" }, { cookie }));
		expect(created.status).toBe(201);
		const { secret, token } = (await created.json()) as { secret: string; token: { id: string } };
		expect(secret).toMatch(/^ttk_[A-Za-z0-9]{12}_[A-Za-z0-9_-]+$/);
		expect(secret.slice(4, 16)).toBe(token.id);

		const me = await h.request("/api/v1/me", { bearer: secret });
		expect(me.status).toBe(200);
		expect(await me.json()).toMatchObject({ email: OWNER.email, authMethod: "token", role: "admin" });

		const mint = await h.request("/api/auth/tokens", post({ name: "again" }, { bearer: secret }));
		expect(mint.status).toBe(403);
		const pw = await h.request(
			"/api/auth/password",
			post({ currentPassword: OWNER.password, newPassword: "another-password-1" }, { bearer: secret }),
		);
		expect(pw.status).toBe(403);

		const list = (await (await h.request("/api/auth/tokens", { cookie })).json()) as { tokens: unknown[] };
		expect(list.tokens).toHaveLength(1);

		expect((await h.request(`/api/auth/tokens/${token.id}`, { method: "DELETE", cookie })).status).toBe(204);
		expect((await h.request("/api/v1/me", { bearer: secret })).status).toBe(401);
	});

	it("refuses a token with the wrong secret", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const { secret } = (await (await h.request("/api/auth/tokens", post({ name: "CLI" }, { cookie }))).json()) as {
			secret: string;
		};
		const forged = `${secret.slice(0, 17)}${"x".repeat(43)}`;
		expect((await h.request("/api/v1/me", { bearer: forged })).status).toBe(401);
	});
});

describe("scoped API tokens", () => {
	async function mint(h: Harness, cookie: string, body: Record<string, unknown>) {
		const res = await h.request("/api/auth/tokens", post({ name: "scoped", ...body }, { cookie }));
		expect(res.status).toBe(201);
		return (await res.json()) as {
			secret: string;
			token: { id: string; scopes: string[] | null; mailboxes: string[] | null; parentId: string | null };
		};
	}

	it("an unscoped token keeps full access, and lists with null scopes", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const { secret, token } = await mint(h, cookie, {});
		expect(token).toMatchObject({ scopes: null, mailboxes: null, parentId: null });
		const me = (await (await h.request("/api/v1/me", { bearer: secret })).json()) as Record<string, unknown>;
		expect(me).toMatchObject({ role: "admin", capabilities: null, mailboxes: null, token: null });
		expect((await h.request("/api/v1/access", { bearer: secret })).status).toBe(200);
	});

	it("a read-only token reads but cannot send, organise or administer", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const { secret } = await mint(h, cookie, { scopes: ["mail:read"] });

		const me = (await (await h.request("/api/v1/me", { bearer: secret })).json()) as Record<string, any>;
		expect(me.role).toBe("member");
		expect(me.token.scopes).toEqual(["mail:read"]);
		expect(me.capabilities).toEqual([{ mailboxId: "*", role: "token", capabilities: ["read"] }]);

		const send = await h.request(
			`/api/v1/mailboxes/${SUPPORT}/emails`,
			post({ to: "x@example.org", from: SUPPORT, subject: "s", text: "t" }, { bearer: secret }),
		);
		expect(send.status).toBe(403);
		expect(await send.json()).toMatchObject({ capabilities: ["sendAs", "sendOnBehalf"] });
		const move = await h.request(`/api/v1/mailboxes/${SUPPORT}/emails/e1/move`, post({ folderId: "archive" }, { bearer: secret }));
		expect(move.status).toBe(403);
		expect(await move.json()).toMatchObject({ capability: "organise" });
		expect((await h.request("/api/v1/access", { bearer: secret })).status).toBe(403);
		const branding = await h.request("/api/v1/branding", { method: "PUT", body: "{}", bearer: secret });
		expect(branding.status).toBe(403);
		const created = await h.request("/api/v1/mailboxes", post({ email: "new@example.com" }, { bearer: secret }));
		expect(created.status).toBe(403);
		// The account itself is out of reach of any scoped token.
		const profile = await h.request("/api/auth/profile", { method: "PATCH", body: JSON.stringify({ name: "X" }), bearer: secret });
		expect(profile.status).toBe(403);
		expect((await h.request("/api/auth/sessions", { bearer: secret })).status).toBe(403);
	});

	it("a mailbox allowlist hides and refuses other mailboxes, even for the owner", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const { secret } = await mint(h, cookie, { mailboxes: [SUPPORT] });
		const boxes = (await (await h.request("/api/v1/mailboxes", { bearer: secret })).json()) as { email: string }[];
		expect(boxes.map((b) => b.email)).toEqual([SUPPORT]);
		expect((await h.request(`/api/v1/mailboxes/${SALES}`, { bearer: secret })).status).toBe(403);
	});

	it("tracks last used time and IP", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const { secret, token } = await mint(h, cookie, { scopes: ["mail:read"] });
		await h.request("/api/v1/me", { bearer: secret });
		const list = (await (await h.request("/api/auth/tokens", { cookie })).json()) as {
			tokens: { id: string; lastUsedAt: number | null; lastUsedIp: string | null }[];
		};
		const row = list.tokens.find((t) => t.id === token.id)!;
		expect(row.lastUsedAt).toBe(h.clock.now);
		expect(row.lastUsedIp).toBe("203.0.113.7");
	});

	it("a scoped token mints only narrower children, and revoking it revokes them", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const parent = await mint(h, cookie, { scopes: ["mail:read", "mail:send"], mailboxes: [SUPPORT], expiresInDays: 30 });

		const wider = await h.request("/api/auth/tokens", post({ name: "c", scopes: ["admin"] }, { bearer: parent.secret }));
		expect(wider.status).toBe(403);
		const otherBox = await h.request(
			"/api/auth/tokens",
			post({ name: "c", scopes: ["mail:read"], mailboxes: [SALES] }, { bearer: parent.secret }),
		);
		expect(otherBox.status).toBe(403);

		const childRes = await h.request(
			"/api/auth/tokens",
			post({ name: "child", scopes: ["mail:read"], expiresInDays: null }, { bearer: parent.secret }),
		);
		expect(childRes.status).toBe(201);
		const child = (await childRes.json()) as { secret: string; token: Record<string, any> };
		// Inherits the parent's mailboxes and never outlives it.
		expect(child.token).toMatchObject({ scopes: ["mail:read"], mailboxes: [SUPPORT], parentId: parent.token.id });
		expect(child.token.expiresAt).toBe(h.clock.now + 30 * 24 * 60 * 60 * 1000);

		// The parent lists itself and its child, not the owner's other tokens.
		await mint(h, cookie, {});
		const seen = (await (await h.request("/api/auth/tokens", { bearer: parent.secret })).json()) as { tokens: { id: string }[] };
		expect(seen.tokens.map((t) => t.id).sort()).toEqual([parent.token.id, child.token.id].sort());

		expect((await h.request(`/api/auth/tokens/${parent.token.id}`, { method: "DELETE", cookie })).status).toBe(204);
		expect((await h.request("/api/v1/me", { bearer: child.secret })).status).toBe(401);
	});

	it("a scoped token cannot revoke a sibling it did not mint", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const a = await mint(h, cookie, { scopes: ["mail:read"] });
		const b = await mint(h, cookie, { scopes: ["mail:read"] });
		expect((await h.request(`/api/auth/tokens/${b.token.id}`, { method: "DELETE", bearer: a.secret })).status).toBe(404);
		expect((await h.request(`/api/auth/tokens/${a.token.id}`, { method: "DELETE", bearer: a.secret })).status).toBe(204);
	});

	it("serves the OpenAPI document and docs page without a sign-in, and nothing else under /api/v1", async () => {
		const h = build();
		await setupOwner(h);
		const spec = await h.request("/api/v1/openapi.json");
		expect(spec.status).toBe(200);
		expect(((await spec.json()) as { openapi: string }).openapi).toBe("3.1.0");
		const docs = await h.request("/api/docs");
		expect(docs.status).toBe(200);
		expect(docs.headers.get("content-type")).toMatch(/text\/html/);
		expect((await h.request("/api/v1/me")).status).toBe(401);
		// A narrowly scoped token still reaches it.
		const cookie = await (async () => {
			const res = await h.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password }));
			return cookieFrom(res);
		})();
		const { secret } = await mint(h, cookie, { scopes: ["mail:send"] });
		expect((await h.request("/api/v1/openapi.json", { bearer: secret })).status).toBe(200);
	});

	it("blocks the reported exploit: a mailbox-only token on the owner account is not an admin", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const { secret, token } = await mint(h, cookie, { mailboxes: [SUPPORT] });
		expect(token.scopes).toBeNull(); // stored as minted

		const me = (await (await h.request("/api/v1/me", { bearer: secret })).json()) as Record<string, any>;
		expect(me.role).toBe("member");
		expect(me.token.scopes).toEqual(["mail:read", "mail:send", "mail:draft", "mail:organize"]);

		const refused: Array<[string, string, unknown?]> = [
			["PUT", "/api/v1/access", { kind: "user", id: "evil@example.com", role: "admin", mailboxes: [] }],
			["GET", "/api/v1/access"],
			["GET", "/api/v1/access/audit"],
			["POST", "/api/v1/mailboxes", { email: "new@example.com", name: "n" }],
			["PUT", "/api/v1/branding", { name: "x" }],
			["DELETE", "/api/v1/domains/example.com"],
			["PATCH", "/api/v1/domains/example.com", { catchAllMailbox: SUPPORT }],
			["POST", `/api/v1/_migrate/mailboxes/${SUPPORT}`],
			["PUT", `/api/v1/mailboxes/${SUPPORT}`, { forwarding: { enabled: true, email: "x@evil.example" } }],
		];
		for (const [method, path, body] of refused) {
			const res = await h.request(path, { method, bearer: secret, ...(body ? { body: JSON.stringify(body) } : {}) });
			const json = (await res.json()) as { code?: string; capability?: string; error?: string };
			// Refused by the token checks themselves, not by something incidental:
			// the scope guard, or the manageSettings capability gate.
			const byScope = json.code === "insufficient_scope" || json.capability === "manageSettings";
			expect({ method, path, status: res.status, byScope }).toEqual({ method, path, status: 403, byScope: true });
		}
		// Admin user listing under /api/auth/admin is refused too.
		expect((await h.request("/api/auth/admin/users", { bearer: secret })).status).toBe(403);
		// And it cannot mint itself an admin child.
		const child = await h.request("/api/auth/tokens", post({ name: "c", scopes: ["admin"] }, { bearer: secret }));
		expect(child.status).toBe(403);

		// Its own mailbox still works.
		expect((await h.request(`/api/v1/mailboxes/${SUPPORT}`, { bearer: secret })).status).toBe(200);
		expect((await h.request(`/api/v1/mailboxes/${SALES}`, { bearer: secret })).status).toBe(403);
		// The grants were not touched.
		expect(h.bucket._store.has("access/users/evil@example.com.json")).toBe(false);
	});

	it("an explicit admin scope with a mailbox allowlist does administer", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const { secret } = await mint(h, cookie, { scopes: ["admin", "mail:read"], mailboxes: [SUPPORT] });
		expect((await h.request("/api/v1/access", { bearer: secret })).status).toBe(200);
	});

	it("refuses a child minted after its parent was revoked mid-request (store re-check)", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const parent = await mint(h, cookie, { scopes: ["mail:read"] });
		// The parent authenticates, then is revoked before the insert runs.
		const original = h.store.createApiToken.bind(h.store);
		h.store.createApiToken = async (input) => {
			await h.store.revokeApiToken(input.userId, parent.token.id);
			return original(input);
		};
		const res = await h.request("/api/auth/tokens", post({ name: "late" }, { bearer: parent.secret }));
		h.store.createApiToken = original;
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ code: "parent_token_inactive" });
		const tokens = (await (await h.request("/api/auth/tokens", { cookie })).json()) as { tokens: { name: string }[] };
		expect(tokens.tokens.map((t) => t.name)).not.toContain("late");
	});

	it("the store refuses an expired or foreign parent directly", async () => {
		const h = build();
		await setupOwner(h);
		const owner = (await h.store.listUsers())[0]!;
		const parent = await h.store.createApiToken({
			id: "parentAAAAAA", userId: owner.id, name: "p", secretHash: "h", expiresAt: h.clock.now + 1000,
			now: h.clock.now, scopes: ["mail:read"],
		});
		const child = (over: Partial<Parameters<typeof h.store.createApiToken>[0]>) =>
			h.store.createApiToken({
				id: "childBBBBBBB", userId: owner.id, name: "c", secretHash: "h2", expiresAt: null,
				now: h.clock.now, scopes: ["mail:read"], parentId: parent.id, ...over,
			});
		await expect(child({ now: h.clock.now + 2000 })).rejects.toThrow("parent_token_inactive");
		await expect(child({ userId: "usr_someoneelse" })).rejects.toThrow("parent_token_inactive");
		await expect(child({})).resolves.toMatchObject({ parentId: parent.id });
	});

	it("rejects unknown scopes", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const res = await h.request("/api/auth/tokens", post({ name: "x", scopes: ["mail:everything"] }, { cookie }));
		expect(res.status).toBe(400);
	});

	it("/me reports the intersection when both scopes and mailboxes are set", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const { secret } = await mint(h, cookie, { scopes: ["mail:read"], mailboxes: [SUPPORT] });
		const me = (await (await h.request("/api/v1/me", { bearer: secret })).json()) as Record<string, any>;
		expect(me.mailboxes).toEqual([SUPPORT]);
		expect(me.capabilities).toEqual([{ mailboxId: SUPPORT, role: "owner", capabilities: ["read"] }]);
	});
});

// -- members, invites and administration -----------------------------------

describe("invites and members", () => {
	it("an accepted invite writes the grant, and the member sees only granted mailboxes", async () => {
		const h = build();
		const owner = await setupOwner(h);

		const created = await h.request(
			"/api/auth/admin/invites",
			post({ email: "Member@Example.com", role: "member", mailboxes: [SUPPORT] }, { cookie: owner }),
		);
		const { url, invite } = (await created.json()) as { url: string; invite: { id: string } };
		expect(url).toMatch(new RegExp(`^${ORIGIN}/invite/[A-Za-z0-9_-]+$`));
		const token = url.split("/invite/")[1];

		const peek = await h.request(`/api/auth/invites/${token}`);
		expect(await peek.json()).toMatchObject({ email: "member@example.com", role: "member" });
		expect(invite.id).toMatch(/^inv_/);

		const weak = await h.request("/api/auth/invites/accept", post({ token, name: "M", password: "short" }));
		expect(await weak.json()).toMatchObject({ code: "weak_password" });

		const accepted = await h.request(
			"/api/auth/invites/accept",
			post({ token, name: "Mia Member", password: "member-password-1" }),
		);
		expect(accepted.status).toBe(200);
		const member = cookieFrom(accepted);

		const grant = JSON.parse(h.bucket._store.get("access/users/member@example.com.json")!);
		expect(grant).toMatchObject({ id: "member@example.com", kind: "user", role: "member", mailboxes: [SUPPORT] });

		const boxes = (await (await h.request("/api/v1/mailboxes", { cookie: member })).json()) as { email: string }[];
		expect(boxes.map((b) => b.email)).toEqual([SUPPORT]);
		expect((await h.request(`/api/v1/mailboxes/${SALES}`, { cookie: member })).status).toBe(403);

		const me = (await (await h.request("/api/v1/me", { cookie: member })).json()) as Record<string, unknown>;
		expect(me).toMatchObject({ role: "member", enforced: true, isOwner: false, name: "Mia Member" });

		// Single use.
		const reuse = await h.request(
			"/api/auth/invites/accept",
			post({ token, name: "Again", password: "member-password-1" }),
		);
		expect(reuse.status).toBe(404);
	});

	it("an admin invite yields an admin grant", async () => {
		const h = build();
		const owner = await setupOwner(h);
		const admin = await inviteMember(h, owner, { email: "ops@example.com", role: "admin" });
		const grant = JSON.parse(h.bucket._store.get("access/users/ops@example.com.json")!);
		expect(grant.role).toBe("admin");
		expect((await h.request("/api/auth/admin/users", { cookie: admin })).status).toBe(200);
	});

	it("refuses administration to a member", async () => {
		const h = build();
		const owner = await setupOwner(h);
		const member = await inviteMember(h, owner, { email: "member@example.com", mailboxes: [SUPPORT] });
		for (const [path, init] of [
			["/api/auth/admin/users", {}],
			["/api/auth/admin/invites", {}],
			["/api/auth/admin/invites", post({ email: "x@example.com", role: "admin" })],
		] as const) {
			const res = await h.request(path, { ...init, cookie: member });
			expect(res.status, path).toBe(403);
		}
	});

	it("lists users with their computed admin flag", async () => {
		const h = build({ env: { ADMIN_EMAILS: "boss@example.com" } });
		const owner = await setupOwner(h);
		await inviteMember(h, owner, { email: "member@example.com", mailboxes: [SUPPORT] });
		await inviteMember(h, owner, { email: "boss@example.com" });
		const { users } = (await (await h.request("/api/auth/admin/users", { cookie: owner })).json()) as {
			users: { email: string; isAdmin: boolean }[];
		};
		const byEmail = Object.fromEntries(users.map((u) => [u.email, u.isAdmin]));
		expect(byEmail).toEqual({ [OWNER.email]: true, "member@example.com": false, "boss@example.com": true });
	});

	it("disables and deletes members but never the owner or oneself", async () => {
		const h = build();
		const owner = await setupOwner(h);
		const member = await inviteMember(h, owner, { email: "member@example.com", mailboxes: [SUPPORT] });
		const { users } = (await (await h.request("/api/auth/admin/users", { cookie: owner })).json()) as {
			users: { id: string; email: string; isOwner: boolean }[];
		};
		const ownerId = users.find((u) => u.isOwner)!.id;
		const memberId = users.find((u) => u.email === "member@example.com")!.id;

		expect((await h.request(`/api/auth/admin/users/${ownerId}`, { method: "DELETE", cookie: owner })).status).toBe(400);

		const disable = await h.request(`/api/auth/admin/users/${memberId}/disable`, post({ disabled: true }, { cookie: owner }));
		expect(disable.status).toBe(204);
		expect((await h.request("/api/v1/me", { cookie: member })).status).toBe(401);

		const del = await h.request(`/api/auth/admin/users/${memberId}`, { method: "DELETE", cookie: owner });
		expect(del.status).toBe(204);
		expect(h.bucket._store.has("access/users/member@example.com.json")).toBe(false);
	});

	it("issues a one-hour reset link that sets the password and ends sessions", async () => {
		const h = build();
		const owner = await setupOwner(h);
		const member = await inviteMember(h, owner, { email: "member@example.com", mailboxes: [SUPPORT] });
		const { users } = (await (await h.request("/api/auth/admin/users", { cookie: owner })).json()) as {
			users: { id: string; email: string }[];
		};
		const memberId = users.find((u) => u.email === "member@example.com")!.id;

		const link = await h.request(`/api/auth/admin/users/${memberId}/reset-link`, post({}, { cookie: owner }));
		const { url, expiresAt } = (await link.json()) as { url: string; expiresAt: number };
		expect(expiresAt - h.clock.now).toBe(60 * 60 * 1000);
		const token = url.split("/reset/")[1];

		expect(await (await h.request(`/api/auth/reset/${token}`)).json()).toEqual({ email: "member@example.com" });
		expect((await h.request("/api/auth/reset", post({ token, password: "tiny" }))).status).toBe(400);
		expect((await h.request("/api/auth/reset", post({ token, password: "brand-new-password" }))).status).toBe(204);
		expect((await h.request("/api/v1/me", { cookie: member })).status).toBe(401);
		expect((await h.request("/api/auth/reset", post({ token, password: "brand-new-password" }))).status).toBe(404);

		const login = await h.request("/api/auth/login", post({ email: "member@example.com", password: "brand-new-password" }));
		expect(login.status).toBe(200);
	});

	it("refuses every admin change made with an API token, but allows listing", async () => {
		const h = build();
		const owner = await setupOwner(h);
		await inviteMember(h, owner, { email: "member@example.com", mailboxes: [SUPPORT] });
		const { secret } = (await (await h.request("/api/auth/tokens", post({ name: "CLI" }, { cookie: owner }))).json()) as {
			secret: string;
		};
		const { users } = (await (await h.request("/api/auth/admin/users", { bearer: secret })).json()) as {
			users: { id: string; email: string; isOwner: boolean }[];
		};
		expect(users).toHaveLength(2);
		expect((await h.request("/api/auth/admin/invites", { bearer: secret })).status).toBe(200);

		const ownerId = users.find((u) => u.isOwner)!.id;
		const memberId = users.find((u) => u.email === "member@example.com")!.id;
		for (const [path, init] of [
			["/api/auth/admin/invites", post({ email: "evil@example.com", role: "admin" })],
			["/api/auth/admin/invites/inv_x", { method: "DELETE" }],
			[`/api/auth/admin/users/${ownerId}/reset-link`, post({})],
			[`/api/auth/admin/users/${memberId}/reset-link`, post({})],
			[`/api/auth/admin/users/${memberId}/disable`, post({ disabled: true })],
			[`/api/auth/admin/users/${memberId}`, { method: "DELETE" }],
			["/api/auth/sessions/revoke-others", post({})],
			["/api/auth/sessions/ses_x", { method: "DELETE" }],
		] as const) {
			const res = await h.request(path, { ...init, bearer: secret });
			expect(res.status, path).toBe(403);
			expect(await res.json(), path).toMatchObject({ code: "session_required" });
		}
		// Nothing happened.
		expect((await h.request("/api/v1/me", { cookie: owner })).status).toBe(200);
		expect((await h.store.getUser(memberId))!.disabled).toBe(false);
		expect(await h.store.listInvites(h.clock.now)).toEqual([]);
	});

	it("only the owner can mint a reset link for the owner, and nobody for themselves", async () => {
		const h = build();
		const owner = await setupOwner(h);
		const admin = await inviteMember(h, owner, { email: "ops@example.com", role: "admin" });
		const member = await inviteMember(h, owner, { email: "member@example.com", mailboxes: [SUPPORT] });
		void member;
		const { users } = (await (await h.request("/api/auth/admin/users", { cookie: owner })).json()) as {
			users: { id: string; email: string; isOwner: boolean }[];
		};
		const ownerId = users.find((u) => u.isOwner)!.id;
		const adminId = users.find((u) => u.email === "ops@example.com")!.id;
		const memberId = users.find((u) => u.email === "member@example.com")!.id;

		const onOwner = await h.request(`/api/auth/admin/users/${ownerId}/reset-link`, post({}, { cookie: admin }));
		expect(onOwner.status).toBe(403);
		expect(await onOwner.json()).toMatchObject({ code: "owner_protected" });

		const self = await h.request(`/api/auth/admin/users/${adminId}/reset-link`, post({}, { cookie: admin }));
		expect(self.status).toBe(400);
		expect(await self.json()).toMatchObject({ code: "self_protected" });
		const ownerSelf = await h.request(`/api/auth/admin/users/${ownerId}/reset-link`, post({}, { cookie: owner }));
		expect(await ownerSelf.json()).toMatchObject({ code: "self_protected" });

		expect((await h.request(`/api/auth/admin/users/${memberId}/reset-link`, post({}, { cookie: admin }))).status).toBe(200);
		expect((await h.request(`/api/auth/admin/users/${adminId}/reset-link`, post({}, { cookie: owner }))).status).toBe(200);
	});

	it("uses APP_URL for links when configured", async () => {
		const h = build({ env: { APP_URL: "https://inbox.example.org/" } });
		const owner = await setupOwner(h);
		const created = await h.request("/api/auth/admin/invites", post({ email: "x@example.com", role: "member" }, { cookie: owner }));
		const { url } = (await created.json()) as { url: string };
		expect(url.startsWith("https://inbox.example.org/invite/")).toBe(true);
	});
});

// -- account self-service ---------------------------------------------------

describe("account", () => {
	it("changing the password keeps this session and ends the others", async () => {
		const h = build();
		const here = await setupOwner(h);
		const elsewhere = cookieFrom(
			await h.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password })),
		);

		const wrong = await h.request(
			"/api/auth/password",
			post({ currentPassword: "not-it-at-all", newPassword: "fresh-password-1" }, { cookie: here }),
		);
		expect(await wrong.json()).toMatchObject({ code: "wrong_password" });

		const ok = await h.request(
			"/api/auth/password",
			post({ currentPassword: OWNER.password, newPassword: "fresh-password-1" }, { cookie: here }),
		);
		expect(ok.status).toBe(204);
		expect((await h.request("/api/v1/me", { cookie: here })).status).toBe(200);
		expect((await h.request("/api/v1/me", { cookie: elsewhere })).status).toBe(401);
	});

	it("lists sessions with the current one marked", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		await h.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password }));
		const { sessions } = (await (await h.request("/api/auth/sessions", { cookie })).json()) as {
			sessions: { id: string; current: boolean }[];
		};
		expect(sessions).toHaveLength(2);
		expect(sessions.filter((s) => s.current)).toHaveLength(1);

		const other = sessions.find((s) => !s.current)!;
		expect((await h.request(`/api/auth/sessions/${other.id}`, { method: "DELETE", cookie })).status).toBe(204);
		const revoke = await h.request("/api/auth/sessions/revoke-others", post({}, { cookie }));
		expect(await revoke.json()).toEqual({ revoked: 0 });
	});

	it("updates the display name", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const res = await h.request("/api/auth/profile", { method: "PATCH", body: JSON.stringify({ name: "O. Owner" }), cookie });
		expect(await res.json()).toMatchObject({ user: { name: "O. Owner" } });
	});

	it("requires a session for the authenticated endpoints", async () => {
		const h = build();
		await setupOwner(h);
		const res = await h.request("/api/auth/sessions");
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({ code: "unauthenticated" });
	});
});

// -- recovery and Turnstile -------------------------------------------------

describe("break-glass recovery", () => {
	it("resets the owner's password with the configured SETUP_TOKEN", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		expect((await h.request("/api/auth/recover", post({ setupToken: "wrong", password: "recovered-pass-1" }))).status).toBe(403);
		expect((await h.request("/api/auth/recover", post({ setupToken: SETUP_TOKEN, password: "short" }))).status).toBe(400);
		const ok = await h.request("/api/auth/recover", post({ setupToken: SETUP_TOKEN, password: "recovered-pass-1" }));
		expect(ok.status).toBe(204);
		expect((await h.request("/api/v1/me", { cookie })).status).toBe(401);
		expect(
			(await h.request("/api/auth/login", post({ email: OWNER.email, password: "recovered-pass-1" }))).status,
		).toBe(200);
	});

	it("closes globally after 10 wrong tokens in an hour, across IPs and without the rate limiter", async () => {
		const h = build();
		await setupOwner(h);
		const { vi } = await import("vitest");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			for (let i = 0; i < 9; i++) {
				const res = await h.request(
					"/api/auth/recover",
					post({ setupToken: `wrong-${i}`, password: "recovered-pass-1" }, { headers: { "cf-connecting-ip": `10.0.0.${i}` } }),
				);
				expect(res.status).toBe(403);
			}
			const tenth = await h.request("/api/auth/recover", post({ setupToken: "wrong-x", password: "recovered-pass-1" }));
			expect(tenth.status).toBe(423);
			expect(await tenth.json()).toMatchObject({ code: "locked", retryAfter: 3600 });
			expect(warn.mock.calls.filter((c) => String(c[0]).includes("Failed owner recovery")).length).toBe(10);

			// Closed even for the right token, from anywhere.
			const right = await h.request(
				"/api/auth/recover",
				post({ setupToken: SETUP_TOKEN, password: "recovered-pass-1" }, { headers: { "cf-connecting-ip": "192.0.2.1" } }),
			);
			expect(right.status).toBe(423);

			h.clock.now += 60 * 60 * 1000;
			expect((await h.request("/api/auth/recover", post({ setupToken: SETUP_TOKEN, password: "recovered-pass-1" }))).status).toBe(204);
		} finally {
			warn.mockRestore();
		}
	});

	it("charges a global rate limiter key", async () => {
		const keys: string[] = [];
		const h = build({
			limiter: (key) => {
				keys.push(key);
				return key !== "auth:recover:global";
			},
		});
		await setupOwner(h);
		const res = await h.request("/api/auth/recover", post({ setupToken: SETUP_TOKEN, password: "recovered-pass-1" }));
		expect(res.status).toBe(429);
		expect(keys).toContain("auth:recover:global");
	});

	it("is unavailable when SETUP_TOKEN is shorter than 16 characters", async () => {
		const h = build({ env: { SETUP_TOKEN: "short-token-15c" } });
		await h.request("/api/auth/setup", post({ setupToken: "short-token-15c", ...OWNER }));
		const { vi } = await import("vitest");
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const res = await h.request("/api/auth/recover", post({ setupToken: "short-token-15c", password: "recovered-pass-1" }));
			expect(res.status).toBe(404);
			expect(await res.json()).toMatchObject({ code: "recovery_unavailable" });
			expect(error.mock.calls.some((c) => String(c[0]).includes("shorter than 16"))).toBe(true);
		} finally {
			error.mockRestore();
		}
	});

	it("is unavailable with only a generated token", async () => {
		const h = build({ env: { SETUP_TOKEN: undefined } });
		const generated = await h.store.ensureGeneratedSetupToken();
		await h.request("/api/auth/setup", post({ setupToken: generated, ...OWNER }));
		const res = await h.request("/api/auth/recover", post({ setupToken: generated, password: "recovered-pass-1" }));
		expect(res.status).toBe(404);
	});
});

describe("Turnstile", () => {
	it("requires a token on login when configured", async () => {
		const h = build({ env: { TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" } });
		const state = (await (await h.request("/api/auth/state")).json()) as { turnstileSiteKey: string };
		expect(state.turnstileSiteKey).toBe("site");
		const res = await h.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password }));
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "turnstile_required" });
	});

	it("fails closed when siteverify errors", async () => {
		const { verifyTurnstile } = await import("../workers/auth/turnstile");
		const env = { TURNSTILE_SITE_KEY: "s", TURNSTILE_SECRET_KEY: "k" };
		const failing = (async () => {
			throw new Error("network");
		}) as unknown as typeof fetch;
		expect(await verifyTurnstile(env, "tok", "1.2.3.4", failing)).toBe(false);
		const ok = (async () => new Response(JSON.stringify({ success: true }))) as unknown as typeof fetch;
		expect(await verifyTurnstile(env, "tok", "1.2.3.4", ok)).toBe(true);
		expect(await verifyTurnstile({}, null, null)).toBe(true);
	});
});

describe("access mode", () => {
	it("keeps the Access check in front of everything in production", async () => {
		const h = build({ env: { AUTH_MODE: "access", POLICY_AUD: "aud", TEAM_DOMAIN: "https://team.cloudflareaccess.com" } });
		expect((await h.request("/api/auth/state")).status).toBe(403);
		expect((await h.request("/api/v1/me")).status).toBe(403);
	});

	it("hides the account endpoints but still answers state", async () => {
		// Development build: Access is bypassed, so the routes themselves answer.
		const h = build({ env: { AUTH_MODE: "access" }, isDev: true });
		const state = await h.request("/api/auth/state");
		expect(await state.json()).toMatchObject({ mode: "access", setupRequired: false, authenticated: true });
		expect((await h.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password }))).status).toBe(404);
	});
});

// -- password reset by email -------------------------------------------------

describe("password reset by email", () => {
	const forgot = (h: Harness, address: string, extra: Record<string, unknown> = {}) =>
		h.request("/api/auth/password/forgot", post({ email: address, ...extra }));

	it("answers an unknown address exactly like a real one, and emails only the real one", async () => {
		const h = build();
		await setupOwner(h);

		const real = await forgot(h, OWNER.email);
		const unknown = await forgot(h, "nobody@example.com");
		expect(real.status).toBe(202);
		expect(unknown.status).toBe(202);
		expect(await real.text()).toBe(await unknown.text());
		expect(real.headers.get("set-cookie")).toBeNull();

		// Nothing is sent before the response: the work is all in waitUntil.
		expect(h.sent).toHaveLength(0);
		await h.settle();
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0].to).toBe(OWNER.email);
		expect(h.sent[0].subject).toBe("Reset your cloudmail password");
		expect(h.sent[0].text).toContain(`${ORIGIN}/reset/`);
		expect(h.sent[0].text).toContain("30 minutes");
		// No request metadata in the message.
		expect(h.sent[0].text).not.toContain("203.0.113.7");
		expect(h.sent[0].html).not.toContain("203.0.113.7");
	});

	it("sends a working, single-use link that signs every session out", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		await forgot(h, OWNER.email.toUpperCase());
		await h.settle();
		const token = resetTokenFrom(h.sent[0]);

		const info = await h.request(`/api/auth/reset/${token}`);
		expect(await info.json()).toEqual({ email: OWNER.email });

		const reset = await h.request("/api/auth/reset", post({ token, password: "brand-new-pass-1" }));
		expect(reset.status).toBe(204);
		expect((await h.request("/api/v1/me", { cookie })).status).toBe(401);

		const again = await h.request("/api/auth/reset", post({ token, password: "another-pass-12" }));
		expect(again.status).toBe(404);

		const login = await h.request("/api/auth/login", post({ email: OWNER.email, password: "brand-new-pass-1" }));
		expect(login.status).toBe(200);
	});

	it("expires the link after 30 minutes and replaces earlier ones", async () => {
		const h = build();
		await setupOwner(h);
		await forgot(h, OWNER.email);
		await h.settle();
		await forgot(h, OWNER.email);
		await h.settle();
		const [first, second] = h.sent.map(resetTokenFrom);
		expect((await h.request(`/api/auth/reset/${first}`)).status).toBe(404);
		expect((await h.request(`/api/auth/reset/${second}`)).status).toBe(200);

		h.clock.now += 30 * 60_000;
		expect((await h.request(`/api/auth/reset/${second}`)).status).toBe(404);
	});

	it("caps reset emails at three an hour per account, without invalidating the last link", async () => {
		const h = build();
		await setupOwner(h);
		for (let i = 0; i < 5; i++) {
			expect((await forgot(h, OWNER.email)).status).toBe(202);
			await h.settle();
			h.clock.now += 1000;
		}
		expect(h.sent).toHaveLength(3);
		expect((await h.request(`/api/auth/reset/${resetTokenFrom(h.sent[2])}`)).status).toBe(200);

		h.clock.now += 60 * 60_000;
		await forgot(h, OWNER.email);
		await h.settle();
		expect(h.sent).toHaveLength(4);
	});

	it("rate limits per IP and per address, identically for unknown addresses", async () => {
		const seen: string[] = [];
		const h = build({
			limiter: (key) => {
				seen.push(key);
				return !key.includes("forgot:email:nobody@example.com");
			},
		});
		await setupOwner(h);
		expect((await forgot(h, OWNER.email)).status).toBe(202);
		expect(seen).toContain("auth:forgot:ip:203.0.113.7");
		expect(seen).toContain(`auth:forgot:email:${OWNER.email}`);
		const limited = await forgot(h, "Nobody@Example.com");
		expect(limited.status).toBe(429);
		expect(await limited.json()).toMatchObject({ code: "rate_limited" });
	});

	it("sends nothing to a disabled account", async () => {
		const h = build();
		const owner = await setupOwner(h);
		await inviteMember(h, owner, { email: "member@example.com", mailboxes: [SUPPORT] });
		const member = (await h.store.getUserByEmail("member@example.com"))!;
		const disabled = await h.request(
			`/api/auth/admin/users/${member.id}/disable`,
			post({ disabled: true }, { cookie: owner }),
		);
		expect(disabled.status).toBe(204);

		const res = await forgot(h, "member@example.com");
		expect(res.status).toBe(202);
		await h.settle();
		expect(h.sent).toHaveLength(0);
	});

	it("leaves the owner's two-factor sign-in on", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const setup = await h.request("/api/auth/2fa/setup", post({ password: OWNER.password }, { cookie }));
		const { secret } = (await setup.json()) as { secret: string };
		const enable = await h.request(
			"/api/auth/2fa/enable",
			post({ code: await currentTotp(secret, h.clock.now) }, { cookie }),
		);
		expect(enable.status).toBe(200);

		await forgot(h, OWNER.email);
		await h.settle();
		const token = resetTokenFrom(h.sent[0]);
		expect((await h.request("/api/auth/reset", post({ token, password: "brand-new-pass-1" }))).status).toBe(204);

		const login = await h.request("/api/auth/login", post({ email: OWNER.email, password: "brand-new-pass-1" }));
		expect(await login.json()).toMatchObject({ status: "mfa_required" });
	});

	it("requires Turnstile when configured", async () => {
		const h = build({ env: { TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" } });
		const res = await forgot(h, OWNER.email);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "turnstile_required" });
		await h.settle();
		expect(h.sent).toHaveLength(0);
	});

	it("derives the sender from DOMAINS, or uses AUTH_EMAIL_FROM", async () => {
		const derived = build({ env: { DOMAINS: "Mail.Example.com, other.example" } as Partial<Env> });
		await setupOwner(derived);
		await forgot(derived, OWNER.email);
		await derived.settle();
		expect(derived.sent[0].from).toEqual({ email: "no-reply@mail.example.com", name: "cloudmail" });

		const configured = build({ env: { AUTH_EMAIL_FROM: '"Acme Support" <Help@Acme.example>' } });
		await setupOwner(configured);
		await forgot(configured, OWNER.email);
		await configured.settle();
		expect(configured.sent[0].from).toEqual({ email: "help@acme.example", name: "Acme Support" });
	});

	it("reports the feature off, and refuses, when there is no sender", async () => {
		const h = build({ env: { DOMAINS: "" } as Partial<Env> });
		await setupOwner(h);
		const state = (await (await h.request("/api/auth/state")).json()) as { passwordResetByEmail: boolean };
		expect(state.passwordResetByEmail).toBe(false);
		const res = await forgot(h, OWNER.email);
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ code: "not_enabled" });
		await h.settle();
		expect(h.sent).toHaveLength(0);

		const on = build();
		const onState = (await (await on.request("/api/auth/state")).json()) as { passwordResetByEmail: boolean };
		expect(onState.passwordResetByEmail).toBe(true);
	});

	it("escapes the branded app name in the email", async () => {
		const h = build();
		await setupOwner(h);
		const { BRANDING_KEY } = await import("../workers/lib/branding");
		await h.bucket.put(
			BRANDING_KEY,
			JSON.stringify({ appName: `<script>alert("x")</script> & Co`, updatedAt: 1 }),
		);
		await forgot(h, OWNER.email);
		await h.settle();
		const { html, subject } = h.sent[0];
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co");
		expect(subject).not.toMatch(/[\r\n]/);
	});

	it("stores nothing in any mailbox", async () => {
		const h = build();
		await setupOwner(h);
		const before = [...h.bucket._store.keys()].sort();
		await forgot(h, OWNER.email);
		await h.settle();
		expect(h.sent).toHaveLength(1);
		// The harness MAILBOX.get() stub has no methods: a Sent-folder write or a
		// mailbox send-limit check would have thrown inside waitUntil, and the
		// send (which comes last) would never have happened.
		expect([...h.bucket._store.keys()].sort()).toEqual(before);
	});
});
