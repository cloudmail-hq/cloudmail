// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Whether a composer that is going away still holds typing that autosave has
 * not written yet.
 *
 * Autosave waits for a short idle gap, so anything typed in the last couple of
 * seconds before the composer closes (its X, Escape, opening another message,
 * archiving the thread being answered) was lost. Gmail and Outlook both save on
 * close; the composer now does the same when this says so.
 */
export interface ComposeFlushState {
	/** The message already left (sent, scheduled) or was discarded on purpose. */
	dispatched: boolean;
	/** A reopened draft's own attachments are still loading: the set is incomplete. */
	loadingAttachments: boolean;
	/** JSON of the current fields, in the same shape autosave snapshots. */
	snapshot: string;
	/** JSON of the fields as last written, or null if never written. */
	savedSnapshot: string | null;
	/** The attachment set differs from the one last written. */
	attachmentsChanged: boolean;
	/** Any recipient, subject, prose or attachment at all. */
	hasContent: boolean;
}

export function shouldFlushDraftOnClose(state: ComposeFlushState): boolean {
	if (state.dispatched || state.loadingAttachments) return false;
	if (!state.hasContent) return false;
	return state.snapshot !== state.savedSnapshot || state.attachmentsChanged;
}
