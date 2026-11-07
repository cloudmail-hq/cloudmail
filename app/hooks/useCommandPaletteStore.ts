// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SnippetTemplate } from "~/lib/snippets";
import type { PaletteMode } from "~/lib/command-palette";

/** How many recently used commands and threads are remembered. */
const RECENT_LIMIT = 8;

export interface RecentThread {
	mailboxId: string;
	id: string;
	subject: string;
	sender: string;
}

interface CommandPaletteState {
	isOpen: boolean;
	/** Which list the palette opens on. */
	mode: PaletteMode;
	open: (mode?: PaletteMode) => void;
	close: () => void;

	/** Command ids, most recent first. Persisted per device. */
	recentCommands: string[];
	noteCommand: (id: string) => void;

	/** Threads opened lately, most recent first. Persisted per device. */
	recentThreads: RecentThread[];
	noteThread: (thread: RecentThread) => void;

	/**
	 * Insert a template into the open composer, at the caret.
	 *
	 * Registered by the composer while it is mounted and null otherwise, which
	 * is also how the palette knows to offer "Insert template…".
	 */
	insertTemplate: ((template: SnippetTemplate) => void) | null;
	setInsertTemplate: (fn: ((template: SnippetTemplate) => void) | null) => void;
}

export const useCommandPaletteStore = create<CommandPaletteState>()(
	persist(
		(set) => ({
			isOpen: false,
			mode: "all",
			open: (mode = "all") => set({ isOpen: true, mode }),
			close: () => set({ isOpen: false }),

			recentCommands: [],
			noteCommand: (id) =>
				set((state) => ({
					recentCommands: [id, ...state.recentCommands.filter((c) => c !== id)].slice(
						0,
						RECENT_LIMIT,
					),
				})),

			recentThreads: [],
			noteThread: (thread) =>
				set((state) => {
					const rest = state.recentThreads.filter(
						(t) => !(t.id === thread.id && t.mailboxId === thread.mailboxId),
					);
					return { recentThreads: [thread, ...rest].slice(0, RECENT_LIMIT) };
				}),

			insertTemplate: null,
			setInsertTemplate: (fn) => set({ insertTemplate: fn }),
		}),
		{
			name: "command-palette",
			// Subjects and senders stay on this device; nothing here is sent anywhere.
			partialize: (state) => ({
				recentCommands: state.recentCommands,
				recentThreads: state.recentThreads,
			}),
		},
	),
);
