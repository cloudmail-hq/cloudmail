// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for the snooze / scheduled-send / blocked-sender logic added on top of
 * the original mailbox.
 *
 * These exercise the parts where a subtle mistake would be expensive and
 * invisible: alarm arming (a lost alarm means mail never goes out), blocklist
 * matching (a wrong match silently diverts mail), and base64 chunking (a
 * corrupted attachment).
 */

import { describe, expect, it, vi } from "vitest";
import {
	isSenderBlocked,
	nextDeadline,
	scheduleNextAlarm,
	senderWithDisplayName,
	setEmailLabels,
	toBase64,
} from "../workers/durableObject/features";
import { extractPriority } from "../workers/lib/email-helpers";

/**
 * Minimal stand-in for DurableObjectState.
 *
 * `sql.exec` returns whatever rows the test queues up and records the SQL and
 * bound parameters, which is enough for the query-shape assertions here.
 */
function fakeCtx(options: {
	rows?: unknown[][];
	alarm?: number | null;
} = {}) {
	const queued = [...(options.rows ?? [])];
	const calls: { sql: string; params: unknown[] }[] = [];
	let alarm = options.alarm ?? null;

	const ctx = {
		storage: {
			sql: {
				exec(sql: string, ...params: unknown[]) {
					calls.push({ sql, params });
					const rows = queued.shift() ?? [];
					return { toArray: () => rows };
				},
			},
			transactionSync: <T>(fn: () => T) => fn(),
			getAlarm: async () => alarm,
			setAlarm: async (when: number) => {
				alarm = when;
			},
		},
	};

	return {
		ctx: ctx as unknown as DurableObjectState,
		calls,
		getAlarm: () => alarm,
	};
}

describe("nextDeadline", () => {
	it("returns null when nothing is pending", () => {
		const { ctx } = fakeCtx({ rows: [[{ next_at: null }]] });
		expect(nextDeadline(ctx)).toBeNull();
	});

	it("parses the earliest pending deadline", () => {
		const { ctx } = fakeCtx({ rows: [[{ next_at: "2026-08-14T10:00:00.000Z" }]] });
		expect(nextDeadline(ctx)).toBe(Date.parse("2026-08-14T10:00:00.000Z"));
	});

	it("returns null rather than NaN for an unparseable timestamp", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { ctx } = fakeCtx({ rows: [[{ next_at: "not a date" }]] });
		expect(nextDeadline(ctx)).toBeNull();
		spy.mockRestore();
	});
});

describe("scheduleNextAlarm", () => {
	it("arms the alarm when none is set", async () => {
		const future = Date.now() + 60_000;
		const { ctx, getAlarm } = fakeCtx({
			rows: [[{ next_at: new Date(future).toISOString() }]],
			alarm: null,
		});

		await scheduleNextAlarm(ctx);
		expect(getAlarm()).toBe(future);
	});

	it("does not push back an alarm that already fires earlier", async () => {
		const soon = Date.now() + 10_000;
		const later = Date.now() + 600_000;
		const { ctx, getAlarm } = fakeCtx({
			rows: [[{ next_at: new Date(later).toISOString() }]],
			alarm: soon,
		});

		await scheduleNextAlarm(ctx);
		expect(getAlarm()).toBe(soon);
	});

	it("replaces the alarm when the new deadline is earlier", async () => {
		const soon = Date.now() + 10_000;
		const later = Date.now() + 600_000;
		const { ctx, getAlarm } = fakeCtx({
			rows: [[{ next_at: new Date(soon).toISOString() }]],
			alarm: later,
		});

		await scheduleNextAlarm(ctx);
		expect(getAlarm()).toBe(soon);
	});

	it("clamps an overdue deadline into the future instead of looping", async () => {
		const past = Date.now() - 60_000;
		const { ctx, getAlarm } = fakeCtx({
			rows: [[{ next_at: new Date(past).toISOString() }]],
			alarm: null,
		});

		await scheduleNextAlarm(ctx);
		expect(getAlarm()).toBeGreaterThan(Date.now());
	});

	it("leaves the alarm alone when there is nothing pending", async () => {
		const { ctx, getAlarm } = fakeCtx({ rows: [[{ next_at: null }]], alarm: null });
		await scheduleNextAlarm(ctx);
		expect(getAlarm()).toBeNull();
	});
});

describe("isSenderBlocked", () => {
	it("matches on the full address and on the domain suffix", () => {
		const { ctx, calls } = fakeCtx({ rows: [[{ 1: 1 }]] });
		expect(isSenderBlocked(ctx, "Spam@Example.COM")).toBe(true);
		// Address is normalised, and the domain suffix is offered as a second pattern.
		expect(calls[0].params).toEqual(["spam@example.com", "@example.com"]);
	});

	it("returns false when no rule matches", () => {
		const { ctx } = fakeCtx({ rows: [[]] });
		expect(isSenderBlocked(ctx, "someone@example.com")).toBe(false);
	});

	it("short-circuits on an empty address without querying", () => {
		const { ctx, calls } = fakeCtx({ rows: [[{ 1: 1 }]] });
		expect(isSenderBlocked(ctx, "   ")).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it("passes an empty suffix for a malformed address so the OR cannot match everything", () => {
		const { ctx, calls } = fakeCtx({ rows: [[]] });
		isSenderBlocked(ctx, "no-at-sign");
		expect(calls[0].params).toEqual(["no-at-sign", ""]);
	});
});

describe("toBase64", () => {
	it("round-trips a payload larger than the chunk size", () => {
		// 0x8000 is the chunk boundary; go past it to catch off-by-one chunking.
		const bytes = new Uint8Array(0x8000 * 2 + 17);
		for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;

		const decoded = Uint8Array.from(atob(toBase64(bytes)), (ch) => ch.charCodeAt(0));
		expect(decoded).toEqual(bytes);
	});

	it("encodes an empty buffer as an empty string", () => {
		expect(toBase64(new Uint8Array(0))).toBe("");
	});
});

describe("extractPriority", () => {
	it("returns null when there are no headers", () => {
		expect(extractPriority(undefined)).toBeNull();
		expect(extractPriority([])).toBeNull();
	});

	it("reads the standard Importance header", () => {
		expect(extractPriority([{ key: "Importance", value: "High" }])).toBe("high");
		expect(extractPriority([{ key: "importance", value: " low " }])).toBe("low");
	});

	it("maps numeric X-Priority levels", () => {
		expect(extractPriority([{ key: "X-Priority", value: "1" }])).toBe("high");
		expect(extractPriority([{ key: "X-Priority", value: "2" }])).toBe("high");
		expect(extractPriority([{ key: "X-Priority", value: "3" }])).toBeNull();
		expect(extractPriority([{ key: "X-Priority", value: "5 (Lowest)" }])).toBe("low");
	});

	it("falls back to X-MSMail-Priority", () => {
		expect(extractPriority([{ key: "X-MSMail-Priority", value: "High" }])).toBe("high");
	});

	it("prefers Importance over X-Priority when both are present", () => {
		expect(
			extractPriority([
				{ key: "X-Priority", value: "5" },
				{ key: "Importance", value: "high" },
			]),
		).toBe("high");
	});

	it("treats normal and unrecognised values as no priority", () => {
		expect(extractPriority([{ key: "Importance", value: "normal" }])).toBeNull();
		expect(extractPriority([{ key: "X-Priority", value: "banana" }])).toBeNull();
		expect(extractPriority([{ key: "Subject", value: "hello" }])).toBeNull();
	});
});

/**
 * Every ordinary send now goes through the scheduled-send path so it can be
 * undone, which means delivery reconstructs the From header from stored data.
 * Getting this wrong strips the sender's display name off all outbound mail, or
 * worse, sends a literal "undefined <addr>".
 */
describe("senderWithDisplayName", () => {
	const headers = (from: string) => JSON.stringify([{ key: "from", value: from }]);

	it("recovers the display name recorded at schedule time", () => {
		expect(
			senderWithDisplayName({
				sender: "ada@example.com",
				raw_headers: headers("Ada Lovelace <ada@example.com>"),
			}),
		).toEqual({ email: "ada@example.com", name: "Ada Lovelace" });
	});

	it("unquotes a quoted display name", () => {
		expect(
			senderWithDisplayName({
				sender: "ada@example.com",
				raw_headers: headers('"Lovelace, Ada" <ada@example.com>'),
			}),
		).toEqual({ email: "ada@example.com", name: "Lovelace, Ada" });
	});

	it("returns a bare address when the header carries no name", () => {
		expect(
			senderWithDisplayName({
				sender: "ada@example.com",
				raw_headers: headers("<ada@example.com>"),
			}),
		).toBe("ada@example.com");
	});

	it("never emits the literal 'undefined' as a name", () => {
		expect(
			senderWithDisplayName({
				sender: "ada@example.com",
				raw_headers: headers("undefined <ada@example.com>"),
			}),
		).toBe("ada@example.com");
	});

	it("falls back to the stored sender when headers are absent or unusable", () => {
		expect(
			senderWithDisplayName({ sender: "ada@example.com", raw_headers: null }),
		).toBe("ada@example.com");
		expect(
			senderWithDisplayName({
				sender: "ada@example.com",
				raw_headers: "not json",
			}),
		).toBe("ada@example.com");
		expect(
			senderWithDisplayName({
				sender: "ada@example.com",
				raw_headers: headers("ada@example.com"),
			}),
		).toBe("ada@example.com");
	});
});

describe("setEmailLabels", () => {
	/** The SELECT that resolves which of the requested label ids exist. */
	const labelLookups = (calls: { sql: string }[]) =>
		calls.filter((c) => c.sql.includes("FROM labels WHERE id IN"));

	it("validates every label id in one query rather than one per id", () => {
		const { ctx, calls } = fakeCtx({
			rows: [
				[{ 1: 1 }], // email exists
				[{ id: "l1" }, { id: "l2" }, { id: "l3" }], // all three labels exist
				[], // DELETE
				[],
				[],
				[], // three INSERTs
				[{ id: "l1", name: "Work", color: "#fff" }], // getEmailLabels
			],
		});

		setEmailLabels(ctx, "e1", ["l1", "l2", "l3"]);

		const lookups = labelLookups(calls);
		expect(lookups).toHaveLength(1);
		expect(lookups[0].sql).toContain("?1, ?2, ?3");
		expect((lookups[0] as { params: unknown[] }).params).toEqual(["l1", "l2", "l3"]);
	});

	it("collapses duplicate ids so they are bound and inserted once", () => {
		const { ctx, calls } = fakeCtx({
			rows: [[{ 1: 1 }], [{ id: "l1" }], [], [], []],
		});

		setEmailLabels(ctx, "e1", ["l1", "l1", "l1"]);

		const lookups = labelLookups(calls);
		expect((lookups[0] as { params: unknown[] }).params).toEqual(["l1"]);
		expect(calls.filter((c) => c.sql.includes("INSERT OR IGNORE"))).toHaveLength(1);
	});

	it("drops ids that do not exist", () => {
		const { ctx, calls } = fakeCtx({
			// Only l1 comes back from the lookup; l2 is unknown.
			rows: [[{ 1: 1 }], [{ id: "l1" }], [], [], []],
		});

		setEmailLabels(ctx, "e1", ["l1", "l2"]);

		const inserts = calls.filter((c) => c.sql.includes("INSERT OR IGNORE"));
		expect(inserts).toHaveLength(1);
		expect((inserts[0] as { params: unknown[] }).params).toEqual(["e1", "l1"]);
	});

	it("skips the lookup entirely when clearing all labels", () => {
		// An empty `IN ()` is a SQLite syntax error, so no query may be issued.
		const { ctx, calls } = fakeCtx({ rows: [[{ 1: 1 }], [], []] });

		setEmailLabels(ctx, "e1", []);

		expect(labelLookups(calls)).toHaveLength(0);
		expect(calls.some((c) => c.sql.includes("DELETE FROM email_labels"))).toBe(true);
	});

	it("returns null for an unknown email without touching labels", () => {
		const { ctx, calls } = fakeCtx({ rows: [[]] });

		expect(setEmailLabels(ctx, "missing", ["l1"])).toBeNull();
		expect(labelLookups(calls)).toHaveLength(0);
	});
});
