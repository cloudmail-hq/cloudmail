/**
 * Inbound HTML preparation for the reading pane.
 *
 * Two things happen here that the sanitiser in `EmailIframe` cannot do on its
 * own:
 *
 * 1. `cid:` references are rewritten to the attachment endpoint. Without this
 *    every embedded image in an ordinary newsletter renders broken, because
 *    `cid:` is only meaningful inside the original MIME container.
 * 2. Remote images are held back by default. A bare `<img src="https://…">` in
 *    a marketing email is usually a tracking pixel, and loading it reports the
 *    open before the reader has decided to trust the sender. Once allowed, they
 *    load through the Worker's `/img/` proxy, never from the reader's browser,
 *    and trackers stay blocked. Links lose their tracking parameters.
 */

import DOMPurify from "dompurify";

import { getAttachmentUrl } from "~/lib/utils";
import {
	formatHeaderLines,
	headerValue,
	parseStoredHeaders,
} from "shared/headers";
import { stripTrackingPixelsForDisplay } from "shared/tracking-inject";
import { cleanLinksInHtml, isTrackingImage } from "shared/email-privacy";
import type { Attachment } from "~/types";

/**
 * Sanitise HTML that will be rendered into a document sharing this origin.
 *
 * Message bodies in the reading pane do not need this: they go into
 * `EmailIframe`, which sanitises *and* sandboxes them into an opaque origin, so
 * a DOMPurify bypass still lands somewhere harmless. This is for the places that
 * have no such sandbox behind them — the signature preview, which renders
 * inline, and the print frame, which is a same-origin `about:blank` document.
 *
 * `style` and the embedding tags are dropped because nothing legitimate here
 * needs them and they are the easiest way to redress the surrounding UI.
 * Images are kept: signatures carry logos and printed mail is expected to show
 * its pictures. That does mean a remote image can load, which is a tracking
 * signal but not a script execution path.
 */
export function sanitizeInlineHtml(html: string | null | undefined): string {
	if (!html) return "";
	return DOMPurify.sanitize(html, {
		USE_PROFILES: { html: true },
		FORBID_TAGS: ["style", "form", "input", "button", "iframe", "object", "embed"],
		FORBID_ATTR: ["style"],
	});
}

export interface PreparedEmailHtml {
	html: string;
	/** How many remote images were withheld. 0 when nothing was blocked. */
	blockedRemoteCount: number;
	/**
	 * How many remote images the message contains, blocked or not.
	 *
	 * Counted in both modes so a caller can tell "this sender is trusted and had
	 * images" from "this message had none". Without it the reading pane can only
	 * see the blocked count, which goes to zero the moment images are allowed —
	 * leaving no way to offer an undo on the messages where it matters.
	 */
	remoteImageCount: number;
	/** Tracking pixels withheld, including when images are allowed. */
	trackerCount: number;
	/** Links that had tracking parameters stripped. */
	cleanedLinkCount: number;
}

/** Build a Content-ID → attachment URL map, tolerating angle brackets. */
function buildCidMap(
	mailboxId: string,
	emailId: string,
	attachments?: Attachment[],
): Map<string, string> {
	const map = new Map<string, string>();
	for (const att of attachments ?? []) {
		if (!att.content_id) continue;
		const cid = att.content_id.replace(/^<|>$/g, "").trim().toLowerCase();
		// Inline disposition: these land in an <img> inside the reading pane, and
		// an attachment disposition makes the browser download them instead of
		// rendering them.
		if (cid) {
			map.set(cid, getAttachmentUrl(mailboxId, emailId, att.id, { inline: true }));
		}
	}
	return map;
}

const REMOTE_URL = /^(https?:)?\/\//i;

/** 1×1 transparent GIF standing in for a withheld image. */
const PLACEHOLDER_GIF =
	"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Remote `url(...)` in an inline style: the CSS route to the same fetch. */
const STYLE_REMOTE_URL = /url\(\s*(["']?)\s*(?:https?:)?\/\/[^)]*?\1\s*\)/gi;

/**
 * Rewrite `cid:` sources, route or withhold remote images, block trackers and
 * clean links.
 *
 * Remote images, in order:
 *
 * 1. **Our own open pixels** are removed outright, whatever the image setting:
 *    this is the sender's browser, and a pixel quoted back in a reply must never
 *    count the sender reading their own mail as an open.
 * 2. **Trackers** (`shared/email-privacy`: a 1×1/hidden image, or a known
 *    open-tracking host) are withheld *even when images are allowed*. Allowing
 *    images is about seeing the message, not about reporting that it was read.
 * 3. **Everything else**, when the reader allows images, is pointed at the
 *    signed same-origin proxy from `imageProxy`, so the sender sees the
 *    Worker's address, not the reader's. An image the server did not sign (no
 *    entry in the map) is withheld rather than loaded directly: the document
 *    CSP allows only `'self'` for images, so a direct load would fail anyway.
 * 4. When images are not allowed, every remote image is withheld.
 *
 * A withheld image keeps its original URL in `data-blocked-src` so "Show
 * images" is a re-render rather than a refetch of the message. `srcset` and
 * remote `url()` in inline styles are always removed: neither goes through the
 * proxy.
 */
export function prepareEmailHtml(
	html: string | null | undefined,
	options: {
		mailboxId: string;
		emailId: string;
		attachments?: Attachment[];
		/** When false, remote images are replaced with a 1×1 transparent pixel. */
		allowRemoteImages: boolean;
		/** Raw `src` → signed `/img/` path, from the read API's `image_proxy`. */
		imageProxy?: Record<string, string>;
		/** Strip `utm_*`, `fbclid` and similar from links. Defaults to on. */
		cleanLinks?: boolean;
	},
): PreparedEmailHtml {
	if (!html) return { html: "", blockedRemoteCount: 0, remoteImageCount: 0, trackerCount: 0, cleanedLinkCount: 0 };

	const cidMap = buildCidMap(
		options.mailboxId,
		options.emailId,
		options.attachments,
	);
	const proxy = options.imageProxy ?? {};

	let blockedRemoteCount = 0;
	let remoteImageCount = 0;
	let trackerCount = 0;

	const withhold = (prefix: string, quote: string, url: string, tracker: boolean) =>
		`${prefix}${tracker ? " data-tracker" : ""} data-blocked-src=${quote}${url}${quote} src=${quote}${PLACEHOLDER_GIF}${quote}`;

	let out = stripTrackingPixelsForDisplay(html).replace(
		/(<img\b[^>]*?)\ssrc=(["'])(.*?)\2/gi,
		(match, prefix: string, quote: string, url: string, offset: number, whole: string) => {
			const trimmed = url.trim();

			if (/^cid:/i.test(trimmed)) {
				const cid = trimmed.slice(4).replace(/^<|>$/g, "").toLowerCase();
				const resolved = cidMap.get(cid);
				return resolved
					? `${prefix} src=${quote}${resolved}${quote}`
					: match;
			}

			if (!REMOTE_URL.test(trimmed)) return match;

			// The whole tag, for the pixel-shape check: attributes after `src`
			// (width="1" height="1") matter as much as those before it.
			const tagEnd = whole.indexOf(">", offset + match.length);
			const tag = whole.slice(offset, tagEnd === -1 ? undefined : tagEnd + 1);
			if (isTrackingImage(tag, trimmed)) {
				trackerCount += 1;
				return withhold(prefix, quote, trimmed, true);
			}

			remoteImageCount += 1;
			const proxied = proxy[trimmed];
			if (options.allowRemoteImages && proxied) {
				return `${prefix} src=${quote}${proxied}${quote}`;
			}
			blockedRemoteCount += options.allowRemoteImages ? 0 : 1;
			return withhold(prefix, quote, trimmed, false);
		},
	);

	// Neither goes through the proxy, so neither may reach the network.
	out = out.replace(/\ssrcset=(["']).*?\1/gi, "");
	out = out.replace(/(\sstyle=)(["'])(.*?)\2/gi, (_m, attr: string, quote: string, css: string) =>
		`${attr}${quote}${css.replace(STYLE_REMOTE_URL, "none")}${quote}`,
	);

	let cleanedLinkCount = 0;
	if (options.cleanLinks !== false) {
		const cleaned = cleanLinksInHtml(out);
		out = cleaned.html;
		cleanedLinkCount = cleaned.cleaned;
	}

	return { html: out, blockedRemoteCount, remoteImageCount, trackerCount, cleanedLinkCount };
}

/**
 * Serialise a message back to an RFC 5322-ish `.eml` for download.
 *
 * Built from the stored headers when we have them, falling back to a minimal
 * header block. Good enough to hand to another mail client or an auditor, which
 * is the reason people ask for "download original".
 *
 * The stored column is a JSON array, not a header block — see
 * `shared/headers.ts`. Writing it in verbatim produced a `.eml` whose header
 * section was a line of JSON, which no mail client can open. It is parsed and
 * re-rendered as header lines instead.
 */
export function toEmlBlob(email: {
	subject?: string | null;
	sender?: string | null;
	recipient?: string | null;
	cc?: string | null;
	date?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	body?: string | null;
}): Blob {
	const stored = parseStoredHeaders(email.raw_headers);
	const headers = stored.length > 0
		? formatHeaderLines(stored)
		: [
				`From: ${email.sender ?? ""}`,
				`To: ${email.recipient ?? ""}`,
				email.cc ? `Cc: ${email.cc}` : null,
				`Subject: ${email.subject ?? ""}`,
				email.date ? `Date: ${new Date(email.date).toUTCString()}` : null,
				email.message_id ? `Message-ID: ${email.message_id}` : null,
				"MIME-Version: 1.0",
				'Content-Type: text/html; charset="utf-8"',
			]
				.filter(Boolean)
				.join("\r\n");

	return new Blob([`${headers}\r\n\r\n${email.body ?? ""}`], {
		type: "message/rfc822",
	});
}

/**
 * Pull the best unsubscribe target out of the stored headers.
 *
 * Prefers an `https:` link, because a `mailto:` unsubscribe requires composing
 * a message and the one-click HTTP form is what most senders honour (RFC 8058).
 *
 * Reads the headers through `shared/headers.ts` rather than regex-matching the
 * column. The column holds a JSON array, so the line-anchored patterns this used
 * to apply matched nothing on real inbound mail and the control never appeared —
 * invisibly, because "no such header" and "could not read the headers" both came
 * back as null.
 */
export function parseUnsubscribe(rawHeaders?: string | null): {
	url?: string;
	mailto?: string;
	oneClick: boolean;
} | null {
	const headers = parseStoredHeaders(rawHeaders);
	if (headers.length === 0) return null;

	const listHeader = headerValue(headers, "List-Unsubscribe");
	if (!listHeader) return null;

	// RFC 8058 requires exactly this value, and requires the POST form to be
	// honoured without a confirmation step. Matched loosely on whitespace only.
	const oneClick = /^List-Unsubscribe\s*=\s*One-Click$/i.test(
		headerValue(headers, "List-Unsubscribe-Post") ?? "",
	);

	const targets = [...listHeader.matchAll(/<([^>]+)>/g)].map((m) => m[1]!.trim());
	const url = targets.find((t) => /^https?:/i.test(t));
	const mailto = targets.find((t) => /^mailto:/i.test(t));

	if (!url && !mailto) return null;
	return { url, mailto, oneClick };
}
