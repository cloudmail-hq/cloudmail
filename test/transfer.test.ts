// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for cross-namespace mailbox transfer.
 *
 * The risky parts are pinned here: `importAll` interpolates table and column
 * names into SQL, and its payload arrives over an HTTP endpoint, so the
 * allowlisting has to hold. `exportAll` and `stats` run against a possibly
 * older schema, so missing tables must not throw.
 */

import { describe, expect, it } from "vitest";
import {
	exportAll,
	importAll,
	stats,
	type ExportShape,
} from "../workers/durableObject/transfer";

interface FakeTable {
	columns: string[];
	rows: Record<string, unknown>[];
}

/**
 * Fake DurableObjectState that answers the handful of query shapes transfer.ts
 * issues, routing on the SQL text rather than on call order.
 */
function fakeCtx(tables: Record<string, FakeTable>) {
	const inserts: { table: string; columns: string[]; values: unknown[] }[] = [];

	const exec = (sql: string, ...params: unknown[]) => {
		const rows = (() => {
			if (sql.includes("sqlite_master")) {
				const name = String(params[0]);
				return name in tables ? [{ 1: 1 }] : [];
			}

			if (sql.includes("pragma_table_info")) {
				const name = String(params[0]);
				return (tables[name]?.columns ?? []).map((c) => ({ name: c }));
			}

			const countMatch = sql.match(/SELECT COUNT\(\*\) AS total FROM (\w+)/);
			if (countMatch) return [{ total: tables[countMatch[1]]?.rows.length ?? 0 }];

			const selectMatch = sql.match(/SELECT \* FROM (\w+)/);
			if (selectMatch) return tables[selectMatch[1]]?.rows ?? [];

			const insertMatch = sql.match(/INSERT OR IGNORE INTO (\w+) \(([^)]+)\)/);
			if (insertMatch) {
				inserts.push({
					table: insertMatch[1],
					columns: insertMatch[2].split(",").map((c) => c.trim()),
					values: params,
				});
				return [];
			}

			return [];
		})();

		return { toArray: () => rows };
	};

	const ctx = {
		storage: {
			sql: { exec },
			transactionSync: <T>(fn: () => T) => fn(),
		},
	};

	return { ctx: ctx as unknown as DurableObjectState, inserts };
}

const emailsTable: FakeTable = {
	columns: ["id", "folder_id", "subject", "read", "priority"],
	rows: [],
};

describe("stats", () => {
	it("reports 0 for tables absent on an older schema instead of throwing", () => {
		const { ctx } = fakeCtx({
			folders: { columns: ["id"], rows: [{ id: "inbox" }] },
		});

		const result = stats(ctx);
		expect(result.folders).toBe(1);
		// Added by migrations 9-13; a legacy object predates them.
		expect(result.labels).toBe(0);
		expect(result.scheduled_sends).toBe(0);
	});
});

describe("exportAll", () => {
	it("returns an empty array for tables the schema does not have", () => {
		const { ctx } = fakeCtx({
			emails: { ...emailsTable, rows: [{ id: "e1", subject: "hi" }] },
		});

		const dump = exportAll(ctx);
		expect(dump.emails).toEqual([{ id: "e1", subject: "hi" }]);
		expect(dump.labels).toEqual([]);
	});
});

describe("importAll", () => {
	it("writes parents before the rows that reference them", () => {
		const { ctx, inserts } = fakeCtx({
			folders: { columns: ["id", "name"], rows: [] },
			emails: emailsTable,
			labels: { columns: ["id", "name"], rows: [] },
			email_labels: { columns: ["email_id", "label_id"], rows: [] },
		});

		// Deliberately out of dependency order in the payload.
		importAll(ctx, {
			email_labels: [{ email_id: "e1", label_id: "l1" }],
			emails: [{ id: "e1" }],
			labels: [{ id: "l1", name: "Work" }],
			folders: [{ id: "inbox", name: "Inbox" }],
		});

		expect(inserts.map((i) => i.table)).toEqual([
			"folders",
			"emails",
			"labels",
			"email_labels",
		]);
	});

	it("drops columns that do not exist on the target table", () => {
		const { ctx, inserts } = fakeCtx({ emails: emailsTable });

		importAll(ctx, {
			emails: [{ id: "e1", subject: "hi", bogus_column: "nope" }],
		});

		expect(inserts).toHaveLength(1);
		expect(inserts[0].columns).toEqual(["id", "subject"]);
		expect(inserts[0].values).toEqual(["e1", "hi"]);
	});

	it("rejects keys that are not plain identifiers", () => {
		const { ctx, inserts } = fakeCtx({ emails: emailsTable });

		importAll(ctx, {
			emails: [{ "id) VALUES ('x'); DROP TABLE emails; --": "boom", id: "e1" }],
		});

		expect(inserts[0].columns).toEqual(["id"]);
	});

	it("ignores tables outside the transfer allowlist", () => {
		const { ctx, inserts } = fakeCtx({ emails: emailsTable });

		importAll(ctx, {
			d1_migrations: [{ id: 1, name: "1_initial_setup" }],
			sqlite_master: [{ name: "evil" }],
		} as ExportShape);

		expect(inserts).toHaveLength(0);
	});

	it("skips a row whose every column was filtered out", () => {
		const { ctx, inserts } = fakeCtx({ emails: emailsTable });
		importAll(ctx, { emails: [{ unknown_a: 1, unknown_b: 2 }] });
		expect(inserts).toHaveLength(0);
	});

	it("coerces JSON values into what SQLite accepts", () => {
		const { ctx, inserts } = fakeCtx({ emails: emailsTable });

		importAll(ctx, {
			emails: [{ id: "e1", read: true, priority: null, subject: { nested: 1 } }],
		});

		expect(inserts[0].values).toEqual(["e1", 1, null, '{"nested":1}']);
	});

	it("reports per-table counts and tolerates a missing table", () => {
		const { ctx } = fakeCtx({ emails: emailsTable });

		const result = importAll(ctx, {
			emails: [{ id: "e1" }, { id: "e2" }],
			labels: [{ id: "l1", name: "Work" }],
		});

		expect(result.emails).toBe(2);
		// `labels` does not exist on this target, so nothing was written.
		expect(result.labels).toBe(0);
	});

	it("handles an empty or malformed payload without throwing", () => {
		const { ctx, inserts } = fakeCtx({ emails: emailsTable });

		expect(() => importAll(ctx, {} as ExportShape)).not.toThrow();
		expect(() =>
			importAll(ctx, { emails: "not an array" } as unknown as ExportShape),
		).not.toThrow();
		expect(() =>
			importAll(ctx, { emails: [null] } as unknown as ExportShape),
		).not.toThrow();
		expect(inserts).toHaveLength(0);
	});
});
