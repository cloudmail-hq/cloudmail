import { htmlToTextLines } from "./html-text";

/**
 * Plain-text bodies as editor-friendly HTML.
 *
 * Agents and API clients (CLI `draft create --body`, MCP `update_draft`) often
 * write a draft as plain text: blank lines between paragraphs, "- " bullets,
 * bare URLs. Stored as is, HTML rendering collapses all of it into one run, in
 * the reader, in the editor (TipTap parses the body as HTML) and in the HTML
 * part of the sent mail. This turns that text into the structure the editor
 * keeps: <p> per paragraph, <br> per line, <ul>/<ol> for list runs, links for
 * bare URLs and <strong> for **bold**. Pure, so the worker and the app share it.
 */

// HTML when the body closes an element (`</x>`) or uses a void one (`<br>`,
// `<img …>`). Plain text such as "Hi <John>," or "a<b then c>" has neither.
const CLOSING_TAG = /<\/[a-z][a-z0-9-]*\s*>/i;
const VOID_TAG = /<(?:br|hr|img|meta|wbr|input|col|source)\b[^<>]*\/?>/i;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,3})[.)]\s+(.*)$/;
// `*` ends a URL so a **bold** wrapper never ends up inside the href. A
// Markdown link, `[the docs](https://…)`, is matched first and keeps its label:
// agents write those far more often than bare URLs. Its target may hold
// balanced parentheses, as Wikipedia URLs do: `…/wiki/Foo_(bar)`. The label
// holds no `[`, as in GFM, which also keeps a long run of `[` linear.
const URL = /\[([^[\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)|\bhttps?:\/\/[^\s<>"'*]+/g;
const TRAILING_PUNCTUATION = ".,;:!?)]";

/**
 * The punctuation a bare URL ends with, which belongs to the sentence. A loop,
 * not `/[.,…]+$/`: that regex retries from every character of a long run of
 * dots, quadratic in a body anyone can send.
 */
function trailingPunctuation(url: string): string {
	let end = url.length;
	while (end > 0 && TRAILING_PUNCTUATION.includes(url[end - 1]!)) end--;
	return url.slice(end);
}

/** True when the body has no HTML tags at all, so it is plain text. */
export function isPlainTextBody(body: string | null | undefined): boolean {
	return !!body && body.trim() !== "" && !CLOSING_TAG.test(body) && !VOID_TAG.test(body);
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** `**x**` as bold. Its text holds no `*`; it may span a link placeholder. */
const BOLD = /\*\*([^*]+?)\*\*/g;
/** Stands for a link while bold is applied. inline() runs per line, so its text holds no newline. */
const LINK_SLOT = "\n";

function bold(html: string): string {
	return html.replace(BOLD, "<strong>$1</strong>");
}

/**
 * Links are found in the raw text, before escaping, so `<url>` and `"url"` stop
 * at the bracket or quote. Bold is applied around the links, never inside a
 * link's `href`: each link is a placeholder while `**…**` is matched, so
 * `**see [docs](url)**` bolds the link and `[x](https://a.example/**b**)`
 * keeps its target as written.
 */
function inline(text: string): string {
	const links: string[] = [];
	let line = "";
	let last = 0;
	for (const m of text.matchAll(URL)) {
		const match = m[0];
		line += escapeHtml(text.slice(last, m.index));
		last = m.index! + match.length;
		if (m[2]) {
			links.push(`<a href="${escapeHtml(m[2])}">${bold(escapeHtml(m[1]!))}</a>`);
			line += LINK_SLOT;
			continue;
		}
		const tail = trailingPunctuation(match);
		const url = tail ? match.slice(0, -tail.length) : match;
		links.push(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
		line += LINK_SLOT + escapeHtml(tail);
	}
	line += escapeHtml(text.slice(last));
	const pieces = bold(line).split(LINK_SLOT);
	return pieces.map((piece, i) => piece + (links[i] ?? "")).join("");
}

/** Plain text as paragraphs, line breaks, lists and links. Empty in, empty out. */
export function plainTextToHtml(text: string | null | undefined): string {
	const lines = (text ?? "").replace(/\r\n?/g, "\n").trim().split("\n");
	if (lines.length === 1 && lines[0] === "") return "";
	const out: string[] = [];
	let para: string[] = [];
	// A list survives blank lines between its items (LLMs often write them that
	// way); it ends at the next line that is not an item of the same kind.
	let list: { tag: "ul" | "ol"; start: number; items: string[] } | null = null;
	const flushPara = () => {
		if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
		para = [];
	};
	const flushList = () => {
		if (!list) return;
		const start = list.tag === "ol" && list.start !== 1 ? ` start="${list.start}"` : "";
		out.push(`<${list.tag}${start}>${list.items.map((i) => `<li><p>${inline(i)}</p></li>`).join("")}</${list.tag}>`);
		list = null;
	};
	for (const line of lines) {
		if (line.trim() === "") {
			flushPara();
			continue;
		}
		const bullet = BULLET.exec(line);
		const numbered = bullet ? null : NUMBERED.exec(line);
		if (bullet || numbered) {
			const tag = bullet ? "ul" : "ol";
			flushPara();
			if (list && list.tag !== tag) flushList();
			list ??= { tag, start: numbered ? Number(numbered[1]) : 1, items: [] };
			list.items.push(bullet ? bullet[1]! : numbered![2]!);
			continue;
		}
		flushList();
		para.push(line.trim());
	}
	flushPara();
	flushList();
	return out.join("");
}

/** The body as HTML: plain text converted, HTML passed through unchanged. */
export function bodyAsHtml(body: string | null | undefined): string {
	return isPlainTextBody(body) ? plainTextToHtml(body) : (body ?? "");
}

// Stands in for indentation until htmlToTextLines has collapsed runs of spaces.
const INDENT = "\u0001";
const INNERMOST_LIST = /<(ul|ol)\b([^>]*)>((?:(?!<\/?(?:ul|ol)\b)[\s\S])*?)<\/\1\s*>/i;

function listToText(tag: string, attrs: string, inner: string): string {
	let n = Number(/\bstart\s*=\s*["']?(\d+)/i.exec(attrs)?.[1] ?? 1);
	const lines: string[] = [];
	for (const raw of inner.split(/<li\b[^>]*>/i).slice(1)) {
		const text = raw
			.replace(/<\/li\s*>[\s\S]*$/i, "")
			.replace(/<\/p>\s*<p\b[^>]*>/gi, "\n")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/?p\b[^>]*>/gi, "");
		const [first = "", ...rest] = text.split("\n").filter((l) => l.trim() !== "");
		lines.push(`${tag === "ol" ? `${n++}.` : "-"} ${first.trim()}`, ...rest.map((l) => `${INDENT}${l.replace(/^[ \t]+/, "")}`));
	}
	return `\n${lines.join("\n")}\n\n`;
}

/**
 * The text/plain part for an HTML body: paragraphs separated by a blank line,
 * "- " and "1." list markers kept (numbering honours `start`), sub-lists and
 * extra paragraphs in an item indented under it, entities decoded. Close to the
 * plain text an agent wrote before it was stored as HTML.
 */
export function htmlToEmailText(html: string | null | undefined): string {
	if (!html) return "";
	let out = html;
	// Innermost lists first, so an outer list sees its sub-lists as text lines.
	for (let m = INNERMOST_LIST.exec(out); m; m = INNERMOST_LIST.exec(out)) {
		out = out.slice(0, m.index) + listToText(m[1]!.toLowerCase(), m[2]!, m[3]!) + out.slice(m.index + m[0].length);
	}
	return htmlToTextLines(out.replace(/<\/p>/gi, "</p>\n")).replaceAll(INDENT, "  ");
}
