// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Usage and cost (the Analytics → Usage tab).
 *
 *   GET /api/v1/usage           month to date and projected: email, AI, R2, DO, caps, budget (admin)
 *   PUT /api/v1/usage/budget    set or clear the AI / email budget thresholds (admin, audited)
 *
 * Admin-only: these are account-wide bills. Shapes: `shared/usage.ts`.
 */

import { Hono } from "hono";
import { UsageBudgetPatchSchema } from "../../shared/usage";
import { auditActorRole, recordAuditDeferred } from "../lib/audit";
import { listMailboxes } from "../lib/email-helpers";
import { requireAdminScope, type MailboxContext } from "../lib/mailbox";
import { buildUsage, usageStore } from "../lib/usage";
import { domainOfAddress, isDomainAllowed } from "../lib/zones";

export const usageRoutes = new Hono<MailboxContext>();

const requireUsageAdmin = requireAdminScope("admin");

usageRoutes.get("/api/v1/usage", requireUsageAdmin, async (c) => {
	const mailboxes = (await listMailboxes(c.env.BUCKET))
		.map((m) => m.email.toLowerCase())
		.filter((m) => isDomainAllowed(c.env, domainOfAddress(m)))
		.sort();
	const refresh = c.req.query("refresh") === "1";
	return c.json(await buildUsage(c.env, mailboxes, { refresh }));
});

usageRoutes.put("/api/v1/usage/budget", requireUsageAdmin, async (c) => {
	const parsed = UsageBudgetPatchSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid budget" }, 400);
	const store = usageStore(c.env);
	if (!store) return c.json({ error: "Usage storage is not available" }, 503);
	const actor = c.var.principal.identity?.id ?? null;
	const before = await store.getUsageBudget();
	const budget = await store.setUsageBudget(parsed.data, actor, Date.now());
	await recordAuditDeferred(c, {
		action: "usage.budget",
		actor,
		actorRole: auditActorRole(c.var.principal, null),
		detail: { ai_usd: budget.ai_usd, email_usd: budget.email_usd, previous_ai_usd: before.ai_usd, previous_email_usd: before.email_usd },
	});
	return c.json({ budget });
});
