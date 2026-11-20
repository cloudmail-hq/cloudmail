// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Migration 26 (`snippet`, `sender_name`, `derived_v`) and its lazy backfill,
 * against real SQLite with the real migration list.
 *
 * Rows are inserted the way a pre-migration mailbox holds them — no derived
 * values — and the read-path SQL (`threadedListSql`, `searchListSql`, the label
 * list) is then run directly, so what an API or MCP caller would receive is what
 * is asserted.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, mailboxMigrations } from "../workers/durableObject/migrations";
import {
	BACKFILL_BATCH,
	DERIVED_VERSION,
	backfillDerivedColumns,
	deriveColumns,
	hasPendingDerived,
	snippetSql,
} from "../workers/durableObject/derived";
import { threadedListSql } from "../workers/durableObject/threading";
import { searchListSql } from "../workers/durableObject/search";
import { parseSearchQuery } from "../shared/search-query";
import { getEmailsByLabel } from "../workers/durableObject/features";

function makeCtx(db: DatabaseSync): DurableObjectState {
	const cursor = (rows: Record<string, unknown>[], rowsWritten = 0) => ({
		toArray: () => rows,
		one: () => rows[0],
		rowsWritten,
		[Symbol.iterator]: () => rows[Symbol.iterator](),
	});
	return {
		storage: {
			sql: {
				exec(query: string, ...bindings: unknown[]) {
					if (bindings.length === 0 && /;\s*\S/.test(query)) {
						db.exec(query);
						return cursor([]);
					}
					const stmt = db.prepare(query);
					if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(query)) {
						return cursor(stmt.all(...(bindings as never[])) as Record<string, unknown>[]);
					}
					const info = stmt.run(...(bindings as never[]));
					return cursor([], Number(info.changes ?? 0));
				},
			},
			transactionSync: <T>(fn: () => T): T => {
				db.exec("BEGIN");
				try {
					const out = fn();
					db.exec("COMMIT");
					return out;
				} catch (e) {
					db.exec("ROLLBACK");
					throw e;
				}
			},
		},
	} as unknown as DurableObjectState;
}

let db: DatabaseSync;
let ctx: DurableObjectState;

beforeEach(() => {
	db = new DatabaseSync(":memory:");
	ctx = makeCtx(db);
	applyMigrations(
		ctx.storage.sql as never,
		mailboxMigrations,
		ctx.storage as never,
	);
});

/** Insert a row the way a mailbox that predates migration 26 holds it. */
function insertLegacy(row: {
	id: string;
	folder?: string;
	body: string;
	sender?: string;
	raw_headers?: string | null;
	date?: string;
	thread_id?: string;
	subject?: string;
}) {
	db.prepare(
		`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, thread_id, raw_headers)
		 VALUES (?, ?, ?, ?, 'me@tapetide.com', ?, ?, ?, ?)`,
	).run(
		row.id,
		row.folder ?? "inbox",
		row.subject ?? "Hello",
		row.sender ?? "priya@example.com",
		row.date ?? "2026-10-25T10:00:00.000Z",
		row.body,
		row.thread_id ?? row.id,
		row.raw_headers ?? null,
	);
}

function read(id: string) {
	return db
		.prepare(`SELECT snippet, sender_name, derived_v FROM emails WHERE id = ?`)
		.get(id) as { snippet: string | null; sender_name: string | null; derived_v: number };
}

describe("migration 26", () => {
	it("adds the columns with legacy rows pending", () => {
		insertLegacy({ id: "a", body: "<p>Hi</p>" });
		expect(read("a")).toEqual({ snippet: null, sender_name: null, derived_v: 0 });
		expect(hasPendingDerived(ctx)).toBe(true);
	});

	it("serves the old raw slice until a row is backfilled, then clean text", () => {
		insertLegacy({ id: "a", body: "<p>Second QA test with Cc.</p>" });
		const before = db
			.prepare(`SELECT ${snippetSql()} AS s FROM emails WHERE id = 'a'`)
			.get() as { s: string };
		expect(before.s).toBe("<p>Second QA test with Cc.</p>");

		backfillDerivedColumns(ctx);
		const after = db
			.prepare(`SELECT ${snippetSql()} AS s FROM emails WHERE id = 'a'`)
			.get() as { s: string };
		expect(after.s).toBe("Second QA test with Cc.");
	});
});

describe("backfillDerivedColumns", () => {
	it("fills snippet and sender_name from body and raw_headers", () => {
		insertLegacy({
			id: "a",
			body: "<style>p{}</style><p>Invoice &amp; receipt</p>",
			raw_headers: JSON.stringify([{ key: "from", value: '"Priya Sharma" <priya@example.com>' }]),
		});
		expect(backfillDerivedColumns(ctx)).toBe(1);
		expect(read("a")).toEqual({
			snippet: "Invoice & receipt",
			sender_name: "Priya Sharma",
			derived_v: DERIVED_VERSION,
		});
		expect(hasPendingDerived(ctx)).toBe(false);
		expect(backfillDerivedColumns(ctx)).toBe(0);
	});

	it("works in bounded batches, newest first", () => {
		const total = BACKFILL_BATCH + 15;
		for (let i = 0; i < total; i++) {
			insertLegacy({
				id: `m${i}`,
				body: `<p>n${i}</p>`,
				date: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
			});
		}
		expect(backfillDerivedColumns(ctx)).toBe(BACKFILL_BATCH);
		// The newest row is done in the first batch; the oldest waits.
		expect(read(`m${total - 1}`).snippet).toBe(`n${total - 1}`);
		expect(read("m0").snippet).toBeNull();
		expect(backfillDerivedColumns(ctx)).toBe(15);
		expect(hasPendingDerived(ctx)).toBe(false);
	});

	it("does not re-index the body in FTS (trigger is column-scoped)", () => {
		insertLegacy({ id: "a", body: "<p>needle</p>" });
		const fts = () =>
			(db.prepare(`SELECT COUNT(*) AS n FROM emails_fts WHERE emails_fts MATCH 'needle'`).get() as {
				n: number;
			}).n;
		expect(fts()).toBe(1);
		backfillDerivedColumns(ctx);
		expect(fts()).toBe(1);
	});

	it("keeps an explicit sender_name rather than guessing from headers", () => {
		expect(
			deriveColumns({
				body: "x",
				sender: "a@b.co",
				sender_name: "Set at ingest",
				raw_headers: JSON.stringify([{ key: "from", value: "Header Name <a@b.co>" }]),
			}).sender_name,
		).toBe("Set at ingest");
	});

	it("never throws on a broken row", () => {
		insertLegacy({ id: "a", body: "<p>ok</p>", raw_headers: "{not json" });
		expect(() => backfillDerivedColumns(ctx)).not.toThrow();
		expect(read("a").derived_v).toBe(DERIVED_VERSION);
	});
});

describe("list and search return clean text", () => {
	beforeEach(() => {
		insertLegacy({
			id: "a",
			body: '<html><head><style>.x{}</style></head><body><p>Quarterly <b>invoice</b> attached</p></body></html>',
			raw_headers: JSON.stringify([{ key: "from", value: "Priya Sharma <priya@example.com>" }]),
		});
		backfillDerivedColumns(ctx);
	});

	it("threaded list", () => {
		const rows = db.prepare(threadedListSql({})).all("inbox", 25, 0) as Record<string, unknown>[];
		expect(rows[0].snippet).toBe("Quarterly invoice attached");
		expect(rows[0].sender_name).toBe("Priya Sharma");
		expect(JSON.parse(rows[0].participant_names as string)).toEqual({
			"priya@example.com": "Priya Sharma",
		});
	});

	it("search without a text term returns the stored snippet", () => {
		const { sql, params, ftsSnippet } = searchListSql(parseSearchQuery("from:priya@example.com"), {
			limit: 10,
			offset: 0,
		});
		expect(ftsSnippet).toBe(false);
		const rows = db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
		expect(rows[0].snippet).toBe("Quarterly invoice attached");
		expect(rows[0].sender_name).toBe("Priya Sharma");
	});

	it("search with a text term flags its FTS excerpt for cleanup", () => {
		const { ftsSnippet } = searchListSql(parseSearchQuery("invoice"), { limit: 10, offset: 0 });
		expect(ftsSnippet).toBe(true);
	});

	it("label list", () => {
		db.prepare(`INSERT INTO labels (id, name) VALUES ('l1', 'Work')`).run();
		db.prepare(`INSERT INTO email_labels (email_id, label_id) VALUES ('a', 'l1')`).run();
		const rows = getEmailsByLabel(ctx, "l1") as Record<string, unknown>[];
		expect(rows[0].snippet).toBe("Quarterly invoice attached");
		expect(rows[0].sender_name).toBe("Priya Sharma");
	});
});
