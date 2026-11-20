// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Apply a setup plan (`./setup-plan.ts`) item by item.
 *
 * The caller has already recomputed the plan from fresh discovery and checked
 * the plan hash, the zone list and per-item confirmation
 * (`workers/routes/cloudflare-setup.ts`). This module only runs the chosen
 * items in dependency order and reports each one; a failure is a result, not
 * a throw, and the items that depend on it are skipped.
 *
 * Every DNS record created, updated or deleted, and every catch-all rule
 * overwritten, goes into the change log (`./dns-change-log.ts`) with the
 * exact before/after, plus an audit entry, so each can be reverted.
 *
 * Routing, catch-all and sending reuse `provisionDomain` one step at a time
 * (`only`), so the Cloudflare calls and their error hints stay in one place.
 * The MX/SPF decision was made by the planner: by the time `enable_routing`
 * runs, `spf_merge` / `mx_replace` have already run (they are dependencies).
 */

import type { ApplyItemResult, CfDnsChange, DnsRecordLite, PlanItem } from "../../shared/cf-setup";
import type { CfDnsRecordFull, CfRoutingRule, CloudflareClient } from "./cloudflare-api";
import { CF_SPF_INCLUDE, ROUTING_DKIM_SELECTOR } from "./dns-audit";
import { provisionDomain } from "./domain-provision";
import type { DomainDetailRecord, DomainPatch, DomainRecord } from "./domain-store";
import type { RecordDnsChangeInput } from "./dns-change-log";
import { liteRule } from "./cf-discovery";
import { PLAN_DMARC, SEMANTIC_METADATA_PROPERTY, catchAllRecord, dependencyOrder, hasCfSpfInclude, isCloudflareMx, isSpf, txtText } from "./setup-plan";

export interface ApplyDeps {
	/** A client targeting the current catch-all Worker name. Called again after `worker_name`. */
	client: () => CloudflareClient;
	recordChange(input: Omit<RecordDnsChangeInput, "appliedBy" | "now">): Promise<CfDnsChange>;
	audit(detail: Record<string, string | number | boolean | null>): Promise<void>;
	getDomain(hostname: string): Promise<DomainDetailRecord | null>;
	createDomain(input: { hostname: string; zoneId: string }): Promise<DomainRecord | null>;
	updateDomain(id: string, patch: DomainPatch): Promise<void>;
	/** Persist a detected Worker name on the connection; false when there is no stored connection. */
	saveWorkerScriptName(name: string): Promise<boolean>;
	/** The Vectorize index the `SEMANTIC_INDEX` binding names. */
	semanticIndexName: string;
	now: () => number;
}

export interface ApplyRequestItem {
	item: PlanItem;
	confirmed: boolean;
}

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function lite(r: CfDnsRecordFull): DnsRecordLite {
	return {
		id: r.id,
		type: r.type.toUpperCase(),
		name: r.name.toLowerCase(),
		content: r.content,
		...(typeof r.priority === "number" ? { priority: r.priority } : {}),
		...(typeof r.ttl === "number" ? { ttl: r.ttl } : {}),
	};
}

/** Cloudflare's own SPF, as Email Routing adds it. */
function isCloudflareOnlySpf(content: string): boolean {
	return txtText(content).trim().toLowerCase().replace(/\s+/g, " ") === `v=spf1 ${CF_SPF_INCLUDE} ~all`;
}

class ItemError extends Error {}

/**
 * Run `chosen` (already validated) in dependency order. `plan` is the whole
 * recomputed plan, used to tell a dependency that is already done from one
 * that was not chosen.
 */
export async function applyPlan(plan: PlanItem[], chosen: ApplyRequestItem[], deps: ApplyDeps): Promise<ApplyItemResult[]> {
	const byId = new Map(plan.map((i) => [i.id, i]));
	const chosenIds = new Set(chosen.map((c) => c.item.id));
	const results = new Map<string, ApplyItemResult>();
	let client = deps.client();

	for (const item of dependencyOrder(chosen.map((c) => c.item))) {
		const blocked = (item.dependsOn ?? []).find((dep) => {
			const d = byId.get(dep);
			if (!d || d.tier === "done") return false;
			return results.get(dep)?.status !== "ok";
		});
		if (blocked) {
			const d = byId.get(blocked)!;
			results.set(item.id, {
				id: item.id,
				status: "skipped",
				detail: chosenIds.has(blocked) ? `Skipped: "${d.title}" didn't complete.` : `Skipped: needs "${d.title}" too.`,
			});
			continue;
		}
		const changeIds: string[] = [];
		const log = async (input: Omit<RecordDnsChangeInput, "appliedBy" | "now" | "planItem" | "zoneId" | "zoneName">) => {
			const change = await deps.recordChange({ ...input, planItem: item.id, zoneId: item.zoneId ?? "account", zoneName: item.hostname });
			changeIds.push(change.id);
			await deps.audit({
				item: item.id,
				kind: item.kind,
				zone: item.zoneId,
				type: input.recordType,
				name: input.name,
				action: input.action,
				change: change.id,
			});
		};
		try {
			const detail = await runItem(item, { client, deps, log, setClient: (c) => (client = c) });
			results.set(item.id, { id: item.id, status: "ok", detail, ...(changeIds.length ? { changeIds } : {}) });
		} catch (e) {
			results.set(item.id, { id: item.id, status: "error", detail: message(e), ...(changeIds.length ? { changeIds } : {}) });
		}
	}
	await markActiveDomains(plan, results, deps);
	// Results in the order the plan lists them.
	return chosen.map((c) => results.get(c.item.id)!).filter(Boolean);
}

interface RunCtx {
	client: CloudflareClient;
	deps: ApplyDeps;
	log: (input: Omit<RecordDnsChangeInput, "appliedBy" | "now" | "planItem" | "zoneId" | "zoneName">) => Promise<void>;
	setClient: (c: CloudflareClient) => void;
}

async function runItem(item: PlanItem, ctx: RunCtx): Promise<string> {
	const { client, deps } = ctx;
	const zoneId = item.zoneId!;
	const host = item.hostname!;
	switch (item.kind) {
		case "worker_name": {
			const name = item.after?.[0]?.content;
			if (!name) throw new ItemError("No Worker name in the plan.");
			if (!(await deps.saveWorkerScriptName(name))) throw new ItemError("There is no stored Cloudflare connection to save the Worker name on.");
			ctx.setClient(deps.client());
			await deps.audit({ item: item.id, kind: item.kind, zone: null, type: "worker_name", name, action: "update", change: null });
			return `The catch-all now targets "${name}".`;
		}
		case "vectorize_metadata_index": {
			const index = deps.semanticIndexName;
			await client.createMetadataIndex(index, SEMANTIC_METADATA_PROPERTY, "string");
			await deps.audit({ item: item.id, kind: item.kind, zone: null, type: "vectorize", name: index, action: "create", change: null });
			return `Added the "${SEMANTIC_METADATA_PROPERTY}" metadata index to ${index}.`;
		}
		case "add_domain": {
			const existing = await deps.getDomain(host);
			if (existing) return `${host} was already added.`;
			const created = await deps.createDomain({ hostname: host, zoneId });
			if (!created) return `${host} was already added.`;
			return `Added ${host}.`;
		}
		case "spf_merge": {
			const before = item.before?.[0];
			const after = item.after?.[0];
			if (!before?.id || !after) throw new ItemError("The plan has no SPF record to update.");
			const current = (await client.listDnsRecords(zoneId, { type: "TXT", name: host })).filter((r) => isSpf(r.content));
			const live = current.find((r) => r.id === before.id);
			if (current.length !== 1 || !live || live.content !== before.content) {
				throw new ItemError("The SPF record changed since the plan was made. Re-check and review again.");
			}
			const updated = await client.updateDnsRecord(zoneId, before.id, {
				type: "TXT",
				name: live.name,
				content: after.content,
				...(typeof live.ttl === "number" ? { ttl: live.ttl } : {}),
			});
			await ctx.log({ recordType: "TXT", name: host, action: "update", before: lite(live), after: lite(updated) });
			await verifySingleSpf(client, zoneId, host);
			return `Added ${CF_SPF_INCLUDE} to the SPF record.`;
		}
		case "mx_replace": {
			const wanted = item.before ?? [];
			const current = await client.listDnsRecords(zoneId, { type: "MX", name: host });
			// A foreign MX added since the plan was made would be left next to Cloudflare's.
			const wantedIds = new Set(wanted.map((r) => r.id));
			const extra = current.filter((r) => !isCloudflareMx(lite(r)) && !wantedIds.has(r.id));
			if (extra.length) {
				throw new ItemError(`New MX record(s) appeared since the plan was made (${extra.map((r) => r.content).join(", ")}). Re-check and review again.`);
			}
			for (const r of wanted) {
				const live = current.find((c) => c.id === r.id);
				if (!live) continue; // Already gone.
				if (live.content.toLowerCase() !== r.content.toLowerCase()) {
					throw new ItemError(`The MX record ${r.content} changed since the plan was made. Re-check and review again.`);
				}
			}
			let deleted = 0;
			for (const r of wanted) {
				const live = current.find((c) => c.id === r.id);
				if (!live) continue;
				await client.deleteDnsRecord(zoneId, live.id);
				await ctx.log({ recordType: "MX", name: host, action: "delete", before: lite(live), after: null });
				deleted++;
			}
			return `Deleted ${deleted} MX record(s). Email Routing adds its own next.`;
		}
		case "enable_routing": {
			const domain = await requireDomain(deps, host);
			const names = [host, `${ROUTING_DKIM_SELECTOR}._domainkey.${host}`];
			const snapshot = async () => (await Promise.all(names.map((n) => client.listDnsRecords(zoneId, { name: n })))).flat();
			const beforeRecords = await snapshot();
			const beforeIds = new Set(beforeRecords.map((r) => r.id));
			// Re-check live: no foreign MX left, and at most one SPF that already
			// includes Cloudflare. Otherwise enabling would split mail delivery or
			// publish a second SPF record.
			const apex = beforeRecords.filter((r) => r.name.toLowerCase() === host.toLowerCase());
			const foreignMx = apex.filter((r) => r.type.toUpperCase() === "MX" && !isCloudflareMx(lite(r)));
			if (foreignMx.length) {
				throw new ItemError(`${host} still has MX records for another provider (${foreignMx.map((r) => r.content).join(", ")}). Re-check and review again.`);
			}
			const liveSpf = apex.filter((r) => r.type.toUpperCase() === "TXT" && isSpf(r.content));
			if (liveSpf.length > 1 || (liveSpf.length === 1 && !hasCfSpfInclude(liveSpf[0]!.content))) {
				throw new ItemError(`${host}'s SPF record changed since the plan was made; turning on Email Routing now would leave two SPF records. Re-check and review again.`);
			}
			const out = await provisionDomain(client, { ...domain, zoneId }, { only: ["routing"], now: deps.now() });
			await savePatch(deps, domain, out.patch, ["routingStatus"]);
			// Log what Cloudflare added, so a revert can remove it.
			const added = (await snapshot()).filter((r) => !beforeIds.has(r.id));
			for (const r of added) await ctx.log({ recordType: r.type.toUpperCase(), name: r.name, action: "create", before: null, after: lite(r) });
			const step = out.result.steps.find((s) => s.step === "routing");
			if (step?.status === "error") throw new ItemError(step.detail);
			// Enabling may add Cloudflare's own SPF next to a merged one: drop that duplicate.
			const spf = (await client.listDnsRecords(zoneId, { type: "TXT", name: host })).filter((r) => isSpf(r.content));
			if (spf.length > 1) {
				const merged = spf.find((r) => beforeIds.has(r.id) && hasCfSpfInclude(r.content));
				const dup = spf.filter((r) => !beforeIds.has(r.id) && isCloudflareOnlySpf(r.content));
				if (merged && dup.length === spf.length - 1) {
					for (const r of dup) {
						await client.deleteDnsRecord(zoneId, r.id);
						await ctx.log({ recordType: "TXT", name: host, action: "delete", before: lite(r), after: null });
					}
				}
			}
			await verifySingleSpf(client, zoneId, host);
			return step?.detail ?? "Email Routing is on.";
		}
		case "catch_all": {
			const domain = await requireDomain(deps, host);
			const current = await client.getCatchAll(zoneId);
			let overwrite: boolean;
			if (item.tier === "confirm") {
				// The hash pinned the rule the admin saw; refuse if it moved since.
				const seen = item.before?.[0]?.content ?? null;
				const now = current ? catchAllRecord(host, liteRule(current)).content : null;
				// No rule at plan time: only Cloudflare's default (added when routing was just enabled) may be there now.
				const appearedDefault = seen === null && current !== null && isDefaultCatchAll(current);
				if (seen !== now && !appearedDefault && !client.isRuleToWorker(current)) {
					throw new ItemError("The catch-all rule changed since the plan was made. Re-check and review again.");
				}
				overwrite = true;
			} else {
				// Auto: a brand-new mail domain. Enabling routing just now may have
				// created Cloudflare's default disabled drop rule; only that may go.
				if (current && !client.isRuleToWorker(current) && !isDefaultCatchAll(current)) {
					throw new ItemError("A catch-all rule appeared since the plan was made. Re-check and review again.");
				}
				overwrite = true;
			}
			const out = await provisionDomain(client, { ...domain, zoneId }, {
				only: ["catch_all"],
				overwriteCatchAll: overwrite,
				now: deps.now(),
			});
			const step = out.result.steps.find((s) => s.step === "catch_all");
			if (out.previousCatchAll !== undefined) {
				await ctx.log({
					recordType: "catch_all",
					name: host,
					action: out.previousCatchAll ? "update" : "create",
					before: out.previousCatchAll ? liteRule(out.previousCatchAll) : null,
					after: out.newCatchAll ? liteRule(out.newCatchAll as CfRoutingRule) : null,
				});
			}
			if (!step || step.status === "error") throw new ItemError(step?.detail ?? "Catch-all failed.");
			if (step.status !== "ok") throw new ItemError(step.detail);
			return step.detail;
		}
		case "sending_domain": {
			const domain = await requireDomain(deps, host);
			const out = await provisionDomain(client, { ...domain, zoneId }, { only: ["sending", "sending_dns"], now: deps.now() });
			await savePatch(deps, domain, out.patch, ["sendingSubdomainId", "sendingStatus", "sendingDns", "dkim"]);
			const step = out.result.steps.find((s) => s.step === "sending");
			if (step?.status === "error") throw new ItemError(step.detail);
			await deps.audit({ item: item.id, kind: item.kind, zone: zoneId, type: "sending", name: host, action: "create", change: null });
			return step?.detail ?? "Sending domain ready.";
		}
		case "dmarc_create": {
			const name = `_dmarc.${host}`;
			const current = (await client.listDnsRecords(zoneId, { type: "TXT", name })).filter((r) => /^v=DMARC1/i.test(txtText(r.content)));
			if (current.length > 0) return "A DMARC record already exists; left as it is.";
			const created = await client.createDnsRecord(zoneId, { type: "TXT", name, content: PLAN_DMARC, ttl: 3600 });
			await ctx.log({ recordType: "TXT", name, action: "create", before: null, after: lite(created) });
			return `Added ${PLAN_DMARC} at ${name}.`;
		}
		default:
			throw new ItemError(`"${item.kind}" can't be applied from here.`);
	}
}

/** Cloudflare's starting rule: disabled, match all, drop. */
export function isDefaultCatchAll(rule: CfRoutingRule): boolean {
	return (
		rule.enabled !== true &&
		(rule.matchers ?? []).length === 1 &&
		rule.matchers[0]!.type === "all" &&
		(rule.actions ?? []).length === 1 &&
		rule.actions[0]!.type === "drop"
	);
}

async function requireDomain(deps: ApplyDeps, host: string): Promise<DomainDetailRecord> {
	const d = await deps.getDomain(host);
	if (!d) throw new ItemError(`${host} isn't in this app yet; add the domain first.`);
	return d;
}

async function savePatch(deps: ApplyDeps, domain: DomainDetailRecord, patch: DomainPatch, keys: (keyof DomainPatch)[]) {
	const out: DomainPatch = {};
	for (const k of keys) if (patch[k] !== undefined) (out as Record<string, unknown>)[k] = patch[k];
	if (patch.zoneId && !domain.zoneId) out.zoneId = patch.zoneId;
	if (Object.keys(out).length) await deps.updateDomain(domain.id, out);
}

/** Exactly one `v=spf1` at the apex, or the item fails with what is there. */
export async function verifySingleSpf(client: CloudflareClient, zoneId: string, host: string): Promise<void> {
	const spf = (await client.listDnsRecords(zoneId, { type: "TXT", name: host })).filter((r) => isSpf(r.content));
	if (spf.length !== 1) {
		throw new ItemError(
			`${host} now has ${spf.length} SPF records (${spf.map((r) => txtText(r.content)).join(" | ") || "none"}). Merge them into one in the dashboard; until then SPF fails.`,
		);
	}
}

/** A zone whose routing, catch-all and sending are all ok or done becomes `active`. */
async function markActiveDomains(plan: PlanItem[], results: Map<string, ApplyItemResult>, deps: ApplyDeps) {
	const zones = new Map<string, string>();
	for (const i of plan) if (i.zoneId && i.hostname) zones.set(i.zoneId, i.hostname);
	for (const [zoneId, host] of zones) {
		const kinds = ["enable_routing", "catch_all", "sending_domain"] as const;
		const ready = kinds.every((k) => {
			const item = plan.find((i) => i.zoneId === zoneId && i.kind === k);
			if (!item) return false;
			return item.tier === "done" || results.get(item.id)?.status === "ok";
		});
		const touched = plan.some((i) => i.zoneId === zoneId && results.get(i.id)?.status === "ok");
		if (!ready || !touched) continue;
		const d = await deps.getDomain(host).catch(() => null);
		if (d && d.status !== "active") await deps.updateDomain(d.id, { status: "active", lastError: null }).catch(() => {});
	}
}

// -- revert ----------------------------------------------------------------------

export class RevertConflictError extends Error {}

/** Content and priority still what apply left. */
function sameRecord(live: CfDnsRecordFull, after: DnsRecordLite): boolean {
	return live.content === after.content && (live.priority ?? null) === (after.priority ?? null);
}

/** The disabled drop rule Cloudflare starts every zone with. */
const DEFAULT_CATCH_ALL = { enabled: false, matchers: [{ type: "all" }], actions: [{ type: "drop" }] };

function sameRule(a: unknown, b: unknown): boolean {
	const norm = (r: any) => JSON.stringify({ enabled: !!r?.enabled, actions: r?.actions ?? [], matchers: r?.matchers ?? [] });
	return norm(a) === norm(b);
}

/**
 * Put back what `change` replaced. Refuses (RevertConflictError) when the
 * record or rule no longer matches what apply left, so a later edit by the
 * user is never overwritten.
 */
export async function revertChange(client: CloudflareClient, change: CfDnsChange): Promise<string> {
	const zoneId = change.zoneId;
	if (change.recordType === "catch_all") {
		const current = await client.getCatchAll(zoneId);
		if (change.after && (!current || !sameRule(liteRule(current), change.after))) {
			throw new RevertConflictError("The catch-all rule was changed since; left as it is.");
		}
		const before = (change.before as CfRoutingRule | null) ?? DEFAULT_CATCH_ALL;
		await client.putCatchAll(zoneId, before);
		return change.before ? "Restored the previous catch-all rule." : "Turned the catch-all back off.";
	}
	const before = change.before as DnsRecordLite | null;
	const after = change.after as DnsRecordLite | null;
	const name = (after ?? before)?.name ?? change.name;
	const current = await client.listDnsRecords(zoneId, { type: change.recordType, name });
	switch (change.action) {
		case "create": {
			const live = current.find((r) => r.id === after?.id);
			if (!live) return "The record was already removed.";
			if (!sameRecord(live, after!)) throw new RevertConflictError("The record was edited since; left as it is.");
			await client.deleteDnsRecord(zoneId, live.id);
			return `Deleted the ${change.recordType} record at ${name}.`;
		}
		case "delete": {
			if (!before) throw new Error("Nothing recorded to restore.");
			if (current.some((r) => r.content.toLowerCase() === before.content.toLowerCase() && (r.priority ?? null) === (before.priority ?? null))) {
				return "The record is already back.";
			}
			// Never bring back a second SPF record (e.g. the duplicate Cloudflare added and apply removed).
			if (before.type.toUpperCase() === "TXT" && isSpf(before.content) && current.some((r) => isSpf(r.content))) {
				throw new RevertConflictError(`${name} already has an SPF record; restoring this one would make two.`);
			}
			await client.createDnsRecord(zoneId, {
				type: before.type,
				name: before.name,
				content: before.content,
				...(typeof before.priority === "number" ? { priority: before.priority } : {}),
				...(typeof before.ttl === "number" ? { ttl: before.ttl } : {}),
			});
			return `Restored the ${change.recordType} record at ${name}.`;
		}
		case "update": {
			if (!before || !after?.id) throw new Error("Nothing recorded to restore.");
			const live = current.find((r) => r.id === after.id);
			if (!live) throw new RevertConflictError("The record was deleted since; nothing to restore onto.");
			if (!sameRecord(live, after)) throw new RevertConflictError("The record was edited since; left as it is.");
			await client.updateDnsRecord(zoneId, live.id, {
				type: before.type,
				name: live.name,
				content: before.content,
				...(typeof live.ttl === "number" ? { ttl: live.ttl } : {}),
			});
			return `Restored the previous ${change.recordType} record at ${name}.`;
		}
	}
}
