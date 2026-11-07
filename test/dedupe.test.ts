// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Duplicate inbound delivery.
 *
 * Cloudflare retries the `email()` handler when it throws, and the handler mints
 * a fresh UUID as the row's primary key each time — so a retry was
 * indistinguishable from new mail and the message was stored twice. The sender's
 * `Message-ID` is the only identifier stable across attempts.
 *
 * These run against real SQLite via `node:sqlite`, because the interesting
 * behaviour is the query semantics (exact match, no accidental LIKE, trimming)
 * and a fake returning canned rows would assert nothing about them.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { hasMessageId } from "../workers/durableObject/dedupe";

/** Adapter over `node:sqlite` for the slice of `SqlStorage` this module uses. */
function sqlStorage(db: DatabaseSync): DurableObjectState {
	return {
		storage: {
			sql: {
				exec(query: string, ...bindings: unknown[]) {
					const rows = db
						.prepare(query)
						.all(...(bindings as never[])) as Record<string, unknown>[];
					return {
						toArray: () => rows,
						rowsWritten: 0,
						[Symbol.iterator]: () => rows[Symbol.iterator](),
					};
				},
			},
			transactionSync: <T>(fn: () => T) => fn(),
		},
	} as unknown as DurableObjectState;
}

let db: DatabaseSync;
let ctx: DurableObjectState;

/** Store a message with the given external Message-ID. */
function seed(id: string, messageId: string | null) {
	db.prepare(
		`INSERT INTO emails (id, folder_id, date, message_id)
		 VALUES (?, 'inbox', '2026-06-01T00:00:00.000Z', ?)`,
	).run(id, messageId);
}

beforeEach(() => {
	db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE emails (
			id TEXT PRIMARY KEY,
			folder_id TEXT NOT NULL,
			date TEXT,
			message_id TEXT
		);
		CREATE INDEX idx_emails_message_id ON emails(message_id);
	`);
	ctx = sqlStorage(db);
});

describe("hasMessageId", () => {
	it("reports a stored message as already present", () => {
		// The retry case: this is what makes the second delivery a no-op.
		seed("row-1", "abc@sender.example");
		expect(hasMessageId(ctx, "abc@sender.example")).toBe(true);
	});

	it("reports an unseen message as absent", () => {
		seed("row-1", "abc@sender.example");
		expect(hasMessageId(ctx, "different@sender.example")).toBe(false);
	});

	it("returns false on an empty mailbox", () => {
		expect(hasMessageId(ctx, "abc@sender.example")).toBe(false);
	});

	it("treats a missing Message-ID as never-seen, rather than dropping the mail", () => {
		// A message with no Message-ID cannot be deduplicated. Storing it twice is
		// recoverable; refusing to store it is not.
		seed("row-1", null);
		for (const value of [null, undefined, "", "   "]) {
			expect(hasMessageId(ctx, value)).toBe(false);
		}
	});

	it("ignores surrounding whitespace when comparing", () => {
		seed("row-1", "abc@sender.example");
		expect(hasMessageId(ctx, "  abc@sender.example  ")).toBe(true);
	});

	it("matches exactly, so a prefix is not treated as a duplicate", () => {
		// Guards against the query drifting to LIKE, which would make one arriving
		// message suppress unrelated ones.
		seed("row-1", "abc@sender.example");
		expect(hasMessageId(ctx, "abc")).toBe(false);
		expect(hasMessageId(ctx, "abc@sender.example.extra")).toBe(false);
	});

	it("is case-sensitive, as msg-id comparison is defined to be", () => {
		seed("row-1", "AbC@sender.example");
		expect(hasMessageId(ctx, "abc@sender.example")).toBe(false);
	});

	it("finds a message filed out of the inbox by a rule or spam scoring", () => {
		// Those decisions are made before the row is stored, so restricting the
		// check to the inbox would miss them and duplicate them on a retry.
		db.prepare(
			`INSERT INTO emails (id, folder_id, date, message_id)
			 VALUES ('row-1', 'spam', '2026-06-01T00:00:00.000Z', 'junk@sender.example')`,
		).run();
		expect(hasMessageId(ctx, "junk@sender.example")).toBe(true);
	});

	it("ignores our own Sent copy, so mail to yourself is not discarded", () => {
		/**
		 * Every send path stores a Sent row carrying the very `Message-ID` it put on
		 * the wire. If that counted, then addressing a message to your own mailbox —
		 * or a mailing list echoing your post back with the id preserved — would
		 * look like a duplicate and the inbound copy would be dropped with only a
		 * log line. That is the same data loss this check exists to prevent,
		 * arriving from the other direction.
		 */
		db.prepare(
			`INSERT INTO emails (id, folder_id, date, message_id)
			 VALUES ('sent-copy', 'sent', '2026-06-01T00:00:00.000Z', 'mine@my.example')`,
		).run();

		expect(hasMessageId(ctx, "mine@my.example")).toBe(false);
	});

	it("still catches a real duplicate once the inbound copy exists", () => {
		// Sent copy plus the delivered copy: the second delivery attempt must be
		// recognised even though a Sent row shares the id.
		db.prepare(
			`INSERT INTO emails (id, folder_id, date, message_id)
			 VALUES ('sent-copy', 'sent', '2026-06-01T00:00:00.000Z', 'mine@my.example')`,
		).run();
		seed("inbox-copy", "mine@my.example");

		expect(hasMessageId(ctx, "mine@my.example")).toBe(true);
	});

	it("still reports present when duplicates already exist", () => {
		// The index is intentionally non-unique, so pre-existing duplicates are
		// possible. `LIMIT 1` has to tolerate them rather than error.
		seed("row-1", "dup@sender.example");
		seed("row-2", "dup@sender.example");
		expect(hasMessageId(ctx, "dup@sender.example")).toBe(true);
	});
});
