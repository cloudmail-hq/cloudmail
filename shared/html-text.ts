/**
 * Entity decoding for the HTML→text conversions.
 *
 * Both the worker (`workers/lib/email-helpers.ts`) and the client
 * (`app/lib/utils.ts`) flatten sender HTML into text, and both then escape that
 * text again on the way into a quoted reply. That round trip is only lossless if
 * the flattening step decodes *everything* the escaping step can emit.
 *
 * It did not. `escapeHtml` writes an apostrophe as `&#39;` in the worker and
 * `&#039;` in the client, and each converter decoded only its own spelling. So a
 * reply quoting a message that arrived already-escaped picked up a second escape
 * pass, `&#39;` became `&amp;#39;`, and the reader saw the literal text
 * `I&#39;m doing well` in the reading pane.
 *
 * Rather than add the two missing spellings in two places, entity handling lives
 * here so there is one list to keep correct.
 */

/**
 * Named references worth decoding.
 *
 * Deliberately not the full HTML5 set — that table is ~2,200 entries and the
 * ones that reach a mailbox are the five escapes plus the typography senders
 * paste out of a word processor. Anything unlisted falls through to the numeric
 * forms below, and an unknown name is left verbatim rather than guessed at.
 */
const NAMED: Record<string, string> = {
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: "\u00a0",
	mdash: "\u2014",
	ndash: "\u2013",
	hellip: "\u2026",
	rarr: "\u2192",
	larr: "\u2190",
	lsquo: "\u2018",
	rsquo: "\u2019",
	ldquo: "\u201c",
	rdquo: "\u201d",
	bull: "\u2022",
	middot: "\u00b7",
	trade: "\u2122",
	copy: "\u00a9",
	reg: "\u00ae",
	deg: "\u00b0",
	euro: "\u20ac",
	pound: "\u00a3",
	yen: "\u00a5",
	cent: "\u00a2",
	sect: "\u00a7",
	para: "\u00b6",
	dagger: "\u2020",
	permil: "\u2030",
	times: "\u00d7",
	divide: "\u00f7",
	plusmn: "\u00b1",
	frac12: "\u00bd",
	frac14: "\u00bc",
	frac34: "\u00be",
	laquo: "\u00ab",
	raquo: "\u00bb",
	shy: "\u00ad",
	ensp: "\u2002",
	emsp: "\u2003",
	thinsp: "\u2009",
	zwnj: "\u200c",
	zwj: "\u200d",
};

/**
 * Whether a code point can be represented as text.
 *
 * A lone surrogate or an out-of-range value would either throw or plant an
 * unpaired surrogate in the string, which then breaks JSON encoding much later
 * and far from here. Those references are left as written instead.
 */
function isDecodable(code: number): boolean {
	if (!Number.isFinite(code)) return false;
	if (code <= 0 || code > 0x10ffff) return false;
	// Surrogate range: only meaningful as a pair inside UTF-16, never alone.
	if (code >= 0xd800 && code <= 0xdfff) return false;
	return true;
}

/**
 * Decode HTML character references in a string of *text*.
 *
 * Call this on text already stripped of tags. Calling it on live markup would
 * turn `&lt;script&gt;` back into a real tag, so the strip must come first.
 *
 * `&amp;` is decoded in a second pass, after everything else. Doing it first
 * would resurrect escaped entities: the literal text `&lt;`, which a sender
 * writing about markup types and which arrives as `&amp;lt;`, would become
 * `&lt;` and then be eaten by the same pass — silently deleting their text.
 */
export function decodeHtmlEntities(text: string): string {
	if (!text || !text.includes("&")) return text;

	const decoded = text.replace(
		/&(#[Xx][0-9A-Fa-f]+|#\d+|[A-Za-z][A-Za-z0-9]{1,31});/g,
		(match, ref: string) => {
			if (ref.charCodeAt(0) === 35 /* # */) {
				const isHex = ref[1] === "x" || ref[1] === "X";
				const code = Number.parseInt(
					isHex ? ref.slice(2) : ref.slice(1),
					isHex ? 16 : 10,
				);
				return isDecodable(code) ? String.fromCodePoint(code) : match;
			}

			// Case-sensitive on purpose: `&Amp;` is not a valid reference, and
			// lowercasing would make up a meaning the sender did not write.
			const named = NAMED[ref];
			return named ?? match;
		},
	);

	return decoded.replace(/&amp;/g, "&");
}

/**
 * Collapse HTML to text, preserving the line structure a reader relies on.
 *
 * Block ends become newlines so a quoted message reads as paragraphs rather than
 * one flattened run, then entities are decoded. Ordering matters both ways:
 * tags are removed before decoding so an escaped tag cannot become a real one,
 * and decoding happens before whitespace collapsing so `&nbsp;` participates in
 * it instead of surviving as a stray hard space.
 */
export function htmlToTextLines(html: string): string {
	if (!html) return "";
	const withBreaks = html
		.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, "")
		.replace(/<\/(?:p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, "");

	return decodeHtmlEntities(withBreaks)
		.replace(/\u00a0/g, " ")
		.replace(/[ \t]+/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
