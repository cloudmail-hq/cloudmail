// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The deployment's optional AI provider config, R2 `ai/providers.json`.
 *
 * The router (`./ai-router.ts`) reads it on every resolution, through a 30 s
 * per-isolate cache like `./ai-config.ts`. Absent, unreadable or invalid
 * means null, and null means Workers AI for every role, exactly as before the
 * file existed. Settings → AI providers (workers/routes/ai-providers.ts)
 * writes it with `putAiProvidersFile`, which also refreshes this isolate's
 * cache; other isolates pick the change up within 30 s.
 *
 * Writes use the object's etag as a precondition, so two admins saving at
 * once cannot silently drop each other's change: the loser gets a conflict
 * and retries on fresh data.
 */

import { AiProvidersFileSchema, parseAiProvidersFile, type AiProvidersFile } from "../../shared/ai-providers";

export const AI_PROVIDERS_KEY = "ai/providers.json";
const TTL_MS = 30_000;

let cached: { at: number; value: AiProvidersFile | null } | null = null;

export async function getAiProvidersFile(
	bucket: Pick<R2Bucket, "get"> | undefined | null,
	options: { fresh?: boolean; now?: number } = {},
): Promise<AiProvidersFile | null> {
	if (!bucket || typeof bucket.get !== "function") return null;
	const now = options.now ?? Date.now();
	if (!options.fresh && cached && now - cached.at < TTL_MS) return cached.value;
	let value: AiProvidersFile | null = null;
	try {
		const obj = await bucket.get(AI_PROVIDERS_KEY);
		if (obj) {
			value = parseAiProvidersFile(await obj.json());
			if (!value) console.error("ai/providers.json is invalid; using Workers AI for every role");
		}
	} catch (e) {
		console.error("Unreadable ai/providers.json; using Workers AI for every role:", (e as Error).message);
		value = null;
	}
	cached = { at: now, value };
	return value;
}

export class AiProvidersConflictError extends Error {
	constructor() {
		super("The AI provider settings changed while you were saving. Reload and try again.");
		this.name = "AiProvidersConflictError";
	}
}

/** An empty config: no providers, Workers AI for everything. */
export function emptyAiProvidersFile(): AiProvidersFile {
	return AiProvidersFileSchema.parse({});
}

/**
 * Read, change and write the file, retrying a lost race a few times. `change`
 * gets a fresh copy and returns the new file (or throws to abort).
 */
export async function updateAiProvidersFile<T>(
	bucket: R2Bucket,
	change: (file: AiProvidersFile) => Promise<{ file: AiProvidersFile; result: T }> | { file: AiProvidersFile; result: T },
): Promise<T> {
	for (let attempt = 0; attempt < 4; attempt++) {
		const obj = await bucket.get(AI_PROVIDERS_KEY);
		let current: AiProvidersFile;
		if (obj) {
			const parsed = parseAiProvidersFile(await obj.json());
			// An invalid file is never silently overwritten with an empty one.
			if (!parsed) throw new Error("ai/providers.json is invalid; fix or remove it before saving");
			current = parsed;
		} else {
			current = emptyAiProvidersFile();
		}
		const { file, result } = await change(structuredClone(current));
		const next = AiProvidersFileSchema.parse(file);
		const written = await bucket.put(AI_PROVIDERS_KEY, JSON.stringify(next), {
			httpMetadata: { contentType: "application/json" },
			onlyIf: obj ? { etagMatches: obj.etag } : { etagDoesNotMatch: "*" },
		} as R2PutOptions);
		// R2 returns null when the precondition failed.
		if (written === null) continue;
		cached = { at: Date.now(), value: next };
		return result;
	}
	throw new AiProvidersConflictError();
}

/** Test hook. */
export function resetAiProvidersCache(): void {
	cached = null;
}
