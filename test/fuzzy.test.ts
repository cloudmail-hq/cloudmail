/**
 * Fuzzy ranking for the command palette and snippet picker.
 *
 * What matters is order, not the absolute numbers: the same keystrokes have to
 * land on the same row every time, and the row people expect has to win.
 */

import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore, normalize, scoreFields } from "../app/lib/fuzzy";

const titles = (items: { title: string }[]) => items.map((item) => item.title);

function rank(query: string, list: string[]): string[] {
	return titles(fuzzyFilter(list.map((title) => ({ title })), query, (item) => item));
}

describe("fuzzyScore", () => {
	it("matches everything with an empty query", () => {
		expect(fuzzyScore("", "Archive")).toBe(0);
		expect(fuzzyScore("   ", "Archive")).toBe(0);
	});

	it("rejects text that doesn't contain the characters in order", () => {
		expect(fuzzyScore("zq", "Archive")).toBeNull();
		expect(fuzzyScore("evih", "Archive")).toBeNull();
	});

	it("orders exact > prefix > word prefix > substring > subsequence", () => {
		const exact = fuzzyScore("inbox", "Inbox")!;
		const prefix = fuzzyScore("inb", "Inbox")!;
		const wordPrefix = fuzzyScore("tom", "Snooze until tomorrow")!;
		const substring = fuzzyScore("box", "Inbox")!;
		const subsequence = fuzzyScore("mau", "Mark as unread")!;
		expect(exact).toBeGreaterThan(prefix);
		expect(prefix).toBeGreaterThan(wordPrefix);
		expect(wordPrefix).toBeGreaterThan(substring);
		expect(substring).toBeGreaterThan(subsequence);
		expect(subsequence).toBeGreaterThan(0);
	});

	it("is case and accent insensitive", () => {
		expect(fuzzyScore("ARCH", "archive")).toBe(fuzzyScore("arch", "Archive"));
		expect(fuzzyScore("resume", "Résumé")).not.toBeNull();
		expect(normalize("  Café   Crème ")).toBe("cafe creme");
	});

	it("matches multi-word queries word by word, in any order", () => {
		expect(fuzzyScore("unread mark", "Mark as unread")).not.toBeNull();
		expect(fuzzyScore("mark zebra", "Mark as unread")).toBeNull();
	});

	it("needs two characters before falling back to scattered letters", () => {
		// One letter that only appears mid-word is noise in a 60-row list.
		expect(fuzzyScore("v", "Archive")).not.toBeNull(); // substring still counts
		expect(fuzzyScore("x", "Archive")).toBeNull();
	});

	it("matches word-prefix chunks", () => {
		expect(fuzzyScore("snotom", "Snooze until tomorrow")).not.toBeNull();
		expect(fuzzyScore("rea", "Reply all")).not.toBeNull();
	});

	it("rejects letters scattered mid-word, which read as noise in a long list", () => {
		// Real noise seen in the palette while typing "arc" and "sent".
		expect(fuzzyScore("arc", "Reply in a full-screen composer")).toBeNull();
		expect(fuzzyScore("arc", "Keyboard shortcuts")).toBeNull();
		expect(fuzzyScore("sent", "Select unstarred messages")).toBeNull();
		expect(fuzzyScore("sent", "API tokens")).toBeNull();
	});

	it("prefers initials over the same letters scattered mid-word", () => {
		// m-a-u on three word starts versus m, a, u buried inside words.
		const initials = fuzzyScore("mau", "Mark as unread");
		const partly = fuzzyScore("mau", "Mailbox audit");
		expect(initials).not.toBeNull();
		expect(partly).not.toBeNull();
		expect(initials!).toBeGreaterThan(partly!);
		// Letters with no structure at all are dropped as noise.
		expect(fuzzyScore("mau", "comma bureau")).toBeNull();
	});
});

describe("fuzzyFilter ordering", () => {
	it("puts the prefix match first", () => {
		expect(rank("ar", ["Mark as read", "Archive", "Search mail"])[0]).toBe("Archive");
	});

	it("finds Mark as unread from its initials", () => {
		expect(rank("mau", ["Mute", "Mark as unread", "Mark as read", "Move to…"])[0]).toBe(
			"Mark as unread",
		);
	});

	it("ranks a word-start hit above a mid-word hit", () => {
		expect(rank("read", ["Thread view", "Mark as read"])).toEqual([
			"Mark as read",
			"Thread view",
		]);
	});

	it("prefers the shorter title for the same kind of match", () => {
		expect(rank("re", ["Reply all", "Reply"])).toEqual(["Reply", "Reply all"]);
	});

	it("keeps input order for ties, so callers control tie-breaks", () => {
		expect(rank("", ["b", "a", "c"])).toEqual(["b", "a", "c"]);
	});

	it("drops items that don't match", () => {
		expect(rank("spam", ["Inbox", "Report spam", "Sent"])).toEqual(["Report spam"]);
	});

	it("applies a boost on top of the match score", () => {
		const items = [{ title: "Reply" }, { title: "Reply all" }];
		const boosted = fuzzyFilter(items, "re", (item) => item, (item) =>
			item.title === "Reply all" ? 100 : 0,
		);
		expect(titles(boosted)[0]).toBe("Reply all");
	});
});

describe("scoreFields", () => {
	it("matches on keywords, below an equally good title match", () => {
		const byKeyword = scoreFields("delete", { title: "Move to Trash", keywords: ["delete"] });
		const byTitle = scoreFields("delete", { title: "Delete", keywords: [] });
		expect(byKeyword).not.toBeNull();
		expect(byTitle!).toBeGreaterThan(byKeyword!);
	});

	it("matches on the subtitle", () => {
		expect(scoreFields("ada@", { title: "Ada Lovelace", subtitle: "ada@example.com" })).not.toBeNull();
	});
});
