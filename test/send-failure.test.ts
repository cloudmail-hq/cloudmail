// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Outbound delivery failures becoming visible.
 *
 * A scheduled send that exhausted its attempts used to be demoted back to Drafts
 * with the reason recorded only in `scheduled_sends.last_error` — a table nothing
 * the user can open reads. The message reappeared as a draft saying nothing about
 * why, and pressing Send again just hit the same wall.
 *
 * Run against real SQLite via `node:sqlite` rather than the fake context in
 * `features.test.ts`. The behaviour under test is which columns end up set on
 * which row after a multi-statement transaction, and a fake that returns canned
 * rows and records SQL strings cannot assert that — it would only prove the query
 * text contains the words. These are also the assertions that catch a column
 * missing from the migration, which a fake cannot see at all.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	markBounced,
	processDueScheduledSends,
} from "../workers/durableObject/features";
import type { Env } from "../workers/types";

/**
 * Adapter over `node:sqlite` for the slice of `SqlStorage` these paths use.
 *
 * `rowsWritten` reports the REAL count. It used to be hardcoded `0`, which was
 * harmless only while nothing read it — the atomic claim in
 * `attemptScheduledSend` does (`UPDATE … WHERE status = 'pending'`, then checks
 * whether it won), so a stubbed zero makes every caller believe it lost the race
 * and nothing is ever delivered.
 */
function sqlStorage(db: DatabaseSync): DurableObjectState {
	return {
		storage: {
			sql: {
				exec(query: string, ...bindings: unknown[]) {
					const statement = db.prepare(query);
					const rows = statement.all(
						...(bindings as never[]),
					) as Record<string, unknown>[];
					// `all()` yields rows for a SELECT and nothing for a write, so the
					// write count comes from the connection's own change counter.
					const changes = Number(
						(db.prepare("SELECT changes() AS n").get() as { n: number | bigint })
							?.n ?? 0,
					);
					return {
						toArray: () => rows,
						rowsWritten: changes,
						[Symbol.iterator]: () => rows[Symbol.iterator](),
					};
				},
			},
			transactionSync: <T>(fn: () => T) => fn(),
			getAlarm: async () => null,
			setAlarm: async () => {},
		},
	} as unknown as DurableObjectState;
}

/**
 * An `Env` whose EMAIL binding either accepts or rejects.
 *
 * `BUCKET.get` returns null for every key: these messages have no attachments,
 * and a missing blob is handled by `deliverScheduledEmail` without failing the
 * send, so it cannot be mistaken for the failure being tested.
 */
function fakeEnv(options: { fail?: string } = {}): Env {
	return {
		EMAIL: {
			send: async () => {
				if (options.fail) throw new Error(options.fail);
				return { messageId: "provider-id" };
			},
		},
		BUCKET: { get: async () => null },
	} as unknown as Env;
}

let db: DatabaseSync;
let ctx: DurableObjectState;

/** A message parked in Scheduled with a pending schedule row. */
function seedScheduled(
	id: string,
	options: { attempts?: number; sendAt?: string; messageId?: string } = {},
) {
	db.prepare(
		`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, message_id)
		 VALUES (?, 'scheduled', 'Invoice', 'ada@example.com', 'nobody@example.org',
		         '2026-08-18T09:00:00.000Z', 'Please find attached.', ?)`,
	).run(id, options.messageId ?? `${id}@example.com`);

	db.prepare(
		`INSERT INTO scheduled_sends (email_id, send_at, status, attempts)
		 VALUES (?, ?, 'pending', ?)`,
	).run(
		id,
		options.sendAt ?? "2026-08-18T09:00:00.000Z",
		options.attempts ?? 0,
	);
}

function readEmail(id: string) {
	return db
		.prepare(
			`SELECT folder_id, delivery_status, delivery_error FROM emails WHERE id = ?`,
		)
		.get(id) as {
		folder_id: string;
		delivery_status: string | null;
		delivery_error: string | null;
	};
}

beforeEach(() => {
	db = new DatabaseSync(":memory:");
	// Mirrors the columns migrations 1-22 leave on these two tables. Folders are
	// a real table with a foreign key from `emails`, because the demotion to
	// Drafts writes a folder id and a schema that did not police it would let a
	// typo pass.
	db.exec(`
		CREATE TABLE folders (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE
		);
		INSERT INTO folders (id, name) VALUES
			('inbox', 'Inbox'), ('sent', 'Sent'), ('draft', 'Drafts'),
			('scheduled', 'Scheduled');

		CREATE TABLE emails (
			id TEXT PRIMARY KEY,
			folder_id TEXT NOT NULL REFERENCES folders(id),
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
			delivery_status TEXT,
			delivery_error TEXT
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

		CREATE TABLE scheduled_sends (
			email_id TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
			send_at TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			attempts INTEGER NOT NULL DEFAULT 0,
			last_error TEXT,
			created_at TEXT,
			tracking_base_url TEXT,
			tracking_mailbox_id TEXT,
			track INTEGER
		);

		CREATE TABLE delivery_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			email_id TEXT NOT NULL, recipient TEXT,
			event_type TEXT NOT NULL, source TEXT NOT NULL,
			provider_message_id TEXT, error_cause TEXT, error_detail TEXT,
			metadata TEXT, dedupe_key TEXT,
			occurred_at TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE UNIQUE INDEX idx_delivery_events_dedupe
			ON delivery_events(dedupe_key) WHERE dedupe_key IS NOT NULL;
	`);
	ctx = sqlStorage(db);
});

function ledger(id: string) {
	return db
		.prepare(`SELECT event_type, error_detail FROM delivery_events WHERE email_id = ? ORDER BY id`)
		.all(id) as { event_type: string; error_detail: string | null }[];
}

describe("processDueScheduledSends: delivery ledger", () => {
	// The ledger is what the timeline renders and what outbound webhooks read
	// (`message.delivery_failed`), so the give-up has to land there too.
	it("records a failed event when the last attempt fails", async () => {
		seedScheduled("led-1", { attempts: 2 });
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		await processDueScheduledSends(ctx, fakeEnv({ fail: "550 mailbox unavailable" }), {
			now: new Date("2026-08-18T09:05:00.000Z"),
		});
		spy.mockRestore();
		expect(ledger("led-1")).toEqual([{ event_type: "failed", error_detail: "550 mailbox unavailable" }]);
	});

	it("records nothing while retries remain", async () => {
		seedScheduled("led-2", { attempts: 0 });
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		await processDueScheduledSends(ctx, fakeEnv({ fail: "451 try again later" }), {
			now: new Date("2026-08-18T09:05:00.000Z"),
		});
		spy.mockRestore();
		expect(ledger("led-2")).toEqual([]);
	});
});

describe("processDueScheduledSends: exhausted attempts", () => {
	it("marks the message failed once the attempt budget is gone", async () => {
		// Third attempt of three, so this failure is the terminal one.
		seedScheduled("msg-1", { attempts: 2 });
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});

		await processDueScheduledSends(ctx, fakeEnv({ fail: "550 mailbox unavailable" }), {
			now: new Date("2026-08-18T09:05:00.000Z"),
		});
		spy.mockRestore();

		const email = readEmail("msg-1");
		// The pre-existing behaviour, still intact: the user's text is preserved as
		// a draft rather than being destroyed.
		expect(email.folder_id).toBe("draft");
		// The new part: the draft now says why it is back.
		expect(email.delivery_status).toBe("failed");
		expect(email.delivery_error).toBe("550 mailbox unavailable");
	});

	it("leaves the status unset while retries remain", async () => {
		// First of three failures. Marking it now would put a "couldn't be sent"
		// banner on a message that is still queued and may well go out.
		seedScheduled("msg-2", { attempts: 0 });
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});

		await processDueScheduledSends(ctx, fakeEnv({ fail: "451 try again later" }), {
			now: new Date("2026-08-18T09:05:00.000Z"),
		});
		spy.mockRestore();

		const email = readEmail("msg-2");
		expect(email.folder_id).toBe("scheduled");
		expect(email.delivery_status).toBeNull();
		expect(email.delivery_error).toBeNull();

		// The schedule row still records the attempt and stays pending.
		const schedule = db
			.prepare(`SELECT status, attempts, last_error FROM scheduled_sends WHERE email_id = ?`)
			.get("msg-2") as { status: string; attempts: number; last_error: string };
		expect(schedule.status).toBe("pending");
		expect(schedule.attempts).toBe(1);
		expect(schedule.last_error).toBe("451 try again later");
	});

	it("truncates a long provider error to the column's cap", async () => {
		// A provider or remote server error is free-form text and can run long; the
		// column is rendered in a banner.
		seedScheduled("msg-3", { attempts: 2 });
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});

		await processDueScheduledSends(ctx, fakeEnv({ fail: "x".repeat(900) }), {
			now: new Date("2026-08-18T09:05:00.000Z"),
		});
		spy.mockRestore();

		expect(readEmail("msg-3").delivery_error?.length).toBe(500);
	});

	it("clears a previous failure when a later attempt succeeds", async () => {
		// The case that makes the banner trustworthy. A message that failed twice
		// and went out on the third attempt is delivered, and a "couldn't be sent"
		// banner on a message sitting in Sent is worse than no banner at all.
		seedScheduled("msg-4", { attempts: 2 });
		db.prepare(
			`UPDATE emails
			    SET delivery_status = 'failed', delivery_error = 'earlier failure'
			  WHERE id = ?`,
		).run("msg-4");

		await processDueScheduledSends(ctx, fakeEnv(), {
			now: new Date("2026-08-18T09:05:00.000Z"),
		});

		const email = readEmail("msg-4");
		expect(email.folder_id).toBe("sent");
		expect(email.delivery_status).toBe("sent");
		expect(email.delivery_error).toBeNull();
	});

	it("does not mark anything when the batch is only rate-limited", async () => {
		// Being over quota is not a delivery failure. It does not burn an attempt,
		// so it must not set a status either.
		seedScheduled("msg-5", { attempts: 2 });

		await processDueScheduledSends(ctx, fakeEnv(), {
			now: new Date("2026-08-18T09:05:00.000Z"),
			checkRateLimit: async () => "Send quota reached",
		});

		const email = readEmail("msg-5");
		expect(email.folder_id).toBe("scheduled");
		expect(email.delivery_status).toBeNull();
	});
});

describe("markBounced", () => {
	/** The address every seeded message is addressed to. */
	const RECIPIENT = "nobody@example.org";

	/** A message this mailbox sent, carrying the outgoing Message-ID. */
	function seedSent(id: string, messageId: string, folder = "sent") {
		db.prepare(
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, message_id)
			 VALUES (?, ?, 'Invoice', 'ada@example.com', ?,
			         '2026-08-18T09:00:00.000Z', ?)`,
		).run(id, folder, RECIPIENT, messageId);
	}

	it("marks the sent message the report names", () => {
		seedSent("sent-1", "abc123@example.com");

		const result = markBounced(
			ctx,
			"abc123@example.com",
			"550 5.1.1 User unknown",
			RECIPIENT,
		);

		expect(result).toEqual({ emailId: "sent-1" });
		const email = readEmail("sent-1");
		expect(email.delivery_status).toBe("bounced");
		expect(email.delivery_error).toBe("550 5.1.1 User unknown");
	});

	it("accepts a bracketed Message-ID", () => {
		// Reports quote the id as it appeared in the header; the column stores it
		// bare.
		seedSent("sent-2", "abc123@example.com");
		expect(
			markBounced(ctx, "<abc123@example.com>", "rejected", RECIPIENT),
		).toEqual({ emailId: "sent-2" });
	});

	it("returns null for an id this mailbox never sent", () => {
		// Ordinary for a bounce of a message sent from elsewhere. The caller still
		// stores and delivers the notification.
		seedSent("sent-3", "abc123@example.com");
		expect(
			markBounced(ctx, "unrelated@other.example", "rejected", RECIPIENT),
		).toBeNull();
		expect(readEmail("sent-3").delivery_status).toBeNull();
	});

	it("refuses to mark a received message", () => {
		// The id space is not ours: inbound mail can carry any Message-ID at all,
		// so an unrestricted match would let a forged report stamp a delivery
		// failure onto someone else's mail.
		seedSent("inbound-1", "spoofed@example.com", "inbox");
		expect(
			markBounced(ctx, "spoofed@example.com", "rejected", RECIPIENT),
		).toBeNull();
		expect(readEmail("inbound-1").delivery_status).toBeNull();
	});

	it("refuses to mark a message still queued to go out", () => {
		// Nothing has been delivered to any remote server yet, so there is nothing
		// for one to have rejected.
		seedSent("queued-1", "pending@example.com", "scheduled");
		expect(
			markBounced(ctx, "pending@example.com", "rejected", RECIPIENT),
		).toBeNull();
	});

	it("returns null for a missing or blank id rather than matching broadly", () => {
		// `message_id` is nullable, so a query with an empty needle must not be
		// allowed to reach rows that simply have no id.
		seedSent("sent-4", "abc123@example.com");
		expect(markBounced(ctx, null, "rejected", RECIPIENT)).toBeNull();
		expect(markBounced(ctx, "   ", "rejected", RECIPIENT)).toBeNull();
		expect(markBounced(ctx, undefined, "rejected", RECIPIENT)).toBeNull();
		expect(readEmail("sent-4").delivery_status).toBeNull();
	});

	it("truncates a long diagnostic to the column's cap", () => {
		seedSent("sent-5", "abc123@example.com");
		markBounced(ctx, "abc123@example.com", "y".repeat(900), RECIPIENT);
		expect(readEmail("sent-5").delivery_error?.length).toBe(500);
	});

	/**
	 * A `Message-ID` is not a secret. Every recipient of a message holds one, and
	 * the content-type detection path accepts a `multipart/report` from any
	 * sender, so the Sent-folder restriction alone leaves the id as the only thing
	 * standing between a stranger and our own sent mail.
	 */
	describe("forged reports", () => {
		it("refuses a report naming a recipient the message never had", () => {
			seedSent("sent-6", "abc123@example.com");

			expect(
				markBounced(
					ctx,
					"abc123@example.com",
					"550 your message was terrible",
					"attacker@evil.example",
				),
			).toBeNull();
			expect(readEmail("sent-6").delivery_status).toBeNull();
		});

		it("refuses a report that names no recipient at all", () => {
			// The shape a forger sends, since omitting the field is easier than
			// guessing who the message went to. A genuine DSN always reports which
			// delivery failed.
			seedSent("sent-7", "abc123@example.com");

			expect(markBounced(ctx, "abc123@example.com", "rejected", null)).toBeNull();
			expect(markBounced(ctx, "abc123@example.com", "rejected", "  ")).toBeNull();
			expect(readEmail("sent-7").delivery_status).toBeNull();
		});

		it("matches a recipient in cc or bcc, not only the To header", () => {
			// A bounce can report any one of the addresses the message went to.
			db.prepare(
				`INSERT INTO emails (id, folder_id, subject, sender, recipient, cc, bcc, date, message_id)
				 VALUES ('sent-8', 'sent', 'Invoice', 'ada@example.com', 'to@example.org',
				         'copied@example.org', 'hidden@example.org',
				         '2026-08-18T09:00:00.000Z', 'multi@example.com')`,
			).run();

			expect(
				markBounced(ctx, "multi@example.com", "rejected", "copied@example.org"),
			).toEqual({ emailId: "sent-8" });

			db.prepare(
				`UPDATE emails SET delivery_status = NULL, delivery_error = NULL WHERE id = 'sent-8'`,
			).run();

			expect(
				markBounced(ctx, "multi@example.com", "rejected", "hidden@example.org"),
			).toEqual({ emailId: "sent-8" });
		});

		it("compares addresses irrespective of case and display name", () => {
			// Our header may hold `Ada Lovelace <ada@example.com>` while a remote
			// report gives `ADA@Example.com`. Both sides are folded before matching,
			// so a genuine bounce is not refused over formatting.
			db.prepare(
				`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, message_id)
				 VALUES ('sent-9', 'sent', 'Invoice', 'ada@example.com',
				         'Grace Hopper <grace@example.org>',
				         '2026-08-18T09:00:00.000Z', 'cased@example.com')`,
			).run();

			expect(
				markBounced(ctx, "cased@example.com", "rejected", "GRACE@Example.ORG"),
			).toEqual({ emailId: "sent-9" });
		});
	});
});
