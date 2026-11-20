// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Quoted-reply detection.
 *
 * Every mail client appends the message it is replying to at the bottom of
 * the outgoing body. Rendering that verbatim means the same text appears
 * once per message in a thread, which makes a conversation unreadable.
 *
 * These helpers split a body into the part the sender actually wrote
 * (`visible`) and the trailing quote chain (`quoted`), so the UI can hide
 * the quote behind a "show trimmed content" toggle, and reply builders can
 * avoid re-quoting history that is already in the thread.
 *
 * Deliberately string/regex based (no DOM): it runs in the browser, in
 * Workers, and in plain Node tests. Both halves of an HTML split are passed
 * through DOMPurify before rendering, which re-balances any tag that the
 * cut left open.
 */

export interface QuoteSplit {
	/** What the sender wrote. Never empty when the input is non-empty. */
	visible: string;
	/** Trailing quote chain, or "" when nothing was detected. */
	quoted: string;
	/** True when a quote was found and removed from `visible`. */
	hasQuote: boolean;
}

/**
 * Wrapper elements that clients use to mark the whole quoted section.
 * Matching one of these is the highest-confidence signal available.
 */
const QUOTE_CONTAINER_PATTERNS: RegExp[] = [
	// Gmail. `gmail_extra` is deliberately absent: it also wraps the sender's
	// signature, and the attribution line inside it is detected anyway.
	/<div[^>]*class\s*=\s*["'][^"']*\bgmail_quote\b/i,
	// Yahoo
	/<div[^>]*class\s*=\s*["'][^"']*\byahoo_quoted\b/i,
	/<div[^>]*id\s*=\s*["']yahoo_quoted/i,
	// Thunderbird
	/<div[^>]*class\s*=\s*["'][^"']*\bmoz-cite-prefix\b/i,
	// Outlook / OWA
	/<div[^>]*id\s*=\s*["']divRplyFwdMsg/i,
	/<div[^>]*id\s*=\s*["']appendonsend/i,
	/<div[^>]*class\s*=\s*["'][^"']*\bx?_?OutlookMessageHeader\b/i,
	// Zoho / Superhuman / generic
	/<div[^>]*class\s*=\s*["'][^"']*\b(?:zmail_extra|quoted-?text|reply-?quote)\b/i,
];

/** "-----Original Message-----" style separators. */
const DASH_SEPARATOR_PATTERN =
	/-{2,}\s*(?:original\s+message|forwarded\s+message|reply\s+message)\s*-{2,}/i;

/**
 * Outlook's rule above a quote. On its own a run of underscores is just a
 * divider, so it only counts when mail headers follow it.
 */
const UNDERSCORE_SEPARATOR_PATTERN = /_{20,}/;

/** Headers that make an underscore rule a real quote boundary. */
const TRAILING_HEADER_PATTERN = /(?:From|Sent|Date|Subject)\s*:/i;

/**
 * Attribution lines ("On <date>, <who> wrote:"), including a few common
 * non-English variants. Kept tag-free (`[^<>]`) so a match cannot span
 * across markup, and validated by {@link isPlausibleAttribution}.
 */
const ATTRIBUTION_PATTERNS: RegExp[] = [
	/On\s[^<>]{5,400}?\bwrote\s*:/i,
	/Le\s[^<>]{5,400}?\ba\s+écrit\s*:/i,
	/El\s[^<>]{5,400}?\bescribió\s*:/i,
	/Am\s[^<>]{5,400}?\bschrieb\s*:/i,
	/\d{4}[-/]\d{1,2}[-/]\d{1,2}[^<>]{0,200}?\bwrote\s*:/i,
];

/** Outlook's header block: "From: … Sent: …" (order of the pair varies). */
const HEADER_BLOCK_PATTERN =
	/From\s*:\s*[^<>]{3,300}?(?:<[^>]*>\s*)*(?:Sent|Date)\s*:/i;

/**
 * An attribution line always carries a timestamp and an address. Requiring
 * both keeps prose like "On Monday the team wrote: hello" out of the match.
 */
function isPlausibleAttribution(candidate: string): boolean {
	if (!/\d/.test(candidate)) return false;
	// The patterns never span markup, so a raw "<" cannot appear here — an
	// address shows up either bare or entity-escaped.
	return /@|&lt;|\bAM\b|\bPM\b/i.test(candidate);
}

/** True when the body looks like HTML rather than a plain-text part. */
export function looksLikeHtml(body: string): boolean {
	return /<(?:br|p|div|table|blockquote|span|a|html|body|img)\b[^>]*>/i.test(
		body,
	);
}

/** Text content length, ignoring tags and entities. */
function textLength(html: string): number {
	return html
		.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, "")
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/\s+/g, " ")
		.trim().length;
}

/**
 * Walk backwards from `index` over whitespace, `&nbsp;`, and opening tags
 * so the cut lands before the markup that wraps the quote (`<blockquote>`,
 * `<div class=…>`, trailing `<br>`s) instead of in the middle of it.
 * Stops at closing tags so preceding content is never swallowed.
 */
function rewindToBoundary(html: string, index: number): number {
	let i = escapeTagInterior(html, index);

	for (;;) {
		let j = i;
		while (j > 0 && /\s/.test(html[j - 1])) j--;

		if (j >= 6 && html.slice(j - 6, j).toLowerCase() === "&nbsp;") {
			i = j - 6;
			continue;
		}

		if (j > 0 && html[j - 1] === ">") {
			const open = html.lastIndexOf("<", j - 1);
			// Only rewind past opening/void tags, never past `</…>`.
			if (open >= 0 && html[open + 1] !== "/") {
				i = open;
				continue;
			}
		}

		return j;
	}
}

/**
 * A pattern can match inside an attribute value (`<div title="On Fri, … wrote:">`).
 * Cutting there would leave half a tag on each side, so move the index back to
 * the start of the tag it landed in.
 */
function escapeTagInterior(html: string, index: number): number {
	const open = html.lastIndexOf("<", index);
	if (open === -1) return index;
	const close = html.indexOf(">", open);
	return close === -1 || close >= index ? open : index;
}

function earliest(current: number, candidate: number): number {
	if (candidate < 0) return current;
	return current === -1 ? candidate : Math.min(current, candidate);
}

/** Do mail headers follow shortly after `from`? */
function hasHeadersAfter(html: string, from: number): boolean {
	return TRAILING_HEADER_PATTERN.test(html.slice(from, from + 300));
}

/** Index where the quoted section starts, or -1 when there is none. */
function findHtmlQuoteStart(html: string): number {
	let boundary = -1;

	for (const pattern of QUOTE_CONTAINER_PATTERNS) {
		const match = pattern.exec(html);
		if (match) boundary = earliest(boundary, match.index);
	}

	for (const pattern of [DASH_SEPARATOR_PATTERN, HEADER_BLOCK_PATTERN]) {
		const match = pattern.exec(html);
		if (match) boundary = earliest(boundary, rewindToBoundary(html, match.index));
	}

	const underscores = UNDERSCORE_SEPARATOR_PATTERN.exec(html);
	if (underscores && hasHeadersAfter(html, underscores.index + underscores[0].length)) {
		boundary = earliest(boundary, rewindToBoundary(html, underscores.index));
	}

	for (const pattern of ATTRIBUTION_PATTERNS) {
		const match = pattern.exec(html);
		if (match && isPlausibleAttribution(match[0])) {
			boundary = earliest(boundary, rewindToBoundary(html, match.index));
		}
	}

	// A trailing <blockquote> with no attribution line is still a quote
	// (Apple Mail, and our own older reply builder).
	const blockquote = /<blockquote\b/i.exec(html);
	if (blockquote && /<\/blockquote>\s*$/i.test(html)) {
		boundary = earliest(boundary, rewindToBoundary(html, blockquote.index));
	}

	return boundary;
}

/** Split an HTML body into the sender's own text and the quote chain. */
export function splitQuotedHtml(html: string): QuoteSplit {
	if (!html) return { visible: "", quoted: "", hasQuote: false };

	const boundary = findHtmlQuoteStart(html);
	if (boundary <= 0) return { visible: html, quoted: "", hasQuote: false };

	const visible = html.slice(0, boundary);
	const quoted = html.slice(boundary);

	// Nothing was actually written above the quote (a bare forward, or a
	// reply sent empty). Showing an empty bubble is worse than showing the
	// quote, so leave the body untouched.
	if (textLength(visible) === 0) {
		return { visible: html, quoted: "", hasQuote: false };
	}

	// `hasQuote` gates the reveal toggle in the UI, so it has to be true
	// whenever anything was taken out of `visible` — including a quote that
	// holds only images. Reporting false there would drop content silently.
	if (!quoted.trim()) return { visible: html, quoted: "", hasQuote: false };

	return { visible, quoted, hasQuote: true };
}

/** Line index where the quoted section starts, or -1 when there is none. */
function findTextQuoteStart(lines: string[]): number {
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (/^\s*>/.test(line)) return i;

		if (DASH_SEPARATOR_PATTERN.test(line)) return i;

		// A bare "____" divider only counts when mail headers follow.
		if (UNDERSCORE_SEPARATOR_PATTERN.test(line)) {
			const lookahead = lines.slice(i + 1, i + 4).join("\n");
			if (/^\s*From\s*:/im.test(lookahead)) return i;
			continue;
		}

		if (/^\s*From\s*:\s*\S/i.test(line)) {
			const lookahead = lines.slice(i + 1, i + 5).join("\n");
			if (/^\s*(?:Sent|Date|To|Subject)\s*:/im.test(lookahead)) return i;
		}

		// Attribution lines wrap, so also test the line joined with the next.
		const joined = `${line} ${lines[i + 1] ?? ""}`;
		for (const pattern of ATTRIBUTION_PATTERNS) {
			const match = pattern.exec(joined);
			if (match && isPlausibleAttribution(match[0])) return i;
		}
	}

	return -1;
}

/** Split a plain-text body into the sender's own text and the quote chain. */
export function splitQuotedText(text: string): QuoteSplit {
	if (!text) return { visible: "", quoted: "", hasQuote: false };

	const lines = text.split(/\r?\n/);
	const boundary = findTextQuoteStart(lines);
	if (boundary <= 0) return { visible: text, quoted: "", hasQuote: false };

	const visible = lines.slice(0, boundary).join("\n");
	const quoted = lines.slice(boundary).join("\n");

	// Same invariant as the HTML path: never trim `visible` without handing
	// back a quote for the UI to reveal.
	if (!visible.trim() || !quoted.trim()) {
		return { visible: text, quoted: "", hasQuote: false };
	}

	return { visible, quoted, hasQuote: true };
}

/** Split a body of either flavour, detecting HTML automatically. */
export function splitQuotedBody(body: string | null | undefined): QuoteSplit {
	if (!body) return { visible: "", quoted: "", hasQuote: false };
	return looksLikeHtml(body) ? splitQuotedHtml(body) : splitQuotedText(body);
}
