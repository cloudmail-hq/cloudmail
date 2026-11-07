// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Instance-wide AI summary settings in R2 (`ai/settings.json`). See
 * `shared/ai-settings.ts` for what each field means and why it is admin-owned.
 */

import {
	normalizeAiConfig,
	type AiConfig,
	type AiConfigPatch,
} from "../../shared/ai-settings";

export const AI_CONFIG_KEY = "ai/settings.json";

/** Cached per isolate briefly: the alarm reads this for every batch. */
let cached: { at: number; value: AiConfig } | null = null;
const TTL_MS = 30_000;

export async function getAiConfig(bucket: R2Bucket, options: { fresh?: boolean } = {}): Promise<AiConfig> {
	if (!options.fresh && cached && Date.now() - cached.at < TTL_MS) return cached.value;
	let value: AiConfig;
	try {
		const obj = await bucket.get(AI_CONFIG_KEY);
		value = normalizeAiConfig(obj ? await obj.json() : null);
	} catch (e) {
		console.error("Unreadable AI settings, using defaults:", (e as Error).message);
		value = normalizeAiConfig(null);
	}
	cached = { at: Date.now(), value };
	return value;
}

export async function updateAiConfig(bucket: R2Bucket, patch: AiConfigPatch): Promise<AiConfig> {
	const current = await getAiConfig(bucket, { fresh: true });
	const next = normalizeAiConfig({ ...current, ...patch });
	await bucket.put(AI_CONFIG_KEY, JSON.stringify(next));
	cached = { at: Date.now(), value: next };
	return next;
}

/** Test hook. */
export function resetAiConfigCache(): void {
	cached = null;
}
