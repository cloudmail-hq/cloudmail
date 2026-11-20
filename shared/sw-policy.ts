/**
 * What the service worker may cache, as a pure function.
 *
 * `public/sw.js` carries a copy of this logic (a service worker is served as a
 * plain static file and cannot import a TypeScript module), and
 * `test/sw-policy.test.ts` checks that the two agree, so the rules live here
 * where they can be unit tested.
 *
 * The goal is offline *launch*, not offline mail: an installed app opened on a
 * train should paint its frame instead of the browser's dinosaur. Mail, auth
 * and every other data request always go to the network, so nothing a user
 * read is ever kept in a cache that outlives their session.
 */

export type SwStrategy =
	/** Not handled: the browser does what it would without a worker. */
	| "bypass"
	/** Content-hashed build output: serve from cache, fill it on a miss. */
	| "cache-first"
	/** A page load: network, falling back to the cached app shell offline. */
	| "navigate";

/**
 * Prefixes that are never cached and never intercepted.
 *
 * `/api` is the mail and auth surface; `/mcp`, `/oauth` and `/.well-known` are
 * the agent and OAuth protocols; `/cdn-cgi` is Cloudflare's own (Access
 * logout, the local email handler). The agent panel's WebSocket lives under
 * `/agents`.
 */
export const SW_BYPASS_PREFIXES = [
	"/api",
	"/mcp",
	"/oauth",
	"/agents",
	"/cdn-cgi",
	"/.well-known",
] as const;

/** `/api` and `/api/...`, but not `/apiary`. */
function underPrefix(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(`${prefix}/`);
}

export function swStrategy(request: {
	method: string;
	url: string;
	mode?: string;
	origin: string;
}): SwStrategy {
	if (request.method !== "GET") return "bypass";
	let url: URL;
	try {
		url = new URL(request.url);
	} catch {
		return "bypass";
	}
	if (url.origin !== request.origin) return "bypass";
	const path = url.pathname;
	if (SW_BYPASS_PREFIXES.some((p) => underPrefix(path, p))) return "bypass";
	// React Router's data requests (`/mail/x.data`) and route manifest carry the
	// same session-scoped content as the API.
	if (path.endsWith(".data") || path === "/__manifest") return "bypass";
	if (request.mode === "navigate") return "navigate";
	// Hashed filenames, so a cached copy can never be stale.
	if (path.startsWith("/assets/")) return "cache-first";
	return "bypass";
}

/**
 * Whether a navigation response may become the cached app shell.
 *
 * Only a plain 200 HTML page: a redirect is the sign-in bounce, and caching it
 * as the shell would make every offline launch land on `/login`.
 */
export function isCacheableShell(response: {
	status: number;
	redirected: boolean;
	type: string;
	contentType: string | null;
}): boolean {
	return (
		response.status === 200 &&
		!response.redirected &&
		response.type === "basic" &&
		(response.contentType ?? "").toLowerCase().startsWith("text/html")
	);
}
