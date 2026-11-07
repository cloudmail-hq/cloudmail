// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * `GET /img/:sig?u=<url>` — the remote-image privacy proxy.
 *
 * Fetches an image a received message references, so the sender sees a
 * Cloudflare address instead of the reader's. See `shared/image-proxy.ts` for
 * how URLs are signed.
 *
 * The endpoint fetches attacker-chosen URLs, so it is built as an SSRF guard
 * first and a proxy second:
 *
 * - The URL must carry a valid HMAC from this deployment's secret. An unsigned
 *   or altered URL is a 403 before any network I/O.
 * - https only, checked with the webhook URL validator (#102): no credentials
 *   in the URL, no private, loopback, link-local, CGNAT or metadata addresses,
 *   in any of the IPv4-mapped / NAT64 / 6to4 forms, and no internal names.
 * - Redirects are followed by hand, at most 3, and every hop is re-validated,
 *   so a public URL cannot bounce the fetch to an internal host.
 * - No cookies, no Referer, no client headers at all: the upstream request is
 *   built from scratch with a fixed User-Agent and Accept.
 * - 10 s timeout. 5 MB cap, enforced while streaming as well as from
 *   Content-Length. Raster image types only: SVG can carry script and external
 *   references, so it is refused.
 * - Responses are cached in the Cache API keyed by the remote URL, so a second
 *   open does not reach the sender at all.
 *
 * The signature is the only credential, like `/t/` and `/u/`. It has to be:
 * the images load from the sandboxed email frame, an opaque origin, so the
 * browser treats them as cross-site and sends no `SameSite=Lax` session
 * cookie. That is safe because only the Worker can mint a signature, and it
 * does so only inside an authenticated read of a stored message, for the
 * images that message references. A leaked URL fetches that one public image
 * until it expires (one to two days) and nothing else; it is not an open
 * proxy.
 */

import { validateWebhookUrl } from "../../shared/webhooks";
import { verifyImageUrl } from "../../shared/image-proxy";
import type { AuthDO } from "../auth/store";
import type { Env } from "../types";

export const IMAGE_PROXY_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_PROXY_TIMEOUT_MS = 10_000;
export const IMAGE_PROXY_MAX_REDIRECTS = 3;
/** Seconds a fetched image is kept in the edge cache and in the browser. */
export const IMAGE_PROXY_CACHE_SECONDS = 24 * 60 * 60;

/**
 * Raster formats a browser renders safely in an `<img>`. Not SVG, which can
 * run script when opened directly and can reference further URLs.
 */
export const ALLOWED_IMAGE_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/jpg",
	"image/pjpeg",
	"image/gif",
	"image/webp",
	"image/avif",
	"image/bmp",
	"image/x-icon",
	"image/vnd.microsoft.icon",
	"image/apng",
]);

/** Fixed, honest, and the same for every reader. */
const UPSTREAM_USER_AGENT = "Mozilla/5.0 (compatible; MailImageProxy/1.0)";

/** Meta key for the generated signing secret, when no Worker secret is set. */
const IMAGE_PROXY_SECRET_META_KEY = "image_proxy_secret";

/**
 * The HMAC key for proxy URLs: `IMAGE_PROXY_SECRET` when configured, else
 * generated once and kept in the AuthDO meta table, the same way the
 * unsubscribe secret is.
 */
export async function getImageProxySecret(env: Env): Promise<string> {
	const configured = env.IMAGE_PROXY_SECRET?.trim();
	if (configured) return configured;
	const ns = env.AUTH_STORE as unknown as DurableObjectNamespace<AuthDO>;
	const stub = ns.get(ns.idFromName("global")) as unknown as {
		getOrInitMeta(key: string, fallback: string): Promise<string>;
	};
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const fallback = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
	return stub.getOrInitMeta(IMAGE_PROXY_SECRET_META_KEY, fallback);
}

/** Why a URL may not be fetched, or null when it may. */
export function imageUrlProblem(raw: string): string | null {
	const check = validateWebhookUrl(raw);
	if (!check.ok) return check.error;
	// Default port only. A port is how an SSRF reaches a non-HTTP service on a
	// host that is otherwise allowed.
	if (new URL(check.url).port !== "") return "Non-default ports are not allowed.";
	return null;
}

/** The media type of a Content-Type header, lowercased, or "". */
export function mediaType(contentType: string | null): string {
	return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

export type ProxyFetch = (input: Request) => Promise<Response>;

export interface ImageFetchResult {
	status: number;
	body?: Uint8Array;
	contentType?: string;
	error?: string;
}

/** Read at most `limit` bytes; null when the stream is longer. */
async function readCapped(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}

/**
 * Fetch one remote image under every rule in the header comment. `fetcher` is a
 * parameter so the SSRF and size rules are testable without a network.
 */
export async function fetchRemoteImage(
	url: string,
	fetcher: ProxyFetch = (r) => fetch(r),
	options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<ImageFetchResult> {
	const maxBytes = options.maxBytes ?? IMAGE_PROXY_MAX_BYTES;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? IMAGE_PROXY_TIMEOUT_MS);
	try {
		let current = url;
		for (let hop = 0; ; hop++) {
			const problem = imageUrlProblem(current);
			if (problem) return { status: 403, error: problem };

			const response = await fetcher(
				new Request(current, {
					method: "GET",
					redirect: "manual",
					signal: controller.signal,
					headers: {
						"User-Agent": UPSTREAM_USER_AGENT,
						Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8",
					},
				}),
			);

			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get("location");
				await response.body?.cancel().catch(() => {});
				if (!location) return { status: 502, error: "Redirect without a location." };
				if (hop >= IMAGE_PROXY_MAX_REDIRECTS) return { status: 502, error: "Too many redirects." };
				current = new URL(location, current).toString();
				continue;
			}

			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				return { status: 502, error: `Upstream returned ${response.status}.` };
			}

			const type = mediaType(response.headers.get("content-type"));
			if (!ALLOWED_IMAGE_TYPES.has(type)) {
				await response.body?.cancel().catch(() => {});
				return { status: 415, error: "Not a supported image type." };
			}

			const declared = Number(response.headers.get("content-length") ?? "");
			if (Number.isFinite(declared) && declared > maxBytes) {
				await response.body?.cancel().catch(() => {});
				return { status: 413, error: "Image too large." };
			}

			if (!response.body) return { status: 200, body: new Uint8Array(), contentType: type };
			const body = await readCapped(response.body, maxBytes);
			if (!body) return { status: 413, error: "Image too large." };
			return { status: 200, body, contentType: type };
		}
	} catch (e) {
		const aborted = (e as Error)?.name === "AbortError" || controller.signal.aborted;
		return { status: aborted ? 504 : 502, error: aborted ? "Upstream timed out." : "Upstream fetch failed." };
	} finally {
		clearTimeout(timer);
	}
}

/** Headers on every proxy response, success or not. */
function baseHeaders(): Headers {
	return new Headers({
		"X-Content-Type-Options": "nosniff",
		// The bytes are the sender's; nothing in them may run or load more.
		"Content-Security-Policy": "default-src 'none'; sandbox",
		// `cross-origin`, not `same-origin`: the requesting document is the
		// sandboxed email frame, an opaque origin, which is never same-origin with
		// anything, so `same-origin` makes the browser refuse every image. The
		// bytes are a public third-party image; the signed URL is the gate.
		"Cross-Origin-Resource-Policy": "cross-origin",
		"Referrer-Policy": "no-referrer",
	});
}

function failure(status: number, message: string): Response {
	const headers = baseHeaders();
	headers.set("Content-Type", "text/plain; charset=utf-8");
	headers.set("Cache-Control", "no-store");
	return new Response(message, { status, headers });
}

interface CacheLike {
	match(key: Request): Promise<Response | undefined>;
	put(key: Request, value: Response): Promise<void>;
}

/** The Cache API key: the remote URL under a synthetic host, never the request. */
function cacheKey(url: string): Request {
	return new Request(`https://image-proxy.cache.invalid/${encodeURIComponent(url)}`);
}

export async function handleImageProxy(
	request: Request,
	env: Env,
	waitUntil: (p: Promise<unknown>) => void,
	deps: {
		fetcher?: ProxyFetch;
		cache?: CacheLike | null;
		secret?: string;
		/** Domains this deployment serves; never proxied. */
		ownDomains?: readonly string[];
		/** Clock, for expiry tests. */
		now?: number;
	} = {},
): Promise<Response> {
	const url = new URL(request.url);
	const sig = url.pathname.split("/")[2] ?? "";
	const target = url.searchParams.get("u") ?? "";
	const exp = Number(url.searchParams.get("e") ?? "");
	if (!sig || !target) return failure(400, "Missing image URL.");

	const secret = deps.secret ?? (await getImageProxySecret(env));
	if (!(await verifyImageUrl(secret, target, exp, sig, deps.now))) {
		return failure(403, "Invalid or expired signature.");
	}

	const problem = imageUrlProblem(target);
	if (problem) return failure(403, problem);

	/**
	 * Never this deployment's own hosts. Without `global_fetch_strictly_public`
	 * a Worker's fetch to its own zone goes straight to the origin, skipping
	 * Cloudflare's security settings, and the reader's own app has nothing an
	 * image tag needs from us that the browser cannot load as `'self'`.
	 */
	const targetHost = new URL(target).hostname.toLowerCase();
	const own = [url.hostname.toLowerCase(), ...(deps.ownDomains ?? [])];
	if (own.some((d) => targetHost === d || targetHost.endsWith(`.${d}`))) {
		return failure(403, "This deployment's own hosts are not proxied.");
	}

	const cache =
		deps.cache !== undefined
			? deps.cache
			: ((globalThis as { caches?: { default?: CacheLike } }).caches?.default ?? null);
	const key = cacheKey(target);
	if (cache) {
		const hit = await cache.match(key).catch(() => undefined);
		if (hit) {
			// Rebuilt: cached responses are immutable, and the browser copy must
			// be `private` even though the edge copy is not.
			// Headers are rebuilt from the current policy rather than replayed, so
			// a policy change takes effect on cached images too. Only the media
			// type comes from the cache, and it is re-checked.
			const type = mediaType(hit.headers.get("content-type"));
			if (ALLOWED_IMAGE_TYPES.has(type)) {
				const headers = baseHeaders();
				headers.set("Content-Type", type);
				headers.set("Cache-Control", `private, max-age=${IMAGE_PROXY_CACHE_SECONDS}`);
				return new Response(hit.body, { status: 200, headers });
			}
		}
	}

	const result = await fetchRemoteImage(target, deps.fetcher);
	if (result.status !== 200 || !result.body) {
		return failure(result.status, result.error ?? "Could not load image.");
	}

	const headers = baseHeaders();
	headers.set("Content-Type", result.contentType!);
	headers.set("Content-Length", String(result.body.byteLength));
	// `private`: a shared cache in front of the reader must not keep it, since the
	// URL alone identifies which message they opened.
	headers.set("Cache-Control", `private, max-age=${IMAGE_PROXY_CACHE_SECONDS}`);
	const response = new Response(result.body as unknown as BodyInit, { status: 200, headers });

	if (cache) {
		const stored = new Response(result.body as unknown as BodyInit, { status: 200, headers: new Headers(headers) });
		// The Cache API honours Cache-Control; the edge copy is keyed by URL only
		// and readable by nobody but this Worker.
		stored.headers.set("Cache-Control", `public, max-age=${IMAGE_PROXY_CACHE_SECONDS}`);
		waitUntil(cache.put(key, stored).catch(() => {}));
	}
	return response;
}
