/**
 * Paste baseline for the composer (app/components/mail/Editor.tsx).
 *
 * Builds a headless TipTap editor with the same extension list as Editor.tsx
 * and pastes each clipboard fixture in test/fixtures/paste/ through
 * ProseMirror's own paste path (`view.pasteHTML` / `view.pasteText`), so
 * TipTap's parse rules decide what survives, as they do in the browser.
 *
 * Each fixture is checked for the outcomes we want after the paste fix:
 *   - no background-color
 *   - no color (the user picked none; a paste must not choose one for them)
 *   - no font-family, font-size or line-height
 *   - structure kept: headings, lists, bold, links, code blocks, tables
 *
 * The baseline (PR #164) ran 14 of these as `it.fails`; the paste cleanup
 * fixed all of them. KNOWN_BROKEN stays for any future tracked gap. The
 * browser baseline and the after run (screenshots, contrast) live in
 * test/fixtures/paste/baseline/ and test/fixtures/paste/after/.
 */

// First: the DOM globals TipTap and ProseMirror need at import time.
import "./fixtures/paste/harness/jsdom-globals";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Editor } from "@tiptap/core";
import TiptapImage from "@tiptap/extension-image";
import LinkExtension from "@tiptap/extension-link";
import { TableKit } from "@tiptap/extension-table/kit";
import TextAlign from "@tiptap/extension-text-align";

import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { SignatureBlock } from "~/components/mail/signature-node";
import {
	ClearFormatting,
	LINK_OPTIONS,
	PasteCleanup,
	SafeColor,
	SafeHighlight,
	SafeTextStyle,
} from "~/components/mail/paste-extension";

const FIXTURES = join(__dirname, "fixtures/paste");

type Check = "no background" | "no color" | "no font styles" | "structure kept";

/**
 * Known failures, run as `it.fails`. The 14 from the baseline (PR #164) are
 * fixed by the paste cleanup; add an entry here only for a known, tracked gap.
 */
const KNOWN_BROKEN: Record<string, Check[]> = {};

/** What each source's structure should become after a paste. */
const STRUCTURE: Record<string, (doc: Document) => void> = {
	"terminal-app": (d) => {
		expect(d.querySelector("pre")?.textContent).toContain("1 failed, 41 passed");
	},
	iterm2: (d) => {
		// Terminal output is monospace text: it belongs in one code block.
		expect(d.querySelector("pre")?.textContent).toContain("881ff10");
	},
	vscode: (d) => {
		expect(d.querySelector("pre")?.textContent).toContain("export function isDevBypass");
		// `env.DEV_AUTH_BYPASS` is code, not a link to http://env.DEV.
		expect(d.querySelectorAll("a")).toHaveLength(0);
	},
	"whatsapp-web": (d) => {
		// Emoji sprites become the emoji itself, inline in one paragraph.
		expect(d.querySelectorAll("img")).toHaveLength(0);
		expect(d.body.textContent).toContain("🙏");
		expect(d.querySelector("strong")?.textContent).toBe("deck");
		expect(d.querySelectorAll("p")).toHaveLength(1);
	},
	discord: (d) => {
		expect(d.querySelector("strong")?.textContent).toBe("done");
		expect(d.querySelector("em")?.textContent).toBe("ok");
		expect(d.querySelector("pre")?.textContent).toContain("curl -s");
		expect(d.querySelector("p code")?.textContent).toBe("@oncall");
	},
	chatgpt: (d) => {
		expect(d.querySelector("h3")?.textContent).toBe("Migration plan");
		expect(d.querySelectorAll("ol > li")).toHaveLength(3);
		expect(d.querySelector("ul a")?.getAttribute("href")).toBe("https://developers.cloudflare.com/workers/");
		// The command sits in the code block, not in a paragraph after it.
		expect(d.querySelector("pre")?.textContent).toContain("wrangler r2 object get");
		expect(d.querySelectorAll("table th")).toHaveLength(2);
		expect(d.querySelectorAll("table td")).toHaveLength(4);
	},
	"claude-web": (d) => {
		expect(d.querySelector("h3")?.textContent).toBe("Summary");
		expect(d.querySelectorAll("ul > li")).toHaveLength(2);
		expect(d.querySelectorAll("li strong")).toHaveLength(2);
		expect(d.querySelector("p code")?.textContent).toBe("parseDraft");
		expect(d.querySelector("pre")?.textContent).toContain("const subject");
		expect(d.querySelectorAll("table td")).toHaveLength(4);
	},
	"google-docs": (d) => {
		expect(d.querySelector("h2")?.textContent).toBe("Q4 launch notes");
		expect(d.querySelector("strong")?.textContent).toBe("Nov 18");
		expect(d.querySelector("a")?.getAttribute("href")).toBe("https://docs.google.com/document/d/abc/edit");
		expect(d.querySelectorAll("ul > li")).toHaveLength(2);
		// Docs' `<br>` between blocks must not become a blank paragraph.
		expect(emptyParagraphsBetweenBlocks(d)).toBe(0);
	},
	"ms-word": (d) => {
		expect(d.querySelector("strong")?.textContent).toBe("Board update");
		// Word's fake bullets (Symbol "·" plus nbsp runs) become a real list.
		expect(d.querySelectorAll("ul > li")).toHaveLength(2);
		expect(d.body.textContent).not.toContain("·");
		expect(emptyParagraphsBetweenBlocks(d)).toBe(0);
	},
	"white-text-dark-site": (d) => {
		expect(d.querySelector("strong")?.textContent).toBe("unlimited seats");
		expect(d.querySelector("a")?.getAttribute("href")).toBe("https://example.com/billing");
	},
	"dark-text": (d) => {
		expect(d.querySelector("em")?.textContent).toBe("APAC");
		expect(d.querySelectorAll("p")).toHaveLength(2);
	},
	gmail: (d) => {
		expect(d.querySelector("strong")?.textContent).toBe("Tuesday's");
		expect(d.body.textContent).toContain("Hitesh");
	},
	"markdown-plain": (d) => {
		// Plain text that is clearly Markdown is rendered as Markdown.
		expect(d.querySelector("strong")?.textContent).toBe("Shipped");
		expect(d.querySelectorAll("ul > li")).toHaveLength(2);
		expect(d.querySelector("pre")?.textContent).toContain("npm run deploy");
		expect(d.body.textContent).not.toContain("```");
	},
};

/** Blank paragraphs sitting between two blocks with content (ignores the trailing one). */
function emptyParagraphsBetweenBlocks(d: Document): number {
	const blocks = [...d.body.children];
	return blocks.filter(
		(el, i) =>
			el.tagName === "P" &&
			el.textContent!.replace(/ /g, "").trim() === "" &&
			i > 0 &&
			i < blocks.length - 1,
	).length;
}

function loadFixtures() {
	const names = [
		...new Set(
			readdirSync(FIXTURES)
				.filter((f) => /\.(html|txt)$/.test(f))
				.map((f) => f.replace(/\.(html|txt)$/, "")),
		),
	].sort();
	return names.map((name) => {
		const read = (ext: string) => {
			const p = join(FIXTURES, `${name}.${ext}`);
			return existsSync(p) ? readFileSync(p, "utf8") : null;
		};
		return { name, html: read("html"), text: read("txt") ?? "" };
	});
}

/** Same extensions, same configuration, same order as Editor.tsx. */
function makeEditor() {
	return new Editor({
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
			PasteCleanup,
			ClearFormatting,
		],
		content: "",
	});
}

let editor: Editor | null = null;

/**
 * Fires a `paste` event carrying both clipboard flavours at the editor, so
 * ProseMirror's own paste handler runs as it does in a browser. (`view.pasteText`
 * would always take the Shift-paste path, which skips Markdown handling.)
 */
function firePaste(ed: Editor, data: { html?: string | null; text?: string }, opts: { shift?: boolean } = {}) {
	const flavours: Record<string, string> = {
		"text/plain": data.text ?? "",
		"text/html": data.html ?? "",
	};
	const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
	Object.defineProperty(event, "clipboardData", {
		value: { getData: (type: string) => flavours[type] ?? "", types: Object.keys(flavours).filter((t) => flavours[t]) },
	});
	// ProseMirror reads Shift from the last key event to decide on a plain paste.
	(ed.view as unknown as { input: { shiftKey: boolean; lastKeyCode: number } }).input.shiftKey = !!opts.shift;
	(ed.view as unknown as { input: { lastKeyCode: number } }).input.lastKeyCode = 86;
	ed.view.dom.dispatchEvent(event);
}

/** Pastes a fixture into a fresh editor and returns editor.getHTML(). */
function paste(fx: { html: string | null; text: string }, opts: { shift?: boolean } = {}): string {
	editor = makeEditor();
	editor.commands.focus();
	firePaste(editor, fx, opts);
	return editor.getHTML();
}

afterEach(() => {
	editor?.destroy();
	editor = null;
	document.body.innerHTML = "";
});

const fixtures = loadFixtures();

describe("composer paste baseline", () => {
	it("loads every fixture", () => {
		expect(fixtures.map((f) => f.name)).toEqual(Object.keys(STRUCTURE).sort());
	});

	for (const fx of fixtures) {
		describe(fx.name, () => {
			const check = (name: Check, fn: () => void) =>
				(KNOWN_BROKEN[fx.name]?.includes(name) ? it.fails : it)(name, fn);

			check("no background", () => {
				expect(paste(fx)).not.toMatch(/background(-color)?\s*:/i);
			});
			check("no color", () => {
				expect(paste(fx)).not.toMatch(/(^|[;"\s])color\s*:/i);
			});
			check("no font styles", () => {
				expect(paste(fx)).not.toMatch(/font-family|font-size|line-height|<font\b/i);
			});
			check("structure kept", () => {
				const doc = new DOMParser().parseFromString(paste(fx), "text/html");
				STRUCTURE[fx.name](doc);
			});
		});
	}
});
