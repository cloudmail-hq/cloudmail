// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Canonical folder ID constants.
 *
 * Every part of the stack — API routes, Durable Object, MCP, agent,
 * frontend sidebar — references folder IDs. This module is the single
 * source of truth so we don't scatter magic strings everywhere.
 */

export const Folders = {
	INBOX: "inbox",
	SENT: "sent",
	DRAFT: "draft",
	ARCHIVE: "archive",
	TRASH: "trash",
	SPAM: "spam",
	SNOOZED: "snoozed",
	SCHEDULED: "scheduled",
	/** First-time senders waiting for a Yes or No. See shared/ai-triage.ts. */
	SCREENER: "screener",
} as const;

export type FolderId = (typeof Folders)[keyof typeof Folders];

/**
 * System folder IDs that appear in the sidebar (excludes spam).
 * Order here matches the sidebar display order.
 */
export const SYSTEM_FOLDER_IDS: readonly FolderId[] = [
	Folders.INBOX,
	Folders.SNOOZED,
	Folders.SENT,
	Folders.SCHEDULED,
	Folders.DRAFT,
	Folders.ARCHIVE,
	Folders.TRASH,
];

/**
 * Human-readable display names for folder IDs.
 * Used in the sidebar, search result badges, and tool descriptions.
 */
export const FOLDER_DISPLAY_NAMES: Record<string, string> = {
	[Folders.INBOX]: "Inbox",
	[Folders.SENT]: "Sent",
	[Folders.DRAFT]: "Drafts",
	[Folders.ARCHIVE]: "Archive",
	[Folders.TRASH]: "Trash",
	[Folders.SPAM]: "Spam",
	[Folders.SNOOZED]: "Snoozed",
	[Folders.SCHEDULED]: "Scheduled",
	[Folders.SCREENER]: "Screener",
};

/** Formatted string for tool parameter descriptions (agent + MCP). */
export const FOLDER_TOOL_DESCRIPTION =
	"Folder to list: inbox, sent, draft, archive, trash";

/** Formatted string for move-email tool descriptions. */
export const MOVE_FOLDER_TOOL_DESCRIPTION =
	"Target folder: inbox, sent, archive, trash, spam, or a custom folder id";

/**
 * Folders a message cannot be *moved* into.
 *
 * Membership of these is produced by a mechanism, not by filing, and every row
 * in them carries state that a move does not create:
 *
 * - **Drafts** means "unsent work you can edit and send". A received message
 *   dropped in here acquires Send and Edit buttons, so Send would put someone
 *   else's incoming mail back on the wire under the mailbox's own name. It also
 *   forges the one invariant the send path relies on to identify a draft it may
 *   destroy — see `destroySupersededDraft` — which turned `organise` plus
 *   `draft` into a permanent delete for any message, without
 *   `deletePermanently`.
 * - **Scheduled** means "queued, with a `scheduled_sends` row and an alarm". A
 *   move creates neither, so the message would sit there looking like it was
 *   about to go out, offering to cancel a send that does not exist, forever.
 *
 * - **Snoozed** means "hidden until `snoozed_until`, then returned". A move sets
 *   neither the wake time nor the return folder, so the message would never come
 *   back. Snoozing goes through the snooze path, which records both.
 *
 * Trash is a legitimate destination: a move there is a filing decision, even
 * though Delete is the path that also records `trashed_from`.
 */
export const UNMOVABLE_INTO_FOLDER_IDS: readonly FolderId[] = [
	Folders.DRAFT,
	Folders.SCHEDULED,
	Folders.SNOOZED,
];

/** Whether mail may be filed into this folder. Custom folders always may. */
export function canMoveInto(folderId: string): boolean {
	return !UNMOVABLE_INTO_FOLDER_IDS.includes(
		folderId.toLowerCase() as FolderId,
	);
}

/**
 * Whether one particular message may be filed into a folder.
 *
 * `canMoveInto` plus direction: Sent holds what this mailbox sent, so received
 * mail filed there would show up as outgoing (and in sent analytics). Mail this
 * mailbox wrote may go back to Sent after being archived; mail it received may
 * not.
 *
 * `outbound` is null when the caller cannot tell (no mailbox address to compare
 * against); the move is then allowed, as it was before this check existed.
 */
export function canMoveMessageInto(
	folderId: string,
	message: { outbound: boolean | null },
): boolean {
	if (!canMoveInto(folderId)) return false;
	if (folderId.toLowerCase() === Folders.SENT) return message.outbound !== false;
	return true;
}

/** Whether `sender` is this mailbox, i.e. the message went out from it. */
export function isOutboundFrom(
	sender: string | null | undefined,
	mailbox: string | null | undefined,
): boolean | null {
	if (!mailbox) return null;
	if (!sender) return false;
	const angled = sender.match(/<([^>]+)>/);
	const address = (angled ? angled[1] : sender).trim().toLowerCase();
	return address === mailbox.trim().toLowerCase();
}

/**
 * Look up a display name for a folder ID, falling back to the raw ID
 * with a capitalised first letter.
 */
export function getFolderDisplayName(folderId: string): string {
	return FOLDER_DISPLAY_NAMES[folderId.toLowerCase()] || folderId.charAt(0).toUpperCase() + folderId.slice(1);
}

/**
 * What a folder's count badge means.
 *
 * Inbox and filing folders count unread mail. Drafts and Scheduled count what
 * is in them: a draft is your own unsent work (stored unread), not mail waiting
 * to be read, so it gets a neutral total rather than an unread pill.
 */
export function folderCountKind(folderId: string): "unread" | "total" {
	const id = folderId.toLowerCase();
	return id === Folders.DRAFT || id === Folders.SCHEDULED ? "total" : "unread";
}

/** A count for a badge: exact up to 999, then "999+". Empty for zero. */
export function formatBadgeCount(count: number | null | undefined): string {
	if (!count || count <= 0) return "";
	return count > 999 ? "999+" : String(count);
}
