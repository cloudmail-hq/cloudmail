// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for the search query parser.
 *
 * The parser replaced a regex that swept operators into a flat bag of filters,
 * and the bugs that motivated the rewrite are all shape bugs rather than
 * tokenizing bugs: negation and OR had nowhere to live, a repeated operator
 * overwrote its earlier self, and free text was recovered by deleting matched
 * substrings — so `subject:report report` deleted the wrong `report`. These
 * tests assert on the AST for that reason.
 *
 * The other half is degradation. A search box is not a compiler prompt: an
 * unterminated quote or `larger:banana` has to keep searching for what was
 * typed, so every malformed input here asserts a usable tree rather than a
 * throw.
 */

import { describe, expect, it } from "vitest";
import {
	includesEverywhere,
	hasFolderScope,
	parseAgeBoundary,
	parseSearchQuery,
	parseSizeBytes,
	type SearchNode,
} from "../shared/search-query";

/** Fixed clock so relative-date assertions are exact rather than approximate. */
const NOW = new Date("2026-03-15T12:00:00.000Z");

function parse(input: string): SearchNode | null {
	return parseSearchQuery(input, { now: NOW });
}

/** A free-text term, the most common leaf. */
function term(value: string, phrase = false): SearchNode {
	return { type: "term", value, phrase };
}

describe("free text", () => {
	it("returns a single term for a single word", () => {
		expect(parse("invoice")).toEqual(term("invoice"));
	});

	it("joins bare words with an implicit AND", () => {
		expect(parse("invoice march")).toEqual({
			type: "and",
			children: [term("invoice"), term("march")],
		});
	});

	it("keeps a quoted phrase as one term", () => {
		expect(parse('"quarterly report"')).toEqual(term("quarterly report", true));
	});

	it("keeps a phrase distinct from the same words unquoted", () => {
		expect(parse('"a b"')).not.toEqual(parse("a b"));
	});

	it("treats a hyphen inside a word as text, not negation", () => {
		// `well-known` is one word. Splitting on the inner hyphen turned it into
		// `well AND NOT known`, which excluded the very messages being sought.
		expect(parse("well-known")).toEqual(term("well-known"));
	});

	it("returns null when there is nothing to search for", () => {
		expect(parse("")).toBeNull();
		expect(parse("   ")).toBeNull();
		expect(parseSearchQuery(null)).toBeNull();
		expect(parseSearchQuery(undefined)).toBeNull();
	});
});

describe("operators", () => {
	it("parses the address and text operators", () => {
		expect(parse("from:alice@example.com")).toEqual({
			type: "operator",
			field: "from",
			value: "alice@example.com",
		});
		expect(parse("to:bob@example.com")).toEqual({
			type: "operator",
			field: "to",
			value: "bob@example.com",
		});
		expect(parse("cc:carol@example.com")).toEqual({
			type: "operator",
			field: "cc",
			value: "carol@example.com",
		});
		expect(parse("bcc:dan@example.com")).toEqual({
			type: "operator",
			field: "bcc",
			value: "dan@example.com",
		});
		expect(parse("subject:hello")).toEqual({
			type: "operator",
			field: "subject",
			value: "hello",
		});
		expect(parse("label:receipts")).toEqual({
			type: "operator",
			field: "label",
			value: "receipts",
		});
		expect(parse("filename:report.pdf")).toEqual({
			type: "operator",
			field: "filename",
			value: "report.pdf",
		});
	});

	it("accepts a quoted operator value containing spaces", () => {
		expect(parse('from:"John Doe"')).toEqual({
			type: "operator",
			field: "from",
			value: "John Doe",
		});
		expect(parse('subject:"Re: Hello"')).toEqual({
			type: "operator",
			field: "subject",
			value: "Re: Hello",
		});
	});

	it("lowercases folder names so `in:Inbox` and `in:inbox` agree", () => {
		expect(parse("in:Inbox")).toEqual({
			type: "operator",
			field: "folder",
			value: "inbox",
		});
	});

	it("parses every is: flag", () => {
		const flags = [
			"read",
			"unread",
			"starred",
			"unstarred",
			"muted",
			"important",
			"snoozed",
		];
		for (const flag of flags) {
			expect(parse(`is:${flag}`)).toEqual({
				type: "operator",
				field: "flag",
				value: flag,
			});
		}
	});

	it("parses has:attachment as a flag", () => {
		expect(parse("has:attachment")).toEqual({
			type: "operator",
			field: "flag",
			value: "attachment",
		});
	});

	it("keeps repeated operators instead of letting one overwrite the other", () => {
		// The flat-bag parser stored one `from`, so this searched for whichever
		// came last and silently ignored the other.
		expect(parse("from:a from:b")).toEqual({
			type: "and",
			children: [
				{ type: "operator", field: "from", value: "a" },
				{ type: "operator", field: "from", value: "b" },
			],
		});
	});

	it("leaves free text intact rather than deleting matching substrings", () => {
		// `String.replace` removed the first occurrence of `report`, which was
		// the one inside `subject:report`, leaving the bare word deleted instead.
		expect(parse("subject:report report")).toEqual({
			type: "and",
			children: [
				{ type: "operator", field: "subject", value: "report" },
				term("report"),
			],
		});
	});

	it("treats an unknown operator as free text", () => {
		expect(parse("banana:split")).toEqual(term("banana:split"));
	});
});

describe("dates", () => {
	it("pins before:/after: to UTC midnight", () => {
		expect(parse("after:2026-01-01")).toEqual({
			type: "operator",
			field: "date",
			cmp: ">=",
			value: "2026-01-01T00:00:00.000Z",
		});
		expect(parse("before:2026-01-01")).toEqual({
			type: "operator",
			field: "date",
			cmp: "<=",
			value: "2026-01-01T00:00:00.000Z",
		});
	});

	it("reads slashes and dashes identically", () => {
		// `new Date("2026/01/01")` is local time while `new Date("2026-01-01")` is
		// UTC, so the two spellings used to disagree by up to a day.
		expect(parse("after:2026/01/01")).toEqual(parse("after:2026-01-01"));
	});

	it("resolves older_than:/newer_than: against the supplied clock", () => {
		expect(parse("older_than:7d")).toEqual({
			type: "operator",
			field: "date",
			cmp: "<=",
			value: "2026-03-08T12:00:00.000Z",
		});
		expect(parse("newer_than:2d")).toEqual({
			type: "operator",
			field: "date",
			cmp: ">=",
			value: "2026-03-13T12:00:00.000Z",
		});
	});

	it("reads `m` as months and `y` as years, matching Gmail", () => {
		expect(parse("older_than:1m")).toEqual({
			type: "operator",
			field: "date",
			cmp: "<=",
			value: "2026-02-15T12:00:00.000Z",
		});
		expect(parse("older_than:1y")).toEqual({
			type: "operator",
			field: "date",
			cmp: "<=",
			value: "2025-03-15T12:00:00.000Z",
		});
	});

	it("shifts the calendar field rather than multiplying days", () => {
		// A 30-day approximation of a month drifts; February proves it.
		expect(parseAgeBoundary("1m", new Date("2026-03-31T00:00:00.000Z"))).toBe(
			new Date(Date.UTC(2026, 1, 28)).toISOString(),
		);
	});

	it("degrades an unparseable date to free text", () => {
		expect(parse("before:someday")).toEqual(term("before:someday"));
		expect(parse("older_than:soon")).toEqual(term("older_than:soon"));
	});
});

describe("sizes", () => {
	it("expands k and m suffixes to bytes", () => {
		expect(parseSizeBytes("500")).toBe(500);
		expect(parseSizeBytes("10k")).toBe(10 * 1024);
		expect(parseSizeBytes("5m")).toBe(5 * 1024 * 1024);
	});

	it("accepts the trailing `b` people write out of habit", () => {
		expect(parseSizeBytes("10kb")).toBe(10 * 1024);
		expect(parseSizeBytes("5mb")).toBe(5 * 1024 * 1024);
		expect(parseSizeBytes("500b")).toBe(500);
	});

	it("parses larger:/smaller: into a byte bound", () => {
		expect(parse("larger:5m")).toEqual({
			type: "operator",
			field: "size",
			cmp: ">=",
			bytes: 5 * 1024 * 1024,
		});
		expect(parse("smaller:10k")).toEqual({
			type: "operator",
			field: "size",
			cmp: "<=",
			bytes: 10 * 1024,
		});
	});

	it("degrades an unparseable size to free text", () => {
		expect(parseSizeBytes("banana")).toBeNull();
		expect(parse("larger:banana")).toEqual(term("larger:banana"));
	});
});

describe("negation", () => {
	it("negates an operator", () => {
		expect(parse("-from:spam@example.com")).toEqual({
			type: "not",
			child: { type: "operator", field: "from", value: "spam@example.com" },
		});
	});

	it("negates a free-text term", () => {
		expect(parse("-urgent")).toEqual({ type: "not", child: term("urgent") });
	});

	it("negates a flag", () => {
		expect(parse("-is:read")).toEqual({
			type: "not",
			child: { type: "operator", field: "flag", value: "read" },
		});
	});

	it("negates a group", () => {
		expect(parse("-(a b)")).toEqual({
			type: "not",
			child: { type: "and", children: [term("a"), term("b")] },
		});
	});

	it("combines a positive and a negative term", () => {
		expect(parse("invoice -draft")).toEqual({
			type: "and",
			children: [term("invoice"), { type: "not", child: term("draft") }],
		});
	});

	it("ignores a dangling `-`", () => {
		// It negates nothing, so it must not become a node that matches
		// everything.
		expect(parse("invoice -")).toEqual(term("invoice"));
	});
});

describe("OR and grouping", () => {
	it("parses uppercase OR as alternation", () => {
		expect(parse("from:a OR from:b")).toEqual({
			type: "or",
			children: [
				{ type: "operator", field: "from", value: "a" },
				{ type: "operator", field: "from", value: "b" },
			],
		});
	});

	it("treats lowercase `or` as a word", () => {
		// "cats or dogs" means both words to the person typing it, and Gmail
		// agrees.
		expect(parse("cats or dogs")).toEqual({
			type: "and",
			children: [term("cats"), term("or"), term("dogs")],
		});
	});

	it("binds OR looser than implicit AND", () => {
		expect(parse("a b OR c")).toEqual({
			type: "or",
			children: [{ type: "and", children: [term("a"), term("b")] }, term("c")],
		});
	});

	it("chains several OR branches into one node", () => {
		expect(parse("a OR b OR c")).toEqual({
			type: "or",
			children: [term("a"), term("b"), term("c")],
		});
	});

	it("groups with parentheses", () => {
		expect(parse("(a OR b) c")).toEqual({
			type: "and",
			children: [
				{ type: "or", children: [term("a"), term("b")] },
				term("c"),
			],
		});
	});

	it("reads braces as Gmail's OR sugar", () => {
		expect(parse("{a b c}")).toEqual({
			type: "or",
			children: [term("a"), term("b"), term("c")],
		});
		expect(parse("{from:a from:b}")).toEqual({
			type: "or",
			children: [
				{ type: "operator", field: "from", value: "a" },
				{ type: "operator", field: "from", value: "b" },
			],
		});
	});

	it("nests groups", () => {
		expect(parse("(a OR (b c)) -d")).toEqual({
			type: "and",
			children: [
				{
					type: "or",
					children: [term("a"), { type: "and", children: [term("b"), term("c")] }],
				},
				{ type: "not", child: term("d") },
			],
		});
	});

	it("needs no whitespace around parentheses", () => {
		expect(parse("(a)(b)")).toEqual({
			type: "and",
			children: [term("a"), term("b")],
		});
	});
});

describe("malformed input degrades to free text", () => {
	/** Every one of these must produce a usable tree rather than throw. */
	const inputs = [
		'subject:"unterminated',
		'"',
		"(",
		")",
		"a )",
		"( a",
		"{",
		"}",
		"-",
		"--",
		"()",
		"( )",
		"OR",
		"OR OR",
		"a OR",
		"OR a",
		"from:",
		"is:",
		"is:nonsense",
		"has:nonsense",
		":::",
		"^*(",
		")))(((",
		"{-}",
		"a ( b OR ) c",
	];

	for (const input of inputs) {
		it(`survives ${JSON.stringify(input)}`, () => {
			expect(() => parseSearchQuery(input, { now: NOW })).not.toThrow();
		});
	}

	it("searches for the text of an unterminated quote", () => {
		expect(parse('subject:"unterminated')).toEqual({
			type: "operator",
			field: "subject",
			value: "unterminated",
		});
	});

	it("keeps the leading part of a query with a stray closer", () => {
		expect(parse("invoice )")).toEqual(term("invoice"));
	});

	it("falls back to free text when the query is only structure", () => {
		// `()` parses to nothing. Searching for the literal characters is more
		// useful than matching every message in the mailbox.
		expect(parse("()")).toEqual(term("()"));
		expect(parse(":::")).toEqual(term(":::"));
	});

	it("drops a valueless operator rather than filtering on empty", () => {
		// `from:` with no value would otherwise become `sender LIKE '%%'`, which
		// matches everything and reads as the operator being ignored.
		expect(parse("from:")).toEqual(term("from:"));
	});

	it("treats an unrecognised flag as free text", () => {
		expect(parse("is:nonsense")).toEqual(term("is:nonsense"));
		expect(parse("has:nonsense")).toEqual(term("has:nonsense"));
	});

	it("survives deep nesting without exhausting the stack", () => {
		const deep = `${"(".repeat(200)}a${")".repeat(200)}`;
		expect(() => parseSearchQuery(deep, { now: NOW })).not.toThrow();
		expect(parseSearchQuery(deep, { now: NOW })).not.toBeNull();
	});

	it("survives a pathological paste", () => {
		const many = Array.from({ length: 500 }, (_, i) => `w${i}`).join(" ");
		expect(() => parseSearchQuery(many, { now: NOW })).not.toThrow();
	});
});

describe("compound queries", () => {
	it("parses a realistic mixed query", () => {
		expect(parse('label:receipts -is:read larger:5m "tax year"')).toEqual({
			type: "and",
			children: [
				{ type: "operator", field: "label", value: "receipts" },
				{ type: "not", child: { type: "operator", field: "flag", value: "read" } },
				{ type: "operator", field: "size", cmp: ">=", bytes: 5 * 1024 * 1024 },
				term("tax year", true),
			],
		});
	});

	it("mixes alternation with a structured filter", () => {
		expect(parse("(from:a OR from:b) is:unread")).toEqual({
			type: "and",
			children: [
				{
					type: "or",
					children: [
						{ type: "operator", field: "from", value: "a" },
						{ type: "operator", field: "from", value: "b" },
					],
				},
				{ type: "operator", field: "flag", value: "unread" },
			],
		});
	});
});

describe("folder scope helpers", () => {
	it("detects in:anywhere anywhere in the tree", () => {
		expect(includesEverywhere(parse("in:anywhere invoice"))).toBe(true);
		expect(includesEverywhere(parse("(a OR in:anywhere)"))).toBe(true);
		expect(includesEverywhere(parse("in:inbox"))).toBe(false);
		expect(includesEverywhere(null)).toBe(false);
	});

	it("does not count in:anywhere as a folder scope", () => {
		// It is the absence of the default Trash/Spam exclusion, not a folder to
		// filter on, so treating it as a scope would match no rows at all.
		expect(hasFolderScope(parse("in:anywhere"))).toBe(false);
		expect(hasFolderScope(parse("in:trash"))).toBe(true);
		expect(hasFolderScope(parse("invoice"))).toBe(false);
	});
});
