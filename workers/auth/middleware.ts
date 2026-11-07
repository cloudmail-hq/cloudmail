// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Authentication middleware: who is calling, and what to do when nobody is.
 *
 * Two layers, deliberately separate:
 *
 * - `createAuthenticate` establishes identity and never refuses anything in
 *   password mode. It reads a `ttk_` bearer token or the session cookie and,
 *   when either is valid, sets `accessIdentity` — the same shape a Cloudflare
 *   Access token produced — so `workers/lib/authz.ts` authorizes built-in users
 *   with no special case. In access mode it is the original Access JWT check,
 *   which does refuse, exactly as before.
 *
 * - `createAuthGate` decides what an unauthenticated request gets: 401 JSON on
 *   the API surfaces, a redirect to `/login` (or `/setup`) on pages, and a pass
 *   for the handful of things that must render without a session.
 *
 * The public `/api/auth/*` routes are mounted between the two, so they see the
 * identity (to answer "am I signed in") without being gated by it.
 *
 * The gate is the UX layer, not the boundary for data: SSR pages here carry no
 * loaders, so a page shell rendered by mistake leaks nothing. Every byte of mail
 * comes from `/api/v1/*`, `/mcp` or `/agents/*`, and those are refused without
 * credentials *and* authorized per mailbox by `resolvePrincipal`.
 */

import type { Context, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
	identityFromTokenPayload,
	resolvePrincipalFor,
	type AccessIdentity,
	type Principal,
} from "../lib/authz";
import type { MailboxContext } from "../lib/mailbox";
import type { Env } from "../types";
import { isDevBypass, resolveAuthMode } from "./config";
import { readSessionCookie } from "./cookies";
import { sha256Hex } from "./crypto";
import type { McpOAuthHooks } from "./oauth";
import { mcpBearerChallenge, mcpOAuthEnabled, oauthBearerFrom } from "./oauth-metadata";
import type { WebAuthnVerifier } from "./passkeys";
import type { AuthCache } from "./session-cache";
import type { ApiTokenInfo, AuthStoreApi, AuthUser, OAuthGrantInfo, SessionInfo } from "./types";

/** What the auth layer needs from its surroundings; injectable for tests. */
export interface AuthDeps {
	/** The AuthDO stub (or an in-memory store in tests). */
	getStore: (env: Env) => AuthStoreApi;
	/** `import.meta.env.DEV` in the Worker. */
	isDev?: boolean;
	/** Clock, for tests that exercise expiry and lockout. */
	now?: () => number;
	/**
	 * MCP OAuth (`workers/auth/oauth.ts`). Optional so the rest of the auth layer
	 * can be exercised without the OAuth library; when absent, `/mcp` accepts
	 * only `ttk_` tokens, exactly as before.
	 */
	mcpOAuth?: McpOAuthHooks;
	/** WebAuthn verification; the real library unless a test stubs it. */
	webauthn?: WebAuthnVerifier;
	/**
	 * Per-isolate cache of validated credentials (`workers/auth/session-cache.ts`).
	 * When set, `getStore` must be wrapped with `withAuthCacheInvalidation` over
	 * the same cache, so changes made in this isolate invalidate it at once.
	 * Absent: every request validates against the store, as before.
	 */
	authCache?: AuthCache;
}

/** The body every unauthenticated API refusal carries. */
export const UNAUTHENTICATED_BODY = {
	error: "Sign in required",
	code: "unauthenticated",
} as const;

// -- identity helpers ------------------------------------------------------

/** The authz identity of a built-in account. Email is the grant key, id the subject. */
export function identityForUser(user: AuthUser): AccessIdentity {
	return { kind: "user", id: user.email, subject: user.id };
}

/**
 * The principal a given account resolves to, outside of a request for it.
 *
 * Used where one user asks about another (the admin user list) or about
 * themselves before a session exists (the login response), so both agree with
 * what `resolvePrincipal` will decide on their next request.
 */
export function principalForUser(
	env: Pick<Env, "ADMIN_EMAILS" | "BUCKET">,
	user: AuthUser,
): Promise<Principal> {
	return resolvePrincipalFor({
		adminEmailsRaw: env.ADMIN_EMAILS,
		bucket: env.BUCKET,
		identity: identityForUser(user),
		forceEnforced: true,
		extraAdminEmails: user.isOwner ? [user.email] : [],
	});
}

/** Parse `Authorization: Bearer ttk_<id>_<secret>`. */
export function parseBearerToken(header: string | null | undefined): { id: string; secret: string } | null {
	if (!header) return null;
	const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
	if (!match) return null;
	const raw = match[1];
	// The id alphabet has no `_`, so the 12 characters after `ttk_` are the id
	// and everything after the next `_` is the secret, which may contain `_`.
	const parsed = /^ttk_([A-Za-z0-9]{12})_([A-Za-z0-9_-]{20,128})$/.exec(raw);
	return parsed ? { id: parsed[1], secret: parsed[2] } : null;
}

// -- Cloudflare Access (legacy mode) --------------------------------------

function getAccessUrls(teamDomain: string) {
	const certsPath = "/cdn-cgi/access/certs";
	const teamUrl = new URL(teamDomain);
	const issuer = teamUrl.origin;
	const certsUrl = teamUrl.pathname.endsWith(certsPath)
		? teamUrl
		: new URL(certsPath, issuer);

	return { issuer, certsUrl };
}

/**
 * Cloudflare Access JWT validation — the app's original authentication, kept
 * as-is for `AUTH_MODE=access`.
 */
export function accessAuthenticate(isDev: boolean): MiddlewareHandler<MailboxContext> {
	return createMiddleware<MailboxContext>(async (c, next) => {
		// Skip validation in development
		if (isDev) {
			// Recorded explicitly so authorization can tell "no token because this is
			// localhost" from "no usable identity in a token we did verify". Only the
			// first is safe to treat as full access; see workers/lib/authz.ts.
			c.set("developmentBypass", true);
			c.set("authMethod", "dev");
			return next();
		}

		const { POLICY_AUD, TEAM_DOMAIN } = c.env;

		// Fail closed in production if Access is not configured.
		if (!POLICY_AUD || !TEAM_DOMAIN) {
			return c.text(
				"Cloudflare Access must be configured in production. Set POLICY_AUD and TEAM_DOMAIN.",
				500,
			);
		}

		const token = c.req.header("cf-access-jwt-assertion");
		if (!token) {
			return c.text("Missing required CF Access JWT", 403);
		}

		try {
			const { issuer, certsUrl } = getAccessUrls(TEAM_DOMAIN);
			const JWKS = createRemoteJWKSet(certsUrl);
			const { payload } = await jwtVerify(token, JWKS, {
				issuer,
				audience: POLICY_AUD,
			});

			/**
			 * Identity comes from the verified payload rather than the
			 * `Cf-Access-Authenticated-User-Email` header: the header is set by the
			 * edge and would be trustworthy here, but reusing the token we just
			 * verified keeps the trust boundary in one place.
			 *
			 * Two shapes arrive. A person's token carries `email`; an Access *service
			 * token* carries `common_name` — the token's Client ID — with an empty
			 * `sub` and no email. Both become principals, so machine callers are
			 * granted mailboxes through the same model as people. See
			 * `workers/lib/authz.ts`.
			 */
			const identity = identityFromTokenPayload(payload);
			if (identity) c.set("accessIdentity", identity);
			c.set("authMethod", "access");
		} catch {
			return c.text("Invalid or expired Access token", 403);
		}

		// Passing Access only establishes *who* is calling. What they may reach is
		// decided per mailbox by `resolvePrincipal`; see workers/lib/authz.ts.
		return next();
	});
}

// -- password mode ---------------------------------------------------------

/**
 * Paths that never need a store lookup: static files and dev-server internals.
 *
 * In production the Workers assets layer answers these before the Worker runs;
 * in `react-router dev` Vite usually does. Skipping them here is about not
 * spending an AuthDO call on a stylesheet, and about the gate below never
 * redirecting a script request to an HTML login page.
 *
 * Extensions are an allow-list rather than "anything with a dot", because
 * mailbox ids are email addresses: `/mail/support@example.com` ends in `.com`
 * and is a page, not a file.
 */
const STATIC_PREFIXES = [
	"/assets/",
	"/@vite/",
	"/@fs/",
	"/@id/",
	"/@react-refresh",
	"/node_modules/",
	"/app/",
	"/shared/",
	"/.well-known/",
];
const STATIC_EXACT = new Set(["/manifest.webmanifest", "/__manifest", "/robots.txt"]);
const STATIC_EXTENSION =
	/\.(?:js|mjs|cjs|jsx|ts|tsx|css|map|png|svg|ico|webp|avif|jpg|jpeg|gif|woff2?|ttf|otf|txt|webmanifest)$/i;

/**
 * The surfaces that carry mail and must always be authenticated and gated.
 * Checked before `isStaticPath` everywhere: an extension is something the
 * caller chooses, so `/api/v1/mailboxes.js` or `/mcp/x.css` must never be
 * mistaken for a file and skip identity or the gate.
 */
export function isApiPath(pathname: string): boolean {
	return (
		pathname === "/api" ||
		pathname.startsWith("/api/") ||
		pathname === "/mcp" ||
		pathname.startsWith("/mcp/") ||
		pathname === "/agents" ||
		pathname.startsWith("/agents/")
	);
}

/**
 * The OAuth discovery documents live under `/.well-known/`, which is otherwise
 * treated as static, and in production a "static-looking" path reaching the
 * Worker is refused with a 404. These two are Worker routes, so they must not be.
 */
const WORKER_WELL_KNOWN = /^\/\.well-known\/oauth-(?:authorization-server|protected-resource)(?:\/|$)/;

export function isStaticPath(pathname: string): boolean {
	if (isApiPath(pathname)) return false;
	if (WORKER_WELL_KNOWN.test(pathname)) return false;
	if (STATIC_EXACT.has(pathname)) return true;
	if (STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
	if (/^\/favicon\./.test(pathname) || /^\/icon-[\w-]+\.png$/.test(pathname)) return true;
	return STATIC_EXTENSION.test(pathname);
}

/** Pages that render without a session. */
export function isPublicPage(pathname: string): boolean {
	const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
	// OAuth protocol endpoints authenticate the client, not a browser session.
	if (path === "/oauth/token" || path === "/oauth/register" || WORKER_WELL_KNOWN.test(path)) return true;
	if (path === "/login" || path === "/setup" || path === "/recover" || path === "/forgot") return true;
	return /^\/(?:invite|reset)\/[^/]+$/.test(path);
}

/**
 * Unauthenticated API reads that are safe and needed before sign-in: the
 * login page renders the deployment's name and logo, and the installable
 * manifest links the logo. Branding is not secret — it is what the login page
 * exists to show.
 */
function isPublicApiRead(method: string, pathname: string): boolean {
	if (method !== "GET" && method !== "HEAD") return false;
	return (
		pathname === "/api/v1/branding" ||
		pathname === "/api/v1/branding/logo" ||
		// The API description and its reference page describe the API, never any
		// data, and tools fetch them before they have a token.
		pathname === "/api/v1/openapi.json" ||
		pathname === "/api/docs"
	);
}

/**
 * Establish identity in password mode, or run the Access check in access mode.
 *
 * Password mode never refuses here: an invalid cookie or token simply leaves
 * the request anonymous, and the gate decides what anonymous gets. That keeps
 * `/api/auth/state` and `/login` usable for someone holding a stale cookie.
 */
export function createAuthenticate(deps: AuthDeps): MiddlewareHandler<MailboxContext> {
	const isDev = deps.isDev === true;
	const access = accessAuthenticate(isDev);
	const now = deps.now ?? Date.now;
	const cache = deps.authCache;

	return createMiddleware<MailboxContext>(async (c, next) => {
		if (resolveAuthMode(c.env) === "access") return access(c, next);

		if (isDevBypass(c.env, isDev)) {
			c.set("developmentBypass", true);
			c.set("authMethod", "dev");
			return next();
		}

		const pathname = new URL(c.req.url).pathname;
		// API paths always resolve identity, whatever they end in.
		if (!isApiPath(pathname) && (isStaticPath(pathname) || pathname.startsWith("/t/") || pathname.startsWith("/u/") || pathname.startsWith("/img/"))) return next();

		const store = deps.getStore(c.env);

		/**
		 * An OAuth access token, on `/mcp` only. Its audience is `<origin>/mcp`
		 * and the library refuses it for any other resource, but it is also never
		 * even looked up elsewhere: `/api/*` stays `ttk_`-and-session only.
		 *
		 * The token proves an approval happened; the AuthDO row says whether it
		 * still stands and whether the user is still enabled, on every request.
		 */
		const isMcp = pathname === "/mcp" || pathname.startsWith("/mcp/");
		const oauthBearer = isMcp ? oauthBearerFrom(c.req.header("authorization")) : null;
		if (oauthBearer && deps.mcpOAuth && mcpOAuthEnabled(c.env)) {
			const origin = new URL(c.req.url).origin;
			// Keyed by origin too: a token is only valid for the resource it was issued for.
			const key = `o:${await sha256Hex(`${origin} ${oauthBearer}`)}`;
			const hit = lookup<{ user: AuthUser; grant?: OAuthGrantInfo }>(c, cache, store, key);
			if (hit) {
				setUser(c, hit.user, "oauth", null, null);
				if (hit.grant) c.set("authOAuthGrant", hit.grant);
				return next();
			}
			const attempt = begin(cache);
			const resolved = await deps.mcpOAuth.resolveAccessToken(c.env, origin, oauthBearer).catch((e) => {
				console.error("[oauth] token validation failed:", (e as Error).message);
				return null;
			});
			const valid = resolved ? await store.validateOAuthGrant(resolved.grantId, resolved.userId, now()) : null;
			if (valid) {
				setUser(c, valid.user, "oauth", null, null);
				// Never past the access token's own expiry (the provider reports seconds).
				const expiresAt = typeof resolved?.expiresAt === "number" ? resolved.expiresAt * 1000 : null;
				remember(cache, attempt, key, { user: valid.user, grant: valid.grant }, valid.epoch, expiresAt);
				// Which app is acting, for attribution and the send policy.
				c.set("authOAuthGrant", valid.grant);
			} else {
				c.set("authBearerRejected", true);
			}
			// Like an invalid `ttk_` token: no fallback to the cookie.
			return next();
		}

		const bearer = parseBearerToken(c.req.header("authorization"));
		if (bearer) {
			const secretHash = await sha256Hex(bearer.secret);
			const ip = c.req.header("cf-connecting-ip") ?? null;
			// The id is public; the secret's hash is what makes the key unguessable,
			// and a wrong secret for a real id is a different key, so it misses. The
			// IP is in the key so a token used from a new address still reaches the
			// store, which records "last used from" on an address change.
			const key = `t:${bearer.id}:${secretHash}:${ip ?? ""}`;
			const hit = lookup<{ user: AuthUser; token: ApiTokenInfo }>(c, cache, store, key);
			if (hit) {
				setUser(c, hit.user, "token", null, null);
				c.set("authToken", hit.token);
				return next();
			}
			const attempt = begin(cache);
			const result = await store.validateApiToken(
				bearer.id,
				secretHash,
				now(),
				ip,
			);
			if (result) {
				setUser(c, result.user, "token", null, null);
				// `resolvePrincipal` narrows the user's grants by this token's scopes
				// and mailbox allowlist. See `applyTokenRestriction`. The cached copy
				// carries the same scopes, so a hit narrows identically.
				c.set("authToken", result.token);
				remember(
					cache,
					attempt,
					key,
					{ user: result.user, token: result.token },
					result.epoch,
					result.token.expiresAt,
				);
			}
			// A presented-but-invalid token does not fall back to the cookie: a
			// client that sent one meant to be that token, and silently acting as
			// whoever's browser it is would be surprising.
			return next();
		}

		const token = readSessionCookie(c.req.header("cookie"), c.req.url);
		if (token) {
			const hash = await sha256Hex(token);
			const key = `s:${hash}`;
			const hit = lookup<{ user: AuthUser; session: SessionInfo }>(c, cache, store, key);
			if (hit) {
				setUser(c, hit.user, "session", hash, hit.session.id);
				return next();
			}
			const attempt = begin(cache);
			const result = await store.validateSession(hash, now());
			if (result) {
				setUser(c, result.user, "session", hash, result.session.id);
				/**
				 * `lastSeenAt` and the sliding idle deadline are written only on a miss.
				 * That loses nothing: the store touches at most once an hour anyway,
				 * and an active session misses at least once per TTL (30 s).
				 */
				remember(
					cache,
					attempt,
					key,
					{ user: result.user, session: result.session },
					result.epoch,
					result.session.expiresAt,
				);
			}
		}
		return next();
	});
}

// -- credential cache --------------------------------------------------------

interface CacheAttempt {
	generation: number;
	sentAt: number;
}

/**
 * A cached validation for `key`, or null (a miss). Records `cache=hit|miss`
 * for `Server-Timing`, and refreshes the epoch in the background once this
 * isolate's view of it is past its soft age.
 */
function lookup<T>(
	c: Context<MailboxContext>,
	cache: AuthCache | undefined,
	store: AuthStoreApi,
	key: string,
): T | null {
	if (!cache) return null;
	c.set("authCacheStatus", "miss");
	if (typeof store.getAuthEpoch !== "function") return null;
	const view = cache.epochView();
	if (!view) return null;
	if (view.stale) {
		const refresh = cache.refreshEpoch(() => store.getAuthEpoch!());
		try {
			c.executionCtx.waitUntil(refresh);
		} catch {
			// No execution context (unit tests): the promise still runs.
		}
	}
	const hit = cache.get<T>(key, view.epoch);
	if (hit) c.set("authCacheStatus", "hit");
	return hit;
}

/** What `remember` needs, captured before the store call is sent. */
function begin(cache: AuthCache | undefined): CacheAttempt | null {
	return cache ? { generation: cache.generation, sentAt: cache.clock() } : null;
}

/** Cache a successful validation and learn the epoch it ran under. */
function remember(
	cache: AuthCache | undefined,
	attempt: CacheAttempt | null,
	key: string,
	value: unknown,
	epoch: number | undefined,
	expiresAt: number | null,
): void {
	if (!cache || !attempt || typeof epoch !== "number") return;
	cache.noteEpoch(epoch, attempt.sentAt, attempt.generation);
	cache.set(key, value, epoch, attempt.generation, attempt.sentAt, expiresAt);
}

function setUser(
	c: Context<MailboxContext>,
	user: AuthUser,
	method: "session" | "token" | "oauth",
	sessionHash: string | null,
	sessionId: string | null,
) {
	c.set("accessIdentity", identityForUser(user));
	c.set("authUser", user);
	c.set("authSessionHash", sessionHash);
	c.set("authSessionId", sessionId);
	c.set("authMethod", method);
}

/**
 * Setup completes once and never reverts (the owner cannot be deleted), so a
 * `false` answer is cached for the isolate's lifetime. Keyed on the namespace
 * binding so separate environments — and separate tests — never share it.
 */
const setupDone = new WeakMap<object, true>();

async function isSetupRequired(env: Env, store: AuthStoreApi): Promise<boolean> {
	const key = (env.AUTH_STORE as object | undefined) ?? (env as object);
	if (setupDone.has(key)) return false;
	const required = await store.isSetupRequired();
	if (!required) setupDone.set(key, true);
	return required;
}

/**
 * React Router's single-fetch data requests (`/mail/x.data`, `/_root.data`)
 * cannot follow a 302 into an HTML page. They are answered the way React Router
 * itself answers a loader redirect, which the client turns into a navigation.
 */
function redirectFor(c: Context<MailboxContext>, isData: boolean, location: string): Response {
	if (isData) {
		return new Response(null, {
			status: 204,
			headers: {
				"X-Remix-Redirect": location,
				"X-Remix-Status": "302",
				"X-Remix-Reload-Document": "true",
			},
		});
	}
	return c.redirect(location, 302);
}

function loginLocation(pathname: string, search: string): string {
	if (pathname === "/" || isPublicPage(pathname)) return "/login";
	return `/login?next=${encodeURIComponent(`${pathname}${search}`)}`;
}

/**
 * The challenge that lets an MCP client discover OAuth (MCP authorization,
 * RFC 9728 §5.1). Only on `/mcp`, and only when OAuth is configured: elsewhere
 * a `Bearer` challenge would advertise a sign-in flow that issues tokens those
 * routes do not accept.
 */
function unauthenticatedHeaders(c: Context<MailboxContext>, pathname: string): Record<string, string> | undefined {
	const isMcp = pathname === "/mcp" || pathname.startsWith("/mcp/");
	if (!isMcp || !mcpOAuthEnabled(c.env)) return undefined;
	const origin = new URL(c.req.url).origin;
	return { "WWW-Authenticate": mcpBearerChallenge(origin, c.var.authBearerRejected === true) };
}

/**
 * Decide what an unauthenticated request gets. Password mode only — in access
 * mode the Access check has already refused anything without a valid token.
 */
export function createAuthGate(deps: AuthDeps): MiddlewareHandler<MailboxContext> {
	return createMiddleware<MailboxContext>(async (c, next) => {
		if (resolveAuthMode(c.env) === "access") return next();
		if (c.var.developmentBypass) return next();

		const url = new URL(c.req.url);
		const pathname = url.pathname;
		const signedIn = Boolean(c.var.accessIdentity);

		// Signed-token endpoints: the token is the credential. `/img/` is the
		// image proxy, loaded from the sandboxed email frame without cookies.
		if (pathname.startsWith("/t/") || pathname.startsWith("/u/") || pathname.startsWith("/img/") || pathname.startsWith("/push/") || pathname.startsWith("/api/auth/")) return next();

		// Before the static check, so an extension cannot dress an API call up as a file.
		if (isApiPath(pathname)) {
			if (signedIn || isPublicApiRead(c.req.method, pathname)) return next();
			return c.json(UNAUTHENTICATED_BODY, 401, unauthenticatedHeaders(c, pathname));
		}

		if (isStaticPath(pathname)) {
			/**
			 * Outside dev a real static file never reaches the Worker: the assets
			 * layer answers it first. So a "static-looking" path arriving here is
			 * either a Worker route (the exact entries below) or a request for a page
			 * dressed up as a file — `/settings.js` would otherwise fall through to the
			 * SSR catch-all and render an app page with no session. Refuse those
			 * rather than trusting the extension.
			 */
			if (deps.isDev === true || STATIC_EXACT.has(pathname)) return next();
			return c.text("Not found", 404);
		}

		// A page (or its `.data` request). Gate on the page the data belongs to.
		const isData = pathname.endsWith(".data");
		let page = isData ? pathname.slice(0, -".data".length) : pathname;
		if (page === "/_root" || page === "") page = "/";

		if (signedIn) {
			// Already signed in: the sign-in screens have nothing to offer.
			if (page === "/login" || page === "/setup") return redirectFor(c, isData, "/");
			return next();
		}

		const store = deps.getStore(c.env);
		if (await isSetupRequired(c.env, store)) {
			return page === "/setup" ? next() : redirectFor(c, isData, "/setup");
		}
		if (page === "/setup") return redirectFor(c, isData, "/login");
		if (isPublicPage(page)) return next();

		return redirectFor(c, isData, loginLocation(page, isData ? "" : url.search));
	});
}

/** Refuse a request that is not a signed-in built-in account. */
export const requireUser = createMiddleware<MailboxContext>(async (c, next) => {
	if (!c.var.authUser) return c.json(UNAUTHENTICATED_BODY, 401);
	return next();
});

/**
 * Refuse a caller authenticated by API token rather than a browser session.
 *
 * Applied to the operations that would turn a leaked token into a taken-over
 * account: minting more tokens, changing the password, changing 2FA, revoking
 * sessions, and every change made through the admin endpoints.
 */
export const requireSession = createMiddleware<MailboxContext>(async (c, next) => {
	if (!c.var.authUser) return c.json(UNAUTHENTICATED_BODY, 401);
	if (c.var.authMethod !== "session") {
		return c.json(
			{ error: "This action requires a signed-in browser session, not an API token.", code: "session_required" },
			403,
		);
	}
	return next();
});
