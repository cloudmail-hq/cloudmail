/**
 * The mailbox's half of Web Push (migration 41) on the real MailboxDO schema:
 * the facts a decision needs, and holding a push back until triage when an
 * auto-archiving label could still move the message.
 */

import { describe, expect, it } from "vitest";
import { mailboxSqlite } from "./helpers/mailbox-sqlite";
import {
	PUSH_MIN_WAIT_MS,
	PUSH_WAIT_MAX_MS,
	hasAutoArchiveLabel,
	nextPushCheckAt,
	parkPush,
	pendingPushCount,
	pushFacts,
	takeReadyPushes,
} from "../workers/durableObject/push-queue";
import { schedulePushForNewMail } from "../workers/lib/push";
import type { Env } from "../workers/types";

function ctxWithMail() {
	const { ctx } = mailboxSqlite() as unknown as { ctx: DurableObjectState };
	const sql = ctx.storage.sql;
	const insert = (id: string, folder: string, thread: string, extra: Record<string, unknown> = {}) =>
		sql.exec(
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, read, starred, body, thread_id, sender_name, priority)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 0, '', ?, ?, ?)`,
			id,
			folder,
			(extra.subject as string) ?? "Hi",
			(extra.sender as string) ?? "ada@example.com",
			"support@acme.dev",
			"2026-10-27T12:00:00.000Z",
			extra.read ? 1 : 0,
			thread,
			(extra.sender_name as string) ?? "Ada",
			(extra.priority as string) ?? null,
		);
	return { ctx, sql, insert };
}

describe("pushFacts", () => {
	it("reads placement, read state, mute and whether you are in the conversation", () => {
		const { ctx, sql, insert } = ctxWithMail();
		insert("e1", "inbox", "t1", { priority: "high" });
		expect(pushFacts(ctx, "e1")).toMatchObject({
			id: "e1",
			threadId: "t1",
			folder: "inbox",
			read: false,
			muted: false,
			sender: "ada@example.com",
			senderName: "Ada",
			priority: "high",
			inConversation: false,
		});
		insert("s1", "sent", "t1");
		sql.exec(`INSERT INTO muted_threads (thread_id) VALUES ('t1')`);
		expect(pushFacts(ctx, "e1")).toMatchObject({ inConversation: true, muted: true });
		expect(pushFacts(ctx, "missing")).toBeNull();
	});
});

describe("waiting for triage", () => {
	it("only when some label auto-archives", () => {
		const { ctx, sql } = ctxWithMail();
		expect(hasAutoArchiveLabel(ctx)).toBe(false);
		sql.exec(`INSERT INTO labels (id, name, color, auto_archive) VALUES ('l1', 'Newsletters', '#000', 1)`);
		expect(hasAutoArchiveLabel(ctx)).toBe(true);
	});

	it("releases a parked push once triage is done, from where the message ended up", () => {
		const { ctx, sql, insert } = ctxWithMail();
		const t0 = Date.UTC(2026, 9, 27, 12);
		insert("e1", "inbox", "t1");
		insert("e2", "inbox", "t2");
		parkPush(ctx, "e1", "support@acme.dev", "hello@acme.dev", t0);
		parkPush(ctx, "e2", "support@acme.dev", "support@acme.dev", t0);
		sql.exec(`INSERT INTO triage_queue (email_id, mailbox_id, enqueued_at, attempts) VALUES ('e2', 'support@acme.dev', ?, 0)`, new Date(t0).toISOString());
		expect(pendingPushCount(ctx)).toBe(2);

		// Too soon: the triage enqueue may not have landed yet.
		expect(takeReadyPushes(ctx, t0 + PUSH_MIN_WAIT_MS - 1)).toEqual([]);

		// Triage auto-archived e1 meanwhile.
		sql.exec(`UPDATE emails SET folder_id = 'archive' WHERE id = 'e1'`);
		const ready = takeReadyPushes(ctx, t0 + 2_000);
		expect(ready.map((r) => [r.emailId, r.deliveredTo, r.facts?.folder])).toEqual([["e1", "hello@acme.dev", "archive"]]);
		// e2 is still in triage, so it waits, with an alarm at the cap.
		expect(pendingPushCount(ctx)).toBe(1);
		expect(nextPushCheckAt(ctx)).toBe(t0 + PUSH_WAIT_MAX_MS);
		// Past the cap it goes out on what is known.
		expect(takeReadyPushes(ctx, t0 + PUSH_WAIT_MAX_MS).map((r) => r.emailId)).toEqual(["e2"]);
		expect(pendingPushCount(ctx)).toBe(0);
		expect(nextPushCheckAt(ctx)).toBeNull();
	});
});

describe("schedulePushForNewMail", () => {
	it("does nothing for mail that did not land in the Inbox", () => {
		const waits: Promise<unknown>[] = [];
		const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
		const stub = { preparePush: async () => null };
		for (const folder of ["spam", "screener", "archive", "trash"]) {
			expect(schedulePushForNewMail({} as Env, ctx, stub, { mailboxId: "a@b.c", emailId: "e", deliveredTo: "a@b.c", folder, triageQueued: false })).toBe(false);
		}
		expect(waits).toHaveLength(0);
	});

	it("asks the mailbox, in the background, for Inbox mail", async () => {
		const waits: Promise<unknown>[] = [];
		const asked: unknown[] = [];
		const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
		// Parked (null): nothing is dispatched now.
		const stub = { preparePush: async (...args: unknown[]) => (asked.push(args), null) };
		expect(schedulePushForNewMail({} as Env, ctx, stub, { mailboxId: "a@b.c", emailId: "e", deliveredTo: "x@b.c", folder: "inbox", triageQueued: true })).toBe(true);
		await Promise.all(waits);
		expect(asked).toEqual([["e", "a@b.c", "x@b.c", true]]);
	});
});
