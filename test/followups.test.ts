// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Follow-up reminders against real SQLite with every mailbox migration applied.
 *
 * What is pinned here:
 *   - the shared alarm: a reminder joins snoozes and scheduled sends in
 *     `nextDeadline`, and firing one does not disturb either of the others;
 *   - cancel on reply: an inbound message in the thread ends the reminder, and
 *     an automated one, a spam one or our own does not;
 *   - reset on re-reply: replying again moves the reminder to the new message
 *     and restarts the same clock;
 *   - the Inbox return: the watched row comes back unread with the Follow up
 *     label, and a later reply or a dismissal puts it back in Sent.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, mailboxMigrations } from "../workers/durableObject/migrations";
import * as followups from "../workers/durableObject/followups";
import {
	nextDeadline,
	processDueSnoozes,
	recordScheduledSend,
	snoozeEmail,
} from "../workers/durableObject/features";
import { FOLLOWUP_LABEL_NAME } from "../shared/followups";

function sqlStorage(db: DatabaseSync): DurableObjectState {
	const exec = (query: string, ...bindings: unknown[]) => {
		const trimmed = query.trim();
		if (bindings.length === 0 && !/^(select|with)/i.test(trimmed)) {
			db.exec(trimmed);
			return { toArray: () => [], rowsWritten: 0, one: () => undefined, [Symbol.iterator]: () => [][Symbol.iterator]() };
		}
		const rows = db.prepare(trimmed).all(...(bindings as never[])) as Record<string, unknown>[];
		const changes = Number((db.prepare("SELECT changes() AS n").get() as { n: number | bigint })?.n ?? 0);
		return {
			toArray: () => rows,
			rowsWritten: /^(select|with)/i.test(trimmed) ? 0 : changes,
			one: () => rows[0],
			[Symbol.iterator]: () => rows[Symbol.iterator](),
		};
	};
	return {
		id: { name: "founder@tapetide.com" },
		storage: {
			sql: { exec },
			transactionSync: <T>(fn: () => T) => fn(),
			getAlarm: async () => null,
			setAlarm: async () => {},
		},
	} as unknown as DurableObjectState;
}

let db: DatabaseSync;
let ctx: DurableObjectState;

const T0 = new Date("2026-10-01T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (ms: number) => new Date(T0.getTime() + ms);

beforeEach(() => {
	db = new DatabaseSync(":memory:");
	ctx = sqlStorage(db);
	applyMigrations(ctx.storage.sql as unknown as SqlStorage, mailboxMigrations, ctx.storage as never);
});

/** Insert a row, then run the same hook `MailboxDO.createEmail` runs. */
function store(row: {
	id: string;
	folder: string;
	thread: string;
	date?: string;
	sender?: string;
	raw_headers?: string | null;
	read?: number;
}, now = T0) {
	db.prepare(
		`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, thread_id, raw_headers, read)
		 VALUES (?, ?, 'Pricing', ?, 'customer@example.org', ?, '<p>Any thoughts?</p>', ?, ?, ?)`,
	).run(
		row.id,
		row.folder,
		row.sender ?? (row.folder === "sent" ? "founder@tapetide.com" : "customer@example.org"),
		row.date ?? now.toISOString(),
		row.thread,
		row.raw_headers ?? null,
		row.read ?? (row.folder === "sent" ? 1 : 0),
	);
	return followups.onEmailStored(
		ctx,
		{ id: row.id, folder_id: row.folder, thread_id: row.thread, raw_headers: row.raw_headers ?? null },
		now,
	);
}

function remind(emailId: string, days = 3, now = T0) {
	return followups.setFollowup(ctx, {
		emailId,
		followupAt: new Date(now.getTime() + days * DAY).toISOString(),
		mode: "manual",
		durationSeconds: days * 86400,
		now,
	});
}

const email = (id: string) =>
	db.prepare(`SELECT folder_id, read FROM emails WHERE id = ?`).get(id) as { folder_id: string; read: number };
const followupRow = (id: string) =>
	db.prepare(`SELECT * FROM followups WHERE email_id = ?`).get(id) as followups.FollowupRow | undefined;
const labelsOf = (id: string) =>
	(db
		.prepare(`SELECT l.name FROM email_labels el JOIN labels l ON l.id = el.label_id WHERE el.email_id = ?`)
		.all(id) as { name: string }[]).map((r) => r.name);

describe("alarm multiplexing", () => {
	it("puts the earliest of snooze, scheduled send and follow-up on the one alarm", () => {
		store({ id: "sent-1", folder: "sent", thread: "t1" });
		remind("sent-1", 1);
		store({ id: "in-2", folder: "inbox", thread: "t2" });
		snoozeEmail(ctx, "in-2", at(2 * DAY).toISOString());
		store({ id: "q-3", folder: "scheduled", thread: "t3" });
		recordScheduledSend(ctx, "q-3", at(3 * DAY).toISOString());

		expect(nextDeadline(ctx)).toBe(at(1 * DAY).getTime());
	});

	it("still reports a snooze that is earlier than the reminder", () => {
		store({ id: "sent-1", folder: "sent", thread: "t1" });
		remind("sent-1", 5);
		store({ id: "in-2", folder: "inbox", thread: "t2" });
		snoozeEmail(ctx, "in-2", at(2 * DAY).toISOString());
		expect(nextDeadline(ctx)).toBe(at(2 * DAY).getTime());
	});

	it("fires a due reminder without touching a pending snooze or scheduled send", () => {
		store({ id: "sent-1", folder: "sent", thread: "t1" });
		remind("sent-1", 1);
		store({ id: "in-2", folder: "inbox", thread: "t2" });
		snoozeEmail(ctx, "in-2", at(4 * DAY).toISOString());
		store({ id: "q-3", folder: "scheduled", thread: "t3" });
		recordScheduledSend(ctx, "q-3", at(5 * DAY).toISOString());

		// The alarm's handlers, in its order.
		processDueSnoozes(ctx, at(2 * DAY));
		const fired = followups.processDueFollowups(ctx, at(2 * DAY));

		expect(fired.map((f) => f.emailId)).toEqual(["sent-1"]);
		expect(email("in-2").folder_id).toBe("snoozed");
		expect(email("q-3").folder_id).toBe("scheduled");
		// The alarm re-arms for what is left: the snooze.
		expect(nextDeadline(ctx)).toBe(at(4 * DAY).getTime());
	});

	it("drops out of nextDeadline once fired", () => {
		store({ id: "sent-1", folder: "sent", thread: "t1" });
		remind("sent-1", 1);
		followups.processDueFollowups(ctx, at(2 * DAY));
		expect(nextDeadline(ctx)).toBeNull();
	});
});

describe("label and Inbox return", () => {
	it("returns the sent row to the Inbox unread with the Follow up label", () => {
		store({ id: "sent-1", folder: "sent", thread: "t1" });
		remind("sent-1", 3);

		expect(followups.processDueFollowups(ctx, at(2 * DAY))).toEqual([]);
		expect(email("sent-1").folder_id).toBe("sent");

		followups.processDueFollowups(ctx, at(3 * DAY));
		expect(email("sent-1")).toEqual({ folder_id: "inbox", read: 0 });
		expect(labelsOf("sent-1")).toEqual([FOLLOWUP_LABEL_NAME]);
		expect(followupRow("sent-1")).toMatchObject({ status: "fired", return_folder: "sent" });
	});

	it("reuses the one label across reminders", () => {
		store({ id: "a", folder: "sent", thread: "t1" });
		store({ id: "b", folder: "sent", thread: "t2" });
		remind("a", 1);
		remind("b", 1);
		followups.processDueFollowups(ctx, at(2 * DAY));
		const count = db.prepare(`SELECT COUNT(*) AS n FROM labels WHERE name = ?`).get(FOLLOWUP_LABEL_NAME) as { n: number };
		expect(count.n).toBe(1);
	});

	it("dismissing a fired reminder puts the row back in Sent without the label", () => {
		store({ id: "sent-1", folder: "sent", thread: "t1" });
		remind("sent-1", 1);
		followups.processDueFollowups(ctx, at(2 * DAY));

		const row = followups.cancelFollowup(ctx, "sent-1", at(2 * DAY));
		expect(row?.status).toBe("done");
		expect(email("sent-1").folder_id).toBe("sent");
		expect(labelsOf("sent-1")).toEqual([]);
	});

	it("returns an archived sent row to Archive, not Sent, on dismissal", () => {
		store({ id: "sent-1", folder: "sent", thread: "t1" });
		db.prepare(`UPDATE emails SET folder_id = 'archive' WHERE id = 'sent-1'`).run();
		remind("sent-1", 1);
		followups.processDueFollowups(ctx, at(2 * DAY));
		expect(email("sent-1").folder_id).toBe("inbox");
		followups.cancelFollowup(ctx, "sent-1", at(2 * DAY));
		expect(email("sent-1").folder_id).toBe("archive");
	});

	it("does not resurface a binned message", () => {
		store({ id: "sent-1", folder: "sent", thread: "t1" });
		remind("sent-1", 1);
		db.prepare(`UPDATE emails SET folder_id = 'trash' WHERE id = 'sent-1'`).run();
		expect(followups.processDueFollowups(ctx, at(2 * DAY))).toEqual([]);
		expect(email("sent-1").folder_id).toBe("trash");
		expect(followupRow("sent-1")?.status).toBe("cancelled");
	});
});

describe("cancel on reply", () => {
	it("an inbound reply in the thread cancels the reminder", () => {
		store({ id: "sent-1", folder: "sent", thread: "t1" });
		remind("sent-1", 3);
		expect(store({ id: "reply", folder: "inbox", thread: "t1" }, at(DAY))).toBe("replied");
		expect(followupRow("sent-1")?.status).toBe("replied");
		expect(followups.processDueFollowups(ctx, at(4 * DAY))).toEqual([]);
		expect(email("sent-1").folder_id).toBe("sent");
	});

	it("counts a reply whose Date header is older than the send (clock skew)", () => {
		store({ id: "sent-1", folder: "sent", thread: "t1" });
		remind("sent-1", 3);
		store({ id: "reply", folder: "inbox", thread: "t1", date: "2026-09-30T00:00:00.000Z" }, at(DAY));
		expect(followupRow("sent-1")?.status).toBe("replied");
	});

	it("ignores an out-of-office auto-reply", () => {
		store({ id: "sent-1", folder: "sent", thread: "t1" });
		remind("sent-1", 3);
		const ooo = JSON.stringify([{ key: "auto-submitted", value: "auto-replied" }]);
		expect(store({ id: "ooo", folder: "inbox", thread: "t1", raw_headers: ooo }, at(DAY))).toBeNull();
		expect(followupRow("sent-1")?.status).toBe("pending");
	});

	it("ignores mail filed to Spam and mail in other threads", () => {
		store({ id: "sent-1", folder: "sent", thread: "t1" });
		remind("sent-1", 3);
		store({ id: "junk", folder: "spam", thread: "t1" }, at(DAY));
		store({ id: "other", folder: "inbox", thread: "t9" }, at(DAY));
		expect(followupRow("sent-1")?.status).toBe("pending");
	});

	it("the alarm's safety net catches a reply the insert hook missed", () => {
		store({ id: "sent-1", folder: "sent", thread: "t1" });
		remind("sent-1", 1);
		// Inserted without the hook, e.g. by an import path.
		db.prepare(
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, thread_id)
			 VALUES ('late', 'inbox', 'Re: Pricing', 'customer@example.org', 'founder@tapetide.com', ?, 'ok', 't1')`,
		).run(at(DAY).toISOString());
		expect(followups.processDueFollowups(ctx, at(2 * DAY))).toEqual([]);
		expect(followupRow("sent-1")?.status).toBe("replied");
	});

	it("a reply after the reminder fired returns the row to Sent", () => {
		store({ id: "sent-1", folder: "sent", thread: "t1" });
		remind("sent-1", 1);
		followups.processDueFollowups(ctx, at(2 * DAY));
		expect(email("sent-1").folder_id).toBe("inbox");

		store({ id: "reply", folder: "inbox", thread: "t1" }, at(3 * DAY));
		expect(followupRow("sent-1")?.status).toBe("replied");
		expect(email("sent-1").folder_id).toBe("sent");
		expect(labelsOf("sent-1")).toEqual([]);
	});

	it("manual cancel stops a pending reminder", () => {
		store({ id: "sent-1", folder: "sent", thread: "t1" });
		remind("sent-1", 1);
		expect(followups.cancelFollowup(ctx, "sent-1")?.status).toBe("cancelled");
		expect(followups.processDueFollowups(ctx, at(2 * DAY))).toEqual([]);
		expect(followups.cancelFollowup(ctx, "sent-1")).toBeNull();
	});
});

describe("reset on re-reply", () => {
	it("moves the reminder to the new message and restarts the same clock", () => {
		store({ id: "sent-1", folder: "sent", thread: "t1" });
		remind("sent-1", 3);

		expect(store({ id: "sent-2", folder: "sent", thread: "t1" }, at(2 * DAY))).toBe("reset");
		expect(followupRow("sent-1")).toBeUndefined();
		expect(followupRow("sent-2")).toMatchObject({
			status: "pending",
			followup_at: at(5 * DAY).toISOString(),
			duration_seconds: 3 * 86400,
		});

		// Not due at the original time any more.
		expect(followups.processDueFollowups(ctx, at(3 * DAY + 1000))).toEqual([]);
		expect(followups.processDueFollowups(ctx, at(5 * DAY)).map((f) => f.emailId)).toEqual(["sent-2"]);
	});

	it("re-replying after it fired puts the old row back and watches the new one", () => {
		store({ id: "sent-1", folder: "sent", thread: "t1" });
		remind("sent-1", 1);
		followups.processDueFollowups(ctx, at(2 * DAY));
		store({ id: "sent-2", folder: "sent", thread: "t1" }, at(2 * DAY));
		expect(email("sent-1").folder_id).toBe("sent");
		expect(followupRow("sent-2")?.status).toBe("pending");
	});

	it("keeps one active reminder per thread when set twice", () => {
		store({ id: "sent-1", folder: "sent", thread: "t1" });
		store({ id: "sent-2", folder: "sent", thread: "t1" });
		remind("sent-1", 1);
		remind("sent-2", 2);
		const active = followups.listFollowups(ctx);
		expect(active.map((f) => f.email_id)).toEqual(["sent-2"]);
	});
});

describe("edge cases from review", () => {
	it("leaves a still-queued message pending instead of cancelling it", () => {
		store({ id: "q", folder: "scheduled", thread: "t1" });
		remind("q", 1);
		expect(followups.processDueFollowups(ctx, at(2 * DAY))).toEqual([]);
		expect(followupRow("q")?.status).toBe("pending");
		expect(Date.parse(followupRow("q")!.followup_at)).toBeGreaterThan(at(2 * DAY).getTime());
	});

	it("a reply to a surfaced row the user then snoozed returns it to Sent", () => {
		store({ id: "sent-1", folder: "sent", thread: "t1" });
		remind("sent-1", 1);
		followups.processDueFollowups(ctx, at(2 * DAY));
		snoozeEmail(ctx, "sent-1", at(5 * DAY).toISOString());
		store({ id: "reply", folder: "inbox", thread: "t1" }, at(3 * DAY));
		expect(email("sent-1").folder_id).toBe("sent");
		processDueSnoozes(ctx, at(6 * DAY));
		expect(email("sent-1").folder_id).toBe("sent");
	});

	it("does not resurface a message that failed to send", () => {
		store({ id: "sent-1", folder: "sent", thread: "t1" });
		remind("sent-1", 1);
		db.prepare(`UPDATE emails SET delivery_status = 'failed' WHERE id = 'sent-1'`).run();
		expect(followups.processDueFollowups(ctx, at(2 * DAY))).toEqual([]);
		expect(email("sent-1").folder_id).toBe("sent");
		expect(followupRow("sent-1")?.status).toBe("cancelled");
	});

	it("cancelling by the newer message id finds the thread's reminder", () => {
		store({ id: "sent-1", folder: "sent", thread: "t1" });
		remind("sent-1", 1);
		store({ id: "sent-2", folder: "sent", thread: "t1" }, at(DAY / 2));
		expect(followups.cancelFollowup(ctx, "sent-2")?.status).toBe("cancelled");
		expect(followups.listFollowups(ctx)).toEqual([]);
	});
});

describe("setFollowup and listing", () => {
	it("refuses a draft", () => {
		store({ id: "d", folder: "draft", thread: "t1" });
		expect(remind("d", 1)).toBeNull();
	});

	it("lists fired ones first, then pending by due date", () => {
		store({ id: "a", folder: "sent", thread: "t1" });
		store({ id: "b", folder: "sent", thread: "t2" });
		store({ id: "c", folder: "sent", thread: "t3" });
		remind("a", 5);
		remind("b", 1);
		remind("c", 3);
		followups.processDueFollowups(ctx, at(1 * DAY));
		expect(followups.listFollowups(ctx).map((f) => [f.email_id, f.status])).toEqual([
			["b", "fired"],
			["c", "pending"],
			["a", "pending"],
		]);
		expect(followups.listFollowups(ctx, { status: "pending" }).map((f) => f.email_id)).toEqual(["c", "a"]);
	});
});
