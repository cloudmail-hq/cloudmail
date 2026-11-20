// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The Workers AI model catalogue, for Settings → AI providers.
 *
 * `GET /accounts/{account}/ai/models/search` with `CF_ANALYTICS_TOKEN` (it
 * needs "Workers AI Read"), every page, text generation and embeddings only,
 * normalised by shared/workers-ai.ts. Cached with the Cache API for an hour,
 * like the analytics bundles (./cf-analytics.ts `cachedJson`).
 *
 * When the search can't be read (no token, no permission, no account id, an
 * outage) the small built-in `FALLBACK_CATALOGUE` is returned with
 * `source: "fallback"` and a short reason. A failure is cached for five
 * minutes so a page refresh doesn't hammer the API. Never throws, and never
 * puts the token in a cache key, log or reason.
 */

import { FALLBACK_CATALOGUE, normaliseCatalogue, type WorkersAiCatalogue } from "../../shared/workers-ai";
import type { Env } from "../types";
import { analyticsCacheKey, cachedJson, analyticsClient, CfAnalyticsError, defaultCache, type CacheLike, type CfAnalyticsClient } from "./cf-analytics";
import { accountIdFor } from "./usage";

export const CATALOGUE_TTL_SECONDS = 3600;
export const CATALOGUE_FAILURE_TTL_SECONDS = 300;
/** Cloudflare's page size limit is 100; ~330 models today. */
const PER_PAGE = 100;
const MAX_PAGES = 8;

export interface CatalogueDeps {
	client?: CfAnalyticsClient | null;
	cache?: CacheLike | null;
	accountId?: string | null;
	refresh?: boolean;
	now?: () => number;
}

function fallback(detail: string, now: () => number): WorkersAiCatalogue {
	return { source: "fallback", fetchedAt: new Date(now()).toISOString(), models: [...FALLBACK_CATALOGUE], detail };
}

/** A short reason for the page: the status, never the response body. */
function reasonFor(e: unknown): string {
	const status = e instanceof CfAnalyticsError ? e.status : undefined;
	if (status === 401 || status === 403) return "The Cloudflare token can't read the Workers AI catalogue (needs Workers AI Read).";
	if (status) return `Cloudflare's model search answered HTTP ${status}.`;
	return "Cloudflare's model search couldn't be reached.";
}

async function fetchAll(client: CfAnalyticsClient, accountId: string): Promise<unknown[]> {
	const rows: unknown[] = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const body = await client.get<unknown[]>(
			`/accounts/${encodeURIComponent(accountId)}/ai/models/search?per_page=${PER_PAGE}&page=${page}`,
		);
		const got = Array.isArray(body.result) ? body.result : [];
		rows.push(...got);
		// The search reports a total across tasks but pages by what it returns;
		// stop on a short or empty page.
		if (got.length < PER_PAGE) break;
	}
	return rows;
}

/** The catalogue: live (cached an hour), or the fallback list with why. */
export async function workersAiCatalogue(env: Env, deps: CatalogueDeps = {}): Promise<WorkersAiCatalogue> {
	const now = deps.now ?? Date.now;
	const client = deps.client === undefined ? await analyticsClient(env) : deps.client;
	if (!client?.hasRest) return fallback("Showing a short list. To see every Workers AI model, give CF_ANALYTICS_TOKEN Workers AI Read.", now);
	let accountId = deps.accountId ?? null;
	if (!accountId) {
		try {
			accountId = await accountIdFor(env, client);
		} catch {
			accountId = null;
		}
	}
	if (!accountId) return fallback("Showing a short list. Set CF_ACCOUNT_ID to see every Workers AI model.", now);

	const cache = deps.cache === undefined ? defaultCache() : deps.cache;
	try {
		const got = await cachedJson<WorkersAiCatalogue>(
			cache,
			analyticsCacheKey("workers-ai-models", { account: accountId, v: 1 }),
			async () => {
				try {
					const models = normaliseCatalogue(await fetchAll(client, accountId!));
					if (models.length === 0) throw new CfAnalyticsError("empty catalogue");
					return { source: "live", fetchedAt: new Date(now()).toISOString(), models };
				} catch (e) {
					// Cached too, briefly: the loader's result decides the TTL below.
					return fallback(reasonFor(e), now);
				}
			},
			{ ttlSeconds: CATALOGUE_TTL_SECONDS, refresh: deps.refresh, now },
		);
		const data = got.data;
		// A cached failure older than the failure TTL is retried.
		if (data.source === "fallback" && got.hit && now() - Date.parse(got.cachedAt) > CATALOGUE_FAILURE_TTL_SECONDS * 1000) {
			return workersAiCatalogue(env, { ...deps, accountId, refresh: true });
		}
		return data;
	} catch (e) {
		return fallback(reasonFor(e), now);
	}
}
