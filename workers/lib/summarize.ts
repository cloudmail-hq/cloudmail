// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Generate a thread summary with Workers AI.
 *
 * Takes an `AiHandle` (./ai-router.ts) and touches no storage, so tests drive
 * it with a mocked binding behind the router. The Durable Object side (what to summarise, when,
 * and where it is stored) lives in `../durableObject/summaries.ts`.
 *
 * Order of operations is the safety property:
 *   1. bulk mail with bulk summaries turned off, and threads with almost no
 *      text, are skipped before any model call;
 *   2. the injection scanner runs on exactly the text the summariser would see,
 *      and a hit stores the neutral line instead of calling the summariser;
 *   3. only then is the summary model called, once, for the one-liner and the
 *      three bullets together.
 *
 * ## One place to call a model
 *
 * Every summary generation goes through `generateSummary`, which resolves the
 * `summary` role through the router; nothing in the summary path calls a
 * model directly.
 */

import {
	INJECTION_SUMMARY,
	MIN_SUMMARY_TEXT_CHARS,
	SUMMARY_SYSTEM_PROMPT,
	BULLETS_TARGET,
	buildSummaryInput,
	cleanSummaryLine,
	parseSummaryResponse,
	summaryUserPrompt,
	type SummarySourceMessage,
	type SummaryStatus,
} from "../../shared/ai-summary";
import { SUMMARY_MODEL, scanPromptInjection } from "./ai";
import type { AiHandle } from "./ai-router";

export interface SummarizeOptions {
	/** Known automated or bulk mail. */
	bulk: boolean;
	/** Whether bulk mail is summarised at all (admin setting, on by default). */
	bulkSummaries: boolean;
	/** Model id override (`SUMMARY_MODEL`); the small default otherwise. */
	model?: string;
}

export interface SummaryResult {
	status: SummaryStatus;
	line: string | null;
	bullets: string[] | null;
	/** Model calls made, for logs and tests. */
	calls: number;
}

/** Thrown when the attempt should be retried later rather than recorded. */
export class SummaryRetryableError extends Error {}

// Response parsing moved to the router with the `run` calls; re-exported.
export { responsePayload, responseText } from "./ai-router";

/** The summary model for this deployment: the override when set, else the small default. */
export function summaryModel(override?: string | null): string {
	const id = override?.trim();
	return id ? id : SUMMARY_MODEL;
}

/** `{line, bullets[3]}`; JSON mode holds the model to the shape, the parser checks the rest. */
export const SUMMARY_JSON_SCHEMA = {
	type: "object",
	properties: {
		line: { type: "string" },
		bullets: { type: "array", items: { type: "string" }, minItems: 1, maxItems: BULLETS_TARGET },
	},
	required: ["line", "bullets"],
} as const;

/** About 30 tokens of line, 3 × 25 of bullets, and the JSON around them. */
const SUMMARY_MAX_TOKENS = 220;
const SUMMARY_TEMPERATURE = 0.2;

/**
 * The single-call summary: prompt-built thread text in, `{line, bullets}` out.
 * Everything model-specific in the summary path is in here; the router
 * (`role: "summary"`) picks and calls the model.
 *
 * JSON mode first. Workers AI raises "JSON Mode couldn't be met" when the
 * model cannot satisfy the schema, and a model without JSON mode may reject
 * the parameter; either way the call is retried once as plain text, which the
 * parser reads as a headline and dashed bullets. Returns the calls made.
 */
export async function generateSummary(
	ai: AiHandle,
	model: string | undefined,
	input: string,
): Promise<{ parsed: ReturnType<typeof parseSummaryResponse>; calls: number }> {
	// `SUMMARY_MODEL` sits below the admin's Workers AI pick (Settings → AI providers).
	const resolved = await ai.resolve("summary", { workersAiFallbackModel: model?.trim() || null });
	const base = {
		system: SUMMARY_SYSTEM_PROMPT,
		user: summaryUserPrompt(input),
		maxTokens: SUMMARY_MAX_TOKENS,
		temperature: SUMMARY_TEMPERATURE,
	};
	try {
		const result = await resolved.json({ ...base, schema: SUMMARY_JSON_SCHEMA as unknown as Record<string, unknown> });
		const parsed = parseSummaryResponse(result);
		if (parsed) return { parsed, calls: 1 };
	} catch (e) {
		console.warn("summary JSON mode failed, retrying as text:", (e as Error).message);
	}
	const result = await resolved.text(base);
	return { parsed: parseSummaryResponse(result), calls: 2 };
}

export async function summarizeThread(
	ai: AiHandle,
	messages: SummarySourceMessage[],
	options: SummarizeOptions,
): Promise<SummaryResult> {
	if (options.bulk && !options.bulkSummaries) {
		return { status: "skipped", line: null, bullets: null, calls: 0 };
	}

	const input = buildSummaryInput(messages);
	// `input.text` always carries a header per message, so gate on the cleaned
	// bodies: an empty or near-empty thread stores no summary (the list shows the
	// snippet) and never reaches a model, where it produced "a new email with no
	// content".
	if (input.textChars < MIN_SUMMARY_TEXT_CHARS) {
		return { status: "skipped", line: null, bullets: null, calls: 0 };
	}

	let calls = 1;
	const scan = await scanPromptInjection(ai, input.text);
	if (scan === "error") throw new SummaryRetryableError("injection scanner unavailable");
	if (scan === "injection") {
		return { status: "blocked", line: INJECTION_SUMMARY, bullets: null, calls };
	}

	let parsed: ReturnType<typeof parseSummaryResponse>;
	try {
		const run = await generateSummary(ai, options.model, input.text);
		parsed = run.parsed;
		calls += run.calls;
	} catch (e) {
		throw new SummaryRetryableError(`summary model failed: ${(e as Error).message}`);
	}

	const bullets = parsed?.bullets ?? null;
	// A response with bullets but no usable line still gives the list its headline.
	const line = parsed?.line ?? (bullets ? cleanSummaryLine(bullets[0]) : null);
	if (!line && !bullets) throw new SummaryRetryableError("model returned nothing usable");
	return { status: "ok", line, bullets, calls };
}
