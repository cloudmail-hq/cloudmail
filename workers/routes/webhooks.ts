// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * `/api/v1/webhooks`: manage outbound webhook endpoints and their deliveries.
 *
 * Mounted under `/api/v1/webhooks` from `workers/index.ts`, after the shared
 * `/api/*` middleware, so `c.var.principal` is already resolved and the request
 * is rate limited. Who may touch what is decided in `../lib/webhooks.ts`.
 *
 * The secret is returned exactly twice in its life: in the response that
 * creates the endpoint and in the one that rotates it. Every other read shows
 * only its last four characters.
 */

import { Hono, type Context } from "hono";
import { ZodError } from "zod";
import type { MailboxContext } from "../lib/mailbox";
import {
	CreateWebhookSchema,
	UpdateWebhookSchema,
	canManageEndpoint,
	canManageWebhooks,
	normalizeWebhookUrl,
	visibleEndpoints,
	webhookStub,
} from "../lib/webhooks";
import type { WebhookEndpoint } from "../lib/webhooks-store";
import {
	WEBHOOK_EVENT_LABELS,
	WEBHOOK_EVENT_TYPES,
	WEBHOOK_MAX_ATTEMPTS,
	WEBHOOK_RETRY_DELAYS_MS,
	buildWebhookPayload,
	generateWebhookSecret,
	sampleEmailSummary,
} from "../../shared/webhooks";

type AppContext = Context<MailboxContext>;

export const webhooks = new Hono<MailboxContext>();

function zodMessage(err: ZodError): string {
	const issue = err.issues[0];
	if (!issue) return "Invalid request";
	const field = issue.path.join(".");
	return field ? `${field}: ${issue.message}` : issue.message;
}

async function readJson(c: AppContext): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		return null;
	}
}

webhooks.use("*", async (c, next) => {
	if (!canManageWebhooks(c.var.principal)) {
		return c.json({ error: "You do not have permission to manage webhooks" }, 403);
	}
	if (!webhookStub(c.env)) {
		return c.json({ error: "Webhooks are not configured on this deployment (missing WEBHOOKS binding)" }, 503);
	}
	return next();
});

/** Load an endpoint the caller may manage, or answer for them. */
async function loadEndpoint(c: AppContext, id: string): Promise<WebhookEndpoint | Response> {
	const endpoint = await webhookStub(c.env)!.getEndpoint(id);
	// 404 either way: an endpoint you cannot manage is one you cannot see.
	if (!endpoint || !canManageEndpoint(c.var.principal, endpoint.mailboxes)) {
		return c.json({ error: "Webhook not found" }, 404);
	}
	return endpoint;
}

/** Event vocabulary and retry policy, so clients never hardcode them. */
webhooks.get("/events", (c) =>
	c.json({
		events: WEBHOOK_EVENT_TYPES.map((type) => ({ type, ...WEBHOOK_EVENT_LABELS[type] })),
		retry: { maxAttempts: WEBHOOK_MAX_ATTEMPTS, delaysMs: WEBHOOK_RETRY_DELAYS_MS },
	}),
);

webhooks.get("/", async (c) => {
	const all = await webhookStub(c.env)!.listEndpoints();
	return c.json({ webhooks: visibleEndpoints(c.var.principal, all) });
});

webhooks.post("/", async (c) => {
	const parsed = CreateWebhookSchema.safeParse(await readJson(c));
	if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
	const input = parsed.data;
	if (!canManageEndpoint(c.var.principal, input.mailboxes)) {
		return c.json(
			{
				error:
					input.mailboxes === null
						? "Only an administrator can create a webhook for every mailbox. Choose the mailboxes it covers."
						: "You need settings access to every mailbox this webhook covers",
			},
			403,
		);
	}
	const secret = generateWebhookSecret();
	const now = Date.now();
	const endpoint = await webhookStub(c.env)!.createEndpoint({
		name: input.name,
		url: normalizeWebhookUrl(input.url),
		secret,
		events: input.events,
		mailboxes: input.mailboxes,
		enabled: input.enabled,
		createdBy: c.var.principal.identity?.id ?? null,
		now,
	});
	return c.json({ webhook: endpoint, secret }, 201);
});

/** Retry one delivery. Registered before `/:id` so "deliveries" is not an id. */
webhooks.post("/deliveries/:deliveryId/retry", async (c) => {
	const stub = webhookStub(c.env)!;
	const delivery = await stub.getDelivery(c.req.param("deliveryId"));
	if (!delivery) return c.json({ error: "Delivery not found" }, 404);
	const endpoint = await loadEndpoint(c, delivery.endpointId);
	if (endpoint instanceof Response) return c.json({ error: "Delivery not found" }, 404);
	const result = await stub.retryDelivery(delivery.id);
	return c.json({ delivery: result });
});

webhooks.get("/:id", async (c) => {
	const endpoint = await loadEndpoint(c, c.req.param("id"));
	if (endpoint instanceof Response) return endpoint;
	return c.json({ webhook: endpoint });
});

async function updateHandler(c: AppContext) {
	const endpoint = await loadEndpoint(c, c.req.param("id") ?? "");
	if (endpoint instanceof Response) return endpoint;
	const parsed = UpdateWebhookSchema.safeParse(await readJson(c));
	if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
	const patch = parsed.data;
	if (patch.mailboxes !== undefined && !canManageEndpoint(c.var.principal, patch.mailboxes)) {
		return c.json({ error: "You need settings access to every mailbox this webhook covers" }, 403);
	}
	const updated = await webhookStub(c.env)!.updateEndpoint(endpoint.id, {
		...patch,
		...(patch.url ? { url: normalizeWebhookUrl(patch.url) } : {}),
		now: Date.now(),
	});
	return c.json({ webhook: updated });
}

// PUT as well as PATCH: the rest of this API uses PUT for partial updates.
webhooks.patch("/:id", updateHandler);
webhooks.put("/:id", updateHandler);

webhooks.delete("/:id", async (c) => {
	const endpoint = await loadEndpoint(c, c.req.param("id"));
	if (endpoint instanceof Response) return endpoint;
	await webhookStub(c.env)!.deleteEndpoint(endpoint.id);
	return c.json({ status: "deleted", id: endpoint.id });
});

webhooks.post("/:id/rotate-secret", async (c) => {
	const endpoint = await loadEndpoint(c, c.req.param("id"));
	if (endpoint instanceof Response) return endpoint;
	const secret = generateWebhookSecret();
	const updated = await webhookStub(c.env)!.rotateSecret(endpoint.id, secret, Date.now());
	return c.json({ webhook: updated, secret });
});

webhooks.post("/:id/test", async (c) => {
	const endpoint = await loadEndpoint(c, c.req.param("id"));
	if (endpoint instanceof Response) return endpoint;
	const mailbox = endpoint.mailboxes?.[0] ?? "inbox@example.com";
	const eventId = `evt_test_${crypto.randomUUID().replace(/-/g, "")}`;
	const type = endpoint.events[0] ?? "message.received";
	const payload = buildWebhookPayload({
		id: eventId,
		type,
		createdAt: new Date().toISOString(),
		mailbox,
		data: sampleEmailSummary(mailbox),
		test: true,
	});
	const delivery = await webhookStub(c.env)!.sendTest(endpoint.id, {
		eventId,
		type,
		mailbox,
		payload: JSON.stringify(payload),
		now: Date.now(),
	});
	return c.json({ delivery });
});

webhooks.get("/:id/deliveries", async (c) => {
	const endpoint = await loadEndpoint(c, c.req.param("id"));
	if (endpoint instanceof Response) return endpoint;
	const limit = Number(c.req.query("limit") ?? 50);
	const deliveries = await webhookStub(c.env)!.listDeliveries(
		endpoint.id,
		Number.isFinite(limit) ? limit : 50,
	);
	return c.json({ deliveries });
});
