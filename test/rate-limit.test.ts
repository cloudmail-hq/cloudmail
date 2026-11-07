// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Outbound send quota.
 *
 * The bug these tests exist to prevent: the cutoff used to come from SQLite's
 * `datetime('now', '-1 hour')`, which formats as `YYYY-MM-DD HH:MM:SS`, while
 * `emails.date` holds ISO 8601 with a `'T'` separator. Compared as TEXT, `'T'`
 * (0x54) sorts above `' '` (0x20), so every row from the same UTC day satisfied
 * "within the last hour" and the hourly limit silently became a daily one.
 *
 * So the assertions are mostly about the *shape* of the cutoff: it has to be an
 * ISO string an hour (or a day) before now, comparable to what the send paths
 * write.
 */

import { describe, expect, it } from "vitest";
import {
	DAILY_SEND_LIMIT,
	HOURLY_SEND_LIMIT,
	checkSendQuota,
} from "../workers/durableObject/rate-limit";
import { Folders } from "../shared/folders";

/**
 * Fake `DurableObjectState` that answers each COUNT with the next queued value
 * and records the SQL and bound params for inspection.
 */
function fakeCtx(counts: number[] = []) {
	const queued = [...counts];
	const calls: { sql: string; params: unknown[] }[] = [];

	const ctx = {
		storage: {
			sql: {
				exec(sql: string, ...params: unknown[]) {
					calls.push({ sql, params });
					const cnt = queued.shift() ?? 0;
					return { toArray: () => [{ cnt }], rowsWritten: 0 };
				},
			},
			transactionSync: <T>(fn: () => T) => fn(),
		},
	};

	return { ctx: ctx as unknown as DurableObjectState, calls };
}

const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

const now = new Date("2026-06-01T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe("checkSendQuota", () => {
	it("counts only the Sent folder", () => {
		const { ctx, calls } = fakeCtx([0, 0]);
		checkSendQuota(ctx, { now });

		expect(calls[0].params[0]).toBe(Folders.SENT);
		expect(flat(calls[0].sql)).toContain("folder_id = ?1");
	});

	it("compares against an ISO cutoff, never SQLite's own clock", () => {
		const { ctx, calls } = fakeCtx([0, 0]);
		checkSendQuota(ctx, { now });

		for (const call of calls) {
			// The regression: any use of datetime()/date() here reintroduces the
			// TEXT-comparison mismatch with the ISO values the send paths write.
			expect(flat(call.sql)).not.toContain("datetime(");
			expect(flat(call.sql)).toContain("date >= ?2");
			expect(call.params[1]).toMatch(
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
			);
		}
	});

	it("uses a rolling one-hour window for the hourly check", () => {
		const { ctx, calls } = fakeCtx([0, 0]);
		checkSendQuota(ctx, { now });

		expect(calls[0].params[1]).toBe(
			new Date(now.getTime() - HOUR_MS).toISOString(),
		);
	});

	it("uses a rolling one-day window for the daily check", () => {
		const { ctx, calls } = fakeCtx([0, 0]);
		checkSendQuota(ctx, { now });

		expect(calls[1].params[1]).toBe(
			new Date(now.getTime() - DAY_MS).toISOString(),
		);
	});

	it("does not count a message sent earlier the same day against the hour", () => {
		// The heart of the old bug. 09:00 is three hours before `now`, so it is
		// outside the hourly window but inside the same UTC day. The cutoff must
		// exclude it, which it does precisely because both sides are ISO.
		const { ctx, calls } = fakeCtx([0, 0]);
		checkSendQuota(ctx, { now });

		const hourCutoff = calls[0].params[1] as string;
		expect("2026-06-01T09:00:00.000Z" >= hourCutoff).toBe(false);
		expect("2026-06-01T11:30:00.000Z" >= hourCutoff).toBe(true);
	});

	it("allows sending while under both limits", () => {
		const { ctx } = fakeCtx([HOURLY_SEND_LIMIT - 1, DAILY_SEND_LIMIT - 1]);
		expect(checkSendQuota(ctx, { now })).toBeNull();
	});

	it("refuses once the hourly limit is reached", () => {
		const { ctx } = fakeCtx([HOURLY_SEND_LIMIT, 0]);
		expect(checkSendQuota(ctx, { now })).toBe(
			`Rate limit exceeded: max ${HOURLY_SEND_LIMIT} emails per hour per mailbox`,
		);
	});

	it("refuses once the daily limit is reached, even when the hour is quiet", () => {
		const { ctx } = fakeCtx([0, DAILY_SEND_LIMIT]);
		expect(checkSendQuota(ctx, { now })).toBe(
			`Rate limit exceeded: max ${DAILY_SEND_LIMIT} emails per day per mailbox`,
		);
	});

	it("short-circuits: an over-quota hour never runs the daily query", () => {
		const { ctx, calls } = fakeCtx([HOURLY_SEND_LIMIT, 0]);
		checkSendQuota(ctx, { now });
		expect(calls).toHaveLength(1);
	});

	it("honours custom limits, so callers can tighten a mailbox", () => {
		const { ctx } = fakeCtx([5, 0]);
		expect(checkSendQuota(ctx, { now, hourlyLimit: 5 })).toContain("max 5");
		const second = fakeCtx([0, 9]);
		expect(checkSendQuota(second.ctx, { now, dailyLimit: 9 })).toContain("max 9");
	});
});
