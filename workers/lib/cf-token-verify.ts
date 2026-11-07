// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Check a pasted Cloudflare API token before it is stored, and find out what
 * it may do.
 *
 * `verifyCloudflareToken`: `GET /user/tokens/verify` (user tokens); when that
 * fails, account-owned tokens via `GET /accounts` then
 * `GET /accounts/{id}/tokens/verify`. The token must be `active`.
 *
 * `probeCloudflareCapabilities`: read-only calls, one per feature, in
 * parallel, each with a 5 s timeout. A failure marks that capability
 * "missing" and is never fatal. DNS write cannot be checked without writing,
 * so it is "unknown" (assumed from the token template).
 *
 * The token is only ever sent in the Authorization header. Nothing here logs
 * it or puts it in an error message.
 */

import { CF_API_BASE } from "./cloudflare-api";
import type { CfAccountChoice, CfCapability, CfCapabilityName, CfTokenKind } from "../../shared/cf-connection";

export const PROBE_TIMEOUT_MS = 5_000;
const GRAPHQL_URL = `${CF_API_BASE}/graphql`;

interface CfCall<T> {
	ok: boolean;
	status: number;
	result: T | null;
	resultInfo?: { total_count?: number; count?: number };
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new Error("timed out"));
		}, ms);
	});
	try {
		return await Promise.race([run(controller.signal), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** One REST call. Network errors and timeouts are `ok: false, status: 0`. */
async function cfGet<T>(token: string, path: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<CfCall<T>> {
	try {
		return await withTimeout(timeoutMs, async (signal) => {
			const res = await fetchImpl(`${CF_API_BASE}${path}`, {
				method: "GET",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				signal,
			});
			const body = (await res.json().catch(() => null)) as {
				success?: boolean;
				result?: T;
				result_info?: { total_count?: number; count?: number };
			} | null;
			return {
				ok: res.ok && body?.success === true,
				status: res.status,
				result: body?.result ?? null,
				resultInfo: body?.result_info,
			};
		});
	} catch {
		return { ok: false, status: 0, result: null };
	}
}

async function cfGraphql(
	token: string,
	query: string,
	variables: Record<string, unknown>,
	fetchImpl: typeof fetch,
	timeoutMs: number,
): Promise<{ ok: boolean; data: any }> {
	try {
		return await withTimeout(timeoutMs, async (signal) => {
			const res = await fetchImpl(GRAPHQL_URL, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ query, variables }),
				signal,
			});
			const body = (await res.json().catch(() => null)) as { data?: unknown; errors?: unknown[] | null } | null;
			const ok = res.ok && !!body?.data && !(Array.isArray(body.errors) && body.errors.length > 0);
			return { ok, data: body?.data ?? null };
		});
	} catch {
		return { ok: false, data: null };
	}
}

// -- verify ------------------------------------------------------------------

export type VerifyResult =
	| { ok: true; tokenKind: CfTokenKind; accountId: string; accountName: string | null }
	| { ok: false; code: "invalid_token"; error: string }
	| { ok: false; code: "multiple_accounts"; error: string; accounts: CfAccountChoice[] };

interface TokenStatus {
	status?: string;
}

export interface VerifyOptions {
	/** The account to use when the token sees several. */
	accountId?: string | null;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

/** Whether the token is active, what kind it is, and which account it belongs to. */
export async function verifyCloudflareToken(token: string, options: VerifyOptions = {}): Promise<VerifyResult> {
	const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
	const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
	const wanted = options.accountId?.trim() || null;
	const invalid = (error: string): VerifyResult => ({ ok: false, code: "invalid_token", error });

	const [user, accountsCall] = await Promise.all([
		cfGet<TokenStatus>(token, "/user/tokens/verify", fetchImpl, timeoutMs),
		cfGet<{ id: string; name?: string }[]>(token, "/accounts?per_page=50", fetchImpl, timeoutMs),
	]);
	const accounts: CfAccountChoice[] = (accountsCall.ok && Array.isArray(accountsCall.result) ? accountsCall.result : [])
		.filter((a) => a && typeof a.id === "string")
		.map((a) => ({ id: a.id, name: a.name ?? null }));

	let tokenKind: CfTokenKind;
	let candidates: CfAccountChoice[];
	if (user.ok && user.result?.status === "active") {
		tokenKind = "user";
		candidates = accounts;
	} else if (user.ok && user.result?.status) {
		return invalid(`This token is ${user.result.status}. Create a new one and paste it here.`);
	} else {
		// Account-owned token: verify against each account it can see (or the one asked for).
		const ids = wanted ? [wanted] : accounts.map((a) => a.id);
		const checks = await Promise.all(
			ids.map(async (id) => ({
				id,
				call: await cfGet<TokenStatus>(token, `/accounts/${encodeURIComponent(id)}/tokens/verify`, fetchImpl, timeoutMs),
			})),
		);
		const active = checks.filter((c) => c.call.ok && c.call.result?.status === "active").map((c) => c.id);
		if (active.length === 0) {
			const inactive = checks.find((c) => c.call.ok && c.call.result?.status);
			if (inactive) return invalid(`This token is ${inactive.call.result!.status}. Create a new one and paste it here.`);
			return invalid("Cloudflare didn't accept this token. Check that it was copied whole and is still active.");
		}
		tokenKind = "account";
		candidates = active.map((id) => accounts.find((a) => a.id === id) ?? { id, name: null });
	}

	if (wanted) {
		const match = candidates.find((a) => a.id === wanted);
		if (!match) return invalid("This token can't reach that account.");
		return { ok: true, tokenKind, accountId: match.id, accountName: match.name };
	}
	if (candidates.length === 0) {
		return invalid("This token can't see any account. Give it Account Settings Read, or create it from the template.");
	}
	if (candidates.length > 1) {
		return {
			ok: false,
			code: "multiple_accounts",
			error: "This token can reach more than one account. Choose the one to use.",
			accounts: candidates,
		};
	}
	return { ok: true, tokenKind, accountId: candidates[0].id, accountName: candidates[0].name };
}

// -- capability probe ---------------------------------------------------------

export interface ProbeOptions {
	accountId: string;
	/** The Worker the catch-all should target, checked against the account's scripts. */
	workerScriptName: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	now?: number;
}

export interface ProbeResult {
	capabilities: CfCapability[];
	zoneCount: number | null;
	/** Whether `workerScriptName` exists on the account; null when scripts could not be listed. */
	workerFound: boolean | null;
}

const ANALYTICS_PROBE = `query ($a: string!) { viewer { accounts(filter: { accountTag: $a }) { accountTag } } }`;
const DMARC_PROBE = `query ($z: string!, $d: Date!) { viewer { zones(filter: { zoneTag: $z }) {
  dmarcReportsSourcesAdaptiveGroups(limit: 1, filter: { date_geq: $d, date_leq: $d }) { sum { totalMatchingMessages } } } } }`;

const ORDER: CfCapabilityName[] = [
	"zones.read",
	"dns.read",
	"dns.write",
	"routing",
	"routing.rules",
	"sending",
	"analytics",
	"dmarc",
	"vectorize",
	"workers.scripts",
];

/** Read-only checks of every feature the token is meant for. Never throws. */
export async function probeCloudflareCapabilities(token: string, options: ProbeOptions): Promise<ProbeResult> {
	const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
	const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
	const account = encodeURIComponent(options.accountId);
	const today = new Date(options.now ?? Date.now()).toISOString().slice(0, 10);
	const out = new Map<CfCapabilityName, CfCapability>();
	const set = (name: CfCapabilityName, ok: boolean, detail?: string) =>
		out.set(name, { name, status: ok ? "ok" : "missing", ...(detail ? { detail } : {}) });

	let zoneCount: number | null = null;
	let workerFound: boolean | null = null;

	const zoneProbes = (async () => {
		const zones = await cfGet<{ id: string }[]>(token, `/zones?per_page=50&account.id=${account}`, fetchImpl, timeoutMs);
		if (!zones.ok || !Array.isArray(zones.result)) {
			set("zones.read", false);
			for (const n of ["dns.read", "routing", "routing.rules", "sending", "dmarc"] as const) {
				out.set(n, { name: n, status: "unknown", detail: "needs zone read" });
			}
			return;
		}
		zoneCount = zones.resultInfo?.total_count ?? zones.result.length;
		set("zones.read", true, `${zoneCount} zone${zoneCount === 1 ? "" : "s"}`);
		const first = zones.result[0]?.id;
		if (!first) {
			for (const n of ["dns.read", "routing", "routing.rules", "sending", "dmarc"] as const) {
				out.set(n, { name: n, status: "unknown", detail: "no zones" });
			}
			return;
		}
		const z = encodeURIComponent(first);
		const [dns, routing, rules, sending, dmarc] = await Promise.all([
			cfGet(token, `/zones/${z}/dns_records?per_page=1`, fetchImpl, timeoutMs),
			cfGet(token, `/zones/${z}/email/routing`, fetchImpl, timeoutMs),
			cfGet(token, `/zones/${z}/email/routing/rules/catch_all`, fetchImpl, timeoutMs),
			cfGet(token, `/zones/${z}/email/sending/subdomains`, fetchImpl, timeoutMs),
			cfGraphql(token, DMARC_PROBE, { z: first, d: today }, fetchImpl, timeoutMs),
		]);
		set("dns.read", dns.ok);
		set("routing", routing.ok);
		// No catch-all rule yet answers 404, which still proves the read permission.
		set("routing.rules", rules.ok || rules.status === 404);
		set("sending", sending.ok);
		set("dmarc", dmarc.ok);
	})();

	const accountProbes = (async () => {
		const [analytics, vectorize, scripts] = await Promise.all([
			cfGraphql(token, ANALYTICS_PROBE, { a: options.accountId }, fetchImpl, timeoutMs),
			cfGet(token, `/accounts/${account}/vectorize/v2/indexes`, fetchImpl, timeoutMs),
			cfGet<{ id: string }[]>(token, `/accounts/${account}/workers/scripts`, fetchImpl, timeoutMs),
		]);
		const seen = analytics.ok && Array.isArray(analytics.data?.viewer?.accounts) && analytics.data.viewer.accounts.length > 0;
		set("analytics", seen);
		set("vectorize", vectorize.ok);
		if (scripts.ok && Array.isArray(scripts.result)) {
			workerFound = scripts.result.some((s) => s?.id === options.workerScriptName);
			set("workers.scripts", true, workerFound ? undefined : `Worker "${options.workerScriptName}" not found`);
		} else {
			set("workers.scripts", false);
		}
	})();

	await Promise.all([zoneProbes, accountProbes]);
	out.set("dns.write", { name: "dns.write", status: "unknown", detail: "assumed from token template" });
	return { capabilities: ORDER.map((n) => out.get(n)!), zoneCount, workerFound };
}
