// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-mailbox send caps: validation and maxima, storage (MailboxDO migration
 * 37) on real SQLite, usage counting, and the token-scope rule that makes
 * changing them admin-only.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_SEND_CAPS,
	MAX_DAILY_SEND_CAP,
	MAX_HOURLY_SEND_CAP,
	SendCapsPatchSchema,
	mergeSendCaps,
	normalizeStoredCaps,
} from "../shared/send-caps";
import { applyMigrations, mailboxMigrations } from "../workers/durableObject/migrations";
import { checkSendQuota, getSendCaps, getSendUsage, setSendCaps } from "../workers/durableObject/rate-limit";
import { requiredTokenScope } from "../workers/lib/token-scope-guard";

function ctx() {
	const db = new DatabaseSync(":memory:");
	const exec = (query: string, ...bindings: unknown[]) => {
		const trimmed = query.trim();
		if (bindings.length === 0 && !/^(select|with)/i.test(trimmed)) {
			db.exec(trimmed);
			return { toArray: () => [], rowsWritten: 0, [Symbol.iterator]: () => [][Symbol.iterator]() };
		}
		const rows = db.prepare(trimmed).all(...(bindings as never[])) as Record<string, unknown>[];
		return { toArray: () => rows, rowsWritten: 0, [Symbol.iterator]: () => rows[Symbol.iterator]() };
	};
	const state = { storage: { sql: { exec }, transactionSync: <T>(fn: () => T) => fn() } } as unknown as DurableObjectState;
	applyMigrations(state.storage.sql as unknown as SqlStorage, mailboxMigrations, state.storage as never);
	const sent = (n: number, at: Date) => {
		for (let i = 0; i < n; i++) {
			db.prepare(
				`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, read) VALUES (?, 'sent', 's', 'a@x.com', 'b@x.com', ?, '', 1)`,
			).run(`${at.getTime()}-${i}`, at.toISOString());
		}
	};
	return { state, sent };
}

describe("send cap validation", () => {
	it("defaults to 20/hour and 100/day", () => {
		expect(DEFAULT_SEND_CAPS).toEqual({ hourly: 20, daily: 100 });
	});

	it("enforces sane maxima and integers", () => {
		expect(SendCapsPatchSchema.safeParse({ hourly: MAX_HOURLY_SEND_CAP }).success).toBe(true);
		expect(SendCapsPatchSchema.safeParse({ hourly: MAX_HOURLY_SEND_CAP + 1 }).success).toBe(false);
		expect(SendCapsPatchSchema.safeParse({ daily: MAX_DAILY_SEND_CAP + 1 }).success).toBe(false);
		expect(SendCapsPatchSchema.safeParse({ daily: 0 }).success).toBe(false);
		expect(SendCapsPatchSchema.safeParse({ daily: 1.5 }).success).toBe(false);
		expect(SendCapsPatchSchema.safeParse({}).success).toBe(false);
		expect(SendCapsPatchSchema.safeParse({ hourly: 5, extra: 1 }).success).toBe(false);
	});

	it("refuses an hourly cap above the daily one", () => {
		expect(mergeSendCaps(DEFAULT_SEND_CAPS, { hourly: 200 })).toHaveProperty("error");
		expect(mergeSendCaps(DEFAULT_SEND_CAPS, { hourly: 50, daily: 400 })).toEqual({ hourly: 50, daily: 400 });
	});

	it("clamps a stored row it cannot trust", () => {
		expect(normalizeStoredCaps({ hourly_cap: 99999, daily_cap: -1 })).toEqual({ hourly: MAX_HOURLY_SEND_CAP, daily: 100 });
		expect(normalizeStoredCaps(null)).toEqual(DEFAULT_SEND_CAPS);
	});
});

describe("send caps in the mailbox (migration 37)", () => {
	it("is a named migration numbered 37", () => {
		expect(mailboxMigrations.map((m) => m.name)).toContain("37_add_send_limits");
	});

	it("reads defaults, stores new caps, and reports usage", () => {
		const { state, sent } = ctx();
		expect(getSendCaps(state)).toEqual({ caps: DEFAULT_SEND_CAPS, default: true });
		expect(setSendCaps(state, { hourly: 5, daily: 50 }, "usr_admin")).toEqual({ hourly: 5, daily: 50 });
		expect(getSendCaps(state)).toEqual({ caps: { hourly: 5, daily: 50 }, default: false });

		const now = new Date("2026-10-26T12:00:00.000Z");
		sent(3, new Date(now.getTime() - 10 * 60_000));
		sent(4, new Date(now.getTime() - 5 * 60 * 60_000));
		expect(getSendUsage(state, now)).toMatchObject({ sent_last_hour: 3, sent_last_day: 7, caps: { hourly: 5 } });
	});

	it("the quota honours the configured caps", () => {
		const { state, sent } = ctx();
		const now = new Date("2026-10-26T12:00:00.000Z");
		sent(5, new Date(now.getTime() - 60_000));
		const { caps } = getSendCaps(state);
		expect(checkSendQuota(state, { now, hourlyLimit: caps.hourly, dailyLimit: caps.daily })).toBeNull();
		setSendCaps(state, { hourly: 5, daily: 50 }, null);
		const next = getSendCaps(state).caps;
		expect(checkSendQuota(state, { now, hourlyLimit: next.hourly, dailyLimit: next.daily })).toContain("max 5 emails per hour");
	});
});

describe("send cap routes", () => {
	it("reading is mail:read; changing is admin-only", () => {
		expect(requiredTokenScope("GET", "/api/v1/mailboxes/a@x.com/send-limits")).toBe("mail:read");
		expect(requiredTokenScope("PUT", "/api/v1/mailboxes/a@x.com/send-limits")).toBe("admin");
		expect(requiredTokenScope("GET", "/api/v1/sending-health")).toBe("mail:read");
		expect(requiredTokenScope("POST", "/api/v1/sending-health/x.com/resume")).toBe("admin");
	});
});
