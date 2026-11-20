// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Bulk message operations and mark-all-read.
 *
 * Plain functions over `DurableObjectState`, matching the style of
 * ./features.ts, so the logic is testable without standing up a Durable
 * Object. `MailboxDO` keeps thin delegating methods because only class
 * methods are reachable over RPC.
 *
 * Every statement here is parameterised and every id list is length-capped:
 * these run straight off a request body, and an unbounded `IN (...)` would let
 * a caller build an arbitrarily large statement.
 */

import { canMoveInto, Folders } from "../../shared/folders";

/**
 * Most messages a single bulk request may touch.
 *
 * The UI selects at most one page at a time, so this is far above real usage;
 * it exists to bound the generated SQL rather than to constrain the caller.
 */
export const BULK_LIMIT = 500;

/**
 * Bound parameters Durable Object SQLite accepts in one statement.
 *
 * This limit is why `BULK_LIMIT` alone was not enough. An `id IN (?1, …, ?500)`
 * statement binds one parameter per id, so every operation here failed outright
 * somewhere around a hundred selected messages — well inside what "select all"
 * on a large page or an API caller would send. The cap was documented as
 * bounding the generated SQL, but nothing ever checked it against the platform's
 * actual ceiling.
 *
 * The fix is to chunk rather than to lower `BULK_LIMIT`: callers keep a useful
 * batch size and the statement stays inside the budget.
 */
export const SQL_MAX_BOUND_PARAMS = 100;

/**
 * Split an id list into runs that fit the bound-parameter budget.
 *
 * @param reserved Parameters the rest of the statement already spends — the
 *   destination folder, a label id, a timestamp — so the ids get what is left.
 */
export function chunkIds(ids: string[], reserved = 0): string[][] {
  const perChunk = Math.max(1, SQL_MAX_BOUND_PARAMS - reserved);
  if (ids.length <= perChunk) return ids.length === 0 ? [] : [ids];

  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += perChunk) {
    chunks.push(ids.slice(i, i + perChunk));
  }
  return chunks;
}

export class BulkLimitError extends Error {
  constructor(count: number) {
    super(`Too many ids: ${count} exceeds the ${BULK_LIMIT} per-request limit`);
    this.name = "BulkLimitError";
  }
}

/** Attachment rows whose R2 blobs the caller must delete. */
export interface OrphanedAttachment {
  email_id: string;
  id: string;
  filename: string;
}

/**
 * Normalise and validate an incoming id list.
 *
 * Duplicates are collapsed so a repeated id cannot inflate the reported count,
 * and blanks are dropped so `["", null]` does not become a placeholder that
 * matches nothing.
 */
export function normalizeIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id === "string" && id.trim() !== "") seen.add(id);
  }
  const unique = [...seen];
  if (unique.length > BULK_LIMIT) throw new BulkLimitError(unique.length);
  return unique;
}

/** `?1, ?2, …` for an id list, so ids are never interpolated into SQL. */
export function placeholders(count: number, offset = 0): string {
  return Array.from({ length: count }, (_, i) => `?${i + 1 + offset}`).join(
    ", ",
  );
}

// ── Flags (read / starred) ─────────────────────────────────────────

/**
 * Set read and/or starred on many messages at once.
 *
 * Returns the number of rows actually changed, which can be lower than the id
 * count when an id no longer exists or already held the target value.
 */
export function bulkUpdateFlags(
  ctx: DurableObjectState,
  ids: unknown,
  patch: { read?: boolean; starred?: boolean },
): number {
  const list = normalizeIds(ids);
  if (list.length === 0) return 0;

  const assignments: string[] = [];
  const values: (string | number)[] = [];

  if (patch.read !== undefined) {
    assignments.push(`read = ?${values.length + 1}`);
    values.push(patch.read ? 1 : 0);
  }
  if (patch.starred !== undefined) {
    assignments.push(`starred = ?${values.length + 1}`);
    values.push(patch.starred ? 1 : 0);
  }
  if (assignments.length === 0) return 0;

  // Atomic across chunks: the caller asked for one operation, and a partial
  // result would leave the selection in two different states.
  return ctx.storage.transactionSync(() => {
    let changed = 0;
    for (const chunk of chunkIds(list, values.length)) {
      changed += ctx.storage.sql.exec(
        `UPDATE emails SET ${assignments.join(", ")}
				 WHERE id IN (${placeholders(chunk.length, values.length)})`,
        ...values,
        ...chunk,
      ).rowsWritten;
    }
    return changed;
  });
}

// ── Move ───────────────────────────────────────────────────────────

/**
 * Move many messages into one folder.
 *
 * Returns null when the destination does not exist, so the route can answer
 * 400 rather than silently moving nothing.
 *
 * A moved message loses any pending snooze: its return folder was recorded
 * against the folder it just left, so honouring it later would drag the message
 * back out of wherever the user has deliberately filed it.
 */
export function bulkMove(
  ctx: DurableObjectState,
  ids: unknown,
  folderId: string,
  /** This mailbox's address; when set, only its own mail may enter Sent. */
  mailboxAddress: string | null = null,
): number | null {
  // Same refusal as the single move, reported the same way — a bulk selection
  // must not be a way around it. See `canMoveInto`.
  if (!canMoveInto(folderId)) return null;

  const list = normalizeIds(ids);
  const folder = ctx.storage.sql
    .exec(`SELECT id FROM folders WHERE id = ?`, folderId)
    .toArray();
  if (folder.length === 0) return null;
  if (list.length === 0) return 0;

  // Received mail is skipped rather than filed into Sent (`canMoveMessageInto`).
  // The address binds after the chunk, at `?(chunk + 2)`.
  const intoSent = folderId.toLowerCase() === Folders.SENT && !!mailboxAddress;

  return ctx.storage.transactionSync(() => {
    let moved = 0;
    for (const chunk of chunkIds(list, 2)) {
      const sentGuard = intoSent
        ? ` AND LOWER(TRIM(sender)) = ?${chunk.length + 2}`
        : "";
      moved += ctx.storage.sql.exec(
        `UPDATE emails
				    SET folder_id = ?1,
				        snoozed_until = NULL,
				        snooze_return_folder = NULL
				  WHERE id IN (${placeholders(chunk.length, 1)})${sentGuard}`,
        folderId,
        ...chunk,
        ...(intoSent ? [mailboxAddress] : []),
      ).rowsWritten;
    }
    return moved;
  });
}

// ── Delete ─────────────────────────────────────────────────────────
//
// Deleting lives in ./trash.ts: a delete is a move to Trash unless the message
// is already binned, and single-message and bulk deletes have to agree on that
// or the same key would mean different things depending on how many rows were
// selected.

// ── Labels ─────────────────────────────────────────────────────────

/**
 * Add or remove one label across many messages.
 *
 * Returns null when the label does not exist. Adding uses INSERT OR IGNORE so
 * re-labelling an already-labelled message is a no-op rather than a
 * constraint failure.
 */
export function bulkSetLabel(
  ctx: DurableObjectState,
  ids: unknown,
  labelId: string,
  add: boolean,
): number | null {
  const list = normalizeIds(ids);
  const label = ctx.storage.sql
    .exec(`SELECT id FROM labels WHERE id = ?`, labelId)
    .toArray();
  if (label.length === 0) return null;
  if (list.length === 0) return 0;

  return ctx.storage.transactionSync(() => {
    let changed = 0;

    if (!add) {
      for (const chunk of chunkIds(list, 1)) {
        changed += ctx.storage.sql.exec(
          `DELETE FROM email_labels
					  WHERE label_id = ?1 AND email_id IN (${placeholders(chunk.length, 1)})`,
          labelId,
          ...chunk,
        ).rowsWritten;
      }
      return changed;
    }

    // Restricted to ids that exist, because email_labels.email_id is a foreign
    // key: a stale id from the client would otherwise abort the whole statement.
    for (const chunk of chunkIds(list, 1)) {
      changed += ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO email_labels (email_id, label_id)
				 SELECT id, ?1 FROM emails WHERE id IN (${placeholders(chunk.length, 1)})`,
        labelId,
        ...chunk,
      ).rowsWritten;
    }
    return changed;
  });
}

// ── Mark all read ──────────────────────────────────────────────────

export interface MarkAllReadScope {
  /** Restrict to one folder. */
  folder?: string;
  /** Restrict to messages carrying one label. */
  labelId?: string;
}

/**
 * Clear unread state in bulk.
 *
 * With no scope this covers every unread message in the mailbox, which is what
 * the unread badge counts. Scoping by folder or label narrows it to what the
 * user is actually looking at. The two scopes compose.
 *
 * `read = 0` is part of the predicate so the write touches only rows that
 * change, keeping `rowsWritten` an honest count of what the user affected.
 */
export function markAllRead(
  ctx: DurableObjectState,
  scope: MarkAllReadScope = {},
): number {
  const conditions: string[] = ["read = 0"];
  const values: string[] = [];

  if (scope.folder) {
    values.push(scope.folder);
    conditions.push(`folder_id = ?${values.length}`);
  }
  if (scope.labelId) {
    values.push(scope.labelId);
    conditions.push(
      `id IN (SELECT email_id FROM email_labels WHERE label_id = ?${values.length})`,
    );
  }

  const cursor = ctx.storage.sql.exec(
    `UPDATE emails SET read = 1 WHERE ${conditions.join(" AND ")}`,
    ...values,
  );
  return cursor.rowsWritten;
}
