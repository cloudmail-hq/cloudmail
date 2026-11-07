// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The built-in provider, Cloudflare Workers AI: its default model per role,
 * its catalogue (normalised from Cloudflare's model search), the rules for
 * picking a model per role, and the successor hint for unlisted models.
 *
 * Pure, so the settings page shows the verdict the API enforces.
 *
 * ## Capabilities
 *
 * Cloudflare's model search lists `function_calling`, `reasoning`, `vision`,
 * `context_window`, `price` and, for some embedding models,
 * `output_dimensions`. It does not list JSON mode. Workers AI's JSON mode docs
 * name the models that support `response_format`
 * (https://developers.cloudflare.com/workers-ai/json-mode/); in practice the
 * function-calling models accept it too, which is why triage has always run on
 * Llama 4 Scout. So JSON is "provider" for the documented models, "hint" for
 * function-calling models, and unknown otherwise: a hint never unlocks
 * triage, Test does.
 *
 * ## Embeddings
 *
 * The Vectorize index is created with 1024 dimensions (bge-m3). A model whose
 * vectors are any other size can't be queried against it at all, so only
 * models known to return 1024 dimensions may serve `embeddings`: listed with
 * `output_dimensions: 1024`, in `EMBEDDING_DIMS_KNOWN`, or measured by Test.
 * Even a same-size model maps text to a different space, so changing it also
 * needs a confirmation, and each mailbox re-indexes (see
 * workers/durableObject/semantic.ts `reconcileEmbeddingModel`).
 */

import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "./semantic";
import { ROLE_NEEDS, type GateResult } from "./ai-gateway";
import { WORKERS_AI_MODEL_ID, type AiRole, type WorkersAiTested } from "./ai-providers";

// ── Defaults ───────────────────────────────────────────────────────

/** The model the email agent drafts with (workers/agent). */
export const AGENT_MODEL = "@cf/moonshotai/kimi-k2.5";
/** Small, fast model for thread summaries. `SUMMARY_MODEL` in the environment overrides it. */
export const SUMMARY_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
/**
 * The scanner's model. Same model and size as the `-fast` alias it once
 * named, which Workers AI dropped from its catalogue (calling it threw, and
 * the scanner fails closed, so auto-draft was skipped for every message).
 */
export const INJECTION_SCANNER_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
/** Yes/no needs no more than the scanner's model; keeps a reminder on every send cheap. */
export const EXPECTS_REPLY_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
/** Llama 4 Scout accepts `response_format`; the triage answer is a handful of enum values. */
export const TRIAGE_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
/** The draft verifier's model. */
export const VERIFIER_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

/** The model each role uses on Workers AI when the admin picked none. */
export const WORKERS_AI_DEFAULTS: Readonly<Record<AiRole, string>> = {
	agent_chat: AGENT_MODEL,
	auto_draft: AGENT_MODEL,
	nudge: AGENT_MODEL,
	summary: SUMMARY_MODEL,
	triage: TRIAGE_MODEL,
	followup_classifier: EXPECTS_REPLY_MODEL,
	injection_scanner: INJECTION_SCANNER_MODEL,
	draft_verifier: VERIFIER_MODEL,
	embeddings: EMBEDDING_MODEL,
	ask_answer: AGENT_MODEL,
	daily_brief: AGENT_MODEL,
};

// ── Catalogue ──────────────────────────────────────────────────────

export const WORKERS_AI_TASKS = ["Text Generation", "Text Embeddings"] as const;
export type WorkersAiTask = (typeof WORKERS_AI_TASKS)[number];

export type WaiCapSource = "provider" | "hint" | "probe";
export interface WaiCap {
	value: boolean | null;
	source: WaiCapSource;
}

/** One Workers AI model, as the settings page and the gate see it. */
export interface WorkersAiModel {
	id: string;
	task: WorkersAiTask;
	description?: string;
	contextTokens: number | null;
	tools: WaiCap;
	json: WaiCap;
	reasoning: boolean;
	vision: boolean;
	/** Embedding vector size, when known. */
	dims: number | null;
	/** USD per million tokens. Output is null for embedding models. */
	price: { input: number | null; output: number | null } | null;
	beta: boolean;
	lora: boolean;
	/** Needs the Workers Paid plan. */
	paid: boolean;
	/** The catalogue marks it deprecated, or with a planned end date. */
	deprecated: boolean;
}

/** Where a catalogue came from. `fallback`: the search failed; the list is the small built-in one. */
export type CatalogueSource = "live" | "fallback";

export interface WorkersAiCatalogue {
	source: CatalogueSource;
	fetchedAt: string;
	models: WorkersAiModel[];
	/** Short reason the live catalogue was not used. Never a token or response body. */
	detail?: string;
}

/** Models documented as supporting JSON mode (`response_format`). */
export const JSON_MODE_DOCUMENTED = new Set([
	"@cf/meta/llama-3.3-70b-instruct-fp8-fast",
	"@cf/meta/llama-3-8b-instruct",
	"@cf/meta/llama-3.1-8b-instruct",
	"@hf/nousresearch/hermes-2-pro-mistral-7b",
	"@hf/thebloke/deepseek-coder-6.7b-instruct-awq",
	"@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
	// In production since triage shipped: `response_format` with a JSON schema.
	TRIAGE_MODEL,
]);

/** Embedding sizes from the model cards, for models the catalogue lists without `output_dimensions`. */
export const EMBEDDING_DIMS_KNOWN: Readonly<Record<string, number>> = {
	"@cf/baai/bge-m3": 1024,
	"@cf/baai/bge-large-en-v1.5": 1024,
	"@cf/baai/bge-base-en-v1.5": 768,
	"@cf/baai/bge-small-en-v1.5": 384,
	"@cf/google/embeddinggemma-300m": 768,
	"@cf/qwen/qwen3-embedding-0.6b": 1024,
	"@cf/pfnet/plamo-embedding-1b": 2048,
};

type RawProperty = { property_id?: unknown; value?: unknown };
type RawModel = { name?: unknown; description?: unknown; task?: { name?: unknown } | null; properties?: unknown };

function truthy(v: unknown): boolean {
	return v === true || v === "true";
}

function positiveInt(v: unknown): number | null {
	const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
	return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function priceOf(v: unknown): WorkersAiModel["price"] {
	if (!Array.isArray(v)) return null;
	let input: number | null = null;
	let output: number | null = null;
	for (const p of v as { unit?: unknown; price?: unknown }[]) {
		const unit = typeof p?.unit === "string" ? p.unit.toLowerCase() : "";
		const price = typeof p?.price === "number" && Number.isFinite(p.price) ? p.price : null;
		if (price === null || unit.includes("cached")) continue;
		if (unit.includes("input")) input = price;
		else if (unit.includes("output")) output = price;
	}
	return input === null && output === null ? null : { input, output };
}

/**
 * One row of Cloudflare's model search, normalised. Null for tasks the app
 * never uses (images, speech, translation…) and for ids that don't look like
 * Workers AI ids.
 */
export function normaliseCatalogueModel(raw: unknown): WorkersAiModel | null {
	const r = raw as RawModel | null;
	const id = typeof r?.name === "string" ? r.name : "";
	const task = typeof r?.task?.name === "string" ? r.task.name : "";
	if (!WORKERS_AI_MODEL_ID.test(id)) return null;
	if (!(WORKERS_AI_TASKS as readonly string[]).includes(task)) return null;
	const props = new Map<string, unknown>();
	for (const p of Array.isArray(r?.properties) ? (r!.properties as RawProperty[]) : []) {
		if (typeof p?.property_id === "string") props.set(p.property_id, p.value);
	}
	const embedding = task === "Text Embeddings";
	const fc = truthy(props.get("function_calling"));
	const deprecation = props.get("planned_deprecation_date") ?? props.get("deprecation_date") ?? props.get("deprecated");
	return {
		id,
		task: task as WorkersAiTask,
		description: typeof r?.description === "string" ? r.description.slice(0, 300) : undefined,
		contextTokens: positiveInt(props.get("context_window")) ?? positiveInt(props.get("max_input_tokens")),
		tools: embedding ? { value: false, source: "provider" } : fc ? { value: true, source: "provider" } : { value: false, source: "provider" },
		json: embedding
			? { value: false, source: "provider" }
			: JSON_MODE_DOCUMENTED.has(id)
				? { value: true, source: "provider" }
				: fc
					? { value: true, source: "hint" }
					: { value: null, source: "hint" },
		reasoning: truthy(props.get("reasoning")),
		vision: truthy(props.get("vision")),
		dims: embedding ? (positiveInt(props.get("output_dimensions")) ?? EMBEDDING_DIMS_KNOWN[id] ?? null) : null,
		price: priceOf(props.get("price")),
		beta: truthy(props.get("beta")),
		lora: truthy(props.get("lora")),
		paid: truthy(props.get("require_workers_paid")),
		deprecated: deprecation !== undefined && deprecation !== null && deprecation !== false && deprecation !== "false",
	};
}

/** Normalise a whole result list: drops unusable rows and duplicates, sorts by id. */
export function normaliseCatalogue(rows: unknown[]): WorkersAiModel[] {
	const byId = new Map<string, WorkersAiModel>();
	for (const row of rows) {
		const m = normaliseCatalogueModel(row);
		if (m && !byId.has(m.id)) byId.set(m.id, m);
	}
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const p = (id: string, over: Partial<WorkersAiModel> & Pick<WorkersAiModel, "task">): WorkersAiModel => ({
	id,
	contextTokens: null,
	tools: { value: false, source: "provider" },
	json: { value: null, source: "hint" },
	reasoning: false,
	vision: false,
	dims: null,
	price: null,
	beta: false,
	lora: false,
	paid: false,
	deprecated: false,
	...over,
});

/**
 * Used when the catalogue can't be read (no token, missing "Workers AI Read"
 * permission, an outage): today's defaults and their listed successors, from
 * the catalogue as of Oct 2026. Every default is in it, so the page never
 * flags a default as unlisted just because the search failed.
 */
export const FALLBACK_CATALOGUE: readonly WorkersAiModel[] = [
	p("@cf/baai/bge-m3", { task: "Text Embeddings", contextTokens: 60_000, dims: 1024, tools: { value: false, source: "provider" }, json: { value: false, source: "provider" } }),
	p("@cf/baai/bge-large-en-v1.5", { task: "Text Embeddings", contextTokens: 512, dims: 1024, tools: { value: false, source: "provider" }, json: { value: false, source: "provider" } }),
	p("@cf/meta/llama-3.1-8b-instruct-fp8", { task: "Text Generation", contextTokens: 32_000 }),
	p("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { task: "Text Generation", contextTokens: 24_000, tools: { value: true, source: "provider" }, json: { value: true, source: "provider" } }),
	p("@cf/meta/llama-4-scout-17b-16e-instruct", { task: "Text Generation", contextTokens: 131_000, tools: { value: true, source: "provider" }, json: { value: true, source: "provider" }, vision: true }),
	p("@cf/moonshotai/kimi-k2.5", { task: "Text Generation", contextTokens: 262_144, tools: { value: true, source: "provider" }, json: { value: true, source: "hint" }, reasoning: true, paid: true }),
	p("@cf/moonshotai/kimi-k2.6", { task: "Text Generation", contextTokens: 262_144, tools: { value: true, source: "provider" }, json: { value: true, source: "hint" }, reasoning: true, vision: true, paid: true }),
	p("@cf/openai/gpt-oss-120b", { task: "Text Generation", contextTokens: 128_000, tools: { value: true, source: "provider" }, json: { value: true, source: "hint" }, reasoning: true }),
];

/** A catalogue's models for one role: embeddings get Text Embeddings, everything else Text Generation. */
export function modelsForRole(models: readonly WorkersAiModel[], role: AiRole): WorkersAiModel[] {
	const task: WorkersAiTask = role === "embeddings" ? "Text Embeddings" : "Text Generation";
	return models.filter((m) => m.task === task);
}

export function filterByTask(models: readonly WorkersAiModel[], task: WorkersAiTask | null | undefined): WorkersAiModel[] {
	return task ? models.filter((m) => m.task === task) : [...models];
}

/** Fold Test results into a catalogue entry: a tested capability beats a hint. */
export function withTested(model: WorkersAiModel, tested: WorkersAiTested | undefined): WorkersAiModel {
	if (!tested) return model;
	const out = { ...model };
	if (tested.tools !== undefined) out.tools = { value: tested.tools, source: "probe" };
	if (tested.json !== undefined) out.json = { value: tested.json, source: "probe" };
	if (tested.dims !== undefined && model.task === "Text Embeddings") out.dims = tested.dims;
	return out;
}

/**
 * A custom id that is not in the catalogue: the task from the id, every
 * capability unknown until Test says otherwise. Defaults keep what is known
 * from the fallback list.
 */
export function unlistedModel(id: string, role: AiRole, tested?: WorkersAiTested): WorkersAiModel {
	const known = FALLBACK_CATALOGUE.find((m) => m.id === id);
	const base =
		known ??
		p(id, {
			task: role === "embeddings" || /embed|bge-/i.test(id) ? "Text Embeddings" : "Text Generation",
			tools: { value: null, source: "hint" },
			dims: EMBEDDING_DIMS_KNOWN[id] ?? null,
		});
	return withTested(base, tested);
}

// ── The gate ───────────────────────────────────────────────────────

export interface WorkersAiPickContext {
	/** The model as the catalogue (or `unlistedModel`) describes it. */
	model: WorkersAiModel;
	/** The model the role uses now, for the embeddings change rule. */
	current: string;
	/** The admin confirmed the embeddings re-index. */
	confirmReindex?: boolean;
}

/**
 * Whether `model` may serve `role` on Workers AI. Same rules as gateways
 * (`checkRoleModel`): tool roles need verified function calling, triage needs
 * verified JSON (a hint is not enough), embeddings needs an embedding model of
 * the index's size. Plus: the scanner is locked, and changing the embeddings
 * model needs `confirmReindex`.
 */
export function checkWorkersAiPick(role: AiRole, ctx: WorkersAiPickContext): GateResult {
	const { model } = ctx;
	if (role === "injection_scanner") {
		return { ok: false, reason: "The prompt-injection scanner's model is fixed: it is the security gate, so it isn't configurable." };
	}
	if (!WORKERS_AI_MODEL_ID.test(model.id)) return { ok: false, reason: "Workers AI model ids start with @cf/ or @hf/." };
	const need = ROLE_NEEDS[role];
	if (need === "embed") {
		if (model.task !== "Text Embeddings") return { ok: false, reason: "Not an embedding model." };
		if (model.dims == null) return { ok: false, reason: `Its vector size isn't known. Run Test to check it is ${EMBEDDING_DIMENSIONS}.` };
		if (model.dims !== EMBEDDING_DIMENSIONS) {
			return { ok: false, reason: `Returns ${model.dims}-dimension vectors; the search index needs ${EMBEDDING_DIMENSIONS}.` };
		}
		if (model.id !== ctx.current && !ctx.confirmReindex) {
			return { ok: false, reason: "Changing the embeddings model re-indexes every mailbox. Confirm to continue." };
		}
		return { ok: true };
	}
	if (model.task !== "Text Generation") return { ok: false, reason: "Not a text generation model." };
	if (need === "tools") {
		if (model.tools.value === false) return { ok: false, reason: "This model can't call tools." };
		if (model.tools.value !== true || model.tools.source === "hint") {
			return { ok: false, reason: "Tool calling isn't verified. Run Test first." };
		}
	}
	if (need === "json") {
		if (model.json.value === false) return { ok: false, reason: "This model doesn't support JSON mode." };
		if (model.json.value !== true || model.json.source === "hint") {
			return { ok: false, reason: "JSON mode isn't verified for this model. Run Test first." };
		}
	}
	return { ok: true };
}

/** True when the reason is only the missing re-index confirmation. */
export function needsReindexConfirm(result: GateResult): boolean {
	return !result.ok && result.reason.startsWith("Changing the embeddings model");
}

// ── Unlisted models and successors ─────────────────────────────────

/** Version numbers in an id, for "closest newer sibling". */
function versionTuple(id: string): number[] {
	// Release, not size: llama-3.1-8b is version 3.1, never 8.
	const name = id.slice(id.lastIndexOf("/") + 1).replace(/-(fp8|fp16|awq|int8)(-fast)?$/i, "");
	const m = /^[a-z][a-z-]*?(\d+(?:\.\d+)*)/i.exec(name);
	return m ? m[1]!.split(".").map(Number) : [];
}

function compareVersions(a: number[], b: number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

/** `@cf/moonshotai/kimi-k2.5` → `@cf/moonshotai/kimi-k`: vendor and family, version and suffixes dropped. */
function familyOf(id: string): string {
	const slash = id.lastIndexOf("/");
	const vendor = id.slice(0, slash + 1);
	const name = id.slice(slash + 1).toLowerCase();
	const family = /^([a-z][a-z-]*?)(?=\d)/.exec(name)?.[1] ?? name.split("-")[0]!;
	return vendor.toLowerCase() + family;
}

/**
 * The listed model to suggest in place of an unlisted one: same vendor and
 * family, same task, the lowest version above it (kimi-k2.5 → kimi-k2.6,
 * not k2.7-code), preferring a name without extra suffixes. Null when there
 * is no such sibling. Never applied automatically.
 */
export function suggestSuccessor(id: string, catalogue: readonly WorkersAiModel[], task?: WorkersAiTask): WorkersAiModel | null {
	const family = familyOf(id);
	const v = versionTuple(id);
	const candidates = catalogue.filter(
		(m) =>
			m.id !== id &&
			familyOf(m.id) === family &&
			(!task || m.task === task) &&
			compareVersions(versionTuple(m.id), v) > 0,
	);
	if (candidates.length === 0) return null;
	const suffixes = (x: string) => x.slice(x.lastIndexOf("/") + 1).split("-").length;
	candidates.sort(
		(a, b) => compareVersions(versionTuple(a.id), versionTuple(b.id)) || suffixes(a.id) - suffixes(b.id) || a.id.localeCompare(b.id),
	);
	return candidates[0]!;
}

/** The warning chip for a role's model, or null when it is listed (or the catalogue is the fallback). */
export function unlistedWarning(
	id: string,
	catalogue: Pick<WorkersAiCatalogue, "source" | "models">,
	task?: WorkersAiTask,
): { successor: string | null } | null {
	// The fallback list is short by design; it says nothing about retirement.
	if (catalogue.source !== "live") return null;
	if (catalogue.models.some((m) => m.id === id && !m.deprecated)) return null;
	return { successor: suggestSuccessor(id, catalogue.models, task)?.id ?? null };
}

export const UNLISTED_NOTE = "Not in Cloudflare's current catalogue — may be retired.";

// ── Badges ─────────────────────────────────────────────────────────

/** "262K", "1M", "32K". */
export function contextLabel(tokens: number | null): string | null {
	if (!tokens) return null;
	if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
	return String(tokens);
}

/** "$0.95 / $4 per M", "$0.012 per M in", or null. */
export function priceLabel(price: WorkersAiModel["price"]): string | null {
	if (!price) return null;
	const fmt = (n: number) => `$${n < 0.1 ? +n.toPrecision(2) : +n.toFixed(2)}`;
	if (price.input !== null && price.output !== null) return `${fmt(price.input)} / ${fmt(price.output)} per M`;
	if (price.input !== null) return `${fmt(price.input)} per M in`;
	if (price.output !== null) return `${fmt(price.output)} per M out`;
	return null;
}
