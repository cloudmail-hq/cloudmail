// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Turns a gateway's model list into catalogue rows. Pure: no fetch (that is
 * workers/lib/ai-discovery.ts).
 *
 * Both list shapes (OpenAI `{ data: [...] }` and Anthropic ModelInfo pages)
 * go through one field extractor, so the first-match-wins mapping in the
 * research doc (section 2.4) lives in one place. Fields a gateway states are
 * recorded with source "provider"; gaps are filled from the hints table
 * (shared/ai-model-hints.ts) with source "hint", or left `null`.
 *
 * Only the normalised fields are kept. Raw rows can carry org metadata and
 * are never stored.
 */

import { EMBEDDING_ID, OTHER_ID, hintFor } from "./ai-model-hints";
import { MODEL_ID, type Cap, type CatalogModel } from "./ai-providers";

/** Most rows a catalogue keeps (matches CatalogueSchema). */
export const MAX_CATALOGUE_MODELS = 2000;

type Kind = CatalogModel["kind"];
type Lifecycle = NonNullable<CatalogModel["lifecycle"]>;
type Pricing = NonNullable<CatalogModel["pricing"]>;

/** What one row states explicitly. Undefined means the row says nothing. */
interface Facts {
	id: string;
	label?: string;
	kind?: Kind;
	contextTokens?: number;
	maxOutputTokens?: number;
	tools?: boolean;
	json?: boolean;
	vision?: boolean;
	reasoning?: boolean;
	lifecycle?: Lifecycle;
	pricing?: Pricing;
}

type Row = Record<string, unknown>;

const isObj = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** A positive integer, from a number or a numeric string. */
function posInt(v: unknown): number | undefined {
	const n = typeof v === "string" && v.trim() ? Number(v) : v;
	return typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}

/** A price: non-negative finite number, from a number or a numeric string. */
function price(v: unknown): number | undefined {
	const n = typeof v === "string" && v.trim() ? Number(v) : v;
	return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** `true`/`false`, or `{ supported: boolean }` (Anthropic capabilities). */
function flag(v: unknown): boolean | undefined {
	if (typeof v === "boolean") return v;
	if (isObj(v) && typeof v.supported === "boolean") return v.supported;
	return undefined;
}

const strList = (v: unknown): string[] | undefined =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()) : undefined;

const first = <T>(...vals: (T | undefined)[]): T | undefined => vals.find((v) => v !== undefined);

/** Per-token USD to per-million, without float noise. */
const perMTok = (perToken: number) => Math.round(perToken * 1e6 * 1e6) / 1e6;

const TOGETHER_KINDS: Record<string, Kind> = {
	chat: "chat",
	language: "chat",
	code: "chat",
	embedding: "embedding",
	image: "other",
	rerank: "other",
	audio: "other",
	video: "other",
	transcribe: "other",
	moderation: "other",
};

const LITELLM_MODES: Record<string, Kind> = {
	chat: "chat",
	completion: "chat",
	responses: "chat",
	embedding: "embedding",
	image_generation: "other",
	image_edit: "other",
	audio_transcription: "other",
	audio_speech: "other",
	rerank: "other",
	moderation: "other",
	moderations: "other",
	video_generation: "other",
};

function lifecycleOf(row: Row): Lifecycle | undefined {
	const raw = isObj(row.lifecycle) ? first(str(row.lifecycle.status), str(row.lifecycle.state)) : str(row.lifecycle);
	const v = raw?.toLowerCase();
	return v === "active" || v === "deprecated" || v === "retired" ? v : undefined;
}

function pricingOf(row: Row): Pricing | undefined {
	// OpenRouter: USD per token, as strings. Negative means "varies" (auto routers).
	if (isObj(row.pricing) && ("prompt" in row.pricing || "completion" in row.pricing)) {
		const i = price(row.pricing.prompt);
		const o = price(row.pricing.completion);
		return i !== undefined && o !== undefined ? { inputPerMTok: perMTok(i), outputPerMTok: perMTok(o) } : undefined;
	}
	// Together: USD per million tokens.
	if (isObj(row.pricing) && ("input" in row.pricing || "output" in row.pricing)) {
		const i = price(row.pricing.input);
		const o = price(row.pricing.output);
		return i !== undefined && o !== undefined ? { inputPerMTok: i, outputPerMTok: o } : undefined;
	}
	// LiteLLM model_info: USD per token.
	const i = price(row.input_cost_per_token);
	const o = price(row.output_cost_per_token);
	return i !== undefined && o !== undefined ? { inputPerMTok: perMTok(i), outputPerMTok: perMTok(o) } : undefined;
}

function kindOf(row: Row, outputs: string[] | undefined, caps: Row): Kind | undefined {
	const type = str(row.type)?.toLowerCase();
	if (type && TOGETHER_KINDS[type]) return TOGETHER_KINDS[type];
	const mode = str(row.mode)?.toLowerCase();
	if (mode && LITELLM_MODES[mode]) return LITELLM_MODES[mode];
	if (outputs?.length) {
		if (outputs.includes("embeddings") || outputs.includes("embedding")) return "embedding";
		return outputs.includes("text") ? "chat" : "other";
	}
	// Mistral: a model that can't chat and isn't an embedding model by id.
	if (caps.completion_chat === false && !EMBEDDING_ID.test(String(row.id ?? ""))) return "other";
	return undefined;
}

/** Strip Gemini's `models/` prefix; the bare id is what chat completions want. */
function cleanId(raw: string, host: string): string {
	if (!raw.startsWith("models/")) return raw;
	if (/(^|\.)googleapis\.com$/i.test(host) || /^models\/(gemini|gemma|text-embedding|embedding|imagen|veo|aqa)/i.test(raw)) {
		return raw.slice("models/".length);
	}
	return raw;
}

/** Everything a row states, by the doc's first-match-wins mapping. */
function extractFacts(row: Row, host: string): Facts | null {
	const rawId = str(row.id) ?? str(row.model_name) ?? str(row.name);
	if (!rawId) return null;
	const id = cleanId(rawId, host);
	if (!MODEL_ID.test(id)) return null;

	const caps = isObj(row.capabilities) ? row.capabilities : {};
	const arch = isObj(row.architecture) ? row.architecture : {};
	const top = isObj(row.top_provider) ? row.top_provider : {};
	const info = isObj(row.model_info) ? row.model_info : {};
	const params = strList(row.supported_parameters);
	const inputs = strList(arch.input_modalities) ?? strList(row.input_modalities);
	const outputs = strList(arch.output_modalities) ?? strList(row.output_modalities);
	const has = (list: string[] | undefined, ...names: string[]) => (list ? names.some((n) => list.includes(n)) : undefined);

	const label = first(str(row.display_name), str(row.name));

	return {
		id,
		label: label && label !== rawId && label !== id ? label.slice(0, 200) : undefined,
		kind: kindOf(row, outputs, caps),
		contextTokens: first(
			posInt(row.max_input_tokens),
			posInt(row.context_length),
			posInt(row.context_window),
			posInt(row.max_context_length),
			posInt(row.max_model_len),
			posInt(info.max_input_tokens),
			posInt(top.context_length),
		),
		maxOutputTokens: first(
			posInt(top.max_completion_tokens),
			posInt(row.max_tokens),
			posInt(row.max_output_tokens),
			posInt(row.max_completion_tokens),
		),
		tools: first(has(params, "tools"), flag(caps.function_calling), flag(row.supports_function_calling), flag(row.supports_tools)),
		json: first(
			flag(caps.structured_outputs),
			has(params, "structured_outputs", "response_format"),
			flag(row.supports_response_schema),
		),
		vision: first(flag(caps.image_input), has(inputs, "image"), flag(caps.vision), flag(row.supports_vision), flag(row.supports_image_input)),
		reasoning: first(flag(caps.thinking), has(params, "reasoning", "include_reasoning"), flag(row.supports_reasoning)),
		lifecycle: lifecycleOf(row),
		pricing: pricingOf(row),
	};
}

const cap = (stated: boolean | undefined, hinted: boolean | undefined): Cap =>
	stated !== undefined ? { value: stated, source: "provider" } : { value: hinted ?? null, source: "hint" };

/** Facts plus hints → a catalogue row. `toolsImplied`: the Anthropic Messages wire. */
function toModel(f: Facts, toolsImplied: boolean): CatalogModel {
	const hint = hintFor(f.id);
	const inferredKind: Kind = EMBEDDING_ID.test(f.id) ? "embedding" : OTHER_ID.test(f.id) ? "other" : "chat";
	const kind = f.kind ?? inferredKind;
	const embed: Cap =
		f.kind !== undefined
			? { value: kind === "embedding", source: "provider" }
			: { value: kind === "embedding", source: "hint" };
	const model: CatalogModel = {
		id: f.id,
		label: f.label ?? f.id,
		kind,
		contextTokens: f.contextTokens ?? hint?.contextTokens ?? null,
		maxOutputTokens: f.maxOutputTokens ?? null,
		caps: {
			tools: toolsImplied && kind === "chat" ? { value: true, source: "provider" } : cap(f.tools, hint?.tools),
			json: cap(f.json, hint?.json),
			vision: cap(f.vision, hint?.vision),
			reasoning: cap(f.reasoning, hint?.reasoning),
			embed,
		},
		tier: hint?.tier ?? null,
	};
	if (f.lifecycle) model.lifecycle = f.lifecycle;
	if (f.pricing) model.pricing = f.pricing;
	return model;
}

/** The row array of any list shape: `{ data }`, `{ models }` or a bare array (Together). */
function rowsOf(json: unknown): Row[] {
	const list = Array.isArray(json) ? json : isObj(json) ? (Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : []) : [];
	return list.filter(isObj);
}

/** True when the body is a model list at all (even an empty one). */
export function isModelList(json: unknown): boolean {
	return Array.isArray(json) || (isObj(json) && (Array.isArray(json.data) || Array.isArray(json.models)));
}

/** Rows a gateway lists but can't serve: Groq `active: false`, Mistral `archived`. */
const dropped = (row: Row) => row.active === false || row.archived === true;

function normaliseRows(rows: Row[], host: string, toolsImplied: boolean): CatalogModel[] {
	const seen = new Set<string>();
	const out: CatalogModel[] = [];
	for (const row of rows) {
		if (out.length >= MAX_CATALOGUE_MODELS) break;
		if (dropped(row)) continue;
		const facts = extractFacts(row, host);
		if (!facts || seen.has(facts.id)) continue;
		seen.add(facts.id);
		const model = toModel(facts, toolsImplied);
		// Image, speech, moderation and rerank models can't serve any role.
		if (model.kind === "other") continue;
		// Mistral lists every alias as its own row too: keep the first, skip the rest.
		for (const alias of Array.isArray(row.aliases) ? row.aliases : []) if (typeof alias === "string") seen.add(alias);
		out.push(model);
	}
	return out;
}

/**
 * An OpenAI-shape `GET /models` body (OpenAI, OpenRouter, LiteLLM, Groq,
 * Mistral, Together, Fireworks, DeepSeek, Gemini, Azure, Ollama, vLLM,
 * Bedrock) → catalogue rows. `host` is the gateway's hostname.
 */
export function normaliseOpenAiList(json: unknown, opts: { host: string; wire: "openai" }): CatalogModel[] {
	return normaliseRows(rowsOf(json), opts.host.toLowerCase(), false);
}

/**
 * One page of Anthropic `GET /v1/models`. Every Messages model calls tools,
 * so `tools` is provider-true; minimal proxies that send `{ id,
 * display_name, type }` get the other caps from hints.
 */
export function normaliseAnthropicPage(json: unknown): { models: CatalogModel[]; hasMore: boolean; lastId: string | null } {
	const rows = rowsOf(json);
	const models = normaliseRows(rows, "", true);
	const body = isObj(json) ? json : {};
	const lastRow = rows.length ? str(rows[rows.length - 1]!.id) : undefined;
	return {
		models,
		hasMore: body.has_more === true,
		lastId: str(body.last_id) ?? lastRow ?? null,
	};
}

/**
 * Overlay LiteLLM's `/model/info` (`data: [{ model_name, model_info }]`) on
 * rows from its `/v1/models`. Stated fields replace hints; models the info
 * doesn't mention are unchanged. Returns new rows.
 */
export function mergeLiteLlmInfo(models: CatalogModel[], infoJson: unknown): CatalogModel[] {
	const facts = new Map<string, Facts>();
	for (const row of rowsOf(infoJson)) {
		const name = str(row.model_name);
		if (!name || facts.has(name) || !isObj(row.model_info)) continue;
		const f = extractFacts({ ...row.model_info, id: name }, "");
		if (f) facts.set(name, f);
	}
	return models.map((m) => {
		const f = facts.get(m.id);
		if (!f) return m;
		const merged: Facts = {
			id: m.id,
			label: m.label !== m.id ? m.label : undefined,
			kind: f.kind,
			// A context the list stated (not one copied from the hints table) survives.
			contextTokens:
				f.contextTokens ??
				(m.contextTokens !== null && m.contextTokens !== hintFor(m.id)?.contextTokens ? m.contextTokens : undefined),
			maxOutputTokens: f.maxOutputTokens ?? m.maxOutputTokens ?? undefined,
			tools: f.tools ?? stated(m.caps.tools),
			json: f.json ?? stated(m.caps.json),
			vision: f.vision ?? stated(m.caps.vision),
			reasoning: f.reasoning ?? stated(m.caps.reasoning),
			lifecycle: f.lifecycle ?? m.lifecycle,
			pricing: f.pricing ?? m.pricing ?? undefined,
		};
		if (merged.kind === undefined && m.caps.embed.source === "provider") merged.kind = m.kind;
		return toModel(merged, false);
	});
}

const stated = (c: Cap): boolean | undefined => (c.source === "provider" && c.value !== null ? c.value : undefined);
