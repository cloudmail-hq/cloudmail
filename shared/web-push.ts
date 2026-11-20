// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Web Push message encryption (RFC 8291, `aes128gcm` from RFC 8188) and VAPID
 * (RFC 8292), on Web Crypto alone so it runs unchanged in the Worker and in
 * the Node test runner.
 *
 * Implemented here rather than pulled in as a dependency: it is about 150
 * lines, every step is pinned by the RFC 8291 Appendix A test vectors (see
 * `test/web-push-crypto.test.ts`), and the maintained libraries either depend
 * on Node's `crypto` module or wrap this same code.
 *
 * Keys travel as base64url: a P-256 public key is the 65-byte uncompressed
 * point (`0x04 || x || y`), which is what `PushSubscription.getKey("p256dh")`
 * and `applicationServerKey` use; a private key is the 32-byte scalar `d`.
 */

const encoder = new TextEncoder();

// ── base64url ──────────────────────────────────────────────────────

export function b64urlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes base64url (or plain base64); whitespace is ignored. Throws on garbage. */
export function b64urlDecode(value: string): Uint8Array<ArrayBuffer> {
	const clean = value.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error("invalid base64url");
	const binary = atob(clean + "=".repeat((4 - (clean.length % 4)) % 4));
	const out = new Uint8Array(new ArrayBuffer(binary.length));
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.length, 0)));
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

// ── keys ───────────────────────────────────────────────────────────

/** A P-256 key pair as base64url strings: public point and private scalar. */
export interface P256KeyPair {
	publicKey: string;
	privateKey: string;
}

/** Whether `value` decodes to an uncompressed P-256 point. */
export function isP256PublicKey(value: string): boolean {
	try {
		const raw = b64urlDecode(value);
		return raw.length === 65 && raw[0] === 0x04;
	} catch {
		return false;
	}
}

/** Whether `value` decodes to a 32-byte private scalar. */
export function isP256PrivateKey(value: string): boolean {
	try {
		return b64urlDecode(value).length === 32;
	} catch {
		return false;
	}
}

function jwkFor(publicKey: Uint8Array, privateKey?: Uint8Array): JsonWebKey {
	if (publicKey.length !== 65 || publicKey[0] !== 0x04) throw new Error("not an uncompressed P-256 point");
	return {
		kty: "EC",
		crv: "P-256",
		x: b64urlEncode(publicKey.subarray(1, 33)),
		y: b64urlEncode(publicKey.subarray(33, 65)),
		...(privateKey ? { d: b64urlEncode(privateKey) } : {}),
		ext: true,
	};
}

/** A fresh key pair, for VAPID. ECDSA and ECDH share the P-256 key format. */
export async function generateP256KeyPair(): Promise<P256KeyPair> {
	const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
	const point = concat(new Uint8Array([0x04]), b64urlDecode(jwk.x!), b64urlDecode(jwk.y!));
	return { publicKey: b64urlEncode(point), privateKey: jwk.d! };
}

// ── RFC 8291 encryption ────────────────────────────────────────────

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
	const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", k, data as BufferSource));
}

/** HKDF-Expand for a single block (every length here is at most 32 bytes). */
async function expand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array<ArrayBuffer>> {
	return (await hmac(prk, concat(info, new Uint8Array([0x01])))).slice(0, length);
}

/** Record size written into the header. One record always suffices here. */
export const PUSH_RECORD_SIZE = 4096;
/** salt(16) + rs(4) + idlen(1) + keyid(65) */
const HEADER_LENGTH = 86;
/** Largest plaintext that fits one record: rs - header - AEAD tag - delimiter. */
export const MAX_PUSH_PLAINTEXT = PUSH_RECORD_SIZE - HEADER_LENGTH - 16 - 1;

export interface EncryptInput {
	plaintext: Uint8Array;
	/** Subscription `p256dh`, base64url. */
	uaPublic: string;
	/** Subscription `auth`, base64url (16 bytes). */
	authSecret: string;
	/** Fixed values, for the RFC test vectors only. Random when omitted. */
	salt?: Uint8Array;
	senderKeys?: P256KeyPair;
}

export interface EncryptedPush {
	/** The `aes128gcm` body: header then the single record. */
	body: Uint8Array<ArrayBuffer>;
	/** The derived values, exposed so tests can check each step. */
	debug: { ecdhSecret: Uint8Array; ikm: Uint8Array; prk: Uint8Array; cek: Uint8Array; nonce: Uint8Array };
}

export async function encryptPushPayload(input: EncryptInput): Promise<EncryptedPush> {
	if (input.plaintext.length > MAX_PUSH_PLAINTEXT) throw new Error("push payload too large");
	const uaPublic = b64urlDecode(input.uaPublic);
	const authSecret = b64urlDecode(input.authSecret);
	if (authSecret.length < 16) throw new Error("auth secret too short");
	const salt = input.salt ?? crypto.getRandomValues(new Uint8Array(16));
	if (salt.length !== 16) throw new Error("salt must be 16 bytes");

	// The application server's one-time ECDH key pair (fixed only in tests).
	let asPrivate: CryptoKey;
	let asPublic: Uint8Array;
	if (input.senderKeys) {
		asPublic = b64urlDecode(input.senderKeys.publicKey);
		asPrivate = await crypto.subtle.importKey(
			"jwk",
			jwkFor(asPublic, b64urlDecode(input.senderKeys.privateKey)),
			{ name: "ECDH", namedCurve: "P-256" },
			false,
			["deriveBits"],
		);
	} else {
		const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
			"deriveBits",
		])) as CryptoKeyPair;
		asPrivate = pair.privateKey;
		asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
	}

	const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
	const ecdhSecret = new Uint8Array(
		await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as EcdhKeyDeriveParams, asPrivate, 256),
	);

	// RFC 8291 section 3.4: combine the ECDH secret with the auth secret.
	const prkKey = await hmac(authSecret, ecdhSecret);
	const keyInfo = concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic);
	const ikm = await expand(prkKey, keyInfo, 32);

	// RFC 8188 section 2.2 and 2.3: content encryption key and nonce.
	const prk = await hmac(salt, ikm);
	const cek = await expand(prk, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await expand(prk, encoder.encode("Content-Encoding: nonce\0"), 12);

	// One record, so the padding delimiter is 0x02 ("last record") with no padding.
	const record = concat(input.plaintext, new Uint8Array([0x02]));
	const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, record));

	const header = new Uint8Array(HEADER_LENGTH);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, PUSH_RECORD_SIZE);
	header[20] = asPublic.length;
	header.set(asPublic, 21);

	return { body: concat(header, ciphertext), debug: { ecdhSecret, ikm, prk, cek, nonce } };
}

// ── RFC 8292 VAPID ─────────────────────────────────────────────────

/** Longest a VAPID token may live (RFC 8292 section 2: 24 hours). */
export const VAPID_MAX_TTL_SECONDS = 24 * 3600;

export interface VapidClaims {
	/** Origin of the push service endpoint. */
	aud: string;
	/** Expiry, seconds since the epoch. */
	exp: number;
	/** Contact for the push service operator: `mailto:` or `https:`. */
	sub: string;
}

/** The push service origin a token must name: scheme, host and port of the endpoint. */
export function vapidAudience(endpoint: string): string {
	return new URL(endpoint).origin;
}

/** An ES256 JWT over `claims`, signed with the VAPID private key. */
export async function signVapidJwt(claims: VapidClaims, keys: P256KeyPair): Promise<string> {
	const key = await crypto.subtle.importKey(
		"jwk",
		jwkFor(b64urlDecode(keys.publicKey), b64urlDecode(keys.privateKey)),
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"],
	);
	const header = b64urlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
	const payload = b64urlEncode(encoder.encode(JSON.stringify(claims)));
	const input = `${header}.${payload}`;
	// Web Crypto returns the IEEE P1363 form (r || s), which is what JWS wants.
	const sig = new Uint8Array(
		await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(input)),
	);
	return `${input}.${b64urlEncode(sig)}`;
}

/** Verify a VAPID JWT against a public key. For tests and diagnostics. */
export async function verifyVapidJwt(token: string, publicKey: string): Promise<VapidClaims | null> {
	const [header, payload, sig] = token.split(".");
	if (!header || !payload || !sig) return null;
	try {
		const key = await crypto.subtle.importKey(
			"jwk",
			jwkFor(b64urlDecode(publicKey)),
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["verify"],
		);
		const ok = await crypto.subtle.verify(
			{ name: "ECDSA", hash: "SHA-256" },
			key,
			b64urlDecode(sig),
			encoder.encode(`${header}.${payload}`),
		);
		return ok ? (JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as VapidClaims) : null;
	} catch {
		return null;
	}
}

/** The `Authorization` header value: `vapid t=<jwt>, k=<public key>`. */
export async function vapidAuthorization(
	endpoint: string,
	keys: P256KeyPair,
	subject: string,
	nowSeconds = Math.floor(Date.now() / 1000),
	ttlSeconds = 12 * 3600,
): Promise<string> {
	const exp = nowSeconds + Math.min(ttlSeconds, VAPID_MAX_TTL_SECONDS);
	const jwt = await signVapidJwt({ aud: vapidAudience(endpoint), exp, sub: subject }, keys);
	return `vapid t=${jwt}, k=${keys.publicKey}`;
}
