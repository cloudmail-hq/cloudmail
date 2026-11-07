// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * A small HMAC-signed, expiring token: `<b64url(json)>.<b64url(hmac)>`.
 *
 * Used for account-export download links, which must work from a plain link
 * (a download manager, `curl`) without a session cookie, and stop working
 * after a fixed time. The payload is readable but not forgeable. Pure Web
 * Crypto, so it runs in the Worker and in tests.
 */

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value: string): Uint8Array<ArrayBuffer> {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
	const out = new Uint8Array(new ArrayBuffer(binary.length));
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

async function key(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
		"verify",
	]);
}

export async function signLink<T extends { exp: number }>(payload: T, secret: string): Promise<string> {
	if (!secret) throw new Error("link secret is empty");
	const body = encoder.encode(JSON.stringify(payload));
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), body));
	return `${b64url(body)}.${b64url(sig)}`;
}

/** The payload, or null when malformed, forged or past `exp` (epoch ms). */
export async function verifyLink<T extends { exp: number }>(
	token: string,
	secret: string,
	now = Date.now(),
): Promise<T | null> {
	try {
		const [body, sig] = token.split(".");
		if (!body || !sig || !secret) return null;
		const ok = await crypto.subtle.verify("HMAC", await key(secret), fromB64url(sig), fromB64url(body));
		if (!ok) return null;
		const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as T;
		if (typeof payload?.exp !== "number" || payload.exp <= now) return null;
		return payload;
	} catch {
		return null;
	}
}
