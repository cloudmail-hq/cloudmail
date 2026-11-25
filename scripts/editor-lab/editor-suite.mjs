#!/usr/bin/env node
/**
 * Browser tests for the composer's editor, run against a demo instance
 * (scripts/demo: `run.sh seed`, then the dev server on 127.0.0.1:5173).
 *
 *   node scripts/editor-lab/editor-suite.mjs [out-dir] [--only a,b]
 *
 * Each case drives the real composer with Playwright: real keys, real
 * clipboard events, the real draft save. Sends are intercepted and never
 * leave the machine. Prints one line per case and writes results.json, plus a
 * screenshot of every failure.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { DEMO_BASE_URL as BASE, DEMO_OWNER } from "../demo/demo-constants.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const args = process.argv.slice(2);
const OUT = resolve(args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--only") ?? "editor-lab-out");
const ONLY = (args.includes("--only") ? args[args.indexOf("--only") + 1] : "").split(",").filter(Boolean);
mkdirSync(OUT, { recursive: true });
const MB = DEMO_OWNER.email;
const MBQ = encodeURIComponent(MB);
const MOD = process.platform === "darwin" ? "Meta" : "Control";

const browser = await chromium.launch({
	executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
	args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
const login = await ctx.request.post(`${BASE}/api/auth/login`, { data: { email: DEMO_OWNER.email, password: DEMO_OWNER.password } });
if (!login.ok()) throw new Error(`login ${login.status()}`);

// ── helpers ────────────────────────────────────────────────────────────

let seq = 0;
const uid = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

async function createDraft(body, subject = `Lab ${uid()}`, to = "guze@example.com", extra = {}) {
	const res = await ctx.request.post(`${BASE}/api/v1/mailboxes/${MBQ}/drafts`, { data: { to, subject, body, ...extra } });
	if (!res.ok()) throw new Error(`draft ${res.status()} ${await res.text()}`);
	return (await res.json()).id;
}

/**
 * Opens reply draft A from its thread, makes an edit, opens reply draft B from
 * the same thread (the composer stays mounted), and presses undo four times.
 */
async function switchDrafts(page, { a, b, edit }) {
	const original = await inboxMessageInThread();
	const thread = { in_reply_to: original.id, thread_id: original.thread_id };
	const subjectA = `Re: ${original.subject ?? ""} (lab a ${uid()})`;
	const subjectB = `Re: ${original.subject ?? ""} (lab b ${uid()})`;
	const idA = await createDraft(a, subjectA, original.sender, thread);
	const idB = await createDraft(b, subjectB, original.sender, thread);
	await gotoApp(page, `/mail/${MBQ}/inbox?m=${original.id}`);
	// A draft card may start collapsed; its header expands it and shows Edit.
	const openFromThread = async (id) => {
		const card = page.locator(`#threadmsg-${id}`);
		const button = card.getByRole("button", { name: "Edit", exact: true });
		if (!(await button.isVisible())) await card.locator("header").click();
		await button.click();
	};
	await openFromThread(idA);
	await waitEditor(page);
	await caretToEnd(page);
	await edit();
	await page.waitForTimeout(300);
	const before = await page.evaluate(() => {
		const el = document.querySelector(".ProseMirror");
		el.dataset.labMark = "first";
		return el.editor.getText();
	});
	await openFromThread(idB);
	await page.waitForFunction((s) => document.querySelector("#compose-subject")?.value === s, subjectB, { timeout: 15000 }).catch(() => {});
	await page.waitForTimeout(600);
	const subjectIsB = (await page.locator("#compose-subject").inputValue()) === subjectB;
	// Still the same editor element: the switch happened in place.
	const sameEditor = await page.evaluate(() => document.querySelector(".ProseMirror")?.dataset.labMark === "first");
	await caretToEnd(page);
	for (let i = 0; i < 4; i++) await page.keyboard.press(`${MOD}+z`);
	const text = await editorText(page);
	return { before, sameEditor, subjectIsB, text: text.slice(0, 80) };
}

/** A seeded inbox message that belongs to a conversation, to reply to. */
async function inboxMessageInThread() {
	const res = await ctx.request.get(`${BASE}/api/v1/mailboxes/${MBQ}/emails?folder=inbox&limit=25`);
	if (!res.ok()) throw new Error(`emails ${res.status()}`);
	const page = await res.json();
	const found = (Array.isArray(page) ? page : page.emails).find((e) => e.thread_id);
	if (!found) throw new Error("no inbox message with a thread_id");
	return found;
}

async function gotoApp(page, path) {
	// The first load after a fresh dep cache can throw a duplicate-React hooks
	// error while Vite re-optimises; a reload settles it (as in scripts/demo).
	for (let i = 0; i < 4; i++) {
		await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 90000 });
		await page.waitForFunction(() => Boolean(window.__reactRouterRouteModules), null, { timeout: 60000 }).catch(() => {});
		await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
		await page.waitForTimeout(800);
		if (await page.evaluate(() => !document.body.innerText.includes("Application Error"))) return;
	}
	throw new Error("app did not load");
}

async function waitEditor(page) {
	await page.locator(".ProseMirror").first().waitFor({ timeout: 90000 });
	await page.waitForFunction(() => Boolean(document.querySelector(".ProseMirror")?.editor), null, { timeout: 30000 });
	await page.waitForTimeout(600);
}

async function openDraft(page, id) {
	await gotoApp(page, `/mail/${MBQ}/draft?m=${id}`);
	await page.getByRole("button", { name: "Edit", exact: true }).first().click();
	await waitEditor(page);
}

async function openNew(page, { to = "guze@example.com", subject = `Lab ${uid()}` } = {}) {
	await gotoApp(page, `/mail/${MBQ}/inbox`);
	await page.getByRole("button", { name: "Compose", exact: true }).locator("visible=true").first().click();
	await waitEditor(page);
	if (to) {
		const field = page.getByLabel("To", { exact: true }).locator("visible=true").first();
		await field.click();
		await field.pressSequentially(to);
		await field.press("Enter");
	}
	if (subject) await page.locator("#compose-subject").fill(subject);
	// Where a person starts typing: the first line, above the signature.
	await page.locator(".ProseMirror > p").first().click();
	await page.keyboard.press("Home");
}

const editorHtml = (page) => page.evaluate(() => document.querySelector(".ProseMirror").editor.getHTML());
const editorJson = (page) => page.evaluate(() => document.querySelector(".ProseMirror").editor.getJSON());
const editorText = (page) => page.evaluate(() => document.querySelector(".ProseMirror").editor.getText());

async function caretToEnd(page) {
	await page.locator(".ProseMirror").click();
	await page.keyboard.press(`${MOD}+End`);
}

/** Records the bodies of draft saves (what the server stores). */
function watchDraftSaves(page) {
	const saves = [];
	page.on("request", (r) => {
		if (r.method() === "POST" && /\/api\/v1\/mailboxes\/[^/]+\/drafts$/.test(r.url())) saves.push(r.postDataJSON());
	});
	return saves;
}

/** Intercepts sends (scheduled-sends with the undo delay) and records them. */
async function interceptSends(page) {
	const sends = [];
	await page.route("**/api/v1/mailboxes/*/scheduled-sends", async (route) => {
		if (route.request().method() !== "POST") return route.continue();
		sends.push(route.request().postDataJSON());
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ id: `lab-${uid()}`, status: "scheduled", send_at: new Date(Date.now() + 600000).toISOString() }),
		});
	});
	return sends;
}

async function saveDraft(page, saves) {
	const before = saves.length;
	await page.locator('[title="Save draft"]').click();
	for (let i = 0; i < 40 && saves.length === before; i++) await page.waitForTimeout(250);
	await page.waitForTimeout(500);
	return saves.at(-1);
}

async function paste(page, { html, text, pngFile = false }) {
	// A real Cmd/Ctrl+V starts with a keydown, and ProseMirror reads the DOM
	// selection on keydown. A bare synthetic paste event skips that and would
	// land wherever the editor last saw the caret, so send the keydown first.
	await page.keyboard.press("Control");
	await page.evaluate(
		async ({ html, text, pngFile }) => {
			const dom = document.querySelector(".ProseMirror");
			const dt = new DataTransfer();
			if (html) dt.setData("text/html", html);
			if (text) dt.setData("text/plain", text);
			if (pngFile) {
				const c = document.createElement("canvas");
				c.width = c.height = 48;
				const g = c.getContext("2d");
				for (let x = 0; x < 48; x += 4) for (let y = 0; y < 48; y += 4) {
					g.fillStyle = `rgb(${(x * 37 + y * 11) % 255},${(x * 7 + y * 53) % 255},${(x * y) % 255})`;
					g.fillRect(x, y, 4, 4);
				}
				const blob = await new Promise((r) => c.toBlob(r, "image/png"));
				dt.items.add(new File([blob], "screenshot.png", { type: "image/png" }));
			}
			dom.focus();
			dom.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
		},
		{ html, text, pngFile },
	);
	await page.waitForTimeout(700);
}

const count = (s, needle) => s.split(needle).length - 1;

// A support reply shaped like the agent-written drafts: one-item numbered
// headings that continue with `start`, address lines with <br>, bullets, links.
const AGENT_HTML =
	"<p>Hi Guze,</p><p>Thanks for the detailed questions. Answers below, in your order.</p>" +
	"<p>COMPANY AND CONTRACT</p><ol><li><p>Legal entity</p></li></ol>" +
	"<p>We sell through our Merchant of Record:</p><p>Example Payments Inc<br>8 The Green, Dover<br>EIN: 000000000</p>" +
	'<ol start="2"><li><p>SLA</p></li></ol><p>Our standard plans don\'t include an uptime guarantee.</p>' +
	'<ol start="3"><li><p>If we discontinue the service</p></li></ol><p>You would get at least 80 days\' notice.</p>' +
	"<ul><li><p>Collections</p></li><li><p>Face IDs</p></li><li><p>Embeddings</p></li></ul>" +
	'<p>See <a href="https://example.com/dpa">the DPA</a> for details.</p><p>Regards,<br>Support</p>';

const AGENT_TEXT = [
	"Hi Guze,",
	"",
	"Thanks for the questions. Short answers:",
	"",
	"- Legal entity: Example Labs",
	"- SLA: on request",
	"",
	"Next steps:",
	"1. Sign the DPA",
	"2. Create an API key",
	"",
	"**Important:** read [the docs](https://example.com/docs) first.",
	"Full guide: https://example.com/guide",
	"",
	"Regards,",
	"Support",
].join("\n");

// ── cases ──────────────────────────────────────────────────────────────

const cases = {
	/** The editor shows paragraphs, list markers and indentation, as the reader and the recipient do. */
	async "layout-matches-mail"(page) {
		await openDraft(page, await createDraft(AGENT_HTML));
		const s = await page.evaluate(() => {
			const root = document.querySelector(".ProseMirror");
			const cs = (sel) => {
				const el = root.querySelector(sel);
				if (!el) return null;
				const c = getComputedStyle(el);
				return { mb: parseFloat(c.marginBottom), pl: parseFloat(c.paddingLeft), ls: c.listStyleType };
			};
			return { p: cs(":scope > p"), ul: cs("ul"), ol: cs("ol"), liP: cs("li > p"), olStart: root.querySelectorAll("ol")[1]?.start };
		});
		const ok = s.p?.mb >= 10 && s.ul?.ls === "disc" && s.ol?.ls === "decimal" && s.ul?.pl >= 16 && s.liP?.mb === 0 && s.olStart === 2;
		return { ok, detail: s };
	},

	/** Opening a draft and leaving it alone writes nothing back. */
	async "open-does-not-resave"(page) {
		const saves = watchDraftSaves(page);
		await openDraft(page, await createDraft(AGENT_HTML));
		await page.waitForTimeout(4500);
		return { ok: saves.length === 0, detail: { saves: saves.length } };
	},

	/** Undo right after opening a draft never empties or changes it. */
	async "undo-after-open-keeps-draft"(page) {
		await openDraft(page, await createDraft(AGENT_HTML));
		const before = await editorText(page);
		await caretToEnd(page);
		await page.keyboard.press(`${MOD}+z`);
		await page.keyboard.press(`${MOD}+z`);
		const after = await editorText(page);
		return { ok: after === before && after.length > 100, detail: { beforeLen: before.length, afterLen: after.length } };
	},

	/** A one-word edit keeps every list, start number, line break and link. */
	async "edit-keeps-structure"(page) {
		const saves = watchDraftSaves(page);
		await openDraft(page, await createDraft(AGENT_HTML));
		await page.locator(".ProseMirror p").first().click();
		await page.keyboard.press("End");
		await page.keyboard.type(" and team");
		const body = (await saveDraft(page, saves))?.body ?? "";
		const detail = {
			ol: count(body, "<ol"), ul: count(body, "<ul"), li: count(body, "<li"), br: count(body, "<br"),
			start2: body.includes('start="2"'), start3: body.includes('start="3"'), link: body.includes('href="https://example.com/dpa"'),
			edited: body.includes("Hi Guze, and team"), liP: count(body, "<li><p>"),
		};
		const ok = detail.ol === 3 && detail.ul === 1 && detail.li === 6 && detail.br >= 3 && detail.start2 && detail.start3 && detail.link && detail.edited;
		return { ok, detail };
	},

	/** Sending an opened agent draft keeps its lists, numbering, line breaks and links, with nothing trailing. */
	async "sent-html-keeps-structure"(page) {
		const sends = await interceptSends(page);
		await openDraft(page, await createDraft(AGENT_HTML));
		await caretToEnd(page);
		await page.keyboard.type(" Thanks");
		await page.keyboard.press(`${MOD}+Enter`);
		await page.waitForTimeout(1500);
		const html = sends[0]?.html ?? "";
		const detail = {
			sends: sends.length, ol: count(html, "<ol"), ul: count(html, "<ul"), start2: html.includes('start="2"'), br: count(html, "<br"),
			link: html.includes('href="https://example.com/dpa"'), edited: html.includes("Support Thanks"), tail: html.slice(-60),
		};
		const ok = detail.sends === 1 && detail.ol === 3 && detail.ul === 1 && detail.start2 && detail.br >= 3 && detail.link && detail.edited && !/<p(\s[^>]*)?>(<br>)?<\/p>$/.test(html);
		return { ok, detail };
	},

	/** An agent's plain-text draft opens as paragraphs, lists, bold and links, Markdown links included. */
	async "agent-plain-text-draft"(page) {
		await openDraft(page, await createDraft(AGENT_TEXT));
		const html = await editorHtml(page);
		const detail = {
			ul: count(html, "<ul"), ol: count(html, "<ol"), strong: html.includes("<strong>Important:</strong>"),
			mdLink: /<a[^>]+href="https:\/\/example\.com\/docs"[^>]*>the docs<\/a>/.test(html), bare: html.includes('href="https://example.com/guide"'),
			p: count(html, "<p>"), rawBrackets: html.includes("[the docs]"),
		};
		return { ok: detail.ul === 1 && detail.ol === 1 && detail.strong && detail.mdLink && detail.bare && !detail.rawBrackets, detail };
	},

	/** Enter twice makes a blank line that is still there in the saved and the sent mail. */
	async "blank-line-survives-save"(page) {
		const saves = watchDraftSaves(page);
		await openNew(page);
		await page.keyboard.type("First line");
		await page.keyboard.press("Enter");
		await page.keyboard.press("Enter");
		await page.keyboard.type("After a blank line");
		const body = (await saveDraft(page, saves))?.body ?? "";
		return { ok: body.includes("<p>First line</p><p><br></p><p>After a blank line</p>"), detail: { body } };
	},

	/** A stored blank line (<p><br></p>) opens as one empty line, not a line break plus a line. */
	async "blank-line-reopens-as-one"(page) {
		await openDraft(page, await createDraft("<p>a</p><p><br></p><p>b</p>"));
		const json = await editorJson(page);
		const kinds = json.content.map((n) => `${n.type}:${(n.content ?? []).map((c) => c.type).join("+")}`);
		return { ok: JSON.stringify(kinds) === JSON.stringify(["paragraph:text", "paragraph:", "paragraph:text"]), detail: { kinds } };
	},

	/** Cmd/Ctrl+Enter sends once, with no stray line break and no trailing empty paragraphs. */
	async "mod-enter-sends-clean"(page) {
		const sends = await interceptSends(page);
		await openNew(page);
		await page.keyboard.type("Hello");
		await page.keyboard.press("Enter");
		await page.keyboard.press("Enter");
		// Send from the end of "Hello". On the empty line below it, a stray line
		// break would serialise the same as the blank line, and the case would
		// pass without the fix.
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("ArrowUp");
		await page.waitForTimeout(50);
		await page.keyboard.press("End");
		await page.waitForTimeout(50);
		await page.keyboard.press(`${MOD}+Enter`);
		await page.waitForTimeout(1500);
		const html = sends[0]?.html ?? "";
		// The demo mailbox has a default signature, so the body is the typed line,
		// the blank lines typed after it, then the signature; nothing after that.
		const ok = sends.length === 1 && html.startsWith("<p>Hello</p>") && !html.includes("<br>Hello") && !html.includes("Hello<br>") &&
			count(html, 'class="email-signature"') === 1 && !/<p(\s[^>]*)?>(<br>)?<\/p>$/.test(html);
		return { ok, detail: { sends: sends.length, html: html.slice(0, 120), tail: html.slice(-60) } };
	},

	/** "- " starts a list, Tab nests, Enter on an empty item outdents and then leaves the list. */
	async "list-keys"(page) {
		await openNew(page, { to: "", subject: "" });
		for (const step of ["- one", "Enter", "two", "Enter", "Tab", "nested", "Enter", "Enter", "Enter", "after"]) {
			if (["Enter", "Tab"].includes(step)) await page.keyboard.press(step);
			else await page.keyboard.type(step);
		}
		const html = await editorHtml(page);
		const want = "<ul><li><p>one</p></li><li><p>two</p><ul><li><p>nested</p></li></ul></li></ul><p>after</p>";
		return { ok: html.replace(/<li>/g, "<li>").includes(want) || html.includes(want.replace(/<li><p>/g, "<li>").replace(/<\/p><\/li>/g, "</li>")), detail: { html } };
	},

	/** "1. " starts a numbered list; Shift+Tab outdents. */
	async "numbered-list-keys"(page) {
		await openNew(page, { to: "", subject: "" });
		await page.keyboard.type("1. first");
		await page.keyboard.press("Enter");
		await page.keyboard.press("Tab");
		await page.keyboard.type("sub");
		await page.keyboard.press("Enter");
		await page.keyboard.press("Shift+Tab");
		await page.keyboard.type("second");
		const html = await editorHtml(page);
		return { ok: /^<ol><li><p>first<\/p><ol><li><p>sub<\/p><\/li><\/ol><\/li><li><p>second<\/p><\/li><\/ol>/.test(html), detail: { html } };
	},

	/** Backspace at the start of a list item turns it back into a paragraph. */
	async "backspace-lifts-item"(page) {
		await openNew(page, { to: "", subject: "" });
		await page.keyboard.type("- item");
		await page.keyboard.press("Home");
		// Chromium reports the caret move a task later; a person never presses
		// the next key inside that gap, Playwright does.
		await page.waitForTimeout(50);
		await page.keyboard.press("Backspace");
		const html = await editorHtml(page);
		return { ok: html.startsWith("<p>item</p>"), detail: { html } };
	},

	/** Shift+Enter is a line break inside the paragraph. */
	async "shift-enter-line-break"(page) {
		await openNew(page, { to: "", subject: "" });
		await page.keyboard.type("a");
		await page.keyboard.press("Shift+Enter");
		await page.keyboard.type("b");
		const html = await editorHtml(page);
		return { ok: html.startsWith("<p>a<br>b</p>"), detail: { html } };
	},

	async "paste-plain-paragraphs"(page) {
		await openNew(page, { to: "", subject: "" });
		await paste(page, { text: "Para one\n\nPara two\nsecond line" });
		const html = await editorHtml(page);
		return { ok: html.startsWith("<p>Para one</p><p>Para two<br>second line</p>"), detail: { html } };
	},

	async "paste-markdown"(page) {
		await openNew(page, { to: "", subject: "" });
		await paste(page, { text: "## Title\n\n- a\n- b\n\n**bold** text and `code`" });
		const html = await editorHtml(page);
		return { ok: html.includes("<h2>Title</h2>") && html.includes("<ul>") && html.includes("<strong>bold</strong>") && html.includes("<code>code</code>"), detail: { html } };
	},

	/** Gmail and Apple Mail write a <div> per line; lines stay together, <div><br></div> is the paragraph break. */
	async "paste-div-per-line"(page) {
		await openNew(page, { to: "", subject: "" });
		await paste(page, {
			html: '<div dir="ltr"><div>Line one</div><div>Line two</div><div><br></div><div>Para two</div></div>',
			text: "Line one\nLine two\n\nPara two",
		});
		const html = await editorHtml(page);
		return { ok: html.startsWith("<p>Line one<br>Line two</p><p>Para two</p>"), detail: { html } };
	},

	/** Real clipboard HTML has newlines between the divs, and Gmail styles bold as a span. */
	async "paste-div-per-line-styled"(page) {
		await openNew(page, { to: "", subject: "" });
		await paste(page, {
			html: '<div>Hello <span style="font-weight:700">bold</span> text</div>\n<div>Second <span style="font-style:italic">line</span></div>\n<div><br></div>\n<div>Para two</div>',
			text: "Hello bold text\nSecond line\n\nPara two",
		});
		const html = await editorHtml(page);
		return { ok: html.startsWith("<p>Hello <strong>bold</strong> text<br>Second <em>line</em></p><p>Para two</p>"), detail: { html } };
	},

	/** Word lists with Symbol and Wingdings bullets become real lists without the bullet glyph. */
	async "paste-word-lists"(page) {
		await openNew(page, { to: "", subject: "" });
		const item = (font, glyph, text, cls) =>
			`<p class=${cls} style='mso-list:l0 level1 lfo1'><![if !supportLists]><span style='font-family:${font};mso-fareast-font-family:${font}'><span style='mso-list:Ignore'>${glyph}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><![endif]>${text}<o:p></o:p></p>`;
		const html =
			`<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta name=ProgId content=Word.Document></head><body>` +
			item("Symbol", "·", "Symbol one", "MsoListParagraphCxSpFirst") +
			item("Symbol", "·", "Symbol two", "MsoListParagraphCxSpLast") +
			"<p class=MsoNormal>Between<o:p></o:p></p>" +
			item("Wingdings", "§", "Wing one", "MsoListParagraphCxSpFirst") +
			item("Wingdings", "§", "Wing two", "MsoListParagraphCxSpLast") +
			"</body></html>";
		await paste(page, { html, text: "Symbol one\nSymbol two\nBetween\nWing one\nWing two" });
		const out = await editorHtml(page);
		return { ok: count(out, "<ul>") === 2 && count(out, "<li>") === 4 && !/[·§]/.test(out), detail: { html: out } };
	},

	/** A pasted list at the end of a typed line starts on its own line, with every item kept. */
	async "paste-list-after-text"(page) {
		await openNew(page, { to: "", subject: "" });
		await page.keyboard.type("Look:");
		await paste(page, { html: "<ul><li>one</li><li>two</li></ul>", text: "one\ntwo" });
		const html = await editorHtml(page);
		return { ok: /^<p>Look:<\/p><ul><li><p>one<\/p><\/li><li><p>two<\/p><\/li><\/ul>/.test(html), detail: { html: html.slice(0, 200) } };
	},

	/** A screenshot on the clipboard (a file, no HTML) goes into the body as an image. */
	async "paste-image-file"(page) {
		await openNew(page, { to: "", subject: "" });
		await page.keyboard.type("Look:");
		await paste(page, { pngFile: true });
		const html = await editorHtml(page);
		return { ok: /<img[^>]+src="data:image\/png;base64,/.test(html), detail: { html: html.slice(0, 160) } };
	},

	/** A linked image copied from a page keeps its link: the HTML wins over the clipboard's bitmap. */
	async "paste-linked-image-with-file"(page) {
		await openNew(page, { to: "", subject: "" });
		await paste(page, {
			html: '<a href="https://example.com/report"><img src="https://example.com/chart.png" alt="chart"></a>',
			pngFile: true,
		});
		const html = await editorHtml(page);
		return { ok: /<img[^>]+src="https:\/\/example\.com\/chart\.png"/.test(html) && !html.includes("data:image/png"), detail: { html: html.slice(0, 200) } };
	},

	/** Pasting a URL over selected words links them. */
	async "paste-url-over-selection"(page) {
		await openNew(page, { to: "", subject: "" });
		await page.keyboard.type("the docs");
		await page.keyboard.press("Shift+Home");
		// As in backspace-lifts-item: let Chromium report the new selection.
		await page.waitForTimeout(50);
		await paste(page, { text: "https://example.com/docs" });
		const html = await editorHtml(page);
		return { ok: /<a[^>]+href="https:\/\/example\.com\/docs"[^>]*>the docs<\/a>/.test(html), detail: { html } };
	},

	/** Select All then a URL replaces the body, as in every editor; it does not link all of it. */
	async "paste-url-over-select-all"(page) {
		await openNew(page, { to: "", subject: "" });
		await page.keyboard.type("first line");
		await page.keyboard.press("Enter");
		await page.keyboard.type("second line");
		await page.keyboard.press(`${MOD}+a`);
		await page.waitForTimeout(50);
		await paste(page, { text: "https://example.com/a" });
		const html = await editorHtml(page);
		const text = await editorText(page);
		return {
			ok: !text.includes("first line") && !text.includes("second line") && text.includes("https://example.com/a"),
			detail: { html: html.slice(0, 200) },
		};
	},

	/** An image copied in Finder carries its file name as text; the paste is the image. */
	async "paste-finder-image"(page) {
		await openNew(page, { to: "", subject: "" });
		await page.keyboard.type("Look:");
		await paste(page, { text: "screenshot.png", pngFile: true });
		const html = await editorHtml(page);
		// The name may be the image's alt text, but not text in the body.
		const text = await editorText(page);
		return {
			ok: /<img[^>]+src="data:image\/png;base64,/.test(html) && !text.includes("screenshot.png"),
			detail: { text, html: html.slice(0, 160) },
		};
	},

	/** Dangerous links and form controls never get in. */
	async "paste-hostile-html"(page) {
		await openNew(page, { to: "", subject: "" });
		await paste(page, {
			html: '<p><a href="javascript:alert(1)">click</a> ok <img src="x" onerror="alert(2)"><input value="x"></p><script>alert(3)</script><a href="tel:+15550100">call</a>',
			text: "click ok call",
		});
		const html = await editorHtml(page);
		return { ok: !/javascript:|onerror|<input|<script/i.test(html) && html.includes('href="tel:+15550100"'), detail: { html } };
	},

	/** Typing autolinks real URLs, not code-like words, and keeps brackets outside the link. */
	async "autolink-typing"(page) {
		await openNew(page, { to: "", subject: "" });
		await page.keyboard.type("see https://example.com/a and env.DEV_AUTH_BYPASS or (https://x.example/b) now ");
		const html = await editorHtml(page);
		const ok = html.includes('href="https://example.com/a"') && !/href="[^"]*DEV_AUTH/.test(html) && html.includes('href="https://x.example/b"') && !html.includes('href="https://x.example/b)"');
		return { ok, detail: { html } };
	},

	/** Inserting a template is one undo step, and undo goes back to the typed text. */
	async "template-insert-undo"(page) {
		await openNew(page, { to: "", subject: "" });
		await page.keyboard.type("hello there");
		// The demo mailbox has a signature, so compare with the whole body.
		const before = await editorText(page);
		await page.getByRole("button", { name: "Insert template" }).click();
		const item = page.getByRole("menuitem").filter({ hasNotText: /Create one/ }).first();
		await item.click();
		await page.waitForTimeout(600);
		const withTemplate = await editorText(page);
		await caretToEnd(page);
		await page.keyboard.press(`${MOD}+z`);
		await page.waitForTimeout(300);
		const after = await editorText(page);
		return { ok: withTemplate.length > before.length + 10 && after === before, detail: { withTemplate: withTemplate.slice(0, 80), before: before.slice(0, 80), after: after.slice(0, 80) } };
	},

	/**
	 * Undo in one draft never brings back another draft's text, when the open
	 * composer switches to another draft. Two reply drafts in one conversation:
	 * the thread stays beside the composer, so its Edit buttons move the same
	 * editor from one draft to the other. A page load would mount a new editor,
	 * with no history to leak.
	 */
	async "undo-stays-in-its-draft"(page) {
		const r = await switchDrafts(page, {
			a: "<p>Alpha draft unique-alpha-word</p>",
			b: "<p>Bravo draft text</p>",
			edit: async () => page.keyboard.type(" typed"),
		});
		return {
			ok: r.before.includes("unique-alpha-word typed") && r.sameEditor && r.subjectIsB && !r.text.includes("unique-alpha-word") && r.text === "Bravo draft text",
			detail: r,
		};
	},

	/**
	 * The same, when the edit leaves the first draft's body equal to the
	 * second's. Nothing loads then, so only the history reset on the switch
	 * keeps undo from putting the deleted words back.
	 */
	async "undo-stays-in-its-draft-same-body"(page) {
		const tail = " unique-alpha-word";
		const r = await switchDrafts(page, {
			a: `<p>Hello from the lab${tail}</p>`,
			b: "<p>Hello from the lab</p>",
			edit: async () => {
				for (let i = 0; i < tail.length; i++) await page.keyboard.press("Backspace");
			},
		});
		return {
			ok: r.before === "Hello from the lab" && r.sameEditor && r.subjectIsB && r.text === "Hello from the lab",
			detail: r,
		};
	},

	/** A reopened draft puts the caret after its own text, above the signature, not at the top. */
	async "reopened-draft-caret-at-end"(page) {
		const body =
			"<p>Hi Maya,</p><p>Notes so far</p>" + '<div class="email-signature"><p>Sam Lee<br>Northwind</p></div>';
		await openDraft(page, await createDraft(body));
		// No click: type where the composer put the caret.
		await page.keyboard.type(" and more");
		const json = await editorJson(page);
		const paragraphs = json.content.filter((n) => n.type === "paragraph").map((n) => (n.content ?? []).map((c) => c.text ?? "").join(""));
		const signature = JSON.stringify(json.content.find((n) => n.type === "signatureBlock") ?? {});
		return {
			ok: paragraphs.includes("Notes so far and more") && paragraphs[0] === "Hi Maya," && !signature.includes("and more"),
			detail: { paragraphs },
		};
	},

	/** Signature blocks and tables survive an edit. */
	async "signature-and-table-survive"(page) {
		const saves = watchDraftSaves(page);
		const body =
			"<p>Hi,</p><table><tbody><tr><th>Plan</th><th>Price</th></tr><tr><td>Solo</td><td>$9</td></tr></tbody></table>" +
			'<div class="email-signature"><p>Maya Okafor<br>Northwind</p></div>';
		await openDraft(page, await createDraft(body));
		await page.locator(".ProseMirror p").first().click();
		await page.keyboard.press("End");
		await page.keyboard.type(" team");
		const saved = (await saveDraft(page, saves))?.body ?? "";
		return { ok: saved.includes('class="email-signature"') && saved.includes("<table") && saved.includes("<td") && saved.includes("Hi, team"), detail: { saved: saved.slice(0, 400) } };
	},

	/** Typing stays fast in a long draft (a long quoted thread). */
	async "long-draft-typing-speed"(page) {
		const para = "<p>" + "Quoted text from an earlier message in a long thread, with enough words to wrap. ".repeat(2) + "</p>";
		await openDraft(page, await createDraft(`<p>Top</p><blockquote>${para.repeat(400)}</blockquote>`));
		await page.locator(".ProseMirror p").first().click();
		await page.keyboard.press("End");
		const t0 = Date.now();
		await page.keyboard.type(" quick reply typed at the top of a long thread", { delay: 0 });
		const ms = (Date.now() - t0) / 46;
		return { ok: ms < 40, detail: { msPerKey: Math.round(ms * 10) / 10 } };
	},
};

// ── run ────────────────────────────────────────────────────────────────

const results = [];
for (const [name, fn] of Object.entries(cases)) {
	if (ONLY.length && !ONLY.includes(name)) continue;
	const page = await ctx.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("dialog", (d) => d.dismiss().catch(() => {}));
	let r;
	try {
		r = await fn(page);
	} catch (e) {
		r = { ok: false, detail: { error: String(e.message ?? e).split("\n")[0] } };
	}
	if (errors.length) r.detail = { ...r.detail, pageErrors: errors.slice(0, 3) };
	if (!r.ok) await page.screenshot({ path: join(OUT, `fail-${name}.png`) }).catch(() => {});
	results.push({ name, ...r });
	console.log(`${r.ok ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(r.detail).slice(0, 400)}`);
	await page.close();
}
writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
await browser.close();
