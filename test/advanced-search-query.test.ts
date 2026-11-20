// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The advanced search panel writes a query string, not a set of parameters.
 *
 * That is the thing worth testing: the panel is only correct if what it emits
 * parses back into the operators it was asked for. So every case here asserts the
 * text *and* runs it through `parseSearchQuery`, which is the same parser the
 * worker uses — a query that reads plausibly but degrades to free text is the
 * failure mode this guards, and it is invisible from the string alone.
 */

import { describe, expect, it } from "vitest";
import { buildAdvancedQuery } from "~/components/mail/MailSearchBar";
import {
	parseSearchQuery,
	walkSearchNodes,
	type SearchNode,
} from "shared/search-query";

const EMPTY = {
	from: "",
	to: "",
	subject: "",
	includes: "",
	excludes: "",
	folder: "",
	size: "",
	age: "",
	hasAttachment: false,
	unreadOnly: false,
	starredOnly: false,
};

const form = (overrides: Partial<typeof EMPTY>) => ({ ...EMPTY, ...overrides });

/** Every operator in the parsed tree, as `field:value` strings. */
function operators(node: SearchNode | null): string[] {
	if (!node) return [];
	const found: string[] = [];
	walkSearchNodes(node, (n) => {
		if (n.type !== "operator") return;
		if (n.field === "size") found.push(`size${n.cmp}${n.bytes}`);
		else if (n.field === "date") found.push(`date${n.cmp}`);
		else found.push(`${n.field}:${n.value}`);
	});
	return found;
}

/** Free-text leaves, with the ones under a `not` marked. */
function terms(node: SearchNode | null): string[] {
	if (!node) return [];
	const found: string[] = [];
	const walk = (n: SearchNode, negated: boolean) => {
		if (n.type === "term") found.push(negated ? `-${n.value}` : n.value);
		else if (n.type === "not") walk(n.child, true);
		else if (n.type === "and" || n.type === "or") {
			for (const child of n.children) walk(child, negated);
		}
	};
	walk(node, false);
	return found;
}

describe("buildAdvancedQuery", () => {
	it("is empty when nothing was filled in", () => {
		expect(buildAdvancedQuery(EMPTY)).toBe("");
	});

	it("emits one operator per filled field", () => {
		const query = buildAdvancedQuery(
			form({
				from: "alice@example.com",
				to: "bob@example.com",
				subject: "invoice",
				folder: "archive",
				hasAttachment: true,
				unreadOnly: true,
				starredOnly: true,
				age: "7d",
				size: "5m",
			}),
		);

		expect(operators(parseSearchQuery(query))).toEqual([
			"from:alice@example.com",
			"to:bob@example.com",
			"subject:invoice",
			"folder:archive",
			"flag:attachment",
			"flag:unread",
			"flag:starred",
			"date>=",
			"size>=5242880",
		]);
	});

	/**
	 * The regression this exists for: `from:John Doe` parses as `from:John` AND
	 * the bare word `Doe`, which is a broader search than the one requested and
	 * silently so.
	 */
	it("quotes a value containing whitespace", () => {
		const query = buildAdvancedQuery(form({ from: "John Doe" }));
		expect(query).toBe('from:"John Doe"');
		expect(operators(parseSearchQuery(query))).toEqual(["from:John Doe"]);
		expect(terms(parseSearchQuery(query))).toEqual([]);
	});

	it("drops embedded quotes rather than escaping them", () => {
		// The grammar has no escape sequence, so a surviving quote would swallow
		// the rest of the query.
		const query = buildAdvancedQuery(form({ subject: 'the "big" report' }));
		expect(query).toBe('subject:"the big report"');
		expect(operators(parseSearchQuery(query))).toEqual([
			"subject:the big report",
		]);
	});

	it("negates each excluded word on its own", () => {
		// `-"receipt invoice"` would exclude only the phrase, so a message
		// containing just `receipt` would still come back.
		const query = buildAdvancedQuery(form({ excludes: "receipt invoice" }));
		expect(query).toBe("-receipt -invoice");
		expect(terms(parseSearchQuery(query))).toEqual(["-receipt", "-invoice"]);
	});

	it("keeps free text as a phrase when it has spaces", () => {
		const query = buildAdvancedQuery(form({ includes: "quarterly report" }));
		expect(query).toBe('"quarterly report"');
		const parsed = parseSearchQuery(query);
		expect(parsed).toEqual({
			type: "term",
			value: "quarterly report",
			phrase: true,
		});
	});

	it("puts operators before free text", () => {
		expect(
			buildAdvancedQuery(
				form({ from: "alice", includes: "invoice", unreadOnly: true }),
			),
		).toBe("from:alice is:unread invoice");
	});

	it("passes the anywhere scope through as in:anywhere", () => {
		const query = buildAdvancedQuery(form({ folder: "anywhere" }));
		expect(query).toBe("in:anywhere");
		expect(operators(parseSearchQuery(query))).toEqual(["folder:anywhere"]);
	});

	it("ignores whitespace-only input", () => {
		expect(buildAdvancedQuery(form({ from: "   ", excludes: "  " }))).toBe("");
	});
});
