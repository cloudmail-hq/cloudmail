// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Semantic indexing inside a MailboxDO (migration 40).
 *
 * ## Flow
 *
 * Storing a message (`createEmail`) calls `enqueueSemantic`, which writes one
 * row to `semantic_queue` and arms the mailbox alarm. The alarm drains a
 * bounded batch, in the same run as triage and summaries (`processSemanticQueue`):
 *
 *   1. skip a message no longer worth indexing (Spam, Trash, Drafts,
 *      Scheduled, Screener) and drop any vectors it had;
 *   2. stop for the day when the per-mailbox embedding cap is spent;
 *   3. otherwise chunk the cleaned text, embed with bge-m3 and upsert into
 *      Vectorize in this mailbox's namespace, with
 *      `{mailbox, thread_id, email_id, date, folder}` metadata.
 *
 * ## Deletes
 *
 * A trigger on `emails` copies the message's `semantic_index` row into
 * `semantic_deletes` whenever a row is deleted (Empty Trash, the retention
 * sweep, a permanent delete). The same alarm drains that table with
 * `deleteByIds`. `purge()` drops tables wholesale, which bypasses the trigger,
 * so it calls `purgeAllVectors` first.
 *
 * ## Missing binding
 *
 * With no `SEMANTIC_INDEX` binding (the index was never created) or the admin
 * toggle off, nothing is queued and the queue is cleared: search falls back
 * to full-text and Ask uses full-text retrieval.
 *
 * Plain functions over `DurableObjectState`, so the SQL runs on `node:sqlite`
 * in tests with mocked `AI` and Vectorize bindings.
 */

import { Folders } from "../../shared/folders";
import {
	EMBEDDING_MODEL,
	MAX_CHUNKS_PER_MESSAGE,
	SEMANTIC_BACKFILL_PER_THREAD,
	SEMANTIC_BACKFILL_THREADS,
	chunkMessage,
	mailboxNamespace,
	vectorId,
	vectorIdsFor,
	type VectorMetadata,
} from "../../shared/semantic";
import type { AiConfig } from "../../shared/ai-settings";
import { chunkIds, placeholders } from "./bulk";
import type { AiHandle } from "../lib/ai-router";
import type { AiWorkBudget } from "../lib/ai-budget";

/** Folders whose messages are never embedded. Matches summaries' exclusions. */
export const SEMANTIC_EXCLUDED_FOLDERS = [
	Folders.DRAFT,
	Folders.SCHEDULED,
	Folders.TRASH,
	Folders.SPAM,
	Folders.SCREENER,
] as const;
const EXCLUDED_SQL = SEMANTIC_EXCLUDED_FOLDERS.map((f) => `'${f}'`).join(", ");

/** Seconds between a message landing and its embedding. */
export const SEMANTIC_DEBOUNCE_MS = 10_000;
/** Messages embedded per alarm run. */
export const SEMANTIC_BATCH = 16;
/** Vector ids deleted per alarm run (Vectorize accepts large batches; this keeps runs short). */
export const SEMANTIC_DELETE_BATCH = 500;
export const SEMANTIC_MAX_ATTEMPTS = 3;
/** Gap between backfill batches, so a backfill drips rather than floods. */
export const SEMANTIC_BACKFILL_PACE_MS = 60_000;
/** Bodies are cut before cleaning: chunks only cover the first screens anyway. */
const BODY_SOURCE_CHARS = 32 * 1024;
const BACKFILL_KEY = "semantic_backfill_v1";

/** The two bindings this needs, typed loosely so tests can pass mocks. */
export interface SemanticBindings {
	ai: AiHandle | undefined;
	index: VectorizeIndexLike | undefined;
}

/** The slice of Vectorize used here. */
export interface VectorizeIndexLike {
	upsert(vectors: VectorizeVector[]): Promise<unknown>;
	deleteByIds(ids: string[]): Promise<unknown>;
	query(vector: number[], options?: VectorizeQueryOptions): Promise<VectorizeMatches>;
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

export function folderTriggersSemantic(folder: string): boolean {
	return !(SEMANTIC_EXCLUDED_FOLDERS as readonly string[]).includes(folder);
}

function utcDay(now: Date): string {
	return now.toISOString().slice(0, 10);
}

// ── Queue ──────────────────────────────────────────────────────────

/** Queue a message. A live request outranks (and resets) a backfill one. */
export function enqueueSemantic(
	ctx: DurableObjectState,
	emailId: string,
	mailboxId: string,
	source: "live" | "backfill" = "live",
	now: Date = new Date(),
): void {
	ctx.storage.sql.exec(
		`INSERT OR IGNORE INTO semantic_mailbox (id, mailbox_id) VALUES (1, ?1)`,
		mailboxId.trim().toLowerCase(),
	);
	ctx.storage.sql.exec(
		`INSERT INTO semantic_queue (email_id, mailbox_id, source, enqueued_at, attempts)
		 VALUES (?1, ?2, ?3, ?4, 0)
		 ON CONFLICT(email_id) DO UPDATE SET
		   source = CASE WHEN excluded.source = 'live' THEN 'live' ELSE semantic_queue.source END,
		   attempts = CASE WHEN excluded.source = 'live' THEN 0 ELSE semantic_queue.attempts END,
		   enqueued_at = CASE WHEN excluded.source = 'live' THEN excluded.enqueued_at ELSE semantic_queue.enqueued_at END`,
		emailId,
		mailboxId.trim().toLowerCase(),
		source,
		now.toISOString(),
	);
}

export function pendingSemanticCount(ctx: DurableObjectState): number {
	try {
		const row = ctx.storage.sql
			.exec(
				`SELECT (SELECT COUNT(*) FROM semantic_queue) + (SELECT COUNT(*) FROM semantic_deletes) AS n`,
			)
			.toArray()[0] as { n: number } | undefined;
		return Number(row?.n ?? 0);
	} catch {
		return 0;
	}
}

/**
 * Queue the newest conversations once (their newest few messages each), for
 * mail that predates semantic search. Spam and Trash are never queued. The
 * daily cap bounds how fast it drains.
 */
export function maybeQueueSemanticBackfill(
	ctx: DurableObjectState,
	mailboxId: string,
	now: Date = new Date(),
): number {
	if (!hasTable(ctx, "semantic_queue")) return 0;
	const done = ctx.storage.sql.exec(`SELECT 1 AS n FROM d1_migrations WHERE name = ?1`, BACKFILL_KEY).toArray();
	if (done.length > 0) return 0;

	const rows = ctx.storage.sql
		.exec(
			`WITH threads AS (
			   SELECT COALESCE(thread_id, id) AS k, MAX(date) AS latest
			     FROM emails
			    WHERE folder_id NOT IN (${EXCLUDED_SQL})
			    GROUP BY COALESCE(thread_id, id)
			    ORDER BY latest DESC
			    LIMIT ?1
			 ), ranked AS (
			   SELECT e.id, ROW_NUMBER() OVER (PARTITION BY COALESCE(e.thread_id, e.id) ORDER BY e.date DESC) AS rn
			     FROM emails e
			     JOIN threads t ON t.k = COALESCE(e.thread_id, e.id)
			    WHERE e.folder_id NOT IN (${EXCLUDED_SQL})
			 )
			 SELECT r.id FROM ranked r
			  WHERE r.rn <= ?2
			    AND NOT EXISTS (SELECT 1 FROM semantic_index si WHERE si.email_id = r.id)`,
			SEMANTIC_BACKFILL_THREADS,
			SEMANTIC_BACKFILL_PER_THREAD,
		)
		.toArray() as { id: string }[];

	ctx.storage.transactionSync(() => {
		for (const row of rows) {
			ctx.storage.sql.exec(
				`INSERT OR IGNORE INTO semantic_queue (email_id, mailbox_id, source, enqueued_at, attempts)
				 VALUES (?1, ?2, 'backfill', ?3, 0)`,
				row.id,
				mailboxId.trim().toLowerCase(),
				now.toISOString(),
			);
		}
		// In the migrations ledger so `purge()` clears it and a re-created mailbox backfills again.
		ctx.storage.sql.exec(`INSERT OR IGNORE INTO d1_migrations (name) VALUES (?1)`, BACKFILL_KEY);
	});
	return rows.length;
}

// ── Usage ──────────────────────────────────────────────────────────

export function semanticUsageToday(ctx: DurableObjectState, now: Date = new Date()): { embeddings: number; queries: number } {
	try {
		const row = ctx.storage.sql
			.exec(`SELECT embeddings, queries FROM semantic_usage WHERE day = ?1`, utcDay(now))
			.toArray()[0] as { embeddings: number; queries: number } | undefined;
		return { embeddings: Number(row?.embeddings ?? 0), queries: Number(row?.queries ?? 0) };
	} catch {
		return { embeddings: 0, queries: 0 };
	}
}

export function recordSemanticUsage(
	ctx: DurableObjectState,
	usage: { embeddings?: number; queries?: number },
	now: Date = new Date(),
): void {
	ctx.storage.sql.exec(
		`INSERT INTO semantic_usage (day, embeddings, queries) VALUES (?1, ?2, ?3)
		 ON CONFLICT(day) DO UPDATE SET embeddings = embeddings + ?2, queries = queries + ?3`,
		utcDay(now),
		usage.embeddings ?? 0,
		usage.queries ?? 0,
	);
	ctx.storage.sql.exec(`DELETE FROM semantic_usage WHERE day < ?1`, utcDay(new Date(now.getTime() - 30 * 86_400_000)));
}

/** Messages indexed, queued and awaiting vector deletion, for the status line. */
export function semanticStatus(ctx: DurableObjectState, now: Date = new Date()) {
	if (!hasTable(ctx, "semantic_index")) {
		return { indexed: 0, queued: 0, pendingDeletes: 0, today: { embeddings: 0, queries: 0 } };
	}
	const n = (sql: string) => Number((ctx.storage.sql.exec(sql).toArray()[0] as { n: number } | undefined)?.n ?? 0);
	return {
		indexed: n(`SELECT COUNT(*) AS n FROM semantic_index`),
		queued: n(`SELECT COUNT(*) AS n FROM semantic_queue`),
		pendingDeletes: n(`SELECT COUNT(*) AS n FROM semantic_deletes`),
		today: semanticUsageToday(ctx, now),
	};
}

// ── Embedding model stamp ──────────────────────────────────────────

/** What a mailbox's vectors were made with, before the model was configurable. */
export const LEGACY_EMBEDDING_KEY = `workers-ai:${EMBEDDING_MODEL}`;

export function embeddingModelKey(providerId: string, modelId: string): string {
	return `${providerId}:${modelId}`;
}

/** The model this mailbox's vectors came from; bge-m3 on Workers AI when never stamped. */
export function indexedEmbeddingModel(ctx: DurableObjectState): string {
	if (!hasTable(ctx, "semantic_model")) return LEGACY_EMBEDDING_KEY;
	const row = ctx.storage.sql.exec(`SELECT model FROM semantic_model WHERE id = 1`).toArray()[0] as { model?: string } | undefined;
	return row?.model ?? LEGACY_EMBEDDING_KEY;
}

/** The model search may query, or null while a model change is still re-indexing this mailbox. */
/**
 * The model search may query. `unstamped` means a mailbox from before this
 * stamp; search keeps its old behaviour until the first drain records the route.
 * Null means a model change is still re-indexing this mailbox.
 */
export function searchableEmbeddingModel(ctx: DurableObjectState): string | "unstamped" | null {
	if (!hasTable(ctx, "semantic_model")) return "unstamped";
	const row = ctx.storage.sql.exec(`SELECT model, reindexing FROM semantic_model WHERE id = 1`).toArray()[0] as
		| { model?: string; reindexing?: number }
		| undefined;
	if (!row?.model) return "unstamped";
	if (Number(row.reindexing ?? 0) === 1) return null;
	return row.model;
}

/**
 * Make the index match `current` (the embeddings role's provider and model).
 *
 * Same model: nothing. Otherwise every indexed message's vectors are queued
 * for deletion and the message is queued again as backfill, so it is
 * re-embedded with the new model under the daily cap, and the stamp moves to
 * `current`. While that drains, search has fewer vector hits (full-text still
 * finds everything); it never compares a query with vectors from another
 * model except for messages whose old vectors are still waiting to be
 * deleted. Returns how many messages were re-queued.
 *
 * Only models with the index's dimensions can be picked (shared/workers-ai.ts
 * `checkWorkersAiPick`, shared/ai-gateway.ts `checkRoleModel`), so a change
 * never produces vectors the index rejects.
 */
export function reconcileEmbeddingModel(ctx: DurableObjectState, current: string, now: Date = new Date()): number {
	if (!hasTable(ctx, "semantic_model") || !hasTable(ctx, "semantic_index")) return 0;
	const existing = ctx.storage.sql.exec(`SELECT model FROM semantic_model WHERE id = 1`).toArray()[0] as { model?: string } | undefined;
	// Mailboxes from before this stamp may already use a gateway model, so
	// stamp them with today's route instead of guessing bge-m3.
	if (!existing?.model) {
		ctx.storage.sql.exec(
			`INSERT INTO semantic_model (id, model, changed_at, reindexing) VALUES (1, ?1, ?2, 0)`,
			current,
			now.toISOString(),
		);
		return 0;
	}
	const stamped = existing.model;
	if (stamped === current) {
		ctx.storage.sql.exec(
			`INSERT OR IGNORE INTO semantic_model (id, model, changed_at) VALUES (1, ?1, ?2)`,
			current,
			now.toISOString(),
		);
		return 0;
	}
	let requeued = 0;
	ctx.storage.transactionSync(() => {
		const rows = ctx.storage.sql
			.exec(`SELECT email_id, mailbox_id FROM semantic_index`)
			.toArray() as { email_id: string; mailbox_id: string }[];
		requeued = rows.length;
		ctx.storage.sql.exec(
			`INSERT OR REPLACE INTO semantic_deletes (email_id, mailbox_id, chunks, enqueued_at)
			 SELECT email_id, mailbox_id, chunks, ?1 FROM semantic_index`,
			now.toISOString(),
		);
		ctx.storage.sql.exec(`DELETE FROM semantic_index`);
		for (const row of rows) {
			ctx.storage.sql.exec(
				`INSERT OR IGNORE INTO semantic_queue (email_id, mailbox_id, source, enqueued_at, attempts)
				 VALUES (?1, ?2, 'backfill', ?3, 0)`,
				row.email_id,
				row.mailbox_id,
				now.toISOString(),
			);
		}
		ctx.storage.sql.exec(
			`INSERT INTO semantic_model (id, model, changed_at, reindexing) VALUES (1, ?1, ?2, ?3)
			 ON CONFLICT(id) DO UPDATE SET model = excluded.model, changed_at = excluded.changed_at, reindexing = excluded.reindexing`,
			current,
			now.toISOString(),
			requeued > 0 ? 1 : 0,
		);
	});
	if (requeued > 0) console.log(`semantic: embeddings model changed (${stamped} → ${current}); re-indexing ${requeued} messages`);
	return requeued;
}

// ── Embedding ──────────────────────────────────────────────────────

/**
 * Embed texts through the router's `embeddings` role (bge-m3 on Workers AI,
 * `EMBEDDING_MODEL`). Returns one vector per input, or throws.
 */
export async function embedTexts(ai: AiHandle, texts: string[]): Promise<number[][]> {
	if (texts.length === 0) return [];
	return (await ai.resolve("embeddings")).embed(texts);
}

interface SourceRow {
	id: string;
	thread_id: string | null;
	folder_id: string;
	subject: string | null;
	sender: string | null;
	sender_name: string | null;
	date: string | null;
	body: string | null;
}

function loadMessage(ctx: DurableObjectState, emailId: string): SourceRow | undefined {
	return ctx.storage.sql
		.exec(
			`SELECT id, thread_id, folder_id, subject, sender, sender_name, date,
			        SUBSTR(body, 1, ${BODY_SOURCE_CHARS}) AS body
			   FROM emails WHERE id = ?1`,
			emailId,
		)
		.toArray()[0] as unknown as SourceRow | undefined;
}

/** Queue the vectors of these messages for deletion and forget them locally. */
export function forgetIndexed(ctx: DurableObjectState, emailIds: string[], now: Date = new Date()): void {
	for (const chunk of chunkIds(emailIds, 1)) {
		ctx.storage.sql.exec(
			`INSERT OR REPLACE INTO semantic_deletes (email_id, mailbox_id, chunks, enqueued_at)
			 SELECT email_id, mailbox_id, chunks, ?1 FROM semantic_index WHERE email_id IN (${placeholders(chunk.length, 1)})`,
			now.toISOString(),
			...chunk,
		);
		ctx.storage.sql.exec(
			`DELETE FROM semantic_index WHERE email_id IN (${placeholders(chunk.length)})`,
			...chunk,
		);
	}
}

export interface SemanticProcessOptions extends SemanticBindings {
	config: Pick<AiConfig, "semantic" | "embedDailyCapPerMailbox">;
	now?: Date;
	batch?: number;
	ignoreDebounce?: boolean;
	/** The alarm's wall-clock budget: no new message is started once it is spent. */
	budget?: AiWorkBudget;
}

export interface SemanticProcessResult {
	indexed: number;
	skipped: number;
	failed: number;
	deleted: number;
	embeddings: number;
	capped: boolean;
	remaining: number;
	nextRunAt: number | null;
}

/**
 * Drain pending vector deletes. Runs even when the feature is off: turning
 * semantic search off must not strand deleted mail's vectors in the index.
 */
export async function drainSemanticDeletes(
	ctx: DurableObjectState,
	index: VectorizeIndexLike | undefined,
	limit = SEMANTIC_DELETE_BATCH,
): Promise<number> {
	if (!hasTable(ctx, "semantic_deletes")) return 0;
	const rows = ctx.storage.sql
		.exec(`SELECT email_id, mailbox_id, chunks FROM semantic_deletes ORDER BY enqueued_at ASC LIMIT ?1`, Math.ceil(limit / MAX_CHUNKS_PER_MESSAGE))
		.toArray() as { email_id: string; mailbox_id: string; chunks: number }[];
	if (rows.length === 0) return 0;
	// No index bound (removed, or a deploy without it): keep the rows. The
	// vectors may still exist in the index, and a later deploy drains them.
	if (!index) return 0;
	const ids = rows.flatMap((r) => vectorIdsFor(r.mailbox_id, r.email_id, Number(r.chunks) || MAX_CHUNKS_PER_MESSAGE));
	await index.deleteByIds(ids);
	for (const chunk of chunkIds(rows.map((r) => r.email_id))) {
		ctx.storage.sql.exec(`DELETE FROM semantic_deletes WHERE email_id IN (${placeholders(chunk.length)})`, ...chunk);
	}
	return ids.length;
}

/** Drain up to `batch` queued messages, then pending deletes. Never throws. */
export async function processSemanticQueue(
	ctx: DurableObjectState,
	options: SemanticProcessOptions,
): Promise<SemanticProcessResult> {
	const now = options.now ?? new Date();
	const result: SemanticProcessResult = {
		indexed: 0,
		skipped: 0,
		failed: 0,
		deleted: 0,
		embeddings: 0,
		capped: false,
		remaining: 0,
		nextRunAt: null,
	};
	if (!hasTable(ctx, "semantic_queue")) return result;

	try {
		result.deleted = await drainSemanticDeletes(ctx, options.index);
	} catch (e) {
		console.warn("semantic: vector delete failed, will retry:", (e as Error).message);
	}

	// Off, no model or no index: drop live backlog, except a model-change
	// re-index. That backlog is the only record of what was indexed before.
	if (!options.config.semantic || !options.ai || !options.index) {
		const reindexing =
			hasTable(ctx, "semantic_model") &&
			Number((ctx.storage.sql.exec(`SELECT reindexing FROM semantic_model WHERE id = 1`).toArray()[0] as { reindexing?: number } | undefined)?.reindexing ?? 0) === 1;
		if (!reindexing) ctx.storage.sql.exec(`DELETE FROM semantic_queue`);
		result.remaining = pendingSemanticCount(ctx);
		return result;
	}

	// The admin may have changed the embeddings model: never mix two models' vectors.
	try {
		const resolved = await options.ai.resolve("embeddings");
		const key = embeddingModelKey(resolved.providerId, resolved.modelId);
		if (resolved.kind === "disabled") {
			// Nothing to embed with; the queue stays for when it is back.
			result.remaining = pendingSemanticCount(ctx);
			return result;
		}
		if (resolved.fallback) {
			// A temporary Workers AI fallback for an unusable gateway route is
			// not a model change, even for a mailbox with no vectors yet:
			// indexing on it would force another full re-index when the gateway
			// recovers. Wait for the configured model instead.
			result.remaining = pendingSemanticCount(ctx);
			return result;
		}
		const requeued = reconcileEmbeddingModel(ctx, key, now);
		if (requeued > 0) {
			result.deleted += await drainSemanticDeletes(ctx, options.index).catch(() => 0);
		}
	} catch (e) {
		console.warn("semantic: embedding model check failed:", (e as Error).message);
	}

	const queued = ctx.storage.sql
		.exec(
			`SELECT email_id, mailbox_id, attempts, source FROM semantic_queue
			  WHERE enqueued_at <= ?2
			  ORDER BY CASE source WHEN 'live' THEN 0 ELSE 1 END, enqueued_at ASC
			  LIMIT ?1`,
			options.batch ?? SEMANTIC_BATCH,
			options.ignoreDebounce
				? "9999-12-31T00:00:00.000Z"
				: new Date(now.getTime() - SEMANTIC_DEBOUNCE_MS + 1_000).toISOString(),
		)
		.toArray() as { email_id: string; mailbox_id: string; attempts: number; source: string }[];

	let used = semanticUsageToday(ctx, now).embeddings;
	let backfilled = false;

	for (const item of queued) {
		// Out of wall time: the rest stays queued and the alarm re-arms for it.
		if (options.budget?.exhausted()) break;
		const drop = () => ctx.storage.sql.exec(`DELETE FROM semantic_queue WHERE email_id = ?1`, item.email_id);
		try {
			const row = loadMessage(ctx, item.email_id);
			if (!row || !folderTriggersSemantic(row.folder_id)) {
				// Gone, or moved somewhere that is never indexed (Spam, Trash…).
				if (row) forgetIndexed(ctx, [row.id], now);
				drop();
				result.skipped++;
				continue;
			}
			const chunks = chunkMessage(row);
			if (chunks.length === 0) {
				forgetIndexed(ctx, [row.id], now);
				drop();
				result.skipped++;
				continue;
			}
			if (used + chunks.length > options.config.embedDailyCapPerMailbox) {
				result.capped = true;
				break;
			}

			const vectors = await embedTexts(options.ai, chunks);
			used += chunks.length;
			result.embeddings += chunks.length;
			recordSemanticUsage(ctx, { embeddings: chunks.length }, now);

			const previous = ctx.storage.sql
				.exec(`SELECT chunks FROM semantic_index WHERE email_id = ?1`, row.id)
				.toArray()[0] as { chunks: number } | undefined;
			const metadataBase: Omit<VectorMetadata, "chunk"> = {
				mailbox: item.mailbox_id,
				thread_id: row.thread_id ?? row.id,
				email_id: row.id,
				date: row.date ?? "",
				folder: row.folder_id,
			};
			await options.index.upsert(
				vectors.map((values, i) => ({
					id: vectorId(item.mailbox_id, row.id, i),
					values,
					namespace: mailboxNamespace(item.mailbox_id),
					metadata: { ...metadataBase, chunk: i },
				})),
			);
			// A re-index that produced fewer chunks leaves stale tail vectors.
			if (previous && Number(previous.chunks) > chunks.length) {
				const stale = vectorIdsFor(item.mailbox_id, row.id, Number(previous.chunks)).slice(chunks.length);
				await options.index.deleteByIds(stale);
			}
			// Re-read after the awaits: the message may have been deleted, or
			// moved to Spam/Trash, while it was being embedded. The delete
			// trigger saw no index row then, so the vectors just written would
			// be orphaned. Remove them now instead of recording them.
			const still = loadMessage(ctx, row.id);
			if (!still || !folderTriggersSemantic(still.folder_id)) {
				await options.index.deleteByIds(vectorIdsFor(item.mailbox_id, row.id, chunks.length));
				drop();
				result.skipped++;
				continue;
			}
			ctx.storage.sql.exec(
				`INSERT INTO semantic_index (email_id, mailbox_id, chunks, indexed_at) VALUES (?1, ?2, ?3, ?4)
				 ON CONFLICT(email_id) DO UPDATE SET mailbox_id = excluded.mailbox_id, chunks = excluded.chunks, indexed_at = excluded.indexed_at`,
				row.id,
				item.mailbox_id,
				chunks.length,
				now.toISOString(),
			);
			// A delete queued earlier (trashed, then restored before the drain
			// ran) would otherwise remove the vectors just written. Only its
			// chunks beyond the new count are still stale.
			const pending = ctx.storage.sql
				.exec(`SELECT chunks FROM semantic_deletes WHERE email_id = ?1`, row.id)
				.toArray()[0] as { chunks: number } | undefined;
			if (pending) {
				if (Number(pending.chunks) > chunks.length) {
					await options.index.deleteByIds(
						vectorIdsFor(item.mailbox_id, row.id, Number(pending.chunks)).slice(chunks.length),
					);
				}
				ctx.storage.sql.exec(`DELETE FROM semantic_deletes WHERE email_id = ?1`, row.id);
			}
			drop();
			result.indexed++;
			if (item.source === "backfill") backfilled = true;
		} catch (e) {
			result.failed++;
			console.warn(`semantic: indexing ${item.email_id} failed:`, (e as Error).message);
			if (item.attempts + 1 >= SEMANTIC_MAX_ATTEMPTS) {
				drop();
			} else {
				ctx.storage.sql.exec(
					`UPDATE semantic_queue SET attempts = attempts + 1, enqueued_at = ?2 WHERE email_id = ?1`,
					item.email_id,
					new Date(now.getTime() + 60_000 * (item.attempts + 1)).toISOString(),
				);
			}
		}
	}

	// Messages the queue just found in Spam/Trash queued their vectors for
	// deletion above; remove them in this run rather than the next.
	try {
		result.deleted += await drainSemanticDeletes(ctx, options.index);
	} catch (e) {
		console.warn("semantic: vector delete failed, will retry:", (e as Error).message);
	}

	// A migration is complete only when every re-queued message is gone.
	if (hasTable(ctx, "semantic_model")) {
		const pending = Number(
			(ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM semantic_queue WHERE source = 'backfill'`).toArray()[0] as { n?: number } | undefined)?.n ?? 0,
		);
		if (pending === 0) ctx.storage.sql.exec(`UPDATE semantic_model SET reindexing = 0 WHERE id = 1`);
	}

	if (backfilled) {
		ctx.storage.sql.exec(
			`UPDATE semantic_queue SET enqueued_at = ?1 WHERE source = 'backfill' AND enqueued_at < ?1`,
			new Date(now.getTime() + SEMANTIC_BACKFILL_PACE_MS - SEMANTIC_DEBOUNCE_MS).toISOString(),
		);
	}
	if (result.capped) {
		// Cap spent: the rest waits for the next UTC day.
		const tomorrow = new Date(`${utcDay(now)}T00:00:00.000Z`).getTime() + 86_400_000 + 60_000;
		ctx.storage.sql.exec(
			`UPDATE semantic_queue SET enqueued_at = ?1 WHERE enqueued_at < ?1`,
			new Date(tomorrow - SEMANTIC_DEBOUNCE_MS).toISOString(),
		);
	}

	result.remaining = pendingSemanticCount(ctx);
	if (result.remaining > 0) {
		const pendingDeletes = Number(
			(ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM semantic_deletes`).toArray()[0] as { n: number }).n,
		);
		const row = ctx.storage.sql.exec(`SELECT MIN(enqueued_at) AS at FROM semantic_queue`).toArray()[0] as
			| { at: string | null }
			| undefined;
		const queueAt = row?.at ? Date.parse(row.at) + SEMANTIC_DEBOUNCE_MS : Number.POSITIVE_INFINITY;
		const at = pendingDeletes > 0 ? now.getTime() + 2_000 : queueAt;
		result.nextRunAt = Number.isFinite(at) ? Math.max(at, now.getTime() + 2_000) : null;
	}
	return result;
}

/**
 * Before `purge()` drops every table: delete this mailbox's vectors outright,
 * since the drop bypasses the delete trigger. Returns how many ids were sent.
 */
export async function purgeAllVectors(ctx: DurableObjectState, index: VectorizeIndexLike | undefined): Promise<number> {
	if (!index || !hasTable(ctx, "semantic_index")) return 0;
	const rows = ctx.storage.sql
		.exec(
			`SELECT email_id, mailbox_id, chunks FROM semantic_index
			 UNION ALL SELECT email_id, mailbox_id, chunks FROM semantic_deletes`,
		)
		.toArray() as { email_id: string; mailbox_id: string; chunks: number }[];
	const ids = rows.flatMap((r) => vectorIdsFor(r.mailbox_id, r.email_id, Number(r.chunks) || MAX_CHUNKS_PER_MESSAGE));
	for (let i = 0; i < ids.length; i += SEMANTIC_DELETE_BATCH) {
		await index.deleteByIds(ids.slice(i, i + SEMANTIC_DELETE_BATCH));
	}
	return ids.length;
}

// ── Hydration ──────────────────────────────────────────────────────

export interface HydratedHit {
	id: string;
	thread_id: string | null;
	folder_id: string;
	subject: string | null;
	sender: string | null;
	sender_name: string | null;
	recipient: string | null;
	date: string | null;
	read: boolean;
	starred: boolean;
	snippet: string | null;
	body: string | null;
}

/**
 * Load the messages behind vector matches, from this mailbox only.
 *
 * The second half of the authz filter: whatever Vectorize returned, a row is
 * only produced for an email id that exists *in this Durable Object*, which is
 * this mailbox. Spam and Trash are dropped unless asked for (`includeAll`),
 * matching full-text search's default scope.
 */
export function hydrateHits(
	ctx: DurableObjectState,
	emailIds: string[],
	options: { includeAll?: boolean; bodyChars?: number } = {},
): HydratedHit[] {
	const unique = [...new Set(emailIds.filter((id) => typeof id === "string" && id.length > 0))].slice(0, 100);
	if (unique.length === 0) return [];
	const bodyChars = Math.max(0, Math.min(options.bodyChars ?? 0, BODY_SOURCE_CHARS));
	const out = new Map<string, HydratedHit>();
	for (const chunk of chunkIds(unique)) {
		const rows = ctx.storage.sql
			.exec(
				`SELECT id, thread_id, folder_id, subject, sender, sender_name, recipient, date, read, starred,
				        snippet, ${bodyChars > 0 ? `SUBSTR(body, 1, ${bodyChars})` : "NULL"} AS body
				   FROM emails
				  WHERE id IN (${placeholders(chunk.length)})
				    ${options.includeAll ? "" : `AND folder_id NOT IN ('${Folders.TRASH}', '${Folders.SPAM}')`}`,
				...chunk,
			)
			.toArray() as Record<string, unknown>[];
		for (const r of rows) {
			out.set(String(r.id), {
				id: String(r.id),
				thread_id: (r.thread_id as string | null) ?? null,
				folder_id: String(r.folder_id),
				subject: (r.subject as string | null) ?? null,
				sender: (r.sender as string | null) ?? null,
				sender_name: (r.sender_name as string | null) ?? null,
				recipient: (r.recipient as string | null) ?? null,
				date: (r.date as string | null) ?? null,
				read: !!r.read,
				starred: !!r.starred,
				snippet: (r.snippet as string | null) ?? null,
				body: (r.body as string | null) ?? null,
			});
		}
	}
	// In the order asked for: that order is the ranking.
	return unique.map((id) => out.get(id)).filter((r): r is HydratedHit => !!r);
}
