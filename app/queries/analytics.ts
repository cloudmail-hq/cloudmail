// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { ApiError } from "~/services/api";
import type { AnalyticsScope, Days } from "../../shared/analytics-types";
import type { UsageBudgetPatch } from "../../shared/usage";
import type { FixtureScenario } from "~/components/analytics/fixtures";
import { queryKeys } from "./keys";

/**
 * Hooks for the analytics console: one query per section, so a slow
 * Cloudflare call for DMARC never holds up the sending tiles.
 *
 * The Worker caches Cloudflare responses for 5 minutes, so the page keeps
 * data fresh for the same time and never refetches on focus: GraphQL allows
 * 300 queries per 5 minutes per user, and a tab switch should not spend them.
 *
 * In development, `?fixtures=<scenario>` on /analytics/* serves the fixtures in
 * `app/components/analytics/fixtures.ts` instead of calling the Worker. The
 * fixtures are loaded with a dynamic import behind `import.meta.env.DEV`, so
 * they are not part of the production bundle.
 */

const STALE_MS = 5 * 60_000;

/** Fixture scenario for this page load, or null for live data. */
export function fixtureScenario(): FixtureScenario | null {
	if (!import.meta.env.DEV || typeof window === "undefined") return null;
	const s = new URLSearchParams(window.location.search).get("fixtures");
	const allowed = ["demo", "issues", "empty", "unconfigured", "error", "loading", "unattributed"];
	return s && allowed.includes(s) ? (s as FixtureScenario) : null;
}

/**
 * A refresh asks the Worker to skip its cache. The flag stays up briefly so
 * every section refetching off the same click carries it.
 */
let bypassCacheUntil = 0;
function takeRefresh(): boolean {
	return Date.now() < bypassCacheUntil;
}

async function fromFixture<T>(
	scenario: FixtureScenario,
	build: (f: typeof import("~/components/analytics/fixtures")) => T,
	signal?: AbortSignal,
): Promise<T> {
	// Statically false in production builds, so the import (and its chunk) is
	// dropped entirely rather than shipped unused.
	if (!import.meta.env.DEV) throw new Error("Analytics fixtures are only available in development");
	const f = await import("~/components/analytics/fixtures");
	if (scenario === "loading") {
		// Hold forever (until aborted) so the skeletons can be inspected.
		await new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
	}
	// A short delay, so the loading state is visible on first paint.
	await new Promise((r) => setTimeout(r, 250));
	if (scenario === "error") {
		throw new ApiError(502, { error: "Cloudflare GraphQL returned an error: upstream timed out" });
	}
	return build(f);
}

const common = {
	staleTime: STALE_MS,
	refetchOnWindowFocus: false,
	placeholderData: keepPreviousData,
	retry: (count: number, err: unknown) =>
		// 4xx (forbidden scope, bad params) will not fix itself.
		!(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 1,
} as const;

export function useAnalyticsOverview(
	params: { days: Days; scope: AnalyticsScope; domain?: string; product?: string },
	enabled = true,
) {
	const fx = fixtureScenario();
	return useQuery({
		queryKey: queryKeys.analytics.section("overview", {
			days: params.days,
			scope: params.scope,
			domain: params.domain ?? "",
			product: params.product ?? "",
			source: fx ?? "live",
		}),
		queryFn: ({ signal }) =>
			fx
				? fromFixture(fx, (f) => f.overviewFixture(fx, params.days, params.scope), signal)
				: api.getAnalyticsOverview({ ...params, refresh: takeRefresh() }, { signal }),
		enabled,
		...common,
	});
}

export function useAnalyticsEngagement(params: { days: Days; mailbox?: string }, enabled = true) {
	const fx = fixtureScenario();
	return useQuery({
		queryKey: queryKeys.analytics.section("engagement", {
			days: params.days,
			mailbox: params.mailbox ?? "",
			source: fx ?? "live",
		}),
		queryFn: ({ signal }) =>
			fx
				? fromFixture(fx, (f) => f.engagementFixture(fx, params.days), signal)
				: api.getAnalyticsEngagement({ ...params, refresh: takeRefresh() }, { signal }),
		enabled,
		...common,
	});
}

export function useAnalyticsInbound(params: { days: Days }, enabled = true) {
	const fx = fixtureScenario();
	return useQuery({
		queryKey: queryKeys.analytics.section("inbound", { days: params.days, source: fx ?? "live" }),
		queryFn: ({ signal }) =>
			fx
				? fromFixture(fx, (f) => f.inboundFixture(fx, params.days), signal)
				: api.getAnalyticsInbound({ ...params, refresh: takeRefresh() }, { signal }),
		enabled,
		...common,
	});
}

export function useAnalyticsDmarc(params: { days: Days }, enabled = true) {
	const fx = fixtureScenario();
	return useQuery({
		queryKey: queryKeys.analytics.section("dmarc", { days: params.days, source: fx ?? "live" }),
		queryFn: ({ signal }) =>
			fx
				? fromFixture(fx, (f) => f.dmarcFixture(fx, params.days), signal)
				: api.getAnalyticsDmarc({ ...params, refresh: takeRefresh() }, { signal }),
		enabled,
		...common,
	});
}

/** Refetch every section, bypassing the Worker's 5-minute cache. */
export function useRefreshAnalytics() {
	const qc = useQueryClient();
	return () => {
		bypassCacheUntil = Date.now() + 3_000;
		return qc.invalidateQueries({ queryKey: queryKeys.analytics.all });
	};
}

/** The Usage tab: month to date, admin-only. Same 5-minute cache and refresh as the other tabs. */
export function useUsage(enabled = true) {
	return useQuery({
		queryKey: queryKeys.analytics.section("usage", {}),
		queryFn: ({ signal }) => api.getUsage({ refresh: takeRefresh() }, { signal }),
		enabled,
		...common,
	});
}

/** Save the budget thresholds, then refetch the tab so the banner follows. */
export function useUpdateUsageBudget() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (patch: UsageBudgetPatch) => api.updateUsageBudget(patch),
		onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.analytics.section("usage", {}) }),
	});
}
