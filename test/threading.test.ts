// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for the conversation-grouped message list.
 *
 * These run the real SQL from `workers/durableObject/threading.ts` against a
 * real SQLite database via `node:sqlite`, rather than asserting on query
 * strings. The queries chain six CTEs and two window functions; a fake that
 * returns canned rows would confirm nothing about whether they group correctly,
 * and the interesting failures here are semantic:
 *
 *   - thread counts silently including Trash and Spam
 *   - a list query and its count query disagreeing, so the last page is empty
 *   - a filter that matches the conversation but drops the wrong row
 *
 * `node:sqlite` is the same SQLite that backs Durable Object storage, so window
 * functions, CTEs and `GROUP_CONCAT(DISTINCT …)` all behave as they do in
 * production.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
	ALLOWED_SORT_COLUMNS,
	draftCountSql,
	draftListSql,
	flatFilterConditions,
	threadMessagesSql,
	threadedCountSql,
	threadedFilterClause,
	threadedListSql,
	threadedOrderBy,
	type ListFilterOptions,
} from "../workers/durableObject/threading";

/** Mirrors the columns `workers/db/schema.ts` declares. */
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
`;

/**
 * Folder ids and display names as `migrations.ts` seeds them.
 *
 * The split matters: the id is the lowercase canonical value that
 * `emails.folder_id` stores and that `shared/folders.ts` exports, while `name`
 * is capitalised for display. A fixture that set both to the same string hid a
 * class of bug where SQL looked a folder up by `name = 'draft'` and silently got
 * NULL, so the predicate matched nothing.
 */
const FOLDERS: [id: string, name: string][] = [
	["inbox", "Inbox"],
	["sent", "Sent"],
	["draft", "Drafts"],
	["archive", "Archive"],
	["trash", "Trash"],
	["spam", "Spam"],
];

let db: DatabaseSync;

interface EmailSeed {
	id: string;
	folder: string;
	subject?: string;
	sender?: string;
	date: string;
	read?: 0 | 1;
	starred?: 0 | 1;
	thread_id?: string | null;
	in_reply_to?: string | null;
	body?: string;
}

function seed(emails: EmailSeed[]) {
	const insert = db.prepare(
		`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, read, starred, body, thread_id, in_reply_to)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	for (const e of emails) {
		insert.run(
			e.id,
			e.folder,
			e.subject ?? "Subject",
			e.sender ?? "someone@example.com",
			"me@example.com",
			e.date,
			e.read ?? 0,
			e.starred ?? 0,
			e.body ?? "body text",
			e.thread_id ?? null,
			e.in_reply_to ?? null,
		);
	}
}

function attach(
	emailId: string,
	options: { inline?: boolean; id?: string } = {},
) {
	db.prepare(
		`INSERT INTO attachments (id, email_id, filename, mimetype, size, content_id, disposition)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(
		options.id ?? `att-${emailId}`,
		emailId,
		"file.pdf",
		"application/pdf",
		100,
		options.inline ? "<cid1>" : null,
		options.inline ? "inline" : "attachment",
	);
}

function listThreads(
	folder: string,
	filters: ListFilterOptions = {},
	options: { limit?: number; offset?: number; sort?: any; direction?: any } = {},
) {
	const sql = threadedListSql(filters, options.sort, options.direction);
	return db
		.prepare(sql)
		.all(folder, options.limit ?? 25, options.offset ?? 0) as any[];
}

function countThreads(folder: string, filters: ListFilterOptions = {}) {
	const row = db.prepare(threadedCountSql(filters)).get(folder) as
		| { total: number }
		| undefined;
	return row?.total ?? 0;
}

beforeEach(() => {
	db = new DatabaseSync(":memory:");
	db.exec(SCHEMA);
	const insertFolder = db.prepare(
		"INSERT INTO folders (id, name, is_deletable) VALUES (?, ?, 0)",
	);
	for (const [id, name] of FOLDERS) insertFolder.run(id, name);
});

describe("conversation grouping", () => {
	it("collapses a thread into one row carrying its latest message", () => {
		seed([
			{ id: "a1", folder: "inbox", thread_id: "t1", date: "2026-01-01T10:00:00Z", subject: "Invoice" },
			{ id: "a2", folder: "inbox", thread_id: "t1", date: "2026-01-03T10:00:00Z", subject: "Re: Invoice" },
			{ id: "a3", folder: "inbox", thread_id: "t1", date: "2026-01-02T10:00:00Z", subject: "Re: Invoice" },
		]);

		const rows = listThreads("inbox");
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe("a2");
		expect(rows[0].thread_count).toBe(3);
	});

	it("groups header-less legacy mail by normalized subject", () => {
		seed([
			{ id: "b1", folder: "inbox", thread_id: null, date: "2026-01-01T10:00:00Z", subject: "Renewal" },
			{ id: "b2", folder: "inbox", thread_id: null, date: "2026-01-02T10:00:00Z", subject: "Re: Renewal" },
			{ id: "b3", folder: "inbox", thread_id: null, date: "2026-01-03T10:00:00Z", subject: "FWD: Renewal" },
		]);

		const rows = listThreads("inbox");
		expect(rows).toHaveLength(1);
		expect(rows[0].thread_count).toBe(3);
	});

	it("never merges two header-threaded conversations that share a subject", () => {
		seed([
			{ id: "c1", folder: "inbox", thread_id: "t1", date: "2026-01-01T10:00:00Z", subject: "Hello" },
			{ id: "c2", folder: "inbox", thread_id: "t2", date: "2026-01-02T10:00:00Z", subject: "Hello" },
		]);

		expect(listThreads("inbox")).toHaveLength(2);
		expect(countThreads("inbox")).toBe(2);
	});

	it("returns each conversation exactly once", () => {
		// Regression guard for the fan-out the thread_meta CTE prevents: a thread
		// appearing twice there renders the same mail once per phantom thread.
		seed([
			{ id: "d1", folder: "inbox", thread_id: "t1", date: "2026-01-01T10:00:00Z", subject: "A" },
			{ id: "d2", folder: "inbox", thread_id: "t1", date: "2026-01-02T10:00:00Z", subject: "Re: A" },
			{ id: "d3", folder: "inbox", thread_id: null, date: "2026-01-03T10:00:00Z", subject: "A" },
		]);

		const rows = listThreads("inbox");
		const ids = rows.map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("thread counts across folders", () => {
	it("counts replies sitting in Sent as part of the conversation", () => {
		seed([
			{ id: "e1", folder: "inbox", thread_id: "t1", date: "2026-01-01T10:00:00Z" },
			{ id: "e2", folder: "sent", thread_id: "t1", date: "2026-01-02T10:00:00Z", read: 1 },
		]);

		const rows = listThreads("inbox");
		expect(rows).toHaveLength(1);
		expect(rows[0].thread_count).toBe(2);
	});

	it("excludes Trash and Spam from thread counts", () => {
		seed([
			{ id: "f1", folder: "inbox", thread_id: "t1", date: "2026-01-01T10:00:00Z", read: 1 },
			{ id: "f2", folder: "trash", thread_id: "t1", date: "2026-01-02T10:00:00Z", read: 1 },
			{ id: "f3", folder: "spam", thread_id: "t1", date: "2026-01-03T10:00:00Z", read: 1 },
		]);

		const rows = listThreads("inbox");
		expect(rows[0].thread_count).toBe(1);
	});

	it("does not report a thread unread because a deleted copy is unread", () => {
		// The phantom-unread-dot bug: a message deleted while unread kept its
		// conversation looking unread in the Inbox forever.
		seed([
			{ id: "g1", folder: "inbox", thread_id: "t1", date: "2026-01-01T10:00:00Z", read: 1 },
			{ id: "g2", folder: "trash", thread_id: "t1", date: "2026-01-02T10:00:00Z", read: 0 },
		]);

		const rows = listThreads("inbox");
		expect(rows[0].thread_unread_count).toBe(0);
	});

	it("still counts Trash contents when Trash is the folder being listed", () => {
		seed([
			{ id: "h1", folder: "trash", thread_id: "t1", date: "2026-01-01T10:00:00Z", read: 0 },
			{ id: "h2", folder: "trash", thread_id: "t1", date: "2026-01-02T10:00:00Z", read: 0 },
		]);

		const rows = listThreads("trash");
		expect(rows).toHaveLength(1);
		expect(rows[0].thread_count).toBe(2);
		expect(rows[0].thread_unread_count).toBe(2);
	});

	it("flags a thread with an unsent draft reply", () => {
		seed([
			{ id: "i1", folder: "inbox", thread_id: "t1", date: "2026-01-01T10:00:00Z" },
			{ id: "i2", folder: "draft", thread_id: "t1", date: "2026-01-02T10:00:00Z" },
		]);

		expect(listThreads("inbox")[0].has_draft).toBe(1);
	});

	it("counts a draft toward thread size but not toward unread", () => {
		// Draft rows are stored unread, so counting them left a thread you had
		// started replying to showing an unread dot and a bold subject forever.
		seed([
			{ id: "j1", folder: "inbox", thread_id: "t1", date: "2026-01-01T10:00:00Z", read: 1 },
			{ id: "j2", folder: "draft", thread_id: "t1", date: "2026-01-02T10:00:00Z", read: 0 },
		]);

		const row = listThreads("inbox")[0];
		expect(row.thread_count).toBe(2);
		expect(row.thread_unread_count).toBe(0);
		expect(row.has_draft).toBe(1);
	});
});

describe("list filters", () => {
	beforeEach(() => {
		seed([
			// Unread, no attachment, not starred.
			{ id: "u1", folder: "inbox", thread_id: "t1", date: "2026-01-01T10:00:00Z", read: 0 },
			// Read, starred, with an attachment.
			{ id: "u2", folder: "inbox", thread_id: "t2", date: "2026-01-02T10:00:00Z", read: 1, starred: 1 },
			// Read, no attachment.
			{ id: "u3", folder: "inbox", thread_id: "t3", date: "2026-01-03T10:00:00Z", read: 1 },
		]);
		attach("u2");
	});

	it("narrows to conversations with unread mail", () => {
		const rows = listThreads("inbox", { unread: true });
		expect(rows.map((r) => r.id)).toEqual(["u1"]);
	});

	it("narrows to starred conversations", () => {
		const rows = listThreads("inbox", { starred: true });
		expect(rows.map((r) => r.id)).toEqual(["u2"]);
	});

	it("narrows to conversations with attachments", () => {
		const rows = listThreads("inbox", { has_attachment: true });
		expect(rows.map((r) => r.id)).toEqual(["u2"]);
	});

	it("ignores inline images when filtering by attachment", () => {
		// An embedded cid: image is not an attachment to the person filtering.
		attach("u3", { inline: true, id: "att-inline" });
		const rows = listThreads("inbox", { has_attachment: true });
		expect(rows.map((r) => r.id)).toEqual(["u2"]);
	});

	it("reports has_attachment on the row so the list can show a paperclip", () => {
		const rows = listThreads("inbox");
		const byId = Object.fromEntries(rows.map((r) => [r.id, r.has_attachment]));
		expect(byId.u2).toBe(1);
		expect(byId.u1).toBe(0);
	});

	it("combines filters conjunctively", () => {
		expect(listThreads("inbox", { unread: true, starred: true })).toHaveLength(0);
	});

	it("keeps the count in step with the filtered list", () => {
		// The pager reads the count; if they disagree it offers empty pages.
		for (const filters of [
			{},
			{ unread: true },
			{ starred: true },
			{ has_attachment: true },
			{ unread: true, has_attachment: true },
		] as ListFilterOptions[]) {
			expect(countThreads("inbox", filters)).toBe(
				listThreads("inbox", filters, { limit: 100 }).length,
			);
		}
	});

	it("treats an unread reply in Archive as not matching an Inbox unread filter", () => {
		// Filtering is folder-scoped even though display counts are not.
		seed([
			{ id: "v1", folder: "inbox", thread_id: "t9", date: "2026-02-01T10:00:00Z", read: 1 },
			{ id: "v2", folder: "archive", thread_id: "t9", date: "2026-02-02T10:00:00Z", read: 0 },
		]);
		const ids = listThreads("inbox", { unread: true }).map((r) => r.id);
		expect(ids).not.toContain("v1");
	});
});

describe("sorting", () => {
	beforeEach(() => {
		seed([
			{ id: "s1", folder: "inbox", thread_id: "t1", date: "2026-01-01T10:00:00Z", subject: "Cherry", sender: "carol@example.com" },
			{ id: "s2", folder: "inbox", thread_id: "t2", date: "2026-01-03T10:00:00Z", subject: "Apple", sender: "alice@example.com" },
			{ id: "s3", folder: "inbox", thread_id: "t3", date: "2026-01-02T10:00:00Z", subject: "Banana", sender: "bob@example.com" },
		]);
	});

	it("defaults to newest first", () => {
		expect(listThreads("inbox").map((r) => r.id)).toEqual(["s2", "s3", "s1"]);
	});

	it("sorts by date ascending on request", () => {
		const rows = listThreads("inbox", {}, { sort: "date", direction: "ASC" });
		expect(rows.map((r) => r.id)).toEqual(["s1", "s3", "s2"]);
	});

	it("sorts by subject", () => {
		const rows = listThreads("inbox", {}, { sort: "subject", direction: "ASC" });
		expect(rows.map((r) => r.subject)).toEqual(["Apple", "Banana", "Cherry"]);
	});

	it("sorts by sender", () => {
		const rows = listThreads("inbox", {}, { sort: "sender", direction: "ASC" });
		expect(rows.map((r) => r.sender)).toEqual([
			"alice@example.com",
			"bob@example.com",
			"carol@example.com",
		]);
	});

	it("executes for every allow-listed sort column in both directions", () => {
		// Guards against a column name that is valid in the allow-list but not a
		// real column on the aliased row.
		for (const column of ALLOWED_SORT_COLUMNS) {
			for (const direction of ["ASC", "DESC"] as const) {
				expect(() =>
					listThreads("inbox", {}, { sort: column, direction }),
				).not.toThrow();
			}
		}
	});

	it("falls back to date for an unrecognised sort column", () => {
		const rows = listThreads("inbox", {}, { sort: "body; DROP TABLE emails" });
		expect(rows.map((r) => r.id)).toEqual(["s2", "s3", "s1"]);
		// The table is still there, i.e. nothing was interpolated.
		expect(countThreads("inbox")).toBe(3);
	});
});

describe("pagination", () => {
	it("pages without repeating or dropping a conversation", () => {
		seed(
			Array.from({ length: 7 }, (_, i) => ({
				id: `p${i}`,
				folder: "inbox",
				thread_id: `t${i}`,
				date: `2026-01-0${i + 1}T10:00:00Z`,
			})),
		);

		const first = listThreads("inbox", {}, { limit: 3, offset: 0 });
		const second = listThreads("inbox", {}, { limit: 3, offset: 3 });
		const third = listThreads("inbox", {}, { limit: 3, offset: 6 });

		const seen = [...first, ...second, ...third].map((r) => r.id);
		expect(seen).toHaveLength(7);
		expect(new Set(seen).size).toBe(7);
		expect(countThreads("inbox")).toBe(7);
	});
});

describe("drafts", () => {
	it("keeps reply-drafts to different messages in separate rows", () => {
		// They share a subject and would otherwise collapse into one row, hiding
		// one of the two replies in progress.
		seed([
			{ id: "d1", folder: "draft", in_reply_to: "orig-a", date: "2026-01-01T10:00:00Z", subject: "Re: Status" },
			{ id: "d2", folder: "draft", in_reply_to: "orig-b", date: "2026-01-02T10:00:00Z", subject: "Re: Status" },
		]);

		const rows = db.prepare(draftListSql({}, undefined, undefined)).all("draft", 25, 0) as any[];
		expect(rows).toHaveLength(2);
		const count = db.prepare(draftCountSql({})).get("draft") as { total: number };
		expect(count.total).toBe(2);
	});

	it("gives every brand-new draft its own row", () => {
		seed([
			{ id: "n1", folder: "draft", date: "2026-01-01T10:00:00Z", subject: "" },
			{ id: "n2", folder: "draft", date: "2026-01-02T10:00:00Z", subject: "" },
		]);

		const rows = db.prepare(draftListSql({}, undefined, undefined)).all("draft", 25, 0) as any[];
		expect(rows).toHaveLength(2);
	});

	it("filters drafts by attachment and keeps the count in step", () => {
		seed([
			{ id: "k1", folder: "draft", date: "2026-01-01T10:00:00Z" },
			{ id: "k2", folder: "draft", date: "2026-01-02T10:00:00Z" },
		]);
		attach("k2");

		const rows = db
			.prepare(draftListSql({ has_attachment: true }, undefined, undefined))
			.all("draft", 25, 0) as any[];
		expect(rows.map((r) => r.id)).toEqual(["k2"]);
		const count = db.prepare(draftCountSql({ has_attachment: true })).get("draft") as {
			total: number;
		};
		expect(count.total).toBe(1);
	});

	/**
	 * The defect the grouping key caused.
	 *
	 * `COALESCE(in_reply_to, id)` kept reply-drafts to *different* parents apart —
	 * the case the tests above cover — but two drafts answering the *same* parent
	 * share `in_reply_to`, so they collapsed into one row and the list showed only
	 * the newer. The older was unreachable, and discarding the visible one made the
	 * row reappear showing its sibling, which reads as a delete that did not work.
	 */
	it("shows two drafts replying to the same message as two rows", () => {
		// Two tabs, or the agent's draft_reply running twice.
		seed([
			{ id: "same-1", folder: "draft", in_reply_to: "orig-a", date: "2026-01-01T10:00:00Z", subject: "Re: Status" },
			{ id: "same-2", folder: "draft", in_reply_to: "orig-a", date: "2026-01-02T10:00:00Z", subject: "Re: Status" },
		]);

		const rows = db.prepare(draftListSql({}, undefined, undefined)).all("draft", 25, 0) as any[];

		expect(rows.map((r) => r.id).sort()).toEqual(["same-1", "same-2"]);
		expect(
			(db.prepare(draftCountSql({})).get("draft") as { total: number }).total,
		).toBe(2);
	});

	it("reports every draft as a single message", () => {
		// A row's id is the draft, so Send, Edit and Discard act on what the user is
		// looking at rather than on a group representative.
		seed([
			{ id: "one-1", folder: "draft", in_reply_to: "orig-a", date: "2026-01-01T10:00:00Z" },
			{ id: "one-2", folder: "draft", in_reply_to: "orig-a", date: "2026-01-02T10:00:00Z" },
		]);

		const rows = db.prepare(draftListSql({}, undefined, undefined)).all("draft", 25, 0) as any[];

		expect(rows.every((r) => r.thread_count === 1)).toBe(true);
	});

	it("does not hide a draft behind a sibling when one is discarded", () => {
		// Walks the actual sequence: two drafts to one parent, bin the newer, and the
		// other must still be its own row rather than a reappearing group.
		seed([
			{ id: "keep", folder: "draft", in_reply_to: "orig-a", date: "2026-01-01T10:00:00Z" },
			{ id: "bin", folder: "draft", in_reply_to: "orig-a", date: "2026-01-02T10:00:00Z" },
		]);

		db.prepare(`UPDATE emails SET folder_id = 'trash' WHERE id = 'bin'`).run();

		const rows = db.prepare(draftListSql({}, undefined, undefined)).all("draft", 25, 0) as any[];
		expect(rows.map((r) => r.id)).toEqual(["keep"]);
	});

	it("carries per-draft unread and starred state, not a group's total", () => {
		// These feed the Unread and Starred filters. Summed across a group they made
		// an unread draft surface a read sibling instead.
		seed([
			{ id: "u1", folder: "draft", in_reply_to: "orig-a", date: "2026-01-01T10:00:00Z", read: 1, starred: 0 },
			{ id: "u2", folder: "draft", in_reply_to: "orig-a", date: "2026-01-02T10:00:00Z", read: 0, starred: 1 },
		]);

		const starred = db
			.prepare(draftListSql({ starred: true }, undefined, undefined))
			.all("draft", 25, 0) as any[];
		expect(starred.map((r) => r.id)).toEqual(["u2"]);

		const unread = db
			.prepare(draftListSql({ unread: true }, undefined, undefined))
			.all("draft", 25, 0) as any[];
		expect(unread.map((r) => r.id)).toEqual(["u2"]);

		for (const filters of [{ starred: true }, { unread: true }]) {
			expect(
				(db.prepare(draftCountSql(filters)).get("draft") as { total: number })
					.total,
			).toBe(1);
		}
	});

	it("orders drafts newest-first and paginates without repeating one", () => {
		// Every draft is now its own row, so the page boundaries move; a duplicated
		// or skipped row here is the classic unstable-order failure.
		seed(
			Array.from({ length: 5 }, (_, i) => ({
				id: `pg-${i}`,
				folder: "draft",
				in_reply_to: "orig-a",
				date: `2026-01-0${i + 1}T10:00:00Z`,
			})),
		);

		const page = (offset: number) =>
			(db.prepare(draftListSql({}, undefined, undefined)).all("draft", 2, offset) as any[]).map(
				(r) => r.id,
			);

		const seen = [...page(0), ...page(2), ...page(4)];
		expect(seen).toEqual(["pg-4", "pg-3", "pg-2", "pg-1", "pg-0"]);
		expect(new Set(seen).size).toBe(5);
		expect(
			(db.prepare(draftCountSql({})).get("draft") as { total: number }).total,
		).toBe(5);
	});
});

describe("clause builders", () => {
	it("emits nothing when no filter is set", () => {
		expect(threadedFilterClause({}, "cs")).toBe("");
		expect(flatFilterConditions({})).toEqual([]);
	});

	it("ignores explicitly false filters", () => {
		// `false` means "the user did not tick this", not "only read mail".
		const filters = { unread: false, starred: false, has_attachment: false };
		expect(threadedFilterClause(filters, "cs")).toBe("");
		expect(flatFilterConditions(filters)).toEqual([]);
	});

	it("narrows the sort direction to two literals", () => {
		expect(threadedOrderBy("x", "date", "ASC")).toContain("ASC");
		expect(threadedOrderBy("x", "date", "DESC")).toContain("DESC");
		// Anything else falls back rather than reaching the query.
		expect(threadedOrderBy("x", "date", "; DROP TABLE emails" as any)).toBe(
			"ORDER BY x.date DESC",
		);
	});

	it("adds a stable tiebreaker for non-date sorts", () => {
		expect(threadedOrderBy("x", "subject", "ASC")).toBe(
			"ORDER BY x.subject ASC, x.date DESC",
		);
	});
});

/**
 * Label listing shares the filter vocabulary with the folder list but is
 * deliberately flat: a label applies to a message, so grouping into
 * conversations would hide which message actually carries it.
 */
describe("label listing", () => {
	/** Adapter presenting node:sqlite through the slice of DurableObjectState these helpers use. */
	function fakeCtx() {
		return {
			storage: {
				sql: {
					exec(sql: string, ...params: unknown[]) {
						const rows = db.prepare(sql).all(...(params as any[]));
						return { toArray: () => rows };
					},
				},
			},
		} as unknown as DurableObjectState;
	}

	beforeEach(() => {
		db.exec(`
			CREATE TABLE labels (
				id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#6b7280',
				parent_id TEXT, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT
			);
			CREATE TABLE email_labels (
				email_id TEXT NOT NULL, label_id TEXT NOT NULL, created_at TEXT
			);
		`);
		db.prepare("INSERT INTO labels (id, name) VALUES ('lab-1', 'Invoices')").run();

		seed([
			{ id: "L1", folder: "inbox", date: "2026-01-01T10:00:00Z", subject: "One", read: 0 },
			{ id: "L2", folder: "sent", date: "2026-01-02T10:00:00Z", subject: "Two", read: 1, starred: 1 },
			{ id: "L3", folder: "trash", date: "2026-01-03T10:00:00Z", subject: "Three", read: 0 },
		]);
		attach("L2");
		const link = db.prepare("INSERT INTO email_labels (email_id, label_id) VALUES (?, 'lab-1')");
		for (const id of ["L1", "L2", "L3"]) link.run(id);
	});

	it("spans folders but excludes trashed mail", async () => {
		const { getEmailsByLabel, countEmailsByLabel } = await import(
			"../workers/durableObject/features"
		);
		const rows = getEmailsByLabel(fakeCtx(), "lab-1");
		expect(rows.map((r: any) => r.id).sort()).toEqual(["L1", "L2"]);
		expect(countEmailsByLabel(fakeCtx(), "lab-1")).toBe(2);
	});

	it("filters by unread, starred and attachment", async () => {
		const { getEmailsByLabel, countEmailsByLabel } = await import(
			"../workers/durableObject/features"
		);
		const ctx = fakeCtx();

		expect(getEmailsByLabel(ctx, "lab-1", { unread: true }).map((r: any) => r.id)).toEqual(["L1"]);
		expect(getEmailsByLabel(ctx, "lab-1", { starred: true }).map((r: any) => r.id)).toEqual(["L2"]);
		expect(
			getEmailsByLabel(ctx, "lab-1", { has_attachment: true }).map((r: any) => r.id),
		).toEqual(["L2"]);

		// Count must track the list or the pager offers pages that render empty.
		for (const filters of [
			{ unread: true },
			{ starred: true },
			{ has_attachment: true },
		]) {
			expect(countEmailsByLabel(ctx, "lab-1", filters)).toBe(
				getEmailsByLabel(ctx, "lab-1", filters).length,
			);
		}
	});

	it("reports has_attachment for the paperclip indicator", async () => {
		const { getEmailsByLabel } = await import("../workers/durableObject/features");
		const rows = getEmailsByLabel(fakeCtx(), "lab-1");
		const byId = Object.fromEntries(rows.map((r: any) => [r.id, r.has_attachment]));
		expect(byId.L2).toBe(true);
		expect(byId.L1).toBe(false);
	});

	it("sorts through the shared allow-list", async () => {
		const { getEmailsByLabel } = await import("../workers/durableObject/features");
		const rows = getEmailsByLabel(fakeCtx(), "lab-1", {
			sortColumn: "subject",
			sortDirection: "ASC",
		});
		expect(rows.map((r: any) => r.subject)).toEqual(["One", "Two"]);
	});
});

/**
 * Which of a conversation's messages a view is entitled to show.
 *
 * The bug these pin down was reported as "deleting a draft trashes the whole
 * thread". Nothing was ever trashed but the draft — every delete is keyed on
 * `emails.id` — but the product said otherwise in two places at once, and said it
 * convincingly:
 *
 *   - `conversation_stats` filtered on
 *     `folder_id NOT IN (trash, spam) OR folder_id = ?1`. Listing Trash makes
 *     `?1` Trash, so the disjunction admitted every row in the conversation and
 *     the Trash row reported the whole thread's size.
 *   - `getThreadEmails` had no folder filter at all, so opening that row rendered
 *     every message of the conversation inside the Trash pane — while those same
 *     messages were still sitting in the Inbox.
 *
 * Both now use one rule, `conversationScopeSql`, so a row's count and the messages
 * behind it cannot disagree: in Trash or Spam show only that folder's messages,
 * everywhere else show everything but those two.
 */
describe("conversation scope", () => {
	/** One draft reply discarded out of a five-message conversation. */
	function seedThreadWithDiscardedDraft() {
		seed([
			{ id: "s1", folder: "inbox", thread_id: "t1", date: "2026-01-01T10:00:00Z", read: 1 },
			{ id: "s2", folder: "sent", thread_id: "t1", date: "2026-01-02T10:00:00Z", read: 1 },
			{ id: "s3", folder: "inbox", thread_id: "t1", date: "2026-01-03T10:00:00Z", read: 1 },
			{ id: "s4", folder: "sent", thread_id: "t1", date: "2026-01-04T10:00:00Z", read: 1 },
			{ id: "s5", folder: "trash", thread_id: "t1", date: "2026-01-05T10:00:00Z", read: 1 },
		]);
	}

	it("reports only the trashed message, not the conversation it came from", () => {
		// The headline regression. This used to say 5.
		seedThreadWithDiscardedDraft();

		const rows = listThreads("trash");

		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe("s5");
		expect(rows[0].thread_count).toBe(1);
	});

	it("leaves the same conversation intact in the folder it lives in", () => {
		// The other half: binning one message must not shrink the Inbox row to
		// nothing, nor count the binned one.
		seedThreadWithDiscardedDraft();

		const rows = listThreads("inbox");

		expect(rows).toHaveLength(1);
		expect(rows[0].thread_count).toBe(4);
	});

	it("applies the same rule to Spam", () => {
		seed([
			{ id: "p1", folder: "inbox", thread_id: "t2", date: "2026-02-01T10:00:00Z", read: 1 },
			{ id: "p2", folder: "inbox", thread_id: "t2", date: "2026-02-02T10:00:00Z", read: 1 },
			{ id: "p3", folder: "spam", thread_id: "t2", date: "2026-02-03T10:00:00Z", read: 1 },
		]);

		expect(listThreads("spam")[0].thread_count).toBe(1);
	});

	it("does not let Trash and Spam bleed into each other", () => {
		// Listing one terminal folder must not count the other's rows; before, the
		// disjunction pulled in everything that was not Spam.
		seed([
			{ id: "q1", folder: "trash", thread_id: "t3", date: "2026-03-01T10:00:00Z", read: 1 },
			{ id: "q2", folder: "spam", thread_id: "t3", date: "2026-03-02T10:00:00Z", read: 1 },
		]);

		expect(listThreads("trash")[0].thread_count).toBe(1);
		expect(listThreads("spam")[0].thread_count).toBe(1);
	});

	it("keeps the list and its count in agreement", () => {
		// These share the CTEs precisely so they cannot drift; a scope change is
		// exactly the sort of edit that would break that.
		seedThreadWithDiscardedDraft();

		for (const folder of ["inbox", "trash", "sent"]) {
			expect(countThreads(folder)).toBe(listThreads(folder).length);
		}
	});

	it("still spans folders for an ordinary view", () => {
		// Regression guard on the untouched half: an Inbox row reports the whole
		// exchange including the replies in Sent, which is what the count next to a
		// subject means everywhere else.
		seed([
			{ id: "r1", folder: "inbox", thread_id: "t4", date: "2026-04-01T10:00:00Z", read: 1 },
			{ id: "r2", folder: "sent", thread_id: "t4", date: "2026-04-02T10:00:00Z", read: 1 },
			{ id: "r3", folder: "archive", thread_id: "t4", date: "2026-04-03T10:00:00Z", read: 1 },
		]);

		expect(listThreads("inbox")[0].thread_count).toBe(3);
	});

	it("resolves the viewed folder by display name as well as id", () => {
		// The seeded row is ('trash', 'Trash'), and these queries take either. A
		// scope that only matched the id would silently fall through to the
		// non-terminal branch and show the whole conversation again.
		seedThreadWithDiscardedDraft();

		expect(listThreads("Trash")[0].thread_count).toBe(1);
	});
});

describe("threadMessagesSql", () => {
	const threadMessages = (threadId: string, folder?: string) => {
		const rows = db
			.prepare(threadMessagesSql(!!folder))
			.all(
				threadId,
				50,
				...(folder ? [folder] : []),
			) as { id: string }[];
		return rows.map((r) => r.id);
	};

	beforeEach(() => {
		seed([
			{ id: "m1", folder: "inbox", thread_id: "t1", date: "2026-01-01T10:00:00Z" },
			{ id: "m2", folder: "sent", thread_id: "t1", date: "2026-01-02T10:00:00Z" },
			{ id: "m3", folder: "trash", thread_id: "t1", date: "2026-01-03T10:00:00Z" },
			{ id: "m4", folder: "spam", thread_id: "t1", date: "2026-01-04T10:00:00Z" },
		]);
	});

	it("shows only the trashed messages when Trash is the view", () => {
		// What the reading pane renders after discarding a draft. This used to be
		// the entire conversation, in the bin, while it was also still in the Inbox.
		expect(threadMessages("t1", "trash")).toEqual(["m3"]);
	});

	it("hides Trash and Spam from an ordinary view", () => {
		expect(threadMessages("t1", "inbox")).toEqual(["m1", "m2"]);
	});

	it("shows only spam when Spam is the view", () => {
		expect(threadMessages("t1", "spam")).toEqual(["m4"]);
	});

	it("returns the whole conversation when no view is given", () => {
		// The people-centric panel and API callers have no folder to narrow to, so
		// the unscoped form is deliberately unchanged.
		expect(threadMessages("t1")).toEqual(["m1", "m2", "m3", "m4"]);
	});

	it("returns messages oldest-first for reading order", () => {
		expect(threadMessages("t1", "inbox")).toEqual(["m1", "m2"]);
	});

	it("keeps the newest messages when a conversation exceeds the limit", () => {
		// The limit exists because this returns full bodies over RPC. Dropping the
		// oldest is the right end to lose.
		const ids = db
			.prepare(threadMessagesSql(true))
			.all("t1", 2, "inbox") as { id: string }[];

		expect(ids.map((r) => r.id)).toEqual(["m1", "m2"]);
	});

	it("agrees with what the list row claims", () => {
		// The property that was actually broken: a row saying "N messages" and the
		// pane behind it showing a different number.
		for (const folder of ["inbox", "trash", "spam"]) {
			const row = listThreads(folder)[0];
			expect(threadMessages("t1", folder)).toHaveLength(row.thread_count);
		}
	});
});
