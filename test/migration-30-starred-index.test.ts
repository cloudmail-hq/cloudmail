// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Migration 30 gives `is:starred` an index, so the Starred view and its count
 * stop scanning every message. Runs the real migrations against node:sqlite
 * and checks the plan the search compiler's statements actually get.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "../shared/search-query";
import { applyMigrations, mailboxMigrations } from "../workers/durableObject/migrations";
import { searchCountSql, searchListSql } from "../workers/durableObject/search";

const NAME = "30_add_starred_index";

function storage(db: DatabaseSync) {
	const done = () => ({ toArray: () => [], rowsWritten: 0, one: () => undefined, [Symbol.iterator]: () => [][Symbol.iterator]() });
	const exec = (query: string, ...bindings: unknown[]) => {
		const trimmed = query.trim();
		if (/^(select|with)/i.test(trimmed)) {
			const rows = db.prepare(trimmed).all(...(bindings as never[])) as Record<string, unknown>[];
			return { toArray: () => rows, rowsWritten: 0, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
		}
		if (bindings.length === 0) db.exec(trimmed);
		else db.prepare(trimmed).run(...(bindings as never[]));
		return done();
	};
	return { sql: { exec }, transactionSync: <T,>(fn: () => T) => fn() };
}

function migrated() {
	const db = new DatabaseSync(":memory:");
	const s = storage(db);
	applyMigrations(s.sql as unknown as SqlStorage, mailboxMigrations, s as never);
	return db;
}

function plan(db: DatabaseSync, st: { sql: string; params: (string | number)[] }): string {
	return (db.prepare(`EXPLAIN QUERY PLAN ${st.sql}`).all(...(st.params as never[])) as { detail: string }[])
		.map((r) => r.detail)
		.join(" | ");
}

describe(`migration ${NAME}`, () => {
	it("is appended after migration 29", () => {
		const names = mailboxMigrations.map((m) => m.name);
		expect(names.indexOf(NAME)).toBe(names.indexOf("29_add_idempotency_keys") + 1);
	});

	it("answers is:starred from the index, list and count", () => {
		const db = migrated();
		const node = parseSearchQuery("is:starred");
		expect(plan(db, searchListSql(node, { limit: 25, offset: 0 }))).toContain("idx_emails_starred_date");
		const count = plan(db, searchCountSql(node));
		expect(count).toContain("idx_emails_starred_date");
		expect(count).not.toMatch(/SCAN e$|SCAN e \|/);
	});

	it("leaves results unchanged", () => {
		const db = migrated();
		const insert = db.prepare(
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, starred)
			 VALUES (?, ?, 's', 'a@example.com', 'b@example.com', ?, 'x', ?)`,
		);
		insert.run("a", "inbox", "2026-10-01T00:00:00Z", 1);
		insert.run("b", "archive", "2026-10-03T00:00:00Z", 1);
		insert.run("c", "inbox", "2026-10-02T00:00:00Z", 0);
		insert.run("d", "trash", "2026-10-04T00:00:00Z", 1);
		const node = parseSearchQuery("is:starred");
		const list = searchListSql(node, { limit: 25, offset: 0 });
		const ids = (db.prepare(list.sql).all(...(list.params as never[])) as { id: string }[]).map((r) => r.id);
		// Trash stays out of an unscoped search; newest first.
		expect(ids).toEqual(["b", "a"]);
		const count = searchCountSql(node);
		expect((db.prepare(count.sql).get(...(count.params as never[])) as { total: number }).total).toBe(2);
	});
});
