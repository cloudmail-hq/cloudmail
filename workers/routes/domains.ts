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
import { authSecret } from "../auth/config";
import type { AuthStoreApi } from "../auth/types";
import {
	openResendKey,
	openSesSecret,
	sealResendKey,
	sealResendWebhookSecret,
	sealSesSecret,
	type DomainSendingRecord,
	type PutDomainSendingInput,
} from "../lib/domain-sending-store";
import { refuseDomainAdd } from "../lib/licence-plan";
import { testResendConnection } from "../lib/resend-api";
import { invalidateTransportCache } from "../lib/mail-transport";
import { testSesConnection } from "../lib/ses-api";
import {
	accountIdOfTopicArn,
	isSesRegion,
	isSnsTopicArn,
	keyIdLast4,
	keyIdLast4 as resendKeyLast4,
	sesIamPolicy,
	RESEND_API_KEY_RE,
	RESEND_WEBHOOK_SECRET_RE,
	SES_ACCESS_KEY_ID_RE,
	SES_CONFIGURATION_SET_RE,
	SES_SECRET_ACCESS_KEY_RE,
	type DomainSendingView,
	type SendingTestResult,
	type SesTestResult,
} from "../../shared/ses-sending";

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
export interface DomainRpc extends Pick<AuthStoreApi, "getOrInitMeta"> {
	getDomainSending(hostname: string): Promise<DomainSendingRecord | null>;
	putDomainSending(input: PutDomainSendingInput): Promise<DomainSendingRecord>;
	recordDomainSendingTest(hostname: string, result: SendingTestResult): Promise<DomainSendingRecord | null>;
	deleteDomainSending(hostname: string): Promise<boolean>;
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
	// The licence plan's domain limit (Solo: one). Checked on add only; mail
	// for domains already configured is never refused.
	const refusal = await refuseDomainAdd(c.env, [hostname]);
	if (refusal) return c.json(refusal, 403);
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

// -- per-domain sending provider ---------------------------------------------------
//
//   GET    /api/v1/domains/:id/sending        provider, key last 4s, stored flags, webhook URL, last test/event, IAM policy
//   PUT    /api/v1/domains/:id/sending        {provider:"cloudflare"}
//                                             | {provider:"ses", region, accessKeyId, secretAccessKey?, configurationSet?, snsTopicArn?}
//                                             | {provider:"resend", apiKey?, webhookSecret?}
//   DELETE /api/v1/domains/:id/sending        back to Cloudflare; every stored setting and secret is wiped
//   POST   /api/v1/domains/:id/sending/test   SES: GetAccount, GetEmailIdentity, GetConfigurationSet, optional simulator send
//                                             Resend: GET /domains, GET /domains/:id, optional send to delivered@resend.dev
//
// Admin-only like every domain route (`domains:manage` for tokens), audited as
// `domain.change`. Secrets (SES secret access key, Resend API key and webhook
// signing secret) are write-only: sealed before the AuthDO RPC
// (../lib/domain-sending-store.ts) and never returned, logged or audited.
//
// Switching to SES or Resend is refused until a connection test of the
// stored settings allows it (SES: DKIM SUCCESS with signing on; Resend:
// domain verified, or a send-only key). `{provider:"cloudflare"}` switches
// sending back but keeps the stored settings; DELETE forgets them.

/** Overridable in tests. */
export const domainSendingDeps = {
	fetchImpl: undefined as typeof fetch | undefined,
	now: () => Date.now(),
	sleep: undefined as ((ms: number) => Promise<void>) | undefined,
};

const regionField = z.string().refine(isSesRegion, "region must be a supported SES region, e.g. us-east-1");
const keyIdField = z
	.string()
	.trim()
	.regex(SES_ACCESS_KEY_ID_RE, "accessKeyId must be an IAM access key ID (AKIA followed by 16 characters)");
const secretField = z
	.string()
	.trim()
	.regex(SES_SECRET_ACCESS_KEY_RE, "secretAccessKey must be the 40-character IAM secret access key");
const topicField = z
	.string()
	.trim()
	.refine(isSnsTopicArn, "snsTopicArn must be an SNS topic ARN, arn:aws:sns:<region>:<account>:<name>");
const resendKeyField = z.string().trim().regex(RESEND_API_KEY_RE, "apiKey must be a Resend API key (re_…)");
const webhookSecretField = z
	.string()
	.trim()
	.regex(RESEND_WEBHOOK_SECRET_RE, "webhookSecret must be the Resend webhook signing secret (whsec_…)");

const SesBody = z
	.object({
		provider: z.literal("ses"),
		region: regionField,
		accessKeyId: keyIdField,
		secretAccessKey: secretField.optional(),
		configurationSet: z
			.string()
			.trim()
			.regex(SES_CONFIGURATION_SET_RE, "configurationSet may use letters, digits, - and _ (up to 64)")
			.nullable()
			.optional(),
		snsTopicArn: topicField.nullable().optional(),
	})
	.strict();
const ResendBody = z
	.object({
		provider: z.literal("resend"),
		apiKey: resendKeyField.optional(),
		webhookSecret: webhookSecretField.nullable().optional(),
	})
	.strict();
const SendingBody = z.discriminatedUnion("provider", [
	z.object({ provider: z.literal("cloudflare") }).strict(),
	SesBody,
	ResendBody,
]);

/** Optional unsaved values to test before saving them. */
const TestBody = z
	.object({
		provider: z.enum(["ses", "resend"]).optional(),
		region: regionField.optional(),
		accessKeyId: keyIdField.optional(),
		secretAccessKey: secretField.optional(),
		configurationSet: z.string().trim().regex(SES_CONFIGURATION_SET_RE).nullable().optional(),
		apiKey: resendKeyField.optional(),
		/** Also send one test message (SES mailbox simulator / delivered@resend.dev). */
		sendTest: z.boolean().optional(),
	})
	.strict();

/** First issue's message, never the rejected value (it may be a secret). */
function issueMessage(error: z.ZodError): string {
	return error.issues[0]?.message ?? "Invalid body";
}

/** Webhook path for the domain's provider, or null. */
function webhookPath(rec: DomainSendingRecord | null): { provider: "ses" | "resend"; path: string } | null {
	if (!rec?.webhookId) return null;
	const provider = rec.provider === "resend" || (rec.provider === "cloudflare" && rec.resendKeyEnc && !rec.accessKeyId)
		? "resend"
		: rec.provider === "ses" || rec.accessKeyId
			? "ses"
			: null;
	return provider ? { provider, path: `/hooks/${provider}/${rec.webhookId}` } : null;
}

export function sendingView(hostname: string, rec: DomainSendingRecord | null, origin: string | null = null): DomainSendingView {
	const ses =
		rec && (rec.region !== null || rec.accessKeyId !== null || rec.secretEnc !== null)
			? {
					region: rec.region,
					accessKeyIdLast4: rec.accessKeyId ? keyIdLast4(rec.accessKeyId) : null,
					secretStored: !!rec.secretEnc,
					configurationSet: rec.configurationSet,
					snsTopicArn: rec.snsTopicArn,
				}
			: null;
	const resend =
		rec && (rec.resendKeyEnc !== null || rec.resendWebhookSecretEnc !== null)
			? {
					apiKeyLast4: rec.resendKeyEnc ? rec.resendKeyLast4 : null,
					apiKeyStored: !!rec.resendKeyEnc,
					webhookSecretStored: !!rec.resendWebhookSecretEnc,
				}
			: null;
	const hook = webhookPath(rec);
	return {
		domain: hostname,
		provider: rec?.provider ?? "cloudflare",
		ses,
		resend,
		webhook: hook ? { ...hook, url: origin ? `${origin}${hook.path}` : null } : null,
		lastEvent: rec?.lastEvent ?? null,
		updatedAt: rec?.updatedAt ?? null,
		updatedBy: rec?.updatedBy ?? null,
		lastTest: rec?.lastTest ?? null,
		iamPolicy: ses?.region
			? sesIamPolicy(hostname, ses.region, ses.configurationSet, accountIdOfTopicArn(ses.snsTopicArn))
			: null,
	};
}

function originOf(c: { req: { url: string } }): string {
	return new URL(c.req.url).origin;
}

function sendingAudit(
	c: Parameters<typeof recordAuditDeferred>[0] & { var: MailboxContext["Variables"] },
	target: string,
	detail: Record<string, string | boolean | null>,
) {
	return recordAuditDeferred(c, {
		action: "domain.change",
		actor: c.var.principal.identity?.id ?? null,
		actorRole: auditActorRole(c.var.principal, null),
		mailboxId: null,
		target,
		detail,
	});
}

/**
 * Whether the stored test allows switching to `provider`. It must be a test of
 * the provider's stored settings (the store drops it when they change) that
 * passed the gate: SES needs DKIM SUCCESS with signing on, Resend a verified
 * domain (or a send-only key, which cannot read the domain).
 */
function testAllows(rec: DomainSendingRecord | null, provider: "ses" | "resend"): { ok: true } | { ok: false; reason: string } {
	const t = rec?.lastTest;
	if (!t || (t.provider ?? "ses") !== provider) {
		return { ok: false, reason: "Saved. Run Test connection, then save again to start sending through this provider." };
	}
	if (t.sendingAllowed === false) return { ok: false, reason: t.blockedReason ?? "The last connection test didn't pass." };
	if (t.sendingAllowed === undefined) {
		// A test recorded before the gate existed: apply the DKIM rule to it.
		const ses = t as SesTestResult;
		if (!ses.identity?.ok || ses.identity.dkim.status !== "SUCCESS" || !ses.identity.dkim.signingEnabled) {
			return { ok: false, reason: "DKIM isn't verified for this domain in SES yet." };
		}
	}
	return { ok: true };
}

/** Whether `next` leaves the stored test describing the same credentials and identity. */
function testSurvives(
	prev: DomainSendingRecord | null,
	next: { region: string | null; accessKeyId: string | null; configurationSet: string | null; newSecret: boolean },
): boolean {
	return (
		!!prev &&
		!next.newSecret &&
		prev.region === next.region &&
		prev.accessKeyId === next.accessKeyId &&
		prev.configurationSet === next.configurationSet
	);
}

domainsRoutes.put("/:id/sending", async (c) => {
	const d = await resolve(c.env, c.req.param("id"));
	if (!d) return c.json({ error: "Domain not found" }, 404);
	const parsed = SendingBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: issueMessage(parsed.error), code: "invalid_body" }, 400);
	const rpc = domainRpc(c.env);
	const prev = await rpc.getDomainSending(d.hostname);
	const actor = c.var.principal.identity?.id ?? null;
	const now = domainSendingDeps.now();

	let rec: DomainSendingRecord;
	let secretReplaced = false;
	let blockedReason: string | null = null;
	if (parsed.data.provider === "cloudflare") {
		rec = await rpc.putDomainSending({
			hostname: d.hostname,
			provider: "cloudflare",
			region: prev?.region ?? null,
			accessKeyId: prev?.accessKeyId ?? null,
			configurationSet: prev?.configurationSet ?? null,
			updatedBy: actor,
			now,
		});
	} else if (parsed.data.provider === "ses") {
		const body = parsed.data;
		// A stored secret belongs to the stored key ID; a new key needs its own secret.
		const keyChanged = prev?.accessKeyId !== body.accessKeyId;
		if (!body.secretAccessKey && (!prev?.secretEnc || keyChanged)) {
			return c.json(
				{
					error:
						keyChanged && prev?.secretEnc
							? "A new access key ID needs its secret access key too."
							: "secretAccessKey is required the first time.",
					code: "secret_required",
				},
				400,
			);
		}
		if (body.snsTopicArn && body.snsTopicArn.split(":")[3] !== body.region) {
			return c.json({ error: "The SNS topic must be in the same region as SES.", code: "invalid_body" }, 400);
		}
		const secretEnc = body.secretAccessKey
			? await sealSesSecret(body.secretAccessKey, await authSecret(c.env, rpc), d.hostname)
			: undefined;
		secretReplaced = secretEnc !== undefined;
		const configurationSet = body.configurationSet ?? null;
		const survives = testSurvives(prev, {
			region: body.region,
			accessKeyId: body.accessKeyId,
			configurationSet,
			newSecret: secretReplaced,
		});
		const gate = survives ? testAllows(prev, "ses") : testAllows(null, "ses");
		if (!gate.ok) blockedReason = gate.reason;
		rec = await rpc.putDomainSending({
			hostname: d.hostname,
			// Not yet allowed: the settings are kept, mail keeps going through Cloudflare.
			provider: gate.ok ? "ses" : "cloudflare",
			region: body.region,
			accessKeyId: body.accessKeyId,
			secretEnc,
			configurationSet,
			...(body.snsTopicArn !== undefined ? { snsTopicArn: body.snsTopicArn } : {}),
			updatedBy: actor,
			now,
		});
	} else {
		const body = parsed.data;
		if (!body.apiKey && !prev?.resendKeyEnc) {
			return c.json({ error: "apiKey is required the first time.", code: "secret_required" }, 400);
		}
		const keyMaterial = await authSecret(c.env, rpc);
		const resendKeyEnc = body.apiKey ? await sealResendKey(body.apiKey, keyMaterial, d.hostname) : undefined;
		const resendWebhookSecretEnc =
			body.webhookSecret === undefined
				? undefined
				: body.webhookSecret === null
					? null
					: await sealResendWebhookSecret(body.webhookSecret, keyMaterial, d.hostname);
		secretReplaced = resendKeyEnc !== undefined;
		const gate = !secretReplaced && prev ? testAllows(prev, "resend") : testAllows(null, "resend");
		if (!gate.ok) blockedReason = gate.reason;
		rec = await rpc.putDomainSending({
			hostname: d.hostname,
			provider: gate.ok ? "resend" : "cloudflare",
			region: prev?.region ?? null,
			accessKeyId: prev?.accessKeyId ?? null,
			configurationSet: prev?.configurationSet ?? null,
			resendKeyEnc,
			...(body.apiKey ? { resendKeyLast4: resendKeyLast4(body.apiKey) } : {}),
			resendWebhookSecretEnc,
			updatedBy: actor,
			now,
		});
	}
	invalidateTransportCache(d.hostname);
	await sendingAudit(c, d.hostname, {
		op: blockedReason ? "sending.stage" : "sending.set",
		provider: rec.provider,
		requested: parsed.data.provider,
		region: rec.region,
		keyIdLast4: rec.accessKeyId ? keyIdLast4(rec.accessKeyId) : null,
		...(rec.resendKeyLast4 ? { resendKeyLast4: rec.resendKeyLast4 } : {}),
		secretReplaced,
	});
	return c.json({ ...sendingView(d.hostname, rec, originOf(c)), blockedReason });
});

domainsRoutes.get("/:id/sending", async (c) => {
	const d = await resolve(c.env, c.req.param("id"));
	if (!d) return c.json({ error: "Domain not found" }, 404);
	return c.json(sendingView(d.hostname, await domainRpc(c.env).getDomainSending(d.hostname), originOf(c)));
});


domainsRoutes.delete("/:id/sending", async (c) => {
	const d = await resolve(c.env, c.req.param("id"));
	if (!d) return c.json({ error: "Domain not found" }, 404);
	const removed = await domainRpc(c.env).deleteDomainSending(d.hostname);
	invalidateTransportCache(d.hostname);
	if (removed) await sendingAudit(c, d.hostname, { op: "sending.reset", provider: "cloudflare" });
	return c.json(sendingView(d.hostname, null, originOf(c)));
});

domainsRoutes.post("/:id/sending/test", async (c) => {
	const d = await resolve(c.env, c.req.param("id"));
	if (!d) return c.json({ error: "Domain not found" }, 404);
	const raw = (await c.req.text()).trim();
	let json: unknown = {};
	if (raw) {
		try {
			json = JSON.parse(raw);
		} catch {
			return c.json({ error: "Body must be JSON", code: "invalid_body" }, 400);
		}
	}
	const parsed = TestBody.safeParse(json);
	if (!parsed.success) return c.json({ error: issueMessage(parsed.error), code: "invalid_body" }, 400);
	const override = parsed.data;
	const rpc = domainRpc(c.env);
	const prev = await rpc.getDomainSending(d.hostname);
	const provider =
		override.provider ??
		(override.apiKey ? "resend" : override.accessKeyId || override.region ? "ses" : prev?.provider === "resend" ? "resend" : prev?.resendKeyEnc && !prev.accessKeyId ? "resend" : "ses");

	if (provider === "resend") {
		let apiKey = override.apiKey ?? null;
		if (!apiKey && prev?.resendKeyEnc) {
			try {
				apiKey = await openResendKey(prev.resendKeyEnc, await authSecret(c.env, rpc), d.hostname);
			} catch {
				return c.json(
					{ error: "The stored Resend API key can no longer be read (AUTH_SECRET changed?). Enter it again.", code: "secret_unreadable" },
					409,
				);
			}
		}
		if (!apiKey) return c.json({ error: "Enter a Resend API key first.", code: "resend_not_configured" }, 412);
		const result = await testResendConnection(d.hostname, apiKey, {
			fetchImpl: domainSendingDeps.fetchImpl,
			now: domainSendingDeps.now(),
			sendTest: override.sendTest === true,
		});
		const ofStored = !!prev?.resendKeyEnc && !override.apiKey;
		const rec = ofStored ? await rpc.recordDomainSendingTest(d.hostname, result) : prev;
		return c.json({ test: result, sending: sendingView(d.hostname, rec, originOf(c)) });
	}

	const region = override.region ?? prev?.region ?? null;
	const accessKeyId = override.accessKeyId ?? prev?.accessKeyId ?? null;
	const configurationSet = override.configurationSet !== undefined ? override.configurationSet : (prev?.configurationSet ?? null);
	let secretAccessKey = override.secretAccessKey ?? null;
	// The stored secret only pairs with the stored key ID.
	if (!secretAccessKey && prev?.secretEnc && accessKeyId === prev.accessKeyId) {
		try {
			secretAccessKey = await openSesSecret(prev.secretEnc, await authSecret(c.env, rpc), d.hostname);
		} catch {
			return c.json(
				{
					error: "The stored secret access key can no longer be read (AUTH_SECRET changed?). Enter it again.",
					code: "secret_unreadable",
				},
				409,
			);
		}
	}
	if (!region || !accessKeyId || !secretAccessKey) {
		return c.json({ error: "Enter a region, access key ID and secret access key first.", code: "ses_not_configured" }, 412);
	}

	const result = await testSesConnection(
		d.hostname,
		{ region, accessKeyId, secretAccessKey, configurationSet },
		{
			fetchImpl: domainSendingDeps.fetchImpl,
			now: domainSendingDeps.now(),
			sendTest: override.sendTest === true,
			...(domainSendingDeps.sleep ? { sleep: domainSendingDeps.sleep } : {}),
		},
	);
	// Only a test of exactly the stored settings is recorded against them.
	const ofStored =
		!!prev &&
		region === prev.region &&
		accessKeyId === prev.accessKeyId &&
		configurationSet === prev.configurationSet &&
		!override.secretAccessKey;
	const rec = ofStored ? await rpc.recordDomainSendingTest(d.hostname, result) : prev;
	return c.json({ test: result, sending: sendingView(d.hostname, rec, originOf(c)) });
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

