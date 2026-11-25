/**
 * How the composer's editor loads, writes and undoes a body: blank lines and
 * line breaks make the round trip unchanged, a load leaves no undo step and no
 * history from the previous draft, inserts are one undo step, Cmd+Enter types
 * nothing, and pastes of lists, images and URLs over words do what mail
 * clients do. Same extension list as Editor.tsx.
 */

import "./fixtures/paste/harness/jsdom-globals";
import { Editor } from "@tiptap/core";
import TiptapImage from "@tiptap/extension-image";
import LinkExtension from "@tiptap/extension-link";
import { TableKit } from "@tiptap/extension-table/kit";
import TextAlign from "@tiptap/extension-text-align";
import Underline from "@tiptap/extension-underline";
import { undoDepth } from "@tiptap/pm/history";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { endOfMessageText, insertAsOneStep, patchContent, replaceContent } from "~/components/mail/editor-history";
import { MailKeys } from "~/components/mail/mail-keys";
import { SignatureBlock } from "~/components/mail/signature-node";
import {
	ClearFormatting,
	LINK_OPTIONS,
	PasteCleanup,
	SafeColor,
	SafeHighlight,
	SafeTextStyle,
} from "~/components/mail/paste-extension";
import {
	editorBodyHtml,
	normalizeEditorInput,
	serializeEditorHtml,
	trimTrailingEmptyParagraphs,
} from "~/lib/editor-html";

let editor: Editor | null = null;

function makeEditor(content = "", onPasteFiles?: (files: File[]) => void) {
	editor = new Editor({
		element: document.body.appendChild(document.createElement("div")),
		extensions: [
			StarterKit.configure({ link: false, underline: false }),
			MailKeys,
			Underline,
			TextAlign.configure({ types: ["heading", "paragraph"] }),
			LinkExtension.configure(LINK_OPTIONS),
			TiptapImage.configure({ allowBase64: true }),
			SafeTextStyle,
			SafeColor,
			SafeHighlight.configure({ multicolor: true }),
			TableKit.configure({ table: { resizable: false } }),
			SignatureBlock,
			PasteCleanup.configure({ onPasteFiles: onPasteFiles ?? null }),
			ClearFormatting,
		],
		content: normalizeEditorInput(content),
	});
	return editor;
}

function firePaste(ed: Editor, data: { html?: string; text?: string; files?: File[] }) {
	const flavours: Record<string, string> = { "text/plain": data.text ?? "", "text/html": data.html ?? "" };
	const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
	Object.defineProperty(event, "clipboardData", {
		value: {
			getData: (type: string) => flavours[type] ?? "",
			types: [...Object.keys(flavours).filter((t) => flavours[t]), ...(data.files?.length ? ["Files"] : [])],
			files: data.files ?? [],
		},
	});
	const input = (ed.view as unknown as { input: { shiftKey: boolean; lastKeyCode: number } }).input;
	input.shiftKey = false;
	input.lastKeyCode = 86;
	ed.view.dom.dispatchEvent(event);
}

function pressModEnter(ed: Editor) {
	const mac = /Mac/.test(navigator.platform);
	const event = new window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true });
	ed.view.dom.dispatchEvent(event);
	return event;
}

afterEach(() => {
	editor?.destroy();
	editor = null;
	document.body.innerHTML = "";
});

describe("editor-html", () => {
	it("reads <p><br></p> and <div><br></div> as empty lines and writes them as <p><br></p>", () => {
		expect(normalizeEditorInput("<p>a</p><p><br></p><p>b</p>")).toBe("<p>a</p><p></p><p>b</p>");
		expect(normalizeEditorInput('<div><br></div><div dir="ltr"><br/></div>')).toBe("<p></p><p></p>");
		expect(serializeEditorHtml('<p>a</p><p></p><p style="text-align: center"></p>')).toBe(
			'<p>a</p><p><br></p><p style="text-align: center"><br></p>',
		);
	});

	it("drops a line break that ends a block, which browsers draw as nothing", () => {
		expect(normalizeEditorInput("<p>a<br></p><li>b<br /></li>")).toBe("<p>a</p><li>b</li>");
		expect(normalizeEditorInput("<p>a<br>b</p>")).toBe("<p>a<br>b</p>");
	});

	it("keeps a signature wrapper that holds only a line break", () => {
		const sig = '<div class="email-signature"><br></div>';
		expect(normalizeEditorInput(sig)).toBe('<div class="email-signature"></div>');
	});

	it("trims empty paragraphs at the end only", () => {
		expect(trimTrailingEmptyParagraphs("<p>a</p><p><br></p><p>b</p><p><br></p><p></p>")).toBe(
			"<p>a</p><p><br></p><p>b</p>",
		);
	});

	it("a body makes the round trip through the editor unchanged", () => {
		for (const body of [
			"<p>Hi Maya,</p><p><br></p><p>Thanks for the call.</p>",
			"<p>One<br>Two</p><ul><li><p>a</p></li><li><p>b</p></li></ul>",
			'<p><br></p><div class="email-signature"><p>— Team</p></div>',
		]) {
			expect(editorBodyHtml(makeEditor(body))).toBe(body);
			editor?.destroy();
		}
	});

	it("a blank line opens as one empty paragraph, not a paragraph holding a break", () => {
		const ed = makeEditor("<p>a</p><p><br></p><p>b</p>");
		const kinds: string[] = [];
		ed.state.doc.forEach((node) => kinds.push(`${node.type.name}:${node.textContent}:${node.childCount}`));
		expect(kinds).toEqual(["paragraph:a:1", "paragraph::0", "paragraph:b:1"]);
	});
});

describe("replaceContent", () => {
	it("loads without an update event or an undo step", () => {
		const ed = makeEditor("<p>first</p>");
		const onUpdate = vi.fn();
		ed.on("update", onUpdate);
		replaceContent(ed, "<p>second</p>");
		expect(ed.getHTML()).toBe("<p>second</p>");
		expect(onUpdate).not.toHaveBeenCalled();
		expect(undoDepth(ed.state)).toBe(0);
		expect(ed.commands.undo()).toBe(false);
		expect(ed.getHTML()).toBe("<p>second</p>");
	});

	it("clears the history, so undo can't reach the previous draft", () => {
		const ed = makeEditor("<p>draft A</p>");
		ed.commands.insertContentAt(ed.state.doc.content.size - 1, " typed");
		expect(undoDepth(ed.state)).toBe(1);
		replaceContent(ed, "<p>draft B</p>");
		expect(undoDepth(ed.state)).toBe(0);
		ed.commands.undo();
		ed.commands.undo();
		expect(ed.getHTML()).toBe("<p>draft B</p>");
		// Typing after the load still undoes normally.
		ed.commands.insertContentAt(ed.state.doc.content.size - 1, "!");
		expect(ed.getHTML()).toBe("<p>draft B!</p>");
		ed.commands.undo();
		expect(ed.getHTML()).toBe("<p>draft B</p>");
	});
});

describe("replaceContent: the caret", () => {
	it("starts at the first line, not inside the signature at the end", () => {
		const ed = makeEditor();
		replaceContent(ed, '<p></p><div class="email-signature"><p>— Team</p></div>');
		expect(ed.state.selection.from).toBe(1);
		expect(ed.state.selection.$from.parent.type.name).toBe("paragraph");
		expect(ed.state.selection.$from.depth).toBe(1);
	});
});

describe("endOfMessageText: where a reopened draft's caret goes", () => {
	const before = (ed: Editor) => ed.state.doc.textBetween(0, endOfMessageText(ed.state.doc), "|");

	it("after the last line of text, above the signature", () => {
		const ed = makeEditor('<p>Hi Maya,</p><p>Notes so far</p><div class="email-signature"><p>— Sam</p></div>');
		expect(before(ed)).toBe("Hi Maya,|Notes so far");
	});

	it("after the reply text, above a quote with no signature", () => {
		const ed = makeEditor("<p>Thanks, will do</p><p></p><blockquote><p>On Mon, a@example.com wrote:</p><p>Hi</p></blockquote><p></p>");
		expect(before(ed)).toBe("Thanks, will do|");
	});

	it("at the end of a draft with neither", () => {
		const ed = makeEditor("<p>One</p><ul><li><p>two</p></li></ul>");
		expect(endOfMessageText(ed.state.doc)).toBe(ed.state.doc.content.size - 3);
		expect(before(ed)).toBe("One|two");
	});

	it("at the first line when the signature is all there is", () => {
		const ed = makeEditor('<div class="email-signature"><p>— Sam</p></div>');
		// Inside the signature's first line (1 is the block, 2 its paragraph), as "start" would be.
		expect(endOfMessageText(ed.state.doc)).toBe(2);
	});
});

describe("patchContent", () => {
	const sig = (name: string) => `<div class="email-signature"><p>— ${name}</p></div>`;

	it("swaps a signature without moving the caret, firing update or touching undo", () => {
		const ed = makeEditor(`<p></p>${sig("Team A")}`);
		ed.commands.setTextSelection(1);
		ed.commands.insertContent("Hello");
		const caret = ed.state.selection.from;
		const onUpdate = vi.fn();
		ed.on("update", onUpdate);
		patchContent(ed, `<p>Hello</p>${sig("Team B")}`);
		expect(editorBodyHtml(ed)).toBe(`<p>Hello</p>${sig("Team B")}`);
		expect(ed.state.selection.from).toBe(caret);
		expect(onUpdate).not.toHaveBeenCalled();
		// Undo takes back the typing, and leaves the new signature.
		ed.commands.undo();
		expect(editorBodyHtml(ed)).toBe(`<p><br></p>${sig("Team B")}`);
	});

	it("adds a signature that arrives after the user started typing", () => {
		const ed = makeEditor("<p></p>");
		ed.commands.setTextSelection(1);
		ed.commands.insertContent("Draft");
		patchContent(ed, `<p>Draft</p>${sig("Team")}`);
		expect(editorBodyHtml(ed)).toBe(`<p>Draft</p>${sig("Team")}`);
		expect(ed.state.selection.from).toBe(6);
	});

	it("does nothing when the document already matches", () => {
		const ed = makeEditor("<p>same</p>");
		const before = ed.state;
		patchContent(ed, "<p>same</p>");
		expect(ed.state).toBe(before);
	});
});

describe("insertAsOneStep", () => {
	it("one undo removes the whole insert and nothing typed before it", () => {
		const ed = makeEditor("<p>hello there</p>");
		ed.commands.focus("end");
		ed.commands.insertContent("!");
		insertAsOneStep(ed, ed.state.selection.from, "<p>Template line one</p><p>Line two</p>");
		expect(ed.getText()).toContain("Line two");
		ed.commands.undo();
		expect(ed.getHTML()).toBe("<p>hello there!</p>");
	});

	it("keepCaret leaves the selection where it was", () => {
		const ed = makeEditor("<p>abc</p>");
		ed.commands.setTextSelection(2);
		insertAsOneStep(ed, ed.state.doc.content.size, '<div class="email-signature"><p>— Team</p></div>', {
			keepCaret: true,
		});
		expect(ed.state.selection.from).toBe(2);
		expect(ed.getHTML()).toContain("email-signature");
	});
});

describe("Mod-Enter", () => {
	it("types no line break, and the keydown still reaches the composer", () => {
		const ed = makeEditor("<p>Hello</p>");
		ed.commands.focus("end");
		const seen = vi.fn();
		document.body.addEventListener("keydown", seen);
		pressModEnter(ed);
		document.body.removeEventListener("keydown", seen);
		expect(ed.getHTML()).toBe("<p>Hello</p>");
		expect(seen).toHaveBeenCalledTimes(1);
	});
});

describe("paste", () => {
	it("a list pasted after text starts a list of its own", () => {
		const ed = makeEditor("<p>Look:</p>");
		ed.commands.focus("end");
		firePaste(ed, { html: "<ul><li>one</li><li>two</li></ul>", text: "one\ntwo" });
		expect(ed.getHTML()).toMatch(/^<p>Look:<\/p><ul><li><p>one<\/p><\/li><li><p>two<\/p><\/li><\/ul>/);
	});

	it("a list pasted inside a list item still joins that list", () => {
		const ed = makeEditor("<ul><li><p>zero</p></li></ul>");
		ed.commands.focus("end");
		firePaste(ed, { html: "<ul><li>one</li><li>two</li></ul>", text: "one\ntwo" });
		expect(ed.getHTML().match(/<ul>/g)).toHaveLength(1);
		expect(ed.getHTML()).toContain("<li><p>two</p></li>");
	});

	it("an image file goes to the host's handler, not into the text", () => {
		const onFiles = vi.fn();
		const ed = makeEditor("<p>a</p>", onFiles);
		ed.commands.focus("end");
		const file = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
		firePaste(ed, { files: [file] });
		expect(onFiles).toHaveBeenCalledWith([file]);
		expect(ed.getHTML()).toBe("<p>a</p>");
	});

	it("an image copied in Finder is the image, though its name comes as text", () => {
		const onFiles = vi.fn();
		const ed = makeEditor("<p>a</p>", onFiles);
		ed.commands.focus("end");
		const file = new File([new Uint8Array([137, 80, 78, 71])], "Screenshot 2026-11-24.png", { type: "image/png" });
		firePaste(ed, { text: "Screenshot 2026-11-24.png", files: [file] });
		expect(onFiles).toHaveBeenCalledWith([file]);
		firePaste(ed, { text: "/Users/sam/Desktop/Screenshot 2026-11-24.png", files: [file] });
		expect(onFiles).toHaveBeenCalledTimes(2);
		expect(ed.getHTML()).toBe("<p>a</p>");
	});

	it("an image beside copied text is the text (Word, Excel)", () => {
		const onFiles = vi.fn();
		const ed = makeEditor("", onFiles);
		ed.commands.focus("end");
		const file = new File([new Uint8Array([1])], "image.png", { type: "image/png" });
		firePaste(ed, { html: "<p>Quarterly numbers</p>", text: "Quarterly numbers", files: [file] });
		expect(onFiles).not.toHaveBeenCalled();
		expect(ed.getText()).toContain("Quarterly numbers");
	});

	it("a URL pasted over words links the words", () => {
		const ed = makeEditor("<p>read the docs today</p>");
		ed.commands.setTextSelection({ from: 6, to: 14 });
		firePaste(ed, { text: "https://example.com/docs" });
		expect(ed.getHTML()).toBe('<p>read <a target="_blank" rel="noopener noreferrer nofollow" href="https://example.com/docs">the docs</a> today</p>');
	});

	it("a URL pasted over Select All replaces the body, it doesn't link all of it", () => {
		const ed = makeEditor("<p>first line</p><p>second line</p>");
		ed.commands.selectAll();
		firePaste(ed, { text: "https://example.com/a" });
		expect(ed.getText()).toBe("https://example.com/a");
		expect(ed.getText()).not.toContain("first line");
	});

	it("a URL pasted over words in two paragraphs replaces them", () => {
		const ed = makeEditor("<p>one two</p><p>three four</p>");
		ed.commands.setTextSelection({ from: 5, to: 12 });
		firePaste(ed, { text: "https://example.com/a" });
		expect(ed.getText()).not.toContain("three");
		expect(ed.getHTML()).not.toContain(">two");
	});

	it("an email address pasted over words links them with mailto", () => {
		const ed = makeEditor("<p>write to support</p>");
		ed.commands.setTextSelection({ from: 10, to: 17 });
		firePaste(ed, { text: "help@example.com" });
		expect(ed.getHTML()).toContain('href="mailto:help@example.com"');
		expect(ed.getHTML()).toContain(">support</a>");
	});

	it("a URL pasted with nothing selected is inserted as a link", () => {
		const ed = makeEditor("<p>see </p>");
		ed.commands.focus("end");
		firePaste(ed, { text: "https://example.com/a" });
		expect(ed.getHTML()).toContain('href="https://example.com/a"');
		expect(ed.getText()).toContain("https://example.com/a");
	});
});
