// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Thread summaries inside a MailboxDO (migration 34).
 *
 * ## Flow
 *
 * Storing a message (`createEmail`, or a scheduled send going out) calls
 * `enqueueSummary`, which writes one row per conversation to `summary_queue`
 * and arms the mailbox alarm a few seconds out. The alarm drains a bounded
 * batch through `processSummaryQueue`, which:
 *
 *   1. counts the conversation's countable messages (not Drafts, Scheduled,
 *      Trash or Spam), and drops the summary when none remain;
 *   2. skips the model entirely when the stored summary was generated from the
 *      same count and recipe version (regenerate only when the count changes);
 *   3. stops for the day when the per-mailbox cap is spent;
 *   4. otherwise calls `summarizeThread` (one model call for the one-liner and
 *      the three bullets) and upserts the result.
 *
 * The reader's "Summarize" button runs the same pass for one conversation,
 * right away (`summarizeThreadNow`), under the same cap.
 *
 * No Cloudflare Queue: the deployment has none, the alarm already exists, and a
 * per-mailbox backlog keyed by thread collapses a burst of replies into one call.
 *
 * ## Backfill
 *
 * The newest `BACKFILL_THREADS` conversations are queued once per mailbox, the
 * first time its inbox list is read after deploy (`maybeQueueBackfill`), at a
 * lower priority than live mail. The marker carries `SUMMARY_VERSION`, so a
 * recipe bump re-queues those conversations the same way (rows already at the
 * new version are skipped). Backfill drains one batch per `BACKFILL_PACE_MS`,
 * and the daily cap bounds it like everything else. Older conversations pick
 * up the new recipe the next time they get mail.
 *
 * Plain functions over `DurableObjectState`, so the real SQL runs against
 * `node:sqlite` in tests with a mocked `AI` binding.
 */

import { Folders } from "../../shared/folders";
import { parseStoredHeaders } from "../../shared/headers";
import {
	SUMMARY_VERSION,
	MAX_SUMMARY_MESSAGES,
	isBulkMail,
	readStoredBullets,
	summaryNeedsRefresh,
	type SummarySourceMessage,
	type SummaryStatus,
} from "../../shared/ai-summary";
import { DEFAULT_AI_CONFIG, type AiConfig } from "../../shared/ai-settings";
import { SummaryRetryableError, summarizeThread } from "../lib/summarize";
import type { AiHandle } from "../lib/ai-router";
import type { AiWorkBudget } from "../lib/ai-budget";

/** Seconds between a message landing and its summary being generated. */
export const SUMMARY_DEBOUNCE_MS = 8_000;
const DUE_SLACK_MS = 1_000;

/**
 * Push every queued row's clock forward. Used when a whole run failed before
 * it could touch individual rows, so the alarm does not re-fire immediately.
 */
export function deferSummaryQueue(ctx: DurableObjectState, ms: number, now: Date = new Date()): void {
	try {
		ctx.storage.sql.exec(
			`UPDATE summary_queue SET enqueued_at = ?1 WHERE enqueued_at < ?1`,
			new Date(now.getTime() + ms - SUMMARY_DEBOUNCE_MS).toISOString(),
		);
	} catch {
		// No table: nothing to defer.
	}
}

/** Conversations summarised per alarm run, so one run stays short. */
export const SUMMARY_BATCH = 8;
/** Attempts before a conversation that keeps failing is dropped from the queue. */
export const SUMMARY_MAX_ATTEMPTS = 3;
/** How many recent conversations the one-off backfill queues. */
export const BACKFILL_THREADS = 200;
/** Gap between backfill batches: 200 threads drain in about 25 minutes. */
export const BACKFILL_PACE_MS = 60_000;
const BACKFILL_KEY = "summary_backfill_v";

/** Folders whose messages are never read into a summary nor counted. */
// The Screener too: mail from a sender nobody has said Yes to is not worth a
// summary call yet. Yes re-queues the sender's threads (see `screenSender`).
const EXCLUDED_FOLDERS = [Folders.DRAFT, Folders.SCHEDULED, Folders.TRASH, Folders.SPAM, Folders.SCREENER] as const;
const EXCLUDED_SQL = EXCLUDED_FOLDERS.map((f) => `'${f}'`).join(", ");

/** The conversation key: `thread_id`, or the message id for an unthreaded message. */
export const THREAD_KEY_SQL = "COALESCE(thread_id, id)";

export interface ThreadSummaryView {
	thread_id: string;
	line: string | null;
	bullets: string[] | null;
	message_count: number;
	status: SummaryStatus;
	generated_at: string;
	/** The conversation has grown since; a new summary is queued. */
	stale: boolean;
}

function hasTable(ctx: DurableObjectState, name: string): boolean {
	try {
		return (
			ctx.storage.sql
				.exec(`SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = ?1`, name)
				.toArray().length > 0
		);
	} catch {
		return false;
	}
}

/** Whether new messages in `folder` should (re)generate their conversation's summary. */
export function folderTriggersSummary(folder: string): boolean {
	return !(EXCLUDED_FOLDERS as readonly string[]).includes(folder);
}

/** Point the alarm at `when` unless one is already due sooner. */
export async function armAlarmAt(ctx: DurableObjectState, when: number): Promise<void> {
	const at = Math.max(when, Date.now() + 1000);
	const existing = await ctx.storage.getAlarm();
	if (existing === null || at < existing) await ctx.storage.setAlarm(at);
}

/** Queue a conversation. Idempotent per thread; a live request outranks a backfill one. */
export function enqueueSummary(
	ctx: DurableObjectState,
	threadKey: string,
	source: "live" | "backfill" = "live",
	now: Date = new Date(),
): void {
	ctx.storage.sql.exec(
		`INSERT INTO summary_queue (thread_id, enqueued_at, attempts, source)
		 VALUES (?1, ?2, 0, ?3)
		 ON CONFLICT(thread_id) DO UPDATE SET
		   source = CASE WHEN excluded.source = 'live' THEN 'live' ELSE summary_queue.source END,
		   attempts = CASE WHEN excluded.source = 'live' THEN 0 ELSE summary_queue.attempts END,
		   -- New live mail restarts the clock (clearing a back-off). A capped
		   -- day re-caps at process time, which costs one cheap alarm run.
		   enqueued_at = CASE WHEN excluded.source = 'live' THEN excluded.enqueued_at ELSE summary_queue.enqueued_at END`,
		threadKey,
		now.toISOString(),
		source,
	);
}

export function pendingSummaryCount(ctx: DurableObjectState): number {
	const row = ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM summary_queue`).toArray()[0] as
		| { n: number }
		| undefined;
	return Number(row?.n ?? 0);
}

/**
 * Queue the newest conversations once, for mailboxes that predate summaries.
 * Returns how many were queued (0 after the first call).
 */
export function maybeQueueBackfill(ctx: DurableObjectState, now: Date = new Date()): number {
	const done = ctx.storage.sql
		.exec(`SELECT 1 AS n FROM d1_migrations WHERE name = ?1`, `${BACKFILL_KEY}${SUMMARY_VERSION}`)
		.toArray();
	if (done.length > 0) return 0;

	const rows = ctx.storage.sql
		.exec(
			`SELECT ${THREAD_KEY_SQL} AS thread_key, MAX(date) AS latest
			   FROM emails
			  WHERE folder_id NOT IN (${EXCLUDED_SQL})
			  GROUP BY ${THREAD_KEY_SQL}
			  ORDER BY latest DESC
			  LIMIT ?1`,
			BACKFILL_THREADS,
		)
		.toArray() as { thread_key: string }[];

	ctx.storage.transactionSync(() => {
		for (const row of rows) {
			// Already summarised at this version: nothing to backfill.
			const existing = ctx.storage.sql
				.exec(`SELECT summary_v FROM thread_summaries WHERE thread_id = ?1`, row.thread_key)
				.toArray()[0] as { summary_v: number } | undefined;
			if (existing && existing.summary_v === SUMMARY_VERSION) continue;
			ctx.storage.sql.exec(
				`INSERT OR IGNORE INTO summary_queue (thread_id, enqueued_at, attempts, source)
				 VALUES (?1, ?2, 0, 'backfill')`,
				row.thread_key,
				now.toISOString(),
			);
		}
		// The marker lives in the migrations ledger so `purge()` clears it with
		// everything else and a re-created mailbox backfills again.
		ctx.storage.sql.exec(
			`INSERT OR IGNORE INTO d1_migrations (name) VALUES (?1)`,
			`${BACKFILL_KEY}${SUMMARY_VERSION}`,
		);
	});
	return rows.length;
}

/** Countable messages in a conversation. */
export function countableMessages(ctx: DurableObjectState, threadKey: string): number {
	const row = ctx.storage.sql
		.exec(
			`SELECT COUNT(*) AS n FROM emails
			  WHERE ${THREAD_KEY_SQL} = ?1 AND folder_id NOT IN (${EXCLUDED_SQL})`,
			threadKey,
		)
		.toArray()[0] as { n: number } | undefined;
	return Number(row?.n ?? 0);
}

interface SourceRow {
	id: string;
	sender: string | null;
	sender_name: string | null;
	date: string | null;
	body: string | null;
	folder_id: string;
	raw_headers: string | null;
}

/** Bodies are cut before any cleaning; a summary needs the first screens, not 2 MB. */
const BODY_SOURCE_CHARS = 32 * 1024;

function loadThread(ctx: DurableObjectState, threadKey: string): SourceRow[] {
	return ctx.storage.sql
		.exec(
			`SELECT id, sender, sender_name, date, SUBSTR(body, 1, ${BODY_SOURCE_CHARS}) AS body,
			        folder_id, raw_headers
			   FROM emails
			  WHERE ${THREAD_KEY_SQL} = ?1 AND folder_id NOT IN (${EXCLUDED_SQL})
			  ORDER BY date DESC
			  LIMIT ?2`,
			threadKey,
			MAX_SUMMARY_MESSAGES,
		)
		.toArray() as unknown as SourceRow[];
}

function utcDay(now: Date): string {
	return now.toISOString().slice(0, 10);
}

function usedToday(ctx: DurableObjectState, now: Date): number {
	const row = ctx.storage.sql
		.exec(`SELECT generated FROM summary_usage WHERE day = ?1`, utcDay(now))
		.toArray()[0] as { generated: number } | undefined;
	return Number(row?.generated ?? 0);
}

function recordUsage(ctx: DurableObjectState, now: Date): void {
	ctx.storage.sql.exec(
		`INSERT INTO summary_usage (day, generated) VALUES (?1, 1)
		 ON CONFLICT(day) DO UPDATE SET generated = generated + 1`,
		utcDay(now),
	);
	// Keep a week of history; older rows are noise.
	ctx.storage.sql.exec(`DELETE FROM summary_usage WHERE day < ?1`, utcDay(new Date(now.getTime() - 7 * 86_400_000)));
}

/** Nudge open clients to refetch, once per batch, without touching `emails`. */
function bumpMailboxVersion(ctx: DurableObjectState): void {
	try {
		ctx.storage.sql.exec(
			`UPDATE mailbox_state SET version = version + 1, updated_at = datetime('now') WHERE id = 1`,
		);
	} catch {
		// Pre-migration-19 mailbox: nothing to bump.
	}
}

export interface ProcessOptions {
	ai: AiHandle | undefined;
	/** The alarm's wall-clock budget: no new conversation is started once it is spent. */
	budget?: AiWorkBudget;
	config?: AiConfig;
	/** This mailbox's address, to tell its own messages from inbound ones. */
	mailboxAddress: string | null;
	now?: Date;
	batch?: number;
	/** Process queued rows regardless of their debounce or back-off clock. */
	ignoreDebounce?: boolean;
	/** Only these conversations (the on-demand path). */
	only?: string[];
	/** Summary model override (`SUMMARY_MODEL`). */
	model?: string;
}

export interface ProcessResult {
	processed: number;
	generated: number;
	unchanged: number;
	skipped: number;
	failed: number;
	/** Rows left in the queue. */
	remaining: number;
	/** When the next run should happen, or null when the queue is empty. */
	nextRunAt: number | null;
	/** The daily cap stopped this run. */
	capped: boolean;
}

/** Drain up to `batch` queued conversations. Never throws. */
export async function processSummaryQueue(
	ctx: DurableObjectState,
	options: ProcessOptions,
): Promise<ProcessResult> {
	const now = options.now ?? new Date();
	const config = options.config ?? DEFAULT_AI_CONFIG;
	const result: ProcessResult = {
		processed: 0,
		generated: 0,
		unchanged: 0,
		skipped: 0,
		failed: 0,
		remaining: 0,
		nextRunAt: null,
		capped: false,
	};
	if (!hasTable(ctx, "summary_queue")) return result;

	// Off, or no model to call: drop the backlog rather than letting it grow.
	if (!config.summaries || !options.ai) {
		ctx.storage.sql.exec(`DELETE FROM summary_queue`);
		return result;
	}

	const only = options.only ? [...new Set(options.only)].slice(0, 90) : null;
	const onlySql = only ? ` AND thread_id IN (${only.map((_, i) => `?${i + 3}`).join(", ")})` : "";
	const queued = ctx.storage.sql
		.exec(
			// Only rows whose debounce (or back-off, or cap wait) has elapsed.
			`SELECT thread_id, attempts, source FROM summary_queue
			  WHERE enqueued_at <= ?2${onlySql}
			  ORDER BY CASE source WHEN 'live' THEN 0 ELSE 1 END, enqueued_at ASC
			  LIMIT ?1`,
			options.batch ?? SUMMARY_BATCH,
			options.ignoreDebounce
				? "9999-12-31T00:00:00.000Z"
				: // A second of slack: an alarm can fire marginally early, and a run
					// that matches nothing would just re-arm itself.
					new Date(now.getTime() - SUMMARY_DEBOUNCE_MS + DUE_SLACK_MS).toISOString(),
			...(only ?? []),
		)
		.toArray() as { thread_id: string; attempts: number; source: string }[];

	let capped = false;
	let backfillCalls = 0;
	let changed = false;
	const self = options.mailboxAddress?.toLowerCase() ?? null;

	for (const item of queued) {
		// Out of wall time: the rest stays queued and the alarm re-arms for it.
		if (options.budget?.exhausted()) break;
		result.processed++;
		const drop = () => ctx.storage.sql.exec(`DELETE FROM summary_queue WHERE thread_id = ?1`, item.thread_id);

		try {
			const count = countableMessages(ctx, item.thread_id);
			if (count === 0) {
				// Everything left is in Spam, Trash or Drafts: never summarised.
				ctx.storage.sql.exec(`DELETE FROM thread_summaries WHERE thread_id = ?1`, item.thread_id);
				drop();
				result.skipped++;
				changed = true;
				continue;
			}

			const stored = ctx.storage.sql
				.exec(`SELECT summary_msg_count, summary_v FROM thread_summaries WHERE thread_id = ?1`, item.thread_id)
				.toArray()[0] as { summary_msg_count: number; summary_v: number } | undefined;
			if (!summaryNeedsRefresh(stored, count)) {
				drop();
				result.unchanged++;
				continue;
			}

			if (usedToday(ctx, now) >= config.dailyCapPerMailbox) {
				capped = true;
				break;
			}

			const rows = loadThread(ctx, item.thread_id);
			const isOwn = (r: SourceRow) =>
				r.folder_id === Folders.SENT || (!!self && (r.sender ?? "").toLowerCase() === self);
			const latestInbound = rows.find((r) => !isOwn(r));
			const bulk = latestInbound
				? isBulkMail(parseStoredHeaders(latestInbound.raw_headers), latestInbound.sender)
				: false;

			const messages: SummarySourceMessage[] = rows.map((r) => ({
				sender: r.sender,
				sender_name: r.sender_name,
				date: r.date,
				body: r.body,
				outbound: isOwn(r),
			}));

			const summary = await summarizeThread(options.ai, messages, {
				bulk,
				bulkSummaries: config.bulkSummaries,
				model: options.model,
			});
			if (summary.calls > 0) {
				recordUsage(ctx, now);
				if (item.source === "backfill") backfillCalls++;
			}

			ctx.storage.sql.exec(
				`INSERT INTO thread_summaries
				   (thread_id, summary_line, summary_bullets, summary_msg_count, summary_v, status, generated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
				 ON CONFLICT(thread_id) DO UPDATE SET
				   summary_line = excluded.summary_line,
				   summary_bullets = excluded.summary_bullets,
				   summary_msg_count = excluded.summary_msg_count,
				   summary_v = excluded.summary_v,
				   status = excluded.status,
				   generated_at = excluded.generated_at`,
				item.thread_id,
				summary.line,
				summary.bullets ? JSON.stringify(summary.bullets) : null,
				count,
				SUMMARY_VERSION,
				summary.status,
				now.toISOString(),
			);
			drop();
			changed = true;
			if (summary.status === "skipped") result.skipped++;
			else result.generated++;
		} catch (e) {
			const retryable = e instanceof SummaryRetryableError;
			console.warn(`summary for ${item.thread_id} failed:`, (e as Error).message);
			result.failed++;
			if (!retryable || item.attempts + 1 >= SUMMARY_MAX_ATTEMPTS) {
				drop();
			} else {
				// Back off by moving the row's clock: `enqueued_at` is what the alarm
				// deadline is computed from, so a failing row cannot spin the alarm.
				ctx.storage.sql.exec(
					`UPDATE summary_queue SET attempts = attempts + 1, enqueued_at = ?2 WHERE thread_id = ?1`,
					item.thread_id,
					new Date(now.getTime() + 60_000 * (item.attempts + 1)).toISOString(),
				);
			}
		}
	}

	if (changed) bumpMailboxVersion(ctx);

	if (backfillCalls > 0) {
		// Backfill (the first run, or every summary after a SUMMARY_VERSION bump)
		// drips one batch per BACKFILL_PACE_MS rather than draining back to back.
		// Moving the rows' clock holds them out of any run in between, whatever
		// fired the alarm; live mail is unaffected.
		ctx.storage.sql.exec(
			`UPDATE summary_queue SET enqueued_at = ?1 WHERE source = 'backfill' AND enqueued_at < ?1`,
			new Date(now.getTime() + BACKFILL_PACE_MS - SUMMARY_DEBOUNCE_MS).toISOString(),
		);
	}

	if (capped) {
		result.capped = true;
		// Cap spent: everything left waits for the next UTC day.
		const tomorrow = new Date(`${utcDay(now)}T00:00:00.000Z`).getTime() + 86_400_000 + 60_000;
		ctx.storage.sql.exec(
			`UPDATE summary_queue SET enqueued_at = ?1 WHERE enqueued_at < ?1`,
			new Date(tomorrow - SUMMARY_DEBOUNCE_MS).toISOString(),
		);
	}

	result.remaining = pendingSummaryCount(ctx);
	if (result.remaining > 0) {
		const row = ctx.storage.sql.exec(`SELECT MIN(enqueued_at) AS at FROM summary_queue`).toArray()[0] as
			| { at: string | null }
			| undefined;
		const at = row?.at ? Date.parse(row.at) + SUMMARY_DEBOUNCE_MS : now.getTime() + 2_000;
		// A full batch continues promptly rather than waiting out a debounce again.
		result.nextRunAt = Math.max(at, now.getTime() + 2_000);
	}
	return result;
}

export type SummarizeNowOutcome =
	| { kind: "ok"; summary: ThreadSummaryView | null }
	| { kind: "capped" }
	| { kind: "not_found" }
	| { kind: "unavailable" }
	/** The model failed; the conversation stays queued for the alarm to retry. */
	| { kind: "failed" };

type NowOptions = Omit<ProcessOptions, "only" | "batch" | "ignoreDebounce">;

/**
 * Generations in flight per mailbox object, so a double click (or two tabs)
 * waits for the first rather than spending a second call. The DO's input gate
 * serialises storage, but not the model call in between.
 */
const inFlight = new WeakMap<DurableObjectState, Map<string, Promise<SummarizeNowOutcome>>>();

/**
 * The reader's "Summarize" button: generate this conversation's summary now,
 * through the same checks as the queue (folders, refresh rule, injection
 * guard, bulk setting) and under the same daily cap. One conversation, at most
 * one generation at a time.
 */
export function summarizeThreadNow(
	ctx: DurableObjectState,
	threadKey: string,
	options: NowOptions,
): Promise<SummarizeNowOutcome> {
	let running = inFlight.get(ctx);
	if (!running) inFlight.set(ctx, (running = new Map()));
	const existing = running.get(threadKey);
	if (existing) return existing;
	const map = running;
	const job = summarizeOnce(ctx, threadKey, options).finally(() => map.delete(threadKey));
	map.set(threadKey, job);
	return job;
}

async function summarizeOnce(ctx: DurableObjectState, threadKey: string, options: NowOptions): Promise<SummarizeNowOutcome> {
	if (!hasTable(ctx, "summary_queue")) return { kind: "unavailable" };
	if (countableMessages(ctx, threadKey) === 0) return { kind: "not_found" };
	const config = options.config ?? DEFAULT_AI_CONFIG;
	if (!config.summaries || !options.ai) return { kind: "unavailable" };

	const now = options.now ?? new Date();
	const current = ctx.storage.sql
		.exec(`SELECT summary_msg_count, summary_v FROM thread_summaries WHERE thread_id = ?1`, threadKey)
		.toArray()[0] as { summary_msg_count: number; summary_v: number } | undefined;
	// Already current: nothing to spend.
	if (!summaryNeedsRefresh(current, countableMessages(ctx, threadKey))) {
		return { kind: "ok", summary: getThreadSummary(ctx, threadKey) };
	}
	if (usedToday(ctx, now) >= config.dailyCapPerMailbox) return { kind: "capped" };

	enqueueSummary(ctx, threadKey, "live", now);
	const run = await processSummaryQueue(ctx, { ...options, now, only: [threadKey], batch: 1, ignoreDebounce: true });
	if (run.capped) return { kind: "capped" };
	if (run.failed > 0) return { kind: "failed" };
	return { kind: "ok", summary: getThreadSummary(ctx, threadKey) };
}

/** Stored summaries for a set of conversations, keyed by thread. */
export function summaryLinesFor(
	ctx: DurableObjectState,
	threadKeys: string[],
): Map<string, { line: string; status: SummaryStatus }> {
	const out = new Map<string, { line: string; status: SummaryStatus }>();
	const keys = [...new Set(threadKeys.filter(Boolean))];
	if (keys.length === 0 || !hasTable(ctx, "thread_summaries")) return out;
	for (let i = 0; i < keys.length; i += 90) {
		const chunk = keys.slice(i, i + 90);
		const placeholders = chunk.map((_, j) => `?${j + 1}`).join(", ");
		const rows = ctx.storage.sql
			.exec(
				`SELECT thread_id, summary_line, status FROM thread_summaries
				  WHERE thread_id IN (${placeholders}) AND summary_line IS NOT NULL`,
				...chunk,
			)
			.toArray() as { thread_id: string; summary_line: string; status: SummaryStatus }[];
		for (const r of rows) out.set(r.thread_id, { line: r.summary_line, status: r.status });
	}
	return out;
}

/**
 * Add `summary_line` (and `summary_status` when it is the neutral text) to list
 * rows. Rows in Spam or Trash never get one, even if the conversation has a
 * summary from its life in the inbox.
 */
export function attachSummaryLines<T extends { id?: unknown; thread_id?: unknown; folder_id?: unknown }>(
	ctx: DurableObjectState,
	rows: T[],
): (T & { summary_line?: string; summary_status?: SummaryStatus })[] {
	const key = (r: T) => String(r.thread_id ?? r.id ?? "");
	const eligible = rows.filter((r) => r.folder_id !== Folders.SPAM && r.folder_id !== Folders.TRASH);
	const lines = summaryLinesFor(ctx, eligible.map(key));
	return rows.map((r) => {
		if (r.folder_id === Folders.SPAM || r.folder_id === Folders.TRASH) return r;
		const s = lines.get(key(r));
		if (!s) return r;
		return { ...r, summary_line: s.line, ...(s.status !== "ok" ? { summary_status: s.status } : {}) };
	});
}

/** The reader's view of one conversation's summary, or null. */
export function getThreadSummary(ctx: DurableObjectState, threadKey: string): ThreadSummaryView | null {
	if (!hasTable(ctx, "thread_summaries")) return null;
	const row = ctx.storage.sql
		.exec(
			`SELECT thread_id, summary_line, summary_bullets, summary_msg_count, status, generated_at
			   FROM thread_summaries WHERE thread_id = ?1`,
			threadKey,
		)
		.toArray()[0] as
		| {
				thread_id: string;
				summary_line: string | null;
				summary_bullets: string | null;
				summary_msg_count: number;
				status: SummaryStatus;
				generated_at: string;
		  }
		| undefined;
	if (!row) return null;
	const live = countableMessages(ctx, threadKey);
	if (live === 0) return null;
	return {
		thread_id: row.thread_id,
		line: row.summary_line,
		bullets: readStoredBullets(row.summary_bullets),
		message_count: row.summary_msg_count,
		status: row.status,
		generated_at: row.generated_at,
		stale: live !== row.summary_msg_count,
	};
}
