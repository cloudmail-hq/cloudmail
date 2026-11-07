/**
 * Clipboard cleanup for the composer.
 *
 * Pasted HTML keeps its structure (headings, paragraphs, lists, quotes, code,
 * tables, links, images, bold/italic/underline/strike) and loses its
 * presentation: every `style`, `class`, `id`, `data-*` and `aria-*`
 * attribute, `<mark>`, `<font>`, and the source's colours, backgrounds, fonts,
 * sizes and spacing. Mail with no explicit colours renders correctly in every
 * client and in both composer themes. Mail that keeps a terminal's white text
 * without its black background does not.
 *
 * Everything here is a pure function of a string. The DOM work uses
 * `DOMParser`, whose documents are inert: no script runs and no image loads
 * while we look at pasted markup. The cleaner itself is an allowlist, and
 * DOMPurify runs over its output as a separate security pass.
 *
 * Source-specific steps run before styles are dropped, because they read
 * them:
 * - Word: `MsoListParagraph` runs and `·`/NBSP fake bullets become real
 *   lists. `<o:p>`, conditional comments and `mso-` styles go.
 * - Google Docs: the `<b id="docs-internal-guid-…">` wrapper is unwrapped,
 *   and spans styled bold/italic/underline/strike become the matching tags.
 * - Code: a pasted `<pre>` is rebuilt from all of its text (or its `<code>`
 *   when it has one), so a chat UI's language header no longer replaces the
 *   code. Monospace `white-space: pre` blocks (VS Code, iTerm2) become code
 *   blocks. Language labels next to a block are dropped.
 * - Emoji: WhatsApp and Discord emoji images become their alt text.
 * - Plain-looking HTML (spans and line breaks only) is classified like plain
 *   text, so terminal output and pasted Markdown get the same treatment
 *   whether or not the source added a `text/html` flavour.
 */

import DOMPurify from "dompurify";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

export type PasteKind = "html" | "markdown" | "terminal" | "text";

export interface CleanResult {
	html: string;
	/**
	 * How many presentational things were dropped: style attributes carrying
	 * colour, background, font or spacing, `<font>` attributes, and `<mark>`
	 * elements. Zero means the cleaned paste looks like the source.
	 */
	removed: number;
	/** What the paste turned out to be. Only `html` keeps the source's markup. */
	kind: PasteKind;
	/** `data:` images left out for being over PASTED_DATA_IMAGE_MAX_BYTES. */
	droppedImages: number;
}

/**
 * Pasted `data:` images. Below the floor they are spacers, tracking pixels and
 * emoji sprites (WhatsApp ships 1x1 GIFs behind every emoji). Above the
 * ceiling they would take a large share of the message size limit and belong
 * in an attachment. Real screenshots and photos sit in between and are kept
 * inline, as the toolbar's image button already does. The sizes are of the
 * decoded image.
 */
export const PASTED_DATA_IMAGE_MIN_BYTES = 1024;
export const PASTED_DATA_IMAGE_MAX_BYTES = 1024 * 1024;

/** Tags that survive, after renaming (h4–h6 to h3, strike/del to s, kbd to code). */
const KEEP_TAGS = new Set([
	"p", "div", "br", "h1", "h2", "h3", "ul", "ol", "li", "blockquote", "hr",
	"pre", "code", "b", "strong", "i", "em", "u", "s", "a", "img",
	"table", "thead", "tbody", "tfoot", "tr", "th", "td",
]);

const RENAME: Record<string, string> = {
	h4: "h3", h5: "h3", h6: "h3",
	strike: "s", del: "s",
	kbd: "code", samp: "code", tt: "code",
};

/** Removed with their content. Everything else that is not kept is unwrapped. */
const DROP_TAGS = new Set([
	"script", "style", "meta", "link", "title", "head", "base", "noscript",
	"template", "iframe", "frame", "frameset", "object", "embed", "applet",
	"param", "svg", "math", "canvas", "video", "audio", "source", "track",
	"form", "button", "select", "option", "optgroup", "textarea", "datalist",
	"map", "area", "dialog", "xml", "o:p",
]);

const BLOCK_TAGS = new Set([
	"p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
	"blockquote", "pre", "table", "thead", "tbody", "tfoot", "tr", "td", "th",
	"hr", "section", "article", "header", "footer", "main", "aside", "nav",
	"figure", "figcaption", "address", "dl", "dt", "dd", "details", "summary",
	"caption",
]);

const PRESENTATION_PROPS =
	/^(color|background|background-color|background-image|font|font-family|font-size|line-height|mso-highlight)$/;

const MONO_FONT =
	/monospace|menlo|monaco|consolas|courier|sf ?mono|fira (code|mono)|jetbrains|source code|ubuntu mono|dejavu sans mono|cascadia|roboto mono|plex mono|inconsolata|\bhack\b/i;

/** Language names a chat UI prints above its code blocks. */
const CODE_LABELS = new Set([
	"bash", "sh", "shell", "zsh", "fish", "console", "terminal", "powershell", "ps1", "cmd", "bat",
	"typescript", "ts", "tsx", "javascript", "js", "jsx", "json", "jsonc", "yaml", "yml", "toml",
	"ini", "xml", "html", "css", "scss", "sass", "less", "sql", "graphql", "python", "py", "ruby",
	"rb", "php", "go", "golang", "rust", "rs", "java", "kotlin", "swift", "c", "cpp", "c++",
	"csharp", "c#", "cs", "objective-c", "scala", "elixir", "erlang", "haskell", "lua", "perl",
	"r", "dart", "dockerfile", "docker", "makefile", "diff", "text", "plaintext", "txt",
	"markdown", "md", "nginx", "hcl", "terraform", "vue", "svelte", "latex", "tex",
]);

const EMOJI_CDN =
	/(cdn\.discordapp\.com\/emojis|discord(app)?\.com\/assets|twemoji|emoji\.slack-edge\.com|static\.whatsapp\.net\/emoji|web\.whatsapp\.com\/img|fonts\.gstatic\.com\/s\/e\/notoemoji|githubassets\.com\/images\/icons\/emoji|emojicdn)/i;

// ── Small helpers ──────────────────────────────────────────────────

function parseStyle(style: string | null): Map<string, string> {
	const out = new Map<string, string>();
	if (!style) return out;
	for (const decl of style.split(";")) {
		const i = decl.indexOf(":");
		if (i < 0) continue;
		const prop = decl.slice(0, i).trim().toLowerCase();
		const value = decl.slice(i + 1).trim().toLowerCase();
		if (prop) out.set(prop, value);
	}
	return out;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function parseDocument(html: string): Document {
	return new DOMParser().parseFromString(html, "text/html");
}

function tagOf(node: Node): string {
	return node.nodeType === 1 ? (node as Element).localName.toLowerCase() : "";
}

function unwrap(el: Element): void {
	const parent = el.parentNode;
	if (!parent) return;
	while (el.firstChild) parent.insertBefore(el.firstChild, el);
	el.remove();
}

function rename(el: Element, tag: string): Element {
	const next = el.ownerDocument.createElement(tag);
	while (el.firstChild) next.appendChild(el.firstChild);
	for (const attr of [...el.attributes]) next.setAttribute(attr.name, attr.value);
	el.replaceWith(next);
	return next;
}

/**
 * The text of an element with its line structure: `<br>` and block
 * boundaries become newlines. NBSP becomes a space. Trailing newlines go.
 */
function blockText(root: Node): string {
	let out = "";
	const walk = (node: Node) => {
		if (node.nodeType === 3) {
			out += (node as Text).data;
			return;
		}
		if (node.nodeType !== 1) return;
		const tag = tagOf(node);
		if (tag === "br") {
			out += "\n";
			return;
		}
		if (DROP_TAGS.has(tag)) return;
		const block = BLOCK_TAGS.has(tag);
		if (block && out && !out.endsWith("\n")) out += "\n";
		node.childNodes.forEach(walk);
		if (block && out && !out.endsWith("\n")) out += "\n";
	};
	walk(root);
	return out.replace(/\u00a0/g, " ").replace(/\n+$/, "");
}

function significantSibling(node: Node, dir: "previousSibling" | "nextSibling"): Node | null {
	let n = node[dir];
	while (n && ((n.nodeType === 3 && !(n as Text).data.trim()) || n.nodeType === 8)) n = n[dir];
	return n;
}

// ── Plain text ─────────────────────────────────────────────────────

/** Which Markdown constructs a text uses. Two or more, or a fence, means Markdown. */
export function markdownSignals(text: string): Set<string> {
	const s = new Set<string>();
	if (/^#{1,6}\s+\S/m.test(text)) s.add("heading");
	if (/^\s*(?:[-*+]|\d{1,3}[.)])\s+\S/m.test(text)) s.add("list");
	if (/^\s*(?:```|~~~)/m.test(text)) s.add("fence");
	if (/(\*\*|__)(?=\S)[^\n]*?\S\1/.test(text)) s.add("bold");
	if (/\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\)/.test(text)) s.add("link");
	if (/`[^`\n]+`/.test(text)) s.add("code");
	if (/^\s*\|.+\|\s*$/m.test(text) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/m.test(text)) {
		s.add("table");
	}
	return s;
}

/**
 * A shell prompt at the start of a line: `$ cmd`, `% cmd`, `❯ cmd`,
 * `user@host:~/dir$ cmd`, `user@host ~/dir % cmd`, PowerShell and Python.
 * The command must start like a command (letter, `.`, `/`, `~`), so a price
 * list (`$ 10 a month`) or a sentence holding an address and a `#` or `$`
 * is not a prompt.
 */
const PROMPT_LINE =
	/^\s*(?:(?:[\w.-]+@[\w.-]+(?::\S*)?(?:\s+[~/]\S*)?\s*)?[$%#❯➜]\s+[A-Za-z./~]|PS [A-Za-z]:\\[^>]*>\s?|>>>\s)/;
const BOX_DRAWING = /[─-╿⏺⎿]/;

/**
 * Plain text: Markdown (2+ signals or a fence), terminal output (a prompt line
 * or box drawing), or prose. A single line is always prose, and WhatsApp-style
 * `*bold*` doesn't count as Markdown.
 */
export function classifyPlainText(text: string): "markdown" | "terminal" | "text" {
	const normalised = text.replace(/\r\n?/g, "\n");
	const lines = normalised.split("\n").filter((l) => l.trim());
	if (lines.length < 2) return "text";
	const signals = markdownSignals(normalised);
	// A fence is unambiguous Markdown. Otherwise a prompt line or box drawing
	// wins over the softer signals: CLI output is full of `-` flags, numbered
	// steps, `#` comments and backticks that would otherwise count as Markdown.
	if (signals.has("fence")) return "markdown";
	if (lines.some((l) => PROMPT_LINE.test(l) || BOX_DRAWING.test(l))) return "terminal";
	if (signals.size >= 2) return "markdown";
	return "text";
}

/** Prose: blank lines separate paragraphs, single newlines are line breaks. */
export function plainTextToHtml(text: string): string {
	const normalised = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
	if (!normalised.trim()) return "";
	return normalised
		.split(/\n[ \t]*\n/)
		.filter((block) => block.trim())
		.map((block) => `<p>${block.split("\n").map(escapeHtml).join("<br>")}</p>`)
		.join("");
}

/** One code block, exact text. */
export function terminalToHtml(text: string): string {
	const normalised = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
	return `<pre><code>${escapeHtml(normalised)}</code></pre>`;
}

/** CommonMark plus GFM (tables, task lists, strike), raw HTML escaped, then cleaned. */
export function markdownToHtml(text: string): string {
	const html = micromark(text.replace(/\r\n?/g, "\n"), {
		extensions: [gfm()],
		htmlExtensions: [gfmHtml()],
	});
	return cleanTree(parseDocument(html)).html;
}

/** The text of pasted HTML, for "Paste as plain text" when the clipboard had no text flavour. */
export function htmlToPlainText(html: string): string {
	return blockText(parseDocument(html).body);
}

// ── Colours ────────────────────────────────────────────────────────

/** WCAG relative luminance of a parsed sRGB colour. */
function luminance([r, g, b]: number[]): number {
	const f = (v: number) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

const NAMED: Record<string, [number, number, number]> = {
	black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0],
	blue: [0, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128], purple: [128, 0, 128],
	maroon: [128, 0, 0], navy: [0, 0, 128], teal: [0, 128, 128], olive: [128, 128, 0],
	orange: [255, 165, 0], yellow: [255, 255, 0], silver: [192, 192, 192],
};

/** `[r, g, b, alpha]` for hex, rgb()/rgba() and a few names; null for anything else. */
export function parseCssColor(value: string): [number, number, number, number] | null {
	const v = value.trim().toLowerCase().replace(/\s*!important$/, "");
	const hex = /^#([0-9a-f]{3,8})$/.exec(v);
	if (hex) {
		let h = hex[1];
		if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
		if (h.length !== 6 && h.length !== 8) return null;
		const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
		return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
	}
	const rgb = /^rgba?\(([^)]+)\)$/.exec(v);
	if (rgb) {
		const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
		if (parts.length < 3) return null;
		const channel = (p: string) => (p.endsWith("%") ? (parseFloat(p) * 255) / 100 : parseFloat(p));
		const [r, g, b] = parts.slice(0, 3).map(channel);
		const a = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
		if ([r, g, b, a].some((x) => Number.isNaN(x))) return null;
		return [r, g, b, a];
	}
	if (v in NAMED) return [...NAMED[v], 1];
	return null;
}

/**
 * Stored text colours must read at 3:1 on white and on the dark composer
 * (`#14171f`), the two backgrounds a message is most often shown on. That
 * keeps luminance between 0.125 and 0.30. A threshold of 0.85 for
 * "near-white" wasn't enough: the paste baseline found `#c7c7c7` (0.57) and
 * WhatsApp's `#e9edef` (0.84) unreadable on white.
 */
export const STORED_COLOR_MIN_LUMINANCE = 0.125;
export const STORED_COLOR_MAX_LUMINANCE = 0.3;

/**
 * The colour to keep for a stored `color:` value, or null to drop it.
 * Drops CSS variables, keywords (`currentColor`, `inherit`, `transparent`),
 * anything unparseable, mostly transparent colours, and colours outside the
 * readable band above.
 */
export function readableStoredColor(value: string | null | undefined): string | null {
	if (!value) return null;
	const v = value.trim().replace(/['"]+/g, "");
	if (!v || /var\(|currentcolor|inherit|initial|unset|revert|transparent/i.test(v)) return null;
	const parsed = parseCssColor(v);
	if (!parsed || parsed[3] < 0.5) return null;
	const l = luminance(parsed);
	if (l < STORED_COLOR_MIN_LUMINANCE || l > STORED_COLOR_MAX_LUMINANCE) return null;
	return v;
}

// ── HTML ───────────────────────────────────────────────────────────

function isEmojiText(text: string): boolean {
	const t = text.trim();
	return !!t && t.length <= 16 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(t) && !/[A-Za-z0-9]{2,}/.test(t);
}

function convertEmojiImages(body: HTMLElement): void {
	for (const img of [...body.querySelectorAll("img")]) {
		const alt = img.getAttribute("alt") ?? "";
		const plain = img.getAttribute("data-plain-text") ?? "";
		const src = img.getAttribute("src") ?? "";
		const cls = img.getAttribute("class") ?? "";
		const style = parseStyle(img.getAttribute("style"));
		const size = Math.max(
			parseFloat(img.getAttribute("width") ?? "") || 0,
			parseFloat(img.getAttribute("height") ?? "") || 0,
			parseFloat(style.get("width") ?? "") || 0,
			parseFloat(style.get("height") ?? "") || 0,
		);
		const emojiHint = /emoji/i.test(cls) || EMOJI_CDN.test(src) || !!plain || img.hasAttribute("data-emoji");
		const small = size > 0 && size <= 48;
		const text = plain || alt;
		if (
			(isEmojiText(text) && (emojiHint || small)) ||
			(emojiHint && /^:[\w~+-]+:$/.test(alt))
		) {
			img.replaceWith(body.ownerDocument.createTextNode(text));
		}
	}
}

function isWordListParagraph(el: Element): boolean {
	if (tagOf(el) !== "p") return false;
	return /MsoListParagraph/i.test(el.getAttribute("class") ?? "") || /mso-list\s*:\s*l\d+/i.test(el.getAttribute("style") ?? "");
}

/**
 * A typed list marker followed by Word's padding (two or more spaces/NBSP).
 * `§` is not here: it starts legal section headings. Word's real symbol-font
 * bullets carry `mso-list` and are found by isWordListParagraph instead.
 */
const FAKE_BULLET = /^[\s\u00a0]*([·•▪◦o\-–]|\d{1,3}[.)]|[a-zA-Z][.)])[\s\u00a0]{2,}/;

/** Word writes list items as paragraphs with a typed marker. Rebuild real lists. */
function rebuildWordLists(body: HTMLElement): void {
	const doc = body.ownerDocument;
	const isItem = (el: Element) =>
		isWordListParagraph(el) || (tagOf(el) === "p" && FAKE_BULLET.test(el.textContent ?? ""));

	for (const start of [...body.querySelectorAll("p")]) {
		if (!start.isConnected || !isItem(start)) continue;
		const prev = significantSibling(start, "previousSibling");
		if (prev && prev.nodeType === 1 && isItem(prev as Element)) continue;

		const group: Element[] = [];
		for (let n: Node | null = start; n && n.nodeType === 1 && isItem(n as Element); n = significantSibling(n, "nextSibling")) {
			group.push(n as Element);
		}
		// Without Word's own list markup, one paragraph that starts "A.  " or
		// "1.  " is a sentence, not a list. Two in a row is a list.
		if (group.length < 2 && !isWordListParagraph(group[0])) continue;

		const items = group.map((p) => {
			const style = p.getAttribute("style") ?? "";
			const level = Number(/level(\d+)/i.exec(style)?.[1] ?? "1");
			let marker = "";
			const ignore = [...p.querySelectorAll("span")].find((s) => /mso-list\s*:\s*ignore/i.test(s.getAttribute("style") ?? ""));
			if (ignore) {
				marker = (ignore.textContent ?? "").replace(/[\s\u00a0]+/g, "");
				ignore.remove();
			} else {
				// Strip the typed marker and its padding, which Word may split
				// over several text nodes: remove that many leading characters.
				const m = FAKE_BULLET.exec(p.textContent ?? "");
				if (m) {
					marker = m[1];
					let left = m[0].length;
					const walker = doc.createTreeWalker(p, 4);
					for (let t = walker.nextNode() as Text | null; t && left > 0; t = walker.nextNode() as Text | null) {
						const take = Math.min(left, t.data.length);
						t.data = t.data.slice(take);
						left -= take;
					}
				}
			}
			// The marker's NBSP padding sometimes sits in its own text nodes:
			// trim leading whitespace until the first real character.
			const lead = doc.createTreeWalker(p, 4);
			for (let t = lead.nextNode() as Text | null; t; t = lead.nextNode() as Text | null) {
				t.data = t.data.replace(/^[\s\u00a0]+/, "");
				if (t.data) break;
			}
			const ordered = /^(\d+|[a-zA-Z]|[ivxlcdm]+)[.)]$/i.test(marker);
			return { p, level: Math.max(1, level), ordered };
		});

		const listTag = (ordered: boolean) => (ordered ? "ol" : "ul");
		const roots: Element[] = [doc.createElement(listTag(items[0].ordered))];
		const stack: { level: number; list: Element }[] = [{ level: items[0].level, list: roots[0] }];
		for (const item of items) {
			let top = stack[stack.length - 1];
			// Bullets after numbers (or the reverse) at the outer level start a
			// new list rather than joining the other kind.
			if (stack.length === 1 && item.level <= top.level && tagOf(top.list) !== listTag(item.ordered)) {
				const next = doc.createElement(listTag(item.ordered));
				roots.push(next);
				stack[0] = { level: top.level, list: next };
				top = stack[0];
			}
			while (item.level > top.level) {
				const parentLi = top.list.lastElementChild ?? top.list.appendChild(doc.createElement("li"));
				const nested = doc.createElement(item.ordered ? "ol" : "ul");
				parentLi.appendChild(nested);
				stack.push({ level: top.level + 1, list: nested });
				top = stack[stack.length - 1];
			}
			while (item.level < top.level && stack.length > 1) {
				stack.pop();
				top = stack[stack.length - 1];
			}
			const li = doc.createElement("li");
			while (item.p.firstChild) li.appendChild(item.p.firstChild);
			top.list.appendChild(li);
		}
		group[0].replaceWith(...roots);
		for (const p of group.slice(1)) p.remove();
	}
}

function languageOf(code: Element | null): string | null {
	const m = /(?:^|\s)(?:language|lang)-([\w+#-]+)/.exec(code?.getAttribute("class") ?? "");
	return m ? m[1].toLowerCase() : null;
}

function labelText(el: Element): string | null {
	if (el.querySelector("pre, code, table, ul, ol, img, p, h1, h2, h3, h4, h5, h6")) return null;
	const t = (el.textContent ?? "").replace(/\b(copy( code)?|edit|run)\b/gi, "").trim().toLowerCase();
	return t && CODE_LABELS.has(t) ? t : null;
}

function makeCodeBlock(doc: Document, text: string, lang: string | null): Element {
	const pre = doc.createElement("pre");
	const code = doc.createElement("code");
	if (lang && /^[\w+#-]+$/.test(lang)) code.setAttribute("class", `language-${lang}`);
	code.textContent = text;
	pre.appendChild(code);
	return pre;
}

/** Rebuild every `<pre>` from its whole text, dropping chat-UI headers and labels. */
function normaliseCodeBlocks(body: HTMLElement): void {
	const doc = body.ownerDocument;
	for (const pre of [...body.querySelectorAll("pre")]) {
		if (!pre.isConnected || pre.parentElement?.closest("pre")) continue;
		const codes = [...pre.querySelectorAll("code")];
		let lang = languageOf(codes[0] ?? null);
		// A header inside the <pre> (ChatGPT's "bash" bar) names the language.
		// Remove such labels, then take the text of the whole <pre>: code
		// outside a <code>, or split across several inline <code> tokens, is
		// all kept, on the lines it was on.
		for (const el of [...pre.querySelectorAll("div, span")]) {
			if (!el.isConnected || codes.some((c) => el.contains(c) || c.contains(el))) continue;
			const label = labelText(el);
			if (label) {
				lang ??= label;
				el.remove();
			}
		}
		const text = blockText(pre);
		const prev = pre.previousElementSibling;
		if (prev && tagOf(prev) !== "p" && !/^h\d$/.test(tagOf(prev))) {
			const label = labelText(prev);
			if (label) {
				lang ??= label;
				prev.remove();
			}
		}
		pre.replaceWith(makeCodeBlock(doc, text, lang));
	}
}

/** VS Code and terminals paste monospace divs with `white-space: pre`, not `<pre>`. */
function convertMonospaceBlocks(body: HTMLElement): void {
	const doc = body.ownerDocument;
	for (const el of [...body.querySelectorAll("div, p")]) {
		if (!el.isConnected || el.closest("pre")) continue;
		const style = parseStyle(el.getAttribute("style"));
		if (!MONO_FONT.test(style.get("font-family") ?? "")) continue;
		if (el.querySelector("pre, table, ul, ol, h1, h2, h3, h4, h5, h6, blockquote, img")) continue;
		const text = blockText(el);
		const preWhitespace = /^(pre|pre-wrap|break-spaces)$/.test(style.get("white-space") ?? "");
		const multiLine = text.includes("\n");
		if (!preWhitespace && !multiLine) continue;
		if (!multiLine) {
			const code = doc.createElement("code");
			code.textContent = text;
			el.replaceWith(code);
			continue;
		}
		el.replaceWith(makeCodeBlock(doc, text, null));
	}
}

/** A `<b>`/`<strong>` that is not bold: Google Docs' whole-paste wrapper, or `font-weight: normal`. */
function isFakeBold(el: Element): boolean {
	return (
		/^docs-internal-guid/.test(el.getAttribute("id") ?? "") ||
		/^(normal|[1-4]00)$/.test(parseStyle(el.getAttribute("style")).get("font-weight") ?? "")
	);
}

/** Inside real bold already (a fake-bold wrapper doesn't count). */
function insideBold(el: Element): boolean {
	for (let n = el.parentElement; n; n = n.parentElement) {
		const t = tagOf(n);
		if (/^(h[1-6]|th)$/.test(t)) return true;
		if ((t === "b" || t === "strong") && !isFakeBold(n)) return true;
	}
	return false;
}

/** Google Docs and others style spans instead of using tags. Keep the meaning. */
function semanticSpans(body: HTMLElement): void {
	const doc = body.ownerDocument;
	for (const span of [...body.querySelectorAll("span")]) {
		if (span.closest("pre, code")) continue;
		const style = parseStyle(span.getAttribute("style"));
		const weight = style.get("font-weight") ?? "";
		const deco = `${style.get("text-decoration") ?? ""} ${style.get("text-decoration-line") ?? ""}`;
		const wrappers: string[] = [];
		if (/^(bold|bolder|[6-9]00)$/.test(weight) && !insideBold(span)) wrappers.push("strong");
		if (/^(italic|oblique)/.test(style.get("font-style") ?? "") && !span.closest("i, em")) wrappers.push("em");
		if (/underline/.test(deco) && !span.closest("a, u")) wrappers.push("u");
		if (/line-through/.test(deco) && !span.closest("s, strike, del")) wrappers.push("s");
		for (const tag of wrappers) {
			const w = doc.createElement(tag);
			while (span.firstChild) w.appendChild(span.firstChild);
			span.appendChild(w);
		}
	}
}

function allowedHref(href: string | null): string | null {
	if (!href) return null;
	// Browsers ignore control characters and whitespace inside a scheme.
	const compact = href.replace(/[\u0000- \u007f-\u009f]/g, "");
	return /^(https?:\/\/|mailto:)/i.test(compact) ? href.trim() : null;
}

/** Raster `data:` images only (never SVG), with their decoded size. */
function dataImageBytes(src: string): number | null {
	const data = /^data:image\/(png|jpe?g|gif|webp);base64,([a-z0-9+/=\s]+)$/i.exec(src.trim());
	return data ? Math.floor((data[2].replace(/\s/g, "").length * 3) / 4) : null;
}

function allowedImageSrc(src: string | null, counter: Counter): string | null {
	if (!src) return null;
	const s = src.trim();
	if (/^https:\/\//i.test(s)) return s;
	const bytes = dataImageBytes(s);
	if (bytes === null || bytes < PASTED_DATA_IMAGE_MIN_BYTES) return null;
	if (bytes > PASTED_DATA_IMAGE_MAX_BYTES) {
		// Reported, so the composer can say so instead of losing it silently.
		counter.droppedImages++;
		return null;
	}
	return s;
}

interface Counter {
	removed: number;
	droppedImages: number;
}

/** Allowlist walk: keep, rename, unwrap or drop each element; strip attributes. */
function sanitizeChildren(parent: Node, counter: Counter): void {
	for (const child of [...parent.childNodes]) {
		if (child.nodeType === 8 || child.nodeType === 7) {
			child.remove();
			continue;
		}
		if (child.nodeType !== 1) continue;
		const el = child as Element;
		let tag = tagOf(el);

		if (DROP_TAGS.has(tag) || tag.includes(":")) {
			el.remove();
			continue;
		}
		if (tag === "input") {
			const type = (el.getAttribute("type") ?? "").toLowerCase();
			if (type === "checkbox") el.replaceWith(el.ownerDocument.createTextNode(el.hasAttribute("checked") ? "☑ " : "☐ "));
			else el.remove();
			continue;
		}

		const style = parseStyle(el.getAttribute("style"));
		if ([...style.keys()].some((p) => PRESENTATION_PROPS.test(p)) || el.hasAttribute("bgcolor") || (tag === "font" && el.attributes.length > 0)) {
			counter.removed++;
		}

		sanitizeChildren(el, counter);

		if (tag === "mark") {
			counter.removed++;
			unwrap(el);
			continue;
		}
		// Google Docs' whole-paste wrapper, and any other "not actually bold" <b>.
		if ((tag === "b" || tag === "strong") && isFakeBold(el)) {
			unwrap(el);
			continue;
		}

		let target = el;
		if (RENAME[tag]) {
			target = rename(el, RENAME[tag]);
			tag = RENAME[tag];
		}
		if (!KEEP_TAGS.has(tag)) {
			unwrap(target);
			continue;
		}

		const keep: Record<string, string> = {};
		if (tag === "a") {
			const href = allowedHref(target.getAttribute("href"));
			if (!href) {
				unwrap(target);
				continue;
			}
			keep.href = href;
		} else if (tag === "img") {
			const src = allowedImageSrc(target.getAttribute("src"), counter);
			if (!src) {
				target.remove();
				continue;
			}
			keep.src = src;
			const alt = target.getAttribute("alt");
			if (alt) keep.alt = alt;
		} else if (tag === "td" || tag === "th") {
			for (const name of ["colspan", "rowspan"]) {
				const v = target.getAttribute(name);
				if (v && /^\d{1,3}$/.test(v)) keep[name] = v;
			}
		} else if (tag === "ol") {
			const v = target.getAttribute("start");
			if (v && /^\d{1,6}$/.test(v)) keep.start = v;
		} else if (tag === "code" && target.parentElement && tagOf(target.parentElement) === "pre") {
			const lang = languageOf(target);
			if (lang) keep.class = `language-${lang}`;
		}
		for (const attr of [...target.attributes]) target.removeAttribute(attr.name);
		for (const [name, value] of Object.entries(keep)) target.setAttribute(name, value);
	}
}

/** Docs nests `<ul>` directly in `<ul>`; move it into the item before it. */
function fixNestedLists(body: HTMLElement): void {
	for (const list of [...body.querySelectorAll("ul > ul, ul > ol, ol > ul, ol > ol")]) {
		const prev = list.previousElementSibling;
		if (prev && tagOf(prev) === "li") prev.appendChild(list);
		else {
			const li = list.ownerDocument.createElement("li");
			list.replaceWith(li);
			li.appendChild(list);
		}
	}
}

/** Spacer paragraphs and `<br>`s between blocks become margins, not blank lines. */
function collapseSpacing(body: HTMLElement): void {
	for (const el of [...body.querySelectorAll("p, div, h1, h2, h3, blockquote")].reverse()) {
		if (el.querySelector("img, hr, table, pre, ul, ol, li") || el.closest("td, th")) continue;
		if ((el.textContent ?? "").replace(/[\s\u00a0\u200b\ufeff]/g, "") === "") el.remove();
	}
	for (const br of [...body.querySelectorAll("br")]) {
		const parent = br.parentElement;
		if (!parent || !BLOCK_TAGS.has(tagOf(parent)) && parent !== body) continue;
		const prev = significantSibling(br, "previousSibling");
		const next = significantSibling(br, "nextSibling");
		const isBlock = (n: Node | null) => !n || (n.nodeType === 1 && BLOCK_TAGS.has(tagOf(n)));
		if (isBlock(prev) || isBlock(next)) br.remove();
	}
}

/** Pasted HTML that is only text in spans, divs and line breaks. */
function isPlainWrapper(body: HTMLElement): boolean {
	const allowed = new Set(["span", "div", "p", "br", "font"]);
	return !!body.textContent?.trim() && [...body.querySelectorAll("*")].every((el) => allowed.has(tagOf(el)) || DROP_TAGS.has(tagOf(el)));
}

const PURIFY_TAGS = [...KEEP_TAGS];
const PURIFY_ATTR = ["href", "src", "alt", "colspan", "rowspan", "start", "class"];

function purify(html: string): string {
	// Fail closed: without the security pass, paste nothing rather than
	// trusting the cleaner alone.
	if (!DOMPurify.isSupported) return "";
	return DOMPurify.sanitize(html, {
		ALLOWED_TAGS: PURIFY_TAGS,
		ALLOWED_ATTR: PURIFY_ATTR,
		ALLOW_DATA_ATTR: false,
		ALLOW_ARIA_ATTR: false,
	});
}

function cleanTree(doc: Document): CleanResult {
	const body = doc.body;
	const counter: Counter = { removed: 0, droppedImages: 0 };
	// Order matters: these read styles and classes that sanitizeChildren drops.
	convertEmojiImages(body);
	rebuildWordLists(body);
	normaliseCodeBlocks(body);
	convertMonospaceBlocks(body);
	semanticSpans(body);
	sanitizeChildren(body, counter);
	fixNestedLists(body);
	collapseSpacing(body);
	return { html: purify(body.innerHTML), removed: counter.removed, kind: "html", droppedImages: counter.droppedImages };
}

/** Clean pasted `text/html`. See the module comment for what is kept. */
export function cleanPastedHtml(html: string): CleanResult {
	const doc = parseDocument(html);
	if (isPlainWrapper(doc.body)) {
		const text = blockText(doc.body);
		const kind = classifyPlainText(text);
		if (kind === "markdown") return { html: markdownToHtml(text), removed: 0, kind, droppedImages: 0 };
		if (kind === "terminal") return { html: terminalToHtml(text), removed: 0, kind, droppedImages: 0 };
	}
	return cleanTree(doc);
}

/**
 * "Keep original formatting": the source markup with only the security pass
 * and the signature rule applied. The editor's schema then keeps colours that
 * pass `readableStoredColor` and highlights, and drops fonts, sizes and
 * backgrounds.
 */
const KEEP_ORIGINAL_TAGS = [...KEEP_TAGS, "span", "mark", "font", "sub", "sup", "del", "strike", "h4", "h5", "h6"];
const KEEP_ORIGINAL_ATTR = [...PURIFY_ATTR, "style", "data-color", "color"];

export function keepOriginalHtml(html: string): string {
	if (!DOMPurify.isSupported) return "";
	// An allowlist, like the default path, plus the presentational tags and
	// `style` that "keep original" is for. The editor schema decides what of
	// that survives (readable colours and highlights; no fonts or backgrounds).
	const safe = DOMPurify.sanitize(html, {
		ALLOWED_TAGS: KEEP_ORIGINAL_TAGS,
		ALLOWED_ATTR: KEEP_ORIGINAL_ATTR,
		ALLOW_DATA_ATTR: false,
		ALLOW_ARIA_ATTR: false,
	});
	const doc = parseDocument(safe);
	// Only our own signature insertion may create a signature block.
	for (const el of [...doc.body.querySelectorAll(".email-signature")]) el.classList.remove("email-signature");
	// Same image and link rules as a cleaned paste: https or raster data: in
	// the size band, never SVG; links only http(s) and mailto.
	const counter: Counter = { removed: 0, droppedImages: 0 };
	for (const img of [...doc.body.querySelectorAll("img")]) {
		const src = allowedImageSrc(img.getAttribute("src"), counter);
		if (src) img.setAttribute("src", src);
		else img.remove();
	}
	for (const a of [...doc.body.querySelectorAll("a")]) {
		if (!allowedHref(a.getAttribute("href"))) unwrap(a);
	}
	return doc.body.innerHTML;
}
