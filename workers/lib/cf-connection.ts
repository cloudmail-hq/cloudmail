// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Which Cloudflare API token the app uses, for every consumer.
 *
 * Order: the `CF_API_TOKEN` env secret wins (an existing deployment keeps
 * working untouched and the AuthDO is not even read), else the connection
 * pasted in Settings → Cloudflare connection (`./cf-connection-store.ts`).
 *
 * The decrypted token is cached per isolate for at most `CONNECTION_CACHE_MS`.
 * After that the row is read again and decrypted again only when its
 * `updated_at` changed, so a DELETE (or a replaced token) takes effect on
 * every isolate within 30 s, and at once on the isolate that made it.
 *
 * Never throws: a missing AuthDO, an older AuthDO without the RPC, or a
 * ciphertext that no longer decrypts (AUTH_SECRET set or changed after
 * connecting) all resolve to null. The last is reported as
 * `state: "reconnect_required"` by `loadCloudflareConnection`.
 */

import { authSecret } from "../auth/config";
import type { AuthStoreApi } from "../auth/types";
import type { Env } from "../types";
import type { CfConnectionState } from "../../shared/cf-connection";
import { CloudflareClient, DEFAULT_WORKER_SCRIPT_NAME } from "./cloudflare-api";
import { openCloudflareToken, type CloudflareConnectionRecord } from "./cf-connection-store";

export type CfTokenSource = "env" | "connection";

export interface ResolvedCfToken {
	token: string;
	accountId: string | null;
	source: CfTokenSource;
	/** The connection's discovered Worker name, if any. `WORKER_SCRIPT_NAME` env still wins. */
	workerScriptName: string | null;
}

/** The AuthDO methods the resolver reads. */
export interface CfConnectionStoreApi extends Pick<AuthStoreApi, "getOrInitMeta"> {
	getCloudflareConnection(): Promise<CloudflareConnectionRecord | null>;
}

export const CONNECTION_CACHE_MS = 30_000;

interface CacheEntry {
	record: CloudflareConnectionRecord | null;
	/** Decrypted token, or null when there is no row or it did not decrypt. */
	token: string | null;
	decryptFailed: boolean;
	readAt: number;
}

let cache: CacheEntry | null = null;

/** Drop the per-isolate copy. Called after PUT/DELETE, and by tests. */
export function invalidateCloudflareConnectionCache(): void {
	cache = null;
}

/** Overridable in tests. */
export const cfConnectionDeps = { now: () => Date.now() };

function envToken(env: Env): string | null {
	return (env as { CF_API_TOKEN?: string }).CF_API_TOKEN?.trim() || null;
}

function envAccountId(env: Env): string | null {
	return (env as { CF_ACCOUNT_ID?: string }).CF_ACCOUNT_ID?.trim() || null;
}

/** The global AuthDO stub, looked up by name so this module imports nothing from `cloudflare:workers`. */
function defaultStore(env: Env): CfConnectionStoreApi | null {
	const ns = (env as unknown as { AUTH_STORE?: DurableObjectNamespace }).AUTH_STORE;
	if (!ns || typeof ns.idFromName !== "function") return null;
	return ns.get(ns.idFromName("global")) as unknown as CfConnectionStoreApi;
}

async function readConnection(env: Env, store?: CfConnectionStoreApi | null): Promise<CacheEntry> {
	const now = cfConnectionDeps.now();
	if (cache && now - cache.readAt < CONNECTION_CACHE_MS) return cache;
	const s = store ?? defaultStore(env);
	let record: CloudflareConnectionRecord | null = null;
	try {
		record = s ? await s.getCloudflareConnection() : null;
	} catch {
		// No AuthDO, or one from before migration 0022: not connected.
		record = null;
	}
	if (!record) {
		cache = { record: null, token: null, decryptFailed: false, readAt: now };
		return cache;
	}
	if (cache?.record && cache.record.updatedAt === record.updatedAt && !cache.decryptFailed) {
		cache = { ...cache, record, readAt: now };
		return cache;
	}
	let token: string | null = null;
	let decryptFailed = false;
	try {
		token = await openCloudflareToken(record.tokenEnc, await authSecret(env, s!));
	} catch {
		decryptFailed = true;
	}
	cache = { record, token, decryptFailed, readAt: now };
	return cache;
}

export interface LoadedCloudflareConnection {
	resolved: ResolvedCfToken | null;
	/** The stored row (never the plaintext token), whether or not env wins. */
	record: CloudflareConnectionRecord | null;
	state: CfConnectionState;
}

/** What Settings shows: the resolved token plus the stored row and its state. Never throws. */
export async function loadCloudflareConnection(
	env: Env,
	store?: CfConnectionStoreApi | null,
): Promise<LoadedCloudflareConnection> {
	const entry = await readConnection(env, store);
	const fromEnv = envToken(env);
	if (fromEnv) {
		return {
			resolved: {
				token: fromEnv,
				accountId: envAccountId(env),
				source: "env",
				workerScriptName: entry.record?.workerScriptName ?? null,
			},
			record: entry.record,
			state: "connected",
		};
	}
	if (!entry.record) return { resolved: null, record: null, state: "none" };
	if (!entry.token) return { resolved: null, record: entry.record, state: "reconnect_required" };
	return {
		resolved: {
			token: entry.token,
			accountId: entry.record.accountId ?? envAccountId(env),
			source: "connection",
			workerScriptName: entry.record.workerScriptName,
		},
		record: entry.record,
		state: "connected",
	};
}

/**
 * The token every Cloudflare API consumer uses: `CF_API_TOKEN` env, else the
 * stored connection, else null (manual mode). Env wins without reading the
 * AuthDO, so a deployment configured by secret behaves exactly as before.
 */
export async function resolveCloudflareToken(
	env: Env,
	store?: CfConnectionStoreApi | null,
): Promise<ResolvedCfToken | null> {
	const fromEnv = envToken(env);
	if (fromEnv) return { token: fromEnv, accountId: envAccountId(env), source: "env", workerScriptName: null };
	return (await loadCloudflareConnection(env, store)).resolved;
}

/**
 * The stored connection's token only, ignoring `CF_API_TOKEN`. Analytics uses
 * this (`CF_ANALYTICS_TOKEN` → connection → `EMAIL_ANALYTICS_TOKEN`) so a
 * deployment with only `CF_API_TOKEN` keeps its analytics exactly as before.
 */
export async function resolveConnectionToken(
	env: Env,
	store?: CfConnectionStoreApi | null,
): Promise<string | null> {
	const entry = await readConnection(env, store);
	return entry.token;
}

/** The stored connection's account id, when its token decrypts. */
export async function resolveConnectionAccountId(
	env: Env,
	store?: CfConnectionStoreApi | null,
): Promise<string | null> {
	const entry = await readConnection(env, store);
	return entry.token ? (entry.record?.accountId ?? null) : null;
}

/** `WORKER_SCRIPT_NAME` env, else the connection's discovered name, else the default. */
export async function resolveWorkerScriptName(env: Env, store?: CfConnectionStoreApi | null): Promise<string> {
	const raw = (env as { WORKER_SCRIPT_NAME?: string }).WORKER_SCRIPT_NAME?.trim();
	if (raw) return raw;
	const entry = await readConnection(env, store);
	return entry.record?.workerScriptName || DEFAULT_WORKER_SCRIPT_NAME;
}

/** A client for the resolved token, or null (manual mode). Never throws. */
export async function cloudflareClient(
	env: Env,
	store?: CfConnectionStoreApi | null,
	fetchImpl?: typeof fetch,
): Promise<CloudflareClient | null> {
	const resolved = await resolveCloudflareToken(env, store);
	if (!resolved) return null;
	return new CloudflareClient({
		token: resolved.token,
		accountId: resolved.accountId ?? undefined,
		workerScriptName: await resolveWorkerScriptName(env, store),
		fetchImpl,
	});
}

/** Last 4 characters, the only part of a token ever shown or audited. */
export function tokenLast4(token: string): string {
	return token.trim().slice(-4);
}
