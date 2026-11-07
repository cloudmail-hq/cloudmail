// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Previews must never show credentials. All fixtures are synthetic.
 */

import { describe, expect, it } from "vitest";
import { draftPreview, REDACTED, redactSecrets } from "../shared/redact-secrets";

describe("redactSecrets", () => {
	it.each([
		["Username: jdoe Password: hunter2!", "Username: jdoe Password: •••"],
		["pwd=Tr0ub4dor&3 thanks", "pwd=••• thanks"],
		["your password is Sunshine99", "your password is •••"],
		["passcode – 8812", "passcode – •••"],
		["API key: abc123def", "API key: •••"],
		["secret=xyz", "secret=•••"],
		["token: abc.def", "token: •••"],
	])("masks labelled secrets: %s", (input, expected) => {
		expect(redactSecrets(input)).toBe(expected);
	});

	it.each([
		"sk_" + "live_" + "FAKE0".repeat(5),
		"sk_" + "test_" + "FAKE0".repeat(5),
		"sk-proj-abcdefghijklmnop1234",
		"ttk_abcdEFGH1234ijkl",
		"ghp_abcdefghijklmnopqrstuvwxyz0123",
		"xoxb-1234567890-abcdefghij",
		"AKIAIOSFODNN7EXAMPLE",
	])("masks provider tokens: %s", (token) => {
		const out = redactSecrets(`here you go ${token} cheers`);
		expect(out).toBe(`here you go ${REDACTED} cheers`);
	});

	it("masks long hex and base64 runs", () => {
		expect(redactSecrets("hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 ok")).toBe(
			"hash ••• ok",
		);
		expect(
			redactSecrets("key eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefgh== end"),
		).toBe("key ••• end");
	});

	it.each([
		["Your code: 482913", "Your code: •••"],
		["verification code is 123 456", "verification code is •••"],
		["OTP 7731", "OTP •••"],
	])("masks one-time codes: %s", (input, expected) => {
		expect(redactSecrets(input)).toBe(expected);
	});

	it("masks Luhn-valid card numbers and leaves other numbers", () => {
		expect(redactSecrets("card 4242 4242 4242 4242 exp 12/30")).toBe(
			"card ••• exp 12/30",
		);
		expect(redactSecrets("card 4111-1111-1111-1111")).toBe("card •••");
		// 16 digits that fail Luhn: an order number, not a card.
		expect(redactSecrets("order 1234567812345678")).toBe("order 1234567812345678");
	});

	it("leaves ordinary prose alone", () => {
		const text =
			"Hi team, the password reset email went out. Code review is at 3pm on 2026-10-26, invoice #10423.";
		expect(redactSecrets(text)).toBe(text);
	});

	it("handles empty input", () => {
		expect(redactSecrets(null)).toBe("");
		expect(redactSecrets("")).toBe("");
	});
});

describe("draftPreview", () => {
	it("keeps only the first line", () => {
		expect(draftPreview("Hi Sam,\nHere are the logins: password: abc")).toBe("Hi Sam,");
	});

	it("masks secrets on the first line", () => {
		expect(draftPreview("password: hunter2 for the staging box")).toBe(
			"password: ••• for the staging box",
		);
	});

	it("truncates long first lines", () => {
		const out = draftPreview("word ".repeat(30), 20);
		expect(out).toBe(`${"word ".repeat(4).trimEnd()}…`);
	});
});
