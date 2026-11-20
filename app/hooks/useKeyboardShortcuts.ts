// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Gmail-style keyboard shortcuts, mounted once from the mailbox layout.
 *
 * The decision of *what* a keystroke means lives in `resolveShortcut`, which is
 * pure and unit tested. This hook is only the effects half: it reads the store,
 * hands the resolver a snapshot, and performs whatever action comes back. The
 * split is deliberate — precedence bugs ("does `u` also archive?") are the kind
 * that a switch statement hides and a test catches.
 *
 * Actions apply to the visible list cursor when nothing is open, and to the open
 * message when something is. The previous implementation had no cursor and so
 * could only act on an open message; the cursor is rendered by `MailList`, so
 * nothing here acts on a row the user cannot see.
 */

import { useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Folders } from "shared/folders";
import { snoozePresets } from "shared/dates";
import { announce, errorMessage, requestUndo, showToast } from "~/lib/toast";
import { wasTrashed } from "~/lib/delete-outcome";
import {
	PREFIX_TIMEOUT_MS,
	resolveShortcut,
	type ShortcutAction,
	type ShortcutContext,
	type ShortcutPrefix,
} from "~/lib/shortcuts";
import { useUIStore } from "~/hooks/useUIStore";
import { useCommandPaletteStore } from "~/hooks/useCommandPaletteStore";
import { useMutedThreads, useSetThreadMuted } from "~/queries/rules";
import {
	useDeleteEmail,
	useMoveEmail,
	useRestoreEmail,
	useSetEmailPriority,
	useSnoozeEmail,
	useUpdateEmail,
} from "~/queries/emails";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";
import type { Email } from "~/types";

/**
 * True when the event came from somewhere the user is typing.
 *
 * Covers the rich text editor too, which is a contenteditable rather than a
 * form control.
 */
function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	const tag = target.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Menus a shortcut can open.
 *
 * `v`, `l` and `.` are Gmail's menu keys, and the menus themselves are Radix
 * dropdowns owned by the list and the reading pane. Rather than lifting that
 * markup into this hook, the request is published and whichever surface is
 * mounted opens its own menu — the same approach `/` already uses for search.
 */
export const MENU_REQUEST_EVENT = "inbox:open-menu";

export interface MenuRequest {
	menu: "move" | "label" | "more";
	target: "cursor" | "message";
}

/**
 * The command palette runs mail actions through this hook rather than keeping
 * its own copies of them, by dispatching the resolved action on this event.
 */
export const RUN_SHORTCUT_EVENT = "inbox:run-shortcut";

export function runShortcutAction(action: ShortcutAction): void {
	window.dispatchEvent(
		new CustomEvent<ShortcutAction>(RUN_SHORTCUT_EVENT, { detail: action }),
	);
}

/**
 * The snapshot `resolveShortcut` decides from, published for the palette.
 *
 * Null when the hook isn't mounted (any page but the mail workspace), which is
 * how the palette knows no mail action can run.
 */
export const useShortcutContextStore = create<{
	context: ShortcutContext | null;
	set: (context: ShortcutContext | null) => void;
}>((set) => ({ context: null, set: (context) => set({ context }) }));

export function useKeyboardShortcuts() {
	const { mailboxId, folder } = useParams<{
		mailboxId: string;
		folder: string;
	}>();
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const {
		selectedEmailId,
		isComposing,
		navigableRows,
		cursorEmailId,
		setCursorEmailId,
		checkedEmailIds,
		setCheckedEmailIds,
		toggleChecked,
		selectEmail,
		startCompose,
		closePanel,
		closeCompose,
	} = useUIStore();

	const updateEmail = useUpdateEmail();
	const moveEmail = useMoveEmail();
	const deleteEmail = useDeleteEmail();
	const restoreEmail = useRestoreEmail();
	const snoozeEmail = useSnoozeEmail();
	const setPriority = useSetEmailPriority();
	const setThreadMuted = useSetThreadMuted();
	const { data: mutedThreads = [] } = useMutedThreads(mailboxId);
	const paletteOpen = useCommandPaletteStore((state) => state.isOpen);

	const [isHelpOpen, setIsHelpOpen] = useState(false);
	const prefixRef = useRef<ShortcutPrefix | null>(null);
	const prefixTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearPrefix = useCallback(() => {
		prefixRef.current = null;
		if (prefixTimerRef.current) {
			clearTimeout(prefixTimerRef.current);
			prefixTimerRef.current = null;
		}
	}, []);

	/**
	 * Reply, reply-all and forward need the full message, and a list row is a
	 * projection with no body, so fetch before opening the composer.
	 */
	const composeFrom = useCallback(
		async (
			mode: "reply" | "reply-all" | "forward",
			id: string,
			popOut: boolean,
		) => {
			if (!mailboxId) return;
			try {
				const email = (await api.getEmail(mailboxId, id)) as Email;
				startCompose({ mode, originalEmail: email, popOut });
			} catch {
				showToast({
					kind: "error",
					message: "Could not open the composer for that message.",
				});
			}
		},
		[mailboxId, startCompose],
	);

	/**
	 * Run one resolved action.
	 *
	 * Kept as a ref-read function rather than a `useCallback` dependency web:
	 * the mutation objects are fresh on every render, so binding the listener to
	 * them would re-subscribe continuously.
	 */
	const perform = useCallback(
		(action: ShortcutAction) => {
			switch (action.type) {
				case "none":
					return;

				case "compose":
					startCompose();
					return;

				case "undo":
					requestUndo();
					return;

				case "open-help":
					setIsHelpOpen(true);
					return;

				case "close-help":
					setIsHelpOpen(false);
					return;

				case "close-compose":
					closeCompose();
					return;

				case "close-message":
					closePanel();
					return;

				case "move-cursor":
					setCursorEmailId(action.id);
					// Following the cursor into the pane only happens when a message is
					// already open, so `j` in the list stays silent and free.
					if (action.open) selectEmail(action.id);
					return;

				case "open-cursor":
					selectEmail(action.id);
					return;

				case "goto":
					if (!mailboxId) return;
					closePanel();
					navigate(`/mail/${encodeURIComponent(mailboxId)}/${action.folder}`);
					return;

				case "select": {
					setCheckedEmailIds(action.ids);
					const count = action.ids.length;
					announce(
						count === 0
							? "Selection cleared"
							: `${count} conversation${count === 1 ? "" : "s"} selected`,
					);
					return;
				}

				case "toggle-select": {
					toggleChecked(action.id);
					// Reads the pre-toggle set, so the announcement describes the state
					// the user is landing in rather than the one they left.
					const wasChecked = checkedEmailIds.includes(action.id);
					announce(wasChecked ? "Removed from selection" : "Added to selection");
					return;
				}

				case "menu":
					window.dispatchEvent(
						new CustomEvent<MenuRequest>(MENU_REQUEST_EVENT, {
							detail: { menu: action.menu, target: action.target },
						}),
					);
					return;

				case "thread-expand":
					window.dispatchEvent(
						new CustomEvent<boolean>("inbox:thread-expand", {
							detail: action.expand,
						}),
					);
					return;

				case "thread-step":
					window.dispatchEvent(
						new CustomEvent<1 | -1>("inbox:thread-step", {
							detail: action.delta,
						}),
					);
					return;
			}

			// Everything below mutates mail, so it needs a mailbox.
			if (!mailboxId) return;

			switch (action.type) {
				case "reply":
					void composeFrom(action.mode, action.id, action.popOut);
					return;

				case "star": {
					// A listed row carries its own state. The open message may not be
					// listed at all — reached by search or a direct link — and then the
					// cached detail is the only thing there is to invert.
					const starred =
						action.starred ??
						!queryClient.getQueryData<Email>(
							queryKeys.emails.detail(mailboxId, action.id),
						)?.starred;
					updateEmail.mutate({
						mailboxId,
						id: action.id,
						data: { starred },
					});
					announce(starred ? "Starred" : "Unstarred");
					return;
				}

				case "mark-read":
					updateEmail.mutate({
						mailboxId,
						id: action.id,
						data: { read: action.read },
					});
					// Marking the open message unread is Gmail's "put it back": the pane
					// closes so the row is visibly waiting again.
					if (!action.read && selectedEmailId === action.id) closePanel();
					announce(action.read ? "Marked as read" : "Marked as unread");
					return;

				case "archive":
					moveEmail.mutate({
						mailboxId,
						id: action.id,
						folderId: Folders.ARCHIVE,
					});
					if (selectedEmailId === action.id) closePanel();
					showToast({ message: "Archived" });
					return;

				case "spam":
					moveEmail.mutate({
						mailboxId,
						id: action.id,
						folderId: Folders.SPAM,
					});
					if (selectedEmailId === action.id) closePanel();
					showToast({ message: "Reported as spam" });
					return;

				case "priority":
					setPriority.mutate({
						mailboxId,
						id: action.id,
						priority: action.priority,
					});
					announce(
						action.priority === "high"
							? "Marked as important"
							: "Marked as not important",
					);
					return;

				case "mute": {
					// The thread id when the message is cached; a lone message is its
					// own thread, which is also what the mute endpoint stores for it.
					const cached = queryClient.getQueryData<Email>(
						queryKeys.emails.detail(mailboxId, action.id),
					);
					const threadId = cached?.thread_id ?? action.id;
					const muted = !mutedThreads.includes(threadId);
					setThreadMuted.mutate(
						{ mailboxId, threadId, muted },
						{
							onSuccess: () =>
								showToast({
									message: muted
										? "Conversation muted — new replies go to Archive"
										: "Conversation unmuted",
								}),
							onError: (err) =>
								showToast({
									kind: "error",
									message: errorMessage(err, "Could not change the mute setting."),
								}),
						},
					);
					return;
				}

				case "snooze": {
					const tomorrow = snoozePresets().find((p) => p.id === "tomorrow");
					if (!tomorrow) return;
					snoozeEmail.mutate({
						mailboxId,
						id: action.id,
						when: { until: tomorrow.at.toISOString() },
					});
					if (selectedEmailId === action.id) closePanel();
					showToast({ message: "Snoozed until tomorrow" });
					return;
				}

				case "delete": {
					// A one-key delete is exactly where an accident happens, so it
					// reports what it did and offers the way back.
					const id = action.id;
					deleteEmail.mutate(
						{ mailboxId, id },
						{
							onSuccess: (result) => {
								// Nothing to undo when the message was destroyed rather than
								// binned; see `wasTrashed`.
								if (!wasTrashed(result)) return;
								showToast({
									message: "Moved to Trash",
									action: {
										label: "Undo",
										onClick: (dismiss) => {
											dismiss();
											restoreEmail.mutate({ mailboxId, id });
											announce("Restored");
										},
									},
								});
							},
						},
					);
					if (selectedEmailId === id) closePanel();
					return;
				}
			}
		},
		[
			checkedEmailIds,
			closeCompose,
			closePanel,
			composeFrom,
			deleteEmail,
			mailboxId,
			moveEmail,
			mutedThreads,
			navigate,
			queryClient,
			restoreEmail,
			selectEmail,
			selectedEmailId,
			setCheckedEmailIds,
			setCursorEmailId,
			setPriority,
			setThreadMuted,
			snoozeEmail,
			startCompose,
			toggleChecked,
			updateEmail,
		],
	);

	/**
	 * The current handler, re-read on every keystroke.
	 *
	 * The listener itself is registered once. Binding it to the values it closes
	 * over would re-subscribe on every render, because the mutation objects it
	 * needs are fresh each time.
	 */
	const handlerRef = useRef<(e: KeyboardEvent) => void>(() => {});

	const context: ShortcutContext = {
		rows: navigableRows,
		cursorId: cursorEmailId,
		openId: selectedEmailId,
		isComposing,
		// The palette is a modal over the workspace, so it counts as one: no mail
		// key fires behind it.
		isHelpOpen: isHelpOpen || paletteOpen,
		prefix: null,
		folder,
		hasMailbox: !!mailboxId,
	};

	const publishContext = useShortcutContextStore((state) => state.set);
	useEffect(() => {
		publishContext({
			rows: navigableRows,
			cursorId: cursorEmailId,
			openId: selectedEmailId,
			isComposing,
			isHelpOpen,
			prefix: null,
			folder,
			hasMailbox: !!mailboxId,
		});
	}, [
		publishContext,
		navigableRows,
		cursorEmailId,
		selectedEmailId,
		isComposing,
		isHelpOpen,
		folder,
		mailboxId,
	]);
	useEffect(() => () => publishContext(null), [publishContext]);

	useEffect(() => {
		handlerRef.current = (e: KeyboardEvent) => {
			const { action, preventDefault, nextPrefix } = resolveShortcut(
				{
					key: e.key,
					metaKey: e.metaKey,
					ctrlKey: e.ctrlKey,
					altKey: e.altKey,
					typing: isTypingTarget(e.target),
					// Radix overlays close on Escape from a capture-phase listener that
					// calls `preventDefault()` without stopping propagation, so this
					// bubble-phase listener still sees the keystroke. Reading the flag is
					// what keeps one Escape from closing a dropdown and the reading pane
					// behind it.
					defaultPrevented: e.defaultPrevented,
				},
				{ ...context, prefix: prefixRef.current },
			);

			// The prefix is re-armed from the resolution rather than mutated in
			// place, so "arm", "resolve" and "forget" are all one assignment and a
			// stale `g` cannot survive a keystroke that ignored it.
			clearPrefix();
			if (nextPrefix) {
				prefixRef.current = nextPrefix;
				prefixTimerRef.current = setTimeout(clearPrefix, PREFIX_TIMEOUT_MS);
			}

			if (preventDefault) e.preventDefault();
			perform(action);
		};
		// No dependency list: the handler is rebuilt after every render so it
		// never closes over stale state, while the listener below stays put.
	});

	const performRef = useRef(perform);
	performRef.current = perform;

	useEffect(() => {
		const listener = (e: KeyboardEvent) => handlerRef.current(e);
		document.addEventListener("keydown", listener);
		const fromPalette = (e: Event) => {
			const action = (e as CustomEvent<ShortcutAction>).detail;
			if (action && typeof action.type === "string") performRef.current(action);
		};
		window.addEventListener(RUN_SHORTCUT_EVENT, fromPalette);
		return () => {
			document.removeEventListener("keydown", listener);
			window.removeEventListener(RUN_SHORTCUT_EVENT, fromPalette);
		};
	}, []);

	// Drop any armed prefix when the hook unmounts mid-sequence.
	useEffect(() => clearPrefix, [clearPrefix]);

	return { isHelpOpen, closeHelp: () => setIsHelpOpen(false) };
}
