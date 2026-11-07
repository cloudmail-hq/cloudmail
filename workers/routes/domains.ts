// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * `/api/v1/domains` (admin only) and `/api/v1/mailboxes/:mailboxId/aliases`.
 *
 * Domains live in the AuthDO (`workers/lib/domain-store.ts`). Env `DOMAINS` /
 * `ZONES` entries are seeded into it on first read so they show up here with
 * status and audit like any other, but stay marked `source: "env"` and cannot
 * be deleted while still configured.
 *
 * Provisioning needs a Cloudflare token (Settings → Cloudflare connection, or
 * the `CF_API_TOKEN` secret; see ../lib/cf-connection.ts). Without one the
 * detail view returns the exact records and dashboard steps instead and
 * `provision` answers 412.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { recordAuditDeferred, auditActorRole } from "../lib/audit";
import { cloudflareClient, resolveCloudflareToken, resolveWorkerScriptName } from "../lib/cf-connection";
import { auditDomain, expectedRecords, manualSteps } from "../lib/dns-audit";
import { provisionDomain } from "../lib/domain-provision";
import type {
	CreateDomainResult,
	DnsRecordSpec,
	DomainDetailRecord,
	DomainPatch,
	DomainRecord,
	SetAliasesResult,
} from "../lib/domain-store";
import { MAX_ALIASES_PER_MAILBOX, withoutRealMailboxes } from "../lib/domain-store";
import { listMailboxes } from "../lib/email-helpers";
import { requireAdminScope, type MailboxContext } from "../lib/mailbox";

/** Admin-only, and a scoped token needs `domains:manage` (or `admin`). */
const requireDomainAdmin = requireAdminScope("domains:manage");
import {
	domainOfAddress,
	getEnvZones,
	invalidateStoredDomains,
	isDomainAllowed,
	normalizeDomain,
	refreshStoredDomains,
} from "../lib/zones";

/** The AuthDO methods these routes call, narrowed for readability. */
export interface DomainRpc {
	listDomains(): Promise<DomainRecord[]>;
	getDomain(idOrHostname: string): Promise<DomainDetailRecord | null>;
	createDomain(input: {
		hostname: string;
		displayName?: string;
		zoneId?: string | null;
		catchAllMailbox?: string | null;
		now: number;
	}): Promise<CreateDomainResult>;
	seedDomains(zones: { domain: string; name: string; zoneId?: string }[], now: number): Promise<number>;
	/** `seedDomains` then `listDomains` in one call. */
	seedAndListDomains(zones: { domain: string; name: string; zoneId?: string }[], now: number): Promise<DomainRecord[]>;
	updateDomain(id: string, patch: DomainPatch, now: number): Promise<DomainDetailRecord | null>;
	deleteDomain(id: string): Promise<boolean>;
	listAliases(mailboxId: string): Promise<string[]>;
	allAliases(): Promise<Record<string, string>>;
	setAliases(mailboxId: string, addresses: string[], now: number): Promise<SetAliasesResult>;
	forgetMailbox(mailboxId: string, now: number): Promise<void>;
	routingLookup(addresses: string[]): Promise<{ aliases: Record<string, string>; catchAll: Record<string, string> }>;
}

/**
 * The AuthDO stub. Taken from the namespace directly rather than through
 * `authStore()` so this module (imported by `workers/index.ts`) never pulls in
 * `cloudflare:workers`, which the unit tests cannot load.
 */
export function domainRpc(env: Env): DomainRpc {
	const ns = env.AUTH_STORE as unknown as DurableObjectNamespace;
	return ns.get(ns.idFromName("global")) as unknown as DomainRpc;
}

/**
 * Seed env domains, then load the stored list into the zone cache. Called by
 * the API middleware so `getZones` (sync) sees DB domains on every request.
 *
 * The list is cached per isolate for `STORED_DOMAINS_TTL_MS` (30 s) and
 * dropped by every domain write in this isolate (`invalidateStoredDomains`);
 * a write in another isolate shows up here within the TTL. The first load in
 * an isolate seeds and lists in one AuthDO call rather than two.
 */
const seeded = new WeakMap<object, true>();
export async function loadStoredDomains(env: Env): Promise<void> {
	const key = ((env as { AUTH_STORE?: object }).AUTH_STORE ?? env) as object;
	if (!(env as { AUTH_STORE?: unknown }).AUTH_STORE) return;
	await refreshStoredDomains(env, async () => {
		const rpc = domainRpc(env);
		if (!seeded.has(key)) {
			const rows = await rpc.seedAndListDomains(getEnvZones(env), Date.now());
			seeded.set(key, true);
			return rows;
		}
		return rpc.listDomains();
	});
}

/** Whether a mailbox settings object exists for `address`. */
async function isMailbox(env: Env, address: string): Promise<boolean> {
	return (await env.BUCKET.head(`mailboxes/${address}.json`)) !== null;
}

/**
 * The aliases a mailbox may send as. Never throws.
 *
 * An alias that has since become a real mailbox is left out: the row may
 * predate the mailbox (or come from a race with its creation), and honouring
 * it would let this mailbox send as the other one.
 */
export async function senderAddressesFor(env: Env, mailboxId: string): Promise<string[]> {
	try {
		const aliases = await domainRpc(env).listAliases(mailboxId);
		return await withoutRealMailboxes(aliases, (a) => isMailbox(env, a));
	} catch (e) {
		console.error(`Alias lookup failed for ${mailboxId}:`, (e as Error).message);
		return [];
	}
}

/**
 * Every live alias as address -> mailbox, for the delivery reconciler. Same
 * rule as `senderAddressesFor`: an alias that is now a real mailbox is
 * dropped, so that mailbox's delivery events are filed under it.
 */
export async function liveAliasMap(env: Env): Promise<Record<string, string>> {
	const all = await domainRpc(env).allAliases();
	const keep = await withoutRealMailboxes(Object.keys(all), (a) => isMailbox(env, a));
	return Object.fromEntries(keep.map((a) => [a, all[a]!]));
}

/** The mailbox `address` is an alias of, or null. Throws if the lookup fails. */
export async function aliasOwnerOf(env: Env, address: string): Promise<string | null> {
	// No AuthDO binding means no alias table, so nothing can own the address.
	if (!(env as { AUTH_STORE?: unknown }).AUTH_STORE) return null;
	const { aliases } = await domainRpc(env).routingLookup([address]);
	return aliases[address.toLowerCase()] ?? null;
}

/** Drop a deleted mailbox's aliases and catch-all assignments. Never throws. */
export async function forgetMailboxRouting(env: Env, mailboxId: string): Promise<void> {
	try {
		await domainRpc(env).forgetMailbox(mailboxId, Date.now());
		invalidateStoredDomains(env);
	} catch (e) {
		console.error(`Failed to clear aliases for deleted mailbox ${mailboxId}:`, (e as Error).message);
	}
}

// -- serialisation --------------------------------------------------------------

const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)(?:[a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/;

export function isValidHostname(raw: string): boolean {
	return HOSTNAME_RE.test(normalizeDomain(raw));
}

function publicDomain(d: DomainRecord, envHosts: Set<string>, mailboxCounts: Map<string, number>) {
	return {
		id: d.id,
		hostname: d.hostname,
		displayName: d.displayName,
		zoneId: d.zoneId,
		status: d.status,
		routingStatus: d.routingStatus,
		sendingStatus: d.sendingStatus,
		sendingSubdomainId: d.sendingSubdomainId,
		dkim: d.dkim,
		catchAllMailbox: d.catchAllMailbox,
		source: envHosts.has(d.hostname) ? ("env" as const) : ("api" as const),
		lastError: d.lastError,
		createdAt: d.createdAt,
		updatedAt: d.updatedAt,
		lastCheckedAt: d.lastCheckedAt,
		mailboxCount: mailboxCounts.get(d.hostname) ?? 0,
	};
}

async function mailboxCountsByDomain(bucket: R2Bucket): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	for (const m of await listMailboxes(bucket)) {
		const d = domainOfAddress(m.email);
		counts.set(d, (counts.get(d) ?? 0) + 1);
	}
	return counts;
}

function isEnvDomain(env: Env, hostname: string): boolean {
	return getEnvZones(env).some((z) => z.domain === hostname);
}

async function cloudflareInfo(env: Env) {
	return { configured: (await resolveCloudflareToken(env)) !== null, workerScriptName: await resolveWorkerScriptName(env) };
}

function recordsFor(d: DomainDetailRecord): DnsRecordSpec[] {
	return expectedRecords(d.hostname, { sendingDkimSelector: d.dkim?.selector, sendingDns: d.sendingDns });
}

// -- domains router ---------------------------------------------------------------

export const domainsRoutes = new Hono<MailboxContext>();
domainsRoutes.use("*", requireDomainAdmin);

const CreateBody = z.object({
	hostname: z.string().min(1).max(253),
	displayName: z.string().max(100).optional(),
	zoneId: z.string().regex(/^[a-f0-9]{32}$/i, "zoneId must be a 32-character hex id").optional(),
	catchAllMailbox: z.string().email().optional(),
});

const PatchBody = z.object({
	displayName: z.string().max(100).optional(),
	catchAllMailbox: z.string().email().nullable().optional(),
});

const ProvisionBody = z
	.object({
		overwriteCatchAll: z.boolean().optional(),
		/**
		 * Required for a domain from DOMAINS/ZONES. Those are already live
		 * (tapetide.com in production), so a provisioning run against them is
		 * changing a working setup and has to be asked for explicitly.
		 */
		confirmEnvDomain: z.boolean().optional(),
	})
	.optional();

async function resolve(env: Env, id: string): Promise<DomainDetailRecord | null> {
	await loadStoredDomains(env);
	return domainRpc(env).getDomain(decodeURIComponent(id));
}

async function shape(env: Env, d: DomainRecord) {
	const envHosts = new Set(getEnvZones(env).map((z) => z.domain));
	return publicDomain(d, envHosts, await mailboxCountsByDomain(env.BUCKET));
}

/** A catch-all must be an existing mailbox on the same domain. */
async function checkCatchAll(env: Env, hostname: string, mailbox: string): Promise<string | null> {
	const address = mailbox.trim().toLowerCase();
	if (domainOfAddress(address) !== hostname) return "Catch-all mailbox must be on the same domain";
	if (!(await env.BUCKET.head(`mailboxes/${address}.json`))) return "Catch-all mailbox does not exist";
	return null;
}

function audit(c: Parameters<typeof recordAuditDeferred>[0] & { var: MailboxContext["Variables"] }, target: string, op: string) {
	return recordAuditDeferred(c, {
		action: "domain.change",
		actor: c.var.principal.identity?.id ?? null,
		actorRole: auditActorRole(c.var.principal, null),
		mailboxId: null,
		target,
		detail: { op },
	});
}

domainsRoutes.get("/", async (c) => {
	await loadStoredDomains(c.env);
	const rows = await domainRpc(c.env).listDomains();
	const envHosts = new Set(getEnvZones(c.env).map((z) => z.domain));
	const counts = await mailboxCountsByDomain(c.env.BUCKET);
	return c.json({
		domains: rows.map((d) => publicDomain(d, envHosts, counts)),
		cloudflare: await cloudflareInfo(c.env),
	});
});

domainsRoutes.get("/:id", async (c) => {
	const d = await resolve(c.env, c.req.param("id"));
	if (!d) return c.json({ error: "Domain not found" }, 404);
	return c.json({
		domain: await shape(c.env, d),
		records: recordsFor(d),
		manualSteps: manualSteps(d.hostname, await resolveWorkerScriptName(c.env)),
		audit: d.lastAudit,
		provision: d.lastProvision,
		cloudflare: await cloudflareInfo(c.env),
	});
});

domainsRoutes.post("/", async (c) => {
	const parsed = CreateBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, 400);
	const hostname = normalizeDomain(parsed.data.hostname);
	if (!isValidHostname(hostname)) return c.json({ error: `"${parsed.data.hostname}" is not a valid domain name` }, 400);
	if (parsed.data.catchAllMailbox) {
		const problem = await checkCatchAll(c.env, hostname, parsed.data.catchAllMailbox);
		if (problem) return c.json({ error: problem }, 400);
	}
	await loadStoredDomains(c.env);
	const result = await domainRpc(c.env).createDomain({
		hostname,
		displayName: parsed.data.displayName,
		zoneId: parsed.data.zoneId,
		catchAllMailbox: parsed.data.catchAllMailbox,
		now: Date.now(),
	});
	if (!result.ok) return c.json({ error: "Domain already exists" }, 409);
	invalidateStoredDomains(c.env);
	await audit(c, hostname, "create");
	return c.json({ domain: await shape(c.env, result.domain) }, 201);
});

domainsRoutes.patch("/:id", async (c) => {
	const d = await resolve(c.env, c.req.param("id"));
	if (!d) return c.json({ error: "Domain not found" }, 404);
	const parsed = PatchBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, 400);
	const patch: DomainPatch = {};
	if (parsed.data.displayName !== undefined) patch.displayName = parsed.data.displayName;
	if (parsed.data.catchAllMailbox !== undefined) {
		if (parsed.data.catchAllMailbox !== null) {
			const problem = await checkCatchAll(c.env, d.hostname, parsed.data.catchAllMailbox);
			if (problem) return c.json({ error: problem }, 400);
		}
		patch.catchAllMailbox = parsed.data.catchAllMailbox;
	}
	const updated = await domainRpc(c.env).updateDomain(d.id, patch, Date.now());
	if (!updated) return c.json({ error: "Domain not found" }, 404);
	invalidateStoredDomains(c.env);
	await audit(c, d.hostname, "update");
	return c.json({ domain: await shape(c.env, updated) });
});

domainsRoutes.delete("/:id", async (c) => {
	const d = await resolve(c.env, c.req.param("id"));
	if (!d) return c.json({ error: "Domain not found" }, 404);
	if (isEnvDomain(c.env, d.hostname)) {
		return c.json({ error: "This domain comes from the DOMAINS/ZONES configuration. Remove it there first." }, 409);
	}
	const count = (await mailboxCountsByDomain(c.env.BUCKET)).get(d.hostname) ?? 0;
	if (count > 0) {
		return c.json({ error: `Delete the ${count} mailbox(es) on ${d.hostname} first.` }, 409);
	}
	await domainRpc(c.env).deleteDomain(d.id);
	invalidateStoredDomains(c.env);
	await audit(c, d.hostname, "delete");
	return c.json({ ok: true });
});

domainsRoutes.post("/:id/verify", async (c) => {
	const d = await resolve(c.env, c.req.param("id"));
	if (!d) return c.json({ error: "Domain not found" }, 404);
	const result = await auditDomain(d.hostname, { sendingDkimSelector: d.dkim?.selector });
	const patch: DomainPatch = { lastAudit: result, lastCheckedAt: result.checkedAt };
	// DNS alone can promote a manual-mode domain; it never demotes one the
	// provisioner marked active, since a resolver blip should not flip status.
	if (result.summary === "pass" && d.status !== "active") patch.status = "active";
	const routing = result.checks.find((x) => x.id === "mx");
	if (routing && !(await resolveCloudflareToken(c.env))) patch.routingStatus = routing.status === "pass" ? "manual" : d.routingStatus;
	const updated = await domainRpc(c.env).updateDomain(d.id, patch, Date.now());
	return c.json({ domain: await shape(c.env, updated ?? d), audit: result });
});

domainsRoutes.post("/:id/provision", async (c) => {
	const d = await resolve(c.env, c.req.param("id"));
	if (!d) return c.json({ error: "Domain not found" }, 404);
	const client = await cloudflareClient(c.env);
	if (!client) {
		return c.json(
			{
				error: "Cloudflare isn't connected. Connect it in Settings → Cloudflare connection, or follow the manual steps, then re-check DNS.",
				manualSteps: manualSteps(d.hostname, await resolveWorkerScriptName(c.env)),
				records: recordsFor(d),
			},
			412,
		);
	}
	const body = ProvisionBody.safeParse(await c.req.json().catch(() => undefined));
	const opts = body.success ? (body.data ?? {}) : {};
	if (isEnvDomain(c.env, d.hostname) && opts.confirmEnvDomain !== true) {
		return c.json(
			{
				error: `${d.hostname} comes from DOMAINS/ZONES and is already in use. Provisioning may change its live Cloudflare configuration; resend with "confirmEnvDomain": true to proceed.`,
				code: "confirm_env_domain",
			},
			428,
		);
	}
	const { result, patch } = await provisionDomain(client, d, {
		overwriteCatchAll: opts.overwriteCatchAll === true,
	});
	patch.lastCheckedAt = result.ranAt;
	const updated = await domainRpc(c.env).updateDomain(d.id, patch, Date.now());
	invalidateStoredDomains(c.env);
	await audit(c, d.hostname, "provision");
	return c.json({ domain: await shape(c.env, updated ?? d), provision: result });
});

// -- aliases ---------------------------------------------------------------------

export const aliasRoutes = new Hono<MailboxContext>();

const AliasesBody = z.object({ aliases: z.array(z.string().max(320)).max(MAX_ALIASES_PER_MAILBOX) });

// Read: anyone `requireMailbox` let through (the composer needs it for From).
aliasRoutes.get("/:mailboxId/aliases", async (c) => {
	const mailboxId = c.req.param("mailboxId").toLowerCase();
	return c.json({ aliases: await senderAddressesFor(c.env, mailboxId) });
});

aliasRoutes.put("/:mailboxId/aliases", requireDomainAdmin, async (c) => {
	const mailboxId = c.req.param("mailboxId").toLowerCase();
	const parsed = AliasesBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, 400);
	await loadStoredDomains(c.env);

	const email = z.string().email();
	const wanted = [...new Set(parsed.data.aliases.map((a) => a.trim().toLowerCase()).filter(Boolean))];
	for (const address of wanted) {
		if (!email.safeParse(address).success) return c.json({ error: `"${address}" is not a valid address` }, 400);
		if (!isDomainAllowed(c.env, domainOfAddress(address))) {
			return c.json({ error: `${domainOfAddress(address)} is not a domain this deployment serves` }, 400);
		}
		if (address !== mailboxId && (await c.env.BUCKET.head(`mailboxes/${address}.json`))) {
			return c.json({ error: `${address} is already a mailbox` }, 409);
		}
	}
	const result = await domainRpc(c.env).setAliases(mailboxId, wanted, Date.now());
	if (!result.ok) return c.json({ error: `${result.address} is already an alias of ${result.owner}` }, 409);
	await recordAuditDeferred(c, {
		action: "mailbox.aliases",
		actor: c.var.principal.identity?.id ?? null,
		actorRole: auditActorRole(c.var.principal, mailboxId),
		mailboxId,
		detail: { count: result.aliases.length },
	});
	return c.json({ aliases: result.aliases });
});

