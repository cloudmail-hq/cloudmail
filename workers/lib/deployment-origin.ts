/**
 * The public origin of THIS deployment, for work that has no request in hand:
 * cron and alarm sends (tracking and unsubscribe links), Web Push's VAPID
 * subject, product logo URLs in templates, the AI gateway's own-host guard.
 *
 * Resolution order:
 *   1. `APP_URL`, when it is a valid http(s) URL (configuration wins).
 *   2. The origin persisted in the AuthDO (`0024_deployment_origin`), recorded
 *      from trusted requests.
 *   3. Nothing (`null`). Callers must then skip whatever needs an origin.
 *      There is deliberately no hard-coded host: a customer deployment that
 *      fell back to the vendor's host would send its recipients' clicks and
 *      unsubscribes to someone else's server.
 *
 * Recording. Only requests that proved who they are count: a signed-in
 * browser session (or a verified Cloudflare Access identity), plus the
 * `/setup` request that creates the owner. Anonymous traffic (tracking
 * pixels, unsubscribe pages, a login attempt) never writes it, so a forged
 * `Host` header on an unauthenticated request cannot poison it.
 *
 * Ranking. An https custom domain (rank 2) beats an https `*.workers.dev`
 * host (rank 1), which beats localhost (rank 0, local dev only). Any other
 * plain-http origin is ignored. A lower rank never replaces a higher one, and
 * the same rank replaces only when the origin changed (the deployment moved).
 *
 * Cost. Reads are cached per isolate for `ORIGIN_CACHE_MS`. Writes are skipped
 * while the isolate already knows the stored origin is at least as good, so a
 * busy session costs no RPC after the first request.
 */

import type { Env } from "../types";

export interface DeploymentOriginRpc {
	getDeploymentOrigin(): Promise<{ origin: string; rank: number } | null>;
	recordDeploymentOrigin(origin: string, rank: number, source: string, now: number): Promise<{ origin: string; changed: boolean }>;
}

export const ORIGIN_CACHE_MS = 60_000;

/** Rank of a candidate origin, or null when it must never be recorded. */
export function originRank(raw: string | null | undefined): { origin: string; rank: number } | null {
	if (!raw) return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	const host = url.hostname.toLowerCase();
	const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
	if (local && (url.protocol === "http:" || url.protocol === "https:")) return { origin: url.origin, rank: 0 };
	if (url.protocol !== "https:") return null;
	if (host === "workers.dev" || host.endsWith(".workers.dev")) return { origin: url.origin, rank: 1 };
	return { origin: url.origin, rank: 2 };
}

/** `APP_URL` as an origin, or null when unset or not a valid http(s) URL. */
export function configuredOrigin(env: Pick<Env, "APP_URL">): string | null {
	const value = env.APP_URL?.trim();
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
	} catch {
		return null;
	}
}

interface CacheEntry {
	value: { origin: string; rank: number } | null;
	at: number;
}

/** Per-isolate cache, keyed by the AuthDO namespace so tests never share it. */
const cache = new WeakMap<object, CacheEntry>();

function cacheKey(env: Env): object {
	return ((env as { AUTH_STORE?: object }).AUTH_STORE ?? env) as object;
}

export function defaultOriginRpc(env: Env): DeploymentOriginRpc | null {
	const ns = (env as unknown as { AUTH_STORE?: Partial<DurableObjectNamespace> }).AUTH_STORE;
	if (!ns || typeof ns.idFromName !== "function" || typeof ns.get !== "function") return null;
	const stub = ns.get(ns.idFromName("global")) as unknown as Partial<DeploymentOriginRpc>;
	// A stub without the methods (an older test double) means "not available".
	return typeof stub?.getDeploymentOrigin === "function" ? (stub as DeploymentOriginRpc) : null;
}

export interface OriginDeps {
	rpc?: DeploymentOriginRpc | null;
	now?: () => number;
}

async function stored(env: Env, deps: OriginDeps): Promise<{ origin: string; rank: number } | null> {
	const now = deps.now?.() ?? Date.now();
	const key = cacheKey(env);
	const hit = cache.get(key);
	if (hit && now - hit.at < ORIGIN_CACHE_MS) return hit.value;
	const rpc = deps.rpc === undefined ? defaultOriginRpc(env) : deps.rpc;
	if (!rpc) return null;
	try {
		const value = await rpc.getDeploymentOrigin();
		cache.set(key, { value, at: now });
		return value;
	} catch (e) {
		console.error("deployment origin lookup failed:", (e as Error).message);
		// A stale value beats none; nothing cached means unknown.
		return hit?.value ?? null;
	}
}

/**
 * This deployment's public origin (no trailing slash), or null when none is
 * known. Never throws.
 */
export async function deploymentOrigin(env: Env, deps: OriginDeps = {}): Promise<string | null> {
	return configuredOrigin(env) ?? (await stored(env, deps))?.origin ?? null;
}

/**
 * Record the origin of a trusted request. Call only for authenticated
 * requests and for `/setup`; see the module comment. Never throws.
 */
export async function recordDeploymentOrigin(
	env: Env,
	requestUrl: string,
	source: "request" | "setup",
	deps: OriginDeps = {},
): Promise<void> {
	const candidate = originRank(requestUrl);
	if (!candidate) return;
	const now = deps.now?.() ?? Date.now();
	// Skip the write while this isolate's view (at most ORIGIN_CACHE_MS old)
	// says the store already holds this origin or a better one. A move to a
	// new custom domain is therefore noticed within that window.
	const current = await stored(env, deps);
	if (current && (current.rank > candidate.rank || current.origin === candidate.origin)) return;
	const rpc = deps.rpc === undefined ? defaultOriginRpc(env) : deps.rpc;
	if (!rpc) return;
	try {
		const result = await rpc.recordDeploymentOrigin(candidate.origin, candidate.rank, source, now);
		const rank = result.origin === candidate.origin ? candidate.rank : (originRank(result.origin)?.rank ?? candidate.rank);
		cache.set(cacheKey(env), { value: { origin: result.origin, rank }, at: now });
	} catch (e) {
		console.error("deployment origin record failed:", (e as Error).message);
	}
}

/** Tests: forget the per-isolate cache. */
export function resetDeploymentOriginCache(env?: Env): void {
	if (env) cache.delete(cacheKey(env));
}

let warned = false;

/**
 * Log once per isolate that a send went out without tracking or unsubscribe
 * links because no origin is known.
 */
export function warnNoDeploymentOrigin(what: string): void {
	if (warned) return;
	warned = true;
	console.warn(
		`No deployment origin is known (set APP_URL, or sign in once on the app's address); ${what} without tracking or unsubscribe links.`,
	);
}

/** Tests: re-arm the one-time warning. */
export function resetNoOriginWarning(): void {
	warned = false;
}
