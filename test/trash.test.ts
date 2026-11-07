// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for Trash semantics.
 *
 * The behaviour worth pinning down is which rows get destroyed. Delete used to
 * drop the row outright, so the regression this guards against is a delete that
 * quietly skips the bin — and the mirror image, a `permanent` delete that binned
 * instead, which would leave a copy of every sent message in Trash.
 *
 * The rest is parameter numbering: every statement mixes fixed leading
 * parameters with a variable-length id list, and an off-by-one in the offset
 * would bind a folder id where an email id belongs.
 */

import { describe, expect, it } from "vitest";
import {
	TERMINAL_FOLDERS,
	deleteOrTrash,
	emptyTrash,
	restoreFromTrash,
} from "../workers/durableObject/trash";
import { BULK_LIMIT, BulkLimitError } from "../workers/durableObject/bulk";

/**
 * Minimal stand-in for DurableObjectState, matching the harness in
 * bulk.test.ts: queued row sets are handed out one per `exec`, as are the
 * `rowsWritten` counts the helpers report.
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

const NOW = "2026-03-04T10:00:00.000Z";

describe("deleteOrTrash", () => {
	it("moves an inbox message to Trash instead of destroying it", () => {
		const { ctx, calls } = fakeCtx({
			rows: [[{ id: "a", folder_id: "inbox" }]],
			rowsWritten: [1, 1],
		});

		const result = deleteOrTrash(ctx, ["a"], { now: NOW });

		expect(result).toEqual({ trashed: 1, deleted: 0, attachmentKeys: [] });
		// Nothing was destroyed, so no blobs are handed back for cleanup.
		expect(calls.some((c) => /DELETE FROM emails/.test(c.sql))).toBe(false);
	});

	it("records where the message came from so it can be restored", () => {
		const { ctx, calls } = fakeCtx({
			rows: [[{ id: "a", folder_id: "archive" }]],
			rowsWritten: [1, 1],
		});

		deleteOrTrash(ctx, ["a"], { now: NOW });

		const update = calls.find((c) => /UPDATE emails/.test(c.sql))!;
		// SQLite evaluates the right-hand sides against the pre-update row, so
		// this captures the old folder even though the same statement overwrites
		// folder_id.
		expect(flat(update.sql)).toContain("trashed_from = folder_id");
		expect(flat(update.sql)).toContain("folder_id = ?1");
		expect(update.params).toEqual(["trash", NOW, "a"]);
	});

	it("drops a pending snooze, so the message can't climb back out of the bin", () => {
		const { ctx, calls } = fakeCtx({
			rows: [[{ id: "a", folder_id: "snoozed" }]],
			rowsWritten: [1, 1],
		});

		deleteOrTrash(ctx, ["a"], { now: NOW });

		const update = flat(calls.find((c) => /UPDATE emails/.test(c.sql))!.sql);
		expect(update).toContain("snoozed_until = NULL");
		expect(update).toContain("snooze_return_folder = NULL");
	});

	it("destroys a message that is already in Trash", () => {
		const { ctx, calls } = fakeCtx({
			rows: [
				[{ id: "a", folder_id: "trash" }],
				[{ email_id: "a", id: "att1", filename: "report.pdf" }],
			],
			rowsWritten: [1, 1, 1],
		});

		const result = deleteOrTrash(ctx, ["a"], { now: NOW });

		expect(result).toEqual({
			trashed: 0,
			deleted: 1,
			attachmentKeys: ["attachments/a/att1/report.pdf"],
		});
		// Attachments must be read before the row goes, or the cascade removes
		// them first and the blobs leak.
		const attSelect = calls.findIndex((c) => /FROM attachments/.test(c.sql));
		const rowDelete = calls.findIndex((c) => /DELETE FROM emails/.test(c.sql));
		expect(attSelect).toBeGreaterThan(-1);
		expect(attSelect).toBeLessThan(rowDelete);
	});

	it("destroys a message that is already in Spam", () => {
		const { ctx } = fakeCtx({
			rows: [[{ id: "a", folder_id: "spam" }], []],
			rowsWritten: [1, 0, 1],
		});

		expect(deleteOrTrash(ctx, ["a"], { now: NOW })).toEqual({
			trashed: 0,
			deleted: 1,
			attachmentKeys: [],
		});
	});

	it("treats trash and spam as the folders where delete means destroy", () => {
		expect([...TERMINAL_FOLDERS]).toEqual(["trash", "spam"]);
	});

	it("splits a selection that spans the inbox and the bin", () => {
		const { ctx } = fakeCtx({
			rows: [
				[
					{ id: "a", folder_id: "inbox" },
					{ id: "b", folder_id: "trash" },
					{ id: "c", folder_id: "sent" },
				],
				[{ email_id: "b", id: "att1", filename: "x.pdf" }],
			],
			rowsWritten: [3, 1, 1, 2],
		});

		const result = deleteOrTrash(ctx, ["a", "b", "c"], { now: NOW });

		// One destroyed, two binned — reported separately because only the second
		// group can be undone.
		expect(result.deleted).toBe(1);
		expect(result.trashed).toBe(2);
		expect(result.attachmentKeys).toEqual(["attachments/b/att1/x.pdf"]);
	});

	it("destroys without binning when asked to be permanent", () => {
		const { ctx, calls } = fakeCtx({
			rows: [[{ email_id: "a", id: "att1", filename: "x.pdf" }]],
			rowsWritten: [1, 1],
		});

		const result = deleteOrTrash(ctx, ["a"], { permanent: true, now: NOW });

		expect(result).toEqual({
			trashed: 0,
			deleted: 1,
			attachmentKeys: ["attachments/a/att1/x.pdf"],
		});
		// No folder lookup: the caller has already decided, and a superseded
		// draft must not be routed through the bin.
		expect(calls.some((c) => /SELECT id, folder_id/.test(c.sql))).toBe(false);
		expect(flat(calls[1].sql)).toBe("DELETE FROM emails WHERE id IN (?1)");
	});

	it("ignores ids that no longer exist rather than reporting them", () => {
		const { ctx } = fakeCtx({ rows: [[]], rowsWritten: [0] });

		expect(deleteOrTrash(ctx, ["gone"], { now: NOW })).toEqual({
			trashed: 0,
			deleted: 0,
			attachmentKeys: [],
		});
	});

	it("touches nothing for an empty list", () => {
		const { ctx, calls } = fakeCtx();

		expect(deleteOrTrash(ctx, [])).toEqual({
			trashed: 0,
			deleted: 0,
			attachmentKeys: [],
		});
		expect(calls).toHaveLength(0);
	});

	it("rejects a list over the bulk limit instead of building giant SQL", () => {
		const { ctx, calls } = fakeCtx();
		const tooMany = Array.from({ length: BULK_LIMIT + 1 }, (_, i) => `id-${i}`);

		expect(() => deleteOrTrash(ctx, tooMany)).toThrow(BulkLimitError);
		expect(calls).toHaveLength(0);
	});
});

describe("restoreFromTrash", () => {
	it("puts a message back in the folder it was deleted from", () => {
		const { ctx, calls } = fakeCtx({ rowsWritten: [1] });

		expect(restoreFromTrash(ctx, ["a"])).toBe(1);

		const sql = flat(calls[0].sql);
		expect(sql).toContain("SET folder_id = COALESCE(");
		expect(calls[0].params).toEqual(["inbox", "trash", "a"]);
	});

	it("falls back to the inbox when the origin folder is gone", () => {
		const { ctx, calls } = fakeCtx({ rowsWritten: [1] });

		restoreFromTrash(ctx, ["a"]);

		// The origin is resolved through `folders` rather than trusted: a custom
		// folder can be deleted while a message that lived in it sits in the bin,
		// and a dangling id would fail the foreign key and take the whole
		// statement with it.
		expect(flat(calls[0].sql)).toContain(
			"(SELECT id FROM folders WHERE id = emails.trashed_from)",
		);
	});

	it("only touches rows that are actually in Trash", () => {
		const { ctx, calls } = fakeCtx({ rowsWritten: [0] });

		restoreFromTrash(ctx, ["a"]);

		// Otherwise a stale id from a client could yank a filed message out of
		// the folder someone deliberately put it in.
		expect(flat(calls[0].sql)).toContain("WHERE folder_id = ?2");
	});

	it("clears the provenance columns so the row stops looking binned", () => {
		const { ctx, calls } = fakeCtx({ rowsWritten: [1] });

		restoreFromTrash(ctx, ["a"]);

		const sql = flat(calls[0].sql);
		expect(sql).toContain("trashed_from = NULL");
		expect(sql).toContain("trashed_at = NULL");
	});

	it("touches nothing for an empty list", () => {
		const { ctx, calls } = fakeCtx();

		expect(restoreFromTrash(ctx, [])).toBe(0);
		expect(calls).toHaveLength(0);
	});
});

describe("emptyTrash", () => {
	it("returns the blobs it orphaned and deletes by folder, not by id", () => {
		const { ctx, calls } = fakeCtx({
			rows: [[{ email_id: "a", id: "att1", filename: "x.pdf" }]],
			rowsWritten: [1, 4],
		});

		const result = emptyTrash(ctx);

		expect(result).toEqual({
			deleted: 4,
			attachmentKeys: ["attachments/a/att1/x.pdf"],
		});
		// Not id-based: the point of Empty Trash is not enumerating what is in
		// there, and the bin can hold more than the bulk id ceiling allows.
		expect(flat(calls[1].sql)).toBe("DELETE FROM emails WHERE folder_id = ?");
		expect(calls[1].params).toEqual(["trash"]);
	});

	it("scopes the attachment lookup to messages in the bin", () => {
		const { ctx, calls } = fakeCtx({ rows: [[]], rowsWritten: [0, 0] });

		emptyTrash(ctx);

		const sql = flat(calls[0].sql);
		expect(sql).toContain("JOIN emails e ON e.id = a.email_id");
		expect(sql).toContain("WHERE e.folder_id = ?");
		expect(calls[0].params).toEqual(["trash"]);
	});
});
