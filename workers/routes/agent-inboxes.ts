// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * `/api/v1/agent-inboxes`: mint a mailbox for one automated agent.
 *
 *   POST   /api/v1/agent-inboxes            create (Idempotency-Key honoured)
 *   GET    /api/v1/agent-inboxes            list
 *   GET    /api/v1/agent-inboxes/:address   one
 *   PATCH  /api/v1/agent-inboxes/:address   change or clear its recipient restriction
 *   DELETE /api/v1/agent-inboxes/:address   end it now (same cleanup as expiry)
 *
 * Administrators only, and a scoped token needs `mailboxes:manage` (the token
 * scope guard and `canManageAgentInboxes` both say so). The token minted for
 * the inbox is a child of the caller's token when the caller is a token, so
 * revoking the caller revokes the agent too, and it never holds a scope the
 * caller lacks. See ../lib/agent-inbox-create.ts and ../lib/agent-inboxes.ts.
 *
 * The send policy is enforced by the pre-send gate (../lib/agent-send-rule.ts).
 */

import { Hono } from "hono";
import { z } from "zod";
import type { MailboxContext } from "../lib/mailbox";
import { canManageAgentInboxes } from "../lib/authz";
import { endAgentInbox, getAgentInbox, listAgentInboxes, putAgentInbox, viewsOf } from "../lib/agent-inboxes";
import { auditActorRole, recordAudit } from "../lib/audit";
import { CreateAgentInboxSchema, createAgentInbox } from "../lib/agent-inbox-create";
import { AGENT_INBOX_MAX_ALLOWED_RECIPIENTS, agentInboxView, normalizeRecipientPattern } from "../../shared/agent-inboxes";

/**
 * `allowed_recipients`: an array narrows who the inbox may send to; `null`
 * removes the restriction (the default: anyone). Only this field for now:
 * the send mode is tied to the token's scopes, which are fixed at creation.
 */
const UpdateAgentInboxSchema = z
	.object({ allowed_recipients: z.array(z.string()).max(AGENT_INBOX_MAX_ALLOWED_RECIPIENTS).nullable() })
	.strict();

export const agentInboxRoutes = new Hono<MailboxContext>();

function zodMessage(err: z.ZodError): string {
	const issue = err.issues[0];
	if (!issue) return "Invalid request";
	const field = issue.path.join(".");
	return field ? `${field}: ${issue.message}` : issue.message;
}

agentInboxRoutes.use("*", async (c, next) => {
	if (!canManageAgentInboxes(c.var.principal)) {
		return c.json(
			{ error: "Only an administrator can manage agent inboxes (a token needs mailboxes:manage).", scope: "mailboxes:manage" },
			403,
		);
	}
	return next();
});

agentInboxRoutes.post("/", async (c) => {
	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		raw = null;
	}
	const parsed = CreateAgentInboxSchema.safeParse(raw);
	if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
	const outcome = await createAgentInbox(c.env, c.var.principal, parsed.data, {
		ownerUserId: c.var.authUser?.id ?? null,
		parentExpiresAt: c.var.authMethod === "token" ? (c.var.authToken?.expiresAt ?? null) : null,
	});
	return c.json(outcome.body, outcome.status);
});

agentInboxRoutes.get("/", async (c) => {
	const records = await listAgentInboxes(c.env.BUCKET);
	return c.json({ agent_inboxes: viewsOf(records) });
});

agentInboxRoutes.get("/:address", async (c) => {
	const record = await getAgentInbox(c.env.BUCKET, decodeURIComponent(c.req.param("address")).toLowerCase());
	if (!record) return c.json({ error: "Agent inbox not found" }, 404);
	return c.json({ agent_inbox: agentInboxView(record, Date.now()) });
});

agentInboxRoutes.patch("/:address", async (c) => {
	const address = decodeURIComponent(c.req.param("address")).toLowerCase();
	const record = await getAgentInbox(c.env.BUCKET, address);
	if (!record) return c.json({ error: "Agent inbox not found" }, 404);
	const parsed = UpdateAgentInboxSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
	let allowed: string[] | null = null;
	if (parsed.data.allowed_recipients !== null) {
		allowed = [];
		for (const entry of parsed.data.allowed_recipients) {
			const pattern = normalizeRecipientPattern(entry);
			if (!pattern) return c.json({ error: `allowed_recipients: "${entry}" is not an address or @domain` }, 400);
			if (!allowed.includes(pattern)) allowed.push(pattern);
		}
		// An empty list would refuse every send; that is what draft_only is for.
		if (allowed.length === 0) allowed = null;
	}
	const updated = { ...record, allowed_recipients: allowed };
	await putAgentInbox(c.env.BUCKET, updated);
	await recordAudit(c.env.BUCKET, {
		action: "agent_inbox.update",
		actor: c.var.principal.identity?.id ?? null,
		actorRole: auditActorRole(c.var.principal, address),
		mailboxId: address,
		target: address,
		detail: { allowed_recipients: allowed === null ? "anyone" : allowed.join(",").slice(0, 500) },
	});
	return c.json({ agent_inbox: agentInboxView(updated, Date.now()) });
});

agentInboxRoutes.delete("/:address", async (c) => {
	const record = await getAgentInbox(c.env.BUCKET, decodeURIComponent(c.req.param("address")).toLowerCase());
	if (!record) return c.json({ error: "Agent inbox not found" }, 404);
	const result = await endAgentInbox(c.env, record, "deleted", {
		id: c.var.principal.identity?.id ?? null,
		role: "admin",
	});
	return c.json({ ended: result });
});
