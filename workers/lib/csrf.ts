// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Cross-site request forgery defence for state-changing requests.
 *
 * ## Why this is needed
 *
 * Cloudflare Access authenticates with a cookie, which is an *ambient*
 * credential: the browser attaches it to any request at this origin, including
 * one triggered by a page the reader did not write. So until now every
 * state-changing route was reachable from any site the reader happened to visit
 * while signed in.
 *
 * The app looked protected because `workers/index.ts` installs Hono's `cors()`
 * middleware with an origin allowlist. That is a misreading of what CORS does:
 * it shapes *response* headers so a browser will refuse to let the attacking
 * page **read** the reply. The request is still delivered and still executed.
 * For anything whose value is the side effect rather than the response body,
 * CORS is no defence at all.
 *
 * The highest-value target was `PUT /api/v1/mailboxes/:id`, which sets
 * `forwarding.email`. One forged request silently redirects every future message
 * to an address of the attacker's choosing. `POST /mcp` is worse in kind, since
 * its tools include `send_email` and `delete_email`.
 *
 * Nor does a preflight save us: `c.req.json()` does not check `Content-Type`, so
 * an HTML form posting `text/plain` is a "simple request" and never triggers one.
 *
 * ## How it decides
 *
 * `Sec-Fetch-Site` is the primary signal. Every browser that can reach this app
 * sends it, it is forbidden to scripts, and it states the relationship between
 * the initiator and the target directly.
 *
 * Non-browser clients — MCP over HTTP, `curl`, the API — send neither
 * `Sec-Fetch-Site` nor `Origin`, and are allowed through. That is not a hole:
 * CSRF depends on a browser attaching credentials the caller does not possess,
 * and a client that has to supply its own credentials cannot be tricked into
 * spending someone else's.
 */

import { createMiddleware } from "hono/factory";

/** Methods that must not have side effects, so cannot be abused this way. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Whether this GET is really a WebSocket handshake.
 *
 * Exempting GET is sound for ordinary reads, but a WebSocket upgrade *is* a GET,
 * and the response is not subject to CORS. So `new WebSocket("wss://host/agents/…")`
 * from any page the signed-in reader happens to visit completes using their
 * ambient Access cookie and yields a live channel to the agent — whose tools
 * read the whole mailbox (`get_email`, `search_emails`) and change state
 * (`draft_email`, `move_email`, `discard_draft`).
 *
 * The `Sec-Fetch-Site` argument does not rescue this either: browsers do not
 * send fetch metadata on WebSocket handshakes. `Origin`, however, is mandatory
 * on them, which is what makes the check below possible.
 */
function isWebSocketUpgrade(headers: {
	get: (name: string) => string | null;
}): boolean {
	return (headers.get("upgrade") ?? "").toLowerCase() === "websocket";
}

/**
 * `Sec-Fetch-Site` values that may perform writes.
 *
 * `same-origin` is the app's own fetches. `none` is a user-initiated load with
 * no initiator — a typed URL or a bookmark — which is the reader acting
 * directly.
 *
 * `same-site` is deliberately excluded. It would admit any sibling subdomain,
 * and on a hosted zone that is not a boundary anyone controls.
 */
const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);

/** `/u/<token>` exactly: one segment, no deeper paths ride the exemption. */
function isUnsubscribePath(url: string): boolean {
	try {
		return /^\/u\/[^/]+\/?$/.test(new URL(url).pathname);
	} catch {
		return false;
	}
}

export interface CsrfVerdict {
	allowed: boolean;
	/** Why it was refused, for the response body and the logs. */
	reason?: string;
}

/**
 * Decide whether a request may change state.
 *
 * Pure and header-only so it can be exhaustively tested; the middleware below
 * is the thin part.
 */
export function checkCsrf(request: {
	method: string;
	headers: { get: (name: string) => string | null };
	url: string;
}): CsrfVerdict {
	// A WebSocket handshake is a GET but is not a safe read, so it is checked
	// even though the method would otherwise exempt it.
	const isUpgrade = isWebSocketUpgrade(request.headers);

	/**
	 * The public unsubscribe endpoint is exempt.
	 *
	 * CSRF is about a browser spending an ambient credential the attacker does
	 * not hold. `/u/:token` reads no cookie at all: the signed token in the path
	 * is the whole credential, so a cross-site POST can do nothing a direct one
	 * could not. And RFC 8058 one-click is a POST that a mailbox provider (or a
	 * webmail client acting in the reader's browser) sends from its own origin,
	 * so refusing cross-site POSTs here would break exactly the flow the
	 * endpoint exists for.
	 */
	if (isUnsubscribePath(request.url)) return { allowed: true };

	if (!isUpgrade && SAFE_METHODS.has(request.method.toUpperCase())) {
		return { allowed: true };
	}

	const fetchSite = request.headers.get("sec-fetch-site");
	if (fetchSite) {
		return ALLOWED_FETCH_SITES.has(fetchSite)
			? { allowed: true }
			: {
					allowed: false,
					reason: `Cross-site ${request.method} requests are not allowed (Sec-Fetch-Site: ${fetchSite})`,
				};
	}

	// No Sec-Fetch-Site. If there is an Origin, it is still a browser and the
	// origin has to match the target.
	const origin = request.headers.get("origin");
	if (!origin) {
		// Browsers always send Origin on a WebSocket handshake, so its absence
		// means a non-browser client — which cannot be made to spend someone
		// else's cookie. Anything claiming to be a browser must identify itself.
		return { allowed: true };
	}

	let originHost: string;
	try {
		originHost = new URL(origin).host;
	} catch {
		return { allowed: false, reason: "Malformed Origin header" };
	}

	// `Host` is what the client addressed; the URL's host is what we were routed
	// as. Compare against both so a proxy hop cannot turn into a refusal.
	const target = new URL(request.url).host;
	const hostHeader = request.headers.get("host");

	if (originHost === target || (hostHeader && originHost === hostHeader)) {
		return { allowed: true };
	}

	return {
		allowed: false,
		reason: `Origin ${origin} does not match this host`,
	};
}

/**
 * Reject cross-site writes with 403.
 *
 * Mounted alongside the Access check in `workers/app.ts` rather than only on
 * `/api/*`, so `/mcp` — whose tools can send and delete mail — is covered by the
 * same rule.
 */
export const csrfGuard = createMiddleware(async (c, next) => {
	const verdict = checkCsrf(c.req.raw);
	if (!verdict.allowed) {
		console.warn(
			`Blocked cross-site ${c.req.method} ${new URL(c.req.url).pathname}: ${verdict.reason}`,
		);
		return c.json({ error: verdict.reason ?? "Forbidden" }, 403);
	}
	return next();
});
