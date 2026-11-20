// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Custom folder deletion.
 *
 * ## Why this is not a one-line DELETE
 *
 * `emails.folder_id` is declared `REFERENCES folders(id) ON DELETE CASCADE`
 * (migration 1). Deleting a folder row therefore destroyed every message filed
 * in it, and their attachment rows after that — no Trash, no Undo, and no
 * returned R2 keys, so the attachment blobs were orphaned in a bucket shared by
 * every mailbox where a prefix sweep would hit other people's data.
 *
 * Two other columns hold folder ids that the cascade does not police:
 *
 * - `snooze_return_folder` — where a snoozed message goes when it wakes up
 * - `trashed_from` — where a binned message came from
 *
 * `restoreFromTrash` already resolves `trashed_from` against `folders` and
 * falls back to the inbox, but the snooze sweep did not. A dangling
 * `snooze_return_folder` made `processDueSnoozes` violate the foreign key,
 * which would stall *every* pending snooze in the mailbox, not just the one.
 *
 * So deletion relocates the mail first, clears both pointers, and only then
 * drops the row. Everything runs in one `transactionSync` so a failure part-way
 * cannot leave mail pointing at a folder that no longer exists.
 */

import { Folders } from "../../shared/folders";

export type FolderDeleteFailure = "not_found" | "not_deletable";

export interface FolderDeleteResult {
	deleted: boolean;
	/** Set only when `deleted` is false. */
	reason?: FolderDeleteFailure;
	/** Messages moved out of the folder instead of being destroyed. */
	relocated: number;
	/** Snoozed messages whose return folder was this one. */
	clearedSnoozeReturns: number;
	/** Binned messages whose origin folder was this one. */
	clearedTrashOrigins: number;
	/** Where the relocated mail went, so the caller can say so. */
	movedTo: string;
}

/**
 * Delete a user-created folder, preserving its contents.
 *
 * Built-in folders are refused: `is_deletable = 0` marks the ones the rest of
 * the app addresses by name.
 *
 * @param options.fallbackFolder Where the contents go. Defaults to the inbox,
 *   which is where someone looks for mail that used to be somewhere else.
 */
export function deleteFolder(
	ctx: DurableObjectState,
	id: string,
	options: { fallbackFolder?: string } = {},
): FolderDeleteResult {
	const fallback = options.fallbackFolder ?? Folders.INBOX;

	const empty: FolderDeleteResult = {
		deleted: false,
		relocated: 0,
		clearedSnoozeReturns: 0,
		clearedTrashOrigins: 0,
		movedTo: fallback,
	};

	if (!id || id === fallback) {
		// Relocating a folder's mail into itself would delete it via the cascade.
		return { ...empty, reason: "not_deletable" };
	}

	const folder = ctx.storage.sql
		.exec(`SELECT id, is_deletable FROM folders WHERE id = ?1`, id)
		.toArray()[0] as { id: string; is_deletable: number } | undefined;

	if (!folder) return { ...empty, reason: "not_found" };
	if (folder.is_deletable === 0) return { ...empty, reason: "not_deletable" };

	return ctx.storage.transactionSync(() => {
		// Relocate first: while any row still references the folder, the DELETE
		// below would cascade into it.
		const relocated = ctx.storage.sql.exec(
			`UPDATE emails SET folder_id = ?1 WHERE folder_id = ?2`,
			fallback,
			id,
		).rowsWritten;

		// A snoozed message parked elsewhere still remembers this folder as its
		// destination. NULL means "wake up in the inbox".
		const clearedSnoozeReturns = ctx.storage.sql.exec(
			`UPDATE emails SET snooze_return_folder = NULL
			  WHERE snooze_return_folder = ?1`,
			id,
		).rowsWritten;

		// Same for a binned message: NULL makes Restore fall back to the inbox,
		// which `restoreFromTrash` already handles.
		const clearedTrashOrigins = ctx.storage.sql.exec(
			`UPDATE emails SET trashed_from = NULL WHERE trashed_from = ?1`,
			id,
		).rowsWritten;

		ctx.storage.sql.exec(`DELETE FROM folders WHERE id = ?1`, id);

		return {
			deleted: true,
			relocated,
			clearedSnoozeReturns,
			clearedTrashOrigins,
			movedTo: fallback,
		};
	});
}
