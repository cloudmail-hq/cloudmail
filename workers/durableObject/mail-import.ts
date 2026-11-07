// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Mail import, the mailbox side: the job table, dedupe, threading and the
 * insert (migration 43_add_mail_import).
 *
 * ## The ingest path, and what it never does
 *
 * Inbound mail runs through `receiveEmail` (workers/index.ts), whose tail
 * forwards, auto-replies, emits `message.received` webhooks and events,
 * queues triage and summaries, correlates bounces, stops sequences on reply
 * and resets follow-ups. Imported mail is years-old history: none of that may
 * happen. So it does not go through that function, nor through
 * `MailboxDO.createEmail` (which resets follow-ups and queues summaries).
 * `insertImported` writes the row itself, with `imported = 1`, and nothing
 * else. Readers that would notify or count sends skip `imported = 1` rows: the
 * unread poll behind desktop notifications, the hourly/daily send cap,
 * analytics and the daily brief.
 *
 * Plain functions over `DurableObjectState`, so tests run the real SQL on
 * `node:sqlite`.
 */

import { Folders } from "../../shared/folders";
import {
	isTerminalImportStatus,
	type ImportJobView,
	type ImportSource,
	type ImportStatus,
} from "../../shared/mail-import";
import * as derived from "./derived";
import { findThreadByMessageIds } from "./references";
import type { StoredAttachment } from "../lib/attachments";

// ── Jobs ────────────────────────────────────────────────────────────

/** A job row as stored. `parts` and `state` are JSON. */
export interface ImportJobRow {
	id: string;
	source: ImportSource;
	status: ImportStatus;
	label: string;
	mailbox: string | null;
	r2_key: string | null;
	upload_id: string | null;
	part_size: number | null;
	parts: string | null;
	parts_total: number | null;
	size_bytes: number | null;
	cursor: number;
	state: string | null;
	imported: number;
	duplicates: number;
	failed: number;
	skipped: number;
	total_messages: number | null;
	last_error: string | null;
	imap_host: string | null;
	imap_username: string | null;
	options: string | null;
	created_at: string;
	updated_at: string;
	started_at: string | null;
	finished_at: string | null;
}

export interface UploadedPart {
	n: number;
	etag: string;
	size: number;
}

/** Most jobs a mailbox keeps; older finished ones are dropped on create. */
export const MAX_KEPT_JOBS = 50;
/** Concurrent unfinished jobs per mailbox. */
export const MAX_ACTIVE_JOBS = 3;

export interface CreateJobInput {
	id: string;
	source: ImportSource;
	status: ImportStatus;
	label: string;
	mailbox: string;
	r2Key?: string | null;
	uploadId?: string | null;
	partSize?: number | null;
	partsTotal?: number | null;
	sizeBytes?: number | null;
	imapHost?: string | null;
	imapUsername?: string | null;
	options?: Record<string, unknown> | null;
	now?: Date;
}

export function activeJobCount(ctx: DurableObjectState): number {
	const row = ctx.storage.sql
		.exec(`SELECT COUNT(*) AS n FROM import_jobs WHERE status NOT IN ('completed', 'failed', 'cancelled')`)
		.toArray()[0] as { n: number } | undefined;
	return Number(row?.n ?? 0);
}

export function createJob(ctx: DurableObjectState, input: CreateJobInput): ImportJobRow {
	const now = (input.now ?? new Date()).toISOString();
	ctx.storage.sql.exec(
		`INSERT INTO import_jobs (id, source, status, label, mailbox, r2_key, upload_id, part_size, parts, parts_total,
		                          size_bytes, imap_host, imap_username, options, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '[]', ?9, ?10, ?11, ?12, ?13, ?14, ?14)`,
		input.id,
		input.source,
		input.status,
		input.label,
		input.mailbox,
		input.r2Key ?? null,
		input.uploadId ?? null,
		input.partSize ?? null,
		input.partsTotal ?? null,
		input.sizeBytes ?? null,
		input.imapHost ?? null,
		input.imapUsername ?? null,
		input.options ? JSON.stringify(input.options) : null,
		now,
	);
	// Keep history bounded: drop the oldest finished jobs past the cap.
	ctx.storage.sql.exec(
		`DELETE FROM import_jobs
		  WHERE status IN ('completed', 'failed', 'cancelled')
		    AND id NOT IN (SELECT id FROM import_jobs ORDER BY created_at DESC, id DESC LIMIT ?1)`,
		MAX_KEPT_JOBS,
	);
	return getJob(ctx, input.id)!;
}

export function getJob(ctx: DurableObjectState, id: string): ImportJobRow | null {
	return (ctx.storage.sql.exec(`SELECT * FROM import_jobs WHERE id = ?`, id).toArray()[0] as unknown as ImportJobRow) ?? null;
}

export function listJobs(ctx: DurableObjectState, limit = 20): ImportJobRow[] {
	return ctx.storage.sql
		.exec(`SELECT * FROM import_jobs ORDER BY created_at DESC, id DESC LIMIT ?`, limit)
		.toArray() as unknown as ImportJobRow[];
}

/** The job the alarm should work on: the oldest queued or running one. */
export function nextRunnableJob(ctx: DurableObjectState): ImportJobRow | null {
	return (
		(ctx.storage.sql
			.exec(
				`SELECT * FROM import_jobs WHERE status IN ('queued', 'running')
				  ORDER BY created_at ASC, id ASC LIMIT 1`,
			)
			.toArray()[0] as unknown as ImportJobRow) ?? null
	);
}

export function hasRunnableJob(ctx: DurableObjectState): boolean {
	try {
		return (
			ctx.storage.sql.exec(`SELECT 1 AS n FROM import_jobs WHERE status IN ('queued', 'running') LIMIT 1`).toArray()
				.length > 0
		);
	} catch {
		return false;
	}
}

export function parseParts(row: Pick<ImportJobRow, "parts">): UploadedPart[] {
	try {
		const parsed = JSON.parse(row.parts ?? "[]");
		return Array.isArray(parsed) ? (parsed as UploadedPart[]) : [];
	} catch {
		return [];
	}
}

/** Record one uploaded part (replacing a re-upload of the same number). */
export function recordPart(ctx: DurableObjectState, id: string, part: UploadedPart, now = new Date()): ImportJobRow | null {
	const row = getJob(ctx, id);
	if (!row || row.status !== "uploading") return null;
	const parts = parseParts(row).filter((p) => p.n !== part.n);
	parts.push(part);
	parts.sort((a, b) => a.n - b.n);
	ctx.storage.sql.exec(
		`UPDATE import_jobs SET parts = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'uploading'`,
		id,
		JSON.stringify(parts),
		now.toISOString(),
	);
	return getJob(ctx, id);
}

export interface JobPatch {
	status?: ImportStatus;
	cursor?: number;
	state?: unknown;
	sizeBytes?: number | null;
	totalMessages?: number | null;
	lastError?: string | null;
	uploadId?: string | null;
	/** Added to the counters. */
	add?: Partial<Record<"imported" | "duplicates" | "failed" | "skipped", number>>;
	now?: Date;
}

/**
 * Update a job. Never revives a terminal job, and never overwrites a status a
 * person set while a step was running (pause/cancel win): `status` is only
 * applied when the row is still `queued` or `running`, unless `force`.
 */
export function patchJob(ctx: DurableObjectState, id: string, patch: JobPatch, force = false): ImportJobRow | null {
	const row = getJob(ctx, id);
	if (!row) return null;
	if (isTerminalImportStatus(row.status) && !force) return row;
	const now = (patch.now ?? new Date()).toISOString();
	const sets: string[] = ["updated_at = ?2"];
	const args: unknown[] = [id, now];
	const push = (sql: string, value: unknown) => {
		args.push(value);
		sets.push(`${sql} = ?${args.length}`);
	};
	if (patch.cursor !== undefined) push("cursor", patch.cursor);
	if (patch.state !== undefined) push("state", patch.state === null ? null : JSON.stringify(patch.state));
	if (patch.sizeBytes !== undefined) push("size_bytes", patch.sizeBytes);
	if (patch.totalMessages !== undefined) push("total_messages", patch.totalMessages);
	if (patch.lastError !== undefined) push("last_error", patch.lastError === null ? null : patch.lastError.slice(0, 500));
	if (patch.uploadId !== undefined) push("upload_id", patch.uploadId);
	for (const key of ["imported", "duplicates", "failed", "skipped"] as const) {
		const n = patch.add?.[key];
		if (n) sets.push(`${key} = ${key} + ${Math.trunc(n)}`);
	}
	const statusAllowed = force || row.status === "queued" || row.status === "running" || row.status === "uploading";
	if (patch.status && statusAllowed) {
		push("status", patch.status);
		if (patch.status === "running" && !row.started_at) push("started_at", now);
		if (isTerminalImportStatus(patch.status)) push("finished_at", now);
	}
	ctx.storage.sql.exec(`UPDATE import_jobs SET ${sets.join(", ")} WHERE id = ?1`, ...args);
	return getJob(ctx, id);
}

/** Pause, resume or cancel. Returns the job, or an error message for a refused transition. */
export function transitionJob(
	ctx: DurableObjectState,
	id: string,
	action: "pause" | "resume" | "cancel",
	now = new Date(),
): { job: ImportJobRow } | { error: string; status: 404 | 409 } {
	const row = getJob(ctx, id);
	if (!row) return { error: "Import not found", status: 404 };
	const allowed: Record<typeof action, ImportStatus[]> = {
		pause: ["queued", "running"],
		resume: ["paused"],
		cancel: ["uploading", "queued", "running", "paused"],
	};
	if (!allowed[action].includes(row.status)) {
		return { error: `This import is ${row.status} and cannot be ${action === "pause" ? "paused" : action === "resume" ? "resumed" : "cancelled"}.`, status: 409 };
	}
	const next: ImportStatus = action === "pause" ? "paused" : action === "resume" ? "queued" : "cancelled";
	patchJob(ctx, id, { status: next, now }, true);
	return { job: getJob(ctx, id)! };
}

function parseState(row: Pick<ImportJobRow, "state">): Record<string, unknown> | null {
	if (!row.state) return null;
	try {
		const v = JSON.parse(row.state);
		return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

export function jobState<T>(row: Pick<ImportJobRow, "state">): T | null {
	return parseState(row) as T | null;
}

/** The API view. Never includes a credential (there is none here to include). */
export function toJobView(row: ImportJobRow): ImportJobView {
	const parts = parseParts(row);
	const isFile = row.source !== "imap";
	const state = parseState(row) as { folders?: { name: string; done?: boolean; total?: number | null; imported?: number }[]; index?: number } | null;
	const folders = state?.folders ?? [];
	const handled = row.imported + row.duplicates + row.failed + row.skipped;
	let progress: ImportJobView["progress"];
	if (row.source === "mbox") {
		progress = { done: Math.min(row.cursor, row.size_bytes ?? row.cursor), total: row.size_bytes, unit: "bytes" };
	} else {
		progress = { done: handled, total: row.total_messages, unit: "messages" };
	}
	return {
		id: row.id,
		source: row.source,
		status: row.status,
		label: row.label,
		created_at: row.created_at,
		updated_at: row.updated_at,
		started_at: row.started_at,
		finished_at: row.finished_at,
		size_bytes: row.size_bytes,
		upload:
			isFile && row.part_size
				? { part_size: row.part_size, parts_uploaded: parts.length, parts_total: row.parts_total ?? 0 }
				: null,
		counts: { imported: row.imported, duplicates: row.duplicates, failed: row.failed, skipped: row.skipped },
		progress,
		last_error: row.last_error,
		imap:
			row.source === "imap"
				? {
						host: row.imap_host ?? "",
						username: row.imap_username ?? "",
						folders_total: folders.length,
						folders_done: folders.filter((f) => f.done).length,
						current_folder: folders.find((f) => !f.done)?.name ?? null,
					}
				: null,
	};
}

// ── Readers that must not see imported mail ─────────────────────────

/**
 * Unread inbox counts for the `/state` poll. The client raises a desktop
 * notification when these grow, so imported mail is left out: an import of
 * 5,000 unread messages must not announce "5,000 new emails".
 */
export function inboxUnreadCounts(ctx: DurableObjectState): { n: number; high: number } {
	const row = ctx.storage.sql
		.exec(
			`SELECT COUNT(*) AS n,
			        SUM(CASE WHEN priority = 'high' THEN 1 ELSE 0 END) AS high
			   FROM emails
			  WHERE folder_id = ?1 AND read = 0 AND imported = 0`,
			Folders.INBOX,
		)
		.toArray()[0] as { n: number; high: number | null } | undefined;
	// SUM over zero rows is NULL, not 0.
	return { n: Number(row?.n ?? 0), high: Number(row?.high ?? 0) };
}

// ── Low-priority indexing ───────────────────────────────────────────

/** Most imported messages one finished job queues for semantic indexing. */
export const IMPORT_SEMANTIC_MAX = 3_000;
/** Folders semantic search never indexes (matches ./semantic.ts). */
const NEVER_INDEXED = ["draft", "scheduled", "trash", "spam", "screener"];

/**
 * Queue a finished import's newest messages for semantic search, as
 * `backfill` work: the queue drains live mail first, paces backfill, and the
 * per-mailbox daily embedding cap bounds it, so an import of 50,000 messages
 * costs no more AI per day than the cap allows and never delays new mail.
 * Nothing is queued when semantic search is not set up (the caller checks).
 * Returns how many were queued.
 */
export function queueImportedForSemantic(
	ctx: DurableObjectState,
	mailbox: string,
	limit = IMPORT_SEMANTIC_MAX,
	now = new Date(),
): number {
	const hasQueue =
		ctx.storage.sql.exec(`SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'semantic_queue'`).toArray()
			.length > 0;
	if (!hasQueue) return 0;
	const excluded = NEVER_INDEXED.map((f) => `'${f}'`).join(", ");
	const rows = ctx.storage.sql
		.exec(
			`SELECT e.id FROM emails e
			  WHERE e.imported = 1 AND e.folder_id NOT IN (${excluded})
			    AND NOT EXISTS (SELECT 1 FROM semantic_index si WHERE si.email_id = e.id)
			    AND NOT EXISTS (SELECT 1 FROM semantic_queue sq WHERE sq.email_id = e.id)
			  ORDER BY e.date DESC
			  LIMIT ?1`,
			limit,
		)
		.toArray() as { id: string }[];
	ctx.storage.transactionSync(() => {
		for (const row of rows) {
			ctx.storage.sql.exec(
				`INSERT OR IGNORE INTO semantic_queue (email_id, mailbox_id, source, enqueued_at, attempts)
				 VALUES (?1, ?2, 'backfill', ?3, 0)`,
				row.id,
				mailbox.trim().toLowerCase(),
				now.toISOString(),
			);
		}
	});
	return rows.length;
}

// ── Dedupe ──────────────────────────────────────────────────────────

/**
 * The mailbox's existing copy of a message, by Message-ID, or by content hash
 * for messages without one.
 *
 * Unlike inbound dedupe (./dedupe.ts), Sent is in scope: an import of a Sent
 * folder must not duplicate mail this app already stored there.
 */
export function findExisting(ctx: DurableObjectState, messageId: string | null, contentHash: string): string | null {
	if (messageId) {
		const row = ctx.storage.sql
			.exec(`SELECT id FROM emails WHERE message_id = ?1 ORDER BY date ASC, id ASC LIMIT 1`, messageId)
			.toArray()[0] as { id: string } | undefined;
		if (row) return row.id;
	}
	const seen = ctx.storage.sql
		.exec(
			`SELECT s.email_id AS id FROM import_seen s JOIN emails e ON e.id = s.email_id WHERE s.content_hash = ?1 LIMIT 1`,
			contentHash,
		)
		.toArray()[0] as { id: string } | undefined;
	return seen?.id ?? null;
}

// ── Threading ───────────────────────────────────────────────────────

/**
 * The thread an imported message joins.
 *
 * Message-ID threading only: the subject fallback inbound mail uses has a
 * 7-day window that means nothing for a 2014 conversation. Imports arrive in
 * any order, so a message whose ancestors are not here yet is keyed on its
 * thread root (`References[0]`), and a root imported after its replies joins
 * the thread they already formed under its own Message-ID.
 */
export function resolveImportThread(
	ctx: DurableObjectState,
	input: { id: string; messageId: string | null; inReplyTo: string | null; references: string[] },
): string {
	// Nearest ancestor first, as `threadCandidates` orders them for inbound mail.
	const candidates: string[] = [];
	for (const id of [input.inReplyTo, ...[...input.references].reverse()]) {
		if (id && !candidates.includes(id)) candidates.push(id);
	}
	if (candidates.length > 0) {
		const local = findThreadByMessageIds(ctx, candidates);
		if (local) return local;
		return input.references[0] || input.inReplyTo || input.messageId || input.id;
	}
	if (input.messageId) {
		const joined = ctx.storage.sql
			.exec(`SELECT thread_id FROM emails WHERE thread_id = ?1 LIMIT 1`, input.messageId)
			.toArray()[0] as { thread_id: string } | undefined;
		if (joined) return joined.thread_id;
	}
	return input.id;
}

// ── Insert ──────────────────────────────────────────────────────────

export interface ImportedMessage {
	id: string;
	folder: "inbox" | "sent" | "archive" | "spam" | "trash";
	subject: string;
	sender: string;
	sender_name: string | null;
	recipient: string;
	cc: string | null;
	bcc: string | null;
	date: string;
	body: string;
	message_id: string | null;
	in_reply_to: string | null;
	references: string[];
	raw_headers: string;
	priority: "high" | "low" | null;
	read: boolean;
	starred: boolean;
	labels: string[];
	contentHash: string;
}

/** Label colours for labels an import creates; the UI's neutral grey. */
const IMPORT_LABEL_COLOR = "#6b7280";

/** Find a label by name (case-insensitive), creating it if missing. */
export function ensureLabel(ctx: DurableObjectState, name: string, cache?: Map<string, string>): string {
	const key = name.toLowerCase();
	const cached = cache?.get(key);
	if (cached) return cached;
	const existing = ctx.storage.sql
		.exec(`SELECT id FROM labels WHERE name = ?1 COLLATE NOCASE LIMIT 1`, name)
		.toArray()[0] as { id: string } | undefined;
	let id = existing?.id;
	if (!id) {
		id = crypto.randomUUID();
		ctx.storage.sql.exec(
			`INSERT OR IGNORE INTO labels (id, name, color, parent_id, sort_order) VALUES (?1, ?2, ?3, NULL, 0)`,
			id,
			name,
			IMPORT_LABEL_COLOR,
		);
		const row = ctx.storage.sql.exec(`SELECT id FROM labels WHERE name = ?1 LIMIT 1`, name).toArray()[0] as
			| { id: string }
			| undefined;
		id = row?.id ?? id;
	}
	cache?.set(key, id);
	return id;
}

/** Apply labels to a message (an existing one, for a duplicate seen in another IMAP folder). */
export function applyImportLabels(ctx: DurableObjectState, emailId: string, labels: string[], cache?: Map<string, string>): void {
	for (const name of labels) {
		const labelId = ensureLabel(ctx, name, cache);
		ctx.storage.sql.exec(
			`INSERT OR IGNORE INTO email_labels (email_id, label_id, source) VALUES (?1, ?2, 'import')`,
			emailId,
			labelId,
		);
	}
}

/**
 * Write one imported message. Returns `duplicate` (with the existing id) when
 * the mailbox already holds it; the caller has not uploaded attachments yet
 * in that case, because it checks `findExisting` first, but this re-checks so
 * the insert itself is the authority.
 *
 * Side effects: the row, its attachment rows, labels, and the content hash.
 * The FTS and mailbox_state triggers run as for any insert. Nothing else.
 */
export function insertImported(
	ctx: DurableObjectState,
	msg: ImportedMessage,
	attachments: StoredAttachment[],
	labelCache?: Map<string, string>,
): { outcome: "imported"; id: string } | { outcome: "duplicate"; id: string } {
	const existing = findExisting(ctx, msg.message_id, msg.contentHash);
	if (existing) return { outcome: "duplicate", id: existing };

	const threadId = resolveImportThread(ctx, {
		id: msg.id,
		messageId: msg.message_id,
		inReplyTo: msg.in_reply_to,
		references: msg.references,
	});
	const cols = derived.deriveColumns({
		body: msg.body,
		sender: msg.sender,
		raw_headers: msg.raw_headers,
		sender_name: msg.sender_name,
	});
	const isSent = msg.folder === Folders.SENT;
	const trashedAt = msg.folder === Folders.TRASH ? new Date().toISOString() : null;

	ctx.storage.transactionSync(() => {
		ctx.storage.sql.exec(
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, cc, bcc, date, read, starred, body,
			                     in_reply_to, email_references, thread_id, message_id, raw_headers, priority,
			                     snippet, sender_name, derived_v, trashed_from, trashed_at, triage_state, imported)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, 'imported', 1)`,
			msg.id,
			msg.folder,
			msg.subject,
			msg.sender,
			msg.recipient,
			msg.cc,
			msg.bcc,
			msg.date,
			isSent || msg.read ? 1 : 0,
			msg.starred ? 1 : 0,
			msg.body,
			msg.in_reply_to,
			msg.references.length > 0 ? JSON.stringify(msg.references) : null,
			threadId,
			msg.message_id,
			msg.raw_headers,
			msg.priority,
			cols.snippet,
			cols.sender_name,
			derived.DERIVED_VERSION,
			// Restoring from the bin sends it to Archive, the safe default.
			msg.folder === Folders.TRASH ? Folders.ARCHIVE : null,
			trashedAt,
		);
		for (const att of attachments) {
			ctx.storage.sql.exec(
				`INSERT INTO attachments (id, email_id, filename, mimetype, size, content_id, disposition, blocked)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
				att.id,
				att.email_id,
				att.filename,
				att.mimetype,
				att.size,
				att.content_id,
				att.disposition,
				att.blocked ? 1 : 0,
			);
		}
		if (!msg.message_id) {
			ctx.storage.sql.exec(
				`INSERT OR IGNORE INTO import_seen (content_hash, email_id) VALUES (?1, ?2)`,
				msg.contentHash,
				msg.id,
			);
		}
		applyImportLabels(ctx, msg.id, msg.labels, labelCache);
	});
	return { outcome: "imported", id: msg.id };
}
