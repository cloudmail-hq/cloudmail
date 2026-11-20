// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Password hashing, token helpers and at-rest secret encryption.
 *
 * These run against the real `node:crypto` scrypt and WebCrypto, the same
 * primitives workerd provides under `nodejs_compat`, so the hash format and the
 * parameter parsing are tested as shipped rather than through a stub.
 */

import { describe, expect, it } from "vitest";
import {
	PASSWORD_MAX_LENGTH,
	PASSWORD_MIN_LENGTH,
	decryptSecret,
	dummyVerifyPassword,
	encryptSecret,
	hashPassword,
	needsRehash,
	normalizeEmail,
	randomId,
	randomToken,
	sha256Hex,
	timingSafeEqualString,
	validatePassword,
	verifyPassword,
} from "../workers/auth/crypto";

describe("validatePassword", () => {
	it("enforces the length bounds", () => {
		expect(validatePassword("a".repeat(PASSWORD_MIN_LENGTH - 1))).toMatch(/at least/);
		expect(validatePassword("a".repeat(PASSWORD_MIN_LENGTH))).toBeNull();
		expect(validatePassword("a".repeat(PASSWORD_MAX_LENGTH + 1))).toMatch(/at most/);
	});

	it("rejects whitespace-only passwords", () => {
		expect(validatePassword(" ".repeat(20))).not.toBeNull();
	});
});

describe("hashPassword / verifyPassword", () => {
	it("round-trips and uses the documented format", async () => {
		const hash = await hashPassword("correct horse battery");
		expect(hash).toMatch(/^\$scrypt\$ln=15,r=8,p=1\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*$/);
		expect(await verifyPassword("correct horse battery", hash)).toBe(true);
		expect(await verifyPassword("correct horse batterY", hash)).toBe(false);
	});

	it("salts every hash", async () => {
		const a = await hashPassword("same password here");
		const b = await hashPassword("same password here");
		expect(a).not.toBe(b);
	});

	it("normalizes with NFKC so composed and decomposed input match", async () => {
		const composed = "caf\u00e9-password";
		const decomposed = "cafe\u0301-password";
		expect(composed).not.toBe(decomposed);
		const hash = await hashPassword(composed);
		expect(await verifyPassword(decomposed, hash)).toBe(true);
	});

	it("reads parameters from the stored string, so older hashes still verify", async () => {
		// A hash made with weaker parameters than the current defaults.
		const { scryptSync } = await import("node:crypto");
		const salt = Buffer.from("0123456789abcdef");
		const key = scryptSync("legacy-password", salt, 32, { N: 2 ** 10, r: 8, p: 1 });
		const stored = `$scrypt$ln=10,r=8,p=1$${salt.toString("base64")}$${key.toString("base64")}`;
		expect(await verifyPassword("legacy-password", stored)).toBe(true);
		expect(needsRehash(stored)).toBe(true);
		expect(needsRehash(await hashPassword("legacy-password"))).toBe(false);
	});

	it("rejects malformed and hostile hashes without throwing", async () => {
		for (const bad of [
			"",
			"plaintext",
			"$scrypt$ln=15,r=8,p=1$onlysalt",
			"$bcrypt$ln=15,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
			"$scrypt$ln=30,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
			"$scrypt$ln=15,r=8,p=1$!!!$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
		]) {
			expect(await verifyPassword("whatever-password", bad)).toBe(false);
			expect(needsRehash(bad)).toBe(true);
		}
	});

	it("refuses over-length passwords before hashing", async () => {
		await expect(hashPassword("a".repeat(PASSWORD_MAX_LENGTH + 1))).rejects.toThrow();
		const hash = await hashPassword("a".repeat(PASSWORD_MIN_LENGTH));
		expect(await verifyPassword("a".repeat(100_000), hash)).toBe(false);
	});

	it("dummyVerifyPassword completes without throwing", async () => {
		await expect(dummyVerifyPassword("anything at all")).resolves.toBeUndefined();
	});
});

describe("tokens and ids", () => {
	it("sha256Hex matches a known vector", async () => {
		expect(await sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	it("randomToken is base64url of the requested size", () => {
		const t = randomToken();
		expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(randomToken()).not.toBe(t);
	});

	it("randomId is alphanumeric after the prefix, so ttk_<id>_<secret> parses", () => {
		for (let i = 0; i < 200; i++) {
			expect(randomId("usr")).toMatch(/^usr_[A-Za-z0-9]{22}$/);
		}
		expect(randomId("ttk", 12)).toMatch(/^ttk_[A-Za-z0-9]{12}$/);
	});

	it("timingSafeEqualString compares exactly", () => {
		expect(timingSafeEqualString("abc", "abc")).toBe(true);
		expect(timingSafeEqualString("abc", "abd")).toBe(false);
		expect(timingSafeEqualString("abc", "abcd")).toBe(false);
		expect(timingSafeEqualString("", "")).toBe(true);
	});

	it("normalizeEmail trims and lower-cases", () => {
		expect(normalizeEmail("  Owner@Example.COM ")).toBe("owner@example.com");
	});
});

describe("encryptSecret / decryptSecret", () => {
	it("round-trips with a fresh IV each time", async () => {
		const a = await encryptSecret("JBSWY3DPEHPK3PXP", "key material");
		const b = await encryptSecret("JBSWY3DPEHPK3PXP", "key material");
		expect(a).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
		expect(a).not.toBe(b);
		expect(await decryptSecret(a, "key material")).toBe("JBSWY3DPEHPK3PXP");
	});

	it("fails with the wrong key or tampered ciphertext", async () => {
		const enc = await encryptSecret("secret", "right key");
		await expect(decryptSecret(enc, "wrong key")).rejects.toThrow();
		const [v, iv, ct] = enc.split(".");
		const flipped = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
		await expect(decryptSecret(`${v}.${iv}.${flipped}`, "right key")).rejects.toThrow();
		await expect(decryptSecret("garbage", "right key")).rejects.toThrow();
	});
});
