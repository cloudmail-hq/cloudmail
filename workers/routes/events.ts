// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * `/api/v1/events`: the realtime event stream.
 *
 *   GET /api/v1/events/stream   WebSocket. Send {"type":"subscribe", mailboxes, events}.
 *   GET /api/v1/events/sse      Server-Sent Events fallback (?mailbox=&event= filters).
 *
 * Both accept `?since=<id>` (SSE also `Last-Event-ID`) to replay what was
 * missed in the last 24 hours. Payloads are the webhook payloads, verbatim.
 *
 * Authentication is the ordinary `/api/*` chain: a bearer `ttk_` token or the
 * session cookie. The token scope guard requires `mail:read`. This route then
 * computes the mailboxes the caller may read and forwards to the EventsDO with
 * that list in a header it sets itself (any client copy is dropped), so the
 * object never has to trust the client about authority. See docs/realtime.md.
 */

import { Hono, type Context } from "hono";
import type { MailboxContext } from "../lib/mailbox";
import { hasTokenScope } from "../lib/authz";
import { listMailboxes } from "../lib/email-helpers";
import { EVENTS_GRANT_HEADER, buildGrant, encodeGrant, eventsStub, readableMailboxes } from "../lib/events";
import { credentialRefFor } from "../lib/events-auth";
import { WEBHOOK_EVENT_TYPES } from "../../shared/webhooks";
import { MAX_CONNECTIONS_PER_PRINCIPAL, EVENT_RETENTION_MS, MAX_REPLAY } from "../lib/events-hub";

type AppContext = Context<MailboxContext>;

export const eventsRoutes = new Hono<MailboxContext>();

eventsRoutes.use("*", async (c, next) => {
	const principal = c.var.principal;
	if (!principal.identity && !principal.developmentBypass) {
		return c.json({ error: "Authentication required" }, 401);
	}
	if (!hasTokenScope(principal, "mail:read")) {
		return c.json({ error: 'This API token does not have the "mail:read" scope.', code: "insufficient_scope", scope: "mail:read" }, 403);
	}
	if (!eventsStub(c.env)) {
		return c.json({ error: "The event stream is not configured on this deployment (missing EVENTS binding)" }, 503);
	}
	return next();
});

/** Build the request the object sees: same query, the grant header set here. */
async function forward(c: AppContext, path: "/ws" | "/sse"): Promise<Response> {
	const principal = c.var.principal;
	const all = (await listMailboxes(c.env.BUCKET)).map((m) => m.email);
	const readable = readableMailboxes(principal, all);
	const tokenExpiry = c.var.authMethod === "token" ? (c.var.authToken?.expiresAt ?? null) : null;
	// The credential reference lets the object re-check it while the stream is
	// open (see ../lib/events-auth.ts). Hashes only.
	const grant = { ...buildGrant(principal, readable, Date.now(), tokenExpiry), credential: await credentialRefFor(c) };

	const incoming = new URL(c.req.url);
	const target = new URL(`https://events.internal${path}`);
	target.search = incoming.search;
	const headers = new Headers();
	for (const name of ["upgrade", "connection", "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions", "last-event-id"]) {
		const value = c.req.header(name);
		if (value) headers.set(name, value);
	}
	headers.set(EVENTS_GRANT_HEADER, encodeGrant(grant));
	return eventsStub(c.env)!.fetch(new Request(target.toString(), { method: "GET", headers }));
}

eventsRoutes.get("/stream", async (c) => {
	if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
		return c.json(
			{
				error: "This endpoint is a WebSocket. Connect with an Upgrade: websocket request, or use /api/v1/events/sse.",
				events: WEBHOOK_EVENT_TYPES,
				limits: { connections_per_user: MAX_CONNECTIONS_PER_PRINCIPAL, retention_ms: EVENT_RETENTION_MS, max_replay: MAX_REPLAY },
			},
			426,
		);
	}
	return forward(c, "/ws");
});

eventsRoutes.get("/sse", (c) => forward(c, "/sse"));
