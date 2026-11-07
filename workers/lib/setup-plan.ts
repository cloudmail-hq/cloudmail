// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The setup plan: what discovery found (`./cf-discovery.ts`) in, a list of
 * `PlanItem`s out. Pure: no I/O, no clock, so every safety rule is unit
 * tested on its own (`test/setup-plan.test.ts`).
 *
 * Tiers are the safety contract:
 *
 *   done     already in the desired state. Shown, never applied.
 *   auto     additive: touches no record or rule the user already has.
 *   confirm  changes or removes something the user has; applied only with
 *            `confirm: true` on that item. An item that depends on a confirm
 *            item is confirm too, so the UI never says "we'll do this" about
 *            something that waits on the user.
 *   manual   the API cannot or should not do it: exact dashboard steps.
 *
 * Rules (see docs in the PR and test/setup-plan.test.ts):
 *
 * - `enable_routing` is auto only with no MX at the apex other than
 *   Cloudflare's AND no `v=spf1` TXT other than one that already includes
 *   `_spf.mx.cloudflare.net`. Enabling adds Cloudflare's own SPF TXT, so with
 *   another SPF present the zone would publish two (PermError for all mail).
 * - Foreign MX: `mx_replace` (confirm) lists the exact records to delete.
 * - One SPF without the include: `spf_merge` (confirm) inserts it before the
 *   `all` term in the same record. Two or more SPF records, a merge that
 *   would pass 10 DNS lookups, or a lookup count we could not resolve: manual.
 * - `catch_all` is auto only when there is no rule and Email Routing was not
 *   enabled before (a brand-new mail domain). Any existing rule, including
 *   Cloudflare's default disabled drop, is confirm.
 * - `dmarc_create` only when no `v=DMARC1` exists, and only `p=none`.
 * - A zone that is not active, or whose state could not be read: manual.
 * - Email Sending refused for the plan: `plan_upgrade` (manual).
 * - The catch-all Worker: exactly one script with a `MailboxDO` binding is
 *   saved on the connection (auto); none or several is manual.
 * - A capability the token lacks: `token_permission` (manual) naming the
 *   exact permission group to add.
 * - Domains from DOMAINS/ZONES are live: every auto item on them is confirm.
 */

import type { CfCapabilityName } from "../../shared/cf-connection";
import type {
	CfRoutingRuleLite,
	DnsRecordLite,
	MxProvider,
	PlanItem,
	PlanItemKind,
	PlanTier,
	VectorizeDiscovery,
	WorkerDiscovery,
	ZoneDiscovery,
} from "../../shared/cf-setup";
import { CF_TOKEN_PERMISSION_GROUPS } from "../../shared/cf-token-template";
import { CF_MX_HOSTS, CF_SPF_INCLUDE } from "./dns-audit";

/** DMARC this app creates on a domain with none: monitor only. */
export const PLAN_DMARC = "v=DMARC1; p=none;";
/** RFC 7208 §4.6.4. */
export const SPF_LOOKUP_LIMIT = 10;
/** The metadata property semantic search filters on (workers/lib/semantic.ts). */
export const SEMANTIC_METADATA_PROPERTY = "mailbox";
/** Cloudflare's MX priorities when Email Routing adds them. */
const CF_MX_PRIORITIES = [13, 24, 86];
/** The pseudo record type a catch-all rule is shown and logged as. */
export const CATCH_ALL_TYPE = "CATCH_ALL";

export interface PlanInput {
	zones: ZoneDiscovery[];
	worker: WorkerDiscovery;
	vectorize: VectorizeDiscovery | null;
	/** Capabilities the token is known to lack (probe, or a 403 during discovery). */
	missingCapabilities: CfCapabilityName[];
	/** Link that creates a token with every permission (shared/cf-token-template.ts). */
	templateUrl: string;
}

// -- TXT and SPF helpers --------------------------------------------------------

/**
 * A TXT record's text: Cloudflare returns content quoted (`"v=spf1 …"`), in
 * one or more character-strings, or bare. Quoted chunks are joined.
 */
export function txtText(content: string): string {
	const trimmed = content.trim();
	const chunks = trimmed.match(/"((?:[^"\\]|\\.)*)"/g);
	if (!chunks || !trimmed.startsWith('"')) return trimmed;
	return chunks.map((c) => c.slice(1, -1).replace(/\\(.)/g, "$1")).join("");
}

/** Write `text` back in the form `original` used (quoted, split at 255, or bare). */
export function txtContentLike(original: string, text: string): string {
	if (!original.trim().startsWith('"')) return text;
	const parts: string[] = [];
	for (let i = 0; i < text.length; i += 255) parts.push(`"${text.slice(i, i + 255).replace(/(["\\])/g, "\\$1")}"`);
	return parts.join(" ") || '""';
}

export function isSpf(content: string): boolean {
	return /^v=spf1(\s|$)/i.test(txtText(content));
}

export function isDmarc(content: string): boolean {
	return /^v=DMARC1(\s*;|\s|$)/i.test(txtText(content));
}

export function hasCfSpfInclude(content: string): boolean {
	return txtText(content).toLowerCase().split(/\s+/).includes(CF_SPF_INCLUDE);
}

/** Terms after `v=spf1`. */
export function spfTerms(content: string): string[] {
	return txtText(content).trim().split(/\s+/).slice(1).filter(Boolean);
}

/** Terms that cost a DNS lookup (RFC 7208 §4.6.4), at the top level only. */
export function spfLookupTerms(content: string): string[] {
	return spfTerms(content).filter((t) => {
		const m = t.toLowerCase().replace(/^[+\-~?]/, "");
		return /^(include:|exists:|redirect=)/.test(m) || /^(a|mx|ptr)([:/]|$)/.test(m);
	});
}

/**
 * The record with the Cloudflare include added before the `all` term (or a
 * `redirect=` modifier), else at the end. Qualifiers and order are kept.
 */
export function mergeSpfInclude(content: string): string {
	const terms = spfTerms(content);
	const at = terms.findIndex((t) => /^[+\-~?]?all$/i.test(t) || /^redirect=/i.test(t));
	const out = [...terms];
	out.splice(at === -1 ? out.length : at, 0, CF_SPF_INCLUDE);
	return txtContentLike(content, ["v=spf1", ...out].join(" "));
}

// -- MX helpers ---------------------------------------------------------------

function mxHost(r: DnsRecordLite): string {
	// Cloudflare's API keeps priority separate; DoH-style content may carry it.
	const parts = r.content.trim().split(/\s+/);
	return (parts.length > 1 && /^\d+$/.test(parts[0]!) ? parts[1]! : parts[0]!).replace(/\.$/, "").toLowerCase();
}

export function isCloudflareMx(r: DnsRecordLite): boolean {
	return CF_MX_HOSTS.includes(mxHost(r));
}

export function classifyMxProvider(mx: DnsRecordLite[]): MxProvider {
	if (mx.length === 0) return "none";
	const foreign = mx.filter((r) => !isCloudflareMx(r));
	if (foreign.length === 0) return "cloudflare";
	const hosts = foreign.map(mxHost);
	if (hosts.every((h) => /(^|\.)(google|googlemail)\.com$/.test(h))) return "google";
	if (hosts.every((h) => /\.mail\.protection\.outlook\.com$|\.outlook\.com$/.test(h))) return "microsoft";
	if (hosts.every((h) => /(^|\.)zoho(mail)?\.[a-z.]+$/.test(h))) return "zoho";
	return "other";
}

const PROVIDER_NAMES: Record<MxProvider, string> = {
	cloudflare: "Cloudflare Email Routing",
	google: "Google Workspace",
	microsoft: "Microsoft 365",
	zoho: "Zoho Mail",
	other: "another mail provider",
	none: "nobody",
};

export function providerName(p: MxProvider): string {
	return PROVIDER_NAMES[p];
}

/** The MX records Email Routing adds at `name`. */
export function cloudflareMxRecords(name: string): DnsRecordLite[] {
	return CF_MX_HOSTS.map((host, i) => ({ type: "MX", name, content: host, priority: CF_MX_PRIORITIES[i] ?? 10 }));
}

// -- catch-all helpers ----------------------------------------------------------

export function catchAllRecord(name: string, rule: CfRoutingRuleLite): DnsRecordLite {
	return { type: CATCH_ALL_TYPE, name, content: describeRule(rule) };
}

function describeRule(rule: CfRoutingRuleLite): string {
	const target = rule.actions.map((a) => `${a.type}${a.value?.length ? ` ${a.value.join(", ")}` : ""}`).join("; ") || "none";
	return `${rule.enabled ? "enabled" : "disabled"}: ${target}`;
}

// -- capabilities ---------------------------------------------------------------

/** Which permission group grants each capability (names from the token template). */
export const CAPABILITY_PERMISSION: Record<CfCapabilityName, string> = {
	"zones.read": "Zone Read",
	"dns.read": "DNS Write",
	"dns.write": "DNS Write",
	routing: "Zone Settings Write",
	"routing.rules": "Email Routing Rules Write",
	sending: "Email Sending Write",
	analytics: "Account Analytics Read",
	dmarc: "Email Security DMARC Reports Read",
	vectorize: "Vectorize Write",
	"workers.scripts": "Workers Scripts Read",
};

const CAPABILITY_USE: Record<CfCapabilityName, string> = {
	"zones.read": "list your domains",
	"dns.read": "read and add DNS records",
	"dns.write": "add DMARC and SPF records",
	routing: "turn on Email Routing",
	"routing.rules": "point the catch-all at this app",
	sending: "set up sending domains",
	analytics: "show email analytics",
	dmarc: "show DMARC reports",
	vectorize: "add the semantic search metadata index",
	"workers.scripts": "check the Worker the catch-all delivers to",
};

function permissionScope(name: string): "zone" | "account" {
	return /^(Zone Read|DNS Write|Zone Settings Write|Email Routing Rules Write|Analytics Read|Email Security DMARC Reports Read)$/.test(name)
		? "zone"
		: "account";
}

// -- the planner -----------------------------------------------------------------

const ZONE_KIND_ORDER: PlanItemKind[] = [
	"zone_pending",
	"zone_error",
	"add_domain",
	"spf_merge",
	"mx_replace",
	"enable_routing",
	"catch_all",
	"sending_domain",
	"plan_upgrade",
	"dmarc_create",
	"dmarc_tighten",
	"dmarc_reports",
	"mta_sts",
	"tls_rpt",
];

export function zoneItemId(zoneId: string, kind: PlanItemKind): string {
	return `${zoneId}:${kind}`;
}

/** Build the plan. Deterministic: same input, same items in the same order. */
export function buildSetupPlan(input: PlanInput): PlanItem[] {
	const items: PlanItem[] = [];
	const missing = new Set(input.missingCapabilities);
	for (const z of input.zones) for (const d of z.denied) missing.add(d);

	items.push(...tokenPermissionItems([...missing], input.templateUrl));
	const workerItem = workerNameItem(input.worker);
	if (workerItem) items.push(workerItem);
	const vecItem = vectorizeItem(input.vectorize);
	if (vecItem) items.push(vecItem);

	for (const zone of input.zones) items.push(...zoneItems(zone, workerItem, missing));
	return items;
}

function tokenPermissionItems(missing: CfCapabilityName[], templateUrl: string): PlanItem[] {
	const order = Object.keys(CAPABILITY_PERMISSION) as CfCapabilityName[];
	return order
		.filter((c) => missing.includes(c))
		.map((cap) => {
			const permission = CAPABILITY_PERMISSION[cap];
			const group = CF_TOKEN_PERMISSION_GROUPS.find((g) => g.name === permission);
			const scope = permissionScope(permission);
			return {
				id: `account:token_permission:${cap}`,
				zoneId: null,
				hostname: null,
				kind: "token_permission" as const,
				tier: "manual" as const,
				title: `Add the "${permission}" permission to the token`,
				detail: `The token can't ${CAPABILITY_USE[cap]}. Steps that need it are listed as manual until it is added.`,
				manualSteps: [
					`Cloudflare dashboard → Manage account → Account API tokens (or My Profile → API Tokens for a user token) → edit this token.`,
					`Add permission: ${scope === "zone" ? "Zone" : "Account"} → ${permission.replace(/ (Read|Write)$/, "")} → ${/Write$/.test(permission) ? "Edit" : "Read"}${group ? ` (id ${group.id})` : ""}.`,
					scope === "zone" ? `Under Zone Resources, include the domains you want to set up (or all zones).` : `Under Account Resources, include this account.`,
					`Save, then press Re-check here. Or create a fresh token from the template: ${templateUrl}`,
				],
			};
		});
}

function workerNameItem(w: WorkerDiscovery): PlanItem | null {
	const base = { id: "account:worker_name", zoneId: null, hostname: null, kind: "worker_name" as const };
	if (w.found === null) return null; // Scripts not listable: the token_permission item covers it.
	if (w.found) {
		return { ...base, tier: "done", title: `The catch-all target Worker "${w.configured}" exists`, detail: "Email Routing delivers to this Worker." };
	}
	const scripts = w.mailboxScripts ?? [];
	if (w.source === "env") {
		return {
			...base,
			tier: "manual",
			title: `WORKER_SCRIPT_NAME is "${w.configured}", but no Worker has that name`,
			detail: "The WORKER_SCRIPT_NAME variable always wins, so it has to name this Worker.",
			manualSteps: [
				scripts.length === 1
					? `Set WORKER_SCRIPT_NAME to "${scripts[0]}" in the Worker's variables (or remove it), then redeploy.`
					: `Set WORKER_SCRIPT_NAME to this Worker's name (Workers & Pages → this app → name at the top), then redeploy.`,
				"Press Re-check here.",
			],
		};
	}
	if (scripts.length === 1 && w.canPersist) {
		return {
			...base,
			tier: "auto",
			title: `Use the Worker "${scripts[0]}" as the catch-all target`,
			detail: `No Worker is named "${w.configured}". "${scripts[0]}" is the only Worker with this app's mailbox storage, so the catch-all will deliver to it. Saved on the Cloudflare connection; WORKER_SCRIPT_NAME still wins if set later.`,
			after: [{ type: "WORKER", name: "catch-all target", content: scripts[0]! }],
		};
	}
	return {
		...base,
		tier: "manual",
		title: `Couldn't tell which Worker is this app`,
		detail:
			scripts.length === 0
				? `No Worker is named "${w.configured}", and none has this app's MailboxDO storage.`
				: `No Worker is named "${w.configured}", and several have this app's MailboxDO storage: ${scripts.join(", ")}.`,
		manualSteps: [
			"Find this app's Worker name: Workers & Pages → the Worker that serves this site.",
			"Set the WORKER_SCRIPT_NAME variable to that name (Settings → Variables), then redeploy.",
			"Press Re-check here.",
		],
	};
}

function vectorizeItem(v: VectorizeDiscovery | null): PlanItem | null {
	if (!v || v.index === "unknown") return null;
	const base = { id: "account:vectorize_metadata_index", zoneId: null, hostname: null, kind: "vectorize_metadata_index" as const };
	if (v.index === "missing") {
		return {
			...base,
			tier: "manual",
			title: `Create the Vectorize index "${v.indexName}"`,
			detail: "Semantic search needs this index. Without it search is full-text only.",
			manualSteps: [
				`npx wrangler vectorize create ${v.indexName} --dimensions=1024 --metric=cosine`,
				`npx wrangler vectorize create-metadata-index ${v.indexName} --property-name=${SEMANTIC_METADATA_PROPERTY} --type=string`,
				"Redeploy, then press Re-check here.",
			],
		};
	}
	if (v.metadataIndex === "present") {
		return { ...base, tier: "done", title: "The semantic search index is ready", detail: `"${v.indexName}" has the ${SEMANTIC_METADATA_PROPERTY} metadata index.` };
	}
	if (v.metadataIndex === "unknown") return null;
	return {
		...base,
		tier: "auto",
		title: "Add the metadata index semantic search filters on",
		detail: `"${v.indexName}" has no "${SEMANTIC_METADATA_PROPERTY}" metadata index, so vectors can't be filtered per mailbox. Vectors inserted before this exists stay unfilterable.`,
	};
}

interface SpfDecision {
	state: "absent" | "has_include" | "mergeable" | "multiple" | "too_many_lookups" | "lookups_unknown";
	record?: DnsRecordLite;
	merged?: string;
	lookups?: number;
}

/** What to do about the apex SPF record(s). */
export function spfDecision(spf: DnsRecordLite[], existingLookups: number | null): SpfDecision {
	if (spf.length === 0) return { state: "absent" };
	if (spf.length > 1) return { state: "multiple" };
	const record = spf[0]!;
	if (hasCfSpfInclude(record.content)) return { state: "has_include", record };
	const topLevel = spfLookupTerms(record.content).length;
	if (existingLookups === null && topLevel > 0) return { state: "lookups_unknown", record };
	// Cloudflare's include costs one lookup; its own record is ip4 only.
	const lookups = Math.max(existingLookups ?? 0, topLevel) + 1;
	if (lookups > SPF_LOOKUP_LIMIT) return { state: "too_many_lookups", record, lookups };
	return { state: "mergeable", record, merged: mergeSpfInclude(record.content), lookups };
}

function zoneItems(zone: ZoneDiscovery, workerItem: PlanItem | null, missing: Set<CfCapabilityName>): PlanItem[] {
	const host = zone.name.toLowerCase();
	const id = (kind: PlanItemKind) => zoneItemId(zone.zoneId, kind);
	const out: PlanItem[] = [];
	const add = (kind: PlanItemKind, tier: PlanTier, rest: Omit<PlanItem, "id" | "zoneId" | "hostname" | "kind" | "tier">) =>
		out.push({ id: id(kind), zoneId: zone.zoneId, hostname: host, kind, tier, ...rest });

	if (zone.status !== "active") {
		add("zone_pending", "manual", {
			title: `Finish adding ${host} to Cloudflare`,
			detail: `The zone is "${zone.status}". Cloudflare can't route mail for it until its nameservers point at Cloudflare.`,
			manualSteps: [
				`At your domain registrar, set the nameservers for ${host} to: ${zone.nameServers?.length ? zone.nameServers.join(", ") : "the two shown in the Cloudflare dashboard → " + host + " → Overview"}.`,
				"Wait for Cloudflare to mark the zone Active (minutes to a day).",
				"Press Re-check here.",
			],
		});
		return out;
	}
	if (zone.detail !== "full" || zone.error) {
		add("zone_error", "manual", {
			title: `Couldn't read ${host}'s mail settings`,
			detail: zone.error ?? "Only a summary was read for this zone.",
			manualSteps: ["Check the token can read this zone (see the permission items above), then press Re-check."],
		});
		return out;
	}

	// DOMAINS/ZONES domains are live: nothing on them happens without a confirm.
	const autoTier: PlanTier = zone.envDomain ? "confirm" : "auto";
	const liveNote = zone.envDomain ? " This domain is configured in DOMAINS/ZONES and live, so it needs your confirmation." : "";
	const dnsWritable = !missing.has("dns.read");

	// -- add_domain
	if (zone.managed) {
		add("add_domain", "done", { title: `${host} is set up in this app`, detail: "The domain is already in Settings → Domains." });
	} else {
		add("add_domain", "auto", { title: `Add ${host} to this app`, detail: "Adds the domain to Settings → Domains so mailboxes can be created on it." });
	}

	const mx = zone.dns.mx;
	const foreignMx = mx.filter((r) => !isCloudflareMx(r));
	const spf = spfDecision(zone.dns.spf, zone.spfLookups ?? null);
	const routingReady = !!zone.routing?.enabled && zone.routing.status === "ready";
	const routingWasEnabled = !!zone.routing?.enabled;
	const provider = zone.mxProvider;

	// -- spf_merge (before enabling routing, so the zone never has two)
	let spfBlocks = false;
	const spfDeps: string[] = [];
	if (!routingReady || spf.state !== "absent") {
		if (spf.state === "multiple") {
			spfBlocks = !routingReady;
			add("spf_merge", "manual", {
				title: `${host} has ${zone.dns.spf.length} SPF records`,
				detail: "Two or more v=spf1 records make SPF fail for every message (PermError). Merge them into one record by hand.",
				before: zone.dns.spf,
				manualSteps: [
					`Dashboard → ${host} → DNS → Records: find the TXT records at ${host} that start with v=spf1.`,
					`Combine their include:/ip4:/ip6: terms into ONE record ending in a single ~all or -all, and add ${CF_SPF_INCLUDE}.`,
					"Delete the other v=spf1 records, then press Re-check here.",
				],
			});
		} else if (spf.state === "too_many_lookups" || spf.state === "lookups_unknown") {
			spfBlocks = !routingReady;
			add("spf_merge", "manual", {
				title: `Add Cloudflare to ${host}'s SPF record by hand`,
				detail:
					spf.state === "too_many_lookups"
						? `Adding ${CF_SPF_INCLUDE} would make the record need ${spf.lookups} DNS lookups; SPF allows ${SPF_LOOKUP_LIMIT}, after which every check fails.`
						: `Couldn't count the DNS lookups the record's includes need, so it can't be checked against SPF's limit of ${SPF_LOOKUP_LIMIT}.`,
				before: [spf.record!],
				manualSteps: [
					`Dashboard → ${host} → DNS → Records → the TXT record at ${host} starting with v=spf1.`,
					`Remove includes for services you no longer use (or flatten them to ip4:/ip6:), then add ${CF_SPF_INCLUDE} before the all term.`,
					"Press Re-check here.",
				],
			});
		} else if (spf.state === "mergeable") {
			const r = spf.record!;
			if (!dnsWritable) spfBlocks = !routingReady;
			add("spf_merge", dnsWritable ? "confirm" : "manual", {
				title: `Add Cloudflare to ${host}'s SPF record`,
				detail: `Adds ${CF_SPF_INCLUDE} to the existing record (same record, nothing else changes; ${spf.lookups} of ${SPF_LOOKUP_LIMIT} lookups). Without it, turning on Email Routing would publish a second SPF record and SPF would fail for all mail.`,
				before: [r],
				after: [{ ...r, content: spf.merged! }],
				...(dnsWritable ? {} : { manualSteps: [`Edit the TXT record at ${host} to: ${txtText(spf.merged!)}`, "Press Re-check here."] }),
			});
			if (dnsWritable) spfDeps.push(id("spf_merge"));
		}
	}

	// -- mx_replace
	const mxDeps: string[] = [];
	if (foreignMx.length > 0 && !routingReady) {
		add("mx_replace", dnsWritable ? "confirm" : "manual", {
			title: `Move ${host}'s mail from ${providerName(provider)} to this app`,
			detail: `Deletes the ${foreignMx.length} MX record(s) below so Email Routing can receive mail. Mail for ${host} stops going to ${providerName(provider)} as soon as this runs. Back up or migrate that mailbox first; you can restore the records from the change log.`,
			before: foreignMx,
			after: cloudflareMxRecords(host),
			...(dnsWritable ? {} : { manualSteps: [`Delete the MX records at ${host} that point to ${providerName(provider)}.`, "Press Re-check here."] }),
		});
		if (dnsWritable) mxDeps.push(id("mx_replace"));
	}

	// -- enable_routing
	const domainDep = zone.managed ? [] : [id("add_domain")];
	const routingBlocked = spfBlocks || (foreignMx.length > 0 && !dnsWritable) || missing.has("routing");
	if (routingReady) {
		add("enable_routing", "done", { title: `Email Routing is on for ${host}`, detail: "Cloudflare receives mail for this domain." });
	} else if (routingBlocked) {
		add("enable_routing", "manual", {
			title: `Turn on Email Routing for ${host}`,
			detail: missing.has("routing")
				? "The token can't change Email Routing settings."
				: "Waits on the manual SPF or MX step above, so the zone never ends up with two SPF records.",
			manualSteps: [
				"Finish the step above first.",
				`Dashboard → ${host} → Email → Email Routing → Enable, or press Re-check here and let this app do it.`,
			],
		});
	} else {
		const deps = [...domainDep, ...spfDeps, ...mxDeps];
		const tier: PlanTier = spfDeps.length || mxDeps.length ? "confirm" : autoTier;
		add("enable_routing", tier, {
			title: `Turn on Email Routing for ${host}`,
			detail:
				(tier === "confirm" && (spfDeps.length || mxDeps.length)
					? "Runs after the change(s) above. "
					: "") +
				`Cloudflare adds its MX records${spf.state === "absent" ? ", an SPF record" : ""} and a DKIM key at ${host}. ${foreignMx.length === 0 && mx.length === 0 ? "No mail goes anywhere else today, so nothing changes for existing mail." : ""}`.trim() +
				liveNote,
			after: [
				...cloudflareMxRecords(host),
				...(spf.state === "absent" ? [{ type: "TXT", name: host, content: `v=spf1 ${CF_SPF_INCLUDE} ~all` }] : []),
			],
			...(deps.length ? { dependsOn: deps } : {}),
		});
	}

	// -- catch_all
	const workerBlocked = workerItem?.tier === "manual";
	const workerDep = workerItem?.tier === "auto" ? [workerItem.id] : [];
	const routingDep = routingReady ? [] : [id("enable_routing")];
	if (zone.catchAllToUs) {
		add("catch_all", "done", { title: `Mail to any address at ${host} reaches this app`, detail: "The catch-all rule delivers to this Worker." });
	} else if (missing.has("routing.rules") || workerBlocked || (routingBlocked && !routingReady)) {
		add("catch_all", "manual", {
			title: `Send mail for every address at ${host} to this app`,
			detail: missing.has("routing.rules")
				? "The token can't edit Email Routing rules."
				: workerBlocked
					? "Waits on the Worker name step above."
					: "Waits on turning on Email Routing.",
			...(zone.catchAll ? { before: [catchAllRecord(host, zone.catchAll)] } : {}),
			manualSteps: [
				`Dashboard → ${host} → Email → Email Routing → Routing rules → Catch-all address.`,
				`Action "Send to a Worker" → this app's Worker → Save, and make sure it is enabled.`,
			],
		});
	} else {
		const isNew = zone.catchAll === null && !routingWasEnabled;
		const routingConfirm = out.find((i) => i.id === id("enable_routing"))?.tier === "confirm";
		const tier: PlanTier = isNew ? (routingConfirm ? "confirm" : autoTier) : "confirm";
		add("catch_all", tier, {
			title: `Send mail for every address at ${host} to this app`,
			detail: isNew
				? `Turns on the catch-all rule for this new mail domain. Mail to addresses with no mailbox, alias or catch-all mailbox is dropped instead of bounced.${liveNote}`
				: `Replaces the current catch-all rule (below). Mail to unknown addresses at ${host} then comes here, and is dropped instead of bounced unless a catch-all mailbox is set. The old rule is saved and can be restored from the change log.`,
			...(zone.catchAll ? { before: [catchAllRecord(host, zone.catchAll)] } : {}),
			after: [{ type: CATCH_ALL_TYPE, name: host, content: "enabled: worker (this app)" }],
			dependsOn: [...domainDep, ...routingDep, ...workerDep],
		});
	}

	// -- sending
	const existing = zone.sending.find((s) => s.name.toLowerCase() === host);
	if (zone.sendingPlanError) {
		add("plan_upgrade", "manual", {
			title: `Email Sending isn't available on this account's plan`,
			detail: `Cloudflare said: ${zone.sendingPlanError}. Sending mail from ${host} needs the Workers Paid plan.`,
			manualSteps: [
				"Dashboard → Workers & Pages → Plans → upgrade to Workers Paid.",
				"Press Re-check here. Receiving works without it.",
			],
		});
	} else if (existing) {
		add("sending_domain", "done", {
			title: `${host} is set up for sending`,
			detail: existing.enabled ? "Email Sending is enabled." : "The sending domain exists but Cloudflare reports it disabled.",
		});
	} else if (missing.has("sending") || (foreignMx.length > 0 && !routingReady && !mxDeps.length)) {
		add("sending_domain", "manual", {
			title: `Set up ${host} for sending`,
			detail: missing.has("sending")
				? "The token can't manage Email Sending."
				: `Cloudflare refuses while ${providerName(provider)}'s MX records are on ${host}; waits on the MX step above.`,
			manualSteps: [`Dashboard → Email → Email Sending → Add domain → ${host}.`, "Press Re-check here."],
		});
	} else {
		const tier: PlanTier = mxDeps.length ? "confirm" : autoTier;
		add("sending_domain", tier, {
			title: `Set up ${host} for sending`,
			detail: `Adds ${host} to Email Sending; Cloudflare adds its bounce MX, SPF and DKIM records under cf-bounce.${host}.${mxDeps.length ? ` Cloudflare refuses while ${providerName(provider)}'s MX records are on ${host}, so this runs after replacing them.` : ""}${liveNote}`,
			dependsOn: [...domainDep, ...mxDeps],
		});
	}

	// -- DMARC
	const dmarc = zone.dns.dmarc;
	if (dmarc.length === 0) {
		add("dmarc_create", dnsWritable ? autoTier : "manual", {
			title: `Add a DMARC record for ${host}`,
			detail: `${host} has no DMARC record. This adds one in monitor mode (p=none): nothing is rejected, it only tells receivers the domain is managed.${liveNote}`,
			after: [{ type: "TXT", name: `_dmarc.${host}`, content: PLAN_DMARC }],
			...(dnsWritable ? {} : { manualSteps: [`Add TXT _dmarc.${host} = "${PLAN_DMARC}".`, "Press Re-check here."] }),
		});
	} else if (dmarc.length > 1) {
		add("dmarc_create", "manual", {
			title: `${host} has ${dmarc.length} DMARC records`,
			detail: "Receivers ignore DMARC when there is more than one record. Keep one.",
			before: dmarc,
			manualSteps: [`Dashboard → ${host} → DNS → Records: delete all but one TXT record at _dmarc.${host}.`, "Press Re-check here."],
		});
	} else {
		add("dmarc_create", "done", { title: `${host} has a DMARC record`, detail: "Kept as it is.", before: dmarc });
	}
	const hasRua = dmarc.some((r) => /(^|;)\s*rua=/i.test(txtText(r.content)));
	if (dmarc.length <= 1 && !hasRua) {
		add("dmarc_reports", "manual", {
			title: `Collect DMARC reports for ${host}`,
			detail: "Optional. With reports you see who sends mail as this domain before tightening the policy.",
			manualSteps: [`Dashboard → ${host} → Email → DMARC Management → Enable. It adds a reporting address to the DMARC record.`],
		});
	}

	// -- optional hardening
	if (zone.dns.mtaSts.length === 0) {
		add("mta_sts", "manual", {
			title: `MTA-STS for ${host} (optional)`,
			detail: "Tells senders to require TLS when delivering to this domain.",
			manualSteps: ["See https://developers.cloudflare.com/email-routing/ and RFC 8461 for the _mta-sts TXT record and policy file."],
		});
	} else {
		add("mta_sts", "done", { title: `${host} publishes MTA-STS`, detail: "Kept as it is." });
	}
	if (zone.dns.tlsRpt.length === 0) {
		add("tls_rpt", "manual", {
			title: `TLS reporting for ${host} (optional)`,
			detail: "Senders report TLS delivery failures to an address you choose.",
			manualSteps: [`Add TXT _smtp._tls.${host} = "v=TLSRPTv1; rua=mailto:<an address you read>".`],
		});
	} else {
		add("tls_rpt", "done", { title: `${host} publishes TLS reporting`, detail: "Kept as it is." });
	}

	return out.sort((a, b) => ZONE_KIND_ORDER.indexOf(a.kind) - ZONE_KIND_ORDER.indexOf(b.kind));
}

// -- plan hash -------------------------------------------------------------------

function canonicalRecord(r: DnsRecordLite): string {
	return [r.id ?? "", r.type.toUpperCase(), r.name.toLowerCase(), r.content, r.priority ?? ""].join("\u0001");
}

/** The part of the plan the user approved: each item's tier and exact `before` records. */
export function planHashInput(items: PlanItem[]): string {
	return [...items]
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		.map((i) => `${i.id}\u0002${i.tier}\u0002${(i.before ?? []).map(canonicalRecord).sort().join("\u0003")}`)
		.join("\n");
}

/** SHA-256 (hex, first 32 chars) of `planHashInput`. */
export async function planHash(items: PlanItem[]): Promise<string> {
	const bytes = new TextEncoder().encode(planHashInput(items));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** Item ids in an order where every dependency comes first (input order otherwise). */
export function dependencyOrder(items: PlanItem[]): PlanItem[] {
	const byId = new Map(items.map((i) => [i.id, i]));
	const out: PlanItem[] = [];
	const state = new Map<string, "visiting" | "done">();
	const visit = (item: PlanItem) => {
		const s = state.get(item.id);
		if (s === "done" || s === "visiting") return; // A cycle would be a planner bug; break it rather than loop.
		state.set(item.id, "visiting");
		for (const dep of item.dependsOn ?? []) {
			const d = byId.get(dep);
			if (d) visit(d);
		}
		state.set(item.id, "done");
		out.push(item);
	};
	items.forEach(visit);
	return out;
}
