// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The engagement cache on `emails` (migration 28).
 *
 * The ledger (`delivery_events`) is the truth; these columns are a per-message
 * summary of it so the Sent list can show "opened 3×, clicked" without
 * aggregating the ledger for every row on every page:
 *
 *   opened_at        first `opened` event
 *   last_opened_at   latest `opened` event
 *   open_count       number of `opened` events
 *   open_proxy_count of those, how many a mail-privacy proxy fetched
 *   clicked_at       first `clicked` event
 *   click_count      number of `clicked` events
 *
 * ## Recomputed, not incremented
 *
 * `recomputeEngagement` rebuilds all six from the ledger for ONE message, using
 * the `idx_delivery_events_email` index. An increment would be cheaper by a
 * hair and would drift the first time an event was written by any path that
 * forgot to bump it; a recompute converges whatever happened before.
 *
 * Writing the row also bumps `mailbox_state.version` (the update trigger from
 * migration 19), which is what makes an open list refetch when an open lands.
 *
 * ## Lazy backfill
 *
 * Rows that already had engagement before this migration start at
 * `engagement_v = 0`. A migration cannot aggregate them (it runs in the
 * constructor, and a big mailbox would stall), so the list paths call
 * `backfillEngagementCache` for one bounded batch per read, newest first —
 * the same shape as ./derived.ts. Rows with no engagement events never need
 * visiting: their defaults (0 / NULL) are already correct.
 *
 * Plain functions over `DurableObjectState` so the SQL runs against
 * `node:sqlite` in tests.
 */

/** Version of the cache computation. Rows below it are recomputed. */
export const ENGAGEMENT_VERSION = 1;

/** Messages processed per backfill call. */
export const ENGAGEMENT_BACKFILL_BATCH = 200;

/**
 * The pending predicate as a literal, so SQLite can use the partial index
 * (a bound parameter never implies the index's WHERE). Must match migration 28.
 */
const PENDING = `engagement_v < ${ENGAGEMENT_VERSION}`;

/** Whether any row still needs computing. One probe of the partial index. */
export function hasPendingEngagement(ctx: DurableObjectState): boolean {
	try {
		return ctx.storage.sql.exec(`SELECT 1 AS n FROM emails WHERE ${PENDING} LIMIT 1`).toArray().length > 0;
	} catch {
		return false;
	}
}

/**
 * Rebuild the engagement cache for one message from the ledger.
 *
 * Never throws: it runs right after an event is recorded on the public
 * tracking endpoint's background tail, and a cache failure must not lose the
 * event (which is already written) or surface as an error.
 */
export function recomputeEngagement(ctx: DurableObjectState, emailId: string): void {
	try {
		const agg = ctx.storage.sql
			.exec(
				`SELECT
				    MIN(CASE WHEN event_type = 'opened' THEN occurred_at END) AS opened_at,
				    MAX(CASE WHEN event_type = 'opened' THEN occurred_at END) AS last_opened_at,
				    SUM(CASE WHEN event_type = 'opened' THEN 1 ELSE 0 END) AS open_count,
				    -- json_valid first: a malformed metadata string must not make
				    -- the whole aggregate throw (json_extract errors on bad JSON).
				    SUM(CASE WHEN event_type = 'opened'
				              AND json_valid(metadata)
				              AND json_extract(metadata, '$.proxy') IS NOT NULL
				             THEN 1 ELSE 0 END) AS open_proxy_count,
				    MIN(CASE WHEN event_type = 'clicked' THEN occurred_at END) AS clicked_at,
				    SUM(CASE WHEN event_type = 'clicked' THEN 1 ELSE 0 END) AS click_count
				   FROM delivery_events
				  WHERE email_id = ?1 AND event_type IN ('opened', 'clicked')`,
				emailId,
			)
			.toArray()[0] as
			| {
					opened_at: string | null;
					last_opened_at: string | null;
					open_count: number | null;
					open_proxy_count: number | null;
					clicked_at: string | null;
					click_count: number | null;
			  }
			| undefined;

		ctx.storage.sql.exec(
			`UPDATE emails
			    SET opened_at = ?1, last_opened_at = ?2, open_count = ?3,
			        open_proxy_count = ?4, clicked_at = ?5, click_count = ?6,
			        engagement_v = ?7
			  WHERE id = ?8`,
			agg?.opened_at ?? null,
			agg?.last_opened_at ?? null,
			Number(agg?.open_count ?? 0),
			Number(agg?.open_proxy_count ?? 0),
			agg?.clicked_at ?? null,
			Number(agg?.click_count ?? 0),
			ENGAGEMENT_VERSION,
			emailId,
		);
	} catch (e) {
		console.error("recomputeEngagement failed for", emailId, (e as Error)?.message);
	}
}

/**
 * Fill the cache for up to `limit` messages not yet computed, newest first.
 * Returns how many were processed; 0 means done.
 *
 * Bounded in work, not just in rows written: the candidates come from the
 * partial index `idx_emails_engagement_pending` (migration 28), and each one is
 * recomputed through `idx_delivery_events_email`. A row with no engagement is
 * simply stamped with the version; its zero/NULL defaults were already right.
 */
export function backfillEngagementCache(
	ctx: DurableObjectState,
	limit: number = ENGAGEMENT_BACKFILL_BATCH,
): number {
	try {
		const rows = ctx.storage.sql
			.exec(
				`SELECT id FROM emails
				  WHERE ${PENDING}
				  ORDER BY date DESC
				  LIMIT ?1`,
				limit,
			)
			.toArray() as { id: string }[];
		if (rows.length === 0) return 0;
		ctx.storage.transactionSync(() => {
			for (const row of rows) recomputeEngagement(ctx, row.id);
		});
		return rows.length;
	} catch (e) {
		console.error("backfillEngagementCache failed:", (e as Error)?.message);
		return 0;
	}
}

/** The list-projection fields this cache adds, for a given table alias. */
export function engagementColumnsSql(alias: string): string {
	const p = `${alias}.`;
	return `${p}opened_at, ${p}last_opened_at, ${p}open_count, ${p}open_proxy_count, ${p}clicked_at, ${p}click_count`;
}
