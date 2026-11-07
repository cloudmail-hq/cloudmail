// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The post-ingest AI pass: one job per new message, after it is stored.
 *
 * Runs inside the mailbox alarm (`drainTriageQueue`), in the same run that
 * drains the thread-summary queue (../durableObject/summaries.ts): inbound
 * mail is queued once and one post-ingest job handles both. They stay two
 * model calls because they work at different grains: summaries per thread,
 * debounced; classification per message, promptly.
 *
 * `runPostIngest` loads the settings and label prompts once, runs the
 * injection scanner once, spends the day's AI budget once, and makes one
 * Workers AI JSON-mode call whose schema is the union of every step's fields.
 * Triage contributes `labels` (and the Screener's `sender_kind` /
 * `confidence`); another per-message feature (extraction, to-dos) can add a
 * step to the same call instead of a second pass.
 *
 * Order of trust, cheapest and most explicit first:
 *   1. Rules, blocks, mute and spam already ran in `receiveEmail`; anything in
 *      Spam or Trash, or labelled by a rule, is skipped here.
 *   2. Header heuristics: no model call.
 *   3. The model, gated by the injection scanner and the daily cap.
 *
 * Never throws: a triage failure costs the labels, never the message.
 */

import {
	AI_CALLS_PER_MESSAGE,
	buildClassifyRequest,
	clampBackfillBatch,
	headerLabelHints,
	parseClassifyResponse,
	verdictForHint,
	type ActiveLabelPrompt,
	type ClassifyResult,
	type TriageCorrection,
	type TriagePresetKey,
} from "../../shared/ai-triage";
import { Folders } from "../../shared/folders";
import { headerValue, parseStoredHeaders } from "../../shared/headers";
import { parseStoredMailboxSettings, type ResolvedMailboxSettings } from "../../shared/mailbox-settings";
import { isPromptInjection, runJsonClassifier } from "./ai";
import { aiAvailable, aiFor, type RouterEnv } from "./ai-router";
import type { AiWorkBudget } from "./ai-budget";
import { stripHtmlToText } from "./email-helpers";
import type { Env } from "../types";

/** The slice of the MailboxDO stub the pipeline calls. */
export interface TriageStub {
	getEmail(id: string): Promise<Record<string, unknown> | null>;
	activeLabelPrompts(): Promise<ActiveLabelPrompt[]>;
	presetLabelId(key: TriagePresetKey): Promise<string | null>;
	recentCorrections(): Promise<TriageCorrection[]>;
	consumeAiBudget(cap: number, calls: number): Promise<boolean>;
	applyTriage(
		emailId: string,
		labelIds: string[],
		source: "ai" | "heuristic",
		verdict?: { kind: string | null; confidence: string | null },
	): Promise<{ applied: string[]; archived: boolean; skipped?: string }>;
	markTriaged(emailId: string, state: string): Promise<void>;
	backfillCandidates(limit: number): Promise<{ id: string }[]>;
	backfillRemaining(): Promise<number>;
}

export interface TriageMessage {
	id: string;
	folder: string;
	sender: string;
	senderName: string | null;
	subject: string;
	bodyHtml: string;
	header: (name: string) => string | undefined | null;
}

/** What one step adds to the shared call, and what it does with the answer. */
export interface PostIngestStep {
	name: string;
	/** Whether this step wants the model for this message. */
	wantsModel(ctx: StepContext): boolean;
	/** Schema properties (and required keys) this step adds to the call. */
	schema?(ctx: StepContext): { properties: Record<string, unknown>; required: string[] };
	/** Runs after the call (or with `answer` null when there was none). */
	apply(ctx: StepContext, answer: unknown | null): Promise<void>;
}

export interface StepContext {
	stub: TriageStub;
	message: TriageMessage;
	settings: ResolvedMailboxSettings;
	labels: ActiveLabelPrompt[];
	corrections: TriageCorrection[];
	/** Set by the triage step for its own `apply`. */
	scratch: Record<string, unknown>;
}

export type PostIngestOutcome =
	| "skipped_folder"
	| "disabled"
	| "heuristic"
	| "no_prompts"
	| "injection"
	| "capped"
	| "model_failed"
	| "classified";

function wantsVerdict(ctx: StepContext): boolean {
	return ctx.message.folder === Folders.SCREENER && ctx.settings.triage.screenerVerdict;
}

/** Auto-labels and the Screener verdict. */
export const triageStep: PostIngestStep = {
	name: "triage",
	wantsModel(ctx) {
		if (ctx.scratch.heuristicDone) return false;
		return ctx.labels.length > 0 || wantsVerdict(ctx);
	},
	schema(ctx) {
		const request = buildClassifyRequest({
			labels: ctx.labels,
			message: {
				from: ctx.message.sender,
				fromName: ctx.message.senderName,
				subject: ctx.message.subject,
				text: stripHtmlToText(ctx.message.bodyHtml),
			},
			corrections: ctx.corrections,
			wantVerdict: wantsVerdict(ctx),
			nonce: (ctx.scratch.nonce as string) ?? "",
		});
		ctx.scratch.request = request;
		const schema = request.schema as { properties: Record<string, unknown>; required: string[] };
		return { properties: schema.properties, required: schema.required };
	},
	async apply(ctx, answer) {
		if (ctx.scratch.heuristicDone) return;
		const request = ctx.scratch.request as ReturnType<typeof buildClassifyRequest> | undefined;
		if (!request || answer === null) {
			// A capped or failed call leaves the message unmarked, so a later
			// backfill can still pick it up; an injection verdict is final.
			const reason = (ctx.scratch.reason as string) ?? "skipped";
			if (reason !== "capped" && reason !== "model_failed") {
				await ctx.stub.markTriaged(ctx.message.id, reason);
			}
			return;
		}
		const result: ClassifyResult = parseClassifyResponse(answer, request.keys);
		// A header hint is a firmer verdict than the model's guess.
		const hint = ctx.scratch.hintVerdict as string | undefined;
		await ctx.stub.applyTriage(ctx.message.id, result.labelIds, "ai", {
			kind: wantsVerdict(ctx) ? (hint ?? result.senderKind) : null,
			confidence: wantsVerdict(ctx) ? (hint ? "high" : result.confidence) : null,
		});
	},
};

/** Every step in the shared post-ingest call. Summaries can append theirs. */
export const POST_INGEST_STEPS: PostIngestStep[] = [triageStep];

/**
 * Header heuristics. Applies the hinted preset's label when the mailbox has
 * that preset on, and settles the Screener verdict, with no model call.
 * Returns true when it labelled the message, which ends triage for it.
 */
async function applyHeuristics(ctx: StepContext): Promise<boolean> {
	const hints = headerLabelHints({ sender: ctx.message.sender, header: ctx.message.header });
	if (hints.length === 0) return false;
	const labelIds: string[] = [];
	// Labels only when auto-labelling is on; the verdict alone otherwise.
	for (const hint of ctx.settings.triage.enabled ? hints : []) {
		const id = await ctx.stub.presetLabelId(hint);
		if (id) labelIds.push(id);
	}
	const verdictKind = wantsVerdict(ctx) ? verdictForHint(hints[0]!) : null;
	if (labelIds.length === 0) {
		// No preset label to apply. A verdict alone settles the Screener
		// guess without a model call, but must not stop the user's own label
		// prompts from being tried.
		if (verdictKind && ctx.labels.length === 0) {
			await ctx.stub.applyTriage(ctx.message.id, [], "heuristic", { kind: verdictKind, confidence: "high" });
			return true;
		}
		if (verdictKind) ctx.scratch.hintVerdict = verdictKind;
		return false;
	}
	await ctx.stub.applyTriage(ctx.message.id, labelIds, "heuristic", {
		kind: verdictKind,
		confidence: verdictKind ? "high" : null,
	});
	return true;
}

/**
 * Run the post-ingest pass for one stored message.
 *
 * `settings` is the mailbox's resolved settings, already read by the caller.
 */
export async function runPostIngest(
	env: RouterEnv,
	stub: TriageStub,
	message: TriageMessage,
	settings: ResolvedMailboxSettings,
	steps: PostIngestStep[] = POST_INGEST_STEPS,
): Promise<PostIngestOutcome> {
	try {
		if (message.folder === Folders.SPAM || message.folder === Folders.TRASH) {
			await stub.markTriaged(message.id, "skipped");
			return "skipped_folder";
		}
		const screenerVerdictOn = message.folder === Folders.SCREENER && settings.triage.screenerVerdict;
		if (!settings.triage.enabled && !screenerVerdictOn) return "disabled";

		const [labels, corrections] = settings.triage.enabled
			? await Promise.all([stub.activeLabelPrompts(), stub.recentCorrections()])
			: [[], []];
		const ctx: StepContext = {
			stub,
			message,
			settings,
			labels,
			corrections,
			scratch: { nonce: crypto.randomUUID().replace(/-/g, "").slice(0, 12) },
		};

		if (await applyHeuristics(ctx)) {
			ctx.scratch.heuristicDone = true;
		}

		const wanting = steps.filter((s) => s.wantsModel(ctx));
		if (wanting.length === 0) {
			for (const step of steps) await step.apply(ctx, null);
			if (ctx.scratch.heuristicDone) return "heuristic";
			await stub.markTriaged(message.id, "no_prompts");
			return "no_prompts";
		}

		// No binding (local dev without AI): nothing to spend the budget on.
		if (!aiAvailable(env)) {
			ctx.scratch.reason = "model_failed";
			for (const step of steps) await step.apply(ctx, null);
			return "model_failed";
		}

		// The budget is spent before either call, so a capped mailbox makes none.
		if (!(await stub.consumeAiBudget(settings.triage.dailyAiCap, AI_CALLS_PER_MESSAGE))) {
			ctx.scratch.reason = "capped";
			for (const step of steps) await step.apply(ctx, null);
			return "capped";
		}

		const ai = aiFor(env, { feature: "triage" });
		if (await isPromptInjection(ai, message.bodyHtml)) {
			ctx.scratch.reason = "injection";
			for (const step of steps) await step.apply(ctx, null);
			return "injection";
		}

		const properties: Record<string, unknown> = {};
		const required: string[] = [];
		let system = "";
		let user = "";
		for (const step of wanting) {
			const part = step.schema?.(ctx);
			if (!part) continue;
			Object.assign(properties, part.properties);
			required.push(...part.required);
		}
		const request = ctx.scratch.request as ReturnType<typeof buildClassifyRequest> | undefined;
		if (request) {
			system = request.system;
			user = request.user;
		}
		const answer = await runJsonClassifier(ai, {
			system,
			user,
			schema: { type: "object", properties, required },
		});
		if (answer === null) ctx.scratch.reason = "model_failed";
		for (const step of steps) await step.apply(ctx, wanting.includes(step) ? answer : null);
		return answer === null ? "model_failed" : "classified";
	} catch (e) {
		console.error(`Post-ingest triage failed for ${message.id}:`, (e as Error).message);
		return "model_failed";
	}
}

/** Build the pipeline's view of a stored row. */
export function triageMessageFromRow(row: Record<string, unknown>): TriageMessage {
	const headers = parseStoredHeaders((row.raw_headers as string | null) ?? null);
	return {
		id: row.id as string,
		folder: (row.folder_id as string) ?? Folders.INBOX,
		sender: ((row.sender as string) ?? "").toLowerCase(),
		senderName: (row.sender_name as string | null) ?? null,
		subject: (row.subject as string) ?? "",
		bodyHtml: (row.body as string) ?? "",
		header: (name) => headerValue(headers, name),
	};
}

/** Read a mailbox's settings blob. Defaults on any failure. */
export async function readMailboxSettings(
	env: Pick<Env, "BUCKET">,
	mailboxId: string,
): Promise<ResolvedMailboxSettings> {
	try {
		const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
		return parseStoredMailboxSettings(obj ? await obj.json() : {});
	} catch {
		return parseStoredMailboxSettings({});
	}
}

/** The queue half of the DO, as the alarm drain sees it. */
export interface TriageQueue {
	take(limit?: number): string[];
	/** Undo `take`'s attempt count for rows that were taken but never tried. */
	release?(emailIds: string[]): void;
	finish(emailId: string, outcome: "done" | "retry"): void;
}

/**
 * Drain one bounded batch of the post-ingest queue. Called from the mailbox
 * alarm in the same run as the summary queue, so a new message is handled by
 * one job. Outcomes that may succeed later (model failure) are retried up to
 * the attempt limit; a capped day is retried too, since backfill will not
 * reach a message whose state is still unset.
 */
export async function drainTriageQueue(
	env: RouterEnv,
	stub: TriageStub,
	queue: TriageQueue,
	settings: ResolvedMailboxSettings,
	limit?: number,
	budget?: AiWorkBudget,
): Promise<{ processed: number; capped: boolean; outOfTime: boolean }> {
	let processed = 0;
	let capped = false;
	const ids = queue.take(limit);
	for (let i = 0; i < ids.length; i++) {
		if (budget?.exhausted()) {
			// Out of wall time: the rest stay queued for the re-armed alarm, and
			// get back the attempt `take` counted, since they were never tried.
			queue.release?.(ids.slice(i));
			return { processed, capped, outOfTime: true };
		}
		const emailId = ids[i]!;
		const row = await stub.getEmail(emailId);
		if (!row) {
			queue.finish(emailId, "done");
			continue;
		}
		const outcome = await runPostIngest(env, stub, triageMessageFromRow(row), settings);
		processed += 1;
		if (outcome === "capped") capped = true;
		queue.finish(emailId, outcome === "model_failed" ? "retry" : "done");
	}
	return { processed, capped, outOfTime: false };
}

/**
 * One bounded backfill step over the last 14 days.
 *
 * Lazy: it runs when someone asks (the settings screen, `tapemail label
 * prompt backfill`, or MCP), never on a timer, and does at most `limit`
 * messages per call. Each message goes through the same pipeline and the same
 * daily cap as new mail, so a backfill cannot spend past it; it stops at the
 * first capped message.
 */
export async function runBackfillStep(
	env: RouterEnv,
	stub: TriageStub,
	settings: ResolvedMailboxSettings,
	limit?: number,
): Promise<{ processed: number; classified: number; remaining: number; capped: boolean }> {
	const batch = clampBackfillBatch(limit);
	const candidates = await stub.backfillCandidates(batch);
	let processed = 0;
	let classified = 0;
	let capped = false;
	for (const candidate of candidates) {
		const row = await stub.getEmail(candidate.id);
		if (!row) continue;
		const outcome = await runPostIngest(env, stub, triageMessageFromRow(row), settings);
		if (outcome === "capped") {
			capped = true;
			break;
		}
		processed += 1;
		if (outcome === "classified" || outcome === "heuristic") classified += 1;
	}
	return { processed, classified, remaining: await stub.backfillRemaining(), capped };
}
