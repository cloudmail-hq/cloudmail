// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Follow-up reminders on sent mail (migration 32), as plain functions over
 * `DurableObjectState` so they run against real SQLite in tests, matching
 * ./trash.ts and ./dedupe.ts. `MailboxDO` holds the thin RPC delegates.
 *
 * ## Model
 *
 * One `followups` row per watched outbound message, keyed by its email id. At
 * most one row per thread is *active* (`pending` or `fired`): setting a new
 * reminder in a thread, or replying again yourself, supersedes the old one.
 *
 *   pending ──(due, no reply)──▶ fired ──(reply / dismiss)──▶ replied | done
 *      │                                                    ▲
 *      ├──(inbound reply)──▶ replied                        │
 *      ├──(user cancels)───▶ cancelled                      │
 *      └──(user replies again)──▶ moved to the new message, clock restarted
 *
 * ## "Since the send" is row order, not header dates
 *
 * A reply is any message stored in the thread after the watched one that we
 * did not write. "After" is `rowid`, the order rows were inserted, rather than
 * the `date` column: an inbound `date` comes from the sender's `Date:` header,
 * and a skewed clock on their side must not make a real reply look older than
 * the message it answers. A scheduled send is inserted before it is delivered,
 * so for those the comparison is still right: anything arriving after the user
 * hit Send counts.
 *
 * ## What "ours" means
 *
 * Sent, Drafts and Scheduled hold rows this mailbox wrote; everything else is
 * inbound. Spam and Trash are not replies (a junk message on an old subject
 * must not cancel a reminder), and an automated message — out-of-office,
 * bounce, list traffic — is not one either, by the same header test
 * stop-on-reply uses for sequences.
 *
 * ## Bringing the thread back
 *
 * The watched Sent row itself returns to the Inbox, unread and labelled
 * "Follow up", in the snooze style: it keeps its date. The folder it came from
 * is recorded in `return_folder` so a reply, or dismissing the reminder, puts
 * it back. Moving the Sent row rather than an older inbound message means the
 * thread's history is never refiled, and the row the user lands on is the one
 * they need to chase.
 */

import { Folders } from "../../shared/folders";
import {
	FOLLOWUP_LABEL_COLOR,
	FOLLOWUP_LABEL_NAME,
	type FollowupMode,
	type FollowupStatus,
	type FollowupView,
} from "../../shared/followups";
import { headerValue, parseStoredHeaders } from "../../shared/headers";

/** Folders whose rows this mailbox wrote. */
export const OUTBOUND_FOLDERS = [Folders.SENT, Folders.DRAFT, Folders.SCHEDULED] as const;

/** Folders whose rows never count as a reply. */
const IGNORED_FOLDERS = [Folders.SPAM, Folders.TRASH] as const;

/** Cap on reminders handled per alarm firing, bounding its runtime. */
export const FOLLOWUP_BATCH_SIZE = 50;

export interface FollowupRow {
	email_id: string;
	thread_id: string;
	followup_at: string;
	followup_mode: FollowupMode;
	status: FollowupStatus;
	duration_seconds: number;
	created_at: string;
	updated_at: string;
	fired_at: string | null;
	resolved_at: string | null;
	return_folder: string | null;
	surfaced_email_id: string | null;
}

/**
 * Whether stored headers mark a message as machine-generated.
 *
 * The same test `isAutomatedInbound` applies for sequence stop-on-reply
 * (workers/lib/suppressions.ts), over the stored header blob instead of a live
 * lookup, so an auto-reply cannot end a reminder any more than it ends a
 * sequence.
 */
export function isAutomatedHeaders(rawHeaders: string | null | undefined): boolean {
	const headers = parseStoredHeaders(rawHeaders);
	const h = (name: string) => headerValue(headers, name) ?? undefined;
	const autoSubmitted = h("auto-submitted");
	if (autoSubmitted && autoSubmitted.trim().toLowerCase() !== "no") return true;
	if (h("x-autoreply") || h("x-autorespond") || h("x-autoresponder")) return true;
	const precedence = h("precedence")?.trim().toLowerCase();
	if (precedence && ["bulk", "list", "junk", "auto_reply"].includes(precedence)) return true;
	const returnPath = h("return-path");
	return !!returnPath && returnPath.trim() === "<>";
}

function inList(values: readonly string[], start: number): string {
	return values.map((_, i) => `?${start + i}`).join(", ");
}

function getRow(ctx: DurableObjectState, emailId: string): FollowupRow | null {
	return (
		(ctx.storage.sql
			.exec(`SELECT * FROM followups WHERE email_id = ?`, emailId)
			.toArray()[0] as unknown as FollowupRow | undefined) ?? null
	);
}

function activeForThread(ctx: DurableObjectState, threadId: string): FollowupRow | null {
	return (
		(ctx.storage.sql
			.exec(
				`SELECT * FROM followups
				  WHERE thread_id = ? AND status IN ('pending', 'fired')
				  ORDER BY created_at DESC LIMIT 1`,
				threadId,
			)
			.toArray()[0] as unknown as FollowupRow | undefined) ?? null
	);
}

/**
 * Whether anyone else has written into the thread since `emailId` was stored.
 *
 * See the module header for why this compares `rowid` and which folders count.
 * Exported so the alarm's safety net and the tests use the same definition.
 */
export function hasReplySince(ctx: DurableObjectState, threadId: string, emailId: string): boolean {
	const excluded = [...OUTBOUND_FOLDERS, ...IGNORED_FOLDERS];
	const rows = ctx.storage.sql
		.exec(
			`SELECT raw_headers FROM emails
			  WHERE thread_id = ?1
			    AND id != ?2
			    AND rowid > COALESCE((SELECT rowid FROM emails WHERE id = ?2), 0)
			    AND folder_id NOT IN (${inList(excluded, 3)})`,
			threadId,
			emailId,
			...excluded,
		)
		.toArray() as { raw_headers: string | null }[];
	return rows.some((row) => !isAutomatedHeaders(row.raw_headers));
}

/**
 * Create or replace the reminder on `emailId`.
 *
 * Any other active reminder in the same thread is superseded, since a thread
 * has one clock. A fired one is resolved first so its row goes back to Sent.
 * Returns null when the message does not exist, is a draft, or is in Trash or
 * Spam.
 */
export function setFollowup(
	ctx: DurableObjectState,
	args: {
		emailId: string;
		followupAt: string;
		mode: FollowupMode;
		durationSeconds: number;
		now?: Date;
	},
): FollowupRow | null {
	const email = ctx.storage.sql
		.exec(
			`SELECT id, folder_id, COALESCE(thread_id, id) AS thread_id FROM emails WHERE id = ?`,
			args.emailId,
		)
		.toArray()[0] as { id: string; folder_id: string; thread_id: string } | undefined;
	if (!email) return null;
	// Nothing to wait for on an unsent draft or a binned message. A queued
	// (Scheduled) one is fine: its reminder is counted from its send time.
	if (
		email.folder_id === Folders.DRAFT ||
		(IGNORED_FOLDERS as readonly string[]).includes(email.folder_id)
	) {
		return null;
	}

	const nowIso = (args.now ?? new Date()).toISOString();
	ctx.storage.transactionSync(() => {
		const existing = activeForThread(ctx, email.thread_id);
		if (existing) {
			// One clock per thread. Re-arming a fired reminder ("remind me again")
			// first puts its row back where it came from, so the next firing
			// records the right return folder.
			resolveRow(ctx, existing, "cancelled", nowIso);
		}
		ctx.storage.sql.exec(
			`INSERT INTO followups
			     (email_id, thread_id, followup_at, followup_mode, status, duration_seconds,
			      created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?6)
			 ON CONFLICT(email_id) DO UPDATE SET
			     thread_id = excluded.thread_id,
			     followup_at = excluded.followup_at,
			     followup_mode = excluded.followup_mode,
			     status = 'pending',
			     duration_seconds = excluded.duration_seconds,
			     updated_at = excluded.updated_at,
			     fired_at = NULL,
			     resolved_at = NULL`,
			args.emailId,
			email.thread_id,
			args.followupAt,
			args.mode,
			Math.max(0, Math.round(args.durationSeconds)),
			nowIso,
		);
	});
	return getRow(ctx, args.emailId);
}

/**
 * Close a reminder. A fired one also puts its surfaced row back where it came
 * from and drops the label, so the Inbox is left as it was before the alarm.
 */
function resolveRow(
	ctx: DurableObjectState,
	row: FollowupRow,
	status: Exclude<FollowupStatus, "pending" | "fired">,
	nowIso: string,
): void {
	if (row.status === "fired" && row.surfaced_email_id) {
		unsurface(ctx, row.surfaced_email_id, row.return_folder);
	}
	ctx.storage.sql.exec(
		`UPDATE followups SET status = ?1, resolved_at = ?2, updated_at = ?2 WHERE email_id = ?3`,
		status,
		nowIso,
		row.email_id,
	);
}

function unsurface(ctx: DurableObjectState, emailId: string, returnFolder: string | null): void {
	// Only if it is still where the reminder put it (or snoozed from there, which
	// would otherwise wake it back into the Inbox with nothing to chase): a user
	// who already filed it somewhere else has made a decision this must not undo.
	ctx.storage.sql.exec(
		`UPDATE emails
		    SET folder_id = COALESCE((SELECT id FROM folders WHERE id = ?1), ?2),
		        snoozed_until = NULL,
		        snooze_return_folder = NULL
		  WHERE id = ?3
		    AND (folder_id = ?4 OR (folder_id = ?5 AND snooze_return_folder = ?4))`,
		returnFolder,
		Folders.SENT,
		emailId,
		Folders.INBOX,
		Folders.SNOOZED,
	);
	const label = followupLabelId(ctx, false);
	if (label) {
		ctx.storage.sql.exec(
			`DELETE FROM email_labels WHERE email_id = ? AND label_id = ?`,
			emailId,
			label,
		);
	}
}

/**
 * Cancel the active reminder on a message, or on the thread it belongs to.
 * Returns the row as it now stands, or null when there was nothing active.
 */
export function cancelFollowup(
	ctx: DurableObjectState,
	emailId: string,
	now = new Date(),
): FollowupRow | null {
	const direct = getRow(ctx, emailId);
	let row = direct && (direct.status === "pending" || direct.status === "fired") ? direct : null;
	if (!row) {
		const thread = ctx.storage.sql
			.exec(`SELECT COALESCE(thread_id, id) AS thread_id FROM emails WHERE id = ?`, emailId)
			.toArray()[0] as { thread_id: string } | undefined;
		row = thread ? activeForThread(ctx, thread.thread_id) : null;
	}
	if (!row) return null;
	const nowIso = now.toISOString();
	ctx.storage.transactionSync(() =>
		resolveRow(ctx, row!, row!.status === "fired" ? "done" : "cancelled", nowIso),
	);
	return getRow(ctx, row.email_id);
}

/**
 * React to a row being stored, from `MailboxDO.createEmail` and the scheduled
 * delivery transition. Never throws: a reminder is not worth failing a write.
 *
 * - An inbound, non-automated row in a thread with an active reminder resolves
 *   it as `replied` (and returns a surfaced row to Sent).
 * - A new Sent row in such a thread is the user replying again: the reminder
 *   moves to the new message and its clock restarts from now, keeping the same
 *   duration and mode.
 */
export function onEmailStored(
	ctx: DurableObjectState,
	email: { id: string; folder_id: string; thread_id: string | null; raw_headers?: string | null },
	now = new Date(),
): "replied" | "reset" | null {
	try {
		const threadId = email.thread_id ?? email.id;
		const active = activeForThread(ctx, threadId);
		if (!active || active.email_id === email.id) return null;
		const nowIso = now.toISOString();

		if (email.folder_id === Folders.SENT) {
			const at = new Date(now.getTime() + active.duration_seconds * 1000).toISOString();
			ctx.storage.transactionSync(() => {
				// A fired reminder's row goes back first; the new message is the
				// one being watched now.
				if (active.status === "fired" && active.surfaced_email_id) {
					unsurface(ctx, active.surfaced_email_id, active.return_folder);
				}
				ctx.storage.sql.exec(`DELETE FROM followups WHERE email_id = ?`, active.email_id);
				ctx.storage.sql.exec(
					`INSERT OR REPLACE INTO followups
					     (email_id, thread_id, followup_at, followup_mode, status, duration_seconds,
					      created_at, updated_at)
					 VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?6)`,
					email.id,
					threadId,
					at,
					active.followup_mode,
					active.duration_seconds,
					nowIso,
				);
			});
			return "reset";
		}

		if (
			(OUTBOUND_FOLDERS as readonly string[]).includes(email.folder_id) ||
			(IGNORED_FOLDERS as readonly string[]).includes(email.folder_id)
		) {
			return null;
		}
		if (isAutomatedHeaders(email.raw_headers)) return null;

		ctx.storage.transactionSync(() => resolveRow(ctx, active, "replied", nowIso));
		return "replied";
	} catch (e) {
		console.error("followups: onEmailStored failed:", (e as Error).message);
		return null;
	}
}

/**
 * The id of the "Follow up" label, creating it when `create` is set. Matched
 * by name, so a user who renames it gets a fresh one next time rather than
 * having their own label repurposed.
 */
export function followupLabelId(ctx: DurableObjectState, create = true): string | null {
	const found = ctx.storage.sql
		.exec(`SELECT id FROM labels WHERE name = ?`, FOLLOWUP_LABEL_NAME)
		.toArray()[0] as { id: string } | undefined;
	if (found) return found.id;
	if (!create) return null;
	const id = crypto.randomUUID();
	ctx.storage.sql.exec(
		`INSERT OR IGNORE INTO labels (id, name, color) VALUES (?, ?, ?)`,
		id,
		FOLLOWUP_LABEL_NAME,
		FOLLOWUP_LABEL_COLOR,
	);
	return (
		(ctx.storage.sql
			.exec(`SELECT id FROM labels WHERE name = ?`, FOLLOWUP_LABEL_NAME)
			.toArray()[0] as { id: string } | undefined)?.id ?? null
	);
}

export interface FiredFollowup {
	emailId: string;
	threadId: string;
	subject: string | null;
	recipient: string | null;
}

/**
 * Fire every reminder whose time has come. Called from the alarm.
 *
 * Each due reminder is re-checked for a reply first, as a safety net for one
 * that arrived by a path `onEmailStored` did not see. With no reply, the watched
 * row returns to the Inbox unread, labelled "Follow up". A row that has since
 * been binned or marked spam is left there and the reminder closes: the user
 * has already said what they think of that thread.
 */
export function processDueFollowups(ctx: DurableObjectState, now = new Date()): FiredFollowup[] {
	const nowIso = now.toISOString();
	const due = ctx.storage.sql
		.exec(
			`SELECT f.*, e.folder_id AS current_folder, e.subject AS subject, e.recipient AS recipient, e.delivery_status AS delivery_status
			   FROM followups f
			   LEFT JOIN emails e ON e.id = f.email_id
			  WHERE f.status = 'pending' AND f.followup_at <= ?1
			  ORDER BY f.followup_at ASC
			  LIMIT ?2`,
			nowIso,
			FOLLOWUP_BATCH_SIZE,
		)
		.toArray() as unknown as (FollowupRow & {
		current_folder: string | null;
		delivery_status: string | null;
		subject: string | null;
		recipient: string | null;
	})[];

	const fired: FiredFollowup[] = [];
	for (const row of due) {
		try {
			if (!row.current_folder) {
				ctx.storage.sql.exec(`DELETE FROM followups WHERE email_id = ?`, row.email_id);
				continue;
			}
			if (hasReplySince(ctx, row.thread_id, row.email_id)) {
				resolveRow(ctx, row, "replied", nowIso);
				continue;
			}
			if (row.delivery_status === "failed" || row.delivery_status === "bounced") {
				// Nobody can reply to mail that never arrived; the failure banner is
				// the thing to act on, not a nudge.
				resolveRow(ctx, row, "cancelled", nowIso);
				continue;
			}
			if (row.current_folder === Folders.SCHEDULED) {
				// Still queued (a long schedule, or delivery retries). Not ours to
				// judge yet: push it back an hour and look again then.
				ctx.storage.sql.exec(
					`UPDATE followups SET followup_at = ?1, updated_at = ?2 WHERE email_id = ?3`,
					new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
					nowIso,
					row.email_id,
				);
				continue;
			}
			if (
				row.current_folder === Folders.TRASH ||
				row.current_folder === Folders.SPAM ||
				row.current_folder === Folders.DRAFT
			) {
				// Binned, or no longer sent at all (an undo moved it back to Drafts).
				resolveRow(ctx, row, "cancelled", nowIso);
				continue;
			}

			ctx.storage.transactionSync(() => {
				const label = followupLabelId(ctx, true);
				// A snoozed row wakes up here instead of at its snooze time.
				ctx.storage.sql.exec(
					`UPDATE emails
					    SET folder_id = ?1, read = 0, snoozed_until = NULL, snooze_return_folder = NULL
					  WHERE id = ?2`,
					Folders.INBOX,
					row.email_id,
				);
				if (label) {
					ctx.storage.sql.exec(
						`INSERT OR IGNORE INTO email_labels (email_id, label_id) VALUES (?, ?)`,
						row.email_id,
						label,
					);
				}
				ctx.storage.sql.exec(
					`UPDATE followups
					    SET status = 'fired', fired_at = ?1, updated_at = ?1,
					        surfaced_email_id = ?2, return_folder = ?3
					  WHERE email_id = ?2`,
					nowIso,
					row.email_id,
					row.current_folder === Folders.SNOOZED ? Folders.SENT : row.current_folder,
				);
			});
			fired.push({
				emailId: row.email_id,
				threadId: row.thread_id,
				subject: row.subject,
				recipient: row.recipient,
			});
		} catch (e) {
			// One bad row must not strand the rest of the batch.
			console.error(`followups: could not fire ${row.email_id}:`, (e as Error).message);
		}
	}
	return fired;
}

/** Earliest pending reminder, for the shared alarm, or null. */
export function nextFollowupAt(ctx: DurableObjectState): string | null {
	const row = ctx.storage.sql
		.exec(`SELECT MIN(followup_at) AS next_at FROM followups WHERE status = 'pending'`)
		.toArray()[0] as { next_at: string | null } | undefined;
	return row?.next_at ?? null;
}

/**
 * Reminders for the "Awaiting reply" view: pending ones by due date, then the
 * fired ones still waiting on the user. Joined to the message for display.
 */
export function listFollowups(
	ctx: DurableObjectState,
	options: { status?: "pending" | "fired" | "active"; limit?: number } = {},
): FollowupView[] {
	const status = options.status ?? "active";
	const statuses = status === "active" ? ["pending", "fired"] : [status];
	const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
	return ctx.storage.sql
		.exec(
			`SELECT f.email_id, f.thread_id, f.followup_at, f.followup_mode, f.status,
			        f.duration_seconds, f.created_at, f.fired_at, f.resolved_at,
			        f.surfaced_email_id,
			        e.subject AS subject, e.recipient AS recipient, e.date AS sent_at
			   FROM followups f
			   JOIN emails e ON e.id = f.email_id
			  WHERE f.status IN (${inList(statuses, 1)})
			  ORDER BY CASE f.status WHEN 'fired' THEN 0 ELSE 1 END, f.followup_at ASC
			  LIMIT ?${statuses.length + 1}`,
			...statuses,
			limit,
		)
		.toArray() as unknown as FollowupView[];
}

/** The reminder on one message (any status), for the reading pane. */
export function getFollowup(ctx: DurableObjectState, emailId: string): FollowupView | null {
	return (
		(ctx.storage.sql
			.exec(
				`SELECT f.email_id, f.thread_id, f.followup_at, f.followup_mode, f.status,
				        f.duration_seconds, f.created_at, f.fired_at, f.resolved_at,
				        f.surfaced_email_id,
				        e.subject AS subject, e.recipient AS recipient, e.date AS sent_at
				   FROM followups f
				   JOIN emails e ON e.id = f.email_id
				  WHERE f.email_id = ?1
				     OR (f.thread_id = (SELECT COALESCE(thread_id, id) FROM emails WHERE id = ?1)
				         AND f.status IN ('pending', 'fired'))
				  ORDER BY CASE WHEN f.status IN ('pending', 'fired') THEN 0 ELSE 1 END,
				           f.updated_at DESC
				  LIMIT 1`,
				emailId,
			)
			.toArray()[0] as unknown as FollowupView | undefined) ?? null
	);
}
