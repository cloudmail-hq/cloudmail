// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Bring-your-own AI gateway rules shared by the Worker and the settings UI
 * (shared/ai-gateway.ts, shared/ai-model-hints.ts): base-URL normalisation
 * for every row of the research doc's table 2.1, wire and auth suggestions,
 * the extra-header denylist, the per-role capability gate and activation.
 */

import { describe, expect, it } from "vitest";
import {
	activationProblems,
	apiBaseFor,
	canonicalBaseUrl,
	checkRoleModel,
	defaultAuthScheme,
	effectiveModelId,
	headerNameProblem,
	headersProblems,
	headerValueProblem,
	needsCustomIds,
	suggestWire,
	tokenHint,
} from "../shared/ai-gateway";
import { hintFor } from "../shared/ai-model-hints";
import {
	AiProviderSchema,
	CatalogModelSchema,
	GATEWAY_ROLES,
	type AiProvider,
	type AiRole,
	type CapSource,
	type CatalogModel,
} from "../shared/ai-providers";
import { EMBEDDING_DIMENSIONS } from "../shared/semantic";

type Caps = Partial<Record<"tools" | "json" | "vision" | "reasoning" | "embed", { value: boolean | null; source: CapSource }>>;

function chat(id: string, caps: Caps = {}): CatalogModel {
	return CatalogModelSchema.parse({ id, label: id, kind: "chat", caps });
}

function embedding(id: string, dims: number | null | undefined): CatalogModel {
	return CatalogModelSchema.parse({ id, label: id, kind: "embedding", embeddingDims: dims });
}

const cap = (value: boolean | null, source: CapSource) => ({ value, source });

function provider(wire: AiProvider["wire"] = "openai"): AiProvider {
	return AiProviderSchema.parse({
		id: "gw",
		label: "Gateway",
		wire,
		baseUrl: "https://api.example.com",
		auth: { scheme: "bearer" },
	});
}

const routing = (over: Partial<{
	models: Record<string, { modelId: string }>;
	default: { modelId: string };
	workersAiExceptions: string[];
	disabledRoles: string[];
}> = {}) => ({ models: {}, workersAiExceptions: [], disabledRoles: [], ...over });

// ── Base URL ───────────────────────────────────────────────────────

describe("apiBaseFor (table 2.1)", () => {
	it.each([
		["https://api.anthropic.com", "anthropic", "https://api.anthropic.com/v1"],
		["https://api.deepseek.com/anthropic", "anthropic", "https://api.deepseek.com/anthropic/v1"],
		["https://api.deepseek.com", "anthropic", "https://api.deepseek.com/anthropic/v1"],
		["https://api.openai.com", "openai", "https://api.openai.com/v1"],
		["https://openrouter.ai", "openai", "https://openrouter.ai/api/v1"],
		["https://openrouter.ai/api", "openai", "https://openrouter.ai/api/v1"],
		["https://api.groq.com", "openai", "https://api.groq.com/openai/v1"],
		["https://api.groq.com/openai", "openai", "https://api.groq.com/openai/v1"],
		[
			"https://generativelanguage.googleapis.com/v1beta/openai",
			"openai",
			"https://generativelanguage.googleapis.com/v1beta/openai",
		],
		["https://generativelanguage.googleapis.com", "openai", "https://generativelanguage.googleapis.com/v1beta/openai"],
		["https://x.openai.azure.com", "openai", "https://x.openai.azure.com/openai/v1"],
		["https://x.services.ai.azure.com", "openai", "https://x.services.ai.azure.com/openai/v1"],
		["https://bedrock-mantle.us-east-1.api.aws", "openai", "https://bedrock-mantle.us-east-1.api.aws/v1"],
		["https://bedrock-mantle.us-east-1.api.aws/openai", "openai", "https://bedrock-mantle.us-east-1.api.aws/openai/v1"],
		[
			"https://gateway.ai.cloudflare.com/v1/acct/gw/openai",
			"openai",
			"https://gateway.ai.cloudflare.com/v1/acct/gw/openai",
		],
		[
			"https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic",
			"anthropic",
			"https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1",
		],
		[
			"https://gateway.ai.cloudflare.com/v1/acct/gw/compat",
			"openai",
			"https://gateway.ai.cloudflare.com/v1/acct/gw/compat",
		],
		["https://api.fireworks.ai", "openai", "https://api.fireworks.ai/inference/v1"],
		["https://litellm.example.com/proxy", "openai", "https://litellm.example.com/proxy/v1"],
	] as const)("%s (%s) → %s", (base, wire, expected) => {
		expect(apiBaseFor(base, wire)).toBe(expected);
	});

	it.each([
		"https://llm.example.com/v1",
		"https://llm.example.com/openai/v1",
		"https://llm.example.com/v1beta/openai",
	])("keeps a path that is already an API base: %s", (base) => {
		expect(apiBaseFor(base, "openai")).toBe(base);
	});

	it("strips trailing slashes, query and fragment before deriving", () => {
		expect(canonicalBaseUrl("https://api.openai.com/v1///?x=1#frag")).toBe("https://api.openai.com/v1");
		expect(canonicalBaseUrl("  https://openrouter.ai/api/  ")).toBe("https://openrouter.ai/api");
		expect(canonicalBaseUrl("not a url")).toBeNull();
		expect(apiBaseFor("https://api.openai.com/?token=abc#x", "openai")).toBe("https://api.openai.com/v1");
		expect(apiBaseFor("https://openrouter.ai/api/", "openai")).toBe("https://openrouter.ai/api/v1");
	});

	it("exact=true returns the canonical URL untouched", () => {
		expect(apiBaseFor("https://api.openai.com", "openai", true)).toBe("https://api.openai.com");
		expect(apiBaseFor("https://llm.example.com/custom/path/", "openai", true)).toBe("https://llm.example.com/custom/path");
		expect(apiBaseFor("https://x.openai.azure.com", "openai", true)).toBe("https://x.openai.azure.com");
	});
});

describe("suggestWire, defaultAuthScheme, needsCustomIds", () => {
	it.each([
		["https://api.anthropic.com", "anthropic"],
		["https://api.deepseek.com/anthropic", "anthropic"],
		["https://gateway.ai.cloudflare.com/v1/a/g/anthropic", "anthropic"],
		["https://api.openai.com", "openai"],
		["https://openrouter.ai/api", "openai"],
		["https://api.groq.com/openai", "openai"],
		["https://generativelanguage.googleapis.com/v1beta/openai", "openai"],
		["https://x.openai.azure.com", "openai"],
		["https://gateway.ai.cloudflare.com/v1/a/g/compat", "openai"],
	] as const)("%s → %s", (base, wire) => {
		expect(suggestWire(base)).toBe(wire);
	});

	it("never guesses for an unknown host", () => {
		expect(suggestWire("https://llm.example.com")).toBeNull();
		expect(suggestWire("https://llm.example.com/v1")).toBeNull();
		expect(suggestWire("garbage")).toBeNull();
	});

	it("default auth: azure api-key, anthropic x-api-key, openai bearer", () => {
		expect(defaultAuthScheme("openai", "https://x.openai.azure.com")).toBe("api-key");
		expect(defaultAuthScheme("openai", "https://x.services.ai.azure.com")).toBe("api-key");
		expect(defaultAuthScheme("anthropic", "https://api.anthropic.com")).toBe("x-api-key");
		expect(defaultAuthScheme("openai", "https://api.openai.com")).toBe("bearer");
		expect(defaultAuthScheme("openai", "not a url")).toBe("bearer");
	});

	it("custom ids for Azure and Cloudflare AI Gateway only", () => {
		expect(needsCustomIds("https://x.openai.azure.com")).toBe(true);
		expect(needsCustomIds("https://x.services.ai.azure.com")).toBe(true);
		expect(needsCustomIds("https://gateway.ai.cloudflare.com/v1/a/g/openai")).toBe(true);
		expect(needsCustomIds("https://api.openai.com")).toBe(false);
		expect(needsCustomIds("garbage")).toBe(false);
	});
});

// ── Headers ────────────────────────────────────────────────────────

describe("header denylist", () => {
	const bearer = { scheme: "bearer" } as const;

	it.each(["host", "Content-Length", "connection", "Transfer-Encoding", "cookie", "x-forwarded-for", "cf-connecting-ip", "CF-Ray"])(
		"blocks %s",
		(name) => {
			expect(headerNameProblem(name, bearer)).not.toBeNull();
		},
	);

	it.each(["cf-aig-authorization", "cf-access-client-id", "OpenAI-Organization", "anthropic-beta", "HTTP-Referer", "X-Title"])(
		"allows %s",
		(name) => {
			expect(headerNameProblem(name, bearer)).toBeNull();
		},
	);

	it("refuses the header that already carries the token", () => {
		expect(headerNameProblem("x-api-key", { scheme: "x-api-key" })).toMatch(/token/);
		expect(headerNameProblem("X-API-Key", { scheme: "x-api-key" })).toMatch(/token/);
		expect(headerNameProblem("api-key", { scheme: "api-key" })).toMatch(/token/);
		expect(headerNameProblem("X-My-Key", { scheme: "custom", header: "x-my-key" })).toMatch(/token/);
		expect(headerNameProblem("Authorization", bearer)).not.toBeNull();
		expect(headerNameProblem("Authorization", { scheme: "x-api-key" })).not.toBeNull();
		// Not the token's header under these schemes, so allowed.
		expect(headerNameProblem("x-api-key", bearer)).toBeNull();
		expect(headerNameProblem("Authorization", { scheme: "none" })).toBeNull();
	});

	it("refuses malformed names", () => {
		expect(headerNameProblem("X Title", bearer)).not.toBeNull();
		expect(headerNameProblem("X-Title:", bearer)).not.toBeNull();
		expect(headerNameProblem("", bearer)).not.toBeNull();
		expect(headerNameProblem("a".repeat(65), bearer)).not.toBeNull();
		expect(headerNameProblem("a".repeat(64), bearer)).toBeNull();
	});

	it("headerValueProblem blocks CR, LF and NUL", () => {
		expect(headerValueProblem("ok value")).toBeNull();
		expect(headerValueProblem("a\rb")).not.toBeNull();
		expect(headerValueProblem("a\nX-Injected: 1")).not.toBeNull();
		expect(headerValueProblem("a\0b")).not.toBeNull();
	});

	it("headersProblems catches duplicates (case-insensitive) and more than 8", () => {
		expect(headersProblems([{ name: "X-Title" }, { name: "HTTP-Referer" }], bearer)).toEqual([]);
		expect(headersProblems([{ name: "X-Title" }, { name: "x-title" }], bearer)).toEqual(["x-title is listed twice."]);
		const nine = Array.from({ length: 9 }, (_, i) => ({ name: `X-H${i}` }));
		expect(headersProblems(nine, bearer)).toEqual(["At most 8 extra headers."]);
		expect(headersProblems(nine.slice(0, 8), bearer)).toEqual([]);
	});
});

// ── Capability gate ────────────────────────────────────────────────

describe("checkRoleModel", () => {
	const KNOWN: CapSource[] = ["probe", "admin", "provider"];

	describe.each([
		["agent_chat", "tools"],
		["auto_draft", "tools"],
		["triage", "json"],
	] as const)("%s needs %s", (role, need) => {
		it("refuses a hint-only true", () => {
			const r = checkRoleModel(role, chat("m", { [need]: cap(true, "hint") }), "openai");
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.reason).toMatch(/verified/);
		});
		it.each(KNOWN)("accepts true from %s", (source) => {
			expect(checkRoleModel(role, chat("m", { [need]: cap(true, source) }), "openai")).toEqual({ ok: true });
		});
		it("refuses a known false with a clear reason", () => {
			const r = checkRoleModel(role, chat("m", { [need]: cap(false, "probe") }), "openai");
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.reason).toMatch(need === "tools" ? /can't call tools/ : /can't return JSON/);
		});
		it("refuses an unknown value", () => {
			expect(checkRoleModel(role, chat("m"), "openai").ok).toBe(false);
		});
	});

	it.each(["nudge", "summary", "followup_classifier", "draft_verifier", "ask_answer", "daily_brief"] as const)(
		"text role %s accepts a hint-only model",
		(role) => {
			expect(checkRoleModel(role, chat("m", { tools: cap(true, "hint") }), "anthropic")).toEqual({ ok: true });
			expect(checkRoleModel(role, chat("m"), "openai")).toEqual({ ok: true });
		},
	);

	describe("embeddings", () => {
		it("refused on the anthropic wire", () => {
			const r = checkRoleModel("embeddings", embedding("e", EMBEDDING_DIMENSIONS), "anthropic");
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.reason).toMatch(/Anthropic/);
		});
		it("refused for a chat model", () => {
			expect(checkRoleModel("embeddings", chat("gpt-5"), "openai")).toEqual({ ok: false, reason: "Not an embedding model." });
		});
		it("refused with no dims or wrong dims", () => {
			expect(checkRoleModel("embeddings", embedding("e", undefined), "openai").ok).toBe(false);
			expect(checkRoleModel("embeddings", embedding("e", null), "openai").ok).toBe(false);
			const r = checkRoleModel("embeddings", embedding("e", 768), "openai");
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.reason).toContain("768");
		});
		it(`ok at ${EMBEDDING_DIMENSIONS}`, () => {
			expect(EMBEDDING_DIMENSIONS).toBe(1024);
			expect(checkRoleModel("embeddings", embedding("e", 1024), "openai")).toEqual({ ok: true });
		});
		it("a chat-kind model with a known embed cap counts as an embedding model", () => {
			const m = CatalogModelSchema.parse({ id: "e", label: "e", kind: "chat", caps: { embed: cap(true, "probe") }, embeddingDims: 1024 });
			expect(checkRoleModel("embeddings", m, "openai")).toEqual({ ok: true });
			const hinted = CatalogModelSchema.parse({ id: "e", label: "e", kind: "chat", caps: { embed: cap(true, "hint") }, embeddingDims: 1024 });
			expect(checkRoleModel("embeddings", hinted, "openai").ok).toBe(false);
		});
	});

	it("the injection scanner is always refused", () => {
		const m = chat("m", { tools: cap(true, "admin"), json: cap(true, "admin") });
		expect(checkRoleModel("injection_scanner", m, "openai").ok).toBe(false);
		expect(checkRoleModel("injection_scanner", undefined, "openai").ok).toBe(false);
	});

	it("an undefined model is refused", () => {
		const r = checkRoleModel("summary", undefined, "openai");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/custom model/);
	});

	it("an embedding model can't serve a text role, kind other is refused", () => {
		expect(checkRoleModel("summary", embedding("e", 1024), "openai")).toEqual({ ok: false, reason: "An embedding model can't write text." });
		const other = CatalogModelSchema.parse({ id: "whisper-1", label: "w", kind: "other" });
		expect(checkRoleModel("summary", other, "openai")).toEqual({ ok: false, reason: "Not a chat model." });
	});
});

describe("activationProblems", () => {
	const strong = chat("strong", { tools: cap(true, "admin"), json: cap(true, "admin") });
	const emb = embedding("emb", 1024);

	it("lists every gateway role with no pick when there's no default", () => {
		const problems = activationProblems(provider(), routing(), [strong, emb]);
		expect(problems.map((p) => p.role)).toEqual([...GATEWAY_ROLES]);
		expect(problems.map((p) => p.role)).not.toContain("injection_scanner");
		expect(problems.find((p) => p.role === "embeddings")?.reason).toMatch(/embedding model/);
		expect(problems.find((p) => p.role === "summary")?.reason).toBe("Pick a model.");
	});

	it("a default covers the chat roles but not embeddings", () => {
		const problems = activationProblems(provider(), routing({ default: { modelId: "strong" } }), [strong, emb]);
		expect(problems.map((p) => p.role)).toEqual(["embeddings"]);
	});

	it("embeddings is satisfied by its own pick, the workers-ai exception or disabledRoles", () => {
		const base = { default: { modelId: "strong" } };
		expect(activationProblems(provider(), routing({ ...base, models: { embeddings: { modelId: "emb" } } }), [strong, emb])).toEqual([]);
		expect(activationProblems(provider(), routing({ ...base, workersAiExceptions: ["embeddings"] }), [strong])).toEqual([]);
		expect(activationProblems(provider(), routing({ ...base, disabledRoles: ["embeddings"] }), [strong])).toEqual([]);
	});

	it("reports a failing role with the gate's reason", () => {
		const weak = chat("weak", { tools: cap(false, "probe") });
		const problems = activationProblems(
			provider(),
			routing({ default: { modelId: "strong" }, models: { agent_chat: { modelId: "weak" } }, disabledRoles: ["embeddings"] }),
			[strong, weak],
		);
		expect(problems).toEqual([{ role: "agent_chat", reason: "This model can't call tools." }]);
	});

	it("embeddings on an anthropic-wire gateway is reported", () => {
		const problems = activationProblems(
			provider("anthropic"),
			routing({ default: { modelId: "strong" }, models: { embeddings: { modelId: "emb" } } }),
			[strong, emb],
		);
		expect(problems).toEqual([{ role: "embeddings", reason: "Anthropic-wire gateways have no embeddings API." }]);
	});
});

describe("effectiveModelId and tokenHint", () => {
	it("own pick, else default, never default for embeddings", () => {
		const r = { models: { summary: { modelId: "s" } }, default: { modelId: "d" } };
		expect(effectiveModelId(r, "summary")).toBe("s");
		expect(effectiveModelId(r, "triage")).toBe("d");
		expect(effectiveModelId(r, "embeddings")).toBeNull();
		expect(effectiveModelId({ models: { embeddings: { modelId: "e" } } }, "embeddings")).toBe("e");
		expect(effectiveModelId({ models: {} }, "summary" as AiRole)).toBeNull();
	});

	it("tokenHint shows the last four only", () => {
		expect(tokenHint("sk-proj-abcdefa1b2")).toBe("…a1b2");
		expect(tokenHint("  sk-abcd1234  ")).toBe("…1234");
		expect(tokenHint("abcd")).toBe("…");
		expect(tokenHint("")).toBe("…");
	});
});

// ── Model hints ────────────────────────────────────────────────────

describe("hintFor", () => {
	it("matches families with vendor prefixes dropped", () => {
		expect(hintFor("claude-haiku-4-5")?.tier).toBe("small");
		expect(hintFor("claude-3-5-haiku-latest")?.tier).toBe("small");
		expect(hintFor("gpt-5-mini")?.tier).toBe("small");
		expect(hintFor("gpt-5")?.tier).toBe("strong");
		const sonnet = hintFor("anthropic/claude-sonnet-x");
		expect(sonnet?.tier).toBe("mid");
		expect(sonnet?.tools).toBe(true);
		expect(hintFor("models/gemini-2.5-flash")?.tier).toBe("small");
		expect(hintFor("accounts/fireworks/models/qwen3-235b")?.tools).toBe(true);
	});

	it("llama-3.1-8b has tools false", () => {
		expect(hintFor("llama-3.1-8b-instant")?.tools).toBe(false);
		expect(hintFor("meta-llama/llama-3.1-8b-instruct")?.tools).toBe(false);
	});

	it("an unknown id is null", () => {
		expect(hintFor("my-private-model")).toBeNull();
		expect(hintFor("")).toBeNull();
	});
});
