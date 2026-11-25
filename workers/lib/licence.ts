/**
 * The app licence ("paid for everything").
 *
 * The admin pastes a licence key once. The app exchanges it at the licence
 * server (`LICENCE_SERVER_URL`, default https://licence.tapetide.com) for an
 * Ed25519-signed token bound to this deployment's `deployment_id` and host,
 * stores the token in the AuthDO (`./licence-store.ts`) and never the key,
 * then verifies the token offline against the bundled public keys
 * (`shared/licence-keys.ts`) on every check. The daily cron, and a boot check
 * once the token is past `refresh_after`, refresh it.
 *
 * Licences are one-time purchases: `exp` (30 days) is a refresh horizon, not
 * a billing period.
 *
 * Locked when there is no token; the token is `expired` (past
 * the 7-day grace) or `invalid` (bad signature, unknown key, wrong deployment
 * or host); or the licence server's last answer was terminal (`revoked`,
 * `expired`, `payment_required`, `invalid_token`, `token_expired`). `grace`
 * (0-7 days past `exp`, refresh still accepted) does NOT lock; admins see a
 * banner.
 *
 * What a lock covers is decided elsewhere: the API gate
 * (`workers/lib/licence-gate.ts`), the send gate (`./pre-send.ts`), the
 * scheduled-send alarm, the sequence cron and webhook delivery. The inbound
 * `email()` handler never consults it: mail is always stored.
 *
 * The check is on in every built Worker. No variable, secret or setting turns
 * it off: every deployment, the vendor's own included, holds a licence. The
 * only place it is off is a development build (`import.meta.env.DEV`: the
 * vite dev server and the test runner), where there is no deployment to
 * license. `import.meta.env.DEV` is a compile-time `false` in `vite build`,
 * so each `import.meta.env.DEV && ...` branch below is removed from the
 * production bundle.
 */

import { LICENCE_JWKS } from "../../shared/licence-keys";
import {
	REFRESH_GRACE_SECONDS,
	normaliseHost,
	planLimits,
	verifyLicenceToken,
	type Jwks,
	type LicenceClaims,
	type VerifyResult,
} from "../../shared/licence-token";
import { isLockedStatus, type LicenceInUse, type LicenceStatus, type LicenceView } from "../../shared/licence";
import type { Env } from "../types";
import { deploymentOrigin } from "./deployment-origin";
import type { LicenceRecord } from "./licence-store";

export const DEFAULT_LICENCE_SERVER_URL = "https://licence.tapetide.com";
/** Where a customer manages a purchase (receipts, deployments, a new key). */
export const LICENCE_MANAGE_URL = "https://tapetide.com/account";
/** Per-isolate cache of the decided state. */
export const LICENCE_CACHE_MS = 30_000;
/** Minimum time between refresh attempts across all isolates. */
export const REFRESH_MIN_INTERVAL_SECONDS = 15 * 60;
/** Daily refresh cadence when the server gave no `refresh_after`. */
export const REFRESH_EVERY_SECONDS = 24 * 60 * 60;
const SERVER_TIMEOUT_MS = 10_000;

/** Licence server answers that lock the app until the next successful activation or refresh. */
export const TERMINAL_SERVER_ERRORS: ReadonlySet<string> = new Set([
	"revoked",
	"expired",
	"payment_required",
	"invalid_token",
	"token_expired",
]);

type LicenceEnv = Pick<Env, "APP_URL"> & {
	LICENCE_SERVER_URL?: string;
	AUTH_STORE?: unknown;
};

/**
 * Development builds only: the check is off unless a test turned it on. Read
 * only behind `import.meta.env.DEV`, so a production build never consults it.
 */
let enforcedInDev = false;

/** Tests: run the check as a production build does. Does nothing outside a development build. */
export function setLicenceEnforcementForTests(on: boolean): void {
	enforcedInDev = on;
}

/** True in a development build with the check off. Always false in a production build. */
export function licenceCheckOff(): boolean {
	return import.meta.env.DEV && !enforcedInDev;
}

export function licenceServerUrl(env: LicenceEnv): string {
	const raw = env.LICENCE_SERVER_URL?.trim();
	if (raw) {
		try {
			const url = new URL(raw);
			if (url.protocol === "https:" || (url.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(url.hostname))) {
				return url.origin + url.pathname.replace(/\/+$/, "");
			}
		} catch {
			/* fall through */
		}
		console.warn("LICENCE_SERVER_URL is not an https URL; using the default.");
	}
	return DEFAULT_LICENCE_SERVER_URL;
}

// ── storage RPC ────────────────────────────────────────────────────

export interface LicenceRpc {
	getLicence(): Promise<LicenceRecord>;
	storeLicenceToken(token: string, refreshAfter: number | null): Promise<LicenceRecord | null>;
	recordLicenceFailure(serverStatus: string | null, serverReason: string | null): Promise<LicenceRecord | null>;
	clearLicenceToken(): Promise<LicenceRecord | null>;
	claimLicenceRefresh(minIntervalSeconds: number): Promise<boolean>;
}

export function defaultLicenceRpc(env: LicenceEnv): LicenceRpc | null {
	const ns = env.AUTH_STORE as Partial<DurableObjectNamespace> | undefined;
	if (!ns || typeof ns.idFromName !== "function" || typeof ns.get !== "function") return null;
	const stub = ns.get(ns.idFromName("global")) as unknown as Partial<LicenceRpc>;
	return typeof stub?.getLicence === "function" ? (stub as LicenceRpc) : null;
}

export interface LicenceDeps {
	rpc?: LicenceRpc | null;
	/** Unix seconds. */
	now?: () => number;
	jwks?: Jwks;
	fetch?: typeof fetch;
	/** The host to bind to, when the caller has a trusted one (an admin's request). */
	host?: string | null;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

// ── deciding the state ─────────────────────────────────────────────

export interface LicenceState {
	status: LicenceStatus;
	locked: boolean;
	record: LicenceRecord | null;
	claims: LicenceClaims | null;
	verify: VerifyResult | null;
	/** The host the token was checked against. */
	host: string | null;
	/**
	 * Set when the deployment now answers on another host than the token is
	 * bound to: the token's own host. Not locked; the admin re-enters the key.
	 */
	movedFrom?: string;
}

/**
 * The host this deployment answers on: the deployment origin (`APP_URL`, or
 * the origin recorded from signed-in requests), else the host the token was
 * activated for. The fallback cannot widen anything: it only lets a
 * deployment whose origin is not known yet (a cron run on a fresh isolate)
 * verify the token it already holds.
 */
async function expectedHost(env: LicenceEnv, claims: LicenceClaims | null, deps: LicenceDeps): Promise<string | null> {
	if (deps.host) return normaliseHost(deps.host);
	const origin = await deploymentOrigin(env as Env);
	if (origin) {
		try {
			return normaliseHost(new URL(origin).hostname);
		} catch {
			/* fall through */
		}
	}
	return claims ? normaliseHost(claims.bind.host) : null;
}

/** Decode the claims without trusting them, only to find the bound host. */
function peekClaims(token: string): LicenceClaims | null {
	try {
		const payload = token.split(".")[1];
		if (!payload) return null;
		const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (payload.length % 4)) % 4));
		const c = JSON.parse(json) as LicenceClaims;
		return c && typeof c === "object" && c.bind && typeof c.bind.host === "string" ? c : null;
	} catch {
		return null;
	}
}

export async function decideLicence(env: LicenceEnv, record: LicenceRecord | null, deps: LicenceDeps = {}): Promise<LicenceState> {
	const base = { record, claims: null, verify: null, host: null } as const;
	if (!record?.token) {
		if (import.meta.env.DEV && !enforcedInDev) return { ...base, status: "off", locked: false };
		return { ...base, status: "none", locked: true };
	}
	const host = await expectedHost(env, peekClaims(record.token), deps);
	const jwks = deps.jwks ?? LICENCE_JWKS;
	const now = deps.now?.() ?? nowSeconds();
	let verify = await verifyLicenceToken(record.token, jwks, { deployment_id: record.deploymentId, host: host ?? "", now });
	/**
	 * The deployment moved to another address (most often workers.dev to a
	 * custom domain: the newest sign-in origin wins). The token is still this
	 * deployment's (`deployment_id` matches) and still signed, only bound to
	 * the old host, and the app cannot re-bind it itself because the key is
	 * never stored. Accept it as bound to its own host and tell the admin to
	 * re-enter the key, which moves the licence without using another seat,
	 * instead of locking a working deployment the moment it gets a nicer URL.
	 */
	let movedFrom: string | null = null;
	if (verify.state === "invalid" && verify.reason === "host_mismatch" && verify.claims) {
		const bound = normaliseHost(verify.claims.bind.host);
		const again = await verifyLicenceToken(record.token, jwks, { deployment_id: record.deploymentId, host: bound, now });
		if (again.state !== "invalid") {
			verify = again;
			movedFrom = bound;
		}
	}
	let status: LicenceStatus =
		verify.state === "valid" ? "active" : verify.state === "grace" ? "grace" : verify.state === "expired" ? "expired" : "invalid";
	if (record.serverStatus && TERMINAL_SERVER_ERRORS.has(record.serverStatus)) {
		status = record.serverStatus === "revoked" ? "revoked" : record.serverStatus === "invalid_token" ? "invalid" : "expired";
	}
	let locked = isLockedStatus(status);
	if (import.meta.env.DEV && !enforcedInDev) locked = false;
	return {
		...base,
		status,
		locked,
		claims: verify.claims ?? null,
		verify,
		host,
		...(movedFrom ? { movedFrom } : {}),
	};
}

// ── per-isolate cache ──────────────────────────────────────────────

interface CacheEntry {
	state: LicenceState;
	at: number;
}
const cache = new WeakMap<object, CacheEntry>();
const keyOf = (env: LicenceEnv): object => ((env.AUTH_STORE as object | undefined) ?? (env as object));

export function invalidateLicenceCache(env: LicenceEnv): void {
	cache.delete(keyOf(env));
}

/** Thrown when the licence row cannot be read. */
export class LicenceUnavailableError extends Error {
	constructor(cause: string) {
		super(`Licence state unavailable: ${cause}`);
		this.name = "LicenceUnavailableError";
	}
}

/**
 * The current state, cached per isolate for LICENCE_CACHE_MS. Throws
 * LicenceUnavailableError when storage fails with nothing cached: callers
 * fail closed (503), except the inbound handler, which never calls this. A
 * development build with the check off never throws: without storage it
 * reports `off`.
 */
export async function licenceState(env: LicenceEnv, deps: LicenceDeps = {}): Promise<LicenceState> {
	const now = Date.now();
	const key = keyOf(env);
	const hit = cache.get(key);
	if (hit && now - hit.at < LICENCE_CACHE_MS && !deps.host) return hit.state;
	const rpc = deps.rpc === undefined ? defaultLicenceRpc(env) : deps.rpc;
	if (!rpc) {
		if (import.meta.env.DEV && !enforcedInDev) return decideLicence(env, null, deps);
		throw new LicenceUnavailableError("no AuthDO binding");
	}
	let record: LicenceRecord;
	try {
		record = await rpc.getLicence();
	} catch (e) {
		if (hit) return hit.state;
		if (import.meta.env.DEV && !enforcedInDev) return decideLicence(env, null, deps);
		throw new LicenceUnavailableError((e as Error).message);
	}
	const state = await decideLicence(env, record, deps);
	if (!deps.host) cache.set(key, { state, at: now });
	return state;
}

/** True when the app is locked. Throws LicenceUnavailableError (fail closed). */
export async function isLicenceLocked(env: LicenceEnv, deps: LicenceDeps = {}): Promise<boolean> {
	if (import.meta.env.DEV && !enforcedInDev) return false;
	return (await licenceState(env, deps)).locked;
}

/**
 * For background work (alarm, cron, webhook drain): locked, or the state
 * cannot be read. Never throws. A read failure counts as locked so a broken
 * AuthDO never waves sends through; held work simply waits.
 */
export async function backgroundLocked(env: LicenceEnv, deps: LicenceDeps = {}): Promise<boolean> {
	try {
		return await isLicenceLocked(env, deps);
	} catch (e) {
		console.error((e as Error).message);
		return true;
	}
}

export function licenceView(state: LicenceState, now = nowSeconds()): LicenceView {
	const claims = state.claims;
	const exp = claims?.exp ?? null;
	const graceDaysLeft =
		state.status === "grace" && exp !== null ? Math.max(0, Math.ceil((exp + REFRESH_GRACE_SECONDS - now) / 86_400)) : null;
	return {
		status: state.status,
		locked: state.locked,
		plan: claims?.plan ?? null,
		expiresAt: exp,
		lastRefreshAt: state.record?.lastRefreshAt ?? null,
		failureCount: state.record?.failureCount ?? 0,
		graceDaysLeft,
		serverReason: state.record?.serverStatus
			? [state.record.serverStatus, state.record.serverReason].filter(Boolean).join(": ")
			: null,
		customerEmail: claims?.customer.email ?? null,
		instances: claims?.instances ?? null,
		...planFields(state),
		manageUrl: LICENCE_MANAGE_URL,
		deploymentId: state.record?.deploymentId ?? "",
		host: state.host ?? claims?.bind.host ?? null,
		movedFrom: state.movedFrom ?? null,
	};
}

/** Plan and limits for the view. Without a token there is no plan to show. */
function planFields(state: LicenceState): Pick<LicenceView, "planName" | "maxDomains" | "maxDeployments" | "upgradeAvailable"> {
	if (!state.claims) return { planName: null, maxDomains: null, maxDeployments: null, upgradeAvailable: false };
	const limits = planLimits(state.claims);
	return {
		planName: limits.plan,
		maxDomains: limits.max_domains,
		maxDeployments: limits.max_deployments,
		upgradeAvailable: limits.plan === "solo" && (state.status === "active" || state.status === "grace"),
	};
}

// ── talking to the licence server ──────────────────────────────────

export type ServerResult =
	| { ok: true; token: string; refreshAfter: number | null }
	| { ok: false; status: number; error: string; reason: string | null; body?: Record<string, unknown> | null };

async function callServer(env: LicenceEnv, path: string, body: unknown, deps: LicenceDeps): Promise<ServerResult & { raw?: unknown }> {
	const f = deps.fetch ?? fetch;
	let res: Response;
	try {
		res = await f(`${licenceServerUrl(env)}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
		});
	} catch (e) {
		return { ok: false, status: 0, error: "unreachable", reason: (e as Error).name };
	}
	const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	if (res.ok && json && typeof json.token === "string") {
		const refreshAfter = typeof json.refresh_after === "number" ? json.refresh_after : null;
		return { ok: true, token: json.token, refreshAfter };
	}
	if (res.ok && json && json.ok === true) return { ok: false, status: res.status, error: "ok", reason: null, raw: json };
	return {
		ok: false,
		status: res.status,
		error: typeof json?.error === "string" ? json.error : `http_${res.status}`,
		reason: typeof json?.reason === "string" ? json.reason : null,
		body: json,
	};
}

/** Messages for the activation form. Never echo the key. */
export function activationMessage(error: string, status: number): string {
	switch (error) {
		case "invalid_licence_key":
			return "That licence key wasn't recognised. Check it and try again.";
		case "activation_limit_reached":
			return "This licence is active on another deployment. Deactivate it there, or move it here.";
		case "takeover_cooldown":
			return "This licence moved to another deployment less than 24 hours ago. Deactivate it there, or try again later.";
		case "not_upgradable":
			return "This licence already covers unlimited domains.";
		case "already_upgraded":
			return "This licence is already Unlimited. Click Check now to pick up the change.";
		case "upgrades_unavailable":
			return "Upgrades aren't available right now. Try again later.";
		case "licence_not_active":
			return "This licence isn't active.";
		case "licence_pending":
			return "The purchase is still being processed. Try again in a minute.";
		case "licence_inactive":
		case "payment_required":
			return "This licence isn't active.";
		case "expired":
			return "This licence has expired.";
		case "revoked":
			return "This licence has been revoked.";
		case "licence_mismatch":
			return "That key belongs to a different product.";
		case "rate_limited":
			return "Too many attempts. Wait a minute and try again.";
		case "invalid_request":
			return "The licence server refused the request. Check the key and this deployment's address.";
		case "unreachable":
			return "Couldn't reach the licence server. Try again shortly.";
		default:
			return status >= 500 ? "The licence server is having trouble. Try again shortly." : "Activation failed.";
	}
}

export interface ActivateInput {
	licenceKey: string;
	/** Hostname the admin is using (from their signed-in request). */
	host: string;
	cfAccount: string | null;
	appVersion: string | null;
	/** Move the licence here: the licence server frees the deployment that holds it. */
	takeover?: boolean;
}

export type ActivateResult =
	| { ok: true; state: LicenceState }
	| { ok: false; status: number; error: string; message: string; inUse?: LicenceInUse };

/** The licence server's 409 body, reshaped. Only masked hosts ever arrive here. */
function inUseFrom(body: Record<string, unknown> | null | undefined, message: string): LicenceInUse {
	const active = Array.isArray(body?.active) ? (body!.active as Record<string, unknown>[]) : [];
	return {
		code: "activation_limit_reached",
		error: message,
		maxDeployments: typeof body?.max_deployments === "number" ? body.max_deployments : null,
		active: active
			.filter((a) => a && typeof a.host_hint === "string")
			.slice(0, 10)
			.map((a) => ({
				hostHint: String(a.host_hint).slice(0, 253),
				lastSeenAt: typeof a.last_seen_at === "number" ? a.last_seen_at : 0,
				stale: a.stale === true,
			})),
	};
}

/**
 * Activate: exchange the key for a token. The key is used for this one call
 * and never stored or logged.
 */
export async function activateLicence(env: LicenceEnv, input: ActivateInput, deps: LicenceDeps = {}): Promise<ActivateResult> {
	const rpc = deps.rpc === undefined ? defaultLicenceRpc(env) : deps.rpc;
	if (!rpc) return { ok: false, status: 503, error: "unavailable", message: "Licence storage is unavailable." };
	const record = await rpc.getLicence();
	const host = normaliseHost(input.host);
	const result = await callServer(
		env,
		"/v1/licence/activate",
		{
			licence_key: input.licenceKey,
			deployment_id: record.deploymentId,
			host,
			cf_account: input.cfAccount && /^[a-f0-9]{32}$/.test(input.cfAccount) ? input.cfAccount : null,
			app_version: input.appVersion,
			...(input.takeover ? { takeover: true } : {}),
		},
		deps,
	);
	if (!result.ok) {
		const status =
			result.status === 409 || result.status === 422 || result.status === 429 ? 422 : result.status >= 500 || result.status === 0 ? 502 : 400;
		const message = activationMessage(result.error, result.status);
		const inUse = result.error === "activation_limit_reached" ? inUseFrom(result.body, message) : undefined;
		return { ok: false, status, error: result.error, message, ...(inUse ? { inUse } : {}) };
	}
	// Refuse a token this deployment would itself reject, before storing it.
	const check = await verifyLicenceToken(result.token, deps.jwks ?? LICENCE_JWKS, {
		deployment_id: record.deploymentId,
		host,
		now: deps.now?.() ?? nowSeconds(),
	});
	if (check.state !== "valid") {
		console.error(`licence: the server's token failed verification (${check.reason ?? check.state})`);
		return { ok: false, status: 502, error: "bad_token", message: "The licence server returned a token this app can't verify. Update the app, or contact support." };
	}
	const stored = await rpc.storeLicenceToken(result.token, result.refreshAfter);
	invalidateLicenceCache(env);
	return { ok: true, state: await decideLicence(env, stored, { ...deps, host }) };
}

export type RefreshOutcome = "refreshed" | "failed" | "terminal" | "skipped" | "no_token";

/**
 * Refresh the token. On success the new token replaces the old. On failure
 * the old token is kept and the failure count goes up; a terminal answer
 * (see TERMINAL_SERVER_ERRORS) is remembered and locks the app.
 */
export async function refreshLicence(env: LicenceEnv, deps: LicenceDeps & { force?: boolean } = {}): Promise<RefreshOutcome> {
	const rpc = deps.rpc === undefined ? defaultLicenceRpc(env) : deps.rpc;
	if (!rpc) return "skipped";
	const record = await rpc.getLicence();
	if (!record.token) return "no_token";
	if (!deps.force && !(await rpc.claimLicenceRefresh(REFRESH_MIN_INTERVAL_SECONDS))) return "skipped";
	const result = await callServer(env, "/v1/licence/refresh", { token: record.token }, deps);
	if (result.ok) {
		await rpc.storeLicenceToken(result.token, result.refreshAfter);
		invalidateLicenceCache(env);
		return "refreshed";
	}
	const terminal = TERMINAL_SERVER_ERRORS.has(result.error) ? result.error : null;
	await rpc.recordLicenceFailure(terminal, terminal ? result.reason : null);
	invalidateLicenceCache(env);
	console.warn(`licence refresh failed: ${result.error}${result.reason ? ` (${result.reason})` : ""}`);
	return terminal ? "terminal" : "failed";
}

/** Due for a refresh: past `refresh_after`, or a day since the last success. */
export function refreshDue(record: LicenceRecord, now = nowSeconds()): boolean {
	if (!record.token) return false;
	if (record.refreshAfter !== null) return now >= record.refreshAfter;
	return record.lastRefreshAt === null || now - record.lastRefreshAt >= REFRESH_EVERY_SECONDS;
}

/**
 * The cron tick and the boot check: refresh when due. Never throws. The
 * AuthDO claim keeps every isolate from calling at once.
 */
export async function maybeRefreshLicence(env: LicenceEnv, deps: LicenceDeps = {}): Promise<RefreshOutcome> {
	try {
		const rpc = deps.rpc === undefined ? defaultLicenceRpc(env) : deps.rpc;
		if (!rpc) return "skipped";
		const record = await rpc.getLicence();
		if (!refreshDue(record, deps.now?.() ?? nowSeconds())) return record.token ? "skipped" : "no_token";
		return await refreshLicence(env, { ...deps, rpc });
	} catch (e) {
		console.error("licence refresh check failed:", (e as Error).message);
		return "failed";
	}
}

let bootChecked = new WeakSet<object>();

/** Once per isolate: start a refresh when the token is due. Off the request path. */
export function bootLicenceCheck(env: LicenceEnv, waitUntil: (p: Promise<unknown>) => void): void {
	const key = keyOf(env);
	if (bootChecked.has(key)) return;
	bootChecked.add(key);
	waitUntil(maybeRefreshLicence(env));
}

/** Tests. */
export function resetLicenceBootCheck(): void {
	bootChecked = new WeakSet<object>();
}

export type DeactivateResult = { ok: true } | { ok: false; status: number; error: string; message: string };

/**
 * Deactivate: free this deployment's slot at the licence server, then drop
 * the token. Needs the key again (the server identifies the licence by it);
 * the key is not stored.
 */
export async function deactivateLicence(env: LicenceEnv, licenceKey: string, deps: LicenceDeps = {}): Promise<DeactivateResult> {
	const rpc = deps.rpc === undefined ? defaultLicenceRpc(env) : deps.rpc;
	if (!rpc) return { ok: false, status: 503, error: "unavailable", message: "Licence storage is unavailable." };
	const record = await rpc.getLicence();
	const result = await callServer(env, "/v1/licence/deactivate", { licence_key: licenceKey, deployment_id: record.deploymentId }, deps);
	if (!result.ok && result.error !== "ok") {
		return { ok: false, status: result.status >= 500 || result.status === 0 ? 502 : 400, error: result.error, message: activationMessage(result.error, result.status) };
	}
	await rpc.clearLicenceToken();
	invalidateLicenceCache(env);
	return { ok: true };
}

export type UpgradeResult = { ok: true; checkoutUrl: string } | { ok: false; status: number; error: string; message: string };

/**
 * Start the Solo → Unlimited upgrade: the licence server checks this
 * deployment's token and answers with a single-use Dodo checkout URL that
 * returns to `returnUrl` (on this deployment's host only; the server ignores
 * anything else). The upgrade lands when Dodo's payment webhook does; the
 * Licence page then refreshes the token to pick it up.
 */
export async function startLicenceUpgrade(
	env: LicenceEnv,
	urls: { returnUrl: string; cancelUrl: string },
	deps: LicenceDeps = {},
): Promise<UpgradeResult> {
	const rpc = deps.rpc === undefined ? defaultLicenceRpc(env) : deps.rpc;
	if (!rpc) return { ok: false, status: 503, error: "unavailable", message: "Licence storage is unavailable." };
	const record = await rpc.getLicence();
	if (!record.token) return { ok: false, status: 400, error: "no_token", message: "Activate a licence first." };
	const f = deps.fetch ?? fetch;
	let res: Response;
	try {
		res = await f(`${licenceServerUrl(env)}/v1/licence/upgrade-checkout`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ token: record.token, return_url: urls.returnUrl, cancel_url: urls.cancelUrl }),
			signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
		});
	} catch {
		return { ok: false, status: 502, error: "unreachable", message: activationMessage("unreachable", 0) };
	}
	const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	const url = typeof json?.checkout_url === "string" ? json.checkout_url : null;
	if (res.ok && url && /^https:\/\//.test(url)) return { ok: true, checkoutUrl: url };
	const error = typeof json?.error === "string" ? json.error : `http_${res.status}`;
	if (TERMINAL_SERVER_ERRORS.has(error)) {
		// Same answer refresh would give: remember it so the app shows the real state.
		await rpc.recordLicenceFailure(error, typeof json?.reason === "string" ? json.reason : null);
		invalidateLicenceCache(env);
	}
	return { ok: false, status: res.status >= 500 ? 502 : 400, error, message: activationMessage(error, res.status) };
}
