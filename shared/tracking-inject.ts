// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Rewrite an outgoing HTML body to carry open- and click-tracking.
 *
 * ## What it does and, deliberately, does not touch
 *
 * This runs on the copy handed to `env.EMAIL.send()` ONLY. The Sent copy stored
 * in the mailbox keeps the original, untouched HTML, so the reading pane, the
 * `.eml`/mbox exporters and any human reading their own Sent folder see the mail
 * as written — not a version littered with redirect URLs and an invisible pixel.
 * The recipient's copy is the one instrumented; ours is not.
 *
 * Two transforms, each independently gated by the mailbox's settings:
 *
 *   - **Click tracking** rewrites every `href` on an `<a>` to a signed
 *     `/t/c/<token>` redirect whose token carries the real destination under its
 *     signature. Only `http(s)` links are wrapped; `mailto:`, `tel:`, anchors and
 *     already-tracked links are left alone, because wrapping them either breaks
 *     them or points the redirect at something it must not send a reader to.
 *   - **Open tracking** appends a 1×1 `<img>` pointing at `/t/o/<token>` just
 *     before `</body>` (or at the end when there is no body tag). One pixel per
 *     message.
 *
 * ## Why token minting is injected
 *
 * Signing needs the mailbox secret and is async; this module is otherwise pure
 * string work and is heavily tested. So the caller passes a `signOpen` /
 * `signClick` pair that already closes over the secret and the payload shape,
 * and this module only decides *what* to sign and *where* to put the result.
 * That keeps the crypto in one place (`shared/tracking-token.ts`) and lets the
 * rewrite be tested with a trivial fake signer.
 *
 * ## HTML handling
 *
 * A mail body is not a document we control, so the rewrite is intentionally
 * conservative regex over `<a ... href="...">`, not a DOM parse: a full parser
 * would re-serialise the whole body and risk changing markup the sender
 * intended. The `href` matcher handles single and double quotes and skips links
 * that are already absolute-tracked or non-http. Anything it is unsure about it
 * leaves untouched — a missed wrap loses one click's tracking, while a botched
 * rewrite could break the link entirely, and the second is far worse.
 */

/** Signs an open-pixel token for this message/recipient. Returns the token. */
export type OpenSigner = () => Promise<string>;

/** Signs a click token for a specific destination URL. Returns the token. */
export type ClickSigner = (url: string) => Promise<string>;

export interface TrackingInjectOptions {
	/** Absolute origin the tracking URLs point at, e.g. `https://mailer.tapetide.com`. No trailing slash. */
	baseUrl: string;
	openTracking: boolean;
	clickTracking: boolean;
	signOpen: OpenSigner;
	signClick: ClickSigner;
}

/**
 * Whether a URL is a wrappable http(s) link (not mailto/tel/anchor/data).
 *
 * Protocol-relative (`//host/path`) is deliberately NOT trackable. It would
 * resolve to http(s) in a browser, but the click endpoint validates the signed
 * destination with `new URL(url)` and no base, which cannot parse it — so
 * wrapping one turned a working link into a 400. Guessing a scheme on the
 * sender's behalf is worse than leaving the link alone, so it goes through
 * untouched and simply is not tracked.
 */
function isTrackableLink(href: string): boolean {
	const trimmed = href.trim();
	if (trimmed === "") return false;
	if (trimmed.startsWith("//")) return false;
	const scheme = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
	if (!scheme) return false; // relative link, no host to redirect to
	const proto = scheme[1].toLowerCase();
	return proto === "http" || proto === "https";
}

/**
 * A link that already points at this deployment's click redirect.
 *
 * Wrapping it again would chain two redirects and count one click twice, so a
 * body instrumented once is left as it is the second time through.
 */
function isOwnTrackedLink(href: string, baseUrl: string): boolean {
	return href.trim().startsWith(`${baseUrl}/t/c/`);
}

const HREF_RE = /(<a\b[^>]*?\shref\s*=\s*)(["'])(.*?)\2/gi;

/**
 * Every spelling of `&` that is valid in an HTML attribute.
 *
 * An href encodes its query separators as an entity, and only decoding the named
 * lowercase form left `&#38;`/`&#x26;`/`&AMP;` literal inside the signed URL.
 * After the redirect a numeric form reads as part of the path rather than a
 * separator, so query parameters were silently lost and the tracked link no
 * longer matched what the sender wrote.
 */
const ENTITY_AMP_RE = /&(?:amp|AMP|Amp|#0*38|#[xX]0*26);/g;

/** Decode `&`-entities in an href so the signed URL is the true destination. */
function decodeHrefEntities(href: string): string {
	return href.replace(ENTITY_AMP_RE, "&");
}

/**
 * Rewrite an HTML body for tracking.
 *
 * Runs the click rewrite first (so the pixel we add is never itself wrapped),
 * then appends the open pixel. Each transform is skipped when its setting is
 * off, so a mailbox with only click tracking on gets links wrapped and no pixel.
 *
 * Async because signing is; collects the links to wrap in one pass, signs them,
 * then substitutes, so the number of await points is bounded by the link count
 * rather than serialised inside a regex callback.
 */
export async function injectTracking(
	html: string,
	options: TrackingInjectOptions,
): Promise<string> {
	let output = html;

	if (options.clickTracking) {
		output = await rewriteLinks(output, options);
	}

	// Idempotent: every pixel this module inserted earlier is removed before the
	// new one goes in, so the recipient's copy carries exactly one. Two things
	// can put one there: a body run through here twice (composed, queued, then
	// delivered), and a reply or forward that quotes an earlier tracked message
	// whose client kept our `<img>`. "Already has a pixel, skip" would be wrong
	// for the second: the quoted pixel's token names the OLD message, so this one
	// would go untracked and its opens would be filed under the other.
	if (options.openTracking) {
		output = stripOwnPixels(output);
		const token = await options.signOpen();
		const pixel = `<img ${PIXEL_MARKER}="1" src="${options.baseUrl}/t/o/${token}" alt="" width="1" height="1" style="display:none;max-width:1px;max-height:1px;border:0" />`;
		output = insertBeforeBodyEnd(output, pixel);
	}

	return output;
}

/**
 * Attribute on the pixel this module inserts.
 *
 * A marker rather than a `/t/o/` URL match, so a pixel is recognised whatever
 * host it was minted for (preview deployments, a changed `APP_URL`), and so an
 * unrelated image that happens to live under a `/t/o/` path is never touched.
 */
export const PIXEL_MARKER = "data-tt-open";

const OWN_PIXEL_RE = new RegExp(`<img\\b[^>]*\\s${PIXEL_MARKER}\\b[^>]*>`, "gi");

/** Remove every pixel `injectTracking` inserted. */
export function stripOwnPixels(html: string): string {
	return html.replace(OWN_PIXEL_RE, "");
}

/**
 * An `<img>` whose source is one of our open-pixel URLs, on any host: a signed
 * token is `<base64url>.<base64url>` under `/t/o/`. Wider than the marker so a
 * client that dropped our attribute while quoting still matches.
 */
const PIXEL_URL_IMG_RE =
	// Payload and HMAC-SHA256 signature (43 base64url chars) are both long; a
	// `/t/o/logo.png` on someone's CDN is not.
	/<img\b[^>]*?\ssrc\s*=\s*(["'])[^"']*\/t\/o\/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{40,}\1[^>]*>/gi;

/**
 * Remove every open pixel of ours from a body about to be SHOWN in this app.
 *
 * The reading pane is the sender's own browser. A reply quoting our message
 * often keeps our pixel, and loading it there would record the sender reading
 * their own mail as the recipient opening it. Stripping it before render means
 * "Show images" can never fire one.
 */
export function stripTrackingPixelsForDisplay(html: string): string {
	return html.replace(OWN_PIXEL_RE, "").replace(PIXEL_URL_IMG_RE, "");
}

/** How many of our pixels `html` carries. */
export function countOwnPixels(html: string): number {
	return html.match(OWN_PIXEL_RE)?.length ?? 0;
}

/**
 * Whether `html` is plausibly an HTML body at all.
 *
 * Several send paths store `html || text` and later hand that back as `html`,
 * so a plain-text message can arrive here looking like HTML. A pixel appended
 * to plain text would show up as literal markup in a client that renders it as
 * text, and there are no anchors to wrap, so plain text is simply not tracked.
 */
export function looksLikeHtml(body: string | null | undefined): boolean {
	return !!body && /<\/?[a-z][a-z0-9]*[\s>\/]/i.test(body);
}

/** Replace every trackable href with a signed redirect URL. */
async function rewriteLinks(
	html: string,
	options: TrackingInjectOptions,
): Promise<string> {
	// Gather the distinct destinations first, so each unique URL is signed once
	// even when it appears in several links.
	const matches = [...html.matchAll(HREF_RE)];
	const urls = new Set<string>();
	for (const match of matches) {
		// An href in HTML has entity-encoded ampersands; decode to sign the real
		// URL, so the recipient is redirected to the true destination.
		const href = decodeHrefEntities(match[3]);
		if (isTrackableLink(href) && !isOwnTrackedLink(href, options.baseUrl)) urls.add(href);
	}

	const tokenByUrl = new Map<string, string>();
	for (const url of urls) {
		tokenByUrl.set(url, await options.signClick(url));
	}

	return html.replace(HREF_RE, (whole, prefix, quote, rawHref) => {
		const href = decodeHrefEntities(rawHref as string);
		const token = tokenByUrl.get(href);
		if (!token) return whole; // untrackable link left exactly as-is
		return `${prefix}${quote}${options.baseUrl}/t/c/${token}${quote}`;
	});
}

/** Put `snippet` immediately before `</body>`, or at the end if there is none. */
function insertBeforeBodyEnd(html: string, snippet: string): string {
	const closingBody = html.search(/<\/body\s*>/i);
	if (closingBody === -1) return html + snippet;
	return html.slice(0, closingBody) + snippet + html.slice(closingBody);
}
