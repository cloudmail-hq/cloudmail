// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Retention purge: the period boundaries, bounded batches, the engagement
 * cache follow-up, the R2 audit log walk, and the policy bounds. Events run on
 * the real migrations over `node:sqlite`.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, mailboxMigrations } from "../workers/durableObject/migrations";
import { purgeExpiredEvents } from "../workers/durableObject/retention";
import { recomputeEngagement } from "../workers/durableObject/engagement";
import { purgeExpiredAudit, recordAudit } from "../workers/lib/audit";
import { retentionDue, RETENTION_INTERVAL_MS } from "../workers/lib/retention";
import {
	buildPrivacyNotice,
	DEFAULT_RETENTION,
	normalizePrivacySettings,
	normalizeRetention,
	retentionCutoff,
} from "../shared/privacy";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-26T12:00:00.000Z");

function sqlStorage(db: DatabaseSync): DurableObjectState {
	const exec = (query: string, ...bindings: unknown[]) => {
		const trimmed = query.trim();
		if (bindings.length === 0 && !/^(select|with)/i.test(trimmed)) {
			db.exec(trimmed);
			return { toArray: () => [], rowsWritten: 0, one: () => undefined, [Symbol.iterator]: () => [][Symbol.iterator]() };
		}
		const rows = db.prepare(trimmed).all(...(bindings as never[])) as Record<string, unknown>[];
		const changes = Number((db.prepare("SELECT changes() AS n").get() as { n: number }).n ?? 0);
		return {
			toArray: () => rows,
			rowsWritten: /^(select|with)/i.test(trimmed) ? 0 : changes,
			one: () => rows[0],
			[Symbol.iterator]: () => rows[Symbol.iterator](),
		};
	};
	return {
		storage: { sql: { exec }, transactionSync: <T>(fn: () => T) => fn() },
	} as unknown as DurableObjectState;
}

let db: DatabaseSync;
let ctx: DurableObjectState;

beforeEach(() => {
	db = new DatabaseSync(":memory:");
	ctx = sqlStorage(db);
	applyMigrations(ctx.storage.sql as unknown as SqlStorage, mailboxMigrations, ctx.storage as never);
	db.prepare(
		`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, read)
		 VALUES ('e1', 'sent', 'Hi', 'a@tapetide.com', 'b@example.org', '2025-01-01T00:00:00.000Z', '<p>x</p>', 1)`,
	).run();
});

function event(type: string, occurredAt: string, emailId = "e1") {
	db.prepare(
		`INSERT INTO delivery_events (email_id, event_type, source, occurred_at) VALUES (?, ?, 'pixel', ?)`,
	).run(emailId, type, occurredAt);
}
function n(type?: string): number {
	const row = (type
		? db.prepare(`SELECT COUNT(*) AS n FROM delivery_events WHERE event_type = ?`).get(type)
		: db.prepare(`SELECT COUNT(*) AS n FROM delivery_events`).get()) as { n: number };
	return Number(row.n);
}

const policy = { trackingEventsDays: 395, deliveryEventsDays: 395 };
const iso = (ms: number) => new Date(ms).toISOString();

describe("retentionCutoff", () => {
	it("keeps exactly N days", () => {
		expect(retentionCutoff(NOW, 30).toISOString()).toBe("2026-09-26T12:00:00.000Z");
	});
});

describe("event purge boundaries", () => {
	it("deletes rows strictly older than the cutoff and keeps the one exactly at it", () => {
		const cutoff = NOW - 395 * DAY;
		event("opened", iso(cutoff - 1)); // 1 ms too old
		event("opened", iso(cutoff)); // exactly at the boundary: kept
		event("opened", iso(cutoff + 1));
		const result = purgeExpiredEvents(ctx, policy, { now: NOW });
		expect(result).toEqual({ trackingEvents: 1, deliveryEvents: 0, more: false });
		expect(n("opened")).toBe(2);
	});

	it("applies each period to its own kind", () => {
		event("opened", iso(NOW - 40 * DAY));
		event("clicked", iso(NOW - 40 * DAY));
		event("delivered", iso(NOW - 40 * DAY));
		const result = purgeExpiredEvents(ctx, { trackingEventsDays: 30, deliveryEventsDays: 395 }, { now: NOW });
		expect(result.trackingEvents).toBe(2);
		expect(result.deliveryEvents).toBe(0);
		expect(n("delivered")).toBe(1);
	});

	it("works in bounded batches, oldest first, and reports more", () => {
		for (let i = 0; i < 7; i++) event("opened", iso(NOW - (500 + i) * DAY));
		const first = purgeExpiredEvents(ctx, policy, { now: NOW, batchSize: 3 });
		expect(first).toEqual({ trackingEvents: 3, deliveryEvents: 0, more: true });
		// Oldest went first: the three left-most remaining are the youngest.
		const left = db.prepare(`SELECT occurred_at FROM delivery_events ORDER BY occurred_at`).all() as {
			occurred_at: string;
		}[];
		expect(left[0].occurred_at).toBe(iso(NOW - 503 * DAY));
		purgeExpiredEvents(ctx, policy, { now: NOW, batchSize: 3 });
		const last = purgeExpiredEvents(ctx, policy, { now: NOW, batchSize: 3 });
		expect(last).toEqual({ trackingEvents: 1, deliveryEvents: 0, more: false });
		expect(n()).toBe(0);
	});

	it("recomputes the engagement cache for messages whose opens went", () => {
		event("opened", iso(NOW - 500 * DAY));
		event("opened", iso(NOW - 10 * DAY));
		recomputeEngagement(ctx, "e1");
		expect((db.prepare(`SELECT open_count FROM emails WHERE id='e1'`).get() as { open_count: number }).open_count).toBe(2);
		purgeExpiredEvents(ctx, policy, { now: NOW });
		const row = db.prepare(`SELECT open_count, opened_at FROM emails WHERE id='e1'`).get() as {
			open_count: number;
			opened_at: string;
		};
		expect(row.open_count).toBe(1);
		expect(row.opened_at).toBe(iso(NOW - 10 * DAY));
	});
});

// ── audit log in R2 ─────────────────────────────────────────────────

function fakeBucket() {
	const store = new Map<string, string>();
	return {
		store,
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async delete(keys: string | string[]) {
			for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
		},
		async list(opts: { prefix?: string; delimiter?: string; startAfter?: string; limit?: number; cursor?: string }) {
			const prefix = opts.prefix ?? "";
			const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
			if (opts.delimiter) {
				const prefixes = [
					...new Set(
						all
							.map((k) => k.slice(prefix.length))
							.filter((rest) => rest.includes(opts.delimiter!))
							.map((rest) => prefix + rest.slice(0, rest.indexOf(opts.delimiter!) + 1)),
					),
				];
				return { objects: [], delimitedPrefixes: prefixes, truncated: false };
			}
			const after = all.filter((k) => !opts.startAfter || k > opts.startAfter);
			const limit = opts.limit ?? 1000;
			return {
				objects: after.slice(0, limit).map((key) => ({ key })),
				truncated: after.length > limit,
				delimitedPrefixes: [],
			};
		},
	};
}

async function auditAt(bucket: ReturnType<typeof fakeBucket>, ms: number, mailboxId: string | null) {
	const real = Date.now;
	Date.now = () => ms;
	try {
		await recordAudit(bucket as unknown as R2Bucket, {
			action: "mail.send",
			actor: "a@tapetide.com",
			actorRole: "owner",
			mailboxId,
		});
	} finally {
		Date.now = real;
	}
}

describe("audit log purge", () => {
	it("removes entries older than the cutoff in every scope and keeps the rest", async () => {
		const bucket = fakeBucket();
		const cutoff = NOW - 365 * DAY;
		await auditAt(bucket, cutoff - DAY, "support@tapetide.com");
		await auditAt(bucket, cutoff - 1, null);
		await auditAt(bucket, cutoff + DAY, "support@tapetide.com");
		await auditAt(bucket, NOW, null);
		const result = await purgeExpiredAudit(bucket as unknown as R2Bucket, cutoff);
		expect(result).toEqual({ deleted: 2, more: false });
		expect(bucket.store.size).toBe(2);
	});

	it("stops at maxDeletes and reports more", async () => {
		const bucket = fakeBucket();
		for (let i = 0; i < 5; i++) await auditAt(bucket, NOW - (400 + i) * DAY, "support@tapetide.com");
		const first = await purgeExpiredAudit(bucket as unknown as R2Bucket, NOW - 365 * DAY, { maxDeletes: 3 });
		expect(first).toEqual({ deleted: 3, more: true });
		const rest = await purgeExpiredAudit(bucket as unknown as R2Bucket, NOW - 365 * DAY, { maxDeletes: 3 });
		expect(rest).toEqual({ deleted: 2, more: false });
	});
});

describe("policy", () => {
	it("defaults: 13 months of events, 90 days of chat, 1 year of audit, 30 days of trash", () => {
		expect(DEFAULT_RETENTION).toEqual({
			trackingEventsDays: 395,
			deliveryEventsDays: 395,
			agentChatDays: 90,
			auditLogDays: 365,
			trashDays: 30,
		});
	});

	it("clamps out-of-range values; the audit log never drops below a year", () => {
		expect(normalizeRetention({ auditLogDays: 30, trashDays: 9999, agentChatDays: -5 })).toMatchObject({
			auditLogDays: 365,
			trashDays: 365,
			agentChatDays: 1,
		});
		expect(normalizeRetention("junk")).toEqual(DEFAULT_RETENTION);
	});

	it("runs a pass once a day, and continues an unfinished one", () => {
		expect(retentionDue({ lastCompletedAt: NOW - RETENTION_INTERVAL_MS + 1, inProgress: null }, NOW)).toBe(false);
		expect(retentionDue({ lastCompletedAt: NOW - RETENTION_INTERVAL_MS, inProgress: null }, NOW)).toBe(true);
		expect(
			retentionDue({ lastCompletedAt: NOW, inProgress: { startedAt: NOW, nextMailbox: 25, auditDone: false } }, NOW),
		).toBe(true);
	});

	it("the notice prints the periods the purge enforces", () => {
		const settings = normalizePrivacySettings({ retention: { agentChatDays: 60 } });
		const text = JSON.stringify(buildPrivacyNotice(settings, { appName: "cloudmail" }));
		expect(text).toContain("AI assistant conversations: 60 days.");
		expect(text).toContain("Open, click and download events: 13 months.");
		expect(text).toContain("Audit log: 1 year.");
		expect(text).toContain("Trash: 30 days");
	});
});
