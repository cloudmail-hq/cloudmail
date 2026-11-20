// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
	type VisibilityCandidate,
	pruneHidden,
	toggleMailboxHidden,
} from "~/lib/mailbox-visibility";

interface MailboxVisibilityStore {
	/**
	 * Mailbox ids the user has chosen not to see, lowercased.
	 *
	 * Deliberately a hide-list rather than a show-list: see the note in
	 * `~/lib/mailbox-visibility`. A mailbox created after this was saved must
	 * appear on its own, or mail arrives somewhere invisible.
	 */
	hiddenMailboxIds: string[];
	toggle: (mailboxes: VisibilityCandidate[], id: string) => void;
	showAll: () => void;
	/** Forget ids for mailboxes that no longer exist. */
	prune: (mailboxes: VisibilityCandidate[]) => void;
}

export const useMailboxVisibilityStore = create<MailboxVisibilityStore>()(
	persist(
		(set, get) => ({
			hiddenMailboxIds: [],
			toggle: (mailboxes, id) =>
				set({
					hiddenMailboxIds: toggleMailboxHidden(
						get().hiddenMailboxIds,
						mailboxes,
						id,
					),
				}),
			showAll: () => set({ hiddenMailboxIds: [] }),
			prune: (mailboxes) => {
				const current = get().hiddenMailboxIds;
				const pruned = pruneHidden(current, mailboxes);
				// Only write when something actually went away: `prune` runs from an
				// effect on every mailbox list change, and setting an equal-but-new
				// array would re-render every subscriber for nothing.
				if (pruned.length !== current.length) {
					set({ hiddenMailboxIds: pruned });
				}
			},
		}),
		{
			name: "mailbox-visibility",
			partialize: (state) => ({ hiddenMailboxIds: state.hiddenMailboxIds }),
		},
	),
);
