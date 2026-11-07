// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Signature-block removal for the reading pane.
 *
 * Serves the `display.hideSignaturesInChat` preference. Only the container this
 * app writes is removed — `div.email-signature`, produced by
 * `renderSignatureBlock` in `app/lib/utils.ts` — not anything that merely looks
 * like a sign-off. Guessing at "— Name" and four lines of contact details is how
 * a display preference silently eats a paragraph of a message, and a mail client
 * that hides content the sender wrote is a worse failure than one that shows a
 * signature the reader asked to hide.
 *
 * Lives in `shared/` rather than beside the DOM helpers so it can be unit tested
 * in a plain Node environment, as the quoted-text splitter is.
 */

/** The class `renderSignatureBlock` puts on the wrapper it emits. */
const SIGNATURE_CLASS = "email-signature";

/**
 * Any opening tag carrying a `class` attribute.
 *
 * Any element, not just `div`: the class is the contract, and pinning the tag
 * name would miss a wrapper someone reasonably changes to a `<section>`. Whether
 * the class list actually contains the signature class is decided by
 * {@link hasSignatureClass}, not here — `\b` treats `-` as a word boundary, so a
 * regex boundary around the name also matched `email-signature-preview` and
 * removed a block that is a different thing entirely.
 */
const TAG_WITH_CLASS =
	/<([a-z][a-z0-9-]*)\b[^>]*\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;

/**
 * True when a `class` attribute value lists the signature class exactly.
 *
 * Split on whitespace and compared whole, which is what the HTML class list
 * means: `email-signature-preview` is one token and is not a match.
 */
function hasSignatureClass(value: string | undefined): boolean {
	if (!value) return false;
	return value.split(/\s+/).includes(SIGNATURE_CLASS);
}

/** True when this opening tag is self-closing and so encloses nothing. */
function isSelfClosing(tag: string): boolean {
	return /\/\s*>$/.test(tag);
}

/**
 * Index just past the element that opens at `start`, or -1 when it never closes.
 *
 * Depth-counted rather than "find the next `</div>`": a signature routinely wraps
 * a table or nested divs, and stopping at the first close tag would cut the
 * message in half and leave the rest of the signature behind as orphaned markup.
 */
function findElementEnd(html: string, start: number, tagName: string): number {
	const open = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
	const close = new RegExp(`</${tagName}\\s*>`, "gi");

	// Start scanning after the opening tag, which the caller has already matched.
	const openTagEnd = html.indexOf(">", start);
	if (openTagEnd === -1) return -1;

	let depth = 1;
	let cursor = openTagEnd + 1;

	while (depth > 0) {
		open.lastIndex = cursor;
		close.lastIndex = cursor;

		const nextOpen = open.exec(html);
		const nextClose = close.exec(html);

		// Unbalanced markup: the element is never closed. Removing to the end of
		// the document would take the rest of the message with it, so the caller
		// is told to leave the body alone instead.
		if (!nextClose) return -1;

		if (nextOpen && nextOpen.index < nextClose.index) {
			if (!isSelfClosing(nextOpen[0])) depth += 1;
			cursor = nextOpen.index + nextOpen[0].length;
			continue;
		}

		depth -= 1;
		cursor = nextClose.index + nextClose[0].length;
	}

	return cursor;
}

/**
 * Remove every signature block this app appended.
 *
 * Returns the body unchanged when there is nothing to remove, so a caller can
 * pass any message through without checking first. Every block is removed, not
 * just the first: a thread that has been replied to several times inside one
 * body carries one per round.
 */
export function stripSignatureBlocks(html: string | null | undefined): string {
	if (!html) return "";
	if (!html.includes(SIGNATURE_CLASS)) return html;

	let out = html;

	// Each pass rescans from the start of the shortened string. Rescanning rather
	// than advancing a cursor is what makes nested signatures fall out: removing
	// an outer block takes any inner one with it, and the next scan simply does
	// not find them.
	for (;;) {
		TAG_WITH_CLASS.lastIndex = 0;
		let match: RegExpExecArray | null = null;
		let found: RegExpExecArray | null = null;

		while ((match = TAG_WITH_CLASS.exec(out)) !== null) {
			// One of the three alternatives captured the value: double-quoted,
			// single-quoted, or bare.
			if (hasSignatureClass(match[2] ?? match[3] ?? match[4])) {
				found = match;
				break;
			}
		}

		if (!found) break;

		if (isSelfClosing(found[0])) {
			out = out.slice(0, found.index) + out.slice(found.index + found[0].length);
			continue;
		}

		const end = findElementEnd(out, found.index, found[1]);
		// Unbalanced markup. Removing to end-of-document would take the rest of
		// the message with it, so the body is left as it is.
		if (end === -1) break;

		out = out.slice(0, found.index) + out.slice(end);
	}

	return out;
}
