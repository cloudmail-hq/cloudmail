/**
 * Token verify, the capability probe and the `/api/v1/cloudflare/connection`
 * routes, with a fake Cloudflare API (no network) and a real AuthStore +
 * CloudflareConnectionStore on node:sqlite.
 */

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStore, type AuthSql } from "../workers/auth/store-core";
import { CloudflareConnectionStore } from "../workers/lib/cf-connection-store";
import { cfConnectionDeps, invalidateCloudflareConnectionCache } from "../workers/lib/cf-connection";
import { probeCloudflareCapabilities, verifyCloudflareToken } from "../workers/lib/cf-token-verify";
import { cloudflareRouteDeps, cloudflareRoutes } from "../workers/routes/cloudflare";
import type { MailboxContext } from "../workers/lib/mailbox";
import type { Env } from "../workers/types";
import { ACCOUNT, ZONE, cfErr, cfOk, fakeCfApi, healthyRoutes } from "./helpers/cf-fake-api";

const TOKEN = "fake-cf-token-0000000000000000000000LAST";
const OTHER_ACCOUNT = "abcdefabcdefabcdefabcdefabcdefab";
const T0 = Date.UTC(2026, 9, 29);

function adapter(db: DatabaseSync): { sql: AuthSql; tx: <T>(fn: () => T) => T } {
	return {
		sql: {
			exec(query: string, ...bindings: unknown[]) {
				const rows = db.prepare(query).all(...(bindings as never[])) as any[];
				return { toArray: () => rows };
			},
		},
		tx<T>(fn: () => T): T {
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
		},
	};
}

// -- verify --------------------------------------------------------------------

describe("verifyCloudflareToken", () => {
	it("accepts an active user token on one account", async () => {
		const api = fakeCfApi(healthyRoutes());
		const r = await verifyCloudflareToken(TOKEN, { fetchImpl: api.impl });
		expect(r).toEqual({ ok: true, tokenKind: "user", accountId: ACCOUNT, accountName: "Acme" });
		expect(api.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
	});

	it("falls back to account-token verify per account", async () => {
		const api = fakeCfApi({
			"GET /user/tokens/verify": cfErr(401, "Invalid API Token", 1000),
			"GET /accounts": cfOk([{ id: ACCOUNT, name: "Acme" }, { id: OTHER_ACCOUNT, name: "Other" }]),
			[`GET /accounts/${ACCOUNT}/tokens/verify`]: cfOk({ status: "active" }),
			[`GET /accounts/${OTHER_ACCOUNT}/tokens/verify`]: cfErr(401),
		});
		const r = await verifyCloudflareToken(TOKEN, { fetchImpl: api.impl });
		expect(r).toEqual({ ok: true, tokenKind: "account", accountId: ACCOUNT, accountName: "Acme" });
	});

	it("rejects a token Cloudflare does not accept, or one that is not active", async () => {
		const bad = fakeCfApi({ "GET /user/tokens/verify": cfErr(401), "GET /accounts": cfErr(401) });
		expect(await verifyCloudflareToken(TOKEN, { fetchImpl: bad.impl })).toMatchObject({ ok: false, code: "invalid_token" });
		const disabled = fakeCfApi({ ...healthyRoutes(), "GET /user/tokens/verify": cfOk({ status: "disabled" }) });
		const r = await verifyCloudflareToken(TOKEN, { fetchImpl: disabled.impl });
		expect(r).toMatchObject({ ok: false, code: "invalid_token" });
		expect((r as { error: string }).error).toContain("disabled");
	});

	it("asks which account when the token sees several, then honours the choice", async () => {
		const routes = { ...healthyRoutes(), "GET /accounts": cfOk([{ id: ACCOUNT, name: "Acme" }, { id: OTHER_ACCOUNT, name: "Other" }]) };
		const api = fakeCfApi(routes);
		const many = await verifyCloudflareToken(TOKEN, { fetchImpl: api.impl });
		expect(many).toMatchObject({ ok: false, code: "multiple_accounts" });
		expect((many as { accounts: unknown[] }).accounts).toHaveLength(2);
		expect(await verifyCloudflareToken(TOKEN, { fetchImpl: api.impl, accountId: OTHER_ACCOUNT })).toMatchObject({
			ok: true,
			accountId: OTHER_ACCOUNT,
		});
	});

	it("never puts the token in an error", async () => {
		const bad = fakeCfApi({ "GET /user/tokens/verify": cfErr(401), "GET /accounts": cfErr(401) });
		const r = await verifyCloudflareToken(TOKEN, { fetchImpl: bad.impl });
		expect(JSON.stringify(r)).not.toContain(TOKEN);
	});
});

// -- probe ---------------------------------------------------------------------

describe("probeCloudflareCapabilities", () => {
	it("marks each read-only probe ok, dns.write unknown, and counts zones", async () => {
		const api = fakeCfApi(healthyRoutes());
		const r = await probeCloudflareCapabilities(TOKEN, { accountId: ACCOUNT, workerScriptName: "tapetide-agentic-inbox", fetchImpl: api.impl, now: T0 });
		const by = Object.fromEntries(r.capabilities.map((c) => [c.name, c.status]));
		expect(by).toEqual({
			"zones.read": "ok",
			"dns.read": "ok",
			"dns.write": "unknown",
			routing: "ok",
			"routing.rules": "ok",
			sending: "ok",
			analytics: "ok",
			dmarc: "ok",
			vectorize: "ok",
			"workers.scripts": "ok",
		});
		expect(r.zoneCount).toBe(3);
		expect(r.workerFound).toBe(true);
		// Read-only: nothing but GETs and GraphQL POSTs.
		expect(api.calls.filter((c) => c.method !== "GET").every((c) => c.path === "/graphql")).toBe(true);
	});

	it("reports failures as missing, never throws, and treats a 404 catch-all as readable", async () => {
		const api = fakeCfApi(
			healthyRoutes({
				[`GET /zones/${ZONE}/email/sending/subdomains`]: cfErr(403),
				[`GET /zones/${ZONE}/email/routing/rules/catch_all`]: cfErr(404, "not found", 1001),
				[`GET /accounts/${ACCOUNT}/vectorize/v2/indexes`]: cfErr(403),
				[`GET /accounts/${ACCOUNT}/workers/scripts`]: cfOk([{ id: "someone-else" }]),
			}),
		);
		const r = await probeCloudflareCapabilities(TOKEN, { accountId: ACCOUNT, workerScriptName: "tapetide-agentic-inbox", fetchImpl: api.impl });
		const by = Object.fromEntries(r.capabilities.map((c) => [c.name, c]));
		expect(by.sending.status).toBe("missing");
		expect(by.vectorize.status).toBe("missing");
		expect(by["routing.rules"].status).toBe("ok");
		expect(r.workerFound).toBe(false);
		expect(by["workers.scripts"].detail).toContain("not found");
	});

	it("without zone read, zone probes are unknown", async () => {
		const api = fakeCfApi(healthyRoutes({ "GET /zones": cfErr(403) }));
		const r = await probeCloudflareCapabilities(TOKEN, { accountId: ACCOUNT, workerScriptName: "x", fetchImpl: api.impl });
		const by = Object.fromEntries(r.capabilities.map((c) => [c.name, c.status]));
		expect(by["zones.read"]).toBe("missing");
		expect(by.routing).toBe("unknown");
	});

	it("times a hung probe out as missing", async () => {
		const hang = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
		const r = await probeCloudflareCapabilities(TOKEN, { accountId: ACCOUNT, workerScriptName: "x", fetchImpl: hang, timeoutMs: 20 });
		expect(r.capabilities.find((c) => c.name === "zones.read")?.status).toBe("missing");
		expect(r.capabilities.find((c) => c.name === "analytics")?.status).toBe("missing");
	});
});

// -- routes --------------------------------------------------------------------

let auth: AuthStore;
let cf: CloudflareConnectionStore;
let objects: Map<string, string>;
let sessionHash: string;
let now: number;

function rpc() {
	return new Proxy(
		{},
		{
			get: (_t, name: string) => async (...args: unknown[]) => {
				if (name === "getCloudflareConnection") return cf.get();
				if (name === "putCloudflareConnection") return cf.put(args[0] as never);
				if (name === "updateCloudflareConnection") return cf.update(args[0] as never, args[1] as number);
				if (name === "deleteCloudflareConnection") return cf.delete();
				return (auth as any)[name](...args);
			},
		},
	);
}

function makeApp(options: { admin?: boolean; method?: "session" | "token"; env?: Record<string, unknown> } = {}) {
	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => {
		c.set("authMethod", options.method ?? "session");
		c.set("authSessionHash", sessionHash);
		c.set("principal", {
			identity: { kind: "user", id: "owner@example.com", subject: null },
			role: options.admin === false ? "member" : "admin",
			mailboxes: [],
			access: [],
			enforced: true,
			developmentBypass: false,
		} as never);
		return next();
	});
	app.route("/", cloudflareRoutes);
	const env = {
		AUTH_SECRET: "route-test-secret-0123456789",
		BUCKET: {
			put: async (key: string, value: string) => void objects.set(key, value),
		},
		...options.env,
	} as unknown as Env;
	const call = (method: string, path = "/api/v1/cloudflare/connection", body?: unknown) =>
		app.request(
			path,
			{ method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
			env,
		);
	return { call };
}

beforeEach(async () => {
	const db = new DatabaseSync(":memory:");
	const { sql, tx } = adapter(db);
	auth = new AuthStore(sql, tx);
	cf = new CloudflareConnectionStore(sql, tx);
	objects = new Map();
	now = T0;
	const owner = await auth.createOwner({ email: "owner@example.com", name: "O", passwordHash: "h", now });
	if (!owner.ok) throw new Error("setup");
	sessionHash = "sess-hash";
	await auth.createSession({ userId: owner.user.id, tokenHash: sessionHash, ip: null, userAgent: null, now });
	await auth.markSessionAuthenticated(sessionHash, now);
	cloudflareRouteDeps.store = () => rpc() as never;
	cloudflareRouteDeps.now = () => now;
	cloudflareRouteDeps.fetchImpl = fakeCfApi(healthyRoutes()).impl;
	cfConnectionDeps.now = () => now;
	invalidateCloudflareConnectionCache();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function auditEntries(): any[] {
	return [...objects.entries()].filter(([k]) => k.startsWith("audit/")).map(([, v]) => JSON.parse(v));
}

describe("GET /api/v1/cloudflare/connection", () => {
	it("is admin-only", async () => {
		const res = await makeApp({ admin: false }).call("GET");
		expect(res.status).toBe(403);
	});

	it("reports not connected with a template link", async () => {
		const res = await makeApp().call("GET");
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body).toMatchObject({ connected: false, state: "none", source: null, last4: null, capabilities: [] });
		expect(body.templateUrl).toContain("https://dash.cloudflare.com/?to=/:account/api-tokens");
	});

	it("reports the env token as source env, with last 4 only", async () => {
		const res = await makeApp({ env: { CF_API_TOKEN: TOKEN } }).call("GET");
		const body = (await res.json()) as any;
		expect(body).toMatchObject({ connected: true, source: "env", last4: "LAST" });
		expect(JSON.stringify(body)).not.toContain(TOKEN);
	});
});

describe("PUT /api/v1/cloudflare/connection", () => {
	it("verifies, probes, stores encrypted and audits last 4 only", async () => {
		const logs = vi.spyOn(console, "log");
		const errors = vi.spyOn(console, "error");
		const res = await makeApp().call("PUT", undefined, { token: TOKEN });
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body).toMatchObject({ connected: true, state: "connected", source: "connection", accountId: ACCOUNT, accountName: "Acme", tokenKind: "user", last4: "LAST", verifiedAt: now });
		expect(body.capabilities).toHaveLength(10);
		expect(body.templateUrl).toContain(`?to=/${ACCOUNT}/api-tokens`);
		expect(JSON.stringify(body)).not.toContain(TOKEN);

		const row = cf.get()!;
		expect(row.tokenEnc).not.toContain(TOKEN);
		expect(row.createdBy).toBe("owner@example.com");

		const entries = auditEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ action: "cloudflare.connect", detail: { last4: "LAST", account: ACCOUNT, kind: "user" } });
		expect(JSON.stringify(entries)).not.toContain(TOKEN);
		for (const spy of [logs, errors]) {
			for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(TOKEN);
		}

		// The next GET resolves the stored token without re-verifying.
		const get = (await (await makeApp().call("GET")).json()) as any;
		expect(get).toMatchObject({ connected: true, source: "connection", last4: "LAST" });
	});

	it("400 invalid_token when Cloudflare refuses it, and stores nothing", async () => {
		cloudflareRouteDeps.fetchImpl = fakeCfApi({ "GET /user/tokens/verify": cfErr(401), "GET /accounts": cfErr(401) }).impl;
		const res = await makeApp().call("PUT", undefined, { token: TOKEN });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "invalid_token" });
		expect(cf.get()).toBeNull();
		expect(auditEntries()).toHaveLength(0);
	});

	it("400 invalid_token for a malformed body", async () => {
		const res = await makeApp().call("PUT", undefined, { token: "short" });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "invalid_token" });
	});

	it("409 multiple_accounts with the list, then succeeds with accountId", async () => {
		cloudflareRouteDeps.fetchImpl = fakeCfApi({
			...healthyRoutes(),
			"GET /accounts": cfOk([{ id: ACCOUNT, name: "Acme" }, { id: OTHER_ACCOUNT, name: "Other" }]),
		}).impl;
		const res = await makeApp().call("PUT", undefined, { token: TOKEN });
		expect(res.status).toBe(409);
		const body = (await res.json()) as any;
		expect(body.code).toBe("multiple_accounts");
		expect(body.accounts.map((a: { id: string }) => a.id)).toEqual([ACCOUNT, OTHER_ACCOUNT]);
		const ok = await makeApp().call("PUT", undefined, { token: TOKEN, accountId: ACCOUNT });
		expect(ok.status).toBe(200);
	});

	it("409 env_token_active while CF_API_TOKEN is set", async () => {
		const res = await makeApp({ env: { CF_API_TOKEN: "env-token-xxxxxxxxxxxxxxxx" } }).call("PUT", undefined, { token: TOKEN });
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ code: "env_token_active" });
	});

	it("needs a browser session that re-authenticated recently", async () => {
		const token = await makeApp({ method: "token" }).call("PUT", undefined, { token: TOKEN });
		expect(token.status).toBe(403);
		expect(await token.json()).toMatchObject({ code: "session_required" });
		now = T0 + 16 * 60_000;
		const stale = await makeApp().call("PUT", undefined, { token: TOKEN });
		expect(stale.status).toBe(403);
		expect(await stale.json()).toMatchObject({ code: "reauth_required" });
		expect(cf.get()).toBeNull();
	});
});

describe("verify and DELETE", () => {
	it("re-probes and updates capabilities", async () => {
		await makeApp().call("PUT", undefined, { token: TOKEN });
		cloudflareRouteDeps.fetchImpl = fakeCfApi(healthyRoutes({ [`GET /accounts/${ACCOUNT}/vectorize/v2/indexes`]: cfErr(403) })).impl;
		now += 60_000;
		const res = await makeApp().call("POST", "/api/v1/cloudflare/connection/verify");
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.verifiedAt).toBe(now);
		expect(body.capabilities.find((c: { name: string }) => c.name === "vectorize").status).toBe("missing");
	});

	it("marks everything missing when the token was revoked", async () => {
		await makeApp().call("PUT", undefined, { token: TOKEN });
		cloudflareRouteDeps.fetchImpl = fakeCfApi({ "GET /user/tokens/verify": cfErr(401), "GET /accounts": cfErr(401) }).impl;
		const res = await makeApp().call("POST", "/api/v1/cloudflare/connection/verify");
		expect(res.status).toBe(400);
		const body = (await res.json()) as any;
		expect(body.code).toBe("invalid_token");
		expect(body.capabilities.every((c: { status: string }) => c.status === "missing")).toBe(true);
	});

	it("verify reports reconnect_required when the token no longer decrypts", async () => {
		await makeApp().call("PUT", undefined, { token: TOKEN });
		invalidateCloudflareConnectionCache();
		const changed = makeApp({ env: { AUTH_SECRET: "a-new-secret-0123456789abc" } });
		const get = (await (await changed.call("GET")).json()) as any;
		expect(get).toMatchObject({ connected: false, state: "reconnect_required", last4: "LAST" });
		const res = await changed.call("POST", "/api/v1/cloudflare/connection/verify");
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ code: "reconnect_required" });
	});

	it("DELETE forgets the token at once on this isolate and audits it", async () => {
		await makeApp().call("PUT", undefined, { token: TOKEN });
		const res = await makeApp().call("DELETE");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ connected: false, state: "none" });
		expect(cf.get()).toBeNull();
		const entries = auditEntries().map((e) => e.action);
		expect(entries).toContain("cloudflare.disconnect");
		const disc = auditEntries().find((e) => e.action === "cloudflare.disconnect");
		expect(disc.detail).toEqual({ last4: "LAST", account: ACCOUNT });
	});

	it("DELETE also needs a fresh session", async () => {
		await makeApp().call("PUT", undefined, { token: TOKEN });
		now = T0 + 20 * 60_000;
		const res = await makeApp().call("DELETE");
		expect(res.status).toBe(403);
		expect(cf.get()).not.toBeNull();
	});
});
