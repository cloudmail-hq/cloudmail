// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The shipped `ProviderFactoryLoader`: decrypts a provider's token and
 * secret headers and builds the real AI SDK clients over the guarded fetch.
 * Importing this module registers it with the router (workers/app.ts does).
 */

import type { AiProvider } from "../../shared/ai-providers";
import { setDefaultFactoryLoader, type ProviderFactory, type RouterEnv } from "./ai-router";
import { gatewayClient, type GatewayClient } from "./ai-gateway-providers";
import { openProviderSecrets, providerKeyMaterial } from "./ai-provider-secrets";
import type { Env } from "../types";
import { deploymentOrigin } from "./deployment-origin";

/**
 * Hosts a gateway URL may never point at: this deployment. The deployment
 * origin (`APP_URL`, else the origin recorded from signed-in requests) and
 * the host serving the current request, plus `*.workers.dev` (always refused
 * by the guard). The mail domains are not listed: an admin may run their
 * gateway on a sibling host in the same zone.
 */
export async function ownHosts(env: Env, requestUrl?: string | null): Promise<string[]> {
	const out = new Set<string>();
	for (const u of [await deploymentOrigin(env), requestUrl]) {
		if (!u) continue;
		try {
			out.add(new URL(u).hostname.toLowerCase());
		} catch {
			// ignore
		}
	}
	return [...out];
}

/** Build a client for `provider` with decrypted secrets. For discovery and Test. */
export async function loadGatewayClient(
	env: Env,
	provider: AiProvider,
	options: { requestUrl?: string | null; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<GatewayClient> {
	const secrets = await openProviderSecrets(provider, await providerKeyMaterial(env));
	return gatewayClient(provider, secrets, {
		ownHosts: await ownHosts(env, options.requestUrl),
		fetch: options.fetch,
		timeoutMs: options.timeoutMs,
		devGatewayOrigin: (env as { LOCAL_FAKE_GATEWAY?: string }).LOCAL_FAKE_GATEWAY,
	});
}

/** A router factory over one client. */
export function factoryFromClient(client: GatewayClient): ProviderFactory {
	return {
		languageModel: (_p, id) => client.languageModel(id) as never,
		embeddingModel: client.embeddingModel ? (_p, id) => client.embeddingModel!(id) as never : undefined,
		redact: client.redact,
	};
}

/** Tests: the network beneath every gateway client the router builds. */
let networkOverride: typeof fetch | undefined;
export function setGatewayNetworkForTests(f: typeof fetch | undefined): void {
	networkOverride = f;
}

setDefaultFactoryLoader(async (env: RouterEnv, provider: AiProvider) =>
	factoryFromClient(await loadGatewayClient(env as Env, provider, { fetch: networkOverride })),
);
