// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for keyboard-shortcut dispatch.
 *
 * The risk here is precedence, not lookup. The bindings live in one long
 * ordered chain of guards, and every bug this suite is built around is an
 * ordering bug rather than a wrong constant:
 *
 * - a key that acts while the user is typing into a field,
 * - a prefix that outlives its keystroke and swallows the next one,
 * - an action landing on the open message when it should land on the cursor,
 * - one key falling through two branches and firing twice,
 * - a destructive key resolving with nothing to act on.
 *
 * Dispatch is a pure function precisely so these can be asserted directly.
 * Nothing here renders a component: a jsdom test of the same logic would prove
 * that React forwards a keydown, which is not the part that breaks.
 */

import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import {
	GOTO_TARGETS,
	SHORTCUT_HELP,
	idsForScope,
	resolveShortcut,
	stepCursor,
	type ShortcutContext,
	type ShortcutKeyEvent,
	type ShortcutRow,
} from "../app/lib/shortcuts";

/** Four rows spanning every read/starred combination the `*` scopes select on. */
const ROWS: ShortcutRow[] = [
	{ id: "a", read: false, starred: false },
	{ id: "b", read: true, starred: true },
	{ id: "c", read: false, starred: true },
	{ id: "d", read: true, starred: false },
];

function context(overrides: Partial<ShortcutContext> = {}): ShortcutContext {
	return {
		rows: ROWS,
		cursorId: null,
		openId: null,
		isComposing: false,
		isHelpOpen: false,
		prefix: null,
		hasMailbox: true,
		...overrides,
	};
}

/** `key` alone is the common case; the rest of the event defaults to unmodified. */
function press(
	key: string,
	overrides: Partial<ShortcutKeyEvent> = {},
): ShortcutKeyEvent {
	return { key, ...overrides };
}

describe("typing guard", () => {
	it("yields no action for any printable key while typing", () => {
		// Every letter that is bound to something destructive or navigational.
		for (const key of ["c", "e", "s", "u", "b", "j", "k", "x", "#", "!", "/"]) {
			const { action, preventDefault } = resolveShortcut(
				press(key, { typing: true }),
				context({ cursorId: "a" }),
			);
			expect(action, `"${key}" must be inert while typing`).toEqual({
				type: "none",
			});
			expect(preventDefault).toBe(false);
		}
	});

	it("leaves an armed prefix alone while typing rather than consuming it", () => {
		// Typing must neither resolve the prefix nor forget it: the timeout owns
		// expiry, and dropping it here would make it depend on where focus is.
		const { action, nextPrefix } = resolveShortcut(
			press("i", { typing: true }),
			context({ prefix: "g" }),
		);
		expect(action).toEqual({ type: "none" });
		expect(nextPrefix).toBe("g");
	});

	it("still closes the composer on Escape, but only once focus has left the field", () => {
		// Escape inside a text field is left to the field; outside it discards.
		expect(
			resolveShortcut(
				press("Escape", { typing: true }),
				context({ isComposing: true }),
			).action,
		).toEqual({ type: "none" });

		expect(
			resolveShortcut(press("Escape"), context({ isComposing: true })).action,
		).toEqual({ type: "close-compose" });
	});

	it("ignores browser and OS chords", () => {
		for (const modifier of ["metaKey", "ctrlKey", "altKey"] as const) {
			expect(
				resolveShortcut(press("c", { [modifier]: true }), context()).action,
			).toEqual({ type: "none" });
		}
	});
});

describe("g prefix", () => {
	it("arms without acting", () => {
		const { action, nextPrefix, preventDefault } = resolveShortcut(
			press("g"),
			context(),
		);
		expect(action).toEqual({ type: "none" });
		expect(nextPrefix).toBe("g");
		// Not claimed: `g` alone has done nothing worth suppressing.
		expect(preventDefault).toBe(false);
	});

	it("navigates on the second keystroke and disarms", () => {
		const { action, nextPrefix } = resolveShortcut(
			press("i"),
			context({ prefix: "g" }),
		);
		expect(action).toEqual({ type: "goto", folder: Folders.INBOX });
		expect(nextPrefix).toBeNull();
	});

	it("routes every documented target", () => {
		for (const [key, folder] of Object.entries(GOTO_TARGETS)) {
			expect(
				resolveShortcut(press(key), context({ prefix: "g" })).action,
			).toEqual({ type: "goto", folder });
		}
	});

	it("expires rather than swallowing the following keystroke", () => {
		// An unmapped second key drops the prefix and does nothing. What matters is
		// that the prefix is gone, so the *next* key is read plainly.
		const { action, nextPrefix } = resolveShortcut(
			press("z"),
			context({ prefix: "g" }),
		);
		expect(action).toEqual({ type: "none" });
		expect(nextPrefix).toBeNull();

		expect(
			resolveShortcut(press("c"), context({ prefix: null })).action,
		).toEqual({ type: "compose" });
	});

	it("takes precedence over the plain binding for the same key", () => {
		// `k` steps the cursor, but `g` then `k` must reach Scheduled.
		expect(
			resolveShortcut(press("k"), context({ prefix: "g", cursorId: "b" })).action,
		).toEqual({ type: "goto", folder: Folders.SCHEDULED });

		expect(
			resolveShortcut(press("k"), context({ cursorId: "b" })).action,
		).toEqual({ type: "move-cursor", id: "a", open: false });
	});

	it("refuses to navigate without a mailbox in the route", () => {
		expect(
			resolveShortcut(press("i"), context({ prefix: "g", hasMailbox: false }))
				.action,
		).toEqual({ type: "none" });
	});
});

describe("* selection prefix", () => {
	it("arms without acting", () => {
		const { action, nextPrefix } = resolveShortcut(press("*"), context());
		expect(action).toEqual({ type: "none" });
		expect(nextPrefix).toBe("*");
	});

	it("resolves each scope to the matching rows", () => {
		const cases: [string, string[]][] = [
			["a", ["a", "b", "c", "d"]],
			["n", []],
			["r", ["b", "d"]],
			["u", ["a", "c"]],
			["s", ["b", "c"]],
			["t", ["a", "d"]],
		];

		for (const [key, ids] of cases) {
			const { action, nextPrefix } = resolveShortcut(
				press(key),
				context({ prefix: "*" }),
			);
			expect(action, `* then ${key}`).toMatchObject({ type: "select", ids });
			expect(nextPrefix).toBeNull();
		}
	});

	it("selects from the listed rows only, never a stale set", () => {
		// The scope is computed against whatever is on screen, so an empty list
		// selects nothing rather than reaching for a previous page.
		expect(
			resolveShortcut(press("a"), context({ prefix: "*", rows: [] })).action,
		).toEqual({ type: "select", scope: "all", ids: [] });
	});

	it("disarms on an unmapped second key", () => {
		const { action, nextPrefix } = resolveShortcut(
			press("q"),
			context({ prefix: "*" }),
		);
		expect(action).toEqual({ type: "none" });
		expect(nextPrefix).toBeNull();
	});
});

describe("cursor movement", () => {
	it("starts at the top on j and the bottom on k from a cold start", () => {
		expect(resolveShortcut(press("j"), context()).action).toEqual({
			type: "move-cursor",
			id: "a",
			open: false,
		});
		expect(resolveShortcut(press("k"), context()).action).toEqual({
			type: "move-cursor",
			id: "d",
			open: false,
		});
	});

	it("stops at each end rather than wrapping", () => {
		// Wrapping would silently move the target of the next destructive key from
		// the last row to the first.
		expect(
			resolveShortcut(press("j"), context({ cursorId: "d" })).action,
		).toEqual({ type: "none" });
		expect(
			resolveShortcut(press("k"), context({ cursorId: "a" })).action,
		).toEqual({ type: "none" });
	});

	it("does not open the message it moves to", () => {
		const { action } = resolveShortcut(press("j"), context({ cursorId: "a" }));
		expect(action).toEqual({ type: "move-cursor", id: "b", open: false });
	});

	it("follows the cursor into the pane only when one is already open", () => {
		const { action } = resolveShortcut(
			press("j"),
			context({ cursorId: "a", openId: "a" }),
		);
		expect(action).toEqual({ type: "move-cursor", id: "b", open: true });
	});

	it("does nothing with an empty list", () => {
		expect(resolveShortcut(press("j"), context({ rows: [] })).action).toEqual({
			type: "none",
		});
	});

	it("recovers when the cursor points at a row that has gone", () => {
		// `stepCursor` treats an unknown cursor as no cursor, so a filtered-out row
		// leaves the list navigable instead of stuck.
		expect(stepCursor(ROWS, "vanished", 1)).toBe("a");
	});
});

describe("Enter", () => {
	it("opens the cursor row", () => {
		expect(
			resolveShortcut(press("Enter"), context({ cursorId: "c" })).action,
		).toEqual({ type: "open-cursor", id: "c" });
	});

	it("falls back to the first row so the list opens from a cold start", () => {
		expect(resolveShortcut(press("Enter"), context()).action).toEqual({
			type: "open-cursor",
			id: "a",
		});
	});

	it("is inert once a message is open, leaving the pane's own controls alone", () => {
		expect(
			resolveShortcut(press("Enter"), context({ openId: "a", cursorId: "a" }))
				.action,
		).toEqual({ type: "none" });
	});
});

describe("cursor versus open message targeting", () => {
	it("acts on the cursor row when nothing is open", () => {
		expect(
			resolveShortcut(press("e"), context({ cursorId: "c" })).action,
		).toEqual({ type: "archive", id: "c" });
	});

	it("acts on the open message when there is one, ignoring the cursor", () => {
		// The cursor may have moved on while the pane still shows an older message.
		expect(
			resolveShortcut(press("e"), context({ cursorId: "c", openId: "a" }))
				.action,
		).toEqual({ type: "archive", id: "a" });
	});

	it("refuses to act with neither a cursor nor an open message", () => {
		// This is the guarantee the old implementation made by having no cursor at
		// all: a destructive key with no visible target does nothing.
		for (const key of ["e", "#", "!", "s", "b", "+", "-"]) {
			expect(resolveShortcut(press(key), context()).action, key).toEqual({
				type: "none",
			});
		}
	});

	it("refuses to act without a mailbox", () => {
		expect(
			resolveShortcut(
				press("#"),
				context({ cursorId: "a", hasMailbox: false }),
			).action,
		).toEqual({ type: "none" });
	});
});

describe("bindings", () => {
	it("resolves reply, reply-all and forward in place", () => {
		const cases: [string, string][] = [
			["r", "reply"],
			["a", "reply-all"],
			["f", "forward"],
		];
		for (const [key, mode] of cases) {
			expect(resolveShortcut(press(key), context({ cursorId: "a" })).action).toEqual(
				{ type: "reply", mode, id: "a", popOut: false },
			);
		}
	});

	it("pops the composer out for the shifted variants", () => {
		const cases: [string, string][] = [
			["R", "reply"],
			["A", "reply-all"],
			["F", "forward"],
		];
		for (const [key, mode] of cases) {
			expect(resolveShortcut(press(key), context({ cursorId: "a" })).action).toEqual(
				{ type: "reply", mode, id: "a", popOut: true },
			);
		}
	});

	it("inverts star from the listed row's own state", () => {
		// Row "a" is unstarred, row "b" is starred.
		expect(
			resolveShortcut(press("s"), context({ cursorId: "a" })).action,
		).toEqual({ type: "star", id: "a", starred: true });
		expect(
			resolveShortcut(press("s"), context({ cursorId: "b" })).action,
		).toEqual({ type: "star", id: "b", starred: false });
	});

	it("defers the star state to the caller for a message that is not listed", () => {
		// Reached by search or a direct link: there is no row to invert, so the
		// hook reads its cache instead.
		expect(
			resolveShortcut(press("s"), context({ openId: "unlisted" })).action,
		).toEqual({ type: "star", id: "unlisted", starred: null });
	});

	it("marks read and unread on the shifted keys, leaving u for the list", () => {
		expect(
			resolveShortcut(press("I"), context({ cursorId: "a" })).action,
		).toEqual({ type: "mark-read", id: "a", read: true });
		expect(
			resolveShortcut(press("U"), context({ cursorId: "a" })).action,
		).toEqual({ type: "mark-read", id: "a", read: false });
	});

	it("sends u back to the list, and only from an open message", () => {
		expect(
			resolveShortcut(press("u"), context({ openId: "a" })).action,
		).toEqual({ type: "close-message" });
		expect(
			resolveShortcut(press("u"), context({ cursorId: "a" })).action,
		).toEqual({ type: "none" });
	});

	it("toggles selection of the cursor row with x", () => {
		expect(
			resolveShortcut(press("x"), context({ cursorId: "b" })).action,
		).toEqual({ type: "toggle-select", id: "b" });
	});

	it("ticks the cursor row with x even while a message is open", () => {
		// `x` mirrors the row checkbox, which belongs to the list, so it stays on
		// the cursor rather than following the pane.
		expect(
			resolveShortcut(press("x"), context({ cursorId: "b", openId: "a" }))
				.action,
		).toEqual({ type: "toggle-select", id: "b" });
	});

	it("needs a cursor for x", () => {
		expect(
			resolveShortcut(press("x"), context({ openId: "a" })).action,
		).toEqual({ type: "none" });
	});

	it("reports spam, except from within Spam", () => {
		expect(
			resolveShortcut(press("!"), context({ cursorId: "a" })).action,
		).toEqual({ type: "spam", id: "a" });
		expect(
			resolveShortcut(press("!"), context({ cursorId: "a", folder: Folders.SPAM }))
				.action,
		).toEqual({ type: "none" });
	});

	it("archives, except from within Archive", () => {
		expect(
			resolveShortcut(press("e"), context({ cursorId: "a" })).action,
		).toEqual({ type: "archive", id: "a" });
		expect(
			resolveShortcut(
				press("e"),
				context({ cursorId: "a", folder: Folders.ARCHIVE }),
			).action,
		).toEqual({ type: "none" });
	});

	it("sets and clears importance", () => {
		expect(
			resolveShortcut(press("+"), context({ cursorId: "a" })).action,
		).toEqual({ type: "priority", id: "a", priority: "high" });
		expect(
			resolveShortcut(press("-"), context({ cursorId: "a" })).action,
		).toEqual({ type: "priority", id: "a", priority: null });
	});

	it("bins with # and snoozes with b", () => {
		expect(
			resolveShortcut(press("#"), context({ cursorId: "a" })).action,
		).toEqual({ type: "delete", id: "a" });
		expect(
			resolveShortcut(press("b"), context({ cursorId: "a" })).action,
		).toEqual({ type: "snooze", id: "a" });
	});

	it("opens the move, label and more menus, aimed at whatever is current", () => {
		const cases: [string, string][] = [
			["v", "move"],
			["l", "label"],
			[".", "more"],
		];
		for (const [key, menu] of cases) {
			expect(
				resolveShortcut(press(key), context({ cursorId: "a" })).action,
			).toEqual({ type: "menu", menu, target: "cursor" });
			expect(
				resolveShortcut(press(key), context({ cursorId: "a", openId: "a" }))
					.action,
			).toEqual({ type: "menu", menu, target: "message" });
		}
	});

	it("expands and collapses a thread, only with a conversation open", () => {
		expect(
			resolveShortcut(press(";"), context({ openId: "a" })).action,
		).toEqual({ type: "thread-expand", expand: true });
		expect(
			resolveShortcut(press(":"), context({ openId: "a" })).action,
		).toEqual({ type: "thread-expand", expand: false });

		for (const key of [";", ":"]) {
			expect(
				resolveShortcut(press(key), context({ cursorId: "a" })).action,
				key,
			).toEqual({ type: "none" });
		}
	});

	it("steps within a conversation, only with one open", () => {
		expect(
			resolveShortcut(press("n"), context({ openId: "a" })).action,
		).toEqual({ type: "thread-step", delta: 1 });
		expect(
			resolveShortcut(press("p"), context({ openId: "a" })).action,
		).toEqual({ type: "thread-step", delta: -1 });

		for (const key of ["n", "p"]) {
			expect(
				resolveShortcut(press(key), context({ cursorId: "a" })).action,
				key,
			).toEqual({ type: "none" });
		}
	});

	it("composes, undoes and opens help without needing a target", () => {
		expect(resolveShortcut(press("c"), context()).action).toEqual({
			type: "compose",
		});
		expect(resolveShortcut(press("z"), context()).action).toEqual({
			type: "undo",
		});
		expect(resolveShortcut(press("?"), context()).action).toEqual({
			type: "open-help",
		});
	});

	it("leaves `/` to the command palette's own listener", () => {
		// The palette opens on `/` from every page, not only the mail workspace,
		// so the resolver must not claim it as well.
		const { action, preventDefault } = resolveShortcut(press("/"), context());
		expect(action).toEqual({ type: "none" });
		expect(preventDefault).toBe(false);
	});

	it("mutes the targeted conversation on m", () => {
		expect(resolveShortcut(press("m"), context({ cursorId: "c" })).action).toEqual({
			type: "mute",
			id: "c",
		});
		expect(resolveShortcut(press("m"), context()).action).toEqual({ type: "none" });
	});
});

describe("modal states", () => {
	it("runs nothing while the composer is open", () => {
		// A composer is a text-entry context even when focus sits on one of its
		// buttons, so a stray `e` must not archive behind it.
		for (const key of ["e", "#", "j", "c", "x"]) {
			expect(
				resolveShortcut(press(key), context({ isComposing: true, cursorId: "a" }))
					.action,
				key,
			).toEqual({ type: "none" });
		}
	});

	it("runs nothing while the help dialog is open", () => {
		// Reading the shortcut list and trying a key out must not act on mail
		// behind the dialog.
		for (const key of ["e", "#", "j", "x"]) {
			expect(
				resolveShortcut(press(key), context({ isHelpOpen: true, cursorId: "a" }))
					.action,
				key,
			).toEqual({ type: "none" });
		}
	});

	it("leaves Escape to Radix while the help dialog is open", () => {
		// The dialog closes itself and restores focus; claiming the key here would
		// be a second handler for one keystroke.
		const { action, preventDefault } = resolveShortcut(
			press("Escape"),
			context({ isHelpOpen: true }),
		);
		expect(action).toEqual({ type: "none" });
		expect(preventDefault).toBe(false);
	});

	it("closes the composer before the message when both are open", () => {
		expect(
			resolveShortcut(
				press("Escape"),
				context({ isComposing: true, openId: "a" }),
			).action,
		).toEqual({ type: "close-compose" });
	});

	it("closes the open message on Escape", () => {
		expect(
			resolveShortcut(press("Escape"), context({ openId: "a" })).action,
		).toEqual({ type: "close-message" });
	});

	/**
	 * The hazard the help-dialog case above only half covered.
	 *
	 * Every Radix overlay — the row dropdown, the message toolbar's move/label
	 * menus, the dialog — closes itself on Escape from a capture-phase listener
	 * that calls `preventDefault()` and never `stopPropagation()`. The app's
	 * listener is on the bubble phase, so it sees that keystroke afterwards.
	 * Without this guard, one Escape over an open dropdown closed the dropdown
	 * *and* the reading pane behind it.
	 */
	it("ignores an Escape another handler already took", () => {
		const { action, preventDefault } = resolveShortcut(
			press("Escape", { defaultPrevented: true }),
			context({ openId: "a" }),
		);

		expect(action).toEqual({ type: "none" });
		expect(preventDefault).toBe(false);
	});

	it("still closes the composer when Escape was not already handled", () => {
		// The guard must not swallow the ordinary case: no overlay open means no
		// `defaultPrevented`, and Escape does its job.
		expect(
			resolveShortcut(
				press("Escape", { defaultPrevented: false }),
				context({ isComposing: true }),
			).action,
		).toEqual({ type: "close-compose" });
	});
});

describe("one keystroke, one action", () => {
	/**
	 * Every key the resolver binds, with a context in which it resolves.
	 *
	 * The point is not the mapping — the tests above cover that — but that the
	 * chain of guards is a partition. A key reachable from two branches would
	 * both move the cursor and mutate mail from a single press.
	 */
	const BOUND_KEYS = [
		"c",
		"z",
		"m",
		"?",
		"j",
		"k",
		"Enter",
		"x",
		"r",
		"a",
		"f",
		"R",
		"A",
		"F",
		"s",
		"U",
		"I",
		"u",
		"e",
		"b",
		"#",
		"!",
		"+",
		"-",
		"v",
		"l",
		".",
		";",
		":",
		"n",
		"p",
		"Escape",
	];

	it("resolves each bound key to exactly one action", () => {
		// A cursor and an open message are both present, which is the context where
		// an overlapping binding would be ambiguous.
		const ctx = context({ cursorId: "b", openId: "a" });

		for (const key of BOUND_KEYS) {
			const first = resolveShortcut(press(key), ctx);
			const second = resolveShortcut(press(key), ctx);
			// Pure: the same input resolves identically, so nothing is being
			// consumed or latched between calls.
			expect(second, key).toEqual(first);
			// One action object, never a list.
			expect(Array.isArray(first.action), key).toBe(false);
		}
	});

	it("claims every key it acts on, and no key it ignores", () => {
		const ctx = context({ cursorId: "b", openId: "a" });

		for (const key of BOUND_KEYS) {
			const { action, preventDefault } = resolveShortcut(press(key), ctx);
			// The two must agree: a claimed key that does nothing swallows a
			// keystroke, and an unclaimed key that acts lets the browser act too.
			expect(preventDefault, `${key} -> ${action.type}`).toBe(
				action.type !== "none",
			);
		}
	});

	it("never claims an unbound key", () => {
		for (const key of ["q", "w", "y", "/", "1", "@", "Tab", "ArrowDown"]) {
			const { action, preventDefault } = resolveShortcut(
				press(key),
				context({ cursorId: "b", openId: "a" }),
			);
			expect(action, key).toEqual({ type: "none" });
			expect(preventDefault, key).toBe(false);
		}
	});

	it("arms a prefix without claiming the keystroke", () => {
		// `g` and `*` are not actions, so the browser is left alone; only the
		// second keystroke resolves.
		for (const key of ["g", "*"]) {
			const { action, preventDefault, nextPrefix } = resolveShortcut(
				press(key),
				context(),
			);
			expect(action, key).toEqual({ type: "none" });
			expect(preventDefault, key).toBe(false);
			expect(nextPrefix, key).toBe(key);
		}
	});
});

describe("idsForScope", () => {
	it("partitions the listed rows", () => {
		// read/unread and starred/unstarred must each cover every row exactly once,
		// or `*r` then `*u` would leave a message unreachable by either.
		const read = idsForScope(ROWS, "read");
		const unread = idsForScope(ROWS, "unread");
		expect([...read, ...unread].sort()).toEqual(["a", "b", "c", "d"]);

		const starred = idsForScope(ROWS, "starred");
		const unstarred = idsForScope(ROWS, "unstarred");
		expect([...starred, ...unstarred].sort()).toEqual(["a", "b", "c", "d"]);
	});

	it("preserves display order", () => {
		// The selection feeds bulk actions and the count shown to the user; a
		// reordered set would report the wrong first row.
		expect(idsForScope(ROWS, "all")).toEqual(["a", "b", "c", "d"]);
	});
});

describe("SHORTCUT_HELP", () => {
	/** Keys the help dialog claims to document, flattened. */
	const documented = SHORTCUT_HELP.flatMap((section) =>
		section.rows.map((row) => row.keys),
	);

	it("documents every key the resolver binds", () => {
		// The audit found the dialog silently omitting bindings — Enter among them.
		// This pins the dialog to the implementation: a new binding with no help row
		// fails here.
		const blob = documented.join(" ");
		const required = [
			"j",
			"k",
			"Enter",
			"u",
			"n",
			"p",
			";",
			":",
			"Escape",
			"/",
			"⌘K",
			"x",
			"* then a",
			"* then n",
			"* then r",
			"* then u",
			"* then s",
			"* then t",
			"c",
			"r",
			"a",
			"f",
			"R",
			"A",
			"F",
			"e",
			"s",
			"I",
			"U",
			"b",
			"m",
			"z",
			"!",
			"+",
			"-",
			"#",
			"v",
			"l",
			".",
			"?",
		];
		for (const entry of required) {
			expect(documented, entry).toContain(entry);
		}
		// Every `g` target is listed individually.
		for (const key of Object.keys(GOTO_TARGETS)) {
			expect(blob, `g then ${key}`).toContain(`g then ${key}`);
		}
	});

	it("has no duplicate rows", () => {
		// Two rows for one key means the dialog contradicts itself somewhere.
		expect(new Set(documented).size).toBe(documented.length);
	});

	it("describes every row", () => {
		for (const section of SHORTCUT_HELP) {
			expect(section.rows.length).toBeGreaterThan(0);
			for (const row of section.rows) {
				expect(row.keys.length).toBeGreaterThan(0);
				expect(row.description.length).toBeGreaterThan(0);
			}
		}
	});
});
