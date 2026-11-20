// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Cloudflare's side of the Usage tab: one account-level GraphQL query for
 * the month to date, through the same client and cache as the analytics
 * console (`cf-analytics.ts`).
 *
 * - `emailSendingAdaptiveGroups`: Email Service is billed per account, so the
 *   count is account-wide rather than per zone. Rows count envelope
 *   recipients and are scaled by `sampleInterval`.
 * - `aiInferenceAdaptiveGroups`: neurons per day and model. Account-wide: the
 *   dataset has no script dimension, so other Workers' AI use is included.
 * - `r2StorageAdaptiveGroups`: the bucket's newest storage sample.
 * - `durableObjectsInvocationsAdaptiveGroups`: this Worker's DO requests.
 */

import { weight } from "./analytics-aggregate";
import type { CfAnalyticsClient } from "./cf-analytics";

export const USAGE_QUERY = `
query UsageAccount($account: string!, $start: Time!, $end: Time!, $r2Start: Time!, $startDate: Date!, $endDate: Date!, $script: string!, $bucket: string!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      email: emailSendingAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end }) {
        count
        dimensions { status sampleInterval }
      }
      ai: aiInferenceAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end }) {
        count
        sum { totalNeurons }
        dimensions { date modelId }
      }
      r2: r2StorageAdaptiveGroups(limit: 1, filter: { datetime_geq: $r2Start, datetime_lt: $end, bucketName: $bucket }, orderBy: [datetime_DESC]) {
        max { payloadSize metadataSize objectCount }
        dimensions { datetime }
      }
      durableObjects: durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { date_geq: $startDate, date_leq: $endDate, scriptName: $script }) {
        sum { requests }
        dimensions { date }
      }
    }
  }
}`.trim();

export interface UsageAccountData {
	email: { count: number; dimensions: { status: string; sampleInterval: number } }[];
	ai: { count: number; sum: { totalNeurons: number }; dimensions: { date: string; modelId: string } }[];
	r2: { max: { payloadSize: number; metadataSize: number; objectCount: number }; dimensions: { datetime: string } }[];
	durableObjects: { sum: { requests: number }; dimensions: { date: string } }[];
}

export interface UsageQueryInput {
	accountId: string;
	/** Month start and now, ISO. */
	start: string;
	end: string;
	/** `YYYY-MM-DD` of the month's first day and today. */
	startDate: string;
	endDate: string;
	/** Worker name, for the DO requests. */
	script: string;
	/** R2 bucket name. */
	bucket: string;
}

export async function fetchUsage(client: CfAnalyticsClient, input: UsageQueryInput): Promise<UsageAccountData> {
	const data = await client.graphql<{ viewer: { accounts: Partial<UsageAccountData>[] } }>(USAGE_QUERY, {
		account: input.accountId,
		start: input.start,
		end: input.end,
		// Storage is sampled; the newest row of the last two days is "now".
		r2Start: new Date(Date.parse(input.end) - 2 * 86_400_000).toISOString(),
		startDate: input.startDate,
		endDate: input.endDate,
		script: input.script,
		bucket: input.bucket,
	});
	const account = data.viewer.accounts?.[0] ?? {};
	return {
		email: account.email ?? [],
		ai: account.ai ?? [],
		r2: account.r2 ?? [],
		durableObjects: account.durableObjects ?? [],
	};
}

export interface UsageSummary {
	emails: number;
	email_sampled: boolean;
	neurons_by_date: Record<string, number>;
	by_model: { model: string; neurons: number; requests: number }[];
	r2: { bytes: number; objects: number } | null;
	do_requests: number;
}

/** Fold the raw groups into the numbers the Usage tab needs. */
export function summarizeUsage(data: UsageAccountData): UsageSummary {
	let emails = 0;
	let sampled = false;
	for (const row of data.email) {
		emails += weight(row.count, row.dimensions?.sampleInterval);
		if ((row.dimensions?.sampleInterval ?? 1) > 1) sampled = true;
	}
	const byDate: Record<string, number> = {};
	const models = new Map<string, { neurons: number; requests: number }>();
	for (const row of data.ai) {
		const n = Number(row.sum?.totalNeurons ?? 0);
		const date = row.dimensions?.date ?? "";
		byDate[date] = (byDate[date] ?? 0) + n;
		const model = row.dimensions?.modelId || "unknown";
		const m = models.get(model) ?? { neurons: 0, requests: 0 };
		m.neurons += n;
		m.requests += Number(row.count ?? 0);
		models.set(model, m);
	}
	const latest = data.r2[0];
	return {
		emails: Math.round(emails),
		email_sampled: sampled,
		neurons_by_date: byDate,
		by_model: [...models].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.neurons - a.neurons),
		r2: latest
			? { bytes: Number(latest.max.payloadSize ?? 0) + Number(latest.max.metadataSize ?? 0), objects: Number(latest.max.objectCount ?? 0) }
			: null,
		do_requests: data.durableObjects.reduce((a, r) => a + Number(r.sum?.requests ?? 0), 0),
	};
}
