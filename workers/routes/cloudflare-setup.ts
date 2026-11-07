// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Cloudflare onboarding: discover, plan, apply, and the change log.
 *
 *   GET  /api/v1/cloudflare/discover                 zones + account state (read-only, cached 60 s)
 *   POST /api/v1/cloudflare/plan                     { zones } → items + planHash (read-only)
 *   POST /api/v1/cloudflare/apply                    { zones, planHash, items: [{ id, confirm? }] }
 *   GET  /api/v1/cloudflare/changes                  recent logged changes
 *   POST /api/v1/cloudflare/changes/:id/revert       put back what a change replaced
 *
 * Admin-only (`domains:manage`). Apply and revert also need a browser session
 * that re-confirmed its user in the last 15 minutes (as the connection routes).
 *
 * Nothing here runs on its own: no cron, no deploy hook. Apply recomputes the
 * plan from fresh discovery and never trusts the client's records; it refuses
 * with 409 `plan_stale` when the recomputed plan hash differs from the one the
 * admin reviewed.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AuthStoreApi } from "../auth/types";
import type { CfApplyResponse, CfDiscovery, CfDnsChange, CfPlanResponse, PlanItem } from "../../shared/cf-setup";
import { cfTokenTemplateUrl } from "../../shared/cf-token-template";
import { semanticIndexName } from "../../shared/semantic";
import { auditActorRole, recordAuditDeferred } from "../lib/audit";
import {
	invalidateCloudflareConnectionCache,
	loadCloudflareConnection,
	resolveWorkerScriptName,
	tokenLast4,
	type LoadedCloudflareConnection,
} from "../lib/cf-connection";
import {
	CALL_TIMEOUT_MS,
	MAX_PLAN_ZONES,
	cachedDiscovery,
	discoverAccount,
	discoverVectorize,
	discoverWorker,
	discoverZones,
	invalidateDiscoveryCache,
	storeDiscovery,
	type DiscoveryContext,
} from "../lib/cf-discovery";
import { CloudflareApiError, CloudflareClient } from "../lib/cloudflare-api";
import type { RecordDnsChangeInput } from "../lib/dns-change-log";
import type { DomainDetailRecord, DomainPatch, DomainRecord, CreateDomainResult } from "../lib/domain-store";
import { requireAdminScope, type MailboxContext } from "../lib/mailbox";
import { buildSetupPlan, planHash } from "../lib/setup-plan";
import { applyPlan, revertChange, RevertConflictError } from "../lib/setup-apply";
import { getEnvZones, invalidateStoredDomains } from "../lib/zones";
import { cloudflareRouteDeps, needsFreshSession, type CloudflareConnectionRpc } from "./cloudflare";

type AppContext = Context<MailboxContext>;

/** The AuthDO methods these routes call. */
export interface CloudflareSetupRpc extends CloudflareConnectionRpc, Pick<AuthStoreApi, "getSessionAuthenticatedAt"> {
	recordDnsChange(input: RecordDnsChangeInput): Promise<CfDnsChange>;
	getDnsChange(id: string): Promise<CfDnsChange | null>;
	listDnsChanges(limit: number, zoneId?: string): Promise<CfDnsChange[]>;
	markDnsChangeReverted(id: string, by: string | null, now: number): Promise<CfDnsChange | null>;
	clearDnsChangeReverted(id: string): Promise<void>;
	listDomains(): Promise<DomainRecord[]>;
	seedDomains(zones: { domain: string; name: string; zoneId?: string }[], now: number): Promise<number>;
	getDomain(idOrHostname: string): Promise<DomainDetailRecord | null>;
	createDomain(input: { hostname: string; zoneId?: string | null; now: number }): Promise<CreateDomainResult>;
	updateDomain(id: string, patch: DomainPatch, now: number): Promise<DomainDetailRecord | null>;
}

/** Overridable in tests. `now` and `fetchImpl` come from `cloudflareRouteDeps`. */
export const cloudflareSetupDeps = {
	store: (c: AppContext): CloudflareSetupRpc => cloudflareRouteDeps.store(c) as unknown as CloudflareSetupRpc,
	/** DoH fetch for SPF include lookups. */
	dohFetch: undefined as typeof fetch | undefined,
};

const ZONE_ID = z.string().regex(/^[a-f0-9]{32}$/i, "zone ids are 32-character hex ids");
const ZonesField = z
	.array(ZONE_ID)
	.min(1, "Choose at least one zone.")
	.max(MAX_PLAN_ZONES, `Choose at most ${MAX_PLAN_ZONES} zones at a time.`)
	.transform((ids) => [...new Set(ids.map((i) => i.toLowerCase()))]);

const PlanBody = z.object({ zones: ZonesField }).strict();
const ApplyBody = z
	.object({
		zones: ZonesField,
		planHash: z.string().min(1).max(128),
		items: z
			.array(z.object({ id: z.string().min(1).max(200), confirm: z.literal(true).optional() }).strict())
			.min(1)
			.max(200),
	})
	.strict();

export const cloudflareSetupRoutes = new Hono<MailboxContext>();
for (const p of ["/api/v1/cloudflare/discover", "/api/v1/cloudflare/plan", "/api/v1/cloudflare/apply", "/api/v1/cloudflare/changes", "/api/v1/cloudflare/changes/*"]) {
	cloudflareSetupRoutes.use(p, requireAdminScope("domains:manage"));
}

// -- context -----------------------------------------------------------------------

interface Session {
	store: CloudflareSetupRpc;
	loaded: LoadedCloudflareConnection;
	token: string;
	accountId: string | null;
	client: () => CloudflareClient;
	ctx: DiscoveryContext;
	templateUrl: string;
	setScriptName(name: string): void;
}

function notConnected(c: AppContext, loaded: LoadedCloudflareConnection) {
	return c.json(
		loaded.state === "reconnect_required"
			? { error: "The saved Cloudflare token can't be read any more. Paste it again in Settings → Cloudflare connection.", code: "reconnect_required" }
			: { error: "Cloudflare isn't connected. Connect it in Settings → Cloudflare connection.", code: "not_connected" },
		412,
	);
}

async function session(c: AppContext): Promise<Session | Response> {
	const store = cloudflareSetupDeps.store(c);
	const loaded = await loadCloudflareConnection(c.env, store);
	if (!loaded.resolved) return notConnected(c, loaded);
	const { token, accountId, source } = loaded.resolved;
	const envName = (c.env as { WORKER_SCRIPT_NAME?: string }).WORKER_SCRIPT_NAME?.trim();
	let scriptName = await resolveWorkerScriptName(c.env, store);
	const workerSource = envName ? "env" : loaded.record?.workerScriptName ? "connection" : "default";

	const domains = await store.listDomains().catch(() => [] as DomainRecord[]);
	const envHosts = new Set(getEnvZones(c.env).map((zz) => zz.domain.toLowerCase()));
	const managedHosts = new Set([...envHosts, ...domains.map((d) => d.hostname.toLowerCase())]);
	const missing =
		source === "connection" ? (loaded.record?.capabilities ?? []).filter((cap) => cap.status === "missing").map((cap) => cap.name) : [];

	const client = () =>
		new CloudflareClient({
			token,
			accountId: accountId ?? undefined,
			workerScriptName: scriptName,
			fetchImpl: cloudflareRouteDeps.fetchImpl,
			timeoutMs: CALL_TIMEOUT_MS,
		});
	const ctx: DiscoveryContext = {
		client: client(),
		accountId,
		tokenSource: source,
		managedHosts,
		envHosts,
		worker: { configured: scriptName, source: workerSource, canPersist: !envName && !!loaded.record },
		missingCapabilities: missing,
		hasSemanticIndex: !!(c.env as { SEMANTIC_INDEX?: unknown }).SEMANTIC_INDEX,
		semanticIndexName: semanticIndexName(c.env as { SEMANTIC_INDEX_NAME?: string }),
		dohFetch: cloudflareSetupDeps.dohFetch,
		now: cloudflareRouteDeps.now(),
	};
	return {
		store,
		loaded,
		token,
		accountId,
		client,
		ctx,
		templateUrl: cfTokenTemplateUrl({ accountId }),
		setScriptName(name: string) {
			scriptName = name;
		},
	};
}

/** Fresh discovery of the chosen zones and the plan for them. */
async function computePlan(s: Session, zoneIds: string[]) {
	const [zoneRead, worker, vectorize] = await Promise.all([discoverZones(s.ctx, zoneIds), discoverWorker(s.ctx), discoverVectorize(s.ctx)]);
	const items = buildSetupPlan({
		zones: zoneRead.zones,
		worker: worker.worker,
		vectorize,
		missingCapabilities: s.ctx.missingCapabilities,
		templateUrl: s.templateUrl,
	});
	return {
		items,
		hash: await planHash(items),
		zones: zoneRead.zones,
		invisible: zoneRead.invisible,
		worker: worker.worker,
		vectorize: vectorize ?? { indexName: s.ctx.semanticIndexName, index: "unknown" as const, metadataIndex: "unknown" as const },
	};
}

function actor(c: AppContext): string | null {
	return c.var.principal.identity?.id ?? null;
}

// -- discover -------------------------------------------------------------------

cloudflareSetupRoutes.get("/api/v1/cloudflare/discover", async (c: AppContext) => {
	const s = await session(c);
	if (s instanceof Response) return s;
	const now = cloudflareRouteDeps.now();
	const key = `${s.loaded.resolved!.source}:${s.accountId ?? ""}:${tokenLast4(s.token)}:${s.loaded.record?.updatedAt ?? 0}`;
	const refresh = c.req.query("refresh") === "1";
	const hit = refresh ? null : cachedDiscovery(key, now);
	if (hit) return c.json({ ...hit, cached: true });
	const result: CfDiscovery = await discoverAccount(s.ctx);
	storeDiscovery(key, result, now);
	return c.json({ ...result, cached: false });
});

// -- plan -----------------------------------------------------------------------------

cloudflareSetupRoutes.post("/api/v1/cloudflare/plan", async (c: AppContext) => {
	const parsed = PlanBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid body", code: "invalid_body" }, 400);
	const s = await session(c);
	if (s instanceof Response) return s;
	const plan = await computePlan(s, parsed.data.zones);
	if (plan.invisible.length) {
		return c.json({ error: "This token can't see some of those zones.", code: "zone_not_visible", zones: plan.invisible }, 400);
	}
	const body: CfPlanResponse = { items: plan.items, planHash: plan.hash, zones: plan.zones, worker: plan.worker, vectorize: plan.vectorize };
	return c.json(body);
});

// -- apply -------------------------------------------------------------------------------

cloudflareSetupRoutes.post("/api/v1/cloudflare/apply", async (c: AppContext) => {
	const store = cloudflareSetupDeps.store(c);
	const stale = await needsFreshSession(c, store);
	if (stale) return stale;
	const parsed = ApplyBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid body", code: "invalid_body" }, 400);
	const { zones, items: wanted } = parsed.data;
	const s = await session(c);
	if (s instanceof Response) return s;

	const plan = await computePlan(s, zones);
	if (plan.invisible.length) {
		return c.json({ error: "This token can't see some of those zones.", code: "zone_not_visible", zones: plan.invisible }, 400);
	}
	if (plan.hash !== parsed.data.planHash) {
		return c.json(
			{
				error: "Something changed on Cloudflare since you reviewed the plan. Review the new plan and apply again.",
				code: "plan_stale",
				items: plan.items,
				planHash: plan.hash,
			},
			409,
		);
	}

	const byId = new Map(plan.items.map((i) => [i.id, i]));
	const selected = new Set(zones);
	const chosen: { item: PlanItem; confirmed: boolean }[] = [];
	const seen = new Set<string>();
	for (const w of wanted) {
		if (seen.has(w.id)) continue;
		seen.add(w.id);
		const item = byId.get(w.id);
		if (!item) {
			const zonePart = w.id.split(":")[0]!;
			if (/^[a-f0-9]{32}$/i.test(zonePart) && !selected.has(zonePart.toLowerCase())) {
				return c.json({ error: `${w.id} is on a zone that wasn't selected.`, code: "zone_not_selected", id: w.id }, 400);
			}
			return c.json({ error: `${w.id} isn't in the plan.`, code: "unknown_item", id: w.id }, 400);
		}
		if (item.zoneId && !selected.has(item.zoneId.toLowerCase())) {
			return c.json({ error: `${w.id} is on a zone that wasn't selected.`, code: "zone_not_selected", id: w.id }, 400);
		}
		if (item.tier === "manual" || item.tier === "done") {
			return c.json({ error: `"${item.title}" is ${item.tier === "done" ? "already done" : "a manual step"}.`, code: "not_applicable", id: w.id }, 400);
		}
		if (item.tier === "confirm" && w.confirm !== true) {
			return c.json({ error: `"${item.title}" changes something you have; confirm it to apply.`, code: "confirm_required", id: w.id }, 400);
		}
		chosen.push({ item, confirmed: w.confirm === true });
	}

	// DOMAINS/ZONES rows exist before any step looks them up.
	await store.seedDomains(getEnvZones(c.env), cloudflareRouteDeps.now());
	const by = actor(c);
	const role = auditActorRole(c.var.principal, null);
	const results = await applyPlan(plan.items, chosen, {
		client: s.client,
		recordChange: (input) => store.recordDnsChange({ ...input, appliedBy: by, now: cloudflareRouteDeps.now() }),
		audit: (detail) => recordAuditDeferred(c, { action: "cloudflare.dns_change", actor: by, actorRole: role, mailboxId: null, detail }),
		getDomain: (hostname) => store.getDomain(hostname),
		createDomain: async ({ hostname, zoneId }) => {
			const r = await store.createDomain({ hostname, zoneId, now: cloudflareRouteDeps.now() });
			if (r.ok) {
				await recordAuditDeferred(c, { action: "domain.change", actor: by, actorRole: role, mailboxId: null, target: hostname, detail: { op: "create" } });
			}
			return r.ok ? r.domain : null;
		},
		updateDomain: async (id, patch) => {
			await store.updateDomain(id, patch, cloudflareRouteDeps.now());
		},
		saveWorkerScriptName: async (name) => {
			const updated = await store.updateCloudflareConnection({ workerScriptName: name }, cloudflareRouteDeps.now());
			invalidateCloudflareConnectionCache();
			if (!updated) return false;
			s.setScriptName(name);
			return true;
		},
		semanticIndexName: s.ctx.semanticIndexName,
		now: () => cloudflareRouteDeps.now(),
	});
	invalidateDiscoveryCache();
	invalidateStoredDomains(c.env);
	const body: CfApplyResponse = { ok: results.every((r) => r.status === "ok"), results };
	return c.json(body);
});

// -- change log --------------------------------------------------------------------------

cloudflareSetupRoutes.get("/api/v1/cloudflare/changes", async (c: AppContext) => {
	const store = cloudflareSetupDeps.store(c);
	const limit = Number(c.req.query("limit") ?? 100);
	const zoneId = c.req.query("zoneId");
	if (zoneId !== undefined && !ZONE_ID.safeParse(zoneId).success) return c.json({ error: "zoneId must be a 32-character hex id" }, 400);
	const changes = await store.listDnsChanges(Number.isFinite(limit) ? limit : 100, zoneId);
	return c.json({ changes });
});

cloudflareSetupRoutes.post("/api/v1/cloudflare/changes/:id/revert", async (c: AppContext) => {
	const store = cloudflareSetupDeps.store(c);
	const stale = await needsFreshSession(c, store);
	if (stale) return stale;
	const id = c.req.param("id") ?? "";
	const change = await store.getDnsChange(id);
	if (!change) return c.json({ error: "Change not found" }, 404);
	if (change.revertedAt !== null) return c.json({ error: "Already reverted.", code: "already_reverted", change }, 409);
	const s = await session(c);
	if (s instanceof Response) return s;

	const by = actor(c);
	const claimed = await store.markDnsChangeReverted(id, by, cloudflareRouteDeps.now());
	if (!claimed) return c.json({ error: "Already reverted.", code: "already_reverted" }, 409);
	let detail: string;
	try {
		detail = await revertChange(s.client(), change);
	} catch (e) {
		await store.clearDnsChangeReverted(id);
		if (e instanceof RevertConflictError) return c.json({ error: e.message, code: "revert_conflict" }, 409);
		const msg = e instanceof Error ? e.message : String(e);
		return c.json({ error: msg, code: e instanceof CloudflareApiError ? "cloudflare_error" : "revert_failed" }, 502);
	}
	await recordAuditDeferred(c, {
		action: "cloudflare.revert",
		actor: by,
		actorRole: auditActorRole(c.var.principal, null),
		mailboxId: null,
		detail: { change: id, zone: change.zoneId, type: change.recordType, name: change.name, action: change.action },
	});
	invalidateDiscoveryCache();
	return c.json({ change: (await store.getDnsChange(id)) ?? claimed, detail });
});
