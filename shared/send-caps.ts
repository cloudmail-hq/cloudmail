// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-mailbox outbound send caps: defaults, bounds and validation.
 *
 * The caps used to be constants (20 an hour, 100 a day). They are now per
 * mailbox, admin-editable, and bounded by maxima that keep one mailbox from
 * spending the whole Cloudflare account quota (5,000 a day on a new account)
 * or looking like a compromised sender.
 *
 * Counted exactly by the mailbox's Durable Object over rolling windows; see
 * `workers/durableObject/rate-limit.ts`.
 */

import { z } from "zod";

export const DEFAULT_HOURLY_SEND_CAP = 20;
export const DEFAULT_DAILY_SEND_CAP = 100;

/** Highest hourly cap an administrator may set. */
export const MAX_HOURLY_SEND_CAP = 1_000;
/** Highest daily cap an administrator may set. */
export const MAX_DAILY_SEND_CAP = 10_000;

export interface SendCaps {
	hourly: number;
	daily: number;
}

export interface SendUsage {
	caps: SendCaps;
	/** True when the caps are the defaults (no row stored). */
	default: boolean;
	sent_last_hour: number;
	sent_last_day: number;
}

export const DEFAULT_SEND_CAPS: SendCaps = {
	hourly: DEFAULT_HOURLY_SEND_CAP,
	daily: DEFAULT_DAILY_SEND_CAP,
};

export const SendCapsPatchSchema = z
	.object({
		hourly: z.number().int().min(1).max(MAX_HOURLY_SEND_CAP).optional(),
		daily: z.number().int().min(1).max(MAX_DAILY_SEND_CAP).optional(),
	})
	.strict()
	.refine((v) => v.hourly !== undefined || v.daily !== undefined, {
		message: "Set hourly, daily or both",
	});

export type SendCapsPatch = z.infer<typeof SendCapsPatchSchema>;

/**
 * Merge a patch over the current caps and check the result is coherent: an
 * hourly cap above the daily one can never be reached and almost always means
 * the two numbers were swapped.
 */
export function mergeSendCaps(current: SendCaps, patch: SendCapsPatch): SendCaps | { error: string } {
	const next = { hourly: patch.hourly ?? current.hourly, daily: patch.daily ?? current.daily };
	if (next.hourly > next.daily) {
		return { error: `The hourly cap (${next.hourly}) cannot be above the daily cap (${next.daily}).` };
	}
	return next;
}

/** Clamp a stored value read back from SQLite into the allowed range. */
export function normalizeStoredCaps(row: { hourly_cap?: unknown; daily_cap?: unknown } | null | undefined): SendCaps {
	const clamp = (value: unknown, fallback: number, max: number) => {
		const n = Number(value);
		return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
	};
	return {
		hourly: clamp(row?.hourly_cap, DEFAULT_HOURLY_SEND_CAP, MAX_HOURLY_SEND_CAP),
		daily: clamp(row?.daily_cap, DEFAULT_DAILY_SEND_CAP, MAX_DAILY_SEND_CAP),
	};
}
