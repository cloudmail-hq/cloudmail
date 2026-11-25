/**
 * Renders the question `confirmAction` asks. Mounted once, in the app shell.
 *
 * Questions queue: a second one asked while the first is open waits its turn
 * instead of replacing it, so neither promise is left unanswered.
 */

import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "~/components/settings/settings-ui";
import { CONFIRM_EVENT, registerConfirmHost, type ConfirmRequest } from "~/lib/confirm";

/** A Radix menu that is open or still closing. */
const OPEN_MENU = "[data-radix-menu-content]";
/** The button of the menu that is open. */
const OPEN_MENU_BUTTON = '[aria-haspopup="menu"][aria-expanded="true"]';
/**
 * Longest wait for a menu to finish closing before the question opens anyway.
 * A menu closes in about 220 ms. A page that isn't running animations (a
 * hidden tab) never finishes; the dialog must not wait on it for long.
 */
const MENU_CLOSE_WAIT_MS = 500;
/** Time for the closed menu to give focus back to its button. */
const MENU_FOCUS_RETURN_MS = 50;

export default function ConfirmHost() {
	const [queue, setQueue] = useState<ConfirmRequest[]>([]);
	const current = queue[0] ?? null;
	// The dialog fades out after an answer; it keeps the words it closed with.
	const shownRef = useRef<ConfirmRequest | null>(null);
	if (current) shownRef.current = current;
	const shown = current ?? shownRef.current;

	const queueRef = useRef(queue);
	queueRef.current = queue;
	/** What had focus when the dialog opened: the button that asked. */
	const returnFocusRef = useRef<HTMLElement | null>(null);

	useEffect(() => {
		let mounted = true;
		const onRequest = (event: Event) => {
			const request = (event as CustomEvent<ConfirmRequest>).detail;
			// Asked from a menu: its button is where focus goes back to. Read now,
			// while the menu is open; the item that was clicked is about to go.
			const menuButton = document.querySelector<HTMLElement>(OPEN_MENU_BUTTON);
			const open = () => {
				if (!mounted) return request.resolve(false);
				// The first question of a run remembers what had focus, to give it back.
				if (queueRef.current.length === 0) {
					const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
					returnFocusRef.current = menuButton ?? active;
				}
				setQueue((q) => [...q, request]);
			};
			/*
			  Asked from a menu item (the menu is still open at this point): wait
			  for the menu to close and hand focus back to its button, then open.
			  Radix returns that focus a tick after the menu unmounts. The dialog
			  has to take focus after that, not before, and the button is then
			  where focus goes back to when the dialog closes.
			*/
			if (document.querySelector(OPEN_MENU) === null) {
				setTimeout(open, 0);
				return;
			}
			const asked = Date.now();
			const whenMenuClosed = () => {
				const closing = document.querySelector(OPEN_MENU) !== null;
				if (closing && Date.now() - asked < MENU_CLOSE_WAIT_MS) setTimeout(whenMenuClosed, 16);
				else setTimeout(open, MENU_FOCUS_RETURN_MS);
			};
			setTimeout(whenMenuClosed, 0);
		};
		window.addEventListener(CONFIRM_EVENT, onRequest);
		const unregister = registerConfirmHost();
		return () => {
			mounted = false;
			window.removeEventListener(CONFIRM_EVENT, onRequest);
			unregister();
			// Nobody is left to ask: every open question is a "no".
			for (const request of queueRef.current) request.resolve(false);
		};
	}, []);

	const answer = (confirmed: boolean) => {
		if (!current) return;
		current.resolve(confirmed);
		setQueue((q) => q.filter((request) => request !== current));
	};

	if (!shown) return null;
	return (
		<ConfirmDialog
			open={current !== null}
			onOpenChange={(open) => {
				if (!open) answer(false);
			}}
			title={shown.title}
			description={shown.description}
			confirmLabel={shown.confirmLabel}
			cancelLabel={shown.cancelLabel}
			destructive={shown.destructive ?? true}
			onConfirm={() => answer(true)}
			onCloseAutoFocus={(event) => {
				const target = returnFocusRef.current;
				returnFocusRef.current = null;
				// Gone when the answer deleted its row; focus then falls to the page.
				if (!target?.isConnected) return;
				event.preventDefault();
				target.focus();
			}}
		/>
	);
}
