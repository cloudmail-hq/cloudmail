// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The unsubscribe token is the only credential on a public, cookieless POST
 * that writes to the suppression list. A forgeable token would let anyone
 * silence any address on any sending domain, so the guarantees are pinned
 * directly: round trip, tamper rejection, wrong secret, malformed input.
 */

import { describe, expect, it } from "vitest";
import {
	signUnsubscribeToken,
	verifyUnsubscribeToken,
} from "../shared/unsubscribe-token";

const SECRET = "s".repeat(64);
const payload = {
	address: "Reader@Example.org",
	domain: "Product.dev",
	mailbox: "hello@product.dev",
};

describe("unsubscribe token", () => {
	it("round-trips and lowercases address and domain", async () => {
		const token = await signUnsubscribeToken(payload, SECRET);
		expect(await verifyUnsubscribeToken(token, SECRET)).toEqual({
			address: "reader@example.org",
			domain: "product.dev",
			mailbox: "hello@product.dev",
		});
	});

	it("is URL-safe with no padding", async () => {
		const token = await signUnsubscribeToken(payload, SECRET);
		expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
	});

	it("rejects a token signed with another secret", async () => {
		const token = await signUnsubscribeToken(payload, "other-secret");
		expect(await verifyUnsubscribeToken(token, SECRET)).toBeNull();
	});

	it("rejects a payload swapped under the original signature", async () => {
		const token = await signUnsubscribeToken(payload, SECRET);
		const forged = await signUnsubscribeToken({ ...payload, address: "victim@example.org" }, SECRET);
		const [, sig] = token.split(".");
		const [body] = forged.split(".");
		expect(await verifyUnsubscribeToken(`${body}.${sig}`, SECRET)).toBeNull();
	});

	it("rejects a flipped signature byte", async () => {
		const token = await signUnsubscribeToken(payload, SECRET);
		const last = token.at(-1) === "A" ? "B" : "A";
		expect(await verifyUnsubscribeToken(token.slice(0, -1) + last, SECRET)).toBeNull();
	});

	it("rejects malformed input without throwing", async () => {
		for (const bad of ["", "abc", "a.b.c", "!!!.???", ".", "x."]) {
			expect(await verifyUnsubscribeToken(bad, SECRET)).toBeNull();
		}
		expect(await verifyUnsubscribeToken("anything.here", "")).toBeNull();
	});

	it("refuses to sign with an empty secret", async () => {
		await expect(signUnsubscribeToken(payload, "")).rejects.toThrow();
	});
});
