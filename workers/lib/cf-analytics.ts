// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Typed, read-only Cloudflare client for the analytics console.
 *
 * - GraphQL: one combined query per page section (overview, inbound, DMARC),
 *   across every configured zone at once via `zoneTag_in` (max 10 per query).
 * - REST: reputation, limits, suppressions (account); sending subdomains, DNS
 *   status and routing rules (zone). GET only.
 * - Cache API: every Cloudflare bundle is cached for 5 minutes under a key
 *   built from the section, zones and a window rounded to 5 minutes, so a page
 *   load never fans out per widget and the 300-queries-per-5-minutes GraphQL
 *   limit is never close. The token is never part of the key.
 *
 * Field semantics and gotchas are documented in the analytics spec; the short
 * version: sending rows are per envelope recipient, counts must be multiplied
 * by `sampleInterval`, a GraphQL `errors` array arrives with HTTP 200, and data
 * older than 31 days cannot be queried.
 *
 * Tokens: `CF_ANALYTICS_TOKEN` for everything; GraphQL falls back to
 * `EMAIL_ANALYTICS_TOKEN`. Without either the console serves local data only.
 */

import type { Env } from "../types";
import { getZones } from "./zones";
import { resolveConnectionAccountId, resolveConnectionToken } from "./cf-connection";

export const CF_GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
export const CF_REST_BASE = "https://api.cloudflare.com/client/v4";
/** `notOlderThan` and `maxDuration` on every email dataset: 2,678,400 s. */
export const CF_RETENTION_DAYS = 31;
export const ANALYTICS_CACHE_TTL_SECONDS = 300;
/** Documented GraphQL limit on zones per query. */
export const MAX_ZONES_PER_QUERY = 10;
/** `maxPageSize` on the email datasets; there is no offset pagination. */
export const RAW_ROW_LIMIT = 10000;

export class CfAnalyticsError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "CfAnalyticsError";
	}
}

// -- configuration -----------------------------------------------------------

export interface CfAnalyticsTokens {
	/** Token for GraphQL: `CF_ANALYTICS_TOKEN`, else the stored connection, else `EMAIL_ANALYTICS_TOKEN`. */
	graphql: string | null;
	/** Token for REST: `CF_ANALYTICS_TOKEN`, else the stored connection (the legacy token lacks Email Sending Read). */
	rest: string | null;
}

/**
 * Pure. `connection` is the token stored in Settings → Cloudflare connection
 * (not `CF_API_TOKEN`: a deployment that set only that keeps its analytics
 * exactly as before).
 */
export function analyticsTokens(
	env: Pick<Env, "EMAIL_ANALYTICS_TOKEN" | "CF_ANALYTICS_TOKEN">,
	connection: string | null = null,
): CfAnalyticsTokens {
	const primary = env.CF_ANALYTICS_TOKEN?.trim() || connection?.trim() || null;
	const legacy = env.EMAIL_ANALYTICS_TOKEN?.trim() || null;
	return { graphql: primary ?? legacy, rest: primary };
}

/**
 * Zone ids to query: every configured or stored zone id plus
 * `EMAIL_ANALYTICS_ZONE_TAG`, sorted so cache keys are stable. Call
 * `loadStoredDomains(env)` first so API-added domains are included.
 */
export function analyticsZoneTags(env: Env): string[] {
	const ids = getZones(env)
		.map((zone) => zone.zoneId)
		.filter((id): id is string => typeof id === "string" && id !== "");
	const explicit = env.EMAIL_ANALYTICS_ZONE_TAG?.trim();
	return [...new Set([...ids, ...(explicit ? [explicit] : [])])].sort();
}

// -- window ------------------------------------------------------------------

export interface AnalyticsTimeWindow {
	days: number;
	/** ISO start, inclusive. */
	start: string;
	/** ISO end, exclusive; `now` floored to 5 minutes so cache keys are stable. */
	end: string;
	/** Start of the 7-day rolling reputation window (Cloudflare evaluates 7 days). */
	reputationStart: string;
	/** True when the window is older than Cloudflare retains (e.g. 90 days). */
	capped: boolean;
}

const FIVE_MINUTES = 5 * 60_000;
const DAY = 86_400_000;

export function analyticsWindow(days: number, now = Date.now()): AnalyticsTimeWindow {
	const endMs = Math.floor(now / FIVE_MINUTES) * FIVE_MINUTES;
	return {
		days,
		start: new Date(endMs - days * DAY).toISOString(),
		end: new Date(endMs).toISOString(),
		reputationStart: new Date(endMs - 7 * DAY).toISOString(),
		capped: days > CF_RETENTION_DAYS,
	};
}

/** Every UTC date (`YYYY-MM-DD`) the window touches, oldest first. */
export function datesInWindow(start: string, end: string): string[] {
	const out: string[] = [];
	const first = Date.parse(start.slice(0, 10) + "T00:00:00Z");
	// `end` is exclusive: a window ending exactly at midnight does not touch that day.
	const last = Date.parse(new Date(Date.parse(end) - 1).toISOString().slice(0, 10) + "T00:00:00Z");
	for (let t = first; t <= last; t += DAY) out.push(new Date(t).toISOString().slice(0, 10));
	return out;
}

// -- cache -------------------------------------------------------------------

/** The slice of the Workers Cache API this module uses; injectable for tests. */
export interface CacheLike {
	match(request: Request | string): Promise<Response | undefined>;
	put(request: Request | string, response: Response): Promise<void>;
}

/** `caches.default` in a Worker; null in Node (tests), which disables caching. */
export function defaultCache(): CacheLike | null {
	const store = (globalThis as { caches?: { default?: CacheLike } }).caches;
	return store?.default ?? null;
}

type KeyPart = string | number | boolean | null | undefined | readonly string[];

/**
 * Cache key URL for a Cloudflare bundle. Parameters are sorted, array values
 * sorted and comma-joined, undefined/null dropped, so equal queries map to the
 * same key regardless of argument order. Never pass a token here.
 */
export function analyticsCacheKey(section: string, parts: Record<string, KeyPart>): string {
	const params = new URLSearchParams();
	for (const name of Object.keys(parts).sort()) {
		const value = parts[name];
		if (value === undefined || value === null) continue;
		params.set(name, Array.isArray(value) ? [...value].sort().join(",") : String(value));
	}
	return `https://analytics-cache.tapetide.internal/v1/${encodeURIComponent(section)}?${params.toString()}`;
}

export interface Cached<T> {
	data: T;
	/** ISO time the data was fetched from Cloudflare. */
	cachedAt: string;
	hit: boolean;
}

/**
 * A forced refresh is honoured at most once per this many seconds per key: a
 * newer cached copy is served instead, so repeated refresh clicks (or several
 * widgets refreshing together) cannot burn the GraphQL budget.
 */
export const REFRESH_MIN_INTERVAL_SECONDS = 30;

/**
 * Return the cached bundle for `key`, or run `loader` and cache its result for
 * `ttlSeconds`. A loader that throws is not cached. `refresh` reloads unless
 * the cached copy is younger than `REFRESH_MIN_INTERVAL_SECONDS`.
 */
export async function cachedJson<T>(
	cache: CacheLike | null,
	key: string,
	loader: () => Promise<T>,
	options: { ttlSeconds?: number; refresh?: boolean; now?: () => number } = {},
): Promise<Cached<T>> {
	const now = options.now ?? Date.now;
	if (cache) {
		try {
			const hit = await cache.match(key);
			if (hit) {
				const body = (await hit.json()) as { cachedAt: string; data: T };
				const age = now() - Date.parse(body.cachedAt);
				if (!options.refresh || age < REFRESH_MIN_INTERVAL_SECONDS * 1000) {
					return { data: body.data, cachedAt: body.cachedAt, hit: true };
				}
			}
		} catch (e) {
			console.warn("analytics cache read failed:", (e as Error).message);
		}
	}
	const data = await loader();
	const cachedAt = new Date(now()).toISOString();
	if (cache) {
		const ttl = options.ttlSeconds ?? ANALYTICS_CACHE_TTL_SECONDS;
		try {
			await cache.put(
				key,
				new Response(JSON.stringify({ cachedAt, data }), {
					headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` },
				}),
			);
		} catch (e) {
			console.warn("analytics cache write failed:", (e as Error).message);
		}
	}
	return { data, cachedAt, hit: false };
}

// -- GraphQL row types -------------------------------------------------------

export interface SendingGroup {
	count: number;
	dimensions: {
		date?: string;
		status: string;
		sendingDomain: string;
		errorCause: string;
		errorAttribution: string;
		isSpam: number;
		sampleInterval: number;
	};
}

export interface SendingRawRow {
	datetime: string;
	messageId: string;
	from: string;
	sendingDomain: string;
	status: string;
	errorCause: string;
	errorAttribution: string;
	errorDetail: string;
	sampleInterval: number;
}

export interface ComplaintGroup {
	count: number;
	dimensions: { date?: string; sendingDomain: string };
}

export interface RoutingGroup {
	count: number;
	dimensions: {
		date?: string;
		action?: string;
		status?: string;
		ruleMatched?: string;
		spf?: string;
		dkim?: string;
		dmarc?: string;
		isSpam?: number;
		sampleInterval: number;
	};
}

export interface RoutingErrorRow {
	datetime: string;
	from: string;
	to: string;
	status: string;
	action: string;
	errorDetail: string;
	sampleInterval: number;
}

export interface RoutingRecipientRow {
	to: string;
	/** Dashed rule UUID; joins to REST rules after `normalizeRuleId`. */
	ruleMatched?: string;
	action?: string;
	status?: string;
	sampleInterval: number;
}

export interface DmarcGroup {
	sum: { totalMatchingMessages: number; dmarc?: number; spfPass?: number; dkimPass?: number };
	uniq?: { ipCount: number };
	dimensions: {
		date?: string;
		sourceOrgName?: string;
		orgName?: string;
		sourceIP?: string;
		sourcePTR?: string;
		headerFrom?: string;
		disposition?: string;
		evaluatedReason?: string;
		sampleInterval?: number;
	};
}

export interface OverviewZoneData {
	zoneTag: string;
	sending: SendingGroup[];
	reputation: SendingGroup[];
	complaints: ComplaintGroup[];
	reputationComplaints: ComplaintGroup[];
	received: RoutingGroup[];
	raw: SendingRawRow[];
}

export interface InboundZoneData {
	zoneTag: string;
	groups: RoutingGroup[];
	errors: RoutingErrorRow[];
	recipients: RoutingRecipientRow[];
}

export interface DmarcZoneData {
	zoneTag: string;
	bySource: DmarcGroup[];
	byReporter: DmarcGroup[];
	byDate: DmarcGroup[];
	detail: DmarcGroup[];
}

// -- queries -----------------------------------------------------------------

const RAW_SENDING_FIELDS =
	"datetime messageId from sendingDomain status errorCause errorAttribution errorDetail sampleInterval";

/**
 * Everything the overview needs from GraphQL in one request: status/domain/day
 * groups for the window, the rolling 7-day groups and complaints for the
 * reputation gauges, complaints, inbound volume per day, and the raw sending
 * rows used for the app/other-sender split.
 */
export const OVERVIEW_QUERY = `
query AnalyticsOverview($zones: [string!], $start: Time!, $end: Time!, $repStart: Time!) {
  viewer {
    zones(filter: { zoneTag_in: $zones }) {
      zoneTag
      sending: emailSendingAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end }, orderBy: [count_DESC]) {
        count
        dimensions { date status sendingDomain errorCause errorAttribution isSpam sampleInterval }
      }
      reputation: emailSendingAdaptiveGroups(limit: 10000, filter: { datetime_geq: $repStart, datetime_lt: $end }, orderBy: [count_DESC]) {
        count
        dimensions { status sendingDomain errorCause errorAttribution isSpam sampleInterval }
      }
      complaints: emailComplaintsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end, isEmailSending: 1 }) {
        count
        dimensions { date sendingDomain }
      }
      reputationComplaints: emailComplaintsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $repStart, datetime_lt: $end, isEmailSending: 1 }) {
        count
        dimensions { sendingDomain }
      }
      received: emailRoutingAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end, eventType: "incoming" }) {
        count
        dimensions { date sampleInterval }
      }
      raw: emailSendingAdaptive(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end }, orderBy: [datetime_DESC]) {
        ${RAW_SENDING_FIELDS}
      }
    }
  }
}`.trim();

/** Raw sending rows alone, for bisecting a window that saturated the row limit. */
export const RAW_SENDING_QUERY = `
query AnalyticsRawSending($zones: [string!], $start: Time!, $end: Time!) {
  viewer {
    zones(filter: { zoneTag_in: $zones }) {
      zoneTag
      raw: emailSendingAdaptive(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end }, orderBy: [datetime_DESC]) {
        ${RAW_SENDING_FIELDS}
      }
    }
  }
}`.trim();

/**
 * Inbound: routing groups (action/status/rule/auth by day), the error rows, and
 * the envelope recipient of every incoming row for the per-address table.
 * `eventType: "incoming"` excludes outbound `send_email` traffic, which leaks
 * into this dataset as `newEmail`.
 */
export const INBOUND_QUERY = `
query AnalyticsInbound($zones: [string!], $start: Time!, $end: Time!) {
  viewer {
    zones(filter: { zoneTag_in: $zones }) {
      zoneTag
      groups: emailRoutingAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end, eventType: "incoming" }, orderBy: [count_DESC]) {
        count
        dimensions { date action status ruleMatched spf dkim dmarc isSpam sampleInterval }
      }
      errors: emailRoutingAdaptive(limit: 50, filter: { datetime_geq: $start, datetime_lt: $end, eventType: "incoming", status_in: ["error", "rejected", "deliveryFailed"] }, orderBy: [datetime_DESC]) {
        datetime from to status action errorDetail sampleInterval
      }
      recipients: emailRoutingAdaptive(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end, eventType: "incoming" }, orderBy: [datetime_DESC]) {
        to ruleMatched action status sampleInterval
      }
    }
  }
}`.trim();

/**
 * DMARC aggregate reports (`dmarcReportsSourcesAdaptiveGroups`, date-keyed).
 * `sampleInterval` is a dimension everywhere so sums can be scaled.
 */
export const DMARC_QUERY = `
query AnalyticsDmarc($zones: [string!], $startDate: Date!, $endDate: Date!) {
  viewer {
    zones(filter: { zoneTag_in: $zones }) {
      zoneTag
      bySource: dmarcReportsSourcesAdaptiveGroups(limit: 1000, filter: { date_geq: $startDate, date_leq: $endDate }, orderBy: [sum_totalMatchingMessages_DESC]) {
        sum { totalMatchingMessages dmarc spfPass dkimPass }
        uniq { ipCount }
        dimensions { sourceOrgName sampleInterval }
      }
      byReporter: dmarcReportsSourcesAdaptiveGroups(limit: 1000, filter: { date_geq: $startDate, date_leq: $endDate }, orderBy: [sum_totalMatchingMessages_DESC]) {
        sum { totalMatchingMessages }
        dimensions { orgName sampleInterval }
      }
      byDate: dmarcReportsSourcesAdaptiveGroups(limit: 1000, filter: { date_geq: $startDate, date_leq: $endDate }, orderBy: [date_ASC]) {
        sum { totalMatchingMessages dmarc }
        dimensions { date sampleInterval }
      }
      detail: dmarcReportsSourcesAdaptiveGroups(limit: 2000, filter: { date_geq: $startDate, date_leq: $endDate }, orderBy: [sum_totalMatchingMessages_DESC]) {
        sum { totalMatchingMessages dmarc }
        dimensions { sourceIP sourcePTR sourceOrgName headerFrom disposition evaluatedReason sampleInterval }
      }
    }
  }
}`.trim();

// -- REST types --------------------------------------------------------------

export interface CfThresholdPolicy {
	warning_at: number;
	at_risk_at: number;
	minimum_denominator: number;
}

export interface CfReputation {
	status: string;
	status_since: string | null;
	grace_started_at?: string | null;
	evaluated_at?: string | null;
	active_policy?: {
		customer_bounce?: CfThresholdPolicy;
		complaint?: CfThresholdPolicy;
		spam_rejection?: CfThresholdPolicy;
		suspension_after_hours?: number;
	};
}

export interface CfLimits {
	quota: { value: number; unit: string } | null;
	usage: { sent: number; over_quota?: boolean; resets_at: string | null } | null;
}

export interface CfSuppression {
	id: string;
	email: string;
	reason: string;
	created_at: string;
	expires_at: string | null;
	scope?: { type: string; value?: string };
}

export interface CfSubdomain {
	id?: string;
	tag: string;
	name: string;
	enabled?: boolean;
}

export interface CfDnsStatus {
	status: string;
	errors?: unknown[];
}

export interface CfRule {
	id?: string;
	tag?: string;
	name?: string;
	enabled?: boolean;
	priority?: number;
	matchers: { type: string; field?: string; value?: string }[];
	actions: { type: string; value?: string[] }[];
}

interface Envelope<T> {
	success: boolean;
	errors?: { code?: number; message: string }[];
	result: T;
	result_info?: { page?: number; per_page?: number; total_count?: number; next_cursor?: string | null };
}

// -- client ------------------------------------------------------------------

export interface CfAnalyticsClientOptions {
	graphqlToken: string | null;
	restToken: string | null;
	fetchImpl?: typeof fetch;
	graphqlEndpoint?: string;
	restBase?: string;
}

export class CfAnalyticsClient {
	private readonly fetchImpl: typeof fetch;
	constructor(private readonly options: CfAnalyticsClientOptions) {
		this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
	}

	get hasGraphql(): boolean {
		return !!this.options.graphqlToken;
	}

	get hasRest(): boolean {
		return !!this.options.restToken;
	}

	/** POST a GraphQL query. Throws on HTTP failure or a non-empty `errors` array. */
	async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
		if (!this.options.graphqlToken) throw new CfAnalyticsError("GraphQL token not configured");
		const res = await this.fetchImpl(this.options.graphqlEndpoint ?? CF_GRAPHQL_ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.options.graphqlToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ query, variables }),
		});
		if (!res.ok) throw new CfAnalyticsError(`GraphQL HTTP ${res.status}`, res.status);
		const payload = (await res.json()) as { data?: T; errors?: { message?: string }[] | null };
		if (payload.errors && payload.errors.length > 0) {
			throw new CfAnalyticsError(
				`GraphQL: ${payload.errors.map((e) => e.message ?? "unknown error").join("; ")}`,
			);
		}
		if (!payload.data) throw new CfAnalyticsError("GraphQL: empty response");
		return payload.data;
	}

	/** GET a REST path (relative to `/client/v4`). Returns the whole envelope. */
	async get<T>(path: string): Promise<Envelope<T>> {
		if (!this.options.restToken) throw new CfAnalyticsError("REST token not configured");
		const res = await this.fetchImpl(`${this.options.restBase ?? CF_REST_BASE}${path}`, {
			method: "GET",
			headers: { Authorization: `Bearer ${this.options.restToken}` },
		});
		let body: Envelope<T> | null = null;
		try {
			body = (await res.json()) as Envelope<T>;
		} catch {
			// Non-JSON edge error page; reported below.
		}
		if (!res.ok || !body?.success) {
			const detail = body?.errors?.map((e) => (e.code ? `${e.code}: ${e.message}` : e.message)).join("; ");
			throw new CfAnalyticsError(`GET ${path.split("?")[0]}: HTTP ${res.status}${detail ? ` (${detail})` : ""}`, res.status);
		}
		return body;
	}

	// GraphQL sections. Zones beyond the per-query limit are dropped (logged).

	async overview(zones: string[], window: AnalyticsTimeWindow): Promise<OverviewZoneData[]> {
		const zoneTags = limitZones(zones);
		const data = await this.graphql<{ viewer: { zones: OverviewZoneData[] } }>(OVERVIEW_QUERY, {
			zones: zoneTags,
			start: window.start,
			end: window.end,
			repStart: window.reputationStart,
		});
		const out = data.viewer.zones.map(normalizeOverviewZone);
		// A saturated raw list may be missing its oldest rows; re-read by bisection.
		if (out.some((zone) => zone.raw.length >= RAW_ROW_LIMIT)) {
			const raw = await this.rawSending(zoneTags, window.start, window.end);
			for (const zone of out) zone.raw = raw.get(zone.zoneTag) ?? zone.raw;
		}
		return out;
	}

	/**
	 * Raw sending rows per zone, splitting the window whenever a response hits
	 * the row limit (the API has no offset pagination). Depth is bounded.
	 */
	async rawSending(zones: string[], start: string, end: string, depth = 0): Promise<Map<string, SendingRawRow[]>> {
		const data = await this.graphql<{ viewer: { zones: { zoneTag: string; raw: SendingRawRow[] | null }[] } }>(
			RAW_SENDING_QUERY,
			{ zones, start, end },
		);
		const result = new Map<string, SendingRawRow[]>();
		for (const zone of data.viewer.zones) result.set(zone.zoneTag, zone.raw ?? []);
		const saturated = [...result.values()].some((rows) => rows.length >= RAW_ROW_LIMIT);
		const startMs = Date.parse(start);
		const endMs = Date.parse(end);
		if (!saturated || depth >= 6 || endMs - startMs < 2000) return result;
		const mid = new Date(startMs + Math.floor((endMs - startMs) / 2)).toISOString();
		const [older, newer] = await Promise.all([
			this.rawSending(zones, start, mid, depth + 1),
			this.rawSending(zones, mid, end, depth + 1),
		]);
		const merged = new Map<string, SendingRawRow[]>();
		// `datetime_lt` makes the halves disjoint, so plain concatenation is exact.
		for (const map of [newer, older]) {
			for (const [zone, rows] of map) merged.set(zone, [...(merged.get(zone) ?? []), ...rows]);
		}
		return merged;
	}

	async inbound(zones: string[], window: AnalyticsTimeWindow): Promise<InboundZoneData[]> {
		const data = await this.graphql<{ viewer: { zones: InboundZoneData[] } }>(INBOUND_QUERY, {
			zones: limitZones(zones),
			start: window.start,
			end: window.end,
		});
		return data.viewer.zones.map((zone) => ({
			zoneTag: zone.zoneTag,
			groups: zone.groups ?? [],
			errors: zone.errors ?? [],
			recipients: zone.recipients ?? [],
		}));
	}

	async dmarc(zones: string[], window: AnalyticsTimeWindow): Promise<DmarcZoneData[]> {
		const data = await this.graphql<{ viewer: { zones: DmarcZoneData[] } }>(DMARC_QUERY, {
			zones: limitZones(zones),
			startDate: window.start.slice(0, 10),
			endDate: window.end.slice(0, 10),
		});
		return data.viewer.zones.map((zone) => ({
			zoneTag: zone.zoneTag,
			bySource: zone.bySource ?? [],
			byReporter: zone.byReporter ?? [],
			byDate: zone.byDate ?? [],
			detail: zone.detail ?? [],
		}));
	}

	// REST

	/** `GET /zones/{id}`: the zone's apex name and owning account. */
	async zone(zoneId: string): Promise<{ id: string; name: string; account?: { id?: string } }> {
		return (await this.get<{ id: string; name: string; account?: { id?: string } }>(`/zones/${enc(zoneId)}`)).result;
	}

	/** The owning account of a zone. */
	async accountIdFor(zoneId: string): Promise<string> {
		const id = (await this.zone(zoneId))?.account?.id;
		if (!id) throw new CfAnalyticsError(`zone ${zoneId} has no account id`);
		return id;
	}

	async reputation(accountId: string): Promise<CfReputation> {
		return (await this.get<CfReputation>(`/accounts/${enc(accountId)}/email/sending/reputation`)).result;
	}

	async limits(accountId: string): Promise<CfLimits> {
		return (await this.get<CfLimits>(`/accounts/${enc(accountId)}/email/sending/limits`)).result;
	}

	/** Every suppression, following `next_cursor` (bounded to 20 pages of 1000). */
	async suppressions(accountId: string): Promise<CfSuppression[]> {
		const out: CfSuppression[] = [];
		let cursor: string | null | undefined = null;
		for (let page = 0; page < 20; page++) {
			const params = new URLSearchParams({ per_page: "1000" });
			if (cursor) params.set("cursor", cursor);
			const body: Envelope<CfSuppression[]> = await this.get<CfSuppression[]>(
				`/accounts/${enc(accountId)}/email/sending/suppressions?${params.toString()}`,
			);
			out.push(...(body.result ?? []));
			cursor = body.result_info?.next_cursor;
			if (!cursor) break;
		}
		return out;
	}

	async subdomains(zoneId: string): Promise<CfSubdomain[]> {
		return (await this.get<CfSubdomain[]>(`/zones/${enc(zoneId)}/email/sending/subdomains`)).result ?? [];
	}

	async subdomainDnsStatus(zoneId: string, subdomainId: string): Promise<CfDnsStatus> {
		return (
			await this.get<CfDnsStatus>(
				`/zones/${enc(zoneId)}/email/sending/subdomains/${enc(subdomainId)}/dns/status`,
			)
		).result;
	}

	/** Every routing rule including the catch-all, paged (bounded to 10 pages of 50). */
	async routingRules(zoneId: string): Promise<CfRule[]> {
		const out: CfRule[] = [];
		for (let page = 1; page <= 10; page++) {
			const body = await this.get<CfRule[]>(`/zones/${enc(zoneId)}/email/routing/rules?per_page=50&page=${page}`);
			out.push(...(body.result ?? []));
			const total = body.result_info?.total_count ?? out.length;
			if (out.length >= total || (body.result ?? []).length === 0) break;
		}
		return out;
	}
}

function enc(segment: string): string {
	return encodeURIComponent(segment);
}

function limitZones(zones: string[]): string[] {
	if (zones.length > MAX_ZONES_PER_QUERY) {
		console.warn(`analytics: ${zones.length} zones configured; querying the first ${MAX_ZONES_PER_QUERY}.`);
	}
	return zones.slice(0, MAX_ZONES_PER_QUERY);
}

function normalizeOverviewZone(zone: OverviewZoneData): OverviewZoneData {
	return {
		zoneTag: zone.zoneTag,
		sending: zone.sending ?? [],
		reputation: zone.reputation ?? [],
		complaints: zone.complaints ?? [],
		reputationComplaints: zone.reputationComplaints ?? [],
		received: zone.received ?? [],
		raw: zone.raw ?? [],
	};
}

/** Env tokens only. Prefer `analyticsClient`, which also uses the stored connection. */
export function clientFromEnv(env: Env, fetchImpl?: typeof fetch): CfAnalyticsClient | null {
	return clientFor(analyticsTokens(env), fetchImpl);
}

function clientFor(tokens: CfAnalyticsTokens, fetchImpl?: typeof fetch): CfAnalyticsClient | null {
	if (!tokens.graphql && !tokens.rest) return null;
	return new CfAnalyticsClient({ graphqlToken: tokens.graphql, restToken: tokens.rest, fetchImpl });
}

/**
 * The analytics client: `CF_ANALYTICS_TOKEN` → stored connection →
 * `EMAIL_ANALYTICS_TOKEN` (GraphQL only). The AuthDO is only read when
 * `CF_ANALYTICS_TOKEN` is unset. Never throws.
 */
export async function analyticsClient(env: Env, fetchImpl?: typeof fetch): Promise<CfAnalyticsClient | null> {
	const connection = env.CF_ANALYTICS_TOKEN?.trim() ? null : await resolveConnectionToken(env);
	return clientFor(analyticsTokens(env, connection), fetchImpl);
}

/** `CF_ACCOUNT_ID`, else the stored connection's account. Null when neither is known. */
export async function analyticsAccountId(env: Env): Promise<string | null> {
	if (env.CF_ACCOUNT_ID?.trim()) return env.CF_ACCOUNT_ID.trim();
	// The connection's account only describes the connection's token.
	if (env.CF_ANALYTICS_TOKEN?.trim()) return null;
	return resolveConnectionAccountId(env);
}
