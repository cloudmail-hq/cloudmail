// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { routeAgentRequest } from "agents";
import { Hono, type Context } from "hono";
import { createRequestHandler } from "react-router";
import { app as apiApp, receiveEmail } from "./index";
import { EmailMCP, MCP_PRINCIPAL_HEADER, encodeMcpPrincipal } from "./mcp";
import { dispatchDueSequenceEmails } from "./lib/sequence-dispatch";
import { DEFAULT_LOOKBACK_MINUTES, reconcileDeliveryEvents } from "./lib/email-reconciler";
import { handleComplaint, handleHardBounce } from "./lib/suppressions";
import { maybeEvaluateSendingHealth, mirrorProviderComplaints } from "./lib/sending-health";
import { maybeCheckUsageBudget } from "./lib/usage";
import {
	handleClickRedirect,
	handleOpenPixel,
} from "./lib/tracking-endpoint";
import { trackingRequestContext } from "./lib/tracking-self-open";
import {
	handleUnsubscribePage,
	handleUnsubscribePost,
} from "./lib/unsubscribe-endpoint";
import { publicProductRoutes } from "./routes/products";
import { publicPushRoutes } from "./routes/push";
import { getZones } from "./lib/zones";
import { renderPrivacyPage } from "./lib/privacy";
import { runRetentionTick } from "./lib/retention";
import { runAccountDeletionTick, runExportTick } from "./lib/account-privacy";
import { forgetMailboxRouting } from "./routes/domains";
import type { PrivacyStoreApi } from "./auth/types";
import { liveAliasMap, loadStoredDomains } from "./routes/domains";
import { webhookStub } from "./lib/webhooks";
import { expireAgentInboxes } from "./lib/agent-inboxes";
import { csrfGuard } from "./lib/csrf";
import { tokenCreateIdempotency } from "./lib/idempotency";
import { withSecurityHeaders } from "./lib/security-headers";
import { recordDeploymentOrigin } from "./lib/deployment-origin";
import { licenceGate } from "./lib/licence-gate";
import { maybeRefreshLicence } from "./lib/licence";
import { handleImageProxy } from "./lib/image-proxy";
import { rateLimitGuard } from "./lib/rate-limit";
import { resolvePrincipal } from "./lib/mailbox";
import { serverTiming, timedMiddleware } from "./lib/server-timing";
import { agentTargetFromPath, canAccessMailbox, canDo } from "./lib/authz";
import { authStore } from "./auth/store";
import { createAuthenticate, createAuthGate, type AuthDeps } from "./auth/middleware";
import { createAuthRoutes } from "./auth/routes";
import {
	createMcpOAuthHooks,
	createOAuthAuthorizeHandler,
	createOAuthProtocolMiddleware,
} from "./auth/oauth";
import { AUTHORIZE_PATH } from "./auth/oauth-metadata";
import type { AuthStoreApi } from "./auth/types";
import { AuthCache, withAuthCacheInvalidation } from "./auth/session-cache";
import { AGENT_SOCKET_CAPABILITIES } from "./lib/capabilities";
import type { MailboxContext } from "./lib/mailbox";

import type { Env } from "./types";

export { MailboxDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";
export { AuthDO } from "./auth/store";
export { WebhookDO } from "./lib/webhooks-do";
export { AssistantDO } from "./lib/assistant-do";
export { EventsDO } from "./lib/events-do";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

/**
 * How the auth layer reaches its storage. The stub's RPC methods mirror
 * `AuthStoreApi` one for one; the cast only drops the RPC wrapper types.
 *
 * One credential cache per isolate. Every store call goes through the wrapper,
 * so a logout, revoke, password change or admin action handled here
 * invalidates it at once; other isolates notice through the AuthDO's auth
 * epoch within 5 s. See ./auth/session-cache.ts.
 */
const authCache = new AuthCache();
const getAuthStore = withAuthCacheInvalidation(
	(env: Env) => authStore(env) as unknown as AuthStoreApi,
	authCache,
);
const authDeps: AuthDeps = {
	getStore: getAuthStore,
	authCache,
	isDev: import.meta.env.DEV,
	mcpOAuth: createMcpOAuthHooks(getAuthStore),
};

// Main app that wraps the API and adds React Router fallback.
// Shares `MailboxContext` with the API app so context variables set here
// (the Access identity) are readable from the routes in `workers/index.ts`.
const app = new Hono<MailboxContext>();

/**
 * Attach hardening headers to everything we serve.
 *
 * Outermost so it also covers `/mcp`, `/agents/*` and the SSR catch-all, and so
 * the headers survive the early returns further down — a 403 from the CSRF guard
 * or the Access check is still a response this origin sent.
 *
 * Headers are set on the way out, after `next()`, and only when absent, so a
 * route that deliberately chose its own value (the attachment endpoint's
 * `Content-Disposition` handling, the logo's cache policy) keeps it.
 *
 * `try/finally` because the block has to run even when a downstream handler
 * throws: Hono's default error path would otherwise return a bare 500 with none
 * of these headers.
 */
app.use("*", async (c, next) => {
	try {
		await next();
	} finally {
		if (c.res) c.res = withSecurityHeaders(c.res, c.req.url);
	}
});

// Per-stage `Server-Timing` on `/api/*` (auth, authz, mailbox lookup, DO call).
// See ./lib/server-timing.ts.
app.use("*", serverTiming);

/**
 * Reject cross-site writes before anything else looks at the request.
 *
 * Ahead of the Access check on purpose: a forged request usually *does* carry a
 * valid Access cookie — that is the whole point of the attack — so passing
 * authentication tells us nothing about whether the reader intended it. See
 * ./lib/csrf.ts.
 *
 * Mounted on the outer app so it also covers `/mcp`, whose tools can send and
 * delete mail, rather than only the `/api/*` routes.
 */
/**
 * OAuth discovery, client registration and the token endpoint for MCP clients.
 *
 * Ahead of the CSRF guard because none of them reads a cookie or acts for a
 * browser session — the token endpoint authenticates the client by its PKCE
 * verifier or refresh token — and browser-based MCP clients call them
 * cross-origin. Behind the security headers like everything else. The consent
 * page, which does act for a session, is mounted after the gate below.
 */
app.use("*", createOAuthProtocolMiddleware(authDeps));

app.use("*", csrfGuard);

/**
 * PUBLIC tracking endpoints — the one unauthenticated surface in the app.
 *
 * Registered BEFORE the Access middleware below, because Hono runs middleware
 * only for routes registered after it: mounting these here is what lets them
 * skip Access while still passing through the security-headers wrapper and the
 * CSRF guard above (both of which allow GET). They must be reachable without an
 * Access identity because the *recipient* of an email fetches them — an image
 * load or a link click — and the recipient has no Access cookie.
 *
 * Everything these trust comes from a signed token; see
 * `workers/lib/tracking-endpoint.ts` and `shared/tracking-token.ts`. A forged or
 * missing token yields the pixel (recording nothing) or a 400 on the redirect,
 * never a leak of which messages exist.
 *
 * The path prefix is `/t/` — short, so the tracking URL a mail client fetches
 * stays small.
 */
// The context carries the UA / network facts for the privacy-proxy flag and a
// self-open check against the app's own session cookie; see
// ./lib/tracking-self-open.ts.
app.get("/t/o/:token", (c) =>
	handleOpenPixel(
		c.req.param("token"),
		c.env,
		(p) => c.executionCtx.waitUntil(p),
		trackingRequestContext(c.req.raw, c.env, getAuthStore),
	),
);
app.get("/t/c/:token", (c) =>
	handleClickRedirect(
		c.req.param("token"),
		c.env,
		(p) => c.executionCtx.waitUntil(p),
		trackingRequestContext(c.req.raw, c.env, getAuthStore),
	),
);

/**
 * PUBLIC unsubscribe endpoint, mounted beside `/t/` for the same reason: the
 * recipient (or, for RFC 8058 one-click, their mailbox provider) has no
 * session. GET shows a confirmation page and records nothing; POST records the
 * suppression. The signed token is the only credential, and the CSRF guard
 * above exempts this path. See `workers/lib/unsubscribe-endpoint.ts`.
 */
app.get("/u/:token", (c) => handleUnsubscribePage(c.req.param("token"), c.env, c.req.url));
/**
 * The public privacy notice, rendered from the operator's settings in R2.
 * Public for the same reason as `/u/`: recipients of tracked mail read it.
 */
app.get("/privacy", (c) => renderPrivacyPage(c.env.BUCKET));
app.post("/u/:token", (c) =>
	handleUnsubscribePost(c.req.param("token"), c.env, (p) => c.executionCtx.waitUntil(p), c.req.url, c.req.raw),
);

/**
 * PUBLIC product logos, for the unsubscribe page and outgoing templates: the
 * reader of an email has no session. Raster images only, by product id; see
 * `workers/routes/products.ts`.
 */
app.route("/", publicProductRoutes);

/**
 * PUBLIC Web Push endpoints for the service worker, which in some browsers
 * runs with no session cookie: notification buttons (a signed, single-use,
 * per-message token is the credential) and `pushsubscriptionchange` (the old
 * subscription's auth secret is). Same-origin POSTs, so behind the CSRF
 * guard like everything else. See ./routes/push.ts.
 */
app.route("/", publicPushRoutes);

/**
 * Remote-image privacy proxy. The signed, expiring URL is the credential: the
 * images load from the sandboxed email frame, which sends no session cookie.
 * Only the Worker mints signatures, inside an authenticated message read, so
 * this is not an open proxy. See ./lib/image-proxy.ts.
 */
app.get("/img/:sig", (c) => {
	return handleImageProxy(c.req.raw, c.env, (p) => c.executionCtx.waitUntil(p), {
		ownDomains: getZones(c.env).map((z) => z.domain.toLowerCase()),
	});
});

/**
 * Authentication: establish who is calling.
 *
 * Registered after the tracking endpoints above so those stay public, and
 * after the CSRF guard so a forged write is refused before a session cookie is
 * even looked at — a forged request carries the victim's cookie, which is the
 * whole point of the attack.
 *
 * Which mechanism runs is decided per request by `AUTH_MODE` (see
 * `workers/auth/config.ts`): built-in password accounts by default, or the
 * original Cloudflare Access JWT check for deployments that use Access. In
 * password mode this never refuses; it only recognises a session cookie or a
 * `ttk_` API token. Refusing is the gate's job, below.
 */
app.use(
	"*",
	timedMiddleware("auth", createAuthenticate(authDeps), (c) => {
		const status = (c as Context<MailboxContext>).var.authCacheStatus;
		return status ? `cache=${status}` : undefined;
	}),
);

/**
 * Sign-in, account and user-management endpoints.
 *
 * Mounted before the gate because signing in has to work without being signed
 * in. Each endpoint that needs an account checks for one itself.
 */
// Idempotency-Key on token creation. See ./lib/idempotency.ts.
app.on(["POST"], "/api/auth/tokens", tokenCreateIdempotency);
app.route("/api/auth", createAuthRoutes(authDeps));

/**
 * Refuse or redirect what has no identity: 401 JSON on `/api/*`, `/mcp` and
 * `/agents/*`, and a redirect to `/login` (or `/setup` on a fresh deployment)
 * for pages. Static files, the sign-in pages and the branding reads the login
 * screen needs pass through. Password mode only; Access already refused.
 */
app.use("*", createAuthGate(authDeps));

/**
 * The licence lock: 402 `licence_required` on `/api`, `/mcp` and `/agents`
 * while the app has no valid licence, except sign-in, the licence routes,
 * `GET /api/v1/me` and the Cloudflare connection (./lib/licence-gate.ts).
 * After the auth gate, so anonymous callers still get 401; everything mounted
 * above this line (tracking, unsubscribe, privacy, logos, push actions, image
 * proxy) serves recipients and is never locked. A no-op unless
 * LICENCE_ENFORCEMENT=enforce. The `email()` handler below never checks it.
 */
app.use("*", licenceGate);

/**
 * Remember the origin this deployment is reached on, for cron and alarm sends
 * (tracking and unsubscribe links) that have no request. Only a signed-in
 * browser session or a verified Access identity counts: an anonymous request
 * (or an API token script) proves nothing about which host is the real one.
 * Off the request path, and a no-op once the isolate knows the origin. See
 * ./lib/deployment-origin.ts.
 */
app.use("*", async (c, next) => {
	const method = c.var.authMethod;
	if ((method === "session" || method === "access") && c.var.accessIdentity) {
		c.executionCtx.waitUntil(recordDeploymentOrigin(c.env, c.req.url, "request"));
	}
	return next();
});

/**
 * The OAuth consent page. After the gate, so a visitor without a session is
 * sent to `/login?next=...` first; after the CSRF guard, so the approve POST is
 * same-origin. See ./auth/oauth.ts.
 */
app.on(["GET", "POST"], AUTHORIZE_PATH, createOAuthAuthorizeHandler(authDeps));

// MCP server endpoint — used by AI coding tools (ProtoAgent, Claude Code, Cursor, etc.)
// Must be before API routes and React Router catch-all
const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });

/**
 * Hand the MCP agent the caller's authority.
 *
 * `EmailMCP` runs in its own Durable Object, so Hono context does not reach it.
 * The agents SDK forwards `ctx.props` into the instance, which is the right
 * channel precisely because it is set here and never by the client: nothing in
 * the request can forge it, so the agent has no header to distrust.
 *
 * Without this, MCP was the way around the whole grant model — its tools take a
 * `mailboxId` argument and include `send_email` and `delete_email`, so any
 * connected client could act on any mailbox regardless of who was holding it.
 */
async function serveMcp(c: Context<MailboxContext>) {
	const ctx = c.executionCtx as ExecutionContext & {
		props?: Record<string, unknown>;
	};
	ctx.props = { ...(ctx.props ?? {}), principal: c.var.principal };

	/**
	 * The agent authorizes every call from this header, not from `ctx.props`: the
	 * SDK only hands props to the instance on its first start, so they go stale
	 * when a grant changes. `set` overwrites anything the client sent.
	 */
	const encoded = encodeMcpPrincipal(c.var.principal);
	const headers = new Headers(c.req.raw.headers);
	headers.set(MCP_PRINCIPAL_HEADER, encoded);
	const request = new Request(c.req.raw, { headers });

	// DELETE destroys the session over RPC and never reaches the agent's
	// per-request check, so confirm here that the caller owns the session.
	const sessionId = request.headers.get("mcp-session-id");
	if (request.method === "DELETE" && sessionId) {
		const stub = c.env.EMAIL_MCP.get(
			c.env.EMAIL_MCP.idFromName(`streamable-http:${sessionId}`),
		);
		if (!(await stub.acceptsCaller(encoded))) {
			return c.json(
				{ jsonrpc: "2.0", error: { code: -32003, message: "Forbidden" }, id: null },
				403,
			);
		}
	}

	return mcpHandler.fetch(request, c.env, ctx);
}

/**
 * Resolve the principal for MCP as well, then rate limit on it.
 *
 * The tighter bucket is deliberate: one MCP call can fan out to Workers AI and
 * to the send path, so it should not be able to spend the same budget as a tab
 * polling for new mail.
 */
const mcpRateLimit = rateLimitGuard({
	bucket: "mcp",
	bindingName: "MCP_RATE_LIMITER",
	select: (env) => env.MCP_RATE_LIMITER,
	retryAfterSeconds: 60,
});

app.use("/mcp", resolvePrincipal, mcpRateLimit);
app.use("/mcp/*", resolvePrincipal, mcpRateLimit);
app.all("/mcp", serveMcp);
app.all("/mcp/*", serveMcp);

// Mount the API routes
app.route("/", apiApp);

/**
 * Agent WebSocket routing — must be before React Router catch-all.
 *
 * Guarded for the same reason MCP is: the agent's tools read the mailbox
 * (`get_email`, `search_emails`) and change it (`draft_email`, `move_email`,
 * `discard_draft`), and the instance is addressed by mailbox name straight from
 * the URL. Without this a member could open a socket to a colleague's agent and
 * work through it, which would make the grant model decorative.
 */
app.use(
	"/agents/*",
	resolvePrincipal,
	rateLimitGuard({
		// Shares the API budget: a handshake is an ordinary request, and the work
		// that follows happens over the socket where this cannot see it.
		bucket: "api",
		bindingName: "API_RATE_LIMITER",
		select: (env) => env.API_RATE_LIMITER,
		retryAfterSeconds: 60,
	}),
);

app.all("/agents/*", async (c) => {
	const pathname = new URL(c.req.url).pathname;

	// The agents router addresses every Durable Object binding by name, which
	// would reach the MCP server here without going through `serveMcp` and its
	// per-request principal. MCP has exactly one front door.
	if (pathname.startsWith("/agents/email-mcp/")) return c.text("Not found", 404);

	const target = agentTargetFromPath(pathname);

	if (target && !canAccessMailbox(c.var.principal, target)) {
		return c.text("You do not have access to this mailbox", 403);
	}

	/**
	 * The socket requires every capability its tools can exercise.
	 *
	 * `createEmailTools` exposes nine tools spanning three capabilities:
	 * `list_emails`, `get_email`, `get_thread` and `search_emails` are **read**;
	 * `draft_email`, `draft_reply` and `discard_draft` are **draft**;
	 * `mark_email_read` and `move_email` are **organise**. There is deliberately no
	 * send tool — the operator sends from the UI.
	 *
	 * All three are required, not merely the strongest. Capabilities are
	 * independently adjustable, so a grant holding `draft` with `organise` revoked
	 * is a real configuration — and gating on `draft` alone would open a socket
	 * whose `move_email` tool then walks straight around that revocation. Once the
	 * socket is open every message on it is invisible to HTTP middleware, so the
	 * connection is the only place this can be decided, which means it has to be
	 * decided conservatively.
	 *
	 * Checked here rather than inside the agent because the instance runs in its own
	 * Durable Object with no view of the principal.
	 *
	 * The consequence worth stating: a grant missing any one of the three cannot
	 * open the agent panel at all. The alternative — a session whose available tools
	 * depend on the grant — means a model that cannot explain why it will not do what
	 * was asked. A narrower per-tool gate is only worth building if someone actually
	 * wants read-only agent access.
	 */
	if (target) {
		const missing = AGENT_SOCKET_CAPABILITIES.filter(
			(capability) => !canDo(c.var.principal, target, capability),
		);
		if (missing.length > 0) {
			return c.text(
				`You do not have permission to use the agent in this mailbox (${missing.join(", ")})`,
				403,
			);
		}
	}

	const response = await routeAgentRequest(c.req.raw, c.env);
	if (response) return response;
	return c.text("Agent not found", 404);
});

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", (c) => {
	return requestHandler(c.req.raw, {
		cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
	});
});

// Export the Hono app as the default export with email and cron handlers
export default {
	fetch: app.fetch,
	/**
	 * Cron tick. Dispatches sequence steps that have come due.
	 *
	 * Snoozes and scheduled sends are deliberately not handled here: those are
	 * armed as Durable Object alarms inside the mailbox that owns them, which
	 * fire at the exact time rather than on a five-minute boundary. Sequences
	 * live in R2 with no DO to hold an alarm, so they need a tick.
	 *
	 * Failures are logged rather than rethrown. A cron invocation has nowhere to
	 * surface an exception to, and one bad enrollment must not stop the batch —
	 * `dispatchDueSequenceEmails` already isolates per-message failures, so
	 * reaching this catch means something broader went wrong.
	 */
	async scheduled(
		_event: { cron: string; scheduledTime: number },
		env: Env,
		ctx: ExecutionContext,
	) {
		ctx.waitUntil(
			dispatchDueSequenceEmails(env)
				.then((result) => {
					// Only log when there was work, so an idle deployment doesn't
					// produce a line every five minutes.
					if (result.sent || result.skipped || result.suppressed || result.failed) {
						console.log(
							`sequence dispatch: sent=${result.sent} skipped=${result.skipped} suppressed=${result.suppressed} failed=${result.failed}`,
						);
					}
				})
				.catch((e) =>
					console.error("Sequence dispatch failed:", (e as Error).message),
				),
		);

		/**
		 * Reconcile Cloudflare Email Service's delivery verdicts into the ledger.
		 *
		 * Runs on the same five-minute tick as sequence dispatch. This is the piece
		 * that closes the gap the whole feature exists for: our own records stop at
		 * the `202` handoff, and only this dataset knows whether the recipient's
		 * server accepted the message and — when it did not — whether the cause was
		 * ours or theirs.
		 *
		 * Inert without configuration: no token or zone means the app still sends
		 * and records send-time outcomes, it just does not learn what happened
		 * downstream. Wrapped in `waitUntil` and its own `.catch` for the same
		 * reason as sequence dispatch — a cron invocation has nowhere to surface an
		 * exception, and the reconciler already isolates per-mailbox failures.
		 *
		 * The lookback is wider than the tick (7 days) so a verdict reported between
		 * ticks, or during an outage of up to a week, is never missed; the ledger's
		 * dedupe makes the overlap free.
		 *
		 * EVERY configured zone is queried, not just one. Email Service analytics
		 * are zone-scoped, so on a multi-domain deployment a single zone tag would
		 * leave mail sent from every other domain permanently unreconciled. Zone ids
		 * come from the `ZONES` config where present; `EMAIL_ANALYTICS_ZONE_TAG`
		 * remains supported as the explicit single-zone setting and as the fallback
		 * for a `DOMAINS`-only deployment, which carries no zone ids.
		 */
		/**
		 * Privacy housekeeping. Retention runs a daily pass in bounded slices
		 * (see ./lib/retention.ts); exports advance a slice per tick; account
		 * deletions past their 7-day grace period are purged. Each logs its own
		 * counts and never throws.
		 */
		ctx.waitUntil(
			runRetentionTick(env).catch((e) => console.error("Retention tick failed:", (e as Error).message)),
		);
		{
			const store = getAuthStore(env) as unknown as AuthStoreApi & PrivacyStoreApi;
			ctx.waitUntil(
				runExportTick(env, store).catch((e) => console.error("Export tick failed:", (e as Error).message)),
			);
			ctx.waitUntil(
				runAccountDeletionTick(env, store, {
					forgetRouting: (mailboxId) => forgetMailboxRouting(env, mailboxId),
				}).catch((e) => console.error("Account deletion tick failed:", (e as Error).message)),
			);
		}

		// Licence refresh, when due (daily, or past `refresh_after`). The AuthDO
		// claim keeps ticks and isolates from calling the server together. A
		// no-op with enforcement off. See ./lib/licence.ts.
		ctx.waitUntil(maybeRefreshLicence(env).catch((e) => console.error("Licence refresh failed:", (e as Error).message)));

		// Webhook retries run on the webhook object's own alarm; this only
		// catches one that was lost. See WebhookDO.kick.
		const hooks = webhookStub(env);
		if (hooks) {
			ctx.waitUntil(
				hooks.kick().catch((e) => console.error("Webhook kick failed:", (e as Error).message)),
			);
		}

		/**
		 * Spam-rate circuit breaker, at most hourly (the AuthDO claims the run):
		 * warns above 0.1%, pauses bulk sends above 0.3%. The same hourly slot
		 * mirrors Cloudflare's validated `complaint` suppressions (the
		 * recipient-level form of `emailComplaintsAdaptiveGroups`) into the local
		 * list. See ./lib/sending-health.ts.
		 */
		ctx.waitUntil(
			maybeEvaluateSendingHealth(env)
				.then(async (result) => {
					if (!result) return;
					await mirrorProviderComplaints(env).catch((e) =>
						console.error("Complaint mirror failed:", (e as Error).message),
					);
					if (result.notified || result.paused.length) {
						console.log(
							`sending health: evaluated=${result.evaluated} notified=${result.notified} paused=${result.paused.join(",") || "-"}`,
						);
					}
				})
				.catch((e) => console.error("Sending health evaluation failed:", (e as Error).message)),
		);

		// Usage budget, at most hourly (claimed in the AuthDO): fires
		// `usage.budget_exceeded` once per month per kind. See ./lib/usage.ts.
		ctx.waitUntil(
			maybeCheckUsageBudget(env).catch((e) => console.error("Usage budget check failed:", (e as Error).message)),
		);

		// Agent inboxes past their TTL: revoke, archive to R2, delete. Within five
		// minutes of expiry; the token itself expires on the dot. See
		// ./lib/agent-inboxes.ts.
		ctx.waitUntil(
			expireAgentInboxes(env)
				.then((r) => {
					if (r.expired || r.failed) console.log(`agent inbox expiry: expired=${r.expired} failed=${r.failed}`);
				})
				.catch((e) => console.error("Agent inbox expiry failed:", (e as Error).message)),
		);

		if (env.EMAIL_ANALYTICS_TOKEN) {
			// Include domains added through /api/v1/domains (zone ids stored there).
			await loadStoredDomains(env).catch(() => {});
			const configuredZoneIds = getZones(env)
				.map((zone) => zone.zoneId)
				.filter((id): id is string => typeof id === "string" && id !== "");
			// Union, not either/or: a DOMAINS-only deployment relies on the explicit
			// tag for its env domain, and adding a domain through the API (which
			// stores a zone id) must not silently stop reconciling that one.
			const zoneTags = [
				...new Set([
					...configuredZoneIds,
					...(env.EMAIL_ANALYTICS_ZONE_TAG ? [env.EMAIL_ANALYTICS_ZONE_TAG] : []),
				]),
			];

			// Sends from an alias are filed in the owning mailbox.
			// Aliases that have since become real mailboxes are excluded.
			const aliases = await liveAliasMap(env).catch(() => ({}) as Record<string, string>);

			for (const zoneTag of zoneTags) {
				ctx.waitUntil(
					reconcileDeliveryEvents(
						{ apiToken: env.EMAIL_ANALYTICS_TOKEN, zoneTag },
						(mailboxId) => env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId)),
						{
							lookbackMinutes: DEFAULT_LOOKBACK_MINUTES,
							aliases,
							// Provider-reported "no such user" bounces feed the
							// suppression list and stop sequences.
							onHardBounce: (address, mailboxId) =>
								handleHardBounce(env, { address, source: `provider:${mailboxId}` }),
							// Provider spam complaints become a permanent `complaint`
							// suppression for the sending domain.
							onComplaint: (address, mailboxId) =>
								handleComplaint(env, { address, fromAddress: mailboxId, source: `provider-complaint:${mailboxId}` }),
						},
					)
						.then((result) => {
							if (result.applied || result.failed) {
								console.log(
									`delivery reconcile [${zoneTag}]: fetched=${result.fetched} mailboxes=${result.mailboxes} applied=${result.applied} failed=${result.failed}`,
								);
							}
						})
						.catch((e) =>
							console.error(
								`Delivery reconcile failed for zone ${zoneTag}:`,
								(e as Error).message,
							),
						),
				);
			}
		}
	},
	async email(
		// `to`/`from` are the SMTP envelope addresses. The envelope recipient is
		// the only address guaranteed to be present, so `receiveEmail` routes on it
		// rather than on the `To:` header, which Bcc'd and list mail may omit.
		event: { raw: ReadableStream; rawSize: number; to?: string; from?: string },
		env: Env,
		ctx: ExecutionContext,
	) {
		try {
			await receiveEmail(event, env, ctx);
		} catch (e) {
			console.error("Failed to process incoming email:", (e as Error).message, (e as Error).stack);
			// Re-throw so Cloudflare's email routing can retry delivery or bounce the message.
			// Swallowing the error would silently drop the email.
			throw e;
		}
	},
};
