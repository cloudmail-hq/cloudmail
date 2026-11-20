// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-feature AI call counter for the Usage tab.
 *
 * Used only by the model router (`./ai-router.ts`), which is the one place
 * calls are counted. `meteredAi(env, feature, binding)` returns the binding
 * with `run` wrapped so each call adds one to today's count for `feature` in
 * the AuthDO (`ai_usage_daily`). Everything else on the binding passes
 * through, so it can be handed to `createAI` as well as called directly.
 *
 * Counting never affects the model call: the write starts alongside `run`,
 * is awaited only after `run` settles (so it adds no latency to a call that
 * takes seconds), and any error from it is swallowed. A failed model call is
 * still counted, since it may still have been billed.
 *
 * Features are named where the call is made: the injection scan inside
 * triage counts as triage, and so on. See `AI_FEATURES` in shared/usage.ts.
 */

import type { AiFeature } from "../../shared/usage";
import type { AiRole } from "../../shared/ai-providers";

/**
 * One model request, per provider and role, for the Usage tab's provider and
 * role tables. Tokens come from the AI SDK's usage (or Workers AI's `usage`)
 * when the backend reports them, else null. Cost only when the gateway
 * publishes prices (catalogue `pricing`); never invented.
 */
export interface AiUsageEntry {
	day: string;
	/** A gateway provider id, or "workers-ai". */
	providerId: string;
	role: AiRole;
	calls: number;
	inputTokens: number | null;
	outputTokens: number | null;
	costUsd: number | null;
	/** True when this call ran on Workers AI because the gateway failed. */
	fallback?: boolean;
}

export interface AiCallRecorder {
	recordAiCall(feature: AiFeature, day: string, calls?: number): Promise<void>;
	/** Optional so older test recorders still type-check. */
	recordAiUsage?(entry: AiUsageEntry): Promise<void>;
}

type EnvLike = { AI?: Ai; AUTH_STORE?: unknown };

/** The AuthDO, or null when the binding is absent (tests, partial configs). */
export function aiCallRecorder(env: EnvLike): AiCallRecorder | null {
	const ns = env.AUTH_STORE as { idFromName(name: string): unknown; get(id: unknown): unknown } | undefined;
	if (!ns || typeof ns.idFromName !== "function") return null;
	try {
		return ns.get(ns.idFromName("global")) as AiCallRecorder;
	} catch {
		return null;
	}
}

export function usageDay(now: number = Date.now()): string {
	return new Date(now).toISOString().slice(0, 10);
}

/**
 * Wrap an AI binding so its calls are counted under `feature`. Returns the
 * input untouched when there is nothing to wrap or nowhere to count.
 */
export function meteredAi<T extends object | undefined | null = Ai>(
	env: EnvLike,
	feature: AiFeature,
	binding: T,
	options: {
		recorder?: AiCallRecorder | null;
		now?: () => number;
		/** Also record a per-provider/role entry for each call (the Usage tab's role table). */
		role?: AiRole;
		fallback?: boolean;
	} = {},
): T {
	if (!binding) return binding;
	const recorder = options.recorder === undefined ? aiCallRecorder(env) : options.recorder;
	if (!recorder) return binding;
	const now = options.now ?? Date.now;
	const target = binding as unknown as Record<PropertyKey, unknown>;
	return new Proxy(target, {
		get(obj, prop) {
			// The real binding as receiver: its class may use private fields.
			const value = Reflect.get(obj, prop);
			if (prop !== "run" || typeof value !== "function") {
				return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(obj) : value;
			}
			return async (...args: unknown[]) => {
				let recorded: Promise<void>;
				try {
					recorded = Promise.resolve(recorder.recordAiCall(feature, usageDay(now()), 1)).catch(() => {});
				} catch {
					recorded = Promise.resolve();
				}
				let out: unknown;
				try {
					out = await (value as (...a: unknown[]) => Promise<unknown>).apply(obj, args);
					return out;
				} finally {
					await recorded;
					if (options.role) {
						await recordUsageEntry(recorder, {
							day: usageDay(now()),
							providerId: "workers-ai",
							role: options.role,
							calls: 1,
							...workersAiTokens(out),
							costUsd: null,
							fallback: options.fallback,
						});
					}
				}
			};
		},
	}) as unknown as T;
}

/** Record one usage entry. Never throws; a failed write never affects the call. */
export async function recordUsageEntry(recorder: AiCallRecorder | null | undefined, entry: AiUsageEntry): Promise<void> {
	if (!recorder || typeof recorder.recordAiUsage !== "function") return;
	try {
		await Promise.resolve(recorder.recordAiUsage(entry)).catch(() => {});
	} catch {
		// Counting never affects the call.
	}
}

/** Token counts from a Workers AI response's `usage`, when present. */
export function workersAiTokens(result: unknown): { inputTokens: number | null; outputTokens: number | null } {
	const u = (result as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
	const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
	return { inputTokens: n(u?.prompt_tokens), outputTokens: n(u?.completion_tokens) };
}

/** Cost from published per-MTok prices, or null. Never estimated. */
export function costFromPricing(
	pricing: { inputPerMTok: number; outputPerMTok: number } | null | undefined,
	inputTokens: number | null,
	outputTokens: number | null,
): number | null {
	if (!pricing || inputTokens === null || outputTokens === null) return null;
	return (inputTokens * pricing.inputPerMTok + outputTokens * pricing.outputPerMTok) / 1_000_000;
}
