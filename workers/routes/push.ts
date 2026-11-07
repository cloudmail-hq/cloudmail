// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Web Push over HTTP.
 *
 * Authenticated, for the signed-in user's own devices and preferences:
 *
 *   GET    /api/v1/push/vapid-key       the application server key to subscribe with
 *   GET    /api/v1/push/subscriptions   my devices
 *   POST   /api/v1/push/subscriptions   register this browser's subscription
 *   DELETE /api/v1/push/subscriptions   revoke a device ({ id } or { endpoint })
 *   GET    /api/v1/push/preferences     my notification preferences
 *   PUT    /api/v1/push/preferences     patch them
 *   POST   /api/v1/push/test            send a test notification to my devices
 *
 * Public, for the service worker, which in some browsers runs with no
 * session cookie (`publicPushRoutes`, mounted before authentication):
 *
 *   POST /push/action          perform a notification button's one action (signed, single-use token)
 *   POST /push/resubscribe     `pushsubscriptionchange`: swap a device's endpoint, proven by its old auth secret
 *
 * A push is per person, so the routes need a signed-in identity; an API token
 * or service identity gets 409 like the assistant routes.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { PushPrefsPatchSchema, deviceLabel, isAllowedPushEndpoint } from "../../shared/push-policy";
import { getVapidKeys, performAction, pushRpc, sendTestPush } from "../lib/push";
import type { MailboxContext } from "../lib/mailbox";
import type { Env } from "../types";
import { backgroundLocked } from "../lib/licence";
import { licenceRequiredBody } from "../lib/licence-gate";

type AppContext = Context<MailboxContext>;

export const pushRoutes = new Hono<MailboxContext>();

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

const SubscriptionBody = z
	.object({
		endpoint: z.string().url().max(2048),
		keys: z
			.object({
				p256dh: z.string().regex(B64URL).min(80).max(100),
				auth: z.string().regex(B64URL).min(16).max(32),
			})
			.strip(),
		expirationTime: z.number().nullable().optional(),
	})
	.strip();

const DeleteBody = z.union([
	z.object({ id: z.string().min(1).max(64) }).strict(),
	z.object({ endpoint: z.string().max(2048) }).strict(),
]);

const NO_IDENTITY = {
	error: "Notifications need a signed-in person (not an API token or service identity).",
	code: "no_identity",
};

/** The user key push rows are stored under: the person's authz id. */
function userKeyOf(c: AppContext): string | null {
	const identity = c.var.principal?.identity;
	if (!identity || identity.kind !== "user") return null;
	// A scoped API token acts for a person, but devices are a browser thing.
	if (c.var.principal?.token) return null;
	return identity.id.toLowerCase();
}

function view(sub: { id: string; userAgent: string | null; createdAt: number; lastSuccessAt: number | null; failures: number; endpoint: string }) {
	let host = "";
	try {
		host = new URL(sub.endpoint).hostname;
	} catch {
		host = "";
	}
	return {
		id: sub.id,
		label: deviceLabel(sub.userAgent),
		user_agent: sub.userAgent,
		push_service: host,
		created_at: new Date(sub.createdAt).toISOString(),
		last_success_at: sub.lastSuccessAt ? new Date(sub.lastSuccessAt).toISOString() : null,
		failures: sub.failures,
	};
}

pushRoutes.get("/api/v1/push/vapid-key", async (c: AppContext) => {
	const keys = await getVapidKeys(c.env);
	if (!keys) return c.json({ error: "Notifications are not available on this deployment", code: "unavailable" }, 503);
	return c.json({ public_key: keys.publicKey });
});

pushRoutes.get("/api/v1/push/subscriptions", async (c: AppContext) => {
	const userKey = userKeyOf(c);
	const rpc = pushRpc(c.env);
	if (!userKey || !rpc) return c.json(NO_IDENTITY, 409);
	return c.json({ subscriptions: (await rpc.pushListSubscriptions(userKey)).map(view) });
});

pushRoutes.post("/api/v1/push/subscriptions", async (c: AppContext) => {
	const userKey = userKeyOf(c);
	const rpc = pushRpc(c.env);
	if (!userKey || !rpc) return c.json(NO_IDENTITY, 409);
	const body = SubscriptionBody.parse(await c.req.json());
	// The Worker POSTs to this URL, so only real push services are accepted.
	if (!isAllowedPushEndpoint(body.endpoint)) {
		return c.json({ error: "That endpoint is not a known push service", code: "endpoint_not_allowed" }, 400);
	}
	const sub = await rpc.pushUpsertSubscription({
		userKey,
		endpoint: body.endpoint,
		p256dh: body.keys.p256dh,
		auth: body.keys.auth,
		userAgent: c.req.header("user-agent")?.slice(0, 300) ?? null,
		now: Date.now(),
	});
	return c.json(view(sub), 201);
});

pushRoutes.delete("/api/v1/push/subscriptions", async (c: AppContext) => {
	const userKey = userKeyOf(c);
	const rpc = pushRpc(c.env);
	if (!userKey || !rpc) return c.json(NO_IDENTITY, 409);
	const ref = DeleteBody.parse(await c.req.json());
	const ok = await rpc.pushDeleteSubscription(userKey, ref);
	return ok ? c.json({ status: "deleted" }) : c.json({ error: "Device not found" }, 404);
});

pushRoutes.get("/api/v1/push/preferences", async (c: AppContext) => {
	const userKey = userKeyOf(c);
	const rpc = pushRpc(c.env);
	if (!userKey || !rpc) return c.json(NO_IDENTITY, 409);
	return c.json(await rpc.pushGetPrefs(userKey));
});

pushRoutes.put("/api/v1/push/preferences", async (c: AppContext) => {
	const userKey = userKeyOf(c);
	const rpc = pushRpc(c.env);
	if (!userKey || !rpc) return c.json(NO_IDENTITY, 409);
	const patch = PushPrefsPatchSchema.parse(await c.req.json());
	return c.json(await rpc.pushUpdatePrefs(userKey, patch, Date.now()));
});

pushRoutes.post("/api/v1/push/test", async (c: AppContext) => {
	const userKey = userKeyOf(c);
	if (!userKey) return c.json(NO_IDENTITY, 409);
	const result = await sendTestPush(c.env, userKey);
	if (result.devices === 0) return c.json({ error: "No devices are registered for notifications", code: "no_devices" }, 404);
	if (result.limited) return c.json({ error: "Too many notifications just now. Try again in a few minutes.", code: "rate_limited" }, 429);
	return c.json(result);
});

// ── Public: the service worker's side ───────────────────────────────

const ActionBody = z.object({ token: z.string().min(20).max(2000) }).strict();

const ResubscribeBody = z
	.object({
		old_endpoint: z.string().max(2048),
		old_auth: z.string().regex(B64URL).min(16).max(32),
		subscription: SubscriptionBody,
	})
	.strict();

export const publicPushRoutes = new Hono<{ Bindings: Env }>();

/**
 * A notification button. The token is the whole credential (see
 * `performAction`): one message, one action, one user, single use, 12 hours.
 * JSON only, so a plain cross-site form cannot submit it.
 */
publicPushRoutes.post("/push/action", async (c) => {
	if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
		return c.json({ error: "Expected JSON" }, 415);
	}
	const parsed = ActionBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
	// Archive and mark-read act on the customer's mailbox, so they lock with
	// the app. (Resubscribe below only keeps a device registered.)
	if (await backgroundLocked(c.env as Env)) return c.json(licenceRequiredBody(), 402);
	const outcome = await performAction(c.env as Env, parsed.data.token);
	if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
	return c.json({ status: "done", action: outcome.action });
});

/**
 * `pushsubscriptionchange`: the browser rotated this device's subscription.
 * The old endpoint plus its auth secret, which only that browser and this
 * server hold, prove it is the same device; the owner carries over.
 */
publicPushRoutes.post("/push/resubscribe", async (c) => {
	if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
		return c.json({ error: "Expected JSON" }, 415);
	}
	const parsed = ResubscribeBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
	const { old_endpoint, old_auth, subscription } = parsed.data;
	if (!isAllowedPushEndpoint(subscription.endpoint)) return c.json({ error: "Not a known push service" }, 400);
	const rpc = pushRpc(c.env as Env);
	if (!rpc) return c.json({ error: "Unavailable" }, 503);
	const sub = await rpc.pushReplaceSubscription({
		oldEndpoint: old_endpoint,
		oldAuth: old_auth,
		endpoint: subscription.endpoint,
		p256dh: subscription.keys.p256dh,
		auth: subscription.keys.auth,
		userAgent: c.req.header("user-agent")?.slice(0, 300) ?? null,
		now: Date.now(),
	});
	return sub ? c.json({ status: "replaced" }) : c.json({ error: "Unknown subscription" }, 404);
});
