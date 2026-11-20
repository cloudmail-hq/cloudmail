// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Signed URLs for the remote-image privacy proxy (`GET /img/:sig?u=…`).
 *
 * Once a reader allows images, they used to load straight from the reader's
 * browser, handing every sender the reader's IP address, rough location and
 * browser on each open. The proxy fetches them from the Worker instead.
 *
 * The signature is an HMAC over the remote URL with a per-deployment secret,
 * so the endpoint fetches only URLs this deployment put into a message it
 * served to a signed-in reader, and is not an open proxy for anything else.
 *
 * The Worker signs (it holds the secret); the client only looks URLs up in the
 * map the Worker returned. Both sides find image sources with the same
 * `findImageSources`, so the map keys match exactly what the client rewrites.
 */

/** Path prefix of the proxy route. */
export const IMAGE_PROXY_PREFIX = "/img/";

/** Most images signed per message, so a hostile body cannot make a read slow. */
export const MAX_PROXIED_IMAGES_PER_MESSAGE = 200;

/** Longest remote URL that is proxied. */
export const MAX_PROXIED_URL_LENGTH = 2048;

/**
 * `<img src>` values as written in the HTML, in document order. The same
 * pattern `prepareEmailHtml` rewrites with.
 */
export const IMG_SRC_RE = /(<img\b[^>]*?)\ssrc=(["'])(.*?)\2/gi;

/** The raw `src` strings of remote images, deduplicated. */
export function findImageSources(html: string | null | undefined): string[] {
	if (!html) return [];
	const out = new Set<string>();
	for (const m of html.matchAll(IMG_SRC_RE)) {
		const raw = m[3]!.trim();
		if (/^(https?:)?\/\//i.test(raw)) out.add(raw);
		if (out.size >= MAX_PROXIED_IMAGES_PER_MESSAGE) break;
	}
	return [...out];
}

/**
 * The URL the proxy should fetch for a raw `src`, or null when it cannot be
 * proxied.
 *
 * Entity-decoded (`&amp;` in markup is `&` on the wire), protocol-relative
 * resolved to https, and `http:` upgraded to `https:` because the proxy only
 * fetches over TLS: a plain-HTTP fetch would let anyone on the path between
 * Cloudflare and the sender rewrite the image.
 */
export function normalizeRemoteImageUrl(raw: string): string | null {
	let value = raw
		.trim()
		.replace(/&amp;/gi, "&")
		.replace(/&#38;/g, "&")
		.replace(/&#x26;/gi, "&");
	if (value.startsWith("//")) value = `https:${value}`;
	if (/^http:\/\//i.test(value)) value = `https://${value.slice(7)}`;
	if (!/^https:\/\//i.test(value)) return null;
	if (value.length > MAX_PROXIED_URL_LENGTH) return null;
	try {
		return new URL(value).toString();
	} catch {
		return null;
	}
}

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer): string {
	let binary = "";
	for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
}

/** Domain-separated so a signature from another feature never verifies here. */
const CONTEXT = "tapetide-image-proxy:v2:";

/**
 * How long a signed URL works. Expiry is rounded up to a day boundary, so the
 * same image gets the same URL for a whole day (the browser cache keeps
 * working) and any URL is valid for between one and two days.
 */
export const IMAGE_PROXY_TTL_SECONDS = 24 * 60 * 60;

/** The expiry stamp for URLs signed at `now` (epoch ms). */
export function imageProxyExpiry(now = Date.now()): number {
	const day = IMAGE_PROXY_TTL_SECONDS;
	return (Math.floor(now / 1000 / day) + 2) * day;
}

const payload = (url: string, exp: number) => `${CONTEXT}${exp}:${url}`;

export async function signImageUrl(secret: string, url: string, exp: number): Promise<string> {
	const key = await hmacKey(secret);
	return base64url(await crypto.subtle.sign("HMAC", key, encoder.encode(payload(url, exp))));
}

/** Constant-time comparison of two signatures. */
function equalSignatures(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * Whether `sig` is this deployment's signature over `url` and `exp`, and
 * `exp` has not passed. The signature is the whole credential: the proxy is
 * loaded from the sandboxed email frame, an opaque origin, so the browser sends
 * no session cookie with it.
 */
export async function verifyImageUrl(
	secret: string,
	url: string,
	exp: number,
	sig: string,
	now = Date.now(),
): Promise<boolean> {
	if (!/^[A-Za-z0-9_-]{43}$/.test(sig)) return false;
	if (!Number.isSafeInteger(exp) || exp * 1000 <= now) return false;
	// Reject a stamp further out than any this deployment would issue.
	if (exp > imageProxyExpiry(now)) return false;
	return equalSignatures(await signImageUrl(secret, url, exp), sig);
}

/** The same-origin path the client puts in `src`. */
export function proxyPath(sig: string, url: string, exp: number): string {
	return `${IMAGE_PROXY_PREFIX}${sig}?e=${exp}&u=${encodeURIComponent(url)}`;
}

/**
 * Raw `src` → proxy path, for every proxiable image in `html`. The response
 * field the reading pane rewrites from.
 */
export async function buildImageProxyMap(
	secret: string,
	html: string | null | undefined,
	now = Date.now(),
): Promise<Record<string, string>> {
	const map: Record<string, string> = {};
	const exp = imageProxyExpiry(now);
	for (const raw of findImageSources(html)) {
		const url = normalizeRemoteImageUrl(raw);
		if (!url) continue;
		map[raw] = proxyPath(await signImageUrl(secret, url, exp), url, exp);
	}
	return map;
}
