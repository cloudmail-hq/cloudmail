// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * OAuth sign-in for MCP clients, end to end over HTTP.
 *
 * The app is assembled in the same order as `workers/app.ts`: OAuth protocol
 * endpoints, CSRF guard, authenticate, `/api/auth`, the gate, the consent page,
 * then `/mcp` (a stub that echoes the resolved principal) and the real API app.
 * The OAuth library runs for real against a Map-backed KV, so dynamic
 * registration, PKCE, the consent transaction, code exchange and refresh
 * rotation are the library's production code; only `cloudflare:workers`, which
 * it imports for a type check on handlers we never pass, is stubbed.
 *
 * What these tests pin down is the glue: an OAuth token resolves to the user
 * who approved it, exactly like their `ttk_` token, on `/mcp` only, and stops
 * working the moment that user is disabled, deleted, signed out everywhere or
 * disconnects the app.
 */

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const { app: apiApp } = await import("../workers/index");
const { createAuthGate, createAuthenticate } = await import("../workers/auth/middleware");
const { createAuthRoutes } = await import("../workers/auth/routes");
const { AuthStore } = await import("../workers/auth/store-core");
const { csrfGuard } = await import("../workers/lib/csrf");
const { resolvePrincipal } = await import("../workers/lib/mailbox");
const { createMcpOAuthHooks, createOAuthAuthorizeHandler, createOAuthProtocolMiddleware, consentCsp, consentHtml } =
	await import("../workers/auth/oauth");
const { isStaticPath } = await import("../workers/auth/middleware");

import type { AuthDeps } from "../workers/auth/middleware";
import { AuthCache, withAuthCacheInvalidation } from "../workers/auth/session-cache";
import type { AuthSql } from "../workers/auth/store-core";
import type { MailboxContext } from "../workers/lib/mailbox";
import type { Env } from "../workers/types";

const ORIGIN = "https://mail.example.com";
const RESOURCE = `${ORIGIN}/mcp`;
const SETUP_TOKEN = "correct-horse-battery-staple";
const OWNER = { email: "owner@example.com", name: "Olivia Owner", password: "owner-password-1" };
const MEMBER = { email: "member@example.com", password: "member-password-1" };
const SUPPORT = "support@example.com";
const REDIRECT = "http://127.0.0.1:33418/callback";

// -- harness -------------------------------------------------------------------

function sqliteStore() {
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

/** Enough of KVNamespace for the provider: get/put/delete/list with prefix, cursor and metadata. */
function fakeKv() {
	const data = new Map<string, { value: string; metadata?: unknown }>();
	return {
		async get(key: string, options?: { type?: string } | string) {
			const entry = data.get(key);
			if (!entry) return null;
			const type = typeof options === "string" ? options : options?.type;
			return type === "json" ? JSON.parse(entry.value) : entry.value;
		},
		async put(key: string, value: string, options?: { metadata?: unknown }) {
			data.set(key, { value, metadata: options?.metadata });
		},
		async delete(key: string) {
			data.delete(key);
		},
		async list(options: { prefix?: string; limit?: number; cursor?: string } = {}) {
			const keys = [...data.keys()].filter((k) => k.startsWith(options.prefix ?? "")).sort();
			const start = options.cursor ? Number(options.cursor) : 0;
			const limit = options.limit ?? 1000;
			const page = keys.slice(start, start + limit);
			const done = start + limit >= keys.length;
			return {
				keys: page.map((name) => ({ name, metadata: data.get(name)?.metadata })),
				list_complete: done,
				cursor: done ? undefined : String(start + limit),
			};
		},
		_data: data,
	};
}

function fakeBucket(initial: Record<string, unknown> = {}) {
	const store = new Map<string, string>(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
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
				objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
				truncated: false as const,
			};
		},
	};
}

type Init = RequestInit & { cookie?: string | null; bearer?: string; site?: string | null };

function build(options: { withKv?: boolean } = {}) {
	const store = sqliteStore();
	const kv = fakeKv();
	const env = {
		DOMAINS: "example.com",
		SETUP_TOKEN,
		AUTH_SECRET: "test-auth-secret",
		BUCKET: fakeBucket({ [`mailboxes/${SUPPORT}.json`]: { fromName: "Support" } }),
		MAILBOX: { idFromName: (name: string) => ({ name }), get: () => ({}) },
		AUTH_STORE: {},
		...(options.withKv === false ? {} : { OAUTH_KV: kv }),
	} as unknown as Env;

	// Credential cache on, as in production.
	const authCache = new AuthCache();
	const getStore = withAuthCacheInvalidation(() => store, authCache);
	const deps: AuthDeps = { getStore, authCache, isDev: false, mcpOAuth: createMcpOAuthHooks(getStore) };
	const app = new Hono<MailboxContext>();
	app.use("*", createOAuthProtocolMiddleware(deps));
	app.use("*", csrfGuard);
	app.use("*", createAuthenticate(deps));
	app.route("/api/auth", createAuthRoutes(deps));
	app.use("*", createAuthGate(deps));
	app.on(["GET", "POST"], "/oauth/authorize", createOAuthAuthorizeHandler(deps));
	app.use("/mcp", resolvePrincipal);
	app.all("/mcp", (c) =>
		c.json({ identity: c.var.accessIdentity ?? null, method: c.var.authMethod, role: c.var.principal.role }),
	);
	app.route("/", apiApp);
	app.all("*", (c) => c.html("<html>page</html>"));

	const pending: Promise<unknown>[] = [];
	const executionCtx = {
		waitUntil: (p: Promise<unknown>) => void pending.push(p),
		passThroughOnException: () => undefined,
		props: {},
	} as unknown as ExecutionContext;

	const request = (path: string, init: Init = {}) => {
		const { cookie, bearer, site, ...rest } = init;
		const headers: Record<string, string> = {
			"cf-connecting-ip": "203.0.113.7",
			...(site === null ? {} : { "Sec-Fetch-Site": site ?? "same-origin" }),
			...(rest.headers as Record<string, string>),
		};
		if (rest.body && typeof rest.body === "string" && !headers["Content-Type"]) {
			headers["Content-Type"] = "application/json";
		}
		if (cookie) headers.Cookie = cookie;
		if (bearer) headers.Authorization = `Bearer ${bearer}`;
		const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
		return Promise.resolve(app.fetch(new Request(url, { redirect: "manual", ...rest, headers }), env, executionCtx));
	};
	const settle = async () => {
		while (pending.length) await Promise.all(pending.splice(0));
	};
	return { request, store, kv, env, settle };
}

type H = ReturnType<typeof build>;

function cookieFrom(res: Response): string {
	const header = res.headers.get("set-cookie");
	if (!header) throw new Error("no Set-Cookie");
	return header.split(";")[0];
}

/** Every `name=value` from all Set-Cookie headers. */
function cookiesFrom(res: Response): string[] {
	return res.headers.getSetCookie().map((c) => c.split(";")[0]);
}

function json(body: unknown, extra: Init = {}): Init {
	return { method: "POST", body: JSON.stringify(body), ...extra };
}

async function setupOwner(h: H): Promise<string> {
	const res = await h.request("/api/auth/setup", json({ setupToken: SETUP_TOKEN, ...OWNER }));
	expect(res.status).toBe(201);
	return cookieFrom(res);
}

async function inviteMember(h: H, ownerCookie: string): Promise<{ cookie: string; id: string }> {
	const created = await h.request(
		"/api/auth/admin/invites",
		json({ email: MEMBER.email, role: "member", mailboxes: [SUPPORT] }, { cookie: ownerCookie }),
	);
	expect(created.status).toBe(201);
	const { url } = (await created.json()) as { url: string };
	const accepted = await h.request(
		"/api/auth/invites/accept",
		json({ token: url.split("/invite/")[1], name: "Member", password: MEMBER.password }),
	);
	expect(accepted.status).toBe(200);
	const { user } = (await accepted.json()) as { user: { id: string } };
	return { cookie: cookieFrom(accepted), id: user.id };
}

function b64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

async function pkce() {
	const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
	return { verifier, challenge };
}

/** What an MCP client does before it opens the browser: dynamic registration. */
async function registerClient(h: H, name = "Claude Code"): Promise<string> {
	const res = await h.request("/oauth/register", {
		method: "POST",
		site: null,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_name: name,
			redirect_uris: [REDIRECT],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		}),
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { client_id: string }).client_id;
}

function authorizePath(clientId: string, challenge: string, state = "st4te-value"): string {
	const q = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: REDIRECT,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		scope: "mcp",
		resource: RESOURCE,
	});
	return `/oauth/authorize?${q}`;
}

/** Open the consent page as `cookie`; returns the handle and the binding cookie. */
async function openConsent(h: H, cookie: string, path: string) {
	const res = await h.request(path, { cookie });
	expect(res.status).toBe(200);
	const html = await res.text();
	const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
	if (!handle) throw new Error("no handle on the consent page");
	return { res, html, handle, binding: cookiesFrom(res).join("; ") };
}

async function decide(h: H, cookie: string, binding: string, handle: string, decision: "approve" | "deny") {
	return h.request("/oauth/authorize" + "", {
		method: "POST",
		cookie: `${cookie}; ${binding}`,
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ handle, decision }).toString(),
	});
}

async function exchangeCode(h: H, clientId: string, code: string, verifier: string) {
	return h.request("/oauth/token", {
		method: "POST",
		site: null,
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: REDIRECT,
			client_id: clientId,
			code_verifier: verifier,
			resource: RESOURCE,
		}).toString(),
	});
}

async function refresh(h: H, clientId: string, refreshToken: string) {
	return h.request("/oauth/token", {
		method: "POST",
		site: null,
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }).toString(),
	});
}

interface Tokens {
	access_token: string;
	refresh_token: string;
	resource: string;
	scope: string;
}

/** The whole dance for `cookie`'s user. */
async function connect(h: H, cookie: string, name?: string): Promise<{ clientId: string; tokens: Tokens }> {
	const clientId = await registerClient(h, name);
	const { verifier, challenge } = await pkce();
	const consent = await openConsent(h, cookie, authorizePath(clientId, challenge));
	const approved = await decide(h, cookie, consent.binding, consent.handle, "approve");
	expect(approved.status).toBe(302);
	const location = new URL(approved.headers.get("location")!);
	expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
	expect(location.searchParams.get("state")).toBe("st4te-value");
	expect(location.searchParams.get("iss")).toBe(ORIGIN);
	const res = await exchangeCode(h, clientId, location.searchParams.get("code")!, verifier);
	expect(res.status).toBe(200);
	return { clientId, tokens: (await res.json()) as Tokens };
}

// -- discovery -------------------------------------------------------------------

describe("discovery", () => {
	let h: H;
	beforeEach(async () => {
		h = build();
		await setupOwner(h);
	});

	it("answers unauthenticated /mcp with a Bearer challenge naming the resource metadata", async () => {
		const res = await h.request("/mcp", json({ jsonrpc: "2.0", method: "initialize", id: 1 }, { site: null }));
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({ code: "unauthenticated" });
		const challenge = res.headers.get("www-authenticate")!;
		expect(challenge).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
		expect(challenge).toMatch(/^Bearer /);
		expect(challenge).not.toContain("invalid_token");
	});

	it("says invalid_token when an OAuth bearer was presented and refused", async () => {
		const res = await h.request("/mcp", { method: "POST", site: null, bearer: "u:g:not-a-real-token" });
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
	});

	it("does not advertise OAuth on /api", async () => {
		const res = await h.request("/api/v1/mailboxes", { site: null });
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBeNull();
	});

	it("serves RFC 9728 protected resource metadata for /mcp", async () => {
		const res = await h.request("/.well-known/oauth-protected-resource/mcp", { site: "cross-site" });
		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		expect(await res.json()).toMatchObject({
			resource: RESOURCE,
			authorization_servers: [ORIGIN],
			scopes_supported: ["mcp"],
		});
	});

	it("serves RFC 8414 authorization server metadata requiring S256 PKCE", async () => {
		const res = await h.request("/.well-known/oauth-authorization-server");
		expect(res.status).toBe(200);
		const meta = (await res.json()) as Record<string, unknown>;
		expect(meta).toMatchObject({
			issuer: ORIGIN,
			authorization_endpoint: `${ORIGIN}/oauth/authorize`,
			token_endpoint: `${ORIGIN}/oauth/token`,
			registration_endpoint: `${ORIGIN}/oauth/register`,
			code_challenge_methods_supported: ["S256"],
		});
		expect(meta.grant_types_supported).toContain("refresh_token");
	});

	it("keeps the well-known endpoints out of the production static-file 404", () => {
		expect(isStaticPath("/.well-known/oauth-authorization-server")).toBe(false);
		expect(isStaticPath("/.well-known/oauth-protected-resource/mcp")).toBe(false);
		expect(isStaticPath("/.well-known/security.txt")).toBe(true);
	});

	it("lets dynamic registration through without a Sec-Fetch-Site header or session", async () => {
		await registerClient(h);
	});

	it("is switched off, ttk_ untouched, when the KV binding is absent", async () => {
		const bare = build({ withKv: false });
		await setupOwner(bare);
		// Falls through to the page catch-all (the static 404 in production), never metadata.
		const meta = await bare.request("/.well-known/oauth-authorization-server");
		expect(meta.headers.get("content-type") ?? "").not.toContain("application/json");
		const res = await bare.request("/mcp", { method: "POST", site: null });
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBeNull();
	});
});

// -- consent page ------------------------------------------------------------------

describe("consent page", () => {
	let h: H;
	let owner: string;
	beforeEach(async () => {
		h = build();
		owner = await setupOwner(h);
	});

	it("sends a visitor without a session to sign in, carrying the request as next", async () => {
		const clientId = await registerClient(h);
		const path = authorizePath(clientId, (await pkce()).challenge);
		const res = await h.request(path);
		expect(res.status).toBe(302);
		const location = res.headers.get("location")!;
		expect(location.startsWith("/login?next=")).toBe(true);
		expect(decodeURIComponent(location.slice("/login?next=".length))).toBe(path);
	});

	it("refuses to approve with an API token instead of a browser session", async () => {
		const created = await h.request("/api/auth/tokens", json({ name: "cli" }, { cookie: owner }));
		const { secret } = (await created.json()) as { secret: string };
		const clientId = await registerClient(h);
		const res = await h.request(authorizePath(clientId, (await pkce()).challenge), { bearer: secret });
		expect(res.status).toBe(403);
		expect(await res.text()).toContain("browser session");
		expect(h.kv._data.size).toBeGreaterThan(0);
		expect([...h.kv._data.keys()].some((k) => k.startsWith("grant:"))).toBe(false);
	});

	it("shows the client name, the redirect host and what is granted, escaped", async () => {
		const clientId = await registerClient(h, `<img src=x onerror=alert(1)>`);
		const { html, res } = await openConsent(h, owner, authorizePath(clientId, (await pkce()).challenge));
		expect(html).toContain("&#60;img src=x onerror=alert(1)&#62;");
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("127.0.0.1");
		expect(html).toContain("as you");
		expect(html).toContain("mailbox access");
		expect(html).toContain("app on your computer");
		expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		expect(res.headers.get("content-security-policy")).toContain("form-action 'self' http://127.0.0.1:33418");
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	it("rejects a request without PKCE, back to the client", async () => {
		const clientId = await registerClient(h);
		const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: "s" });
		const res = await h.request(`/oauth/authorize?${q}`, { cookie: owner });
		expect(res.status).toBe(302);
		expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
	});

	it("renders, never redirects, when the redirect URI is not the registered one", async () => {
		const clientId = await registerClient(h);
		const q = new URLSearchParams({
			response_type: "code",
			client_id: clientId,
			redirect_uri: "https://evil.example/cb",
			code_challenge: (await pkce()).challenge,
			code_challenge_method: "S256",
		});
		const res = await h.request(`/oauth/authorize?${q}`, { cookie: owner });
		expect(res.status).toBe(400);
		expect(res.headers.get("location")).toBeNull();
	});

	it("refuses a cross-site approve POST before it reaches the consent handler", async () => {
		const clientId = await registerClient(h);
		const consent = await openConsent(h, owner, authorizePath(clientId, (await pkce()).challenge));
		const res = await h.request("/oauth/authorize", {
			method: "POST",
			site: "cross-site",
			cookie: `${owner}; ${consent.binding}`,
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ handle: consent.handle, decision: "approve" }).toString(),
		});
		expect(res.status).toBe(403);
		expect(await h.store.listOAuthGrants((await h.store.getUserByEmail(OWNER.email))!.id)).toHaveLength(0);
	});

	it("refuses an approval from a browser that did not open the page", async () => {
		const clientId = await registerClient(h);
		const consent = await openConsent(h, owner, authorizePath(clientId, (await pkce()).challenge));
		const res = await decide(h, owner, "", consent.handle, "approve");
		expect(res.status).toBe(400);
	});

	it("sends access_denied back to the client on Deny, and records nothing", async () => {
		const clientId = await registerClient(h);
		const consent = await openConsent(h, owner, authorizePath(clientId, (await pkce()).challenge));
		const res = await decide(h, owner, consent.binding, consent.handle, "deny");
		expect(res.status).toBe(302);
		const location = new URL(res.headers.get("location")!);
		expect(location.searchParams.get("error")).toBe("access_denied");
		expect(location.searchParams.get("state")).toBe("st4te-value");
		expect(await h.store.listOAuthGrants((await h.store.getUserByEmail(OWNER.email))!.id)).toHaveLength(0);
	});

	it("uses each consent handle once", async () => {
		const clientId = await registerClient(h);
		const consent = await openConsent(h, owner, authorizePath(clientId, (await pkce()).challenge));
		expect((await decide(h, owner, consent.binding, consent.handle, "approve")).status).toBe(302);
		expect((await decide(h, owner, consent.binding, consent.handle, "approve")).status).toBe(400);
	});
});

// -- token -> identity -------------------------------------------------------------

describe("an OAuth token on /mcp", () => {
	let h: H;
	let owner: string;
	beforeEach(async () => {
		h = build();
		owner = await setupOwner(h);
	});

	it("acts as the approving user, exactly like their ttk_ token", async () => {
		const { tokens } = await connect(h, owner);
		expect(tokens.resource).toBe(RESOURCE);
		const ownerUser = (await h.store.getUserByEmail(OWNER.email))!;

		const viaOAuth = await h.request("/mcp", { method: "POST", site: null, bearer: tokens.access_token });
		expect(viaOAuth.status).toBe(200);
		const oauthBody = (await viaOAuth.json()) as Record<string, unknown>;
		expect(oauthBody).toEqual({
			identity: { kind: "user", id: OWNER.email, subject: ownerUser.id },
			method: "oauth",
			role: "admin",
		});

		const created = await h.request("/api/auth/tokens", json({ name: "cli" }, { cookie: owner }));
		const { secret } = (await created.json()) as { secret: string };
		const viaTtk = (await (await h.request("/mcp", { method: "POST", site: null, bearer: secret })).json()) as Record<
			string,
			unknown
		>;
		expect(viaTtk.identity).toEqual(oauthBody.identity);
		expect(viaTtk.role).toBe(oauthBody.role);
	});

	it("carries a member's grants, not more", async () => {
		const member = await inviteMember(h, owner);
		const { tokens } = await connect(h, member.cookie);
		const res = await h.request("/mcp", { method: "POST", site: null, bearer: tokens.access_token });
		expect(await res.json()).toMatchObject({
			identity: { kind: "user", id: MEMBER.email, subject: member.id },
			role: "member",
		});
	});

	it("is not accepted on /api/v1", async () => {
		const { tokens } = await connect(h, owner);
		const res = await h.request("/api/v1/me", { site: null, bearer: tokens.access_token });
		expect(res.status).toBe(401);
		const mailboxes = await h.request("/api/v1/mailboxes", { site: null, bearer: tokens.access_token });
		expect(mailboxes.status).toBe(401);
	});

	it("is not accepted for /api/auth either (no minting tokens with it)", async () => {
		const { tokens } = await connect(h, owner);
		const res = await h.request("/api/auth/tokens", json({ name: "x" }, { site: null, bearer: tokens.access_token }));
		expect(res.status).toBe(401);
	});

	it("stops working when the user is disabled, and cannot be refreshed", async () => {
		const member = await inviteMember(h, owner);
		const { clientId, tokens } = await connect(h, member.cookie);
		const off = await h.request(`/api/auth/admin/users/${member.id}/disable`, json({ disabled: true }, { cookie: owner }));
		expect(off.status).toBe(204);
		await h.settle();

		const res = await h.request("/mcp", { method: "POST", site: null, bearer: tokens.access_token });
		expect(res.status).toBe(401);
		expect((await refresh(h, clientId, tokens.refresh_token)).status).toBe(400);

		// Re-enabling restores nothing: the approval is gone with the sessions.
		await h.request(`/api/auth/admin/users/${member.id}/disable`, json({ disabled: false }, { cookie: owner }));
		expect((await h.request("/mcp", { method: "POST", site: null, bearer: tokens.access_token })).status).toBe(401);
	});

	it("stops working when the user is disabled even if KV cleanup has not run", async () => {
		const member = await inviteMember(h, owner);
		const { tokens } = await connect(h, member.cookie);
		// Straight to the store: no route, so no provider cleanup at all.
		await h.store.setDisabled(member.id, true);
		expect((await h.request("/mcp", { method: "POST", site: null, bearer: tokens.access_token })).status).toBe(401);
	});

	it("stops working when the user is deleted", async () => {
		const member = await inviteMember(h, owner);
		const { tokens } = await connect(h, member.cookie);
		expect((await h.request(`/api/auth/admin/users/${member.id}`, { method: "DELETE", cookie: owner })).status).toBe(204);
		await h.settle();
		expect((await h.request("/mcp", { method: "POST", site: null, bearer: tokens.access_token })).status).toBe(401);
		expect([...h.kv._data.keys()].some((k) => k.startsWith(`grant:${member.id}:`))).toBe(false);
	});

	it("stops working after 'sign out all other sessions'", async () => {
		const { tokens, clientId } = await connect(h, owner);
		const res = await h.request("/api/auth/sessions/revoke-others", json({}, { cookie: owner }));
		expect(res.status).toBe(200);
		expect((await h.request("/mcp", { method: "POST", site: null, bearer: tokens.access_token })).status).toBe(401);
		expect((await refresh(h, clientId, tokens.refresh_token)).status).toBe(400);
	});

	it("refreshes with rotation", async () => {
		const { clientId, tokens } = await connect(h, owner);
		const first = await refresh(h, clientId, tokens.refresh_token);
		expect(first.status).toBe(200);
		const next = (await first.json()) as Tokens;
		expect(next.refresh_token).not.toBe(tokens.refresh_token);
		expect((await h.request("/mcp", { method: "POST", site: null, bearer: next.access_token })).status).toBe(200);
		// Using the new refresh token retires the old one.
		expect((await refresh(h, clientId, next.refresh_token)).status).toBe(200);
		expect((await refresh(h, clientId, tokens.refresh_token)).status).toBe(400);
	});

	it("refuses a code exchange with the wrong PKCE verifier", async () => {
		const clientId = await registerClient(h);
		const { challenge } = await pkce();
		const consent = await openConsent(h, owner, authorizePath(clientId, challenge));
		const approved = await decide(h, owner, consent.binding, consent.handle, "approve");
		const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
		const res = await exchangeCode(h, clientId, code, (await pkce()).verifier);
		expect(res.status).toBe(400);
	});

	it("does not fall back to the session cookie when an OAuth bearer is refused", async () => {
		const res = await h.request("/mcp", { method: "POST", cookie: owner, bearer: "u:g:bogus" });
		expect(res.status).toBe(401);
	});
});

// -- connected apps -------------------------------------------------------------------

describe("connected apps", () => {
	let h: H;
	let owner: string;
	beforeEach(async () => {
		h = build();
		owner = await setupOwner(h);
	});

	it("lists approved clients with name, host and last use, and revokes one", async () => {
		const { tokens } = await connect(h, owner, "Cursor");
		await h.request("/mcp", { method: "POST", site: null, bearer: tokens.access_token });

		const listed = await h.request("/api/auth/oauth-grants", { cookie: owner });
		const { grants } = (await listed.json()) as {
			grants: Array<{ id: string; clientName: string; redirectHost: string; createdAt: number; lastUsedAt: number | null }>;
		};
		expect(grants).toHaveLength(1);
		expect(grants[0]).toMatchObject({ clientName: "Cursor", redirectHost: "127.0.0.1" });
		expect(grants[0].lastUsedAt).not.toBeNull();

		const revoked = await h.request(`/api/auth/oauth-grants/${grants[0].id}`, { method: "DELETE", cookie: owner });
		expect(revoked.status).toBe(204);
		await h.settle();
		expect((await h.request("/mcp", { method: "POST", site: null, bearer: tokens.access_token })).status).toBe(401);
		const ownerId = (await h.store.getUserByEmail(OWNER.email))!.id;
		expect([...h.kv._data.keys()].some((k) => k.startsWith(`grant:${ownerId}:`))).toBe(false);
	});

	it("revokes only the caller's own grants", async () => {
		const member = await inviteMember(h, owner);
		await connect(h, owner);
		const ownerId = (await h.store.getUserByEmail(OWNER.email))!.id;
		const [grant] = await h.store.listOAuthGrants(ownerId);
		const res = await h.request(`/api/auth/oauth-grants/${grant.id}`, { method: "DELETE", cookie: member.cookie });
		expect(res.status).toBe(404);
		expect(await h.store.listOAuthGrants(ownerId)).toHaveLength(1);
	});

	it("replaces, not stacks, a re-approval of the same client", async () => {
		const clientId = await registerClient(h);
		for (let i = 0; i < 2; i++) {
			const consent = await openConsent(h, owner, authorizePath(clientId, (await pkce()).challenge));
			expect((await decide(h, owner, consent.binding, consent.handle, "approve")).status).toBe(302);
		}
		const ownerId = (await h.store.getUserByEmail(OWNER.email))!.id;
		expect(await h.store.listOAuthGrants(ownerId)).toHaveLength(1);
	});
});

// -- pure helpers ---------------------------------------------------------------------

describe("consent rendering", () => {
	it("never lets a redirect URI inject into the CSP", () => {
		expect(consentCsp("http://127.0.0.1:1234/cb")).toContain("form-action 'self' http://127.0.0.1:1234;");
		expect(consentCsp("not a url")).toContain("form-action 'self';");
	});

	it("labels a self-registered client as unverified", () => {
		const html = consentHtml({
			details: {
				clientId: "c",
				clientName: "Thing",
				redirectUri: "https://app.example/cb",
				redirectHost: "app.example",
				redirectIsLoopback: false,
				scope: ["mcp"],
			},
			handle: "h",
			email: "a@example.com",
			appName: "Mail",
		});
		expect(html).toContain("not verified");
		expect(html).not.toContain("app on your computer");
	});
});
