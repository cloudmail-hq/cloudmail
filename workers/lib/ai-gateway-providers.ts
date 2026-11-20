// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * AI SDK clients for a configured gateway: `@ai-sdk/anthropic` for the
 * Anthropic Messages wire, `@ai-sdk/openai-compatible` for OpenAI Chat
 * Completions (and `/embeddings`).
 *
 * Built per resolution from a decrypted token (./ai-provider-secrets.ts) and
 * the guarded fetch (./ai-gateway-fetch.ts), so the plaintext lives only as
 * long as the call. Imported only by the router and the settings routes;
 * test/ai-router-static.test.ts keeps it that way.
 *
 * Auth mapping (research doc section 3):
 *   openai wire:    bearer → `apiKey` (Authorization: Bearer); any other
 *                   scheme → its header, no apiKey, so no Bearer is added.
 *   anthropic wire: x-api-key → `apiKey`; bearer → `authToken`; other schemes
 *                   → their header. The SDK sets `anthropic-version`.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { apiBaseFor, headerNameProblem, headerValueProblem } from "../../shared/ai-gateway";
import type { AiProvider } from "../../shared/ai-providers";
import { gatewayFetch, redactGatewayText } from "./ai-gateway-fetch";
import type { ProviderSecrets } from "./ai-provider-secrets";

/** `@ai-sdk/anthropic` throws without a key; for other schemes it gets this, and the header is stripped before sending. */
const NO_KEY = "tapetide-no-key";

/** The headers a provider sends besides its auth: the admin's, with the denylist re-applied. */
export function extraHeaders(provider: AiProvider, secrets: ProviderSecrets): Record<string, string> {
	const out: Record<string, string> = {};
	for (const h of provider.headers) {
		const value = secrets.headers[h.name];
		if (value === undefined) continue;
		// Checked again at use: a hand-edited providers.json must not smuggle a header in.
		if (headerNameProblem(h.name, provider.auth) || headerValueProblem(value)) continue;
		out[h.name] = value;
	}
	return out;
}

/** The auth header for discovery and Test probes (the SDK clients set their own). */
export function authHeaders(provider: AiProvider, token: string | null): Record<string, string> {
	if (!token) return {};
	switch (provider.auth.scheme) {
		case "bearer":
			return { Authorization: `Bearer ${token}` };
		case "x-api-key":
			return { "x-api-key": token };
		case "api-key":
			return { "api-key": token };
		case "custom":
			return { [provider.auth.header]: token };
		default:
			return {};
	}
}

export interface GatewayClientOptions {
	ownHosts: readonly string[];
	/** The network beneath the guard. Tests pass a fake gateway. */
	fetch?: typeof fetch;
	timeoutMs?: number;
	/** Local dev only; see `devTarget` in ./ai-gateway-fetch.ts. */
	devGatewayOrigin?: string;
}

export interface GatewayClient {
	apiBase: string;
	/** The guarded fetch, for discovery and probes. */
	fetch: typeof fetch;
	/** Auth plus extra headers, for discovery and probes. */
	headers: Record<string, string>;
	languageModel(modelId: string): ReturnType<ReturnType<typeof createAnthropic>["languageModel"]>;
	/** Only on the OpenAI wire. */
	embeddingModel: ((modelId: string) => ReturnType<ReturnType<typeof createOpenAICompatible>["embeddingModel"]>) | null;
	/** Secrets to scrub from any text this client's errors produce. */
	secrets: string[];
	redact(text: string): string;
}

export function gatewayClient(provider: AiProvider, secrets: ProviderSecrets, options: GatewayClientOptions): GatewayClient {
	const apiBase = apiBaseFor(provider.baseUrl, provider.wire, provider.exactBaseUrl);
	const secretList = [
		...(secrets.token ? [secrets.token] : []),
		...provider.headers.filter((h) => h.secret && secrets.headers[h.name]).map((h) => secrets.headers[h.name]!),
	];
	const guarded = gatewayFetch({
		apiBase,
		ownHosts: options.ownHosts,
		allowCustomPorts: provider.options.allowCustomPorts,
		allowCloudflareApi: false,
		timeoutMs: options.timeoutMs,
		secrets: secretList,
		fetch: options.fetch,
		devGatewayOrigin: options.devGatewayOrigin,
	});
	const extra = extraHeaders(provider, secrets);
	const token = secrets.token;
	const scheme = provider.auth.scheme;
	const authOnly = authHeaders(provider, token);

	let languageModel: GatewayClient["languageModel"];
	let embeddingModel: GatewayClient["embeddingModel"] = null;

	if (provider.wire === "anthropic") {
		const direct = !!token && (scheme === "x-api-key" || scheme === "bearer");
		const anthropic = createAnthropic({
			baseURL: apiBase,
			name: `gateway-${provider.id}`,
			...(direct ? (scheme === "bearer" ? { authToken: token! } : { apiKey: token! }) : { apiKey: NO_KEY }),
			headers: { ...(direct ? {} : authOnly), ...extra },
			fetch: direct ? guarded : stripAnthropicKey(guarded),
		});
		languageModel = (id) => anthropic.languageModel(id);
	} else {
		const structured = provider.options.structuredOutputs;
		const compat = createOpenAICompatible({
			name: `gateway-${provider.id}`,
			baseURL: apiBase,
			...(scheme === "bearer" && token ? { apiKey: token } : {}),
			headers: { ...(scheme !== "bearer" ? authOnly : {}), ...extra },
			includeUsage: provider.options.includeUsage,
			// "auto": json_schema for models the hints say support it is not
			// knowable per request, so auto means on; a gateway that rejects it
			// gets "off" (json_object plus local validation).
			supportsStructuredOutputs: structured !== "off",
			fetch: guarded,
		});
		languageModel = (id) => compat.languageModel(id) as never;
		embeddingModel = (id) => compat.embeddingModel(id);
	}

	return {
		apiBase,
		fetch: guarded,
		headers: { ...authOnly, ...extra },
		languageModel,
		embeddingModel,
		secrets: secretList,
		redact: (text) => redactGatewayText(text, secretList),
	};

	/** Anthropic wire with api-key / custom / none: drop the SDK's placeholder x-api-key. */
	function stripAnthropicKey(next: typeof fetch): typeof fetch {
		return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
			const headers = new Headers(init.headers);
			if (headers.get("x-api-key") === NO_KEY) headers.delete("x-api-key");
			return next(input, { ...init, headers });
		}) as typeof fetch;
	}
}
