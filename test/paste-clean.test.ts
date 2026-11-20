/**
 * Unit tests for app/lib/paste-clean.ts, following the fixture list in the
 * paste research doc (section 6). Fixture numbers are noted where they apply.
 * Editor-level behaviour (Shift-paste, Clear formatting, the toast's
 * replacement, setContent colour guards) is in editor-paste-behaviour.test.ts.
 */

import "./fixtures/paste/harness/jsdom-globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	PASTED_DATA_IMAGE_MAX_BYTES,
	classifyPlainText,
	cleanPastedHtml,
	htmlToPlainText,
	keepOriginalHtml,
	markdownToHtml,
	plainTextToHtml,
	readableStoredColor,
	terminalToHtml,
} from "~/lib/paste-clean";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/paste", name), "utf8");
const clean = (html: string) => cleanPastedHtml(html).html;
const dom = (html: string) => new DOMParser().parseFromString(html, "text/html").body;

/** No presentation left anywhere in the output. */
function expectNoPresentation(html: string) {
	expect(html).not.toMatch(/\sstyle=|\sclass="(?!language-)|\sid=|\sdata-|\saria-|<font|<mark|<span/i);
}

describe("cleanPastedHtml: fixtures", () => {
	it("Terminal.app (1): one code block with exact text, no colour", () => {
		const html = clean(fixture("terminal-app.html"));
		expectNoPresentation(html);
		const pre = dom(html).querySelector("pre");
		expect(pre?.textContent).toBe(fixture("terminal-app.txt").replace(/\n$/, ""));
	});

	it("iTerm2 copy with style (2, 3): one code block, lines kept", () => {
		const r = cleanPastedHtml(fixture("iterm2.html"));
		expect(r.kind).toBe("terminal");
		expect(dom(r.html).querySelector("pre")?.textContent).toBe(fixture("iterm2.txt").replace(/\n$/, ""));
	});

	it("VS Code (4): code block, indentation kept, no syntax spans", () => {
		const html = clean(fixture("vscode.html"));
		expectNoPresentation(html);
		expect(dom(html).querySelector("pre code")?.textContent).toBe(fixture("vscode.txt").replace(/\n$/, ""));
	});

	it("ChatGPT (6): headings, lists, link, table, and the whole command in the code block", () => {
		const body = dom(clean(fixture("chatgpt.html")));
		expect(body.querySelector("h3")?.textContent).toBe("Migration plan");
		expect(body.querySelectorAll("ol > li")).toHaveLength(3);
		const code = body.querySelector("pre code");
		expect(code?.textContent).toBe("wrangler r2 object get mail/backup.tar --file ./backup.tar");
		expect(code?.getAttribute("class")).toBe("language-bash");
		expect(body.querySelectorAll("table th")).toHaveLength(2);
		expect(body.innerHTML).not.toMatch(/var\(|rgb\(|style=/);
	});

	it("Claude web (7): language label above the block is dropped", () => {
		const body = dom(clean(fixture("claude-web.html")));
		expect(body.textContent).not.toMatch(/^\s*typescript/m);
		expect(body.querySelector("pre code")?.getAttribute("class")).toBe("language-typescript");
		expect(body.querySelector("p code")?.textContent).toBe("parseDraft");
	});

	it("WhatsApp Web (11): emoji sprites become emoji, text has no colour", () => {
		const html = clean(fixture("whatsapp-web.html"));
		expect(html).not.toMatch(/<img/);
		expect(html).toContain("🙏");
		expect(html).toContain("😊");
		expectNoPresentation(html);
	});

	it("Discord (12): bold, code and inline code kept, theme colours dropped", () => {
		const body = dom(clean(fixture("discord.html")));
		expect(body.querySelector("strong")?.textContent).toBe("done");
		expect(body.querySelector("pre code")?.textContent).toContain("curl -s");
		expectNoPresentation(body.innerHTML);
	});

	it("Google Docs (14): heading, list, bold, link; no wrapper bold; no spacer paragraphs", () => {
		const r = cleanPastedHtml(fixture("google-docs.html"));
		const body = dom(r.html);
		expect(body.querySelector("h2")?.textContent).toBe("Q4 launch notes");
		expect(body.querySelector("strong")?.textContent).toBe("Nov 18");
		expect(body.querySelectorAll("strong")).toHaveLength(1);
		expect(body.querySelector("a")?.getAttribute("href")).toBe("https://docs.google.com/document/d/abc/edit");
		expect(body.querySelectorAll("ul > li")).toHaveLength(2);
		expect(r.html).not.toMatch(/<br>/);
		expectNoPresentation(r.html);
		expect(r.removed).toBeGreaterThan(0);
	});

	it("Google Docs: two-level list via nested <ul>", () => {
		const html = clean(
			'<b id="docs-internal-guid-1" style="font-weight:normal"><ul><li><p>One</p></li><ul><li><p>One a</p></li></ul><li><p>Two</p></li></ul></b>',
		);
		expect(dom(html).querySelector("ul > li > ul > li")?.textContent).toBe("One a");
	});

	it("Word (16): real list from MsoListParagraph, no o:p, mso- or bullet glyphs", () => {
		const html = clean(fixture("ms-word.html"));
		const body = dom(html);
		expect(body.querySelectorAll("ul > li")).toHaveLength(2);
		expect(body.querySelector("li")?.textContent).toBe("Hiring two engineers");
		expect(html).not.toMatch(/o:p|mso-|·|MsoNormal/);
		expectNoPresentation(html);
	});

	it("Word: numbered and nested levels", () => {
		const p = (level: number, marker: string, text: string) =>
			`<p class=MsoListParagraphCxSpMiddle style='mso-list:l0 level${level} lfo1'><![if !supportLists]><span style='mso-list:Ignore'>${marker}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp; </span></span><![endif]>${text}</p>`;
		const html = clean(`<html xmlns:o="urn:schemas-microsoft-com:office:office"><body>${p(1, "1.", "First")}${p(2, "a.", "First a")}${p(1, "2.", "Second")}</body></html>`);
		const body = dom(html);
		expect(body.querySelectorAll(":scope > ol > li")).toHaveLength(2);
		expect(body.querySelector("ol > li > ol > li")?.textContent).toBe("First a");
	});

	it("Word table with shaded header (17): header cells kept, no shading", () => {
		const html = clean(
			'<table class=MsoTableGrid><tr><td style="background:#D9E2F3;mso-shading:white"><p class=MsoNormal><b>Name</b></p></td><td bgcolor="#D9E2F3"><p class=MsoNormal><b>Role</b></p></td></tr><tr><td><p class=MsoNormal>Ada</p></td><td><p class=MsoNormal>Eng</p></td></tr></table>',
		);
		expect(dom(html).querySelectorAll("td")).toHaveLength(4);
		expect(html).not.toMatch(/background|bgcolor|shading/i);
	});

	it("GitHub README (19): no heading anchor icon, checkboxes become ☐/☑", () => {
		const html = clean(
			'<div class="markdown-heading"><h2 class="heading-element">Setup</h2><a id="user-content-setup" class="anchor" aria-label="Permalink: Setup" href="#setup"><svg class="octicon"><path d="M0"></path></svg></a></div><ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled checked> done</li><li class="task-list-item"><input type="checkbox" disabled> todo</li></ul>',
		);
		const body = dom(html);
		expect(body.querySelector("h2")?.textContent).toBe("Setup");
		expect(html).not.toMatch(/<svg|<a /);
		const text = body.textContent!.replace(/\s+/g, " ");
		expect(text).toContain("☑ done");
		expect(text).toContain("☐ todo");
	});

	it("web article (20): paragraphs, links and emphasis only", () => {
		const html = clean('<p style="color:#333;font-family:Georgia;font-size:18px">Read <a href="https://x.example" style="color:#06c">this</a> <em>now</em>.</p>');
		expect(html).toBe('<p>Read <a href="https://x.example">this</a> <em>now</em>.</p>');
	});

	it("white text on a dark hero (21): no colour stored", () => {
		expectNoPresentation(clean(fixture("white-text-dark-site.html")));
		expect(clean('<span style="color:#fff">Hidden?</span>')).toBe("Hidden?");
	});

	it("pasted <mark> (22): highlight dropped by default", () => {
		const r = cleanPastedHtml('<p>Keep <mark style="background: yellow">this</mark></p>');
		expect(r.html).toBe("<p>Keep this</p>");
		expect(r.removed).toBeGreaterThan(0);
	});

	it("pasted signature (23): unwrapped, no style", () => {
		const html = clean('<p>Hi</p><div class="email-signature" style="color:#666;border-top:1px solid #ddd"><p>— Ada</p></div>');
		expect(html).not.toMatch(/email-signature|style=/);
		expect(dom(html).textContent).toContain("— Ada");
	});

	it("https image (24): kept with alt", () => {
		expect(clean('<img src="https://cdn.example/a.png" alt="Chart" width="600" style="border:1px">')).toBe(
			'<img src="https://cdn.example/a.png" alt="Chart">',
		);
	});

	it("data: images (26): tiny ones and huge ones are dropped, real ones kept", () => {
		const b64 = (bytes: number) => "A".repeat(Math.ceil((bytes * 4) / 3));
		expect(clean(`<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">`)).toBe("");
		expect(clean(`<img src="data:image/png;base64,${b64(50_000)}">`)).toContain("<img");
		expect(clean(`<img src="data:image/png;base64,${b64(PASTED_DATA_IMAGE_MAX_BYTES + 10)}">`)).toBe("");
		expect(clean(`<img src="data:image/svg+xml;base64,${b64(5000)}">`)).toBe("");
	});

	it("non-https images are dropped (file:, blob:, cid:, http:)", () => {
		for (const src of ["file:///x.png", "blob:https://a/1", "cid:img1", "http://x.example/a.png"]) {
			expect(clean(`<img src="${src}">`)).toBe("");
		}
	});
});

describe("cleanPastedHtml: security (27)", () => {
	it("drops javascript:, data: and vbscript: links, keeping the text", () => {
		for (const href of ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "java\tscript:alert(1)", "data:text/html,x", "vbscript:x", "#top", "/relative"]) {
			expect(clean(`<a href="${href}">t</a>`)).toBe("t");
		}
		expect(clean('<a href="mailto:a@b.example">m</a>')).toBe('<a href="mailto:a@b.example">m</a>');
	});

	it("drops event handlers, scripts, iframes, svg, styles and forms", () => {
		const html = clean(
			'<img src="https://x.example/a.png" onerror="alert(1)"><p onclick="x()">t</p><script>alert(1)</script><iframe src="https://evil.example"></iframe><svg><script>alert(1)</script></svg><style>p{color:red}</style><form action="https://evil"><input name="a"></form><object data="x"></object><math><mi>x</mi></math>',
		);
		expect(html).toBe('<img src="https://x.example/a.png"><p>t</p>');
	});

	it("does not run anything while parsing", () => {
		const g = globalThis as Record<string, unknown>;
		g.__pasted = false;
		clean('<img src="x" onerror="globalThis.__pasted=true"><script>globalThis.__pasted=true</script>');
		expect(g.__pasted).toBe(false);
	});

	it("drops style injection and attributes on kept tags", () => {
		const html = clean('<p style="background:url(javascript:alert(1))" class="x" id="y" data-x="1" aria-label="z" title="t">a</p>');
		expect(html).toBe("<p>a</p>");
	});

	it("keeps only safe language classes on code", () => {
		expect(clean('<pre><code class="language-ts">x</code></pre>')).toBe('<pre><code class="language-ts">x</code></pre>');
		expect(clean('<pre><code class="language-x&quot; onclick=&quot;y">x</code></pre>')).not.toMatch(/onclick/);
	});

	it("keepOriginalHtml still removes scripts, handlers and the signature class", () => {
		const html = keepOriginalHtml('<p style="color:#c00" onclick="x()">r</p><script>1</script><div class="email-signature">s</div><a href="javascript:1">j</a>');
		expect(html).toContain("color:#c00");
		expect(html).not.toMatch(/onclick|<script|email-signature|javascript:/);
	});
});

describe("plain text", () => {
	it("Markdown from a copy button (8) is detected and converted", () => {
		expect(classifyPlainText(fixture("chatgpt.txt"))).toBe("markdown");
		expect(classifyPlainText(fixture("markdown-plain.txt"))).toBe("markdown");
		const body = dom(markdownToHtml(fixture("markdown-plain.txt")));
		expect(body.querySelector("strong")?.textContent).toBe("Shipped");
		expect(body.querySelectorAll("ul > li")).toHaveLength(2);
		expect(body.querySelector("pre code")?.textContent).toBe("npm run deploy");
	});

	it("Markdown tables and links convert", () => {
		const body = dom(markdownToHtml(fixture("chatgpt.txt")));
		expect(body.querySelectorAll("table td")).toHaveLength(4);
		expect(body.querySelector("a")?.getAttribute("href")).toBe("https://developers.cloudflare.com/workers/");
	});

	it("raw HTML inside Markdown is not rendered", () => {
		const body = dom(markdownToHtml("# Hi\n\n- <img src=x onerror=alert(1)>\n- <script>1</script>"));
		expect(body.querySelector("img, script")).toBeNull();
		expect(body.querySelectorAll("li")).toHaveLength(2);
	});

	it("one stray * or # (9) is prose, not Markdown", () => {
		expect(classifyPlainText("5 * 3 = 15, issue #42\nsee you then")).toBe("text");
	});

	it("WhatsApp markup (10) is prose", () => {
		expect(classifyPlainText("*Meeting* at _5pm_\n~cancelled~ moved")).toBe("text");
	});

	it("a single line never converts", () => {
		expect(classifyPlainText("## just this")).toBe("text");
		expect(classifyPlainText("$ npm test")).toBe("text");
	});

	it("terminal output (prompt lines, box drawing, TUI glyphs) is one code block", () => {
		expect(classifyPlainText(fixture("terminal-app.txt"))).toBe("terminal");
		expect(classifyPlainText(fixture("iterm2.txt"))).toBe("terminal");
		expect(classifyPlainText("┌──────┬─────┐\n│ name │ age │\n└──────┴─────┘")).toBe("terminal");
		expect(classifyPlainText("⏺ Reading file\n  ⎿  Read 20 lines")).toBe("terminal");
		expect(terminalToHtml("a  b\n  c")).toBe("<pre><code>a  b\n  c</code></pre>");
	});

	it("prose: blank lines split paragraphs, single newlines are breaks", () => {
		expect(plainTextToHtml("Hi Sam,\nthanks.\n\nBye <3")).toBe("<p>Hi Sam,<br>thanks.</p><p>Bye &lt;3</p>");
	});

	it("plain-looking HTML (spans and <br>) with Markdown in it converts like plain text", () => {
		const r = cleanPastedHtml('<span style="color:#ddd">## Plan<br>- one<br>- two</span>');
		expect(r.kind).toBe("markdown");
		expect(dom(r.html).querySelectorAll("li")).toHaveLength(2);
	});

	it("htmlToPlainText keeps line structure", () => {
		expect(htmlToPlainText("<p>a</p><p>b<br>c</p>")).toBe("a\nb\nc");
	});
});

describe("review findings (Gemini cross-check)", () => {
	it("a sentence with an address and a # or $ is not a terminal prompt", () => {
		expect(classifyPlainText("user@example.com said order # 123 is delayed.\nPlease check.")).toBe("text");
		expect(classifyPlainText("alice@company.com paid $ 50 for tickets.\nThanks")).toBe("text");
		expect(classifyPlainText("Plans:\n$ 10 per month\n$ 100 per year")).toBe("text");
	});

	it("real prompts still count, and win over soft Markdown signals", () => {
		expect(classifyPlainText("user@host:~/app$ ls -la\ntotal 8")).toBe("terminal");
		const cli = "$ npm run build -- --watch\n1. compiled `app.ts`\n- 2 warnings";
		expect(classifyPlainText(cli)).toBe("terminal");
	});

	it("keeps text in a <pre> outside its <code>, and inline code tokens on one line", () => {
		const a = dom(clean("<pre><code>npm install</code>\n# or use pnpm\npnpm add</pre>"));
		expect(a.querySelector("pre code")?.textContent).toBe("npm install\n# or use pnpm\npnpm add");
		const b = dom(clean("<pre><code>const</code> <code>x</code> = 1;</pre>"));
		expect(b.querySelector("pre code")?.textContent).toBe("const x = 1;");
	});

	it("a legal § heading and a single 'A.  ' sentence are not lists", () => {
		expect(clean("<p>§  102.1 Scope</p>")).toBe("<p>§  102.1 Scope</p>");
		expect(clean("<p>A.  Because it is faster.</p>")).toBe("<p>A.  Because it is faster.</p>");
	});

	it("bullets after numbers start a second list", () => {
		const body = dom(clean("<p>1.  First</p><p>2.  Second</p><p>·  Note</p><p>·  Other</p>"));
		expect(body.querySelectorAll(":scope > ol > li")).toHaveLength(2);
		expect(body.querySelectorAll(":scope > ul > li")).toHaveLength(2);
	});

	it("strips marker padding split over several text nodes", () => {
		const li = dom(clean("<p>·<span>&nbsp;&nbsp;</span><span>&nbsp; </span>Item one</p><p>·  Item two</p>")).querySelector("li");
		expect(li?.textContent).toBe("Item one");
	});

	it("empty table cells keep their paragraph", () => {
		const body = dom(clean("<table><tr><td><p></p></td><td><p>x</p></td></tr></table>"));
		expect(body.querySelectorAll("td")).toHaveLength(2);
		expect(body.querySelector("td")?.querySelector("p")).not.toBeNull();
	});

	it("reports data: images dropped for size, so the composer can say so", () => {
		const big = "A".repeat(Math.ceil(((PASTED_DATA_IMAGE_MAX_BYTES + 10) * 4) / 3));
		expect(cleanPastedHtml(`<p>Shot:</p><img src="data:image/png;base64,${big}">`).droppedImages).toBe(1);
		expect(cleanPastedHtml('<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">').droppedImages).toBe(0);
	});

	it("keepOriginalHtml is an allowlist: no SVG data images, media or javascript links", () => {
		const svg = "PHN2Zz48L3N2Zz4=".repeat(200);
		const html = keepOriginalHtml(
			`<p style="color:#c00">r</p><img src="data:image/svg+xml;base64,${svg}"><video src="https://x.example/v.mp4"></video><audio src="https://x.example/a.mp3"></audio><a href="java\tscript:1">j</a><img src="https://x.example/ok.png" alt="ok">`,
		);
		expect(html).toContain('style="color:#c00"');
		expect(html).not.toMatch(/svg|<video|<audio|javascript|<a /i);
		expect(html).toContain('src="https://x.example/ok.png"');
	});
});

describe("readableStoredColor (5.6)", () => {
	it("drops near-white, near-black, CSS variables and keywords", () => {
		for (const c of ["#fff", "#ffffff", "rgb(233, 237, 239)", "#c7c7c7", "white", "#000", "#111", "rgb(33,33,33)", "black", "#1a1a1a", "var(--tw-prose-body)", "currentColor", "inherit", "transparent", "rgba(200, 0, 0, 0.2)", "nonsense"]) {
			expect(readableStoredColor(c), c).toBeNull();
		}
	});

	it("keeps mid-luminance colours that read on light and dark", () => {
		for (const c of ["#d93025", "#1a73e8", "rgb(0, 128, 0)", "#e8710a"]) {
			expect(readableStoredColor(c), c).toBe(c);
		}
	});
});
