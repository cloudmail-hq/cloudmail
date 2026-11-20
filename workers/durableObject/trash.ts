// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Trash semantics.
 *
 * Deleting a message used to drop the row and its attachment blobs on the
 * spot, which meant a mis-click — or an agent tool call — destroyed mail with
 * no way back, and the Trash folder only ever filled by an explicit
 * "Move to → Trash". That is not what anyone means by Delete in a mail client.
 *
 * So a delete is now two-stage, the way every mail client behaves:
 *
 *   - a message anywhere else moves to Trash, remembering where it came from
 *   - a message already in Trash or Spam is destroyed
 *
 * Callers that genuinely need the row gone (a draft superseded by the copy
 * that was just queued for sending, a draft being rewritten in place) pass
 * `permanent`, because routing those through Trash would litter it with a copy
 * of everything ever sent.
 *
 * Plain functions over `DurableObjectState`, matching ./bulk.ts and
 * ./features.ts, so the behaviour is testable without a Durable Object.
 * `MailboxDO` keeps thin delegating methods because only class methods are
 * reachable over RPC.
 */

import { Folders } from "../../shared/folders";
import { attachmentKey } from "../lib/attachments";
import {
  chunkIds,
  normalizeIds,
  placeholders,
  type OrphanedAttachment,
} from "./bulk";

/**
 * Folders where Delete means "destroy this".
 *
 * Trash is the obvious one. Spam is included because a second delete on a junk
 * message is a request to be rid of it, not a request to move it one folder
 * sideways.
 */
export const TERMINAL_FOLDERS: readonly string[] = [
  Folders.TRASH,
  Folders.SPAM,
];

/**
 * What a delete actually did.
 *
 * Both counts are reported because a single request can do both: selecting
 * across an inbox and a Trash view and pressing Delete trashes some rows and
 * destroys others. The UI needs to know which happened to word the toast and
 * decide whether Undo is offered.
 */
export interface DeleteOutcome {
  /** Rows moved to Trash, recoverable. */
  trashed: number;
  /** Rows destroyed. */
  deleted: number;
  /** R2 keys the caller must delete; empty when nothing was destroyed. */
  attachmentKeys: string[];
}

/** Collect the R2 keys held by a set of messages, before their rows go away. */
function attachmentKeysFor(ctx: DurableObjectState, ids: string[]): string[] {
  if (ids.length === 0) return [];

  const keys: string[] = [];

  // Chunked to stay inside the bound-parameter budget; see `chunkIds`.
  for (const chunk of chunkIds(ids)) {
    // Consume the cursor synchronously: a cursor held across an await has no
    // snapshot isolation guarantee.
    const rows = ctx.storage.sql
      .exec(
        `SELECT email_id, id, filename FROM attachments
				  WHERE email_id IN (${placeholders(chunk.length)})`,
        ...chunk,
      )
      .toArray() as unknown as OrphanedAttachment[];

    for (const row of rows) {
      keys.push(attachmentKey(row.email_id, row.id, row.filename));
    }
  }

  return keys;
}

/** Destroy rows outright, returning the blobs left behind. */
function destroy(
  ctx: DurableObjectState,
  ids: string[],
): { deleted: number; attachmentKeys: string[] } {
  if (ids.length === 0) return { deleted: 0, attachmentKeys: [] };

  const attachmentKeys = attachmentKeysFor(ctx, ids);

  // One transaction across the chunks. Splitting the statement to respect the
  // bound-parameter budget must not turn one delete into several independently
  // failing ones: the caller deletes `attachmentKeys` from R2 afterwards, so a
  // half-applied delete would strip the blobs off messages whose rows survived.
  const deleted = ctx.storage.transactionSync(() => {
    let count = 0;
    for (const chunk of chunkIds(ids)) {
      count += ctx.storage.sql.exec(
        `DELETE FROM emails WHERE id IN (${placeholders(chunk.length)})`,
        ...chunk,
      ).rowsWritten;
    }
    return count;
  });

  return { deleted, attachmentKeys };
}

/**
 * Move rows to Trash, recording where each one came from.
 *
 * SQLite evaluates every right-hand side against the pre-update row, so
 * `trashed_from = folder_id` captures the old folder even though the same
 * statement overwrites `folder_id`.
 *
 * A pending snooze is dropped: its return folder was recorded against the
 * folder the message just left, so honouring it later would haul the message
 * back out of the bin on its own.
 */
function moveToTrash(
  ctx: DurableObjectState,
  ids: string[],
  now: string,
): number {
  if (ids.length === 0) return 0;

  // Atomic across chunks, so a partial failure cannot leave half a selection
  // binned and half of it where it was.
  return ctx.storage.transactionSync(() => {
    let trashed = 0;
    for (const chunk of chunkIds(ids, 2)) {
      trashed += ctx.storage.sql.exec(
        `UPDATE emails
				    SET trashed_from = folder_id,
				        folder_id = ?1,
				        trashed_at = ?2,
				        snoozed_until = NULL,
				        snooze_return_folder = NULL
				  WHERE id IN (${placeholders(chunk.length, 2)})`,
        Folders.TRASH,
        now,
        ...chunk,
      ).rowsWritten;
    }
    return trashed;
  });
}

/**
 * Delete messages, binning them first unless they are already binned.
 *
 * Ids that no longer exist are ignored rather than reported as an error: two
 * tabs deleting the same message is ordinary, and the second one has nothing
 * to complain about.
 */
export function deleteOrTrash(
  ctx: DurableObjectState,
  ids: unknown,
  options: { permanent?: boolean; now?: string } = {},
): DeleteOutcome {
  const list = normalizeIds(ids);
  if (list.length === 0) return { trashed: 0, deleted: 0, attachmentKeys: [] };

  if (options.permanent) {
    return { trashed: 0, ...destroy(ctx, list) };
  }

  const rows: { id: string; folder_id: string }[] = [];
  for (const chunk of chunkIds(list)) {
    rows.push(
      ...(ctx.storage.sql
        .exec(
          `SELECT id, folder_id FROM emails WHERE id IN (${placeholders(chunk.length)})`,
          ...chunk,
        )
        .toArray() as unknown as { id: string; folder_id: string }[]),
    );
  }

  const terminal: string[] = [];
  const binnable: string[] = [];
  for (const row of rows) {
    if (TERMINAL_FOLDERS.includes(row.folder_id)) terminal.push(row.id);
    else binnable.push(row.id);
  }

  const destroyed = destroy(ctx, terminal);
  const trashed = moveToTrash(
    ctx,
    binnable,
    options.now ?? new Date().toISOString(),
  );

  return { trashed, ...destroyed };
}

/**
 * Bin messages, and never destroy one.
 *
 * `deleteOrTrash` escalates to destroying whatever is already in Trash or
 * Spam. That is right for a person pressing Delete twice, and wrong for an
 * agent: the MCP tools must not be able to destroy mail at all. The folder is
 * filtered in the same statement that moves the rows, so a message moved into
 * Trash by another client between a caller's check and this call is left where
 * it is rather than destroyed.
 *
 * Returns which ids were binned, which were already binned (left alone), and
 * which do not exist, so the caller can report each honestly.
 */
export function trashOnly(
  ctx: DurableObjectState,
  ids: unknown,
  options: { now?: string } = {},
): { trashed: string[]; alreadyBinned: string[]; missing: string[] } {
  const list = normalizeIds(ids);
  if (list.length === 0) return { trashed: [], alreadyBinned: [], missing: [] };

  const now = options.now ?? new Date().toISOString();
  return ctx.storage.transactionSync(() => {
    const folders = new Map<string, string>();
    for (const chunk of chunkIds(list)) {
      for (const row of ctx.storage.sql
        .exec(
          `SELECT id, folder_id FROM emails WHERE id IN (${placeholders(chunk.length)})`,
          ...chunk,
        )
        .toArray() as unknown as { id: string; folder_id: string }[]) {
        folders.set(row.id, row.folder_id);
      }
    }

    const binnable = list.filter((id) => {
      const folder = folders.get(id);
      return folder !== undefined && !TERMINAL_FOLDERS.includes(folder);
    });

    for (const chunk of chunkIds(binnable, 4)) {
      ctx.storage.sql.exec(
        `UPDATE emails
				    SET trashed_from = folder_id,
				        folder_id = ?1,
				        trashed_at = ?2,
				        snoozed_until = NULL,
				        snooze_return_folder = NULL
				  WHERE folder_id NOT IN (?3, ?4)
				    AND id IN (${placeholders(chunk.length, 4)})`,
        Folders.TRASH,
        now,
        Folders.TRASH,
        Folders.SPAM,
        ...chunk,
      );
    }

    return {
      trashed: binnable,
      alreadyBinned: list.filter((id) => {
        const folder = folders.get(id);
        return folder !== undefined && TERMINAL_FOLDERS.includes(folder);
      }),
      missing: list.filter((id) => !folders.has(id)),
    };
  });
}

/**
 * Destroy the draft a queued send was composed from.
 *
 * Deliberately narrower than `deleteOrTrash(…, { permanent: true })`, which will
 * destroy any row it is handed. Sending a draft has to remove that draft — the
 * message is on its way, and binning the row would leave a copy of everything
 * ever sent sitting in Trash — but the authority being exercised is "send", not
 * "destroy arbitrary mail". Scoping the statement to the Drafts folder means the
 * send path cannot be talked into destroying a received message by passing its
 * id, so the two authorities stay separate even though one calls the other.
 *
 * A missing or non-draft id reports zero rather than raising: the caller has
 * already queued the message by this point, and failing the send because the
 * draft was tidied up in another tab would be the worse outcome.
 *
 * The folder is resolved by id *or* name for the same reason `updateDraft` does
 * it: the seeded row is `('draft', 'Drafts')`, so matching on name alone finds
 * nothing and the delete would silently do nothing.
 */
export function destroySupersededDraft(
  ctx: DurableObjectState,
  id: unknown,
): { deleted: number; attachmentKeys: string[] } {
  if (typeof id !== "string" || id === "") {
    return { deleted: 0, attachmentKeys: [] };
  }

  const row = ctx.storage.sql
    .exec(
      `SELECT e.id FROM emails e
			   JOIN folders f ON f.id = e.folder_id
			  WHERE e.id = ?1 AND (f.id = ?2 OR f.name = ?2)`,
      id,
      Folders.DRAFT,
    )
    .toArray()[0] as { id: string } | undefined;

  if (!row) return { deleted: 0, attachmentKeys: [] };

  return destroy(ctx, [id]);
}

/**
 * Put binned messages back where they came from.
 *
 * The origin folder is validated against `folders` rather than trusted, because
 * a custom folder can be deleted while a message that lived in it sits in the
 * bin — restoring to a dangling id would fail the foreign key and take the
 * whole statement with it. Anything unresolvable lands in the inbox, which is
 * where someone looks for a message they just recovered.
 *
 * Scoped to rows actually in Trash so a stale id from a client cannot yank a
 * filed message out of its folder.
 */
export function restoreFromTrash(
  ctx: DurableObjectState,
  ids: unknown,
): number {
  const list = normalizeIds(ids);
  if (list.length === 0) return 0;

  return ctx.storage.transactionSync(() => {
    let restored = 0;
    for (const chunk of chunkIds(list, 2)) {
      restored += ctx.storage.sql.exec(
        `UPDATE emails
			    SET folder_id = COALESCE(
			            (SELECT id FROM folders WHERE id = emails.trashed_from),
			            ?1
			        ),
			        trashed_from = NULL,
			        trashed_at = NULL
			  WHERE folder_id = ?2
			    AND id IN (${placeholders(chunk.length, 2)})`,
        Folders.INBOX,
        Folders.TRASH,
        ...chunk,
      ).rowsWritten;
    }
    return restored;
  });
}

/**
 * Destroy everything in Trash.
 *
 * Deliberately not id-based: the point of Empty Trash is not having to
 * enumerate what is in there, and the bin can hold more than the bulk id
 * ceiling allows.
 */
export function emptyTrash(ctx: DurableObjectState): {
  deleted: number;
  attachmentKeys: string[];
} {
  const rows = ctx.storage.sql
    .exec(
      `SELECT a.email_id AS email_id, a.id AS id, a.filename AS filename
			   FROM attachments a
			   JOIN emails e ON e.id = a.email_id
			  WHERE e.folder_id = ?`,
      Folders.TRASH,
    )
    .toArray() as unknown as OrphanedAttachment[];

  const attachmentKeys = rows.map((row) =>
    attachmentKey(row.email_id, row.id, row.filename),
  );

  const cursor = ctx.storage.sql.exec(
    `DELETE FROM emails WHERE folder_id = ?`,
    Folders.TRASH,
  );

  return { deleted: cursor.rowsWritten, attachmentKeys };
}

/**
 * How long a binned message is kept before it is destroyed for good.
 *
 * Thirty days is the convention across mail clients, and the reason a retention
 * sweep exists at all: without one, Trash is not a bin, it is a folder that
 * grows forever and quietly keeps mail the user believes they deleted.
 */
export const TRASH_RETENTION_DAYS = 30;

/**
 * Destroy messages that have been in the bin longer than the retention window.
 *
 * Rows binned before migration 14 have no `trashed_at`, so they are stamped on
 * first sight rather than deleted immediately: the alternative is destroying
 * mail whose age we do not actually know.
 *
 * Runs from the alarm, which already wakes for snoozes and scheduled sends, so
 * this costs no additional scheduling.
 */
export function purgeExpiredTrash(
  ctx: DurableObjectState,
  options: { now?: Date; retentionDays?: number } = {},
): { deleted: number; stamped: number; attachmentKeys: string[] } {
  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? TRASH_RETENTION_DAYS;

  // Give undated rows a clock to run against, starting now.
  const stamped = ctx.storage.sql.exec(
    `UPDATE emails SET trashed_at = ?1
		  WHERE folder_id = ?2 AND trashed_at IS NULL`,
    now.toISOString(),
    Folders.TRASH,
  ).rowsWritten;

  const cutoff = new Date(
    now.getTime() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Attachment keys are collected before the delete cascades their rows away;
  // the caller owns the R2 cleanup because this object has no bucket binding.
  const rows = ctx.storage.sql
    .exec(
      `SELECT a.email_id AS email_id, a.id AS id, a.filename AS filename
			   FROM attachments a
			   JOIN emails e ON e.id = a.email_id
			  WHERE e.folder_id = ?1 AND e.trashed_at IS NOT NULL AND e.trashed_at < ?2`,
      Folders.TRASH,
      cutoff,
    )
    .toArray() as unknown as OrphanedAttachment[];

  const attachmentKeys = rows.map((row) =>
    attachmentKey(row.email_id, row.id, row.filename),
  );

  const deleted = ctx.storage.sql.exec(
    `DELETE FROM emails
		  WHERE folder_id = ?1 AND trashed_at IS NOT NULL AND trashed_at < ?2`,
    Folders.TRASH,
    cutoff,
  ).rowsWritten;

  return { deleted, stamped, attachmentKeys };
}
