/**
 * Global toast queue for the app shell, and the app's one screen-reader
 * announcer.
 *
 * A custom event rather than context: toasts are fired from query hooks and
 * plain functions that sit outside the React tree, and threading a provider
 * through all of them buys nothing. `<Toaster />` is mounted once by
 * `DashboardLayout` and renders whatever arrives.
 *
 * The live region lives here for the same reason. Archiving, binning, marking
 * read and undo all reported themselves visually only, so a keyboard user
 * acting on the list cursor got no confirmation that anything had happened.
 * Scattering an `aria-live` node per feature would mean several regions
 * competing to speak, and a region that mounts at the moment of the update is
 * not reliably announced at all — so `Toaster` owns exactly one, mounted for
 * the life of the app, and everything routes through `announce`.
 */

export const TOAST_EVENT = "cloudmail:toast";

export const ANNOUNCE_EVENT = "cloudmail:announce";

export type ToastKind = "info" | "success" | "warning" | "error";

export interface ToastAction {
	label: string;
	/** Receives a dismiss callback so the action can close its own toast. */
	onClick: (dismiss: () => void) => void;
}

export interface ToastInit {
	kind?: ToastKind;
	/** Main line. Keep it to a short sentence. */
	message: string;
	/** Optional second line. */
	description?: string;
	action?: ToastAction;
	/**
	 * Additional buttons, rendered after `action` in the order given.
	 *
	 * Separate from `action` rather than replacing it: one button is the common
	 * case and reads better as a single object at the call site. The undo-send
	 * window is what needs two — Undo and Send now are opposite answers to the
	 * same question, so offering only one of them makes the wait mandatory in one
	 * direction.
	 */
	actions?: ToastAction[];
	/** ms before auto-dismiss. Default 4500; 0 requires a manual close. */
	durationMs?: number;
	/**
	 * Stable id. Firing again with the same id replaces the existing toast
	 * instead of stacking a duplicate — used by the undo-send window, which
	 * must not pile up one card per send.
	 */
	id?: string;
}

export function showToast(toast: ToastInit): string {
	const id =
		toast.id ??
		(typeof crypto !== "undefined" && "randomUUID" in crypto
			? crypto.randomUUID()
			: `t_${Date.now()}_${Math.random().toString(36).slice(2)}`);

	if (typeof window !== "undefined") {
		window.dispatchEvent(
			new CustomEvent<ToastInit>(TOAST_EVENT, { detail: { ...toast, id } }),
		);
	}

	return id;
}

/**
 * Speak a message through the app's live region, without showing anything.
 *
 * For results a sighted user reads off the screen itself — the cursor landing
 * on a different row, a selection count changing. Anything that also deserves
 * a visible card should use `showToast`, which announces on its own.
 */
export function announce(message: string): void {
	if (typeof window === "undefined" || !message) return;
	window.dispatchEvent(
		new CustomEvent<string>(ANNOUNCE_EVENT, { detail: message }),
	);
}

/** Convenience wrappers so call sites read as intent rather than config. */
export const toast = {
	info: (message: string, init?: Omit<ToastInit, "message" | "kind">) =>
		showToast({ ...init, message, kind: "info" }),
	success: (message: string, init?: Omit<ToastInit, "message" | "kind">) =>
		showToast({ ...init, message, kind: "success" }),
	warning: (message: string, init?: Omit<ToastInit, "message" | "kind">) =>
		showToast({ ...init, message, kind: "warning" }),
	error: (message: string, init?: Omit<ToastInit, "message" | "kind">) =>
		showToast({ ...init, message, kind: "error" }),
};

export const TOAST_DISMISS_EVENT = "cloudmail:toast-dismiss";

/** Close a toast by the id returned from `showToast`. */
export function dismissToast(id: string): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(
		new CustomEvent<string>(TOAST_DISMISS_EVENT, { detail: id }),
	);
}

export const UNDO_EVENT = "cloudmail:undo";

/**
 * Run the Undo on the newest toast that offers one.
 *
 * Every undoable thing in the app (send, delete, bulk moves) already puts an
 * "Undo" button on its toast, so the keyboard and the command palette press
 * that button rather than keeping a second history of their own.
 */
export function requestUndo(): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent(UNDO_EVENT));
}

/**
 * Transport-level messages that mean nothing to a reader: the browser's own
 * network errors, aborts, and the bare "Request failed: 503" an API error gets
 * when the server sent no message.
 */
const TECHNICAL_ERROR =
	/^(failed to fetch|networkerror|load failed|network request failed|the operation was aborted|signal is aborted|request failed: \d+|unexpected token|the user aborted)/i;

/** Pull a human-readable message out of whatever a mutation rejected with. */
export function errorMessage(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message) {
		const message = error.message.trim();
		if (/^(failed to fetch|networkerror|load failed|network request failed)/i.test(message)) {
			return `${fallback} Check your connection and try again.`;
		}
		if (TECHNICAL_ERROR.test(message)) {
			const status = (error as { status?: unknown }).status;
			return typeof status === "number" && status >= 500
				? `${fallback} The server had a problem; try again in a moment.`
				: fallback;
		}
		return message;
	}
	return fallback;
}

/**
 * The toast for a failed mutation that declared `meta.errorMessage`, or null
 * for one that handles (or deliberately ignores) its own errors.
 *
 * Fire-and-forget actions (star, read, labels, unsnooze, mark all read) used to
 * fail with only a console line: the optimistic change snapped back and the
 * reader was left guessing.
 */
export function mutationFailureMessage(meta: Record<string, unknown> | undefined, error: unknown): string | null {
	const fallback = meta?.errorMessage;
	if (typeof fallback !== "string" || !fallback) return null;
	return errorMessage(error, fallback);
}
