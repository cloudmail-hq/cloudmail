// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The one place the app chooses and calls an AI model.
 *
 * Every call site names a role (`AI_ROLES` in shared/ai-providers.ts) and gets
 * a `ResolvedModel` from `resolveModel(env, role)`, or from an `AiHandle`
 * (`aiFor(env, { feature })`) that carries the usage feature for a group of
 * calls. Nothing outside this file calls `env.AI.run`, builds an AI SDK model,
 * or counts a call for the Usage tab; test/ai-router-static.test.ts enforces
 * that.
 *
 * ## Call styles
 *
 * - `text({ system, user, maxTokens, temperature })`: one completion, text out.
 * - `json({ system, user, schema, ... })`: one completion held to a JSON
 *   schema; returns the parsed object, or the text when the model gave text.
 * - `embed(texts)`: one vector per input.
 * - `streamText(...)` / `generateText(...)`: the AI SDK calls with tools, with
 *   the role's model and timeout filled in. For the agent panel, auto-draft
 *   and the follow-up nudge.
 *
 * ## Backends
 *
 * Workers AI (the built-in provider, used whenever no gateway is active): text, JSON
 * and embeddings go to `env.AI.run` with exactly the request bodies each call
 * site sent before the router existed, so model, prompt, `max_tokens`,
 * `temperature` and `response_format` are unchanged byte for byte. Chat with
 * tools goes through `createAI` (agents/models/ai-sdk), as since PR A. The
 * model per role is the admin's pick from Settings → AI providers
 * (`workersAi.models`), else `SUMMARY_MODEL` for summaries, else the default
 * (`workersAiModelFor`).
 *
 * Gateway: when R2 `ai/providers.json` routes a role to a provider, the
 * provider factory builds AI SDK models and every style runs through
 * `generateText` / `streamText` / `embedMany`. No factory ships in this
 * release (the Anthropic and OpenAI-compatible factories come with the
 * settings UI), so a config naming a provider resolves back to Workers AI
 * with `reason: "unsupported-provider"`. Tests inject a factory.
 *
 * ## Safety rails
 *
 * - `injection_scanner` is pinned to Workers AI in every configuration
 *   (`WORKERS_AI_PINNED_ROLES`). The scanner fails closed; a gateway outage
 *   must not block every auto-draft and held send.
 * - Per-role timeouts (`ROLE_TIMEOUTS`). A timeout is an error to the caller,
 *   which already handles errors (fail closed, retry later, or no labels).
 * - A per-provider circuit breaker (./ai-breaker.ts) on gateway calls.
 * - Usage metering: each model request is counted once, under the handle's
 *   feature or the role's default feature, here and nowhere else.
 * - Optional fallback to Workers AI after a failed gateway call, off unless
 *   the config turns it on.
 */

import {
	embedMany,
	generateText as sdkGenerateText,
	jsonSchema,
	NoObjectGeneratedError,
	Output,
	streamText as sdkStreamText,
	wrapLanguageModel,
	type EmbeddingModel,
	type LanguageModelMiddleware,
	type ToolSet,
} from "ai";
import { createAI } from "agents/models/ai-sdk";
import {
	WORKERS_AI_PINNED_ROLES,
	WORKERS_AI_PROVIDER_ID,
	type AiProvider,
	type AiProvidersFile,
	type AiRole,
} from "../../shared/ai-providers";
import { WORKERS_AI_DEFAULTS } from "../../shared/workers-ai";
import type { AiFeature } from "../../shared/usage";
import { devMockAi } from "./ai-dev-mock";
import { getAiProvidersFile } from "./ai-providers-store";
import { AiCircuitOpenError, aiBreaker, r2BreakerFlags, type BreakerFlagStore, type CircuitBreaker } from "./ai-breaker";
import {
	aiCallRecorder,
	costFromPricing,
	meteredAi,
	recordUsageEntry,
	usageDay,
	type AiCallRecorder,
} from "./ai-usage";
import { checkRoleModel, effectiveModelId } from "../../shared/ai-gateway";
import { providerModels } from "../../shared/ai-providers";

export { AI_ROLES, type AiRole } from "../../shared/ai-providers";

// ── Workers AI models, per role ────────────────────────────────────

// The defaults live in shared/workers-ai.ts so the settings page shows them.
export {
	AGENT_MODEL,
	EXPECTS_REPLY_MODEL,
	INJECTION_SCANNER_MODEL,
	SUMMARY_MODEL,
	TRIAGE_MODEL,
	VERIFIER_MODEL,
	WORKERS_AI_DEFAULTS,
} from "../../shared/workers-ai";

/** The Usage-tab feature a role counts under when the caller names none. */
export const ROLE_FEATURES: Readonly<Record<AiRole, AiFeature>> = {
	agent_chat: "agent",
	auto_draft: "agent",
	nudge: "agent",
	summary: "summaries",
	triage: "triage",
	followup_classifier: "followups",
	injection_scanner: "safety",
	draft_verifier: "verifier",
	embeddings: "semantic",
	ask_answer: "semantic",
	daily_brief: "agent",
};

// ── Timeouts ───────────────────────────────────────────────────────

/**
 * Per-call timeouts. A number is the whole call; the agent panel streams, so
 * it gets an idle timeout between chunks instead of a total.
 */
export const ROLE_TIMEOUTS = {
	injection_scanner: 15_000,
	followup_classifier: 15_000,
	triage: 15_000,
	summary: 25_000,
	draft_verifier: 30_000,
	embeddings: 15_000,
	ask_answer: 45_000,
	daily_brief: 30_000,
	nudge: 60_000,
	/** Per step: auto-draft runs up to five tool steps. */
	auto_draft: { stepMs: 45_000 },
	/** Streaming: the first chunk may wait on tool planning; after that, no chunk for 30 s is a stall. */
	agent_chat: { firstChunkMs: 45_000, chunkMs: 30_000 },
} as const satisfies Record<AiRole, number | { stepMs?: number; firstChunkMs?: number; chunkMs?: number }>;

export class AiTimeoutError extends Error {
	constructor(
		readonly role: AiRole,
		readonly ms: number,
	) {
		super(`AI call for ${role} timed out after ${ms} ms`);
		this.name = "AiTimeoutError";
	}
}

/** Race a call against the role's timeout. The timer never outlives the call. */
export async function withTimeout<T>(role: AiRole, ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new AiTimeoutError(role, ms));
		}, ms);
	});
	const call = run(controller.signal);
	// `env.AI.run` takes no signal, so a timed-out call keeps running; its
	// eventual rejection is swallowed here rather than surfacing unhandled.
	call.catch(() => {});
	try {
		return await Promise.race([call, expired]);
	} finally {
		clearTimeout(timer);
	}
}

function totalTimeoutMs(role: AiRole): number {
	const t = ROLE_TIMEOUTS[role];
	return typeof t === "number" ? t : 60_000;
}

/** The role's AI SDK `timeout`, scaled by a gateway's `timeoutScale`. */
function scaledTimeout(role: AiRole, scale: number) {
	const t = ROLE_TIMEOUTS[role];
	if (typeof t === "number") return Math.round(t * scale);
	return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Math.round(v * scale)]));
}

// ── Types ──────────────────────────────────────────────────────────

/** An AI SDK v4-spec language model (what `wrapLanguageModel` returns). */
export type LanguageModelV4 = ReturnType<typeof wrapLanguageModel>;
export type EmbeddingModelV4 = Exclude<EmbeddingModel, string>;

/** What the router reads from the environment. Loose so tests can pass partial envs. */
export interface RouterEnv {
	AI?: Ai;
	AUTH_STORE?: unknown;
	BUCKET?: unknown;
	SUMMARY_MODEL?: string;
	LOCAL_AI_MOCK?: string;
}

/**
 * Builds AI SDK models for a configured gateway provider. The shipped one is
 * `gatewayFactory` (./ai-gateway-factory.ts); tests inject fakes.
 */
export interface ProviderFactory {
	languageModel(provider: AiProvider, modelId: string): LanguageModelV4;
	embeddingModel?(provider: AiProvider, modelId: string): EmbeddingModelV4;
	/** Redact secrets from error text before it is logged. */
	redact?(text: string): string;
}

/**
 * Builds the factory for one provider, per resolution (the token is
 * decrypted here and lives only as long as the returned closures). The
 * default is the real Anthropic / OpenAI-compatible clients.
 */
export type ProviderFactoryLoader = (env: RouterEnv, provider: AiProvider) => Promise<ProviderFactory>;

/** A role the admin switched off (or that cannot run) while a gateway is active. */
export class AiRoleDisabledError extends Error {
	constructor(
		readonly role: AiRole,
		readonly why: string,
	) {
		super(`AI ${role} is unavailable: ${why}`);
		this.name = "AiRoleDisabledError";
	}
}

export interface ResolveOptions {
	/** Usage feature to count under; the role's default otherwise. */
	feature?: AiFeature;
	/**
	 * Workers AI model for this call, above the admin's pick. For Test, which
	 * must call exactly the model it names.
	 */
	workersAiModel?: string | null;
	/**
	 * Workers AI model below the admin's pick: the deployment's `SUMMARY_MODEL`
	 * as a caller passes it. Ignored when the admin picked a model for the role.
	 */
	workersAiFallbackModel?: string | null;
	mailboxId?: string;
	/** Tests: gateway model builders, bypassing the loader (and its token decryption). */
	factory?: ProviderFactory | null;
	/** Builds the factory for the active provider. Defaults to the real clients (`setDefaultFactoryLoader`). */
	loadFactory?: ProviderFactoryLoader | null;
	/** Tests: the usage counter (null for none). Defaults to the AuthDO. */
	recorder?: AiCallRecorder | null;
	/** Tests: the config, bypassing R2. `null` means "no file". */
	config?: AiProvidersFile | null;
	/** Tests: the breaker and its shared flag. */
	breaker?: CircuitBreaker;
	flags?: BreakerFlagStore | null;
	now?: () => number;
}

export interface TextRequest {
	system: string;
	user: string;
	maxTokens: number;
	temperature?: number;
	/**
	 * `"none"` asks a reasoning model to skip reasoning. On Workers AI this is
	 * `reasoning_effort: "none"`, retried once without it when the model
	 * rejects the parameter.
	 */
	reasoning?: "none";
}

export interface JsonRequest extends TextRequest {
	/** JSON Schema the answer must follow. */
	schema: Record<string, unknown>;
}

export type ResolveReason =
	/** No config, or the config does not route this role. */
	| "default"
	/** The config routes this role to a gateway. */
	| "config"
	/** The role never leaves Workers AI (the injection scanner). */
	| "pinned"
	/** The admin listed the role in `workersAiExceptions`. */
	| "exception"
	/** The config names a provider this build cannot construct. */
	| "unsupported-provider"
	/** The config names a provider that does not exist or is disabled. */
	| "missing-provider"
	/** A gateway is active, but this role has no usable model there, or the admin turned it off. */
	| "disabled";

export interface ResolvedModel {
	role: AiRole;
	/**
	 * `disabled`: a gateway is active and this role cannot run (no usable
	 * model, or the admin turned it off). Every call rejects with
	 * `AiRoleDisabledError`; nothing is sent anywhere.
	 */
	kind: "workers-ai" | "gateway" | "disabled";
	providerId: string;
	modelId: string;
	reason: ResolveReason;
	/** True when this is the Workers AI fallback for an unusable gateway role (not the configured route). */
	fallback?: boolean;
	feature: AiFeature;
	text(req: TextRequest): Promise<string | null>;
	json(req: JsonRequest): Promise<unknown>;
	embed(texts: string[]): Promise<number[][]>;
	/** The AI SDK model, for calls with tools. */
	languageModel(): LanguageModelV4;
	streamText<TOOLS extends ToolSet = ToolSet>(
		params: Omit<Parameters<typeof sdkStreamText<TOOLS>>[0], "model">,
	): ReturnType<typeof sdkStreamText<TOOLS>>;
	generateText<TOOLS extends ToolSet = ToolSet>(
		params: Omit<Parameters<typeof sdkGenerateText<TOOLS>>[0], "model">,
	): ReturnType<typeof sdkGenerateText<TOOLS>>;
}

// ── Workers AI response parsing ────────────────────────────────────

/** Text out of either Workers AI response shape (`{response}` or chat completions). */
export function responseText(result: unknown): string | null {
	if (!result || typeof result !== "object") return typeof result === "string" ? result : null;
	const r = result as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
	if (typeof r.response === "string") return r.response;
	const content = r.choices?.[0]?.message?.content;
	return typeof content === "string" ? content : null;
}

/**
 * The model's answer in JSON mode, which Workers AI may deliver already
 * parsed: an object under `response`, or text in either response shape.
 */
export function responsePayload(result: unknown): unknown {
	if (result && typeof result === "object" && !Array.isArray(result)) {
		const r = (result as { response?: unknown }).response;
		if (r && typeof r === "object" && !Array.isArray(r)) return r;
	}
	return responseText(result);
}

// ── Workers AI backend ─────────────────────────────────────────────

function chatBody(req: TextRequest, extra: Record<string, unknown> = {}) {
	return {
		messages: [
			{ role: "system", content: req.system },
			{ role: "user", content: req.user },
		],
		max_tokens: req.maxTokens,
		temperature: req.temperature ?? 0,
		...extra,
	};
}

/**
 * The Workers AI binding: the offline mock in `vite dev` with
 * `LOCAL_AI_MOCK=1` (./ai-dev-mock.ts), else `env.AI`. The only read of `env.AI`.
 */
function workersAiBinding(env: RouterEnv): Ai | undefined {
	return devMockAi(env) ?? env.AI;
}

function workersAiModel(
	env: RouterEnv,
	role: AiRole,
	modelId: string,
	reason: ResolveReason,
	feature: AiFeature,
	recorder: AiCallRecorder | null | undefined,
	opts: { fallback?: boolean } = {},
): ResolvedModel {
	const raw = workersAiBinding(env);
	// Counted per request, under the feature and the role, like every other backend.
	const binding = raw ? meteredAi(env, feature, raw, { recorder, role, fallback: opts.fallback }) : undefined;
	const run = (input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
		if (!binding) return Promise.reject(new Error("Workers AI binding unavailable"));
		void signal; // `run` takes no signal; the timeout race abandons the call.
		return binding.run(modelId as Parameters<Ai["run"]>[0], input as never);
	};
	const ms = totalTimeoutMs(role);

	const lm = (): LanguageModelV4 => {
		if (!binding) throw new Error("Workers AI binding unavailable");
		// collectLog: prompts are mail; keep them out of the AI Gateway log.
		// skipCache: a reply is never served from the gateway cache.
		return createAI({ binding: binding as Ai, collectLog: false, skipCache: true })(modelId as never);
	};

	return {
		role,
		kind: "workers-ai",
		providerId: WORKERS_AI_PROVIDER_ID,
		modelId,
		reason,
		...(opts.fallback ? { fallback: true } : {}),
		feature,
		async text(req) {
			if (req.reasoning === "none") {
				// As before the router: any error on the first try retries once
				// without the parameter. Both tries share the role's one timeout.
				const started = Date.now();
				let result: unknown;
				try {
					result = await withTimeout(role, ms, (s) => run(chatBody(req, { reasoning_effort: "none" }), s));
				} catch (e) {
					if (e instanceof AiTimeoutError) throw e;
					const left = ms - (Date.now() - started);
					if (left <= 0) throw new AiTimeoutError(role, ms);
					result = await withTimeout(role, left, (s) => run(chatBody(req), s));
				}
				return responseText(result);
			}
			return responseText(await withTimeout(role, ms, (s) => run(chatBody(req), s)));
		},
		async json(req) {
			const result = await withTimeout(role, ms, (s) =>
				run(chatBody(req, { response_format: { type: "json_schema", json_schema: req.schema } }), s),
			);
			return responsePayload(result);
		},
		async embed(texts) {
			if (texts.length === 0) return [];
			const result = (await withTimeout(role, ms, (s) => run({ text: texts, truncate_inputs: true }, s))) as {
				data?: number[][];
				response?: number[][];
			} | null;
			const data = result?.data ?? result?.response;
			if (!Array.isArray(data) || data.length !== texts.length) {
				throw new Error(`embedding returned ${Array.isArray(data) ? data.length : "no"} vectors for ${texts.length} inputs`);
			}
			return data;
		},
		languageModel: lm,
		streamText(params) {
			return sdkStreamText({ timeout: ROLE_TIMEOUTS[role], ...params, model: lm() } as never) as never;
		},
		generateText(params) {
			return sdkGenerateText({ timeout: ROLE_TIMEOUTS[role], ...params, model: lm() } as never) as never;
		},
	};
}

// ── Gateway backend ────────────────────────────────────────────────

function countCall(recorder: AiCallRecorder | null | undefined, feature: AiFeature, now: () => number): Promise<void> {
	if (!recorder) return Promise.resolve();
	try {
		return Promise.resolve(recorder.recordAiCall(feature, usageDay(now()), 1)).catch(() => {});
	} catch {
		return Promise.resolve();
	}
}

/**
 * Pass a model stream through, and give the breaker its verdict when it ends:
 * failure on an `error` part or a thrown read, success on a clean end. A
 * consumer that cancels before any error (the panel closed) gives no verdict,
 * only frees a half-open trial. Pull-based, so backpressure is kept.
 */
export function judgedStream<T>(
	source: ReadableStream<T>,
	providerId: string,
	breaker: CircuitBreaker,
	flags: BreakerFlagStore | null,
	admitted: { trial: boolean },
): ReadableStream<T> {
	const reader = source.getReader();
	let failed: unknown = null;
	let settled = false;
	const settle = (outcome: "end" | "abandoned") => {
		if (settled) return;
		settled = true;
		if (failed) breaker.failure(providerId, failed, flags);
		else if (outcome === "abandoned") breaker.release(providerId, admitted);
		else breaker.success(providerId);
	};
	return new ReadableStream<T>({
		async pull(controller) {
			let next: ReadableStreamReadResult<T>;
			try {
				next = await reader.read();
			} catch (e) {
				failed ??= e;
				settle("end");
				controller.error(e);
				return;
			}
			if (next.done) {
				settle("end");
				controller.close();
				return;
			}
			const part = next.value as { type?: string; error?: unknown };
			// Provider and transport errors arrive as `error` parts.
			if (part?.type === "error") failed ??= part.error ?? new Error("stream error");
			controller.enqueue(next.value);
		},
		async cancel(reason) {
			settle("abandoned");
			await reader.cancel(reason);
		},
	});
}

/**
 * Metering and the breaker for a gateway model, as AI SDK middleware, so a
 * tool loop is counted per model request like Workers AI is. Each request
 * also records a provider/role usage entry with the tokens the gateway
 * reported (null when it reported none) and the cost from published prices.
 */
function gatewayMiddleware(
	providerId: string,
	role: AiRole,
	feature: AiFeature,
	recorder: AiCallRecorder | null | undefined,
	breaker: CircuitBreaker,
	flags: BreakerFlagStore | null,
	now: () => number,
	pricing: { inputPerMTok: number; outputPerMTok: number } | null | undefined,
): LanguageModelMiddleware {
	const entry = (usage: { inputTokens?: { total?: number }; outputTokens?: { total?: number } } | undefined) => {
		const inputTokens = typeof usage?.inputTokens?.total === "number" ? usage.inputTokens.total : null;
		const outputTokens = typeof usage?.outputTokens?.total === "number" ? usage.outputTokens.total : null;
		return recordUsageEntry(recorder, {
			day: usageDay(now()),
			providerId,
			role,
			calls: 1,
			inputTokens,
			outputTokens,
			costUsd: costFromPricing(pricing, inputTokens, outputTokens),
		});
	};
	const guarded = async <T extends { usage?: unknown }>(call: () => PromiseLike<T>): Promise<T> => {
		await breaker.admit(providerId, flags);
		const counted = countCall(recorder, feature, now);
		let out: T | undefined;
		try {
			out = await call();
			breaker.success(providerId);
			return out;
		} catch (e) {
			breaker.failure(providerId, e, flags);
			throw e;
		} finally {
			await counted;
			await entry(out?.usage as never);
		}
	};
	return {
		wrapGenerate: ({ doGenerate }) => guarded(doGenerate),
		// A stream is judged when it ends, not when it starts: a provider that
		// opens streams and then fails mid-way must still trip the breaker.
		wrapStream: async ({ doStream }) => {
			const admitted = await breaker.admit(providerId, flags);
			const counted = countCall(recorder, feature, now);
			let started: Awaited<ReturnType<typeof doStream>>;
			try {
				started = await doStream();
			} catch (e) {
				breaker.failure(providerId, e, flags);
				await counted;
				await entry(undefined);
				throw e;
			}
			await counted;
			// Usage arrives in the stream's `finish` part (with `includeUsage` on
			// OpenAI-compatible gateways); a stream that never finishes counts the call alone.
			let usage: unknown;
			let recorded = false;
			const record = () => {
				if (recorded) return;
				recorded = true;
				void entry(usage as never);
			};
			const tapped = started.stream.pipeThrough(
				new TransformStream({
					transform(part, controller) {
						const p = part as { type?: string; usage?: unknown };
						if (p?.type === "finish") usage = p.usage;
						controller.enqueue(part);
					},
					flush: record,
				}),
			);
			return { ...started, stream: judgedStream(tapped, providerId, breaker, flags, admitted) };
		},
	};
}

/** Log a gateway failure without the request (mail), headers or token. */
function logGatewayFailure(role: AiRole, providerId: string, modelId: string, e: unknown, redact: (t: string) => string, what: string) {
	const err = e as { statusCode?: unknown; name?: unknown; message?: unknown } | null;
	const status = typeof err?.statusCode === "number" ? err.statusCode : null;
	const message = redact(String(err?.message ?? e).split("\n")[0]!.slice(0, 200));
	console.warn(`AI ${role}: gateway ${providerId} (${modelId}) ${what}`, { status, name: String(err?.name ?? "Error"), message });
}

/**
 * The error a caller sees from a gateway call: same class name and status
 * (the breaker and callers branch on them), with the message redacted and
 * the request body, URL, headers and response body gone.
 */
export function safeGatewayError(e: unknown, redact: (t: string) => string): Error {
	if (e instanceof AiTimeoutError || e instanceof AiCircuitOpenError || e instanceof AiRoleDisabledError) return e;
	const err = e as { statusCode?: unknown; name?: unknown; message?: unknown } | null;
	const out = new Error(redact(String(err?.message ?? e).split("\n")[0]!.slice(0, 300)));
	out.name = typeof err?.name === "string" ? err.name : "Error";
	if (typeof err?.statusCode === "number") Object.assign(out, { statusCode: err.statusCode });
	if (NoObjectGeneratedError.isInstance(e)) Object.assign(out, { text: e.text });
	return out;
}

function gatewayModel(
	role: AiRole,
	provider: AiProvider,
	modelId: string,
	factory: ProviderFactory,
	feature: AiFeature,
	ctx: {
		recorder: AiCallRecorder | null | undefined;
		breaker: CircuitBreaker;
		flags: BreakerFlagStore | null;
		now: () => number;
		fallback: ResolvedModel | null;
		pricing?: { inputPerMTok: number; outputPerMTok: number } | null;
	},
): ResolvedModel {
	const ms = Math.round(totalTimeoutMs(role) * (provider.options?.timeoutScale ?? 1));
	const redact = (t: string) => (factory.redact ? factory.redact(t) : t);
	const lm = (): LanguageModelV4 =>
		wrapLanguageModel({
			model: factory.languageModel(provider, modelId),
			middleware: gatewayMiddleware(provider.id, role, feature, ctx.recorder, ctx.breaker, ctx.flags, ctx.now, ctx.pricing),
		});

	/** Run on the gateway; on failure, once on Workers AI when the admin opted in. */
	const withFallback = async <T>(primary: () => Promise<T>, secondary: (m: ResolvedModel) => Promise<T>): Promise<T> => {
		try {
			return await primary();
		} catch (e) {
			if (!ctx.fallback) {
				logGatewayFailure(role, provider.id, modelId, e, redact, "failed");
				throw safeGatewayError(e, redact);
			}
			logGatewayFailure(role, provider.id, modelId, e, redact, "failed, falling back to Workers AI");
			return secondary(ctx.fallback);
		}
	};

	return {
		role,
		kind: "gateway",
		providerId: provider.id,
		modelId,
		reason: "config",
		feature,
		text(req) {
			return withFallback(
				async () => {
					const r = await sdkGenerateText({
						model: lm(),
						instructions: req.system,
						prompt: req.user,
						maxOutputTokens: req.maxTokens,
						temperature: req.temperature ?? 0,
						...(req.reasoning ? { reasoning: req.reasoning } : {}),
						maxRetries: 1,
						timeout: ms,
					});
					return r.text;
				},
				(m) => m.text(req),
			);
		},
		json(req) {
			return withFallback(
				async () => {
					try {
						const r = await sdkGenerateText({
							model: lm(),
							instructions: req.system,
							prompt: req.user,
							maxOutputTokens: req.maxTokens,
							temperature: req.temperature ?? 0,
							output: Output.object({ schema: jsonSchema(req.schema as never) }),
							maxRetries: 1,
							timeout: ms,
						});
						return r.output as unknown;
					} catch (e) {
						// The model answered, but not with schema-valid JSON: hand the text
						// to the callers' tolerant parsers, as Workers AI JSON mode does.
						if (NoObjectGeneratedError.isInstance(e) && typeof e.text === "string") return e.text;
						throw e;
					}
				},
				(m) => m.json(req),
			);
		},
		embed(texts) {
			return withFallback(
				async () => {
					if (texts.length === 0) return [];
					if (!factory.embeddingModel) throw new Error(`provider ${provider.id} has no embedding models`);
					await ctx.breaker.admit(provider.id, ctx.flags);
					const counted = countCall(ctx.recorder, feature, ctx.now);
					let tokens: number | null = null;
					try {
						const r = await embedMany({
							model: factory.embeddingModel(provider, modelId),
							values: texts,
							maxRetries: 1,
							abortSignal: AbortSignal.timeout(ms),
						});
						tokens = typeof r.usage?.tokens === "number" ? r.usage.tokens : null;
						ctx.breaker.success(provider.id);
						return r.embeddings;
					} catch (e) {
						ctx.breaker.failure(provider.id, e, ctx.flags);
						throw e;
					} finally {
						await counted;
						await recordUsageEntry(ctx.recorder, {
							day: usageDay(ctx.now()),
							providerId: provider.id,
							role,
							calls: 1,
							inputTokens: tokens,
							outputTokens: tokens === null ? null : 0,
							costUsd: costFromPricing(ctx.pricing, tokens, tokens === null ? null : 0),
						});
					}
				},
				(m) => m.embed(texts),
			);
		},
		languageModel: lm,
		streamText(params) {
			return sdkStreamText({ timeout: scaledTimeout(role, provider.options?.timeoutScale ?? 1), maxRetries: 1, ...params, model: lm() } as never) as never;
		},
		generateText(params) {
			return sdkGenerateText({ timeout: scaledTimeout(role, provider.options?.timeoutScale ?? 1), maxRetries: 1, ...params, model: lm() } as never) as never;
		},
	};
}

// ── Resolution ─────────────────────────────────────────────────────

/**
 * The Workers AI model id for a role. First match wins:
 *   1. `override`: a per-call model (Test);
 *   2. the admin's pick (`workersAi.models` in ai/providers.json), never for
 *      the pinned scanner;
 *   3. `fallback` (a caller's `SUMMARY_MODEL`), then `SUMMARY_MODEL` in the
 *      environment, for summaries only;
 *   4. the role's default (`WORKERS_AI_DEFAULTS`).
 */
export function workersAiModelFor(
	env: RouterEnv,
	role: AiRole,
	override?: string | null,
	picks?: Readonly<Record<string, string>> | null,
	fallback?: string | null,
): string {
	if (WORKERS_AI_PINNED_ROLES.includes(role)) return WORKERS_AI_DEFAULTS[role];
	const explicit = override?.trim();
	if (explicit) return explicit;
	const picked = picks?.[role]?.trim();
	if (picked) return picked;
	if (role === "summary") {
		const fromCaller = fallback?.trim();
		if (fromCaller) return fromCaller;
		const fromEnv = env.SUMMARY_MODEL?.trim();
		if (fromEnv) return fromEnv;
	}
	return WORKERS_AI_DEFAULTS[role];
}

/** True when a model can be called at all (today: the Workers AI binding is bound). */
export function aiAvailable(env: RouterEnv): boolean {
	return !!workersAiBinding(env);
}

let warnedUnsupported = false;

/**
 * The shipped factory loader, registered by ./ai-gateway-factory.ts. Kept as
 * an injection point so this file has no dependency on the auth store or the
 * provider SDKs, and tests of the router never decrypt anything.
 */
let defaultFactoryLoader: ProviderFactoryLoader | null = null;
export function setDefaultFactoryLoader(loader: ProviderFactoryLoader | null): void {
	defaultFactoryLoader = loader;
}

/** A role that refuses every call: a gateway is active and the role cannot run there. */
function disabledModel(role: AiRole, providerId: string, modelId: string, feature: AiFeature, why: string): ResolvedModel {
	const fail = () => Promise.reject(new AiRoleDisabledError(role, why));
	const throwNow = (): never => {
		throw new AiRoleDisabledError(role, why);
	};
	return {
		role,
		kind: "disabled",
		providerId,
		modelId,
		reason: "disabled",
		feature,
		text: fail,
		json: fail,
		embed: fail,
		languageModel: throwNow,
		streamText: throwNow as never,
		generateText: throwNow as never,
	};
}

/** Whether a role can run with this config; for `semanticAvailable` and the like. */
export function roleUsable(m: Pick<ResolvedModel, "kind">): boolean {
	return m.kind !== "disabled";
}

/**
 * Whether the active config lets `role` run at all: false when a gateway is
 * active and the role is switched off or has no usable model there (for
 * embeddings: "Semantic search off"). Cheap: the config read is cached, and
 * no client is built (`loadFactory: null` skips token decryption).
 */
export async function roleEnabled(env: RouterEnv, role: AiRole): Promise<boolean> {
	if (!aiAvailable(env)) {
		// No Workers AI binding: only a gateway can serve the role.
		const config = await getAiProvidersFile(env.BUCKET as Pick<R2Bucket, "get"> | undefined);
		if (!config?.routing.gatewayProviderId) return false;
	}
	const m = await resolveModel(env, role, { recorder: null, loadFactory: async () => ({ languageModel: () => null as never, embeddingModel: () => null as never }) });
	return roleUsable(m);
}

/**
 * Resolve a role to a model. Never throws.
 *
 * Rules, in order:
 *   1. pinned roles (the injection scanner) → Workers AI, always;
 *   2. no config, or no active gateway (or it was deleted or disabled) →
 *      Workers AI, today's models;
 *   3. the role is an admin exception (embeddings only) → Workers AI;
 *      the admin turned it off → disabled;
 *   4. otherwise the active gateway serves the role: its own pick, else the
 *      routing default (never for embeddings). The model must be in the
 *      provider's catalogue or custom list and pass the capability gate
 *      (`checkRoleModel`): tools verified for agent chat and auto-draft, JSON
 *      for triage, an embedding model of the index's size for embeddings;
 *   5. a role that cannot run on the gateway (no model, failed gate, the
 *      client could not be built) is disabled, so no mail goes anywhere else.
 *      With the admin's fallback opt-in it runs on Workers AI instead.
 *
 * At call time a failed gateway call also falls back once when opted in,
 * except embeddings: another model's vectors cannot be mixed into the index.
 */
export async function resolveModel(env: RouterEnv, role: AiRole, opts: ResolveOptions = {}): Promise<ResolvedModel> {
	const feature = opts.feature ?? ROLE_FEATURES[role];
	const recorder = opts.recorder === undefined ? aiCallRecorder(env) : opts.recorder;
	if (WORKERS_AI_PINNED_ROLES.includes(role)) {
		// No config read: the scanner's model is fixed whatever the file says.
		// Not even a per-call override: the security gate's model is fixed.
		return workersAiModel(env, role, WORKERS_AI_DEFAULTS[role], "pinned", feature, recorder);
	}

	const config =
		opts.config !== undefined ? opts.config : await getAiProvidersFile(env.BUCKET as Pick<R2Bucket, "get"> | undefined);
	const picks = config?.workersAi?.models ?? null;
	const wai = (reason: ResolveReason, fallback = false) =>
		workersAiModel(
			env,
			role,
			workersAiModelFor(env, role, opts.workersAiModel, picks, opts.workersAiFallbackModel),
			reason,
			feature,
			recorder,
			{ fallback },
		);
	const routing = config?.routing;
	if (!config || !routing?.gatewayProviderId) return wai("default");
	const provider = config.providers.find((p) => p.id === routing.gatewayProviderId && p.enabled);
	if (!provider) {
		// Text roles keep their existing behaviour. For embeddings a turned-off
		// gateway is temporary state, not a reason to rebuild every index.
		return role === "embeddings"
			? disabledModel(role, routing.gatewayProviderId, "", feature, "the active gateway is off or missing")
			: wai("missing-provider");
	}

	if (routing.workersAiExceptions.includes(role)) return wai("exception");

	const unusable = (why: string, modelId = "") => {
		// Embeddings have no safe fallback: another model's vectors cannot join the index.
		if (role !== "embeddings" && routing.fallbackToWorkersAi) return wai("default", true);
		return disabledModel(role, provider.id, modelId, feature, why);
	};
	if (routing.disabledRoles.includes(role)) return disabledModel(role, provider.id, "", feature, "turned off by the admin");

	// v1 has one active gateway: a per-role ref naming any other provider
	// (Workers AI included; only a hand-edited file can) is not honoured. The
	// admin's only way to keep a role on Workers AI is `workersAiExceptions`.
	const ref = routing.models[role];
	if (ref?.providerId && ref.providerId !== provider.id) {
		return unusable(`the model for this role names another provider (${ref.providerId})`);
	}
	const modelId = effectiveModelId(routing, role);
	if (!modelId) return unusable("no model picked for this role");

	const model = providerModels(provider).find((m) => m.id === modelId);
	const gate = checkRoleModel(role, model, provider.wire);
	if (!gate.ok) {
		warnOnce(`gate:${provider.id}:${role}:${modelId}`, `AI ${role}: ${modelId} on ${provider.id} fails its capability check (${gate.reason})`);
		return unusable(gate.reason, modelId);
	}

	let factory = opts.factory ?? null;
	if (!factory) {
		const loader = opts.loadFactory === undefined ? defaultFactoryLoader : opts.loadFactory;
		if (!loader) {
			// No gateway client in this build (a test without one, or a bundle
			// that dropped ./ai-gateway-factory.ts): never send the mail elsewhere.
			if (!warnedUnsupported) {
				warnedUnsupported = true;
				console.warn("ai/providers.json routes roles to a gateway this build cannot call");
			}
			return role !== "embeddings" && routing.fallbackToWorkersAi
				? wai("unsupported-provider", true)
				: disabledModel(role, provider.id, modelId, feature, "no gateway client in this build");
		}
		try {
			factory = await loader(env, provider);
		} catch (e) {
			// Never the error object: it may hold key material or the token.
			warnOnce(`load:${provider.id}`, `AI gateway ${provider.id}: could not build the client (${(e as Error)?.name ?? "Error"})`);
			return unusable("the gateway client could not be built", modelId);
		}
	}
	if (role === "embeddings" && !factory.embeddingModel) return unusable("this gateway has no embeddings API", modelId);

	return gatewayModel(role, provider, modelId, factory, feature, {
		recorder,
		breaker: opts.breaker ?? aiBreaker,
		flags: opts.flags !== undefined ? opts.flags : r2BreakerFlags(env.BUCKET as Pick<R2Bucket, "get" | "put"> | undefined),
		now: opts.now ?? Date.now,
		// Embeddings from two models share dimensions but not a vector space.
		// A call-time fallback would stamp the index as the gateway model and
		// write Workers AI vectors into it. Leave embedding work queued instead;
		// search already falls back to full-text on an embedding error.
		fallback: role !== "embeddings" && routing.fallbackToWorkersAi ? wai("default", true) : null,
		pricing: model?.pricing ?? null,
	});
}

/**
 * A gateway model for the settings Test button: no capability gate (testing
 * is how a capability gets verified) and never a Workers AI fallback, so a
 * pass means the gateway itself answered. Counted under `role`'s feature.
 */
export function probeModel(
	env: RouterEnv,
	provider: AiProvider,
	modelId: string,
	factory: ProviderFactory,
	role: AiRole,
	opts: Pick<ResolveOptions, "recorder" | "breaker" | "flags" | "now"> = {},
): ResolvedModel {
	return gatewayModel(role, provider, modelId, factory, ROLE_FEATURES[role], {
		recorder: opts.recorder === undefined ? aiCallRecorder(env) : opts.recorder,
		breaker: opts.breaker ?? aiBreaker,
		flags: opts.flags !== undefined ? opts.flags : r2BreakerFlags(env.BUCKET as Pick<R2Bucket, "get" | "put"> | undefined),
		now: opts.now ?? Date.now,
		fallback: null,
		pricing: providerModels(provider).find((m) => m.id === modelId)?.pricing ?? null,
	});
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
	if (warned.has(key)) return;
	if (warned.size > 200) warned.clear();
	warned.add(key);
	console.warn(message);
}

// ── Handles ────────────────────────────────────────────────────────

/** Resolution bound to an environment and a usage feature, for passing to helpers. */
export interface AiHandle {
	resolve(role: AiRole, opts?: Pick<ResolveOptions, "workersAiModel" | "workersAiFallbackModel">): Promise<ResolvedModel>;
}

/**
 * A handle over `env`. `feature`, when given, is what every call through it
 * counts under (the scan inside triage counts as triage, as it always has).
 */
export function aiFor(env: RouterEnv, opts: Omit<ResolveOptions, "workersAiModel" | "workersAiFallbackModel"> = {}): AiHandle {
	return {
		resolve: (role, more = {}) => resolveModel(env, role, { ...opts, ...more }),
	};
}
