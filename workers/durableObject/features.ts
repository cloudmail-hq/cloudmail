// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Storage logic for the features layered on top of the original mailbox:
 * labels, signatures, priority, snooze, scheduled send, and blocked senders.
 *
 * These are plain functions over `DurableObjectState` rather than methods on
 * `MailboxDO` so the class stays readable and this logic can be exercised
 * without standing up a Durable Object. `MailboxDO` keeps thin delegating
 * methods because only methods on the class are reachable over RPC.
 *
 * Schema lives in migrations 9-13 (see ./migrations.ts).
 */

import * as followups from "./followups";
import { DELIVERY_ERROR_MAX_LENGTH } from "../../shared/dsn";
import {
	latestTerminalStatus,
	type DatedLifecycleEvent,
	type DeliveryEventInput,
} from "../../shared/delivery-events";
import { Folders } from "../../shared/folders";
import { isBlockedAttachment } from "../../shared/attachment-types";
import { attachmentKey } from "../lib/attachments";
import { buildOutgoingHeaders } from "../lib/email-helpers";
import * as threading from "./threading";
import { snippetSql } from "./derived";
import { recomputeEngagement } from "./engagement";
import { describeSendError } from "../../shared/send-errors";
import { sendEmail } from "../email-sender";
import { preSendOrThrow } from "../lib/pre-send";
import { trackOutgoingHtml, trackingBaseUrl } from "../lib/tracking-send";
import { backgroundLocked } from "../lib/licence";
import { trackingOptOutStore } from "../lib/tracking-opt-outs";
import type { Env } from "../types";
import { SUMMARY_DEBOUNCE_MS, enqueueSummary } from "./summaries";

/**
 * When queued summaries next want the alarm: a debounce after the oldest live
 * row, so a burst of replies is one call. Null when nothing is queued. A capped
 * mailbox is pushed to the next day by the alarm itself, which sets a later
 * alarm after processing; this only ever asks for an earlier one.
 */
function summaryDeadline(ctx: DurableObjectState): number | null {
	try {
		const row = ctx.storage.sql
			.exec(`SELECT MIN(enqueued_at) AS at FROM summary_queue`)
			.toArray()[0] as { at: string | null } | undefined;
		if (!row?.at) return null;
		const at = Date.parse(row.at);
		return Number.isNaN(at) ? null : at + SUMMARY_DEBOUNCE_MS;
	} catch {
		return null;
	}
}

/** Queue a summary refresh for a just-sent message's conversation. Never throws. */
function queueSummaryAfterSend(ctx: DurableObjectState, emailId: string): void {
	try {
		const row = ctx.storage.sql
			.exec(`SELECT COALESCE(thread_id, id) AS k FROM emails WHERE id = ?1`, emailId)
			.toArray()[0] as { k: string } | undefined;
		if (row?.k) enqueueSummary(ctx, row.k);
	} catch {
		// Pre-migration-30 mailbox, or a test fake without the table.
	}
}

// ── Types ──────────────────────────────────────────────────────────

export interface LabelRow {
	id: string;
	name: string;
	color: string;
	parent_id: string | null;
	sort_order: number;
}

export interface LabelWithCounts extends LabelRow {
	email_count: number;
	unread_count: number;
	/** An auto-label's description; null for a plain label. */
	prompt?: string | null;
	auto_archive?: boolean;
	show_tab?: boolean;
}

export interface SignatureRow {
	id: string;
	name: string;
	body_html: string;
	is_default: boolean;
}

export interface BlockedSenderRow {
	id: string;
	pattern: string;
	reason: string | null;
	created_at: string;
}

/** Number of delivery attempts before a scheduled message is given up on. */
const MAX_SEND_ATTEMPTS = 3;

/** Backoff between failed delivery attempts. */
const RETRY_INTERVAL_MS = 5 * 60 * 1000;

/** Cap on messages delivered per alarm firing, to bound the alarm's runtime. */
const SEND_BATCH_SIZE = 25;

// ── Labels ─────────────────────────────────────────────────────────

/**
 * List labels with total and unread counts.
 *
 * Counts come from correlated subqueries rather than a GROUP BY join so labels
 * with no emails still appear.
 */
export function getLabels(ctx: DurableObjectState): LabelWithCounts[] {
	return ctx.storage.sql
		.exec(
			`SELECT
				l.id, l.name, l.color, l.parent_id, l.sort_order,
				l.prompt, l.auto_archive, l.show_tab,
				(SELECT COUNT(*) FROM email_labels el WHERE el.label_id = l.id) AS email_count,
				(SELECT COUNT(*) FROM email_labels el
					JOIN emails e ON e.id = el.email_id
					WHERE el.label_id = l.id AND e.read = 0) AS unread_count
			FROM labels l
			ORDER BY l.sort_order ASC, l.name ASC`,
		)
		.toArray()
		.map((row) => ({
			...row,
			// Triage settings (migration 35). Booleans for the client.
			prompt: (row.prompt as string | null) ?? null,
			auto_archive: !!row.auto_archive,
			show_tab: !!row.show_tab,
		})) as unknown as LabelWithCounts[];
}

export function getLabel(ctx: DurableObjectState, id: string): LabelRow | null {
	const row = ctx.storage.sql
		.exec(
			`SELECT id, name, color, parent_id, sort_order FROM labels WHERE id = ?`,
			id,
		)
		.toArray()[0] as unknown as LabelRow | undefined;
	return row ?? null;
}

/** Returns null when the name is already taken. */
export function createLabel(
	ctx: DurableObjectState,
	name: string,
	color = "#6b7280",
	parentId: string | null = null,
	sortOrder = 0,
): LabelWithCounts | null {
	const id = crypto.randomUUID();
	try {
		ctx.storage.sql.exec(
			`INSERT INTO labels (id, name, color, parent_id, sort_order) VALUES (?, ?, ?, ?, ?)`,
			id,
			name,
			color,
			parentId,
			sortOrder,
		);
	} catch (e) {
		if (isUniqueViolation(e)) return null;
		throw e;
	}
	return {
		id,
		name,
		color,
		parent_id: parentId,
		sort_order: sortOrder,
		email_count: 0,
		unread_count: 0,
	};
}

export function updateLabel(
	ctx: DurableObjectState,
	id: string,
	patch: {
		name?: string;
		color?: string;
		parent_id?: string | null;
		sort_order?: number;
	},
): LabelRow | null {
	const sets: string[] = [];
	const params: (string | number | null)[] = [];

	const push = (column: string, value: string | number | null) => {
		params.push(value);
		sets.push(`${column} = ?${params.length}`);
	};

	if (patch.name !== undefined) push("name", patch.name);
	if (patch.color !== undefined) push("color", patch.color);
	if (patch.parent_id !== undefined) push("parent_id", patch.parent_id);
	if (patch.sort_order !== undefined) push("sort_order", patch.sort_order);

	if (sets.length === 0) return getLabel(ctx, id);

	params.push(id);
	try {
		ctx.storage.sql.exec(
			`UPDATE labels SET ${sets.join(", ")} WHERE id = ?${params.length}`,
			...params,
		);
	} catch (e) {
		if (isUniqueViolation(e)) return null;
		throw e;
	}
	return getLabel(ctx, id);
}

export function deleteLabel(ctx: DurableObjectState, id: string): boolean {
	if (!getLabel(ctx, id)) return false;
	// email_labels rows are removed by ON DELETE CASCADE.
	ctx.storage.sql.exec(`DELETE FROM labels WHERE id = ?`, id);
	return true;
}

/** Idempotent: re-applying a label already present is a no-op. */
export function addEmailLabel(
	ctx: DurableObjectState,
	emailId: string,
	labelId: string,
): boolean {
	if (!rowExists(ctx, "emails", emailId)) return false;
	if (!rowExists(ctx, "labels", labelId)) return false;

	ctx.storage.sql.exec(
		`INSERT OR IGNORE INTO email_labels (email_id, label_id) VALUES (?, ?)`,
		emailId,
		labelId,
	);
	return true;
}

export function removeEmailLabel(
	ctx: DurableObjectState,
	emailId: string,
	labelId: string,
): boolean {
	ctx.storage.sql.exec(
		`DELETE FROM email_labels WHERE email_id = ? AND label_id = ?`,
		emailId,
		labelId,
	);
	return true;
}

export function getEmailLabels(
	ctx: DurableObjectState,
	emailId: string,
): Pick<LabelRow, "id" | "name" | "color">[] {
	return ctx.storage.sql
		.exec(
			`SELECT l.id, l.name, l.color, el.source
			 FROM email_labels el
			 JOIN labels l ON l.id = el.label_id
			 WHERE el.email_id = ?
			 ORDER BY l.sort_order ASC, l.name ASC`,
			emailId,
		)
		.toArray() as unknown as Pick<LabelRow, "id" | "name" | "color">[];
}

/**
 * Replace an email's entire label set atomically, so the UI can submit a
 * checkbox list without computing add/remove diffs. Unknown label ids are
 * dropped rather than failing the whole request.
 */
export function setEmailLabels(
	ctx: DurableObjectState,
	emailId: string,
	labelIds: string[],
): Pick<LabelRow, "id" | "name" | "color">[] | null {
	if (!rowExists(ctx, "emails", emailId)) return null;

	const valid = existingLabelIds(ctx, labelIds);

	ctx.storage.transactionSync(() => {
		ctx.storage.sql.exec(`DELETE FROM email_labels WHERE email_id = ?`, emailId);
		for (const labelId of valid) {
			ctx.storage.sql.exec(
				`INSERT OR IGNORE INTO email_labels (email_id, label_id) VALUES (?, ?)`,
				emailId,
				labelId,
			);
		}
	});

	return getEmailLabels(ctx, emailId);
}

/**
 * Emails carrying a label. Trashed mail is excluded.
 *
 * Labelled mail is a flat list, not a conversation list — a label applies to a
 * message, so collapsing them into threads would hide which of a thread's
 * messages actually carries the label. The filters are therefore the flat ones
 * from `threading.flatFilterConditions`, shared with the non-threaded folder
 * list so "Unread" cannot mean two different things on two screens.
 */
export function getEmailsByLabel(
	ctx: DurableObjectState,
	labelId: string,
	options: {
		page?: number;
		limit?: number;
		sortColumn?: threading.SortColumn;
		sortDirection?: "ASC" | "DESC";
	} & threading.ListFilterOptions = {},
) {
	const { page = 1, limit: rawLimit = 25 } = options;
	const limit = Math.min(Math.max(rawLimit, 1), 100);
	const offset = (Math.max(page, 1) - 1) * limit;

	const rows = ctx.storage.sql
		.exec(
			`SELECT e.id, e.subject, e.sender, e.recipient, e.cc, e.bcc, e.date,
				e.read, e.starred, e.thread_id, e.folder_id, e.priority,
				e.delivery_status, e.delivery_error,
				${snippetSql("e")} AS snippet, e.sender_name,
				${threading.hasAttachmentSql("e.id")} AS has_attachment
			 FROM email_labels el
			 JOIN emails e ON e.id = el.email_id
			 WHERE el.label_id = ?1 AND e.folder_id != ?2
			 ${labelFilterClause(options)}
			 ${threading.threadedOrderBy("e", options.sortColumn, options.sortDirection)}
			 LIMIT ?3 OFFSET ?4`,
			labelId,
			Folders.TRASH,
			limit,
			offset,
		)
		.toArray() as Record<string, unknown>[];

	return rows.map((row) => ({
		...row,
		read: !!row.read,
		starred: !!row.starred,
		has_attachment: !!row.has_attachment,
	}));
}

/**
 * Filter clause for the label queries, qualified to the `e` alias.
 *
 * `flatFilterConditions` qualifies its attachment check to `emails.id`, which is
 * not in scope inside this join, so the conditions are rebuilt against the alias
 * rather than reused verbatim. Takes no parameters, so callers keep their own
 * numbering.
 */
function labelFilterClause(filters: threading.ListFilterOptions): string {
	const clauses: string[] = [];
	if (filters.unread) clauses.push("e.read = 0");
	if (filters.starred) clauses.push("e.starred = 1");
	if (filters.has_attachment) {
		clauses.push(threading.hasAttachmentSql("e.id"));
	}
	return clauses.length > 0 ? `AND ${clauses.join(" AND ")}` : "";
}

export function countEmailsByLabel(
	ctx: DurableObjectState,
	labelId: string,
	filters: threading.ListFilterOptions = {},
): number {
	const row = ctx.storage.sql
		.exec(
			`SELECT COUNT(*) AS total
			 FROM email_labels el
			 JOIN emails e ON e.id = el.email_id
			 WHERE el.label_id = ?1 AND e.folder_id != ?2
			 ${labelFilterClause(filters)}`,
			labelId,
			Folders.TRASH,
		)
		.toArray()[0] as { total: number } | undefined;
	return row?.total ?? 0;
}

// ── Signatures ─────────────────────────────────────────────────────

export function getSignatures(ctx: DurableObjectState): SignatureRow[] {
	const rows = ctx.storage.sql
		.exec(
			`SELECT id, name, body_html, is_default, created_at, updated_at
			 FROM signatures ORDER BY is_default DESC, name ASC`,
		)
		.toArray() as Record<string, unknown>[];
	return rows.map((r) => ({ ...r, is_default: !!r.is_default })) as SignatureRow[];
}

export function getDefaultSignature(
	ctx: DurableObjectState,
): Omit<SignatureRow, "is_default"> | null {
	const row = ctx.storage.sql
		.exec(`SELECT id, name, body_html FROM signatures WHERE is_default = 1 LIMIT 1`)
		.toArray()[0] as unknown as Omit<SignatureRow, "is_default"> | undefined;
	return row ?? null;
}

export function createSignature(
	ctx: DurableObjectState,
	name: string,
	bodyHtml: string,
	isDefault = false,
): SignatureRow {
	const id = crypto.randomUUID();
	ctx.storage.transactionSync(() => {
		// At most one signature may be the default.
		if (isDefault) ctx.storage.sql.exec(`UPDATE signatures SET is_default = 0`);
		ctx.storage.sql.exec(
			`INSERT INTO signatures (id, name, body_html, is_default) VALUES (?, ?, ?, ?)`,
			id,
			name,
			bodyHtml,
			isDefault ? 1 : 0,
		);
	});
	return { id, name, body_html: bodyHtml, is_default: isDefault };
}

export function updateSignature(
	ctx: DurableObjectState,
	id: string,
	patch: { name?: string; body_html?: string; is_default?: boolean },
): SignatureRow | null {
	if (!rowExists(ctx, "signatures", id)) return null;

	ctx.storage.transactionSync(() => {
		// Clearing the other defaults has to happen before this row is written,
		// otherwise the blanket UPDATE would wipe the flag we just set.
		if (patch.is_default === true) {
			ctx.storage.sql.exec(`UPDATE signatures SET is_default = 0`);
		}

		const sets: string[] = [];
		const params: (string | number)[] = [];
		const push = (column: string, value: string | number) => {
			params.push(value);
			sets.push(`${column} = ?${params.length}`);
		};

		if (patch.name !== undefined) push("name", patch.name);
		if (patch.body_html !== undefined) push("body_html", patch.body_html);
		if (patch.is_default !== undefined) push("is_default", patch.is_default ? 1 : 0);
		sets.push(`updated_at = datetime('now')`);

		params.push(id);
		ctx.storage.sql.exec(
			`UPDATE signatures SET ${sets.join(", ")} WHERE id = ?${params.length}`,
			...params,
		);
	});

	const row = ctx.storage.sql
		.exec(`SELECT id, name, body_html, is_default FROM signatures WHERE id = ?`, id)
		.toArray()[0] as Record<string, unknown>;
	return { ...row, is_default: !!row.is_default } as SignatureRow;
}

export function deleteSignature(ctx: DurableObjectState, id: string): boolean {
	if (!rowExists(ctx, "signatures", id)) return false;
	ctx.storage.sql.exec(`DELETE FROM signatures WHERE id = ?`, id);
	return true;
}

// ── Priority ───────────────────────────────────────────────────────

/** `priority` is "high" | "low"; null resets the message to normal. */
export function setEmailPriority(
	ctx: DurableObjectState,
	id: string,
	priority: "high" | "low" | null,
): boolean {
	if (!rowExists(ctx, "emails", id)) return false;
	ctx.storage.sql.exec(`UPDATE emails SET priority = ? WHERE id = ?`, priority, id);
	return true;
}

// ── Snooze ─────────────────────────────────────────────────────────

/**
 * Move a message to the Snoozed folder until `untilIso`, remembering where it
 * came from so the alarm can put it back.
 *
 * Re-snoozing an already-snoozed message keeps the original return folder
 * instead of recording "snoozed" as its destination.
 */
export function snoozeEmail(
	ctx: DurableObjectState,
	id: string,
	untilIso: string,
): boolean {
	const row = ctx.storage.sql
		.exec(`SELECT folder_id, snooze_return_folder FROM emails WHERE id = ?`, id)
		.toArray()[0] as
		| { folder_id: string; snooze_return_folder: string | null }
		| undefined;
	if (!row) return false;

	const returnFolder =
		row.folder_id === Folders.SNOOZED
			? row.snooze_return_folder || Folders.INBOX
			: row.folder_id;

	ctx.storage.sql.exec(
		`UPDATE emails
		 SET folder_id = ?, snoozed_until = ?, snooze_return_folder = ?
		 WHERE id = ?`,
		Folders.SNOOZED,
		untilIso,
		returnFolder,
		id,
	);
	return true;
}

/** Return a snoozed message to its original folder immediately. */
export function unsnoozeEmail(ctx: DurableObjectState, id: string): boolean {
	// Existence is all this needs; the destination is resolved in SQL below.
	const row = ctx.storage.sql
		.exec(`SELECT 1 FROM emails WHERE id = ?`, id)
		.toArray()[0];
	if (!row) return false;

	// Resolved against `folders` rather than trusted, matching
	// `restoreFromTrash`: a custom folder can be deleted while a message that
	// lived in it is snoozed, and writing a dangling id would fail the foreign
	// key. Anything unresolvable wakes up in the inbox.
	ctx.storage.sql.exec(
		`UPDATE emails
		 SET folder_id = COALESCE(
		         (SELECT id FROM folders WHERE id = emails.snooze_return_folder),
		         ?1
		     ),
		     snoozed_until = NULL,
		     snooze_return_folder = NULL
		 WHERE id = ?2`,
		Folders.INBOX,
		id,
	);
	return true;
}

export function getSnoozedEmails(ctx: DurableObjectState) {
	const rows = ctx.storage.sql
		.exec(
			`SELECT id, subject, sender, recipient, date, read, starred,
				thread_id, folder_id, snoozed_until, snooze_return_folder,
				${snippetSql()} AS snippet, sender_name
			 FROM emails
			 WHERE folder_id = ? AND snoozed_until IS NOT NULL
			 ORDER BY snoozed_until ASC`,
			Folders.SNOOZED,
		)
		.toArray() as Record<string, unknown>[];
	return rows.map((r) => ({ ...r, read: !!r.read, starred: !!r.starred }));
}

/**
 * Return every snooze whose deadline has passed to its original folder.
 *
 * The return folder is resolved against `folders` instead of being written
 * straight through. A message snoozed out of a custom folder that was since
 * deleted would otherwise get a dangling `folder_id`, failing the foreign key
 * and taking the whole statement with it — stalling every *other* pending
 * snooze in the mailbox, not just its own.
 */
export function processDueSnoozes(ctx: DurableObjectState, now = new Date()): void {
	ctx.storage.sql.exec(
		`UPDATE emails
		 SET folder_id = COALESCE(
		         (SELECT id FROM folders WHERE id = emails.snooze_return_folder),
		         ?1
		     ),
			 snoozed_until = NULL,
			 snooze_return_folder = NULL
		 WHERE folder_id = ?2
		   AND snoozed_until IS NOT NULL
		   AND snoozed_until <= ?3`,
		Folders.INBOX,
		Folders.SNOOZED,
		now.toISOString(),
	);
}

// ── Scheduled / undo send ──────────────────────────────────────────

export function recordScheduledSend(
	ctx: DurableObjectState,
	emailId: string,
	sendAtIso: string,
	tracking: {
		trackingBaseUrl?: string | null;
		mailboxId?: string | null;
		/** `false`: deliver this one untracked. See migration 38. */
		track?: boolean | null;
	} = {},
): void {
	ctx.storage.sql.exec(
		`INSERT INTO scheduled_sends (email_id, send_at, status, tracking_base_url, tracking_mailbox_id, track)
		 VALUES (?, ?, 'pending', ?, ?, ?)`,
		emailId,
		sendAtIso,
		tracking.trackingBaseUrl ?? null,
		tracking.mailboxId?.toLowerCase() ?? null,
		tracking.track === false ? 0 : null,
	);
}

export function listScheduledSends(ctx: DurableObjectState) {
	return ctx.storage.sql
		.exec(
			`SELECT s.email_id, s.send_at, s.status, s.attempts, s.last_error,
				e.subject, e.sender, e.recipient, e.cc, e.bcc,
				${snippetSql("e")} AS snippet
			 FROM scheduled_sends s
			 JOIN emails e ON e.id = s.email_id
			 ORDER BY s.send_at ASC`,
		)
		.toArray() as Record<string, unknown>[];
}

/**
 * Cancel a pending scheduled send. The message moves to Drafts rather than
 * being deleted, so the user never loses text they wrote.
 */
export function cancelScheduledSend(
	ctx: DurableObjectState,
	emailId: string,
): { cancelled: boolean; status: string } | null {
	const row = ctx.storage.sql
		.exec(`SELECT status FROM scheduled_sends WHERE email_id = ?`, emailId)
		.toArray()[0] as { status: string } | undefined;
	if (!row) return null;
	if (row.status !== "pending") return { cancelled: false, status: row.status };

	ctx.storage.transactionSync(() => {
		ctx.storage.sql.exec(`DELETE FROM scheduled_sends WHERE email_id = ?`, emailId);
		ctx.storage.sql.exec(
			`UPDATE emails SET folder_id = ?, read = 1 WHERE id = ?`,
			Folders.DRAFT,
			emailId,
		);
		// An unsent message has nothing to wait for.
		ctx.storage.sql.exec(`DELETE FROM followups WHERE email_id = ?`, emailId);
	});

	return { cancelled: true, status: "cancelled" };
}

/**
 * Deliver scheduled messages whose time has come.
 *
 * Each gets up to MAX_SEND_ATTEMPTS tries with linear backoff. On permanent
 * failure the message lands in Drafts with the error recorded, so a bad address
 * never silently swallows the user's mail.
 *
 * The reason is written onto the email row as well as into `scheduled_sends`.
 * Only the schedule row used to carry it, and nothing the user can open reads
 * that table — so a message they had already sent reappeared in Drafts saying
 * nothing about why, and the obvious response is to press Send again into the
 * same wall.
 */
export async function processDueScheduledSends(
	ctx: DurableObjectState,
	env: Env,
	options: {
		/**
		 * Send-quota check, injected so this module does not duplicate the
		 * mailbox's rate-limit SQL. Returns an error message when over quota.
		 */
		checkRateLimit?: () => Promise<string | null>;
		now?: Date;
		/** Licence check (tests); defaults to `backgroundLocked`. */
		licenceLocked?: (env: Env) => Promise<boolean>;
	} = {},
): Promise<void> {
	const now = options.now ?? new Date();

	const due = ctx.storage.sql
		.exec(
			`SELECT email_id, attempts FROM scheduled_sends
			 WHERE status = 'pending' AND send_at <= ?1
			 ORDER BY send_at ASC
			 LIMIT ?2`,
			now.toISOString(),
			SEND_BATCH_SIZE,
		)
		.toArray() as { email_id: string; attempts: number }[];

	if (due.length === 0) return;

	// Licence locked (or its state unreadable): hold the batch, exactly like
	// the quota deferral below. `attempts` is untouched, so nothing falls back
	// to Drafts, and the messages go out on the first alarm after activation.
	if (await (options.licenceLocked ?? backgroundLocked)(env)) {
		const retryAt = new Date(now.getTime() + RETRY_INTERVAL_MS).toISOString();
		ctx.storage.transactionSync(() => {
			for (const item of due) {
				ctx.storage.sql.exec(`UPDATE scheduled_sends SET send_at = ? WHERE email_id = ?`, retryAt, item.email_id);
			}
		});
		console.log(`scheduled send held: licence required; ${due.length} message(s) retry at ${retryAt}`);
		return;
	}

	// The quota that matters is the one in force at delivery, not at scheduling
	// time. Being over it is not a delivery failure, so the batch is pushed back
	// without touching `attempts` — otherwise a quiet hour of throttling would
	// burn through the retry budget and dump good mail into Drafts.
	if (options.checkRateLimit) {
		const limitError = await options.checkRateLimit();
		if (limitError) {
			const retryAt = new Date(now.getTime() + RETRY_INTERVAL_MS).toISOString();
			console.log(`scheduled send deferred: ${limitError}; retrying at ${retryAt}`);
			ctx.storage.transactionSync(() => {
				for (const item of due) {
					ctx.storage.sql.exec(
						`UPDATE scheduled_sends SET send_at = ? WHERE email_id = ?`,
						retryAt,
						item.email_id,
					);
				}
			});
			return;
		}
	}

	for (const item of due) {
		await attemptScheduledSend(ctx, env, item);
	}
}

/**
 * One delivery attempt for one queued message, including the bookkeeping.
 *
 * Extracted so the alarm and the "Send now" button share a single definition of
 * what sending means. They used to be the same code only by coincidence, and
 * anything the batch path recorded — clearing `delivery_status`, the retry
 * backoff, the fall back into Drafts on the last attempt — is exactly what an
 * immediate send has to record too.
 *
 * Returns why it stopped, so a caller acting on a user's click can say
 * something more useful than "failed":
 *  - `sent`    — delivered, now in Sent
 *  - `vanished`— the email row was deleted under us; the schedule row is dropped
 *  - `failed`  — the attempt threw; `error` carries the reason and `exhausted`
 *                says whether the message has now been given up on
 */
async function attemptScheduledSend(
	ctx: DurableObjectState,
	env: Env,
	item: { email_id: string; attempts: number },
): Promise<
	| { outcome: "sent" }
	| { outcome: "vanished" }
	| { outcome: "claimed-elsewhere" }
	| { outcome: "failed"; error: string; exhausted: boolean }
> {
	/**
	 * Claim the row before doing anything external (Codex P1).
	 *
	 * Two callers race for one message: the alarm, and the Send now button. Both
	 * read `status = 'pending'`, and delivery then `await`s `EMAIL.send()` — during
	 * which the Durable Object is free to run the other one. Without a claim both
	 * pass their status check and the recipient gets two copies.
	 *
	 * `WHERE status = 'pending'` inside the UPDATE is what makes this safe: SQLite
	 * applies it atomically, so exactly one caller changes a row and the loser sees
	 * `rowsWritten === 0`. Checking and then updating in two statements would leave
	 * the same window open.
	 *
	 * `sending` is a distinct state from `sent` on purpose. It says "in flight",
	 * which is what lets the alarm skip a message another caller is mid-delivery on
	 * rather than treating it as available. The failure paths below return it to
	 * `pending` (or `failed` when the budget is gone), so a crash cannot strand a
	 * message in it — and the read-time staleness check in `processDueScheduledSends`
	 * recovers one that an isolate died holding.
	 */
	const claimed = ctx.storage.sql.exec(
		`UPDATE scheduled_sends
		    SET status = 'sending'
		  WHERE email_id = ? AND status = 'pending'`,
		item.email_id,
	);
	if (claimed.rowsWritten === 0) return { outcome: "claimed-elsewhere" };

	const email = ctx.storage.sql
		.exec(
			`SELECT e.id, e.subject, e.sender, e.recipient, e.cc, e.bcc, e.body, e.message_id,
				e.thread_id, e.in_reply_to, e.email_references, e.raw_headers,
				s.tracking_base_url, s.tracking_mailbox_id, s.track
			 FROM emails e
			 LEFT JOIN scheduled_sends s ON s.email_id = e.id
			 WHERE e.id = ?`,
			item.email_id,
		)
		.toArray()[0] as unknown as ScheduledEmailRow | undefined;

	if (!email) {
		// The message was deleted out from under us; drop the schedule row.
		ctx.storage.sql.exec(
			`DELETE FROM scheduled_sends WHERE email_id = ?`,
			item.email_id,
		);
		return { outcome: "vanished" };
	}

	try {
		await deliverScheduledEmail(ctx, env, email);

		ctx.storage.transactionSync(() => {
			ctx.storage.sql.exec(
				`UPDATE scheduled_sends
				 SET status = 'sent', attempts = attempts + 1, last_error = NULL
				 WHERE email_id = ?`,
				item.email_id,
			);
			// The failure marks are cleared here, not only on the retry path: a
			// message that failed twice and went out on the third attempt is
			// delivered, and a banner saying otherwise on a message sitting in Sent
			// is worse than no banner at all.
			ctx.storage.sql.exec(
				`UPDATE emails
				    SET folder_id = ?, read = 1, date = ?,
				        delivery_status = 'sent', delivery_error = NULL
				  WHERE id = ?`,
				Folders.SENT,
				new Date().toISOString(),
				item.email_id,
			);
		});
		// Delivered mail is now in Sent: a reply in a thread with a reminder
		// restarts its clock, exactly as an immediate send does in createEmail.
		followups.onEmailStored(ctx, {
			id: item.email_id,
			folder_id: Folders.SENT,
			thread_id: email.thread_id ?? null,
		});
		// The conversation grew by one sent message: refresh its AI summary.
		// The alarm that drains the queue is re-armed by the caller.
		queueSummaryAfterSend(ctx, email.id);
		return { outcome: "sent" };
	} catch (e) {
		const message = describeSendError(e);
		const attempts = item.attempts + 1;
		const exhausted = attempts >= MAX_SEND_ATTEMPTS;

		console.error(
			`scheduled send failed for ${item.email_id} (attempt ${attempts}):`,
			message,
		);

		ctx.storage.transactionSync(() => {
			ctx.storage.sql.exec(
				`UPDATE scheduled_sends
				 SET attempts = ?1, last_error = ?2, status = ?3, send_at = ?4
				 WHERE email_id = ?5`,
				attempts,
				message.slice(0, 500),
				exhausted ? "failed" : "pending",
				exhausted
					? new Date().toISOString()
					: new Date(Date.now() + attempts * RETRY_INTERVAL_MS).toISOString(),
				item.email_id,
			);
			if (exhausted) {
				ctx.storage.sql.exec(
					`UPDATE emails
					    SET folder_id = ?1, delivery_status = 'failed', delivery_error = ?2
					  WHERE id = ?3`,
					Folders.DRAFT,
					message.slice(0, DELIVERY_ERROR_MAX_LENGTH),
					item.email_id,
				);
			}
		});
		// The give-up is a delivery outcome like any other, so it goes in the
		// ledger: the timeline shows it, and the webhook flush turns it into
		// `message.delivery_failed`. Only on the final attempt; a retry pending
		// is not a failure yet. Outside the transaction because it never throws.
		if (exhausted) {
			appendDeliveryEvent(ctx, {
				emailId: item.email_id,
				type: "failed",
				source: "send",
				errorCause: "internal",
				errorDetail: message,
				dedupeKey: `send:failed:${item.email_id}:${attempts}`,
			});
		}
		return { outcome: "failed", error: message, exhausted };
	}
}

/**
 * Deliver one queued message right now, skipping the rest of its wait.
 *
 * The other half of the undo window: Undo pulls the message back into Drafts,
 * this pushes it out early. Both have to be reachable while the toast is up,
 * because the alternative for someone who wants the mail gone now is to sit and
 * watch a countdown.
 *
 * Delivery goes through `attemptScheduledSend`, so an immediate send is the same
 * event as an alarm-driven one — same Sent row, same retry accounting, same
 * fall back into Drafts if it fails for good. Nothing here writes a second copy
 * or a second `Message-ID`.
 *
 * The quota is still checked. Send now shortens the wait; it is not a way around
 * the mailbox's hourly and daily limits, and the message stays queued so the
 * alarm can carry it later.
 *
 * Returns null when there is no such queued message (404), and a non-`pending`
 * status when the alarm already claimed it (409) — the race this is most likely
 * to lose, since the button and the alarm are chasing the same row.
 */
export async function sendScheduledSendNow(
	ctx: DurableObjectState,
	env: Env,
	emailId: string,
	options: { checkRateLimit?: () => Promise<string | null> } = {},
): Promise<
	| { status: "sent" }
	| { status: "already"; current: string }
	| { status: "deferred"; error: string }
	| { status: "failed"; error: string; exhausted: boolean }
	| null
> {
	const row = ctx.storage.sql
		.exec(
			`SELECT status, attempts FROM scheduled_sends WHERE email_id = ?`,
			emailId,
		)
		.toArray()[0] as { status: string; attempts: number } | undefined;

	if (!row) return null;
	if (row.status !== "pending") return { status: "already", current: row.status };

	// Locked: leave it queued (the API gate normally refuses before this).
	if (await backgroundLocked(env)) return { status: "deferred", error: "This deployment needs an active licence." };

	if (options.checkRateLimit) {
		const limitError = await options.checkRateLimit();
		if (limitError) return { status: "deferred", error: limitError };
	}

	const result = await attemptScheduledSend(ctx, env, {
		email_id: emailId,
		attempts: row.attempts,
	});

	// The row is gone, so there is nothing left to send and nothing to report a
	// failure about. Treated as not-found rather than as an error: from the
	// caller's side the queued message no longer exists.
	if (result.outcome === "vanished") return null;
	if (result.outcome === "sent") return { status: "sent" };
	/**
	 * The alarm claimed the row between the status read above and the claim inside
	 * `attemptScheduledSend`. Reported as `already`, exactly like losing the race
	 * before the read — the click and the alarm wanted the same thing, and the
	 * message is on its way, so the caller turns this into the 409 the UI already
	 * treats as success.
	 */
	if (result.outcome === "claimed-elsewhere") {
		return { status: "already", current: "sending" };
	}
	return { status: "failed", error: result.error, exhausted: result.exhausted };
}

/**
 * Mark a sent message as bounced, given what a DSN reported on.
 *
 * The correlation the whole bounce feature rests on. `emails.message_id` holds
 * the id this app put in the outgoing `Message-ID` header, and a notification
 * returns the original's headers, so the id read out of the report is the join
 * key. Indexed by `idx_emails_message_id` (migration 21).
 *
 * Restricted to Sent. A bounce is a report about something this mailbox sent,
 * and the id space is not ours: a message we *received* can legitimately carry
 * any `Message-ID` at all, so an unrestricted match would let a forged report
 * name an inbound message and stamp a delivery failure onto someone else's mail.
 * Scheduled and draft rows are excluded for the same reason plus a practical
 * one — a message still queued has not been delivered to anything yet, so there
 * is nothing for a remote server to have rejected.
 *
 * The Sent restriction alone is not enough, which is why `reportedRecipient`
 * exists. A `Message-ID` is not a secret: every recipient of a message received
 * a copy of it, and the content-type detection path accepts a report from any
 * sender. Without a second check, anyone we have ever mailed could send a
 * `multipart/report` naming that id and stamp our own sent message as bounced,
 * with their text in `delivery_error` for the user to read.
 *
 * So a report must also name a recipient the message was actually addressed to.
 * That is true of every genuine DSN — a bounce reports which delivery failed —
 * and it reduces the worst a forger can do to claiming failure for their own
 * address, which they could equally achieve by configuring their own mail
 * server to reject us. A report naming no recipient at all is refused rather
 * than trusted, since that is the shape a forger would send.
 *
 * Returns the id of the row it marked, or null when nothing matched. Null is the
 * ordinary case for a bounce of a message sent from somewhere else, and the
 * caller treats it as such: the notification is still stored and delivered.
 */
export function markBounced(
	ctx: DurableObjectState,
	originalMessageId: string | null | undefined,
	reason: string,
	reportedRecipient: string | null | undefined,
): { emailId: string } | null {
	const needle = originalMessageId?.trim().replace(/^<|>$/g, "");
	if (!needle) return null;

	const reported = normalizeAddress(reportedRecipient);
	if (!reported) return null;

	const row = ctx.storage.sql
		.exec(
			`SELECT id, recipient, cc, bcc FROM emails
			  WHERE message_id = ?1 AND folder_id = ?2
			  ORDER BY date DESC
			  LIMIT 1`,
			needle,
			Folders.SENT,
		)
		.toArray()[0] as
		| { id: string; recipient: string | null; cc: string | null; bcc: string | null }
		| undefined;

	if (!row) return null;

	const addressed = new Set(
		[row.recipient, row.cc, row.bcc]
			.flatMap((field) => (field ?? "").split(","))
			.map(normalizeAddress)
			.filter((address): address is string => address !== null),
	);

	if (!addressed.has(reported)) return null;

	ctx.storage.sql.exec(
		`UPDATE emails
		    SET delivery_status = 'bounced', delivery_error = ?1
		  WHERE id = ?2`,
		reason.slice(0, DELIVERY_ERROR_MAX_LENGTH),
		row.id,
	);

	// Also record it in the ledger, keyed to the reporting recipient so a
	// redelivered DSN for the same address does not double-count. `errorCause`
	// is left null here: the DSN's own status/diagnostic is the reason, and the
	// coarse our-vs-their bucketing is applied by the reconciler from the
	// provider's classification, not re-derived from free text.
	appendDeliveryEvent(ctx, {
		emailId: row.id,
		type: "bounced",
		source: "dsn",
		recipient: reported,
		errorDetail: reason,
		dedupeKey: `dsn:bounced:${row.id}:${reported}`,
	});

	return { emailId: row.id };
}

/**
 * Record a feedback-loop (ARF) spam complaint against the message it names.
 *
 * Same trust model as {@link markBounced}: the original `Message-ID` must match
 * a row in Sent, so a forged report cannot suppress an arbitrary address. The
 * complainer is the report's named recipient when that is one the message was
 * addressed to; when the provider redacted it (common) and the message had a
 * single recipient, that recipient. A redacted report about a multi-recipient
 * message cannot be attributed and is not acted on.
 *
 * Appends a `complained` ledger event (deduped per message and recipient) and
 * returns the recipient for the caller to suppress, or null.
 */
export function recordComplaint(
	ctx: DurableObjectState,
	originalMessageId: string | null | undefined,
	reportedRecipient: string | null | undefined,
	detail: string | null,
): { emailId: string; recipient: string } | null {
	const needle = originalMessageId?.trim().replace(/^<|>$/g, "");
	if (!needle) return null;
	const row = ctx.storage.sql
		.exec(
			`SELECT id, recipient, cc, bcc FROM emails
			  WHERE message_id = ?1 AND folder_id = ?2
			  ORDER BY date DESC
			  LIMIT 1`,
			needle,
			Folders.SENT,
		)
		.toArray()[0] as
		| { id: string; recipient: string | null; cc: string | null; bcc: string | null }
		| undefined;
	if (!row) return null;

	const addressed = [
		...new Set(
			[row.recipient, row.cc, row.bcc]
				.flatMap((field) => (field ?? "").split(","))
				.map(normalizeAddress)
				.filter((address): address is string => address !== null),
		),
	];
	const reported = normalizeAddress(reportedRecipient);
	const recipient = reported
		? addressed.includes(reported)
			? reported
			: null
		: addressed.length === 1
			? addressed[0]
			: null;
	if (!recipient) return null;

	appendDeliveryEvent(ctx, {
		emailId: row.id,
		type: "complained",
		source: "dsn",
		recipient,
		errorDetail: detail,
		dedupeKey: `arf:complained:${row.id}:${recipient}`,
	});
	// The cached status the list and reader show follows the ledger: a
	// complaint after delivery is the newer truth.
	recomputeDeliveryStatus(ctx, row.id);
	return { emailId: row.id, recipient };
}

/**
 * Write back what the provider actually did with a message.
 *
 * ## Why this exists
 *
 * The send routes return `202 {"status":"sent"}` and write the Sent copy BEFORE
 * delivery is attempted, then hand the real `env.EMAIL.send()` to `waitUntil`.
 * A rejection there used to reach nothing but `console.error`, so a message that
 * never left the building sat in Sent looking identical to a delivered one. That
 * is how a header rejection took down 100% of outgoing mail without a single
 * failing test or visible symptom.
 *
 * Two distinct outcomes are recorded:
 *
 * - **Success** stores the provider's `Message-ID` in `emails.message_id`. Email
 *   Service generates that id and refuses to let a caller set one, so it is the
 *   ONLY id the outside world knows the message by — and therefore the id an
 *   inbound reply cites in `In-Reply-To`, which `findThreadByMessageIds` and
 *   `markBounced` both join on. Recording it is what keeps threading and bounce
 *   correlation working now that we no longer invent the id ourselves.
 * - **Failure** sets `delivery_status = 'failed'` plus the reason, using the same
 *   columns and the same 500-char cap as the scheduled-send and bounce paths, so
 *   the existing UI surfaces it with no new rendering.
 *
 * Deliberately leaves the row in Sent on failure. Moving it back to Drafts is the
 * scheduled-send behaviour, where a retry is still pending; here the attempt is
 * over, and silently relocating a message the user watched leave would be a
 * second surprise on top of the first. The status is what tells the story.
 *
 * Never throws: it runs on the tail of a `waitUntil` chain, where an exception
 * would replace a recorded failure with an unrecorded one.
 */
export function recordDelivery(
	ctx: DurableObjectState,
	emailId: string,
	outcome: { providerMessageId?: string; error?: string },
): void {
	try {
		const providerId = outcome.providerMessageId?.trim().replace(/^<|>$/g, "");
		if (providerId) {
			ctx.storage.sql.exec(
				`UPDATE emails
				    SET message_id = ?1, delivery_status = 'sent', delivery_error = NULL
				  WHERE id = ?2`,
				providerId,
				emailId,
			);
			// A returned provider id means Email Service accepted the message — it is
			// `sent`, NOT yet `delivered`. Delivery to the recipient's server is
			// confirmed later by the GraphQL reconciler or a DSN; recording it here
			// would claim more than the 202 knows. The `sent` event carries the
			// provider id so a later reconciler row can be joined even before the
			// local status changes.
			appendDeliveryEvent(ctx, {
				emailId,
				type: "sent",
				source: "send",
				providerMessageId: providerId,
			});
			return;
		}
		if (outcome.error) {
			ctx.storage.sql.exec(
				`UPDATE emails
				    SET delivery_status = 'failed', delivery_error = ?1
				  WHERE id = ?2`,
				outcome.error.slice(0, DELIVERY_ERROR_MAX_LENGTH),
				emailId,
			);
			// Our own send call threw before the provider ever accepted the message:
			// a rejected header, a binding error, a timeout. That is `failed`, an
			// error on our side of the handoff, distinct from a downstream `bounced`.
			appendDeliveryEvent(ctx, {
				emailId,
				type: "failed",
				source: "send",
				errorCause: "internal",
				errorDetail: outcome.error,
			});
		}
	} catch (e) {
		// The message itself is already sent or already failed; losing the audit of
		// that is bad but not worth turning into an unhandled rejection.
		console.error("recordDelivery failed for", emailId, (e as Error)?.message);
	}
}

// ── Delivery-event ledger (migration 24) ───────────────────────────

/**
 * `DeliveryEventInput` is defined in `shared/delivery-events.ts` and imported
 * above: the reconciler builds it before sending it over RPC and must not reach
 * into the Durable Object layer, so the shape lives in `shared/`.
 *
 * A stored ledger row, as read back for the reading pane and analytics.
 */
export interface DeliveryEventRow {
	id: number;
	email_id: string;
	recipient: string | null;
	event_type: string;
	source: string;
	provider_message_id: string | null;
	error_cause: string | null;
	error_detail: string | null;
	metadata: string | null;
	occurred_at: string;
	created_at: string;
}

/**
 * Append one event to the delivery ledger, deduping when asked.
 *
 * ## Why this is separate from `recordDelivery`
 *
 * `recordDelivery` maintains the *coarse cache* on `emails` that the current UI
 * already reads. This maintains the *detailed history* the new features query.
 * `recordDelivery` calls this so a single send path keeps both in step, but the
 * DSN handler, the GraphQL reconciler and the tracking endpoint call this
 * directly — they add history without necessarily changing the cached status
 * (an `opened` event must never touch `delivery_status`).
 *
 * ## De-duplication
 *
 * When `dedupeKey` is set the insert is `ON CONFLICT DO NOTHING` against the
 * partial unique index, so the reconciler re-reading the same 3-day window every
 * five minutes writes each provider verdict exactly once. Engagement events pass
 * no key and always insert.
 *
 * Never throws for the same reason `recordDelivery` does not: several callers
 * run on a `waitUntil` tail, and an unhandled rejection there would replace a
 * recorded event with an unrecorded failure. Returns whether a row was written,
 * so a caller that needs to know (the reconciler counting new events) can tell a
 * dedupe no-op from a real insert.
 */
export function appendDeliveryEvent(
	ctx: DurableObjectState,
	event: DeliveryEventInput,
): boolean {
	try {
		const occurredAt = event.occurredAt ?? new Date().toISOString();
		const providerId =
			event.providerMessageId?.trim().replace(/^<|>$/g, "") || null;
		const detail = event.errorDetail
			? event.errorDetail.slice(0, DELIVERY_ERROR_MAX_LENGTH)
			: null;
		const metadata = event.metadata ? JSON.stringify(event.metadata) : null;
		const recipient = normalizeAddress(event.recipient) ?? null;

		const result = ctx.storage.sql.exec(
			`INSERT INTO delivery_events
			     (email_id, recipient, event_type, source, provider_message_id,
			      error_cause, error_detail, metadata, dedupe_key, occurred_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
			 ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
			event.emailId,
			recipient,
			event.type,
			event.source,
			providerId,
			event.errorCause ?? null,
			detail,
			metadata,
			event.dedupeKey ?? null,
			occurredAt,
		);
		return (result.rowsWritten ?? 0) > 0;
	} catch (e) {
		console.error(
			"appendDeliveryEvent failed for",
			event.emailId,
			(e as Error)?.message,
		);
		return false;
	}
}

/**
 * Every ledger event for one message, oldest first.
 *
 * Oldest-first because the reading pane renders a timeline (queued → sent →
 * delivered → opened) and that is its natural order; the analytics path does its
 * own aggregation and does not use this.
 */
export function getDeliveryEvents(
	ctx: DurableObjectState,
	emailId: string,
): DeliveryEventRow[] {
	return ctx.storage.sql
		.exec(
			`SELECT id, email_id, recipient, event_type, source,
			        provider_message_id, error_cause, error_detail, metadata,
			        occurred_at, created_at
			   FROM delivery_events
			  WHERE email_id = ?1
			  ORDER BY occurred_at ASC, id ASC`,
			emailId,
		)
		.toArray() as unknown as DeliveryEventRow[];
}

/**
 * Recompute `emails.delivery_status` from the ledger for one message.
 *
 * The cache and the ledger can only diverge if something wrote one without the
 * other, but a reconciled `delivered` (which arrives via the ledger alone, from
 * GraphQL) DOES need to flip a message out of a stale `failed`. So after the
 * reconciler appends provider verdicts it calls this to bring the cache forward.
 *
 * Uses `latestTerminalStatus` so the rule lives in one shared, tested place
 * rather than being re-expressed in SQL. A message with no terminal event yet
 * resets to NULL — the correct "in-flight, nothing known" state — but only if it
 * is not currently `failed` from a source the ledger does not yet mirror; to
 * avoid erasing a genuine failure recorded before this table existed, a NULL
 * recompute never overwrites an existing non-null status. It only ever promotes
 * to `delivered` or records a `failed` the ledger can see.
 */
export function recomputeDeliveryStatus(
	ctx: DurableObjectState,
	emailId: string,
): void {
	try {
		const events = ctx.storage.sql
			.exec(
				`SELECT event_type, occurred_at FROM delivery_events
				  WHERE email_id = ?1`,
				emailId,
			)
			.toArray() as unknown as DatedLifecycleEvent[];

		const status = latestTerminalStatus(events);
		if (status === null) return; // nothing terminal in the ledger; leave the cache

		if (status === "delivered") {
			ctx.storage.sql.exec(
				`UPDATE emails
				    SET delivery_status = 'delivered', delivery_error = NULL
				  WHERE id = ?1`,
				emailId,
			);
		} else {
			ctx.storage.sql.exec(
				`UPDATE emails
				    SET delivery_status = 'failed'
				  WHERE id = ?1 AND delivery_status IS NOT 'failed'`,
				emailId,
			);
		}
	} catch (e) {
		console.error(
			"recomputeDeliveryStatus failed for",
			emailId,
			(e as Error)?.message,
		);
	}
}

/**
 * File a batch of provider-observed verdicts into this mailbox's ledger.
 *
 * The reconciler hands verdicts keyed by the provider's `messageId` — that is
 * the only id it has, because the CF dataset is zone-wide and knows nothing of
 * our local row ids. This resolves each to the local `emails.id` by the
 * `message_id` column `recordDelivery` populated on send, appends the event, and
 * recomputes the coarse status for any row a terminal verdict touched.
 *
 * A verdict whose `messageId` matches no local row is skipped, not an error: the
 * zone sends mail from surfaces other than this app (the marketing domain seen
 * in the live data), and reconciling only what we sent is correct. Skipped and
 * deduped verdicts both count as "not applied", so `applied` is the number of
 * genuinely-new ledger rows — the figure the cron log reports.
 *
 * Returns `{ applied }`. Never throws for a single bad verdict; the loop
 * isolates each so one malformed row cannot drop the rest of the batch.
 */
export function reconcileProviderEvents(
	ctx: DurableObjectState,
	events: DeliveryEventInput[],
): { applied: number; matched: number } {
	let applied = 0;
	const matched = new Set<string>();

	for (const event of events) {
		try {
			// `emailId` arrives holding the provider id (the reconciler has nothing
			// else); resolve it to the local row.
			const providerId = event.providerMessageId?.trim().replace(/^<|>$/g, "");
			if (!providerId) continue;

			const rowId = findOutboundRowByProviderId(ctx, providerId);
			if (!rowId) continue; // not a message this app sent

			matched.add(rowId);
			if (appendDeliveryEvent(ctx, { ...event, emailId: rowId })) applied += 1;
		} catch (e) {
			console.error(
				"reconcileProviderEvents skipped a verdict:",
				(e as Error)?.message,
			);
		}
	}

	/**
	 * Recompute the coarse cache for EVERY matched row, not only rows that
	 * gained an event this batch.
	 *
	 * The verdict is deduped, so a row reconciled before the cache learned the
	 * value `delivered` (pre-#103 it was written back as NULL) would otherwise
	 * never be revisited: every later tick dedupes the same verdict and skips the
	 * recompute, leaving `delivery_status` NULL forever. Recomputing is a cheap
	 * per-row read and is idempotent, so the re-read window heals those rows.
	 */
	for (const emailId of matched) {
		recomputeDeliveryStatus(ctx, emailId);
	}

	return { applied, matched: matched.size };
}

/**
 * The local row a provider `messageId` names, among messages this mailbox sent.
 *
 * - **Either bracket form.** Most send paths store the id bare (`recordDelivery`
 *   strips `<>`), but the agent/MCP tools stored `send()`'s `messageId` as
 *   returned, which is `<…@domain>`. Matching both keeps those rows joinable.
 * - **Any outbound row, not only Sent.** A sent message the user archived (or
 *   whose thread they filed) still went out; restricting to `folder_id='sent'`
 *   left it unreconciled forever. A row counts as outbound when it has a
 *   `sent`/`queued` ledger event (written by every send path), or is in Sent.
 *   Inbound copies of our own mail (a self-send) never have such an event.
 */
export function findOutboundRowByProviderId(
	ctx: DurableObjectState,
	providerId: string,
): string | null {
	const bare = providerId.trim().replace(/^<|>$/g, "");
	if (!bare) return null;
	const row = ctx.storage.sql
		.exec(
			`SELECT e.id AS id FROM emails e
			  WHERE e.message_id IN (?1, ?2)
			    AND (
			          e.folder_id = ?3
			          OR EXISTS (
			               SELECT 1 FROM delivery_events de
			                WHERE de.email_id = e.id AND de.event_type IN ('sent', 'queued')
			             )
			        )
			  -- A row the ledger proves we sent beats one that is merely in Sent.
			  ORDER BY EXISTS (
			             SELECT 1 FROM delivery_events de
			              WHERE de.email_id = e.id AND de.event_type IN ('sent', 'queued')
			           ) DESC,
			           (e.folder_id = ?3) DESC, e.date DESC LIMIT 1`,
			bare,
			`<${bare}>`,
			Folders.SENT,
		)
		.toArray()[0] as { id: string } | undefined;
	return row?.id ?? null;
}

// ── Tracking settings + engagement (migration 25) ──────────────────

/** The per-mailbox tracking configuration the send path and endpoint read. */
export interface TrackingSettings {
	openTracking: boolean;
	clickTracking: boolean;
	attachmentTracking: boolean;
	/** Append a tracking disclosure line to tracked mail (migration 38). */
	disclosureEnabled: boolean;
	/** The line itself; null means the default wording. */
	disclosureText: string | null;
}

/** Longest disclosure line accepted. One sentence, not a policy. */
export const DISCLOSURE_TEXT_MAX = 300;

interface TrackingSettingsRow {
	open_tracking: number;
	click_tracking: number;
	attachment_tracking: number;
	secret: string | null;
	disclosure_enabled?: number;
	disclosure_text?: string | null;
}

function readTrackingRow(ctx: DurableObjectState): TrackingSettingsRow {
	const row = ctx.storage.sql
		.exec(
			`SELECT open_tracking, click_tracking, attachment_tracking, secret,
			        disclosure_enabled, disclosure_text
			   FROM tracking_settings WHERE id = 1`,
		)
		.toArray()[0] as unknown as TrackingSettingsRow | undefined;
	// The migration seeds row 1, but a mailbox whose migration has only just run
	// (or a test table) may not have it; default to tracking-on, matching the
	// column defaults and the operator's decision.
	return (
		row ?? {
			open_tracking: 1,
			click_tracking: 1,
			attachment_tracking: 1,
			secret: null,
		}
	);
}

/** The mailbox's tracking toggles, for the settings screen and the send path. */
export function getTrackingSettings(ctx: DurableObjectState): TrackingSettings {
	const row = readTrackingRow(ctx);
	return {
		openTracking: Number(row.open_tracking) === 1,
		clickTracking: Number(row.click_tracking) === 1,
		attachmentTracking: Number(row.attachment_tracking) === 1,
		disclosureEnabled: Number(row.disclosure_enabled ?? 0) === 1,
		disclosureText: row.disclosure_text ?? null,
	};
}

/**
 * Update the mailbox's tracking toggles. Only the fields present are changed, so
 * the settings screen can flip one switch without resending the others.
 */
export function updateTrackingSettings(
	ctx: DurableObjectState,
	patch: Partial<TrackingSettings>,
): TrackingSettings {
	const current = getTrackingSettings(ctx);
	const next = { ...current, ...patch };
	const text = next.disclosureText?.trim().slice(0, DISCLOSURE_TEXT_MAX) || null;
	// The seed row normally exists; recreate it if a test table lacks it.
	ctx.storage.sql.exec(`INSERT OR IGNORE INTO tracking_settings (id) VALUES (1)`);
	ctx.storage.sql.exec(
		`UPDATE tracking_settings
		    SET open_tracking = ?1, click_tracking = ?2, attachment_tracking = ?3,
		        disclosure_enabled = ?4, disclosure_text = ?5,
		        updated_at = datetime('now')
		  WHERE id = 1`,
		next.openTracking ? 1 : 0,
		next.clickTracking ? 1 : 0,
		next.attachmentTracking ? 1 : 0,
		next.disclosureEnabled ? 1 : 0,
		text,
	);
	return { ...next, disclosureText: text };
}

/**
 * The mailbox's token-signing secret, generating one on first use.
 *
 * Lazy so no migration has to invent randomness and so a mailbox that never
 * sends tracked mail never gets a secret. Once minted it is stable, so every
 * token for the mailbox verifies against the same key; rotating it (by writing a
 * new one) invalidates every outstanding tracking link for that mailbox at once,
 * which is the revocation mechanism.
 *
 * Returned to the send path (which signs tokens) and never exposed over any
 * read API — it is a signing key, not a setting.
 */
/**
 * The mailbox's signing secret if it has one, WITHOUT creating it.
 *
 * The read side of the pair. The public tracking endpoint must never mint a
 * secret: the mailbox id in a token is attacker-controlled until the signature
 * is verified, so a create-on-read there would let anyone persist state for an
 * arbitrary name. A mailbox with no secret has never sent tracked mail, so no
 * valid token for it can exist and null is the correct answer.
 */
export function getTrackingSecret(ctx: DurableObjectState): string | null {
	return readTrackingRow(ctx).secret;
}

export function getOrCreateTrackingSecret(ctx: DurableObjectState): string {
	const existing = readTrackingRow(ctx).secret;
	if (existing) return existing;

	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const secret = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
		"",
	);
	ctx.storage.sql.exec(
		`UPDATE tracking_settings SET secret = ?1 WHERE id = 1 AND secret IS NULL`,
		secret,
	);
	// Re-read rather than trust the write: a concurrent send may have minted one
	// first, and both must end up using the same key.
	return readTrackingRow(ctx).secret ?? secret;
}

/**
 * Record an engagement event (open, click, attachment download) against a
 * message, resolving the token's `emailId` — already a local row id, since the
 * token was minted with it — straight through.
 *
 * Engagement never dedupes: every open is real signal. Returns whether the row
 * existed, so the endpoint can 404 a token that names a message since deleted
 * rather than silently recording against nothing.
 */
export function recordEngagement(
	ctx: DurableObjectState,
	event: DeliveryEventInput,
): boolean {
	const row = ctx.storage.sql
		.exec(`SELECT id FROM emails WHERE id = ?1 LIMIT 1`, event.emailId)
		.toArray()[0] as { id: string } | undefined;
	if (!row) return false;
	// One transaction, so the event and the list's engagement cache land
	// together. Writing the row also bumps `mailbox_state.version`, which is
	// what makes an open Sent list refetch.
	ctx.storage.transactionSync(() => {
		appendDeliveryEvent(ctx, event);
		recomputeEngagement(ctx, event.emailId);
	});
	return true;
}

// ── Sent analytics (aggregates over the ledger) ────────────────────

/** The headline counts a mailbox's Sent-analytics panel renders. */
export interface SentAnalytics {
	/** Distinct messages this mailbox sent in the window (rows created in Sent). */
	sent: number;
	/** Of those, how many have a `delivered` ledger event. */
	delivered: number;
	/** How many have a terminal failure (bounced/rejected/failed/complained). */
	failed: number;
	/** Distinct messages with at least one `opened` event. */
	opened: number;
	/** Distinct messages with at least one `clicked` event. */
	clicked: number;
	/** Failures the reconciler attributed to our side. */
	failedInternal: number;
	/** Failures attributed to the recipient's server. */
	failedRecipient: number;
}

/**
 * Aggregate this mailbox's outbound delivery + engagement over a date window.
 *
 * Counts are over DISTINCT messages, not events: a message opened five times is
 * one `opened`, and a message with both a soft-bounce and a delivery is one
 * `delivered` (the ledger keeps every event; the panel wants "how many messages
 * reached someone"). Rates are computed by the caller from these integers so the
 * denominator is explicit and no division happens in SQL.
 *
 * ## Cohort first, then that cohort's whole history
 *
 * The window selects the MESSAGES (by `emails.date`), and every outcome counted
 * is an outcome of one of those messages — with no second window on the events.
 * Filtering events by `occurred_at` independently was wrong twice over: opening
 * an eight-day-old message today incremented `opened` in a 7-day view whose
 * `sent` and `delivered` did not include it, so open rate could exceed 100%; and
 * a delivery reconciled just after the window closed was dropped from a cohort
 * that still counted the send.
 *
 * ## Outbound membership does not depend on the current folder
 *
 * `folder_id = 'sent'` was the old test, which quietly removed a message from
 * the denominator the moment someone archived or binned it while its ledger
 * events still counted — turning 1 sent/1 delivered into 0 sent/1 delivered.
 * A `sent` ledger event is the immutable marker instead: every send path writes
 * one and nothing rewrites it, wherever the message later moves. Rows in Sent
 * are still counted so mail that predates the ledger is not lost.
 *
 * ## One terminal verdict per message
 *
 * Failures are not simply erased whenever a delivery exists. Each message's
 * terminal events are collapsed with `latestTerminalStatus`, the same rule the
 * reading pane uses, so a delivery followed by a bounce or a complaint reports
 * as failed rather than delivered, and only the winning event's attribution
 * lands in a failure bucket — a retry whose cause changed cannot populate both.
 *
 * `start`/`end` are ISO strings. Read-only, so it never risks the served table.
 */
export function getSentAnalytics(
	ctx: DurableObjectState,
	window: { start: string; end: string },
): SentAnalytics {
	/**
	 * The cohort: messages this mailbox SENT inside the window.
	 *
	 * A row qualifies either because the ledger holds a `sent`/`queued` event for
	 * it — the immutable marker, true regardless of where the message now lives —
	 * or because it is still sitting in Sent, which covers messages sent before
	 * the ledger existed.
	 */
	const cohortRows = ctx.storage.sql
		.exec(
			`SELECT e.id AS id
			   FROM emails e
			  WHERE e.date >= ?1 AND e.date <= ?2
			    AND (
			          e.folder_id = ?3
			          OR EXISTS (
			               SELECT 1 FROM delivery_events de
			                WHERE de.email_id = e.id
			                  AND de.event_type IN ('sent', 'queued')
			             )
			        )`,
			window.start,
			window.end,
			Folders.SENT,
		)
		.toArray() as unknown as { id: string }[];

	const cohort = new Set(cohortRows.map((row) => row.id));
	if (cohort.size === 0) {
		return {
			sent: 0,
			delivered: 0,
			failed: 0,
			opened: 0,
			clicked: 0,
			failedInternal: 0,
			failedRecipient: 0,
		};
	}

	/**
	 * Every event belonging to that cohort, with NO window on `occurred_at`.
	 *
	 * The cohort is already bounded, so its outcomes are whatever happened to
	 * those messages — including a delivery reconciled after the window closed and
	 * an open that arrived days later. Both belong to the send being measured.
	 */
	const rows = ctx.storage.sql
		.exec(
			`SELECT de.email_id AS email_id, de.event_type AS event_type,
			        de.error_cause AS error_cause, de.occurred_at AS occurred_at
			   FROM delivery_events de
			   JOIN emails e ON e.id = de.email_id
			  WHERE e.date >= ?1 AND e.date <= ?2`,
			window.start,
			window.end,
		)
		.toArray() as unknown as {
		email_id: string;
		event_type: string;
		error_cause: string | null;
		occurred_at: string;
	}[];

	const opened = new Set<string>();
	const clicked = new Set<string>();
	// Terminal events per message, collapsed below by `latestTerminalStatus`.
	const terminalByEmail = new Map<
		string,
		{ event_type: string; occurred_at: string; error_cause: string | null }[]
	>();

	for (const row of rows) {
		if (!cohort.has(row.email_id)) continue;
		switch (row.event_type) {
			case "opened":
				opened.add(row.email_id);
				break;
			case "clicked":
				clicked.add(row.email_id);
				break;
			case "delivered":
			case "bounced":
			case "rejected":
			case "failed":
			case "complained": {
				const list = terminalByEmail.get(row.email_id) ?? [];
				list.push(row);
				terminalByEmail.set(row.email_id, list);
				break;
			}
		}
	}

	let delivered = 0;
	let failed = 0;
	let failedInternal = 0;
	let failedRecipient = 0;

	for (const events of terminalByEmail.values()) {
		// Same collapse rule as the reading pane, including its equal-timestamp
		// tie-break, so the panel and the message never disagree.
		const status = latestTerminalStatus(events);
		if (status === "delivered") {
			delivered += 1;
			continue;
		}
		if (status !== "failed") continue;

		failed += 1;
		// Attribute using the WINNING event only. Summing every failure's cause
		// would let a retry whose attribution changed land in both buckets.
		let winner: (typeof events)[number] | null = null;
		for (const event of events) {
			if (event.event_type === "delivered") continue;
			if (winner === null || event.occurred_at >= winner.occurred_at) {
				winner = event;
			}
		}
		if (winner?.error_cause === "internal") failedInternal += 1;
		else if (winner?.error_cause === "recipient") failedRecipient += 1;
	}

	return {
		sent: cohort.size,
		delivered,
		failed,
		opened: opened.size,
		clicked: clicked.size,
		failedInternal,
		failedRecipient,
	};
}

/**
 * The bare address, lowercased, for comparing a reported recipient against the
 * ones a message carried.
 *
 * Both sides are compared this way because they are written by different
 * systems: our own header may hold `Ada Lovelace <ada@example.com>` while a
 * remote report gives `rfc822; ada@EXAMPLE.com`. Domains are case-insensitive
 * and in practice so are local parts, so folding both is what makes a genuine
 * bounce match.
 */
function normalizeAddress(value: string | null | undefined): string | null {
	if (!value) return null;
	const angled = value.match(/<([^>]*)>/);
	const bare = (angled ? angled[1] : value).trim().toLowerCase();
	return bare === "" ? null : bare;
}

interface ScheduledEmailRow {
	id: string;
	subject: string | null;
	sender: string;
	recipient: string;
	cc: string | null;
	bcc: string | null;
	body: string | null;
	message_id: string | null;
	thread_id?: string | null;
	in_reply_to: string | null;
	email_references: string | null;
	raw_headers: string | null;
	/** Captured at queue time for open/click tracking (migration 28). */
	tracking_base_url?: string | null;
	tracking_mailbox_id?: string | null;
	/** 0 when the sender switched tracking off for this message. */
	track?: number | null;
}

/**
 * Recover the original `From`, display name included.
 *
 * `emails.sender` holds a bare address, so a message from an identity like
 * "Ada Lovelace <ada@example.com>" would otherwise be delivered as plain
 * `ada@example.com`. The send routes record the full header in `raw_headers`, so
 * read the name back out of it.
 *
 * Returns the structured `{ email, name }` form rather than a formatted string:
 * a `from` string is interpreted elsewhere as a bare address, so handing back
 * "Name <addr>" would be a different thing entirely.
 */
export function senderWithDisplayName(
	email: Pick<ScheduledEmailRow, "sender" | "raw_headers">,
): string | { email: string; name: string } {
	if (!email.raw_headers) return email.sender;

	let from: string | undefined;
	try {
		const headers = JSON.parse(email.raw_headers) as {
			key?: string;
			value?: string;
		}[];
		if (!Array.isArray(headers)) return email.sender;
		from = headers.find((h) => h?.key?.toLowerCase() === "from")?.value;
	} catch {
		return email.sender;
	}
	if (!from) return email.sender;

	const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
	if (!match) return email.sender;

	// Display names may be quoted per RFC 5322 §3.4.
	const name = match[1].replace(/^"(.*)"$/, "$1").trim();
	const address = match[2].trim();
	if (!address) return email.sender;
	// "undefined <addr>" is what a missing name used to serialise to; treat any
	// nameless header as a bare address rather than sending the literal.
	if (!name || name === "undefined") return address;

	return { email: address, name };
}

/** Send one scheduled message, rehydrating its attachments from R2. */
async function deliverScheduledEmail(
	ctx: DurableObjectState,
	env: Env,
	email: ScheduledEmailRow,
): Promise<void> {
	const recipients = splitAddressList(email.recipient);
	if (recipients.length === 0) throw new Error("scheduled email has no recipient");

	const attachmentRows = ctx.storage.sql
		.exec(
			`SELECT id, filename, mimetype, content_id, disposition
			 FROM attachments WHERE email_id = ?`,
			email.id,
		)
		.toArray() as unknown as {
		id: string;
		filename: string;
		mimetype: string;
		content_id: string | null;
		disposition: string | null;
	}[];

	const attachments: {
		content: string;
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
		contentId?: string;
	}[] = [];

	for (const att of attachmentRows) {
		/**
		 * Re-checked at delivery, not only when the message was composed.
		 *
		 * The send schema refuses these at the edge, but a message queued *before*
		 * that check existed is still sitting in this table waiting for its alarm —
		 * and Undo Send means every ordinary send passes through here. Validating
		 * only on the way in would let the backlog out.
		 *
		 * Skipped rather than failing the message: the recipient gets the mail
		 * without the part, which is better than a send that never completes and
		 * retries twice more. See `shared/attachment-types.ts`.
		 */
		if (isBlockedAttachment(att.filename)) {
			console.warn(
				`scheduled send: refusing blocked attachment ${att.filename} on ${email.id}`,
			);
			continue;
		}

		const key = attachmentKey(email.id, att.id, att.filename);
		const object = await env.BUCKET.get(key);
		if (!object) {
			// Missing blob: send what we can rather than failing the whole message.
			console.error(`scheduled send: attachment blob missing for ${key}`);
			continue;
		}
		attachments.push({
			content: toBase64(new Uint8Array(await object.arrayBuffer())),
			filename: att.filename,
			type: att.mimetype,
			disposition: att.disposition === "inline" ? "inline" : "attachment",
			...(att.content_id ? { contentId: att.content_id } : {}),
		});
	}

	const cc = splitAddressList(email.cc);
	const bcc = splitAddressList(email.bcc);

	/**
	 * Open/click tracking, applied HERE and only here.
	 *
	 * Every UI send passes through this function (the undo window is a short
	 * schedule), so this is the single final send for them. The stored row keeps
	 * the clean body; only the copy handed to the provider is instrumented, and
	 * `injectTracking` strips any earlier pixel first, so a body that somehow
	 * arrived instrumented still leaves with exactly one.
	 */
	const mailboxId =
		email.tracking_mailbox_id ??
		((ctx.id as { name?: string } | undefined)?.name?.toLowerCase() || null);
	const html = mailboxId
		? await trackOutgoingHtml({
				stub: {
					getTrackingSettings: async () => getTrackingSettings(ctx),
					getOrCreateTrackingSecret: async () => getOrCreateTrackingSecret(ctx),
				},
				mailboxId,
				emailId: email.id,
				html: email.body ?? "",
				baseUrl: await trackingBaseUrl(env, email.tracking_base_url),
				to: recipients,
				cc,
				bcc,
				attachments,
				track: email.track !== null && email.track !== undefined && Number(email.track) === 0 ? false : null,
				optOuts: trackingOptOutStore(env),
				fromAddress: email.sender,
			})
		: email.body ?? "";

	/**
	 * The shared pre-send gate, transactional semantics, at DELIVERY time: an
	 * address that hard-bounced or complained since the message was queued is
	 * dropped (and the message refused if nobody is left). The quota was already
	 * checked by the caller (`processDueScheduledSends` / `sendScheduledSendNow`).
	 * A refusal throws, so the retry/give-up bookkeeping applies.
	 */
	const extraHeaders = buildHeaders(email);
	const gate = await preSendOrThrow(env, {
		kind: "transactional",
		from: email.sender ?? mailboxId ?? "",
		mailboxId,
		to: recipients,
		cc,
		bcc,
		html: html ?? "",
		attachments,
		headers: extraHeaders?.headers,
		quotaChecked: true,
	});

	const { messageId: providerMessageId } = await sendEmail(env.EMAIL, {
		to: gate.to,
		from: senderWithDisplayName(email),
		subject: email.subject ?? "(no subject)",
		html: html ?? "",
		...(gate.cc.length > 0 ? { cc: gate.cc } : {}),
		...(gate.bcc.length > 0 ? { bcc: gate.bcc } : {}),
		...(attachments.length > 0 ? { attachments } : {}),
		...(extraHeaders ?? {}),
	}, gate.clearance);

	// The row was written when the send was SCHEDULED, carrying an id we minted
	// then. Only now does the real id exist, so record it — otherwise a reply to a
	// scheduled message cites an id `findThreadByMessageIds` has never seen.
	//
	// Called directly rather than through the route helper: this runs inside the
	// Durable Object, so it already has the storage context.
	recordDelivery(ctx, email.id, { providerMessageId });
}

/**
 * Headers for a scheduled send, rebuilt from the stored row.
 *
 * Delegates the formatting to `buildOutgoingHeaders` so every send path in the
 * app brackets and names these fields identically. The extra work here is
 * reading them back out of a row: `email_references` is written as a JSON array
 * by the send routes, but a pre-existing raw value is tolerated rather than
 * dropped, since losing the chain silently splits a thread.
 */
function buildHeaders(
	email: ScheduledEmailRow,
): { headers: Record<string, string> } | null {
	let references: string[] = [];
	let rawReferences: string | null = null;

	if (email.email_references) {
		try {
			const refs = JSON.parse(email.email_references) as string[];
			if (Array.isArray(refs)) references = refs.filter(Boolean);
		} catch {
			rawReferences = email.email_references;
		}
	}

	/*
	 * The `Sender:` read-back that used to live here is GONE, along with the route
	 * that persisted it.
	 *
	 * It existed so the cron dispatcher — which runs with no caller attached and
	 * cannot resolve attribution itself — could put an on-behalf-of header on a
	 * scheduled send. Email Service does not allowlist `Sender` and rejects the
	 * entire message for it, so that header was one of the two reasons nothing was
	 * being delivered at all.
	 *
	 * Attribution is not lost: the audit log records who sent from whose mailbox
	 * (`mail.send` with `attribution`). That is a record of who acted, which is
	 * what an auditor needs, rather than a claim about what was transmitted.
	 */

	// Threading headers only. The row's own `message_id` is deliberately NOT sent:
	// Email Service generates `Message-ID` itself and rejects any attempt to set
	// one, failing the entire message. The stored id is now a record of what the
	// provider assigned, not an instruction to it.
	//
	// The `message_id`-present / absent branch that used to live here is gone with
	// it — both cases produce the same headers now, so a single call is the whole
	// behaviour.
	const headers = buildOutgoingHeaders({
		inReplyTo: email.in_reply_to,
		references,
	});

	// Already bracketed by whoever wrote it, so it is passed through verbatim.
	if (rawReferences) headers.References = rawReferences;

	return Object.keys(headers).length > 0 ? { headers } : null;
}

// ── Blocked senders ────────────────────────────────────────────────

/**
 * The two sender lists share a schema, a `pattern` grammar and every operation,
 * so they share an implementation too. Blocking sends a sender's mail to Spam;
 * allowing exempts it from heuristic spam scoring.
 *
 * The table name is interpolated into the SQL, which is safe only because this
 * type admits exactly two literals — never a caller-supplied string.
 */
type SenderListTable = "blocked_senders" | "allowed_senders";

/**
 * The patterns that would match an address: the address itself and its domain
 * suffix. Both list types use the same grammar, so both match the same way.
 */
function matchPatternsFor(senderAddress: string): string[] {
	const address = senderAddress.trim().toLowerCase();
	if (!address) return [];
	const atIndex = address.lastIndexOf("@");
	return atIndex >= 0 ? [address, address.slice(atIndex)] : [address];
}

function listSenders(
	ctx: DurableObjectState,
	table: SenderListTable,
): BlockedSenderRow[] {
	return ctx.storage.sql
		.exec(
			`SELECT id, pattern, reason, created_at FROM ${table} ORDER BY pattern ASC`,
		)
		.toArray() as unknown as BlockedSenderRow[];
}

function addSender(
	ctx: DurableObjectState,
	table: SenderListTable,
	pattern: string,
	reason: string | null,
): { id: string; pattern: string; reason: string | null } | null {
	const normalized = pattern.trim().toLowerCase();
	if (!normalized) return null;

	const id = crypto.randomUUID();
	try {
		ctx.storage.sql.exec(
			`INSERT INTO ${table} (id, pattern, reason) VALUES (?, ?, ?)`,
			id,
			normalized,
			reason,
		);
	} catch (e) {
		if (isUniqueViolation(e)) return null;
		throw e;
	}
	return { id, pattern: normalized, reason };
}

function removeSender(
	ctx: DurableObjectState,
	table: SenderListTable,
	id: string,
): boolean {
	if (!rowExists(ctx, table, id)) return false;
	ctx.storage.sql.exec(`DELETE FROM ${table} WHERE id = ?`, id);
	return true;
}

function senderListed(
	ctx: DurableObjectState,
	table: SenderListTable,
	senderAddress: string,
): boolean {
	const patterns = matchPatternsFor(senderAddress);
	if (patterns.length === 0) return false;

	return (
		ctx.storage.sql
			.exec(
				`SELECT 1 FROM ${table}
				 WHERE pattern = ?1 OR (?2 != '' AND pattern = ?2)
				 LIMIT 1`,
				patterns[0],
				patterns[1] ?? "",
			)
			.toArray().length > 0
	);
}

/**
 * Drop every rule in `table` that matches `senderAddress`, returning the
 * patterns removed.
 *
 * Needed because the user-facing gesture is about a sender, not a rule id:
 * "Not spam" has an address in hand and no idea whether the rule that caught it
 * was the exact address or a domain-wide block. Deleting by id could only ever
 * clear one of those, which is why marking something not-spam used to leave it
 * blocked and the next message went straight back to Spam.
 */
function removeSendersMatching(
	ctx: DurableObjectState,
	table: SenderListTable,
	senderAddress: string,
): string[] {
	const patterns = matchPatternsFor(senderAddress);
	if (patterns.length === 0) return [];

	const removed = ctx.storage.sql
		.exec(
			`DELETE FROM ${table}
			 WHERE pattern = ?1 OR (?2 != '' AND pattern = ?2)
			 RETURNING pattern`,
			patterns[0],
			patterns[1] ?? "",
		)
		.toArray() as unknown as { pattern: string }[];

	return removed.map((row) => row.pattern);
}

export function getBlockedSenders(ctx: DurableObjectState): BlockedSenderRow[] {
	return listSenders(ctx, "blocked_senders");
}

/** `pattern` is a full address or a bare domain suffix such as "@spam.com". */
export function blockSender(
	ctx: DurableObjectState,
	pattern: string,
	reason: string | null = null,
): { id: string; pattern: string; reason: string | null } | null {
	return addSender(ctx, "blocked_senders", pattern, reason);
}

export function unblockSender(ctx: DurableObjectState, id: string): boolean {
	return removeSender(ctx, "blocked_senders", id);
}

/** Clear every block rule matching an address. Returns the patterns removed. */
export function unblockSenderMatching(
	ctx: DurableObjectState,
	senderAddress: string,
): string[] {
	return removeSendersMatching(ctx, "blocked_senders", senderAddress);
}

/**
 * True when a sender matches a block rule: an exact address match, or a rule
 * stored as a domain suffix ("@example.com").
 */
export function isSenderBlocked(
	ctx: DurableObjectState,
	senderAddress: string,
): boolean {
	return senderListed(ctx, "blocked_senders", senderAddress);
}

export function getAllowedSenders(ctx: DurableObjectState): BlockedSenderRow[] {
	return listSenders(ctx, "allowed_senders");
}

/** Exempt a sender from heuristic spam scoring. Same pattern grammar as blocks. */
export function allowSender(
	ctx: DurableObjectState,
	pattern: string,
	reason: string | null = null,
): { id: string; pattern: string; reason: string | null } | null {
	return addSender(ctx, "allowed_senders", pattern, reason);
}

export function disallowSender(ctx: DurableObjectState, id: string): boolean {
	return removeSender(ctx, "allowed_senders", id);
}

/** True when a sender is on the allowlist, by address or by domain suffix. */
export function isSenderAllowed(
	ctx: DurableObjectState,
	senderAddress: string,
): boolean {
	return senderListed(ctx, "allowed_senders", senderAddress);
}

/**
 * Whether this mailbox has ever sent mail to an address.
 *
 * A ham signal for spam scoring: someone the user has written to is someone they
 * want to hear from.
 *
 * `recipient` holds a comma-joined list, so this has to match one entry within
 * it rather than the whole column. Two details do the work:
 *
 *   - Spaces are stripped and the list is wrapped in delimiters before
 *     comparing, so it does not matter whether entries were joined with ", " or
 *     "," — outbound sends join with the former, but a caller passing `to` as a
 *     bare comma-separated string produces the latter.
 *   - `instr` rather than `LIKE`, because an email address is not a safe LIKE
 *     pattern: `_` is legal in a local part and matches any character, so
 *     `a_b@x.example` would be satisfied by `axb@x.example`.
 */
export function hasSentTo(
	ctx: DurableObjectState,
	address: string,
): boolean {
	const needle = address.trim().toLowerCase();
	if (!needle) return false;

	return (
		ctx.storage.sql
			.exec(
				`SELECT 1 FROM emails
				  WHERE folder_id = ?1
				    AND instr(
				          ',' || REPLACE(LOWER(recipient), ' ', '') || ',',
				          ',' || ?2 || ','
				        ) > 0
				  LIMIT 1`,
				Folders.SENT,
				needle,
			)
			.toArray().length > 0
	);
}

/**
 * Whether a message from `address` is already stored, outside Spam.
 *
 * Spam is excluded so a spammer's second message is not "someone you have
 * heard from". `sender` is stored lowercased, so this is an index-friendly
 * equality, not a scan of recipients.
 */
export function hasReceivedFrom(ctx: DurableObjectState, address: string): boolean {
	const needle = address.trim().toLowerCase();
	if (!needle) return false;
	return (
		ctx.storage.sql
			.exec(
				`SELECT 1 FROM emails WHERE sender = ?1 AND folder_id NOT IN (?2, ?3, ?4) LIMIT 1`,
				needle,
				Folders.SPAM,
				Folders.SENT,
				Folders.DRAFT,
			)
			.toArray().length > 0
	);
}

/** Most correspondents `frequentCorrespondents` returns. */
export const FREQUENT_CORRESPONDENT_LIMIT = 200;

export interface FrequentCorrespondent {
	address: string;
	name: string | null;
	count: number;
}

/**
 * The people this mailbox hears from most, with the display name they use.
 *
 * Feeds two warnings: a lookalike of a frequent correspondent's domain, and
 * their display name arriving from a different address. Only senders seen at
 * least twice outside Spam count, so one stray message does not make a
 * stranger's name "known". Bounded, because it runs on every delivery.
 */
export function frequentCorrespondents(ctx: DurableObjectState): FrequentCorrespondent[] {
	const rows = ctx.storage.sql
		.exec(
			`SELECT sender AS address,
			        MAX(CASE WHEN sender_name IS NOT NULL AND sender_name != '' THEN sender_name END) AS name,
			        COUNT(*) AS count
			   FROM emails
			  WHERE folder_id NOT IN (?1, ?2, ?3) AND sender LIKE '%@%'
			  GROUP BY sender
			 HAVING COUNT(*) >= 2
			  ORDER BY count DESC
			  LIMIT ?4`,
			Folders.SPAM,
			Folders.SENT,
			Folders.DRAFT,
			FREQUENT_CORRESPONDENT_LIMIT,
		)
		.toArray() as unknown as FrequentCorrespondent[];
	return rows.map((r) => ({ address: String(r.address), name: r.name ? String(r.name) : null, count: Number(r.count) }));
}

export interface NotSpamResult {
	/** Where the message went. */
	folder: string;
	/** Block patterns that were cleared, if any. */
	unblocked: string[];
	/** The sender added to the allowlist, or null when it was already listed. */
	allowed: string | null;
}

/**
 * Undo a spam verdict for one message, and stop it recurring.
 *
 * Moving the message back is the easy part and was all this used to do — which
 * meant the very next message from that sender was filed to Spam again, because
 * neither the block rule that caught it nor the heuristics that scored it had
 * changed. Three things have to happen together:
 *
 *   - the message moves to the inbox and its score is cleared, so nothing
 *     downstream still describes it as spam;
 *   - any block rule matching the sender is dropped;
 *   - the sender joins the allowlist, exempting them from future scoring.
 *
 * Returns null when the id is unknown, so the caller can 404 rather than
 * reporting success for a message that does not exist.
 */
export function markNotSpam(
	ctx: DurableObjectState,
	emailId: string,
): NotSpamResult | null {
	const row = ctx.storage.sql
		.exec(`SELECT sender FROM emails WHERE id = ?`, emailId)
		.toArray()[0] as { sender: string | null } | undefined;
	if (!row) return null;

	const sender = (row.sender ?? "").trim().toLowerCase();
	let unblocked: string[] = [];
	let allowed: string | null = null;

	ctx.storage.transactionSync(() => {
		ctx.storage.sql.exec(
			`UPDATE emails
			    SET folder_id = ?, spam_score = NULL, spam_signals = NULL
			  WHERE id = ?`,
			Folders.INBOX,
			emailId,
		);

		if (sender) {
			unblocked = removeSendersMatching(ctx, "blocked_senders", sender);
			// `addSender` returns null when the pattern is already listed, which is
			// not a failure here — the sender ending up allowlisted is the goal,
			// not this call being the one that put them there.
			allowed = addSender(ctx, "allowed_senders", sender, "Marked not spam")
				? sender
				: null;
		}
	});

	return { folder: Folders.INBOX, unblocked, allowed };
}

// ── Alarm scheduling ───────────────────────────────────────────────

/**
 * Earliest outstanding deadline across snoozes, scheduled sends and follow-up
 * reminders, or null when there is nothing pending.
 */
export function nextDeadline(ctx: DurableObjectState): number | null {
	const row = ctx.storage.sql
		.exec(
			`SELECT MIN(next_at) AS next_at FROM (
				SELECT MIN(snoozed_until) AS next_at FROM emails
					WHERE folder_id = ?1 AND snoozed_until IS NOT NULL
				UNION ALL
				SELECT MIN(send_at) AS next_at FROM scheduled_sends
					WHERE status = 'pending'
				UNION ALL
				SELECT MIN(followup_at) AS next_at FROM followups
					WHERE status = 'pending'
			)`,
			Folders.SNOOZED,
		)
		.toArray()[0] as { next_at: string | null } | undefined;

	const nextAt = row?.next_at;
	const parsed = nextAt ? Date.parse(nextAt) : null;
	if (nextAt && Number.isNaN(parsed)) {
		console.error("nextDeadline: unparseable timestamp", nextAt);
	}
	const fixed = parsed !== null && !Number.isNaN(parsed) ? parsed : null;
	const summaries = summaryDeadline(ctx);
	if (fixed === null) return summaries;
	if (summaries === null) return fixed;
	return Math.min(fixed, summaries);
}

/**
 * Point the alarm at the earliest pending deadline.
 *
 * A Durable Object has a single alarm, so snooze, scheduled send and follow-up
 * reminders share it.
 * An existing alarm is only replaced when the new deadline is strictly earlier,
 * so a far-future snooze cannot push back an imminent send.
 */
export async function scheduleNextAlarm(ctx: DurableObjectState): Promise<void> {
	const target = nextDeadline(ctx);
	if (target === null) return;

	// Never schedule in the past: the runtime would fire it immediately, looping.
	const when = Math.max(target, Date.now() + 1000);
	const existing = await ctx.storage.getAlarm();
	if (existing === null || when < existing) {
		await ctx.storage.setAlarm(when);
	}
}

// ── Helpers ────────────────────────────────────────────────────────

function isUniqueViolation(e: unknown): boolean {
	return e instanceof Error && e.message.includes("UNIQUE constraint failed");
}

/**
 * Resolve which of `labelIds` actually exist, in a single query.
 *
 * Called with a caller-supplied list (the API caps it at 50), so checking each
 * id separately would issue one statement per id. Duplicates are collapsed
 * first, which also keeps the returned list free of repeats.
 *
 * Order is preserved: label assignment is not order-sensitive today, but a
 * stable result keeps the behaviour predictable for callers and tests.
 */
function existingLabelIds(
	ctx: DurableObjectState,
	labelIds: string[],
): string[] {
	// An empty IN () list is a syntax error in SQLite, so short-circuit.
	if (labelIds.length === 0) return [];

	const unique = [...new Set(labelIds)];
	const placeholders = unique.map((_, i) => `?${i + 1}`).join(", ");

	const found = new Set(
		(
			ctx.storage.sql
				.exec(
					`SELECT id FROM labels WHERE id IN (${placeholders})`,
					...unique,
				)
				.toArray() as { id: string }[]
		).map((row) => row.id),
	);

	return unique.filter((id) => found.has(id));
}

/**
 * Existence check by primary key. The table name is never caller-supplied —
 * every call site passes a literal — so it is safe to interpolate.
 */
function rowExists(
	ctx: DurableObjectState,
	table:
		| "emails"
		| "labels"
		| "signatures"
		| "blocked_senders"
		| "allowed_senders",
	id: string,
): boolean {
	return (
		ctx.storage.sql.exec(`SELECT 1 FROM ${table} WHERE id = ?`, id).toArray()
			.length > 0
	);
}

function splitAddressList(value: string | null): string[] {
	return (value ?? "")
		.split(",")
		.map((v) => v.trim())
		.filter(Boolean);
}

/**
 * Base64-encode bytes in chunks.
 *
 * `btoa(String.fromCharCode(...bytes))` exceeds the spread argument limit on
 * anything larger than a few hundred kilobytes, which attachments routinely are.
 */
export function toBase64(bytes: Uint8Array): string {
	const CHUNK = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}
