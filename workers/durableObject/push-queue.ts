// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The mailbox's half of Web Push (migration 41): the facts a notification
 * decision needs about one stored message, and a small queue for messages
 * whose push has to wait for triage.
 *
 * Why wait: a label with auto-archive moves matching mail out of the Inbox
 * during the post-ingest job, a second or so after delivery. Pushing at
 * delivery would notify for mail the user asked never to see in their Inbox.
 * So when a message is queued for triage and some label auto-archives, its
 * push is parked here and the alarm sends it after triage has run, from
 * wherever the message ended up. Without such a label there is nothing to
 * wait for and the push goes out at once.
 */

import { Folders } from "../../shared/folders";
import type { StoredMailFacts } from "../lib/push";

/** Longest a push waits for triage before it is decided on what is known. */
export const PUSH_WAIT_MAX_MS = 5 * 60_000;
export const PUSH_QUEUE_BATCH = 20;
/** A parked push is never released before this, so the triage job has been queued. */
export const PUSH_MIN_WAIT_MS = 1_000;

export const PUSH_QUEUE_MIGRATION_SQL = `
	CREATE TABLE IF NOT EXISTS push_queue (
		email_id TEXT PRIMARY KEY,
		mailbox_id TEXT NOT NULL,
		delivered_to TEXT NOT NULL,
		enqueued_at INTEGER NOT NULL
	);
`;

/** The decision inputs for one message, or null when it is gone. */
export function pushFacts(ctx: DurableObjectState, emailId: string): StoredMailFacts | null {
	const row = ctx.storage.sql
		.exec(
			`SELECT id, thread_id, folder_id, read, sender, sender_name, subject, priority FROM emails WHERE id = ?`,
			emailId,
		)
		.toArray()[0] as Record<string, unknown> | undefined;
	if (!row) return null;
	const threadId = (row.thread_id as string | null) ?? String(row.id);
	const muted =
		ctx.storage.sql.exec(`SELECT 1 FROM muted_threads WHERE thread_id = ?`, threadId).toArray().length > 0;
	// You wrote in this conversation, so a reply to it is probably one you owe an answer to.
	const inConversation =
		ctx.storage.sql
			.exec(`SELECT 1 FROM emails WHERE thread_id = ? AND folder_id = ? LIMIT 1`, threadId, Folders.SENT)
			.toArray().length > 0;
	return {
		id: String(row.id),
		threadId,
		folder: String(row.folder_id ?? Folders.INBOX),
		read: Number(row.read) === 1,
		muted,
		sender: String(row.sender ?? "").toLowerCase(),
		senderName: (row.sender_name as string | null) ?? null,
		subject: String(row.subject ?? ""),
		priority: (row.priority as string | null) ?? null,
		inConversation,
	};
}

/** Whether triage could move new mail out of the Inbox: some label auto-archives. */
export function hasAutoArchiveLabel(ctx: DurableObjectState): boolean {
	return ctx.storage.sql.exec(`SELECT 1 FROM labels WHERE auto_archive = 1 LIMIT 1`).toArray().length > 0;
}

export function parkPush(ctx: DurableObjectState, emailId: string, mailboxId: string, deliveredTo: string, now = Date.now()): void {
	ctx.storage.sql.exec(
		`INSERT INTO push_queue (email_id, mailbox_id, delivered_to, enqueued_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(email_id) DO NOTHING`,
		emailId,
		mailboxId.toLowerCase(),
		deliveredTo.toLowerCase(),
		now,
	);
}

export function pendingPushCount(ctx: DurableObjectState): number {
	try {
		const row = ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM push_queue`).toArray()[0] as { n: number } | undefined;
		return Number(row?.n ?? 0);
	} catch {
		return 0;
	}
}

export interface ReadyPush {
	emailId: string;
	mailboxId: string;
	deliveredTo: string;
	facts: StoredMailFacts | null;
}

/**
 * Parked pushes whose triage has finished (or that waited too long), removed
 * from the queue. The caller sends them; a lost send is a missed courtesy,
 * never lost mail, so nothing is retried.
 */
export function takeReadyPushes(ctx: DurableObjectState, now = Date.now(), limit = PUSH_QUEUE_BATCH): ReadyPush[] {
	const rows = ctx.storage.sql
		.exec(
			`SELECT p.email_id, p.mailbox_id, p.delivered_to FROM push_queue p
			  WHERE (p.enqueued_at <= ? AND NOT EXISTS (SELECT 1 FROM triage_queue t WHERE t.email_id = p.email_id))
			     OR p.enqueued_at <= ?
			  ORDER BY p.enqueued_at ASC LIMIT ?`,
			// Not before the triage enqueue can have landed.
			now - PUSH_MIN_WAIT_MS,
			now - PUSH_WAIT_MAX_MS,
			limit,
		)
		.toArray() as { email_id: string; mailbox_id: string; delivered_to: string }[];
	const out: ReadyPush[] = [];
	for (const r of rows) {
		ctx.storage.sql.exec(`DELETE FROM push_queue WHERE email_id = ?`, r.email_id);
		out.push({ emailId: r.email_id, mailboxId: r.mailbox_id, deliveredTo: r.delivered_to, facts: pushFacts(ctx, r.email_id) });
	}
	return out;
}

/** When the next parked push should be looked at, or null. */
export function nextPushCheckAt(ctx: DurableObjectState): number | null {
	const row = ctx.storage.sql.exec(`SELECT MIN(enqueued_at) AS t FROM push_queue`).toArray()[0] as { t: number | null } | undefined;
	return row?.t === null || row?.t === undefined ? null : Number(row.t) + PUSH_WAIT_MAX_MS;
}
