// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The Cloudflare analytics client with a mocked fetch serving recorded-shape
 * fixtures, plus the cache key, the Cache API wrapper and the window rules.
 */

import { describe, expect, it, vi } from "vitest";
import {
	CfAnalyticsClient,
	CfAnalyticsError,
	DMARC_QUERY,
	INBOUND_QUERY,
	OVERVIEW_QUERY,
	RAW_ROW_LIMIT,
	REFRESH_MIN_INTERVAL_SECONDS,
	analyticsCacheKey,
	analyticsTokens,
	analyticsWindow,
	analyticsZoneTags,
	cachedJson,
	datesInWindow,
	type CacheLike,
} from "../workers/lib/cf-analytics";
import overviewFixture from "./fixtures/cf-analytics/graphql-overview.json";
import dmarcFixture from "./fixtures/cf-analytics/graphql-dmarc.json";
import inboundFixture from "./fixtures/cf-analytics/graphql-inbound.json";
import reputationFixture from "./fixtures/cf-analytics/rest-reputation.json";
import limitsFixture from "./fixtures/cf-analytics/rest-limits.json";
import suppressionsFixture from "./fixtures/cf-analytics/rest-suppressions.json";
import subdomainsFixture from "./fixtures/cf-analytics/rest-subdomains.json";
import rulesFixture from "./fixtures/cf-analytics/rest-rules.json";
import dnsFixture from "./fixtures/cf-analytics/rest-dns-status.json";

const ZONE = "b8f81bfc13367df4146457bcd04befe4";
const NOW = Date.parse("2026-10-26T06:02:30.000Z");

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function client(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
	return new CfAnalyticsClient({
		graphqlToken: "gql-token",
		restToken: "rest-token",
		fetchImpl: fetchImpl as unknown as typeof fetch,
	});
}

describe("window", () => {
	it("floors the end to 5 minutes so cache keys are stable", () => {
		const w = analyticsWindow(7, NOW);
		expect(w.end).toBe("2026-10-26T06:00:00.000Z");
		expect(w.start).toBe("2026-10-19T06:00:00.000Z");
		expect(w.reputationStart).toBe("2026-10-19T06:00:00.000Z");
		expect(analyticsWindow(7, NOW + 60_000).end).toBe(w.end);
	});

	it("caps anything over Cloudflare's 31-day retention", () => {
		expect(analyticsWindow(30, NOW).capped).toBe(false);
		expect(analyticsWindow(90, NOW).capped).toBe(true);
	});

	it("lists every touched UTC date, end exclusive", () => {
		expect(datesInWindow("2026-10-24T06:00:00.000Z", "2026-10-26T06:00:00.000Z")).toEqual([
			"2026-10-24",
			"2026-10-25",
			"2026-10-26",
		]);
		expect(datesInWindow("2026-10-25T00:00:00.000Z", "2026-10-26T00:00:00.000Z")).toEqual(["2026-10-25"]);
		expect(datesInWindow(analyticsWindow(30, NOW).start, analyticsWindow(30, NOW).end)).toHaveLength(31);
	});
});

describe("cache key", () => {
	it("is order-independent for params and array values", () => {
		const a = analyticsCacheKey("overview", { zones: ["z2", "z1"], start: "s", end: "e" });
		const b = analyticsCacheKey("overview", { end: "e", start: "s", zones: ["z1", "z2"] });
		expect(a).toBe(b);
		expect(a).toBe("https://analytics-cache.tapetide.internal/v1/overview?end=e&start=s&zones=z1%2Cz2");
	});

	it("differs by section, window and zones, and drops null/undefined", () => {
		const base = { zones: ["z1"], start: "s", end: "e" };
		const key = analyticsCacheKey("overview", base);
		expect(analyticsCacheKey("inbound", base)).not.toBe(key);
		expect(analyticsCacheKey("overview", { ...base, start: "s2" })).not.toBe(key);
		expect(analyticsCacheKey("overview", { ...base, zones: ["z1", "z3"] })).not.toBe(key);
		expect(analyticsCacheKey("overview", { ...base, account: null, extra: undefined })).toBe(key);
	});

	it("is the same for two requests a minute apart in the same 5-minute bucket", () => {
		const k = (t: number) => {
			const w = analyticsWindow(7, t);
			return analyticsCacheKey("overview", { zones: [ZONE], start: w.start, end: w.end });
		};
		expect(k(NOW)).toBe(k(NOW + 60_000));
		expect(k(NOW)).not.toBe(k(NOW + 5 * 60_000));
	});
});

function memoryCache(): CacheLike & { store: Map<string, Response>; puts: number } {
	const store = new Map<string, Response>();
	const cache = {
		store,
		puts: 0,
		async match(key: Request | string) {
			const hit = store.get(String(key));
			return hit ? hit.clone() : undefined;
		},
		async put(key: Request | string, response: Response) {
			cache.puts += 1;
			store.set(String(key), response.clone());
		},
	};
	return cache;
}

describe("cachedJson", () => {
	it("loads once, then serves the cached copy with its original cachedAt", async () => {
		const cache = memoryCache();
		const loader = vi.fn(async () => ({ n: 1 }));
		const first = await cachedJson(cache, "k", loader, { now: () => NOW });
		const second = await cachedJson(cache, "k", loader, { now: () => NOW + 1000 });
		expect(loader).toHaveBeenCalledTimes(1);
		expect(first).toEqual({ data: { n: 1 }, cachedAt: new Date(NOW).toISOString(), hit: false });
		expect(second).toEqual({ data: { n: 1 }, cachedAt: new Date(NOW).toISOString(), hit: true });
		const stored = cache.store.get("k")!;
		expect(stored.headers.get("Cache-Control")).toBe("max-age=300");
	});

	it("refresh reloads and repopulates once the cached copy is 30 s old", async () => {
		const cache = memoryCache();
		const loader = vi.fn(async () => ({ n: loader.mock.calls.length }));
		await cachedJson(cache, "k", loader, { now: () => NOW });
		const fresh = await cachedJson(cache, "k", loader, { refresh: true, now: () => NOW + 31_000 });
		expect(loader).toHaveBeenCalledTimes(2);
		expect(fresh).toMatchObject({ hit: false, cachedAt: new Date(NOW + 31_000).toISOString() });
		expect(cache.puts).toBe(2);
		// The repopulated copy is what a plain read gets next.
		expect((await cachedJson(cache, "k", loader, { now: () => NOW + 32_000 })).cachedAt).toBe(fresh.cachedAt);
	});

	it("rate-limits refresh: a copy younger than 30 s is served instead", async () => {
		const cache = memoryCache();
		const loader = vi.fn(async () => ({ n: 1 }));
		await cachedJson(cache, "k", loader, { now: () => NOW });
		for (const dt of [1_000, 10_000, 29_999]) {
			const got = await cachedJson(cache, "k", loader, { refresh: true, now: () => NOW + dt });
			expect(got.hit).toBe(true);
		}
		expect(loader).toHaveBeenCalledTimes(1);
		expect(REFRESH_MIN_INTERVAL_SECONDS).toBe(30);
	});

	it("does not cache a failure", async () => {
		const cache = memoryCache();
		await expect(cachedJson(cache, "k", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
		expect(cache.store.size).toBe(0);
	});

	it("works with no cache (Node)", async () => {
		expect((await cachedJson(null, "k", async () => 5)).data).toBe(5);
	});
});

describe("tokens and zones", () => {
	it("prefers CF_ANALYTICS_TOKEN; GraphQL falls back to EMAIL_ANALYTICS_TOKEN; REST does not", () => {
		expect(analyticsTokens({ CF_ANALYTICS_TOKEN: "a", EMAIL_ANALYTICS_TOKEN: "b" })).toEqual({ graphql: "a", rest: "a" });
		expect(analyticsTokens({ EMAIL_ANALYTICS_TOKEN: "b" })).toEqual({ graphql: "b", rest: null });
		expect(analyticsTokens({})).toEqual({ graphql: null, rest: null });
		expect(analyticsTokens({ CF_ANALYTICS_TOKEN: "  " })).toEqual({ graphql: null, rest: null });
	});

	it("unions configured zone ids with EMAIL_ANALYTICS_ZONE_TAG, sorted", () => {
		const env = {
			ZONES: JSON.stringify([
				{ domain: "b.example.com", name: "B", zoneId: "zz" },
				{ domain: "a.example.com", name: "A", zoneId: "aa" },
			]),
			EMAIL_ANALYTICS_ZONE_TAG: "aa",
		};
		expect(analyticsZoneTags(env as never)).toEqual(["aa", "zz"]);
	});
});

describe("GraphQL client", () => {
	it("sends one combined overview query with the zones and window", async () => {
		const calls: { url: string; body: { query: string; variables: Record<string, unknown> }; auth: string | null }[] = [];
		const c = client(async (url, init) => {
			calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("Authorization") });
			return json(overviewFixture);
		});
		const w = analyticsWindow(7, NOW);
		const zones = await c.overview([ZONE], w);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.cloudflare.com/client/v4/graphql");
		expect(calls[0].auth).toBe("Bearer gql-token");
		expect(calls[0].body.query).toBe(OVERVIEW_QUERY);
		expect(calls[0].body.variables).toEqual({ zones: [ZONE], start: w.start, end: w.end, repStart: w.reputationStart });
		expect(zones[0].zoneTag).toBe(ZONE);
		expect(zones[0].sending.length).toBeGreaterThan(0);
		expect(zones[0].raw.length).toBeGreaterThan(0);
		expect(zones[0].complaints).toEqual([]);
	});

	it("the queries filter inbound to incoming mail and select sampleInterval", () => {
		expect(INBOUND_QUERY).toContain('eventType: "incoming"');
		expect(OVERVIEW_QUERY).toContain('eventType: "incoming"');
		for (const q of [OVERVIEW_QUERY, INBOUND_QUERY, DMARC_QUERY]) expect(q).toContain("sampleInterval");
		expect(OVERVIEW_QUERY).toContain("isEmailSending: 1");
	});

	it("throws on a GraphQL errors array even with HTTP 200", async () => {
		const c = client(async () =>
			json({ data: null, errors: [{ message: "zone cannot request data older than 4w3d" }] }),
		);
		await expect(c.inbound([ZONE], analyticsWindow(7, NOW))).rejects.toThrow(/older than 4w3d/);
	});

	it("throws on HTTP failure", async () => {
		const c = client(async () => new Response("nope", { status: 500 }));
		await expect(c.dmarc([ZONE], analyticsWindow(7, NOW))).rejects.toBeInstanceOf(CfAnalyticsError);
	});

	it("DMARC is queried by date", async () => {
		let variables: Record<string, unknown> = {};
		const c = client(async (_url, init) => {
			variables = JSON.parse(String(init.body)).variables;
			return json(dmarcFixture);
		});
		const out = await c.dmarc([ZONE], analyticsWindow(30, NOW));
		expect(variables).toEqual({ zones: [ZONE], startDate: "2026-09-26", endDate: "2026-10-26" });
		expect(out[0].bySource[0].dimensions.sourceOrgName).toBe("Cloudflare, Inc.");
	});

	it("inbound returns groups, errors and recipients", async () => {
		const c = client(async () => json(inboundFixture));
		const out = await c.inbound([ZONE], analyticsWindow(7, NOW));
		expect(out[0].groups.length).toBeGreaterThan(0);
		expect(out[0].recipients[0].to).toMatch(/@example\.com$/);
	});

	it("bisects the raw sending window when the row limit saturates", async () => {
		const row = overviewFixture.data.viewer.zones[0].raw[0];
		const windows: { start: string; end: string }[] = [];
		const c = client(async (_url, init) => {
			const { query, variables } = JSON.parse(String(init.body));
			if (query === OVERVIEW_QUERY) {
				const z = overviewFixture.data.viewer.zones[0];
				return json({ data: { viewer: { zones: [{ ...z, raw: Array(RAW_ROW_LIMIT).fill(row) }] } }, errors: null });
			}
			windows.push({ start: variables.start, end: variables.end });
			// The full window saturates; each half returns 3 rows.
			const saturated = windows.length === 1;
			return json({
				data: { viewer: { zones: [{ zoneTag: ZONE, raw: saturated ? Array(RAW_ROW_LIMIT).fill(row) : [row, row, row] }] } },
				errors: null,
			});
		});
		const out = await c.overview([ZONE], analyticsWindow(7, NOW));
		expect(windows).toHaveLength(3);
		expect(windows[1].end).toBe(windows[2].start);
		expect(out[0].raw).toHaveLength(6);
	});
});

describe("REST client", () => {
	const routes: Record<string, unknown> = {
		"/accounts/acct/email/sending/reputation": reputationFixture,
		"/accounts/acct/email/sending/limits": limitsFixture,
		[`/zones/${ZONE}/email/sending/subdomains`]: subdomainsFixture,
		[`/zones/${ZONE}/email/sending/subdomains/024bdc70a3544d108d5444722b30486b/dns/status`]: dnsFixture,
		[`/zones/${ZONE}`]: { success: true, errors: [], result: { id: ZONE, account: { id: "acct" } } },
	};
	const rest = () => {
		const seen: { method: string; path: string; auth: string | null }[] = [];
		const c = client(async (url, init) => {
			const u = new URL(url);
			const path = u.pathname.replace("/client/v4", "");
			seen.push({ method: init.method ?? "GET", path: path + u.search, auth: new Headers(init.headers).get("Authorization") });
			if (path.endsWith("/email/sending/suppressions")) return json(suppressionsFixture);
			if (path.endsWith("/email/routing/rules")) return json(rulesFixture);
			const body = routes[path];
			return body ? json(body) : json({ success: false, errors: [{ code: 7003, message: "No route" }] }, 404);
		});
		return { c, seen };
	};

	it("reads reputation, limits and the account id with GET only", async () => {
		const { c, seen } = rest();
		expect(await c.accountIdFor(ZONE)).toBe("acct");
		expect((await c.reputation("acct")).active_policy?.customer_bounce?.warning_at).toBe(0.4);
		expect((await c.limits("acct")).quota).toEqual({ value: 5000, unit: "day" });
		expect(seen.every((s) => s.method === "GET" && s.auth === "Bearer rest-token")).toBe(true);
	});

	it("pages suppressions with per_page=1000 and stops at a null cursor", async () => {
		const { c, seen } = rest();
		const items = await c.suppressions("acct");
		expect(items).toHaveLength(5);
		expect(seen).toHaveLength(1);
		expect(seen[0].path).toContain("per_page=1000");
	});

	it("follows next_cursor", async () => {
		let page = 0;
		const c = client(async (url) => {
			page += 1;
			const cursor = new URL(url).searchParams.get("cursor");
			return json({
				success: true,
				errors: [],
				result: [{ id: `s${page}`, email: `p${page}@example.com`, reason: "manual", created_at: "", expires_at: null }],
				result_info: { next_cursor: page === 1 ? "abc" : null, cursorSeen: cursor },
			});
		});
		const items = await c.suppressions("acct");
		expect(items.map((s) => s.id)).toEqual(["s1", "s2"]);
	});

	it("reads subdomains, DNS status and rules", async () => {
		const { c } = rest();
		const subs = await c.subdomains(ZONE);
		expect(subs.map((s) => s.name).sort()).toEqual(["example.com", "mail.example.com"]);
		expect((await c.subdomainDnsStatus(ZONE, "024bdc70a3544d108d5444722b30486b")).status).toBe("ready");
		expect(await c.routingRules(ZONE)).toHaveLength(9);
	});

	it("surfaces the Cloudflare error code", async () => {
		const { c } = rest();
		await expect(c.subdomainDnsStatus(ZONE, "missing")).rejects.toThrow(/HTTP 404 \(7003: No route\)/);
	});

	it("refuses without a REST token", async () => {
		const c = new CfAnalyticsClient({ graphqlToken: "g", restToken: null, fetchImpl: vi.fn() as never });
		await expect(c.limits("acct")).rejects.toThrow(/REST token not configured/);
	});
});
