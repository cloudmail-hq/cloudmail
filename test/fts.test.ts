// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for the FTS5 MATCH translation.
 *
 * The expression is assembled from user input, so the failures worth defending
 * against are a syntax error reaching FTS5 (the search returns an error rather
 * than results) and an operator surviving quoting (an injection surface). Both
 * are asserted on the emitted string, since that string is what SQLite parses.
 *
 * The other property under test is what *cannot* be expressed. Returning null
 * means "the index cannot answer this subtree, use a SQL predicate instead", and
 * confusing that with "matches nothing" is how a search silently loses rows.
 */

import { describe, expect, it } from "vitest";
import {
	SNIPPET_MARK_CLOSE,
	SNIPPET_MARK_OPEN,
	splitSnippetHighlights,
	toFtsMatchExpression,
} from "../shared/fts";
import { parseSearchQuery } from "../shared/search-query";

/** Translate what someone typed, exercising parser and translator together. */
function match(input: string): string | null {
	return toFtsMatchExpression(parseSearchQuery(input));
}

describe("toFtsMatchExpression", () => {
	it("quotes each word and matches it as a prefix", () => {
		expect(match("invoice march")).toBe('"invoice"* AND "march"*');
	});

	it("keeps a quoted phrase intact", () => {
		expect(match('"quarterly report" draft')).toBe(
			'"quarterly report" AND "draft"*',
		);
	});

	it("neutralises FTS5 operators that arrive as bare words", () => {
		// Unquoted, `NOT` and `AND` are syntax; quoted, they are just words. The
		// parser only reads uppercase `OR` as structure, so `NOT` stays a term.
		expect(match("NOT urgent")).toBe('"NOT"* AND "urgent"*');
		expect(match("a AND b")).toBe('"a"* AND "AND"* AND "b"*');
	});

	it("escapes embedded quotes rather than producing invalid syntax", () => {
		// An unterminated quote is read as a phrase, so this is `say` AND the
		// phrase `hi`. Either way the quote never reaches FTS5 unescaped.
		expect(match('say "hi')).toBe('"say"* AND "hi"');
		// A quote inside a word survives to the translator, which doubles it —
		// the escape FTS5's string literals use. Left bare it is a syntax error,
		// which fails the whole search rather than returning nothing.
		expect(match('it"s')).toBe('"it""s"*');
	});

	it("returns null when there is nothing to search for", () => {
		expect(toFtsMatchExpression(null)).toBeNull();
		expect(toFtsMatchExpression(undefined)).toBeNull();
		expect(match("")).toBeNull();
		expect(match("   ")).toBeNull();
		// Punctuation alone cannot be tokenised, so the caller falls back to a
		// scan instead of getting an empty result set.
		expect(match("--")).toBeNull();
		expect(match("^*(")).toBeNull();
	});

	it("supports non-Latin scripts", () => {
		expect(match("发票")).toBe('"发票"*');
		expect(match("счёт march")).toBe('"счёт"* AND "march"*');
	});

	it("drops stray punctuation tokens but keeps the real ones", () => {
		expect(match("invoice - march")).toBe('"invoice"* AND "march"*');
	});

	it("bounds the number of clauses", () => {
		const many = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
		expect(match(many)!.split(" AND ")).toHaveLength(12);
	});

	it("bounds the query length", () => {
		const long = "x".repeat(700);
		// The parser truncates at its own limit before the translator sees it.
		expect(match(long)).toBe(`"${"x".repeat(512)}"*`);
	});

	describe("OR", () => {
		it("emits FTS5 OR for an alternation", () => {
			expect(match("invoice OR receipt")).toBe('"invoice"* OR "receipt"*');
		});

		it("chains several branches", () => {
			expect(match("a OR b OR c")).toBe('"a"* OR "b"* OR "c"*');
		});

		it("parenthesises an alternation nested under AND", () => {
			// Without the parentheses FTS5's precedence would read this as
			// `a AND (b OR c)` only by accident; making it explicit means the
			// expression says what the query meant.
			expect(match("(a OR b) c")).toBe('("a"* OR "b"*) AND "c"*');
		});

		it("reads Gmail's brace sugar as OR", () => {
			expect(match("{a b}")).toBe('"a"* OR "b"*');
		});

		it("refuses an alternation with an inexpressible branch", () => {
			// Dropping the branch would return a strict subset of what was asked
			// for. OR is the one operator where a missing branch loses results
			// rather than adding them, so the whole subtree goes to SQL.
			expect(match("invoice OR from:a")).toBeNull();
			// A branch of pure punctuation has no tokens FTS5 can index, so the
			// alternation cannot be answered by the index either. Quoted, since
			// bare `--` is discarded by the parser before it becomes a branch.
			expect(match('invoice OR "^*("')).toBeNull();
		});

		it("refuses an alternation containing a negation", () => {
			// FTS5 has no unary NOT, so `a OR NOT b` cannot be expressed at all.
			expect(match("a OR -b")).toBeNull();
		});
	});

	describe("NOT", () => {
		it("subtracts a negated term from a positive one", () => {
			expect(match("invoice -draft")).toBe('"invoice"* NOT "draft"*');
		});

		it("groups several negatives into one NOT", () => {
			// `a NOT (b OR c)` is `a AND NOT b AND NOT c`, written so the
			// negatives stay grouped regardless of how FTS5 resolves precedence
			// between AND and NOT.
			expect(match("invoice -draft -copy")).toBe(
				'"invoice"* NOT ("draft"* OR "copy"*)',
			);
		});

		it("groups several positives before subtracting", () => {
			expect(match("invoice march -draft")).toBe(
				'("invoice"* AND "march"*) NOT "draft"*',
			);
		});

		it("negates a phrase", () => {
			expect(match('invoice -"final draft"')).toBe(
				'"invoice"* NOT "final draft"',
			);
		});

		it("collapses double negation", () => {
			// FTS5 cannot express `NOT NOT x`, and it means `x`.
			expect(match("--invoice")).toBe('"invoice"*');
		});

		it("refuses a bare negation with nothing to subtract from", () => {
			// There is no positive set to remove from, so SQL has to express it.
			expect(match("-invoice")).toBeNull();
			expect(match("-a -b")).toBeNull();
		});

		it("subtracts a negated group", () => {
			expect(match("invoice -(draft copy)")).toBe(
				'"invoice"* NOT ("draft"* AND "copy"*)',
			);
		});
	});

	it("ignores structured operators, which are SQL's job", () => {
		expect(match("from:alice")).toBeNull();
		expect(match("is:unread")).toBeNull();
		expect(match("larger:5m")).toBeNull();
		// Mixed, the operator contributes nothing and the text still matches.
		expect(toFtsMatchExpression({
			type: "and",
			children: [
				{ type: "term", value: "invoice", phrase: false },
				{ type: "operator", field: "from", value: "alice" },
			],
		})).toBe('"invoice"*');
	});
});

describe("splitSnippetHighlights", () => {
	const open = SNIPPET_MARK_OPEN;
	const close = SNIPPET_MARK_CLOSE;

	it("splits marked runs from plain ones", () => {
		expect(splitSnippetHighlights(`the ${open}invoice${close} is due`)).toEqual([
			{ text: "the ", match: false },
			{ text: "invoice", match: true },
			{ text: " is due", match: false },
		]);
	});

	it("handles several highlights", () => {
		expect(
			splitSnippetHighlights(`${open}a${close} and ${open}b${close}`),
		).toEqual([
			{ text: "a", match: true },
			{ text: " and ", match: false },
			{ text: "b", match: true },
		]);
	});

	it("returns plain text unchanged", () => {
		expect(splitSnippetHighlights("nothing marked")).toEqual([
			{ text: "nothing marked", match: false },
		]);
	});

	it("returns nothing for an absent snippet", () => {
		expect(splitSnippetHighlights(null)).toEqual([]);
		expect(splitSnippetHighlights(undefined)).toEqual([]);
		expect(splitSnippetHighlights("")).toEqual([]);
	});

	it("keeps the remainder when a snippet is cut mid-highlight", () => {
		// `snippet()` truncates, so an unpaired marker is expected rather than
		// exceptional. Dropping the tail would hide text that matched.
		expect(splitSnippetHighlights(`the ${open}invoi`)).toEqual([
			{ text: "the invoi", match: false },
		]);
	});

	it("never leaves a marker in the output", () => {
		// The markers are control characters. Any that survive would render as
		// invisible junk inside the result row.
		for (const segment of splitSnippetHighlights(`${open}a${open}b${close}c`)) {
			expect(segment.text).not.toContain(open);
			expect(segment.text).not.toContain(close);
		}
	});

	it("passes HTML through as text rather than markup", () => {
		// The snippet comes from message bodies, so this is the injection case:
		// the characters must survive intact and be rendered as a text node.
		expect(
			splitSnippetHighlights(`${open}<script>alert(1)</script>${close}`),
		).toEqual([{ text: "<script>alert(1)</script>", match: true }]);
	});
});
