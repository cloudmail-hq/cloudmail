/**
 * Parity between the keyboard resolver, the shortcut registry, the help dialog
 * and the command palette.
 *
 * The registry (`SHORTCUT_COMMANDS`) is the one list all three read from, and
 * these tests are what stop it drifting from `resolveShortcut`: a new binding
 * without a registry row fails here, and so does a row whose keys do nothing.
 */

import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import {
	GOTO_TARGETS,
	PALETTE_KEYS,
	SHORTCUT_COMMANDS,
	SHORTCUT_HELP,
	gotoSequence,
	resolveSequence,
	resolveShortcut,
	type ShortcutContext,
} from "../app/lib/shortcuts";
import { buildPaletteItems, type PaletteSource } from "../app/lib/command-palette";

/** A context where every binding can resolve: a cursor row and an open message. */
const FULL: ShortcutContext = {
	// The cursor sits mid-list so both `j` and `k` can move it.
	rows: [
		{ id: "a", read: false, starred: false },
		{ id: "b", read: true, starred: true },
		{ id: "c", read: false, starred: true },
	],
	cursorId: "b",
	openId: "a",
	isComposing: false,
	isHelpOpen: false,
	prefix: null,
	folder: Folders.INBOX,
	hasMailbox: true,
};

/** Every printable ASCII key, plus the named keys the resolver might bind. */
const CANDIDATE_KEYS = [
	...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)),
	"Enter",
	"Escape",
	"Tab",
	"Backspace",
	"Delete",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"Home",
	"End",
	"PageUp",
	"PageDown",
];

/** Every sequence (single key, or prefix + key) the resolver acts on in `ctx`. */
function boundSequences(ctx: ShortcutContext): string[][] {
	const bound: string[][] = [];
	for (const key of CANDIDATE_KEYS) {
		const first = resolveShortcut({ key }, ctx);
		if (first.action.type !== "none") bound.push([key]);
		if (first.nextPrefix) {
			for (const second of CANDIDATE_KEYS) {
				const next = resolveShortcut({ key: second }, { ...ctx, prefix: first.nextPrefix });
				if (next.action.type === "none") continue;
				// Escape acts whether or not a prefix is armed; that is the plain
				// binding, not a `g`/`*` sequence of its own.
				const alone = resolveShortcut({ key: second }, ctx).action;
				if (JSON.stringify(alone) === JSON.stringify(next.action)) continue;
				bound.push([key, second]);
			}
		}
	}
	return bound;
}

const registered = new Set(SHORTCUT_COMMANDS.map((c) => c.sequence.join(" ")));

describe("registry ↔ resolver parity", () => {
	it("has a registry row for every key the resolver binds", () => {
		const missing = boundSequences(FULL)
			.map((seq) => seq.join(" "))
			.filter((seq) => !registered.has(seq));
		expect(missing).toEqual([]);
	});

	it("also covers keys that only bind with nothing open (Enter)", () => {
		const listOnly = { ...FULL, openId: null };
		const missing = boundSequences(listOnly)
			.map((seq) => seq.join(" "))
			.filter((seq) => !registered.has(seq));
		expect(missing).toEqual([]);
	});

	it("resolves every registry row to an action in some context", () => {
		const contexts: ShortcutContext[] = [
			FULL,
			{ ...FULL, openId: null },
			// Escape only acts with something open; covered by FULL.
		];
		for (const command of SHORTCUT_COMMANDS) {
			const acts = contexts.some(
				(ctx) => resolveSequence(command.sequence, ctx).type !== "none",
			);
			expect(acts, command.id).toBe(true);
		}
	});

	it("has unique ids and unique key sequences", () => {
		const ids = SHORTCUT_COMMANDS.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(registered.size).toBe(SHORTCUT_COMMANDS.length);
	});

	it("lists every g target as a navigation row", () => {
		for (const [key, folder] of Object.entries(GOTO_TARGETS)) {
			expect(gotoSequence(folder), folder).toEqual(["g", key]);
		}
	});

	it("does not bind the palette's own `/`", () => {
		expect(resolveShortcut({ key: "/" }, FULL).action.type).toBe("none");
		expect(PALETTE_KEYS.map((k) => k.keys)).toContain("/");
	});
});

describe("help dialog is derived from the registry", () => {
	const rows = SHORTCUT_HELP.flatMap((section) => section.rows);

	it("shows one row per registry entry plus the palette keys", () => {
		expect(rows.length).toBe(SHORTCUT_COMMANDS.length + PALETTE_KEYS.length);
	});

	it("uses the registry's titles", () => {
		for (const command of SHORTCUT_COMMANDS) {
			expect(rows.map((r) => r.description)).toContain(command.title);
		}
	});
});

function source(overrides: Partial<PaletteSource> = {}): PaletteSource {
	return {
		mailboxId: "me@example.com",
		shortcutContext: FULL,
		mailboxes: [],
		folders: [],
		labels: [],
		people: [],
		templates: [],
		recentThreads: [],
		canInsertTemplate: false,
		viewer: { isAdmin: true, passwordMode: true, managesSomeMailbox: true },
		query: "",
		...overrides,
	};
}

describe("registry ↔ palette parity", () => {
	const paletteActions = SHORTCUT_COMMANDS.filter((c) => c.palette === "action");

	it("offers every palette-eligible shortcut when a message is open", () => {
		const ids = new Set(buildPaletteItems(source()).map((item) => item.id));
		for (const command of paletteActions) {
			expect(ids.has(`cmd:${command.id}`), command.id).toBe(true);
		}
	});

	it("shows each action's own shortcut beside it", () => {
		const items = buildPaletteItems(source());
		for (const command of paletteActions) {
			const item = items.find((entry) => entry.id === `cmd:${command.id}`);
			expect(item?.shortcut, command.id).toEqual(command.sequence);
		}
	});

	it("runs exactly what the keystroke would", () => {
		const items = buildPaletteItems(source());
		for (const command of paletteActions) {
			const item = items.find((entry) => entry.id === `cmd:${command.id}`)!;
			expect(item.run, command.id).toEqual({
				kind: "shortcut",
				action: resolveSequence(command.sequence, FULL),
			});
		}
	});

	it("shows each g shortcut on its folder", () => {
		const items = buildPaletteItems(source());
		for (const [key, folder] of Object.entries(GOTO_TARGETS)) {
			const item = items.find((entry) => entry.id === `go:folder:${folder}`);
			expect(item?.shortcut, folder).toEqual(["g", key]);
		}
	});

	it("hides actions that need a message when nothing is selected or open", () => {
		const empty: ShortcutContext = { ...FULL, cursorId: null, openId: null, rows: [] };
		const ids = new Set(buildPaletteItems(source({ shortcutContext: empty })).map((i) => i.id));
		for (const id of ["reply", "archive", "trash", "star", "mute", "snooze", "label", "move", "spam"]) {
			expect(ids.has(`cmd:${id}`), id).toBe(false);
		}
		// List-wide ones stay.
		expect(ids.has("cmd:compose")).toBe(true);
		expect(ids.has("cmd:undo")).toBe(true);
		expect(ids.has("cmd:help")).toBe(true);
	});

	it("offers only Compose off the mail workspace", () => {
		const actions = buildPaletteItems(source({ shortcutContext: null, mailboxId: undefined })).filter(
			(item) => item.section === "Actions",
		);
		expect(actions.map((a) => a.id)).toEqual(["cmd:compose"]);
	});

	it("respects folder rules, e.g. no Archive while in Archive", () => {
		const inArchive = { ...FULL, folder: Folders.ARCHIVE };
		const ids = new Set(buildPaletteItems(source({ shortcutContext: inArchive })).map((i) => i.id));
		expect(ids.has("cmd:archive")).toBe(false);
	});

	it("offers actions while the help dialog is open, because they run after it closes", () => {
		const ids = new Set(
			buildPaletteItems(source({ shortcutContext: { ...FULL, isHelpOpen: true } })).map((i) => i.id),
		);
		expect(ids.has("cmd:archive")).toBe(true);
	});

	it("offers nothing that needs a mailbox while composing", () => {
		const composing = { ...FULL, isComposing: true };
		const actions = buildPaletteItems(source({ shortcutContext: composing })).filter(
			(item) => item.section === "Actions",
		);
		expect(actions.map((a) => a.id)).toEqual(["cmd:compose"]);
	});
});

describe("screener and triage in the palette", () => {
	it("offers the Screener with its g s shortcut, and the triage settings", () => {
		const items = buildPaletteItems(source());
		const screener = items.find((i) => i.id === "go:folder:screener");
		expect(screener?.run).toEqual({ kind: "navigate", to: "/mail/me%40example.com/screener" });
		expect(screener?.shortcut).toEqual(["g", "s"]);
		const settings = items.find((i) => i.id === "go:mailbox-settings:triage");
		expect(settings?.run).toEqual({ kind: "navigate", to: "/mail/me%40example.com/settings#triage" });
		expect(settings?.keywords).toContain("split inbox");
	});

	it("does not list the screener folder twice", () => {
		const items = buildPaletteItems(source({ folders: [{ id: "screener", name: "Screener" }] }));
		expect(items.filter((i) => i.id === "go:folder:screener")).toHaveLength(1);
	});
});
