// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Mailbox purge, migrations, and the FTS trigger's scope.
 *
 * These run the real migrations against a real SQLite database via
 * `node:sqlite`, because the bugs being prevented are specifically about a table
 * a hand-written DROP list forgot and the order those drops happen in. Asserting
 * on SQL strings would just restate the list.
 *
 * `MAILBOX.idFromName(address)` means re-creating a mailbox at an address lands
 * on the same Durable Object, so purge has to leave storage in exactly the state
 * a brand-new mailbox would be in. The failure that motivated this: `emails_fts`
 * is an external-content FTS5 index keyed by `emails.rowid`, and it survived the
 * purge. Since `d1_migrations` was dropped, migrations re-ran and rebuilt
 * `emails` with rowids from 1 — colliding with index entries from the destroyed
 * mailbox, so searching for a word that only ever appeared in deleted mail
 * returned whichever new message inherited that rowid.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
	applyMigrations,
	dropAllTables,
	mailboxMigrations,
} from "../workers/durableObject/migrations";

/**
 * Adapt `node:sqlite` to the slice of the `SqlStorage` interface the migration
 * runner and `dropAllTables` use.
 *
 * Multi-statement migration bodies go through `exec`, which node's driver
 * accepts but which cannot carry bindings; anything parameterised or expecting
 * rows goes through `prepare`.
 */
function sqlStorage(db: DatabaseSync): SqlStorage {
	const cursor = (rows: Record<string, unknown>[], rowsWritten = 0) => ({
		toArray: () => rows,
		rowsWritten,
		one: () => rows[0],
		columnNames: rows.length ? Object.keys(rows[0]) : [],
		[Symbol.iterator]: () => rows[Symbol.iterator](),
	});

	return {
		exec(query: string, ...bindings: unknown[]) {
			const isRead = /^\s*(SELECT|PRAGMA|WITH)\b/i.test(query);

			if (bindings.length === 0 && !isRead) {
				db.exec(query);
				return cursor([]) as never;
			}

			const stmt = db.prepare(query);
			if (isRead) {
				return cursor(
					stmt.all(...(bindings as never[])) as Record<string, unknown>[],
				) as never;
			}
			const info = stmt.run(...(bindings as never[]));
			return cursor([], Number(info.changes ?? 0)) as never;
		},
	} as unknown as SqlStorage;
}

/** Minimal storage shim so migrations run inside a transaction, as in prod. */
function storageShim(db: DatabaseSync) {
	return {
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
	};
}

let db: DatabaseSync;
let sql: SqlStorage;

/** Names of every non-internal table currently in the database. */
function tableNames(): string[] {
	return (
		db
			.prepare(
				`SELECT name FROM sqlite_master
				  WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
				  ORDER BY name`,
			)
			.all() as { name: string }[]
	).map((r) => r.name);
}

function triggerNames(): string[] {
	return (
		db
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`,
			)
			.all() as { name: string }[]
	).map((r) => r.name);
}

function migrate() {
	applyMigrations(sql, mailboxMigrations, storageShim(db) as never);
}

beforeEach(() => {
	db = new DatabaseSync(":memory:");
	sql = sqlStorage(db);
	migrate();
});

describe("migrations", () => {
	it("apply cleanly from scratch", () => {
		// If this fails, every other test here is meaningless.
		expect(tableNames()).toContain("emails");
		expect(tableNames()).toContain("d1_migrations");
	});

	it("are idempotent — re-running applies nothing new", () => {
		const before = tableNames();
		migrate();
		expect(tableNames()).toEqual(before);
	});

	it("record every migration, in declaration order", () => {
		// `id` is AUTOINCREMENT, so ordering by it recovers insertion order. The
		// runner keys on `name`, so a rename would silently re-run a migration.
		const applied = (
			db.prepare(`SELECT name FROM d1_migrations ORDER BY id`).all() as {
				name: string;
			}[]
		).map((r) => r.name);
		expect(applied).toEqual(mailboxMigrations.map((m) => m.name));
	});
});

describe("dropAllTables", () => {
	it("leaves no tables behind at all", () => {
		expect(tableNames().length).toBeGreaterThan(5);
		dropAllTables(sql);
		expect(tableNames()).toEqual([]);
	});

	it("removes the FTS index, not just the ordinary tables", () => {
		// The specific omission that corrupted search across a mailbox recreate.
		expect(tableNames()).toContain("emails_fts");
		dropAllTables(sql);
		expect(tableNames()).not.toContain("emails_fts");
	});

	it("removes the FTS shadow tables with their virtual table", () => {
		// FTS5 keeps emails_fts_data/_idx/_docsize/_config. They show up as
		// ordinary tables but cannot be dropped directly, so the virtual table has
		// to go first — this is what that ordering is for.
		expect(tableNames().some((n) => n.startsWith("emails_fts_"))).toBe(true);
		dropAllTables(sql);
		expect(tableNames().some((n) => n.startsWith("emails_fts_"))).toBe(false);
	});

	it("removes tables added by later migrations", () => {
		// The old hand-written list stopped at nine tables and never caught up.
		for (const late of [
			"rules",
			"muted_threads",
			"auto_reply_log",
			"mailbox_state",
			"allowed_senders",
		]) {
			expect(tableNames()).toContain(late);
		}
		dropAllTables(sql);
		expect(tableNames()).toEqual([]);
	});

	it("takes the triggers with the tables they hang off", () => {
		expect(triggerNames().length).toBeGreaterThan(0);
		dropAllTables(sql);
		expect(triggerNames()).toEqual([]);
	});

	it("drops triggers before tables, so a cascade cannot fire a dead trigger", () => {
		/**
		 * The ordering bug this exists to prevent. `folders` is a parent of `emails`
		 * via ON DELETE CASCADE, so dropping it deletes every `emails` row, which
		 * fires the `AFTER DELETE` trigger that writes to `emails_fts`. With the FTS
		 * table already gone, that raised `no such table: main.emails_fts` and the
		 * purge aborted with most tables still standing.
		 */
		db.prepare(
			`INSERT INTO emails (id, folder_id, date, subject, body)
			 VALUES ('m1', 'inbox', '2026-06-01T00:00:00.000Z', 'Subject', 'body')`,
		).run();

		expect(() => dropAllTables(sql)).not.toThrow();
		expect(tableNames()).toEqual([]);
	});

	it("drops the migration ledger, so migrations re-run afterwards", () => {
		dropAllTables(sql);
		expect(tableNames()).not.toContain("d1_migrations");
		migrate();
		expect(tableNames()).toContain("d1_migrations");
	});
});

describe("FTS trigger scope", () => {
	/**
	 * The update trigger was `AFTER UPDATE ON emails`, with no column list, so it
	 * fired for any column. Marking a message read, starring it, moving it,
	 * snoozing it or autosaving a draft therefore tore the whole body out of the
	 * FTS5 index and reinserted it — the most expensive write in the schema,
	 * triggered by the cheapest actions in the UI, on a table where bodies are
	 * stored inline.
	 */
	function triggerSql(name: string): string {
		const row = db
			.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name = ?`)
			.get(name) as { sql: string } | undefined;
		return row?.sql ?? "";
	}

	const seed = (id: string, body: string) =>
		db
			.prepare(
				`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, read)
				 VALUES (?, 'inbox', 'Subject', 'a@b.com', 'me@c.com', '2026-06-01T00:00:00.000Z', ?, 0)`,
			)
			.run(id, body);

	const search = (term: string) =>
		(
			db
				.prepare(
					`SELECT e.id FROM emails_fts f JOIN emails e ON e.rowid = f.rowid
					  WHERE emails_fts MATCH ?`,
				)
				.all(term) as { id: string }[]
		).map((r) => r.id);

	it("only re-indexes when an indexed column changes", () => {
		expect(triggerSql("emails_fts_update")).toMatch(
			/AFTER UPDATE OF\s+subject,\s*body,\s*sender,\s*recipient/i,
		);
	});

	it("still indexes newly inserted mail", () => {
		seed("m1", "the quarterly zygote report");
		expect(search('"zygote"')).toEqual(["m1"]);
	});

	it("keeps the message searchable after a flag-only update", () => {
		// `read` is not an indexed column, so the trigger must not fire — but the
		// existing index entry has to survive, or narrowing it would have broken
		// search for every message anyone opened.
		seed("m1", "the quarterly zygote report");
		db.prepare(`UPDATE emails SET read = 1 WHERE id = 'm1'`).run();
		expect(search('"zygote"')).toEqual(["m1"]);
	});

	it("keeps the message searchable after a folder move", () => {
		seed("m1", "the quarterly zygote report");
		db.prepare(`UPDATE emails SET folder_id = 'archive' WHERE id = 'm1'`).run();
		expect(search('"zygote"')).toEqual(["m1"]);
	});

	it("re-indexes when the body is edited, as a draft autosave does", () => {
		seed("m1", "the original zygote text");
		db.prepare(
			`UPDATE emails SET body = 'replaced with widget text' WHERE id = 'm1'`,
		).run();

		expect(search('"zygote"')).toEqual([]);
		expect(search('"widget"')).toEqual(["m1"]);
	});

	it("re-indexes when the subject is edited", () => {
		seed("m1", "body text");
		db.prepare(
			`UPDATE emails SET subject = 'zygote agreement' WHERE id = 'm1'`,
		).run();
		expect(search('"zygote"')).toEqual(["m1"]);
	});

	it("drops the message from the index when the row is deleted", () => {
		seed("m1", "the quarterly zygote report");
		db.prepare(`DELETE FROM emails WHERE id = 'm1'`).run();
		expect(search('"zygote"')).toEqual([]);
	});
});

describe("message-id index", () => {
	/**
	 * Backs both `findThreadByMessageIds` and the inbound duplicate check. It is
	 * deliberately *not* UNIQUE: duplicate rows may already exist from before the
	 * duplicate check landed, and a migration that throws does so from the Durable
	 * Object constructor, which would make the mailbox permanently unreachable.
	 */
	it("exists", () => {
		const row = db
			.prepare(
				`SELECT name FROM sqlite_master
				  WHERE type='index' AND name='idx_emails_message_id'`,
			)
			.get();
		expect(row).toBeDefined();
	});

	it("is not unique, so existing duplicates cannot brick the mailbox", () => {
		const row = db
			.prepare(
				`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_emails_message_id'`,
			)
			.get() as { sql: string };
		expect(row.sql).not.toMatch(/UNIQUE/i);

		// Proven rather than assumed: two rows sharing a Message-ID must insert.
		for (const id of ["a", "b"]) {
			db.prepare(
				`INSERT INTO emails (id, folder_id, date, message_id)
				 VALUES (?, 'inbox', '2026-06-01T00:00:00.000Z', 'dup@example.com')`,
			).run(id);
		}
		const count = db
			.prepare(
				`SELECT COUNT(*) AS n FROM emails WHERE message_id = 'dup@example.com'`,
			)
			.get() as { n: number };
		expect(count.n).toBe(2);
	});

	it("indexes the attachments foreign key the list queries probe", () => {
		// `hasAttachmentSql` emits a correlated EXISTS on attachments(email_id) in
		// every list, count, search, label and thread query.
		const row = db
			.prepare(
				`SELECT name FROM sqlite_master
				  WHERE type='index' AND name='idx_attachments_email_id'`,
			)
			.get();
		expect(row).toBeDefined();
	});
});

describe("purge round-trip", () => {
	/** Seed one message, mirroring what the inbound handler writes. */
	function seed(id: string, subject: string, body: string) {
		db.prepare(
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body)
			 VALUES (?, 'inbox', ?, 'a@b.com', 'me@c.com', '2026-06-01T00:00:00.000Z', ?)`,
		).run(id, subject, body);
	}

	const search = (term: string) =>
		(
			db
				.prepare(
					`SELECT e.id FROM emails_fts f
					   JOIN emails e ON e.rowid = f.rowid
					  WHERE emails_fts MATCH ?`,
				)
				.all(term) as { id: string }[]
		).map((r) => r.id);

	it("indexes seeded mail for search", () => {
		seed("m1", "Invoice", "the quarterly zygote report");
		expect(search('"zygote"')).toEqual(["m1"]);
	});

	it("does not resurrect deleted mail in search after a recreate", () => {
		// The exact corruption. Seed, purge, re-migrate, seed something unrelated,
		// then search for a word that only existed in the destroyed message.
		seed("old", "Secret", "the quarterly zygote report");
		expect(search('"zygote"')).toEqual(["old"]);

		dropAllTables(sql);
		migrate();

		seed("new", "Hello", "completely unrelated content");

		expect(search('"zygote"')).toEqual([]);
		expect(search('"unrelated"')).toEqual(["new"]);
	});

	it("leaves a purged mailbox with no mail and seeded folders", () => {
		seed("m1", "Invoice", "body");
		dropAllTables(sql);
		migrate();

		const count = db.prepare(`SELECT COUNT(*) AS n FROM emails`).get() as {
			n: number;
		};
		expect(count.n).toBe(0);

		// A recreated mailbox has to look brand new, folders included.
		const folders = (
			db.prepare(`SELECT id FROM folders ORDER BY id`).all() as {
				id: string;
			}[]
		).map((r) => r.id);
		expect(folders).toContain("inbox");
		expect(folders).toContain("sent");
	});

	it("resets the change counter", () => {
		seed("m1", "Invoice", "body");
		const before = db
			.prepare(`SELECT version FROM mailbox_state WHERE id = 1`)
			.get() as { version: number };
		expect(before.version).toBeGreaterThan(0);

		dropAllTables(sql);
		migrate();

		const after = db
			.prepare(`SELECT version FROM mailbox_state WHERE id = 1`)
			.get() as { version: number };
		expect(after.version).toBe(0);
	});
});
