// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Send now and the alarm racing for the same queued message.
 *
 * ## Why this file exists separately from send-now.test.ts
 *
 * That suite has a case named "does not send a second copy when the alarm runs
 * afterwards", and it passes — but it awaits `sendScheduledSendNow` to completion
 * *before* running the alarm. Sequentially, the plain `status = 'pending'` read was
 * already enough, so the test could not see the defect Codex reported: both
 * handlers read `pending`, then delivery `await`s `EMAIL.send()`, and the Durable
 * Object is free to run the other one during that await.
 *
 * Verified by mutation — removing the atomic claim left that suite 8/8 green. A
 * test for an interleaving has to actually interleave, or it is testing the
 * sequential path and reporting on the concurrent one.
 *
 * So the fake `EMAIL.send()` here BLOCKS. Both callers are started, the first is
 * suspended mid-delivery, the second runs to completion against a database that
 * still says `pending` under the old code, and only then is the first released.
 * That is the real window, and it is the one that put two copies in a recipient's
 * inbox.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
	processDueScheduledSends,
	sendScheduledSendNow,
} from "../workers/durableObject/features";
import type { Env } from "../workers/types";

/** Adapter over `node:sqlite`, reporting a REAL `rowsWritten` (the claim reads it). */
function sqlStorage(db: DatabaseSync): DurableObjectState {
	return {
		storage: {
			sql: {
				exec(query: string, ...bindings: unknown[]) {
					const rows = db
						.prepare(query)
						.all(...(bindings as never[])) as Record<string, unknown>[];
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
 * An EMAIL binding that suspends inside `send()` until released.
 *
 * This is the whole point of the file: the gap between "I read pending" and "I
 * wrote sent" is where the second caller gets in, and it only exists while an
 * await is outstanding.
 */
function blockingEnv() {
	const sent: Record<string, unknown>[] = [];
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => (release = resolve));
	let firstEntered!: () => void;
	const entered = new Promise<void>((resolve) => (firstEntered = resolve));
	let calls = 0;

	const env = {
		EMAIL: {
			send: async (message: Record<string, unknown>) => {
				calls += 1;
				if (calls === 1) {
					// Announce that delivery is in flight, then hold the lock open.
					firstEntered();
					await blocked;
				}
				sent.push(message);
				return { messageId: `provider-id-${calls}` };
			},
		},
		BUCKET: { get: async () => null },
	} as unknown as Env;

	return { env, sent, release, entered };
}

let db: DatabaseSync;
let ctx: DurableObjectState;

function seedDue(id: string) {
	db.prepare(
		`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, message_id)
		 VALUES (?, 'scheduled', 'Invoice', 'ada@example.com', 'grace@example.org',
		         '2026-08-18T09:00:00.000Z', 'Please find attached.', ?)`,
	).run(id, `${id}@example.com`);
	// Already due, so the alarm is entitled to take it — that is what makes the
	// two callers genuine competitors rather than one obviously being early.
	db.prepare(
		`INSERT INTO scheduled_sends (email_id, send_at, status, attempts)
		 VALUES (?, '2026-08-18T09:00:00.000Z', 'pending', 0)`,
	).run(id);
}

function readSchedule(id: string) {
	return db
		.prepare(`SELECT status, attempts FROM scheduled_sends WHERE email_id = ?`)
		.get(id) as { status: string; attempts: number } | undefined;
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

		CREATE TABLE attachments (
			id TEXT PRIMARY KEY,
			email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
			filename TEXT NOT NULL, mimetype TEXT NOT NULL, size INTEGER NOT NULL,
			content_id TEXT, disposition TEXT
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

describe("Send now interleaved with the alarm", () => {
	it("delivers exactly ONCE when the alarm fires mid-delivery", async () => {
		// The defect: without an atomic claim both callers read `pending`, both
		// proceed, and the recipient receives the message twice.
		seedDue("msg-1");
		const { env, sent, release, entered } = blockingEnv();

		// Start Send now and wait until it is suspended inside EMAIL.send().
		const clicking = sendScheduledSendNow(ctx, env, "msg-1");
		await entered;

		// The alarm runs now, while the first delivery is still in flight and the
		// row has not yet been marked sent.
		await processDueScheduledSends(ctx, env, {
			now: new Date("2026-08-18T09:05:00.000Z"),
		});

		release();
		await clicking;

		expect(sent).toHaveLength(1);
	});

	it("delivers exactly ONCE when Send now arrives mid-alarm", async () => {
		// The mirror image, since either can be first through the door.
		seedDue("msg-2");
		const { env, sent, release, entered } = blockingEnv();

		const alarming = processDueScheduledSends(ctx, env, {
			now: new Date("2026-08-18T09:05:00.000Z"),
		});
		await entered;

		const result = await sendScheduledSendNow(ctx, env, "msg-2");

		release();
		await alarming;

		expect(sent).toHaveLength(1);
		// The click lost, and says so in the shape the route turns into a 409 — which
		// the UI reports as success, because the message did go out.
		expect(result).toEqual({ status: "already", current: "sending" });
	});

	it("leaves the row terminal, not stuck in the in-flight state", async () => {
		// `sending` is a lock. If a delivery could finish while leaving it set, the
		// message would be invisible to the alarm forever.
		seedDue("msg-3");
		const { env, release, entered } = blockingEnv();

		const clicking = sendScheduledSendNow(ctx, env, "msg-3");
		await entered;
		release();
		await clicking;

		expect(readSchedule("msg-3")).toEqual({ status: "sent", attempts: 1 });
	});

	it("counts one attempt, not two, for one delivery", async () => {
		// Two callers each incrementing `attempts` would burn the retry budget on a
		// message that never failed.
		seedDue("msg-4");
		const { env, release, entered } = blockingEnv();

		const clicking = sendScheduledSendNow(ctx, env, "msg-4");
		await entered;
		await processDueScheduledSends(ctx, env, {
			now: new Date("2026-08-18T09:05:00.000Z"),
		});
		release();
		await clicking;

		expect(readSchedule("msg-4")?.attempts).toBe(1);
	});

	it("returns the row to pending when delivery fails, so the alarm can retry", async () => {
		// The claim must not become a leak: a failed attempt has to release the lock
		// or the message is stranded and never retried.
		seedDue("msg-5");
		const env = {
			EMAIL: {
				send: async () => {
					throw new Error("451 try again later");
				},
			},
			BUCKET: { get: async () => null },
		} as unknown as Env;

		const result = await sendScheduledSendNow(ctx, env, "msg-5");

		expect(result).toMatchObject({ status: "failed", exhausted: false });
		expect(readSchedule("msg-5")?.status).toBe("pending");
	});
});
