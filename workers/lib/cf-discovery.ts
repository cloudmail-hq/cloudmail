// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Read-only discovery of a Cloudflare account for onboarding: zones, their
 * mail DNS, Email Routing, catch-all and sending state, the Worker the
 * catch-all should target, and the semantic search Vectorize index. The pure
 * planner (`./setup-plan.ts`) turns the result into a plan.
 *
 * Nothing here writes. Bounds, so one request stays inside Workers'
 * subrequest limits and never hangs:
 *
 *   - zones are paged 50 at a time, at most `ZONE_CAP` (200);
 *   - at most `ZONE_CONCURRENCY` (6) zones are read at once;
 *   - every Cloudflare call has `CALL_TIMEOUT_MS`;
 *   - the zone list reads a summary (apex records + routing, 2 calls) for at
 *     most `SUMMARY_CAP` zones; the rest are listed by name only;
 *   - a full read (7 calls + SPF include lookups over DoH) is only done for
 *     the zones the admin chose, at most `MAX_PLAN_ZONES`.
 *
 * A failed call is reported on its zone (`error`, or `denied` for a 403),
 * never thrown. Any read that a tier decision depends on (DNS, routing,
 * catch-all) failing makes the zone's `error` set, so the planner turns the
 * whole zone into a manual item instead of guessing "nothing there".
 *
 * `GET /discover` is cached per isolate for `DISCOVERY_CACHE_MS` (60 s).
 * Plan and apply always read fresh.
 */

import type { CfCapabilityName } from "../../shared/cf-connection";
import type {
	CfDiscovery,
	CfRoutingRuleLite,
	CfSendingLite,
	DnsRecordLite,
	VectorizeDiscovery,
	WorkerDiscovery,
	ZoneDiscovery,
} from "../../shared/cf-setup";
import { CloudflareApiError, type CfDnsRecordFull, type CfRoutingRule, type CfZone, type CloudflareClient } from "./cloudflare-api";
import { VECTORIZE_INDEX_NAME } from "../../shared/semantic";
import { queryDns } from "./dns-audit";
import { classifyMxProvider, hasCfSpfInclude, isDmarc, isSpf, spfTerms, SEMANTIC_METADATA_PROPERTY, SPF_LOOKUP_LIMIT, txtText } from "./setup-plan";

export const ZONE_CAP = 200;
export const ZONE_PAGE_SIZE = 50;
export const ZONE_CONCURRENCY = 6;
export const CALL_TIMEOUT_MS = 8_000;
export const SUMMARY_CAP = 12;
export const MAX_PLAN_ZONES = 5;
export const DISCOVERY_CACHE_MS = 60_000;
/** Scripts whose settings are read when looking for this app's Worker. */
export const SCRIPT_SCAN_CAP = 10;
/** DoH queries one SPF lookup count may make. */
const SPF_QUERY_BUDGET = 6;
/** Default Vectorize index name; `DiscoveryContext.semanticIndexName` is the resolved one. */
export const SEMANTIC_INDEX_NAME = VECTORIZE_INDEX_NAME;
/** The Durable Object class that marks a Worker as this app. */
export const MAILBOX_DO_CLASS = "MailboxDO";

export interface DiscoveryContext {
	client: CloudflareClient;
	accountId: string | null;
	tokenSource: "env" | "connection";
	/** Hostnames already stored or configured here (lowercase). */
	managedHosts: Set<string>;
	/** Hostnames from DOMAINS/ZONES (lowercase). */
	envHosts: Set<string>;
	worker: { configured: string; source: WorkerDiscovery["source"]; canPersist: boolean };
	/** From the stored connection's probe. */
	missingCapabilities: CfCapabilityName[];
	/** Whether this deployment has a `SEMANTIC_INDEX` binding at all. */
	hasSemanticIndex: boolean;
	/** The index that binding names (`semanticIndexName(env)` in ../../shared/semantic). */
	semanticIndexName: string;
	/** For SPF include lookups. */
	dohFetch?: typeof fetch;
	now: number;
}

// -- small helpers ---------------------------------------------------------------

/** `fn` over `items`, at most `limit` at a time, results in input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]!, i);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function isDenied(e: unknown): boolean {
	return e instanceof CloudflareApiError && e.status === 403;
}

function isNotFound(e: unknown): boolean {
	return e instanceof CloudflareApiError && e.status === 404;
}

/** A 403 from Email Sending that is about the account's plan, not the token. */
export function isPlanError(e: unknown): boolean {
	if (!(e instanceof CloudflareApiError)) return false;
	const text = `${e.message} ${e.errors.map((x) => x.message).join(" ")}`;
	return (e.status === 403 || e.status === 400 || e.status === 402) && /\b(plan|paid|subscription|entitle|upgrade)/i.test(text);
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

export function liteRule(rule: CfRoutingRule): CfRoutingRuleLite {
	return {
		enabled: rule.enabled === true,
		matchers: (rule.matchers ?? []).map((m) => ({ ...m })),
		actions: (rule.actions ?? []).map((a) => ({ type: a.type, ...(a.value ? { value: [...a.value] } : {}) })),
		...(rule.name ? { name: rule.name } : {}),
	};
}

function emptyZone(zone: CfZone, ctx: DiscoveryContext, detail: ZoneDiscovery["detail"]): ZoneDiscovery {
	const name = zone.name.toLowerCase();
	return {
		zoneId: zone.id,
		name,
		status: zone.status ?? "unknown",
		...(zone.plan?.name ? { plan: zone.plan.name } : {}),
		...(zone.name_servers?.length ? { nameServers: zone.name_servers } : {}),
		managed: ctx.managedHosts.has(name),
		envDomain: ctx.envHosts.has(name),
		detail,
		routing: null,
		catchAll: null,
		catchAllToUs: false,
		sending: [],
		dns: { mx: [], spf: [], dmarc: [], tlsRpt: [], mtaSts: [] },
		mxProvider: "none",
		spfLookups: null,
		denied: [],
	};
}

function addError(z: ZoneDiscovery, text: string) {
	z.error = z.error ? `${z.error} ${text}` : text;
}

// -- SPF lookup count -----------------------------------------------------------------

/**
 * DNS lookups an SPF record costs (RFC 7208 §4.6.4), following `include:` and
 * `redirect=` over DoH. Stops counting once past the limit. Null when an
 * include could not be resolved or the query budget ran out.
 */
export async function countSpfLookups(content: string, dohFetch?: typeof fetch): Promise<number | null> {
	let count = 0;
	let queries = 0;
	const seen = new Set<string>();
	const walk = async (record: string): Promise<boolean> => {
		for (const raw of spfTerms(record)) {
			const term = raw.toLowerCase().replace(/^[+\-~?]/, "");
			const target = /^include:(.+)$/.exec(term)?.[1] ?? /^redirect=(.+)$/.exec(term)?.[1];
			if (target) {
				count++;
				if (count > SPF_LOOKUP_LIMIT) return true;
				if (target.includes("%") || seen.has(target)) continue;
				seen.add(target);
				if (++queries > SPF_QUERY_BUDGET) return false;
				let txt: string[];
				try {
					txt = await queryDns(target, "TXT", dohFetch);
				} catch {
					return false;
				}
				const child = txt.find((t) => isSpf(t));
				if (child && !(await walk(child))) return false;
				if (count > SPF_LOOKUP_LIMIT) return true;
			} else if (/^(a|mx|ptr|exists)([:/]|$)/.test(term)) {
				count++;
				if (count > SPF_LOOKUP_LIMIT) return true;
			}
		}
		return true;
	};
	return (await walk(txtText(content))) ? count : null;
}

// -- zones ------------------------------------------------------------------------

/** Every zone the token sees (scoped to the account when known), active first, capped. */
export async function listAllZones(client: CloudflareClient): Promise<{ zones: CfZone[]; total: number }> {
	const zones: CfZone[] = [];
	let total = 0;
	for (let page = 1; zones.length < ZONE_CAP; page++) {
		const res = await client.listZonesPage(page, ZONE_PAGE_SIZE);
		zones.push(...res.zones);
		total = Math.max(total, res.totalCount ?? zones.length);
		if (res.zones.length < ZONE_PAGE_SIZE) break;
	}
	const capped = zones.slice(0, ZONE_CAP);
	const rank = (z: CfZone) => (z.status === "active" ? 0 : 1);
	capped.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
	return { zones: capped, total: Math.max(total, capped.length) };
}

async function readApex(client: CloudflareClient, z: ZoneDiscovery): Promise<boolean> {
	try {
		const records = (await client.listDnsRecords(z.zoneId, { name: z.name })).map(lite);
		z.dns.mx = records.filter((r) => r.type === "MX");
		z.dns.spf = records.filter((r) => r.type === "TXT" && isSpf(r.content));
		z.mxProvider = classifyMxProvider(z.dns.mx);
		return true;
	} catch (e) {
		if (isDenied(e)) z.denied.push("dns.read");
		addError(z, isDenied(e) ? "The token can't read this zone's DNS records." : `DNS: ${message(e)}`);
		return false;
	}
}

async function readRouting(client: CloudflareClient, z: ZoneDiscovery): Promise<void> {
	try {
		const s = await client.getRoutingSettings(z.zoneId);
		z.routing = { enabled: s.enabled === true, status: s.status ?? (s.enabled ? "ready" : "unconfigured") };
	} catch (e) {
		if (isNotFound(e)) {
			z.routing = { enabled: false, status: "unconfigured" };
			return;
		}
		if (isDenied(e)) z.denied.push("routing");
		addError(z, isDenied(e) ? "The token can't read Email Routing on this zone." : `Email Routing: ${message(e)}`);
	}
}

async function readTxt(client: CloudflareClient, z: ZoneDiscovery, name: string, keep: (content: string) => boolean): Promise<DnsRecordLite[]> {
	try {
		return (await client.listDnsRecords(z.zoneId, { type: "TXT", name })).map(lite).filter((r) => keep(r.content));
	} catch (e) {
		if (isDenied(e) && !z.denied.includes("dns.read")) z.denied.push("dns.read");
		addError(z, `DNS ${name}: ${message(e)}`);
		return [];
	}
}

/** The summary the zone list shows: apex MX/SPF and routing state. */
async function summarizeZone(ctx: DiscoveryContext, zone: CfZone): Promise<ZoneDiscovery> {
	const z = emptyZone(zone, ctx, "summary");
	if (z.status !== "active") return z;
	await Promise.all([readApex(ctx.client, z), readRouting(ctx.client, z)]);
	return z;
}

/** Everything the planner needs about one zone. */
export async function readZoneFull(ctx: DiscoveryContext, zone: CfZone): Promise<ZoneDiscovery> {
	const z = emptyZone(zone, ctx, "full");
	if (z.status !== "active") return z;
	const client = ctx.client;
	const [, dmarc, tlsRpt, mtaSts] = await Promise.all([
		readApex(client, z),
		readTxt(client, z, `_dmarc.${z.name}`, isDmarc),
		readTxt(client, z, `_smtp._tls.${z.name}`, (c) => /^v=TLSRPTv1/i.test(txtText(c))),
		readTxt(client, z, `_mta-sts.${z.name}`, (c) => /^v=STSv1/i.test(txtText(c))),
		readRouting(client, z),
		(async () => {
			try {
				const rule = await client.getCatchAll(z.zoneId);
				z.catchAll = rule ? liteRule(rule) : null;
				z.catchAllToUs = client.isRuleToWorker(rule);
			} catch (e) {
				if (isDenied(e)) z.denied.push("routing.rules");
				addError(z, isDenied(e) ? "The token can't read Email Routing rules on this zone." : `Catch-all: ${message(e)}`);
			}
		})(),
		(async () => {
			try {
				const list = await client.listSendingSubdomains(z.zoneId);
				z.sending = (Array.isArray(list) ? list : []).map(
					(s): CfSendingLite => ({ tag: s.tag, name: s.name.toLowerCase(), enabled: s.enabled !== false }),
				);
			} catch (e) {
				if (isPlanError(e)) z.sendingPlanError = e instanceof CloudflareApiError && e.errors[0]?.message ? e.errors[0].message : message(e);
				else if (isDenied(e)) z.denied.push("sending");
				else z.sendingError = message(e);
			}
		})(),
	]);
	z.dns.dmarc = dmarc;
	z.dns.tlsRpt = tlsRpt;
	z.dns.mtaSts = mtaSts;
	// Only a record the planner might merge into needs counting (DoH calls are subrequests too).
	if (z.dns.spf.length === 1 && !hasCfSpfInclude(z.dns.spf[0]!.content)) z.spfLookups = await countSpfLookups(z.dns.spf[0]!.content, ctx.dohFetch);
	return z;
}

/**
 * Full reads for the chosen zones. A zone id the token cannot see (or on
 * another account) is returned in `invisible`, not read.
 */
export async function discoverZones(
	ctx: DiscoveryContext,
	zoneIds: string[],
): Promise<{ zones: ZoneDiscovery[]; invisible: string[] }> {
	const invisible: string[] = [];
	const results = await mapLimit(zoneIds, ZONE_CONCURRENCY, async (id) => {
		let zone: CfZone;
		try {
			zone = await ctx.client.getZone(id);
		} catch {
			invisible.push(id);
			return null;
		}
		if (!zone || zone.id !== id || (ctx.accountId && zone.account?.id && zone.account.id !== ctx.accountId)) {
			invisible.push(id);
			return null;
		}
		return readZoneFull(ctx, zone);
	});
	return { zones: results.filter((z): z is ZoneDiscovery => z !== null), invisible };
}

// -- account ---------------------------------------------------------------------

export async function discoverWorker(ctx: DiscoveryContext): Promise<{ worker: WorkerDiscovery; error?: string }> {
	const base: WorkerDiscovery = { ...ctx.worker, found: null, mailboxScripts: null };
	if (!ctx.accountId) return { worker: base, error: "No account id, so Workers were not checked." };
	let scripts: string[];
	try {
		scripts = (await ctx.client.listWorkerScripts()).map((s) => s.id).filter(Boolean);
	} catch (e) {
		return { worker: base, ...(isDenied(e) ? {} : { error: `Workers: ${message(e)}` }) };
	}
	if (scripts.includes(ctx.worker.configured)) return { worker: { ...base, found: true } };
	const scan = scripts.slice(0, SCRIPT_SCAN_CAP);
	const matches = await mapLimit(scan, ZONE_CONCURRENCY, async (name) => {
		try {
			const bindings = await ctx.client.getScriptBindings(name);
			// A binding with `script_name` points at another Worker's class; the
			// owner of MailboxDO is the one that defines it.
			const own = bindings.some(
				(b) => b.type === "durable_object_namespace" && b.class_name === MAILBOX_DO_CLASS && (!b.script_name || b.script_name === name),
			);
			return own ? name : null;
		} catch {
			return null;
		}
	});
	return { worker: { ...base, found: false, mailboxScripts: matches.filter((m): m is string => m !== null) } };
}

export async function discoverVectorize(ctx: DiscoveryContext): Promise<VectorizeDiscovery | null> {
	if (!ctx.hasSemanticIndex) return null;
	const out: VectorizeDiscovery = { indexName: ctx.semanticIndexName, index: "unknown", metadataIndex: "unknown" };
	if (!ctx.accountId) return out;
	try {
		const index = await ctx.client.getVectorizeIndex(ctx.semanticIndexName);
		out.index = index ? "present" : "missing";
		if (!index) return out;
		const meta = await ctx.client.listMetadataIndexes(ctx.semanticIndexName);
		out.metadataIndex = meta.some((m) => m.propertyName === SEMANTIC_METADATA_PROPERTY) ? "present" : "missing";
	} catch {
		// Unknown: the token_permission item (vectorize) explains a 403.
	}
	return out;
}

/** The zone list: every zone, a summary for the first `SUMMARY_CAP` active ones. */
export async function discoverAccount(ctx: DiscoveryContext): Promise<CfDiscovery> {
	const errors: string[] = [];
	const [zoneList, worker, vectorize] = await Promise.all([
		listAllZones(ctx.client).catch((e) => {
			errors.push(isDenied(e) ? "The token can't list zones (needs Zone Read)." : `Zones: ${message(e)}`);
			return { zones: [] as CfZone[], total: 0 };
		}),
		discoverWorker(ctx),
		discoverVectorize(ctx),
	]);
	if (worker.error) errors.push(worker.error);
	const zones = await mapLimit(zoneList.zones, ZONE_CONCURRENCY, (zone, i) =>
		i < SUMMARY_CAP ? summarizeZone(ctx, zone) : Promise.resolve(emptyZone(zone, ctx, "list")),
	);
	return {
		accountId: ctx.accountId,
		tokenSource: ctx.tokenSource,
		zones,
		zoneCount: zoneList.total,
		truncated: zoneList.total > zones.length,
		worker: worker.worker,
		vectorize: vectorize ?? { indexName: ctx.semanticIndexName, index: "unknown", metadataIndex: "unknown" },
		missingCapabilities: ctx.missingCapabilities,
		errors,
		discoveredAt: ctx.now,
	};
}

// -- cache ----------------------------------------------------------------------

const cache = new Map<string, { at: number; value: CfDiscovery }>();

export function cachedDiscovery(key: string, now: number): CfDiscovery | null {
	const hit = cache.get(key);
	if (hit && now - hit.at < DISCOVERY_CACHE_MS) return hit.value;
	if (hit) cache.delete(key);
	return null;
}

export function storeDiscovery(key: string, value: CfDiscovery, now: number): void {
	if (cache.size > 20) cache.clear();
	cache.set(key, { at: now, value });
}

/** After a token change or an apply. */
export function invalidateDiscoveryCache(): void {
	cache.clear();
}
