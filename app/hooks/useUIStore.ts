// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { create } from "zustand";
import type { ShortcutRow } from "~/lib/shortcuts";
import type { Email } from "~/types";

export type ComposeMode = "new" | "reply" | "reply-all" | "forward";

export interface ComposeOptions {
	mode: ComposeMode;
	originalEmail?: Email | null;
	/** When editing a draft, this holds the draft email to pre-fill the composer */
	draftEmail?: Email | null;
	/**
	 * Seed values for a fresh message.
	 *
	 * Used by surfaces that know who the message is for without having an email
	 * to reply to — the People view composes to the selected correspondent.
	 */
	prefill?: {
		to?: string;
		cc?: string;
		bcc?: string;
		subject?: string;
		/** HTML body to open with, in place of the bare signature block. */
		body?: string;
	};
	/**
	 * Mailbox to send from.
	 *
	 * The workspace takes this from the route; the People view spans every
	 * mailbox and has to nominate one.
	 */
	mailboxId?: string;
	/**
	 * Open the composer already popped out to full screen.
	 *
	 * Gmail's `Shift+r` / `Shift+a` / `Shift+f` reply "in a new window". This app
	 * docks its composer in a corner panel rather than spawning an OS window, so
	 * the equivalent is the fullscreen state — same intent (get out of the way of
	 * the list, give the message room) without popup blockers in the way.
	 */
	popOut?: boolean;
}

interface UIState {
	// Side panel state
	selectedEmailId: string | null;
	isComposing: boolean;
	_previousEmailId: string | null;
	selectEmail: (id: string | null) => void;
	startCompose: (options?: ComposeOptions) => void;
	closePanel: () => void;
	closeCompose: () => void;

	// Compose options
	composeOptions: ComposeOptions;

	// Mobile sidebar
	isSidebarOpen: boolean;
	openSidebar: () => void;
	closeSidebar: () => void;
	toggleSidebar: () => void;

	// Agent panel
	isAgentPanelOpen: boolean;
	toggleAgentPanel: () => void;

	/**
	 * The messages currently listed, in display order.
	 *
	 * Published by the list view so keyboard navigation can step through it from
	 * the layout, without the shortcut handler needing to know which route is
	 * mounted or re-running its data query.
	 *
	 * Rows rather than bare ids: shortcuts need to know what they are toggling.
	 * `s` on the cursor row has to star or unstar it, and `*u` has to pick out
	 * the unread ones — with ids alone both would need a cache lookup per row,
	 * and neither could resolve without touching the query client.
	 */
	navigableRows: ShortcutRow[];
	setNavigableRows: (rows: ShortcutRow[]) => void;

	/**
	 * The visible list cursor.
	 *
	 * Deliberately separate from `selectedEmailId`: the cursor marks the row a
	 * keystroke will act on, and moving it opens nothing. That separation is what
	 * lets `j`/`k` walk the list and `e`/`#` archive or bin a row without ever
	 * loading it, the way Gmail behaves. A cursor that also opened the message
	 * would refetch a body on every keypress.
	 *
	 * Null before the user has moved it, so the first `j` starts at the top.
	 */
	cursorEmailId: string | null;
	setCursorEmailId: (id: string | null) => void;

	/**
	 * Where a range selection started, for shift-clicking a span of rows.
	 *
	 * Held separately from the cursor because the cursor keeps moving while the
	 * anchor must not: `x` at the far end of a range has to know where the range
	 * began, and re-deriving that from the checked set is ambiguous once the set
	 * has holes in it.
	 */
	selectionAnchorId: string | null;
	setSelectionAnchorId: (id: string | null) => void;

	/**
	 * Ids ticked for a bulk action.
	 *
	 * Distinct from `selectedEmailId`, which is the one message open in the
	 * reading panel. A checked set can span rows the user never opened.
	 */
	checkedEmailIds: string[];
	toggleChecked: (id: string) => void;
	/** Replaces the set outright, for select-all / select-none. */
	setCheckedEmailIds: (ids: string[]) => void;
	clearChecked: () => void;
}

export const useUIStore = create<UIState>((set, get) => ({
	selectedEmailId: null,
	isComposing: false,
	_previousEmailId: null,
	composeOptions: { mode: "new", originalEmail: null },
	isSidebarOpen: false,
	// Opt-in: the reading pane gets the full width until the user asks for the agent.
	isAgentPanelOpen: false,
	navigableRows: [],
	cursorEmailId: null,
	selectionAnchorId: null,
	checkedEmailIds: [],

	/*
	 * Opening a message drags the cursor onto it, so dismissing the pane leaves the
	 * cursor where the reader's attention already is rather than back at whatever
	 * row they last arrowed past.
	 *
	 * Only when the message is actually one of the listed rows, though. A thread
	 * opened from a person view, a direct link, or a search result the current list
	 * does not contain would otherwise point `aria-activedescendant` at a row id
	 * that was never rendered — a reference screen readers follow and find nothing
	 * at. In that case the cursor stays where it was, which is still a real row.
	 */
	selectEmail: (id) =>
		set((state) => ({
			selectedEmailId: id,
			isComposing: false,
			cursorEmailId:
				id !== null && state.navigableRows.some((row) => row.id === id)
					? id
					: state.cursorEmailId,
		})),

	setCursorEmailId: (id) =>
		set((state) => (state.cursorEmailId === id ? state : { cursorEmailId: id })),

	setSelectionAnchorId: (id) =>
		set((state) =>
			state.selectionAnchorId === id ? state : { selectionAnchorId: id },
		),

	// Ticking a row also anchors the range, so a later shift-click has a start
	// point without the caller having to set two pieces of state in step.
	toggleChecked: (id) =>
		set((state) => ({
			checkedEmailIds: state.checkedEmailIds.includes(id)
				? state.checkedEmailIds.filter((existing) => existing !== id)
				: [...state.checkedEmailIds, id],
			selectionAnchorId: id,
		})),

	setCheckedEmailIds: (ids) =>
		set({
			checkedEmailIds: ids,
			// A wholesale replacement (`*a`, `*u`, select-all) has no single origin
			// row, so any surviving anchor would extend a range from somewhere the
			// user never clicked.
			selectionAnchorId: null,
		}),

	// Returns the existing array when already empty, so clearing on unmount or
	// after a no-op action doesn't notify every subscriber.
	clearChecked: () =>
		set((state) =>
			state.checkedEmailIds.length === 0 && state.selectionAnchorId === null
				? state
				: { checkedEmailIds: [], selectionAnchorId: null },
		),

	setNavigableRows: (rows) =>
		set((state) => {
			// Field-compare first: the list view republishes on every render, and a
			// fresh array each time would notify every subscriber. Read and starred
			// state is compared too, or starring a row would leave the shortcut
			// handler holding the pre-toggle value and `s` would stop inverting.
			const same =
				state.navigableRows.length === rows.length &&
				state.navigableRows.every(
					(row, i) =>
						row.id === rows[i].id &&
						row.read === rows[i].read &&
						row.starred === rows[i].starred,
				);
			if (same) return state;
			// Drop a cursor whose row has gone — archived, filtered out, or left
			// behind by paging. Keeping it would point `aria-activedescendant` at an
			// element that no longer exists and leave the next keystroke acting on a
			// message that is no longer on screen.
			const cursorSurvives =
				state.cursorEmailId !== null &&
				rows.some((row) => row.id === state.cursorEmailId);
			return {
				navigableRows: rows,
				...(cursorSurvives ? {} : { cursorEmailId: null }),
			};
		}),

	startCompose: (options) =>
		set((state) => {
			const mode = options?.mode || "new";
			const isReplyOrForward = mode === "reply" || mode === "reply-all" || mode === "forward";
			return {
				isComposing: true,
				_previousEmailId: state.selectedEmailId,
				// Keep selectedEmailId when replying/forwarding so the thread stays visible
				selectedEmailId: isReplyOrForward ? state.selectedEmailId : null,
				composeOptions: options || { mode: "new", originalEmail: null },
				isSidebarOpen: false,
			};
		}),

	closePanel: () => set({ selectedEmailId: null, isComposing: false, _previousEmailId: null, composeOptions: { mode: "new" as const, originalEmail: null } }),

	closeCompose: () =>
		set((state) => ({
			isComposing: false,
			selectedEmailId: state._previousEmailId,
			_previousEmailId: null,
			composeOptions: { mode: "new" as const, originalEmail: null },
		})),

	openSidebar: () => set({ isSidebarOpen: true }),
	closeSidebar: () => set({ isSidebarOpen: false }),
	toggleSidebar: () => set({ isSidebarOpen: !get().isSidebarOpen }),

	toggleAgentPanel: () => set({ isAgentPanelOpen: !get().isAgentPanelOpen }),
}));
