// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The analytics DO reads (`workers/durableObject/analytics.ts`) against real
 * SQLite with the production migrations applied, so a column the queries
 * reference but the schema lacks fails here.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { getEngagement, getInboundStats, getSendingStats } from "../workers/durableObject/analytics";
import { applyMigrations, mailboxMigrations } from "../workers/durableObject/migrations";

function sqlStorage(db: DatabaseSync): DurableObjectState {
	const exec = (query: string, ...bindings: unknown[]) => {
		const trimmed = query.trim();
		if (/^(select|with)/i.test(trimmed)) {
			const rows = db.prepare(trimmed).all(...(bindings as never[])) as Record<string, unknown>[];
			return { toArray: () => rows, rowsWritten: 0, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
		}
		if (bindings.length === 0) {
			db.exec(trimmed);
			return { toArray: () => [], rowsWritten: 0, one: () => undefined, [Symbol.iterator]: () => [][Symbol.iterator]() };
		}
		const info = db.prepare(trimmed).run(...(bindings as never[]));
		return { toArray: () => [], rowsWritten: Number(info.changes ?? 0), one: () => undefined, [Symbol.iterator]: () => [][Symbol.iterator]() };
	};
	return { storage: { sql: { exec }, transactionSync: <T>(fn: () => T) => fn() } } as unknown as DurableObjectState;
}

let db: DatabaseSync;
let ctx: DurableObjectState;
const WINDOW = { start: "2026-10-19T00:00:00.000Z", end: "2026-10-26T06:00:00.000Z" };

function email(id: string, folder: string, date: string, extra: Record<string, string | null> = {}) {
	const cols = { id, folder_id: folder, subject: `Subject ${id}`, sender: "support@example.com", recipient: "a@example.org", date, body: "", ...extra };
	const keys = Object.keys(cols);
	db.prepare(`INSERT INTO emails (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(
		...(Object.values(cols) as never[]),
	);
}

function event(emailId: string, type: string, at: string, extra: { recipient?: string | null; metadata?: unknown; cause?: string; detail?: string } = {}) {
	db.prepare(
		`INSERT INTO delivery_events (email_id, recipient, event_type, source, error_cause, error_detail, metadata, occurred_at)
		 VALUES (?, ?, ?, 'send', ?, ?, ?, ?)`,
	).run(
		emailId,
		extra.recipient === undefined ? "a@example.org" : extra.recipient,
		type,
		extra.cause ?? null,
		extra.detail ?? null,
		extra.metadata ? JSON.stringify(extra.metadata) : null,
		at,
	);
}

beforeEach(() => {
	db = new DatabaseSync(":memory:");
	ctx = sqlStorage(db);
	applyMigrations(ctx.storage.sql as unknown as SqlStorage, mailboxMigrations, ctx.storage as never);
});

describe("getSendingStats", () => {
	it("counts only terminal verdicts as delivered; queued/sent/NULL are pending", () => {
		// Three sends: one delivered, one only `sent` (legacy route called it delivered), one bounced.
		email("m1", "sent", "2026-10-20T10:00:00.000Z");
		email("m2", "sent", "2026-10-21T10:00:00.000Z");
		email("m3", "sent", "2026-10-21T11:00:00.000Z");
		event("m1", "sent", "2026-10-20T10:00:01.000Z");
		event("m1", "delivered", "2026-10-20T10:01:00.000Z");
		event("m2", "sent", "2026-10-21T10:00:01.000Z");
		event("m3", "sent", "2026-10-21T11:00:01.000Z");
		event("m3", "bounced", "2026-10-21T11:05:00.000Z", { cause: "recipient", detail: "550 5.1.1 no such user" });
		const stats = getSendingStats(ctx, WINDOW);
		expect(stats).toMatchObject({ sent: 3, delivered: 1, bounced: 1, failed: 0, rejected: 0, pending: 1 });
		expect(stats.errors).toEqual([
			{ cause: "bounced", bucket: "recipient", count: 1, example: "550 5.1.1 no such user", last_seen: "2026-10-21T11:05:00.000Z" },
		]);
		expect(stats.by_date).toEqual([
			{ date: "2026-10-20", sent: 1, delivered: 1, bounced: 0, failed: 0 },
			{ date: "2026-10-21", sent: 2, delivered: 0, bounced: 1, failed: 0 },
		]);
	});

	it("latest terminal wins; a complaint counts as delivered plus a complaint", () => {
		email("m1", "sent", "2026-10-20T10:00:00.000Z");
		event("m1", "failed", "2026-10-20T10:00:01.000Z");
		event("m1", "delivered", "2026-10-20T10:05:00.000Z");
		email("m2", "archive", "2026-10-20T11:00:00.000Z"); // moved out of Sent; still in cohort via `sent` event
		event("m2", "sent", "2026-10-20T11:00:01.000Z");
		event("m2", "delivered", "2026-10-20T11:01:00.000Z");
		event("m2", "complained", "2026-10-22T00:00:00.000Z");
		const stats = getSendingStats(ctx, WINDOW);
		expect(stats).toMatchObject({ sent: 2, delivered: 2, failed: 0, complaints: 1 });
	});

	it("adds scheduled sends to pending and soft bounces to soft_bounced", () => {
		email("s1", "scheduled", "2026-10-27T00:00:00.000Z");
		email("m1", "sent", "2026-10-20T10:00:00.000Z");
		event("m1", "soft_bounced", "2026-10-20T10:01:00.000Z");
		const stats = getSendingStats(ctx, WINDOW);
		expect(stats).toMatchObject({ sent: 1, pending: 2, soft_bounced: 1, delivered: 0 });
	});

	it("excludes messages outside the window", () => {
		email("old", "sent", "2026-10-01T00:00:00.000Z");
		event("old", "delivered", "2026-10-01T00:01:00.000Z");
		expect(getSendingStats(ctx, WINDOW).sent).toBe(0);
	});
});

describe("getEngagement", () => {
	beforeEach(() => {
		email("m1", "sent", "2026-10-20T10:00:00.000Z", { recipient: "a@example.org, b@example.org", cc: "c@example.org" });
		email("m2", "sent", "2026-10-22T10:00:00.000Z");
		email("in1", "inbox", "2026-10-22T10:00:00.000Z"); // not outbound
		event("m1", "delivered", "2026-10-20T10:01:00.000Z");
		event("m2", "delivered", "2026-10-22T10:01:00.000Z");
		// m1: a opens twice, b once; a clicks the same link twice, b clicks another.
		event("m1", "opened", "2026-10-20T12:00:00.000Z", { recipient: "a@example.org" });
		event("m1", "opened", "2026-10-21T12:00:00.000Z", { recipient: "a@example.org" });
		event("m1", "opened", "2026-10-20T11:00:00.000Z", { recipient: "b@example.org" });
		event("m1", "clicked", "2026-10-20T12:01:00.000Z", { recipient: "a@example.org", metadata: { url: "https://example.com/a" } });
		event("m1", "clicked", "2026-10-20T12:02:00.000Z", { recipient: "a@example.org", metadata: { url: "https://example.com/a" } });
		event("m1", "clicked", "2026-10-20T12:03:00.000Z", { recipient: "b@example.org", metadata: { url: "https://example.com/b" } });
		// m2: a message-level pixel (NULL recipient) counts as one opener, opened after the window ends.
		event("m2", "opened", "2026-10-27T00:00:00.000Z", { recipient: null });
		event("m2", "clicked", "2026-10-22T13:00:00.000Z", { recipient: null, metadata: { url: "https://example.com/a" } });
	});

	it("totals opens, unique opens and clicks over the cohort", () => {
		const e = getEngagement(ctx, WINDOW);
		expect(e).toMatchObject({
			sent: 2,
			delivered: 2,
			opens: 4,
			opened_messages: 2,
			unique_opens: 3,
			clicks: 4,
			clicked_messages: 2,
			unique_clicks: 3,
		});
	});

	it("lists messages newest first with recipients and first open", () => {
		const e = getEngagement(ctx, WINDOW);
		expect(e.messages.map((m) => m.email_id)).toEqual(["m2", "m1"]);
		expect(e.messages[1]).toEqual({
			email_id: "m1",
			subject: "Subject m1",
			sent_at: "2026-10-20T10:00:00.000Z",
			recipients: 3,
			opens: 3,
			unique_opens: 2,
			clicks: 3,
			unique_clicks: 2,
			first_open_at: "2026-10-20T11:00:00.000Z",
			outcome: "delivered",
		});
	});

	it("aggregates links by URL across messages", () => {
		const e = getEngagement(ctx, WINDOW);
		expect(e.links).toEqual([
			{ url: "https://example.com/a", clicks: 3, unique_clicks: 2, messages: 2 },
			{ url: "https://example.com/b", clicks: 1, unique_clicks: 1, messages: 1 },
		]);
	});

	it("respects the limit and returns zeros for an empty mailbox", () => {
		// Both messages were engaged with, so both stay even past the limit.
		expect(getEngagement(ctx, WINDOW, 1).messages.map((m) => m.email_id)).toEqual(["m2", "m1"]);
		expect(getEngagement(ctx, WINDOW, 0).messages).toHaveLength(0);
		const fresh = new DatabaseSync(":memory:");
		const freshCtx = sqlStorage(fresh);
		applyMigrations(freshCtx.storage.sql as unknown as SqlStorage, mailboxMigrations, freshCtx.storage as never);
		expect(getEngagement(freshCtx, WINDOW)).toMatchObject({ sent: 0, opens: 0, messages: [], links: [] });
	});
});

describe("getEngagement, production shape", () => {
	/*
	 * Live: 17 messages in the cohort, 14 reconciled `delivered`, 3 still
	 * unreconciled, and only one (sent via the API, so pixel-tracked) with
	 * opens: 12 opens and 3 clicks from one recipient. The UI showed the newest
	 * rows, which were all untracked.
	 */
	beforeEach(() => {
		for (let i = 0; i < 17; i++) {
			const id = `p${String(i).padStart(2, "0")}`;
			email(id, "sent", `2026-10-${String(9 + i).padStart(2, "0")}T10:00:00.000Z`);
			event(id, "sent", `2026-10-${String(9 + i).padStart(2, "0")}T10:00:01.000Z`);
			if (i >= 3) event(id, "delivered", `2026-10-${String(9 + i).padStart(2, "0")}T10:01:00.000Z`);
		}
		// The oldest message (p00, unreconciled) is the tracked one.
		for (let k = 0; k < 12; k++) event("p00", "opened", `2026-10-09T11:${String(k).padStart(2, "0")}:00.000Z`, { recipient: "a@example.org" });
		for (let k = 0; k < 3; k++) event("p00", "clicked", `2026-10-09T12:0${k}:00.000Z`, { recipient: "a@example.org", metadata: { url: "https://example.com/x" } });
	});

	const WIDE = { start: "2026-10-01T00:00:00.000Z", end: "2026-10-31T00:00:00.000Z" };

	it("per-message rows add up to the totals, even for a message past the newest-N cut", () => {
		const e = getEngagement(ctx, WIDE, 10);
		expect(e).toMatchObject({ sent: 17, opens: 12, unique_opens: 1, clicks: 3, unique_clicks: 1, opened_messages: 1, clicked_messages: 1 });
		const tracked = e.messages.find((m) => m.email_id === "p00")!;
		expect(tracked).toMatchObject({ opens: 12, unique_opens: 1, clicks: 3, unique_clicks: 1, first_open_at: "2026-10-09T11:00:00.000Z" });
		expect(e.messages.reduce((n, m) => n + m.opens, 0)).toBe(e.opens);
		expect(e.messages.reduce((n, m) => n + m.clicks, 0)).toBe(e.clicks);
		expect(e.messages).toHaveLength(11); // newest 10 + the engaged one
	});

	it("an opened message counts as delivered, so the rate's denominator includes it", () => {
		// 14 reconciled + 1 opened-but-unreconciled = 15, not 14.
		expect(getEngagement(ctx, WIDE).delivered).toBe(15);
	});

	it("an open does not override a later bounce", () => {
		event("p01", "opened", "2026-10-10T11:00:00.000Z", { recipient: "a@example.org" });
		event("p01", "bounced", "2026-10-10T12:00:00.000Z", { cause: "recipient" });
		expect(getEngagement(ctx, WIDE).delivered).toBe(15);
	});

	it("engagement and the overview use the same delivered and pending", () => {
		const e = getEngagement(ctx, WIDE);
		const s = getSendingStats(ctx, WIDE);
		// p00 is opened but unreconciled: delivered in both. p01, p02 are pending in both.
		expect(s).toMatchObject({ sent: 17, delivered: 15, pending: 2 });
		expect(e).toMatchObject({ sent: 17, delivered: 15, pending: 2 });
		expect(e.messages.filter((m) => m.outcome === "pending").map((m) => m.email_id).sort()).toEqual(["p01", "p02"]);
		expect(e.messages.find((m) => m.email_id === "p00")?.outcome).toBe("delivered");
	});
});

describe("getInboundStats", () => {
	it("never counts a sent message filed out of Sent as inbound", () => {
		email("arch-sent", "archive", "2026-10-20T00:00:00.000Z");
		event("arch-sent", "sent", "2026-10-20T00:00:01.000Z");
		email("arch-in", "archive", "2026-10-20T00:00:00.000Z");
		const stats = getInboundStats(ctx, WINDOW);
		expect(stats.stored).toBe(1);
		expect(stats.capped).toBe(false);
		// Always pass/fail/none, each summing to `stored`.
		for (const key of ["spf", "dkim", "dmarc"] as const) {
			expect(Object.values(stats.auth[key]).reduce((a, b) => a + b, 0)).toBe(1);
			expect(stats.auth[key]).toMatchObject({ pass: 0, fail: 0, none: 1 });
		}
	});

	it("counts stored inbound and spam, and parses auth verdicts", () => {
		const headers = (ar: string) => JSON.stringify([{ key: "Authentication-Results", value: ar }]);
		email("i1", "inbox", "2026-10-20T00:00:00.000Z", { raw_headers: headers("mx.cloudflare.net; spf=pass smtp.mailfrom=x; dkim=pass header.d=x; dmarc=pass header.from=x") });
		email("i2", "spam", "2026-10-20T00:00:00.000Z", { raw_headers: headers("mx.cloudflare.net; spf=fail smtp.mailfrom=x; dkim=none; dmarc=fail header.from=x") });
		email("i3", "archive", "2026-10-21T00:00:00.000Z");
		email("s1", "sent", "2026-10-21T00:00:00.000Z");
		email("d1", "draft", "2026-10-21T00:00:00.000Z");
		const stats = getInboundStats(ctx, WINDOW);
		expect(stats.stored).toBe(3);
		expect(stats.spam_filed).toBe(1);
		// No Authentication-Results header means nothing was evaluated: `none`.
		expect(stats.auth.spf).toEqual({ pass: 1, fail: 1, none: 1 });
		expect(stats.auth.dmarc).toEqual({ pass: 1, fail: 1, none: 1 });
		expect(stats.auth.dkim).toEqual({ pass: 1, fail: 0, none: 2 });
		expect(stats.by_date).toEqual([
			{ date: "2026-10-20", received: 2, spam: 1 },
			{ date: "2026-10-21", received: 1, spam: 0 },
		]);
	});
});
