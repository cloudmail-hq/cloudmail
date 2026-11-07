// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

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
import { createAuthRoutes } from "../workers/auth/routes";
import { AuthStore, WEBAUTHN_CHALLENGE_MS, type AuthSql } from "../workers/auth/store-core";
import { base32Decode, hotp, totpStep } from "../workers/auth/totp";
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
}

function build(options: { env?: Partial<Env>; webauthn?: WebAuthnVerifier; limiter?: (key: string) => boolean } = {}): Harness {
	const store = sqliteStore();
	const clock = { now: Date.UTC(2026, 5, 1) };
	const limited: string[] = [];
	const env = {
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

	const executionCtx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
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
	return { request, store, clock, env, limited };
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
			expect(await unknown.json()).toMatchObject({ code: "passkey_invalid" });

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
		expect(await res.json()).toMatchObject({ code: "passkey_invalid" });
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

		// The MFA challenge is spent.
		const again = await h.request("/api/auth/passkeys/mfa/options", post({ challenge }));
		expect(again.status).toBe(401);
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
