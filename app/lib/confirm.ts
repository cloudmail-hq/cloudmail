/**
 * "Are you sure?" as a dialog in the app's own style, asked from anywhere.
 *
 * The browser's `window.confirm` blocks the page, can't be styled or labelled
 * ("OK" for "delete this mailbox"), and some browsers let a user switch it off
 * for a site, after which every confirm answers "no" without asking.
 *
 * A promise and a custom event rather than a hook, for the reason `toast.ts`
 * gives: the question is asked from event handlers and plain functions, and
 * one `<ConfirmHost />` in the app shell renders whichever one is waiting.
 * Outside the shell (or before it mounts) there is no host, and the browser's
 * own dialog still asks, so a destructive action is never left unguarded.
 */

export const CONFIRM_EVENT = "cloudmail:confirm";

export interface ConfirmOptions {
	/** The question, ending in a question mark: `Delete the label "Billing"?` */
	title: string;
	/** What happens on yes: what is lost, what is kept. */
	description: string;
	/** The yes button, naming the action: "Delete label", not "OK". */
	confirmLabel: string;
	/** The no button. "Cancel" unless that word is the action being confirmed. */
	cancelLabel?: string;
	/** Red yes button. On by default: most of these delete something. */
	destructive?: boolean;
}

export interface ConfirmRequest extends ConfirmOptions {
	resolve: (confirmed: boolean) => void;
}

/** Deleting a message that is already in Trash or Spam: there is no bin after the bin. */
export const CONFIRM_DELETE_FOREVER: ConfirmOptions = {
	title: "Delete this message permanently?",
	description: "This cannot be undone.",
	confirmLabel: "Delete forever",
};

let hosts = 0;
let waiting = 0;

/** Called by `<ConfirmHost />` while it is mounted. Returns the unregister function. */
export function registerConfirmHost(): () => void {
	hosts++;
	return () => {
		hosts--;
	};
}

/**
 * True while a question is on screen. Global key handlers check it: the
 * browser's dialog blocked the page, so `e` could not archive the message
 * behind it, and this dialog must not let it either.
 */
export function isConfirmOpen(): boolean {
	return waiting > 0;
}

/** Ask, and resolve to the answer. Closing the dialog any other way is "no". */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
	if (typeof window === "undefined") return Promise.resolve(false);
	if (hosts === 0) return Promise.resolve(window.confirm(`${options.title} ${options.description}`));
	return new Promise<boolean>((resolve) => {
		waiting++;
		let settled = false;
		const request: ConfirmRequest = {
			...options,
			resolve: (confirmed) => {
				if (settled) return;
				settled = true;
				waiting--;
				resolve(confirmed);
			},
		};
		window.dispatchEvent(new CustomEvent<ConfirmRequest>(CONFIRM_EVENT, { detail: request }));
	});
}
