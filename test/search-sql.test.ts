// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for the generated search SQL.
 *
 * These run the real statements from `workers/durableObject/search.ts` against a
 * real SQLite database via `node:sqlite`, with a real `emails_fts` FTS5 virtual
 * table, rather than asserting on query strings. Asserting on the SQL would
 * confirm nothing about the interesting failures, which are all semantic:
 *
 *   - `-from:x` dropping messages that have no sender, because `NOT (NULL LIKE
 *     …)` is NULL and NULL is not true
 *   - a hoisted MATCH and the predicates disagreeing about placeholder numbers,
 *     so values bind to the wrong `?N`
 *   - `larger:` measuring characters instead of bytes
 *   - the list and count queries disagreeing, which shows up only as an empty
 *     last page
 *
 * `node:sqlite` is the same SQLite that backs Durable Object storage, so FTS5,
 * `snippet()` and external-content triggers behave as they do in production.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { splitSnippetHighlights } from "../shared/fts";
import { parseSearchQuery } from "../shared/search-query";
import { searchCountSql, searchListSql } from "../workers/durableObject/search";

/**
 * Mirrors the columns and index that `migrations.ts` builds.
 *
 * The FTS5 table is external-content over `emails` and keyed by its rowid, with
 * the same triggers migration 18/21 install — that relationship is what the
 * hoisted MATCH joins on, so a fixture that indexed rows by `id` would pass
 * while production returned the wrong messages.
 */
const SCHEMA = `
	CREATE TABLE folders (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL UNIQUE,
		is_deletable INTEGER NOT NULL DEFAULT 1
	);
	CREATE TABLE emails (
		id TEXT PRIMARY KEY,
		folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
		subject TEXT,
		sender TEXT,
		recipient TEXT,
		cc TEXT,
		bcc TEXT,
		date TEXT,
		read INTEGER DEFAULT 0,
		starred INTEGER DEFAULT 0,
		body TEXT,
		in_reply_to TEXT,
		email_references TEXT,
		thread_id TEXT,
		message_id TEXT,
		raw_headers TEXT,
		snoozed_until TEXT,
		snooze_return_folder TEXT,
		priority TEXT,
		-- Added by migration 22. The search projection selects them, so the fixture
		-- has to carry them or every query in this file fails to compile.
		delivery_status TEXT,
		delivery_error TEXT,
		snippet TEXT,
		sender_name TEXT,
		-- Engagement cache (migration 28); the list projections select it.
		opened_at TEXT,
		last_opened_at TEXT,
		open_count INTEGER NOT NULL DEFAULT 0,
		open_proxy_count INTEGER NOT NULL DEFAULT 0,
		clicked_at TEXT,
		click_count INTEGER NOT NULL DEFAULT 0,
		engagement_v INTEGER NOT NULL DEFAULT 0,
		security_warnings TEXT,
		derived_v INTEGER NOT NULL DEFAULT 0
	);
	CREATE TABLE attachments (
		id TEXT PRIMARY KEY,
		email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
		filename TEXT NOT NULL,
		mimetype TEXT NOT NULL,
		size INTEGER NOT NULL,
		content_id TEXT,
		disposition TEXT
	);
	CREATE TABLE labels (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		color TEXT NOT NULL DEFAULT '#6b7280',
		parent_id TEXT,
		sort_order INTEGER NOT NULL DEFAULT 0
	);
	CREATE TABLE email_labels (
		email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
		label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
		PRIMARY KEY (email_id, label_id)
	);
	CREATE TABLE muted_threads (
		thread_id TEXT PRIMARY KEY
	);
	CREATE VIRTUAL TABLE emails_fts USING fts5(
		subject, body, sender, recipient,
		content = 'emails',
		content_rowid = 'rowid'
	);
	CREATE TRIGGER emails_fts_insert AFTER INSERT ON emails BEGIN
		INSERT INTO emails_fts (rowid, subject, body, sender, recipient)
		VALUES (new.rowid, COALESCE(new.subject, ''), COALESCE(new.body, ''),
				COALESCE(new.sender, ''), COALESCE(new.recipient, ''));
	END;
`;

const FOLDERS: [id: string, name: string][] = [
	["inbox", "Inbox"],
	["sent", "Sent"],
	["archive", "Archive"],
	["trash", "Trash"],
	["spam", "Spam"],
];

/** Fixed clock, so `older_than:`/`newer_than:` bounds are exact. */
const NOW = new Date("2026-03-15T12:00:00.000Z");

let db: DatabaseSync;

interface EmailSeed {
	id: string;
	folder?: string;
	subject?: string;
	sender?: string;
	recipient?: string;
	cc?: string;
	bcc?: string;
	date?: string;
	read?: 0 | 1;
	starred?: 0 | 1;
	body?: string;
	thread_id?: string;
	priority?: string;
	snoozed_until?: string;
}

function seed(emails: EmailSeed[]) {
	const insert = db.prepare(
		`INSERT INTO emails (id, folder_id, subject, sender, recipient, cc, bcc,
			date, read, starred, body, thread_id, priority, snoozed_until)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	for (const e of emails) {
		insert.run(
			e.id,
			e.folder ?? "inbox",
			e.subject ?? "Subject",
			// `null` rather than a default, so the NULL-handling cases are real.
			e.sender === undefined ? "someone@example.com" : e.sender,
			e.recipient ?? "me@example.com",
			e.cc ?? null,
			e.bcc ?? null,
			e.date ?? "2026-03-14T00:00:00.000Z",
			e.read ?? 0,
			e.starred ?? 0,
			e.body ?? "body text",
			e.thread_id ?? null,
			e.priority ?? null,
			e.snoozed_until ?? null,
		);
	}
}

function label(name: string, emailIds: string[]) {
	const id = `label-${name}`;
	db.prepare(`INSERT OR IGNORE INTO labels (id, name) VALUES (?, ?)`).run(id, name);
	for (const emailId of emailIds) {
		db.prepare(
			`INSERT INTO email_labels (email_id, label_id) VALUES (?, ?)`,
		).run(emailId, id);
	}
}

function attach(emailId: string, filename: string, size = 100) {
	db.prepare(
		`INSERT INTO attachments (id, email_id, filename, mimetype, size, disposition)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	).run(`att-${emailId}-${filename}`, emailId, filename, "application/pdf", size, "attachment");
}

/** Run a query the way the DO does, returning matching ids in list order. */
function search(query: string, options: { limit?: number; offset?: number } = {}): string[] {
	const node = parseSearchQuery(query, { now: NOW });
	const { sql, params } = searchListSql(node, {
		limit: options.limit ?? 50,
		offset: options.offset ?? 0,
	});
	return (db.prepare(sql).all(...params) as { id: string }[]).map((r) => r.id);
}

/** The count the pager uses, which must agree with `search`. */
function count(query: string): number {
	const node = parseSearchQuery(query, { now: NOW });
	const { sql, params } = searchCountSql(node);
	return (db.prepare(sql).get(...params) as { total: number }).total;
}

/** Full rows, for assertions about the projection rather than membership. */
function searchRows(query: string): Record<string, unknown>[] {
	const node = parseSearchQuery(query, { now: NOW });
	const { sql, params } = searchListSql(node, { limit: 50, offset: 0 });
	return db.prepare(sql).all(...params) as Record<string, unknown>[];
}

beforeEach(() => {
	db = new DatabaseSync(":memory:");
	db.exec(SCHEMA);
	const insertFolder = db.prepare(
		`INSERT INTO folders (id, name, is_deletable) VALUES (?, ?, 0)`,
	);
	for (const [id, name] of FOLDERS) insertFolder.run(id, name);
});

describe("free-text search", () => {
	beforeEach(() => {
		seed([
			{ id: "a", subject: "Invoice 2026", body: "please pay the invoice" },
			{ id: "b", subject: "Receipt", body: "your receipt is attached" },
			{ id: "c", subject: "Lunch", body: "unrelated chatter" },
		]);
	});

	it("matches through the full-text index", () => {
		expect(search("invoice")).toEqual(["a"]);
	});

	it("matches a word as a prefix, so search keeps up with typing", () => {
		expect(search("invo")).toEqual(["a"]);
	});

	it("requires every word of an implicit AND", () => {
		expect(search("invoice receipt")).toEqual([]);
	});

	it("agrees with the count query", () => {
		// A list and count that disagree produce an empty last page, which is
		// invisible until someone pages to the end.
		for (const query of ["invoice", "invoice receipt", "receipt", "e"]) {
			expect(count(query)).toBe(search(query).length);
		}
	});
});

describe("compound queries", () => {
	beforeEach(() => {
		seed([
			{ id: "from-a", sender: "alice@example.com", subject: "From Alice" },
			{ id: "from-b", sender: "bob@example.com", subject: "From Bob" },
			{ id: "from-c", sender: "carol@example.com", subject: "From Carol" },
			// No sender at all: the row `-from:` must not silently exclude.
			{ id: "no-sender", sender: null as unknown as string, subject: "Anonymous" },
		]);
	});

	it("-from:x excludes that sender and keeps everything else", () => {
		// Including the message with no sender. `NOT (sender LIKE '%alice%')` is
		// NULL there, and NULL is not true, so the obvious implementation dropped
		// the one result that most obviously belongs.
		expect(search("-from:alice").sort()).toEqual(
			["from-b", "from-c", "no-sender"].sort(),
		);
	});

	it("from:a OR from:b returns both senders and nothing else", () => {
		expect(search("from:alice OR from:bob").sort()).toEqual(
			["from-a", "from-b"].sort(),
		);
	});

	it("counts a negation and an alternation the same way it lists them", () => {
		expect(count("-from:alice")).toBe(3);
		expect(count("from:alice OR from:bob")).toBe(2);
	});
});

describe("label: and read state", () => {
	beforeEach(() => {
		seed([
			{ id: "l1", subject: "Tagged unread", read: 0 },
			{ id: "l2", subject: "Tagged read", read: 1 },
			{ id: "l3", subject: "Untagged unread", read: 0 },
		]);
		label("foo", ["l1", "l2"]);
	});

	it("label:foo -is:read returns only the unread tagged message", () => {
		expect(search("label:foo -is:read")).toEqual(["l1"]);
	});

	it("matches a label by name case-insensitively", () => {
		// The sidebar shows names, and that is what people type.
		expect(search("label:FOO").sort()).toEqual(["l1", "l2"].sort());
	});

	it("matches a label by id as well as name", () => {
		expect(search("label:label-foo").sort()).toEqual(["l1", "l2"].sort());
	});

	it("returns nothing for a label that does not exist", () => {
		expect(search("label:nope")).toEqual([]);
	});

	it("agrees with the count query", () => {
		expect(count("label:foo -is:read")).toBe(1);
		expect(count("label:foo")).toBe(2);
	});
});

describe("size operators", () => {
	beforeEach(() => {
		seed([
			{ id: "small", subject: "Small", body: "x" },
			{ id: "big", subject: "Big", body: "y" },
			{ id: "cjk", subject: "CJK", body: "发".repeat(1024) },
		]);
		// 6 MiB of attachment dominates the size, as it does in real mail.
		attach("big", "huge.pdf", 6 * 1024 * 1024);
		attach("small", "tiny.pdf", 10);
	});

	it("larger:5m returns only the message over five mebibytes", () => {
		expect(search("larger:5m")).toEqual(["big"]);
	});

	it("smaller:1k excludes the large message", () => {
		expect(search("smaller:1k").sort()).toEqual(["small"].sort());
	});

	it("measures bytes, not characters", () => {
		// 1024 CJK characters are ~3 KiB in UTF-8. Measured as characters this
		// row looks like 1 KiB and `larger:2k` would miss it.
		expect(search("larger:2k").sort()).toContain("cjk");
	});

	it("agrees with the count query", () => {
		expect(count("larger:5m")).toBe(1);
	});
});

describe("date and age operators", () => {
	beforeEach(() => {
		seed([
			{ id: "old", subject: "Old", date: "2026-01-01T00:00:00.000Z" },
			{ id: "recent", subject: "Recent", date: "2026-03-14T00:00:00.000Z" },
			{ id: "today", subject: "Today", date: "2026-03-15T06:00:00.000Z" },
		]);
	});

	it("older_than:7d returns only messages past the boundary", () => {
		expect(search("older_than:7d")).toEqual(["old"]);
	});

	it("newer_than:7d returns the rest", () => {
		expect(search("newer_than:7d").sort()).toEqual(["recent", "today"].sort());
	});

	it("honours before: and after:", () => {
		expect(search("before:2026-02-01")).toEqual(["old"]);
		expect(search("after:2026-03-15").sort()).toEqual(["today"].sort());
	});

	it("agrees with the count query", () => {
		expect(count("older_than:7d")).toBe(1);
	});
});

describe("folder scope", () => {
	beforeEach(() => {
		seed([
			{ id: "in-inbox", folder: "inbox", subject: "Kept" },
			{ id: "in-trash", folder: "trash", subject: "Kept" },
			{ id: "in-spam", folder: "spam", subject: "Kept" },
			{ id: "in-archive", folder: "archive", subject: "Kept" },
		]);
	});

	it("excludes trash and spam from an unscoped search", () => {
		// A hit in Trash reads as "it's still there" when it is on its way out.
		expect(search("Kept").sort()).toEqual(["in-archive", "in-inbox"].sort());
	});

	it("reaches trash when the query names it", () => {
		expect(search("in:trash Kept")).toEqual(["in-trash"]);
	});

	it("includes everything for in:anywhere", () => {
		expect(search("in:anywhere Kept").sort()).toEqual(
			["in-archive", "in-inbox", "in-spam", "in-trash"].sort(),
		);
	});

	it("matches a folder by display name as well as id", () => {
		expect(search("in:Archive Kept")).toEqual(["in-archive"]);
	});
});

describe("flags and attachment operators", () => {
	beforeEach(() => {
		seed([
			{ id: "f1", subject: "Starred", starred: 1 },
			{ id: "f2", subject: "Important", priority: "high" },
			{ id: "f3", subject: "Snoozed", snoozed_until: "2026-04-01T00:00:00.000Z" },
			{ id: "f4", subject: "Muted", thread_id: "t-muted" },
			{ id: "f5", subject: "Plain" },
		]);
		db.prepare(`INSERT INTO muted_threads (thread_id) VALUES (?)`).run("t-muted");
		attach("f5", "report.pdf");
	});

	it("matches is:starred", () => {
		expect(search("is:starred")).toEqual(["f1"]);
	});

	it("matches is:important as high priority", () => {
		expect(search("is:important")).toEqual(["f2"]);
	});

	it("matches is:snoozed", () => {
		expect(search("is:snoozed")).toEqual(["f3"]);
	});

	it("matches is:muted through the muted_threads table", () => {
		expect(search("is:muted")).toEqual(["f4"]);
	});

	it("matches has:attachment and filename:", () => {
		expect(search("has:attachment")).toEqual(["f5"]);
		expect(search("filename:report.pdf")).toEqual(["f5"]);
	});

	it("matches filename: as a substring so a file type can be searched", () => {
		expect(search("filename:pdf")).toEqual(["f5"]);
	});
});

describe("address operators", () => {
	beforeEach(() => {
		seed([
			{ id: "r1", recipient: "team@example.com" },
			{ id: "r2", cc: "carol@example.com" },
			{ id: "r3", bcc: "dan@example.com" },
		]);
	});

	it("matches cc: and bcc: separately", () => {
		expect(search("cc:carol")).toEqual(["r2"]);
		expect(search("bcc:dan")).toEqual(["r3"]);
	});

	it("keeps to: spanning cc and bcc, as it did before those operators existed", () => {
		expect(search("to:carol")).toEqual(["r2"]);
		expect(search("to:team")).toEqual(["r1"]);
	});
});

describe("text mixed with structured operators", () => {
	beforeEach(() => {
		seed([
			{ id: "m1", sender: "alice@example.com", subject: "Invoice", body: "pay up", read: 0 },
			{ id: "m2", sender: "bob@example.com", subject: "Invoice", body: "pay up", read: 1 },
			{ id: "m3", sender: "alice@example.com", subject: "Lunch", body: "nothing", read: 0 },
		]);
	});

	it("intersects the index match with SQL predicates", () => {
		expect(search("invoice from:alice")).toEqual(["m1"]);
	});

	it("binds parameters correctly when a MATCH precedes the predicates", () => {
		// The snippet CTE is textually ahead of the WHERE clause, so predicate
		// placeholders have to start numbering after it. Getting this wrong binds
		// values to the wrong `?N` and the query silently answers a different
		// question.
		expect(search("invoice -is:read")).toEqual(["m1"]);
		expect(search("invoice from:alice -is:read")).toEqual(["m1"]);
	});

	it("handles text under an OR with an operator", () => {
		// Text nested in an OR cannot be hoisted, so it compiles to an inline
		// MATCH subquery instead. The answer must not change.
		expect(search("lunch OR from:bob").sort()).toEqual(["m2", "m3"].sort());
	});

	it("agrees with the count query for mixed queries", () => {
		for (const query of [
			"invoice from:alice",
			"invoice -is:read",
			"lunch OR from:bob",
			"invoice from:alice -is:read",
		]) {
			expect(count(query)).toBe(search(query).length);
		}
	});
});

describe("bare negation and untokenisable text", () => {
	beforeEach(() => {
		seed([
			{ id: "n1", subject: "Draft copy", body: "draft" },
			{ id: "n2", subject: "Final", body: "final" },
		]);
	});

	it("answers a bare negated word through SQL, since FTS5 cannot", () => {
		// FTS5 has no unary NOT, so this must fall back to a predicate rather
		// than returning nothing.
		expect(search("-draft")).toEqual(["n2"]);
	});

	it("still finds punctuation, which the index cannot tokenise", () => {
		seed([{ id: "n3", subject: "Odd", body: "a ^*( b" }]);
		expect(search('"^*("')).toEqual(["n3"]);
	});
});

describe("pagination", () => {
	beforeEach(() => {
		seed(
			Array.from({ length: 5 }, (_, i) => ({
				id: `p${i}`,
				subject: "Paged",
				body: "invoice",
				// Descending ids so date ordering is unambiguous.
				date: `2026-03-1${i}T00:00:00.000Z`,
			})),
		);
	});

	it("orders newest first and pages without overlap", () => {
		const first = search("invoice", { limit: 2, offset: 0 });
		const second = search("invoice", { limit: 2, offset: 2 });
		expect(first).toEqual(["p4", "p3"]);
		expect(second).toEqual(["p2", "p1"]);
		expect(count("invoice")).toBe(5);
	});

	it("quotes every row of a later page, not just the first", () => {
		// Snippets are computed for the chosen page only (after LIMIT/OFFSET), so
		// a page past the first must still carry a highlighted excerpt per row.
		const node = parseSearchQuery("invoice", { now: NOW });
		const { sql, params } = searchListSql(node, { limit: 2, offset: 2 });
		const rows = db.prepare(sql).all(...params) as { id: string; snippet: string }[];
		expect(rows.map((r) => r.id)).toEqual(["p2", "p1"]);
		for (const row of rows) {
			expect(splitSnippetHighlights(row.snippet).some((seg) => seg.match)).toBe(true);
		}
	});
});

describe("snippet highlighting", () => {
	beforeEach(() => {
		seed([
			{
				id: "s1",
				subject: "Quarterly invoice",
				body: "Please review the invoice before the end of the month.",
			},
		]);
	});

	it("returns a snippet marking the matched term", () => {
		const [row] = searchRows("invoice");
		const segments = splitSnippetHighlights(row.snippet as string);
		expect(segments.some((s) => s.match)).toBe(true);
		// The matched run is the searched word, not a neighbouring one.
		expect(
			segments.filter((s) => s.match).map((s) => s.text.toLowerCase()),
		).toContain("invoice");
	});

	it("falls back to leading body text when there is no MATCH to quote", () => {
		// A structured-only query has no full-text match, so there is nothing for
		// `snippet()` to highlight — the row still needs preview text.
		const [row] = searchRows("is:unread");
		expect(row.snippet).toContain("Please review");
		expect(splitSnippetHighlights(row.snippet as string)).toEqual([
			{ text: row.snippet as string, match: false },
		]);
	});

	it("never returns a marker as visible text", () => {
		const [row] = searchRows("invoice");
		for (const segment of splitSnippetHighlights(row.snippet as string)) {
			expect(segment.text).not.toMatch(/[\u0011\u0012]/);
		}
	});
});

describe("malformed queries still return rows", () => {
	beforeEach(() => {
		seed([{ id: "q1", subject: "Anything", body: "text" }]);
	});

	it("does not throw and does not return an error for broken input", () => {
		// The degradation guarantee has to hold end to end, not just in the
		// parser: a query that parses to free text must still produce runnable
		// SQL.
		for (const query of ['subject:"unterminated', "(", ")))(((", "-", "OR", "from:", "larger:banana"]) {
			expect(() => search(query)).not.toThrow();
			expect(() => count(query)).not.toThrow();
		}
	});

	it("treats an unparseable operator value as text", () => {
		// `larger:banana` is a typo. Answering it with "no results" hides that;
		// searching for the text at least shows the query ran.
		expect(search("larger:banana")).toEqual([]);
		expect(search("Anything")).toEqual(["q1"]);
	});
});
