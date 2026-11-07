// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The built-in provider, Cloudflare Workers AI, as a first-class provider:
 * the catalogue (normalisation, task filter, Cache API, fallback list), the
 * per-role model picks and their gate (tools, JSON, the scanner lock,
 * embeddings dimensions and re-index confirmation), router precedence with
 * `SUMMARY_MODEL`, the unlisted-model warning and successor, the settings
 * routes (built-in card active with no config, authz, session-only changes,
 * audit), one-active-provider switching, and the per-mailbox re-index when
 * the embeddings model changes. Synthetic fixtures only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	FALLBACK_CATALOGUE,
	WORKERS_AI_DEFAULTS,
	checkWorkersAiPick,
	contextLabel,
	filterByTask,
	modelsForRole,
	normaliseCatalogue,
	priceLabel,
	suggestSuccessor,
	unlistedModel,
	unlistedWarning,
	withTested,
	type WorkersAiCatalogue,
} from "../shared/workers-ai";
import { parseAiProvidersFile, type AiProvidersFile } from "../shared/ai-providers";
import { EMBEDDING_MODEL } from "../shared/semantic";
import { CfAnalyticsClient } from "../workers/lib/cf-analytics";
import { CATALOGUE_FAILURE_TTL_SECONDS, workersAiCatalogue } from "../workers/lib/workers-ai-catalogue";
import { resolveModel, SUMMARY_MODEL, workersAiModelFor } from "../workers/lib/ai-router";
import { AI_PROVIDERS_KEY, resetAiProvidersCache } from "../workers/lib/ai-providers-store";
import { setAiProviderRouteNetworkForTests, setWorkersAiCatalogueForTests } from "../workers/routes/ai-providers";
import { aiBreaker } from "../workers/lib/ai-breaker";
import { generateSummary } from "../workers/lib/summarize";
import { aiFor } from "../workers/lib/ai-router";
import {
	LEGACY_EMBEDDING_KEY,
	enqueueSemantic,
	indexedEmbeddingModel,
	searchableEmbeddingModel,
	processSemanticQueue,
	reconcileEmbeddingModel,
	type VectorizeIndexLike,
} from "../workers/durableObject/semantic";
import { DEFAULT_AI_CONFIG } from "../shared/ai-settings";
import { hybridSearch } from "../workers/lib/semantic";
import { CATALOGUE_ROWS, catalogueNetwork, memoryCache, row } from "./fixtures/workers-ai-catalogue";
import { ADMIN, MEMBER, as, json, makeHarness, mutateJson, type Caller } from "./fixtures/ai-gateway/harness";
import { OAI_BASE, OAI_CHAT, OAI_TOKEN, fakeNetwork } from "./fixtures/ai-gateway/fake-gateways";
import { mailboxSqlite } from "./helpers/mailbox-sqlite";

const LIVE: WorkersAiCatalogue = { source: "live", fetchedAt: "2026-10-29T00:00:00.000Z", models: normaliseCatalogue(CATALOGUE_ROWS) };
const model = (id: string) => LIVE.models.find((m) => m.id === id)!;

// ── Catalogue normalisation ────────────────────────────────────────

describe("catalogue", () => {
	it("keeps text generation and embeddings only, sorted, with capabilities from properties", () => {
		const ids = LIVE.models.map((m) => m.id);
		expect(ids).not.toContain("@cf/acme/painter");
		expect(ids).not.toContain("@cf/acme/whisper");
		expect(ids).toEqual([...ids].sort());
		const agent = model("@cf/acme/agent-2.1");
		expect(agent).toMatchObject({
			task: "Text Generation",
			contextTokens: 262_144,
			tools: { value: true, source: "provider" },
			reasoning: true,
			vision: true,
			// Cached input is not the input price.
			price: { input: 0.95, output: 4 },
		});
		// Function calling suggests JSON mode, but only as a hint.
		expect(agent.json).toEqual({ value: true, source: "hint" });
		expect(model("@cf/acme/chat-1.0").tools).toEqual({ value: false, source: "provider" });
		expect(model("@cf/acme/beta-lora")).toMatchObject({ beta: true, lora: true });
	});

	it("reads embedding sizes from output_dimensions, else the model card table, else unknown", () => {
		expect(model("@cf/acme/embed-1024").dims).toBe(1024);
		expect(model("@cf/acme/embed-768").dims).toBe(768);
		expect(model("@cf/baai/bge-m3").dims).toBe(1024);
		expect(model("@cf/acme/embed-unknown").dims).toBeNull();
	});

	it("documents JSON mode for the triage model", () => {
		expect(model("@cf/meta/llama-4-scout-17b-16e-instruct").json).toEqual({ value: true, source: "provider" });
	});

	it("filters by task, and each role sees only its task", () => {
		expect(filterByTask(LIVE.models, "Text Embeddings").every((m) => m.task === "Text Embeddings")).toBe(true);
		expect(filterByTask(LIVE.models, null)).toHaveLength(LIVE.models.length);
		expect(modelsForRole(LIVE.models, "embeddings").map((m) => m.task)).toEqual(expect.arrayContaining(["Text Embeddings"]));
		expect(modelsForRole(LIVE.models, "embeddings").some((m) => m.task !== "Text Embeddings")).toBe(false);
		expect(modelsForRole(LIVE.models, "summary").some((m) => m.task !== "Text Generation")).toBe(false);
	});

	it("labels context and price", () => {
		expect(contextLabel(262_144)).toBe("262K");
		expect(contextLabel(1_048_576)).toBe("1M");
		expect(contextLabel(null)).toBeNull();
		expect(priceLabel({ input: 0.95, output: 4 })).toBe("$0.95 / $4 per M");
		expect(priceLabel({ input: 0.012, output: null })).toBe("$0.012 per M in");
		expect(priceLabel(null)).toBeNull();
	});

	it("the fallback list carries every default model", () => {
		for (const id of new Set(Object.values(WORKERS_AI_DEFAULTS))) {
			expect(FALLBACK_CATALOGUE.some((m) => m.id === id), id).toBe(true);
		}
	});
});

describe("catalogue fetch, cache and fallback", () => {
	const env = {} as never;
	const client = (fetch: typeof globalThis.fetch) => new CfAnalyticsClient({ graphqlToken: null, restToken: "synthetic-token", fetchImpl: fetch });

	it("reads every page once, then serves the cache", async () => {
		const net = catalogueNetwork({ rows: Array.from({ length: 230 }, (_, i) => row(`@cf/acme/m-${i}`, "Text Generation")) });
		const cache = memoryCache();
		const first = await workersAiCatalogue(env, { client: client(net.fetch), cache, accountId: "acct" });
		expect(first.source).toBe("live");
		expect(first.models).toHaveLength(230);
		expect(net.calls.filter((c) => c.includes("/ai/models/search"))).toHaveLength(3);
		const again = await workersAiCatalogue(env, { client: client(net.fetch), cache, accountId: "acct" });
		expect(again.models).toHaveLength(230);
		expect(net.calls).toHaveLength(3);
		// The token is never part of a cache key.
		expect([...cache.store.keys()].some((k) => k.includes("synthetic-token"))).toBe(false);
	});

	it("falls back to the built-in list when the token lacks permission, and says why", async () => {
		const net = catalogueNetwork({ status: 403 });
		const got = await workersAiCatalogue(env, { client: client(net.fetch), cache: memoryCache(), accountId: "acct" });
		expect(got.source).toBe("fallback");
		expect(got.models).toEqual([...FALLBACK_CATALOGUE]);
		expect(got.detail).toMatch(/Workers AI Read/);
		expect(got.detail).not.toContain("synthetic-token");
	});

	it("falls back without a token or an account, without calling anything", async () => {
		const noToken = await workersAiCatalogue(env, { client: null });
		expect(noToken.source).toBe("fallback");
		expect(noToken.detail).toMatch(/CF_ANALYTICS_TOKEN/);
		const net = catalogueNetwork();
		const noAccount = await workersAiCatalogue({ DOMAINS: "" } as never, { client: client(net.fetch), cache: null });
		expect(noAccount.source).toBe("fallback");
		expect(net.calls.filter((c) => c.includes("/ai/"))).toHaveLength(0);
	});

	it("retries a cached failure after the failure TTL", async () => {
		const cache = memoryCache();
		let now = Date.parse("2026-10-29T00:00:00Z");
		const failing = catalogueNetwork({ status: 500 });
		const a = await workersAiCatalogue(env, { client: client(failing.fetch), cache, accountId: "acct", now: () => now });
		expect(a.source).toBe("fallback");
		const healthy = catalogueNetwork();
		// Within the failure TTL: still the cached fallback.
		now += 60_000;
		expect((await workersAiCatalogue(env, { client: client(healthy.fetch), cache, accountId: "acct", now: () => now })).source).toBe("fallback");
		now += CATALOGUE_FAILURE_TTL_SECONDS * 1000;
		expect((await workersAiCatalogue(env, { client: client(healthy.fetch), cache, accountId: "acct", now: () => now })).source).toBe("live");
	});
});

// ── The gate ───────────────────────────────────────────────────────

describe("picking a Workers AI model for a role", () => {
	const pick = (role: Parameters<typeof checkWorkersAiPick>[0], id: string, extra: { confirmReindex?: boolean; current?: string } = {}) =>
		checkWorkersAiPick(role, {
			model: LIVE.models.find((m) => m.id === id) ?? unlistedModel(id, role),
			current: extra.current ?? WORKERS_AI_DEFAULTS[role],
			confirmReindex: extra.confirmReindex,
		});

	it("tool roles need listed function calling", () => {
		expect(pick("agent_chat", "@cf/acme/agent-2.2")).toEqual({ ok: true });
		expect(pick("auto_draft", "@cf/acme/chat-1.0")).toMatchObject({ ok: false, reason: expect.stringMatching(/can't call tools/) });
		// An unlisted custom id is unknown until Test.
		expect(pick("agent_chat", "@cf/acme/brand-new")).toMatchObject({ ok: false, reason: expect.stringMatching(/Run Test/) });
	});

	it("triage needs verified JSON: a hint is refused until Test passes", () => {
		expect(pick("triage", "@cf/meta/llama-4-scout-17b-16e-instruct")).toEqual({ ok: true });
		expect(pick("triage", "@cf/acme/agent-2.2")).toMatchObject({ ok: false, reason: expect.stringMatching(/isn't verified/) });
		const tested = withTested(model("@cf/acme/agent-2.2"), { testedAt: "t", json: true });
		expect(checkWorkersAiPick("triage", { model: tested, current: WORKERS_AI_DEFAULTS.triage })).toEqual({ ok: true });
		const failed = withTested(model("@cf/acme/agent-2.2"), { testedAt: "t", json: false });
		expect(checkWorkersAiPick("triage", { model: failed, current: WORKERS_AI_DEFAULTS.triage })).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/doesn't support JSON/),
		});
	});

	it("text roles take any text generation model, never an embedding model", () => {
		expect(pick("summary", "@cf/acme/chat-1.0")).toEqual({ ok: true });
		expect(pick("summary", "@cf/baai/bge-m3")).toMatchObject({ ok: false, reason: "Not a text generation model." });
		expect(pick("summary", "gpt-4o")).toMatchObject({ ok: false, reason: expect.stringMatching(/@cf\//) });
	});

	it("locks the injection scanner", () => {
		expect(pick("injection_scanner", "@cf/acme/agent-2.2")).toMatchObject({ ok: false, reason: expect.stringMatching(/fixed/) });
	});

	it("embeddings: only the index's size, and a change needs the re-index confirmation", () => {
		expect(pick("embeddings", "@cf/acme/embed-768", { confirmReindex: true })).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/768-dimension.*needs 1024/),
		});
		expect(pick("embeddings", "@cf/acme/embed-unknown", { confirmReindex: true })).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/Run Test/),
		});
		expect(pick("embeddings", "@cf/acme/chat-1.0", { confirmReindex: true })).toMatchObject({ ok: false, reason: "Not an embedding model." });
		expect(pick("embeddings", "@cf/acme/embed-1024")).toMatchObject({ ok: false, reason: expect.stringMatching(/re-indexes/) });
		expect(pick("embeddings", "@cf/acme/embed-1024", { confirmReindex: true })).toEqual({ ok: true });
		// The current model needs no confirmation.
		expect(pick("embeddings", EMBEDDING_MODEL)).toEqual({ ok: true });
		// A Test that measured 1024 dimensions unlocks an unknown model.
		const measured = withTested(model("@cf/acme/embed-unknown"), { testedAt: "t", embed: true, dims: 1024 });
		expect(checkWorkersAiPick("embeddings", { model: measured, current: EMBEDDING_MODEL, confirmReindex: true })).toEqual({ ok: true });
	});
});

// ── Unlisted models ────────────────────────────────────────────────

describe("unlisted model warning", () => {
	const catalogue = {
		source: "live" as const,
		models: normaliseCatalogue([
			row("@cf/moonshotai/kimi-k2.6", "Text Generation", { function_calling: "true" }),
			row("@cf/moonshotai/kimi-k2.7-code", "Text Generation", { function_calling: "true" }),
			row("@cf/meta/llama-3.1-8b-instruct-fp8", "Text Generation"),
		]),
	};

	it("flags a model that is no longer listed and suggests the nearest newer sibling", () => {
		expect(unlistedWarning("@cf/moonshotai/kimi-k2.5", catalogue, "Text Generation")).toEqual({ successor: "@cf/moonshotai/kimi-k2.6" });
		expect(suggestSuccessor("@cf/moonshotai/kimi-k2.5", catalogue.models)?.id).toBe("@cf/moonshotai/kimi-k2.6");
	});

	it("says nothing for a listed model, or when the catalogue is only the fallback list", () => {
		expect(unlistedWarning("@cf/meta/llama-3.1-8b-instruct-fp8", catalogue)).toBeNull();
		expect(unlistedWarning("@cf/moonshotai/kimi-k2.5", { source: "fallback", models: [] })).toBeNull();
	});

	it("ranks Llama successors by release, not parameter count", () => {
		const llama = normaliseCatalogue([
			row("@cf/meta/llama-3.2-11b-vision-instruct", "Text Generation"),
			row("@cf/meta/llama-3.3-70b-instruct-fp8-fast", "Text Generation"),
			row("@cf/meta/llama-4-scout-17b-16e-instruct", "Text Generation"),
		]);
		expect(suggestSuccessor("@cf/meta/llama-3.1-8b-instruct-fp8", llama)?.id).toBe("@cf/meta/llama-3.2-11b-vision-instruct");
		expect(suggestSuccessor("@cf/meta/llama-3.3-70b-instruct-fp8-fast", llama)?.id).toBe("@cf/meta/llama-4-scout-17b-16e-instruct");
	});

	it("has no successor when no newer sibling is listed", () => {
		expect(unlistedWarning("@cf/acme/gone-1.0", catalogue)).toEqual({ successor: null });
		expect(suggestSuccessor("@cf/moonshotai/kimi-k2.7-code", catalogue.models)).toBeNull();
	});

	it("flags a model the catalogue marks deprecated", () => {
		const dep = { source: "live" as const, models: normaliseCatalogue([row("@cf/acme/old-1.0", "Text Generation", { planned_deprecation_date: "2026-12-01" })]) };
		expect(unlistedWarning("@cf/acme/old-1.0", dep)).toEqual({ successor: null });
	});
});

// ── Router ─────────────────────────────────────────────────────────

const binding = () => ({ run: vi.fn(async (_m: string, _i: unknown) => ({ response: "NO", data: [[0.1]] })) });

function fileWith(models: Record<string, string>, extra: Partial<AiProvidersFile> = {}): AiProvidersFile {
	return parseAiProvidersFile({ workersAi: { models }, ...extra })!;
}

describe("router: per-role Workers AI models", () => {
	afterEach(() => resetAiProvidersCache());

	it("routes each role to the admin's pick, others to their default", async () => {
		const config = fileWith({ agent_chat: "@cf/acme/agent-2.2", triage: "@cf/acme/json-model" });
		const b = binding();
		const agent = await resolveModel({ AI: b as never }, "agent_chat", { config, recorder: null });
		expect(agent).toMatchObject({ kind: "workers-ai", modelId: "@cf/acme/agent-2.2", reason: "default" });
		const triage = await resolveModel({ AI: b as never }, "triage", { config, recorder: null });
		await triage.json({ system: "s", user: "u", maxTokens: 5, schema: { type: "object" } });
		expect(b.run).toHaveBeenCalledWith("@cf/acme/json-model", expect.objectContaining({ response_format: expect.anything() }));
		expect((await resolveModel({ AI: b as never }, "summary", { config, recorder: null })).modelId).toBe(SUMMARY_MODEL);
	});

	it("never changes the scanner, whatever the file or the caller says", async () => {
		const config = fileWith({ injection_scanner: "@cf/acme/agent-2.2" });
		const m = await resolveModel({ AI: binding() as never }, "injection_scanner", { config, recorder: null });
		expect(m).toMatchObject({ modelId: WORKERS_AI_DEFAULTS.injection_scanner, reason: "pinned" });
		const overridden = await resolveModel({ AI: binding() as never }, "injection_scanner", {
			config,
			recorder: null,
			workersAiModel: "@cf/acme/agent-2.2",
		});
		expect(overridden.modelId).toBe(WORKERS_AI_DEFAULTS.injection_scanner);
		expect(workersAiModelFor({}, "injection_scanner", "@cf/acme/x", { injection_scanner: "@cf/acme/y" })).toBe(
			WORKERS_AI_DEFAULTS.injection_scanner,
		);
	});

	it("SUMMARY_MODEL: below the admin's pick, above the default", async () => {
		const env = { AI: binding() as never, SUMMARY_MODEL: "@cf/acme/env-summary" };
		expect((await resolveModel(env, "summary", { config: null, recorder: null })).modelId).toBe("@cf/acme/env-summary");
		expect((await resolveModel(env, "summary", { config: fileWith({ summary: "@cf/acme/picked" }), recorder: null })).modelId).toBe(
			"@cf/acme/picked",
		);
		// Only summaries read it.
		expect((await resolveModel(env, "triage", { config: null, recorder: null })).modelId).toBe(WORKERS_AI_DEFAULTS.triage);
		// The pure precedence, including a per-call override (Test) on top.
		expect(workersAiModelFor(env, "summary", "@cf/acme/test", { summary: "@cf/acme/picked" })).toBe("@cf/acme/test");
		expect(workersAiModelFor({}, "summary", null, {}, "@cf/acme/caller")).toBe("@cf/acme/caller");
	});

	it("the summary path passes SUMMARY_MODEL as a fallback, so the admin's pick wins", async () => {
		const b = { run: vi.fn(async () => ({ response: { line: "A line", bullets: ["one"] } })) };
		const ai = aiFor({ AI: b as never }, { config: fileWith({ summary: "@cf/acme/picked" }), recorder: null });
		await generateSummary(ai, "@cf/acme/env-summary", "text");
		expect(b.run).toHaveBeenCalledWith("@cf/acme/picked", expect.anything());
		const plain = aiFor({ AI: b as never }, { config: null, recorder: null });
		await generateSummary(plain, "@cf/acme/env-summary", "text");
		expect(b.run).toHaveBeenLastCalledWith("@cf/acme/env-summary", expect.anything());
		await generateSummary(plain, undefined, "text");
		expect(b.run).toHaveBeenLastCalledWith(SUMMARY_MODEL, expect.anything());
	});

	it("a turned-off active gateway pauses embeddings instead of switching vector spaces", async () => {
		const config = parseAiProvidersFile({
			providers: [{ id: "gw", label: "Gateway", wire: "openai", baseUrl: "https://gw.example/v1", auth: { scheme: "bearer" }, enabled: false }],
			routing: { gatewayProviderId: "gw", fallbackToWorkersAi: true },
		})!;
		expect(await resolveModel({ AI: binding() as never }, "embeddings", { config, recorder: null })).toMatchObject({ kind: "disabled" });
		expect(await resolveModel({ AI: binding() as never }, "summary", { config, recorder: null })).toMatchObject({
			kind: "workers-ai",
			reason: "missing-provider",
		});
	});

	it("uses the Workers AI pick for an exception role and for fallback while a gateway is active", async () => {
		const config = parseAiProvidersFile({
			providers: [
				{
					id: "gw",
					label: "Gateway",
					wire: "openai",
					baseUrl: "https://gw.example/v1",
					auth: { scheme: "bearer" },
					catalogue: { status: "ok", models: [] },
				},
			],
			routing: { gatewayProviderId: "gw", workersAiExceptions: ["embeddings"], fallbackToWorkersAi: true },
			workersAi: { models: { embeddings: "@cf/acme/embed-1024", summary: "@cf/acme/picked" } },
		})!;
		const emb = await resolveModel({ AI: binding() as never }, "embeddings", { config, recorder: null });
		expect(emb).toMatchObject({ kind: "workers-ai", reason: "exception", modelId: "@cf/acme/embed-1024" });
		// No model picked on the gateway: with fallback on, the role runs on its Workers AI pick.
		const summary = await resolveModel({ AI: binding() as never }, "summary", { config, recorder: null, loadFactory: null });
		expect(summary).toMatchObject({ kind: "workers-ai", modelId: "@cf/acme/picked" });
	});
});

// ── Routes ─────────────────────────────────────────────────────────

describe("settings routes", () => {
	let h: ReturnType<typeof makeHarness>;
	let catalogue: WorkersAiCatalogue;
	beforeEach(() => {
		resetAiProvidersCache();
		aiBreaker.reset();
		h = makeHarness();
		catalogue = LIVE;
		setWorkersAiCatalogueForTests(async () => catalogue);
		setAiProviderRouteNetworkForTests(fakeNetwork().fetch);
	});
	afterEach(() => {
		setWorkersAiCatalogueForTests(undefined);
		setAiProviderRouteNetworkForTests(undefined);
	});
	const admin = (caller: Caller = { kind: "session" }) => as(ADMIN, h.env, caller);
	const route = (models: Record<string, string | null>, extra: Record<string, unknown> = {}, caller?: Caller) =>
		admin(caller)("/api/v1/ai/providers/workers-ai/routing", { method: "PATCH", body: { models, ...extra } });
	const stored = () => JSON.parse(h.bucket.store.get(AI_PROVIDERS_KEY)?.body ?? "null");
	const audit = () =>
		[...h.bucket.store.entries()].filter(([k]) => k.startsWith("audit/_instance/")).map(([, v]) => JSON.parse(v.body));

	it("with no config, lists the built-in provider as active with every role's default", async () => {
		const res = await admin()("/api/v1/ai/providers");
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body.providers).toEqual([]);
		expect(body.status).toMatchObject({ mode: "workers-ai", activeProviderId: "workers-ai", line: "All AI runs on Cloudflare Workers AI." });
		expect(body.status.exceptions.map((e: { role: string }) => e.role)).toContain("injection_scanner");
		expect(body.workersAi.builtIn).toBe(true);
		const agent = body.workersAi.roles.find((r: { role: string }) => r.role === "agent_chat");
		expect(agent).toMatchObject({ modelId: WORKERS_AI_DEFAULTS.agent_chat, source: "default", locked: false });
		expect(body.workersAi.roles.find((r: { role: string }) => r.role === "injection_scanner").locked).toBe(true);
		expect(body.usage).toMatchObject({ byProvider: expect.any(Array) });
		// Reading writes nothing.
		expect(stored()).toBeNull();
	});

	it("shows SUMMARY_MODEL as the summary's source", async () => {
		h.env.SUMMARY_MODEL = "@cf/acme/env-summary";
		const body = await json(await admin()("/api/v1/ai/providers"));
		expect(body.workersAi.roles.find((r: { role: string }) => r.role === "summary")).toMatchObject({
			modelId: "@cf/acme/env-summary",
			source: "env",
		});
	});

	it("saves a valid pick additively in ai/providers.json, audits it, and the router uses it", async () => {
		const res = await route({ agent_chat: "@cf/acme/agent-2.2" });
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body.workersAi.roles.find((r: { role: string }) => r.role === "agent_chat")).toMatchObject({
			modelId: "@cf/acme/agent-2.2",
			source: "admin",
		});
		expect(stored()).toMatchObject({ version: 1, providers: [], workersAi: { models: { agent_chat: "@cf/acme/agent-2.2" } } });
		const entry = audit().find((e) => e.action === "ai.routing");
		expect(entry?.detail).toMatchObject({ provider: "workers-ai", roles: "agent_chat=@cf/acme/agent-2.2" });
		resetAiProvidersCache();
		const m = await resolveModel(h.env as never, "agent_chat", { recorder: null });
		expect(m.modelId).toBe("@cf/acme/agent-2.2");

		// Reset to default removes the pick.
		expect((await route({ agent_chat: null })).status).toBe(200);
		expect(stored().workersAi.models).toEqual({});
	});

	it("refuses invalid picks with the reason, saving nothing", async () => {
		const res = await route({ agent_chat: "@cf/acme/chat-1.0", triage: "@cf/acme/agent-2.2" });
		expect(res.status).toBe(422);
		const body = await json(res);
		expect(body.code).toBe("capability_check_failed");
		expect(body.problems.map((p: { role: string }) => p.role).sort()).toEqual(["agent_chat", "triage"]);
		expect(stored()).toBeNull();
		expect((await route({ injection_scanner: "@cf/acme/agent-2.2" })).status).toBe(422);
		expect((await route({ summary: "gpt-4o" })).status).toBe(400);
		expect((await route({ not_a_role: "@cf/acme/x" })).status).toBe(400);
	});

	it("embeddings: refuses another size; needs confirmation for a same-size change", async () => {
		const wrong = await route({ embeddings: "@cf/acme/embed-768" }, { confirmReindex: true });
		expect(wrong.status).toBe(422);
		expect((await json(wrong)).problems[0].reason).toMatch(/768-dimension/);
		const unconfirmed = await route({ embeddings: "@cf/acme/embed-1024" });
		expect(unconfirmed.status).toBe(422);
		expect((await json(unconfirmed)).code).toBe("reindex_confirm_required");
		const ok = await route({ embeddings: "@cf/acme/embed-1024" }, { confirmReindex: true });
		expect(ok.status).toBe(200);
		expect((await json(ok)).reindex).toBe(true);
		expect(audit().some((e) => e.detail?.reindex === true)).toBe(true);
		// Resetting it back is a change too.
		expect((await json(await route({ embeddings: null }))).code).toBe("reindex_confirm_required");
	});

	it("Test records results, which then unlock a JSON pick for triage", async () => {
		(h.ai.run as ReturnType<typeof vi.fn>).mockImplementation(async (_m: string, input: Record<string, unknown>) =>
			input.response_format ? { response: { ok: true } } : { response: "OK" },
		);
		const res = await admin()("/api/v1/ai/providers/workers-ai/test", {
			method: "POST",
			body: { modelId: "@cf/acme/agent-2.2", checks: ["text", "json"] },
		});
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body.results.map((r: { check: string; ok: boolean }) => [r.check, r.ok])).toEqual([
			["text", true],
			["json", true],
		]);
		expect(h.ai.run).toHaveBeenCalledWith("@cf/acme/agent-2.2", expect.anything());
		expect(stored().workersAi.tested["@cf/acme/agent-2.2"]).toMatchObject({ text: true, json: true });
		expect(audit().find((e) => e.detail?.changed === "tested")?.detail).toMatchObject({
			provider: "workers-ai",
			model: "@cf/acme/agent-2.2",
			checks: "text=pass,json=pass",
		});
		expect((await route({ triage: "@cf/acme/agent-2.2" })).status).toBe(200);
	});

	it("a failed embed Test clears the vector size it found before", async () => {
		const run = h.ai.run as ReturnType<typeof vi.fn>;
		run.mockImplementationOnce(async () => ({ data: [new Array(1024).fill(0.1)] }));
		expect(
			(await admin()("/api/v1/ai/providers/workers-ai/test", { method: "POST", body: { modelId: "@cf/acme/embed-unknown", checks: ["embed"] } }))
				.status,
		).toBe(200);
		expect(stored().workersAi.tested["@cf/acme/embed-unknown"]).toMatchObject({ embed: true, dims: 1024 });
		run.mockImplementationOnce(async () => {
			throw new Error("model unavailable");
		});
		await admin()("/api/v1/ai/providers/workers-ai/test", { method: "POST", body: { modelId: "@cf/acme/embed-unknown", checks: ["embed"] } });
		expect(stored().workersAi.tested["@cf/acme/embed-unknown"]).toMatchObject({ embed: false });
		expect(stored().workersAi.tested["@cf/acme/embed-unknown"].dims).toBeUndefined();
		expect((await route({ embeddings: "@cf/acme/embed-unknown" }, { confirmReindex: true })).status).toBe(422);
	});

	it("an embeddings pick while a gateway serves embeddings needs no re-index confirmation", async () => {
		const res = await admin()("/api/v1/ai/providers", {
			method: "POST",
			body: { label: "OAI gateway", wire: "openai", baseUrl: OAI_BASE, auth: { scheme: "bearer" }, token: OAI_TOKEN },
		});
		const id = (await json(res)).provider.id;
		mutateJson(h.bucket, AI_PROVIDERS_KEY, (f) => {
			f.routing.gatewayProviderId = id;
		});
		resetAiProvidersCache();
		const picked = await route({ embeddings: "@cf/acme/embed-1024" });
		expect(picked.status).toBe(200);
		expect((await json(picked)).reindex).toBe(false);
	});

	it("the catalogue route filters by task and flags an unlisted role model with its successor", async () => {
		catalogue = {
			source: "live",
			fetchedAt: "2026-10-29T00:00:00.000Z",
			models: normaliseCatalogue([...CATALOGUE_ROWS, row("@cf/moonshotai/kimi-k2.6", "Text Generation", { function_calling: "true" })]),
		};
		const res = await admin()("/api/v1/ai/providers/workers-ai/models?task=Text%20Embeddings");
		const body = await json(res);
		expect(body.models.every((m: { task: string }) => m.task === "Text Embeddings")).toBe(true);
		const agent = body.roles.find((r: { role: string }) => r.role === "agent_chat");
		expect(agent).toMatchObject({ modelId: "@cf/moonshotai/kimi-k2.5", unlisted: { successor: "@cf/moonshotai/kimi-k2.6" } });
		// Listed defaults carry no warning.
		expect(body.roles.find((r: { role: string }) => r.role === "embeddings").unlisted).toBeNull();
		// Never switched automatically.
		expect(stored()).toBeNull();
	});

	describe("authz", () => {
		const endpoints = [
			{ method: "GET", path: "/api/v1/ai/providers/workers-ai/models", personOnly: false },
			{ method: "POST", path: "/api/v1/ai/providers/workers-ai/test", body: { modelId: "@cf/acme/agent-2.2", checks: ["text"] }, personOnly: false },
			{ method: "PATCH", path: "/api/v1/ai/providers/workers-ai/routing", body: { models: { summary: "@cf/acme/chat-1.0" } }, personOnly: true },
		];

		it("refuses non-admins everywhere", async () => {
			for (const e of endpoints) {
				const res = await as(MEMBER, h.env, { kind: "session" })(e.path, { method: e.method, body: e.body });
				expect(res.status, `${e.method} ${e.path}`).toBe(403);
			}
		});

		it("an admin token may read and test, never change models", async () => {
			for (const kind of ["token", "oauth"] as const) {
				for (const e of endpoints) {
					const caller: Caller = kind === "token" ? { kind, scopes: ["admin"] } : { kind };
					const res = await admin(caller)(e.path, { method: e.method, body: e.body });
					if (e.personOnly) {
						expect(res.status, `${kind} ${e.method} ${e.path}`).toBe(403);
						expect((await json(res)).code).toBe("person_required");
					} else expect(res.status, `${kind} ${e.method} ${e.path}`).toBe(200);
				}
			}
			expect(stored()?.workersAi?.models ?? {}).toEqual({});
		});

		it("a signed-in admin may change models", async () => {
			expect((await route({ summary: "@cf/acme/chat-1.0" }, {}, { kind: "session" })).status).toBe(200);
			expect((await route({ summary: null }, {}, { kind: "access" })).status).toBe(200);
		});
	});

	describe("one active provider", () => {
		async function addGateway() {
			const res = await admin()("/api/v1/ai/providers", {
				method: "POST",
				body: { label: "OAI gateway", wire: "openai", baseUrl: OAI_BASE, auth: { scheme: "bearer" }, token: OAI_TOKEN },
			});
			expect(res.status).toBe(201);
			return (await json(res)).provider.id as string;
		}

		it("activating a gateway with gaps is refused and lists the unmapped roles", async () => {
			const id = await addGateway();
			const res = await admin()("/api/v1/ai/routing", { method: "PATCH", body: { gatewayProviderId: id } });
			expect(res.status).toBe(422);
			const roles = (await json(res)).problems.map((p: { role: string }) => p.role);
			expect(roles).toEqual(expect.arrayContaining(["agent_chat", "triage", "embeddings"]));
			expect(roles).not.toContain("injection_scanner");
			const body = await json(await admin()("/api/v1/ai/providers"));
			expect(body.status.mode).toBe("workers-ai");
		});

		it("switching is one at a time, and back to built-in in one call; picks on both sides survive", async () => {
			const id = await addGateway();
			await route({ agent_chat: "@cf/acme/agent-2.2" });
			mutateJson(h.bucket, AI_PROVIDERS_KEY, (f) => {
				const p = f.providers[0];
				const known = { value: true, source: "provider" };
				p.catalogue = {
					status: "ok",
					fetchedAt: "2026-10-29T00:00:00Z",
					models: [
						{ id: OAI_CHAT, label: OAI_CHAT, kind: "chat", caps: { tools: known, json: known, vision: known, reasoning: known, embed: { value: false, source: "provider" } } },
					],
				};
				f.routing.default = { modelId: OAI_CHAT };
				f.routing.workersAiExceptions = ["embeddings"];
			});
			resetAiProvidersCache();
			expect((await admin()("/api/v1/ai/routing", { method: "PATCH", body: { gatewayProviderId: id } })).status).toBe(200);
			let body = await json(await admin()("/api/v1/ai/providers"));
			expect(body.status).toMatchObject({ mode: "gateway", activeProviderId: id, line: "All AI runs on OAI gateway." });
			expect(body.status.exceptions.map((e: { text: string }) => e.text)).toEqual(
				expect.arrayContaining([expect.stringMatching(/scanner/), "Embeddings run on Workers AI."]),
			);
			expect(body.routing.gatewayProviderId).toBe(id);

			expect((await admin()("/api/v1/ai/routing", { method: "PATCH", body: { gatewayProviderId: null } })).status).toBe(200);
			body = await json(await admin()("/api/v1/ai/providers"));
			expect(body.status.mode).toBe("workers-ai");
			expect(body.workersAi.roles.find((r: { role: string }) => r.role === "agent_chat").modelId).toBe("@cf/acme/agent-2.2");
			expect(body.providers).toHaveLength(1);
			expect(body.routing.default).toEqual({ modelId: OAI_CHAT });
		});

		it("a disabled or deleted active gateway reads as Workers AI, like the router", async () => {
			const id = await addGateway();
			mutateJson(h.bucket, AI_PROVIDERS_KEY, (f) => {
				f.routing.gatewayProviderId = id;
				f.providers[0].enabled = false;
			});
			resetAiProvidersCache();
			const body = await json(await admin()("/api/v1/ai/providers"));
			expect(body.status.mode).toBe("workers-ai");
		});
	});
});

// ── Re-index on an embeddings change ───────────────────────────────

describe("embeddings model change re-indexes the mailbox", () => {
	function memoryIndex(): VectorizeIndexLike & { store: Map<string, { values: number[] }>; deleted: string[] } {
		const store = new Map<string, { values: number[] }>();
		const deleted: string[] = [];
		return {
			store,
			deleted,
			upsert: vi.fn(async (vectors: { id: string; values: number[] }[]) => {
				for (const v of vectors) store.set(v.id, { values: v.values });
				return { ids: vectors.map((v) => v.id), count: vectors.length };
			}),
			deleteByIds: vi.fn(async (ids: string[]) => {
				for (const id of ids) {
					deleted.push(id);
					store.delete(id);
				}
				return { ids, count: ids.length };
			}),
			query: vi.fn(async () => ({ matches: [], count: 0 })),
		} as never;
	}

	const embeddingRun = () =>
		vi.fn(async (_model: string, input: Record<string, unknown>) => ({ data: (input.text as string[]).map(() => new Array(1024).fill(0.1)) }));

	it("stamps the model, and on a change re-queues indexed mail and replaces its vectors", async () => {
		const { ctx, insert } = mailboxSqlite();
		const id = insert({ folder: "inbox", subject: "Synthetic subject", body: "A synthetic message body long enough to embed." });
		enqueueSemantic(ctx, id, "box@example.com");
		const index = memoryIndex();
		const run = embeddingRun();
		const config = { ...DEFAULT_AI_CONFIG, semantic: true };
		const opts = (models: Record<string, string>) => ({
			ai: aiFor({ AI: { run } as never }, { config: parseAiProvidersFile({ workersAi: { models } })!, recorder: null }),
			index,
			config,
			ignoreDebounce: true,
		});

		expect(indexedEmbeddingModel(ctx)).toBe(LEGACY_EMBEDDING_KEY);
		const first = await processSemanticQueue(ctx, opts({}));
		expect(first.indexed).toBe(1);
		expect(run).toHaveBeenLastCalledWith(EMBEDDING_MODEL, expect.anything());
		expect(indexedEmbeddingModel(ctx)).toBe(LEGACY_EMBEDDING_KEY);

		// Same model again: nothing re-queued.
		expect(reconcileEmbeddingModel(ctx, LEGACY_EMBEDDING_KEY)).toBe(0);

		// The admin switches to another 1024-d model: the next run re-embeds with it.
		const second = await processSemanticQueue(ctx, opts({ embeddings: "@cf/acme/embed-1024" }));
		expect(second.indexed).toBe(1);
		expect(run).toHaveBeenLastCalledWith("@cf/acme/embed-1024", expect.anything());
		expect(indexedEmbeddingModel(ctx)).toBe("workers-ai:@cf/acme/embed-1024");
		// The old vectors were queued for deletion and the new ones written under the same ids.
		expect(index.deleted.length).toBeGreaterThan(0);
		expect(index.store.size).toBeGreaterThan(0);
		const rows = ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM semantic_index`).toArray()[0] as { n: number };
		expect(Number(rows.n)).toBe(1);
		// The whole backlog drained, so the mailbox can be searched with the new model.
		expect(searchableEmbeddingModel(ctx)).toBe("workers-ai:@cf/acme/embed-1024");
	});

	it("stays full-text-only until a capped re-index finishes", async () => {
		const { ctx, insert } = mailboxSqlite();
		for (let i = 0; i < 3; i++) {
			const id = insert({ folder: "inbox", subject: `Synthetic ${i}`, body: `Synthetic body ${i} long enough to embed for the search index.` });
			enqueueSemantic(ctx, id, "box@example.com");
		}
		const config = { ...DEFAULT_AI_CONFIG, semantic: true };
		const run = embeddingRun();
		const opts = (models: Record<string, string>, embedDailyCapPerMailbox = 100) => ({
			ai: aiFor({ AI: { run } as never }, { config: parseAiProvidersFile({ workersAi: { models } })!, recorder: null }),
			index: memoryIndex(),
			config: { ...config, embedDailyCapPerMailbox },
			ignoreDebounce: true,
			now: new Date("2026-10-29T12:00:00.000Z"),
		});
		expect((await processSemanticQueue(ctx, opts({}))).indexed).toBe(3);
		// Today's cap leaves room for only one more message after the change.
		const first = await processSemanticQueue(ctx, opts({ embeddings: "@cf/acme/embed-1024" }, 4));
		expect(first.indexed).toBe(1);
		expect(first.remaining).toBeGreaterThan(0);
		expect(indexedEmbeddingModel(ctx)).toBe("workers-ai:@cf/acme/embed-1024");
		expect(searchableEmbeddingModel(ctx)).toBeNull();
		// Turning search off during a re-index keeps the backlog, so old mail is not lost.
		const off = await processSemanticQueue(ctx, { ...opts({ embeddings: "@cf/acme/embed-1024" }), config: { ...config, semantic: false } });
		expect(off.remaining).toBeGreaterThan(0);
		expect(searchableEmbeddingModel(ctx)).toBeNull();
		const resumed = await processSemanticQueue(ctx, opts({ embeddings: "@cf/acme/embed-1024" }, 100));
		expect(resumed.remaining).toBe(0);
		expect(searchableEmbeddingModel(ctx)).toBe("workers-ai:@cf/acme/embed-1024");
	});

	it("a temporary fallback to Workers AI never re-indexes a gateway-embedded mailbox", async () => {
		const { ctx, insert } = mailboxSqlite();
		const id = insert({ folder: "inbox", subject: "Synthetic", body: "Another synthetic body that is long enough to embed." });
		// Indexed with a gateway model.
		reconcileEmbeddingModel(ctx, "gw:text-embed-1024");
		enqueueSemantic(ctx, id, "box@example.com");
		const run = embeddingRun();
		const fallback = {
			resolve: async () => ({
				...(await resolveModel({ AI: { run } as never }, "embeddings", { config: null, recorder: null })),
				fallback: true,
			}),
		};
		const res = await processSemanticQueue(ctx, {
			ai: fallback as never,
			index: memoryIndex(),
			config: { ...DEFAULT_AI_CONFIG, semantic: true },
			ignoreDebounce: true,
		});
		expect(res.indexed).toBe(0);
		expect(run).not.toHaveBeenCalled();
		expect(indexedEmbeddingModel(ctx)).toBe("gw:text-embed-1024");
		expect(res.remaining).toBe(1);
	});

	it("search skips vectors from a mailbox whose index came from another model", async () => {
		const run = embeddingRun();
		const query = vi.fn(async () => ({
			matches: [{ id: "v", score: 0.9, namespace: "x", metadata: { mailbox: "box@example.com", email_id: "m1" } }],
			count: 1,
		}));
		const stub = (stamp: string) => ({
			searchEmails: async () => [],
			hydrateSemanticHits: async () => [],
			semanticEmbeddingModel: async () => stamp,
		});
		const deps = (stamp: string) => ({
			ai: aiFor({ AI: { run } as never }, { config: parseAiProvidersFile({ workersAi: { models: { embeddings: "@cf/acme/embed-1024" } } })!, recorder: null }),
			index: { query, upsert: vi.fn(), deleteByIds: vi.fn() } as never,
			config: { ...DEFAULT_AI_CONFIG, semantic: true },
			stub: () => stub(stamp) as never,
		});
		await hybridSearch(deps(LEGACY_EMBEDDING_KEY), ["box@example.com"], "where is my synthetic invoice");
		expect(query).not.toHaveBeenCalled();
		await hybridSearch(deps("workers-ai:@cf/acme/embed-1024"), ["box@example.com"], "where is my synthetic invoice");
		expect(query).toHaveBeenCalledTimes(1);
	});
});
