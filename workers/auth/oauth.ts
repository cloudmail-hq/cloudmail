// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * OAuth 2.1 sign-in for MCP clients (MCP authorization spec, 2026-07-28).
 *
 * A client such as Claude Code connects to `/mcp`, gets a `401` whose
 * `WWW-Authenticate` names our protected resource metadata, registers itself
 * (RFC 7591), sends the user's browser to `/oauth/authorize`, and exchanges the
 * code (PKCE S256) for an access token bound to `<origin>/mcp`. That token then
 * acts exactly like the user's `ttk_` API token — same identity, same grants —
 * but only on `/mcp`.
 *
 * Why the library's role API rather than wrapping the Worker in `OAuthProvider`:
 * the wrapper owns routing and authentication for its API route, so `/mcp`
 * would stop accepting `ttk_` tokens (they are not its tokens) and would bypass
 * our CSRF guard, security headers, session cookies and the per-request
 * principal header `serveMcp` relies on. `OAuthAuthorizationServer` is the same
 * engine used as a library: we route its protocol endpoints from Hono, call
 * `validateToken()` from our own authenticate middleware, and leave every
 * existing route exactly where it was.
 *
 * Two stores, on purpose:
 * - The provider keeps clients, grants and tokens in the `OAUTH_KV` namespace
 *   (hashed, props encrypted). KV is eventually consistent and outside the
 *   AuthDO's transactions.
 * - The AuthDO keeps one `oauth_grants` row per approval. It is the authority
 *   on whether an approval still stands: checked on every `/mcp` request and on
 *   every code/refresh exchange, and deleted by the same statements that
 *   disable, delete, reset or sign a user out everywhere. Revocation therefore
 *   takes effect on the next request; cleaning the KV records is best-effort.
 */

import {
	AuthorizationError,
	CimdFetchError,
	OAuthAuthorizationServer,
	OAuthError,
	type AuthRequest,
	type ConsentDescription,
	type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { Context, Handler, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { getBranding } from "../lib/branding";
import type { MailboxContext } from "../lib/mailbox";
import type { Env } from "../types";
import type { AuthDeps } from "./middleware";
import {
	AS_METADATA_PATH,
	AUTHORIZE_PATH,
	MCP_PRM_PATH,
	MCP_SCOPE,
	REGISTER_PATH,
	TOKEN_PATH,
	mcpOAuthEnabled,
	mcpResource,
	protectedResourceMetadata,
} from "./oauth-metadata";
import { authLimit } from "./ratelimit";
import type { AuthStoreApi } from "./types";

/** What we store in the provider's encrypted props: enough to find the AuthDO row. */
export interface McpOAuthProps {
	userId: string;
	grantId: string;
	/** Access-token expiry in seconds since the epoch, when the provider reports it. */
	expiresAt?: number;
}

/** Hooks the auth middleware and routes call; optional in `AuthDeps` so tests can omit them. */
export interface McpOAuthHooks {
	/** The approving user and AuthDO grant for an access token valid for `<origin>/mcp`, else null. */
	resolveAccessToken(env: Env, origin: string, token: string): Promise<McpOAuthProps | null>;
	/** Best-effort: delete the provider's KV grants for a user (all, or one AuthDO grant). */
	revokeProviderGrants(env: Env, origin: string, userId: string, grantId?: string): Promise<void>;
}

// -- the provider ------------------------------------------------------------

/**
 * One authorization server per origin, because the issuer and the resource are
 * the request origin: a deployment reachable on a custom domain and on
 * workers.dev issues tokens for each separately, and neither is accepted on
 * the other. Capped so a stream of odd Host headers cannot grow it unbounded.
 */
const serversByStore = new WeakMap<AuthDeps["getStore"], Map<string, OAuthAuthorizationServer<Env>>>();
const MAX_SERVERS = 8;

export function oauthServerFor(origin: string, getStore: AuthDeps["getStore"]): OAuthAuthorizationServer<Env> {
	// Keyed by the store accessor too: the provider's exchange callback closes over it.
	let servers = serversByStore.get(getStore);
	if (!servers) {
		servers = new Map();
		serversByStore.set(getStore, servers);
	}
	const cached = servers.get(origin);
	if (cached) return cached;
	const server = new OAuthAuthorizationServer<Env>({
		issuer: origin,
		resources: [mcpResource(origin)],
		authorizeEndpoint: AUTHORIZE_PATH,
		tokenEndpoint: TOKEN_PATH,
		clientRegistrationEndpoint: REGISTER_PATH,
		scopesSupported: [MCP_SCOPE],
		/**
		 * Defaults kept deliberately: 1-hour access tokens, refresh tokens that
		 * rotate on every use, and a grant that ends 30 days after approval however
		 * often it is refreshed — the same absolute lifetime as a browser session.
		 */
		/**
		 * The AuthDO veto. Runs on the code exchange and every refresh, so a client
		 * of a user who has since been disabled, deleted, reset or signed out
		 * everywhere — or who revoked this app — cannot mint another token.
		 * `invalid_grant` also makes the library delete the KV grant, which is the
		 * cleanup for every revocation path that did not do it itself.
		 */
		tokenExchangeCallback: async ({ props, env }) => {
			const p = props as Partial<McpOAuthProps> | undefined;
			if (!p?.userId || !p.grantId) {
				throw new OAuthError("invalid_grant", { description: "This authorization is no longer valid" });
			}
			const valid = await getStore(env).validateOAuthGrant(p.grantId, p.userId, Date.now());
			if (!valid) {
				throw new OAuthError("invalid_grant", { description: "This authorization is no longer valid" });
			}
		},
		onError: ({ status, code, internal }) => {
			// Reasons, never descriptions or bodies: those can echo client input.
			if (status >= 500) console.error(`[oauth] ${status} ${code} ${internal.category}/${internal.reason}`);
		},
	});
	if (servers.size >= MAX_SERVERS) servers.delete(servers.keys().next().value!);
	servers.set(origin, server);
	return server;
}

export function createMcpOAuthHooks(getStore: AuthDeps["getStore"]): McpOAuthHooks {
	return {
		async resolveAccessToken(env, origin, token) {
			const server = oauthServerFor(origin, getStore);
			const validated = await server.validateToken<McpOAuthProps>(mcpResource(origin), token, env);
			const props = validated?.props;
			if (!props?.userId || !props.grantId || props.userId !== validated!.userId) return null;
			return {
				userId: props.userId,
				grantId: props.grantId,
				...(typeof validated!.expiresAt === "number" ? { expiresAt: validated!.expiresAt } : {}),
			};
		},
		async revokeProviderGrants(env, origin, userId, grantId) {
			const oauth = oauthServerFor(origin, getStore).getOAuthApi(env);
			let cursor: string | undefined;
			do {
				const page = await oauth.listUserGrants(userId, { cursor });
				for (const grant of page.items) {
					if (grantId === undefined || grant.metadata?.grantId === grantId) {
						await oauth.revokeGrant(grant.id, userId);
					}
				}
				cursor = page.cursor;
			} while (cursor);
		},
	};
}

// -- protocol endpoints --------------------------------------------------------

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
	"Access-Control-Allow-Headers": "*",
} as const;

/**
 * Discovery, registration and the token endpoint.
 *
 * Mounted ahead of the CSRF guard in `workers/app.ts`. These endpoints read no
 * cookie and act for no session: the token endpoint authenticates the client
 * by its code verifier, refresh token or secret, and registration creates a
 * client that still needs a signed-in user's consent. A browser-based MCP
 * client calls them cross-origin with CORS, which the CSRF guard would refuse
 * for no benefit. Security headers still apply; they are mounted outermost.
 */
export function createOAuthProtocolMiddleware(deps: AuthDeps): MiddlewareHandler<MailboxContext> {
	return createMiddleware<MailboxContext>(async (c, next) => {
		if (!mcpOAuthEnabled(c.env)) return next();
		const path = new URL(c.req.url).pathname;
		if (path === MCP_PRM_PATH) return protectedResource(c);
		if (path !== AS_METADATA_PATH && path !== TOKEN_PATH && path !== REGISTER_PATH) return next();
		if (path === REGISTER_PATH && c.req.method === "POST") {
			// Registration writes to KV with no account behind it; bound it per address.
			const ip = c.req.header("cf-connecting-ip") ?? "unknown";
			if (!(await authLimit(c.env, `oauth-register:ip:${ip}`))) {
				return c.json(
					{ error: "temporarily_unavailable", error_description: "Too many registrations" },
					429,
					{ "Retry-After": "60" },
				);
			}
		}
		const origin = new URL(c.req.url).origin;
		return oauthServerFor(origin, deps.getStore).fetch(c.req.raw, c.env, c.executionCtx as ExecutionContext);
	});
}

/**
 * RFC 9728 metadata for `/mcp`, served here rather than by the library's
 * resource-server host because `/mcp` itself stays on our own pipeline.
 * Only the path-specific document exists: the root document would have to
 * describe the origin as the resource, which is not what our tokens are for.
 */
function protectedResource(c: Context<MailboxContext>): Response {
	if (c.req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
	if (c.req.method !== "GET" && c.req.method !== "HEAD") {
		return new Response(null, { status: 405, headers: { ...CORS_HEADERS, Allow: "GET, HEAD, OPTIONS" } });
	}
	const body = JSON.stringify(protectedResourceMetadata(new URL(c.req.url).origin));
	return new Response(c.req.method === "HEAD" ? null : body, {
		headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
	});
}

// -- the consent page ----------------------------------------------------------

/**
 * `/oauth/authorize`: our own consent page, server-rendered.
 *
 * Mounted after the auth gate, so a visitor without a session is already sent
 * to `/login?next=/oauth/authorize?...` and comes back here once signed in.
 * Approving needs a browser session: an API token or an OAuth token must not be
 * able to mint more credentials, the same rule token creation follows.
 *
 * The library's consent transaction carries the confused-deputy protections:
 * the validated request is stored server-side under a single-use handle bound
 * to this browser by a `__Host-` cookie, so the POST cannot be forged from
 * another site or replayed, and its client and redirect URI cannot be swapped.
 * Every request shows the page; there is no auto-approval, remembered or
 * otherwise, so a dynamically registered client never gets a token without the
 * user seeing its name and where the token goes.
 */
export function createOAuthAuthorizeHandler(deps: AuthDeps): Handler<MailboxContext> {
	const now = deps.now ?? Date.now;
	return async (c, next) => {
		if (!mcpOAuthEnabled(c.env)) return next();
		const user = c.var.authUser;
		// The gate has already redirected anyone without an identity to sign in.
		if (!user) return next();
		if (c.var.authMethod !== "session") {
			return page(403, {
				title: "Sign in with your browser",
				message: "Connecting an app needs a signed-in browser session, not an API token.",
			});
		}

		const origin = new URL(c.req.url).origin;
		const oauth = oauthServerFor(origin, deps.getStore).getOAuthApi(c.env);
		try {
			if (c.req.method === "GET") return await showConsent(c, oauth, user.email);
			return await decide(c, oauth, deps.getStore(c.env), user.id, now());
		} catch (error) {
			if (error instanceof AuthorizationError && error.redirectTo) {
				return c.redirect(error.redirectTo, 302);
			}
			if (error instanceof AuthorizationError) {
				return page(400, { title: "Can't connect this app", message: error.description });
			}
			if (error instanceof CimdFetchError) {
				return page(400, { title: "Can't connect this app", message: "This app could not be verified." });
			}
			throw error;
		}
	};
}

async function showConsent(c: Context<MailboxContext>, oauth: OAuthHelpers, email: string): Promise<Response> {
	const request = await oauth.parseAuthRequest(c.req.raw);
	// Before beginConsent: a failed lookup must leave nothing in KV.
	const details = await oauth.describeConsent(request);
	const consent = await oauth.beginConsent(request);
	const appName = await appNameFor(c.env);
	const headers = new Headers(consent.headers);
	headers.set("Content-Type", "text/html; charset=utf-8");
	headers.set("Content-Security-Policy", consentCsp(details.redirectUri));
	return new Response(consentHtml({ details, handle: consent.handle, email, appName }), { status: 200, headers });
}

async function decide(
	c: Context<MailboxContext>,
	oauth: OAuthHelpers,
	store: AuthStoreApi,
	userId: string,
	t: number,
): Promise<Response> {
	const form = await c.req.raw.formData();
	const handle = String(form.get("handle") ?? "");
	if (form.get("decision") !== "approve") {
		const denied = await oauth.denyConsent(c.req.raw, handle);
		return new Response(null, { status: 302, headers: denied.headers });
	}

	// The request comes back from storage, never from the form.
	const approved = await oauth.approveConsent(c.req.raw, handle, { scope: [MCP_SCOPE] });
	const request: AuthRequest = approved.request;
	const details = await oauth.describeConsent(request);
	const grant = await store.createOAuthGrant({
		userId,
		clientId: request.clientId,
		clientName: details.clientName,
		redirectHost: details.redirectHost,
		now: t,
	});
	const props: McpOAuthProps = { userId, grantId: grant.id };
	const { redirectTo } = await oauth.completeAuthorization({
		request,
		userId,
		// Plain-text KV metadata: only ids, so revoking from Settings can find it.
		metadata: { grantId: grant.id },
		scope: request.scope,
		props,
	});
	const headers = new Headers(approved.headers);
	headers.set("Location", redirectTo);
	return new Response(null, { status: 302, headers });
}

async function appNameFor(env: Env): Promise<string> {
	try {
		return (await getBranding(env.BUCKET)).appName || "cloudmail";
	} catch {
		return "cloudmail";
	}
}

// -- HTML ----------------------------------------------------------------------

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/**
 * The page needs no script, so it gets a policy far tighter than the app's.
 *
 * `form-action` must include the client's redirect origin: Chrome applies it to
 * the redirect that follows a form submission, so `'self'` alone would block
 * the approve/deny redirect to `http://localhost:<port>/callback`. The origin
 * comes from a redirect URI the library has already validated (https, or http
 * on a loopback host) and is re-checked here so nothing can be smuggled into
 * the header.
 */
export function consentCsp(redirectUri: string): string {
	let target = "";
	try {
		const origin = new URL(redirectUri).origin;
		if (/^https?:\/\/[A-Za-z0-9.\-[\]:]+$/.test(origin)) target = ` ${origin}`;
	} catch {
		// Leave it out: the redirect is then blocked, which is the safe failure.
	}
	return [
		"default-src 'none'",
		"style-src 'unsafe-inline'",
		"img-src 'self' data:",
		`form-action 'self'${target}`,
		"frame-ancestors 'none'",
		"base-uri 'none'",
	].join("; ");
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fcfcfc;--card:#fff;--fg:#0f172a;--muted:#64748b;--border:#e5e7eb;--subtle:#f3f4f6;--accent:#7c5cfc;--warn-bg:#fffbeb;--warn-fg:#92400e}
@media (prefers-color-scheme:dark){:root{--bg:#0e1015;--card:#15181f;--fg:#e5e7eb;--muted:#94a3b8;--border:#262a33;--subtle:#1c2029;--warn-bg:#2a2210;--warn-fg:#fcd34d}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:40px 16px;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:440px}.brand{display:flex;justify-content:center;gap:8px;align-items:center;margin-bottom:24px;font-weight:800;text-transform:uppercase;letter-spacing:-.01em}
.glyph{width:32px;height:32px;border-radius:8px;background:#0a0a0a;display:inline-flex;align-items:center;justify-content:center;color:#bfff00;font-weight:900}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:28px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
h1{font-size:20px;margin:0 0 6px;letter-spacing:-.01em}p{margin:0 0 12px;color:var(--muted)}strong{color:var(--fg)}
dl{margin:16px 0;padding:12px 14px;background:var(--subtle);border-radius:8px;display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:13px}dt{color:var(--muted)}dd{margin:0;word-break:break-word}
.warn{background:var(--warn-bg);color:var(--warn-fg);border-radius:8px;padding:10px 12px;font-size:13px;margin:12px 0}
.actions{display:flex;gap:8px;margin-top:20px}button{flex:1;height:38px;border-radius:8px;font:inherit;font-weight:600;cursor:pointer;border:1px solid var(--border);background:var(--card);color:var(--fg)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.foot{margin-top:16px;font-size:12px;text-align:center;color:var(--muted)}
`;

function layout(appName: string, title: string, body: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escapeHtml(title)} · ${escapeHtml(appName)}</title><style>${STYLE}</style></head>
<body><main><div class="brand"><span class="glyph" aria-hidden="true">@</span><span>${escapeHtml(appName)}</span></div>
<div class="card">${body}</div></main></body></html>`;
}

/** Everything client-supplied (name, URIs) is escaped: DCR lets anyone choose it. */
export function consentHtml(input: {
	details: ConsentDescription;
	handle: string;
	email: string;
	appName: string;
}): string {
	const { details, handle, email, appName } = input;
	const name = escapeHtml(details.clientName);
	const provenance = details.clientDomain
		? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
		: "This app registered itself, so its name is not verified.";
	const loopback = details.redirectIsLoopback
		? `<div class="warn" role="note"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</div>`
		: "";
	const body = `<h1>Connect ${name}?</h1>
<p>${provenance}</p>
<p><strong>${name}</strong> will be able to use ${escapeHtml(appName)} over MCP <strong>as you</strong>, with your mailbox access: read, search, draft, organise and send mail in every mailbox you can reach.</p>
<dl><dt>Signed in as</dt><dd>${escapeHtml(email)}</dd><dt>Access sent to</dt><dd>${escapeHtml(details.redirectHost)}</dd></dl>
${loopback}
<form method="post">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<div class="actions"><button type="submit" name="decision" value="deny">Deny</button><button type="submit" name="decision" value="approve" class="primary">Approve</button></div>
</form>
<p class="foot">You can disconnect it any time under Settings → Account &amp; security → Connected apps.</p>`;
	return layout(appName, `Connect ${details.clientName}`, body);
}

function page(status: 400 | 403, input: { title: string; message: string }): Response {
	const body = `<h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.message)}</p><p class="foot">Start connecting again from the app.</p>`;
	return new Response(layout("cloudmail", input.title, body), {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Content-Security-Policy": consentCsp(""),
		},
	});
}
