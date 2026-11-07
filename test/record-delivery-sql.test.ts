// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * `recordDelivery` against real SQLite.
 *
 * ## Why this runs on a real database
 *
 * The behaviour under test is *which columns end up set on which row*, and the
 * fake context in `features.test.ts` records SQL strings rather than executing
 * them — it would only prove the query text contains the right words. These
 * assertions also catch a column missing from the migration, which a fake cannot
 * see at all. Same reasoning, and the same harness, as `send-failure.test.ts`.
 *
 * ## What it protects
 *
 * Two things that only became load-bearing once we stopped sending our own
 * `Message-ID` (Email Service rejects it, which silently killed every send):
 *
 *   1. The provider's id has to land on the row, because it is now the only id
 *      the outside world knows the message by — so it is what an inbound reply
 *      cites and what `findThreadByMessageIds` / `markBounced` join on. Get this
 *      wrong and delivery works while threading quietly breaks.
 *   2. A delivery failure has to be visible on the row. The send route answers
 *      `202 {"status":"sent"}` before delivery is attempted, so without a
 *      write-back a message that never left looks identical to one that did.
 *      That is precisely why the outage went unnoticed.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordDelivery } from "../workers/durableObject/features";

/** Adapter over `node:sqlite` for the slice of `SqlStorage` this path uses. */
function sqlStorage(db: DatabaseSync): DurableObjectState {
	return {
		storage: {
			sql: {
				exec(query: string, ...bindings: unknown[]) {
					const statement = db.prepare(query);
					const rows = statement.all(
						...(bindings as never[]),
					) as Record<string, unknown>[];
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

function seedSent(id: string, messageId: string | null) {
	db.prepare(
		`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, message_id)
		 VALUES (?, 'sent', 'Hello', 'support@tapetide.com', 'user@example.org',
		         '2026-08-21T09:00:00.000Z', '<p>Hi</p>', ?)`,
	).run(id, messageId);
}

function readEmail(id: string) {
	return db
		.prepare(
			`SELECT folder_id, message_id, delivery_status, delivery_error
			   FROM emails WHERE id = ?`,
		)
		.get(id) as {
		folder_id: string;
		message_id: string | null;
		delivery_status: string | null;
		delivery_error: string | null;
	};
}

beforeEach(() => {
	db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
		INSERT INTO folders (id, name) VALUES
			('inbox', 'Inbox'), ('sent', 'Sent'), ('draft', 'Drafts'),
			('scheduled', 'Scheduled');

		CREATE TABLE emails (
			id TEXT PRIMARY KEY,
			folder_id TEXT NOT NULL REFERENCES folders(id),
			subject TEXT, sender TEXT, recipient TEXT, cc TEXT, bcc TEXT,
			date TEXT, read INTEGER DEFAULT 0, starred INTEGER DEFAULT 0,
			body TEXT, in_reply_to TEXT, email_references TEXT, thread_id TEXT,
			message_id TEXT, raw_headers TEXT,
			delivery_status TEXT, delivery_error TEXT
		);
	`);
	ctx = sqlStorage(db);
});

describe("recordDelivery: success", () => {
	it("overwrites the locally-minted id with the provider's", () => {
		// The row was written before the send, carrying an id we invented that never
		// existed outside our database. This is the correction.
		seedSent("msg-1", "locally-minted@tapetide.com");

		recordDelivery(ctx, "msg-1", {
			providerMessageId: "real-provider-id@cloudflare",
		});

		expect(readEmail("msg-1").message_id).toBe("real-provider-id@cloudflare");
	});

	it("strips angle brackets, so the stored id joins against a cited one", () => {
		// `markBounced` and the inbound reply matcher both compare bare ids. A stored
		// `<x@y>` would never equal the `x@y` read out of an In-Reply-To header, so
		// threading would fail while everything looked correct.
		seedSent("msg-2", null);

		recordDelivery(ctx, "msg-2", { providerMessageId: "<bracketed@cf>" });

		expect(readEmail("msg-2").message_id).toBe("bracketed@cf");
	});

	it("clears a previous failure when a retry succeeds", () => {
		// A message that failed and later went out is delivered; a banner saying
		// otherwise on a message sitting in Sent is worse than no banner.
		seedSent("msg-3", null);
		recordDelivery(ctx, "msg-3", { error: "451 try again" });
		expect(readEmail("msg-3").delivery_status).toBe("failed");

		recordDelivery(ctx, "msg-3", { providerMessageId: "second-try@cf" });

		const email = readEmail("msg-3");
		expect(email.delivery_status).toBe("sent");
		expect(email.delivery_error).toBeNull();
		expect(email.message_id).toBe("second-try@cf");
	});

	it("leaves the message in Sent", () => {
		seedSent("msg-4", null);
		recordDelivery(ctx, "msg-4", { providerMessageId: "ok@cf" });
		expect(readEmail("msg-4").folder_id).toBe("sent");
	});
});

describe("recordDelivery: failure", () => {
	it("records the provider's rejection where the user can see it", () => {
		// The exact message that took outgoing mail down, and which previously
		// reached nothing but console.error.
		seedSent("msg-5", "minted@tapetide.com");

		recordDelivery(ctx, "msg-5", {
			error:
				"custom header 'Message-ID' is not allowed. " +
				"Only whitelisted headers and X-* headers are accepted.",
		});

		const email = readEmail("msg-5");
		expect(email.delivery_status).toBe("failed");
		expect(email.delivery_error).toContain("Message-ID");
	});

	it("caps the reason at the shared 500-char limit", () => {
		// Same cap as the bounce and scheduled-send paths, so one oversized upstream
		// error cannot bloat every row.
		seedSent("msg-6", null);

		recordDelivery(ctx, "msg-6", { error: "x".repeat(900) });

		expect(readEmail("msg-6").delivery_error).toHaveLength(500);
	});

	it("does NOT move the message out of Sent", () => {
		// Deliberate: unlike the scheduled-send path there is no retry pending, and
		// relocating a message the user watched leave would be a second surprise.
		seedSent("msg-7", null);
		recordDelivery(ctx, "msg-7", { error: "550 rejected" });
		expect(readEmail("msg-7").folder_id).toBe("sent");
	});

	it("preserves the stored id on failure", () => {
		// Nothing was delivered, so there is no provider id to adopt; wiping ours
		// would lose the only handle the row has.
		seedSent("msg-8", "minted@tapetide.com");
		recordDelivery(ctx, "msg-8", { error: "550 rejected" });
		expect(readEmail("msg-8").message_id).toBe("minted@tapetide.com");
	});
});

describe("recordDelivery: robustness", () => {
	it("never throws when the row does not exist", () => {
		// It runs on the tail of a fire-and-forget chain, where an exception would
		// become an unhandled rejection.
		expect(() =>
			recordDelivery(ctx, "no-such-row", { providerMessageId: "x@y" }),
		).not.toThrow();
	});

	it("never throws when storage itself fails", () => {
		const broken = {
			storage: {
				sql: {
					exec() {
						throw new Error("storage gone");
					},
				},
			},
		} as unknown as DurableObjectState;
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(() =>
			recordDelivery(broken, "msg-9", { error: "upstream refused" }),
		).not.toThrow();
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});

	it("writes nothing when handed neither an id nor an error", () => {
		seedSent("msg-10", "minted@tapetide.com");
		recordDelivery(ctx, "msg-10", {});
		const email = readEmail("msg-10");
		expect(email.message_id).toBe("minted@tapetide.com");
		expect(email.delivery_status).toBeNull();
	});

	it("treats a blank provider id as absent rather than storing an empty id", () => {
		// An empty message_id would silently match nothing forever.
		seedSent("msg-11", "minted@tapetide.com");
		recordDelivery(ctx, "msg-11", { providerMessageId: "   " });
		expect(readEmail("msg-11").message_id).toBe("minted@tapetide.com");
	});
});
