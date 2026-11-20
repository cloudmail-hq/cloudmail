// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-provider circuit breaker for AI calls.
 *
 * ## Design
 *
 * State lives in each isolate (a `Map` per provider id), because the calls
 * that need protecting (DO alarms, the agent, request handlers) run in many
 * isolates and a per-call round trip to shared storage would cost more than
 * the failures it saves. On top of that, one lightweight shared flag:
 *
 * - When an isolate opens a provider's breaker it writes
 *   `ai/breaker/<id>.json` = `{ openUntil }` to R2 (fire and forget).
 * - An isolate whose local breaker is closed reads that flag at most once per
 *   `SHARED_FLAG_TTL_MS` per provider, and treats an unexpired flag as open.
 *
 * So one isolate's discovery that a gateway is down reaches the others within
 * about 30 s, at the cost of one R2 read per provider per isolate per 30 s and
 * one write per opening. The flag is advisory: a missing or stale one only
 * means a few extra failed calls, and a flag never outlives `openUntil`.
 *
 * ## States
 *
 * - closed: calls pass. `failureThreshold` consecutive failures (or one
 *   auth failure, 401/403) open it.
 * - open: calls fail fast with `AiCircuitOpenError` until `openUntil`.
 * - half-open: after `openUntil`, exactly one trial call passes; the rest fail
 *   fast while it runs. Success closes the breaker, failure re-opens it for
 *   another `openMs`. A trial that never reports back is given up on after
 *   `openMs`, so a lost verdict cannot hold the breaker shut. A streamed call
 *   is judged when its stream ends (see the router's middleware).
 *
 * The router applies this to gateway providers only. Workers AI is the
 * in-network default and keeps today's behaviour: every call is attempted.
 */

export const BREAKER_FAILURE_THRESHOLD = 5;
export const BREAKER_OPEN_MS = 5 * 60_000;
export const SHARED_FLAG_TTL_MS = 30_000;
const FLAG_PREFIX = "ai/breaker/";

export class AiCircuitOpenError extends Error {
	constructor(readonly providerId: string) {
		super(`AI provider ${providerId} is paused after repeated failures`);
		this.name = "AiCircuitOpenError";
	}
}

export type BreakerState = "closed" | "open" | "half-open";

interface Entry {
	failures: number;
	openUntil: number;
	trialInFlight: boolean;
	trialStartedAt: number;
	flagCheckedAt: number;
}

/** Shared storage for the cross-isolate flag. */
export interface BreakerFlagStore {
	read(providerId: string): Promise<number | null>;
	write(providerId: string, openUntil: number): Promise<void>;
}

export function r2BreakerFlags(bucket: Pick<R2Bucket, "get" | "put"> | undefined | null): BreakerFlagStore | null {
	if (!bucket || typeof bucket.get !== "function" || typeof bucket.put !== "function") return null;
	return {
		async read(id) {
			const obj = await bucket.get(`${FLAG_PREFIX}${id}.json`);
			if (!obj) return null;
			const v = (await obj.json()) as { openUntil?: unknown } | null;
			return typeof v?.openUntil === "number" ? v.openUntil : null;
		},
		async write(id, openUntil) {
			await bucket.put(`${FLAG_PREFIX}${id}.json`, JSON.stringify({ openUntil }));
		},
	};
}

/** True for errors that mean the credentials are wrong, not that the provider is busy. */
function isAuthFailure(e: unknown): boolean {
	const status = (e as { statusCode?: unknown; status?: unknown } | null)?.statusCode ?? (e as { status?: unknown } | null)?.status;
	return status === 401 || status === 403;
}

export class CircuitBreaker {
	readonly #entries = new Map<string, Entry>();
	readonly #threshold: number;
	readonly #openMs: number;
	readonly #now: () => number;

	constructor(options: { failureThreshold?: number; openMs?: number; now?: () => number } = {}) {
		this.#threshold = options.failureThreshold ?? BREAKER_FAILURE_THRESHOLD;
		this.#openMs = options.openMs ?? BREAKER_OPEN_MS;
		this.#now = options.now ?? Date.now;
	}

	#entry(id: string): Entry {
		let e = this.#entries.get(id);
		if (!e) {
			e = { failures: 0, openUntil: 0, trialInFlight: false, trialStartedAt: 0, flagCheckedAt: -Infinity };
			this.#entries.set(id, e);
		}
		return e;
	}

	state(id: string): BreakerState {
		const e = this.#entries.get(id);
		if (!e || e.openUntil === 0) return "closed";
		return this.#now() < e.openUntil ? "open" : "half-open";
	}

	/**
	 * Ask to make one call. Throws `AiCircuitOpenError` when the call must not
	 * be made. Every admitted call must be followed by `success` or `failure`.
	 */
	async admit(id: string, flags?: BreakerFlagStore | null): Promise<{ trial: boolean }> {
		const e = this.#entry(id);
		const now = this.#now();
		if (e.openUntil === 0 && flags && now - e.flagCheckedAt >= SHARED_FLAG_TTL_MS) {
			e.flagCheckedAt = now;
			try {
				const until = await flags.read(id);
				if (until !== null && until > now) e.openUntil = until;
			} catch {
				// Advisory only.
			}
		}
		const state = this.state(id);
		if (state === "closed") return { trial: false };
		// A trial that never reported back (its isolate work was cut off, say)
		// must not hold the breaker shut forever: after `openMs`, try again.
		if (e.trialInFlight && now - e.trialStartedAt >= this.#openMs) e.trialInFlight = false;
		if (state === "open" || e.trialInFlight) throw new AiCircuitOpenError(id);
		e.trialInFlight = true; // half-open: this call is the trial
		e.trialStartedAt = now;
		return { trial: true };
	}

	/**
	 * An admitted call ended without a verdict (the caller abandoned it). Frees
	 * the half-open slot if that call was the trial; any other call has nothing
	 * to free, and must not free someone else's trial.
	 */
	release(id: string, admitted: { trial: boolean }): void {
		if (admitted.trial) this.#entry(id).trialInFlight = false;
	}

	success(id: string): void {
		const e = this.#entry(id);
		e.failures = 0;
		e.openUntil = 0;
		e.trialInFlight = false;
	}

	failure(id: string, error?: unknown, flags?: BreakerFlagStore | null): void {
		const e = this.#entry(id);
		const wasTrial = e.trialInFlight;
		e.trialInFlight = false;
		e.failures++;
		if (wasTrial || e.failures >= this.#threshold || isAuthFailure(error)) {
			e.openUntil = this.#now() + this.#openMs;
			const until = e.openUntil;
			if (flags) void flags.write(id, until).catch(() => {});
		}
	}

	/** Test hook. */
	reset(): void {
		this.#entries.clear();
	}
}

/** The isolate's breaker, shared by every router call. */
export const aiBreaker = new CircuitBreaker();
