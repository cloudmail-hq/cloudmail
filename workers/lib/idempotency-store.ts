// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Storage for idempotency keys, shared by `MailboxDO` (per-mailbox sends and
 * creates) and `AuthDO` (instance-level creates). See ./idempotency.ts for the
 * HTTP and MCP layers on top.
 *
 * Plain functions over a SQL handle so they run unchanged against Durable
 * Object storage and against `node:sqlite` in tests.
 *
 * ## Why the check-and-set lives here
 *
 * A Durable Object handles one RPC at a time, and every function below is a
 * synchronous run of SQL statements with no `await` in between. So `begin`
 * reading "no row" and inserting the in-flight row cannot interleave with a
 * second `begin` for the same key: the second one sees the first's row and is
 * told the request is in progress. Doing the same check in the Worker would
 * race, because two isolates can each read "no row" before either writes.
 */

/** The table, created by MailboxDO migration 29 and AuthDO migration 0009. */
export const IDEMPOTENCY_TABLE_SQL = `CREATE TABLE IF NOT EXISTS idempotency_keys (
	scope TEXT NOT NULL,
	idem_key TEXT NOT NULL,
	request_hash TEXT NOT NULL,
	status INTEGER,
	body TEXT,
	content_type TEXT,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	PRIMARY KEY (scope, idem_key)
)`;

export const IDEMPOTENCY_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires ON idempotency_keys(expires_at)`;

/** How long a completed response is kept and replayed. Matches Resend. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long an in-flight reservation holds before it is treated as abandoned.
 *
 * A reservation is released when the request finishes, fails with a 5xx or
 * throws. The one case that leaves it behind is the Worker dying mid-request,
 * and without a timeout that key would answer "in progress" for a day. Two
 * minutes is longer than any send takes; the cost is that a retry after a crash
 * that happened *after* the provider accepted the mail can send it again, which
 * is no worse than having no key at all.
 */
export const IDEMPOTENCY_IN_FLIGHT_MS = 2 * 60 * 1000;

/** Rows deleted per opportunistic sweep, so a backlog never stalls a request. */
const SWEEP_BATCH = 100;

export interface IdempotencySql {
	exec(query: string, ...bindings: unknown[]): { toArray(): any[] };
}

export interface IdempotencyBeginInput {
	scope: string;
	key: string;
	requestHash: string;
	now?: number;
}

export type IdempotencyBeginResult =
	/** No usable row: the caller now holds the reservation and must run the request. */
	| {
			state: "started";
			/**
			 * Fencing token: the reservation's `created_at`. `complete` and `release`
			 * must pass it back, so a request whose reservation timed out and was
			 * taken over by a retry cannot overwrite or delete the retry's row.
			 */
			reservedAt: number;
	  }
	/** A completed request with the same payload; return its response. */
	| { state: "replay"; status: number; body: string; contentType: string | null }
	/** The key was used with a different payload. */
	| { state: "mismatch" }
	/** The first request with this key has not finished yet. */
	| { state: "in_progress" };

export interface IdempotencyCompleteInput {
	scope: string;
	key: string;
	requestHash: string;
	/** From the `started` result of `beginIdempotent`. */
	reservedAt: number;
	status: number;
	body: string;
	contentType: string | null;
	now?: number;
}

export interface IdempotencyReleaseInput {
	scope: string;
	key: string;
	requestHash: string;
	reservedAt: number;
}

/** Delete up to one batch of expired rows. Returns how many went. */
export function sweepIdempotencyKeys(sql: IdempotencySql, now = Date.now()): number {
	const rows = sql
		.exec(
			`DELETE FROM idempotency_keys
			  WHERE rowid IN (SELECT rowid FROM idempotency_keys WHERE expires_at <= ?1 LIMIT ?2)
			  RETURNING 1`,
			now,
			SWEEP_BATCH,
		)
		.toArray();
	return rows.length;
}

/**
 * Look the key up and, when it is free, reserve it.
 *
 * Expired rows are ignored and replaced (lazy expiry), and a small sweep of
 * other expired rows runs first so the table stays bounded even in a mailbox
 * whose alarm never fires.
 */
export function beginIdempotent(
	sql: IdempotencySql,
	input: IdempotencyBeginInput,
): IdempotencyBeginResult {
	const now = input.now ?? Date.now();
	sweepIdempotencyKeys(sql, now);

	const row = sql
		.exec(
			`SELECT request_hash, status, body, content_type, expires_at
			   FROM idempotency_keys WHERE scope = ?1 AND idem_key = ?2`,
			input.scope,
			input.key,
		)
		.toArray()[0] as
		| {
				request_hash: string;
				status: number | null;
				body: string | null;
				content_type: string | null;
				expires_at: number;
		  }
		| undefined;

	if (row && Number(row.expires_at) > now) {
		if (row.request_hash !== input.requestHash) return { state: "mismatch" };
		if (row.status === null || row.status === undefined) return { state: "in_progress" };
		return {
			state: "replay",
			status: Number(row.status),
			body: row.body ?? "",
			contentType: row.content_type ?? null,
		};
	}

	sql.exec(
		`INSERT INTO idempotency_keys (scope, idem_key, request_hash, status, body, content_type, created_at, expires_at)
		 VALUES (?1, ?2, ?3, NULL, NULL, NULL, ?4, ?5)
		 ON CONFLICT (scope, idem_key) DO UPDATE SET
		   request_hash = excluded.request_hash,
		   status = NULL, body = NULL, content_type = NULL,
		   created_at = excluded.created_at,
		   expires_at = excluded.expires_at`,
		input.scope,
		input.key,
		input.requestHash,
		now,
		now + IDEMPOTENCY_IN_FLIGHT_MS,
	);
	return { state: "started", reservedAt: now };
}

/**
 * Store the response for a reservation, kept for {@link IDEMPOTENCY_TTL_MS}.
 *
 * Only updates the caller's own in-flight row (same hash, same `reservedAt`, no
 * status yet): if the reservation timed out and a retry took the key over, the
 * retry's row is left alone.
 */
export function completeIdempotent(sql: IdempotencySql, input: IdempotencyCompleteInput): boolean {
	const now = input.now ?? Date.now();
	const rows = sql
		.exec(
			`UPDATE idempotency_keys
			    SET status = ?5, body = ?6, content_type = ?7, expires_at = ?8
			  WHERE scope = ?1 AND idem_key = ?2 AND request_hash = ?3 AND created_at = ?4
			    AND status IS NULL
			  RETURNING 1`,
			input.scope,
			input.key,
			input.requestHash,
			input.reservedAt,
			input.status,
			input.body,
			input.contentType,
			now + IDEMPOTENCY_TTL_MS,
		)
		.toArray();
	return rows.length > 0;
}

/** Drop the caller's own unfinished reservation so a retry can run (5xx, thrown, not storable). */
export function releaseIdempotent(sql: IdempotencySql, input: IdempotencyReleaseInput): void {
	sql.exec(
		`DELETE FROM idempotency_keys
		  WHERE scope = ?1 AND idem_key = ?2 AND request_hash = ?3 AND created_at = ?4
		    AND status IS NULL`,
		input.scope,
		input.key,
		input.requestHash,
		input.reservedAt,
	);
}
