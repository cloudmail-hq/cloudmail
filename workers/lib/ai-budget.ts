// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * A wall-clock budget for the AI work in one mailbox alarm run.
 *
 * The post-ingest alarm runs triage, push, summaries and semantic indexing,
 * each bounded by a batch count. Batch counts bound the number of calls, not
 * their latency: a slow provider can stretch one run far past what anyone
 * expects of an alarm. Each drain loop asks `exhausted()` before starting the
 * next item and stops when the budget is spent; whatever is left stays queued
 * and the alarm re-arms for it, as it already does for a full batch.
 *
 * Per-call timeouts (`ROLE_TIMEOUTS` in ./ai-router.ts) bound how far past the
 * budget the last item can run.
 */

/** Stop starting AI work in an alarm run after this much wall time. */
export const ALARM_AI_BUDGET_MS = 25_000;

export class AiWorkBudget {
	readonly #deadline: number;
	readonly #now: () => number;

	constructor(ms: number = ALARM_AI_BUDGET_MS, now: () => number = Date.now) {
		this.#now = now;
		this.#deadline = now() + ms;
	}

	remainingMs(): number {
		return Math.max(0, this.#deadline - this.#now());
	}

	/** True once the budget is spent: start no more items. */
	exhausted(): boolean {
		return this.#now() >= this.#deadline;
	}
}
