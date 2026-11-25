import { describe, expect, it } from "vitest";
import { bodyAsHtml, htmlToEmailText, isPlainTextBody, plainTextToHtml } from "../shared/plain-text-html";

describe("plainTextToHtml", () => {
	it("keeps paragraphs, line breaks and bullet lists from an agent's plain-text draft", () => {
		const text = [
			"Hi Shantanu,",
			"",
			"Our API covers the data you listed:",
			"",
			"- Daily prices for NSE and BSE equities",
			"- Quarterly and annual financials",
			"",
			"Docs: https://developers.tapetide.com/",
			"Username: tapetide",
			"",
			"Regards, Team Tapetide",
		].join("\n");
		expect(plainTextToHtml(text)).toBe(
			"<p>Hi Shantanu,</p>" +
				"<p>Our API covers the data you listed:</p>" +
				"<ul><li><p>Daily prices for NSE and BSE equities</p></li><li><p>Quarterly and annual financials</p></li></ul>" +
				'<p>Docs: <a href="https://developers.tapetide.com/">https://developers.tapetide.com/</a><br>Username: tapetide</p>' +
				"<p>Regards, Team Tapetide</p>",
		);
	});

	it("handles numbered lists, a list right after a line, and CRLF", () => {
		expect(plainTextToHtml("Steps:\r\n1. Sign up\r\n2) Pay")).toBe("<p>Steps:</p><ol><li><p>Sign up</p></li><li><p>Pay</p></li></ol>");
	});

	it("escapes markup-looking text, keeps trailing punctuation outside links, and bolds **x**", () => {
		expect(plainTextToHtml("a < b & **c**. See https://x.example/a?b=1&c=2.")).toBe(
			'<p>a &lt; b &amp; <strong>c</strong>. See <a href="https://x.example/a?b=1&amp;c=2">https://x.example/a?b=1&amp;c=2</a>.</p>',
		);
	});

	it("stops a link at <…> or quotes around it", () => {
		expect(plainTextToHtml('See <https://example.com/docs> or "https://example.com/a"')).toBe(
			'<p>See &lt;<a href="https://example.com/docs">https://example.com/docs</a>&gt; or &quot;<a href="https://example.com/a">https://example.com/a</a>&quot;</p>',
		);
	});

	it("keeps one numbered list across blank lines, and its starting number", () => {
		expect(plainTextToHtml("1. Confirm the order\n\n2. Ship by Friday")).toBe(
			"<ol><li><p>Confirm the order</p></li><li><p>Ship by Friday</p></li></ol>",
		);
		expect(plainTextToHtml("3) Third\n4) Fourth")).toBe('<ol start="3"><li><p>Third</p></li><li><p>Fourth</p></li></ol>');
		expect(plainTextToHtml("- a\n\nNote\n\n- b")).toBe("<ul><li><p>a</p></li></ul><p>Note</p><ul><li><p>b</p></li></ul>");
	});

	it("keeps a bold-wrapped URL as a clean link inside <strong>", () => {
		expect(plainTextToHtml("**Docs: https://example.com/docs**")).toBe(
			'<p><strong>Docs: <a href="https://example.com/docs">https://example.com/docs</a></strong></p>',
		);
		expect(plainTextToHtml("**https://x.com**")).toBe('<p><strong><a href="https://x.com">https://x.com</a></strong></p>');
	});

	it("never bolds inside a link's target, and bolds around or inside its label", () => {
		expect(plainTextToHtml("See [docs](https://example.com/a**b) and **bold** here.")).toBe(
			'<p>See <a href="https://example.com/a**b">docs</a> and <strong>bold</strong> here.</p>',
		);
		expect(plainTextToHtml("[x](https://example.com/**a**)")).toBe('<p><a href="https://example.com/**a**">x</a></p>');
		expect(plainTextToHtml("**see [docs](https://example.com/d)**")).toBe(
			'<p><strong>see <a href="https://example.com/d">docs</a></strong></p>',
		);
		expect(plainTextToHtml("[**docs**](https://example.com/d)")).toBe('<p><a href="https://example.com/d"><strong>docs</strong></a></p>');
		expect(plainTextToHtml("[**a](https://example.com/d) b**")).toBe('<p><a href="https://example.com/d">**a</a> b**</p>');
	});

	it("keeps balanced parentheses in a Markdown link's target", () => {
		expect(plainTextToHtml("See [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) now.")).toBe(
			'<p>See <a href="https://en.wikipedia.org/wiki/Foo_(bar)">Foo</a> now.</p>',
		);
	});

	it("turns a Markdown link into a link with its label", () => {
		expect(plainTextToHtml("See [the docs](https://example.com/docs) and https://x.example/a.")).toBe(
			'<p>See <a href="https://example.com/docs">the docs</a> and <a href="https://x.example/a">https://x.example/a</a>.</p>',
		);
		expect(plainTextToHtml("[a <b>](https://example.com/?q=1&r=2)")).toBe(
			'<p><a href="https://example.com/?q=1&amp;r=2">a &lt;b&gt;</a></p>',
		);
		// Only http(s) targets; anything else stays text.
		expect(plainTextToHtml("[x](javascript:alert(1))")).toBe("<p>[x](javascript:alert(1))</p>");
	});

	it("takes a label without brackets, as GFM does", () => {
		expect(plainTextToHtml("[a [b](https://example.com/b)")).toBe('<p>[a <a href="https://example.com/b">b</a></p>');
	});

	// Both inputs took seconds with the old patterns: a run of `[` retried as a
	// link label from every bracket, a run of dots retried as trailing punctuation.
	it("stays fast on long runs of brackets and of dots after a URL", () => {
		const brackets = "[".repeat(200_000);
		expect(plainTextToHtml(brackets)).toBe(`<p>${brackets}</p>`);
		const dots = ".".repeat(200_000);
		expect(plainTextToHtml(`http://a${dots}a`)).toBe(`<p><a href="http://a${dots}a">http://a${dots}a</a></p>`);
		expect(plainTextToHtml(`http://a${dots}`)).toBe(`<p><a href="http://a">http://a</a>${dots}</p>`);
	});

	it("is empty for empty input", () => {
		expect(plainTextToHtml("")).toBe("");
		expect(plainTextToHtml("  \n ")).toBe("");
		expect(plainTextToHtml(null)).toBe("");
	});
});

describe("bodyAsHtml", () => {
	it("converts plain text and passes HTML through untouched", () => {
		expect(isPlainTextBody("Hi\n\nThere")).toBe(true);
		expect(isPlainTextBody("<p>Hi</p>")).toBe(false);
		expect(isPlainTextBody("Hi <John>,\n\nSee you")).toBe(true);
		expect(bodyAsHtml("Hi <John>,\n\nSee you")).toBe("<p>Hi &lt;John&gt;,</p><p>See you</p>");
		expect(isPlainTextBody("if a<b then c>d")).toBe(true);
		// Any element counts as HTML, not only a fixed list of names.
		expect(isPlainTextBody("<article>Shipped <mark>today</mark></article>")).toBe(false);
		expect(bodyAsHtml("<article>Shipped <mark>today</mark></article>")).toBe("<article>Shipped <mark>today</mark></article>");
		expect(isPlainTextBody("Line one<br>Line two")).toBe(false);
		expect(isPlainTextBody("")).toBe(false);
		expect(bodyAsHtml("<p>Hi</p>\n\n<ul><li>x</li></ul>")).toBe("<p>Hi</p>\n\n<ul><li>x</li></ul>");
		expect(bodyAsHtml("Hi\n\nThere")).toBe("<p>Hi</p><p>There</p>");
		expect(bodyAsHtml(null)).toBe("");
	});
});

describe("htmlToEmailText", () => {
	it("round-trips a plain-text draft closely: blank lines between paragraphs, list markers kept", () => {
		const text = "Hi Shantanu,\n\nThanks & regards.\n\n- Daily prices\n- Financials\n\n3. Three\n4. Four\n\nDocs: https://x.example/";
		expect(htmlToEmailText(plainTextToHtml(text))).toBe(text);
	});

	it("keeps a second paragraph inside a list item on its own line", () => {
		expect(htmlToEmailText("<ul><li><p>Ship by Friday</p><p>Include the tracking number</p></li></ul>")).toBe(
			"- Ship by Friday\n  Include the tracking number",
		);
	});

	it("indents nested lists under their item and keeps the outer markers", () => {
		expect(htmlToEmailText("<ul><li><p>a</p><ul><li><p>b</p></li></ul></li><li><p>c</p></li></ul>")).toBe("- a\n  - b\n- c");
		expect(htmlToEmailText('<ol start="2"><li><p>x</p><ul><li><p>y</p></li></ul></li><li><p>z</p></li></ol>')).toBe("2. x\n  - y\n3. z");
	});

	it("keeps <br> line breaks and is empty for empty input", () => {
		expect(htmlToEmailText("<p>a<br>b</p>")).toBe("a\nb");
		expect(htmlToEmailText("")).toBe("");
	});
});
