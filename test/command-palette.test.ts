/**
 * The command palette's item list and ordering.
 */

import { describe, expect, it } from "vitest";
import { Folders } from "../shared/folders";
import { visibleSections } from "../shared/settings-sections";
import {
	buildPaletteItems,
	isPaletteShortcut,
	rankPaletteItems,
	templateItems,
	type PaletteSource,
} from "../app/lib/command-palette";
import type { ShortcutContext } from "../app/lib/shortcuts";

const OPEN: ShortcutContext = {
	rows: [{ id: "a", read: false, starred: false }],
	cursorId: "a",
	openId: "a",
	isComposing: false,
	isHelpOpen: false,
	prefix: null,
	folder: Folders.INBOX,
	hasMailbox: true,
};

function source(overrides: Partial<PaletteSource> = {}): PaletteSource {
	return {
		mailboxId: "me@example.com",
		shortcutContext: OPEN,
		mailboxes: [
			{ id: "me@example.com", email: "me@example.com", name: "Me" },
			{ id: "support@acme.dev", email: "support@acme.dev", name: "Acme support" },
		],
		folders: [{ id: "receipts", name: "Receipts" }],
		labels: [{ id: "lbl_1", name: "Customers" }],
		people: [{ email: "ada@example.com", name: "Ada Lovelace" }],
		templates: [{ slug: "thanks", name: "Thanks for signing up", subject: "Welcome" }],
		recentThreads: [{ mailboxId: "me@example.com", id: "t1", subject: "Invoice 42", sender: "Stripe" }],
		canInsertTemplate: false,
		viewer: { isAdmin: true, passwordMode: true, managesSomeMailbox: true },
		query: "",
		...overrides,
	};
}

const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe("buildPaletteItems", () => {
	it("lists system folders, custom folders and labels for the mailbox", () => {
		const all = ids(buildPaletteItems(source()));
		for (const folder of [Folders.INBOX, Folders.SENT, Folders.SPAM, Folders.TRASH, "receipts"]) {
			expect(all, folder).toContain(`go:folder:${folder}`);
		}
		expect(all).toContain("go:label:lbl_1");
	});

	it("links to the top-level pages", () => {
		const all = ids(buildPaletteItems(source()));
		for (const page of ["people", "templates", "sequences", "analytics"]) {
			expect(all).toContain(`go:page:${page}`);
		}
	});

	it("lists every settings page the viewer can see, from the shared section list", () => {
		const all = buildPaletteItems(source());
		const viewer = { isAdmin: true, passwordMode: true, managesSomeMailbox: true };
		for (const section of visibleSections(viewer)) {
			const item = all.find((entry) => entry.id === `go:settings:${section.id}`);
			expect(item, section.id).toBeDefined();
			expect(item!.run).toEqual({ kind: "navigate", to: `/settings/${section.id}` });
		}
		for (const id of ["domains", "api-tokens", "webhooks", "suppressions"]) {
			expect(ids(all)).toContain(`go:settings:${id}`);
		}
		expect(all.find((i) => i.id === "go:settings:api-tokens")?.run).toEqual({
			kind: "navigate",
			to: "/settings/account#api-tokens",
		});
	});

	it("hides admin-only settings from members, and account settings in Access mode", () => {
		const member = ids(
			buildPaletteItems(
				source({ viewer: { isAdmin: false, passwordMode: true, managesSomeMailbox: true } }),
			),
		);
		expect(member).not.toContain("go:settings:domains");
		expect(member).not.toContain("go:settings:suppressions");
		expect(member).toContain("go:settings:webhooks");

		const access = ids(
			buildPaletteItems(
				source({ viewer: { isAdmin: true, passwordMode: false, managesSomeMailbox: true } }),
			),
		);
		expect(access).not.toContain("go:settings:account");
		expect(access).not.toContain("go:settings:api-tokens");
	});

	it("offers to switch to other mailboxes, not the current one", () => {
		const all = ids(buildPaletteItems(source()));
		expect(all).toContain("mailbox:support@acme.dev");
		expect(all).not.toContain("mailbox:me@example.com");
	});

	it("links people to the People view", () => {
		const person = buildPaletteItems(source()).find((i) => i.id === "person:ada@example.com");
		expect(person?.run).toEqual({ kind: "navigate", to: "/people?person=ada%40example.com" });
	});

	it("adds a search row whenever there is a query, scoped like the top bar", () => {
		expect(ids(buildPaletteItems(source()))).not.toContain("search");
		const withQuery = buildPaletteItems(source({ query: "  invoice " }));
		const search = withQuery.find((i) => i.id === "search");
		expect(search?.run).toEqual({ kind: "search", query: "invoice" });
		expect(search?.title).toBe("Search mail for “invoice”");
		// Off Mail it searches every inbox, as the top bar's field does.
		const offMail = buildPaletteItems(source({ query: "x", mailboxId: undefined })).find((i) => i.id === "search");
		expect(offMail?.title).toBe("Search all inboxes for “x”");
	});

	it("offers Insert template only while composing with templates", () => {
		expect(ids(buildPaletteItems(source()))).not.toContain("cmd:insert-template");
		expect(ids(buildPaletteItems(source({ canInsertTemplate: true })))).toContain(
			"cmd:insert-template",
		);
		expect(
			ids(buildPaletteItems(source({ canInsertTemplate: true, templates: [] }))),
		).not.toContain("cmd:insert-template");
	});

	it("includes recent threads", () => {
		const thread = buildPaletteItems(source()).find((i) => i.id === "thread:me@example.com:t1");
		expect(thread?.run).toEqual({ kind: "open-thread", mailboxId: "me@example.com", id: "t1" });
	});

	it("encodes ids in links", () => {
		const item = buildPaletteItems(source({ labels: [{ id: "a/b c", name: "Odd" }] })).find(
			(i) => i.id === "go:label:a/b c",
		);
		expect(item?.run).toEqual({ kind: "navigate", to: "/mail/me%40example.com/label/a%2Fb%20c" });
	});
});

describe("rankPaletteItems", () => {
	const items = buildPaletteItems(source());

	it("puts recently used commands first with an empty query", () => {
		const ranked = rankPaletteItems(items, "", ["cmd:archive", "go:page:analytics"]);
		expect(ids(ranked.slice(0, 2))).toEqual(["cmd:archive", "go:page:analytics"]);
		expect(ranked[0].section).toBe("Recent");
		// Not repeated further down.
		expect(ids(ranked).filter((id) => id === "cmd:archive")).toHaveLength(1);
	});

	it("ignores recents that no longer exist", () => {
		const ranked = rankPaletteItems(items, "", ["cmd:gone", "cmd:archive"]);
		expect(ranked[0].id).toBe("cmd:archive");
	});

	it("leaves people out of the idle list", () => {
		expect(rankPaletteItems(items, "", []).some((i) => i.section === "People")).toBe(false);
	});

	it("ranks by match quality with a query", () => {
		expect(rankPaletteItems(items, "archive", [])[0].id).toBe("cmd:archive");
		expect(rankPaletteItems(items, "domains", [])[0].id).toBe("go:settings:domains");
		expect(rankPaletteItems(items, "ada", [])[0].id).toBe("person:ada@example.com");
	});

	it("finds an action by keyword", () => {
		expect(ids(rankPaletteItems(items, "delete", [])).slice(0, 3)).toContain("cmd:trash");
	});

	it("lets a recent item win a close match, but not beat an exact one", () => {
		expect(ids(rankPaletteItems(items, "rep", []))[0]).toBe("cmd:reply");
		expect(ids(rankPaletteItems(items, "rep", ["cmd:reply-all"]))[0]).toBe("cmd:reply-all");
		// Typing the whole title still gets you that title.
		expect(ids(rankPaletteItems(items, "reply", ["cmd:reply-all"]))[0]).toBe("cmd:reply");
	});

	it("keeps Search mail last, as the fallback", () => {
		const withSearch = buildPaletteItems(source({ query: "inbox" }));
		const ranked = rankPaletteItems(withSearch, "inbox", []);
		expect(ranked[0].id).toBe("go:folder:inbox");
		expect(ranked[ranked.length - 1].id).toBe("search");
	});

	it("still offers Search mail when nothing else matches", () => {
		const withSearch = buildPaletteItems(source({ query: "qqzzxx" }));
		expect(ids(rankPaletteItems(withSearch, "qqzzxx", []))).toEqual(["search"]);
	});

	it("ranks templates in template mode", () => {
		const templates = templateItems([
			{ slug: "intro", name: "Intro call" },
			{ slug: "thanks", name: "Thanks for signing up" },
		]);
		expect(rankPaletteItems(templates, "thank", [])[0].id).toBe("template:thanks");
		expect(rankPaletteItems(templates, "", []).map((i) => i.id)).toEqual([
			"template:intro",
			"template:thanks",
		]);
	});
});

describe("isPaletteShortcut", () => {
	it("opens on ⌘K and Ctrl+K, even from a text field", () => {
		expect(isPaletteShortcut({ key: "k", metaKey: true })).toBe(true);
		expect(isPaletteShortcut({ key: "k", ctrlKey: true })).toBe(true);
		expect(isPaletteShortcut({ key: "K", metaKey: true, typing: true })).toBe(true);
	});

	it("opens on / only outside text fields", () => {
		expect(isPaletteShortcut({ key: "/" })).toBe(true);
		expect(isPaletteShortcut({ key: "/", typing: true })).toBe(false);
		expect(isPaletteShortcut({ key: "/", ctrlKey: true })).toBe(false);
	});

	it("ignores other chords, plain k, and handled events", () => {
		expect(isPaletteShortcut({ key: "k" })).toBe(false);
		expect(isPaletteShortcut({ key: "k", metaKey: true, shiftKey: true })).toBe(false);
		expect(isPaletteShortcut({ key: "k", metaKey: true, altKey: true })).toBe(false);
		expect(isPaletteShortcut({ key: "k", metaKey: true, defaultPrevented: true })).toBe(false);
	});
});
