// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Gateway tokens and secret header values at rest.
 *
 * AES-256-GCM with an HKDF key from AUTH_SECRET (or the AuthDO-generated key
 * when it is unset), like TOTP seeds and IMAP passwords, but under its own
 * HKDF info so the key differs from both. The AES-GCM additional data is the
 * provider id (and the header name), so a ciphertext copied onto another
 * provider or another header fails to decrypt.
 *
 * Plaintext exists only inside one request: decrypted when a provider client
 * is built (./ai-gateway-providers.ts) and never written to R2, DO storage,
 * logs or any API response.
 */

import { authSecret } from "../auth/config";
import { decryptSecret, encryptSecret, type SecretPurpose } from "../auth/crypto";
import type { AiProvider } from "../../shared/ai-providers";
import type { Env } from "../types";

export const AI_PROVIDER_KEY_INFO = "tapetide-ai-provider-v1";

function tokenPurpose(providerId: string): SecretPurpose {
	return { info: AI_PROVIDER_KEY_INFO, aad: `ai-provider:${providerId}:token` };
}

function headerPurpose(providerId: string, header: string): SecretPurpose {
	return { info: AI_PROVIDER_KEY_INFO, aad: `ai-provider:${providerId}:header:${header.toLowerCase()}` };
}

export function sealProviderToken(token: string, keyMaterial: string, providerId: string): Promise<string> {
	return encryptSecret(token, keyMaterial, tokenPurpose(providerId));
}

export function openProviderToken(enc: string, keyMaterial: string, providerId: string): Promise<string> {
	return decryptSecret(enc, keyMaterial, tokenPurpose(providerId));
}

export function sealProviderHeader(value: string, keyMaterial: string, providerId: string, header: string): Promise<string> {
	return encryptSecret(value, keyMaterial, headerPurpose(providerId, header));
}

export function openProviderHeader(enc: string, keyMaterial: string, providerId: string, header: string): Promise<string> {
	return decryptSecret(enc, keyMaterial, headerPurpose(providerId, header));
}

/** The key material, from AUTH_SECRET or the AuthDO. */
export async function providerKeyMaterial(env: Env): Promise<string> {
	// The AuthDO stub, looked up here rather than through ../auth/store so this
	// module stays importable outside the Workers runtime (tests).
	const ns = env.AUTH_STORE as unknown as { idFromName(n: string): unknown; get(id: unknown): unknown };
	return authSecret(env, ns.get(ns.idFromName("global")) as never);
}

/** Whether tokens are protected by an AUTH_SECRET (rather than a key stored beside the data). */
export function hasAuthSecret(env: Pick<Env, "AUTH_SECRET">): boolean {
	return !!env.AUTH_SECRET?.trim();
}

export interface ProviderSecrets {
	token: string | null;
	/** Every extra header, secret ones decrypted. */
	headers: Record<string, string>;
}

/** Decrypt a provider's token and secret headers for one call. */
export async function openProviderSecrets(provider: AiProvider, keyMaterial: string): Promise<ProviderSecrets> {
	const token = provider.tokenEnc ? await openProviderToken(provider.tokenEnc, keyMaterial, provider.id) : null;
	const headers: Record<string, string> = {};
	for (const h of provider.headers) {
		if (h.secret && h.valueEnc) headers[h.name] = await openProviderHeader(h.valueEnc, keyMaterial, provider.id, h.name);
		else if (h.value !== undefined) headers[h.name] = h.value;
	}
	return { token, headers };
}

/** Every plaintext secret, for redaction. */
export function secretValues(secrets: ProviderSecrets, provider: AiProvider): string[] {
	const out: string[] = [];
	if (secrets.token) out.push(secrets.token);
	for (const h of provider.headers) if (h.secret && secrets.headers[h.name]) out.push(secrets.headers[h.name]!);
	return out;
}
