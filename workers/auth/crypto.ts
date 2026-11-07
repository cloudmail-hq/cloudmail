// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Cryptographic primitives for built-in authentication.
 *
 * Passwords use scrypt from `node:crypto` (available under `nodejs_compat`)
 * rather than PBKDF2 from WebCrypto: scrypt is memory-hard, so the hashes are
 * far more expensive to attack on GPUs at the same CPU cost to us. Everything
 * else is plain WebCrypto. No third-party dependencies, on purpose — this is the
 * code that guards every mailbox.
 *
 * Hashing runs in the stateless Worker, never in the AuthDO, so one slow hash
 * cannot queue every other login behind the single-threaded object.
 */

import { scrypt, timingSafeEqual } from "node:crypto";

export const PASSWORD_MIN_LENGTH = 10;
/**
 * Upper bound checked before hashing. scrypt's cost does not grow much with
 * input length, but NFKC normalization and the request body do, and there is
 * no legitimate reason for a longer password.
 */
export const PASSWORD_MAX_LENGTH = 256;

/** Current scrypt parameters. ln is log2(N). Raise these and `needsRehash` upgrades on login. */
const SCRYPT_LN = 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_SALT_BYTES = 16;
/** 128 * N * r = 32 MiB at the current parameters; leave headroom. */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
/**
 * Refuse stored hashes demanding more than this. The parameters come from the
 * stored string, so a corrupted (or planted) row must not be able to make one
 * verification allocate gigabytes.
 */
const SCRYPT_MAX_LN = 16;

/** Returns an error message, or null when the password is acceptable. */
export function validatePassword(password: string): string | null {
	if (typeof password !== "string") return "Password is required";
	const normalized = password.normalize("NFKC");
	if (normalized.length < PASSWORD_MIN_LENGTH) {
		return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
	}
	if (normalized.length > PASSWORD_MAX_LENGTH) {
		return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
	}
	if (normalized.trim().length === 0) return "Password cannot be only whitespace";
	return null;
}

function scryptAsync(
	password: string,
	salt: Uint8Array,
	keylen: number,
	ln: number,
	r: number,
	p: number,
): Promise<Uint8Array<ArrayBuffer>> {
	return new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
		scrypt(
			password,
			salt,
			keylen,
			{ N: 2 ** ln, r, p, maxmem: SCRYPT_MAXMEM },
			(err, key) => (err ? reject(err) : resolve(Uint8Array.from(key))),
		);
	});
}

/**
 * Hash a password as `$scrypt$ln=15,r=8,p=1$<saltB64>$<hashB64>`.
 *
 * NFKC normalization means the same password typed on different keyboards or
 * input methods (composed vs decomposed accents, full-width digits) hashes the
 * same. Throws on over-length input: callers validate first, this is the floor.
 */
export async function hashPassword(password: string): Promise<string> {
	const normalized = password.normalize("NFKC");
	if (normalized.length > PASSWORD_MAX_LENGTH) throw new Error("password too long");
	const salt = crypto.getRandomValues(new Uint8Array(SCRYPT_SALT_BYTES));
	const hash = await scryptAsync(normalized, salt, SCRYPT_KEYLEN, SCRYPT_LN, SCRYPT_R, SCRYPT_P);
	return `$scrypt$ln=${SCRYPT_LN},r=${SCRYPT_R},p=${SCRYPT_P}$${toBase64(salt)}$${toBase64(hash)}`;
}

interface ParsedHash {
	ln: number;
	r: number;
	p: number;
	salt: Uint8Array<ArrayBuffer>;
	hash: Uint8Array<ArrayBuffer>;
}

/** Parse a stored hash, or null when it is not one we wrote. */
function parseHash(stored: string): ParsedHash | null {
	if (typeof stored !== "string") return null;
	const parts = stored.split("$");
	// ["", "scrypt", "ln=..,r=..,p=..", salt, hash]
	if (parts.length !== 5 || parts[0] !== "" || parts[1] !== "scrypt") return null;
	const params = /^ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})$/.exec(parts[2]);
	if (!params) return null;
	const ln = Number(params[1]);
	const r = Number(params[2]);
	const p = Number(params[3]);
	if (ln < 1 || ln > SCRYPT_MAX_LN || r < 1 || r > 16 || p < 1 || p > 16) return null;
	try {
		const salt = fromBase64(parts[3]);
		const hash = fromBase64(parts[4]);
		if (salt.length < 8 || hash.length < 16 || hash.length > 64) return null;
		return { ln, r, p, salt, hash };
	} catch {
		return null;
	}
}

/**
 * Verify a password against a stored hash in constant time.
 *
 * Parameters are read from the stored string rather than assumed, so hashes
 * made under older parameters keep verifying after the defaults are raised.
 * Malformed hashes and over-length passwords verify false; neither throws, so a
 * bad row cannot turn into a 500 that distinguishes accounts.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	if (typeof password !== "string") return false;
	const normalized = password.normalize("NFKC");
	if (normalized.length > PASSWORD_MAX_LENGTH) return false;
	const parsed = parseHash(stored);
	if (!parsed) return false;
	let candidate: Uint8Array<ArrayBuffer>;
	try {
		candidate = await scryptAsync(
			normalized,
			parsed.salt,
			parsed.hash.length,
			parsed.ln,
			parsed.r,
			parsed.p,
		);
	} catch {
		// Parameters within the parse limits but over `maxmem`: treat as malformed.
		return false;
	}
	return timingSafeEqual(candidate, parsed.hash);
}

/** True when the stored hash was made with weaker parameters than the current ones. */
export function needsRehash(stored: string): boolean {
	const parsed = parseHash(stored);
	if (!parsed) return true;
	return (
		parsed.ln < SCRYPT_LN ||
		parsed.r < SCRYPT_R ||
		parsed.p < SCRYPT_P ||
		parsed.hash.length < SCRYPT_KEYLEN
	);
}

/**
 * A valid hash of a password nobody knows, at current parameters. Verifying
 * against it costs exactly what a real verification does.
 */
const DUMMY_HASH =
	"$scrypt$ln=15,r=8,p=1$dGFwZXRpZGUtZHVtbXktc2FsdA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/**
 * Burn one scrypt verification for an unknown email, so "no such user" and
 * "wrong password" take the same time and the login endpoint does not become
 * an account-enumeration oracle.
 */
export async function dummyVerifyPassword(password: string): Promise<void> {
	await verifyPassword(typeof password === "string" ? password : "", DUMMY_HASH);
}

/** Lower-case hex SHA-256. Used to store tokens so the database never holds a usable one. */
export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return toHex(new Uint8Array(digest));
}

/** URL-safe random token. 32 bytes = 256 bits by default. */
export function randomToken(bytes = 32): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 22;

/**
 * `<prefix>_<22 alphanumerics>` (~131 bits). The alphabet deliberately has no
 * `_` or `-`, so `ttk_<id>_<secret>` splits unambiguously on the first two
 * underscores and ids survive double-click selection.
 */
export function randomId(prefix: string, length = ID_LENGTH): string {
	return `${prefix}_${randomAlphanumeric(length)}`;
}

/** Uniform random string over [A-Za-z0-9] via rejection sampling (no modulo bias). */
export function randomAlphanumeric(length: number): string {
	// 62 * 4 = 248: bytes >= 248 are rejected so every symbol is equally likely.
	const limit = 248;
	let out = "";
	while (out.length < length) {
		const buf = crypto.getRandomValues(new Uint8Array((length - out.length) * 2));
		for (const b of buf) {
			if (b >= limit) continue;
			out += ID_ALPHABET[b % 62];
			if (out.length === length) break;
		}
	}
	return out;
}

/**
 * Constant-time string comparison. Length is not secret here (all compared
 * values are fixed-length hashes or tokens), so a length mismatch returns early.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
	if (typeof a !== "string" || typeof b !== "string") return false;
	const ea = new TextEncoder().encode(a);
	const eb = new TextEncoder().encode(b);
	if (ea.length !== eb.length) return false;
	let diff = 0;
	for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
	return diff === 0;
}

const SECRET_INFO = new TextEncoder().encode("tapetide-totp-v1");

/**
 * A different use of the same key material: its own HKDF `info` (so the
 * derived key differs from the TOTP one) and optional AES-GCM associated data
 * binding a ciphertext to a record, so it cannot be moved to another one.
 * Omitted, both functions behave exactly as they always have (TOTP).
 */
export interface SecretPurpose {
	info: string;
	aad?: string;
}

/**
 * AES-256-GCM key from arbitrary key material via HKDF-SHA256. HKDF (not a raw
 * hash) because `AUTH_SECRET` may be a human-chosen string; the fixed `info`
 * binds the key to this purpose so the same secret can later derive others.
 */
async function deriveSecretKey(keyMaterial: string, info: Uint8Array<ArrayBuffer> = SECRET_INFO): Promise<CryptoKey> {
	if (!keyMaterial) throw new Error("missing key material");
	const base = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(keyMaterial),
		"HKDF",
		false,
		["deriveKey"],
	);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

/**
 * Encrypt a small secret (a TOTP seed) for storage: `v1.<ivB64url>.<ctB64url>`.
 * A database dump alone then cannot mint second-factor codes.
 */
export async function encryptSecret(
	plaintext: string,
	keyMaterial: string,
	purpose?: SecretPurpose,
): Promise<string> {
	const key = await deriveSecretKey(keyMaterial, purpose ? new TextEncoder().encode(purpose.info) : undefined);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt(
		purpose?.aad !== undefined
			? { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(purpose.aad) }
			: { name: "AES-GCM", iv },
		key,
		new TextEncoder().encode(plaintext),
	);
	return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
}

/** Inverse of `encryptSecret`. Throws on a wrong key, tampering or a malformed value. */
export async function decryptSecret(enc: string, keyMaterial: string, purpose?: SecretPurpose): Promise<string> {
	const parts = typeof enc === "string" ? enc.split(".") : [];
	if (parts.length !== 3 || parts[0] !== "v1") throw new Error("malformed secret");
	const iv = fromBase64Url(parts[1]);
	const ct = fromBase64Url(parts[2]);
	if (iv.length !== 12) throw new Error("malformed secret");
	const key = await deriveSecretKey(keyMaterial, purpose ? new TextEncoder().encode(purpose.info) : undefined);
	const pt = await crypto.subtle.decrypt(
		purpose?.aad !== undefined
			? { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(purpose.aad) }
			: { name: "AES-GCM", iv },
		key,
		ct,
	);
	return new TextDecoder().decode(pt);
}

/** Trim + lower-case. Emails are compared and stored in this form everywhere. */
export function normalizeEmail(email: string): string {
	return typeof email === "string" ? email.trim().toLowerCase() : "";
}

// -- encoding helpers -------------------------------------------------------

function toHex(bytes: Uint8Array): string {
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}

function toBase64(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error("bad base64");
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function toBase64Url(bytes: Uint8Array): string {
	return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64url");
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
	return fromBase64(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}
