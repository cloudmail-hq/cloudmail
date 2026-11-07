// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Settings → AI providers over HTTP (workers/routes/ai-providers.ts), through
 * the real Hono app: who may call what, how tokens and secret headers are
 * stored and never returned, URL and header validation, idempotent create,
 * discovery and Test against a fake gateway, routing and its capability
 * gate, and the audit trail.
 */

import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { resetAiProvidersCache, AI_PROVIDERS_KEY } from "../workers/lib/ai-providers-store";
import { setAiProviderRouteNetworkForTests } from "../workers/routes/ai-providers";
import { openProviderHeader, openProviderToken } from "../workers/lib/ai-provider-secrets";
import { aiBreaker } from "../workers/lib/ai-breaker";
import { ADMIN, AUTH_SECRET, MEMBER, as, json, makeHarness, type Caller } from "./fixtures/ai-gateway/harness";
import { OAI_BASE, OAI_CHAT, OAI_EMBED, OAI_TOKEN, fakeNetwork } from "./fixtures/ai-gateway/fake-gateways";

const HEADER_SECRET = "hdr-secret-value-55aa";

let h: ReturnType<typeof makeHarness>;
let net: ReturnType<typeof fakeNetwork>;

beforeEach(() => {
	resetAiProvidersCache();
	aiBreaker.reset();
	h = makeHarness();
	net = fakeNetwork();
	setAiProviderRouteNetworkForTests(net.fetch);
});
afterEach(() => {
	setAiProviderRouteNetworkForTests(undefined);
	aiBreaker.reset();
});

const admin = (caller: Caller = { kind: "access" }) => as(ADMIN, h.env, caller);

const createBody = (extra: Record<string, unknown> = {}) => ({
	label: "OAI gateway",
	wire: "openai",
	baseUrl: OAI_BASE,
	auth: { scheme: "bearer" },
	token: OAI_TOKEN,
	...extra,
});

async function createOai(extra: Record<string, unknown> = {}): Promise<any> {
	const res = await admin()("/api/v1/ai/providers", { method: "POST", body: createBody(extra) });
	expect(res.status).toBe(201);
	return (await json(res)).provider;
}

const stored = () => JSON.parse(h.bucket.store.get(AI_PROVIDERS_KEY)!.body);
const auditEntries = () =>
	[...h.bucket.store.entries()].filter(([k]) => k.startsWith("audit/_instance/")).map(([, v]) => JSON.parse(v.body));

async function discover(id: string) {
	const res = await admin()(`/api/v1/ai/providers/${id}/discover`, { method: "POST" });
	expect(res.status).toBe(200);
	return (await json(res)).provider;
}

async function probe(id: string, modelId: string, checks?: string[]) {
	const res = await admin()(`/api/v1/ai/providers/${id}/test`, { method: "POST", body: { modelId, ...(checks ? { checks } : {}) } });
	expect(res.status).toBe(200);
	return json(res);
}

// ── Authz ──────────────────────────────────────────────────────────

const ENDPOINTS: { method: string; path: (id: string) => string; body?: unknown; personOnly: boolean }[] = [
	{ method: "GET", path: () => "/api/v1/ai/providers", personOnly: false },
	{ method: "POST", path: () => "/api/v1/ai/providers", body: createBody({ label: "Second" }), personOnly: true },
	{ method: "PATCH", path: (id) => `/api/v1/ai/providers/${id}`, body: { label: "Renamed" }, personOnly: true },
	{ method: "DELETE", path: (id) => `/api/v1/ai/providers/${id}`, personOnly: true },
	{ method: "POST", path: (id) => `/api/v1/ai/providers/${id}/discover`, personOnly: false },
	{ method: "PATCH", path: (id) => `/api/v1/ai/providers/${id}/models`, body: { add: [{ id: "my-model" }] }, personOnly: true },
	{ method: "POST", path: (id) => `/api/v1/ai/providers/${id}/test`, body: { modelId: OAI_CHAT, checks: ["text"] }, personOnly: false },
	{ method: "GET", path: () => "/api/v1/ai/routing", personOnly: false },
	{ method: "PATCH", path: () => "/api/v1/ai/routing", body: { fallbackToWorkersAi: false }, personOnly: true },
];

describe("authz", () => {
	it("refuses a non-admin member on every endpoint", async () => {
		const p = await createOai();
		const call = as(MEMBER, h.env);
		for (const e of ENDPOINTS) {
			const res = await call(e.path(p.id), { method: e.method, body: e.body });
			expect(res.status, `${e.method} ${e.path(p.id)}`).toBe(403);
		}
		expect(stored().providers).toHaveLength(1);
	});

	it("refuses an admin token scoped mail:read on every endpoint", async () => {
		const p = await createOai();
		const call = admin({ kind: "token", scopes: ["mail:read"] });
		for (const e of ENDPOINTS) {
			const res = await call(e.path(p.id), { method: e.method, body: e.body });
			expect(res.status, `${e.method} ${e.path(p.id)}`).toBe(403);
			expect(await json(res)).toMatchObject({ scope: "admin" });
		}
	});

	it("lets an admin-scoped token read, discover and test, but not change the config", async () => {
		const p = await createOai();
		await discover(p.id);
		const call = admin({ kind: "token", scopes: ["admin"] });
		for (const e of ENDPOINTS) {
			const res = await call(e.path(p.id), { method: e.method, body: e.body });
			if (e.personOnly) {
				expect(res.status, `${e.method} ${e.path(p.id)}`).toBe(403);
				expect(await json(res), `${e.method} ${e.path(p.id)}`).toMatchObject({ code: "person_required" });
			} else {
				expect(res.status, `${e.method} ${e.path(p.id)}`).toBe(200);
			}
		}
		// Nothing changed: still one provider, its old label, no custom models.
		const file = stored();
		expect(file.providers).toHaveLength(1);
		expect(file.providers[0].label).toBe("OAI gateway");
		expect(file.providers[0].customModels).toEqual([]);
	});

	// BUG (workers/routes/ai-providers.ts:95-98): isPersonOnly exempts any path
	// ending in /discover or /test, so a provider whose id is "test" or
	// "discover" (the slug of a label "Test") can be repointed or deleted with
	// an admin-scoped API token.
	it("requires a person to change a provider whose id is 'test' or 'discover'", async () => {
		for (const id of ["test", "discover"]) {
			await createOai({ id, label: id });
			const call = admin({ kind: "token", scopes: ["admin"] });
			const patched = await call(`/api/v1/ai/providers/${id}`, { method: "PATCH", body: { baseUrl: "https://attacker.example/v1" } });
			expect(patched.status, `PATCH ${id}`).toBe(403);
			const deleted = await call(`/api/v1/ai/providers/${id}`, { method: "DELETE" });
			expect(deleted.status, `DELETE ${id}`).toBe(403);
		}
	});

	it("refuses an OAuth caller config changes with person_required", async () => {
		const p = await createOai();
		const call = admin({ kind: "oauth" });
		for (const e of ENDPOINTS.filter((x) => x.personOnly)) {
			const res = await call(e.path(p.id), { method: e.method, body: e.body });
			expect(res.status, `${e.method} ${e.path(p.id)}`).toBe(403);
			expect(await json(res)).toMatchObject({ code: "person_required" });
		}
	});

	it("lets a session or Access admin do everything", async () => {
		for (const caller of [{ kind: "session" }, { kind: "access" }] as Caller[]) {
			resetAiProvidersCache();
			h = makeHarness();
			const call = admin(caller);
			const created = await call("/api/v1/ai/providers", { method: "POST", body: createBody() });
			expect(created.status).toBe(201);
			const id = (await json(created)).provider.id;
			for (const e of ENDPOINTS.filter((x) => x.method !== "DELETE")) {
				const res = await call(e.path(id), { method: e.method, body: e.body });
				expect(res.status, `${caller.kind} ${e.method} ${e.path(id)}`).toBeLessThan(300);
			}
			expect((await call(`/api/v1/ai/providers/${id}`, { method: "DELETE" })).status).toBe(204);
		}
	});
});

// ── Create ─────────────────────────────────────────────────────────

describe("create", () => {
	it("stores the token encrypted and never returns it", async () => {
		const res = await admin()("/api/v1/ai/providers", { method: "POST", body: createBody() });
		expect(res.status).toBe(201);
		const text = await res.text();
		expect(text).not.toContain(OAI_TOKEN);
		const { provider } = JSON.parse(text);
		expect(provider).toMatchObject({ tokenSet: true, tokenHint: `…${OAI_TOKEN.slice(-4)}`, wire: "openai", baseUrl: OAI_BASE });
		expect(provider).not.toHaveProperty("tokenEnc");

		const raw = h.bucket.store.get(AI_PROVIDERS_KEY)!.body;
		expect(raw).not.toContain(OAI_TOKEN);
		const p = JSON.parse(raw).providers[0];
		expect(p.tokenEnc).toMatch(/^v1\./);
		expect(await openProviderToken(p.tokenEnc, AUTH_SECRET, p.id)).toBe(OAI_TOKEN);

		const list = await (await admin()("/api/v1/ai/providers")).text();
		expect(list).not.toContain(OAI_TOKEN);
		expect(list).not.toContain("tokenEnc");
		expect(list).not.toContain(p.tokenEnc);
		expect(JSON.parse(list)).toMatchObject({ authSecretSet: true, providers: [{ id: p.id, tokenSet: true }] });
	});

	it("never returns a secret header value, and seals it at rest", async () => {
		const res = await admin()("/api/v1/ai/providers", {
			method: "POST",
			body: createBody({
				headers: [
					{ name: "cf-aig-authorization", value: HEADER_SECRET, secret: true },
					{ name: "x-team", value: "mail" },
				],
			}),
		});
		expect(res.status).toBe(201);
		const text = await res.text();
		expect(text).not.toContain(HEADER_SECRET);
		expect(JSON.parse(text).provider.headers).toEqual([
			{ name: "cf-aig-authorization", secret: true, set: true },
			{ name: "x-team", secret: false, value: "mail", set: true },
		]);
		const raw = h.bucket.store.get(AI_PROVIDERS_KEY)!.body;
		expect(raw).not.toContain(HEADER_SECRET);
		const p = JSON.parse(raw).providers[0];
		const sealed = p.headers.find((x: any) => x.name === "cf-aig-authorization");
		expect(sealed.value).toBeUndefined();
		expect(await openProviderHeader(sealed.valueEnc, AUTH_SECRET, p.id, "cf-aig-authorization")).toBe(HEADER_SECRET);
		expect(await (await admin()("/api/v1/ai/providers")).text()).not.toContain(HEADER_SECRET);
	});

	it("retries a lost R2 race on fresh data", async () => {
		h.bucket.state.loseRaces = 1;
		await createOai();
		expect(stored().providers).toHaveLength(1);
	});
});

// ── Validation ─────────────────────────────────────────────────────

describe("validation", () => {
	const bad = async (body: Record<string, unknown>, field: string) => {
		const res = await admin()("/api/v1/ai/providers", { method: "POST", body: createBody(body) });
		expect(res.status, JSON.stringify(body)).toBe(400);
		expect((await json(res)).field, JSON.stringify(body)).toBe(field);
	};

	it("refuses unsafe base URLs", async () => {
		await bad({ baseUrl: "http://oai.gw.example/v1" }, "baseUrl");
		await bad({ baseUrl: "https://10.0.0.7/v1" }, "baseUrl");
		await bad({ baseUrl: "https://169.254.169.254/v1" }, "baseUrl");
		await bad({ baseUrl: "https://my-gw.someone.workers.dev/v1" }, "baseUrl");
		await bad({ baseUrl: "https://mailer.example.com/v1" }, "baseUrl");
		await bad({ baseUrl: "https://oai.gw.example:8443/v1" }, "baseUrl");
		expect(h.bucket.store.has(AI_PROVIDERS_KEY)).toBe(false);
		// The custom port is fine once allowed.
		const ok = await admin()("/api/v1/ai/providers", {
			method: "POST",
			body: createBody({ baseUrl: "https://oai.gw.example:8443/v1", options: { allowCustomPorts: true } }),
		});
		expect(ok.status).toBe(201);
	});

	it("refuses denylisted and clashing headers, and line breaks in values", async () => {
		await bad({ headers: [{ name: "cookie", value: "a=b" }] }, "headers");
		await bad({ headers: [{ name: "x-forwarded-for", value: "1.2.3.4" }] }, "headers");
		await bad({ headers: [{ name: "cf-ray", value: "x" }] }, "headers");
		await bad({ headers: [{ name: "Authorization", value: "Bearer other" }] }, "headers");
		await bad({ auth: { scheme: "x-api-key" }, headers: [{ name: "X-Api-Key", value: "dup" }] }, "headers");
		await bad({ headers: [{ name: "x-team", value: "a\r\nInjected: yes" }] }, "headers");
		expect(h.bucket.store.has(AI_PROVIDERS_KEY)).toBe(false);
	});
});

// ── Idempotency ────────────────────────────────────────────────────

describe("idempotent create", () => {
	it("creates one provider for a repeated Idempotency-Key and replays the response", async () => {
		const send = () =>
			admin()("/api/v1/ai/providers", { method: "POST", body: createBody(), headers: { "Idempotency-Key": "create-oai-1" } });
		const first = await send();
		const second = await send();
		expect(first.status).toBe(201);
		expect(second.status).toBe(201);
		expect(first.headers.get("Idempotent-Replayed")).toBeNull();
		expect(second.headers.get("Idempotent-Replayed")).toBe("true");
		const a = await json(first);
		const b = await json(second);
		expect(b.provider.id).toBe(a.provider.id);
		expect(stored().providers).toHaveLength(1);
		expect(JSON.stringify(b)).not.toContain(OAI_TOKEN);
	});
});

// ── Patch ──────────────────────────────────────────────────────────

describe("patch", () => {
	const patch = (id: string, body: unknown) => admin()(`/api/v1/ai/providers/${id}`, { method: "PATCH", body });

	it("clears the token with null and replaces it with a string", async () => {
		const p = await createOai();
		const cleared = await json(await patch(p.id, { token: null }));
		expect(cleared.provider).toMatchObject({ tokenSet: false, tokenHint: null });
		expect(stored().providers[0].tokenEnc).toBeNull();

		const next = "sk-replacement-token-b7d1";
		const res = await patch(p.id, { token: next });
		const text = await res.text();
		expect(text).not.toContain(next);
		expect(JSON.parse(text).provider).toMatchObject({ tokenSet: true, tokenHint: "…b7d1" });
		const s = stored().providers[0];
		expect(await openProviderToken(s.tokenEnc, AUTH_SECRET, p.id)).toBe(next);
	});

	it("keeps a secret header's ciphertext when sent without a value", async () => {
		const p = await createOai({ headers: [{ name: "cf-aig-authorization", value: HEADER_SECRET, secret: true }] });
		const before = stored().providers[0].headers[0].valueEnc;
		const res = await patch(p.id, { headers: [{ name: "cf-aig-authorization", secret: true }, { name: "x-team", value: "ops" }] });
		expect(res.status).toBe(200);
		const after = stored().providers[0].headers;
		expect(after[0]).toEqual({ name: "cf-aig-authorization", valueEnc: before, secret: true });
		expect(after[1]).toMatchObject({ name: "x-team", value: "ops", secret: false });
		// A new secret header with no value has nothing to keep.
		const missing = await patch(p.id, { headers: [{ name: "cf-aig-other", secret: true }] });
		expect(missing.status).toBe(400);
		expect((await json(missing)).field).toBe("headers");
	});

	it("resets the catalogue when the base URL changes", async () => {
		const p = await createOai();
		expect((await discover(p.id)).catalogue).toMatchObject({ status: "ok", count: 2 });
		const res = await json(await patch(p.id, { baseUrl: "https://oai2.gw.example/v1" }));
		expect(res.provider.catalogue).toMatchObject({ status: "never", count: 0, fetchedAt: null });
		expect(res.provider.baseUrl).toBe("https://oai2.gw.example/v1");
		// Re-validated on change.
		expect((await patch(p.id, { baseUrl: "https://192.168.1.1/v1" })).status).toBe(400);
	});

	it("refuses to disable or delete the active provider", async () => {
		const p = await activeOai();
		const off = await patch(p.id, { enabled: false });
		expect(off.status).toBe(409);
		expect(await json(off)).toMatchObject({ code: "provider_active" });
		const del = await admin()(`/api/v1/ai/providers/${p.id}`, { method: "DELETE" });
		expect(del.status).toBe(409);
		expect(await json(del)).toMatchObject({ code: "provider_active" });

		const deactivate = await admin()("/api/v1/ai/routing", { method: "PATCH", body: { gatewayProviderId: null } });
		expect(deactivate.status).toBe(200);
		expect((await patch(p.id, { enabled: false })).status).toBe(200);
		const gone = await admin()(`/api/v1/ai/providers/${p.id}`, { method: "DELETE" });
		expect(gone.status).toBe(204);
		expect(stored().providers).toEqual([]);
		// Picks naming it explicitly would be dropped; the default stays (it names no provider).
		expect((await admin()(`/api/v1/ai/providers/${p.id}`, { method: "DELETE" })).status).toBe(404);
	});
});

// ── Discover ───────────────────────────────────────────────────────

describe("discover", () => {
	it("stores the catalogue, sending the bearer token", async () => {
		const p = await createOai();
		const view = await discover(p.id);
		expect(view.catalogue).toMatchObject({ status: "ok", count: 2 });
		expect(view.models.map((m: any) => m.id).sort()).toEqual([OAI_CHAT, OAI_EMBED]);
		expect(view.models.find((m: any) => m.id === OAI_EMBED).kind).toBe("embedding");
		expect(net.calls).toHaveLength(1);
		expect(net.calls[0]!.url).toBe(`${OAI_BASE}/models`);
		expect(net.calls[0]!.headers.authorization).toBe(`Bearer ${OAI_TOKEN}`);
		expect(stored().providers[0].catalogue.models).toHaveLength(2);
	});

	it("reports a 401 as auth-failed without echoing the body", async () => {
		const p = await createOai();
		net.setOverride(() => Response.json({ error: { message: `invalid key ${OAI_TOKEN}` } }, { status: 401 }));
		const res = await admin()(`/api/v1/ai/providers/${p.id}/discover`, { method: "POST" });
		const text = await res.text();
		expect(res.status).toBe(200);
		expect(text).not.toContain(OAI_TOKEN);
		expect(JSON.parse(text).provider.catalogue).toMatchObject({ status: "auth-failed", count: 0, detail: "HTTP 401" });
		expect(h.bucket.store.get(AI_PROVIDERS_KEY)!.body).not.toContain(OAI_TOKEN);
	});

	it("keeps probe and admin capabilities across a rediscovery", async () => {
		const p = await createOai();
		await discover(p.id);
		await probe(p.id, OAI_CHAT);
		await admin()(`/api/v1/ai/providers/${p.id}/models`, { method: "PATCH", body: { caps: [{ id: OAI_CHAT, vision: false }] } });
		const view = await discover(p.id);
		const m = view.models.find((x: any) => x.id === OAI_CHAT);
		expect(m.caps.tools).toEqual({ value: true, source: "probe" });
		expect(m.caps.json).toEqual({ value: true, source: "probe" });
		expect(m.caps.vision).toEqual({ value: false, source: "admin" });
		expect(m.testedAt).toEqual(expect.any(String));
	});
});

// ── Models ─────────────────────────────────────────────────────────

describe("models patch", () => {
	const models = (id: string, body: unknown) => admin()(`/api/v1/ai/providers/${id}/models`, { method: "PATCH", body });

	it("adds a custom id from hints, sets and clears overrides, refuses unknown ids", async () => {
		const p = await createOai();
		const added = await json(await models(p.id, { add: [{ id: "gpt-4o-mini-2026-deploy", label: "Deployment" }] }));
		const m = added.provider.models.find((x: any) => x.id === "gpt-4o-mini-2026-deploy");
		expect(m).toMatchObject({ custom: true, kind: "chat", label: "Deployment" });
		expect(m.caps.tools).toEqual({ value: true, source: "hint" });
		expect(m.caps.json).toEqual({ value: true, source: "hint" });

		const set = await json(await models(p.id, { caps: [{ id: "gpt-4o-mini-2026-deploy", tools: false }] }));
		expect(set.provider.models.find((x: any) => x.id === "gpt-4o-mini-2026-deploy").caps.tools).toEqual({ value: false, source: "admin" });

		const cleared = await json(await models(p.id, { caps: [{ id: "gpt-4o-mini-2026-deploy", tools: null }] }));
		expect(cleared.provider.models.find((x: any) => x.id === "gpt-4o-mini-2026-deploy").caps.tools).toEqual({ value: null, source: "hint" });

		const unknown = await models(p.id, { caps: [{ id: "nope", tools: true }] });
		expect(unknown.status).toBe(400);
		expect((await json(unknown)).field).toBe("caps");

		const removed = await json(await models(p.id, { remove: ["gpt-4o-mini-2026-deploy"] }));
		expect(removed.provider.models).toEqual([]);
	});
});

// ── Test ───────────────────────────────────────────────────────────

describe("test", () => {
	it("verifies text, JSON and tools against the gateway and stores them as probe results", async () => {
		const p = await createOai();
		await discover(p.id);
		const out = await probe(p.id, OAI_CHAT);
		expect(out.results.map((r: any) => [r.check, r.ok])).toEqual([
			["text", true],
			["json", true],
			["tools", true],
		]);
		const m = out.provider.models.find((x: any) => x.id === OAI_CHAT);
		expect(m.caps.json).toEqual({ value: true, source: "probe" });
		expect(m.caps.tools).toEqual({ value: true, source: "probe" });
		const chat = net.calls.filter((c) => c.url.endsWith("/chat/completions"));
		expect(chat).toHaveLength(3);
		expect(chat.every((c) => c.headers.authorization === `Bearer ${OAI_TOKEN}`)).toBe(true);
		expect(chat[1]!.body.response_format).toMatchObject({ type: "json_schema" });
		expect(chat[2]!.body.tool_choice).toBe("required");
	});

	it("stores false when the tools check fails", async () => {
		const p = await createOai();
		await discover(p.id);
		net.setOverride((r) =>
			r.body?.tools
				? Response.json({
						id: "x",
						object: "chat.completion",
						created: 1,
						model: OAI_CHAT,
						choices: [{ index: 0, message: { role: "assistant", content: "I'd rather not" }, finish_reason: "stop" }],
					})
				: null,
		);
		const out = await probe(p.id, OAI_CHAT, ["tools"]);
		expect(out.results).toEqual([expect.objectContaining({ check: "tools", ok: false, error: expect.any(String) })]);
		expect(out.provider.models.find((x: any) => x.id === OAI_CHAT).caps.tools).toEqual({ value: false, source: "probe" });
	});

	it("records an embedding model's vector size", async () => {
		const p = await createOai();
		await discover(p.id);
		const out = await probe(p.id, OAI_EMBED);
		expect(out.results).toEqual([expect.objectContaining({ check: "embed", ok: true, dims: 1024 })]);
		const m = out.provider.models.find((x: any) => x.id === OAI_EMBED);
		expect(m.embeddingDims).toBe(1024);
		expect(m.caps.embed).toEqual({ value: true, source: "probe" });
	});

	it("never echoes the token in a failed check", async () => {
		const p = await createOai();
		await discover(p.id);
		net.setOverride(() => Response.json({ error: { message: `bad key ${OAI_TOKEN}` } }, { status: 400 }));
		const res = await admin()(`/api/v1/ai/providers/${p.id}/test`, { method: "POST", body: { modelId: OAI_CHAT, checks: ["text"] } });
		const text = await res.text();
		expect(text).not.toContain(OAI_TOKEN);
		expect(JSON.parse(text).results[0]).toMatchObject({ check: "text", ok: false });
	});
});

// ── Routing ────────────────────────────────────────────────────────

/** A discovered, probed and activated OpenAI provider. */
async function activeOai(): Promise<any> {
	const p = await createOai();
	await discover(p.id);
	await probe(p.id, OAI_CHAT);
	const res = await admin()("/api/v1/ai/routing", {
		method: "PATCH",
		body: { default: OAI_CHAT, embeddings: "workers-ai", gatewayProviderId: p.id },
	});
	expect(res.status).toBe(200);
	return p;
}

describe("routing", () => {
	const routing = (body: unknown) => admin()("/api/v1/ai/routing", { method: "PATCH", body });

	it("refuses a hint-only tool model for agent chat and accepts it once probed", async () => {
		const p = await createOai();
		await discover(p.id);
		const refused = await routing({ models: { agent_chat: OAI_CHAT } });
		expect(refused.status).toBe(422);
		const body = await json(refused);
		expect(body.code).toBe("capability_check_failed");
		expect(body.problems.map((x: any) => x.role)).toEqual(["agent_chat"]);
		expect(stored().routing.models).toEqual({});

		await probe(p.id, OAI_CHAT);
		const ok = await routing({ models: { agent_chat: OAI_CHAT } });
		expect(ok.status).toBe(200);
		expect((await json(ok)).routing.models.agent_chat).toEqual({ modelId: OAI_CHAT });
	});

	it("requires verified JSON for triage", async () => {
		const p = await createOai();
		await admin()(`/api/v1/ai/providers/${p.id}/models`, {
			method: "PATCH",
			body: { add: [{ id: "house-model" }], caps: [{ id: "house-model", tools: true }] },
		});
		expect((await routing({ models: { agent_chat: "house-model" } })).status).toBe(200);
		const triage = await routing({ models: { triage: "house-model" } });
		expect(triage.status).toBe(422);
		expect((await json(triage)).problems).toEqual([{ role: "triage", reason: expect.stringContaining("JSON") }]);
	});

	it("never routes the injection scanner", async () => {
		const p = await createOai();
		await discover(p.id);
		await probe(p.id, OAI_CHAT);
		const res = await routing({ models: { injection_scanner: OAI_CHAT } });
		expect(res.status).toBe(422);
		expect(await json(res)).toMatchObject({ code: "capability_check_failed", problems: [{ role: "injection_scanner" }] });
	});

	it("refuses activation with gaps, listing them", async () => {
		const p = await createOai();
		await discover(p.id);
		const res = await routing({ gatewayProviderId: p.id, default: OAI_CHAT });
		expect(res.status).toBe(422);
		const body = await json(res);
		expect(body.code).toBe("capability_check_failed");
		const roles = body.problems.map((x: any) => x.role);
		expect(roles).toEqual(expect.arrayContaining(["agent_chat", "auto_draft", "triage", "embeddings"]));
		expect(roles).not.toContain("injection_scanner");
		expect(stored().routing.gatewayProviderId).toBeNull();
	});

	it("activates when every role is covered", async () => {
		const p = await activeOai();
		const res = await json(await admin()("/api/v1/ai/routing"));
		expect(res.problems).toEqual([]);
		expect(res.routing).toMatchObject({ gatewayProviderId: p.id, embeddingsMode: "workers-ai", fallbackToWorkersAi: false, workersAiExceptions: ["embeddings"] });
		const list = await json(await admin()("/api/v1/ai/providers"));
		expect(list.routing.gatewayProviderId).toBe(p.id);
		expect(list.roles.find((r: any) => r.role === "injection_scanner")).toMatchObject({ pinned: true });
	});

	it("turns embeddings off: disabled role, no embeddings pick", async () => {
		const p = await createOai();
		await discover(p.id);
		await probe(p.id, OAI_EMBED);
		expect((await routing({ models: { embeddings: OAI_EMBED } })).status).toBe(200);
		expect(stored().routing.models.embeddings).toEqual({ modelId: OAI_EMBED });
		const res = await json(await routing({ embeddings: "off" }));
		expect(res.routing.disabledRoles).toContain("embeddings");
		expect(res.routing.models.embeddings).toBeUndefined();
		expect(res.routing.embeddingsMode).toBe("off");
		expect(stored().routing.models.embeddings).toBeUndefined();
	});

	it("defaults fallback to off", async () => {
		const empty = await json(await admin()("/api/v1/ai/routing"));
		expect(empty.routing.fallbackToWorkersAi).toBe(false);
		await createOai();
		const res = await json(await admin()("/api/v1/ai/routing"));
		expect(res.routing.fallbackToWorkersAi).toBe(false);
	});
});

// ── Audit ──────────────────────────────────────────────────────────

describe("audit", () => {
	it("records create, update, delete and routing without secrets", async () => {
		const p = await createOai({ headers: [{ name: "cf-aig-authorization", value: HEADER_SECRET, secret: true }] });
		await admin()(`/api/v1/ai/providers/${p.id}`, { method: "PATCH", body: { token: "sk-second-token-4242" } });
		await admin()("/api/v1/ai/routing", { method: "PATCH", body: { fallbackToWorkersAi: true } });
		await admin()(`/api/v1/ai/providers/${p.id}`, { method: "DELETE" });
		const entries = auditEntries();
		const actions = entries.map((e) => e.action);
		expect(actions).toEqual(expect.arrayContaining(["ai.provider_create", "ai.provider_update", "ai.routing", "ai.provider_delete"]));
		const created = entries.find((e) => e.action === "ai.provider_create");
		expect(created).toMatchObject({ actor: ADMIN, detail: { provider: p.id, host: "oai.gw.example", wire: "openai", headers: "cf-aig-authorization" } });
		const all = JSON.stringify(entries);
		for (const secret of [OAI_TOKEN, "sk-second-token-4242", HEADER_SECRET]) expect(all).not.toContain(secret);
	});
});
