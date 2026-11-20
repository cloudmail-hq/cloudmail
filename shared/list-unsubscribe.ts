// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * RFC 2369 / RFC 8058 unsubscribe headers and the optional footer.
 *
 * Gmail and Yahoo require bulk senders to offer one-click unsubscribe:
 *
 *     List-Unsubscribe: <https://host/u/TOKEN>, <mailto:box@domain?subject=unsubscribe>
 *     List-Unsubscribe-Post: List-Unsubscribe=One-Click
 *
 * The provider POSTs `List-Unsubscribe=One-Click` to the https URL without
 * fetching anything first, which is why `/u/:token` accepts a cookieless POST.
 *
 * Both headers are on Email Service's allowlist (`shared/email-headers.ts`).
 * Its limits matter here: a value over 2,048 bytes rejects the whole message,
 * so the builder refuses to emit an oversized header rather than let it
 * through, and the https URL must be inside angle brackets.
 */

/** Email Service's per-header value limit. */
export const MAX_HEADER_VALUE_BYTES = 2048;

export interface ListUnsubscribeOptions {
	/** Absolute https URL of the one-click endpoint. */
	url: string;
	/** Optional mailto target, usually the sending mailbox. */
	mailto?: string | null;
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

/**
 * Build the header pair, or `{}` when it cannot be built safely.
 *
 * Returning nothing rather than throwing is deliberate: the unsubscribe header
 * is an addition to a send, and an invalid one would reject the whole message
 * at the provider. A send without the header is degraded; a send that never
 * leaves is broken.
 */
export function buildListUnsubscribeHeaders(
	options: ListUnsubscribeOptions,
): Record<string, string> {
	let url: URL;
	try {
		url = new URL(options.url);
	} catch {
		return {};
	}
	// RFC 8058 §3.1: the one-click URI MUST be https.
	if (url.protocol !== "https:") return {};
	if (/[<>,\s]/.test(options.url)) return {};

	const parts = [`<${url.toString()}>`];
	const mailto = options.mailto?.trim().toLowerCase();
	if (mailto && /^[^\s@<>,]+@[^\s@<>,]+$/.test(mailto)) {
		parts.push(`<mailto:${mailto}?subject=unsubscribe>`);
	}

	let value = parts.join(", ");
	if (byteLength(value) > MAX_HEADER_VALUE_BYTES) {
		// Drop the mailto first; the https link is the one that matters.
		value = parts[0];
		if (byteLength(value) > MAX_HEADER_VALUE_BYTES) return {};
	}

	return {
		"List-Unsubscribe": value,
		"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
	};
}

function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/** The placeholder a template may use to position the link itself. */
export const UNSUBSCRIBE_PLACEHOLDER = "{{unsubscribe_url}}";

/**
 * Put the unsubscribe link into an HTML body.
 *
 * A template that already places `{{unsubscribe_url}}` gets it substituted in
 * place and no footer. Otherwise, with `footer` on, a small footer is
 * appended (inside `</body>` when the body is a full document). With `footer`
 * off the body is returned with the placeholder substituted only.
 */
export function applyUnsubscribeToHtml(
	html: string,
	url: string,
	options: { footer: boolean },
): string {
	const safe = escapeAttribute(url);
	if (html.includes(UNSUBSCRIBE_PLACEHOLDER)) {
		return html.split(UNSUBSCRIBE_PLACEHOLDER).join(safe);
	}
	if (!options.footer) return html;

	const footer =
		`<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#6b7280">` +
		`Don't want these emails? <a href="${safe}" style="color:#6b7280">Unsubscribe</a>.</p>`;
	const closing = html.search(/<\/body\s*>/i);
	return closing === -1
		? `${html}${footer}`
		: `${html.slice(0, closing)}${footer}${html.slice(closing)}`;
}

/** Plain-text counterpart of {@link applyUnsubscribeToHtml}. */
export function applyUnsubscribeToText(
	text: string,
	url: string,
	options: { footer: boolean },
): string {
	if (text.includes(UNSUBSCRIBE_PLACEHOLDER)) {
		return text.split(UNSUBSCRIBE_PLACEHOLDER).join(url);
	}
	if (!options.footer) return text;
	return `${text.replace(/\s+$/, "")}\n\n--\nUnsubscribe: ${url}\n`;
}
