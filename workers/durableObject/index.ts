// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq, and, or, asc, desc, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import {
	canMoveInto,
	canMoveMessageInto,
	Folders,
	isOutboundFrom,
} from "../../shared/folders";
import type { DeliveryEventInput } from "../../shared/delivery-events";
import { parseSearchQuery } from "../../shared/search-query";
import { cleanFtsSnippet } from "../../shared/plain-snippet";
import { searchCountSql, searchListSql } from "./search";
import type { Env } from "../types";
import { applyMigrations, dropAllTables, mailboxMigrations } from "./migrations";
import { attachmentKey } from "../lib/attachments";
import {
	beginIdempotent,
	completeIdempotent,
	releaseIdempotent,
	sweepIdempotencyKeys,
	type IdempotencyBeginInput,
	type IdempotencyBeginResult,
	type IdempotencyCompleteInput,
	type IdempotencyReleaseInput,
} from "../lib/idempotency-store";
import * as features from "./features";
import * as summaries from "./summaries";
import * as semantic from "./semantic";
import { semanticIndex } from "../lib/semantic";
import { collectBriefData } from "./brief-data";
import { getAiConfig } from "../lib/ai-config";
import * as mailImport from "./mail-import";
import { IMPORT_RESCHEDULE_MS, runImportStep } from "../lib/mail-import";
import { connectImap } from "../lib/mail-import-imap";
import { openImportPassword } from "../lib/import-credential-store";
import { authStore } from "../auth/store";
import { authSecret } from "../auth/config";
import * as analytics from "./analytics";
import * as bulk from "./bulk";
import * as trash from "./trash";
import * as dedupe from "./dedupe";
import * as references from "./references";
import * as folders from "./folders";
import * as rateLimit from "./rate-limit";
import * as rules from "./rules";
import * as transfer from "./transfer";
import * as threading from "./threading";
import * as derived from "./derived";
import * as engagement from "./engagement";
import * as followups from "./followups";
import * as retention from "./retention";
import { normalizeRetention, type RetentionPolicy } from "../../shared/privacy";
import * as triage from "./triage";
import { drainTriageQueue, readMailboxSettings } from "../lib/triage";
import { aiAvailable, aiFor, roleEnabled } from "../lib/ai-router";
import { AiWorkBudget } from "../lib/ai-budget";
import { parseStoredMailboxSettings } from "../../shared/mailbox-settings";
import type { TriagePresetKey } from "../../shared/ai-triage";
import { STREAM_CURSOR_KEY, emailSummaryFor, flushLedgerToWebhooks } from "./webhook-events";
import { eventsStub } from "../lib/events";
import * as approvals from "./approvals";
import * as pushQueue from "./push-queue";
import { notifyApproval, notifyFollowups, notifyNewMail } from "../lib/push";
import type { ApprovalStatus } from "../../shared/agent-send-policy";
import { webhookStub } from "../lib/webhooks";
import { WEBHOOK_EVENT_TYPES, buildWebhookPayload, type WebhookEventType } from "../../shared/webhooks";
import {
	ALLOWED_SORT_COLUMNS,
	type ListFilterOptions,
	type SortColumn,
} from "./threading";

/**
 * Most messages `getThreadEmails` returns for one conversation.
 *
 * This call returns full bodies over RPC, so an unbounded thread could exceed
 * the response limit. Well above any thread a person actually reads; it exists
 * so a pathological thread degrades to "the most recent 200" instead of failing.
 *
 * Note the trade-off at the boundary: on a thread longer than this the *oldest*
 * messages drop out, including the root. Better than failing to open it at all,
 * but it is a truncation rather than a paging story.
 */
const MAX_THREAD_MESSAGES = 200;

/**
 * Most `References` entries considered when threading an inbound reply.
 *
 * The header is attacker-controlled and has no length limit, while the lookup
 * binds one parameter per entry. Candidates arrive nearest-ancestor-first, so
 * the tail cannot change the outcome.
 */
const MAX_REFERENCE_CANDIDATES = 20;

/**
 * `participant_names` arrives as SQLite's `json_group_object` text (or NULL
 * when nobody in the conversation had a display name). Returned to callers as
 * an object keyed by address; malformed JSON degrades to "no names".
 */
function parseParticipantNames(raw: unknown): Record<string, string> | undefined {
	if (typeof raw !== "string" || !raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const out: Record<string, string> = {};
		for (const [address, name] of Object.entries(parsed as Record<string, unknown>)) {
			if (address && typeof name === "string" && name) out[address] = name;
		}
		return Object.keys(out).length > 0 ? out : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Map SortColumn string names to Drizzle column references for safe
 * ORDER BY construction (no string interpolation into SQL).
 */
const SORT_COLUMN_MAP = {
	id: schema.emails.id,
	subject: schema.emails.subject,
	sender: schema.emails.sender,
	recipient: schema.emails.recipient,
	date: schema.emails.date,
	read: schema.emails.read,
	starred: schema.emails.starred,
} satisfies Record<SortColumn, typeof schema.emails[keyof typeof schema.emails]>;

/**
 * What a search RPC carries.
 *
 * The flat filter fields (`from`, `subject`, `is_read`, `date_start`, …) are
 * gone: they were the client's parsed operators, one query parameter each, and
 * that shape is what capped the operator set — it had nowhere to put negation,
 * OR or grouping. The raw string now crosses the wire and the worker parses it.
 */
interface SearchFilterOptions {
	query: string;
	/**
	 * Folder to scope to when the query names none.
	 *
	 * Out-of-band because the agent's `search_emails` tool passes a folder
	 * alongside the query rather than inside it. An explicit `in:` in the query
	 * wins.
	 */
	folder?: string;
}

interface GetEmailsOptions extends ListFilterOptions {
	folder?: string;
	thread_id?: string;
	page?: number;
	limit?: number;
	sortColumn?: SortColumn;
	sortDirection?: "ASC" | "DESC";
}

interface EmailData {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	body: string;
	read?: boolean;
	starred?: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	/**
	 * The sender's display name (migration 26). Inbound: from the parsed
	 * `From:`. Outbound: the name the mailbox sends under. When absent,
	 * `createEmail` falls back to whatever `raw_headers` says.
	 */
	sender_name?: string | null;
	/**
	 * Initial delivery state. The HTTP send routes write `"queued"` because the
	 * row exists before the provider is called; `recordDelivery` advances it.
	 * Absent for everything that was not sent by this app.
	 */
	delivery_status?: "queued" | "sent" | null;
	priority?: "high" | "low" | null;
	/** Heuristic spam score at delivery; null when the message was never scored. */
	spam_score?: number | null;
	/** JSON array of `{id, label}` explaining the score. */
	spam_signals?: string | null;
	/** JSON array of reader warnings (migration 31); see `shared/sender-warnings`. */
	security_warnings?: string | null;
}

interface AttachmentData {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

/** Storage flag: a retention purge has more batches to run from the alarm. */
const RETENTION_PENDING_KEY = "retention_pending";
/** Gap between continuation batches, so a big purge never monopolises the object. */
const RETENTION_CONTINUE_MS = 5_000;

export class MailboxDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;
	db: ReturnType<typeof drizzle>;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.db = drizzle(this.ctx.storage, { schema });
		applyMigrations(this.ctx.storage.sql, mailboxMigrations, this.ctx.storage);
	}

	/**
	 * Whether a backfill pass found nothing left to do, so read paths stop
	 * asking. Per-instance: a fresh isolate checks once (one indexed probe) and
	 * then remembers. New rows are derived at insert time and never re-open it.
	 */
	#derivedComplete = false;

	/**
	 * Lazily fill `snippet` / `sender_name` for legacy rows (migration 26).
	 *
	 * Called at the top of the list and search paths, one bounded batch per
	 * call, newest rows first — so the first page anyone looks at is clean on
	 * that very request, and a large backlog drains over the next few reads
	 * without a single long stall. See ./derived.ts.
	 */
	#catchUpDerived(): void {
		this.#catchUpEngagement();
		if (this.#derivedComplete) return;
		const processed = derived.backfillDerivedColumns(this.ctx);
		if (processed < derived.BACKFILL_BATCH && !derived.hasPendingDerived(this.ctx)) {
			this.#derivedComplete = true;
		}
	}

	/** Same idea as `#derivedComplete`, for the engagement cache (migration 28). */
	#engagementComplete = false;

	/**
	 * Lazily fill the engagement cache for messages that had opens or clicks
	 * before migration 28. One bounded batch per list read; see ./engagement.ts.
	 * New events keep the cache current themselves, so once the backlog is
	 * empty it stays empty for the life of the instance.
	 */
	#catchUpEngagement(): void {
		if (this.#engagementComplete) return;
		const processed = engagement.backfillEngagementCache(this.ctx);
		// Done only when a probe agrees: a batch that failed returns 0 too, and
		// must not end the backfill for the life of the instance.
		if (
			processed < engagement.ENGAGEMENT_BACKFILL_BATCH &&
			!engagement.hasPendingEngagement(this.ctx)
		) {
			this.#engagementComplete = true;
		}
	}

	/**
	 * Drain the derived-column backlog in one call, for an operator or a test.
	 * Bounded by `maxBatches` so an RPC cannot run unbounded.
	 */
	async backfillDerived(maxBatches = 50): Promise<{ processed: number; done: boolean }> {
		let processed = 0;
		for (let i = 0; i < maxBatches; i++) {
			const n = derived.backfillDerivedColumns(this.ctx);
			processed += n;
			if (n < derived.BACKFILL_BATCH) break;
		}
		const done = !derived.hasPendingDerived(this.ctx);
		if (done) this.#derivedComplete = true;
		return { processed, done };
	}

	// ── Outbound webhooks ──────────────────────────────────────────
	//
	// See ./webhook-events.ts. Every RPC that can write the delivery ledger
	// calls `queueWebhookFlush()` on its way out, which forwards new ledger rows
	// to the webhook object in the background. Nothing here can fail or slow
	// the caller: the flush runs under `waitUntil` and swallows its errors.

	/** Event types wanted per address, cached briefly to spare an RPC per write. */
	private webhookWanted = new Map<string, { types: WebhookEventType[]; at: number }>();
	private webhookFlushRunning: Promise<void> | null = null;
	private webhookFlushAgain = false;

	/** This mailbox's address, from `ctx.id.name` where the runtime provides it. */
	private mailboxAddress(): string | null {
		const name = (this.ctx.id as { name?: string }).name;
		return name ? name.toLowerCase() : null;
	}

	private async wantedWebhookTypes(address: string): Promise<WebhookEventType[]> {
		const stub = webhookStub(this.env);
		if (!stub) return [];
		const now = Date.now();
		const cached = this.webhookWanted.get(address);
		if (cached && now - cached.at < 60_000) return cached.types;
		const types = await stub.wantedTypes(address);
		this.webhookWanted.set(address, { types, at: now });
		return types;
	}

	private queueWebhookFlush(): void {
		const stub = webhookStub(this.env);
		// The realtime stream (EventsDO) is fed from the same ledger, from its own
		// cursor, with every event type: subscribers filter, not this object.
		const stream = eventsStub(this.env);
		if (!stub && !stream) return;
		if (this.webhookFlushRunning) {
			this.webhookFlushAgain = true;
			return;
		}
		const run = async () => {
			try {
				do {
					this.webhookFlushAgain = false;
					if (stub) {
						await flushLedgerToWebhooks(this.ctx, this.mailboxAddress(), stub, (address) =>
							this.wantedWebhookTypes(address),
						);
					}
					if (stream) {
						await flushLedgerToWebhooks(
							this.ctx,
							this.mailboxAddress(),
							{ wantedTypes: async () => [...WEBHOOK_EVENT_TYPES], enqueue: async (events) => ({ queued: (await stream.publish(events)).published }) },
							async () => [...WEBHOOK_EVENT_TYPES],
							STREAM_CURSOR_KEY,
						).catch((e) => console.error("event stream flush failed:", (e as Error).message));
					}
				} while (this.webhookFlushAgain);
			} catch (e) {
				console.error("webhook flush failed:", (e as Error).message);
			} finally {
				this.webhookFlushRunning = null;
			}
		};
		this.webhookFlushRunning = run();
		this.ctx.waitUntil(this.webhookFlushRunning);
	}

	/**
	 * Fire `message.received` for a stored inbound message. Called by the
	 * inbound handler under `waitUntil`; never throws.
	 */
	async emitReceivedWebhook(emailId: string, mailbox: string): Promise<void> {
		try {
			const stub = webhookStub(this.env);
			const stream = eventsStub(this.env);
			if (!stub && !stream) return;
			const address = mailbox.toLowerCase();
			const wanted = stub ? await stub.wantedTypes(address) : [];
			if (!wanted.includes("message.received") && !stream) return;
			const summary = emailSummaryFor(this.ctx, emailId);
			if (!summary) return;
			const eventId = `evt_${address}_recv_${emailId}`;
			const payload = buildWebhookPayload({
				id: eventId,
				type: "message.received",
				createdAt: new Date().toISOString(),
				mailbox: address,
				data: summary,
			});
			const event = { eventId, type: "message.received" as const, mailbox: address, payload: JSON.stringify(payload), now: Date.now() };
			if (stream) {
				await stream.publish([event]).catch((e) => console.error("event stream publish failed:", (e as Error).message));
			}
			if (stub && wanted.includes("message.received")) await stub.enqueue([event]);
		} catch (e) {
			console.error("message.received webhook failed:", (e as Error).message);
		}
	}

	// ── Email CRUD (Drizzle) ───────────────────────────────────────

	async getEmails(options: GetEmailsOptions = {}) {
		this.#catchUpDerived();
		const {
			folder,
			thread_id,
			page = 1,
			limit: rawLimit = 25,
			sortColumn: rawSortColumn = "date",
			sortDirection = "DESC",
		} = options;

		// Cap pagination limit to prevent unbounded queries
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		const sortColumn: SortColumn = ALLOWED_SORT_COLUMNS.includes(
			rawSortColumn as SortColumn,
		)
			? rawSortColumn
			: "date";

		const offset = (page - 1) * limit;

		const conditions: SQL[] = [];
		if (folder) {
			conditions.push(
				sql`${schema.emails.folder_id} = (SELECT id FROM folders WHERE name = ${folder} OR id = ${folder} LIMIT 1)`,
			);
		}
		if (thread_id) {
			conditions.push(eq(schema.emails.thread_id, thread_id));
		}
		for (const condition of this.#listFilterConditions(options)) {
			conditions.push(condition);
		}

		const orderCol = SORT_COLUMN_MAP[sortColumn];
		const orderDir = sortDirection === "ASC" ? asc(orderCol) : desc(orderCol);

		const result = this.db
			.select({
				id: schema.emails.id,
				subject: schema.emails.subject,
				sender: schema.emails.sender,
				recipient: schema.emails.recipient,
				cc: schema.emails.cc,
				bcc: schema.emails.bcc,
				date: schema.emails.date,
				read: schema.emails.read,
				starred: schema.emails.starred,
				in_reply_to: schema.emails.in_reply_to,
				email_references: schema.emails.email_references,
				thread_id: schema.emails.thread_id,
				folder_id: schema.emails.folder_id,
				// The list draws a failure icon from these, so they have to survive the
				// projection. `getEmail` selects every column and needs no such entry.
				delivery_status: schema.emails.delivery_status,
				delivery_error: schema.emails.delivery_error,
				// Engagement cache (migration 28), for the Sent list's status icons.
				opened_at: schema.emails.opened_at,
				last_opened_at: schema.emails.last_opened_at,
				open_count: schema.emails.open_count,
				open_proxy_count: schema.emails.open_proxy_count,
				clicked_at: schema.emails.clicked_at,
				click_count: schema.emails.click_count,
				// Stored plain text (migration 26), falling back to the old raw slice
				// for a row the lazy backfill has not reached yet.
				snippet: sql<string>`COALESCE(${schema.emails.snippet}, SUBSTR(${schema.emails.body}, 1, 300))`,
				sender_name: schema.emails.sender_name,
				// The list draws a warning icon from this (migration 31).
				security_warnings: schema.emails.security_warnings,
				// Presence only, not the rows: the list renders a paperclip, and
				// joining the metadata would multiply rows per attachment.
				//
				// `sql.raw` with the shared builder rather than an interpolated
				// template: Drizzle rewrites column references inside a tagged
				// fragment used in a projection, and the resulting expression
				// evaluated to 0 for every row.
				has_attachment: sql.raw(
					threading.hasAttachmentSql("emails.id"),
				) as unknown as SQL<number>,
			})
			.from(schema.emails)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(orderDir)
			.limit(limit)
			.offset(offset)
			.all();

		return summaries.attachSummaryLines(this.ctx, result).map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
			has_attachment: !!email.has_attachment,
		}));
	}

	/**
	 * Drizzle conditions for the shared list filters.
	 *
	 * `has_attachment` deliberately ignores inline parts: a message whose only
	 * attachment is a `cid:` image embedded in the body reads as "no
	 * attachments" to a user, and the list's paperclip uses the same rule.
	 */
	#listFilterConditions(filters: ListFilterOptions): SQL[] {
		const conditions: SQL[] = [];
		if (filters.unread) conditions.push(sql`${schema.emails.read} = 0`);
		if (filters.starred) conditions.push(sql`${schema.emails.starred} = 1`);
		if (filters.has_attachment) {
			conditions.push(sql.raw(threading.hasAttachmentSql("emails.id")));
		}
		return conditions;
	}

	/**
	 * Count total emails matching the given filters (for pagination).
	 */
	async countEmails(
		options: ListFilterOptions & { folder?: string; thread_id?: string } = {},
	) {
		const { folder, thread_id } = options;
		const conditions: string[] = [];
		const params: (string | number)[] = [];

		if (folder) {
			conditions.push(
				"folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)",
			);
			params.push(folder);
		}

		if (thread_id) {
			conditions.push(`thread_id = ?${params.length + 1}`);
			params.push(thread_id);
		}

		// Mirrors #listFilterConditions via the shared builder. These take no
		// parameters, so they can be appended as literal SQL without disturbing
		// the positional params above.
		for (const condition of threading.flatFilterConditions(options)) {
			conditions.push(condition);
		}

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) as total FROM emails ${where}`,
				...params,
			),
		][0] as { total: number } | undefined;

		return row?.total ?? 0;
	}

	// ── Threaded queries ───────────────────────────────────────────
	//
	// The SQL lives in ./threading.ts so it can be executed against a real
	// SQLite database in test/threading.test.ts. See that module's header for
	// why the list and count queries share their grouping CTEs.

	async getThreadedEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			page = 1,
			limit: rawLimit = 25,
			sortColumn,
			sortDirection,
		} = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		if (!folder) {
			// Conversation grouping is defined relative to a folder, so without one
			// there is nothing to group; fall back to the flat list.
			return this.getEmails(options);
		}

		const offset = (page - 1) * limit;
		const sql =
			folder === Folders.DRAFT
				? threading.draftListSql(options, sortColumn, sortDirection)
				: threading.threadedListSql(options, sortColumn, sortDirection);

		this.#catchUpDerived();
		if (folder === Folders.INBOX) {
			this.#maybeBackfillSummaries();
			this.#maybeBackfillSemantic();
		}
		const rows = summaries.attachSummaryLines(this.ctx, [
			...this.ctx.storage.sql.exec(sql, folder, limit, offset),
		] as any[]);
		return rows.map((row: any) => ({
			...row,
			participant_names: parseParticipantNames(row.participant_names),
			read: !!row.read,
			starred: !!row.starred,
			thread_count: row.thread_count || 1,
			thread_unread_count: row.thread_unread_count || 0,
			participants: row.participants || row.sender,
			// The draft list has no cross-folder view, so these two are absent from
			// its projection. Coerced here rather than branching at the call site.
			needs_reply: !!row.needs_reply,
			has_draft: !!row.has_draft,
			has_attachment: !!row.has_attachment,
		}));
	}

	/**
	 * One page of this mailbox's contribution to the unified inbox: threaded
	 * rows newest first, strictly after `after` (a (date, id) high-water mark).
	 * Asks for `limit + 1` so the caller knows whether more remain. Also returns
	 * the folder's unread count, so the unified view aggregates it without a
	 * second round trip.
	 */
	async getUnifiedPage(options: {
		folder: string;
		limit: number;
		after?: { date: string; id: string } | null;
		unread?: boolean;
		starred?: boolean;
		has_attachment?: boolean;
	}) {
		this.#catchUpDerived();
		const limit = Math.min(Math.max(options.limit, 1), 100);
		const filters = {
			unread: options.unread,
			starred: options.starred,
			has_attachment: options.has_attachment,
		};
		const rows = [
			...this.ctx.storage.sql.exec(
				threading.unifiedListSql(filters),
				options.folder,
				limit + 1,
				options.after?.date ?? null,
				options.after?.id ?? "",
			),
		].map((row: any) => ({
			...row,
			participant_names: parseParticipantNames(row.participant_names),
			read: !!row.read,
			starred: !!row.starred,
			thread_count: row.thread_count || 1,
			thread_unread_count: row.thread_unread_count || 0,
			participants: row.participants || row.sender,
			needs_reply: !!row.needs_reply,
			has_draft: !!row.has_draft,
			has_attachment: !!row.has_attachment,
		}));
		const unread = this.ctx.storage.sql
			.exec(
				`SELECT COUNT(*) AS n FROM emails
				  WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1) AND read = 0`,
				options.folder,
			)
			.one() as { n: number };
		return { rows, unread: unread.n };
	}

	/**
	 * Count conversations in a folder, for pagination.
	 *
	 * Returns the number of conversation groups, not individual messages, and
	 * honours the same filters as `getThreadedEmails` — a count that ignored them
	 * would offer pages the list cannot fill.
	 */
	async countThreadedEmails(folder: string, filters: ListFilterOptions = {}) {
		const sql =
			folder === Folders.DRAFT
				? threading.draftCountSql(filters)
				: threading.threadedCountSql(filters);

		const row = [...this.ctx.storage.sql.exec(sql, folder)][0] as
			| { total: number }
			| undefined;
		return row?.total ?? 0;
	}


	// ── Person-centric aggregation ─────────────────────────────────

	/**
	 * Aggregate this mailbox's messages by counterparty.
	 *
	 * One row per sender address, which the Worker then merges across every
	 * mailbox (see `shared/people.ts`). Aggregating here rather than shipping
	 * raw rows keeps the cross-DO payload proportional to the number of
	 * correspondents instead of the number of messages.
	 *
	 * `limit` caps correspondents, not messages — the counts stay accurate for
	 * everyone returned. Senders are ordered by recency, so the cap only ever
	 * drops the least recently active.
	 */
	async getPeople(options: { folder?: string; limit?: number } = {}) {
		const { folder = Folders.INBOX, limit: rawLimit = 500 } = options;
		const limit = Math.min(Math.max(rawLimit, 1), 2000);

		const rows = [
			...this.ctx.storage.sql.exec(
				`WITH folder_emails AS (
					SELECT
						LOWER(TRIM(e.sender)) AS person,
						e.date,
						e.read,
						EXISTS (
							SELECT 1 FROM attachments a WHERE a.email_id = e.id
						) AS has_attachment
					FROM emails e
					WHERE e.folder_id = (
							SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1
						)
						AND e.sender IS NOT NULL
						AND TRIM(e.sender) != ''
				)
				SELECT
					person AS email,
					COUNT(*) AS totalCount,
					SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) AS unreadCount,
					MAX(CASE WHEN has_attachment THEN 1 ELSE 0 END) AS hasAttachment,
					MAX(date) AS lastEmailAt
				FROM folder_emails
				GROUP BY person
				ORDER BY lastEmailAt DESC
				LIMIT ?2`,
				folder,
				limit,
			),
		] as {
			email: string;
			totalCount: number;
			unreadCount: number;
			hasAttachment: number;
			lastEmailAt: string | null;
		}[];

		const fromHeaders = this.getLatestFromHeaders(folder, limit);

		return rows.map((row) => ({
			email: row.email,
			fromHeader: fromHeaders.get(row.email) ?? null,
			lastEmailAt: row.lastEmailAt,
			unreadCount: row.unreadCount ?? 0,
			totalCount: row.totalCount ?? 0,
			hasAttachment: row.hasAttachment ? 1 : 0,
		}));
	}

	/**
	 * Raw `From` header of each correspondent's most recent message.
	 *
	 * Inbound mail stores `sender` as a bare lowercased address, so a friendly
	 * display name only survives inside `raw_headers`. Pulling just the one
	 * header out in SQL avoids shipping entire header blobs across the RPC
	 * boundary.
	 *
	 * `json_valid` is not optional: `json_each` raises SQLITE_ERROR for the
	 * whole statement when any single row holds non-JSON, so one malformed blob
	 * would otherwise cost every correspondent in the mailbox their name.
	 * Rows that fail the check fall back to the next most recent valid message.
	 *
	 * Kept separate from the aggregate query, and failure-tolerant, because a
	 * display name is cosmetic: a bad `raw_headers` blob should cost a nice
	 * name, not the whole inbox.
	 */
	private getLatestFromHeaders(folder: string, limit: number): Map<string, string> {
		const names = new Map<string, string>();

		try {
			const rows = [
				...this.ctx.storage.sql.exec(
					`WITH folder_emails AS (
						SELECT
							LOWER(TRIM(sender)) AS person,
							raw_headers,
							ROW_NUMBER() OVER (
								PARTITION BY LOWER(TRIM(sender)) ORDER BY date DESC
							) AS rn
						FROM emails
						WHERE folder_id = (
								SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1
							)
							AND sender IS NOT NULL
							AND TRIM(sender) != ''
							AND raw_headers IS NOT NULL
							AND json_valid(raw_headers)
					)
					SELECT
						person,
						(
							SELECT json_extract(h.value, '$.value')
							FROM json_each(fe.raw_headers) h
							WHERE LOWER(json_extract(h.value, '$.key')) = 'from'
							LIMIT 1
						) AS from_header
					FROM folder_emails fe
					WHERE fe.rn = 1
					LIMIT ?2`,
					folder,
					limit,
				),
			] as { person: string; from_header: string | null }[];

			for (const row of rows) {
				if (row.from_header) names.set(row.person, row.from_header);
			}
		} catch (e) {
			console.error(
				"Failed to resolve sender display names:",
				(e as Error).message,
			);
		}

		return names;
	}

	/**
	 * This mailbox's side of the conversation with one person: everything they
	 * sent us plus everything we sent them.
	 *
	 * Trash and spam are excluded so the timeline matches what the inbox shows.
	 * `INSTR` is used rather than `LIKE` because addresses legitimately contain
	 * `_`, which `LIKE` would treat as a wildcard.
	 */
	async getPersonEmails(options: {
		person: string;
		limit?: number;
	}) {
		const person = options.person.trim().toLowerCase();
		if (!person) return [];

		const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
		this.#catchUpDerived();

		const rows = [
			...this.ctx.storage.sql.exec(
				`SELECT
					e.id, e.subject, e.sender, e.recipient, e.cc, e.date,
					e.read, e.starred, e.thread_id, e.folder_id,
					e.in_reply_to, e.message_id,
					e.delivery_status, e.delivery_error,
					${derived.snippetSql("e")} AS snippet, e.sender_name,
					(SELECT COUNT(*) FROM attachments a WHERE a.email_id = e.id)
						AS attachmentCount
				FROM emails e
				-- Compared directly against folder ids. This previously looked the
				-- ids up by folders.name IN (?2, ?3), which never matched: the
				-- parameters are the lowercase canonical ids while the name column
				-- holds the capitalised display string, so Trash and Spam were not
				-- excluded at all.
				WHERE e.folder_id NOT IN (?2, ?3)
					AND (
						LOWER(TRIM(e.sender)) = ?1
						OR INSTR(LOWER(COALESCE(e.recipient, '')), ?1) > 0
						OR INSTR(LOWER(COALESCE(e.cc, '')), ?1) > 0
					)
				ORDER BY e.date DESC
				LIMIT ?4`,
				person,
				Folders.TRASH,
				Folders.SPAM,
				limit,
			),
		] as Record<string, unknown>[];

		return rows.map((row) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
			attachmentCount: Number(row.attachmentCount ?? 0),
		}));
	}

	// ── Single email operations (Drizzle) ──────────────────────────

	async getEmail(id: string) {
		const email = this.db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select()
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		return {
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: emailAttachments,
		};
	}

	/**
	 * Fetch a message by either kind of identifier a reference can hold.
	 *
	 * `emails.in_reply_to` is not one thing. Four write paths store the parent's
	 * RFC `Message-ID` — inbound delivery, the reply and forward routes, the
	 * scheduled-send path, and the agent's auto-reply — while three store our own
	 * row UUID: the composer's draft saves, `draft_reply`, and the auto-drafter.
	 * Both are legitimate; the column has simply always meant "the parent", not
	 * "the parent's row id".
	 *
	 * Callers that resolved a reference with `getEmail` alone therefore worked or
	 * failed depending on which path had written the row they were handed. The
	 * visible case: cancelling Undo Send drops the queued message back into Drafts
	 * with an RFC-form `in_reply_to`, and sending that draft again then looked up a
	 * Message-ID as though it were a row id, missed, and either sent the reply
	 * detached from its conversation or failed outright with "Original email not
	 * found".
	 *
	 * Row id is tried first: ours are unique by construction, and are what most
	 * callers hold. See ./references.ts for the `Message-ID` half and why the
	 * newest match wins there.
	 */
	async getEmailByRef(ref: string) {
		if (!ref) return null;

		const byId = await this.getEmail(ref);
		if (byId) return byId;

		const id = references.findIdByMessageId(this.ctx, ref);
		return id ? this.getEmail(id) : null;
	}

	/**
	 * Fetch all emails in a thread with full bodies and attachments in
	 * two queries (one for emails, one for attachments) instead of
	 * N+1 individual getEmail calls.
	 */
	async getThreadEmails(threadId: string, options: { folder?: string } = {}) {
		/**
		 * Scoped to the folder being viewed, when one is given.
		 *
		 * This had no folder filter at all, so every view rendered the whole
		 * conversation regardless of where its messages actually were. In Trash that
		 * was actively misleading: deleting one draft out of a thread and opening it
		 * from Trash showed the entire conversation sitting in the bin, while those
		 * same messages were still in the Inbox. `threading.conversationScopeSql`
		 * holds the rule, shared with the list's `conversation_stats` so the count on
		 * a row and the messages behind it cannot disagree.
		 *
		 * Absent a folder the old behaviour stands — the whole conversation minus
		 * nothing — because callers without a view have no basis to narrow it.
		 */
		// Bounded because this returns full bodies over RPC. An unbounded thread
		// could exceed the response limit, and the attachment lookup below binds
		// one parameter per message, which has its own ceiling.
		const emailRows = [
			...this.ctx.storage.sql.exec(
				threading.threadMessagesSql(!!options.folder),
				threadId,
				MAX_THREAD_MESSAGES,
				...(options.folder ? [options.folder] : []),
			),
		] as any[];

		if (emailRows.length === 0) return [];

		const emailIds = emailRows.map((e) => e.id as string);

		// Batch-fetch attachments, chunked to stay inside the bound-parameter
		// budget rather than binding one per message in a single statement.
		const attachmentRows: any[] = [];
		for (const chunk of bulk.chunkIds(emailIds)) {
			attachmentRows.push(
				...(this.ctx.storage.sql
					.exec(
						`SELECT * FROM attachments
						  WHERE email_id IN (${bulk.placeholders(chunk.length)})`,
						...chunk,
					)
					.toArray() as any[]),
			);
		}

		// Group attachments by email_id
		const attachmentsByEmail = new Map<string, any[]>();
		for (const att of attachmentRows) {
			const list = attachmentsByEmail.get(att.email_id) || [];
			list.push(att);
			attachmentsByEmail.set(att.email_id, list);
		}

		return emailRows.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: attachmentsByEmail.get(email.id) || [],
		}));
	}

	async updateEmail(
		id: string,
		{ read, starred }: { read?: boolean; starred?: boolean },
	) {
		const data: { read?: number; starred?: number } = {};
		if (read !== undefined) {
			data.read = read ? 1 : 0;
		}
		if (starred !== undefined) {
			data.starred = starred ? 1 : 0;
		}

		if (Object.keys(data).length === 0) {
			return this.getEmail(id);
		}

		this.db
			.update(schema.emails)
			.set(data)
			.where(eq(schema.emails.id, id))
			.run();

		return this.getEmail(id);
	}

	async markThreadRead(threadId: string) {
		this.ctx.storage.sql.exec(
			`UPDATE emails SET read = 1 WHERE thread_id = ? AND read = 0`,
			threadId,
		);
		return { threadId, markedRead: true };
	}

	/**
	 * Which folder a message is in, or null if there is no such message.
	 *
	 * Exists so a caller can find out whether deleting a message would bin it or
	 * destroy it *before* asking, which is what decides how much authority the
	 * delete needs. Cheaper than fetching the message to read one column.
	 */
	async getEmailFolder(id: string): Promise<string | null> {
		const row = this.db
			.select({ folder: schema.emails.folder_id })
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		return row?.folder ?? null;
	}

	/**
	 * Delete one message: to Trash, or destroyed if it is already binned.
	 *
	 * Returns null when the id is unknown so the route can answer 404, and
	 * otherwise the outcome, because "trashed" and "deleted" need different
	 * wording and only one of them can be undone. See ./trash.ts for why a
	 * bare delete no longer destroys anything.
	 */
	async deleteEmail(id: string, options: { permanent?: boolean } = {}) {
		const exists = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!exists) return null;

		const outcome = trash.deleteOrTrash(this.ctx, [id], options);
		this.#armSemanticSoon();
		return outcome;
	}

	/**
	 * Destroy the draft a queued send replaced; see trash.destroySupersededDraft
	 * for why this is scoped to the Drafts folder rather than reusing the
	 * `permanent` delete.
	 */
	async destroySupersededDraft(id: string) {
		return trash.destroySupersededDraft(this.ctx, id);
	}

	/**
	 * Bin messages without ever destroying one; for the MCP tools. See
	 * trash.trashOnly.
	 */
	async trashEmailsOnly(ids: string[]) {
		return trash.trashOnly(this.ctx, ids);
	}

	/** Put binned messages back where they came from; see trash.restoreFromTrash. */
	async restoreEmails(ids: string[]) {
		return trash.restoreFromTrash(this.ctx, ids);
	}

	/** Destroy everything in Trash; returns R2 keys for the caller to clean up. */
	async emptyTrash() {
		const outcome = trash.emptyTrash(this.ctx);
		this.#armSemanticSoon();
		return outcome;
	}

	async getAttachment(id: string) {
		return (
			this.db
				.select()
				.from(schema.attachments)
				.where(eq(schema.attachments.id, id))
				.get() ?? null
		);
	}

	/**
	 * Update a draft in place.
	 *
	 * Autosave used to delete the row and insert a replacement, which meant every
	 * save minted a new id, orphaned the old row's attachments, and left a window
	 * where the draft existed nowhere. Updating in place keeps the id stable, so
	 * attachments stay attached and the composer has nothing to chase.
	 *
	 * Returns false when the id is unknown or is not a draft, which the route
	 * turns into "create a new one instead" — a draft deleted in another tab must
	 * not resurrect as an update to a missing row, and this must never be able to
	 * rewrite a sent or received message.
	 */
	async updateDraft(
		id: string,
		fields: {
			subject?: string;
			recipient?: string;
			cc?: string | null;
			bcc?: string | null;
			body?: string;
			date?: string;
			in_reply_to?: string | null;
			thread_id?: string | null;
		},
	): Promise<boolean> {
		// Resolved by id *or* name, the same way `createEmail` does it. Looking the
		// folder up by name alone silently failed — the seeded row is
		// `('draft', 'Drafts')`, so `name = 'draft'` matches nothing — and every
		// autosave then fell through to creating a new draft, which is exactly the
		// row-per-save behaviour this method exists to prevent.
		const draftFolder = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(
				or(
					eq(schema.folders.id, Folders.DRAFT),
					eq(schema.folders.name, Folders.DRAFT),
				),
			)
			.get();
		if (!draftFolder) return false;

		const existing = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(
				and(
					eq(schema.emails.id, id),
					eq(schema.emails.folder_id, draftFolder.id),
				),
			)
			.get();
		if (!existing) return false;

		this.db
			.update(schema.emails)
			.set({
				subject: fields.subject,
				recipient: fields.recipient,
				cc: fields.cc,
				bcc: fields.bcc,
				body: fields.body,
				// The preview follows the body. Left alone, an autosaved draft would
				// keep listing the first thing ever typed into it.
				...(fields.body !== undefined
					? {
							snippet: derived.deriveColumns({ body: fields.body }).snippet,
							derived_v: derived.DERIVED_VERSION,
						}
					: {}),
				date: fields.date,
				in_reply_to: fields.in_reply_to,
				thread_id: fields.thread_id,
				// Editing a failed draft clears the failure. This row keeps its id
				// across autosaves, so a draft demoted here by an exhausted send would
				// otherwise carry "couldn't be sent" — and the address that caused it —
				// while the user is in the middle of fixing exactly that. The mark is
				// re-applied by the send path if the next attempt fails too.
				delivery_status: null,
				delivery_error: null,
			})
			.where(eq(schema.emails.id, id))
			.run();

		return true;
	}

	/**
	 * Swap a message's attachment set.
	 *
	 * Returns the R2 keys of the rows it removed so the Worker can delete the
	 * blobs — the DO has no bucket binding, and leaving them behind would leak
	 * storage that cannot be swept later, since the bucket is shared across
	 * mailboxes and cannot be listed by mailbox prefix.
	 */
	async replaceAttachments(
		emailId: string,
		attachments: AttachmentData[],
	): Promise<string[]> {
		const previous = this.db
			.select({
				id: schema.attachments.id,
				filename: schema.attachments.filename,
			})
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, emailId))
			.all();

		this.db
			.delete(schema.attachments)
			.where(eq(schema.attachments.email_id, emailId))
			.run();

		if (attachments.length > 0) {
			this.db.insert(schema.attachments).values(attachments).run();
		}

		return previous.map((row) => attachmentKey(emailId, row.id, row.filename));
	}

	// ── Folders (Drizzle) ──────────────────────────────────────────

	async getFolders() {
		const result = this.db
			.select({
				id: schema.folders.id,
				name: schema.folders.name,
				unreadCount: sql<number>`COALESCE(SUM(CASE WHEN ${schema.emails.read} = 0 THEN 1 ELSE 0 END), 0)`.mapWith(Number),
				// Drafts and Scheduled show how many there are, not "unread".
				totalCount: sql<number>`COUNT(${schema.emails.id})`.mapWith(Number),
			})
			.from(schema.folders)
			.leftJoin(schema.emails, eq(schema.emails.folder_id, schema.folders.id))
			.groupBy(schema.folders.id, schema.folders.name)
			.all();
		return result;
	}

	async createFolder(id: string, name: string, is_deletable: number = 1) {
		try {
			const result = this.db
				.insert(schema.folders)
				.values({ id, name, is_deletable })
				.returning({ id: schema.folders.id, name: schema.folders.name })
				.get();
			return { ...result, unreadCount: 0, totalCount: 0 };
		} catch (e: unknown) {
			if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) {
				return null;
			}
			throw e;
		}
	}

	async updateFolder(id: string, name: string) {
		const result = this.db
			.update(schema.folders)
			.set({ name })
			.where(eq(schema.folders.id, id))
			.returning({ id: schema.folders.id, name: schema.folders.name })
			.get();
		return result;
	}

	/**
	 * Delete a custom folder, moving its contents to the inbox.
	 *
	 * The relocation is the point: `emails.folder_id` cascades on delete, so the
	 * obvious implementation destroyed every message in the folder. See
	 * ./folders.ts.
	 */
	async deleteFolder(id: string) {
		return folders.deleteFolder(this.ctx, id);
	}

	async moveEmail(id: string, folderId: string) {
		// Refused here rather than only at the route, because the agent tool and the
		// MCP surface reach this directly. See `canMoveInto`: filing mail into Drafts
		// forges the invariant the send path uses to decide it may destroy a row.
		if (!canMoveInto(folderId)) return false;

		// Received mail cannot be filed into Sent. See `canMoveMessageInto`.
		if (folderId.toLowerCase() === Folders.SENT) {
			const row = this.db
				.select({ sender: schema.emails.sender })
				.from(schema.emails)
				.where(eq(schema.emails.id, id))
				.get();
			if (
				row &&
				!canMoveMessageInto(folderId, {
					outbound: isOutboundFrom(row.sender, this.mailboxAddress()),
				})
			) {
				return false;
			}
		}

		const folder = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(eq(schema.folders.id, folderId))
			.get();

		if (!folder) return false;

		this.#learn(() => triage.noteMoved(this.ctx, [id], folderId));
		this.db
			.update(schema.emails)
			.set({ folder_id: folderId })
			.where(eq(schema.emails.id, id))
			.run();

		return true;
	}

	// ── Search (raw SQL — see ./search.ts for the compiler) ────────

	/**
	 * Run a search, falling back to the pre-index scan if the full-text index is
	 * unavailable.
	 *
	 * The index is created by migration 18, which every mailbox runs on its next
	 * request — but a mailbox that has not yet woken up would otherwise turn
	 * every search into a 500. `run` is retried in `like` mode instead, which
	 * returns the right answer more slowly.
	 */
	#withTextFallback<T>(run: (mode: "fts" | "like") => T): T {
		try {
			return run("fts");
		} catch (e) {
			const message = (e as Error).message ?? "";
			// Only swallow the failures that mean "the index cannot answer this".
			// Anything else is a real bug and should surface. `bound` covers the
			// compiler's parameter-budget assertion, which the scan has no limit
			// on and can therefore still answer.
			const recoverable =
				message.includes("emails_fts") ||
				message.includes("fts5") ||
				message.includes("no such table") ||
				message.includes("syntax error") ||
				message.includes("bound");
			if (!recoverable) throw e;

			console.warn(
				`Full-text search unavailable (${message}); falling back to a scan.`,
			);
			return run("like");
		}
	}

	async searchEmails(options: SearchFilterOptions & { page?: number; limit?: number }) {
		const { page = 1, limit: rawLimit = 25 } = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);
		// Parsed here rather than on the client because the worker is what turns
		// operators into SQL. The client used to parse and send a dozen flat query
		// parameters, which pinned the operator set to what that flat shape could
		// express — no negation, no OR, no grouping.
		const node = parseSearchQuery(options.query);
		const offset = (Math.max(page, 1) - 1) * limit;
		this.#catchUpDerived();

		return this.#withTextFallback((mode) => {
			const { sql: statement, params, ftsSnippet } = searchListSql(node, {
				mode,
				limit,
				offset,
				defaultFolder: options.folder,
			});

			const result = this.ctx.storage.sql.exec(statement, ...params);
			// Row shape is the projection in `searchListSql`; the flags are stored
			// as SQLite integers and the client expects booleans.
			const rows = [...result] as Record<string, unknown>[];
			return rows.map((row) => ({
				...row,
				// An FTS5 excerpt is cut from the indexed body, which for HTML mail
				// is markup; the stored snippet is already clean and passes through
				// untouched. Highlight markers survive the cleanup.
				snippet: ftsSnippet
					? cleanFtsSnippet(row.snippet as string | null)
					: row.snippet,
				read: !!row.read,
				starred: !!row.starred,
				has_attachment: !!row.has_attachment,
			}));
		});
	}

	/**
	 * Count matching messages, for pagination.
	 *
	 * Compiled from the same AST and the same predicates as the list, because a
	 * list and count that disagree produce an empty last page — a bug that stays
	 * invisible until someone pages to the end.
	 */
	async countSearchResults(options: SearchFilterOptions) {
		const node = parseSearchQuery(options.query);

		return this.#withTextFallback((mode) => {
			const { sql: statement, params } = searchCountSql(node, {
				mode,
				defaultFolder: options.folder,
			});

			const row = [...this.ctx.storage.sql.exec(statement, ...params)][0] as
				| { total: number }
				| undefined;
			return row?.total ?? 0;
		});
	}

	// ── Threading helpers (raw SQL) ────────────────────────────────

	/**
	 * Resolve an existing local thread from the Message-IDs an inbound reply
	 * cites in In-Reply-To / References.
	 *
	 * Those are the *counterparty's* identifiers, which we store in
	 * `emails.message_id` — not in `id` or `thread_id`, which are our own UUIDs.
	 * Threading straight off `References[0]` therefore matches nothing local and
	 * opens a second conversation for the same exchange, so look the citations up
	 * before falling back to them.
	 *
	 * @param msgIds Candidate ids in preference order (nearest ancestor first).
	 */
	async findThreadByMessageIds(msgIds: string[]): Promise<string | null> {
		// Truncated because `References` is attacker-controlled and unbounded in
		// length, while the statement binds one parameter per candidate. The list
		// arrives nearest-ancestor-first, and a match beyond the first handful
		// would not change which thread we pick.
		return references.findThreadByMessageIds(
			this.ctx,
			msgIds.filter(Boolean).slice(0, MAX_REFERENCE_CANDIDATES),
		);
	}

	/**
	 * Whether a message with this Message-ID is already stored.
	 *
	 * Makes inbound delivery idempotent across the retries Cloudflare performs
	 * when the email handler throws. See ./dedupe.ts.
	 */
	async hasMessageId(messageId: string | null | undefined): Promise<boolean> {
		return dedupe.hasMessageId(this.ctx, messageId);
	}

	// ── Mail import ────────────────────────────────────────────────
	//
	// Jobs live in `import_jobs` (migration 43); the alarm runs them one bounded
	// step at a time. See ./mail-import.ts and ../lib/mail-import.ts. Imported
	// rows never go through `createEmail` or `receiveEmail`, so no webhook,
	// notification, forward, auto-reply, triage, summary or follow-up fires.

	async createImportJob(input: mailImport.CreateJobInput) {
		if (mailImport.activeJobCount(this.ctx) >= mailImport.MAX_ACTIVE_JOBS) {
			return { error: `At most ${mailImport.MAX_ACTIVE_JOBS} imports can run at once. Wait for one to finish or cancel it.` };
		}
		const row = mailImport.createJob(this.ctx, input);
		if (row.status === "queued") await this.#armImport();
		return { job: mailImport.toJobView(row) };
	}

	async listImportJobs(limit?: number) {
		return mailImport.listJobs(this.ctx, limit).map(mailImport.toJobView);
	}

	async getImportJob(id: string) {
		const row = mailImport.getJob(this.ctx, id);
		return row ? mailImport.toJobView(row) : null;
	}

	/** The internals the upload routes need (R2 key and upload id). Never sent to clients. */
	async getImportUpload(id: string) {
		const row = mailImport.getJob(this.ctx, id);
		if (!row) return null;
		return {
			status: row.status,
			source: row.source,
			r2Key: row.r2_key,
			uploadId: row.upload_id,
			partSize: row.part_size,
			partsTotal: row.parts_total,
			sizeBytes: row.size_bytes,
			parts: mailImport.parseParts(row),
		};
	}

	async recordImportPart(id: string, part: mailImport.UploadedPart) {
		const row = mailImport.recordPart(this.ctx, id, part);
		return row ? mailImport.toJobView(row) : null;
	}

	/** The upload is complete in R2: queue the job. */
	async startImportJob(id: string, sizeBytes: number) {
		const row = mailImport.getJob(this.ctx, id);
		if (!row) return null;
		if (row.status !== "uploading") return mailImport.toJobView(row);
		mailImport.patchJob(this.ctx, id, { status: "queued", sizeBytes, uploadId: null });
		await this.#armImport();
		return mailImport.toJobView(mailImport.getJob(this.ctx, id)!);
	}

	async transitionImportJob(id: string, action: "pause" | "resume" | "cancel") {
		const result = mailImport.transitionJob(this.ctx, id, action);
		if ("error" in result) return result;
		if (action === "resume") await this.#armImport();
		if (action === "cancel") this.ctx.waitUntil(this.#cleanupImport(result.job));
		return { job: mailImport.toJobView(result.job) };
	}

	async #armImport(when = Date.now() + IMPORT_RESCHEDULE_MS): Promise<void> {
		await summaries.armAlarmAt(this.ctx, when);
	}

	/**
	 * After a job ends: delete its IMAP password and its uploaded file. The
	 * imported messages and their attachments stay; they are mail now.
	 */
	async #cleanupImport(row: mailImport.ImportJobRow): Promise<void> {
		if (row.source === "imap") {
			try {
				await authStore(this.env).deleteImportCredential(row.id);
			} catch (e) {
				console.error(`import ${row.id}: credential delete failed:`, (e as Error).message);
			}
		}
		if (row.r2_key) {
			try {
				if (row.upload_id) {
					await this.env.BUCKET.resumeMultipartUpload(row.r2_key, row.upload_id).abort().catch(() => {});
				}
				await this.env.BUCKET.delete(row.r2_key);
			} catch (e) {
				console.error(`import ${row.id}: upload cleanup failed:`, (e as Error).message);
			}
		}
	}

	/** One bounded import step, from the alarm. Returns whether to re-arm soon. */
	async #runImportAlarm(): Promise<boolean> {
		if (!mailImport.hasRunnableJob(this.ctx)) return false;
		const job = mailImport.nextRunnableJob(this.ctx)!;
		const mailbox = job.mailbox ?? this.mailboxAddress() ?? "";
		const result = await runImportStep({
			ctx: this.ctx,
			bucket: this.env.BUCKET as never,
			mailbox,
			imap: {
				connect: connectImap,
				password: async () => {
					const s = authStore(this.env);
					const enc = await s.getImportCredential(job.id, mailbox);
					if (!enc) return null;
					return openImportPassword(enc, await authSecret(this.env, s), job.id);
				},
			},
		});
		if (result.finished) {
			await this.#cleanupImport(result.finished);
			// Imported mail is never queued at ingest. Once a job has finished,
			// its newest messages go to semantic search as low-priority backfill
			// (live mail first, paced, inside the daily cap). Summaries, triage
			// and the rest are never queued for imported mail.
			if (result.finished.imported > 0 && mailbox && this.#semanticReady()) {
				try {
					if (mailImport.queueImportedForSemantic(this.ctx, mailbox) > 0) {
						await summaries.armAlarmAt(this.ctx, Date.now() + semantic.SEMANTIC_DEBOUNCE_MS);
					}
				} catch (e) {
					console.error("import: semantic backfill queue failed:", (e as Error).message);
				}
			}
		}
		return result.more;
	}

	/** Whether this mailbox has ever sent mail to an address. */
	async hasSentTo(address: string) {
		return features.hasSentTo(this.ctx, address);
	}

	/**
	 * Whether any message from `address` is already stored here, in any folder
	 * but Spam. The first-time-sender warning asks this before the new row is
	 * written, so the message being delivered never counts as its own history.
	 */
	async hasReceivedFrom(address: string) {
		return features.hasReceivedFrom(this.ctx, address);
	}

	/**
	 * Display names and domains of the people this mailbox corresponds with most,
	 * for the impersonation warnings. Bounded; see `features.frequentCorrespondents`.
	 */
	async getFrequentCorrespondents() {
		return features.frequentCorrespondents(this.ctx);
	}

	async findThreadBySubject(subject: string, senderAddress?: string): Promise<string | null> {
		const normalized = subject
			.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
			.trim()
			.toLowerCase();

		if (!normalized) return null;

		// `emails.date` is ISO 8601 while `datetime()` yields `YYYY-MM-DD HH:MM:SS`;
		// comparing the two as TEXT widens the window by up to a day, because 'T'
		// sorts above ' '. See ./rate-limit.ts for the full explanation.
		const cutoff = new Date(
			Date.now() - 7 * 24 * 60 * 60 * 1000,
		).toISOString();

		const result = this.ctx.storage.sql.exec(
			`SELECT thread_id, subject,
			        GROUP_CONCAT(DISTINCT LOWER(sender)) as senders,
			        GROUP_CONCAT(DISTINCT LOWER(recipient)) as recipients
			 FROM emails
			 WHERE thread_id IS NOT NULL
			   AND thread_id != id
			   AND date >= ?1
			 GROUP BY thread_id
			 ORDER BY MAX(date) DESC
			 LIMIT 50`,
			cutoff,
		);

		const normalizedSender = senderAddress?.toLowerCase().trim();

		for (const row of result) {
			const rowSubject = String((row as any).subject || "")
				.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
				.trim()
				.toLowerCase();
			if (rowSubject !== normalized) continue;

			if (normalizedSender) {
				const threadSenders = String((row as any).senders || "");
				const threadRecipients = String((row as any).recipients || "");
				const allParticipants = `${threadSenders},${threadRecipients}`;
				if (!allParticipants.includes(normalizedSender)) {
					continue;
				}
			}

			return String((row as any).thread_id);
		}
		return null;
	}

	// ── Rate limiting ──────────────────────────────────────────────

	/**
	 * Check if the mailbox has exceeded the send rate limit.
	 *
	 * The window arithmetic lives in ./rate-limit.ts, which documents why the
	 * cutoffs must be computed in JS rather than with `datetime('now', …)`.
	 */
	async checkSendRateLimit(): Promise<string | null> {
		// Per-mailbox caps (migration 37), admin-editable; defaults 20/h, 100/day.
		const { caps } = rateLimit.getSendCaps(this.ctx);
		return rateLimit.checkSendQuota(this.ctx, { hourlyLimit: caps.hourly, dailyLimit: caps.daily });
	}

	// ── Idempotency keys ───────────────────────────────────────────
	//
	// Per-mailbox sends and creates. Each is synchronous SQL inside one RPC, so
	// the in-flight check-and-set cannot interleave. See ../lib/idempotency.ts.

	async idempotencyBegin(input: IdempotencyBeginInput): Promise<IdempotencyBeginResult> {
		return beginIdempotent(this.ctx.storage.sql, input);
	}

	async idempotencyComplete(input: IdempotencyCompleteInput): Promise<boolean> {
		return completeIdempotent(this.ctx.storage.sql, input);
	}

	async idempotencyRelease(input: IdempotencyReleaseInput): Promise<void> {
		releaseIdempotent(this.ctx.storage.sql, input);
	}

	// ── Send approvals ─────────────────────────────────────────────
	//
	// Agent and MCP sends held for a person. See ./approvals.ts and
	// workers/lib/agent-send-gate.ts.

	async createSendApproval(input: approvals.CreateApprovalInput) {
		const record = approvals.createApproval(this.ctx, input);
		// Tell the people who could approve it. Background and never throws.
		const mailboxId = this.mailboxAddress();
		if (mailboxId) {
			this.ctx.waitUntil(
				notifyApproval(this.env, {
					mailboxId,
					approvalId: record.id,
					subject: record.subject,
					recipients: record.recipients.length,
				}).catch(() => {}),
			);
		}
		return record;
	}

	async getSendApproval(id: string) {
		return approvals.getApproval(this.ctx, id);
	}

	async listSendApprovals(options: { status?: ApprovalStatus | "all"; limit?: number } = {}) {
		return approvals.listApprovals(this.ctx, options);
	}

	async countPendingSendApprovals() {
		return approvals.countPendingApprovals(this.ctx);
	}

	async claimSendApproval(id: string, options: { decidedBy: string | null; expectedRevision?: number | null }) {
		return approvals.claimApproval(this.ctx, id, options);
	}

	async finishSendApproval(id: string, fence: string, outcome: approvals.FinishOutcome) {
		return approvals.finishApproval(this.ctx, id, fence, outcome);
	}

	async updatePendingSendApproval(
		id: string,
		update: { payload: Record<string, unknown>; recipients: string[]; subject: string; revisedBy?: approvals.ApprovalReviser; reason?: string },
	) {
		return approvals.updatePendingApproval(this.ctx, id, update);
	}

	async reopenSendApproval(id: string) {
		return approvals.reopenApproval(this.ctx, id);
	}

	async rejectSendApproval(id: string, options: { decidedBy: string | null; note?: string | null }) {
		return approvals.rejectApproval(this.ctx, id, options);
	}

	// ── Labels ─────────────────────────────────────────────────────
	//
	// The bodies live in ./features.ts; only methods declared on this class are
	// reachable over RPC, so each one is a thin delegation.

	async getLabels() {
		return features.getLabels(this.ctx);
	}

	async createLabel(
		name: string,
		color?: string,
		parentId: string | null = null,
		sortOrder = 0,
	) {
		return features.createLabel(this.ctx, name, color, parentId, sortOrder);
	}

	async updateLabel(
		id: string,
		patch: { name?: string; color?: string; parent_id?: string | null; sort_order?: number },
	) {
		return features.updateLabel(this.ctx, id, patch);
	}

	async deleteLabel(id: string) {
		return features.deleteLabel(this.ctx, id);
	}

	async getEmailLabels(emailId: string) {
		return features.getEmailLabels(this.ctx, emailId);
	}

	// The three below are what a person does to labels, so they feed the
	// triage feedback loop (./triage.ts). Rules and triage write directly.
	async setEmailLabels(emailId: string, labelIds: string[]) {
		this.#learn(() => triage.noteLabelSetReplaced(this.ctx, emailId, labelIds));
		const before = new Set(features.getEmailLabels(this.ctx, emailId).map((l) => l.id));
		const result = features.setEmailLabels(this.ctx, emailId, labelIds);
		for (const id of labelIds) {
			if (!before.has(id)) this.#learn(() => triage.noteLabelAdded(this.ctx, emailId, id));
		}
		return result;
	}

	async addEmailLabel(emailId: string, labelId: string) {
		const ok = features.addEmailLabel(this.ctx, emailId, labelId);
		if (ok) this.#learn(() => triage.noteLabelAdded(this.ctx, emailId, labelId));
		return ok;
	}

	async removeEmailLabel(emailId: string, labelId: string) {
		this.#learn(() => triage.noteLabelRemoved(this.ctx, emailId, labelId));
		return features.removeEmailLabel(this.ctx, emailId, labelId);
	}

	/** Run a feedback-loop write. Learning must never fail the user's action. */
	#learn(fn: () => void) {
		try {
			fn();
		} catch (e) {
			console.error("triage feedback failed:", (e as Error).message);
		}
	}

	async getEmailsByLabel(
		labelId: string,
		options: {
			page?: number;
			limit?: number;
			sortColumn?: SortColumn;
			sortDirection?: "ASC" | "DESC";
		} & ListFilterOptions = {},
	) {
		this.#catchUpDerived();
		return features.getEmailsByLabel(this.ctx, labelId, options);
	}

	async countEmailsByLabel(labelId: string, filters: ListFilterOptions = {}) {
		return features.countEmailsByLabel(this.ctx, labelId, filters);
	}

	// ── Signatures & priority ──────────────────────────────────────

	async getSignatures() {
		return features.getSignatures(this.ctx);
	}

	async getDefaultSignature() {
		return features.getDefaultSignature(this.ctx);
	}

	async createSignature(name: string, bodyHtml: string, isDefault = false) {
		return features.createSignature(this.ctx, name, bodyHtml, isDefault);
	}

	async updateSignature(
		id: string,
		patch: { name?: string; body_html?: string; is_default?: boolean },
	) {
		return features.updateSignature(this.ctx, id, patch);
	}

	async deleteSignature(id: string) {
		return features.deleteSignature(this.ctx, id);
	}

	async setEmailPriority(id: string, priority: "high" | "low" | null) {
		if (!features.setEmailPriority(this.ctx, id, priority)) return null;
		return this.getEmail(id);
	}

	// ── Snooze ─────────────────────────────────────────────────────

	async snoozeEmail(id: string, untilIso: string) {
		if (!features.snoozeEmail(this.ctx, id, untilIso)) return null;
		await features.scheduleNextAlarm(this.ctx);
		return this.getEmail(id);
	}

	async unsnoozeEmail(id: string) {
		if (!features.unsnoozeEmail(this.ctx, id)) return null;
		return this.getEmail(id);
	}

	async getSnoozedEmails() {
		return features.getSnoozedEmails(this.ctx);
	}

	// ── Scheduled / undo send ──────────────────────────────────────

	/**
	 * Park an outbound message in the Scheduled folder for later delivery.
	 *
	 * It is stored as an ordinary email row so it stays searchable and keeps its
	 * attachments; `scheduled_sends` holds only the delivery state. Undo Send is
	 * this same mechanism with a short delay.
	 */
	async createScheduledEmail(
		email: EmailData,
		attachments: AttachmentData[],
		sendAtIso: string,
		/**
		 * What delivery needs to instrument the message for open/click tracking,
		 * captured while a request is still in hand. Absent (older callers, the
		 * MCP tool) falls back to `APP_URL` and the DO's own name.
		 */
		tracking?: { trackingBaseUrl?: string | null; mailboxId?: string | null; track?: boolean | null },
	) {
		await this.createEmail(Folders.SCHEDULED, { ...email, read: true }, attachments);
		features.recordScheduledSend(this.ctx, email.id, sendAtIso, {
			trackingBaseUrl: tracking?.trackingBaseUrl ?? null,
			mailboxId: tracking?.mailboxId ?? this.mailboxAddress(),
			track: tracking?.track ?? null,
		});
		await features.scheduleNextAlarm(this.ctx);
		return { email_id: email.id, send_at: sendAtIso, status: "pending" };
	}

	async listScheduledSends() {
		return features.listScheduledSends(this.ctx);
	}

	async cancelScheduledSend(emailId: string) {
		return features.cancelScheduledSend(this.ctx, emailId);
	}

	/**
	 * Deliver a queued message immediately instead of waiting out its delay.
	 *
	 * The quota check is handed over the same way the alarm hands it over, so an
	 * immediate send is bounded by the same hourly and daily limits.
	 */
	async sendScheduledNow(emailId: string) {
		try {
			return await features.sendScheduledSendNow(this.ctx, this.env, emailId, {
				checkRateLimit: () => this.checkSendRateLimit(),
			});
		} finally {
			this.queueWebhookFlush();
			// A sent message queues a summary refresh; make sure the alarm will
			// drain it even when nothing else is pending.
			await features.scheduleNextAlarm(this.ctx).catch(() => {});
		}
	}

	/** A feedback-loop complaint about a message this mailbox sent. See features.recordComplaint. */
	async recordComplaint(
		originalMessageId: string | null,
		reportedRecipient: string | null,
		detail: string | null,
	) {
		const result = features.recordComplaint(this.ctx, originalMessageId, reportedRecipient, detail);
		this.queueWebhookFlush();
		return result;
	}

	/** Configured send caps plus usage against them. See ./rate-limit.ts. */
	async getSendUsage() {
		return rateLimit.getSendUsage(this.ctx);
	}

	/** Store validated caps (shared/send-caps.ts `mergeSendCaps`). */
	async setSendCaps(caps: { hourly: number; daily: number }, updatedBy: string | null) {
		return rateLimit.setSendCaps(this.ctx, caps, updatedBy);
	}

	/**
	 * Correlate an inbound bounce back to the message it reports on.
	 *
	 * Called by the inbound handler when it recognises a delivery-status
	 * notification carrying a permanent failure. Returns null when this mailbox
	 * holds no sent message with that id, or when the report does not name a
	 * recipient that message was addressed to — both are ordinary, and the
	 * notification is stored and delivered either way, so the user can always
	 * read the raw bounce.
	 */
	async markBounced(
		originalMessageId: string | null,
		reason: string,
		reportedRecipient: string | null,
	) {
		const result = features.markBounced(
			this.ctx,
			originalMessageId,
			reason,
			reportedRecipient,
		);
		this.queueWebhookFlush();
		return result;
	}

	/**
	 * Record what actually happened when a message was handed to the provider.
	 *
	 * The send routes answer `202 {"status":"sent"}` and write the Sent copy
	 * BEFORE delivery is attempted, then perform the real `env.EMAIL.send()`
	 * inside `waitUntil`. For the whole life of this fork a rejection there
	 * reached nothing but `console.error`, so a message that was never delivered
	 * sat in Sent indistinguishable from one that was. This is the write-back that
	 * makes the outcome observable.
	 *
	 * On success it also stores the provider's own `Message-ID`. That is now the
	 * only id the outside world knows this message by — Email Service generates it
	 * and refuses to let us set our own — so it is the id an inbound reply will
	 * cite, and therefore the one `findThreadByMessageIds` and `markBounced` must
	 * match against.
	 */
	async recordDelivery(
		emailId: string,
		outcome: { providerMessageId?: string; error?: string },
	) {
		const result = features.recordDelivery(this.ctx, emailId, outcome);
		this.queueWebhookFlush();
		return result;
	}

	// ── Delivery-event ledger ──────────────────────────────────────

	/**
	 * Append one event to the delivery ledger. The single entry point every
	 * observer (DSN handler, GraphQL reconciler, tracking endpoint) reaches over
	 * RPC. Returns whether a row was written, so a deduped no-op is
	 * distinguishable from a real insert.
	 */
	async appendDeliveryEvent(event: DeliveryEventInput) {
		const wrote = features.appendDeliveryEvent(this.ctx, event);
		this.queueWebhookFlush();
		return wrote;
	}

	/** All ledger events for one message, oldest first — for the reading pane. */
	async getDeliveryEvents(emailId: string) {
		return features.getDeliveryEvents(this.ctx, emailId);
	}

	/**
	 * Bring `emails.delivery_status` forward from ledger events. Called after the
	 * reconciler appends provider verdicts, since a reconciled `delivered` is the
	 * one delivery signal that arrives via the ledger alone.
	 */
	async recomputeDeliveryStatus(emailId: string) {
		return features.recomputeDeliveryStatus(this.ctx, emailId);
	}

	/**
	 * File a batch of Cloudflare Email Service delivery verdicts into this
	 * mailbox's ledger. Called by the cron reconciler, which resolves the zone's
	 * events to their sending mailbox and hands each DO its own. Returns the count
	 * of genuinely-new ledger rows so the tick can log only when there was work.
	 */
	async reconcileProviderEvents(events: DeliveryEventInput[]) {
		const result = features.reconcileProviderEvents(this.ctx, events);
		if (result.applied > 0) this.queueWebhookFlush();
		return result;
	}

	// ── Tracking ───────────────────────────────────────────────────

	/** The mailbox's open/click/attachment toggles, for settings and the send path. */
	async getTrackingSettings() {
		return features.getTrackingSettings(this.ctx);
	}

	/** Patch the mailbox's tracking toggles; returns the resolved settings. */
	async updateTrackingSettings(
		patch: Partial<features.TrackingSettings>,
	) {
		return features.updateTrackingSettings(this.ctx, patch);
	}

	/**
	 * The mailbox's token-signing secret, minted on first use. Used by the send
	 * path to sign tracking tokens and by the public endpoint to verify them.
	 * Never exposed over a read API — it is a signing key.
	 */
	async getOrCreateTrackingSecret() {
		return features.getOrCreateTrackingSecret(this.ctx);
	}

	/**
	 * The mailbox's signing secret if it has one, without creating it. Used by the
	 * PUBLIC tracking endpoint, which must never allocate state from a token's
	 * unverified mailbox claim.
	 */
	async getTrackingSecret() {
		return features.getTrackingSecret(this.ctx);
	}

	/**
	 * Record an engagement event (open/click/attachment) from the public
	 * tracking endpoint. Returns whether the message still exists, so the
	 * endpoint can 404 a token naming a deleted message.
	 */
	async recordEngagement(event: DeliveryEventInput) {
		const recorded = features.recordEngagement(this.ctx, event);
		if (recorded) this.queueWebhookFlush();
		return recorded;
	}

	/**
	 * Aggregate this mailbox's outbound delivery + engagement over a date window,
	 * for the Sent-analytics panel. Read-only.
	 */
	async getSentAnalytics(window: { start: string; end: string }) {
		return features.getSentAnalytics(this.ctx, window);
	}

	/** Per-message and per-link engagement for the analytics console. Read-only. */
	async getEngagementAnalytics(window: { start: string; end: string }, limit = 50) {
		return analytics.getEngagement(this.ctx, window, limit);
	}

	/** Ledger-based sending counts (messages) for the analytics console. Read-only. */
	async getSendingAnalytics(window: { start: string; end: string }) {
		return analytics.getSendingStats(this.ctx, window);
	}

	/** Local inbound counts and parsed auth verdicts. Read-only. */
	async getInboundAnalytics(window: { start: string; end: string }) {
		return analytics.getInboundStats(this.ctx, window);
	}

	// ── Blocked senders ────────────────────────────────────────────

	async getBlockedSenders() {
		return features.getBlockedSenders(this.ctx);
	}

	async blockSender(pattern: string, reason: string | null = null) {
		return features.blockSender(this.ctx, pattern, reason);
	}

	async unblockSender(id: string) {
		return features.unblockSender(this.ctx, id);
	}

	async isSenderBlocked(senderAddress: string) {
		return features.isSenderBlocked(this.ctx, senderAddress);
	}

	/** Clear every block rule matching an address; returns the patterns removed. */
	async unblockSenderMatching(senderAddress: string) {
		return features.unblockSenderMatching(this.ctx, senderAddress);
	}

	// ── Allowed senders ────────────────────────────────────────────

	async getAllowedSenders() {
		return features.getAllowedSenders(this.ctx);
	}

	async allowSender(pattern: string, reason: string | null = null) {
		return features.allowSender(this.ctx, pattern, reason);
	}

	async disallowSender(id: string) {
		return features.disallowSender(this.ctx, id);
	}

	async isSenderAllowed(senderAddress: string) {
		return features.isSenderAllowed(this.ctx, senderAddress);
	}

	/**
	 * Rescue a message the filter got wrong.
	 *
	 * One RPC rather than three calls from the Worker because the three have to
	 * agree: moving the message without clearing the block leaves the next one
	 * going back to Spam, and clearing the block without allowlisting leaves the
	 * heuristics free to reach the same verdict again. Doing it in one place also
	 * keeps it a single storage transaction.
	 */
	async markNotSpam(emailId: string) {
		return features.markNotSpam(this.ctx, emailId);
	}

	// ── Bulk operations ────────────────────────────────────────────

	async bulkUpdateFlags(ids: string[], patch: { read?: boolean; starred?: boolean }) {
		return bulk.bulkUpdateFlags(this.ctx, ids, patch);
	}

	async bulkMoveEmails(ids: string[], folderId: string) {
		if (Array.isArray(ids)) this.#learn(() => triage.noteMoved(this.ctx, ids.slice(0, bulk.BULK_LIMIT), folderId));
		return bulk.bulkMove(this.ctx, ids, folderId, this.mailboxAddress());
	}

	/**
	 * Bulk delete: Trash-first, same rule as the single-message path.
	 *
	 * Returns the R2 keys of whatever was destroyed for the caller to clean up;
	 * see trash.deleteOrTrash.
	 */
	async bulkDeleteEmails(ids: string[], options: { permanent?: boolean } = {}) {
		const outcome = trash.deleteOrTrash(this.ctx, ids, options);
		this.#armSemanticSoon();
		return outcome;
	}

	async bulkSetLabel(ids: string[], labelId: string, add: boolean) {
		if (!add && Array.isArray(ids)) {
			for (const id of ids.slice(0, bulk.BULK_LIMIT)) {
				this.#learn(() => triage.noteLabelRemoved(this.ctx, id, labelId));
			}
		}
		return bulk.bulkSetLabel(this.ctx, ids, labelId, add);
	}

	async markAllRead(scope: bulk.MarkAllReadScope = {}) {
		return bulk.markAllRead(this.ctx, scope);
	}

	// ── Change polling ─────────────────────────────────────────────

	/**
	 * A cheap snapshot the client can poll to learn whether anything moved.
	 *
	 * Two single-row reads, so this is affordable every few seconds — which is
	 * the point: the UI can notice new mail quickly without refetching lists it
	 * already has. `version` is bumped by triggers on every write to `emails`.
	 */
	async getMailboxState() {
		const version = (
			this.ctx.storage.sql
				.exec(`SELECT version FROM mailbox_state WHERE id = 1`)
				.toArray()[0] as { version?: number } | undefined
		)?.version;

		// Both counts come from one scan of the `(folder_id, read)` index rather
		// than a second query: the client needs the high-priority figure to honour
		// its "only important mail" preference, and paying for another aggregate
		// every few seconds per open tab to get it would not be worth it.
		// Imported mail is excluded, so an import never fires a desktop
		// notification. See ./mail-import.ts.
		const counts = mailImport.inboxUnreadCounts(this.ctx);

		return {
			// A mailbox that predates migration 19 reports 0 rather than failing,
			// which the client treats as "no information" and keeps polling.
			version: version ?? 0,
			inboxUnread: counts.n,
			inboxUnreadHighPriority: counts.high,
		};
	}

	// ── Filter rules ───────────────────────────────────────────────

	async getRules() {
		return rules.getRules(this.ctx);
	}

	/** Only what the inbound path needs: enabled rules with real conditions. */
	async getEnabledRules() {
		return rules.getEnabledRules(this.ctx);
	}

	async createRule(input: rules.RuleInput) {
		return rules.createRule(this.ctx, input);
	}

	async updateRule(id: string, patch: Partial<rules.RuleInput>) {
		return rules.updateRule(this.ctx, id, patch);
	}

	async deleteRule(id: string) {
		return rules.deleteRule(this.ctx, id);
	}

	async reorderRules(ids: string[]) {
		return rules.reorderRules(this.ctx, ids);
	}

	/**
	 * Apply the label side of a rule outcome.
	 *
	 * Folder, read, starred and priority are set when the row is inserted, so
	 * they never need a second write. Labels cannot be: they are rows keyed by
	 * the email id, which only exists once the message has been stored.
	 */
	async applyRuleLabels(emailId: string, labelIds: string[]) {
		let applied = 0;
		for (const labelId of labelIds) {
			if (features.addEmailLabel(this.ctx, emailId, labelId)) applied += 1;
		}
		// Rules win over triage; the source is what says so. See ./triage.ts.
		triage.markRuleLabels(this.ctx, emailId, labelIds);
		return applied;
	}

	// ── AI triage and the Screener (./triage.ts) ───────────────────

	async listLabelPrompts() {
		return triage.listLabelPrompts(this.ctx);
	}

	async activeLabelPrompts() {
		return triage.activeLabelPrompts(this.ctx);
	}

	async tabLabels() {
		return triage.tabLabels(this.ctx);
	}

	async setLabelPrompt(labelId: string, patch: triage.LabelPromptPatch) {
		return triage.setLabelPrompt(this.ctx, labelId, patch);
	}

	async setTriagePreset(
		key: TriagePresetKey,
		options: { enabled: boolean; autoArchive?: boolean; showTab?: boolean },
	) {
		return triage.setPreset(this.ctx, key, options);
	}

	async triagePresets() {
		return triage.presetStatus(this.ctx);
	}

	async presetLabelId(key: TriagePresetKey) {
		return triage.presetLabelId(this.ctx, key);
	}

	async recentCorrections() {
		return triage.recentCorrections(this.ctx);
	}

	async triageStatus() {
		return {
			ai_calls_today: triage.aiUsageToday(this.ctx),
			corrections: triage.correctionCount(this.ctx),
			backfill_remaining: triage.backfillRemaining(this.ctx),
		};
	}

	async consumeAiBudget(cap: number, calls: number) {
		return triage.consumeAiBudget(this.ctx, cap, calls);
	}

	async applyTriage(
		emailId: string,
		labelIds: string[],
		source: "ai" | "heuristic",
		verdict?: { kind: string | null; confidence: string | null },
	) {
		return triage.applyTriage(this.ctx, emailId, labelIds, source, verdict);
	}

	async markTriaged(emailId: string, state: string) {
		triage.markTriaged(this.ctx, emailId, state);
	}

	async backfillCandidates(limit: number) {
		return triage.backfillCandidates(this.ctx, limit);
	}

	async backfillRemaining() {
		return triage.backfillRemaining(this.ctx);
	}

	async listScreener(limit?: number) {
		return triage.listScreener(this.ctx, limit);
	}

	/**
	 * Yes or No for a screened sender, with the allow/block list write and the
	 * backlog move in one transaction.
	 */
	async screenSender(sender: string, decision: triage.ScreenDecision, target: "spam" | "trash" = "spam") {
		// Screened mail is never summarised; a Yes makes it worth one.
		const threads = decision === "allow" ? triage.screenerThreadKeys(this.ctx, sender) : [];
		const result = triage.screenSender(this.ctx, sender, decision, target, triage.senderListOps(this.ctx));
		if (result) for (const key of threads) this.#queueSummary(key);
		return result;
	}

	// ── Muted conversations ────────────────────────────────────────

	async isThreadMuted(threadId: string | null) {
		return rules.isThreadMuted(this.ctx, threadId);
	}

	async muteThread(threadId: string) {
		rules.muteThread(this.ctx, threadId);
		return true;
	}

	async unmuteThread(threadId: string) {
		return rules.unmuteThread(this.ctx, threadId);
	}

	async listMutedThreads() {
		return rules.listMutedThreads(this.ctx);
	}

	// ── Auto-reply bookkeeping ─────────────────────────────────────

	/**
	 * Reserve an auto-reply to this address, returning false when one already
	 * went out inside the cooldown window. Claim and record are one call so two
	 * messages arriving together cannot both decide they are first.
	 */
	async claimAutoReply(recipient: string) {
		return rules.claimAutoReply(this.ctx, recipient);
	}

	// ── Follow-up reminders ────────────────────────────────────────

	async setFollowup(args: {
		emailId: string;
		followupAt: string;
		mode: "manual" | "auto";
		durationSeconds: number;
	}) {
		const row = followups.setFollowup(this.ctx, args);
		if (row) await features.scheduleNextAlarm(this.ctx);
		return row ? followups.getFollowup(this.ctx, row.email_id) : null;
	}

	async cancelFollowup(emailId: string) {
		const row = followups.cancelFollowup(this.ctx, emailId);
		return row ? followups.getFollowup(this.ctx, row.email_id) : null;
	}

	async getFollowup(emailId: string) {
		return followups.getFollowup(this.ctx, emailId);
	}

	async listFollowups(options: { status?: "pending" | "fired" | "active"; limit?: number } = {}) {
		return followups.listFollowups(this.ctx, options);
	}

	/**
	 * Ask the mailbox agent for a short nudge draft on each fired reminder, when
	 * the mailbox has `followups.draftNudge` on. Uses the auto-draft machinery
	 * (`EmailAgent /onFollowup`), which only ever writes to Drafts.
	 */
	async #requestNudgeDrafts(fired: followups.FiredFollowup[]): Promise<void> {
		const mailboxId = this.mailboxAddress();
		if (!mailboxId || !this.env.EMAIL_AGENT) return;
		try {
			const obj = await this.env.BUCKET.get(`mailboxes/${mailboxId}.json`);
			if (!obj) return;
			const settings = parseStoredMailboxSettings(await obj.json());
			if (!settings.followups.draftNudge || !settings.autoDraft.enabled) return;
			const agent = this.env.EMAIL_AGENT.get(this.env.EMAIL_AGENT.idFromName(mailboxId));
			for (const item of fired) {
				await agent
					.fetch(
						new Request("https://agents/onFollowup", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ mailboxId, ...item }),
						}),
					)
					.catch((e) => console.error("follow-up nudge trigger failed:", (e as Error).message));
			}
		} catch (e) {
			console.error("follow-up nudge drafts failed:", (e as Error).message);
		}
	}

	// ── Alarm ──────────────────────────────────────────────────────

	/**
	 * Single alarm shared by snooze expiry, scheduled delivery and follow-up
	 * reminders.
	 *
	 * The handlers are independent: a failure in one must not strand the
	 * others, and the alarm is always re-armed for whatever remains outstanding.
	 */
	async alarm(): Promise<void> {
		try {
			features.processDueSnoozes(this.ctx);
		} catch (e) {
			console.error("alarm: snooze processing failed:", (e as Error).message);
		}

		try {
			await features.processDueScheduledSends(this.ctx, this.env, {
				checkRateLimit: () => this.checkSendRateLimit(),
			});
		} catch (e) {
			console.error("alarm: scheduled send processing failed:", (e as Error).message);
		}

		/**
		 * Retention sweep for the bin.
		 *
		 * Piggybacks on an alarm that already fires for snoozes and scheduled
		 * sends, so a mailbox with neither only sweeps when something else wakes
		 * it — which is fine: the guarantee is "eventually", not "to the minute".
		 */
		const policy = await this.#retentionPolicy();
		try {
			const purged = trash.purgeExpiredTrash(this.ctx, { retentionDays: policy.trashDays });
			if (purged.deleted > 0) {
				console.log(
					`alarm: purged ${purged.deleted} message(s) past the ${policy.trashDays}-day bin retention.`,
				);
			}
			// R2 blobs outlive the rows, so they are deleted here rather than left
			// to accumulate as orphans nobody can reach.
			for (const key of purged.attachmentKeys) {
				try {
					await this.env.BUCKET.delete(key);
				} catch (e) {
					console.error(
						`alarm: failed to delete attachment ${key}:`,
						(e as Error).message,
					);
				}
			}
		} catch (e) {
			console.error("alarm: trash retention sweep failed:", (e as Error).message);
		}

		// Expired idempotency keys. Also swept lazily on every keyed request.
		try {
			sweepIdempotencyKeys(this.ctx.storage.sql);
		} catch (e) {
			console.error("alarm: idempotency sweep failed:", (e as Error).message);
		}

		/**
		 * Follow-up reminders. Independent of the handlers above for the same
		 * reason they are independent of each other. A fired reminder optionally
		 * asks the agent for a nudge draft, which never sends.
		 */
		try {
			const fired = followups.processDueFollowups(this.ctx);
			if (fired.length > 0) {
				console.log(`alarm: ${fired.length} follow-up reminder(s) returned to the inbox.`);
				this.ctx.waitUntil(this.#requestNudgeDrafts(fired));
				const mailboxId = this.mailboxAddress();
				if (mailboxId) this.ctx.waitUntil(notifyFollowups(this.env, mailboxId, fired).then(() => {}, () => {}));
			}
		} catch (e) {
			console.error("alarm: follow-up processing failed:", (e as Error).message);
		}

		/**
		 * The post-ingest AI job, part one: per-message classification (auto
		 * labels, Screener verdict). Before summaries, so a message triage
		 * auto-archives is summarised where it ended up. Bounded per run; more
		 * waiting re-arms the alarm. See ./triage.ts and ../lib/triage.ts.
		 */
		/**
		 * One wall-clock budget for the AI work below (triage, summaries,
		 * semantic indexing). Each drain stops starting new items once it is
		 * spent and the alarm re-arms for what is left, so a slow provider
		 * cannot stretch a run past ~25 s on top of the per-call timeouts.
		 */
		const aiBudget = new AiWorkBudget();

		let triageMore = false;
		try {
			if (triage.pendingTriageCount(this.ctx) > 0) {
				await drainTriageQueue(
					// The router counts each call per feature (../lib/ai-router.ts).
					this.env,
					triage.localTriageStub(this.ctx),
					{
						take: (limit) => triage.takeTriageBatch(this.ctx, limit),
						release: (ids) => triage.releaseTriage(this.ctx, ids),
						finish: (id, outcome) => triage.finishTriage(this.ctx, id, outcome),
					},
					// From the queue row: `ctx.id.name` is not available in an alarm.
					await readMailboxSettings(this.env, triage.queuedMailboxId(this.ctx) ?? this.mailboxAddress() ?? ""),
					undefined,
					aiBudget,
				);
				triageMore = triage.pendingTriageCount(this.ctx) > 0;
			}
		} catch (e) {
			console.error("alarm: triage processing failed:", (e as Error).message);
		}

		// Web Push for mail that waited on triage (./push-queue.ts). After triage,
		// so a message an auto-archiving label moved is not notified about.
		let pushMore: number | null = null;
		try {
			if (pushQueue.pendingPushCount(this.ctx) > 0) {
				for (const ready of pushQueue.takeReadyPushes(this.ctx)) {
					if (!ready.facts) continue;
					this.ctx.waitUntil(
						notifyNewMail(this.env, { mailboxId: ready.mailboxId, deliveredTo: ready.deliveredTo, facts: ready.facts }).then(
							() => {},
							() => {},
						),
					);
				}
				pushMore = pushQueue.nextPushCheckAt(this.ctx);
			}
		} catch (e) {
			console.error("alarm: push processing failed:", (e as Error).message);
		}

		// AI thread summaries, part two of the same job. After sends, so a
		// message that just went out is part of the conversation it summarises.
		// Bounded per run.
		let summaryNext: number | null = null;
		try {
			if (summaries.pendingSummaryCount(this.ctx) > 0) {
				const run = await this.processSummaries(undefined, aiBudget);
				summaryNext = run.nextRunAt;
			}
		} catch (e) {
			console.error("alarm: summary processing failed:", (e as Error).message);
			// Back the whole queue off, or the shared alarm would re-fire at once.
			summaries.deferSummaryQueue(this.ctx, 5 * 60_000);
		}

		// Semantic indexing, part three of the post-ingest job, and vector
		// deletes for mail purged above (the retention sweep included). After
		// triage, so a message triage moved to Spam is never embedded.
		let semanticNext: number | null = null;
		try {
			if (semantic.pendingSemanticCount(this.ctx) > 0) {
				const run = await this.processSemantic(undefined, aiBudget);
				semanticNext = run.nextRunAt;
			}
		} catch (e) {
			console.error("alarm: semantic indexing failed:", (e as Error).message);
		}

		// Retention continuation: a purge pass that filled its batch re-arms the
		// alarm and finishes here, one bounded batch per wake.
		let moreRetention = false;
		if ((await this.ctx.storage.get<boolean>(RETENTION_PENDING_KEY)) === true) {
			try {
				moreRetention = this.#purgeEventsBatch(policy);
			} catch (e) {
				console.error("alarm: retention purge failed:", (e as Error).message);
			}
		}
		try {
			approvals.sweepApprovals(this.ctx);
		} catch (e) {
			console.error("alarm: approval sweep failed:", (e as Error).message);
		}

		// Scheduled and undo-window sends recorded their outcome above.
		this.queueWebhookFlush();

		/**
		 * Mail import: one bounded step (about 20 s or 250 messages), last so
		 * everything time-sensitive above has already run. The cursor is saved
		 * after every message, so an eviction mid-step costs nothing but a re-read.
		 */
		let importMore = false;
		try {
			importMore = await this.#runImportAlarm();
		} catch (e) {
			console.error("alarm: import step failed:", (e as Error).message);
			importMore = mailImport.hasRunnableJob(this.ctx);
		}

		await features.scheduleNextAlarm(this.ctx);
		if (importMore) await this.#armImport();
		if (summaryNext !== null) await summaries.armAlarmAt(this.ctx, summaryNext);
		if (semanticNext !== null) await summaries.armAlarmAt(this.ctx, semanticNext);
		if (moreRetention) await this.#armRetentionContinuation();
		if (triageMore) await summaries.armAlarmAt(this.ctx, Date.now() + triage.TRIAGE_DELAY_MS);
		if (pushMore !== null) await summaries.armAlarmAt(this.ctx, pushMore);
	}

	// ── Retention ──────────────────────────────────────────────────

	/** The policy the cron last pushed, or the defaults. */
	async #retentionPolicy(): Promise<RetentionPolicy> {
		return normalizeRetention(await this.ctx.storage.get(retention.RETENTION_POLICY_KEY));
	}

	/** One bounded batch of event purging. Returns whether more remains. */
	#purgeEventsBatch(policy: RetentionPolicy): boolean {
		const result = retention.purgeExpiredEvents(this.ctx, policy);
		if (result.trackingEvents || result.deliveryEvents) {
			console.log(
				`retention [${this.mailboxAddress() ?? "?"}]: tracking_events=${result.trackingEvents} delivery_events=${result.deliveryEvents}${result.more ? " (more)" : ""}`,
			);
		}
		return result.more;
	}

	/** Fire the alarm soon to continue a purge; never pushes back an earlier one. */
	async #armRetentionContinuation(): Promise<void> {
		await this.ctx.storage.put(RETENTION_PENDING_KEY, true);
		const when = Date.now() + RETENTION_CONTINUE_MS;
		const existing = await this.ctx.storage.getAlarm();
		if (existing === null || when < existing) await this.ctx.storage.setAlarm(when);
	}

	/**
	 * Apply the deployment's retention policy to this mailbox. Called by the
	 * daily cron pass with the operator's settings. Runs one bounded batch of
	 * event purging and the trash sweep now; when a batch fills, the alarm
	 * finishes the rest in further bounded batches.
	 */
	async applyRetention(policyInput: RetentionPolicy) {
		const policy = normalizeRetention(policyInput);
		await this.ctx.storage.put(retention.RETENTION_POLICY_KEY, policy);
		const events = retention.purgeExpiredEvents(this.ctx, policy);
		const binned = trash.purgeExpiredTrash(this.ctx, { retentionDays: policy.trashDays });
		for (const key of binned.attachmentKeys) {
			await this.env.BUCKET.delete(key).catch((e: unknown) =>
				console.error(`retention: failed to delete attachment ${key}:`, (e as Error).message),
			);
		}
		if (events.more) await this.#armRetentionContinuation();
		else await this.ctx.storage.delete(RETENTION_PENDING_KEY);
		// Purged mail's vectors are queued by trigger; the alarm deletes them.
		this.#armSemanticSoon();
		return {
			trackingEvents: events.trackingEvents,
			deliveryEvents: events.deliveryEvents,
			trash: binned.deleted,
			more: events.more,
		};
	}

	/**
	 * Queue a stored message for the post-ingest pass. The inbound handler
	 * calls this after `createEmail` when the mailbox has triage or the
	 * Screener verdict on; the alarm does the work.
	 */
	// ── Web Push ───────────────────────────────────────────────────
	//
	// See ./push-queue.ts and ../lib/push.ts.

	/**
	 * Decide when to notify about a message just stored: now (returns its
	 * facts for the caller to dispatch), or after triage (parks it and returns
	 * null). Called by `receiveEmail` after `enqueueTriage`.
	 */
	async preparePush(emailId: string, mailboxId: string, deliveredTo: string, triageQueued: boolean) {
		// The caller says whether triage was queued: its enqueue runs in the
		// background and may not have landed in `triage_queue` yet.
		if (triageQueued && pushQueue.hasAutoArchiveLabel(this.ctx)) {
			pushQueue.parkPush(this.ctx, emailId, mailboxId, deliveredTo);
			return null;
		}
		return pushQueue.pushFacts(this.ctx, emailId);
	}

	async enqueueTriage(emailId: string, mailboxId: string) {
		triage.enqueueTriage(this.ctx, emailId, mailboxId);
		await summaries.armAlarmAt(this.ctx, Date.now() + triage.TRIAGE_DELAY_MS);
	}

	// ── Cross-namespace transfer ───────────────────────────────────
	//
	// Used by the one-off /api/v1/_migrate/* routes. `exportAll` and `stats` are
	// invoked on a *retired* deployment's namespace, so they must tolerate an
	// older schema; see ./transfer.ts.

	async stats() {
		return transfer.stats(this.ctx);
	}

	async exportAll() {
		return transfer.exportAll(this.ctx);
	}

	// ── Owner-facing export ────────────────────────────────────────

	/**
	 * One page of full messages, oldest first, for the mbox export.
	 *
	 * Deliberately *not* `exportAll`, which materialises every row in memory and
	 * returns it as one RPC response. That is fine for the migration path it was
	 * written for, where the operator picks the moment, and wrong for an export a
	 * reader can trigger on a mailbox of any size: bodies dominate the payload, so
	 * a large mailbox would exceed the response limit and fail — worst of all
	 * *only* for the people with the most mail to lose.
	 *
	 * Keyed on `(date, id)` rather than an offset. Offset paging over a table that
	 * is still receiving mail re-reads and skips rows as the earlier pages shift,
	 * so a message arriving mid-export can push another out of the archive
	 * entirely. `id` breaks ties, because `date` is not unique — a bulk send lands
	 * many rows on the same timestamp.
	 *
	 * Attachment metadata is joined per page rather than per message: one query for
	 * the page instead of one per row.
	 */
	async exportPage(options: { limit?: number; afterDate?: string; afterId?: string } = {}) {
		const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

		/**
		 * Most body bytes one page may carry.
		 *
		 * A row count alone does not bound memory: a body may approach
		 * `MAX_MESSAGE_BYTES` (5 MiB), so 50 rows could be 250 MiB, and the Worker
		 * then builds an encoded copy of each — defeating the streaming this method
		 * exists to serve.
		 */
		const BYTE_BUDGET = 8 * 1024 * 1024;

		/**
		 * Sizes first, bodies second.
		 *
		 * The budget has to be decided *before* the bodies are materialized. An
		 * earlier version selected `*` and trimmed the array afterwards, which read
		 * every full body into memory first — so the page it discarded had already
		 * cost what the budget was there to prevent, and the export still fell over
		 * on exactly the large-mail case it was meant to handle.
		 *
		 * `LENGTH(CAST(body AS BLOB))` is bytes rather than characters: `LENGTH()` on
		 * text counts code points, so a body of CJK or accented text would report a
		 * fraction of its real cost.
		 *
		 * `COALESCE(date, '')` is the sort key in both the ORDER BY and the cursor
		 * predicate. `emails.date` is nullable, and a bare `date > ?` comparison is
		 * *false* for every NULL — so once a cursor was taken from a null-dated row
		 * the next page skipped the rest of them silently and resumed at dated rows.
		 * Coalescing on both sides keeps the ordering total and the cursor honest.
		 */
		const keys = (
			options.afterDate === undefined
				? this.ctx.storage.sql.exec(
						`SELECT id, COALESCE(date, '') AS sort_date,
						        LENGTH(CAST(COALESCE(body, '') AS BLOB)) AS body_bytes
						   FROM emails
						  ORDER BY sort_date ASC, id ASC
						  LIMIT ?`,
						limit,
					)
				: this.ctx.storage.sql.exec(
						`SELECT id, COALESCE(date, '') AS sort_date,
						        LENGTH(CAST(COALESCE(body, '') AS BLOB)) AS body_bytes
						   FROM emails
						  WHERE (COALESCE(date, '') > ?1)
						     OR (COALESCE(date, '') = ?1 AND id > ?2)
						  ORDER BY sort_date ASC, id ASC
						  LIMIT ?3`,
						options.afterDate,
						options.afterId ?? "",
						limit,
					)
		).toArray() as unknown as { id: string; sort_date: string; body_bytes: number }[];

		/**
		 * Which of those keys fit.
		 *
		 * Truncating the page, not the export: the cursor comes from the last key
		 * *kept*, so anything dropped here is read again on the next pull. The first
		 * row is always kept even if it exceeds the budget alone, because a page of
		 * zero rows reads as the end of the mailbox and would silently stop the
		 * archive at the first large message.
		 */
		const chosen: { id: string; sort_date: string }[] = [];
		let bytes = 0;
		for (const key of keys) {
			const size = Number(key.body_bytes) || 0;
			if (chosen.length > 0 && bytes + size > BYTE_BUDGET) break;
			chosen.push({ id: key.id, sort_date: key.sort_date });
			bytes += size;
		}

		if (chosen.length === 0) return { messages: [], attachments: {}, done: true };

		// Now the bodies, for the chosen ids only, in the same order.
		const chosenIds = chosen.map((key) => key.id);
		const idPlaceholders = chosenIds.map(() => "?").join(", ");
		const fetched = this.ctx.storage.sql
			.exec(
				`SELECT * FROM emails WHERE id IN (${idPlaceholders})`,
				...chosenIds,
			)
			.toArray() as unknown as Record<string, unknown>[];

		// `IN` does not preserve order, and an mbox archive should read
		// chronologically, so the rows are put back into the key order above.
		const byId = new Map(fetched.map((row) => [String(row.id), row]));
		const rows = chosenIds
			.map((id) => byId.get(id))
			.filter((row): row is Record<string, unknown> => row !== undefined);

		if (rows.length === 0) return { messages: [], attachments: {}, done: true };

		const ids = rows.map((row) => String(row.id));
		const placeholders = ids.map(() => "?").join(", ");
		const attachmentRows = this.ctx.storage.sql
			.exec(
				`SELECT email_id, filename, mimetype, size FROM attachments
				 WHERE email_id IN (${placeholders})`,
				...ids,
			)
			.toArray() as unknown as {
			email_id: string;
			filename: string;
			mimetype: string;
			size: number;
		}[];

		const attachments: Record<
			string,
			{ filename: string; mimetype: string; size: number }[]
		> = {};
		for (const row of attachmentRows) {
			(attachments[row.email_id] ??= []).push({
				filename: row.filename,
				mimetype: row.mimetype,
				size: row.size,
			});
		}

		const last = chosen[chosen.length - 1]!;
		return {
			messages: rows,
			attachments,
			/**
			 * The end of the mailbox, as opposed to the end of this page.
			 *
			 * A short page means the end *only* when the query itself ran out of keys.
			 * A page shortened by the byte budget is not the end — reporting it as
			 * such would stop the export at the first large message and hand the
			 * reader a truncated archive that looked complete.
			 *
			 * A full page might still be the end, in which case the next call returns
			 * nothing and stops: one wasted query rather than a guess.
			 */
			done: keys.length < limit && chosen.length === keys.length,
			/**
			 * The cursor carries the *coalesced* sort key, not the raw column.
			 *
			 * A null-dated row yields `''` here, which is exactly what the next page's
			 * `COALESCE(date, '') > ?` predicate compares against — so those rows are
			 * walked through rather than skipped.
			 */
			cursor: { date: last.sort_date, id: last.id },
		};
	}

	/**
	 * Aggregate delivery analytics for messages in the Sent folder.
	 *
	 * Returns counts by delivery status and date breakdown for charting.
	 */
	async getAnalytics(options: { days?: number } = {}): Promise<{
		total: number;
		delivered: number;
		failed: number;
		bounced: number;
		pending: number;
		byDate: { date: string; sent: number; delivered: number; failed: number }[];
	}> {
		const days = options.days ?? 30;
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

		const rows = this.ctx.storage.sql
			.exec(
				`SELECT
					COUNT(*) AS total,
					SUM(CASE WHEN delivery_status IS NULL OR delivery_status IN ('queued', 'sent', 'delivered') THEN 1 ELSE 0 END) AS delivered,
					SUM(CASE WHEN delivery_status = 'failed' THEN 1 ELSE 0 END) AS failed,
					SUM(CASE WHEN delivery_status = 'bounced' THEN 1 ELSE 0 END) AS bounced
				FROM emails
				WHERE folder_id = 'sent'
				  AND date >= ?`,
				cutoff,
			)
			.toArray()[0] as any;

		// Count scheduled sends that haven't gone out yet
		const pendingRow = this.ctx.storage.sql
			.exec(
				`SELECT COUNT(*) AS pending
				FROM emails
				WHERE folder_id = 'scheduled'
				  AND date >= ?`,
				cutoff,
			)
			.toArray()[0] as any;

		const byDateRows = this.ctx.storage.sql
			.exec(
				`SELECT
					substr(date, 1, 10) AS day,
					COUNT(*) AS sent,
					SUM(CASE WHEN delivery_status IS NULL OR delivery_status IN ('queued', 'sent', 'delivered') THEN 1 ELSE 0 END) AS delivered,
					SUM(CASE WHEN delivery_status IN ('failed', 'bounced') THEN 1 ELSE 0 END) AS failed
				FROM emails
				WHERE folder_id = 'sent'
				  AND date >= ?
				GROUP BY day
				ORDER BY day ASC`,
				cutoff,
			)
			.toArray() as any[];

		return {
			total: Number(rows?.total ?? 0),
			delivered: Number(rows?.delivered ?? 0),
			failed: Number(rows?.failed ?? 0),
			bounced: Number(rows?.bounced ?? 0),
			pending: Number(pendingRow?.pending ?? 0),
			byDate: byDateRows.map((r: any) => ({
				date: r.day,
				sent: Number(r.sent),
				delivered: Number(r.delivered),
				failed: Number(r.failed),
			})),
		};
	}

	/** How many messages an export will contain, for the caller to report. */
	async countAllEmails(): Promise<number> {
		const row = this.ctx.storage.sql
			.exec(`SELECT COUNT(*) AS total FROM emails`)
			.toArray()[0] as { total: number } | undefined;
		return row?.total ?? 0;
	}

	async importAll(payload: transfer.ExportShape) {
		return transfer.importAll(this.ctx, payload);
	}

	// ── Destruction ────────────────────────────────────────────────

	/**
	 * Erase every trace of this mailbox and report the R2 attachment keys the
	 * caller must delete.
	 *
	 * Attachment blobs cannot be cleaned up with a single prefix delete: the R2
	 * bucket is shared by every mailbox and keys are `attachments/{emailId}/...`,
	 * so a prefix sweep would destroy other mailboxes' data. The key list has to
	 * come from this object's own tables, which is why it is returned rather
	 * than deleted here (Durable Objects have no bucket binding of their own in
	 * this design).
	 *
	 * The tables are dropped and the migrations re-run rather than emptied with
	 * DELETE, because `MAILBOX.idFromName(address)` means re-creating a mailbox
	 * at the same address lands on this same object. It must be left in exactly
	 * the state a brand-new mailbox would be in, seeded folders included.
	 */
	async purge(): Promise<string[]> {
		// Vectors first: dropping the tables below bypasses the delete trigger
		// that normally queues them, and afterwards nothing knows their ids.
		// Covers mailbox delete, agent inbox expiry and account deletion, which
		// all end here. A Vectorize failure must not block the purge.
		try {
			await semantic.purgeAllVectors(this.ctx, semanticIndex(this.env));
		} catch (e) {
			console.error("purge: vector cleanup failed:", (e as Error).message);
		}

		// Consume the cursor synchronously — cursors held across an await have no
		// snapshot isolation guarantees.
		const rows = this.ctx.storage.sql
			.exec(`SELECT email_id, id, filename FROM attachments`)
			.toArray() as { email_id: string; id: string; filename: string }[];

		const attachmentKeys = rows.map((row) =>
			attachmentKey(row.email_id, row.id, row.filename),
		);

		// Derived from sqlite_master rather than listed here: a hand-maintained
		// list had already fallen six tables behind the schema, and the one it
		// missed that mattered was `emails_fts`, whose stale rowids then collided
		// with the rebuilt `emails` table. See `dropAllTables`.
		dropAllTables(this.ctx.storage.sql);

		// Sweep up key-value entries and any pending alarm the tables did not hold.
		try {
			await this.ctx.storage.deleteAll();
		} catch (e) {
			console.error("purge: deleteAll failed:", (e as Error).message);
		}

		applyMigrations(this.ctx.storage.sql, mailboxMigrations, this.ctx.storage);

		return attachmentKeys;
	}

	// ── Email creation (Drizzle) ───────────────────────────────────

	async createEmail(
		folder: string,
		email: EmailData,
		attachments: AttachmentData[],
	) {
		// Resolve folder name or ID to the actual folder ID.
		const folderRow = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(or(eq(schema.folders.id, folder), eq(schema.folders.name, folder)))
			.limit(1)
			.get();

		if (!folderRow) {
			throw new Error(
				`createEmail: folder "${folder}" not found. ` +
					"Ensure the folder exists before inserting an email.",
			);
		}

		const folderId = folderRow.id;
		const isSent = folderId === Folders.SENT;
		const derivedColumns = derived.deriveColumns(email);

		// Sent emails are always read — the sender obviously knows what they wrote.
		// This prevents sent replies from inflating thread_unread_count.
		this.db
			.insert(schema.emails)
			.values({
				id: email.id,
				folder_id: folderId,
				subject: email.subject,
				sender: email.sender,
				recipient: email.recipient,
				cc: email.cc ?? null,
				bcc: email.bcc ?? null,
				date: email.date,
				read: isSent ? 1 : (email.read ? 1 : 0),
				starred: email.starred ? 1 : 0,
				body: email.body,
				in_reply_to: email.in_reply_to ?? null,
				email_references: email.email_references ?? null,
				thread_id: email.thread_id ?? null,
				message_id: email.message_id ?? null,
				raw_headers: email.raw_headers ?? null,
				priority: email.priority ?? null,
				spam_score: email.spam_score ?? null,
				spam_signals: email.spam_signals ?? null,
				security_warnings: email.security_warnings ?? null,
				snippet: derivedColumns.snippet,
				sender_name: derivedColumns.sender_name,
				derived_v: derived.DERIVED_VERSION,
				delivery_status: email.delivery_status ?? null,
			})
			.run();

		if (attachments.length > 0) {
			this.db.insert(schema.attachments).values(attachments).run();
		}

		// An inbound reply cancels a follow-up reminder in its thread; replying
		// again yourself restarts it. Never throws. See ./followups.ts.
		if (followups.onEmailStored(this.ctx, {
			id: email.id,
			folder_id: folderId,
			thread_id: email.thread_id ?? null,
			raw_headers: email.raw_headers ?? null,
		}) === "reset") {
			await features.scheduleNextAlarm(this.ctx);
		}
		// Inbound or sent: the conversation changed, so its summary is refreshed
		// in the background. Drafts, Scheduled, Trash and Spam never trigger one.
		if (summaries.folderTriggersSummary(folderId)) {
			this.#queueSummary(email.thread_id ?? email.id);
		}
		// Semantic index, same job. Never Spam, Trash, Drafts or the Screener.
		if (semantic.folderTriggersSemantic(folderId)) {
			this.#queueSemantic(email.id);
		}
	}

	// ── Semantic search (./semantic.ts) ────────────────────────────

	/** Whether indexing can run at all here: a bound index, a model, and an address. */
	#semanticReady(): boolean {
		return !!semanticIndex(this.env) && aiAvailable(this.env);
	}

	#queueSemantic(emailId: string): void {
		const mailbox = this.mailboxAddress();
		// No binding: nothing is queued, so a deployment without the index pays nothing.
		if (!mailbox || !this.#semanticReady()) return;
		try {
			semantic.enqueueSemantic(this.ctx, emailId, mailbox);
			this.ctx.waitUntil(
				summaries
					.armAlarmAt(this.ctx, Date.now() + semantic.SEMANTIC_DEBOUNCE_MS)
					.catch((e) => console.error("semantic alarm arm failed:", (e as Error).message)),
			);
		} catch (e) {
			console.error("semantic enqueue failed:", (e as Error).message);
		}
	}

	/** Arm the alarm when vector deletes or re-index work is waiting. */
	#armSemanticSoon(): void {
		try {
			if (semantic.pendingSemanticCount(this.ctx) === 0) return;
			this.ctx.waitUntil(summaries.armAlarmAt(this.ctx, Date.now() + 2_000).catch(() => {}));
		} catch {
			// No table yet: nothing pending.
		}
	}

	#semanticBackfillChecked = false;
	#maybeBackfillSemantic(): void {
		if (this.#semanticBackfillChecked) return;
		this.#semanticBackfillChecked = true;
		const mailbox = this.mailboxAddress();
		if (!mailbox || !this.#semanticReady()) return;
		try {
			if (semantic.maybeQueueSemanticBackfill(this.ctx, mailbox) > 0) {
				this.ctx.waitUntil(
					summaries.armAlarmAt(this.ctx, Date.now() + semantic.SEMANTIC_DEBOUNCE_MS).catch(() => {}),
				);
			}
		} catch (e) {
			console.error("semantic backfill check failed:", (e as Error).message);
		}
	}

	/** Drain the queue now, bounded. The alarm does this normally. */
	async processSemantic(batch?: number, budget?: AiWorkBudget) {
		return semantic.processSemanticQueue(this.ctx, {
			// "Semantic search off" with a gateway active: no model, so the backlog is dropped.
			ai: (await roleEnabled(this.env, "embeddings")) ? aiFor(this.env, { feature: "semantic" }) : undefined,
			index: semanticIndex(this.env),
			config: await getAiConfig(this.env.BUCKET),
			batch,
			budget,
		});
	}

	/**
	 * Messages behind vector matches, from this mailbox only (the hydration
	 * half of the authz filter; see ./semantic.ts `hydrateHits`).
	 */
	async hydrateSemanticHits(ids: string[], options: { includeAll?: boolean; bodyChars?: number } = {}) {
		return semantic.hydrateHits(this.ctx, Array.isArray(ids) ? ids : [], options);
	}

	/** Count one hybrid query against this mailbox, for the usage line. */
	async recordSemanticQuery() {
		try {
			semantic.recordSemanticUsage(this.ctx, { queries: 1 });
		} catch {
			// Pre-migration mailbox: nothing to count into.
		}
	}

	/** The embedding model this mailbox's vectors came from, for the search's model check. */
	async semanticEmbeddingModel(): Promise<string> {
		try {
			return semantic.searchableEmbeddingModel(this.ctx) ?? "reindexing";
		} catch {
			return "unstamped";
		}
	}

	async semanticStatus() {
		return semantic.semanticStatus(this.ctx);
	}

	// ── AI thread summaries ────────────────────────────────────────
	//
	// See ./summaries.ts. Enqueue is synchronous SQL; generation happens in the
	// alarm, so storing mail never waits on a model.

	#queueSummary(threadKey: string): void {
		try {
			summaries.enqueueSummary(this.ctx, threadKey);
			this.ctx.waitUntil(
				summaries
					.armAlarmAt(this.ctx, Date.now() + summaries.SUMMARY_DEBOUNCE_MS)
					.catch((e) => console.error("summary alarm arm failed:", (e as Error).message)),
			);
		} catch (e) {
			console.error("summary enqueue failed:", (e as Error).message);
		}
	}

	/**
	 * Queue the newest conversations for a one-off backfill, then let the alarm
	 * drain them under the daily cap. Called from the list path; cheap after the
	 * first time (one indexed lookup).
	 */
	#backfillChecked = false;
	#maybeBackfillSummaries(): void {
		if (this.#backfillChecked) return;
		this.#backfillChecked = true;
		try {
			const queued = summaries.maybeQueueBackfill(this.ctx);
			if (queued > 0) {
				this.ctx.waitUntil(
					summaries
						.armAlarmAt(this.ctx, Date.now() + summaries.SUMMARY_DEBOUNCE_MS)
						.catch(() => {}),
				);
			}
		} catch (e) {
			console.error("summary backfill check failed:", (e as Error).message);
		}
	}

	/** The reader's summary for one conversation, or null. */
	async getThreadSummary(threadId: string) {
		return summaries.getThreadSummary(this.ctx, threadId);
	}

	/** Queue a regeneration on request (the reader's "refresh" for a stale summary). */
	async requestThreadSummary(threadId: string) {
		if (summaries.countableMessages(this.ctx, threadId) === 0) return { queued: false };
		this.#queueSummary(threadId);
		return { queued: true };
	}

	/**
	 * The reader's "Summarize" button: generate this conversation's summary now,
	 * under the daily cap. A failure leaves it queued for the alarm.
	 */
	async summarizeThreadNow(threadId: string) {
		const outcome = await summaries.summarizeThreadNow(this.ctx, threadId, {
			ai: aiAvailable(this.env) ? aiFor(this.env, { feature: "summaries" }) : undefined,
			config: await getAiConfig(this.env.BUCKET),
			mailboxAddress: this.mailboxAddress(),
			model: this.env.SUMMARY_MODEL,
		});
		if (summaries.pendingSummaryCount(this.ctx) > 0) {
			await summaries.armAlarmAt(this.ctx, Date.now() + summaries.SUMMARY_DEBOUNCE_MS);
		}
		return outcome;
	}

	/** Drain the queue now, bounded. For operators and tests; the alarm does this normally. */
	async processSummaries(batch?: number, budget?: AiWorkBudget) {
		return summaries.processSummaryQueue(this.ctx, {
			ai: aiAvailable(this.env) ? aiFor(this.env, { feature: "summaries" }) : undefined,
			config: await getAiConfig(this.env.BUCKET),
			mailboxAddress: this.mailboxAddress(),
			model: this.env.SUMMARY_MODEL,
			batch,
			budget,
		});
	}

	/** This mailbox's slice of a daily brief. */
	async getBriefData(input: { mailbox: string; since: string; until: string }) {
		const threads = (await this.getThreadedEmails({
			folder: Folders.INBOX,
			limit: 100,
		})) as { id: string; thread_id: string | null; subject: string | null; sender: string | null; sender_name: string | null; date: string; needs_reply?: boolean; has_draft?: boolean }[];
		return collectBriefData(this.ctx, {
			...input,
			needsReply: threads.filter((t) => t.needs_reply && !t.has_draft),
		});
	}
}
