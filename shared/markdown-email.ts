/**
 * Markdown bodies as email: the HTML part and the plain-text part.
 *
 * Agents write Markdown far more reliably than email HTML, so the API, the MCP
 * tools and the CLI take a `markdown` body and render it here. The HTML is what
 * the composer's editor keeps (`<p>`, `<ul><li><p>`, `<h1>`–`<h6>`, tables,
 * `<pre>`), so a person who opens the draft sees what the agent wrote, and the
 * few elements whose client defaults read badly in mail (headings, tables,
 * code, quotes, rules) carry short inline styles with no colours, so dark mode
 * still works (see `shared/outgoing-html.ts`).
 *
 * Mail rules on top of GitHub-flavoured Markdown:
 * - A single line break stays a line break ("Regards,\nMaya"), as people
 *   expect in a letter; Markdown would join the lines.
 * - "--" under a line is a signature dash, not a heading, and indented text is
 *   a paragraph, not code (setext headings and indented code are off).
 * - `~` alone is not strikethrough ("~5 min"); `~~x~~` is.
 * - Raw HTML is shown as text. Links work for http, https and mailto only.
 *   Images become links, since remote images in mail are blocked or tracked.
 * - Task items get ☐ / ☑, footnotes become [1] with the notes at the end.
 * - A link or footnote definition nothing cites is shown as written, so no
 *   text the writer typed disappears, and a non-blank body never renders empty.
 *
 * Bodies arrive from agents and API callers, so the cost has to stay bounded:
 * - The parser is markdown-it with its own linkify off. Both micromark and
 *   linkify-it take quadratic time on some inputs (seconds at 25 KB); the bare
 *   URL linker here is a single pass.
 * - Quotes and lists nested deeper than MAX_BLOCK_DEPTH (counted together), a
 *   body over MARKDOWN_MAX_CHARS, or any parser failure renders the body as
 *   plain paragraphs instead, with nothing dropped.
 * - The renderer walks inline tokens in a loop and recurses only over blocks,
 *   whose depth the guard above bounds.
 */

import MarkdownIt from "markdown-it";

type Token = ReturnType<MarkdownIt["parse"]>[number];
type RuleBlock = Parameters<MarkdownIt["block"]["ruler"]["push"]>[1];
type RuleInline = Parameters<MarkdownIt["inline"]["ruler"]["push"]>[1];
type StateBlock = Parameters<RuleBlock>[0];

export interface MarkdownEmail {
	/** Body fragment for the HTML part. Empty for an empty input. */
	html: string;
	/** The text/plain part: the same content without Markdown syntax. */
	text: string;
}

/**
 * The longest Markdown body the API takes, in characters. About 25 pages of
 * text; parsing it takes well under a second even for hostile input.
 */
export const MARKDOWN_MAX_CHARS = 100_000;

/** Quotes and lists nested deeper than this, counted together, send the body as plain text. */
const MAX_BLOCK_DEPTH = 32;
/** Bold/italic/strike tags nested deeper than this are dropped; the text stays. */
const MAX_INLINE_DEPTH = 10;
const MAX_FOOTNOTE_LABEL = 100;

const HEADING_STYLE: Record<number, string> = {
	1: "font-size:20px;line-height:1.3;margin:20px 0 8px;",
	2: "font-size:17px;line-height:1.3;margin:20px 0 8px;",
	3: "font-size:15px;line-height:1.3;margin:20px 0 8px;",
};
const MINOR_HEADING_STYLE = "font-size:14px;line-height:1.3;margin:16px 0 6px;";
const QUOTE_STYLE = "margin:0 0 12px;padding:0 0 0 12px;border-left:3px solid #d0d7de;";
const RULE_STYLE = "border:none;border-top:1px solid #d0d7de;margin:20px 0;";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const PRE_STYLE = `font-family:${MONO};font-size:13px;line-height:1.45;white-space:pre-wrap;margin:0 0 12px;padding:8px 10px;border:1px solid #d0d7de;border-radius:4px;`;
const CODE_STYLE = `font-family:${MONO};font-size:90%;`;
const TABLE_STYLE = "border-collapse:collapse;margin:0 0 12px;";
const CELL_STYLE = "border:1px solid #d0d7de;padding:6px 10px;vertical-align:top;";
const TASK_LIST_STYLE = "list-style-type:none;padding-left:4px;";

// ── Parser ─────────────────────────────────────────────────────────

interface ParseEnv {
	/** markdown-it's link definitions, behind a proxy that notes each new one and each lookup. */
	references: Record<string, { href: string } | undefined>;
	/** The label the last link definition stored; null for a duplicate. */
	lastDefined: string | null;
	/** While a link or image rule runs: the first definition it looked up. */
	lookup: { label: string | null } | null;
	/** Labels of footnote definitions. */
	footnotes: Set<string>;
	/** Quotes and lists open around the current line. */
	depth: number;
	/** Nesting went past MAX_BLOCK_DEPTH. */
	overflow: boolean;
}

function newEnv(): ParseEnv {
	const env: ParseEnv = {
		references: {},
		lastDefined: null,
		lookup: null,
		footnotes: new Set(),
		depth: 0,
		overflow: false,
	};
	const store: Record<string, { href: string } | undefined> = Object.create(null);
	env.references = new Proxy(store, {
		get(target, key) {
			if (typeof key !== "string") return undefined;
			const value = target[key];
			if (value !== undefined && env.lookup && env.lookup.label === null) env.lookup.label = key;
			return value;
		},
		set(target, key, value) {
			if (typeof key === "string") {
				target[key] = value;
				env.lastDefined = key;
			}
			return true;
		},
	});
	return env;
}

const md = new MarkdownIt("default", { html: false, linkify: false, typographer: false });
md.disable(["lheading", "code"]);
// Every target is kept here and checked by `safeUrl` when rendering, so a link
// to a scheme mail can't open still shows its text instead of its syntax.
md.validateLink = () => true;

const FOOTNOTE_DEF = new RegExp(`^\\[\\^([^\\]\\s[]{1,${MAX_FOOTNOTE_LABEL}})\\]:[ \\t]*`);

/** The start of a line, enough to match a footnote definition. */
function lineHead(state: StateBlock, line: number): string {
	const start = state.bMarks[line]! + state.tShift[line]!;
	return state.src.slice(start, Math.min(state.eMarks[line]!, start + MAX_FOOTNOTE_LABEL + 10));
}

/** `[^label]: text` up to the next blank line or definition, one paragraph. */
const footnoteDefinition: RuleBlock = (state, startLine, endLine, silent) => {
	if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
	const head = FOOTNOTE_DEF.exec(lineHead(state, startLine));
	if (!head) return false;
	if (silent) return true;
	// Continuation lines run to a blank line, the next definition, or a block
	// that could start in a paragraph (a list, a quote, a heading, …).
	const terminators = md.block.ruler.getRules("paragraph");
	const parentType = state.parentType;
	state.parentType = "paragraph";
	let next = startLine + 1;
	for (; next < endLine; next++) {
		if (state.isEmpty(next) || state.sCount[next]! < state.blkIndent) break;
		if (FOOTNOTE_DEF.test(lineHead(state, next))) break;
		if (state.sCount[next]! - state.blkIndent < 4 && terminators.some((rule) => rule(state, next, endLine, true))) break;
	}
	state.parentType = parentType;
	const label = md.utils.normalizeReference(head[1]!);
	(state.env as ParseEnv).footnotes.add(label);
	const raw = state.getLines(startLine, next, state.blkIndent, false).trim();
	const open = state.push("footnote_open", "", 1);
	open.meta = { label, raw };
	open.map = [startLine, next];
	const inline = state.push("inline", "", 0);
	inline.content = raw.slice(head[0].length).trim();
	inline.map = [startLine, next];
	inline.children = [];
	state.push("footnote_close", "", -1);
	state.line = next;
	return true;
};

/** `[^label]` for a defined footnote. The label holds no `[` or space, and is short, so a scan never runs far. */
const footnoteReference: RuleInline = (state, silent) => {
	const start = state.pos;
	if (state.src.charCodeAt(start) !== 0x5b || state.src.charCodeAt(start + 1) !== 0x5e) return false;
	// Room for the label and its closing bracket.
	const limit = Math.min(state.posMax, start + 3 + MAX_FOOTNOTE_LABEL);
	let pos = start + 2;
	for (; pos < limit; pos++) {
		const c = state.src.charCodeAt(pos);
		if (c === 0x5d) break;
		if (c === 0x5b || c === 0x20 || c === 0x09 || c === 0x0a) return false;
	}
	if (pos === start + 2 || pos >= limit) return false;
	const label = md.utils.normalizeReference(state.src.slice(start + 2, pos));
	if (!(state.env as ParseEnv).footnotes.has(label)) return false;
	if (!silent) state.push("footnote_ref", "", 0).meta = { label };
	state.pos = pos + 1;
	return true;
};

const blockRules = (md.block.ruler as unknown as { __rules__: { name: string; fn: RuleBlock; alt: string[] }[] }).__rules__;
const linkDefinition = blockRules.find((rule) => rule.name === "reference")?.fn;
if (!linkDefinition) throw new Error("markdown-it has no reference rule");

/**
 * Counts quotes and lists around the lines it parses. markdown-it's own
 * `state.level` counts tokens instead: two per list level (the list and the
 * item), one per quote.
 */
function countNesting(name: string): void {
	const entry = blockRules.find((r) => r.name === name);
	if (!entry) throw new Error(`markdown-it has no ${name} rule`);
	const rule = entry.fn;
	const counted: RuleBlock = (state, startLine, endLine, silent) => {
		if (silent) return rule(state, startLine, endLine, silent);
		const env = state.env as ParseEnv;
		env.depth++;
		try {
			return rule(state, startLine, endLine, silent);
		} finally {
			env.depth--;
		}
	};
	// `at` resets the rule's alt list, which lets it end a paragraph.
	md.block.ruler.at(name, counted, { alt: [...entry.alt] });
}
countNesting("blockquote");
countNesting("list");
// Lines inside more than MAX_BLOCK_DEPTH quotes and lists: the body goes out as
// plain text. Well inside markdown-it's own limit of 100 token levels, past
// which it drops the rest of the document without a word.
md.block.ruler.before("table", "depth_guard", (state, _startLine, endLine) => {
	const env = state.env as ParseEnv;
	if (env.depth <= MAX_BLOCK_DEPTH) return false;
	env.overflow = true;
	state.line = endLine;
	return true;
});
md.block.ruler.before("reference", "footnote_definition", footnoteDefinition);
// markdown-it's link definitions leave no token. Keep one, with the source,
// so a definition nothing cites can be shown as written.
md.block.ruler.at("reference", (state, startLine, endLine, silent) => {
	const env = state.env as ParseEnv;
	env.lastDefined = null;
	if (!linkDefinition(state, startLine, endLine, silent)) return false;
	if (silent) return true;
	const token = state.push("reference_def", "", 0);
	token.map = [startLine, state.line];
	// A duplicate label stores nothing and no link can use it, so it stays visible.
	token.meta = { label: env.lastDefined, raw: state.getLines(startLine, state.line, state.blkIndent, false).trim() };
	return true;
});

const inlineRules = (md.inline.ruler as unknown as { __rules__: { name: string; fn: RuleInline; alt: string[] }[] }).__rules__;

/**
 * Marks each link or image made from a definition with that definition's
 * label (`meta.reference`), so a definition is hidden only when a link that
 * renders used it, not merely one with the same URL. markdown-it looks the
 * label up before it parses the link text, so the first lookup in a call is
 * the link's own; a nested link or image gets its own slot.
 */
function markReferenceUse(name: "link" | "image", tokenType: "link_open" | "image"): void {
	const entry = inlineRules.find((r) => r.name === name);
	if (!entry) throw new Error(`markdown-it has no ${name} rule`);
	const rule = entry.fn;
	const marked: RuleInline = (state, silent) => {
		const env = state.env as ParseEnv;
		const outer = env.lookup;
		const lookup = { label: null as string | null };
		env.lookup = lookup;
		const before = state.tokens.length;
		let ok: boolean;
		try {
			ok = rule(state, silent);
		} finally {
			env.lookup = outer;
		}
		if (ok && !silent && lookup.label !== null) {
			// Pending text is pushed first, so the link's token may not be the first one.
			for (let i = before; i < state.tokens.length; i++) {
				const token = state.tokens[i]!;
				if (token.type !== tokenType) continue;
				token.meta = { ...token.meta, reference: lookup.label };
				break;
			}
		}
		return ok;
	};
	md.inline.ruler.at(name, marked, { alt: [...entry.alt] });
}
markReferenceUse("link", "link_open");
markReferenceUse("image", "image");
md.inline.ruler.before("link", "footnote_ref", footnoteReference);

// ── Document ───────────────────────────────────────────────────────

interface Block {
	/** The token type without `_open`: paragraph, bullet_list, fence, … */
	type: string;
	token: Token;
	blocks: Block[];
	/** Inline tokens of a paragraph, heading, table cell or footnote. */
	inline: Token[];
	/** For a list item that is a task: whether it is checked. */
	task?: boolean;
}

interface Doc {
	blocks: Block[];
	/** Footnote label → its first definition, in definition order. */
	notes: Map<string, Block>;
	/** Footnote labels cited anywhere, notes included. */
	cited: Set<string>;
	/** Labels of the link definitions that links shown in the message used. */
	shownReferences: Set<string>;
}

const TASK = /^\[([ xX])\](?:[ \t]+|$)/;

/** GFM task items: an item whose text starts with `[ ]` or `[x]`. */
function markTask(item: Block): void {
	const first = item.blocks[0];
	const lead = first?.type === "paragraph" ? first.inline[0] : undefined;
	if (lead?.type !== "text") return;
	const match = TASK.exec(lead.content);
	if (!match) return;
	item.task = match[1] !== " ";
	lead.content = lead.content.slice(match[0].length);
}

/** The flat token stream as a block tree, built with a stack. */
function buildDoc(tokens: Token[]): Doc {
	const root: Block = { type: "root", token: null as unknown as Token, blocks: [], inline: [] };
	const stack: Block[] = [root];
	const notes = new Map<string, Block>();
	const cited = new Set<string>();
	for (const token of tokens) {
		const parent = stack[stack.length - 1]!;
		if (token.nesting === 1) {
			const block: Block = { type: token.type.replace(/_open$/, ""), token, blocks: [], inline: [] };
			parent.blocks.push(block);
			stack.push(block);
		} else if (token.nesting === -1) {
			if (stack.length > 1) stack.pop();
			if (parent.type === "list_item") markTask(parent);
			else if (parent.type === "footnote" && !notes.has(parent.token.meta.label)) notes.set(parent.token.meta.label, parent);
		} else if (token.type === "inline") {
			parent.inline = token.children ?? [];
			for (const child of parent.inline) if (child.type === "footnote_ref") cited.add(child.meta.label);
		} else {
			parent.blocks.push({ type: token.type, token, blocks: [], inline: [] });
		}
	}
	const doc: Doc = { blocks: root.blocks, notes, cited, shownReferences: new Set() };
	doc.shownReferences = shownReferences(doc);
	return doc;
}

/** A footnote shown as a note at the end: cited, and the first with its label. */
function isNote(block: Block, doc: Doc): boolean {
	const label = block.token.meta.label as string;
	return doc.cited.has(label) && doc.notes.get(label) === block;
}

/**
 * The definition labels used by links and images that render as links. A link
 * inside an image's alt text is only text, and so is an image inside a link; a
 * footnote that is not a note is shown as written; a link to a target mail
 * can't open is shown as its text.
 */
function shownReferences(doc: Doc): Set<string> {
	const labels = new Set<string>();
	const pending = [...doc.blocks];
	while (pending.length) {
		const block = pending.pop()!;
		if (block.type === "footnote" && !isNote(block, doc)) continue;
		pending.push(...block.blocks);
		let inLink = false;
		for (const t of block.inline) {
			let shown = false;
			if (t.type === "link_open") {
				inLink = true;
				shown = safeUrl(t.attrGet("href")) !== null;
			} else if (t.type === "link_close") inLink = false;
			else if (t.type === "image" && !inLink) shown = safeUrl(t.attrGet("src")) !== null;
			const label = t.meta?.reference as string | undefined;
			if (shown && label !== undefined) labels.add(label);
		}
	}
	return labels;
}

/**
 * A definition that does its job out of sight: a footnote shown as a note, or
 * a link definition that a link shown in the message used. Any other is shown
 * as written, so its text and URL still reach the reader: one nothing cites,
 * one cited only from a footnote that is not a note or from an image's alt
 * text, or one whose target mail can't open.
 */
function isHiddenDefinition(block: Block, doc: Doc): boolean {
	if (block.type === "footnote") return isNote(block, doc);
	const label = block.token.meta?.label as string | null;
	return label !== null && doc.shownReferences.has(label);
}

class NoteNumbers {
	readonly order: string[] = [];
	readonly numbers = new Map<string, number>();
	number(label: string): number {
		let n = this.numbers.get(label);
		if (n === undefined) {
			n = this.order.push(label);
			this.numbers.set(label, n);
		}
		return n;
	}
}

interface Render {
	doc: Doc;
	notes: NoteNumbers;
}

/** Each cited note once, numbered in order of first citation; notes can cite notes. */
function forEachNote(r: Render, write: (n: number, note: Block) => void): void {
	let i = 0;
	const flush = () => {
		for (; i < r.notes.order.length; i++) {
			const note = r.doc.notes.get(r.notes.order[i]!);
			if (note) write(i + 1, note);
		}
	};
	flush();
	// Notes cited only by notes nobody reaches still get a number.
	for (const label of r.doc.notes.keys()) {
		if (r.doc.cited.has(label) && !r.notes.numbers.has(label)) {
			r.notes.number(label);
			flush();
		}
	}
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** The link target, or null when it is not a scheme mail can open safely. */
function safeUrl(url: string | null): string | null {
	const v = (url ?? "").trim();
	return /^(?:https?:\/\/|mailto:)/i.test(v) ? v : null;
}

/** The text of inline tokens, as for an image's alt text. */
function plainInline(tokens: Token[]): string {
	let out = "";
	const pending = [...tokens].reverse();
	while (pending.length) {
		const t = pending.pop()!;
		if (t.type === "text" || t.type === "code_inline") out += t.content;
		else if (t.type === "softbreak" || t.type === "hardbreak") out += " ";
		else if (t.type === "image" && t.children) for (let i = t.children.length - 1; i >= 0; i--) pending.push(t.children[i]!);
	}
	return out;
}

function codeOf(block: Block): string {
	return block.token.content.replace(/\n$/, "");
}

/** Table rows (header first) as cells. markdown-it already pads rows to the header's width. */
function tableRows(table: Block): Block[][] {
	return table.blocks.flatMap((section) => section.blocks.map((row) => row.blocks));
}

function alignOf(cell: Block): string | null {
	return /text-align:(left|right|center)/.exec(cell.token.attrGet("style") ?? "")?.[1] ?? null;
}

function isTight(list: Block): boolean {
	return list.blocks.every((item) => item.blocks.every((b) => b.type !== "paragraph" || b.token.hidden));
}

// ── Bare URLs ──────────────────────────────────────────────────────

const URL_START = /\b(?:https?:\/\/|www\.)/gi;
const URL_TRAILING = "?!.,:;*_~'\"";

function endsUrl(code: number): boolean {
	// Whitespace, `<`, `>` and `"`.
	return code <= 0x20 || code === 0x3c || code === 0x3e || code === 0x22 || code === 0xa0 || code === 0x2028 || code === 0x2029;
}

const EMAIL_LOCAL = /[A-Za-z0-9._+-]/;
const EMAIL_DOMAIN = /[A-Za-z0-9._-]/;
const DOMAIN_LABEL = /^[A-Za-z0-9_-]+$/;

/**
 * Text as HTML with bare email addresses linked, GFM style. One pass: each `@`
 * scans back to the previous one at most, and forward to the next one.
 */
function emailLinkHtml(text: string): string {
	let out = "";
	let last = 0;
	for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
		let start = at;
		while (start > last && EMAIL_LOCAL.test(text[start - 1]!)) start--;
		let end = at + 1;
		while (end < text.length && EMAIL_DOMAIN.test(text[end]!)) end++;
		while (end > at + 1 && /[.\-_]/.test(text[end - 1]!)) end--;
		const labels = text.slice(at + 1, end).split(".");
		if (start === at || labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label))) continue;
		const address = text.slice(start, end);
		out += `${escapeHtml(text.slice(last, start))}<a href="mailto:${escapeHtml(address)}">${escapeHtml(address)}</a>`;
		last = end;
		at = end - 1;
	}
	return out + escapeHtml(text.slice(last));
}

/**
 * Text as HTML with bare `http(s)://` and `www.` URLs and email addresses
 * linked, GFM style: trailing punctuation and an unmatched `)` stay outside
 * the link. One pass: each character is scanned a constant number of times.
 */
function autolinkHtml(text: string): string {
	let out = "";
	let last = 0;
	URL_START.lastIndex = 0;
	for (let m = URL_START.exec(text); m; m = URL_START.exec(text)) {
		const start = m.index;
		const hostStart = start + m[0].length;
		let end = hostStart;
		let opens = 0;
		let closes = 0;
		for (; end < text.length && !endsUrl(text.charCodeAt(end)); end++) {
			if (text[end] === "(") opens++;
			else if (text[end] === ")") closes++;
		}
		URL_START.lastIndex = end;
		let stop = end;
		while (stop > hostStart) {
			const c = text[stop - 1]!;
			if (URL_TRAILING.includes(c)) stop--;
			else if (c === ")" && closes > opens) {
				closes--;
				stop--;
			} else break;
		}
		if (stop === hostStart || !/[\p{L}\p{N}]/u.test(text[hostStart]!)) continue;
		const url = text.slice(start, stop);
		const href = /^www\./i.test(url) ? `https://${url}` : url;
		out += `${emailLinkHtml(text.slice(last, start))}<a href="${escapeHtml(href)}">${escapeHtml(url)}</a>`;
		last = stop;
	}
	return out + emailLinkHtml(text.slice(last));
}

/** Text shown as written: one paragraph, line breaks kept, URLs linked. */
function literalHtml(text: string): string {
	return `<p>${text.split("\n").map(autolinkHtml).join("<br>")}</p>`;
}

// ── HTML ───────────────────────────────────────────────────────────

/** Bold, italic and strike tokens by type: the tag, and the family that pairs them. */
const INLINE_TAG: Record<string, { tag: string; family: "emphasis" | "strike" }> = {
	em_open: { tag: "em", family: "emphasis" },
	em_close: { tag: "em", family: "emphasis" },
	strong_open: { tag: "strong", family: "emphasis" },
	strong_close: { tag: "strong", family: "emphasis" },
	s_open: { tag: "s", family: "strike" },
	s_close: { tag: "s", family: "strike" },
};

interface OpenTag {
	tag: string;
	/** Written to the HTML: within MAX_INLINE_DEPTH. */
	written: boolean;
}

/**
 * Inline tokens as HTML, in one loop.
 *
 * markdown-it pairs `*`/`_` and `~~` separately, so the two can cross
 * (`*a ~~b* c~~`). Each family's own pairs nest, so a stack per family finds
 * the open tag a close belongs to; the written tags then close the way a
 * browser does: tags opened inside it close with it and open again after
 * (`<em>a <s>b</s></em><s> c</s>`). Tags past MAX_INLINE_DEPTH are not written,
 * which also bounds that reopening, so the loop stays linear.
 */
function inlineHtml(tokens: Token[], r: Render): string {
	const parts: string[] = [];
	const families: Record<string, OpenTag[]> = { emphasis: [], strike: [] };
	/** The written tags, innermost last. */
	const written: OpenTag[] = [];
	/** Inside a link: whether its `<a>` was written, and the written depth at its start. */
	let link: { written: boolean; depth: number } | null = null;
	const closeTo = (depth: number) => {
		while (written.length > depth) parts.push(`</${written.pop()!.tag}>`);
	};
	for (const t of tokens) {
		switch (t.type) {
			case "text":
				parts.push(link === null ? autolinkHtml(t.content) : escapeHtml(t.content));
				break;
			case "softbreak":
			case "hardbreak":
				parts.push("<br>");
				break;
			case "code_inline":
				parts.push(`<code style="${CODE_STYLE}">${escapeHtml(t.content)}</code>`);
				break;
			case "em_open":
			case "strong_open":
			case "s_open": {
				const { tag, family } = INLINE_TAG[t.type]!;
				const entry: OpenTag = { tag, written: written.length < MAX_INLINE_DEPTH };
				families[family]!.push(entry);
				if (entry.written) {
					written.push(entry);
					parts.push(`<${tag}>`);
				}
				break;
			}
			case "em_close":
			case "strong_close":
			case "s_close": {
				const entry = families[INLINE_TAG[t.type]!.family]!.pop();
				const at = entry?.written ? written.lastIndexOf(entry) : -1;
				if (at < (link?.depth ?? 0)) break;
				const inner = written.slice(at + 1);
				closeTo(at);
				for (const tag of inner) {
					written.push(tag);
					parts.push(`<${tag.tag}>`);
				}
				break;
			}
			case "link_open": {
				const href = safeUrl(t.attrGet("href"));
				link = { written: href !== null, depth: written.length };
				if (href) parts.push(`<a href="${escapeHtml(href)}">`);
				break;
			}
			case "link_close":
				if (link) {
					closeTo(link.depth);
					if (link.written) parts.push("</a>");
				}
				link = null;
				break;
			case "image": {
				// Inside a link the image is its label: a link can't hold a link.
				const src = link === null ? safeUrl(t.attrGet("src")) : null;
				const label = escapeHtml(plainInline(t.children ?? []) || src || "");
				parts.push(src ? `<a href="${escapeHtml(src)}">${label}</a>` : label);
				break;
			}
			case "footnote_ref":
				parts.push(`[${r.notes.number(t.meta.label)}]`);
				break;
			default:
				parts.push(escapeHtml(t.content));
		}
	}
	closeTo(0);
	return parts.join("");
}

function blocksHtml(blocks: Block[], r: Render): string {
	let out = "";
	for (const block of blocks) out += blockHtml(block, r);
	return out;
}

function listHtml(list: Block, r: Render): string {
	const ordered = list.type === "ordered_list";
	const tag = ordered ? "ol" : "ul";
	const startAt = ordered ? Number(list.token.attrGet("start") ?? 1) : 1;
	const start = startAt !== 1 ? ` start="${startAt}"` : "";
	const tasks = !ordered && list.blocks.length > 0 && list.blocks.every((item) => item.task !== undefined);
	let items = "";
	for (const item of list.blocks) {
		const box = item.task === undefined ? "" : item.task ? "☑ " : "☐ ";
		const [first, ...rest] = item.blocks;
		items +=
			first?.type === "paragraph"
				? `<li><p>${box}${inlineHtml(first.inline, r)}</p>${blocksHtml(rest, r)}</li>`
				: `<li><p>${box}</p>${blocksHtml(item.blocks, r)}</li>`;
	}
	return `<${tag}${start}${tasks ? ` style="${TASK_LIST_STYLE}"` : ""}>${items}</${tag}>`;
}

function tableHtml(table: Block, r: Render): string {
	const [head = [], ...body] = tableRows(table);
	const cell = (tag: "th" | "td", c: Block) => {
		const align = alignOf(c) ?? (tag === "th" ? "left" : null);
		return `<${tag} style="${CELL_STYLE}${align ? `text-align:${align};` : ""}">${inlineHtml(c.inline, r)}</${tag}>`;
	};
	const headRow = `<tr>${head.map((c) => cell("th", c)).join("")}</tr>`;
	const bodyRows = body.map((row) => `<tr>${row.map((c) => cell("td", c)).join("")}</tr>`).join("");
	return `<table style="${TABLE_STYLE}"><thead>${headRow}</thead>${bodyRows ? `<tbody>${bodyRows}</tbody>` : ""}</table>`;
}

function blockHtml(block: Block, r: Render): string {
	switch (block.type) {
		case "paragraph":
			return `<p>${inlineHtml(block.inline, r)}</p>`;
		case "heading": {
			const level = Number(block.token.tag.slice(1));
			return `<h${level} style="${HEADING_STYLE[level] ?? MINOR_HEADING_STYLE}">${inlineHtml(block.inline, r)}</h${level}>`;
		}
		case "hr":
			return `<hr style="${RULE_STYLE}">`;
		case "blockquote":
			return `<blockquote style="${QUOTE_STYLE}">${blocksHtml(block.blocks, r)}</blockquote>`;
		case "bullet_list":
		case "ordered_list":
			return listHtml(block, r);
		case "fence":
			return `<pre style="${PRE_STYLE}"><code>${escapeHtml(codeOf(block))}</code></pre>`;
		case "table":
			return tableHtml(block, r);
		case "footnote":
		case "reference_def":
			return isHiddenDefinition(block, r.doc) ? "" : literalHtml(block.token.meta.raw);
		default:
			if (block.blocks.length) return blocksHtml(block.blocks, r);
			if (block.inline.length) return `<p>${inlineHtml(block.inline, r)}</p>`;
			return block.token.content ? literalHtml(block.token.content) : "";
	}
}

/** Footnotes cited in the body, numbered, after a rule. Run after the body so the numbers exist. */
function notesHtml(r: Render): string {
	const parts: string[] = [];
	forEachNote(r, (n, note) => parts.push(`<p>[${n}] ${inlineHtml(note.inline, r)}</p>`));
	return parts.length ? `<hr style="${RULE_STYLE}">${parts.join("")}` : "";
}

// ── Plain text ─────────────────────────────────────────────────────

/** "text (url)", or just the URL when the text is the URL. */
function linkText(target: string | null, label: string): string {
	if (!target) return label;
	const bare = target.replace(/^mailto:/i, "").replace(/^https?:\/\//i, "");
	if (!label || label === target || label === bare || `${label}/` === bare) return target.replace(/^mailto:/i, "");
	return `${label} (${target.replace(/^mailto:/i, "")})`;
}

function inlineText(tokens: Token[], r: Render): string {
	const parts: string[] = [];
	let link: { at: number; href: string | null } | null = null;
	for (const t of tokens) {
		switch (t.type) {
			case "text":
			case "code_inline":
				parts.push(t.content);
				break;
			case "softbreak":
			case "hardbreak":
				parts.push("\n");
				break;
			case "link_open":
				link = { at: parts.length, href: safeUrl(t.attrGet("href")) };
				break;
			case "link_close":
				if (link) parts.push(linkText(link.href, parts.splice(link.at).join("")));
				link = null;
				break;
			case "image": {
				const alt = plainInline(t.children ?? []);
				parts.push(link ? alt : linkText(safeUrl(t.attrGet("src")), alt));
				break;
			}
			case "footnote_ref":
				parts.push(`[${r.notes.number(t.meta.label)}]`);
				break;
		}
	}
	return parts.join("");
}

function blocksText(blocks: Block[], r: Render, gap = "\n\n"): string {
	const parts: string[] = [];
	for (const block of blocks) {
		const text = blockText(block, r);
		if (text !== "") parts.push(text);
	}
	return parts.join(gap);
}

function indentAfterFirst(text: string, marker: string): string {
	const pad = " ".repeat(marker.length + 1);
	return text
		.split("\n")
		.map((line, i) => (i === 0 ? `${marker} ${line}` : line ? `${pad}${line}` : line))
		.join("\n");
}

function listText(list: Block, r: Render): string {
	const ordered = list.type === "ordered_list";
	const start = ordered ? Number(list.token.attrGet("start") ?? 1) : 1;
	const gap = isTight(list) ? "\n" : "\n\n";
	return list.blocks
		.map((item, i) => {
			const box = item.task === undefined ? "" : item.task ? "[x] " : "[ ] ";
			return indentAfterFirst(box + blocksText(item.blocks, r, gap), ordered ? `${start + i}.` : "-");
		})
		.join(gap);
}

function tableText(table: Block, r: Render): string {
	const rows = tableRows(table).map((row) => row.map((cell) => inlineText(cell.inline, r).replace(/\n/g, " ").trim()));
	const [head, ...body] = rows;
	if (!head) return "";
	const widths = head.map((_, i) => {
		let width = 3;
		for (const row of rows) width = Math.max(width, (row[i] ?? "").length);
		return width;
	});
	const line = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i]!)).join(" | ").trimEnd();
	return [line(head), widths.map((w) => "-".repeat(w)).join("-|-"), ...body.map(line)].join("\n");
}

function blockText(block: Block, r: Render): string {
	switch (block.type) {
		case "paragraph":
		case "heading":
			return inlineText(block.inline, r);
		case "hr":
			return "---";
		case "blockquote":
			return blocksText(block.blocks, r)
				.split("\n")
				.map((line) => (line ? `> ${line}` : ">"))
				.join("\n");
		case "bullet_list":
		case "ordered_list":
			return listText(block, r);
		case "fence":
			return codeOf(block);
		case "table":
			return tableText(block, r);
		case "footnote":
		case "reference_def":
			return isHiddenDefinition(block, r.doc) ? "" : block.token.meta.raw;
		default:
			if (block.blocks.length) return blocksText(block.blocks, r);
			return block.inline.length ? inlineText(block.inline, r) : block.token.content;
	}
}

function notesText(r: Render): string {
	const parts: string[] = [];
	forEachNote(r, (n, note) => parts.push(`[${n}] ${inlineText(note.inline, r)}`));
	return parts.join("\n");
}

// ── Entry points ───────────────────────────────────────────────────

/** The body as written: paragraphs at blank lines, line breaks kept, URLs linked. */
function plainTextEmail(source: string): MarkdownEmail {
	const paragraphs = source
		.split(/\n[ \t]*\n\s*/)
		.map((p) => p.trim())
		.filter(Boolean);
	return { html: paragraphs.map(literalHtml).join(""), text: source };
}

function renderTokens(source: string): MarkdownEmail | null {
	const env = newEnv();
	const tokens = md.parse(source, env);
	if (env.overflow) return null;
	const doc = buildDoc(tokens);
	const htmlRender: Render = { doc, notes: new NoteNumbers() };
	const html = blocksHtml(doc.blocks, htmlRender) + notesHtml(htmlRender);
	const textRender: Render = { doc, notes: new NoteNumbers() };
	const body = blocksText(doc.blocks, textRender);
	const notes = notesText(textRender);
	return { html, text: notes ? `${body}\n\n---\n${notes}` : body };
}

/**
 * A Markdown body as the HTML and plain-text parts of an email. Empty in,
 * empty out; any other body renders to something a reader can see.
 */
export function renderMarkdownEmail(markdown: string | null | undefined): MarkdownEmail {
	const source = (markdown ?? "").replace(/\r\n?/g, "\n").trim();
	if (!source) return { html: "", text: "" };
	if (source.length > MARKDOWN_MAX_CHARS) return plainTextEmail(source);
	let rendered: MarkdownEmail | null = null;
	try {
		rendered = renderTokens(source);
	} catch {
		// A parser bug must not lose the message: send it as written.
	}
	return rendered?.html && rendered.text.trim() ? rendered : plainTextEmail(source);
}

/** The HTML part only, for a stored body such as a draft. */
export function markdownToEmailHtml(markdown: string | null | undefined): string {
	return renderMarkdownEmail(markdown).html;
}
