// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * A small typed client for the Cloudflare endpoints domain provisioning uses:
 * zone lookup, Email Routing (DNS, settings, catch-all rule) and Email Sending
 * subdomains.
 *
 * Built by `cloudflareClient` in ./cf-connection.ts from `CF_API_TOKEN` or
 * the stored connection. The token needs Zone Read, Zone Settings Write, Email Routing Rules Write, Email
 * Sending Edit and DNS Read on the zones it should manage.
 *
 * `fetchImpl` is injectable so tests assert request shapes without a network.
 */

import type { Env } from "../types";

export const CF_API_BASE = "https://api.cloudflare.com/client/v4";
export const DEFAULT_WORKER_SCRIPT_NAME = "cloudmail";

export interface CfApiErrorDetail {
	code?: number;
	message: string;
}

export class CloudflareApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly path: string,
		readonly errors: CfApiErrorDetail[],
	) {
		super(message);
		this.name = "CloudflareApiError";
	}
}

export interface CfZone {
	id: string;
	name: string;
	status?: string;
	account?: { id: string; name?: string };
	plan?: { name?: string; legacy_id?: string };
	name_servers?: string[];
}

/** A record from `/zones/{id}/dns_records` (has an id, unlike `CfDnsRecord`). */
export interface CfDnsRecordFull {
	id: string;
	type: string;
	name: string;
	content: string;
	priority?: number;
	ttl?: number;
	proxied?: boolean;
	comment?: string | null;
}

export interface CfDnsRecordInput {
	type: string;
	name: string;
	content: string;
	priority?: number;
	ttl?: number;
	comment?: string;
}

export interface CfWorkerScript {
	id: string;
}

export interface CfScriptBinding {
	type: string;
	name: string;
	class_name?: string;
	script_name?: string;
}

export interface CfVectorizeIndex {
	name: string;
	config?: { dimensions?: number; metric?: string };
}

export interface CfMetadataIndex {
	propertyName: string;
	indexType: string;
}

export interface CfDnsRecord {
	type: string;
	name: string;
	content: string;
	priority?: number;
	ttl?: number;
}

export interface CfRoutingSettings {
	enabled?: boolean;
	status?: string;
	name?: string;
	tag?: string;
}

/** `GET /email/routing/dns`: present records, plus what is missing. */
export interface CfRoutingDns {
	records: CfDnsRecord[];
	missing: CfDnsRecord[];
}

export interface CfRoutingRule {
	id?: string;
	tag?: string;
	name?: string;
	enabled?: boolean;
	priority?: number;
	matchers: { type: string; field?: string; value?: string }[];
	actions: { type: string; value?: string[] }[];
}

export interface CfSendingSubdomain {
	tag: string;
	name: string;
	enabled?: boolean;
	dkim_selector?: string;
	return_path_domain?: string;
	drop_suppressed_recipients?: boolean;
	preview_enabled?: boolean;
	created?: string;
	modified?: string;
}

interface CfEnvelope<T> {
	success: boolean;
	errors?: CfApiErrorDetail[];
	result: T;
	result_info?: { total_count?: number; page?: number; per_page?: number };
}

export interface CloudflareClientOptions {
	token: string;
	accountId?: string;
	workerScriptName?: string;
	fetchImpl?: typeof fetch;
	baseUrl?: string;
	/** Abort each call after this many ms (a CloudflareApiError with status 0). Unset: no limit. */
	timeoutMs?: number;
}

export class CloudflareClient {
	readonly workerScriptName: string;
	readonly accountId?: string;
	private readonly token: string;
	private readonly fetchImpl: typeof fetch;
	private readonly baseUrl: string;
	private readonly timeoutMs?: number;

	constructor(options: CloudflareClientOptions) {
		this.timeoutMs = options.timeoutMs;
		this.token = options.token;
		this.accountId = options.accountId;
		this.workerScriptName = options.workerScriptName || DEFAULT_WORKER_SCRIPT_NAME;
		this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
		this.baseUrl = options.baseUrl ?? CF_API_BASE;
	}

	async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
		return (await this.requestWithInfo<T>(path, init)).result;
	}

	/** `request`, plus the envelope's `result_info` (pagination). */
	async requestWithInfo<T>(
		path: string,
		init: { method?: string; body?: unknown } = {},
	): Promise<{ result: T; info?: { total_count?: number; page?: number; per_page?: number } }> {
		const method = init.method ?? "GET";
		const controller = this.timeoutMs ? new AbortController() : null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const call = (async () => {
			const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${this.token}`,
					"Content-Type": "application/json",
				},
				...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
				...(controller ? { signal: controller.signal } : {}),
			});
			let json: CfEnvelope<T> | null = null;
			try {
				json = (await res.json()) as CfEnvelope<T>;
			} catch {
				// Non-JSON (an HTML error page from an edge failure): reported below.
			}
			return { res, json };
		})();
		let outcome: { res: Response; json: CfEnvelope<T> | null };
		try {
			outcome = controller
				? await Promise.race([
						call,
						new Promise<never>((_, reject) => {
							timer = setTimeout(() => {
								controller.abort();
								reject(new CloudflareApiError(`Cloudflare API timed out on ${method} ${path}`, 0, path, []));
							}, this.timeoutMs);
						}),
					])
				: await call;
		} finally {
			clearTimeout(timer);
		}
		const { res, json } = outcome;
		if (!res.ok || !json?.success) {
			const errors = json?.errors ?? [];
			const detail =
				errors.map((e) => (e.code ? `code ${e.code}: ${e.message}` : e.message)).join("; ") ||
				res.statusText ||
				"request failed";
			throw new CloudflareApiError(
				`Cloudflare API ${res.status} on ${init.method ?? "GET"} ${path}: ${detail}`,
				res.status,
				path,
				errors,
			);
		}
		return { result: json.result, info: json.result_info };
	}

	// -- zones -----------------------------------------------------------------

	/**
	 * The zone serving `hostname`: an exact match first, then each parent
	 * (so `mail.example.com` finds `example.com`). Null when none is on the
	 * account. Scoped to `CF_ACCOUNT_ID` when set.
	 */
	async findZone(hostname: string): Promise<CfZone | null> {
		const labels = hostname.toLowerCase().replace(/\.$/, "").split(".");
		for (let i = 0; i + 1 < labels.length; i++) {
			const candidate = labels.slice(i).join(".");
			const params = new URLSearchParams({ name: candidate });
			if (this.accountId) params.set("account.id", this.accountId);
			const zones = await this.request<CfZone[]>(`/zones?${params.toString()}`);
			const zone = zones.find((z) => z.name === candidate);
			if (zone) return zone;
		}
		return null;
	}

	/** One page of the zones the token sees, scoped to the account when known. */
	async listZonesPage(page: number, perPage = 50): Promise<{ zones: CfZone[]; totalCount: number | null }> {
		const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
		if (this.accountId) params.set("account.id", this.accountId);
		const res = await this.requestWithInfo<CfZone[]>(`/zones?${params.toString()}`);
		return { zones: Array.isArray(res.result) ? res.result : [], totalCount: res.info?.total_count ?? null };
	}

	getZone(zoneId: string): Promise<CfZone> {
		return this.request<CfZone>(`/zones/${enc(zoneId)}`);
	}

	// -- dns records -------------------------------------------------------------

	/** Records at exactly `name` (all types unless `type`). One page of 100 is plenty for one name. */
	listDnsRecords(zoneId: string, filter: { type?: string; name?: string } = {}): Promise<CfDnsRecordFull[]> {
		const params = new URLSearchParams({ per_page: "100" });
		if (filter.type) params.set("type", filter.type);
		if (filter.name) params.set("name", filter.name);
		return this.request<CfDnsRecordFull[]>(`/zones/${enc(zoneId)}/dns_records?${params.toString()}`);
	}

	createDnsRecord(zoneId: string, record: CfDnsRecordInput): Promise<CfDnsRecordFull> {
		return this.request<CfDnsRecordFull>(`/zones/${enc(zoneId)}/dns_records`, { method: "POST", body: record });
	}

	/** Full replace (PUT): type, name and content are required. */
	updateDnsRecord(zoneId: string, recordId: string, record: CfDnsRecordInput): Promise<CfDnsRecordFull> {
		return this.request<CfDnsRecordFull>(`/zones/${enc(zoneId)}/dns_records/${enc(recordId)}`, {
			method: "PUT",
			body: record,
		});
	}

	async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
		await this.request<{ id: string }>(`/zones/${enc(zoneId)}/dns_records/${enc(recordId)}`, { method: "DELETE" });
	}

	// -- email routing ---------------------------------------------------------

	getRoutingSettings(zoneId: string): Promise<CfRoutingSettings> {
		return this.request<CfRoutingSettings>(`/zones/${enc(zoneId)}/email/routing`);
	}

	async getRoutingDns(zoneId: string): Promise<CfRoutingDns> {
		const result = await this.request<
			CfDnsRecord[] | { record?: CfDnsRecord[]; errors?: { missing?: CfDnsRecord }[] }
		>(`/zones/${enc(zoneId)}/email/routing/dns`);
		// The endpoint has answered both a bare list and a `{record, errors}` shape.
		if (Array.isArray(result)) return { records: result, missing: [] };
		return {
			records: result?.record ?? [],
			missing: (result?.errors ?? []).map((e) => e.missing).filter((r): r is CfDnsRecord => !!r),
		};
	}

	/** Enable Email Routing and add its MX/SPF/DKIM records. `name` for a subdomain. */
	enableRoutingDns(zoneId: string, name?: string): Promise<CfRoutingSettings> {
		return this.request<CfRoutingSettings>(`/zones/${enc(zoneId)}/email/routing/dns`, {
			method: "POST",
			body: name ? { name } : {},
		});
	}

	async getCatchAll(zoneId: string): Promise<CfRoutingRule | null> {
		try {
			return await this.request<CfRoutingRule>(`/zones/${enc(zoneId)}/email/routing/rules/catch_all`);
		} catch (e) {
			if (e instanceof CloudflareApiError && e.status === 404) return null;
			throw e;
		}
	}

	/** Point the zone's catch-all at this Worker. */
	putCatchAllToWorker(zoneId: string): Promise<CfRoutingRule> {
		return this.request<CfRoutingRule>(`/zones/${enc(zoneId)}/email/routing/rules/catch_all`, {
			method: "PUT",
			body: {
				name: `Route all email to ${this.workerScriptName}`,
				enabled: true,
				matchers: [{ type: "all" }],
				actions: [{ type: "worker", value: [this.workerScriptName] }],
			},
		});
	}

	/** Restore a catch-all rule exactly (revert of an overwrite). */
	putCatchAll(zoneId: string, rule: Pick<CfRoutingRule, "enabled" | "matchers" | "actions" | "name">): Promise<CfRoutingRule> {
		return this.request<CfRoutingRule>(`/zones/${enc(zoneId)}/email/routing/rules/catch_all`, {
			method: "PUT",
			body: {
				...(rule.name ? { name: rule.name } : {}),
				enabled: rule.enabled ?? false,
				matchers: rule.matchers,
				actions: rule.actions,
			},
		});
	}

	/** Whether a rule already delivers to this Worker. */
	isRuleToWorker(rule: CfRoutingRule | null): boolean {
		return Boolean(
			rule?.enabled &&
				rule.actions?.some((a) => a.type === "worker" && (a.value ?? []).includes(this.workerScriptName)),
		);
	}

	// -- email sending ---------------------------------------------------------

	listSendingSubdomains(zoneId: string): Promise<CfSendingSubdomain[]> {
		return this.request<CfSendingSubdomain[]>(`/zones/${enc(zoneId)}/email/sending/subdomains`);
	}

	getSendingSubdomain(zoneId: string, id: string): Promise<CfSendingSubdomain> {
		return this.request<CfSendingSubdomain>(
			`/zones/${enc(zoneId)}/email/sending/subdomains/${enc(id)}`,
		);
	}

	createSendingSubdomain(zoneId: string, name: string): Promise<CfSendingSubdomain> {
		return this.request<CfSendingSubdomain>(`/zones/${enc(zoneId)}/email/sending/subdomains`, {
			method: "POST",
			body: { name },
		});
	}

	// -- account: workers and vectorize -----------------------------------------

	private account(): string {
		if (!this.accountId) throw new Error("No Cloudflare account id: set CF_ACCOUNT_ID or connect an account token.");
		return enc(this.accountId);
	}

	listWorkerScripts(): Promise<CfWorkerScript[]> {
		return this.request<CfWorkerScript[]>(`/accounts/${this.account()}/workers/scripts`);
	}

	async getScriptBindings(scriptName: string): Promise<CfScriptBinding[]> {
		const settings = await this.request<{ bindings?: CfScriptBinding[] }>(
			`/accounts/${this.account()}/workers/scripts/${enc(scriptName)}/settings`,
		);
		return Array.isArray(settings?.bindings) ? settings.bindings : [];
	}

	/** Null when the index does not exist. */
	async getVectorizeIndex(name: string): Promise<CfVectorizeIndex | null> {
		try {
			return await this.request<CfVectorizeIndex>(`/accounts/${this.account()}/vectorize/v2/indexes/${enc(name)}`);
		} catch (e) {
			if (e instanceof CloudflareApiError && e.status === 404) return null;
			throw e;
		}
	}

	async listMetadataIndexes(name: string): Promise<CfMetadataIndex[]> {
		const res = await this.request<{ metadataIndexes?: CfMetadataIndex[] }>(
			`/accounts/${this.account()}/vectorize/v2/indexes/${enc(name)}/metadata_index/list`,
		);
		return res?.metadataIndexes ?? [];
	}

	async createMetadataIndex(name: string, propertyName: string, indexType: "string" | "number" | "boolean"): Promise<void> {
		await this.request<unknown>(`/accounts/${this.account()}/vectorize/v2/indexes/${enc(name)}/metadata_index/create`, {
			method: "POST",
			body: { propertyName, indexType },
		});
	}

	getSendingSubdomainDns(zoneId: string, id: string): Promise<CfDnsRecord[]> {
		return this.request<CfDnsRecord[]>(
			`/zones/${enc(zoneId)}/email/sending/subdomains/${enc(id)}/dns`,
		);
	}
}

function enc(segment: string): string {
	return encodeURIComponent(segment);
}

/** The Worker script that routing rules should target. */
export function workerScriptName(env: Env): string {
	const raw = (env as { WORKER_SCRIPT_NAME?: string }).WORKER_SCRIPT_NAME?.trim();
	return raw || DEFAULT_WORKER_SCRIPT_NAME;
}

/**
 * A client when `CF_API_TOKEN` is configured, else null. Env only: callers
 * use the async `cloudflareClient` (./cf-connection.ts), which also reads the
 * stored connection. Kept for tests and sync callers.
 */
export function cloudflareClientFromEnv(env: Env, fetchImpl?: typeof fetch): CloudflareClient | null {
	const token = (env as { CF_API_TOKEN?: string }).CF_API_TOKEN?.trim();
	if (!token) return null;
	const accountId = (env as { CF_ACCOUNT_ID?: string }).CF_ACCOUNT_ID?.trim() || undefined;
	return new CloudflareClient({
		token,
		accountId,
		workerScriptName: workerScriptName(env),
		fetchImpl,
	});
}
