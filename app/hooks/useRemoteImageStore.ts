// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
	addRemoteImagePattern,
	removeRemoteImagePattern,
	replaceRemoteImagePattern,
	senderAddress,
	senderDomainPattern,
} from "~/lib/remote-images";

interface RemoteImageStore {
	/**
	 * Senders whose remote images load without asking, as address or `@domain`
	 * patterns. Empty by default: nothing is trusted until the reader says so.
	 */
	trustedSenders: string[];
	/** Trust one address, from the "always for this sender" action. */
	trustSender: (sender: string) => void;
	/** Trust a whole domain, from the "always for this domain" action. */
	trustDomain: (sender: string) => void;
	/** Add a hand-typed pattern from settings. Invalid input is ignored. */
	add: (pattern: string) => void;
	remove: (pattern: string) => void;
	/** Edit a pattern in place. Invalid input leaves the original untouched. */
	replace: (from: string, to: string) => void;
	clear: () => void;
}

/**
 * Kept in `localStorage` rather than the mailbox.
 *
 * Loading a remote image reveals this browser's IP and the fact that the message
 * was opened here, so "do I trust this sender with that" is a property of the
 * device sitting in front of the reader, not of the mailbox. It also means the
 * preference works on a shared mailbox without one person's choice silently
 * unblocking trackers for everyone else reading it.
 *
 * The tradeoff is that the list doesn't follow the user to another browser, and
 * the settings section says so.
 */
export const useRemoteImageStore = create<RemoteImageStore>()(
	persist(
		(set, get) => ({
			trustedSenders: [],

			trustSender: (sender) => {
				const address = senderAddress(sender);
				if (!address) return;
				set({ trustedSenders: addRemoteImagePattern(get().trustedSenders, address) });
			},

			trustDomain: (sender) => {
				const domain = senderDomainPattern(sender);
				if (!domain) return;
				set({ trustedSenders: addRemoteImagePattern(get().trustedSenders, domain) });
			},

			// The helpers return the original array when nothing changed, so an
			// unchanged set never notifies subscribers.
			add: (pattern) =>
				set({ trustedSenders: addRemoteImagePattern(get().trustedSenders, pattern) }),

			remove: (pattern) =>
				set({
					trustedSenders: removeRemoteImagePattern(get().trustedSenders, pattern),
				}),

			replace: (from, to) =>
				set({
					trustedSenders: replaceRemoteImagePattern(get().trustedSenders, from, to),
				}),

			clear: () =>
				set((state) =>
					state.trustedSenders.length === 0 ? state : { trustedSenders: [] },
				),
		}),
		{
			name: "remote-image-trust",
			partialize: (state) => ({ trustedSenders: state.trustedSenders }),
		},
	),
);
