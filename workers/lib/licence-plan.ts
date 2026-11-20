/**
 * What the licence's plan allows: cloudmail sells Solo (one mail domain) and
 * Unlimited. The plan comes from the signed token (`planLimits` in the
 * vendored verifier); a token minted before plans existed is Unlimited, and
 * so is every deployment with enforcement off (the vendor's own, local dev).
 *
 * The domain limit is applied where a domain is ADDED: `POST /api/v1/domains`
 * (Settings, CLI, SDK) and the Cloudflare plan/apply flow (onboarding wizard,
 * Settings → Cloudflare). It never shrinks the served domain list: inbound
 * mail for every configured domain is always routed and stored, whatever the
 * plan. Domains past the limit (listed in `DOMAINS`, or kept after an upgrade
 * was refunded) are "not covered": they still receive mail, can't send, and
 * the Licence page says so.
 *
 * Which domains are covered: the oldest first (env domains that were never
 * stored count as oldest, in `DOMAINS` order), so adding a domain never moves
 * cover away from one already in use.
 */

import type { PlanItem } from "../../shared/cf-setup";
import { planLimits, type PlanLimits } from "../../shared/licence-token";
import type { Env } from "../types";
import { domainRpc, loadStoredDomains } from "../routes/domains";
import { enforcementMode, licenceState, type LicenceDeps } from "./licence";
import { domainOfAddress, getEnvZones, normalizeDomain } from "./zones";

/** In-app page with the plan, the limits and the Upgrade button. */
export const LICENCE_SETTINGS_PATH = "/settings/licence";

export const UNLIMITED: PlanLimits = { plan: "unlimited", max_domains: null, max_deployments: null };

/** The current plan's limits. Never throws: an unreadable state is not a reason to refuse a domain or a send here (the licence gate already handles a lock). */
export async function currentPlanLimits(env: Env, deps: LicenceDeps = {}): Promise<PlanLimits> {
	if (enforcementMode(env) === "off" && !deps.rpc) return UNLIMITED;
	try {
		const state = await licenceState(env, deps);
		if (state.enforcement === "off") return UNLIMITED;
		return planLimits(state.claims);
	} catch (e) {
		console.warn("licence plan unavailable:", (e as Error).message);
		return UNLIMITED;
	}
}

export interface DomainUsage {
	limits: PlanLimits;
	/** Every configured domain, oldest first. */
	domains: string[];
	/** The ones the plan covers. */
	covered: string[];
	/** Configured but past the plan's limit. They receive mail; they can't send. */
	notCovered: string[];
}

interface DomainRow {
	hostname: string;
	createdAt?: number;
}

/** Order domains oldest first; env domains with no row yet go first, in env order. */
export function orderDomains(envDomains: string[], rows: DomainRow[]): string[] {
	const created = new Map<string, number>();
	for (const r of rows) {
		const d = normalizeDomain(r.hostname);
		if (d && !created.has(d)) created.set(d, typeof r.createdAt === "number" ? r.createdAt : Number.MAX_SAFE_INTEGER);
	}
	const envIndex = new Map(envDomains.map((d, i) => [normalizeDomain(d), i]));
	const all = new Set<string>([...envIndex.keys(), ...created.keys()].filter(Boolean));
	return [...all].sort((a, b) => {
		const ca = created.get(a) ?? -1;
		const cb = created.get(b) ?? -1;
		if (ca !== cb) return ca - cb;
		const ea = envIndex.get(a) ?? Number.MAX_SAFE_INTEGER;
		const eb = envIndex.get(b) ?? Number.MAX_SAFE_INTEGER;
		if (ea !== eb) return ea - eb;
		return a < b ? -1 : a > b ? 1 : 0;
	});
}

export function splitByLimit(domains: string[], limits: PlanLimits): Pick<DomainUsage, "covered" | "notCovered"> {
	if (limits.max_domains === null) return { covered: domains, notCovered: [] };
	return { covered: domains.slice(0, limits.max_domains), notCovered: domains.slice(limits.max_domains) };
}

export interface DomainUsageDeps extends LicenceDeps {
	/** Stored domain rows (tests). Defaults to the AuthDO. */
	listDomains?: () => Promise<DomainRow[]>;
}

/** Configured domains and how the plan covers them. */
export async function domainUsage(env: Env, deps: DomainUsageDeps = {}, known?: PlanLimits): Promise<DomainUsage> {
	const limits = known ?? (await currentPlanLimits(env, deps));
	const envDomains = getEnvZones(env).map((z) => z.domain);
	let rows: DomainRow[] = [];
	if (deps.listDomains) rows = await deps.listDomains();
	else if ((env as { AUTH_STORE?: unknown }).AUTH_STORE) {
		await loadStoredDomains(env);
		rows = await domainRpc(env).listDomains();
	}
	const domains = orderDomains(envDomains, rows);
	return { limits, domains, ...splitByLimit(domains, limits) };
}

/** Usage on a domain-limited plan; null on Unlimited (and nothing is read). */
export async function limitedDomainUsage(env: Env, deps: DomainUsageDeps = {}): Promise<DomainUsage | null> {
	const limits = await currentPlanLimits(env, deps);
	return limits.max_domains === null ? null : domainUsage(env, deps, limits);
}

/** For an add: the refusal when `adding` doesn't fit the plan, else null. */
export async function refuseDomainAdd(env: Env, adding: string[], deps: DomainUsageDeps = {}): Promise<DomainLimitRefusal | null> {
	const usage = await limitedDomainUsage(env, deps);
	return usage ? checkDomainAllowance(usage, adding) : null;
}

export interface DomainLimitRefusal {
	error: string;
	code: "plan_domain_limit";
	plan: PlanLimits["plan"];
	maxDomains: number;
	used: number;
	upgradeUrl: string;
}

export function domainLimitMessage(maxDomains: number): string {
	const what = maxDomains === 1 ? "one mail domain" : `${maxDomains} mail domains`;
	return `Your cloudmail Solo licence covers ${what}. Upgrade to Unlimited in Settings → Licence to add more. Mail for your current domains keeps arriving either way.`;
}

/**
 * Whether `adding` (new hostnames) fits the plan. Hostnames already configured
 * don't count again. Returns null when it fits.
 */
export function checkDomainAllowance(usage: DomainUsage, adding: string[]): DomainLimitRefusal | null {
	const max = usage.limits.max_domains;
	if (max === null) return null;
	const have = new Set(usage.domains);
	const fresh = new Set(adding.map(normalizeDomain).filter((d) => d && !have.has(d)));
	if (fresh.size === 0 || usage.domains.length + fresh.size <= max) return null;
	return {
		error: domainLimitMessage(max),
		code: "plan_domain_limit",
		plan: usage.limits.plan,
		maxDomains: max,
		used: usage.domains.length,
		upgradeUrl: LICENCE_SETTINGS_PATH,
	};
}

/** How many more domains the plan allows. `null` = unlimited. */
export function remainingDomains(usage: DomainUsage): number | null {
	const max = usage.limits.max_domains;
	return max === null ? null : Math.max(0, max - usage.domains.length);
}

/**
 * For sends: refuse a From address on a domain the plan doesn't cover.
 * Only does any work on a domain-limited plan. Returns the message, or null.
 */
export async function uncoveredSenderDomain(env: Env, from: string, deps: DomainUsageDeps = {}): Promise<string | null> {
	const limits = await currentPlanLimits(env, deps);
	if (limits.max_domains === null) return null;
	const domain = domainOfAddress(from);
	if (!domain) return null;
	let usage: DomainUsage;
	try {
		usage = await domainUsage(env, deps, limits);
	} catch (e) {
		console.warn("domain usage unavailable:", (e as Error).message);
		return null;
	}
	if (!usage.notCovered.includes(normalizeDomain(domain))) return null;
	return `${domain} isn't covered by your cloudmail Solo licence, so it can receive mail but not send. Upgrade to Unlimited in Settings → Licence, or send from ${usage.covered[0] ?? "your main domain"}.`;
}

/**
 * The Cloudflare setup plan, cut to the plan's domain allowance. Zones that
 * would add a domain past it keep no steps but one manual item saying why, so
 * the review screen shows it and apply can't run it. Zones already in the app
 * are untouched. Applied before the plan is hashed, so plan and apply agree.
 */
export function limitPlanItems(items: PlanItem[], remaining: number | null, maxDomains: number | null): PlanItem[] {
	if (remaining === null || maxDomains === null) return items;
	const adding: string[] = [];
	for (const item of items) {
		if (item.kind === "add_domain" && item.tier !== "done" && item.tier !== "manual" && item.zoneId && !adding.includes(item.zoneId)) adding.push(item.zoneId);
	}
	const blocked = new Set(adding.slice(Math.max(0, remaining)));
	if (blocked.size === 0) return items;
	const out: PlanItem[] = [];
	for (const item of items) {
		if (!item.zoneId || !blocked.has(item.zoneId)) {
			out.push(item);
			continue;
		}
		if (item.kind !== "add_domain") continue;
		const host = item.hostname ?? "This domain";
		out.push({
			...item,
			tier: "manual",
			title: `${host} needs an Unlimited licence`,
			detail: domainLimitMessage(maxDomains),
			manualSteps: [`Upgrade to Unlimited in Settings → Licence.`, `Then come back here and review the plan for ${host} again.`],
			before: undefined,
			after: undefined,
			dependsOn: undefined,
		});
	}
	return out;
}
