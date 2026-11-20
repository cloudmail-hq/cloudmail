// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The spam-rate circuit breaker: thresholds, evaluation and state transitions.
 *
 * Gmail and Yahoo ask bulk senders to keep the user-reported spam rate under
 * 0.3%, and recommend staying under 0.1%. A domain that crosses 0.3% for long
 * enough gets its mail rejected wholesale, transactional mail included, so the
 * cheapest protection is to stop the mail that causes complaints (sequences and
 * template sends) before the provider stops everything.
 *
 * - Above {@link SPAM_RATE_WARNING} (0.1%): warning banner and a
 *   `deliverability.warning` webhook.
 * - Above {@link SPAM_RATE_PAUSE} (0.3%): bulk sends from the domain are paused
 *   until an administrator resumes them. Transactional mail continues.
 *
 * The rate is complaints / delivered over a rolling 7 days, per sending domain,
 * the same definition Cloudflare and Gmail Postmaster use. Below
 * {@link SPAM_RATE_MIN_DELIVERED} delivered messages the rate is not acted on:
 * one complaint on 40 messages is 2.5%, which says nothing about a domain.
 *
 * Pure, so the Worker, the UI and the tests share one definition.
 */

export const SPAM_RATE_WINDOW_DAYS = 7;
/** Warn above this fraction (0.1%). */
export const SPAM_RATE_WARNING = 0.001;
/** Pause bulk sends above this fraction (0.3%, the Gmail/Yahoo limit). */
export const SPAM_RATE_PAUSE = 0.003;
/** Fewer delivered messages than this and the rate is not acted on. */
export const SPAM_RATE_MIN_DELIVERED = 100;
/**
 * After an administrator resumes a domain, the breaker does not re-pause it for
 * this long. The 7-day window still contains the complaints that tripped it, so
 * without a grace period a resume would be undone by the next evaluation.
 */
export const RESUME_GRACE_MS = 24 * 60 * 60 * 1000;

export type HealthLevel = "ok" | "warning" | "critical" | "insufficient_volume";

/** Cloudflare's account reputation status, when known. */
export type ProviderReputationStatus = "healthy" | "warning" | "at_risk" | "suspended" | string;

export interface SpamRateInput {
	complaints: number;
	delivered: number;
	minimumDelivered?: number;
	/** Cloudflare's account status; `warning` floors the level at warning, `at_risk`/`suspended` at critical. */
	providerStatus?: ProviderReputationStatus | null;
}

export interface SpamRateEvaluation {
	/** complaints / delivered, or null with nothing delivered. */
	rate: number | null;
	level: HealthLevel;
	complaints: number;
	delivered: number;
}

const RANK: Record<HealthLevel, number> = {
	insufficient_volume: 0,
	ok: 0,
	warning: 1,
	critical: 2,
};

export function levelRank(level: HealthLevel | null | undefined): number {
	return level ? RANK[level] : 0;
}

export function evaluateSpamRate(input: SpamRateInput): SpamRateEvaluation {
	const complaints = Math.max(0, Math.trunc(input.complaints || 0));
	const delivered = Math.max(0, Math.trunc(input.delivered || 0));
	const minimum = input.minimumDelivered ?? SPAM_RATE_MIN_DELIVERED;
	const rate = delivered > 0 ? complaints / delivered : null;

	let level: HealthLevel;
	if (delivered < minimum) level = "insufficient_volume";
	else if (rate !== null && rate > SPAM_RATE_PAUSE) level = "critical";
	else if (rate !== null && rate > SPAM_RATE_WARNING) level = "warning";
	else level = "ok";

	// The provider sees the whole account; its verdict can only make it worse.
	const status = (input.providerStatus ?? "").toLowerCase();
	if (status === "at_risk" || status === "suspended") level = "critical";
	else if (status === "warning" && levelRank(level) < RANK.warning) level = "warning";

	return { rate, level, complaints, delivered };
}

/** One sending domain's stored breaker state. */
export interface SendingDomainHealth {
	domain: string;
	level: HealthLevel;
	spam_rate: number | null;
	complaints: number;
	delivered: number;
	/** `local`, `cloudflare` or `local+cloudflare`: where the counts came from. */
	source: string | null;
	/** Cloudflare's account reputation status at evaluation time. */
	provider_status: string | null;
	evaluated_at: number | null;
	bulk_paused: boolean;
	paused_at: number | null;
	paused_reason: string | null;
	resumed_at: number | null;
	resumed_by: string | null;
	/** Highest level a webhook was sent for since the domain was last healthy. */
	notified_level: HealthLevel | null;
}

export function emptyDomainHealth(domain: string): SendingDomainHealth {
	return {
		domain,
		level: "ok",
		spam_rate: null,
		complaints: 0,
		delivered: 0,
		source: null,
		provider_status: null,
		evaluated_at: null,
		bulk_paused: false,
		paused_at: null,
		paused_reason: null,
		resumed_at: null,
		resumed_by: null,
		notified_level: null,
	};
}

export type HealthNotification = "warning" | "paused" | null;

/**
 * Apply one evaluation to the stored state.
 *
 * - Critical and not already paused (and not inside the resume grace period):
 *   pause bulk sends.
 * - The level rising above what was last notified: notify once. Falling back to
 *   ok clears the notified level, so a later relapse notifies again.
 * - A pause is never lifted here. Only an administrator resumes.
 */
export function nextDomainHealth(
	prev: SendingDomainHealth | null,
	evaluation: SpamRateEvaluation & { source: string; providerStatus?: string | null },
	now: number,
): { next: SendingDomainHealth; notify: HealthNotification } {
	const base = prev ?? emptyDomainHealth("");
	const next: SendingDomainHealth = {
		...base,
		level: evaluation.level,
		spam_rate: evaluation.rate,
		complaints: evaluation.complaints,
		delivered: evaluation.delivered,
		source: evaluation.source,
		provider_status: evaluation.providerStatus ?? null,
		evaluated_at: now,
	};

	let notify: HealthNotification = null;
	const inGrace = base.resumed_at !== null && now - base.resumed_at < RESUME_GRACE_MS;
	if (evaluation.level === "critical" && !base.bulk_paused && !inGrace) {
		next.bulk_paused = true;
		next.paused_at = now;
		// A new pause supersedes the last resume.
		next.resumed_at = null;
		next.resumed_by = null;
		next.paused_reason =
			evaluation.rate !== null && evaluation.rate > SPAM_RATE_PAUSE
				? `Spam complaint rate ${formatRate(evaluation.rate)} is above ${formatRate(SPAM_RATE_PAUSE)}`
				: `Cloudflare reputation is ${evaluation.providerStatus ?? "at risk"}`;
		notify = "paused";
		next.notified_level = "critical";
	} else if (levelRank(evaluation.level) > levelRank(base.notified_level)) {
		notify = evaluation.level === "critical" ? (next.bulk_paused ? "paused" : "warning") : "warning";
		next.notified_level = evaluation.level;
	} else if (evaluation.level === "ok") {
		next.notified_level = null;
	}
	return { next, notify };
}

/** `0.12%`, two decimals, for messages and the UI. */
export function formatRate(rate: number | null): string {
	if (rate === null || !Number.isFinite(rate)) return "n/a";
	return `${(rate * 100).toFixed(2)}%`;
}

/** Whether a stored state should show the in-app banner. */
export function needsAttention(row: Pick<SendingDomainHealth, "level" | "bulk_paused">): boolean {
	return row.bulk_paused || row.level === "warning" || row.level === "critical";
}
