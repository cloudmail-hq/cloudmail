// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * `toPlainSnippet` — the list preview that replaced `SUBSTR(body, 1, 300)`.
 *
 * The regression this guards: the REST API and MCP `list_emails` returned
 * `"<p>Second QA test with Cc. Bold and links next.</p>"` as the snippet of a
 * message sent from production on 2026-10-25, because the projection sliced the
 * raw HTML body.
 */

import { describe, expect, it } from "vitest";
import {
	SNIPPET_MAX_CHARS,
	cleanFtsSnippet,
	toPlainSnippet,
} from "../shared/plain-snippet";
import { SNIPPET_MARK_CLOSE, SNIPPET_MARK_OPEN } from "../shared/fts";

describe("toPlainSnippet", () => {
	it("strips the tags the production sample carried", () => {
		expect(toPlainSnippet("<p>Second QA test with Cc. Bold and links next.</p>")).toBe(
			"Second QA test with Cc. Bold and links next.",
		);
	});

	it("keeps words apart across block boundaries", () => {
		expect(toPlainSnippet("<h2>This week</h2><p>Three things</p>")).toBe(
			"This week Three things",
		);
		expect(toPlainSnippet("Hi Deeksha,<br>Thanks")).toBe("Hi Deeksha, Thanks");
		expect(toPlainSnippet("<table><tr><td>Total</td><td>$4</td></tr></table>")).toBe(
			"Total $4",
		);
	});

	it("decodes entities after stripping, so escaped markup stays text", () => {
		expect(toPlainSnippet("<p>Tom &amp; Jerry &mdash; &#39;hi&#39; &lt;b&gt;</p>")).toBe(
			"Tom & Jerry — 'hi' <b>",
		);
	});

	it("drops head, style and script content", () => {
		const html = `<!DOCTYPE html><html><head><title>Newsletter</title>
			<style>.x{color:red} body{margin:0}</style></head>
			<body><script>track()</script><p>Real content</p></body></html>`;
		expect(toPlainSnippet(html)).toBe("Real content");
	});

	it("drops a stylesheet that was never closed", () => {
		expect(toPlainSnippet("<p>Hello</p><style>.a{color:red}")).toBe("Hello");
	});

	it("drops HTML comments, including Outlook conditionals", () => {
		expect(
			toPlainSnippet("<!--[if mso]><table><tr><td><![endif]--><p>Hi there</p>"),
		).toBe("Hi there");
	});

	it("drops a hidden preheader and the zero-width padding after it", () => {
		const html =
			'<div style="display:none;max-height:0">Preview text</div>' +
			"‌ ‌ ‌<p>Visible body</p>";
		expect(toPlainSnippet(html)).toBe("Visible body");
	});

	it("drops a Gmail quoted reply", () => {
		const html =
			'<div dir="ltr">Sounds good, ship it.</div><br>' +
			'<div class="gmail_quote"><div class="gmail_attr">On Sun, 25 Oct 2026 at 18:31, Tapetide &lt;tech@tapetide.com&gt; wrote:</div>' +
			"<blockquote>Second QA test</blockquote></div>";
		expect(toPlainSnippet(html)).toBe("Sounds good, ship it.");
	});

	it("drops a > quote chain from a plain-text reply", () => {
		const text = "Thanks, received.\n\nOn Sun, 25 Oct 2026, Bob <bob@x.com> wrote:\n> original";
		expect(toPlainSnippet(text)).toBe("Thanks, received.");
	});

	it("leaves plain text alone, entities included", () => {
		// A plain-text body is not HTML: `&amp;` is literally what the sender typed.
		expect(toPlainSnippet("R&D update &amp; notes\n\nline two")).toBe(
			"R&D update &amp; notes line two",
		);
	});

	it("keeps a plain-text body that mentions tags", () => {
		expect(toPlainSnippet("Use x < y and y > z here")).toBe("Use x < y and y > z here");
	});

	it("collapses whitespace and non-breaking spaces", () => {
		expect(toPlainSnippet("<p>  a&nbsp;&nbsp;b \n\n\t c  </p>")).toBe("a b c");
	});

	it("caps at the snippet length without splitting a surrogate pair", () => {
		const long = "😀".repeat(SNIPPET_MAX_CHARS + 50);
		const out = toPlainSnippet(long);
		expect(Array.from(out)).toHaveLength(SNIPPET_MAX_CHARS);
		expect(out).not.toMatch(/[\ud800-\udbff]$/);
	});

	it("handles a body truncated mid-tag", () => {
		expect(toPlainSnippet('<p>Hello world</p><a href="https://exa')).toBe("Hello world");
	});

	it("returns an empty string for empty input", () => {
		expect(toPlainSnippet("")).toBe("");
		expect(toPlainSnippet(null)).toBe("");
		expect(toPlainSnippet("<p></p>")).toBe("");
	});
});

describe("cleanFtsSnippet", () => {
	const hit = (s: string) => `${SNIPPET_MARK_OPEN}${s}${SNIPPET_MARK_CLOSE}`;

	it("removes whole and cut-off tags but keeps highlight markers", () => {
		const raw = `…ss="x">Hello <b>${hit("invoice")}</b> &amp; more <a href="…`;
		expect(cleanFtsSnippet(raw)).toBe(`Hello ${hit("invoice")} & more`);
	});

	it("passes clean text through", () => {
		expect(cleanFtsSnippet(`a ${hit("b")} c`)).toBe(`a ${hit("b")} c`);
	});
});
