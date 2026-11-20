// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Time-based one-time passwords (RFC 6238) and recovery codes.
 *
 * SHA-1, 6 digits, 30-second steps: the parameters every authenticator app
 * supports. Anything else (SHA-256, 8 digits) is silently ignored by several
 * popular apps, which then show codes that never verify.
 *
 * Replay protection is not here: `verifyTotp` returns the matched step and the
 * AuthDO refuses any step not newer than the last accepted one, atomically.
 */

import { timingSafeEqualString } from "./crypto";

const STEP_SECONDS = 30;
const DIGITS = 6;
/** Accept the previous and next step too, to absorb clock skew and typing time. */
const WINDOW = 1;
const SECRET_BYTES = 20;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, upper-case, no padding (what otpauth URIs expect). */
export function base32Encode(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const b of bytes) {
		value = (value << 8) | b;
		bits += 8;
		while (bits >= 5) {
			out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
	return out;
}

/**
 * Decode base32, tolerating lower case, spaces, dashes and padding — people
 * paste secrets in every format. Throws on any other character.
 */
export function base32Decode(input: string): Uint8Array<ArrayBuffer> {
	const clean = input.toUpperCase().replace(/[\s=-]/g, "");
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const ch of clean) {
		const idx = BASE32_ALPHABET.indexOf(ch);
		if (idx < 0) throw new Error("invalid base32");
		value = ((value << 5) | idx) & 0xffff;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return new Uint8Array(out);
}

/** A fresh base32 secret of 20 random bytes (160 bits, the RFC 4226 recommendation). */
export function generateTotpSecret(): string {
	return base32Encode(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

/** `otpauth://totp/<issuer>:<account>?...` for the enrolment QR code. */
export function totpUri(o: { secret: string; account: string; issuer: string }): string {
	const label = encodeURIComponent(`${o.issuer}:${o.account}`);
	const params = new URLSearchParams({
		secret: o.secret,
		issuer: o.issuer,
		algorithm: "SHA1",
		digits: String(DIGITS),
		period: String(STEP_SECONDS),
	});
	return `otpauth://totp/${label}?${params.toString()}`;
}

/** HOTP value (RFC 4226) for a counter, zero-padded to `DIGITS`. */
export async function hotp(key: Uint8Array<ArrayBuffer>, counter: number): Promise<string> {
	const msg = new Uint8Array(8);
	// Counter as a 64-bit big-endian integer. Steps fit comfortably in 53 bits.
	let c = counter;
	for (let i = 7; i >= 0; i--) {
		msg[i] = c & 0xff;
		c = Math.floor(c / 256);
	}
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		key,
		{ name: "HMAC", hash: "SHA-1" },
		false,
		["sign"],
	);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, msg));
	const offset = mac[mac.length - 1] & 0x0f;
	const bin =
		((mac[offset] & 0x7f) << 24) |
		(mac[offset + 1] << 16) |
		(mac[offset + 2] << 8) |
		mac[offset + 3];
	return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** The 30-second step containing `nowMs`. */
export function totpStep(nowMs: number): number {
	return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/**
 * Check a 6-digit code against the steps around `nowMs`.
 *
 * Returns the matched step (for replay tracking) or null. Every step in the
 * window is computed and compared in constant time, so timing does not reveal
 * which step, if any, matched.
 */
export async function verifyTotp(
	secret: string,
	code: string,
	nowMs: number,
): Promise<number | null> {
	const normalized = typeof code === "string" ? code.replace(/\s/g, "") : "";
	if (!/^\d{6}$/.test(normalized)) return null;
	let key: Uint8Array<ArrayBuffer>;
	try {
		key = base32Decode(secret);
	} catch {
		return null;
	}
	if (key.length === 0) return null;
	const current = totpStep(nowMs);
	let matched: number | null = null;
	for (let delta = -WINDOW; delta <= WINDOW; delta++) {
		const step = current + delta;
		if (step < 0) continue;
		const expected = await hotp(key, step);
		// Keep the newest match so a code valid for two steps cannot be replayed
		// once as the older and once as the newer.
		if (timingSafeEqualString(expected, normalized)) matched = step;
	}
	return matched;
}

/**
 * Lower-case RFC 4648 base32 alphabet: no 0/1/8/9, so the usual look-alikes
 * (0/o, 1/l, 8/b) cannot be confused when a code is copied from paper.
 */
const RECOVERY_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * One-time recovery codes, `xxxxx-xxxxx` (50 bits each). Shown once; stored as
 * `sha256Hex(normalizeRecoveryCode(code))`.
 */
export function generateRecoveryCodes(count = 10): string[] {
	const codes: string[] = [];
	for (let i = 0; i < count; i++) {
		// 32 symbols divide 256 evenly, so `b & 31` is unbiased.
		const bytes = crypto.getRandomValues(new Uint8Array(10));
		let s = "";
		for (const b of bytes) s += RECOVERY_ALPHABET[b & 31];
		codes.push(`${s.slice(0, 5)}-${s.slice(5)}`);
	}
	return codes;
}

/** Canonical form for hashing: lower-case, no spaces or dashes. */
export function normalizeRecoveryCode(code: string): string {
	return typeof code === "string" ? code.toLowerCase().replace(/[\s-]/g, "") : "";
}
