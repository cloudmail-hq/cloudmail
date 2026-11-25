/**
 * Passkeys over HTTP: registration (with the recent-sign-in requirement),
 * usernameless sign-in, the passkey second factor, and management.
 *
 * Most tests drive the real `@simplewebauthn/server` verification with a
 * software ES256 authenticator (`helpers/soft-authenticator.ts`), so the
 * signatures, origin and rpID checks, user verification and counter handling
 * are the library's own. A few stub the verifier through `AuthDeps.webauthn`
 * to pin down how the routes treat its answers.
 *
 * Storage is the real `AuthStore` over `node:sqlite`, assembled the way
 * `workers/app.ts` assembles the auth layer.
 */

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthGate, createAuthenticate, type AuthDeps } from "../workers/auth/middleware";
import { PASSKEY_REAUTH_MS, relyingParty, type WebAuthnVerifier } from "../workers/auth/passkeys";
import { createAuthRoutes, FACTOR_STEP_UP_MS } from "../workers/auth/routes";
import { AuthStore, WEBAUTHN_CHALLENGE_MS, type AuthSql } from "../workers/auth/store-core";
import { base32Decode, hotp, totpStep } from "../workers/auth/totp";
import { sha256Hex } from "../workers/auth/crypto";
import { csrfGuard } from "../workers/lib/csrf";
import type { MailboxContext } from "../workers/lib/mailbox";
import type { Env } from "../workers/types";
import { SoftAuthenticator } from "./helpers/soft-authenticator";

const ORIGIN = "https://mail.example.com";
const RP_ID = "mail.example.com";
const SETUP_TOKEN = "correct-horse-battery-staple";
const OWNER = { email: "owner@example.com", name: "Olivia Owner", password: "owner-password-1" };

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

function fakeBucket() {
	const store = new Map<string, string>();
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
	};
}

type Init = RequestInit & { cookie?: string | null; bearer?: string; origin?: string };

interface Harness {
	request: (path: string, init?: Init) => Promise<Response>;
	store: AuthStore;
	clock: { now: number };
	env: Env;
	limited: string[];
	/** Security notices handed to the fake `EMAIL` binding. */
	sent: { to: string; subject: string; text: string; html: string }[];
	/** Wait for everything the routes passed to `waitUntil`. */
	settle: () => Promise<void>;
}

function build(options: { env?: Partial<Env>; webauthn?: WebAuthnVerifier; limiter?: (key: string) => boolean } = {}): Harness {
	const store = sqliteStore();
	const clock = { now: Date.UTC(2026, 5, 1) };
	const limited: string[] = [];
	const sent: Harness["sent"] = [];
	const env = {
		EMAIL: {
			async send(message: Harness["sent"][number]) {
				sent.push(message);
				return { messageId: `msg-${sent.length}` };
			},
		},
		DOMAINS: "example.com",
		SETUP_TOKEN,
		AUTH_SECRET: "test-auth-secret",
		BUCKET: fakeBucket(),
		AUTH_STORE: {},
		AUTH_RATE_LIMITER: {
			limit: async ({ key }: { key: string }) => {
				limited.push(key);
				return { success: options.limiter ? options.limiter(key) : true };
			},
		},
		...options.env,
	} as unknown as Env;

	const deps: AuthDeps = {
		getStore: () => store,
		isDev: false,
		now: () => clock.now,
		...(options.webauthn ? { webauthn: options.webauthn } : {}),
	};
	const app = new Hono<MailboxContext>();
	app.use("*", csrfGuard);
	app.use("*", createAuthenticate(deps));
	app.route("/api/auth", createAuthRoutes(deps));
	app.use("*", createAuthGate(deps));
	// Echoes how the request authenticated: the OAuth consent page and every
	// session-only action branch on exactly this.
	app.get("/api/v1/whoami", (c) => c.json({ authMethod: c.var.authMethod ?? null }));
	app.all("*", (c) => c.html("<html>page</html>"));

	const pending: Promise<unknown>[] = [];
	const executionCtx = {
		waitUntil: (promise: Promise<unknown>) => {
			pending.push(promise);
		},
		passThroughOnException: () => undefined,
	} as unknown as ExecutionContext;
	const settle = async () => {
		while (pending.length) await Promise.all(pending.splice(0));
	};
	const request: Harness["request"] = (path, init = {}) => {
		const { cookie, bearer, origin, ...rest } = init;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"Sec-Fetch-Site": "same-origin",
			"cf-connecting-ip": "203.0.113.7",
			...(rest.headers as Record<string, string>),
		};
		if (cookie) headers.Cookie = cookie;
		if (bearer) headers.Authorization = `Bearer ${bearer}`;
		return Promise.resolve(app.fetch(new Request(`${origin ?? ORIGIN}${path}`, { ...rest, headers }), env, executionCtx));
	};
	return { request, store, clock, env, limited, sent, settle };
}

function post(body: unknown, extra: Init = {}): Init {
	return { method: "POST", body: JSON.stringify(body), ...extra };
}

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

async function registerOptions(h: Harness, cookie: string) {
	const res = await h.request("/api/auth/passkeys/register/options", post({}, { cookie }));
	expect(res.status).toBe(200);
	return ((await res.json()) as { options: any }).options;
}

/** Register a fresh software passkey for the signed-in user. */
async function enrol(h: Harness, cookie: string, auth = new SoftAuthenticator({ origin: ORIGIN, rpID: RP_ID })) {
	const options = await registerOptions(h, cookie);
	const res = await h.request(
		"/api/auth/passkeys/register/verify",
		post({ response: auth.register(options), name: "Laptop" }, { cookie }),
	);
	expect(res.status).toBe(201);
	return { auth, passkey: ((await res.json()) as { passkey: any }).passkey };
}

/** Step up with an existing passkey (`POST /passkeys/reauth`). */
async function reauthWithPasskey(h: Harness, cookie: string, auth: SoftAuthenticator) {
	const opts = await h.request("/api/auth/passkeys/reauth/options", post({}, { cookie }));
	expect(opts.status).toBe(200);
	const { options } = (await opts.json()) as { options: any };
	const res = await h.request("/api/auth/passkeys/reauth", post({ response: auth.authenticate(options) }, { cookie }));
	expect(res.status).toBe(200);
}

async function loginOptions(h: Harness) {
	const res = await h.request("/api/auth/passkeys/login/options", post({}));
	expect(res.status).toBe(200);
	return ((await res.json()) as { options: any }).options;
}

// -- relying party -------------------------------------------------------------

describe("relying party", () => {
	it("uses APP_URL when set, else the request origin", () => {
		expect(relyingParty({}, "https://mail.example.com/api/auth/x")).toEqual({
			rpID: "mail.example.com",
			origin: "https://mail.example.com",
		});
		expect(relyingParty({ APP_URL: "https://inbox.example.org/app/" }, "https://other.workers.dev/x")).toEqual({
			rpID: "inbox.example.org",
			origin: "https://inbox.example.org",
		});
		expect(relyingParty({ APP_URL: "not a url" }, "http://localhost:5173/x")).toEqual({
			rpID: "localhost",
			origin: "http://localhost:5173",
		});
	});
});

// -- registration ----------------------------------------------------------------

describe("passkey registration", () => {
	let h: Harness;
	let cookie: string;
	beforeEach(async () => {
		h = build();
		cookie = await setupOwner(h);
	});

	it("registers a passkey with the real verifier and lists it", async () => {
		const options = await registerOptions(h, cookie);
		expect(options.rp.id).toBe(RP_ID);
		expect(options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
		expect(options.attestation).toBe("none");
		// The user handle is the account id, never the email.
		expect(Buffer.from(options.user.id, "base64url").toString()).toMatch(/^usr_/);

		const auth = new SoftAuthenticator({ origin: ORIGIN, rpID: RP_ID });
		const res = await h.request(
			"/api/auth/passkeys/register/verify",
			post({ response: auth.register(options), name: "MacBook" }, { cookie }),
		);
		expect(res.status).toBe(201);
		const { passkey } = (await res.json()) as { passkey: any };
		expect(passkey).toMatchObject({ name: "MacBook", deviceType: "multiDevice", backedUp: true });
		expect(passkey).not.toHaveProperty("publicKey");

		const list = await h.request("/api/auth/passkeys", { cookie });
		expect(((await list.json()) as { passkeys: any[] }).passkeys).toHaveLength(1);

		// A second registration excludes the credential already held.
		const again = await registerOptions(h, cookie);
		expect(again.excludeCredentials.map((c: { id: string }) => c.id)).toEqual([auth.id]);
	});

	it("names a new passkey after its provider, and numbers repeats", async () => {
		const gpm = "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4"; // Google Password Manager
		const register = async (aaguid?: string) => {
			const auth = new SoftAuthenticator({ origin: ORIGIN, rpID: RP_ID, ...(aaguid ? { aaguid } : {}) });
			const res = await h.request(
				"/api/auth/passkeys/register/verify",
				post({ response: auth.register(await registerOptions(h, cookie)) }, { cookie }),
			);
			expect(res.status).toBe(201);
			return ((await res.json()) as { passkey: { name: string; aaguid: string } }).passkey;
		};
		expect(await register(gpm)).toMatchObject({ name: "Google Password Manager", aaguid: gpm });
		expect((await register(gpm)).name).toBe("Google Password Manager 2");
		// All zeros (withheld) or unknown: the generic name.
		expect((await register()).name).toBe("Passkey 3");
		expect((await register("11111111-2222-3333-4444-555555555555")).name).toBe("Passkey 4");
	});

	it("lists the accepted credential ids for the Signal API", async () => {
		const { auth } = await enrol(h, cookie);
		const body = (await (await h.request("/api/auth/passkeys", { cookie })).json()) as {
			passkeys: Record<string, unknown>[];
			accepted: { rpId: string; userId: string; credentialIds: string[] };
		};
		expect(body.accepted.rpId).toBe(RP_ID);
		expect(Buffer.from(body.accepted.userId, "base64url").toString()).toMatch(/^usr_/);
		expect(body.accepted.credentialIds).toEqual([auth.id]);
		// The list itself still carries no key material.
		expect(body.passkeys[0]).not.toHaveProperty("publicKey");
		expect(body.passkeys[0]).not.toHaveProperty("credentialId");

		// An API token gets the list, but no credential ids.
		const created = await h.request("/api/auth/tokens", post({ name: "cli" }, { cookie }));
		const { secret } = (await created.json()) as { secret: string };
		const viaToken = await h.request("/api/auth/passkeys", { bearer: secret });
		expect(viaToken.status).toBe(200);
		const tokenBody = (await viaToken.json()) as { passkeys: unknown[]; accepted?: unknown };
		expect(tokenBody.passkeys).toHaveLength(1);
		expect(tokenBody).not.toHaveProperty("accepted");
		expect(JSON.stringify(tokenBody)).not.toContain(auth.id);
	});

	it("uses a challenge once", async () => {
		const options = await registerOptions(h, cookie);
		const auth = new SoftAuthenticator({ origin: ORIGIN, rpID: RP_ID });
		const response = auth.register(options);
		expect((await h.request("/api/auth/passkeys/register/verify", post({ response }, { cookie }))).status).toBe(201);
		const replay = await h.request("/api/auth/passkeys/register/verify", post({ response }, { cookie }));
		expect(replay.status).toBe(400);
		expect(await replay.json()).toMatchObject({ code: "challenge_expired" });
	});

	it("refuses a challenge older than five minutes", async () => {
		const options = await registerOptions(h, cookie);
		h.clock.now += WEBAUTHN_CHALLENGE_MS + 1;
		const auth = new SoftAuthenticator({ origin: ORIGIN, rpID: RP_ID });
		const res = await h.request("/api/auth/passkeys/register/verify", post({ response: auth.register(options) }, { cookie }));
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "challenge_expired" });
	});

	it("refuses a sign-in challenge presented for registration", async () => {
		const options = await loginOptions(h);
		const auth = new SoftAuthenticator({ origin: ORIGIN, rpID: RP_ID });
		const res = await h.request(
			"/api/auth/passkeys/register/verify",
			post({ response: auth.register({ ...options, user: { id: "x" } }) }, { cookie }),
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "challenge_expired" });
	});

	it("refuses another origin and an unverified user", async () => {
		const options = await registerOptions(h, cookie);
		const wrongOrigin = new SoftAuthenticator({ origin: ORIGIN, rpID: RP_ID }).register(options, {
			origin: "https://evil.example.net",
		});
		const error = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			expect((await h.request("/api/auth/passkeys/register/verify", post({ response: wrongOrigin }, { cookie }))).status).toBe(400);

			const noUv = new SoftAuthenticator({ origin: ORIGIN, rpID: RP_ID, userVerified: false });
			const res = await h.request(
				"/api/auth/passkeys/register/verify",
				post({ response: noUv.register(await registerOptions(h, cookie)) }, { cookie }),
			);
			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({ code: "passkey_invalid" });
		} finally {
			error.mockRestore();
		}
		expect(await h.store.listPasskeys((await h.store.listUsers())[0].id)).toEqual([]);
	});

	it("needs a browser session, not an API token", async () => {
		const created = await h.request("/api/auth/tokens", post({ name: "cli" }, { cookie }));
		const { secret } = (await created.json()) as { secret: string };
		const res = await h.request("/api/auth/passkeys/register/options", post({}, { bearer: secret }));
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ code: "session_required" });
		expect((await h.request("/api/auth/passkeys/register/options", post({}))).status).toBe(401);
	});

	it("asks to re-confirm after 15 minutes, and accepts the password", async () => {
		h.clock.now += PASSKEY_REAUTH_MS + 1;
		const stale = await h.request("/api/auth/passkeys/register/options", post({}, { cookie }));
		expect(stale.status).toBe(403);
		expect(await stale.json()).toMatchObject({ code: "reauth_required" });

		const wrong = await h.request("/api/auth/passkeys/reauth", post({ password: "nope-nope-nope" }, { cookie }));
		expect(wrong.status).toBe(400);
		expect(await wrong.json()).toMatchObject({ code: "wrong_password" });

		const ok = await h.request("/api/auth/passkeys/reauth", post({ password: OWNER.password }, { cookie }));
		expect(ok.status).toBe(200);
		expect((await h.request("/api/auth/passkeys/register/options", post({}, { cookie }))).status).toBe(200);
	});

	it("re-confirms with an existing passkey", async () => {
		const { auth } = await enrol(h, cookie);
		h.clock.now += PASSKEY_REAUTH_MS + 1;
		const opts = await h.request("/api/auth/passkeys/reauth/options", post({}, { cookie }));
		const { options } = (await opts.json()) as { options: any };
		expect(options.allowCredentials.map((c: { id: string }) => c.id)).toEqual([auth.id]);
		const res = await h.request("/api/auth/passkeys/reauth", post({ response: auth.authenticate(options) }, { cookie }));
		expect(res.status).toBe(200);
		expect((await h.request("/api/auth/passkeys/register/options", post({}, { cookie }))).status).toBe(200);
	});

	it("counts wrong re-confirmation passwords against the sign-in lock", async () => {
		h.clock.now += PASSKEY_REAUTH_MS + 1;
		for (let i = 0; i < 4; i++) {
			expect((await h.request("/api/auth/passkeys/reauth", post({ password: "wrong-password" }, { cookie }))).status).toBe(400);
		}
		const fifth = await h.request("/api/auth/passkeys/reauth", post({ password: "wrong-password" }, { cookie }));
		expect(fifth.status).toBe(423);
		const right = await h.request("/api/auth/passkeys/reauth", post({ password: OWNER.password }, { cookie }));
		expect(right.status).toBe(423);
	});

	it("renames and deletes, scoped to the caller", async () => {
		const { passkey } = await enrol(h, cookie);
		const renamed = await h.request(`/api/auth/passkeys/${passkey.id}`, {
			method: "PATCH",
			body: JSON.stringify({ name: "Phone" }),
			cookie,
		});
		expect(((await renamed.json()) as { passkey: any }).passkey.name).toBe("Phone");
		expect((await h.request(`/api/auth/passkeys/${passkey.id}`, { method: "DELETE", cookie })).status).toBe(204);
		expect((await h.request(`/api/auth/passkeys/${passkey.id}`, { method: "DELETE", cookie })).status).toBe(404);
	});

	it("rate limits the ceremony endpoints per user", async () => {
		const limitedHarness = build({ limiter: (key) => !key.startsWith("auth:passkey-register:") });
		const c = await setupOwner(limitedHarness);
		const res = await limitedHarness.request("/api/auth/passkeys/register/options", post({}, { cookie: c }));
		expect(res.status).toBe(429);
	});
});

// -- usernameless sign-in ------------------------------------------------------

describe("passkey sign-in", () => {
	let h: Harness;
	let cookie: string;
	let auth: SoftAuthenticator;
	beforeEach(async () => {
		h = build();
		cookie = await setupOwner(h);
		({ auth } = await enrol(h, cookie));
	});

	it("signs in without an email and creates a normal session", async () => {
		const options = await loginOptions(h);
		expect(options.rpId).toBe(RP_ID);
		expect(options.userVerification).toBe("required");
		expect(options.allowCredentials ?? []).toEqual([]);

		const res = await h.request("/api/auth/passkeys/login/verify", post({ response: auth.authenticate(options) }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; user: { email: string } };
		expect(body).toMatchObject({ status: "ok", user: { email: OWNER.email } });
		const session = cookieFrom(res);
		expect(session).toMatch(/^__Host-tt_session=/);

		const state = await h.request("/api/auth/state", { cookie: session });
		expect(await state.json()).toMatchObject({ authenticated: true });
		const [stored] = await h.store.listPasskeys((await h.store.listUsers())[0].id);
		expect(stored.lastUsedAt).toBe(h.clock.now);
	});

	it("is a complete sign-in even with TOTP on", async () => {
		const setup = await h.request("/api/auth/2fa/setup", post({ password: OWNER.password }, { cookie }));
		const { secret } = (await setup.json()) as { secret: string };
		const code = await hotp(base32Decode(secret), totpStep(h.clock.now));
		expect((await h.request("/api/auth/2fa/enable", post({ code }, { cookie }))).status).toBe(200);

		const res = await h.request("/api/auth/passkeys/login/verify", post({ response: auth.authenticate(await loginOptions(h)) }));
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ status: "ok" });
	});

	it("uses each challenge once", async () => {
		const response = auth.authenticate(await loginOptions(h));
		expect((await h.request("/api/auth/passkeys/login/verify", post({ response }))).status).toBe(200);
		const replay = await h.request("/api/auth/passkeys/login/verify", post({ response }));
		expect(replay.status).toBe(401);
		expect(await replay.json()).toMatchObject({ code: "challenge_expired" });
	});

	it("refuses an unknown credential, another origin, and an unverified user", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const stranger = new SoftAuthenticator({ origin: ORIGIN, rpID: RP_ID });
			const unknown = await h.request(
				"/api/auth/passkeys/login/verify",
				post({ response: stranger.authenticate(await loginOptions(h)) }),
			);
			expect(unknown.status).toBe(401);
			// Its own code, so the browser can tell the passkey provider to drop it.
			expect(await unknown.json()).toMatchObject({ code: "passkey_unknown" });

			const phished = await h.request(
				"/api/auth/passkeys/login/verify",
				post({ response: auth.authenticate(await loginOptions(h), { origin: "https://mail.example.com.evil.net" }) }),
			);
			expect(phished.status).toBe(401);

			// The registered key, but the user was only present, not verified.
			auth.opts.userVerified = false;
			warn.mockClear();
			const noUv = await h.request(
				"/api/auth/passkeys/login/verify",
				post({ response: auth.authenticate(await loginOptions(h)) }),
			);
			expect(noUv.status).toBe(401);
			expect(warn.mock.calls.some((c) => /user verification/i.test(String(c[0])))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	it("refuses a user handle that is not the credential's owner", async () => {
		const response = auth.authenticate(await loginOptions(h), {
			userHandle: Buffer.from("usr_someone_else").toString("base64url"),
		});
		const res = await h.request("/api/auth/passkeys/login/verify", post({ response }));
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({ code: "passkey_invalid" });
	});

	it("refuses a disabled user, whose passkeys are gone with the disable", async () => {
		// Invite a member, give them a passkey, disable them.
		const invite = await h.request(
			"/api/auth/admin/invites",
			post({ email: "m@example.com", role: "member", mailboxes: [] }, { cookie }),
		);
		const token = ((await invite.json()) as { url: string }).url.split("/invite/")[1];
		const accepted = await h.request(
			"/api/auth/invites/accept",
			post({ token, name: "Member", password: "member-password-1" }),
		);
		const memberCookie = cookieFrom(accepted);
		const { auth: memberKey } = await enrol(h, memberCookie);
		const member = (await h.store.getUserByEmail("m@example.com"))!;
		expect((await h.request(`/api/auth/admin/users/${member.id}/disable`, post({ disabled: true }, { cookie }))).status).toBe(204);

		const res = await h.request(
			"/api/auth/passkeys/login/verify",
			post({ response: memberKey.authenticate(await loginOptions(h)) }),
		);
		expect(res.status).toBe(401);
		// Disabling deleted the passkey, so it is unknown now.
		expect(await res.json()).toMatchObject({ code: "passkey_unknown" });
	});

	it("creates a browser session that counts as one (OAuth consent and other session-only actions)", async () => {
		const res = await h.request("/api/auth/passkeys/login/verify", post({ response: auth.authenticate(await loginOptions(h)) }));
		const session = cookieFrom(res);
		// The MCP OAuth consent page refuses anything but authMethod "session";
		// this is what the cookie resolves to on the next request.
		const me = await h.request("/api/v1/whoami", { cookie: session });
		expect(me.status).toBe(200);
		expect(await me.json()).toMatchObject({ authMethod: "session" });
		// And it passes requireSession, the guard on token minting.
		const token = await h.request("/api/auth/tokens", post({ name: "cli" }, { cookie: session }));
		expect(token.status).toBe(201);
	});

	it("signing out everywhere else from a passkey session also disconnects OAuth clients", async () => {
		const user = (await h.store.listUsers())[0];
		await h.store.createOAuthGrant({ userId: user.id, clientId: "c1", clientName: "Claude", redirectHost: "claude.ai", now: h.clock.now });
		const res = await h.request("/api/auth/passkeys/login/verify", post({ response: auth.authenticate(await loginOptions(h)) }));
		const session = cookieFrom(res);
		expect((await h.request("/api/auth/sessions/revoke-others", post({}, { cookie: session }))).status).toBe(200);
		expect(await h.store.listOAuthGrants(user.id)).toEqual([]);
	});

	it("rate limits per IP and per credential", async () => {
		const response = auth.authenticate(await loginOptions(h));
		await h.request("/api/auth/passkeys/login/verify", post({ response }));
		expect(h.limited).toContain("auth:passkey-login:ip:203.0.113.7");
		expect(h.limited).toContain(`auth:passkey-login:cred:${auth.id}`);

		const blocked = build({ limiter: (key) => !key.startsWith("auth:passkey-login:ip:") });
		expect((await blocked.request("/api/auth/passkeys/login/options", post({}))).status).toBe(429);
	});
});

// -- counters --------------------------------------------------------------------

describe("signature counter", () => {
	it("accepts an advancing counter and refuses one that goes backwards", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const auth = new SoftAuthenticator({ origin: ORIGIN, rpID: RP_ID, counter: 10, counterStep: 1 });
		await enrol(h, cookie, auth);

		expect((await h.request("/api/auth/passkeys/login/verify", post({ response: auth.authenticate(await loginOptions(h)) }))).status).toBe(200);

		// A clone replays from an older counter value.
		auth.counter = 5;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const cloned = await h.request("/api/auth/passkeys/login/verify", post({ response: auth.authenticate(await loginOptions(h)) }));
			expect(cloned.status).toBe(401);
			expect(warn.mock.calls.some((c) => String(c[0]).includes("cloned"))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	it("refuses a regression the store catches even when the verifier passes it", async () => {
		// A stubbed verifier that always approves, reporting a stale counter, as a
		// concurrent assertion racing past the library's own check would.
		const verifier: WebAuthnVerifier = {
			verifyRegistrationResponse: async () =>
				({
					verified: true,
					registrationInfo: {
						fmt: "none",
						aaguid: "00000000-0000-0000-0000-000000000000",
						credential: { id: "stub-cred", publicKey: new Uint8Array([1, 2, 3]), counter: 7, transports: ["usb"] },
						credentialType: "public-key",
						attestationObject: new Uint8Array(),
						userVerified: true,
						credentialDeviceType: "singleDevice",
						credentialBackedUp: false,
						origin: ORIGIN,
						rpID: RP_ID,
					},
				}) as never,
			verifyAuthenticationResponse: async () =>
				({
					verified: true,
					authenticationInfo: {
						credentialID: "stub-cred",
						newCounter: 7,
						userVerified: true,
						credentialDeviceType: "singleDevice",
						credentialBackedUp: false,
						origin: ORIGIN,
						rpID: RP_ID,
					},
				}) as never,
		};
		const h = build({ webauthn: verifier });
		const cookie = await setupOwner(h);
		const auth = new SoftAuthenticator({ origin: ORIGIN, rpID: RP_ID });
		const reg = await h.request(
			"/api/auth/passkeys/register/verify",
			post({ response: auth.register(await registerOptions(h, cookie)) }, { cookie }),
		);
		expect(reg.status).toBe(201);
		expect(((await reg.json()) as { passkey: any }).passkey).toMatchObject({ deviceType: "singleDevice", transports: ["usb"] });

		const response = { ...auth.authenticate(await loginOptions(h)), id: "stub-cred", rawId: "stub-cred" };
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const res = await h.request("/api/auth/passkeys/login/verify", post({ response: { ...response, response: { ...response.response, userHandle: undefined } } }));
			expect(res.status).toBe(401);
			// Refused by the store's compare-and-set, not by the (approving) verifier.
			expect(warn.mock.calls.some((c) => String(c[0]).includes("did not advance (stored 7)"))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	it("treats a verifier that says unverified as a failure", async () => {
		const verifier: WebAuthnVerifier = {
			verifyRegistrationResponse: async () => ({ verified: false }) as never,
			verifyAuthenticationResponse: async () => ({ verified: false, authenticationInfo: {} }) as never,
		};
		const h = build({ webauthn: verifier });
		const cookie = await setupOwner(h);
		const auth = new SoftAuthenticator({ origin: ORIGIN, rpID: RP_ID });
		const res = await h.request(
			"/api/auth/passkeys/register/verify",
			post({ response: auth.register(await registerOptions(h, cookie)) }, { cookie }),
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "passkey_invalid" });
	});
});

// -- second factor -------------------------------------------------------------

describe("passkey as the second factor", () => {
	async function enrolledWithTotp() {
		const h = build();
		const cookie = await setupOwner(h);
		const { auth } = await enrol(h, cookie);
		const setup = await h.request("/api/auth/2fa/setup", post({ password: OWNER.password }, { cookie }));
		const { secret } = (await setup.json()) as { secret: string };
		const code = await hotp(base32Decode(secret), totpStep(h.clock.now));
		expect((await h.request("/api/auth/2fa/enable", post({ code }, { cookie }))).status).toBe(200);
		h.clock.now += 60_000;
		return { h, auth };
	}

	async function mfaChallenge(h: Harness) {
		const res = await h.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password }));
		const body = (await res.json()) as { status: string; challenge: string; passkeys: boolean };
		expect(body).toMatchObject({ status: "mfa_required", passkeys: true });
		return body.challenge;
	}

	it("completes the MFA step with a passkey", async () => {
		const { h, auth } = await enrolledWithTotp();
		const challenge = await mfaChallenge(h);
		const opts = await h.request("/api/auth/passkeys/mfa/options", post({ challenge }));
		expect(opts.status).toBe(200);
		const { options } = (await opts.json()) as { options: any };
		expect(options.allowCredentials.map((c: { id: string }) => c.id)).toEqual([auth.id]);

		const res = await h.request("/api/auth/passkeys/mfa/verify", post({ challenge, response: auth.authenticate(options) }));
		expect(res.status).toBe(200);
		expect(res.headers.get("set-cookie")).toContain("__Host-tt_session=");
		// Not asked to trust the browser: no trust cookie.
		expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-tt_trust="))).toBe(false);

		// The MFA challenge is spent.
		const again = await h.request("/api/auth/passkeys/mfa/options", post({ challenge }));
		expect(again.status).toBe(401);
	});

	describe("removing a factor forgets other trusted browsers", () => {
		async function withAppAndPasskey() {
			const h = build();
			const cookie = await setupOwner(h);
			await enrol(h, cookie);
			const setup = await h.request("/api/auth/2fa/setup", post({ password: OWNER.password }, { cookie }));
			const { secret } = (await setup.json()) as { secret: string };
			const code = await hotp(base32Decode(secret), totpStep(h.clock.now));
			expect((await h.request("/api/auth/2fa/enable", post({ code }, { cookie }))).status).toBe(200);
			h.clock.now += 60_000;
			return { h, secret };
		}

		async function trusted(h: Harness, secret: string) {
			const challenge = await mfaChallenge(h);
			const res = await h.request(
				"/api/auth/login/mfa",
				post({ challenge, code: await hotp(base32Decode(secret), totpStep(h.clock.now)), trustBrowser: true }),
			);
			expect(res.status).toBe(200);
			h.clock.now += 31_000;
			const trust = res.headers.getSetCookie().find((c) => c.startsWith("__Host-tt_trust="))!.split(";")[0];
			return { session: cookieFrom(res), trust };
		}

		const passwordLogin = (h: Harness, cookie: string) =>
			h.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password }, { cookie }));

		it("when the app goes and a passkey stays", async () => {
			const { h, secret } = await withAppAndPasskey();
			const a = await trusted(h, secret);
			const b = await trusted(h, secret);
			const off = await h.request(
				"/api/auth/2fa/disable",
				post(
					{ password: OWNER.password, code: await hotp(base32Decode(secret), totpStep(h.clock.now)) },
					{ cookie: `${b.session}; ${b.trust}` },
				),
			);
			expect(off.status).toBe(204);
			expect(await (await passwordLogin(h, a.trust)).json()).toMatchObject({ status: "mfa_required" });
			expect(await (await passwordLogin(h, b.trust)).json()).toMatchObject({ status: "ok" });
		});

		it("when a passkey goes and the app stays", async () => {
			const { h, secret } = await withAppAndPasskey();
			const a = await trusted(h, secret);
			const b = await trusted(h, secret);
			const { passkeys } = (await (await h.request("/api/auth/passkeys", { cookie: b.session })).json()) as {
				passkeys: { id: string }[];
			};
			const del = await h.request(`/api/auth/passkeys/${passkeys[0].id}`, {
				method: "DELETE",
				cookie: `${b.session}; ${b.trust}`,
			});
			expect(del.status).toBe(204);
			expect(await (await passwordLogin(h, a.trust)).json()).toMatchObject({ status: "mfa_required" });
			expect(await (await passwordLogin(h, b.trust)).json()).toMatchObject({ status: "ok" });
		});
	});

	it("trusts the browser after a passkey second step when asked", async () => {
		const { h, auth } = await enrolledWithTotp();
		const challenge = await mfaChallenge(h);
		const { options } = (await (await h.request("/api/auth/passkeys/mfa/options", post({ challenge }))).json()) as {
			options: any;
		};
		const res = await h.request(
			"/api/auth/passkeys/mfa/verify",
			post({ challenge, response: auth.authenticate(options), trustBrowser: true }),
		);
		expect(res.status).toBe(200);
		const trust = res.headers
			.getSetCookie()
			.find((c) => c.startsWith("__Host-tt_trust="))
			?.split(";")[0];
		expect(trust).toBeTruthy();
		const login = await h.request(
			"/api/auth/login",
			post({ email: OWNER.email, password: OWNER.password }, { cookie: trust }),
		);
		expect(await login.json()).toMatchObject({ status: "ok" });
	});

	it("refuses a passkey challenge issued for usernameless sign-in", async () => {
		const { h, auth } = await enrolledWithTotp();
		const challenge = await mfaChallenge(h);
		const res = await h.request(
			"/api/auth/passkeys/mfa/verify",
			post({ challenge, response: auth.authenticate(await loginOptions(h)) }),
		);
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({ code: "challenge_expired" });
	});

	it("counts a bad passkey against the account's second-factor lock", async () => {
		const { h } = await enrolledWithTotp();
		const stranger = new SoftAuthenticator({ origin: ORIGIN, rpID: RP_ID });
		for (let i = 0; i < 4; i++) {
			const challenge = await mfaChallenge(h);
			const { options } = (await (await h.request("/api/auth/passkeys/mfa/options", post({ challenge }))).json()) as { options: any };
			const res = await h.request("/api/auth/passkeys/mfa/verify", post({ challenge, response: stranger.authenticate(options) }));
			expect(res.status).toBe(401);
		}
		const challenge = await mfaChallenge(h);
		const { options } = (await (await h.request("/api/auth/passkeys/mfa/options", post({ challenge }))).json()) as { options: any };
		const fifth = await h.request("/api/auth/passkeys/mfa/verify", post({ challenge, response: stranger.authenticate(options) }));
		expect(fifth.status).toBe(423);
	});

	it("tells the login step there is no passkey when there is none", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const setup = await h.request("/api/auth/2fa/setup", post({ password: OWNER.password }, { cookie }));
		const { secret } = (await setup.json()) as { secret: string };
		const code = await hotp(base32Decode(secret), totpStep(h.clock.now));
		await h.request("/api/auth/2fa/enable", post({ code }, { cookie }));
		const res = await h.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password }));
		const body = (await res.json()) as { challenge: string; passkeys: boolean };
		expect(body.passkeys).toBe(false);
		const opts = await h.request("/api/auth/passkeys/mfa/options", post({ challenge: body.challenge }));
		expect(await opts.json()).toMatchObject({ code: "no_passkeys" });
	});
});

describe("access mode", () => {
	it("hides the passkey endpoints", async () => {
		const h = build({ env: { AUTH_MODE: "access", POLICY_AUD: "aud", TEAM_DOMAIN: "https://team.cloudflareaccess.com" } });
		const res = await h.request("/api/auth/passkeys/login/options", post({}));
		expect([403, 404]).toContain(res.status);
	});
});

// -- two-factor through a passkey alone ----------------------------------------

describe("a passkey turns two-factor on", () => {
	async function passkeyOnlyOwner() {
		const h = build();
		const cookie = await setupOwner(h);
		const options = await registerOptions(h, cookie);
		const auth = new SoftAuthenticator({ origin: ORIGIN, rpID: RP_ID });
		const res = await h.request("/api/auth/passkeys/register/verify", post({ response: auth.register(options), name: "Laptop" }, { cookie }));
		expect(res.status).toBe(201);
		const body = (await res.json()) as { passkey: { id: string }; recoveryCodes?: string[] };
		h.clock.now += 60_000;
		return { h, cookie, auth, passkey: body.passkey, recoveryCodes: body.recoveryCodes ?? [] };
	}

	async function passwordLogin(h: Harness) {
		const res = await h.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password }));
		return { res, body: (await res.json()) as { status: string; challenge: string; passkeys: boolean; totp: boolean } };
	}

	it("issues recovery codes with the first passkey only", async () => {
		const { h, cookie, recoveryCodes } = await passkeyOnlyOwner();
		expect(recoveryCodes).toHaveLength(10);
		for (const code of recoveryCodes) expect(code).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/);
		// A second passkey keeps the codes the first one brought.
		h.clock.now = h.clock.now - 60_000;
		const options = await registerOptions(h, cookie);
		const second = new SoftAuthenticator({ origin: ORIGIN, rpID: RP_ID });
		const res = await h.request("/api/auth/passkeys/register/verify", post({ response: second.register(options) }, { cookie }));
		expect(res.status).toBe(201);
		expect(await res.json()).not.toHaveProperty("recoveryCodes");
		const status = (await (await h.request("/api/auth/2fa", { cookie })).json()) as Record<string, unknown>;
		expect(status).toMatchObject({ enabled: true, totpEnabled: false, passkeys: 2, recoveryCodesLeft: 10, totpSuspended: false });
	});

	it("makes a password sign-in ask for the passkey, with no session until it does", async () => {
		const { h, auth } = await passkeyOnlyOwner();
		const { res, body } = await passwordLogin(h);
		expect(body).toMatchObject({ status: "mfa_required", passkeys: true, totp: false });
		expect(res.headers.get("set-cookie")).toBeNull();

		const opts = await h.request("/api/auth/passkeys/mfa/options", post({ challenge: body.challenge }));
		const { options } = (await opts.json()) as { options: any };
		const ok = await h.request("/api/auth/passkeys/mfa/verify", post({ challenge: body.challenge, response: auth.authenticate(options) }));
		expect(ok.status).toBe(200);
		expect(ok.headers.get("set-cookie")).toContain("__Host-tt_session=");
	});

	it("refuses an authenticator code (there is no app) but takes a recovery code once", async () => {
		const { h, recoveryCodes } = await passkeyOnlyOwner();
		const { body } = await passwordLogin(h);
		const code = await h.request("/api/auth/login/mfa", post({ challenge: body.challenge, code: "123456" }));
		expect(code.status).toBe(401);
		expect(await code.json()).toMatchObject({ code: "invalid_code" });

		const rc = await h.request("/api/auth/login/mfa", post({ challenge: body.challenge, code: recoveryCodes[0].toUpperCase() }));
		expect(rc.status).toBe(200);
		const again = await passwordLogin(h);
		const reused = await h.request("/api/auth/login/mfa", post({ challenge: again.body.challenge, code: recoveryCodes[0] }));
		expect(reused.status).toBe(401);
	});

	it("still signs straight in with the passkey itself", async () => {
		const { h, auth } = await passkeyOnlyOwner();
		const res = await h.request("/api/auth/passkeys/login/verify", post({ response: auth.authenticate(await loginOptions(h)) }));
		expect(res.status).toBe(200);
		expect(res.headers.get("set-cookie")).toContain("__Host-tt_session=");
	});

	it("goes back to password-only once the last passkey is removed", async () => {
		const { h, cookie, passkey } = await passkeyOnlyOwner();
		expect((await h.request(`/api/auth/passkeys/${passkey.id}`, { method: "DELETE", cookie })).status).toBe(204);
		const { body } = await passwordLogin(h);
		expect(body.status).toBe("ok");
		expect(await h.store.countRecoveryCodes((await h.store.getUserByEmail(OWNER.email))!.id)).toBe(0);
	});

	it("won't remove the last factor while the organization requires two-factor", async () => {
		const { h, cookie, passkey } = await passkeyOnlyOwner();
		const on = await h.request("/api/auth/admin/security-policy", { method: "PUT", body: JSON.stringify({ requireMfa: true }), cookie });
		expect(on.status).toBe(200);
		const res = await h.request(`/api/auth/passkeys/${passkey.id}`, { method: "DELETE", cookie });
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ code: "last_factor" });
		// Someone else's id is a plain 404, not a hint.
		expect((await h.request("/api/auth/passkeys/pk_nope", { method: "DELETE", cookie })).status).toBe(404);
	});

	it("still accepts recovery codes stored before per-user hashing, and flags them", async () => {
		const { h, cookie } = await passkeyOnlyOwner();
		const user = (await h.store.getUserByEmail(OWNER.email))!;
		// An account from before this change: 50-bit codes, plain SHA-256.
		await h.store.replaceRecoveryCodes(user.id, [await sha256Hex("abcdefghij")]);
		const status = (await (await h.request("/api/auth/2fa", { cookie })).json()) as Record<string, unknown>;
		expect(status).toMatchObject({ recoveryCodesLeft: 1, recoveryCodesOutdated: true });
		const { body } = await passwordLogin(h);
		const rc = await h.request("/api/auth/login/mfa", post({ challenge: body.challenge, code: "ABCDE-FGHIJ" }));
		expect(rc.status).toBe(200);
		expect(await h.store.countRecoveryCodes(user.id)).toBe(0);
	});

	it("salts stored codes with the user id", async () => {
		const { h, recoveryCodes } = await passkeyOnlyOwner();
		const user = (await h.store.getUserByEmail(OWNER.email))!;
		expect(await h.store.countRecoveryCodes(user.id, { legacyOnly: true })).toBe(0);
		// The plain hash of a real code is not what was stored.
		const plain = await sha256Hex(recoveryCodes[0].replace(/-/g, ""));
		expect(await h.store.consumeRecoveryCode(user.id, plain)).toBe(false);
	});

	it("lets a passkey-only account make new recovery codes", async () => {
		const { h, cookie, recoveryCodes } = await passkeyOnlyOwner();
		const res = await h.request("/api/auth/2fa/recovery-codes", post({ password: OWNER.password }, { cookie }));
		expect(res.status).toBe(200);
		const fresh = ((await res.json()) as { recoveryCodes: string[] }).recoveryCodes;
		expect(fresh).toHaveLength(10);
		const { body } = await passwordLogin(h);
		expect((await h.request("/api/auth/login/mfa", post({ challenge: body.challenge, code: recoveryCodes[0] }))).status).toBe(401);
		expect((await h.request("/api/auth/login/mfa", post({ challenge: body.challenge, code: fresh[0] }))).status).toBe(200);
	});
});

describe("authenticator codes after too many wrong guesses", () => {
	it("stop working at 100 failures until a recovery code or passkey gets in", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const setup = await h.request("/api/auth/2fa/setup", post({ password: OWNER.password }, { cookie }));
		const { secret } = (await setup.json()) as { secret: string };
		const enable = await h.request("/api/auth/2fa/enable", post({ code: await hotp(base32Decode(secret), totpStep(h.clock.now)) }, { cookie }));
		const { recoveryCodes } = (await enable.json()) as { recoveryCodes: string[] };
		const user = (await h.store.getUserByEmail(OWNER.email))!;
		for (let i = 0; i < 100; i++) await h.store.recordMfaFailure(user.id, h.clock.now);
		h.clock.now += 16 * 60_000;

		const challenge = async () =>
			((await (await h.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password }))).json()) as { challenge: string }).challenge;
		const right = await hotp(base32Decode(secret), totpStep(h.clock.now));
		const refused = await h.request("/api/auth/login/mfa", post({ challenge: await challenge(), code: right }));
		expect(refused.status).toBe(401);
		expect(await refused.json()).toMatchObject({ code: "totp_suspended" });
		expect(((await (await h.request("/api/auth/2fa", { cookie })).json()) as { totpSuspended: boolean }).totpSuspended).toBe(true);
		// Not counted as another guess.
		expect(await h.store.getMfaFailureCount(user.id)).toBe(100);

		const rc = await h.request("/api/auth/login/mfa", post({ challenge: await challenge(), code: recoveryCodes[0] }));
		expect(rc.status).toBe(200);
		h.clock.now += 60_000;
		const next = await hotp(base32Decode(secret), totpStep(h.clock.now));
		expect((await h.request("/api/auth/login/mfa", post({ challenge: await challenge(), code: next }))).status).toBe(200);
	});
});

describe("admin reset of someone's two-factor", () => {
	async function withMember(role: "member" | "admin" = "member") {
		const h = build();
		const owner = await setupOwner(h);
		const email = role === "admin" ? "ops@example.com" : "m@example.com";
		const invite = await h.request("/api/auth/admin/invites", post({ email, role, mailboxes: [] }, { cookie: owner }));
		const token = ((await invite.json()) as { url: string }).url.split("/invite/")[1];
		const accepted = await h.request("/api/auth/invites/accept", post({ token, name: "Member", password: "member-password-1" }));
		const memberCookie = cookieFrom(accepted);
		await enrol(h, memberCookie);
		const member = (await h.store.getUserByEmail(email))!;
		return { h, owner, memberCookie, member, email };
	}

	it("removes their passkeys and codes, signs them out, and logs it", async () => {
		const { h, owner, memberCookie, member, email } = await withMember();
		const before = await h.request("/api/auth/login", post({ email, password: "member-password-1" }));
		expect(((await before.json()) as { status: string }).status).toBe("mfa_required");

		const res = await h.request(`/api/auth/admin/users/${member.id}/reset-2fa`, post({}, { cookie: owner }));
		expect(res.status).toBe(204);
		expect(await h.store.listPasskeys(member.id)).toHaveLength(0);
		expect(await h.store.countRecoveryCodes(member.id)).toBe(0);
		expect((await h.request("/api/auth/2fa", { cookie: memberCookie })).status).toBe(401);
		const after = await h.request("/api/auth/login", post({ email, password: "member-password-1" }));
		expect(((await after.json()) as { status: string }).status).toBe("ok");
	});

	it("needs a recent sign-in, and refuses yourself and another admin unless you're the owner", async () => {
		const { h, owner, member } = await withMember();
		h.clock.now += PASSKEY_REAUTH_MS + 1;
		const stale = await h.request(`/api/auth/admin/users/${member.id}/reset-2fa`, post({}, { cookie: owner }));
		expect(stale.status).toBe(403);
		expect(await stale.json()).toMatchObject({ code: "reauth_required" });
		expect((await h.request("/api/auth/passkeys/reauth", post({ password: OWNER.password }, { cookie: owner }))).status).toBe(200);
		expect((await h.request(`/api/auth/admin/users/${member.id}/reset-2fa`, post({}, { cookie: owner }))).status).toBe(204);

		const ownerUser = (await h.store.getUserByEmail(OWNER.email))!;
		const self = await h.request(`/api/auth/admin/users/${ownerUser.id}/reset-2fa`, post({}, { cookie: owner }));
		expect(await self.json()).toMatchObject({ code: "self_protected" });
	});

	it("keeps an admin from resetting another admin or the owner", async () => {
		const { h, owner, memberCookie: adminCookie } = await withMember("admin");
		const other = await h.request("/api/auth/admin/invites", post({ email: "ops2@example.com", role: "admin", mailboxes: [] }, { cookie: owner }));
		const token = ((await other.json()) as { url: string }).url.split("/invite/")[1];
		await h.request("/api/auth/invites/accept", post({ token, name: "Ops 2", password: "member-password-1" }));
		const ops2 = (await h.store.getUserByEmail("ops2@example.com"))!;
		const ownerUser = (await h.store.getUserByEmail(OWNER.email))!;
		expect((await (await h.request(`/api/auth/admin/users/${ops2.id}/reset-2fa`, post({}, { cookie: adminCookie }))).json())).toMatchObject({ code: "admin_protected" });
		expect((await (await h.request(`/api/auth/admin/users/${ownerUser.id}/reset-2fa`, post({}, { cookie: adminCookie }))).json())).toMatchObject({ code: "owner_protected" });
	});
});

describe("review follow-ups", () => {
	async function ownerWithApp(h: Harness, cookie: string) {
		const setup = await h.request("/api/auth/2fa/setup", post({ password: OWNER.password }, { cookie }));
		const { secret } = (await setup.json()) as { secret: string };
		const enable = await h.request("/api/auth/2fa/enable", post({ code: await hotp(base32Decode(secret), totpStep(h.clock.now)) }, { cookie }));
		expect(enable.status).toBe(200);
		return { secret, body: (await enable.json()) as { recoveryCodes: string[]; recoveryCodesKept: boolean } };
	}
	const requireMfa = (h: Harness, cookie: string) =>
		h.request("/api/auth/admin/security-policy", { method: "PUT", body: JSON.stringify({ requireMfa: true }), cookie });

	it("keeps a passkey's codes when the app is added later", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const res = await h.request("/api/auth/passkeys/register/verify", post({ response: new SoftAuthenticator({ origin: ORIGIN, rpID: RP_ID }).register(await registerOptions(h, cookie)) }, { cookie }));
		const first = ((await res.json()) as { recoveryCodes: string[] }).recoveryCodes;
		expect(first).toHaveLength(10);
		const { body } = await ownerWithApp(h, cookie);
		expect(body).toEqual({ recoveryCodes: [], recoveryCodesKept: true });
		const user = (await h.store.getUserByEmail(OWNER.email))!;
		expect(await h.store.countRecoveryCodes(user.id)).toBe(10);
	});

	it("won't turn the app off when it is the last factor and two-factor is required", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const { secret } = await ownerWithApp(h, cookie);
		expect((await requireMfa(h, cookie)).status).toBe(200);
		h.clock.now += 60_000;
		const code = await hotp(base32Decode(secret), totpStep(h.clock.now));
		const refused = await h.request("/api/auth/2fa/disable", post({ password: OWNER.password, code }, { cookie }));
		expect(refused.status).toBe(409);
		expect(await refused.json()).toMatchObject({ code: "last_factor" });
		// With a passkey as well, the app can go.
		await enrol(h, cookie);
		h.clock.now += 60_000;
		const next = await hotp(base32Decode(secret), totpStep(h.clock.now));
		expect((await h.request("/api/auth/2fa/disable", post({ password: OWNER.password, code: next }, { cookie }))).status).toBe(204);
	});

	it("doesn't spend second-step attempts on asking for the passkey prompt", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const { auth } = await enrol(h, cookie);
		h.clock.now += 60_000;
		const login = await h.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password }));
		const { challenge } = (await login.json()) as { challenge: string };
		let options: any;
		// Someone who cancels the browser prompt a few times and tries again.
		for (let i = 0; i < 6; i++) {
			const opts = await h.request("/api/auth/passkeys/mfa/options", post({ challenge }));
			expect(opts.status).toBe(200);
			options = ((await opts.json()) as { options: any }).options;
		}
		const ok = await h.request("/api/auth/passkeys/mfa/verify", post({ challenge, response: auth.authenticate(options) }));
		expect(ok.status).toBe(200);
	});

	it("counts wrong passwords on two-factor changes against the sign-in lock", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const { auth } = await enrol(h, cookie);
		const statuses: number[] = [];
		for (let i = 0; i < 6; i++) {
			const res = await h.request("/api/auth/2fa/recovery-codes", post({ password: "wrong-password-1" }, { cookie }));
			statuses.push(res.status);
		}
		expect(statuses.slice(0, 4)).toEqual([400, 400, 400, 400]);
		expect(statuses[4]).toBe(423);
		// Locked even for the right password until the lock runs out.
		expect((await h.request("/api/auth/2fa/recovery-codes", post({ password: OWNER.password }, { cookie }))).status).toBe(423);
		h.clock.now += 16 * 60_000;
		// The password is right, but new codes also need a recent passkey.
		const stale = await h.request("/api/auth/2fa/recovery-codes", post({ password: OWNER.password }, { cookie }));
		expect(stale.status).toBe(403);
		await reauthWithPasskey(h, cookie, auth);
		expect((await h.request("/api/auth/2fa/recovery-codes", post({ password: OWNER.password }, { cookie }))).status).toBe(200);
	});

	it("lifts the app-code suspension a day after the last wrong code", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const { secret } = await ownerWithApp(h, cookie);
		const user = (await h.store.getUserByEmail(OWNER.email))!;
		for (let i = 0; i < 100; i++) await h.store.recordMfaFailure(user.id, h.clock.now);
		h.clock.now += 16 * 60_000;
		const challenge = async () =>
			((await (await h.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password }))).json()) as { challenge: string }).challenge;
		const code = () => hotp(base32Decode(secret), totpStep(h.clock.now));
		// Re-confirming with an app code is refused the same way.
		const reauth = await h.request("/api/auth/passkeys/reauth", post({ code: await code() }, { cookie }));
		expect(await reauth.json()).toMatchObject({ code: "totp_suspended" });
		expect(await (await h.request("/api/auth/login/mfa", post({ challenge: await challenge(), code: await code() }))).json()).toMatchObject({ code: "totp_suspended" });
		h.clock.now += 24 * 3_600_000;
		expect((await h.request("/api/auth/login/mfa", post({ challenge: await challenge(), code: await code() }))).status).toBe(200);
	});

	it("signs the member out at once on an admin reset, even with a warm session cache", async () => {
		const h = build();
		const owner = await setupOwner(h);
		const invite = await h.request("/api/auth/admin/invites", post({ email: "m@example.com", role: "member", mailboxes: [] }, { cookie: owner }));
		const token = ((await invite.json()) as { url: string }).url.split("/invite/")[1];
		const memberCookie = cookieFrom(await h.request("/api/auth/invites/accept", post({ token, name: "M", password: "member-password-1" })));
		await enrol(h, memberCookie);
		const member = (await h.store.getUserByEmail("m@example.com"))!;
		expect((await h.request("/api/auth/2fa", { cookie: memberCookie })).status).toBe(200);
		expect((await h.request(`/api/auth/admin/users/${member.id}/reset-2fa`, post({}, { cookie: owner }))).status).toBe(204);
		expect((await h.request("/api/auth/2fa", { cookie: memberCookie })).status).toBe(401);
	});
});

describe("security notices for passkeys", () => {
	it("emails the account holder when a passkey is added or removed, naming the device", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const options = await registerOptions(h, cookie);
		const auth = new SoftAuthenticator({ origin: ORIGIN, rpID: RP_ID });
		const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
		const added = await h.request(
			"/api/auth/passkeys/register/verify",
			post({ response: auth.register(options), name: "<b>Work</b> laptop" }, { cookie, headers: { "user-agent": ua } }),
		);
		expect(added.status).toBe(201);
		await h.settle();
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0].to).toBe(OWNER.email);
		expect(h.sent[0].subject).toBe("New passkey added to your cloudmail account");
		expect(h.sent[0].text).toContain("“<b>Work</b> laptop”");
		expect(h.sent[0].text).toContain("Device: Chrome on Mac");
		expect(h.sent[0].text).toContain(`${ORIGIN}/settings/account`);
		// Escaped in the HTML part, and never the address it came from.
		expect(h.sent[0].html).toContain("&lt;b&gt;Work&lt;/b&gt;");
		expect(h.sent[0].html).not.toContain("<b>Work</b>");
		expect(h.sent[0].text).not.toContain("203.0.113.7");

		const { passkey } = (await added.json()) as { passkey: { id: string } };
		expect((await h.request(`/api/auth/passkeys/${passkey.id}`, { method: "DELETE", cookie })).status).toBe(204);
		await h.settle();
		expect(h.sent.map((m) => m.subject)).toEqual([
			"New passkey added to your cloudmail account",
			"Passkey removed from your cloudmail account",
		]);
		// Someone else's id: no passkey removed, no email.
		await h.request("/api/auth/passkeys/pk_nope", { method: "DELETE", cookie });
		await h.settle();
		expect(h.sent).toHaveLength(2);
	});

	it("tells a member their two-factor was reset, and by whom", async () => {
		const h = build();
		const owner = await setupOwner(h);
		const invite = await h.request("/api/auth/admin/invites", post({ email: "m@example.com", role: "member", mailboxes: [] }, { cookie: owner }));
		const token = ((await invite.json()) as { url: string }).url.split("/invite/")[1];
		const memberCookie = cookieFrom(await h.request("/api/auth/invites/accept", post({ token, name: "M", password: "member-password-1" })));
		await enrol(h, memberCookie);
		await h.settle();
		h.sent.length = 0;
		const member = (await h.store.getUserByEmail("m@example.com"))!;
		expect((await h.request(`/api/auth/admin/users/${member.id}/reset-2fa`, post({}, { cookie: owner }))).status).toBe(204);
		await h.settle();
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0].to).toBe("m@example.com");
		expect(h.sent[0].subject).toBe("Your cloudmail two-factor was reset");
		expect(h.sent[0].text).toContain(`An administrator (${OWNER.email})`);
		// The admin's device is not the member's business.
		expect(h.sent[0].text).not.toContain("Device:");
	});

	it("warns once when wrong passkeys after the right password reach the lock", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		await enrol(h, cookie);
		await h.settle();
		h.sent.length = 0;
		h.clock.now += 60_000;
		const stranger = new SoftAuthenticator({ origin: ORIGIN, rpID: RP_ID });
		for (let i = 0; i < 6; i++) {
			const login = await h.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password }));
			const { challenge } = (await login.json()) as { challenge: string };
			const { options } = (await (await h.request("/api/auth/passkeys/mfa/options", post({ challenge }))).json()) as { options: any };
			await h.request("/api/auth/passkeys/mfa/verify", post({ challenge, response: stranger.authenticate(options) }));
			h.clock.now += 16 * 60_000;
		}
		await h.settle();
		expect(h.sent.map((m) => m.subject)).toEqual(["Someone may know your cloudmail password"]);
		expect(h.sent[0].text).toContain("failed the two-factor step 5 times in a row");
	});
});

// -- step-up with an existing factor ---------------------------------------------

describe("factor changes need a recent second factor", () => {
	async function passkeyOwner() {
		const h = build();
		const cookie = await setupOwner(h);
		const { auth, passkey } = await enrol(h, cookie);
		return { h, cookie, auth, passkey };
	}

	async function passkeySignIn(h: Harness, auth: SoftAuthenticator) {
		const res = await h.request("/api/auth/passkeys/login/verify", post({ response: auth.authenticate(await loginOptions(h)) }));
		expect(res.status).toBe(200);
		return cookieFrom(res);
	}

	async function expectStale(res: Response) {
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ code: "reauth_required", secondFactor: true });
	}

	it("counts a passkey sign-in for five minutes, then wants a passkey, not the password", async () => {
		const { h, auth } = await passkeyOwner();
		h.clock.now += 60 * 60_000;
		const cookie = await passkeySignIn(h, auth);
		expect((await h.request("/api/auth/passkeys/register/options", post({}, { cookie }))).status).toBe(200);
		h.clock.now += FACTOR_STEP_UP_MS;
		await expectStale(await h.request("/api/auth/passkeys/register/options", post({}, { cookie })));
		// The password still re-confirms the session for other actions, not for this.
		expect((await h.request("/api/auth/passkeys/reauth", post({ password: OWNER.password }, { cookie }))).status).toBe(200);
		await expectStale(await h.request("/api/auth/passkeys/register/options", post({}, { cookie })));
		await reauthWithPasskey(h, cookie, auth);
		expect((await h.request("/api/auth/passkeys/register/options", post({}, { cookie }))).status).toBe(200);
	});

	it("counts the second step of a password sign-in, passkey or recovery code", async () => {
		const h = build();
		const setup = await setupOwner(h);
		const first = await h.request("/api/auth/passkeys/register/options", post({}, { cookie: setup }));
		const auth = new SoftAuthenticator({ origin: ORIGIN, rpID: RP_ID });
		const added = await h.request(
			"/api/auth/passkeys/register/verify",
			post({ response: auth.register(((await first.json()) as { options: any }).options) }, { cookie: setup }),
		);
		const { recoveryCodes } = (await added.json()) as { recoveryCodes: string[] };
		h.clock.now += 60 * 60_000;

		const login = async () =>
			((await (await h.request("/api/auth/login", post({ email: OWNER.email, password: OWNER.password }))).json()) as {
				challenge: string;
			}).challenge;

		let challenge = await login();
		const opts = await h.request("/api/auth/passkeys/mfa/options", post({ challenge }));
		const { options } = (await opts.json()) as { options: any };
		const viaPasskey = await h.request("/api/auth/passkeys/mfa/verify", post({ challenge, response: auth.authenticate(options) }));
		expect(viaPasskey.status).toBe(200);
		expect((await h.request("/api/auth/passkeys/register/options", post({}, { cookie: cookieFrom(viaPasskey) }))).status).toBe(200);

		challenge = await login();
		const viaCode = await h.request("/api/auth/login/mfa", post({ challenge, code: recoveryCodes[0] }));
		expect(viaCode.status).toBe(200);
		const cookie = cookieFrom(viaCode);
		expect((await h.request("/api/auth/2fa/recovery-codes", post({}, { cookie }))).status).toBe(200);
	});

	it("needs one to remove a passkey", async () => {
		const { h, cookie, auth, passkey } = await passkeyOwner();
		h.clock.now += FACTOR_STEP_UP_MS;
		await expectStale(await h.request(`/api/auth/passkeys/${passkey.id}`, { method: "DELETE", cookie }));
		expect(await h.store.listPasskeys((await h.store.listUsers())[0].id)).toHaveLength(1);
		await reauthWithPasskey(h, cookie, auth);
		expect((await h.request(`/api/auth/passkeys/${passkey.id}`, { method: "DELETE", cookie })).status).toBe(204);
	});

	it("lets a passkey account set up the app with its passkey, password or not", async () => {
		const { h, cookie, auth } = await passkeyOwner();
		// Just added the passkey: that ceremony counts.
		expect((await h.request("/api/auth/2fa/setup", post({}, { cookie }))).status).toBe(200);
		h.clock.now += FACTOR_STEP_UP_MS;
		await expectStale(await h.request("/api/auth/2fa/setup", post({ password: OWNER.password }, { cookie })));
		// A wrong password sent anyway is still checked and counted.
		const wrong = await h.request("/api/auth/2fa/setup", post({ password: "wrong-password-1" }, { cookie }));
		expect(await wrong.json()).toMatchObject({ code: "wrong_password" });
		await reauthWithPasskey(h, cookie, auth);
		expect((await h.request("/api/auth/2fa/setup", post({}, { cookie }))).status).toBe(200);
	});

	it("still asks an account with no second factor for its password", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const none = await h.request("/api/auth/2fa/setup", post({}, { cookie }));
		expect(none.status).toBe(400);
		expect(await none.json()).toMatchObject({ code: "password_required" });
		expect((await h.request("/api/auth/2fa/setup", post({ password: OWNER.password }, { cookie }))).status).toBe(200);
		// Its first passkey keeps the 15-minute sign-in rule.
		h.clock.now += FACTOR_STEP_UP_MS;
		expect((await h.request("/api/auth/passkeys/register/options", post({}, { cookie }))).status).toBe(200);
	});

	it("takes an app code, and counts turning the app on as one", async () => {
		const h = build();
		const cookie = await setupOwner(h);
		const setup = await h.request("/api/auth/2fa/setup", post({ password: OWNER.password }, { cookie }));
		const { secret } = (await setup.json()) as { secret: string };
		const code = (t: number) => hotp(base32Decode(secret), totpStep(t));
		expect((await h.request("/api/auth/2fa/enable", post({ code: await code(h.clock.now) }, { cookie }))).status).toBe(200);
		expect((await h.request("/api/auth/2fa/recovery-codes", post({}, { cookie }))).status).toBe(200);
		h.clock.now += FACTOR_STEP_UP_MS;
		await expectStale(await h.request("/api/auth/2fa/recovery-codes", post({}, { cookie })));
		await expectStale(await h.request("/api/auth/passkeys/register/options", post({}, { cookie })));
		expect((await h.request("/api/auth/passkeys/reauth", post({ code: await code(h.clock.now) }, { cookie }))).status).toBe(200);
		expect((await h.request("/api/auth/2fa/recovery-codes", post({}, { cookie }))).status).toBe(200);
		expect((await h.request("/api/auth/passkeys/register/options", post({}, { cookie }))).status).toBe(200);
	});
});
