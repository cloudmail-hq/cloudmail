// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Model discovery: list normalisation for each gateway shape in the research
 * doc's table 2.3 (shared/ai-discovery.ts) and the fetch side's pagination,
 * enrichment and status mapping (workers/lib/ai-discovery.ts). Fixtures are
 * synthetic, shaped from each gateway's public docs.
 */

import { describe, expect, it, vi } from "vitest";
import { mergeLiteLlmInfo, normaliseAnthropicPage, normaliseOpenAiList } from "../shared/ai-discovery";
import { CatalogModelSchema, type CatalogModel } from "../shared/ai-providers";
import { discoverModels } from "../workers/lib/ai-discovery";

const openai = (json: unknown, host = "api.example.com") => normaliseOpenAiList(json, { host, wire: "openai" });
const byId = (models: CatalogModel[]) => new Map(models.map((m) => [m.id, m]));
const jsonRes = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("normaliseOpenAiList", () => {
	it("OpenAI: drops image, speech and moderation ids, keeps embeddings, infers caps from hints", () => {
		const models = openai({
			object: "list",
			data: ["gpt-5", "gpt-4.1-mini", "dall-e-3", "tts-1", "whisper-1", "omni-moderation-latest", "gpt-image-1", "text-embedding-3-small"].map(
				(id) => ({ id, object: "model", created: 1, owned_by: "system" }),
			),
		});
		const m = byId(models);
		for (const id of ["dall-e-3", "tts-1", "whisper-1", "omni-moderation-latest", "gpt-image-1"]) {
			expect(m.has(id)).toBe(false);
		}
		expect(m.get("text-embedding-3-small")).toMatchObject({ kind: "embedding", caps: { embed: { value: true, source: "hint" } } });
		expect(m.get("gpt-5")).toMatchObject({
			kind: "chat",
			label: "gpt-5",
			tier: "strong",
			caps: { tools: { value: true, source: "hint" }, json: { value: true, source: "hint" } },
		});
		expect(m.get("gpt-4.1-mini")?.tier).toBe("small");
		// owned_by never survives.
		expect(JSON.stringify(models)).not.toContain("owned_by");
		for (const model of models) expect(CatalogModelSchema.safeParse(model).success).toBe(true);
	});

	it("OpenRouter: context, max output, caps from supported_parameters and modalities, pricing per MTok", () => {
		const models = openai(
			{
				data: [
					{
						id: "anthropic/claude-sonnet-4.5",
						name: "Anthropic: Claude Sonnet 4.5",
						context_length: 1_000_000,
						architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] },
						pricing: { prompt: "0.000003", completion: "0.000015", request: "0" },
						top_provider: { context_length: 1_000_000, max_completion_tokens: 64_000, is_moderated: true },
						supported_parameters: ["tools", "tool_choice", "response_format", "reasoning", "max_tokens"],
					},
					{
						id: "meta-llama/llama-3.1-8b-instruct",
						name: "Meta: Llama 3.1 8B Instruct",
						context_length: 131_072,
						architecture: { input_modalities: ["text"], output_modalities: ["text"] },
						pricing: { prompt: "0.00000002", completion: "0.00000005" },
						supported_parameters: ["max_tokens", "temperature"],
					},
					{
						id: "openai/text-embedding-3-large",
						name: "OpenAI: Text Embedding 3 Large",
						context_length: 8192,
						architecture: { input_modalities: ["text"], output_modalities: ["embeddings"] },
						pricing: { prompt: "0.00000013", completion: "0" },
					},
					{ id: "openrouter/auto", name: "Auto Router", pricing: { prompt: "-1", completion: "-1" }, context_length: 2_000_000 },
				],
			},
			"openrouter.ai",
		);
		const m = byId(models);
		expect(m.get("anthropic/claude-sonnet-4.5")).toMatchObject({
			label: "Anthropic: Claude Sonnet 4.5",
			kind: "chat",
			contextTokens: 1_000_000,
			maxOutputTokens: 64_000,
			pricing: { inputPerMTok: 3, outputPerMTok: 15 },
			caps: {
				tools: { value: true, source: "provider" },
				json: { value: true, source: "provider" },
				vision: { value: true, source: "provider" },
				reasoning: { value: true, source: "provider" },
				embed: { value: false, source: "provider" },
			},
		});
		const llama = m.get("meta-llama/llama-3.1-8b-instruct")!;
		expect(llama.caps.tools).toEqual({ value: false, source: "provider" });
		expect(llama.caps.vision).toEqual({ value: false, source: "provider" });
		expect(llama.pricing).toEqual({ inputPerMTok: 0.02, outputPerMTok: 0.05 });
		expect(m.get("openai/text-embedding-3-large")).toMatchObject({ kind: "embedding", caps: { embed: { value: true, source: "provider" } } });
		// Negative "varies" prices are not prices.
		expect(m.get("openrouter/auto")?.pricing).toBeUndefined();
		expect(JSON.stringify(models)).not.toContain("is_moderated");
	});

	it("Groq: context_window, inactive models dropped", () => {
		const m = byId(
			openai(
				{
					object: "list",
					data: [
						{ id: "llama-3.1-8b-instant", object: "model", owned_by: "Meta", active: true, context_window: 131072 },
						{ id: "old-model", object: "model", owned_by: "Meta", active: false, context_window: 8192 },
						{ id: "whisper-large-v3", object: "model", owned_by: "OpenAI", active: true, context_window: 448 },
					],
				},
				"api.groq.com",
			),
		);
		expect(m.has("old-model")).toBe(false);
		expect(m.get("llama-3.1-8b-instant")).toMatchObject({
			contextTokens: 131072,
			tier: "small",
			caps: { tools: { value: false, source: "hint" } },
		});
		expect(m.has("whisper-large-v3")).toBe(false);
	});

	it("Mistral: max_context_length, capabilities, aliases deduped, archived dropped", () => {
		const row = (id: string, aliases: string[], extra: object = {}) => ({
			id,
			object: "model",
			name: id,
			aliases,
			max_context_length: 131072,
			capabilities: { completion_chat: true, function_calling: true, vision: false, fine_tuning: false },
			archived: false,
			...extra,
		});
		const models = openai(
			{
				object: "list",
				data: [
					row("mistral-large-2411", ["mistral-large-latest"]),
					row("mistral-large-latest", ["mistral-large-2411"]),
					row("pixtral-large-2411", [], { capabilities: { completion_chat: true, function_calling: true, vision: true } }),
					row("mistral-embed", [], { capabilities: { completion_chat: false, function_calling: false, vision: false }, max_context_length: 8192 }),
					row("mistral-medium-2312", [], { archived: true }),
				],
			},
			"api.mistral.ai",
		);
		expect(models.map((m) => m.id)).toEqual(["mistral-large-2411", "pixtral-large-2411", "mistral-embed"]);
		const m = byId(models);
		expect(m.get("mistral-large-2411")).toMatchObject({
			contextTokens: 131072,
			caps: { tools: { value: true, source: "provider" }, vision: { value: false, source: "provider" } },
		});
		expect(m.get("pixtral-large-2411")?.caps.vision).toEqual({ value: true, source: "provider" });
		expect(m.get("mistral-embed")?.kind).toBe("embedding");
	});

	it("Together: top-level array, type field, context_length, pricing per 1M", () => {
		const m = byId(
			openai(
				[
					{
						id: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
						object: "model",
						type: "chat",
						display_name: "Llama 3.3 70B Instruct Turbo",
						organization: "Meta",
						context_length: 131072,
						pricing: { input: 0.88, output: 0.88, hourly: 0, base: 0, finetune: 0 },
					},
					{ id: "BAAI/bge-large-en-v1.5", type: "embedding", context_length: 512, pricing: { input: 0.02, output: 0 } },
					{ id: "black-forest-labs/FLUX.1-schnell", type: "image" },
					{ id: "Salesforce/Llama-Rank-V1", type: "rerank" },
					{ id: "mistralai/Mixtral-8x7B-v0.1", type: "language", context_length: 32768 },
				],
				"api.together.xyz",
			),
		);
		expect(m.get("meta-llama/Llama-3.3-70B-Instruct-Turbo")).toMatchObject({
			kind: "chat",
			label: "Llama 3.3 70B Instruct Turbo",
			contextTokens: 131072,
			pricing: { inputPerMTok: 0.88, outputPerMTok: 0.88 },
		});
		expect(m.get("BAAI/bge-large-en-v1.5")).toMatchObject({ kind: "embedding", caps: { embed: { value: true, source: "provider" } } });
		expect(m.has("black-forest-labs/FLUX.1-schnell")).toBe(false);
		expect(m.has("Salesforce/Llama-Rank-V1")).toBe(false);
		expect(m.get("mistralai/Mixtral-8x7B-v0.1")?.kind).toBe("chat");
		expect(JSON.stringify([...m.values()])).not.toContain("organization");
	});

	it("Fireworks: account-path ids, supports_tools, supports_image_input, context_length", () => {
		const m = byId(
			openai(
				{
					object: "list",
					data: [
						{
							id: "accounts/fireworks/models/qwen3-235b-a22b",
							object: "model",
							owned_by: "fireworks",
							supports_chat: true,
							supports_image_input: false,
							supports_tools: true,
							context_length: 131072,
						},
						{ id: "accounts/fireworks/models/llama-v3p2-90b-vision-instruct", supports_image_input: true, supports_tools: false },
					],
				},
				"api.fireworks.ai",
			),
		);
		expect(m.get("accounts/fireworks/models/qwen3-235b-a22b")).toMatchObject({
			contextTokens: 131072,
			tier: "mid",
			caps: { tools: { value: true, source: "provider" }, vision: { value: false, source: "provider" } },
		});
		expect(m.get("accounts/fireworks/models/llama-v3p2-90b-vision-instruct")?.caps).toMatchObject({
			tools: { value: false, source: "provider" },
			vision: { value: true, source: "provider" },
		});
	});

	it("DeepSeek: ids only, caps from hints", () => {
		const m = byId(
			openai({ object: "list", data: [{ id: "deepseek-v4-pro", owned_by: "deepseek" }, { id: "deepseek-v4-flash", owned_by: "deepseek" }] }, "api.deepseek.com"),
		);
		expect(m.get("deepseek-v4-pro")).toMatchObject({ tier: "mid", caps: { tools: { value: true, source: "hint" }, json: { value: true, source: "hint" } } });
		expect(m.get("deepseek-v4-flash")?.tier).toBe("small");
	});

	it("Gemini: strips the models/ prefix", () => {
		const models = openai(
			{
				object: "list",
				data: [
					{ id: "models/gemini-2.5-flash", object: "model", owned_by: "google" },
					{ id: "models/text-embedding-004", object: "model", owned_by: "google" },
					{ id: "gemini-2.5-pro", object: "model", owned_by: "google" },
				],
			},
			"generativelanguage.googleapis.com",
		);
		expect(models.map((m) => m.id)).toEqual(["gemini-2.5-flash", "text-embedding-004", "gemini-2.5-pro"]);
		expect(models[0]).toMatchObject({ label: "gemini-2.5-flash", tier: "small", caps: { vision: { value: true, source: "hint" } } });
		expect(models[1]?.kind).toBe("embedding");
	});

	it("vLLM: max_model_len", () => {
		const [m] = openai({
			object: "list",
			data: [{ id: "Qwen/Qwen3-32B", object: "model", owned_by: "vllm", root: "/models/qwen3", parent: null, max_model_len: 32768, permission: [{ id: "x" }] }],
		});
		expect(m).toMatchObject({ id: "Qwen/Qwen3-32B", contextTokens: 32768, caps: { tools: { value: true, source: "hint" } } });
		expect(JSON.stringify(m)).not.toContain("permission");
	});

	it("Azure, Ollama and Bedrock: plain OpenAI shape", () => {
		expect(openai({ data: [{ id: "gpt-4o", object: "model", created: 1, lifecycle_status: "generally-available" }] }, "x.openai.azure.com")[0]).toMatchObject({
			id: "gpt-4o",
			kind: "chat",
			tier: "mid",
		});
		expect(openai({ object: "list", data: [{ id: "llama3.1:8b", object: "model", owned_by: "library" }, { id: "nomic-embed-text:latest", owned_by: "library" }] }).map((m) => m.kind)).toEqual(["chat", "embedding"]);
		expect(openai({ object: "list", data: [{ id: "openai.gpt-oss-120b", object: "model" }] }, "bedrock-mantle.us-east-1.api.aws")[0]?.kind).toBe("chat");
	});

	it("hints: claude-* on the OpenAI wire gets tools from hint; unknown models stay null", () => {
		const m = byId(openai({ data: [{ id: "claude-haiku-4-5" }, { id: "llama-3.1-8b" }, { id: "my-finetune" }] }));
		expect(m.get("claude-haiku-4-5")).toMatchObject({ tier: "small", contextTokens: 200_000, caps: { tools: { value: true, source: "hint" } } });
		expect(m.get("llama-3.1-8b")?.caps.tools).toEqual({ value: false, source: "hint" });
		expect(m.get("my-finetune")).toMatchObject({
			kind: "chat",
			tier: null,
			contextTokens: null,
			caps: { tools: { value: null, source: "hint" }, json: { value: null, source: "hint" }, embed: { value: false, source: "hint" } },
		});
	});

	it("drops invalid ids, dedupes and caps at 2000", () => {
		const models = openai({
			data: [{ id: "ok-model" }, { id: "ok-model" }, { id: "bad id with spaces" }, { id: "x".repeat(201) }, { id: "<script>" }, { id: 42 }, "str", null],
		});
		expect(models.map((m) => m.id)).toEqual(["ok-model"]);
		const many = openai({ data: Array.from({ length: 2100 }, (_, i) => ({ id: `m-${i}` })) });
		expect(many).toHaveLength(2000);
		expect(openai({ error: "nope" })).toEqual([]);
	});
});

describe("normaliseAnthropicPage", () => {
	it("maps ModelInfo, with tools always provider-true", () => {
		const page = normaliseAnthropicPage({
			data: [
				{
					type: "model",
					id: "claude-opus-4-5",
					display_name: "Claude Opus 4.5",
					created_at: "2025-11-01T00:00:00Z",
					lifecycle: "active",
					max_input_tokens: 200_000,
					max_tokens: 64_000,
					capabilities: {
						image_input: { supported: true },
						pdf_input: { supported: true },
						structured_outputs: { supported: true },
						thinking: { supported: true, types: { enabled: { supported: true } } },
					},
				},
				{ type: "model", id: "claude-3-haiku-20240307", display_name: "Claude Haiku 3", lifecycle: "deprecated", capabilities: null },
			],
			first_id: "claude-opus-4-5",
			last_id: "claude-3-haiku-20240307",
			has_more: true,
		});
		expect(page.hasMore).toBe(true);
		expect(page.lastId).toBe("claude-3-haiku-20240307");
		expect(page.models[0]).toMatchObject({
			id: "claude-opus-4-5",
			label: "Claude Opus 4.5",
			kind: "chat",
			contextTokens: 200_000,
			maxOutputTokens: 64_000,
			lifecycle: "active",
			tier: "strong",
			caps: {
				tools: { value: true, source: "provider" },
				json: { value: true, source: "provider" },
				vision: { value: true, source: "provider" },
				reasoning: { value: true, source: "provider" },
			},
		});
		expect(page.models[1]).toMatchObject({
			lifecycle: "deprecated",
			caps: { tools: { value: true, source: "provider" }, json: { value: true, source: "hint" } },
		});
	});

	it("minimal proxies: { id, display_name, type } only", () => {
		const page = normaliseAnthropicPage({ data: [{ id: "glm-4.6", display_name: "GLM 4.6", type: "model" }, { id: "kimi-k2-thinking", type: "model" }] });
		expect(page.hasMore).toBe(false);
		expect(page.lastId).toBe("kimi-k2-thinking");
		expect(page.models[0]).toMatchObject({
			label: "GLM 4.6",
			kind: "chat",
			caps: { tools: { value: true, source: "provider" }, json: { value: null, source: "hint" } },
		});
		expect(page.models[1]?.tier).toBe("strong");
	});
});

describe("mergeLiteLlmInfo", () => {
	it("overlays /model/info facts on the bare list", () => {
		const base = openai({
			object: "list",
			data: [{ id: "gpt-4o", object: "model", owned_by: "openai" }, { id: "local-embed", object: "model" }, { id: "untouched" }],
		});
		const merged = byId(
			mergeLiteLlmInfo(base, {
				data: [
					{
						model_name: "gpt-4o",
						litellm_params: { model: "openai/gpt-4o", api_key: "sk-should-never-appear" },
						model_info: {
							max_input_tokens: 128000,
							max_output_tokens: 16384,
							supports_function_calling: true,
							supports_vision: true,
							supports_response_schema: true,
							mode: "chat",
							input_cost_per_token: 0.0000025,
							output_cost_per_token: 0.00001,
						},
					},
					{ model_name: "local-embed", model_info: { mode: "embedding", max_input_tokens: 8192 } },
				],
			}),
		);
		expect(merged.get("gpt-4o")).toMatchObject({
			contextTokens: 128000,
			maxOutputTokens: 16384,
			pricing: { inputPerMTok: 2.5, outputPerMTok: 10 },
			caps: {
				tools: { value: true, source: "provider" },
				json: { value: true, source: "provider" },
				vision: { value: true, source: "provider" },
			},
		});
		expect(merged.get("local-embed")).toMatchObject({ kind: "embedding", contextTokens: 8192, caps: { embed: { value: true, source: "provider" } } });
		expect(merged.get("untouched")).toEqual(byId(base).get("untouched"));
		expect(JSON.stringify([...merged.values()])).not.toContain("sk-should-never-appear");
	});
});

describe("discoverModels", () => {
	const anthropicProvider = { baseUrl: "https://api.anthropic.com", wire: "anthropic" as const, exactBaseUrl: false, options: {} };
	const openaiProvider = (baseUrl: string, options = {}) => ({ baseUrl, wire: "openai" as const, exactBaseUrl: false, options });
	const now = () => Date.UTC(2026, 9, 28, 12, 0, 0);

	it("Anthropic: limit=1000, after_id pagination, anthropic-version, stops at has_more false", async () => {
		const fetchFn = vi.fn(async (url: string) => {
			const after = new URL(url).searchParams.get("after_id");
			return after
				? jsonRes({ data: [{ id: "claude-haiku-4-5", type: "model" }], has_more: false, last_id: "claude-haiku-4-5" })
				: jsonRes({ data: [{ id: "claude-opus-4-5", type: "model" }], has_more: true, last_id: "claude-opus-4-5" });
		});
		const cat = await discoverModels(anthropicProvider, { fetch: fetchFn as unknown as typeof fetch, headers: { "x-api-key": "k" }, now });
		expect(cat).toMatchObject({ status: "ok", detail: null, fetchedAt: "2026-10-28T12:00:00.000Z" });
		expect(cat.models.map((m) => m.id)).toEqual(["claude-opus-4-5", "claude-haiku-4-5"]);
		expect(fetchFn).toHaveBeenCalledTimes(2);
		const [u1, init1] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
		const u2 = new URL((fetchFn.mock.calls[1] as unknown as [string])[0]);
		expect(new URL(u1).pathname).toBe("/v1/models");
		expect(new URL(u1).searchParams.get("limit")).toBe("1000");
		expect(new URL(u1).searchParams.get("after_id")).toBeNull();
		expect(u2.searchParams.get("limit")).toBe("1000");
		expect(u2.searchParams.get("after_id")).toBe("claude-opus-4-5");
		expect(init1.headers).toMatchObject({ "anthropic-version": "2023-06-01", "x-api-key": "k" });
	});

	it("Anthropic: keeps a caller's anthropic-version and stops at 5 pages", async () => {
		let n = 0;
		const fetchFn = vi.fn(async () => {
			n++;
			return jsonRes({ data: [{ id: `claude-m-${n}`, type: "model" }], has_more: true, last_id: `claude-m-${n}` });
		});
		const cat = await discoverModels(anthropicProvider, {
			fetch: fetchFn as unknown as typeof fetch,
			headers: { "Anthropic-Version": "2026-10-21" },
		});
		expect(fetchFn).toHaveBeenCalledTimes(5);
		expect(cat.models).toHaveLength(5);
		const headers = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
		expect(headers["Anthropic-Version"]).toBe("2026-10-21");
		expect(headers["anthropic-version"]).toBeUndefined();
	});

	it("OpenRouter: asks for every output modality", async () => {
		const fetchFn = vi.fn(async () => jsonRes({ data: [{ id: "openai/gpt-5" }] }));
		const cat = await discoverModels(openaiProvider("https://openrouter.ai/api/v1"), { fetch: fetchFn as unknown as typeof fetch, headers: {} });
		const url = new URL((fetchFn.mock.calls[0] as unknown as [string])[0]);
		expect(url.origin + url.pathname).toBe("https://openrouter.ai/api/v1/models");
		expect(url.searchParams.get("output_modalities")).toBe("all");
		expect(cat.status).toBe("ok");
	});

	it("LiteLLM: also reads /model/info at the proxy root, best effort", async () => {
		const fetchFn = vi.fn(async (url: string) => {
			if (url.endsWith("/v1/models")) return jsonRes({ data: [{ id: "team-gpt", object: "model" }] });
			if (url === "https://litellm.example.com/model/info") {
				return jsonRes({ data: [{ model_name: "team-gpt", model_info: { supports_function_calling: true, max_input_tokens: 64000 } }] });
			}
			return jsonRes({}, 404);
		});
		const cat = await discoverModels(openaiProvider("https://litellm.example.com/v1"), { fetch: fetchFn as unknown as typeof fetch, headers: {} });
		expect(cat.models[0]).toMatchObject({ id: "team-gpt", contextTokens: 64000, caps: { tools: { value: true, source: "provider" } } });
		const init = (fetchFn.mock.calls[1] as unknown as [string, RequestInit])[1];
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("LiteLLM: info failures keep the plain list; the toggle enables it on any host", async () => {
		const fetchFn = vi.fn(async (url: string) => (url.endsWith("/models") ? jsonRes({ data: [{ id: "m1" }] }) : jsonRes({ error: "admin only" }, 403)));
		const cat = await discoverModels(openaiProvider("https://proxy.example.com", { litellmInfo: true }), {
			fetch: fetchFn as unknown as typeof fetch,
			headers: {},
		});
		expect(cat.status).toBe("ok");
		expect(cat.models.map((m) => m.id)).toEqual(["m1"]);
		const urls = fetchFn.mock.calls.map((c) => (c as unknown as [string])[0]);
		expect(urls).toEqual(["https://proxy.example.com/v1/models", "https://proxy.example.com/model/info", "https://proxy.example.com/v1/model/info"]);
	});

	it("does not call /model/info for other hosts", async () => {
		const fetchFn = vi.fn(async () => jsonRes({ data: [{ id: "m1" }] }));
		await discoverModels(openaiProvider("https://api.openai.com"), { fetch: fetchFn as unknown as typeof fetch, headers: {} });
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it.each([
		[404, "no-discovery"],
		[405, "no-discovery"],
		[401, "auth-failed"],
		[403, "auth-failed"],
		[500, "error"],
		[429, "error"],
	])("HTTP %i → %s, detail is the status only", async (status, expected) => {
		const secret = "sk-live-SECRETSECRET1234567890";
		const fetchFn = vi.fn(async () => jsonRes({ error: { message: `Invalid key ${secret}` } }, status));
		const cat = await discoverModels(openaiProvider("https://api.example.com"), { fetch: fetchFn as unknown as typeof fetch, headers: {} });
		expect(cat.status).toBe(expected);
		expect(cat.detail).toBe(`HTTP ${status}`);
		expect(cat.models).toEqual([]);
		expect(JSON.stringify(cat)).not.toContain("SECRETSECRET");
	});

	it("thrown fetch errors become a redacted error detail", async () => {
		const fetchFn = vi.fn(async () => {
			throw new Error("connect failed\nAuthorization: Bearer sk-abcdefghijklmnop");
		});
		const cat = await discoverModels(openaiProvider("https://api.example.com"), { fetch: fetchFn as unknown as typeof fetch, headers: {} });
		expect(cat.status).toBe("error");
		expect(cat.detail).toBe("connect failed");
	});

	it("an oversized body is an error", async () => {
		const big = JSON.stringify({ data: [{ id: "m", pad: "x".repeat(2 * 1024 * 1024 + 10) }] });
		const fetchFn = vi.fn(async () => new Response(big, { status: 200 }));
		const cat = await discoverModels(openaiProvider("https://api.example.com"), { fetch: fetchFn as unknown as typeof fetch, headers: {} });
		expect(cat.status).toBe("error");
		expect(cat.detail).toMatch(/too large/);
	});

	it("invalid JSON and unknown shapes are errors without echoing the body", async () => {
		const fetchFn = vi.fn(async () => new Response("<html>sk-leakyleakyleaky</html>", { status: 200 }));
		const cat = await discoverModels(openaiProvider("https://api.example.com"), { fetch: fetchFn as unknown as typeof fetch, headers: {} });
		expect(cat.status).toBe("error");
		expect(JSON.stringify(cat)).not.toContain("leaky");
		const fetch2 = vi.fn(async () => jsonRes({ hello: "world" }));
		expect((await discoverModels(openaiProvider("https://api.example.com"), { fetch: fetch2 as unknown as typeof fetch, headers: {} })).status).toBe("error");
	});

	it("drops invalid ids from a live list", async () => {
		const fetchFn = vi.fn(async () => jsonRes({ data: [{ id: "good-1" }, { id: "bad/../ id" }, { id: "" }] }));
		const cat = await discoverModels(openaiProvider("https://api.example.com"), { fetch: fetchFn as unknown as typeof fetch, headers: {} });
		expect(cat.models.map((m) => m.id)).toEqual(["good-1"]);
	});
});
