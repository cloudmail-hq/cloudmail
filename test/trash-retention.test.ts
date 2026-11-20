// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Bin retention sweep.
 *
 * This is the one part of the trash story that destroys mail without anyone
 * asking, so the assertions are about restraint: it only touches rows in Trash,
 * only ones older than the window, and it gives undated rows a clock instead of
 * assuming they are ancient.
 */

import { describe, expect, it } from "vitest";
import {
	TRASH_RETENTION_DAYS,
	purgeExpiredTrash,
} from "../workers/durableObject/trash";
import { Folders } from "../shared/folders";

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

const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

const now = new Date("2026-06-01T12:00:00.000Z");

describe("purgeExpiredTrash", () => {
	it("stamps undated rows rather than destroying mail of unknown age", () => {
		const { ctx, calls } = fakeCtx({ rowsWritten: [3, 0, 0] });
		const result = purgeExpiredTrash(ctx, { now });

		expect(result.stamped).toBe(3);
		expect(flat(calls[0].sql)).toContain("SET trashed_at = ?1");
		expect(flat(calls[0].sql)).toContain("trashed_at IS NULL");
		expect(calls[0].params).toEqual([now.toISOString(), Folders.TRASH]);
	});

	it("deletes only Trash rows older than the retention window", () => {
		const { ctx, calls } = fakeCtx({ rowsWritten: [0, 0, 4] });
		const result = purgeExpiredTrash(ctx, { now });

		expect(result.deleted).toBe(4);

		const del = calls[calls.length - 1];
		expect(flat(del.sql)).toBe(
			"DELETE FROM emails WHERE folder_id = ?1 AND trashed_at IS NOT NULL AND trashed_at < ?2",
		);

		const [folder, cutoff] = del.params as [string, string];
		expect(folder).toBe(Folders.TRASH);

		const expected = new Date(
			now.getTime() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000,
		).toISOString();
		expect(cutoff).toBe(expected);
	});

	it("honours a custom retention window", () => {
		const { ctx, calls } = fakeCtx({ rowsWritten: [0, 0, 1] });
		purgeExpiredTrash(ctx, { now, retentionDays: 7 });

		const [, cutoff] = calls[calls.length - 1].params as [string, string];
		expect(cutoff).toBe(
			new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
		);
	});

	it("returns the attachment keys of what it destroyed, for R2 cleanup", () => {
		const { ctx } = fakeCtx({
			rows: [
				[],
				[
					{ email_id: "e1", id: "a1", filename: "report.pdf" },
					{ email_id: "e2", id: "a2", filename: "photo.png" },
				],
				[],
			],
			rowsWritten: [0, 2, 2],
		});

		const result = purgeExpiredTrash(ctx, { now });

		// Same layout `attachmentKey` produces everywhere else, so the alarm
		// deletes the blobs the download route would have served.
		expect(result.attachmentKeys).toEqual([
			"attachments/e1/a1/report.pdf",
			"attachments/e2/a2/photo.png",
		]);
	});

	it("reports nothing to do on an empty bin", () => {
		const { ctx } = fakeCtx({ rowsWritten: [0, 0, 0] });
		expect(purgeExpiredTrash(ctx, { now })).toEqual({
			deleted: 0,
			stamped: 0,
			attachmentKeys: [],
		});
	});
});
