// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * "Send now" during the undo window.
 *
 * Every send in this app is a scheduled send with a 30 second delay, so the delay
 * is unconditional — including for the messages the user is certain about. This
 * is the way out of the front of that window, and it has to be the *same* send
 * the alarm would have performed: one delivery, one Sent row, one `Message-ID`.
 * A second code path that happened to also call `EMAIL.send` would be free to
 * drift, which is why `sendScheduledSendNow` and `processDueScheduledSends` share
 * `attemptScheduledSend` and why the assertions below are about the state left
 * behind rather than about the call being made.
 *
 * Run against real SQLite via `node:sqlite` for the same reason
 * `send-failure.test.ts` is: the behaviour is which columns end up set on which
 * row, and a fake that records query strings cannot see that.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	processDueScheduledSends,
	sendScheduledSendNow,
} from "../workers/durableObject/features";
import type { Env } from "../workers/types";

/**
 * Adapter over `node:sqlite` for the slice of `SqlStorage` these paths use.
 *
 * `rowsWritten` reports the REAL count. It used to be hardcoded `0`, which was
 * harmless only for as long as nothing read it — the atomic claim in
 * `attemptScheduledSend` does (`UPDATE … WHERE status = 'pending'`, then checks
 * whether it won), so a stubbed zero makes every caller believe it lost the race
 * and nothing is ever delivered. A fake that invents a value for a field the code
 * under test consults is not a fake, it is a different implementation.
 */
function sqlStorage(db: DatabaseSync): DurableObjectState {
	return {
		storage: {
			sql: {
				exec(query: string, ...bindings: unknown[]) {
					const statement = db.prepare(query);
					const result = statement.all(...(bindings as never[]));
					const rows = result as Record<string, unknown>[];
					// `all()` returns rows for a SELECT and an empty array for a write, so
					// the write count comes from the connection's own change counter.
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
 * An `Env` whose EMAIL binding records what it was asked to send.
 *
 * `sent` is the assertion surface for "exactly once": the risk with a second
 * trigger for delivery is two copies, not zero.
 */
function fakeEnv(options: { fail?: string } = {}) {
	const sent: Record<string, unknown>[] = [];
	const env = {
		EMAIL: {
			send: async (message: Record<string, unknown>) => {
				if (options.fail) throw new Error(options.fail);
				sent.push(message);
				return { messageId: "provider-id" };
			},
		},
		BUCKET: { get: async () => null },
	} as unknown as Env;
	return { env, sent };
}

let db: DatabaseSync;
let ctx: DurableObjectState;

/**
 * A message parked in Scheduled, by default with its delay still running.
 *
 * The future `send_at` is the point: an alarm would not touch this row yet, so
 * anything that delivers it did so because it was asked to.
 */
function seedScheduled(
	id: string,
	options: { attempts?: number; sendAt?: string; status?: string } = {},
) {
	db.prepare(
		`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, message_id)
		 VALUES (?, 'scheduled', 'Invoice', 'ada@example.com', 'grace@example.org',
		         '2026-08-18T09:00:30.000Z', 'Please find attached.', ?)`,
	).run(id, `${id}@example.com`);

	db.prepare(
		`INSERT INTO scheduled_sends (email_id, send_at, status, attempts)
		 VALUES (?, ?, ?, ?)`,
	).run(
		id,
		options.sendAt ?? "2026-08-18T09:00:30.000Z",
		options.status ?? "pending",
		options.attempts ?? 0,
	);
}

function readEmail(id: string) {
	return db
		.prepare(
			`SELECT folder_id, read, delivery_status, delivery_error FROM emails WHERE id = ?`,
		)
		.get(id) as {
		folder_id: string;
		read: number;
		delivery_status: string | null;
		delivery_error: string | null;
	};
}

function readSchedule(id: string) {
	return db
		.prepare(
			`SELECT status, attempts, last_error, send_at FROM scheduled_sends WHERE email_id = ?`,
		)
		.get(id) as
		| {
				status: string;
				attempts: number;
				last_error: string | null;
				send_at: string;
		  }
		| undefined;
}

beforeEach(() => {
	db = new DatabaseSync(":memory:");
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
	`);
	ctx = sqlStorage(db);
});

describe("sendScheduledSendNow", () => {
	it("delivers a message whose delay has not run out", async () => {
		seedScheduled("msg-1");
		const { env, sent } = fakeEnv();

		const result = await sendScheduledSendNow(ctx, env, "msg-1");

		expect(result).toEqual({ status: "sent" });
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ to: ["grace@example.org"] });

		// Ends up indistinguishable from a message the alarm delivered.
		const email = readEmail("msg-1");
		expect(email.folder_id).toBe("sent");
		expect(email.read).toBe(1);
		expect(email.delivery_status).toBe("sent");
		expect(readSchedule("msg-1")).toMatchObject({ status: "sent", attempts: 1 });
	});

	it("does not send a second copy when the alarm runs afterwards", async () => {
		// The race this feature creates. The row is left `status = 'sent'`, which is
		// what keeps it out of the alarm's `pending` query — if it were merely
		// deleted from `scheduled_sends`, or left pending, the recipient would get
		// the message twice.
		seedScheduled("msg-2", { sendAt: "2026-08-18T09:00:00.000Z" });
		const { env, sent } = fakeEnv();

		await sendScheduledSendNow(ctx, env, "msg-2");
		await processDueScheduledSends(ctx, env, {
			now: new Date("2026-08-18T09:05:00.000Z"),
		});

		expect(sent).toHaveLength(1);
	});

	it("reports 409-worthy state when the alarm got there first", async () => {
		// A 30 second window and a button are chasing one row, so this is the
		// likeliest way the call fails. The caller turns it into "already sent"
		// rather than an error, because the user got what they asked for.
		seedScheduled("msg-3", { status: "sent", attempts: 1 });
		const { env, sent } = fakeEnv();

		expect(await sendScheduledSendNow(ctx, env, "msg-3")).toEqual({
			status: "already",
			current: "sent",
		});
		expect(sent).toHaveLength(0);
	});

	it("returns null when there is no such queued message", async () => {
		const { env, sent } = fakeEnv();
		expect(await sendScheduledSendNow(ctx, env, "nope")).toBeNull();
		expect(sent).toHaveLength(0);
	});

	it("returns null when the email row was deleted under it", async () => {
		// A schedule row with no email is nothing the caller can send, and reporting
		// it as a failure would put an error on screen for a message the user has
		// already thrown away.
		seedScheduled("msg-4");
		db.prepare(`PRAGMA foreign_keys = OFF`).run();
		db.prepare(`DELETE FROM emails WHERE id = ?`).run("msg-4");
		const { env } = fakeEnv();

		expect(await sendScheduledSendNow(ctx, env, "msg-4")).toBeNull();
		// The orphan is cleaned up rather than left to be retried forever.
		expect(readSchedule("msg-4")).toBeUndefined();
	});

	it("refuses while the mailbox is over its send quota, and keeps the message queued", async () => {
		// Send now shortens the wait; it is not a way around the hourly and daily
		// limits. The message must stay pending so the alarm can still carry it —
		// silently dropping it here would lose mail to a rate limit.
		seedScheduled("msg-5");
		const { env, sent } = fakeEnv();

		const result = await sendScheduledSendNow(ctx, env, "msg-5", {
			checkRateLimit: async () => "Send quota reached",
		});

		expect(result).toEqual({ status: "deferred", error: "Send quota reached" });
		expect(sent).toHaveLength(0);
		expect(readEmail("msg-5").folder_id).toBe("scheduled");
		expect(readSchedule("msg-5")).toMatchObject({ status: "pending", attempts: 0 });
	});

	it("keeps the message queued when the attempt fails but retries remain", async () => {
		seedScheduled("msg-6", { attempts: 0 });
		const { env } = fakeEnv({ fail: "451 try again later" });
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await sendScheduledSendNow(ctx, env, "msg-6");
		spy.mockRestore();

		expect(result).toEqual({
			status: "failed",
			error: "451 try again later",
			exhausted: false,
		});
		// No banner on a message that is still going to be tried again.
		const email = readEmail("msg-6");
		expect(email.folder_id).toBe("scheduled");
		expect(email.delivery_status).toBeNull();
		expect(readSchedule("msg-6")).toMatchObject({ status: "pending", attempts: 1 });
	});

	it("falls back to Drafts with a reason when the attempt was the last one", async () => {
		// Pressing Send now on a message already down to its final attempt spends
		// it, so the same visible failure the alarm would produce has to happen
		// here: back to Drafts, saying why.
		seedScheduled("msg-7", { attempts: 2 });
		const { env } = fakeEnv({ fail: "550 mailbox unavailable" });
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await sendScheduledSendNow(ctx, env, "msg-7");
		spy.mockRestore();

		expect(result).toEqual({
			status: "failed",
			error: "550 mailbox unavailable",
			exhausted: true,
		});
		const email = readEmail("msg-7");
		expect(email.folder_id).toBe("draft");
		expect(email.delivery_status).toBe("failed");
		expect(email.delivery_error).toBe("550 mailbox unavailable");
	});
});
