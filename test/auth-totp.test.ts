// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * TOTP against the RFC 6238 reference vectors.
 *
 * The RFC lists 8-digit codes; the 6-digit values used here are the same
 * HOTP truncation taken mod 10^6, which is what every authenticator app shows.
 */

import { describe, expect, it } from "vitest";
import {
	base32Decode,
	base32Encode,
	generateRecoveryCodes,
	generateTotpSecret,
	hotp,
	normalizeRecoveryCode,
	totpStep,
	totpUri,
	verifyTotp,
} from "../workers/auth/totp";

const RFC_SECRET = base32Encode(new TextEncoder().encode("12345678901234567890"));

const VECTORS: Array<[number, string]> = [
	[59, "287082"],
	[1111111109, "081804"],
	[1111111111, "050471"],
	[1234567890, "005924"],
	[2000000000, "279037"],
];

describe("base32", () => {
	it("encodes per RFC 4648", () => {
		expect(base32Encode(new TextEncoder().encode("foobar"))).toBe("MZXW6YTBOI");
		expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
	});

	it("decodes leniently and rejects junk", () => {
		expect(new TextDecoder().decode(base32Decode("mzxw 6ytb-oi=="))).toBe("foobar");
		expect(() => base32Decode("MZXW1")).toThrow();
	});

	it("generates 160-bit secrets", () => {
		const s = generateTotpSecret();
		expect(s).toMatch(/^[A-Z2-7]{32}$/);
		expect(base32Decode(s).length).toBe(20);
	});
});

describe("RFC 6238 vectors", () => {
	it.each(VECTORS)("T=%i -> %s", async (seconds, code) => {
		const key = new TextEncoder().encode("12345678901234567890");
		expect(await hotp(key, totpStep(seconds * 1000))).toBe(code);
		expect(await verifyTotp(RFC_SECRET, code, seconds * 1000)).toBe(totpStep(seconds * 1000));
	});
});

describe("verifyTotp", () => {
	const t = 1111111111 * 1000;

	it("accepts one step either side and nothing further", async () => {
		const step = totpStep(t);
		expect(await verifyTotp(RFC_SECRET, "050471", t + 30_000)).toBe(step);
		expect(await verifyTotp(RFC_SECRET, "050471", t - 30_000)).toBe(step);
		expect(await verifyTotp(RFC_SECRET, "050471", t + 90_000)).toBeNull();
	});

	it("rejects malformed codes and secrets", async () => {
		expect(await verifyTotp(RFC_SECRET, "05047", t)).toBeNull();
		expect(await verifyTotp(RFC_SECRET, "abcdef", t)).toBeNull();
		expect(await verifyTotp(RFC_SECRET, "000000", t)).toBeNull();
		expect(await verifyTotp("not base32!", "050471", t)).toBeNull();
	});

	it("tolerates spaces inside the code", async () => {
		expect(await verifyTotp(RFC_SECRET, "050 471", t)).toBe(totpStep(t));
	});
});

describe("totpUri", () => {
	it("builds an otpauth URI authenticators accept", () => {
		const uri = totpUri({ secret: "JBSWY3DPEHPK3PXP", account: "a@b.example", issuer: "Tapetide" });
		expect(uri.startsWith("otpauth://totp/Tapetide%3Aa%40b.example?")).toBe(true);
		const params = new URL(uri).searchParams;
		expect(params.get("secret")).toBe("JBSWY3DPEHPK3PXP");
		expect(params.get("issuer")).toBe("Tapetide");
		expect(params.get("digits")).toBe("6");
		expect(params.get("period")).toBe("30");
	});
});

describe("recovery codes", () => {
	it("generates distinct xxxxx-xxxxx codes", () => {
		const codes = generateRecoveryCodes();
		expect(codes).toHaveLength(10);
		for (const c of codes) expect(c).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);
		expect(new Set(codes).size).toBe(10);
		expect(generateRecoveryCodes(3)).toHaveLength(3);
	});

	it("normalizes case, spaces and dashes", () => {
		expect(normalizeRecoveryCode(" ABCDE-fghij ")).toBe("abcdefghij");
		expect(normalizeRecoveryCode("abcde fghij")).toBe("abcdefghij");
	});
});
