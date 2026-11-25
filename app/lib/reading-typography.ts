/**
 * Typography decisions for the message frame.
 *
 * These lived inline in `EmailIframe` as part of a template string, which meant
 * the rules could only be checked by eye in a browser. They are pure functions of
 * the sender's HTML, so they belong somewhere a test can reach them.
 *
 * The constraint that shapes all of it: the body of a message is *someone else's
 * markup*, only partially specified. A rule that improves a plain reply can
 * destroy a table-based newsletter, so each rule below is gated on evidence that
 * the sender left that decision to us.
 */

/**
 * Whether the message brings its own colours.
 *
 * Matters because a newsletter that sets `color: #333` on its text but leaves the
 * background to the client renders near-black on near-black the moment the client
 * goes dark. There is no safe way to recolour someone else's markup, so those
 * messages stay on the light canvas they were authored against.
 *
 * Plain-text mail and simple replies — most of a working inbox — declare nothing,
 * so they get a true dark rendering.
 */
export function declaresOwnColors(html: string): boolean {
	// Legacy presentational attributes, still common in bulk mail.
	if (/<[^>]+\s(?:bgcolor|color)\s*=/i.test(html)) return true;

	// Inline styles are checked one attribute at a time rather than with a single
	// pattern over the whole document. Matching `(?:^|;)` against the full HTML
	// cannot anchor to the start of an attribute value, so a declaration that
	// comes first — `style="color:#333"`, the most common shape in real mail —
	// would go undetected and the message would be wrongly recoloured.
	for (const [, , value] of html.matchAll(/style\s*=\s*(["'])([^"']*)\1/gi)) {
		if (/(?:^|;)\s*(?:color|background(?:-color)?)\s*:/i.test(value)) {
			return true;
		}
	}
	return false;
}

/**
 * Whether the sender laid the message out themselves.
 *
 * A `<table>` in an email is almost never tabular data — it is the layout engine
 * bulk mail has used for twenty years, sized in fixed pixels. Capping the line
 * length of a document like that does nothing useful and can force horizontal
 * scrolling, so the measure cap below is withheld from these.
 *
 * A multi-column `<td>` row or an explicit width is the tell. A single-cell table
 * is a wrapper, not a layout, so it does not count.
 */
export function bringsOwnLayout(html: string): boolean {
	if (/<table\b/i.test(html)) {
		// Two or more cells in one row means columns, which means layout.
		if (/<tr\b[^>]*>(?:\s|<(?!\/tr)[^>]*>)*?<t[dh]\b[\s\S]*?<t[dh]\b/i.test(html)) {
			return true;
		}
		// An explicitly sized table is being positioned, not merely wrapped.
		if (/<table\b[^>]*\s(?:width\s*=|style\s*=\s*["'][^"']*width)/i.test(html)) {
			return true;
		}
	}
	// A max-width wrapper is the modern spelling of the same intent.
	if (/style\s*=\s*["'][^"']*max-width\s*:/i.test(html)) return true;
	return false;
}

/**
 * Elements that cannot contain anything, so they are never a message's canvas.
 *
 * A newsletter often opens with a tracking pixel or a spacer, and a forward opens
 * with a `<br>`; none of those is the surface the message is painted on.
 */
const VOID_ELEMENTS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

/**
 * The message's outermost element, or null if it has none.
 *
 * The first tag in document order is necessarily the outermost one — nothing can
 * be nested before it — so this needs no depth tracking. Void elements are
 * skipped because they hold nothing, and so are hidden ones: a preheader
 * (`display: none` text for the inbox preview) is conventionally the first thing
 * in a newsletter and is not its canvas either.
 */
function outerElementAttrs(html: string): string | null {
	const tags = html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi);
	for (const [, tag, attrs] of tags) {
		if (VOID_ELEMENTS.has(tag.toLowerCase())) continue;
		if (/style\s*=\s*(["'])[^"']*display\s*:\s*none[^"']*\1/i.test(attrs)) continue;
		return attrs;
	}
	return null;
}

/** Whether an attribute string declares a background that actually paints. */
function declaresBackground(attrs: string): boolean {
	// Legacy presentational attribute, still common in bulk mail.
	if (/\sbgcolor\s*=/i.test(attrs)) return true;

	const style = attrs.match(/style\s*=\s*(["'])([^"']*)\1/i);
	if (!style) return false;
	const value = style[2];
	if (!/(?:^|;)\s*background(?:-color|-image)?\s*:/i.test(value)) return false;
	// `none` and `transparent` are the absence of a surface, not the presence of
	// one.
	return !/(?:^|;)\s*background[^;:]*:\s*(?:none|transparent)\s*(?:;|$)/i.test(value);
}

/**
 * Whether the message paints its own surface.
 *
 * The question behind this one is "would a gutter of ours read as a frame around
 * this?", and the answer is yes for anything that arrives with a canvas of its
 * own. That is a wider set than `bringsOwnLayout`: a table sized in pixels is the
 * classic newsletter, but plenty of current ones are divs carrying a background
 * and their own padding, no table anywhere, and those look just as wrong inset
 * inside a card — a coloured band floating in a white margin, indented from a
 * column that is already indented.
 *
 * So this is `bringsOwnLayout` plus a background, but only a background on the
 * *outermost* element. Any background anywhere is far too eager: a forward built
 * by `buildForwardBody` leads with a paragraph and a signature and then insets
 * the original in a `background-color: #f9f9f9` block, and an ordinary reply may
 * hold a single highlighted callout or a shaded code block. Those are messages
 * with a coloured patch inside them, not messages with a surface of their own,
 * and dropping the gutter for them would push the text that surrounds the patch
 * flat against the frame edge.
 *
 * Deliberately narrower than `declaresOwnColors` in the other direction too,
 * which also counts a text colour: `color: #333` says nothing about whether a
 * message has a surface, and treating it as though it did would strip the gutter
 * from ordinary replies that merely set their type colour — which is most of
 * them.
 *
 * Where the outer element merely wraps the real canvas, this answers false and
 * the message keeps its gutter. That is the safe direction to be wrong in: a
 * gutter that was not needed costs some width, where one wrongly removed puts
 * text against an edge.
 */
export function paintsOwnSurface(html: string): boolean {
	if (bringsOwnLayout(html)) return true;
	const outer = outerElementAttrs(html);
	return outer === null ? false : declaresBackground(outer);
}

/**
 * The reading measure, in `ch`, or null to leave the width alone.
 *
 * ~70 characters per line is the range typographic research and every reading
 * app converges on; the mailer was letting text run the full width of the pane,
 * which on a 1920px monitor is well over 200 characters and forces the eye to
 * hunt for the start of the next line.
 *
 * Returned as `ch` rather than `px` so the measure tracks the font: it stays
 * correct if the size changes, and it stays correct when a reader has zoomed.
 */
export function readingMeasureCh(html: string): number | null {
	if (!html.trim()) return null;
	if (bringsOwnLayout(html)) return null;
	return 70;
}

/**
 * Base type scale for the message frame.
 *
 * 14px was below the 15–16px that every mail client and reading surface has
 * settled on, and it was paired with a 1.65 line-height that is generous for
 * body copy but too tight once a paragraph runs long. 15px/1.7 is the smallest
 * change that reads as comfortable at arm's length without re-flowing a
 * fixed-width newsletter, which is sized in pixels and unaffected by either.
 */
export const BODY_FONT_SIZE_PX = 15;
export const BODY_LINE_HEIGHT = 1.7;
