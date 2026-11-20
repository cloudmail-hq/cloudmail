// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The plain-text preview a list row shows under the subject.
 *
 * List projections used to return `SUBSTR(body, 1, 300)`, which for HTML mail
 * is markup: the REST API and MCP `list_emails` handed agents `<p>…</p>`, and a
 * newsletter's first 300 characters were usually `<head><style>` and nothing a
 * reader would recognise. The browser stripped tags on its own, so the bug only
 * showed through the API.
 *
 * Computed once at insert time and stored in `emails.snippet` (migration 26),
 * so every reader — list, search, MCP — gets the same text without parsing a
 * body per row per request.
 *
 * String and regex based, like `quoted-text.ts`, because it runs in Workers,
 * in the browser and in Node tests, none of which share a DOM.
 */

import { decodeHtmlEntities } from "./html-text";
import { looksLikeHtml, splitQuotedHtml, splitQuotedText } from "./quoted-text";

/** Characters stored per message. Matches the old `SUBSTR(body, 1, 300)`. */
export const SNIPPET_MAX_CHARS = 300;

/**
 * Invisible characters marketing mail pads its preheader with so the inbox
 * preview stops after the intended teaser. Kept in a snippet they render as a
 * long run of nothing, which is exactly what the sender wanted to avoid too.
 */
const INVISIBLE =
	/[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\u3164\ufeff\uffa0]/g;

/** Elements whose content is never visible text. */
const NON_TEXT_ELEMENTS = /<(head|style|script|title|template|noscript|svg|xml)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/**
 * An opening `<style>`/`<head>`/`<script>` with no close. A body that was cut
 * short (or a sender that never closed its head) would otherwise leak its whole
 * stylesheet into the preview.
 */
const UNCLOSED_NON_TEXT = /<(head|style|script|title)\b[^>]*>[\s\S]*$/i;

/** Remove everything a reader cannot see, before tags are stripped. */
function dropInvisibleMarkup(html: string): string {
	let out = html
		.replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
		.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, " ")
		.replace(/<!DOCTYPE[^>]*>/gi, " ")
		.replace(NON_TEXT_ELEMENTS, " ");
	out = out.replace(UNCLOSED_NON_TEXT, " ");
	// Elements hidden inline are almost always preheader tricks or tracking
	// scaffolding. Only the simplest shape is handled: a leaf element whose own
	// content holds no nested tags. Anything more ambitious needs a parser.
	out = out.replace(
		/<([a-z][a-z0-9]*)\b[^>]*style\s*=\s*["'][^"']*(?:display\s*:\s*none|mso-hide\s*:\s*all)[^"']*["'][^>]*>[^<]*<\/\1\s*>/gi,
		" ",
	);
	return out;
}

/** HTML body → flattened text, with tags removed and entities decoded. */
function htmlToPlain(html: string): string {
	const visible = splitQuotedHtml(dropInvisibleMarkup(html)).visible;
	const withBreaks = visible
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/<\/(?:p|div|tr|td|th|li|h[1-6]|blockquote|table|section|article|header|footer)\s*>/gi, " ")
		.replace(/<[^>]*>/g, "")
		// A tag left open at the very end (a truncated body) has no `>`.
		.replace(/<[a-z!/][^>]*$/i, "");
	return decodeHtmlEntities(withBreaks);
}

/** Plain-text body → the part the sender wrote, minus `>` quote chains. */
function textToPlain(text: string): string {
	const visible = splitQuotedText(text).visible;
	// `splitQuotedText` cuts at the first `>` line, which leaves the attribution
	// above it ("On …, Bob <bob@x.com> wrote:") as the last thing the sender
	// "wrote". In a preview that line is pure noise, so drop a trailing one.
	return visible.replace(/\n[^\n]*\bwrote:\s*$/i, "");
}

/** Collapse whitespace and cut to `max` characters on a code-point boundary. */
function collapseAndCut(text: string, max: number): string {
	const collapsed = text.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
	const points = Array.from(collapsed);
	if (points.length <= max) return collapsed;
	return points.slice(0, max).join("").trimEnd();
}

/**
 * Plain-text preview of a stored body.
 *
 * HTML is recognised the same way the reader recognises it (`looksLikeHtml`),
 * so a plain-text body that happens to mention `&amp;` keeps it literally rather
 * than having it decoded. Quoted replies are dropped where `quoted-text.ts` can
 * find them — a reply's preview should be the reply, not the message it quotes.
 *
 * Never returns null: an empty body gives `""`, which callers store to record
 * that the row has been processed (NULL means "not yet computed").
 */
export function toPlainSnippet(
	body: string | null | undefined,
	max: number = SNIPPET_MAX_CHARS,
): string {
	if (!body) return "";
	const plain = looksLikeHtml(body) ? htmlToPlain(body) : textToPlain(body);
	return collapseAndCut(plain, max);
}

/**
 * Tidy an FTS5 `snippet()` result for display.
 *
 * The full-text index is built over the stored body, which for HTML mail is
 * markup, so a highlighted excerpt can contain whole tags, a tag cut in half at
 * either edge, and undecoded entities. The highlight markers are control
 * characters (see `shared/fts.ts`) and survive every step here.
 */
export function cleanFtsSnippet(snippet: string | null | undefined): string {
	if (!snippet) return "";
	const stripped = snippet
		.replace(/<[^<>]*>/g, " ")
		// A tag cut off by the excerpt's left edge: `…class="x">Hello`.
		.replace(/^[^<>]*?=\s*["'][^<>]*>/, " ")
		// …and by its right edge: `Hello <a href="…`.
		.replace(/<[^<>]*$/, " ");
	return decodeHtmlEntities(stripped)
		.replace(INVISIBLE, "")
		.replace(/\s+/g, " ")
		.trim();
}
