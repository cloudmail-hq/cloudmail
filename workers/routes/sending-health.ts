// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Sending compliance API: the spam-rate circuit breaker and per-mailbox caps.
 *
 *   GET  /api/v1/sending-health                    per-domain spam rate, level, pause state
 *   POST /api/v1/sending-health/evaluate           re-evaluate now (admin)
 *   POST /api/v1/sending-health/:domain/resume     resume paused bulk sends (admin, audited)
 *   POST /api/v1/sending-health/:domain/pause      pause bulk sends by hand (admin, audited)
 *   GET  /api/v1/mailboxes/:mailboxId/send-limits  caps, usage, and the account quota (admins)
 *   PUT  /api/v1/mailboxes/:mailboxId/send-limits  change the caps (admin, audited)
 *
 * Reading health is open to any signed-in caller for the domains of mailboxes
 * they can see: the warning banner is for everyone who sends. Changing anything
 * is admin-only, same tier as domains and suppressions.
 */

import { Hono } from "hono";
import { z } from "zod";
import { SendCapsPatchSchema, mergeSendCaps, type SendCaps, type SendUsage } from "../../shared/send-caps";
import { sendingDomainOf } from "../../shared/suppressions";
import { auditActorRole, recordAuditDeferred } from "../lib/audit";
import { isAdmin, isAdminFor, visibleMailboxes } from "../lib/authz";
import {
	analyticsAccountId,
	analyticsCacheKey,
	analyticsClient,
	analyticsZoneTags,
	cachedJson,
	defaultCache,
	type CfLimits,
} from "../lib/cf-analytics";
import { listMailboxes } from "../lib/email-helpers";
import { requireAdminScope, type MailboxContext } from "../lib/mailbox";
import { evaluateSendingHealth, sendingHealthStore } from "../lib/sending-health";
import { loadStoredDomains } from "./domains";
import type { Env } from "../types";

export const sendingHealthRoutes = new Hono<MailboxContext>();

const requireSendingAdmin = requireAdminScope("admin");

const DomainParam = z
	.string()
	.trim()
	.toLowerCase()
	.regex(/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/, "Not a domain");

async function visibleDomains(c: { env: Env; var: MailboxContext["Variables"] }): Promise<{ all: string[]; mailboxes: string[] }> {
	const mailboxes = (await listMailboxes(c.env.BUCKET)).map((m) => m.email);
	const visible = visibleMailboxes(c.var.principal, mailboxes, (m) => m);
	return { all: [...new Set(visible.map(sendingDomainOf).filter(Boolean))], mailboxes: visible };
}

sendingHealthRoutes.get("/api/v1/sending-health", async (c) => {
	const store = sendingHealthStore(c.env);
	if (!store) return c.json({ domains: [], thresholds: THRESHOLDS });
	const { all } = await visibleDomains(c);
	const allowed = new Set(all);
	const rows = (await store.listSendingHealth()).filter((r) => isAdmin(c.var.principal) || allowed.has(r.domain));
	return c.json({ domains: rows, thresholds: THRESHOLDS });
});

const THRESHOLDS = {
	warning: 0.001,
	pause: 0.003,
	window_days: 7,
	minimum_delivered: 100,
};

sendingHealthRoutes.post("/api/v1/sending-health/evaluate", requireSendingAdmin, async (c) => {
	const result = await evaluateSendingHealth(c.env);
	return c.json(result);
});

sendingHealthRoutes.post("/api/v1/sending-health/:domain/resume", requireSendingAdmin, async (c) => {
	const domain = DomainParam.parse(c.req.param("domain"));
	const store = sendingHealthStore(c.env);
	if (!store) return c.json({ error: "Sending health is not available" }, 503);
	const actor = c.var.principal.identity?.id ?? null;
	const before = (await store.listSendingHealth()).find((r) => r.domain === domain) ?? null;
	const resumed = await store.resumeBulkSending(domain, actor, Date.now());
	if (!resumed) return c.json({ error: "No sending health record for that domain" }, 404);
	await recordAuditDeferred(c, {
		action: "sending.resume",
		actor,
		actorRole: auditActorRole(c.var.principal, null),
		detail: {
			domain,
			was_paused: before?.bulk_paused ?? false,
			spam_rate: before?.spam_rate ?? null,
			paused_reason: before?.paused_reason ?? null,
		},
	});
	return c.json({ domain: resumed });
});

const PauseBody = z.object({ reason: z.string().trim().min(1).max(300).optional() }).strict();

sendingHealthRoutes.post("/api/v1/sending-health/:domain/pause", requireSendingAdmin, async (c) => {
	const domain = DomainParam.parse(c.req.param("domain"));
	const body = PauseBody.parse(await c.req.json().catch(() => ({})));
	const store = sendingHealthStore(c.env);
	if (!store) return c.json({ error: "Sending health is not available" }, 503);
	const actor = c.var.principal.identity?.id ?? null;
	const reason = body.reason ?? "Paused by an administrator";
	const paused = await store.pauseBulkSending(domain, reason, Date.now());
	await recordAuditDeferred(c, {
		action: "sending.pause",
		actor,
		actorRole: auditActorRole(c.var.principal, null),
		detail: { domain, reason },
	});
	return c.json({ domain: paused });
});

// ── Per-mailbox send caps ──────────────────────────────────────────

interface SendLimitsStub {
	getSendUsage(): Promise<SendUsage>;
	setSendCaps(caps: SendCaps, updatedBy: string | null): Promise<SendCaps>;
}

function limitsStub(env: Env, mailboxId: string): SendLimitsStub {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId)) as unknown as SendLimitsStub;
}

/** The account's daily quota, from the same cached REST read the analytics page uses. */
async function accountQuota(env: Env): Promise<{ limit: number; used: number; unit: string; resets_at: string | null } | null> {
	const client = await analyticsClient(env);
	if (!client?.hasRest) return null;
	try {
		await loadStoredDomains(env).catch(() => {});
		const zones = analyticsZoneTags(env);
		const accountId = (await analyticsAccountId(env)) || (zones[0] ? await client.accountIdFor(zones[0]) : null);
		if (!accountId) return null;
		const { data } = await cachedJson<CfLimits>(
			defaultCache(),
			analyticsCacheKey("limits", { account: accountId }),
			() => client.limits(accountId),
		);
		if (!data?.quota) return null;
		return {
			limit: data.quota.value,
			used: data.usage?.sent ?? 0,
			unit: data.quota.unit,
			resets_at: data.usage?.resets_at ?? null,
		};
	} catch (e) {
		console.error("send limits: account quota read failed:", (e as Error).message);
		return null;
	}
}

sendingHealthRoutes.get("/api/v1/mailboxes/:mailboxId/send-limits", async (c) => {
	const mailboxId = decodeURIComponent(c.req.param("mailboxId")).toLowerCase();
	const usage = await limitsStub(c.env, mailboxId).getSendUsage();
	const admin = isAdminFor(c.var.principal, "admin");
	return c.json({
		...usage,
		maxima: { hourly: 1000, daily: 10000 },
		editable: admin,
		// The Cloudflare account quota is account-wide, so only administrators see it.
		account_quota: admin ? await accountQuota(c.env) : null,
	});
});

sendingHealthRoutes.put("/api/v1/mailboxes/:mailboxId/send-limits", requireSendingAdmin, async (c) => {
	const mailboxId = decodeURIComponent(c.req.param("mailboxId")).toLowerCase();
	const patch = SendCapsPatchSchema.parse(await c.req.json());
	const stub = limitsStub(c.env, mailboxId);
	const current = await stub.getSendUsage();
	const merged = mergeSendCaps(current.caps, patch);
	if ("error" in merged) return c.json({ error: merged.error }, 400);
	const actor = c.var.principal.identity?.id ?? null;
	const caps = await stub.setSendCaps(merged, actor);
	await recordAuditDeferred(c, {
		action: "mailbox.send_limits",
		actor,
		actorRole: auditActorRole(c.var.principal, mailboxId),
		mailboxId,
		detail: { hourly: caps.hourly, daily: caps.daily, previous_hourly: current.caps.hourly, previous_daily: current.caps.daily },
	});
	return c.json({ ...(await stub.getSendUsage()), maxima: { hourly: 1000, daily: 10000 }, editable: true });
});
