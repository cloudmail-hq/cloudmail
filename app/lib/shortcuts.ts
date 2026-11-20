// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Keyboard-shortcut dispatch for the mail workspace, as a pure function.
 *
 * `resolveShortcut` is the whole decision: given a keystroke and a snapshot of
 * what is on screen, it returns the single action to run. It touches no DOM, no
 * store and no network, which is what makes the precedence rules testable —
 * previously they lived inside a `useEffect` closure and the only way to check
 * that `u` did not also archive was to read the switch statement carefully.
 *
 * Three rules shape it:
 *
 * 1. Never steal a keystroke from a text field. Anything typed into an input,
 *    textarea or the rich text editor is the user's content, not a command.
 * 2. Actions apply to the *cursor row* when nothing is open, and to the open
 *    message when something is. The cursor is visible in the list, so this no
 *    longer acts on a message the user cannot see.
 * 3. One keystroke yields at most one action. Every binding lives in exactly
 *    one branch below, so a key can never both move the cursor and mutate mail.
 *
 * `g` and `*` are prefixes: `g` then `i` goes to the inbox, `*` then `u`
 * selects the unread rows. A pending prefix expires (see `PREFIX_TIMEOUT_MS`)
 * so a stray `g` doesn't swallow the next real keystroke.
 */

import { Folders } from "../../shared/folders";

/** How long a prefix stays armed before it is forgotten. */
export const PREFIX_TIMEOUT_MS = 1500;

/** The two armed-prefix states. */
export type ShortcutPrefix = "g" | "*";

/** Where `g` + key navigates. */
export const GOTO_TARGETS: Record<string, string> = {
	i: Folders.INBOX,
	e: Folders.ARCHIVE,
	d: Folders.DRAFT,
	t: Folders.SENT,
	b: Folders.SNOOZED,
	k: Folders.SCHEDULED,
	"#": Folders.TRASH,
	// The Screener's route is `/mail/:id/screener`, the same path a folder gets.
	s: Folders.SCREENER,
};

/** What `*` + key ticks. */
export type SelectionScope =
	| "all"
	| "none"
	| "read"
	| "unread"
	| "starred"
	| "unstarred";

const SELECT_TARGETS: Record<string, SelectionScope> = {
	a: "all",
	n: "none",
	r: "read",
	u: "unread",
	s: "starred",
	t: "unstarred",
};

/**
 * The keystroke, reduced to what the decision actually depends on.
 *
 * Shift is deliberately absent: the browser already folds it into `key`, so
 * `Shift+r` arrives as `"R"` and `Shift+8` as `"*"`. Matching the produced
 * character means `*`, `!`, `+`, `:` and `#` need no special casing, and
 * `Shift+r` cannot be confused with `r`.
 */
export interface ShortcutKeyEvent {
	key: string;
	metaKey?: boolean;
	ctrlKey?: boolean;
	altKey?: boolean;
	/** True when the keystroke came from a text field or the editor. */
	typing?: boolean;
	/**
	 * True when something has already handled this keystroke.
	 *
	 * Every Radix overlay — the dropdowns on a row and in the message toolbar, the
	 * help dialog — closes itself on Escape from a *capture-phase* listener that
	 * calls `preventDefault()` and never `stopPropagation()`. The global listener
	 * here is on the bubble phase, so it still sees that keystroke afterwards. Left
	 * unchecked, one Escape closes the open dropdown *and* the reading pane behind
	 * it, which is not what the user asked for.
	 */
	defaultPrevented?: boolean;
}

/**
 * One listed row, reduced to what a shortcut needs to decide.
 *
 * Carrying `read` and `starred` is what lets `*u` and `s` resolve here rather
 * than in the hook: the toggle target is known without a cache lookup.
 */
export interface ShortcutRow {
	id: string;
	read: boolean;
	starred: boolean;
}

export interface ShortcutContext {
	/** Listed rows in display order. */
	rows: readonly ShortcutRow[];
	/** The visible list cursor. Never opens anything on its own. */
	cursorId: string | null;
	/** The message open in the reading pane, if any. */
	openId: string | null;
	isComposing: boolean;
	isHelpOpen: boolean;
	/** Armed prefix, or null. */
	prefix: ShortcutPrefix | null;
	/** The folder on screen, so Archive-in-Archive can be a no-op. */
	folder?: string;
	/** False before a mailbox is in the URL; every mail action needs one. */
	hasMailbox: boolean;
}

export type ShortcutAction =
	| { type: "none" }
	| { type: "compose" }
	| { type: "open-help" }
	| { type: "close-help" }
	| { type: "close-compose" }
	/** `Escape` / `u`: back to the list. */
	| { type: "close-message" }
	/** `j` / `k`. `open` follows the cursor into the reading pane. */
	| { type: "move-cursor"; id: string; open: boolean }
	/** `Enter`. */
	| { type: "open-cursor"; id: string }
	| { type: "goto"; folder: string }
	| { type: "select"; scope: SelectionScope; ids: string[] }
	/** `x`. */
	| { type: "toggle-select"; id: string }
	/** `r` / `a` / `f`, and their pop-out `Shift` variants. */
	| {
			type: "reply";
			mode: "reply" | "reply-all" | "forward";
			id: string;
			popOut: boolean;
	  }
	| { type: "archive"; id: string }
	| { type: "delete"; id: string }
	| { type: "spam"; id: string }
	/** `starred: null` means "invert whatever the cached detail holds". */
	| { type: "star"; id: string; starred: boolean | null }
	| { type: "mark-read"; id: string; read: boolean }
	| { type: "snooze"; id: string }
	/** `m`: mute or unmute the conversation. */
	| { type: "mute"; id: string }
	/** `z`: run the Undo of the most recent undoable toast. */
	| { type: "undo" }
	| { type: "priority"; id: string; priority: "high" | null }
	/** `;` / `:` in an open conversation. */
	| { type: "thread-expand"; expand: boolean }
	/** `n` / `p` in an open conversation. */
	| { type: "thread-step"; delta: 1 | -1 }
	/** `v` / `l` / `.` */
	| {
			type: "menu";
			menu: "move" | "label" | "more";
			target: "cursor" | "message";
	  };

export interface ShortcutResolution {
	action: ShortcutAction;
	/** True when the keystroke was claimed and the browser default must go. */
	preventDefault: boolean;
	/** The prefix armed *after* this keystroke. */
	nextPrefix: ShortcutPrefix | null;
}

/**
 * Result constructors.
 *
 * These exist for the pairing, not for brevity: `preventDefault` must be true
 * at every one of the ~40 claim sites below and false at every decline. Writing
 * the literal each time is how a binding ends up claiming a key while letting
 * the browser scroll the list as well.
 */
const NOTHING = (
	nextPrefix: ShortcutPrefix | null = null,
): ShortcutResolution => ({
	action: { type: "none" },
	preventDefault: false,
	nextPrefix,
});

const CLAIM = (
	action: ShortcutAction,
	nextPrefix: ShortcutPrefix | null = null,
): ShortcutResolution => ({ action, preventDefault: true, nextPrefix });

/** Ids a `*` scope ticks, from the rows currently listed. */
export function idsForScope(
	rows: readonly ShortcutRow[],
	scope: SelectionScope,
): string[] {
	switch (scope) {
		case "all":
			return rows.map((row) => row.id);
		case "none":
			return [];
		case "read":
			return rows.filter((row) => row.read).map((row) => row.id);
		case "unread":
			return rows.filter((row) => !row.read).map((row) => row.id);
		case "starred":
			return rows.filter((row) => row.starred).map((row) => row.id);
		case "unstarred":
			return rows.filter((row) => !row.starred).map((row) => row.id);
	}
}

/**
 * Where the cursor lands, or null to stay put.
 *
 * From a cold start `j` takes the first row and `k` the last, which is what
 * makes the list navigable before anything has been touched. At either end it
 * returns null rather than wrapping: wrapping from the last row to the first
 * silently moves the target of the next destructive keystroke.
 */
export function stepCursor(
	rows: readonly ShortcutRow[],
	cursorId: string | null,
	delta: 1 | -1,
): string | null {
	if (rows.length === 0) return null;
	const at = cursorId ? rows.findIndex((row) => row.id === cursorId) : -1;
	if (at === -1) return delta === 1 ? rows[0].id : rows[rows.length - 1].id;
	const next = at + delta;
	if (next < 0 || next >= rows.length) return null;
	return rows[next].id;
}

/**
 * The single action a keystroke should run.
 *
 * Order matters and is the point of the function: Escape before the typing
 * guard, the typing guard before everything else, prefixes before plain keys,
 * and list-wide keys before the ones that need something to act on.
 */
export function resolveShortcut(
	event: ShortcutKeyEvent,
	context: ShortcutContext,
): ShortcutResolution {
	const { key } = event;

	if (key === "Escape") {
		/*
		 * Something already dealt with this keystroke, so we must not deal with it
		 * again. Every Radix overlay closes itself on Escape from a capture-phase
		 * listener that calls `preventDefault()` without `stopPropagation()`, and
		 * this listener is on the bubble phase — so a dropdown open over the reading
		 * pane would otherwise close the dropdown *and* the pane behind it from one
		 * press. `isHelpOpen` stays as a belt-and-braces check for the dialog, whose
		 * state we happen to own.
		 */
		if (event.defaultPrevented || context.isHelpOpen) return NOTHING();
		// Closing the composer discards unsent text, so only do it once the user
		// has left the text field — the same bar as clicking its X.
		if (event.typing) return NOTHING();
		if (context.isComposing) return CLAIM({ type: "close-compose" });
		if (context.openId) return CLAIM({ type: "close-message" });
		return NOTHING();
	}

	// A pending prefix is left alone while typing: it will expire on its own,
	// and consuming it here would make the timeout depend on where focus is.
	if (event.typing) return NOTHING(context.prefix);

	// Leave browser and OS chords alone.
	if (event.metaKey || event.ctrlKey || event.altKey) {
		return NOTHING(context.prefix);
	}

	// A composer is a text-entry context even when focus is on one of its
	// buttons, so no command runs while it is open.
	if (context.isComposing) return NOTHING(context.prefix);

	// While the help dialog is open it owns the keyboard. Without this, reading
	// the shortcut list and pressing `#` out of curiosity would bin a message
	// behind the dialog.
	if (context.isHelpOpen) return NOTHING(context.prefix);

	// Prefixes resolve before plain keys, which is why `g` then `k` reaches
	// Scheduled while a bare `k` still steps the cursor.
	if (context.prefix === "g") {
		const folder = GOTO_TARGETS[key];
		if (!folder || !context.hasMailbox) return NOTHING();
		return CLAIM({ type: "goto", folder });
	}

	if (context.prefix === "*") {
		const scope = SELECT_TARGETS[key];
		if (!scope) return NOTHING();
		return CLAIM({ type: "select", scope, ids: idsForScope(context.rows, scope) });
	}

	if (key === "g") return NOTHING("g");
	if (key === "*") return NOTHING("*");

	// List-wide keys: they need no message to act on.
	switch (key) {
		case "c":
			return CLAIM({ type: "compose" });

		// `/` and ⌘K open the command palette, whose listener lives with the
		// palette so they work on every page, not only in the mail workspace.
		// See `PALETTE_KEYS`.

		case "z":
			return CLAIM({ type: "undo" });

		case "?":
			return CLAIM({ type: "open-help" });

		case "j":
		case "k": {
			const id = stepCursor(context.rows, context.cursorId, key === "j" ? 1 : -1);
			if (!id) return NOTHING();
			// With a message already open, following the cursor keeps the reading
			// pane in step; with nothing open the cursor moves silently.
			return CLAIM({ type: "move-cursor", id, open: context.openId !== null });
		}

		case "Enter": {
			// Enter opens whatever the cursor is on, and falls back to the top row
			// so the list can be opened from a cold start.
			const id = context.cursorId ?? context.rows[0]?.id;
			if (!id || context.openId) return NOTHING();
			return CLAIM({ type: "open-cursor", id });
		}
	}

	// `x` ticks the cursor row whether or not a message is open, because the
	// checkbox it mirrors belongs to the list.
	if (key === "x") {
		if (!context.cursorId) return NOTHING();
		return CLAIM({ type: "toggle-select", id: context.cursorId });
	}

	// Everything below acts on a message: the open one if there is one, the
	// cursor row otherwise.
	const id = context.openId ?? context.cursorId;
	if (!context.hasMailbox || !id) return NOTHING();

	const row = context.rows.find((candidate) => candidate.id === id);
	const folder = context.folder;

	switch (key) {
		case "r":
			return CLAIM({ type: "reply", mode: "reply", id, popOut: false });
		case "a":
			return CLAIM({ type: "reply", mode: "reply-all", id, popOut: false });
		case "f":
			return CLAIM({ type: "reply", mode: "forward", id, popOut: false });

		// Shift opens the same composer popped out, which is this app's answer to
		// Gmail's "in a new window".
		case "R":
			return CLAIM({ type: "reply", mode: "reply", id, popOut: true });
		case "A":
			return CLAIM({ type: "reply", mode: "reply-all", id, popOut: true });
		case "F":
			return CLAIM({ type: "reply", mode: "forward", id, popOut: true });

		case "s":
			// A listed row already knows its state; the open message may not be
			// listed (search, a direct link), and then the caller inverts its cache.
			return CLAIM({ type: "star", id, starred: row ? !row.starred : null });

		// `u` is Gmail's back-to-list, so read state moved to the Shift variants.
		case "U":
			return CLAIM({ type: "mark-read", id, read: false });
		case "I":
			return CLAIM({ type: "mark-read", id, read: true });

		case "u":
			if (!context.openId) return NOTHING();
			return CLAIM({ type: "close-message" });

		case "e":
			if (folder === Folders.ARCHIVE) return NOTHING();
			return CLAIM({ type: "archive", id });

		case "b":
			return CLAIM({ type: "snooze", id });

		case "m":
			return CLAIM({ type: "mute", id });

		case "#":
			return CLAIM({ type: "delete", id });

		case "!":
			if (folder === Folders.SPAM) return NOTHING();
			return CLAIM({ type: "spam", id });

		case "+":
			return CLAIM({ type: "priority", id, priority: "high" });
		case "-":
			return CLAIM({ type: "priority", id, priority: null });

		case "v":
			return CLAIM({
				type: "menu",
				menu: "move",
				target: context.openId ? "message" : "cursor",
			});
		case "l":
			return CLAIM({
				type: "menu",
				menu: "label",
				target: context.openId ? "message" : "cursor",
			});
		case ".":
			return CLAIM({
				type: "menu",
				menu: "more",
				target: context.openId ? "message" : "cursor",
			});

		// Thread keys only mean anything inside an open conversation.
		case ";":
			if (!context.openId) return NOTHING();
			return CLAIM({ type: "thread-expand", expand: true });
		case ":":
			if (!context.openId) return NOTHING();
			return CLAIM({ type: "thread-expand", expand: false });

		case "n":
			if (!context.openId) return NOTHING();
			return CLAIM({ type: "thread-step", delta: 1 });
		case "p":
			if (!context.openId) return NOTHING();
			return CLAIM({ type: "thread-step", delta: -1 });
	}

	return NOTHING();
}

/**
 * Run a whole key sequence through the resolver: `["g", "i"]` arms the prefix
 * on the first press and resolves on the second.
 *
 * This is how the command palette asks "what would this shortcut do right
 * now?", so an action the palette offers is exactly the action the keystroke
 * would run, including the rules about what needs a message to act on.
 */
export function resolveSequence(
	sequence: readonly string[],
	context: ShortcutContext,
): ShortcutAction {
	let prefix = context.prefix;
	let action: ShortcutAction = { type: "none" };
	for (const key of sequence) {
		const resolution = resolveShortcut({ key }, { ...context, prefix });
		action = resolution.action;
		prefix = resolution.nextPrefix;
	}
	return action;
}

export type ShortcutGroup =
	| "Navigation"
	| "Selection"
	| "Acting on mail"
	| "Jumping to a folder"
	| "Help";

/**
 * Where a command shows up in the palette.
 *
 * - `"action"`: listed as a palette action, run through the resolver.
 * - `"navigation"`: the palette lists the destination itself (a folder) and
 *   shows this shortcut beside it.
 * - `false`: list-cursor mechanics (`j`, `Enter`, `Escape`…) that mean nothing
 *   once the palette has focus.
 */
export type PaletteSlot = "action" | "navigation" | false;

export interface ShortcutCommand {
	/** Stable id, used for "recently used" in the palette. */
	id: string;
	/** Keys pressed, in order. */
	sequence: readonly string[];
	/** Palette title, and the help dialog's description. */
	title: string;
	group: ShortcutGroup;
	palette: PaletteSlot;
	/** Extra words the palette matches on. */
	keywords?: readonly string[];
}

const gotoCommand = (key: string, title: string): ShortcutCommand => ({
	id: `goto-${GOTO_TARGETS[key]}`,
	sequence: ["g", key],
	title,
	group: "Jumping to a folder",
	palette: "navigation",
});

const selectCommand = (key: string, title: string): ShortcutCommand => ({
	id: `select-${SELECT_TARGETS[key]}`,
	sequence: ["*", key],
	title,
	group: "Selection",
	palette: "action",
	keywords: ["select", "tick", "check"],
});

/**
 * Every keyboard shortcut, once.
 *
 * The help dialog, the palette's actions and the shortcut hints beside them
 * are all read from this table, and `test/command-registry.test.ts` checks it
 * against `resolveShortcut` in both directions: every key the resolver binds
 * has a row here, and every row resolves to a real action. A binding cannot be
 * added without the palette and the help dialog learning it.
 */
export const SHORTCUT_COMMANDS: readonly ShortcutCommand[] = [
	// Navigation
	{ id: "cursor-down", sequence: ["j"], title: "Move the cursor down the list", group: "Navigation", palette: false },
	{ id: "cursor-up", sequence: ["k"], title: "Move the cursor up the list", group: "Navigation", palette: false },
	{ id: "open-cursor", sequence: ["Enter"], title: "Open the message under the cursor", group: "Navigation", palette: false },
	{ id: "back-to-list", sequence: ["u"], title: "Back to the list", group: "Navigation", palette: "action", keywords: ["close", "list"] },
	{ id: "thread-next", sequence: ["n"], title: "Next message in the conversation", group: "Navigation", palette: false },
	{ id: "thread-prev", sequence: ["p"], title: "Previous message in the conversation", group: "Navigation", palette: false },
	{ id: "thread-expand", sequence: [";"], title: "Expand every message in the conversation", group: "Navigation", palette: "action", keywords: ["thread", "open all"] },
	{ id: "thread-collapse", sequence: [":"], title: "Collapse every message in the conversation", group: "Navigation", palette: "action", keywords: ["thread"] },
	{ id: "escape", sequence: ["Escape"], title: "Close the message, composer or dialog", group: "Navigation", palette: false },

	// Selection
	{ id: "toggle-select", sequence: ["x"], title: "Tick or untick the cursor row", group: "Selection", palette: false },
	selectCommand("a", "Select all"),
	selectCommand("n", "Select none"),
	selectCommand("r", "Select read messages"),
	selectCommand("u", "Select unread messages"),
	selectCommand("s", "Select starred messages"),
	selectCommand("t", "Select unstarred messages"),

	// Acting on mail
	{ id: "compose", sequence: ["c"], title: "Compose", group: "Acting on mail", palette: "action", keywords: ["new", "write", "email", "message"] },
	{ id: "reply", sequence: ["r"], title: "Reply", group: "Acting on mail", palette: "action", keywords: ["respond"] },
	{ id: "reply-all", sequence: ["a"], title: "Reply all", group: "Acting on mail", palette: "action", keywords: ["respond", "everyone"] },
	{ id: "forward", sequence: ["f"], title: "Forward", group: "Acting on mail", palette: "action", keywords: ["send on"] },
	{ id: "reply-popout", sequence: ["R"], title: "Reply in a full-screen composer", group: "Acting on mail", palette: "action", keywords: ["respond", "pop out"] },
	{ id: "reply-all-popout", sequence: ["A"], title: "Reply all in a full-screen composer", group: "Acting on mail", palette: "action", keywords: ["respond", "pop out"] },
	{ id: "forward-popout", sequence: ["F"], title: "Forward in a full-screen composer", group: "Acting on mail", palette: "action", keywords: ["pop out"] },
	{ id: "archive", sequence: ["e"], title: "Archive", group: "Acting on mail", palette: "action", keywords: ["done", "remove"] },
	{ id: "star", sequence: ["s"], title: "Star or unstar", group: "Acting on mail", palette: "action", keywords: ["flag", "favourite", "favorite"] },
	{ id: "mark-read", sequence: ["I"], title: "Mark as read", group: "Acting on mail", palette: "action", keywords: ["seen"] },
	{ id: "mark-unread", sequence: ["U"], title: "Mark as unread", group: "Acting on mail", palette: "action", keywords: ["unseen"] },
	{ id: "snooze", sequence: ["b"], title: "Snooze until tomorrow", group: "Acting on mail", palette: "action", keywords: ["later", "remind"] },
	{ id: "mute", sequence: ["m"], title: "Mute or unmute the conversation", group: "Acting on mail", palette: "action", keywords: ["silence", "ignore", "thread"] },
	{ id: "spam", sequence: ["!"], title: "Report spam", group: "Acting on mail", palette: "action", keywords: ["junk", "mark spam"] },
	{ id: "important", sequence: ["+"], title: "Mark important", group: "Acting on mail", palette: "action", keywords: ["priority"] },
	{ id: "not-important", sequence: ["-"], title: "Mark not important", group: "Acting on mail", palette: "action", keywords: ["priority"] },
	{ id: "trash", sequence: ["#"], title: "Move to Trash", group: "Acting on mail", palette: "action", keywords: ["delete", "bin", "remove"] },
	{ id: "move", sequence: ["v"], title: "Move to…", group: "Acting on mail", palette: "action", keywords: ["folder", "file"] },
	{ id: "label", sequence: ["l"], title: "Label as…", group: "Acting on mail", palette: "action", keywords: ["tag", "category"] },
	{ id: "more", sequence: ["."], title: "More actions…", group: "Acting on mail", palette: "action", keywords: ["menu"] },
	{ id: "undo", sequence: ["z"], title: "Undo", group: "Acting on mail", palette: "action", keywords: ["revert"] },

	// Jumping to a folder
	gotoCommand("i", "Inbox"),
	gotoCommand("t", "Sent"),
	gotoCommand("d", "Drafts"),
	gotoCommand("e", "Archive"),
	gotoCommand("b", "Snoozed"),
	gotoCommand("k", "Scheduled"),
	gotoCommand("#", "Trash"),
	gotoCommand("s", "Screener"),

	// Help
	{ id: "help", sequence: ["?"], title: "Keyboard shortcuts", group: "Help", palette: "action", keywords: ["help", "keys", "hotkeys"] },
];

/**
 * Keys that open the command palette.
 *
 * Handled by the palette's own listener rather than `resolveShortcut`, because
 * the palette is available on every page and ⌘K has to work from inside a
 * text field too. Listed here so the help dialog shows them with the rest.
 */
export const PALETTE_KEYS: readonly { keys: string; title: string }[] = [
	{ keys: "⌘K", title: "Command palette (Ctrl+K on Windows and Linux)" },
	{ keys: "/", title: "Command palette, when you are not typing" },
];

/** The shortcut for a folder, when it has one: `inbox` → `["g", "i"]`. */
export function gotoSequence(folderId: string): readonly string[] | null {
	const command = SHORTCUT_COMMANDS.find(
		(entry) => entry.palette === "navigation" && entry.id === `goto-${folderId}`,
	);
	return command ? command.sequence : null;
}

/** Display text for a key sequence: `["g", "i"]` → `"g then i"`. */
export function sequenceLabel(sequence: readonly string[]): string {
	return sequence.join(" then ");
}

const HELP_GROUP_ORDER: readonly ShortcutGroup[] = [
	"Navigation",
	"Selection",
	"Acting on mail",
	"Jumping to a folder",
	"Help",
];

/**
 * The help dialog's rows, derived from `SHORTCUT_COMMANDS`.
 *
 * Derived rather than written out, so the dialog cannot list a key the
 * resolver doesn't bind, or miss one it does.
 */
export const SHORTCUT_HELP: {
	group: string;
	rows: { keys: string; description: string }[];
}[] = HELP_GROUP_ORDER.map((group) => ({
	group,
	rows: [
		...SHORTCUT_COMMANDS.filter((command) => command.group === group).map(
			(command) => ({
				keys: sequenceLabel(command.sequence),
				description: command.title,
			}),
		),
		...(group === "Help"
			? PALETTE_KEYS.map((entry) => ({ keys: entry.keys, description: entry.title }))
			: []),
	],
}));

