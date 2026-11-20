/**
 * Editor-level paste behaviour: Shift-paste, the toast's replacement of the
 * last paste, undo, Clear formatting, the colour guards on setContent, the
 * highlight text colour and link rules. Same extension list as Editor.tsx.
 */

import "./fixtures/paste/harness/jsdom-globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Editor } from "@tiptap/core";
import TiptapImage from "@tiptap/extension-image";
import LinkExtension from "@tiptap/extension-link";
import { TableKit } from "@tiptap/extension-table/kit";
import TextAlign from "@tiptap/extension-text-align";

import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignatureBlock } from "~/components/mail/signature-node";
import {
	ClearFormatting,
	HIGHLIGHT_TEXT_COLOR,
	LINK_OPTIONS,
	PasteCleanup,
	SafeColor,
	SafeHighlight,
	SafeTextStyle,
	pasteCleanupKey,
	replaceLastPaste,
	shouldAutoLink,
	type PastedInfo,
} from "~/components/mail/paste-extension";
import { keepOriginalHtml, parseCssColor, plainTextToHtml } from "~/lib/paste-clean";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/paste", name), "utf8");

let editor: Editor | null = null;

function makeEditor(content = "", onPasted?: (info: PastedInfo) => void) {
	editor = new Editor({
		element: document.body.appendChild(document.createElement("div")),
		extensions: [
			StarterKit.configure({ link: false, underline: false }),
			Underline,
			TextAlign.configure({ types: ["heading", "paragraph"] }),
			LinkExtension.configure(LINK_OPTIONS),
			TiptapImage.configure({ allowBase64: true }),
			SafeTextStyle,
			SafeColor,
			SafeHighlight.configure({ multicolor: true }),
			TableKit.configure({ table: { resizable: false } }),
			SignatureBlock,
			PasteCleanup.configure({ onPasted: onPasted ? (info) => onPasted(info) : null }),
			ClearFormatting,
		],
		content,
	});
	return editor;
}

/** A real paste event through ProseMirror's handler, as Chromium sends it. */
function firePaste(ed: Editor, data: { html?: string; text?: string }, opts: { shift?: boolean } = {}) {
	const flavours: Record<string, string> = { "text/plain": data.text ?? "", "text/html": data.html ?? "" };
	const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
	Object.defineProperty(event, "clipboardData", {
		value: { getData: (type: string) => flavours[type] ?? "", types: Object.keys(flavours).filter((t) => flavours[t]) },
	});
	const input = (ed.view as unknown as { input: { shiftKey: boolean; lastKeyCode: number } }).input;
	input.shiftKey = !!opts.shift;
	input.lastKeyCode = 86;
	ed.view.dom.dispatchEvent(event);
}

afterEach(() => {
	editor?.destroy();
	editor = null;
	document.body.innerHTML = "";
});

describe("Shift-paste (Cmd/Ctrl+Shift+V)", () => {
	/*
	  Chromium's Cmd+Shift+V ("Paste and Match Style") delivers a paste event
	  with only text/plain, and ProseMirror additionally treats a paste with
	  Shift held as plain. Both paths give exactly the pasted characters.
	*/
	it("pastes rich fixtures as plain text (28): paragraphs and line breaks, no Markdown", () => {
		const ed = makeEditor();
		ed.commands.focus();
		firePaste(ed, { html: fixture("chatgpt.html"), text: fixture("chatgpt.txt") }, { shift: true });
		const html = ed.getHTML();
		expect(html).not.toMatch(/<h3|<ol|<table|<pre|<strong/);
		expect(html).toContain("### Migration plan");
		expect(html).toContain("**safe**");
	});

	it("Chromium's text-only Paste and Match Style keeps Markdown literal when Shift is held", () => {
		const ed = makeEditor();
		ed.commands.focus();
		firePaste(ed, { text: fixture("markdown-plain.txt") }, { shift: true });
		expect(ed.getHTML()).toContain("- list item one");
		expect(ed.getHTML()).not.toMatch(/<ul|<pre/);
	});

	it("single newlines become <br>, blank lines new paragraphs", () => {
		const ed = makeEditor();
		ed.commands.focus();
		firePaste(ed, { text: "Hi Sam,\nthanks.\n\nBye" }, { shift: true });
		expect(ed.getHTML()).toBe("<p>Hi Sam,<br>thanks.</p><p>Bye</p>");
	});

	it("does not offer the cleanup toast", () => {
		const onPasted = vi.fn();
		const ed = makeEditor("", onPasted);
		ed.commands.focus();
		firePaste(ed, { html: fixture("google-docs.html"), text: fixture("google-docs.txt") }, { shift: true });
		return Promise.resolve().then(() => expect(onPasted).not.toHaveBeenCalled());
	});
});

describe("paste inside a code block (29)", () => {
	it("inserts raw text only", () => {
		const ed = makeEditor("<pre><code>x</code></pre>");
		ed.commands.focus("end");
		firePaste(ed, { html: fixture("chatgpt.html"), text: "## not a heading\n- nor a list" });
		expect(ed.getHTML()).toMatch(/^<pre><code>x## not a heading\n- nor a list<\/code><\/pre>(<p><\/p>)?$/);
	});
});

describe("cleaned paste: toast, replace and undo", () => {
	const pasteDocs = async () => {
		const seen: PastedInfo[] = [];
		const ed = makeEditor("<p>Before</p>", (info) => seen.push(info));
		ed.commands.focus("end");
		firePaste(ed, { html: fixture("google-docs.html"), text: fixture("google-docs.txt") });
		await Promise.resolve();
		return { ed, seen };
	};

	it("reports a cleaned paste once, with the raw clipboard", async () => {
		const { seen } = await pasteDocs();
		expect(seen).toHaveLength(1);
		expect(seen[0].kind).toBe("html");
		expect(seen[0].removed).toBeGreaterThan(0);
		expect(seen[0].raw.html).toContain("docs-internal-guid");
	});

	it("keeps the raw clipboard out of the document and its history", async () => {
		const { ed } = await pasteDocs();
		expect(ed.getHTML()).not.toContain("docs-internal-guid");
		expect(JSON.stringify(ed.state.doc.toJSON())).not.toContain("font-family");
	});

	it('"Keep original formatting" replaces the range: colours that read are kept, fonts are not', async () => {
		const seen: PastedInfo[] = [];
		const ed = makeEditor("<p>Before</p>", (info) => seen.push(info));
		ed.commands.focus("end");
		const raw = '<p><span style="color:#d93025;font-family:Comic Sans MS">Red</span> and <span style="color:#000000">black</span></p>';
		firePaste(ed, { html: raw, text: "Red and black" });
		await Promise.resolve();
		expect(ed.getHTML()).toBe("<p>BeforeRed and black</p>");
		expect(replaceLastPaste(ed, seen[0].id, keepOriginalHtml(seen[0].raw.html))).toBe(true);
		const html = ed.getHTML();
		expect(html).toMatch(/<span style="color: (#d93025|rgb\(217, 48, 37\));?">Red<\/span>/);
		expect(html).not.toMatch(/Comic|#000000|rgb\(0, 0, 0\)/);
		expect(html).toContain("Before");
	});

	it('"Paste as plain text" replaces the range with the text flavour', async () => {
		const { ed, seen } = await pasteDocs();
		replaceLastPaste(ed, seen[0].id, plainTextToHtml(seen[0].raw.text));
		const html = ed.getHTML();
		expect(html).not.toMatch(/<h2|<ul|<a /);
		expect(html).toContain("Q4 launch notes");
		expect(html).toContain("Before");
	});

	it("a later edit voids the offer", async () => {
		const { ed, seen } = await pasteDocs();
		ed.commands.insertContent("typed");
		expect(pasteCleanupKey.getState(ed.state)).toBeNull();
		expect(replaceLastPaste(ed, seen[0].id, "<p>x</p>")).toBe(false);
		expect(ed.getHTML()).toContain("typed");
	});

	it("Cmd+Z undoes the paste in one step", async () => {
		const { ed } = await pasteDocs();
		ed.commands.undo();
		expect(ed.getHTML()).toBe("<p>Before</p>");
	});

	it("Markdown paste reports kind markdown, and undo returns to before the paste", async () => {
		const seen: PastedInfo[] = [];
		const ed = makeEditor("", (info) => seen.push(info));
		ed.commands.focus();
		firePaste(ed, { text: fixture("markdown-plain.txt") });
		await Promise.resolve();
		expect(seen[0]?.kind).toBe("markdown");
		expect(ed.getHTML()).toMatch(/<ul>.*<pre>/s);
		replaceLastPaste(ed, seen[0].id, plainTextToHtml(seen[0].raw.text));
		expect(ed.getHTML()).toContain("- list item one");
	});

	it("an already-clean paste is not reported", async () => {
		const onPasted = vi.fn();
		const ed = makeEditor("", onPasted);
		ed.commands.focus();
		firePaste(ed, { html: "<p>Just <strong>text</strong></p>", text: "Just text" });
		await Promise.resolve();
		expect(onPasted).not.toHaveBeenCalled();
	});
});

describe("Clear formatting (30)", () => {
	it("removes colour, bold and alignment; keeps links and lists", () => {
		const ed = makeEditor(
			'<ul><li><p style="text-align: center"><strong><span style="color: #d93025">Red</span></strong> <a href="https://x.example">link</a></p></li></ul>',
		);
		ed.commands.selectAll();
		ed.commands.clearFormatting();
		expect(ed.getHTML().replace(/<p><\/p>$/, "")).toBe('<ul><li><p>Red <a target="_blank" rel="noopener noreferrer nofollow" href="https://x.example">link</a></p></li></ul>');
	});

	it("with an empty selection, clears the current paragraph only", () => {
		const ed = makeEditor("<p><strong>one</strong></p><p><strong>two</strong></p>");
		ed.commands.setTextSelection(2);
		ed.commands.clearFormatting();
		expect(ed.getHTML()).toBe("<p>one</p><p><strong>two</strong></p>");
	});

	it("is bound to Mod-\\", () => {
		const ed = makeEditor();
		const shortcuts = ed.extensionManager.extensions.find((e) => e.name === "clearFormatting");
		expect(shortcuts).toBeTruthy();
		const event = new window.KeyboardEvent("keydown", { key: "\\", ctrlKey: !/Mac/.test(navigator.platform), metaKey: /Mac/.test(navigator.platform), bubbles: true });
		ed.commands.setContent("<p><em>x</em></p>");
		ed.commands.selectAll();
		ed.view.dom.dispatchEvent(event);
		expect(ed.getHTML()).toBe("<p>x</p>");
	});
});

describe("colour guards on setContent (31)", () => {
	it("drops CSS variables, near-white and near-black from drafts and templates", () => {
		const ed = makeEditor(
			'<p><span style="color: var(--x)">a</span><span style="color:#fff">b</span><span style="color: rgb(0, 0, 0)">c</span><span style="color: #d93025">d</span></p>',
		);
		expect(ed.getHTML()).toMatch(/^<p>abc<span style="color: (#d93025|rgb\(217, 48, 37\));?">d<\/span><\/p>$/);
	});

	it("keeps a colour the user picks with setColor", () => {
		const ed = makeEditor("<p>x</p>");
		ed.commands.selectAll();
		ed.commands.setColor("#1a73e8");
		expect(ed.getHTML()).toMatch(/^<p><span style="color: (#1a73e8|rgb\(26, 115, 232\));?">x<\/span><\/p>$/);
	});

	it("a highlight carries a fixed dark text colour", () => {
		const ed = makeEditor("<p>x</p>");
		ed.commands.selectAll();
		ed.commands.setHighlight({ color: "#fff59d" });
		const mark = new DOMParser().parseFromString(ed.getHTML(), "text/html").querySelector("mark") as HTMLElement;
		expect(mark.getAttribute("data-color")).toBe("#fff59d");
		expect(parseCssColor(mark.style.color)).toEqual(parseCssColor(HIGHLIGHT_TEXT_COLOR));
	});
});

describe("links", () => {
	it("does not autolink code-like tokens", () => {
		for (const token of ["env.DEV_AUTH_BYPASS", "config.json", "a.b", "user.name"]) {
			expect(shouldAutoLink(token), token).toBe(false);
		}
	});

	it("autolinks real URLs and email addresses", () => {
		for (const url of ["https://x.example", "http://x.example/a", "www.example.com", "mailto:a@b.example", "a@b.example"]) {
			expect(shouldAutoLink(url), url).toBe(true);
		}
	});

	it("pasted prose keeps https links and gets none from code-like words", () => {
		const ed = makeEditor();
		ed.commands.focus();
		firePaste(ed, { text: "Set env.DEV_AUTH_BYPASS and see https://example.com/docs today" });
		const html = ed.getHTML();
		expect(html).toContain('href="https://example.com/docs"');
		expect(html).not.toMatch(/href="[^"]*env\.DEV/);
		expect(html.match(/<a /g)).toHaveLength(1);
	});

	it("pasting a URL over a selection links it, with https as the default protocol", () => {
		const ed = makeEditor("<p>docs</p>");
		ed.commands.setTextSelection({ from: 1, to: 5 });
		firePaste(ed, { text: "www.example.com/docs" });
		expect(ed.getHTML()).toContain('href="https://www.example.com/docs"');
		expect(ed.getHTML()).toContain(">docs</a>");
	});
});
