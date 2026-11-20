// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Zone (domain) configuration for multi-domain support.
 *
 * A single Worker deployment serves several Cloudflare zones. Mailboxes are
 * keyed by their full email address, so the zone a mailbox belongs to is
 * always derivable from the address itself — there is no separate mapping to
 * keep in sync.
 *
 * Two config sources, in precedence order:
 *   1. `ZONES`   — JSON array, allows a display name and zone ID per domain
 *   2. `DOMAINS` — comma-separated domain list (legacy, still supported)
 *
 * `DOMAINS` remains the source of truth for deployments that predate `ZONES`,
 * so existing configs keep working untouched.
 */

import type { Env } from "../types";

export interface Zone {
	/** Stable identifier — the domain, which is unique per deployment. */
	id: string;
	/** Domain name, e.g. "example.com". */
	domain: string;
	/** Display name shown in the UI. Defaults to the domain. */
	name: string;
	/** Cloudflare zone ID. Informational only; not required for routing. */
	zoneId?: string;
}

interface RawZone {
	domain?: string;
	id?: string;
	name?: string;
	zoneId?: string;
}

/** Normalise a domain for comparison: lowercase, trimmed, no leading "@" or dot. */
export function normalizeDomain(domain: string): string {
	return domain.trim().toLowerCase().replace(/^[@.]+/, "");
}

/** Extract the domain part of an email address, normalised. Empty if malformed. */
export function domainOfAddress(address: string): string {
	const at = address.lastIndexOf("@");
	if (at === -1 || at === address.length - 1) return "";
	return normalizeDomain(address.slice(at + 1));
}

function parseZonesVar(raw: string): Zone[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Malformed ZONES must not take the deployment down — fall back to DOMAINS.
		console.error("ZONES is not valid JSON; falling back to DOMAINS");
		return [];
	}
	if (!Array.isArray(parsed)) {
		console.error("ZONES must be a JSON array; falling back to DOMAINS");
		return [];
	}

	const zones: Zone[] = [];
	for (const entry of parsed as RawZone[]) {
		const domain = normalizeDomain(String(entry?.domain ?? entry?.id ?? ""));
		if (!domain) continue;
		zones.push({
			id: domain,
			domain,
			name: entry?.name?.trim() || domain,
			...(entry?.zoneId ? { zoneId: entry.zoneId } : {}),
		});
	}
	return zones;
}

function parseDomainsVar(raw: string): Zone[] {
	return raw
		.split(",")
		.map(normalizeDomain)
		.filter(Boolean)
		.map((domain) => ({ id: domain, domain, name: domain }));
}

/**
 * Zones from environment configuration only, de-duplicated by domain and
 * order-stable.
 *
 * Zones from `ZONES` win over `DOMAINS` entries for the same domain so a
 * display name can be layered onto an existing `DOMAINS` list without
 * removing it.
 */
export function getEnvZones(env: Env): Zone[] {
	const fromZones = env.ZONES ? parseZonesVar(env.ZONES) : [];
	const fromDomains = env.DOMAINS ? parseDomainsVar(env.DOMAINS) : [];

	const byDomain = new Map<string, Zone>();
	for (const zone of [...fromZones, ...fromDomains]) {
		if (!byDomain.has(zone.domain)) byDomain.set(zone.domain, zone);
	}
	return [...byDomain.values()];
}

/** The slice of a stored domain row the zone list needs. */
export interface StoredDomainLike {
	hostname: string;
	displayName: string;
	zoneId: string | null;
}

/**
 * Union of env zones and stored domains, env first and order-stable.
 *
 * For a domain in both, the env entry keeps its position but a stored display
 * name or zone id fills in what env left unset, so an operator can edit a
 * `DOMAINS`-seeded domain in the UI without touching wrangler config.
 */
export function mergeZones(envZones: Zone[], stored: StoredDomainLike[]): Zone[] {
	const byDomain = new Map<string, Zone>();
	for (const zone of envZones) byDomain.set(zone.domain, { ...zone });
	for (const row of stored) {
		const domain = normalizeDomain(row.hostname);
		if (!domain) continue;
		const existing = byDomain.get(domain);
		if (existing) {
			if (existing.name === existing.domain && row.displayName && row.displayName !== domain) {
				existing.name = row.displayName;
			}
			if (!existing.zoneId && row.zoneId) existing.zoneId = row.zoneId;
			continue;
		}
		byDomain.set(domain, {
			id: domain,
			domain,
			name: row.displayName || domain,
			...(row.zoneId ? { zoneId: row.zoneId } : {}),
		});
	}
	return [...byDomain.values()];
}

/**
 * Stored domains, cached per isolate.
 *
 * `getZones` is synchronous and called from dozens of places, so the database
 * half of the union is read ahead of time by `refreshStoredDomains` (from the
 * API middleware and the email handler) and kept here. Keyed by the AuthDO
 * binding so separate environments and tests never share an entry.
 */
const storedDomainCache = new WeakMap<object, { at: number; domains: StoredDomainLike[] }>();

/** How long a cached read stays fresh. Writes in this isolate invalidate at once. */
export const STORED_DOMAINS_TTL_MS = 30_000;

function cacheKey(env: Env): object {
	return ((env as { AUTH_STORE?: object }).AUTH_STORE ?? env) as object;
}

/** Replace the cached stored-domain list (also used by tests). */
export function setStoredDomains(env: Env, domains: StoredDomainLike[], now = Date.now()): void {
	storedDomainCache.set(cacheKey(env), { at: now, domains });
}

/** Drop the cache so the next `refreshStoredDomains` reads the database. */
export function invalidateStoredDomains(env: Env): void {
	storedDomainCache.delete(cacheKey(env));
}

/**
 * Load stored domains into the cache when it is stale. Never throws: a failed
 * read leaves the previous (or empty) list, so env domains keep working even if
 * the AuthDO is unreachable.
 */
export async function refreshStoredDomains(
	env: Env,
	load: () => Promise<StoredDomainLike[]>,
	now = Date.now(),
	/**
	 * `strict`: rethrow a failed load instead of backing off. The inbound path
	 * uses it, because deciding a DB domain is unserved would route on the
	 * wrong address; a thrown error makes Cloudflare retry instead.
	 */
	options: { strict?: boolean } = {},
): Promise<void> {
	const hit = storedDomainCache.get(cacheKey(env));
	if (hit && now - hit.at < STORED_DOMAINS_TTL_MS) return;
	try {
		setStoredDomains(env, await load(), now);
	} catch (e) {
		// A stale list from an earlier load is still a sound answer; only having
		// none at all is a reason to refuse.
		if (options.strict && !hit) throw e;
		console.error("Failed to load stored domains:", (e as Error).message);
		// Back off for a TTL rather than retrying on every request.
		setStoredDomains(env, hit?.domains ?? [], now);
	}
}

/**
 * Every zone this deployment serves: env `ZONES`/`DOMAINS` plus domains added
 * through `/api/v1/domains`. The stored half is whatever
 * `refreshStoredDomains` last loaded.
 */
export function getZones(env: Env): Zone[] {
	const stored = storedDomainCache.get(cacheKey(env))?.domains ?? [];
	return mergeZones(getEnvZones(env), stored);
}

/** Configured domains as a plain list. */
export function getDomains(env: Env): string[] {
	return getZones(env).map((z) => z.domain);
}

/**
 * Whether a domain is served by this deployment.
 *
 * Returns true when no zones are configured at all: a deployment with empty
 * config should not have every request rejected, and local development often
 * runs without `DOMAINS` set.
 */
export function isDomainAllowed(env: Env, domain: string): boolean {
	const domains = getDomains(env);
	if (domains.length === 0) return true;
	return domains.includes(normalizeDomain(domain));
}

/** Whether an email address sits on a domain served by this deployment. */
export function isAddressAllowed(env: Env, address: string): boolean {
	const domain = domainOfAddress(address);
	if (!domain) return false;
	return isDomainAllowed(env, domain);
}
