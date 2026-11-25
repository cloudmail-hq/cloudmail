import { describe, expect, it } from "vitest";
import { MARKDOWN_MAX_CHARS, markdownToEmailHtml, renderMarkdownEmail } from "../shared/markdown-email";
import { SendEmailRequestSchema, sendBodyParts } from "../workers/lib/schemas";

const html = (md: string) => markdownToEmailHtml(md);
const text = (md: string) => renderMarkdownEmail(md).text;

describe("renderMarkdownEmail: HTML part", () => {
	it("writes paragraphs, and keeps a single line break as a line break", () => {
		expect(html("Hi Maya,\n\nThanks for the call.\n\nRegards,\nSam")).toBe(
			"<p>Hi Maya,</p><p>Thanks for the call.</p><p>Regards,<br>Sam</p>",
		);
	});

	it("keeps signature dashes as text, not a heading", () => {
		expect(html("Thanks,\n--\nSam")).toBe("<p>Thanks,<br>--<br>Sam</p>");
		// Three dashes on a line of their own are a rule, as in any Markdown.
		expect(html("Thanks,\n---\nSam")).toMatch(/^<p>Thanks,<\/p><hr [^>]*><p>Sam<\/p>$/);
	});

	it("reads indented text as a paragraph, not code", () => {
		expect(html("    four spaces in")).toBe("<p>four spaces in</p>");
	});

	it("writes list items the way the editor keeps them, with start numbers", () => {
		expect(html("- one\n- two")).toBe("<ul><li><p>one</p></li><li><p>two</p></li></ul>");
		expect(html("3. three\n4. four")).toBe('<ol start="3"><li><p>three</p></li><li><p>four</p></li></ol>');
		expect(html("- one\n  - nested")).toBe("<ul><li><p>one</p><ul><li><p>nested</p></li></ul></li></ul>");
	});

	it("writes headings with a size that reads as mail, not a web page", () => {
		expect(html("# Title")).toMatch(/^<h1 style="font-size:20px;[^"]*">Title<\/h1>$/);
		expect(html("#### Small")).toMatch(/^<h4 style="font-size:14px;[^"]*">Small<\/h4>$/);
	});

	it("writes bold, italic, strikethrough and code", () => {
		expect(html("**b** *i* ~~s~~ `c`")).toBe(
			'<p><strong>b</strong> <em>i</em> <s>s</s> <code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:90%;">c</code></p>',
		);
	});

	it("leaves a single tilde alone", () => {
		expect(html("~5 min, ~10 min")).toBe("<p>~5 min, ~10 min</p>");
	});

	it("links http, https and mailto only", () => {
		expect(html("[a](https://example.com) [b](mailto:a@example.com)")).toBe(
			'<p><a href="https://example.com">a</a> <a href="mailto:a@example.com">b</a></p>',
		);
		expect(html("[x](javascript:alert(1)) [y](/relative) [z](#frag)")).toBe("<p>x y z</p>");
	});

	it("links bare URLs, and sends www. ones as https", () => {
		expect(html("see https://example.com/a. and www.example.com")).toBe(
			'<p>see <a href="https://example.com/a">https://example.com/a</a>. and <a href="https://www.example.com">www.example.com</a></p>',
		);
	});

	it("links bare email addresses, once", () => {
		expect(html("Mail ana.b+x@example.co.uk, or <ana@example.com>. Not a@b or @example.com.")).toBe(
			'<p>Mail <a href="mailto:ana.b+x@example.co.uk">ana.b+x@example.co.uk</a>, or <a href="mailto:ana@example.com">ana@example.com</a>. Not a@b or @example.com.</p>',
		);
		expect(html("https://user@example.com/x")).toBe('<p><a href="https://user@example.com/x">https://user@example.com/x</a></p>');
	});

	it("resolves reference links", () => {
		expect(html("Read [the docs][d].\n\n[d]: https://example.com/docs")).toBe(
			'<p>Read <a href="https://example.com/docs">the docs</a>.</p>',
		);
	});

	it("shows raw HTML as text", () => {
		expect(html("Press <Enter> or <b>this</b>")).toBe("<p>Press &lt;Enter&gt; or &lt;b&gt;this&lt;/b&gt;</p>");
		expect(html('<div onclick="x()">hi</div>')).toBe("<p>&lt;div onclick=&quot;x()&quot;&gt;hi&lt;/div&gt;</p>");
		expect(html("<script>alert(1)</script>")).not.toContain("<script");
	});

	it("turns an image into a link, never an <img>", () => {
		expect(html("![Our logo](https://example.com/logo.png)")).toBe(
			'<p><a href="https://example.com/logo.png">Our logo</a></p>',
		);
		expect(html("![x](data:image/png;base64,AAAA)")).toBe("<p>x</p>");
	});

	it("writes task items with boxes", () => {
		expect(html("- [ ] to do\n- [x] done")).toBe(
			'<ul style="list-style-type:none;padding-left:4px;"><li><p>☐ to do</p></li><li><p>☑ done</p></li></ul>',
		);
	});

	it("writes tables with borders, alignment and every column on every row", () => {
		const out = html("| Item | Cost |\n|:--|--:|\n| A | $5 |\n| B |");
		expect(out).toMatch(/^<table style="border-collapse:collapse;/);
		expect(out).toContain("<thead><tr><th ");
		expect(out.match(/<td /g)).toHaveLength(4);
		expect(out).toContain("text-align:right;\">$5</td>");
	});

	it("writes code blocks escaped, in a preformatted box", () => {
		expect(html("```js\nif (a < b) {}\n```")).toMatch(/^<pre style="[^"]*white-space:pre-wrap;[^"]*"><code>if \(a &lt; b\) \{\}<\/code><\/pre>$/);
	});

	it("writes quotes and rules", () => {
		expect(html("> quoted")).toMatch(/^<blockquote style="[^"]*border-left:3px solid[^"]*"><p>quoted<\/p><\/blockquote>$/);
		expect(html("a\n\n---\n\nb")).toMatch(/^<p>a<\/p><hr style="[^"]*"><p>b<\/p>$/);
	});

	it("numbers footnotes in order of use and puts the notes at the end", () => {
		const out = html("One[^b] two[^a].\n\n[^a]: Alpha.\n[^b]: Beta.");
		expect(out).toMatch(/^<p>One\[1\] two\[2\]\.<\/p><hr [^>]*><p>\[1\] Beta\.<\/p><p>\[2\] Alpha\.<\/p>$/);
	});

	it("sets no text or background colour, so dark mode still works", () => {
		const out = html("# H\n\n> q\n\n| a |\n|-|\n| b |\n\n```\nx\n```\n\n`c`");
		expect(out).not.toMatch(/[;"]color:|background/);
	});

	it("is empty for an empty body", () => {
		expect(renderMarkdownEmail("")).toEqual({ html: "", text: "" });
		expect(renderMarkdownEmail("  \n ")).toEqual({ html: "", text: "" });
		expect(renderMarkdownEmail(undefined)).toEqual({ html: "", text: "" });
	});
});

describe("renderMarkdownEmail: text part", () => {
	it("is the message without Markdown syntax", () => {
		expect(text("Hi Maya,\n\n**Next steps:**\n\n1. Send the *contract*\n2. Book a [demo](https://example.com/demo)\n\nRegards,\nSam")).toBe(
			"Hi Maya,\n\nNext steps:\n\n1. Send the contract\n2. Book a demo (https://example.com/demo)\n\nRegards,\nSam",
		);
	});

	it("writes a bare URL once", () => {
		expect(text("see https://example.com/a and <mailto:a@example.com>")).toBe("see https://example.com/a and a@example.com");
	});

	it("indents nested lists and keeps task boxes", () => {
		expect(text("- one\n  - nested\n- [x] done")).toBe("- one\n  - nested\n- [x] done");
	});

	it("lines up tables", () => {
		expect(text("| Item | Cost |\n|-|-|\n| A | $5 |")).toBe("Item | Cost\n-----|-----\nA    | $5");
	});

	it("keeps code, quotes and footnotes readable", () => {
		expect(text("```\nconst a = 1;\n```")).toBe("const a = 1;");
		expect(text("> one\n>\n> two")).toBe("> one\n>\n> two");
		expect(text("Hi[^n].\n\n[^n]: A note.")).toBe("Hi[1].\n\n---\n[1] A note.");
	});
});

describe("renderMarkdownEmail: nothing typed is lost", () => {
	it("shows a link or footnote definition nothing cites as written", () => {
		expect(renderMarkdownEmail("[d]: https://example.com/d")).toEqual({
			html: '<p>[d]: <a href="https://example.com/d">https://example.com/d</a></p>',
			text: "[d]: https://example.com/d",
		});
		expect(renderMarkdownEmail("[^a]: The account is 4401.")).toEqual({
			html: "<p>[^a]: The account is 4401.</p>",
			text: "[^a]: The account is 4401.",
		});
		expect(html("Hi.\n\n[d]: https://example.com/d\n[^n]: note")).toBe(
			'<p>Hi.</p><p>[d]: <a href="https://example.com/d">https://example.com/d</a></p><p>[^n]: note</p>',
		);
	});

	it("hides a link definition only when a shown link uses it", () => {
		const def = "[d]: https://example.com/d";
		const shown = '<p>[d]: <a href="https://example.com/d">https://example.com/d</a></p>';
		// Used by a link, or by an image (which becomes a link): hidden.
		expect(html(`Read [this][d].\n\n${def}`)).toBe('<p>Read <a href="https://example.com/d">this</a>.</p>');
		expect(html(`See ![the chart][d].\n\n${def}`)).toBe('<p>See <a href="https://example.com/d">the chart</a>.</p>');
		// Used inside a cited note: hidden, the note links it.
		expect(html(`Hi[^n].\n\n[^n]: See [this][d].\n\n${def}`)).toBe(
			'<p>Hi[1].</p><hr style="border:none;border-top:1px solid #d0d7de;margin:20px 0;"><p>[1] See <a href="https://example.com/d">this</a>.</p>',
		);
		// Used only inside a footnote nothing cites, which is shown as written.
		expect(html(`Hi.\n\n[^n]: See [this][d].\n\n${def}`)).toBe(`<p>Hi.</p><p>[^n]: See [this][d].</p>${shown}`);
		// Used only inside an image's alt text, which is plain text.
		expect(html(`![a [b][d] c](https://example.com/i.png)\n\n${def}`)).toBe(
			`<p><a href="https://example.com/i.png">a b c</a></p>${shown}`,
		);
		expect(text(`![a [b][d] c](https://example.com/i.png)\n\n${def}`)).toBe(`a b c (https://example.com/i.png)\n\n${def}`);
		// Same target under another label nothing uses: that one is shown.
		expect(html(`Read [this][a].\n\n[a]: https://example.com/d\n${def}`)).toBe(
			`<p>Read <a href="https://example.com/d">this</a>.</p>${shown}`,
		);
		// Another label with the same URL, used only where it shows as text: still shown.
		expect(html(`[a][x]\n\n[x]: https://example.com/1\n[y]: https://example.com/1\n\n[^n]: see [b][y]`)).toBe(
			'<p><a href="https://example.com/1">a</a></p><p>[y]: <a href="https://example.com/1">https://example.com/1</a></p><p>[^n]: see [b][y]</p>',
		);
		// A link inside a link's text is its text; an image there is its alt text.
		expect(html("[![chart][i]](https://example.com/c)\n\n[i]: https://example.com/i.png")).toBe(
			'<p><a href="https://example.com/c">chart</a></p><p>[i]: <a href="https://example.com/i.png">https://example.com/i.png</a></p>',
		);
		// A target mail can't open shows as text, so its definition stays too.
		expect(html("Run [this][j].\n\n[j]: javascript:alert(1)")).toBe("<p>Run this.</p><p>[j]: javascript:alert(1)</p>");
	});

	it("cites footnotes with labels up to the longest a definition takes", () => {
		const label = "n".repeat(100);
		expect(html(`Hi[^${label}].\n\n[^${label}]: A note.`)).toMatch(/^<p>Hi\[1\]\.<\/p><hr [^>]*><p>\[1\] A note\.<\/p>$/);
		const long = "n".repeat(101);
		expect(html(`Hi[^${long}].\n\n[^${long}]: A note.`)).toBe(`<p>Hi[^${long}].</p><p>[^${long}]: A note.</p>`);
	});

	it("keeps a footnote definition to its paragraph", () => {
		expect(html("Hi[^n].\n\n[^n]: A note.\n- not part of it")).toMatch(
			/^<p>Hi\[1\]\.<\/p><ul><li><p>not part of it<\/p><\/li><\/ul><hr [^>]*><p>\[1\] A note\.<\/p>$/,
		);
	});

	it("renders every other non-blank body to something", () => {
		for (const md of ["| |\n|-|", "-", "- ", "#", "> ", "```\n```", "[]()", "![]()", "**", "<!-- c -->"]) {
			const out = renderMarkdownEmail(md);
			expect(out.html, md).not.toBe("");
			expect(out.text.trim(), md).not.toBe("");
		}
	});

	it("keeps tags well nested when the source crosses them", () => {
		expect(html("*a ~~b* c~~")).toBe("<p><em>a ~~b</em> c~~</p>");
		const out = html("**a *b** c* [x **y](https://example.com) z**");
		const tags = out.match(/<\/?(?:em|strong|s|a)\b/g) ?? [];
		const stack: string[] = [];
		for (const tag of tags) {
			if (tag.startsWith("</")) expect(stack.pop()).toBe(tag.slice(2));
			else stack.push(tag.slice(1));
		}
		expect(stack).toEqual([]);
	});
});

describe("renderMarkdownEmail: hostile input", () => {
	const fast = (md: string) => {
		const start = performance.now();
		const out = renderMarkdownEmail(md);
		return { out, ms: performance.now() - start };
	};

	it("renders nesting past the limit as plain text, keeping the words", () => {
		const quotes = fast(">".repeat(2000) + " hi");
		expect(quotes.out.html).toBe(`<p>${"&gt;".repeat(2000)} hi</p>`);
		let list = "";
		for (let i = 0; i < 300; i++) list += "  ".repeat(i) + "- x\n";
		const lists = fast(list + "  ".repeat(299) + "  hi");
		expect(lists.out.html).toContain("hi</p>");
		expect(lists.out.html).not.toContain("<ul>");
		expect(lists.out.text).toContain("hi");
	});

	it("nests quotes and lists 32 deep, counted together, and no deeper", () => {
		const quotes = (n: number) => "> ".repeat(n) + "hi\n\n**bold**";
		expect(html(quotes(32)).match(/<blockquote/g)).toHaveLength(32);
		expect(html(quotes(33))).not.toContain("<blockquote");
		expect(html(quotes(33))).toContain("**bold**");
		const list = (n: number) => Array.from({ length: n }, (_, i) => "  ".repeat(i) + "- x").join("\n") + "\n\n**bold**";
		expect(html(list(32)).match(/<ul>/g)).toHaveLength(32);
		expect(html(list(32))).toContain("<strong>bold</strong>");
		expect(html(list(33))).not.toContain("<ul>");
		expect(html(list(33))).toContain("**bold**");
		const mixed = (q: number, l: number) => "> ".repeat(q) + "- ".repeat(l) + "x";
		expect(html(mixed(16, 16)).match(/<blockquote|<ul>/g)).toHaveLength(32);
		expect(html(mixed(17, 16))).not.toMatch(/<blockquote|<ul>/);
	});

	it("still nests to a depth a person writes", () => {
		expect(html("> > > > > deep")).toContain("<blockquote");
		let list = "";
		for (let i = 0; i < 8; i++) list += "  ".repeat(i) + "- x\n";
		expect(html(list).match(/<ul>/g)).toHaveLength(8);
	});

	it("caps inline tag depth, keeping the text", () => {
		const out = html("*a ".repeat(50) + "b" + " c*".repeat(50));
		expect(out.match(/<em>/g)).toHaveLength(10);
		expect(out.match(/<\/em>/g)).toHaveLength(10);
		expect(out).toContain("b");
	});

	it("stays fast on inputs that are quadratic for other parsers", () => {
		const size = MARKDOWN_MAX_CHARS - 10;
		const cases = {
			"nested emphasis": "*a ".repeat(size / 6) + "b" + " c*".repeat(size / 6),
			closers: "a* ".repeat(size / 3),
			"mixed delimiters": "*a _b ~~c ".repeat(size / 10),
			brackets: "a] ".repeat(size / 3),
			"image opens": "![a ".repeat(size / 4),
			"www links": "www.a.co ".repeat(size / 9),
			"email-like runs": "a.".repeat(size / 4) + "@" + "b.".repeat(size / 4),
			"many ats": "a@".repeat(size / 2),
			"punctuation after a URL": "http://a" + ".".repeat(size),
			"table rows": "| a | b |\n|-|-|\n" + "| x | y |\n".repeat(size / 10),
			"lazy quote lines": "> a\n" + "b\n".repeat(size / 2),
			"footnote refs": "[^a] ".repeat(size / 5) + "\n\n[^a]: n",
		};
		for (const [name, md] of Object.entries(cases)) {
			const { out, ms } = fast(md);
			expect(out.html, name).not.toBe("");
			expect(ms, name).toBeLessThan(1500);
		}
	});

	it("sends a body over the size limit as plain paragraphs", () => {
		const md = "**a** b\n\n".repeat(MARKDOWN_MAX_CHARS / 8);
		const { out, ms } = fast(md);
		expect(out.html.startsWith("<p>**a** b</p><p>**a** b</p>")).toBe(true);
		expect(ms).toBeLessThan(1500);
	});
});

describe("send bodies", () => {
	const base = { to: "a@example.com", from: "me@example.com", subject: "Hi" };

	it("accepts markdown as the only body, and refuses it with html", () => {
		expect(SendEmailRequestSchema.safeParse({ ...base, markdown: "**Hi**" }).success).toBe(true);
		expect(SendEmailRequestSchema.safeParse({ ...base, markdown: "  " }).success).toBe(false);
		const both = SendEmailRequestSchema.safeParse({ ...base, markdown: "a", html: "<p>a</p>" });
		expect(both.success).toBe(false);
		expect(JSON.stringify(both.error)).toContain("not both");
	});

	it("renders markdown into both parts, and an explicit text part wins", () => {
		expect(sendBodyParts({ markdown: "**Hi** there" })).toEqual({ html: "<p><strong>Hi</strong> there</p>", text: "Hi there" });
		expect(sendBodyParts({ markdown: "**Hi**", text: "Custom" })).toEqual({ html: "<p><strong>Hi</strong></p>", text: "Custom" });
		expect(sendBodyParts({ html: "<p>x</p>", text: "x" })).toEqual({ html: "<p>x</p>", text: "x" });
	});

	it("refuses a markdown body over the size limit", () => {
		const big = SendEmailRequestSchema.safeParse({ ...base, markdown: "a".repeat(MARKDOWN_MAX_CHARS + 1) });
		expect(big.success).toBe(false);
		expect(SendEmailRequestSchema.safeParse({ ...base, markdown: "a".repeat(MARKDOWN_MAX_CHARS) }).success).toBe(true);
	});
});
