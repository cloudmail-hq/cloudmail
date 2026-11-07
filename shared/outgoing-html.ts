/**
 * The last step for the HTML of every outgoing message (called by
 * `sendEmail`, the one function all send paths go through).
 *
 * - Declares `color-scheme: light dark`. With no hard-coded body colours,
 *   Apple Mail and Outlook then render the message natively in dark mode
 *   instead of inverting it.
 * - Wraps a body fragment in one font wrapper (font family, size and line
 *   height, never a colour or background), so every message from the app
 *   looks the same and nothing inherits a client's serif default.
 * - Drops absolute black and white text colours (`#000`, `#fff`, `black`,
 *   `white`, `rgb(0,0,0)`, `rgb(255,255,255)`) from inline styles without a
 *   background of their own. Those are what go invisible when a reader flips
 *   the background; with no colour the client's own text colour applies.
 *
 * A full document (one with `<html>`) is the caller's design, such as the
 * password reset mail: it only gets the meta tags. The function is pure,
 * string-based (no DOM in the Worker) and idempotent.
 */

import { looksLikeHtml } from "./tracking-inject";

export const OUTGOING_BODY_MARKER = "data-cloudmail-body";

export const OUTGOING_FONT_STYLE =
	"font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5;";

const COLOR_SCHEME_META =
	'<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">';

const ABSOLUTE_COLOR =
	/^(#0{3}|#0{6}|#f{3}|#f{6}|black|white|rgba?\(\s*0\s*,\s*0\s*,\s*0\s*(,\s*1(\.0+)?\s*)?\)|rgba?\(\s*255\s*,\s*255\s*,\s*255\s*(,\s*1(\.0+)?\s*)?\))$/i;

/** A background anywhere outside a highlight, including the legacy attribute. */
const SETS_BACKGROUND = /background(-color|-image)?\s*:|\sbgcolor\s*=/i;
const MARK_BACKGROUND = /<mark\b[^>]*>/gi;

/**
 * Remove `color:` declarations that are absolute black or white.
 *
 * Only for bodies that set no background of their own (highlights aside).
 * The check has to be whole-body: this is string-based, and white text on a
 * dark container's background (`<div style="background:#000"><p
 * style="color:#fff">`) must keep its colour, or it turns black on black.
 * The composer's HTML never sets backgrounds, so its absolute colours go;
 * designed mail with backgrounds is left exactly as written. Only real tags
 * are touched, so a code sample showing `style="color:black"` as escaped text
 * is not rewritten.
 */
export function dropAbsoluteTextColors(html: string): string {
	if (SETS_BACKGROUND.test(html.replace(MARK_BACKGROUND, ""))) return html;
	return html.replace(/<[a-z][^<>]*>/gi, (tag) =>
		tag.replace(/(\sstyle\s*=\s*)(["'])(.*?)\2/is, (whole, prefix: string, quote: string, style: string) => {
			const decls = style.split(";");
			if (decls.some((d) => /^\s*background(-color)?\s*:/i.test(d))) return whole;
			const kept = decls.filter((d) => {
				const m = /^\s*color\s*:\s*(.+?)\s*(!important)?\s*$/i.exec(d);
				return !(m && ABSOLUTE_COLOR.test(m[1]));
			});
			if (kept.length === decls.length) return whole;
			const next = kept.join(";").trim();
			return next && next !== ";" ? `${prefix}${quote}${next}${quote}` : "";
		}),
	);
}

export function prepareOutgoingHtml(html: string | undefined): string | undefined {
	if (!html || !html.trim()) return html;
	if (html.includes(OUTGOING_BODY_MARKER)) return html;
	// Several paths hand plain text over as `html`; wrapping it would make the
	// line breaks collapse. Same test the tracking injector uses.
	if (!looksLikeHtml(html)) return html;
	const hasScheme = /<meta[^>]+name\s*=\s*["']?color-scheme/i.test(html);

	if (/<html[\s>]/i.test(html)) {
		if (hasScheme) return html;
		if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (head) => `${head}${COLOR_SCHEME_META}`);
		return html.replace(/<html[^>]*>/i, (tag) => `${tag}<head>${COLOR_SCHEME_META}</head>`);
	}

	return (
		`<!DOCTYPE html><html><head><meta charset="utf-8">${COLOR_SCHEME_META}</head>` +
		`<body><div ${OUTGOING_BODY_MARKER}="1" style="${OUTGOING_FONT_STYLE}">${dropAbsoluteTextColors(html)}</div></body></html>`
	);
}
