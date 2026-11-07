/**
 * Composer snippets: the `;` trigger, variable filling and placeholder Tab.
 */

import { describe, expect, it } from "vitest";
import {
	fillTemplate,
	findPlaceholders,
	firstRecipient,
	matchSnippetTrigger,
	nextPlaceholder,
	rankSnippets,
	recipientVariables,
} from "../app/lib/snippets";

describe("matchSnippetTrigger", () => {
	it("opens on ; at the start of a block", () => {
		expect(matchSnippetTrigger(";")).toEqual({ query: "", from: 0 });
		expect(matchSnippetTrigger(";tha")).toEqual({ query: "tha", from: 0 });
	});

	it("opens on ; after whitespace or an opening bracket", () => {
		expect(matchSnippetTrigger("Hi there ;intro")).toEqual({ query: "intro", from: 9 });
		expect(matchSnippetTrigger("see (;sig")).toEqual({ query: "sig", from: 5 });
	});

	it("accepts dashes and underscores, like template slugs", () => {
		expect(matchSnippetTrigger(";follow-up_2")?.query).toBe("follow-up_2");
	});

	it("does not open mid-word or after punctuation", () => {
		// Ordinary semicolons, entities and URL parameters.
		expect(matchSnippetTrigger("one;two")).toBeNull();
		expect(matchSnippetTrigger("&amp;")).toBeNull();
		expect(matchSnippetTrigger("/path;jsessionid")).toBeNull();
		expect(matchSnippetTrigger("done.;x")).toBeNull();
	});

	it("closes once a space is typed after the query", () => {
		expect(matchSnippetTrigger(";thanks ")).toBeNull();
		expect(matchSnippetTrigger("; ")).toBeNull();
	});

	it("only looks at the text right before the caret", () => {
		expect(matchSnippetTrigger(";intro and then more")).toBeNull();
		expect(matchSnippetTrigger("a ;b ;c")).toEqual({ query: "c", from: 5 });
	});

	it("caps the query length", () => {
		expect(matchSnippetTrigger(`;${"a".repeat(40)}`)).not.toBeNull();
		expect(matchSnippetTrigger(`;${"a".repeat(41)}`)).toBeNull();
	});
});

describe("firstRecipient", () => {
	it("takes the first valid address in To", () => {
		expect(firstRecipient("not-an-address, ada@example.com, bob@example.com")).toEqual({
			email: "ada@example.com",
			name: null,
		});
	});

	it("reads a display name from a Name <address> token", () => {
		expect(firstRecipient("Ada Lovelace <ada@example.com>")).toEqual({
			email: "ada@example.com",
			name: "Ada Lovelace",
		});
		expect(firstRecipient('"Ada Lovelace" <ada@example.com>')?.name).toBe("Ada Lovelace");
	});

	it("falls back to a known sender name for a bare address", () => {
		expect(
			firstRecipient("Ada@Example.com", { "ada@example.com": "Ada Lovelace" }),
		).toEqual({ email: "Ada@Example.com", name: "Ada Lovelace" });
	});

	it("returns null with no usable recipient", () => {
		expect(firstRecipient("")).toBeNull();
		expect(firstRecipient("nobody")).toBeNull();
	});
});

describe("recipientVariables", () => {
	it("fills name, first_name and email from a known name", () => {
		expect(recipientVariables({ email: "ada@example.com", name: "Ada King Lovelace" })).toEqual({
			email: "ada@example.com",
			name: "Ada King Lovelace",
			full_name: "Ada King Lovelace",
			first_name: "Ada",
			last_name: "Lovelace",
		});
	});

	it("fills only email when no name is known, rather than guessing", () => {
		expect(recipientVariables({ email: "j.smith@example.com", name: null })).toEqual({
			email: "j.smith@example.com",
		});
	});

	it("ignores a 'name' that is really an address", () => {
		expect(recipientVariables({ email: "a@b.co", name: "a@b.co" })).toEqual({ email: "a@b.co" });
	});

	it("is empty with no recipient", () => {
		expect(recipientVariables(null)).toEqual({});
	});
});

describe("fillTemplate", () => {
	it("substitutes known variables and leaves unknown ones as placeholders", () => {
		const { html, unfilled } = fillTemplate(
			"<p>Hi {{first_name}}, your plan is {{plan}}. Reply to {{ email }}.</p>",
			{ first_name: "Ada", email: "ada@example.com" },
		);
		expect(html).toBe("<p>Hi Ada, your plan is {{plan}}. Reply to ada@example.com.</p>");
		expect(unfilled).toEqual(["plan"]);
	});

	it("treats an empty value as unknown", () => {
		expect(fillTemplate("{{name}}", { name: "" })).toEqual({
			html: "{{name}}",
			unfilled: ["name"],
		});
	});

	it("escapes substituted values, which come from mail headers", () => {
		const { html } = fillTemplate("<p>Hi {{name}}</p>", { name: '<img src=x onerror="alert(1)">' });
		expect(html).toBe("<p>Hi &lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>");
	});

	it("lists each unfilled name once", () => {
		expect(fillTemplate("{{a}} {{a}} {{b}}", {}).unfilled).toEqual(["a", "b"]);
	});

	it("leaves text without variables untouched", () => {
		expect(fillTemplate("<p>Plain</p>", { name: "x" })).toEqual({ html: "<p>Plain</p>", unfilled: [] });
	});
});

describe("findPlaceholders / nextPlaceholder", () => {
	const text = "Hi {{first_name}}, about {{plan}} and {{date}}.";
	const ranges = findPlaceholders(text);

	it("finds every {{name}} with its offsets", () => {
		expect(ranges.map((r) => r.name)).toEqual(["first_name", "plan", "date"]);
		expect(text.slice(ranges[1].from, ranges[1].to)).toBe("{{plan}}");
	});

	it("Tab selects the next placeholder after the caret", () => {
		expect(nextPlaceholder(ranges, { from: 0, to: 0 })).toEqual(ranges[0]);
		expect(nextPlaceholder(ranges, { from: ranges[0].to, to: ranges[0].to })).toEqual(ranges[1]);
	});

	it("Tab moves on from a selected placeholder", () => {
		expect(nextPlaceholder(ranges, ranges[0])).toEqual(ranges[1]);
		expect(nextPlaceholder(ranges, ranges[1])).toEqual(ranges[2]);
	});

	it("returns null past the last one, so Tab can leave the editor", () => {
		expect(nextPlaceholder(ranges, ranges[2])).toBeNull();
		expect(nextPlaceholder([], { from: 0, to: 0 })).toBeNull();
	});

	it("Shift+Tab goes back", () => {
		expect(nextPlaceholder(ranges, ranges[2], -1)).toEqual(ranges[1]);
		expect(nextPlaceholder(ranges, ranges[0], -1)).toBeNull();
		expect(nextPlaceholder(ranges, { from: text.length, to: text.length }, -1)).toEqual(ranges[2]);
	});
});

describe("rankSnippets", () => {
	const templates = [
		{ slug: "intro", name: "Intro call", subject: "Quick chat?", bodyHtml: "" },
		{ slug: "thanks", name: "Thanks for signing up", subject: "Welcome", bodyHtml: "" },
		{ slug: "refund", name: "Refund issued", subject: "Your refund", bodyHtml: "" },
	];

	it("keeps the given order for an empty query", () => {
		expect(rankSnippets(templates, "").map((t) => t.slug)).toEqual(["intro", "thanks", "refund"]);
	});

	it("matches on name, slug and subject", () => {
		expect(rankSnippets(templates, "ref")[0].slug).toBe("refund");
		expect(rankSnippets(templates, "welcome")[0].slug).toBe("thanks");
		expect(rankSnippets(templates, "thanks")[0].slug).toBe("thanks");
	});

	it("limits the list", () => {
		expect(rankSnippets(templates, "", 2)).toHaveLength(2);
	});
});
