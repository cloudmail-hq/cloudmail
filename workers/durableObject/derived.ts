// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Columns derived from a message's body and headers (migration 26).
 *
 * `snippet` and `sender_name` are computed in JavaScript because SQLite has no
 * HTML parser and no RFC 2047 decoder. They are written at insert time by
 * `createEmail`, and every row that predates the migration (or was copied in by
 * `importAll`) is filled lazily by `backfillDerivedColumns`.
 *
 * ## Why lazy and batched
 *
 * A migration that walked every row would run inside the Durable Object
 * constructor. On a mailbox with tens of thousands of messages that is a long
 * synchronous stall on first access after deploy, and a migration that throws
 * makes the mailbox unreachable. So the migration only adds columns and this
 * module catches up a bounded batch at a time, from the read paths a user (or
 * an agent) actually hits. Until a row is reached the list projections fall
 * back to `SUBSTR(body, 1, 300)` — the previous behaviour, so nothing regresses
 * while the backlog drains.
 *
 * Plain functions over `DurableObjectState`, like ./dedupe.ts and ./trash.ts,
 * so the real SQL runs against `node:sqlite` in tests.
 */

import { toPlainSnippet } from "../../shared/plain-snippet";
import { senderNameFromRawHeaders } from "../../shared/sender-name";

/**
 * Version of the derivation. Rows with `derived_v` below this are recomputed.
 * Bump it when `toPlainSnippet` or the name parsing changes meaningfully; the
 * partial index in migration 26 is `WHERE derived_v < 1`, so a bump also needs
 * a new index (or accepts a scan for one backfill pass).
 */
export const DERIVED_VERSION = 1;

/**
 * The pending-row predicate, as a literal. SQLite only uses a partial index
 * when the query's WHERE textually implies the index's, and a bound parameter
 * never does, so this cannot be `derived_v < ?`.
 */
const PENDING = `derived_v < ${DERIVED_VERSION}`;

/** Rows processed per backfill call. Bounded so one read never stalls long. */
export const BACKFILL_BATCH = 200;

/**
 * Bodies longer than this are cut before deriving the snippet. A preview needs
 * the first few hundred visible characters; a 2 MB newsletter does not need to
 * be regex-scanned end to end to find them.
 */
const SNIPPET_SOURCE_CHARS = 64 * 1024;

/** The list projection's snippet expression, for an aliased `emails` table. */
export function snippetSql(alias?: string): string {
	const p = alias ? `${alias}.` : "";
	return `COALESCE(${p}snippet, SUBSTR(${p}body, 1, 300))`;
}

/** Derived values for one row, from what is stored about it. */
export function deriveColumns(row: {
	body: string | null | undefined;
	sender?: string | null;
	raw_headers?: string | null;
	sender_name?: string | null;
}): { snippet: string; sender_name: string | null } {
	const body = row.body ?? "";
	return {
		snippet: toPlainSnippet(
			body.length > SNIPPET_SOURCE_CHARS ? body.slice(0, SNIPPET_SOURCE_CHARS) : body,
		),
		// An explicit name (set at ingest or send time) is never overwritten by the
		// header guess: for sent mail the header we stored IS the name, and for
		// inbound mail the ingest path's parsed name is at least as good.
		sender_name:
			row.sender_name ?? senderNameFromRawHeaders(row.raw_headers, row.sender),
	};
}

/**
 * Fill `snippet` / `sender_name` for up to `limit` rows that still need them.
 *
 * Returns how many rows were updated, so a caller (or a test) can loop until
 * the backlog is empty. Never throws: it runs ahead of read paths, and a
 * failure to tidy a preview must not turn a list request into a 500.
 *
 * The UPDATE deliberately touches only the three derived columns. The FTS
 * trigger fires on `subject, body, sender, recipient` only (migration 21), so
 * the backfill never re-indexes a body. It does bump the `mailbox_state`
 * version (that trigger fires on any update), which makes an open client
 * refetch once — and pick up the clean snippets — which is the desired effect.
 */
export function backfillDerivedColumns(
	ctx: DurableObjectState,
	limit: number = BACKFILL_BATCH,
): number {
	try {
		const rows = ctx.storage.sql
			.exec(
				// Newest first: the first page a user or agent lists is the one that
				// should come back clean, and on a large mailbox that is the batch
				// this call processes.
				`SELECT id, body, sender, raw_headers, sender_name
				   FROM emails
				  WHERE ${PENDING}
				  ORDER BY date DESC
				  LIMIT ?1`,
				limit,
			)
			.toArray() as {
			id: string;
			body: string | null;
			sender: string | null;
			raw_headers: string | null;
			sender_name: string | null;
		}[];
		if (rows.length === 0) return 0;

		ctx.storage.transactionSync(() => {
			for (const row of rows) {
				let derived: { snippet: string; sender_name: string | null };
				try {
					derived = deriveColumns(row);
				} catch {
					// One pathological body must not wedge the backlog: mark it done
					// with the legacy expression's output so it is not retried forever.
					derived = {
						snippet: (row.body ?? "").slice(0, 300),
						sender_name: row.sender_name,
					};
				}
				ctx.storage.sql.exec(
					`UPDATE emails
					    SET snippet = ?1, sender_name = ?2, derived_v = ?3
					  WHERE id = ?4`,
					derived.snippet,
					derived.sender_name,
					DERIVED_VERSION,
					row.id,
				);
			}
		});
		return rows.length;
	} catch (e) {
		console.error("backfillDerivedColumns failed:", (e as Error)?.message);
		return 0;
	}
}

/** Whether any row still needs deriving. Cheap: the partial index answers it. */
export function hasPendingDerived(ctx: DurableObjectState): boolean {
	try {
		const row = ctx.storage.sql
			.exec(`SELECT 1 AS n FROM emails WHERE ${PENDING} LIMIT 1`)
			.toArray()[0];
		return !!row;
	} catch {
		return false;
	}
}
