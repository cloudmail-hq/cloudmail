/**
 * Regression cover for HTML entities surviving into text a reader sees.
 *
 * The reported symptom was a quoted reply rendering `I&#39;m doing well`
 * literally in the reading pane. The cause is a round trip: the worker's
 * `escapeHtml` emits `&#39;` for an apostrophe, the HTML→text converters do not
 * decode that form, and the result is escaped a second time into `&amp;#39;` —
 * which renders as the visible entity.
 */

import { describe, expect, it } from "vitest";

import { decodeHtmlEntities } from "../shared/html-text";
import { htmlToPlainText } from "../app/lib/utils";
import {
	buildQuotedReplyBlock,
	escapeHtml,
	stripHtmlToText,
} from "../workers/lib/email-helpers";

describe("decodeHtmlEntities", () => {
	it("decodes the five OWASP escapes both converters can emit", () => {
		expect(decodeHtmlEntities("&amp;")).toBe("&");
		expect(decodeHtmlEntities("&lt;")).toBe("<");
		expect(decodeHtmlEntities("&gt;")).toBe(">");
		expect(decodeHtmlEntities("&quot;")).toBe('"');
	});

	it("decodes BOTH apostrophe numeric forms the codebase produces", () => {
		// workers/lib/email-helpers.ts emits &#39;, app/lib/utils.ts emits &#039;.
		// A decoder that knows only one leaves the other visible to the reader.
		expect(decodeHtmlEntities("I&#39;m")).toBe("I'm");
		expect(decodeHtmlEntities("I&#039;m")).toBe("I'm");
		expect(decodeHtmlEntities("&apos;")).toBe("'");
	});

	it("decodes the typographic entities prose actually contains", () => {
		expect(decodeHtmlEntities("a&nbsp;b")).toBe("a\u00a0b");
		expect(decodeHtmlEntities("&mdash;")).toBe("\u2014");
		expect(decodeHtmlEntities("&ndash;")).toBe("\u2013");
		expect(decodeHtmlEntities("&rarr;")).toBe("\u2192");
		expect(decodeHtmlEntities("&hellip;")).toBe("\u2026");
		expect(decodeHtmlEntities("&rsquo;")).toBe("\u2019");
	});

	it("decodes arbitrary numeric and hex references", () => {
		expect(decodeHtmlEntities("&#8212;")).toBe("\u2014");
		expect(decodeHtmlEntities("&#x2014;")).toBe("\u2014");
		expect(decodeHtmlEntities("&#X2192;")).toBe("\u2192");
	});

	it("decodes &amp; LAST so an escaped entity is not resurrected", () => {
		// The literal text `&lt;` — what a sender writing about markup types —
		// arrives as `&amp;lt;`. Decoding `&amp;` first would turn it into `&lt;`
		// and the second pass would eat it, silently deleting the reader's text.
		expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
		expect(decodeHtmlEntities("&amp;#39;")).toBe("&#39;");
		expect(decodeHtmlEntities("&amp;amp;")).toBe("&amp;");
	});

	it("leaves a bare ampersand and unknown entities alone", () => {
		expect(decodeHtmlEntities("Tom & Jerry")).toBe("Tom & Jerry");
		expect(decodeHtmlEntities("&notarealentity;")).toBe("&notarealentity;");
	});

	it("rejects a surrogate or out-of-range code point rather than corrupting", () => {
		expect(decodeHtmlEntities("&#xD800;")).toBe("&#xD800;");
		expect(decodeHtmlEntities("&#x110000;")).toBe("&#x110000;");
	});

	it("is a no-op on text with no entities", () => {
		expect(decodeHtmlEntities("plain text")).toBe("plain text");
		expect(decodeHtmlEntities("")).toBe("");
	});
});

describe("htmlToPlainText decodes what the worker escaped", () => {
	it("decodes &#39; — the form workers/lib/email-helpers.ts emits", () => {
		expect(htmlToPlainText("<p>I&#39;m doing well</p>")).toBe("I'm doing well");
	});

	it("still decodes the &#039; form it already handled", () => {
		expect(htmlToPlainText("<p>I&#039;m fine</p>")).toBe("I'm fine");
	});

	it("decodes em dashes and arrows instead of leaking markup", () => {
		expect(htmlToPlainText("<p>a&mdash;b&rarr;c</p>")).toBe("a\u2014b\u2192c");
	});
});

describe("stripHtmlToText decodes entities", () => {
	it("does not leak &#39; into the plaintext alternative", () => {
		expect(stripHtmlToText("<p>I&#39;m here</p>")).toBe("I'm here");
	});

	it("does not leak &amp; as markup", () => {
		expect(stripHtmlToText("<p>Tom &amp; Jerry</p>")).toBe("Tom & Jerry");
	});
});

describe("buildQuotedReplyBlock does not double-escape", () => {
	const original = {
		date: "2026-08-21T10:43:00.000Z",
		sender: "alex@example.net",
		// Exactly what the reading pane held in the reported screenshot: a body
		// that had already been escaped once on its way in.
		body: "<p>Hi Support Team, I&#39;m doing well, thank you!</p>",
	};

	it("renders the apostrophe as a character, not as a visible entity", () => {
		const quoted = buildQuotedReplyBlock(original);
		expect(quoted).toContain("I&#39;m doing well");
		// The bug: a second escape pass turns `&#39;` into `&amp;#39;`, which the
		// browser then paints as the literal text `&#39;`.
		expect(quoted).not.toContain("&amp;#39;");
	});

	it("keeps escaping genuinely dangerous markup in the quoted body", () => {
		const quoted = buildQuotedReplyBlock({
			...original,
			body: "<p>hi</p><script>alert(1)</script>",
		});
		expect(quoted).not.toContain("<script>");
	});

	it("escapes a sender who is trying to inject markup", () => {
		const quoted = buildQuotedReplyBlock({
			...original,
			sender: '<img src=x onerror="alert(1)">',
		});
		expect(quoted).not.toContain("<img");
		expect(quoted).toContain("&lt;img");
	});
});

describe("escapeHtml stays lossless through a decode round trip", () => {
	it("round-trips every character it escapes", () => {
		const raw = `Tom & Jerry's "quote" <tag> — → …`;
		expect(decodeHtmlEntities(escapeHtml(raw))).toBe(raw);
	});
});
