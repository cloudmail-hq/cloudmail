// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Follow-up reminders API.
 *
 *   GET    /api/v1/mailboxes/:mailboxId/followups                  awaiting-reply list
 *   GET    /api/v1/mailboxes/:mailboxId/emails/:id/followup        the reminder on a message
 *   POST   /api/v1/mailboxes/:mailboxId/emails/:id/followup        set or replace it
 *   POST   /api/v1/mailboxes/:mailboxId/emails/:id/followup/cancel cancel (or dismiss a fired one)
 *   DELETE /api/v1/mailboxes/:mailboxId/emails/:id/followup        same as cancel, REST-style
 *
 * Mounted at the root of the API app, behind `requireMailbox`. Reading needs
 * `read`; setting and cancelling are organising, the same tier as snooze. Both
 * gates are the path-scoped ones in workers/index.ts, which run before the
 * idempotency middleware so a refused caller never reserves a key.
 * See ../durableObject/followups.ts for the model.
 */

import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { MAX_FOLLOWUP_SECONDS } from "../../shared/followups";
import {
	applySendFollowup,
	parseFollowupField,
	resolveExplicitFollowup,
	type FollowupStub,
} from "../lib/followups";
import type { MailboxContext } from "../lib/mailbox";

type AppContext = Context<MailboxContext>;

export const followupRoutes = new Hono<MailboxContext>();

const MB = "/api/v1/mailboxes/:mailboxId";

const SetFollowupBody = z
	.object({
		at: z.string().optional(),
		delay_seconds: z.number().int().positive().max(MAX_FOLLOWUP_SECONDS).optional(),
	})
	.strict();

const ListQuery = z.object({
	status: z.enum(["pending", "fired", "active"]).optional(),
	limit: z.coerce.number().int().min(1).max(500).optional(),
});

followupRoutes.get(`${MB}/followups`, async (c: AppContext) => {
	const query = ListQuery.parse({
		status: c.req.query("status") || undefined,
		limit: c.req.query("limit") || undefined,
	});
	const followups = await c.var.mailboxStub.listFollowups(query);
	return c.json({ followups });
});

followupRoutes.get(`${MB}/emails/:id/followup`, async (c: AppContext) => {
	const followup = await c.var.mailboxStub.getFollowup(c.req.param("id")!);
	if (!followup) return c.json({ error: "No reminder on this message" }, 404);
	return c.json(followup);
});

followupRoutes.post(`${MB}/emails/:id/followup`, async (c: AppContext) => {
	const body = SetFollowupBody.parse(await c.req.json());
	const resolved = resolveExplicitFollowup({ at: body.at, delaySeconds: body.delay_seconds });
	if (!resolved.ok) return c.json({ error: resolved.error }, 400);
	const followup = await c.var.mailboxStub.setFollowup({
		emailId: c.req.param("id")!,
		followupAt: resolved.at,
		mode: "manual",
		durationSeconds: resolved.durationSeconds,
	});
	if (!followup) {
		return c.json({ error: "Message not found, or it is a draft or in Trash or Spam" }, 404);
	}
	return c.json(followup);
});

async function cancel(c: AppContext) {
	const followup = await c.var.mailboxStub.cancelFollowup(c.req.param("id")!);
	if (!followup) return c.json({ error: "No active reminder on this message or its thread" }, 404);
	return c.json(followup);
}

followupRoutes.post(`${MB}/emails/:id/followup/cancel`, cancel);
followupRoutes.delete(`${MB}/emails/:id/followup`, cancel);

// ── Send hook ──────────────────────────────────────────────────────

/** The send routes a `followup` field (or the mailbox default) applies to. */
export const FOLLOWUP_SEND_PATHS = [
	"/api/v1/mailboxes/:mailboxId/emails",
	"/api/v1/mailboxes/:mailboxId/emails/:id/reply",
	"/api/v1/mailboxes/:mailboxId/emails/:id/forward",
	"/api/v1/mailboxes/:mailboxId/scheduled-sends",
];

/**
 * The one hook on the send path.
 *
 * Wraps the send routes rather than editing each: after a successful send it
 * reads the optional `followup` field from the (cached) request body and sets
 * the reminder in the background, so neither the classifier nor the reminder
 * can slow down or fail a send. A queued send's reminder counts from its
 * `send_at`. Mounted after the idempotency middleware, so a replayed response
 * never reaches it and cannot re-arm a reminder the user cancelled.
 */
export const followupSendHook = createMiddleware<MailboxContext>(async (c, next) => {
	await next();
	try {
		if (c.res.status < 200 || c.res.status >= 300) return;
		const result = (await c.res.clone().json()) as { id?: unknown; send_at?: unknown };
		if (typeof result?.id !== "string") return;
		const raw = (await c.req.json().catch(() => undefined)) as
			| { html?: string; text?: string }
			| undefined;
		const request = parseFollowupField(raw);
		const mailboxId = decodeURIComponent(c.req.param("mailboxId") ?? "");
		const sentAtMs = typeof result.send_at === "string" ? Date.parse(result.send_at) : Date.now();
		c.executionCtx.waitUntil(
			applySendFollowup(c.env, c.var.mailboxStub as unknown as FollowupStub, {
				mailboxId,
				emailId: result.id,
				request,
				body: raw?.html ?? raw?.text,
				sentAtMs: Number.isFinite(sentAtMs) ? sentAtMs : Date.now(),
			}),
		);
	} catch (e) {
		console.error("follow-up send hook failed:", (e as Error).message);
	}
});
