// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for bulk message operations and mark-all-read.
 *
 * The risk in this module is not the SQL verbs, it is the parameter numbering:
 * every statement mixes fixed leading parameters with a variable-length id list,
 * so an off-by-one in the placeholder offset would bind a folder id where an
 * email id belongs and quietly affect the wrong rows. Those assertions are the
 * point of this file.
 */

import { describe, expect, it } from "vitest";
import {
	BULK_LIMIT,
	BulkLimitError,
	SQL_MAX_BOUND_PARAMS,
	bulkMove,
	bulkSetLabel,
	bulkUpdateFlags,
	chunkIds,
	markAllRead,
} from "../workers/durableObject/bulk";
import { deleteOrTrash, restoreFromTrash } from "../workers/durableObject/trash";

/**
 * Minimal stand-in for DurableObjectState.
 *
 * Extends the harness used by features.test.ts with `rowsWritten`, which the
 * bulk helpers return as their affected-row count.
 */
function fakeCtx(options: { rows?: unknown[][]; rowsWritten?: number[] } = {}) {
	const queuedRows = [...(options.rows ?? [])];
	const queuedWrites = [...(options.rowsWritten ?? [])];
	const calls: { sql: string; params: unknown[] }[] = [];

	const ctx = {
		storage: {
			sql: {
				exec(sql: string, ...params: unknown[]) {
					calls.push({ sql, params });
					const rows = queuedRows.shift() ?? [];
					const rowsWritten = queuedWrites.shift() ?? rows.length;
					return { toArray: () => rows, rowsWritten };
				},
			},
			transactionSync: <T>(fn: () => T) => fn(),
		},
	};

	return { ctx: ctx as unknown as DurableObjectState, calls };
}

/** Collapse whitespace so assertions aren't coupled to SQL indentation. */
const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe("id normalisation", () => {
	it("collapses duplicates so a repeated id can't inflate the count", () => {
		const { ctx, calls } = fakeCtx({ rowsWritten: [1] });
		bulkUpdateFlags(ctx, ["a", "a", "a"], { read: true });
		// One flag value plus a single id.
		expect(calls[0].params).toEqual([1, "a"]);
	});

	it("drops blank and non-string ids rather than binding them", () => {
		const { ctx, calls } = fakeCtx({ rowsWritten: [1] });
		bulkUpdateFlags(ctx, ["a", "", "   ", null, 7, undefined, "b"], { read: true });
		expect(calls[0].params).toEqual([1, "a", "b"]);
	});

	it("is a no-op for an empty list, without touching storage", () => {
		const { ctx, calls } = fakeCtx();
		expect(bulkUpdateFlags(ctx, [], { read: true })).toBe(0);
		expect(calls).toHaveLength(0);
	});

	it("is a no-op when given something that isn't an array", () => {
		const { ctx, calls } = fakeCtx();
		expect(bulkUpdateFlags(ctx, "a", { read: true })).toBe(0);
		expect(calls).toHaveLength(0);
	});

	it("rejects a list over the limit instead of building giant SQL", () => {
		const { ctx, calls } = fakeCtx();
		const tooMany = Array.from({ length: BULK_LIMIT + 1 }, (_, i) => `id-${i}`);
		expect(() => bulkUpdateFlags(ctx, tooMany, { read: true })).toThrow(BulkLimitError);
		expect(calls).toHaveLength(0);
	});

	it("accepts a list exactly at the limit", () => {
		const atLimit = Array.from({ length: BULK_LIMIT }, (_, i) => `id-${i}`);
		// One write per chunk; the fake reports each chunk's own size.
		const perChunk = SQL_MAX_BOUND_PARAMS - 1;
		const chunks = Math.ceil(BULK_LIMIT / perChunk);
		const { ctx } = fakeCtx({
			rowsWritten: Array.from({ length: chunks }, (_, i) =>
				Math.min(perChunk, BULK_LIMIT - i * perChunk),
			),
		});
		expect(bulkUpdateFlags(ctx, atLimit, { read: true })).toBe(BULK_LIMIT);
	});
});

describe("bound-parameter budget", () => {
	/**
	 * Durable Object SQLite accepts a limited number of bound parameters per
	 * statement. `BULK_LIMIT` is 500 and every operation here binds one parameter
	 * per id, so before chunking these all failed outright somewhere around a
	 * hundred selected messages — inside what "select all" on a large page sends.
	 */
	const overBudget = Array.from({ length: 250 }, (_, i) => `id-${i}`);

	const withinBudget = (calls: { params: unknown[] }[]) =>
		calls.every((c) => c.params.length <= SQL_MAX_BOUND_PARAMS);

	it("chunkIds returns nothing for an empty list", () => {
		expect(chunkIds([])).toEqual([]);
	});

	it("chunkIds keeps a small list in one chunk", () => {
		expect(chunkIds(["a", "b"])).toEqual([["a", "b"]]);
	});

	it("chunkIds leaves room for the statement's own parameters", () => {
		const chunks = chunkIds(overBudget, 2);
		expect(chunks[0]).toHaveLength(SQL_MAX_BOUND_PARAMS - 2);
		// Nothing is dropped or duplicated by the split.
		expect(chunks.flat()).toEqual(overBudget);
	});

	it("chunkIds never returns an empty chunk, even if fully reserved", () => {
		const chunks = chunkIds(overBudget, SQL_MAX_BOUND_PARAMS + 5);
		expect(chunks.every((c) => c.length >= 1)).toBe(true);
		expect(chunks.flat()).toEqual(overBudget);
	});

	it("bulkUpdateFlags stays inside the budget and sums the chunks", () => {
		const { ctx, calls } = fakeCtx({ rowsWritten: [99, 99, 52] });
		expect(bulkUpdateFlags(ctx, overBudget, { read: true })).toBe(250);
		expect(calls.length).toBeGreaterThan(1);
		expect(withinBudget(calls)).toBe(true);
	});

	it("bulkMove stays inside the budget and sums the chunks", () => {
		const { ctx, calls } = fakeCtx({
			rows: [[{ id: "archive" }]],
			rowsWritten: [0, 99, 99, 52],
		});
		expect(bulkMove(ctx, overBudget, "archive")).toBe(250);
		expect(withinBudget(calls)).toBe(true);
	});

	it("bulkSetLabel stays inside the budget when adding", () => {
		const { ctx, calls } = fakeCtx({
			rows: [[{ id: "work" }]],
			rowsWritten: [0, 99, 99, 52],
		});
		expect(bulkSetLabel(ctx, overBudget, "work", true)).toBe(250);
		expect(withinBudget(calls)).toBe(true);
	});

	it("bulkSetLabel stays inside the budget when removing", () => {
		const { ctx, calls } = fakeCtx({
			rows: [[{ id: "work" }]],
			rowsWritten: [0, 99, 99, 52],
		});
		expect(bulkSetLabel(ctx, overBudget, "work", false)).toBe(250);
		expect(withinBudget(calls)).toBe(true);
	});

	it("deleteOrTrash stays inside the budget across all its statements", () => {
		// Every id reads back as an inbox message, so all of them get binned.
		const rows = chunkIds(overBudget).map((chunk) =>
			chunk.map((id) => ({ id, folder_id: "inbox" })),
		);
		const { ctx, calls } = fakeCtx({ rows: [...rows], rowsWritten: [] });
		deleteOrTrash(ctx, overBudget);
		expect(withinBudget(calls)).toBe(true);
	});

	it("restoreFromTrash stays inside the budget", () => {
		const { ctx, calls } = fakeCtx({ rowsWritten: [98, 98, 54] });
		expect(restoreFromTrash(ctx, overBudget)).toBe(250);
		expect(withinBudget(calls)).toBe(true);
	});
});

describe("bulkUpdateFlags", () => {
	it("sets read, binding the flag before the ids", () => {
		const { ctx, calls } = fakeCtx({ rowsWritten: [2] });
		expect(bulkUpdateFlags(ctx, ["a", "b"], { read: true })).toBe(2);
		expect(flat(calls[0].sql)).toBe(
			"UPDATE emails SET read = ?1 WHERE id IN (?2, ?3)",
		);
		expect(calls[0].params).toEqual([1, "a", "b"]);
	});

	it("sets unread as 0 rather than omitting the column", () => {
		const { ctx, calls } = fakeCtx({ rowsWritten: [1] });
		bulkUpdateFlags(ctx, ["a"], { read: false });
		expect(calls[0].params).toEqual([0, "a"]);
	});

	it("offsets id placeholders past both flags when setting read and starred", () => {
		const { ctx, calls } = fakeCtx({ rowsWritten: [1] });
		bulkUpdateFlags(ctx, ["a", "b"], { read: true, starred: false });
		expect(flat(calls[0].sql)).toBe(
			"UPDATE emails SET read = ?1, starred = ?2 WHERE id IN (?3, ?4)",
		);
		expect(calls[0].params).toEqual([1, 0, "a", "b"]);
	});

	it("does nothing when no flag is supplied", () => {
		const { ctx, calls } = fakeCtx();
		expect(bulkUpdateFlags(ctx, ["a"], {})).toBe(0);
		expect(calls).toHaveLength(0);
	});
});

describe("bulkMove", () => {
	it("returns null when the destination folder doesn't exist", () => {
		const { ctx, calls } = fakeCtx({ rows: [[]] });
		expect(bulkMove(ctx, ["a"], "nope")).toBeNull();
		// Only the folder lookup ran; nothing was moved.
		expect(calls).toHaveLength(1);
	});

	it("moves and clears any pending snooze", () => {
		const { ctx, calls } = fakeCtx({ rows: [[{ id: "archive" }]], rowsWritten: [0, 2] });
		expect(bulkMove(ctx, ["a", "b"], "archive")).toBe(2);

		const update = flat(calls[1].sql);
		expect(update).toContain("SET folder_id = ?1");
		expect(update).toContain("snoozed_until = NULL");
		expect(update).toContain("snooze_return_folder = NULL");
		expect(update).toContain("WHERE id IN (?2, ?3)");
		expect(calls[1].params).toEqual(["archive", "a", "b"]);
	});

	it("validates the folder even when the id list is empty", () => {
		const { ctx } = fakeCtx({ rows: [[]] });
		expect(bulkMove(ctx, [], "nope")).toBeNull();
	});
});

// Deleting is covered by test/trash.test.ts: it is a move to Trash unless the
// message is already binned, so it no longer lives in this module.

describe("bulkSetLabel", () => {
	it("returns null when the label doesn't exist", () => {
		const { ctx, calls } = fakeCtx({ rows: [[]] });
		expect(bulkSetLabel(ctx, ["a"], "ghost", true)).toBeNull();
		expect(calls).toHaveLength(1);
	});

	it("adds via INSERT..SELECT so a stale email id can't abort the statement", () => {
		const { ctx, calls } = fakeCtx({ rows: [[{ id: "l1" }]], rowsWritten: [0, 2] });
		expect(bulkSetLabel(ctx, ["a", "b"], "l1", true)).toBe(2);

		const sql = flat(calls[1].sql);
		expect(sql).toContain("INSERT OR IGNORE INTO email_labels");
		expect(sql).toContain("SELECT id, ?1 FROM emails WHERE id IN (?2, ?3)");
		expect(calls[1].params).toEqual(["l1", "a", "b"]);
	});

	it("removes with the label bound ahead of the ids", () => {
		const { ctx, calls } = fakeCtx({ rows: [[{ id: "l1" }]], rowsWritten: [0, 1] });
		expect(bulkSetLabel(ctx, ["a"], "l1", false)).toBe(1);

		expect(flat(calls[1].sql)).toBe(
			"DELETE FROM email_labels WHERE label_id = ?1 AND email_id IN (?2)",
		);
		expect(calls[1].params).toEqual(["l1", "a"]);
	});
});

describe("markAllRead", () => {
	it("covers the whole mailbox when unscoped", () => {
		const { ctx, calls } = fakeCtx({ rowsWritten: [12] });
		expect(markAllRead(ctx)).toBe(12);
		expect(flat(calls[0].sql)).toBe("UPDATE emails SET read = 1 WHERE read = 0");
		expect(calls[0].params).toEqual([]);
	});

	it("scopes to a folder", () => {
		const { ctx, calls } = fakeCtx({ rowsWritten: [3] });
		markAllRead(ctx, { folder: "inbox" });
		expect(flat(calls[0].sql)).toBe(
			"UPDATE emails SET read = 1 WHERE read = 0 AND folder_id = ?1",
		);
		expect(calls[0].params).toEqual(["inbox"]);
	});

	it("scopes to a label via a subquery", () => {
		const { ctx, calls } = fakeCtx({ rowsWritten: [4] });
		markAllRead(ctx, { labelId: "l1" });
		expect(flat(calls[0].sql)).toBe(
			"UPDATE emails SET read = 1 WHERE read = 0 " +
				"AND id IN (SELECT email_id FROM email_labels WHERE label_id = ?1)",
		);
		expect(calls[0].params).toEqual(["l1"]);
	});

	it("composes folder and label scopes, numbering both parameters", () => {
		const { ctx, calls } = fakeCtx({ rowsWritten: [1] });
		markAllRead(ctx, { folder: "inbox", labelId: "l1" });
		const sql = flat(calls[0].sql);
		expect(sql).toContain("folder_id = ?1");
		expect(sql).toContain("label_id = ?2");
		expect(calls[0].params).toEqual(["inbox", "l1"]);
	});

	it("always filters on read = 0 so the count reflects real changes", () => {
		const { ctx, calls } = fakeCtx({ rowsWritten: [0] });
		markAllRead(ctx, { folder: "sent" });
		expect(flat(calls[0].sql)).toContain("read = 0");
	});
});
