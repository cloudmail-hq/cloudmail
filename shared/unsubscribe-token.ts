// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Signed tokens for the public `/u/:token` unsubscribe endpoint.
 *
 * Same construction as `shared/tracking-token.ts`, for the same reason: the
 * person clicking "unsubscribe" (or their mail provider, for an RFC 8058
 * one-click POST) has no session, so the URL is the only thing the endpoint can
 * trust. The token therefore has to be:
 *
 *   - Unforgeable: HMAC-SHA256 over the payload, recomputed and compared in
 *     constant time. Without that, anyone could suppress any address on any of
 *     our sending domains by guessing a URL.
 *   - Tamper-evident: the address, the sending domain (the suppression scope)
 *     and the mailbox that sent the mail are all under the signature.
 *
 * Unlike tracking tokens there is one deployment-wide secret rather than one per
 * mailbox. A suppression is not mailbox data; it is a statement about a
 * recipient and a sending domain, stored in the global AuthDO. Rotating the
 * secret invalidates every outstanding unsubscribe link, so it should not be
 * rotated casually. There is no expiry: an unsubscribe link in a mail from last
 * year must still work, and Gmail/Yahoo bulk-sender rules require that it does.
 *
 * `<b64url(payload)>.<b64url(hmac)>`. Pure Web Crypto, so it runs unchanged in
 * the Worker and in tests.
 */

export interface UnsubscribeTokenPayload {
	/** Recipient address, lowercased. */
	address: string;
	/**
	 * Sending domain the unsubscribe applies to. An indie hacker runs several
	 * products from one deployment, and unsubscribing from one product's drip
	 * must not silence the others, so the scope is the From domain.
	 */
	domain: string;
	/** Mailbox that sent the message. Informational, recorded as the source. */
	mailbox: string;
}

interface WirePayload {
	a: string;
	d: string;
	m: string;
	v: 1;
}

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function importKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
	return diff === 0;
}

/** Mint a signed unsubscribe token. Address and domain are lowercased. */
export async function signUnsubscribeToken(
	payload: UnsubscribeTokenPayload,
	secret: string,
): Promise<string> {
	if (!secret) throw new Error("unsubscribe secret is empty");
	const wire: WirePayload = {
		a: payload.address.trim().toLowerCase(),
		d: payload.domain.trim().toLowerCase(),
		m: payload.mailbox.trim().toLowerCase(),
		v: 1,
	};
	const body = encoder.encode(JSON.stringify(wire));
	const key = await importKey(secret);
	const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
	return `${toBase64Url(body)}.${toBase64Url(signature)}`;
}

/**
 * Verify a token and return its payload, or null for any failure.
 *
 * The signature is checked before the JSON is parsed, so a tampered payload is
 * rejected at the crypto step rather than interpreted.
 */
export async function verifyUnsubscribeToken(
	token: string,
	secret: string,
): Promise<UnsubscribeTokenPayload | null> {
	try {
		if (!secret || typeof token !== "string") return null;
		const parts = token.split(".");
		if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
		const [body, sig] = parts;

		const key = await importKey(secret);
		const bodyBytes = fromBase64Url(body);
		const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, bodyBytes));
		if (!timingSafeEqual(expected, fromBase64Url(sig))) return null;

		const wire = JSON.parse(new TextDecoder().decode(bodyBytes)) as Partial<WirePayload>;
		if (
			wire.v !== 1 ||
			typeof wire.a !== "string" ||
			typeof wire.d !== "string" ||
			typeof wire.m !== "string" ||
			!wire.a.includes("@")
		) {
			return null;
		}
		return { address: wire.a, domain: wire.d, mailbox: wire.m };
	} catch {
		return null;
	}
}
