// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Usage and cost: prices, month-to-date projection, and the budget check.
 *
 * Pure on purpose: the Worker computes `/api/v1/usage` and the hourly budget
 * check with these, the Usage tab formats with them, and the tests pin the
 * math without a binding in sight.
 */

import { z } from "zod";
import type { AiRole } from "./ai-providers";

// ── Prices (USD) ────────────────────────────────────────────────────

/**
 * Email Service on Workers Paid: 3,000 emails a month included, then $0.35
 * per 1,000. https://developers.cloudflare.com/email-service/platform/pricing/
 */
export const EMAIL_INCLUDED_PER_MONTH = 3000;
export const EMAIL_PRICE_PER_1000 = 0.35;

/**
 * Workers AI: 10,000 neurons a day free (per account, resetting 00:00 UTC),
 * then $0.011 per 1,000 neurons on Workers Paid.
 * https://developers.cloudflare.com/workers-ai/platform/pricing/
 */
export const AI_FREE_NEURONS_PER_DAY = 10_000;
export const AI_PRICE_PER_1000_NEURONS = 0.011;

/**
 * Durable Objects on Workers Paid: 1 million requests a month included, then
 * $0.15 per million. Shown as a count only: the allowance is shared by every
 * Worker on the account, so this app's share has no price of its own.
 * https://developers.cloudflare.com/durable-objects/platform/pricing/
 */
export const DO_INCLUDED_REQUESTS_PER_MONTH = 1_000_000;

export const USAGE_PRICING = {
	email_included_per_month: EMAIL_INCLUDED_PER_MONTH,
	email_price_per_1000: EMAIL_PRICE_PER_1000,
	ai_free_neurons_per_day: AI_FREE_NEURONS_PER_DAY,
	ai_price_per_1000_neurons: AI_PRICE_PER_1000_NEURONS,
	do_included_requests_per_month: DO_INCLUDED_REQUESTS_PER_MONTH,
} as const;

// ── AI features ─────────────────────────────────────────────────────

/** Where the app calls Workers AI. Counted per call by `workers/lib/ai-usage.ts`. */
export const AI_FEATURES = ["summaries", "triage", "followups", "agent", "verifier", "safety", "semantic"] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export const AI_FEATURE_LABELS: Record<AiFeature, string> = {
	summaries: "Summaries",
	triage: "Triage",
	followups: "Follow-up check",
	agent: "Agent drafts",
	verifier: "Draft checks",
	safety: "Injection scan",
	semantic: "Semantic search and Ask",
};

export function isAiFeature(value: unknown): value is AiFeature {
	return typeof value === "string" && (AI_FEATURES as readonly string[]).includes(value);
}

// ── Month window ────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

export interface MonthWindow {
	/** `YYYY-MM`, UTC. */
	month: string;
	/** First instant of the month, ISO. */
	start: string;
	/** `now`, ISO (exclusive end of the month-to-date window). */
	end: string;
	/** `YYYY-MM-DD` of the first day and of today. */
	startDate: string;
	today: string;
	days_in_month: number;
	/** Share of the month that has passed, in (0, 1]. */
	elapsed_fraction: number;
}

export function monthWindow(now: number = Date.now()): MonthWindow {
	const d = new Date(now);
	const y = d.getUTCFullYear();
	const m = d.getUTCMonth();
	const startMs = Date.UTC(y, m, 1);
	const endMs = Date.UTC(y, m + 1, 1);
	const days = Math.round((endMs - startMs) / DAY_MS);
	// At least a minute in, so a projection at 00:00:00 on the 1st is not infinite.
	const elapsed = Math.min(1, Math.max(60_000, now - startMs) / (endMs - startMs));
	return {
		month: `${y}-${String(m + 1).padStart(2, "0")}`,
		start: new Date(startMs).toISOString(),
		end: new Date(now).toISOString(),
		startDate: new Date(startMs).toISOString().slice(0, 10),
		today: d.toISOString().slice(0, 10),
		days_in_month: days,
		elapsed_fraction: elapsed,
	};
}

/** Linear month-end projection of a month-to-date count. Never below what is already used. */
export function projectMonthEnd(mtd: number, elapsedFraction: number): number {
	if (!Number.isFinite(mtd) || mtd <= 0) return 0;
	if (!(elapsedFraction > 0)) return mtd;
	return Math.max(mtd, mtd / Math.min(1, elapsedFraction));
}

/** Cents-precision rounding for money shown or compared. */
export function roundUsd(n: number): number {
	return Math.round(n * 100) / 100;
}

// ── Costs ───────────────────────────────────────────────────────────

/** Emails past the monthly allowance. */
export function billableEmails(sent: number): number {
	return Math.max(0, Math.ceil(sent) - EMAIL_INCLUDED_PER_MONTH);
}

export function emailCost(sent: number): number {
	return (billableEmails(sent) / 1000) * EMAIL_PRICE_PER_1000;
}

/**
 * Workers AI cost for a set of days. The free allocation is per day, so a
 * quiet day's leftover never offsets a busy one.
 */
export function aiCostForDays(neuronsPerDay: readonly number[]): number {
	let billable = 0;
	for (const n of neuronsPerDay) billable += Math.max(0, n - AI_FREE_NEURONS_PER_DAY);
	return (billable / 1000) * AI_PRICE_PER_1000_NEURONS;
}

export interface AiProjection {
	neurons_mtd: number;
	neurons_projected: number;
	cost_mtd: number;
	projected_cost: number;
}

/**
 * Month-to-date and projected AI cost from neurons per UTC day. The rest of
 * the month is assumed to run at the average day so far, with each future
 * day getting its own free allocation.
 */
export function projectAi(byDate: Readonly<Record<string, number>>, window: MonthWindow): AiProjection {
	const days = Object.values(byDate).filter((n) => Number.isFinite(n) && n > 0);
	const mtd = days.reduce((a, b) => a + b, 0);
	const costMtd = aiCostForDays(days);
	const elapsedDays = window.elapsed_fraction * window.days_in_month;
	const remainingDays = Math.max(0, window.days_in_month - elapsedDays);
	const avgPerDay = elapsedDays > 0 ? mtd / elapsedDays : 0;
	const futureDaily = (Math.max(0, avgPerDay - AI_FREE_NEURONS_PER_DAY) / 1000) * AI_PRICE_PER_1000_NEURONS;
	return {
		neurons_mtd: mtd,
		neurons_projected: projectMonthEnd(mtd, window.elapsed_fraction),
		cost_mtd: costMtd,
		projected_cost: costMtd + futureDaily * remainingDays,
	};
}

export interface EmailProjection {
	sent_mtd: number;
	projected: number;
	cost_mtd: number;
	projected_cost: number;
}

export function projectEmail(sentMtd: number, window: MonthWindow): EmailProjection {
	const projected = projectMonthEnd(sentMtd, window.elapsed_fraction);
	return { sent_mtd: sentMtd, projected, cost_mtd: emailCost(sentMtd), projected_cost: emailCost(projected) };
}

// ── Budget ──────────────────────────────────────────────────────────

export const BUDGET_KINDS = ["ai", "email"] as const;
export type BudgetKind = (typeof BUDGET_KINDS)[number];

const Threshold = z.number().finite().min(0).max(1_000_000).nullable();

/** `PUT /api/v1/usage/budget`. Omit a key to keep it; null clears it. */
export const UsageBudgetPatchSchema = z
	.object({ ai_usd: Threshold.optional(), email_usd: Threshold.optional() })
	.strict();
export type UsageBudgetPatch = z.infer<typeof UsageBudgetPatchSchema>;

export interface UsageBudget {
	ai_usd: number | null;
	email_usd: number | null;
	updated_at: number | null;
	updated_by: string | null;
}

export const EMPTY_BUDGET: UsageBudget = { ai_usd: null, email_usd: null, updated_at: null, updated_by: null };

export interface BudgetAlert {
	kind: BudgetKind;
	projected_usd: number;
	threshold_usd: number;
	exceeded: boolean;
}

/**
 * One alert per kind with both a threshold and a projection. Exceeded means
 * strictly above: a $0 threshold fires on the first billable cent.
 */
export function evaluateBudget(
	budget: Pick<UsageBudget, "ai_usd" | "email_usd">,
	projected: Partial<Record<BudgetKind, number | null>>,
): BudgetAlert[] {
	const out: BudgetAlert[] = [];
	for (const kind of BUDGET_KINDS) {
		const threshold = kind === "ai" ? budget.ai_usd : budget.email_usd;
		const value = projected[kind];
		if (threshold == null || value == null || !Number.isFinite(value)) continue;
		const p = roundUsd(value);
		out.push({ kind, projected_usd: p, threshold_usd: threshold, exceeded: p > threshold });
	}
	return out;
}

// ── Response ────────────────────────────────────────────────────────

export interface UsageProvider {
	configured: boolean;
	cached_at?: string;
	error?: string;
	sampled?: boolean;
}

export interface UsageMailboxRow {
	email: string;
	triage: { enabled: boolean; daily_ai_cap: number; calls_today: number };
	send_caps: { hourly: number; daily: number; sent_last_hour: number; sent_last_day: number; default: boolean } | null;
}

/** Model requests per provider this month. `provider_id` is "workers-ai" for Workers AI. */
export interface UsageAiProviderRow {
	provider_id: string;
	label: string;
	calls_mtd: number;
	calls_today: number;
	/** Null until a call reports tokens. */
	input_tokens_mtd: number | null;
	output_tokens_mtd: number | null;
	/** Only when the gateway publishes prices; never estimated. */
	cost_mtd_usd: number | null;
}

/** Model requests per role and the provider that served them this month. */
export interface UsageAiRoleRow {
	role: AiRole;
	label: string;
	provider_id: string;
	calls_mtd: number;
	calls_today: number;
	input_tokens_mtd: number | null;
	output_tokens_mtd: number | null;
}

/** `GET /api/v1/usage`. */
export interface UsageResponse {
	window: MonthWindow;
	email: {
		/** Cloudflare counts envelope recipients; local counts messages. */
		source: "cloudflare" | "local";
		unit: "recipients" | "messages";
		included: number;
	} & EmailProjection;
	ai: {
		/** This app's calls, counted locally. */
		by_feature: { feature: AiFeature; label: string; calls_mtd: number; calls_today: number }[];
		/** Per provider, counted locally by the model router. Empty before any request is recorded. */
		by_provider: UsageAiProviderRow[];
		/** Per role and provider, counted locally by the model router. */
		by_role: UsageAiRoleRow[];
		calls_mtd: number;
		/** Cloudflare's neuron counts. Account-wide: every Worker on the account. */
		neurons: (AiProjection & { today: number; by_model: { model: string; neurons: number; requests: number }[] }) | null;
	};
	r2: { bucket: string; bytes: number; objects: number } | null;
	durable_objects: { requests_mtd: number; projected: number; included: number } | null;
	quota: { limit: number; used: number; unit: string; resets_at: string | null } | null;
	mailboxes: UsageMailboxRow[];
	budget: UsageBudget & { alerts: BudgetAlert[]; exceeded: boolean };
	pricing: typeof USAGE_PRICING;
	provider: UsageProvider;
}
