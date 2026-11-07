// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Response hardening headers.
 *
 * The app served none of these. The only Content-Security-Policy in the codebase
 * was the one inside the sandboxed email iframe — good, but it protects the
 * message body, not the application that frames it. So an injected script
 * anywhere in the React tree could reach any origin it liked, the app could be
 * framed by another site, and MIME sniffing was left to the browser.
 *
 * ## The iframe constrains what this policy can say
 *
 * `EmailIframe` renders message bodies with `iframe.srcdoc`, and a document with
 * a local scheme — `about:srcdoc`, `data:`, `blob:` — **inherits its parent's
 * CSP**. The effective policy for the email body is therefore the intersection of
 * this policy and the one the iframe sets for itself.
 *
 * That matters for two features.
 *
 * - **Remote images.** They are withheld until the reader asks for them, and once
 *   allowed they are rewritten to the same-origin proxy (`/img/:sig?u=…`, see
 *   `./image-proxy.ts`), which fetches them from the Worker so the sender never
 *   sees the reader's IP. Because every allowed image now arrives from `'self'`,
 *   `img-src` here is `'self' data: blob:` and nothing else. This used to be
 *   `https:`, which the iframe needed to load images straight from senders.
 *   Narrowing it also makes the policy a backstop instead of a formality: a
 *   remote URL that escapes the rewrite (an inline-style `url()`, a `srcset`
 *   candidate, a bug) is refused by the browser rather than fetched. It also
 *   blocks remote markdown images in the agent panel, the EchoLeak exfiltration
 *   path, because that panel is rendered under this same policy.
 * - **The height reporter.** The iframe runs a small inline script to report its
 *   height, which needs `script-src 'unsafe-inline'` to survive inheritance.
 *
 * The iframe's own meta policy narrows further: `img-src data: blob: 'self'`
 * in both modes, so blocked-image mode differs from allowed-image mode only in
 * whether `prepareEmailHtml` rewrote the sources to the proxy.
 * `frame-src` stays permissive for the Turnstile challenge.
 *
 * ## Why `script-src` allows inline
 *
 * React Router serves hydration state as an inline script, so a policy without
 * `'unsafe-inline'` would break the app on first paint. Nonce plumbing through
 * the SSR entry would fix that properly and is worth doing later. Until then this
 * is honest about what it is: it stops script from *other origins*, which defeats
 * the common injected-`<script src>` case, and does nothing about inline
 * injection. That is a real improvement over no policy at all, and less than a
 * strict policy would give.
 */

/**
 * Content-Security-Policy for HTML documents.
 *
 * Only sent with documents. On a JSON response it protects nothing, and on the
 * attachment endpoint a different, much stricter policy applies (see below).
 */
export const DOCUMENT_CSP = [
	"default-src 'self'",
	// No <base> rewriting, and no plugin content.
	"base-uri 'self'",
	"object-src 'none'",
	// This app is never legitimately framed by anything.
	"frame-ancestors 'none'",
	"form-action 'self'",
	// See the note above: inline is required by SSR hydration and by the email
	// iframe's height reporter, which inherits this policy.
	//
	// challenges.cloudflare.com is Turnstile, the optional bot check on the
	// sign-in pages. One exact origin rather than `https:`, so enabling it does not
	// open script loading to the rest of the web.
	"script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
	// Tailwind and inline email styles.
	"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
	// Same-origin only. Remote images in mail arrive through the /img/ proxy, so
	// nothing on this page ever needs another origin; see the note above.
	"img-src 'self' data: blob:",
	"font-src 'self' data: https://fonts.gstatic.com",
	// 'self' covers the same-origin WebSocket the agent panel opens.
	"connect-src 'self'",
	// Turnstile renders its challenge in an iframe from the same origin.
	"frame-src 'self' data: blob: https://challenges.cloudflare.com",
].join("; ");

/**
 * Content-Security-Policy for attachment downloads.
 *
 * Attachments are attacker-supplied bytes served from our own origin. The route
 * already forces a download for the dangerous types and sends `nosniff`, but a
 * policy that permits nothing is the cheap belt to that braces: even if a
 * renderable type slips through, it can neither run script nor call home.
 */
export const ATTACHMENT_CSP = "default-src 'none'; sandbox";

/**
 * Headers applied to every response.
 *
 * `Strict-Transport-Security` is inert over plain HTTP, so sending it
 * unconditionally is safe; `preload` is deliberately omitted because it is a
 * commitment to a browser-vendor list that cannot easily be walked back.
 *
 * Why production shows `max-age=31536000` without `includeSubDomains`: the
 * tapetide.com zone has Cloudflare's zone-level HSTS (the `security_header`
 * setting, SSL/TLS → Edge Certificates) turned on with
 * `include_subdomains: false`. Cloudflare applies it at the edge to every
 * response in the zone (Worker, static assets, and `tapetide.com` itself) and
 * it replaces this header, so nothing set here can win while it is on. That is
 * a zone-wide decision for the account owner, deliberately not changed from
 * code: either turn on "Include subdomains" there (every subdomain must then
 * serve HTTPS) or turn zone HSTS off so this value takes effect.
 *
 * This value stays correct so it applies the moment the zone setting allows
 * it, and on deployments without zone HSTS. Static assets are served before
 * the Worker runs, so `public/_headers` repeats the same values for them.
 */
export const BASE_SECURITY_HEADERS: Record<string, string> = {
	"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
	"X-Content-Type-Options": "nosniff",
	// Redundant with frame-ancestors for modern browsers, kept for the ones that
	// only understand this.
	"X-Frame-Options": "DENY",
	// Referrers can carry mailbox addresses and message ids in the path, which
	// have no business being sent to another origin.
	"Referrer-Policy": "no-referrer",
	// Nothing here needs these, and denying them shrinks what an injected script
	// could ask the browser for.
	"Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
	// Keeps this origin out of a cross-origin attacker's process.
	"Cross-Origin-Opener-Policy": "same-origin",
};

/** Whether a response is an HTML document, and so should carry the document CSP. */
export function isHtmlResponse(contentType: string | null): boolean {
	if (!contentType) return false;
	return contentType.split(";")[0]!.trim().toLowerCase() === "text/html";
}

/**
 * Headers this response should gain.
 *
 * Returned as a plain object rather than applied in place so the decision is
 * testable without constructing a Worker response pipeline.
 */
export function securityHeadersFor(options: {
	contentType: string | null;
	/** True for the attachment download route, which gets the strict policy. */
	isAttachment?: boolean;
}): Record<string, string> {
	const headers = { ...BASE_SECURITY_HEADERS };

	if (options.isAttachment) {
		headers["Content-Security-Policy"] = ATTACHMENT_CSP;
		return headers;
	}

	if (isHtmlResponse(options.contentType)) {
		headers["Content-Security-Policy"] = DOCUMENT_CSP;
	}

	return headers;
}

/** Path pattern for the attachment download route. */
export function isAttachmentPath(pathname: string): boolean {
	return /^\/api\/v1\/mailboxes\/[^/]+\/emails\/[^/]+\/attachments\/[^/]+$/.test(
		pathname,
	);
}

/**
 * Merge the hardening headers into a response, returning the one to send.
 *
 * Returns the same object when it could be amended in place, and a rebuilt one
 * when it could not. Two cases cannot be amended:
 *
 * - A WebSocket upgrade (the agent handshake). A 101 carries no headers a client
 *   could read, and its response object is immutable.
 * - A response proxied straight out of a Durable Object. `/mcp` and `/agents/*`
 *   both return the stub's `fetch` result verbatim, and workerd marks those
 *   headers immutable, so `set()` throws a `TypeError`.
 *
 * The second case is why this exists at all: applying the headers in place, which
 * is the obvious implementation, turns every MCP request into a 500. Rebuilding
 * costs a response object and keeps the endpoint working, which is the right
 * trade against a missing `Referrer-Policy` on a machine-to-machine call.
 */
export function withSecurityHeaders(res: Response, url: string): Response {
	const upgrade = res as Response & { webSocket?: unknown | null };
	if (res.status === 101 || upgrade.webSocket) return res;

	const headers = securityHeadersFor({
		contentType: res.headers.get("content-type"),
		isAttachment: isAttachmentPath(new URL(url).pathname),
	});

	// Only absent headers, so a route that chose its own value keeps it.
	const missing = Object.entries(headers).filter(
		([name]) => !res.headers.has(name),
	);
	if (missing.length === 0) return res;

	try {
		for (const [name, value] of missing) res.headers.set(name, value);
		return res;
	} catch {
		const rebuilt = new Response(res.body, res);
		for (const [name, value] of missing) rebuilt.headers.set(name, value);
		return rebuilt;
	}
}
