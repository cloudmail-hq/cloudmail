// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Outbound send quota for a mailbox.
 *
 * Split out of `MailboxDO` so the window arithmetic is testable without
 * standing up a Durable Object, matching the style of ./trash.ts.
 *
 * ## Why the cutoffs are computed in JS
 *
 * This previously compared the stored timestamp against SQLite's own clock:
 *
 *     WHERE date >= datetime('now', '-1 hour')
 *
 * `emails.date` holds ISO 8601 (`2026-08-16T09:00:00.000Z`, always UTC — see
 * `resolveMessageDate`), while `datetime()` returns `2026-08-16 08:00:00`.
 * SQLite compares those as TEXT, and `'T'` (0x54) sorts above `' '` (0x20), so
 * every row whose *date part* was at or after the cutoff's date part passed the
 * test regardless of its time. The hourly limit therefore behaved as a daily
 * one, and the daily limit as "since yesterday at the earliest".
 *
 * Passing an ISO cutoff computed from the same clock the rows were written with
 * makes both sides the same shape, so the comparison is exact. It also keeps
 * `idx_emails_folder_date` usable, which `datetime(date)` on the column would
 * not.
 */

import { Folders } from "../../shared/folders";
import {
	DEFAULT_DAILY_SEND_CAP,
	DEFAULT_HOURLY_SEND_CAP,
	normalizeStoredCaps,
	type SendCaps,
	type SendUsage,
} from "../../shared/send-caps";

/** Default messages a mailbox may send in a rolling hour (configurable). */
export const HOURLY_SEND_LIMIT = DEFAULT_HOURLY_SEND_CAP;

/** Default messages a mailbox may send in a rolling day (configurable). */
export const DAILY_SEND_LIMIT = DEFAULT_DAILY_SEND_CAP;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface SendQuotaOptions {
	now?: Date;
	hourlyLimit?: number;
	dailyLimit?: number;
}

/** Count messages filed in Sent at or after `cutoffIso`. */
function countSentSince(ctx: DurableObjectState, cutoffIso: string): number {
	const row = ctx.storage.sql
		.exec(
			`SELECT COUNT(*) AS cnt FROM emails
			  WHERE folder_id = ?1
			    AND date >= ?2
			    AND imported = 0`,
			Folders.SENT,
			cutoffIso,
		)
		.toArray()[0] as { cnt: number } | undefined;

	return row?.cnt ?? 0;
}

/**
 * Whether this mailbox may send right now.
 *
 * @returns null when under quota, or a user-facing message when over it.
 */
export function checkSendQuota(
	ctx: DurableObjectState,
	options: SendQuotaOptions = {},
): string | null {
	const now = options.now ?? new Date();
	// The configured caps are read by the caller (`getSendCaps`) and passed in,
	// so this function only counts.
	const hourlyLimit = options.hourlyLimit ?? HOURLY_SEND_LIMIT;
	const dailyLimit = options.dailyLimit ?? DAILY_SEND_LIMIT;

	const sentThisHour = countSentSince(
		ctx,
		new Date(now.getTime() - HOUR_MS).toISOString(),
	);
	if (sentThisHour >= hourlyLimit) {
		return `Rate limit exceeded: max ${hourlyLimit} emails per hour per mailbox`;
	}

	const sentToday = countSentSince(
		ctx,
		new Date(now.getTime() - DAY_MS).toISOString(),
	);
	if (sentToday >= dailyLimit) {
		return `Rate limit exceeded: max ${dailyLimit} emails per day per mailbox`;
	}

	return null;
}

/**
 * The mailbox's configured caps (migration 37), or the defaults when none are
 * stored. A table that does not exist yet (a test harness that skipped the
 * migration) also reads as the defaults.
 */
export function getSendCaps(ctx: DurableObjectState): { caps: SendCaps; default: boolean } {
	try {
		const row = ctx.storage.sql
			.exec(`SELECT hourly_cap, daily_cap FROM send_limits WHERE id = 1`)
			.toArray()[0] as { hourly_cap: number; daily_cap: number } | undefined;
		return { caps: normalizeStoredCaps(row), default: !row };
	} catch {
		return { caps: normalizeStoredCaps(null), default: true };
	}
}

/** Store new caps. The caller has validated them (`mergeSendCaps`). */
export function setSendCaps(
	ctx: DurableObjectState,
	caps: SendCaps,
	updatedBy: string | null,
	now = new Date(),
): SendCaps {
	ctx.storage.sql.exec(
		`INSERT INTO send_limits (id, hourly_cap, daily_cap, updated_at, updated_by)
		 VALUES (1, ?1, ?2, ?3, ?4)
		 ON CONFLICT(id) DO UPDATE SET hourly_cap = ?1, daily_cap = ?2, updated_at = ?3, updated_by = ?4`,
		caps.hourly,
		caps.daily,
		now.toISOString(),
		updatedBy,
	);
	return getSendCaps(ctx).caps;
}

/** Caps plus what has been sent against them, for the settings screen. */
export function getSendUsage(ctx: DurableObjectState, now = new Date()): SendUsage {
	const { caps, default: isDefault } = getSendCaps(ctx);
	return {
		caps,
		default: isDefault,
		sent_last_hour: countSentSince(ctx, new Date(now.getTime() - HOUR_MS).toISOString()),
		sent_last_day: countSentSince(ctx, new Date(now.getTime() - DAY_MS).toISOString()),
	};
}
