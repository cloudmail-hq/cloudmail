/**
 * Markdown to HTML for the docs site (`/docs`).
 *
 * Every docs page is Markdown first: the hand-written guides in `./pages` and
 * the endpoint pages generated from the OpenAPI document. The same Markdown is
 * served as the page's `.md` twin, so "Copy as Markdown" and the HTML can never
 * drift apart.
 *
 * A deliberately small subset: headings, paragraphs, fenced code, GFM tables,
 * lists (one level of nesting), blockquotes, rules, and inline code, bold,
 * italic and links. Raw HTML is never passed through: all text is escaped, and
 * the only markup emitted is the fixed tags below. Link targets are limited to
 * same-origin paths, fragments, `https:` and `mailto:`.
 */

export interface Heading {
	level: 2 | 3;
	id: string;
	text: string;
}

export interface RenderedMarkdown {
	html: string;
	headings: Heading[];
}

export function escapeHtml(value: unknown): string {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function slugify(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/`/g, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "section"
	);
}

/** Same-origin path (not protocol-relative), fragment, https or mailto. */
const SAFE_HREF = /^(?:\/(?!\/)|#|https:\/\/|mailto:)/i;

export function isSafeHref(href: string): boolean {
	return SAFE_HREF.test(href) && !/[\s<>"'`\\]/.test(href);
}

/**
 * One pass over inline syntax. Alternatives, leftmost match wins:
 * 1 escaped character, 2 code span, 3+4 link, 5 bold, 6 italic.
 *
 * Link text may not contain an unescaped `[`, and a link target may not
 * contain brackets or parentheses. Both keep hostile lines linear: a run of
 * `[`, or of unclosed `[a](`, stops at the next bracket instead of scanning
 * to the end of the line each time. `test/docs-site.test.ts` times this.
 */
const INLINE =
	/\\([\\`*_{}[\]()#+\-.!|<>])|`([^`\n]+)`|\[((?:[^[\]\\\n]|\\.)+)\]\(([^()[\]\s]+)\)|\*\*((?:[^*\n]|\*(?!\*))+)\*\*|\*([^*\s](?:[^*\n]*[^*\s])?)\*/g;

/** Inline Markdown to HTML. Text outside the recognised syntax is escaped. */
export function renderInline(source: string): string {
	let out = "";
	let last = 0;
	for (const m of source.matchAll(INLINE)) {
		const at = m.index ?? 0;
		out += escapeHtml(source.slice(last, at));
		last = at + m[0].length;
		if (m[1] !== undefined) out += escapeHtml(m[1]);
		else if (m[2] !== undefined) out += `<code>${escapeHtml(m[2])}</code>`;
		else if (m[3] !== undefined) {
			const href = m[4];
			const text = renderInline(m[3]);
			if (!isSafeHref(href)) out += text;
			else if (/^https:/i.test(href))
				out += `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${text}</a>`;
			else out += `<a href="${escapeHtml(href)}">${text}</a>`;
		} else if (m[5] !== undefined) out += `<strong>${renderInline(m[5])}</strong>`;
		else if (m[6] !== undefined) out += `<em>${renderInline(m[6])}</em>`;
	}
	return out + escapeHtml(source.slice(last));
}

/** Plain text of an inline run, for heading ids and the table of contents. */
export function inlineText(source: string): string {
	return source
		.replace(/`([^`\n]+)`/g, "$1")
		.replace(/\[((?:[^[\]\\\n]|\\.)+)\]\([^()[\]\s]+\)/g, "$1")
		.replace(/\*\*([^*\n]+)\*\*/g, "$1")
		.replace(/\\([\\`*_{}[\]()#+\-.!|<>])/g, "$1")
		.trim();
}

const FENCE = /^```([\w-]*)\s*$/;
const HEADING = /^(#{2,4})\s+(.+?)\s*#*$/;
const LIST_ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const TABLE_DIVIDER = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Split a table row on unescaped pipes; `\|` inside a cell is a literal pipe. */
export function splitTableRow(line: string): string[] {
	const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	const cells: string[] = [];
	let cell = "";
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (ch === "\\" && trimmed[i + 1] === "|") {
			cell += "|";
			i++;
		} else if (ch === "|") {
			cells.push(cell.trim());
			cell = "";
		} else cell += ch;
	}
	cells.push(cell.trim());
	return cells;
}

function startsBlock(line: string, next: string | undefined): boolean {
	return (
		FENCE.test(line) ||
		HEADING.test(line) ||
		LIST_ITEM.test(line) ||
		/^>\s?/.test(line) ||
		/^---+\s*$/.test(line) ||
		(line.trimStart().startsWith("|") && next !== undefined && TABLE_DIVIDER.test(next))
	);
}

interface RenderState {
	headings: Heading[];
	ids: Map<string, number>;
	/** How many blockquotes and lists deep the renderer is. */
	depth: number;
}

/**
 * Blockquotes and lists nest by recursion. Past this depth the remaining text
 * is rendered as one paragraph, so a line of ten thousand `>` cannot overflow
 * the stack. Real pages nest two or three deep.
 */
const MAX_NESTING = 12;

function uniqueId(state: RenderState, text: string): string {
	const base = slugify(text);
	const seen = state.ids.get(base) ?? 0;
	state.ids.set(base, seen + 1);
	return seen === 0 ? base : `${base}-${seen + 1}`;
}

function renderList(lines: string[], state: RenderState): string {
	if (state.depth >= MAX_NESTING) return `<p>${renderInline(lines.map((l) => l.trim()).join(" "))}</p>`;
	state.depth++;
	try {
		return renderListItems(lines, state);
	} finally {
		state.depth--;
	}
}

function renderListItems(lines: string[], state: RenderState): string {
	const first = LIST_ITEM.exec(lines[0])!;
	const ordered = /\d/.test(first[2]);
	const indent = first[1].length;
	const items: { text: string[]; nested: string[] }[] = [];
	for (const line of lines) {
		const m = LIST_ITEM.exec(line);
		if (m && m[1].length <= indent) {
			items.push({ text: [m[3]], nested: [] });
			continue;
		}
		const item = items[items.length - 1];
		if (!item) continue;
		if (line.trim() === "") continue;
		// Deeper lines belong to the item: a marker starts a nested list, anything
		// else continues the item's text.
		if (m || item.nested.length > 0) item.nested.push(line);
		else item.text.push(line.trim());
	}
	const tag = ordered ? "ol" : "ul";
	const body = items
		.map((item) => {
			const nested = item.nested.length ? renderList(item.nested, state) : "";
			return `<li>${renderInline(item.text.join(" "))}${nested}</li>`;
		})
		.join("");
	return `<${tag}>${body}</${tag}>`;
}

function renderBlocks(lines: string[], state: RenderState): string {
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === "") {
			i++;
			continue;
		}

		const fence = FENCE.exec(line);
		if (fence) {
			const code: string[] = [];
			i++;
			while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
			i++; // closing fence
			const lang = fence[1] || "text";
			out.push(
				`<div class="code" data-lang="${escapeHtml(lang)}"><pre><code>${escapeHtml(code.join("\n"))}</code></pre></div>`,
			);
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading) {
			const level = heading[1].length;
			const text = inlineText(heading[2]);
			const id = uniqueId(state, text);
			if (level === 2 || level === 3) state.headings.push({ level, id, text });
			out.push(
				`<h${level} id="${escapeHtml(id)}"><a class="anchor" href="#${escapeHtml(id)}">${renderInline(heading[2])}</a></h${level}>`,
			);
			i++;
			continue;
		}

		if (/^---+\s*$/.test(line)) {
			out.push("<hr>");
			i++;
			continue;
		}

		if (line.trimStart().startsWith("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
			const head = splitTableRow(line);
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && lines[i].trimStart().startsWith("|")) rows.push(splitTableRow(lines[i++]));
			const th = head.map((c) => `<th scope="col">${renderInline(c)}</th>`).join("");
			const tb = rows
				.map((r) => `<tr>${head.map((_, col) => `<td>${renderInline(r[col] ?? "")}</td>`).join("")}</tr>`)
				.join("");
			out.push(`<div class="table"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
			continue;
		}

		if (/^>\s?/.test(line)) {
			const quoted: string[] = [];
			while (i < lines.length && /^>\s?/.test(lines[i])) quoted.push(lines[i++].replace(/^>\s?/, ""));
			if (state.depth >= MAX_NESTING) {
				out.push(`<p>${renderInline(quoted.map((l) => l.trim()).join(" "))}</p>`);
				continue;
			}
			state.depth++;
			try {
				out.push(`<blockquote>${renderBlocks(quoted, state)}</blockquote>`);
			} finally {
				state.depth--;
			}
			continue;
		}

		const firstItem = LIST_ITEM.exec(line);
		if (firstItem) {
			const ordered = /\d/.test(firstItem[2]);
			const indent = firstItem[1].length;
			// Part of this list: a deeper line, or an item of the same kind. A
			// numbered item after bullets (or the reverse) starts a new list.
			const belongs = (candidate: string): boolean => {
				const m = LIST_ITEM.exec(candidate);
				if (m) return m[1].length > indent || /\d/.test(m[2]) === ordered;
				return /^\s{2,}\S/.test(candidate);
			};
			const block: string[] = [];
			while (i < lines.length) {
				const current = lines[i];
				if (current.trim() === "") {
					// A blank line ends the list unless more of it follows.
					const next = lines[i + 1];
					if (next !== undefined && belongs(next)) {
						i++;
						continue;
					}
					break;
				}
				if (!belongs(current)) break;
				block.push(current);
				i++;
			}
			out.push(renderList(block, state));
			continue;
		}

		const paragraph: string[] = [];
		while (i < lines.length && lines[i].trim() !== "" && !(paragraph.length > 0 && startsBlock(lines[i], lines[i + 1]))) {
			paragraph.push(lines[i].trim());
			i++;
		}
		out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
	}
	return out.join("\n");
}

/** Render a page body. Headings of level 2 and 3 are returned for the page's contents list. */
export function renderMarkdown(source: string): RenderedMarkdown {
	const state: RenderState = { headings: [], ids: new Map(), depth: 0 };
	const html = renderBlocks(source.replace(/\r\n?/g, "\n").split("\n"), state);
	return { html, headings: state.headings };
}
