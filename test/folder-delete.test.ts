// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Custom folder deletion.
 *
 * `emails.folder_id` is declared `ON DELETE CASCADE`, so the obvious
 * implementation — delete the row, return true — destroyed every message in the
 * folder along with its attachment rows, with no Trash step and no R2 keys
 * returned for the orphaned blobs.
 *
 * These tests are about what deletion must do *before* it touches the folder
 * row: relocate the mail, and clear the two columns elsewhere in the table that
 * still name the folder.
 */

import { describe, expect, it } from "vitest";
import { deleteFolder } from "../workers/durableObject/folders";
import { Folders } from "../shared/folders";

/**
 * Fake `DurableObjectState`. `rows` queues the result of each SELECT and
 * `rowsWritten` the count reported by each write, in call order.
 */
function fakeCtx(options: { rows?: unknown[][]; rowsWritten?: number[] } = {}) {
	const queuedRows = [...(options.rows ?? [])];
	const queuedWrites = [...(options.rowsWritten ?? [])];
	const calls: { sql: string; params: unknown[] }[] = [];
	let transactions = 0;

	const ctx = {
		storage: {
			sql: {
				exec(sql: string, ...params: unknown[]) {
					calls.push({ sql, params });
					const rows = queuedRows.shift() ?? [];
					const rowsWritten = queuedWrites.shift() ?? 0;
					return { toArray: () => rows, rowsWritten };
				},
			},
			transactionSync: <T>(fn: () => T): T => {
				transactions += 1;
				return fn();
			},
		},
	};

	return {
		ctx: ctx as unknown as DurableObjectState,
		calls,
		transactions: () => transactions,
	};
}

const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

/** A deletable custom folder. */
const custom = [{ id: "projects", is_deletable: 1 }];

describe("deleteFolder", () => {
	it("refuses a folder that does not exist", () => {
		const { ctx } = fakeCtx({ rows: [[]] });
		const result = deleteFolder(ctx, "nope");

		expect(result.deleted).toBe(false);
		expect(result.reason).toBe("not_found");
	});

	it("refuses a built-in folder", () => {
		const { ctx, calls } = fakeCtx({
			rows: [[{ id: Folders.ARCHIVE, is_deletable: 0 }]],
		});
		const result = deleteFolder(ctx, "archive");

		expect(result.deleted).toBe(false);
		expect(result.reason).toBe("not_deletable");
		// Nothing beyond the lookup ran.
		expect(calls).toHaveLength(1);
	});

	it("refuses to delete the fallback folder into itself", () => {
		// Relocating a folder's mail into the folder being deleted would hand every
		// message straight back to the cascade.
		const { ctx, calls } = fakeCtx();
		const result = deleteFolder(ctx, Folders.INBOX);

		expect(result.deleted).toBe(false);
		expect(result.reason).toBe("not_deletable");
		expect(calls).toHaveLength(0);
	});

	it("relocates the folder's mail instead of destroying it", () => {
		const { ctx, calls } = fakeCtx({
			rows: [custom],
			rowsWritten: [0, 12, 0, 0],
		});
		const result = deleteFolder(ctx, "projects");

		expect(result.deleted).toBe(true);
		expect(result.relocated).toBe(12);
		expect(result.movedTo).toBe(Folders.INBOX);

		const relocate = calls[1];
		expect(flat(relocate.sql)).toBe(
			"UPDATE emails SET folder_id = ?1 WHERE folder_id = ?2",
		);
		expect(relocate.params).toEqual([Folders.INBOX, "projects"]);
	});

	it("relocates before dropping the folder, so the cascade never fires", () => {
		const { ctx, calls } = fakeCtx({
			rows: [custom],
			rowsWritten: [0, 3, 0, 0],
		});
		deleteFolder(ctx, "projects");

		const relocateAt = calls.findIndex((c) =>
			flat(c.sql).startsWith("UPDATE emails SET folder_id"),
		);
		const deleteAt = calls.findIndex((c) =>
			flat(c.sql).startsWith("DELETE FROM folders"),
		);

		expect(relocateAt).toBeGreaterThan(-1);
		expect(deleteAt).toBeGreaterThan(relocateAt);
	});

	it("clears snooze return pointers aimed at the folder", () => {
		// A snoozed message lives in Snoozed, not in the folder being deleted, so
		// relocation misses it. Left dangling, waking it up would violate the
		// foreign key and stall the whole snooze sweep.
		const { ctx, calls } = fakeCtx({
			rows: [custom],
			rowsWritten: [0, 0, 4, 0],
		});
		const result = deleteFolder(ctx, "projects");

		expect(result.clearedSnoozeReturns).toBe(4);

		const cleared = calls.find((c) =>
			flat(c.sql).includes("snooze_return_folder = NULL"),
		);
		expect(cleared).toBeDefined();
		expect(flat(cleared!.sql)).toBe(
			"UPDATE emails SET snooze_return_folder = NULL WHERE snooze_return_folder = ?1",
		);
		expect(cleared!.params).toEqual(["projects"]);
	});

	it("clears trash origin pointers aimed at the folder", () => {
		const { ctx, calls } = fakeCtx({
			rows: [custom],
			rowsWritten: [0, 0, 0, 2],
		});
		const result = deleteFolder(ctx, "projects");

		expect(result.clearedTrashOrigins).toBe(2);

		const cleared = calls.find((c) =>
			flat(c.sql).includes("trashed_from = NULL"),
		);
		expect(flat(cleared!.sql)).toBe(
			"UPDATE emails SET trashed_from = NULL WHERE trashed_from = ?1",
		);
		expect(cleared!.params).toEqual(["projects"]);
	});

	it("never issues a bare DELETE that could cascade into emails", () => {
		const { ctx, calls } = fakeCtx({
			rows: [custom],
			rowsWritten: [0, 5, 0, 0],
		});
		deleteFolder(ctx, "projects");

		// The only DELETE is against `folders`, and it is scoped to one id.
		const deletes = calls.filter((c) => /\bDELETE\b/i.test(c.sql));
		expect(deletes).toHaveLength(1);
		expect(flat(deletes[0].sql)).toBe("DELETE FROM folders WHERE id = ?1");
		expect(deletes[0].params).toEqual(["projects"]);
	});

	it("runs the whole thing in one transaction", () => {
		// A failure between relocating and dropping would leave mail pointing at a
		// folder that no longer exists.
		const { ctx, transactions } = fakeCtx({
			rows: [custom],
			rowsWritten: [0, 1, 0, 0],
		});
		deleteFolder(ctx, "projects");
		expect(transactions()).toBe(1);
	});

	it("honours a custom fallback folder", () => {
		const { ctx, calls } = fakeCtx({
			rows: [custom],
			rowsWritten: [0, 7, 0, 0],
		});
		const result = deleteFolder(ctx, "projects", {
			fallbackFolder: Folders.ARCHIVE,
		});

		expect(result.movedTo).toBe(Folders.ARCHIVE);
		expect(calls[1].params).toEqual([Folders.ARCHIVE, "projects"]);
	});

	it("reports an empty folder as deleted with nothing relocated", () => {
		const { ctx } = fakeCtx({ rows: [custom], rowsWritten: [0, 0, 0, 0] });
		expect(deleteFolder(ctx, "projects")).toEqual({
			deleted: true,
			relocated: 0,
			clearedSnoozeReturns: 0,
			clearedTrashOrigins: 0,
			movedTo: Folders.INBOX,
		});
	});
});
