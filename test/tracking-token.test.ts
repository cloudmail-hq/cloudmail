// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The signed tracking token. These are the security guarantees the whole public
 * endpoint rests on, so they are tested directly: round-trip, tamper rejection,
 * wrong-secret rejection, and that the signed click URL cannot be swapped (the
 * open-redirect guard).
 */

import { describe, expect, it } from "vitest";
import {
	readClaimedMailbox,
	signTrackingToken,
	verifyTrackingToken,
	type TrackingTokenPayload,
} from "../shared/tracking-token";

const SECRET = "a".repeat(64);
const OTHER_SECRET = "b".repeat(64);

const openPayload: TrackingTokenPayload = {
	mailboxId: "support@tapetide.com",
	emailId: "local-123",
	recipient: "user@example.org",
	kind: "opened",
};

const clickPayload: TrackingTokenPayload = {
	mailboxId: "support@tapetide.com",
	emailId: "local-123",
	recipient: "user@example.org",
	kind: "clicked",
	url: "https://tapetide.com/pricing",
};

describe("round trip", () => {
	it("verifies a token it just signed and returns the payload", async () => {
		const token = await signTrackingToken(openPayload, SECRET);
		const verified = await verifyTrackingToken(token, SECRET);
		expect(verified).toEqual(openPayload);
	});

	it("preserves the signed click URL", async () => {
		const token = await signTrackingToken(clickPayload, SECRET);
		const verified = await verifyTrackingToken(token, SECRET);
		expect(verified?.url).toBe("https://tapetide.com/pricing");
	});

	it("carries a null recipient for a message-level pixel", async () => {
		const token = await signTrackingToken(
			{ ...openPayload, recipient: null },
			SECRET,
		);
		expect((await verifyTrackingToken(token, SECRET))?.recipient).toBeNull();
	});
});

describe("readClaimedMailbox", () => {
	it("reads the mailbox in the clear without a secret", async () => {
		const token = await signTrackingToken(openPayload, SECRET);
		expect(readClaimedMailbox(token)).toBe("support@tapetide.com");
	});

	it("returns null for a garbage token", () => {
		expect(readClaimedMailbox("not-a-token")).toBeNull();
	});
});

describe("rejection", () => {
	it("rejects a token signed with a different secret", async () => {
		const token = await signTrackingToken(openPayload, SECRET);
		expect(await verifyTrackingToken(token, OTHER_SECRET)).toBeNull();
	});

	it("rejects a tampered payload — the open-redirect guard", async () => {
		// An attacker swaps the click destination for their own site. The payload
		// changed but the signature did not, so verify must refuse it.
		const token = await signTrackingToken(clickPayload, SECRET);
		const [body, sig] = token.split(".");
		// Re-encode a payload with an evil URL, keep the original signature.
		const evil = { ...clickPayload, url: "https://evil.example/steal" };
		const evilBody = btoa(
			JSON.stringify({
				m: evil.mailboxId,
				e: evil.emailId,
				r: evil.recipient,
				k: evil.kind,
				u: evil.url,
			}),
		)
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		const forged = `${evilBody}.${sig}`;
		expect(body).not.toBe(evilBody); // sanity: we really changed it
		expect(await verifyTrackingToken(forged, SECRET)).toBeNull();
	});

	it("rejects a token whose signature is truncated", async () => {
		const token = await signTrackingToken(openPayload, SECRET);
		const [body] = token.split(".");
		expect(await verifyTrackingToken(`${body}.deadbeef`, SECRET)).toBeNull();
	});

	it("rejects a token with no signature part", async () => {
		const [body] = (await signTrackingToken(openPayload, SECRET)).split(".");
		expect(await verifyTrackingToken(body, SECRET)).toBeNull();
	});

	it("rejects a re-pointed mailbox — the signature covers the mailbox id", async () => {
		// Even though readClaimedMailbox would report the swapped mailbox, verify
		// against that mailbox's secret fails because the id is under the HMAC.
		const token = await signTrackingToken(openPayload, SECRET);
		const [, sig] = token.split(".");
		const swapped = btoa(
			JSON.stringify({ m: "ceo@tapetide.com", e: "local-123", r: null, k: "opened" }),
		)
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		expect(await verifyTrackingToken(`${swapped}.${sig}`, SECRET)).toBeNull();
	});
});
