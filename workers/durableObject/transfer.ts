// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Cross-namespace mailbox transfer, backing the `/api/v1/_migrate/*` routes.
 *
 * Each Worker deployment owns its own MailboxDO namespace, so a mailbox served
 * by a retired deployment is invisible to the surviving one even though both
 * share the R2 bucket holding mailbox settings. These helpers copy the SQLite
 * rows across.
 *
 * Two constraints shape the design:
 *
 * 1. `exportAll` runs inside the *legacy* deployment's Durable Object, which may
 *    be on an older schema. Everything is therefore discovered at runtime from
 *    `sqlite_master` and `table_info` rather than assumed, so a legacy object
 *    predating migrations 9-13 exports what it has and nothing errors.
 * 2. Row IDs are preserved. Attachment blobs are not copied: both deployments
 *    point at the same bucket and keys embed the email and attachment IDs, so
 *    keeping the IDs keeps existing blobs reachable.
 */

/**
 * Tables that may be transferred, ordered so a parent is always written before
 * anything referencing it.
 *
 * This doubles as the allowlist for SQL identifier interpolation: a table name
 * is only ever emitted into SQL after matching an entry here.
 */
const TRANSFER_TABLES = [
	"folders",
	"emails",
	"attachments",
	"labels",
	"email_labels",
	"signatures",
	"blocked_senders",
	"scheduled_sends",
] as const;

export type TransferTable = (typeof TRANSFER_TABLES)[number];

export type ExportShape = Record<string, Record<string, unknown>[]>;

/** Counts of the rows that matter for verifying a copy. */
export type MailboxStats = Record<string, number>;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function tableExists(ctx: DurableObjectState, table: string): boolean {
	return (
		ctx.storage.sql
			.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, table)
			.toArray().length > 0
	);
}

/** Actual column names of a table, used to filter incoming payload keys. */
function columnsOf(ctx: DurableObjectState, table: TransferTable): Set<string> {
	const rows = ctx.storage.sql
		.exec(`SELECT name FROM pragma_table_info(?)`, table)
		.toArray() as { name: string }[];
	return new Set(rows.map((r) => r.name));
}

/**
 * Row counts per transferable table.
 *
 * Read-only, so it is safe to call before and after a copy to confirm the
 * outcome. Tables absent on an older schema are reported as 0 rather than
 * omitted, which keeps the before/after shapes comparable.
 */
export function stats(ctx: DurableObjectState): MailboxStats {
	const result: MailboxStats = {};
	for (const table of TRANSFER_TABLES) {
		if (!tableExists(ctx, table)) {
			result[table] = 0;
			continue;
		}
		const row = ctx.storage.sql
			.exec(`SELECT COUNT(*) AS total FROM ${table}`)
			.toArray()[0] as { total: number } | undefined;
		result[table] = row?.total ?? 0;
	}
	return result;
}

/**
 * Dump every transferable row.
 *
 * `SELECT *` keeps this forward-compatible: columns added by later migrations
 * are carried across without touching this function.
 */
export function exportAll(ctx: DurableObjectState): ExportShape {
	const out: ExportShape = {};
	for (const table of TRANSFER_TABLES) {
		out[table] = tableExists(ctx, table)
			? (ctx.storage.sql
					.exec(`SELECT * FROM ${table}`)
					.toArray() as Record<string, unknown>[])
			: [];
	}
	return out;
}

/**
 * Insert exported rows, skipping any whose primary key is already present.
 *
 * Idempotent by way of INSERT OR IGNORE, so the copy can be re-run after
 * repointing Email Routing to sweep up whatever landed in the old namespace in
 * the interim. The whole import is one transaction: a partial copy that looked
 * successful would be worse than a clean failure.
 *
 * Unknown tables and unknown or malformed column names are dropped rather than
 * trusted, because the payload arrives over an HTTP endpoint.
 */
export function importAll(
	ctx: DurableObjectState,
	payload: ExportShape,
): Record<string, number> {
	const inserted: Record<string, number> = {};

	ctx.storage.transactionSync(() => {
		for (const table of TRANSFER_TABLES) {
			const rows = payload?.[table];
			if (!Array.isArray(rows) || rows.length === 0) {
				inserted[table] = 0;
				continue;
			}
			if (!tableExists(ctx, table)) {
				inserted[table] = 0;
				continue;
			}

			const allowed = columnsOf(ctx, table);
			let count = 0;

			for (const row of rows) {
				if (!row || typeof row !== "object") continue;

				const columns = Object.keys(row).filter(
					(key) => IDENTIFIER.test(key) && allowed.has(key),
				);
				if (columns.length === 0) continue;

				const placeholders = columns.map((_, i) => `?${i + 1}`).join(", ");
				const values = columns.map((key) => normalize(row[key]));

				ctx.storage.sql.exec(
					`INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
					...values,
				);
				count++;
			}

			inserted[table] = count;
		}
	});

	return inserted;
}

/**
 * Coerce a JSON-decoded value into something SQLite accepts.
 *
 * The payload crosses an RPC/JSON boundary, so booleans arrive as booleans even
 * though the columns are INTEGER, and nested objects can only have come from a
 * malformed request.
 */
function normalize(value: unknown): string | number | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (typeof value === "number" || typeof value === "string") return value;
	return JSON.stringify(value);
}
