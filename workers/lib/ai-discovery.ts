// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Model discovery: GET a gateway's `/models` and normalise it into a
 * catalogue (research doc section 2.4).
 *
 * The caller passes a `fetch` that is already guarded (gatewayFetch: SSRF
 * check, no redirects, timeout) and the headers to send (auth plus extra
 * headers). Response bodies are capped at 2 MB. Error details carry the
 * status code only, never a response body, which can echo the token.
 */

import { mergeLiteLlmInfo, normaliseAnthropicPage, normaliseOpenAiList, isModelList, MAX_CATALOGUE_MODELS } from "../../shared/ai-discovery";
import { apiBaseFor, canonicalBaseUrl, looksLikeLiteLlm } from "../../shared/ai-gateway";
import type { AiProvider, CatalogModel, Catalogue } from "../../shared/ai-providers";
import { describeGatewayError, readJsonCapped } from "./ai-gateway-fetch";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const ANTHROPIC_MAX_PAGES = 5;
const LITELLM_INFO_TIMEOUT_MS = 5_000;

export interface DiscoverOptions {
	/** Already guarded (gatewayFetch). */
	fetch: typeof fetch;
	/** Auth and extra headers, ready to send. */
	headers: Record<string, string>;
	now?: () => number;
}

type Provider = Pick<AiProvider, "baseUrl" | "wire" | "exactBaseUrl"> & {
	options?: Partial<AiProvider["options"]>;
};

/** A non-2xx answer, mapped to a catalogue status. */
class StatusError extends Error {
	constructor(readonly status: number) {
		super(`HTTP ${status}`);
	}
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	const n = name.toLowerCase();
	return Object.keys(headers).some((k) => k.toLowerCase() === n);
}

async function getJson(fetchFn: typeof fetch, url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
	const res = await fetchFn(url, { method: "GET", headers: { accept: "application/json", ...headers }, signal });
	if (!res.ok) {
		// Never read the body: it can echo the key.
		try {
			await res.body?.cancel();
		} catch {
			// ignore
		}
		throw new StatusError(res.status);
	}
	return readJsonCapped(res, MAX_BODY_BYTES);
}

async function listAnthropic(fetchFn: typeof fetch, apiBase: string, headers: Record<string, string>): Promise<CatalogModel[]> {
	const h = hasHeader(headers, "anthropic-version") ? headers : { ...headers, "anthropic-version": "2023-06-01" };
	const out: CatalogModel[] = [];
	const seen = new Set<string>();
	let afterId: string | null = null;
	for (let page = 0; page < ANTHROPIC_MAX_PAGES; page++) {
		const url = new URL(`${apiBase}/models`);
		url.searchParams.set("limit", "1000");
		if (afterId) url.searchParams.set("after_id", afterId);
		const json = await getJson(fetchFn, url.toString(), h);
		if (!isModelList(json)) throw new Error("The gateway's model list is not in a known format.");
		const { models, hasMore, lastId } = normaliseAnthropicPage(json);
		for (const m of models) {
			if (seen.has(m.id) || out.length >= MAX_CATALOGUE_MODELS) continue;
			seen.add(m.id);
			out.push(m);
		}
		// Stop on the last page, a stuck cursor or a full catalogue.
		if (!hasMore || !lastId || lastId === afterId || out.length >= MAX_CATALOGUE_MODELS) break;
		afterId = lastId;
	}
	return out;
}

/** Candidate `/model/info` URLs: the proxy root first, then under the API base. */
function liteLlmInfoUrls(provider: Provider, apiBase: string): string[] {
	const canonical = canonicalBaseUrl(provider.baseUrl) ?? provider.baseUrl.replace(/\/+$/, "");
	const root = canonical.replace(/\/v1$/i, "");
	return [...new Set([`${root}/model/info`, `${apiBase}/model/info`])];
}

/** LiteLLM `/model/info`, best effort: any failure keeps the plain list. */
async function enrichLiteLlm(
	provider: Provider,
	apiBase: string,
	models: CatalogModel[],
	opts: DiscoverOptions,
): Promise<CatalogModel[]> {
	for (const url of liteLlmInfoUrls(provider, apiBase)) {
		try {
			const json = await getJson(opts.fetch, url, opts.headers, AbortSignal.timeout(LITELLM_INFO_TIMEOUT_MS));
			if (isModelList(json)) return mergeLiteLlmInfo(models, json);
		} catch {
			// Disabled for non-admin keys, outside the guarded base, or slow: try the next.
		}
	}
	return models;
}

/** Fetch and normalise a provider's model list. Never throws. */
export async function discoverModels(provider: Provider, opts: DiscoverOptions): Promise<Catalogue> {
	const now = opts.now ?? Date.now;
	const done = (status: Catalogue["status"], detail: string | null, models: CatalogModel[] = []): Catalogue => ({
		fetchedAt: new Date(now()).toISOString(),
		status,
		detail: detail?.slice(0, 300) ?? null,
		models,
	});

	let apiBase: string;
	let host: string;
	try {
		apiBase = apiBaseFor(provider.baseUrl, provider.wire, provider.exactBaseUrl);
		host = new URL(apiBase).hostname.toLowerCase();
	} catch {
		return done("error", "The base URL is not valid.");
	}

	try {
		if (provider.wire === "anthropic") {
			return done("ok", null, await listAnthropic(opts.fetch, apiBase, opts.headers));
		}
		const url = new URL(`${apiBase}/models`);
		if (host === "openrouter.ai") url.searchParams.set("output_modalities", "all");
		const json = await getJson(opts.fetch, url.toString(), opts.headers);
		if (!isModelList(json)) return done("error", "The gateway's model list is not in a known format.");
		let models = normaliseOpenAiList(json, { host, wire: "openai" });
		if (provider.options?.litellmInfo || looksLikeLiteLlm(provider.baseUrl)) {
			models = await enrichLiteLlm(provider, apiBase, models, opts);
		}
		return done("ok", null, models);
	} catch (e) {
		if (e instanceof StatusError) {
			if (e.status === 404 || e.status === 405) return done("no-discovery", `HTTP ${e.status}`);
			if (e.status === 401 || e.status === 403) return done("auth-failed", `HTTP ${e.status}`);
			return done("error", `HTTP ${e.status}`);
		}
		if (e instanceof SyntaxError) return done("error", "The gateway's model list is not valid JSON.");
		return done("error", describeGatewayError(e).message);
	}
}
