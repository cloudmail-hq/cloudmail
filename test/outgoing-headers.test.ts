// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Headers on outgoing mail.
 *
 * ## The bug this file now exists to prevent
 *
 * Every outgoing email in the product silently failed to deliver, because
 * `buildOutgoingHeaders` set `Message-ID` on every send. Cloudflare Email Service
 * treats that header as platform-controlled — it generates its own — and rejects
 * any attempt to set one:
 *
 *     custom header 'Message-ID' is not allowed.
 *     Only whitelisted headers and X-* headers are accepted.
 *
 * A rejected header fails the WHOLE message. `Sender`, added for shared-mailbox
 * attribution, is refused for the same reason: it is not on the allowlist.
 *
 * ## Why the previous version of this file did not catch it
 *
 * It asserted the opposite. Its first case was literally titled *"always emits
 * Message-ID, even with no threading context"*, and it passed — because it only
 * ever checked the shape of the object we build, never whether the provider would
 * accept it. 1496 tests were green while 100% of sends failed.
 *
 * That is the lesson these tests encode: a formatting assertion is not a contract
 * test. Every case below is written against the provider's documented allowlist
 * (`shared/email-headers.ts`), so the header set is checked against what Email
 * Service will actually take, not against what we happen to emit.
 */

import { describe, expect, it } from "vitest";
import { buildOutgoingHeaders } from "../workers/lib/email-helpers";
import {
	ALLOWLISTED_HEADERS,
	API_FIELD_HEADERS,
	PLATFORM_CONTROLLED_HEADERS,
	UnsendableHeaderError,
	assertSendableHeaders,
	isSendableHeader,
	rejectionFor,
} from "../shared/email-headers";

describe("buildOutgoingHeaders", () => {
	// ── The regression itself ────────────────────────────────────────────────
	it("NEVER emits Message-ID — the provider generates it and rejects ours", () => {
		// The exact assertion the old suite got backwards. Every send path reached
		// this function, so this one property is the whole outage.
		const cases = [
			{},
			{ inReplyTo: "parent@example.com" },
			{ references: ["root@example.com"] },
			{ inReplyTo: "parent@example.com", references: ["root@example.com"] },
		];
		for (const options of cases) {
			expect(buildOutgoingHeaders(options)).not.toHaveProperty("Message-ID");
		}
	});

	it("NEVER emits Sender — not allowlisted, so it fails the message too", () => {
		expect(buildOutgoingHeaders({ inReplyTo: "a@b" })).not.toHaveProperty("Sender");
	});

	it("produces only headers the provider will accept, for every input shape", () => {
		// The property that matters, stated directly: whatever this function returns
		// must be sendable. A future addition that is not allowlisted fails here.
		for (const options of [
			{},
			{ inReplyTo: "p@x" },
			{ references: ["a@x", "b@x"] },
			{ inReplyTo: "p@x", references: ["a@x"] },
		]) {
			for (const name of Object.keys(buildOutgoingHeaders(options))) {
				expect(isSendableHeader(name), `${name} would be rejected`).toBe(true);
			}
		}
	});

	it("emits nothing at all for a brand-new message", () => {
		// A new message has no ancestor, so there is nothing allowlisted to send.
		// Previously this returned a lone Message-ID, which is what made the
		// simplest possible send — a fresh email with no reply context — fail.
		expect(buildOutgoingHeaders({})).toEqual({});
	});

	// ── Threading, which still works ─────────────────────────────────────────
	it("wraps threading ids in angle brackets, as RFC 5322 requires", () => {
		expect(
			buildOutgoingHeaders({
				inReplyTo: "parent@other.example",
				references: ["root@other.example", "parent@other.example"],
			}),
		).toEqual({
			"In-Reply-To": "<parent@other.example>",
			References: "<root@other.example> <parent@other.example>",
		});
	});

	it("joins References with a single space, oldest first", () => {
		expect(buildOutgoingHeaders({ references: ["a@x", "b@x", "c@x"] }).References).toBe(
			"<a@x> <b@x> <c@x>",
		);
	});

	it("omits In-Reply-To rather than sending an empty one", () => {
		// `<>` is not a valid msg-id and some receivers reject the message.
		for (const inReplyTo of [undefined, null, ""]) {
			expect(buildOutgoingHeaders({ inReplyTo })).not.toHaveProperty("In-Reply-To");
		}
	});

	it("omits References when the chain is empty", () => {
		expect(buildOutgoingHeaders({ references: [] })).not.toHaveProperty("References");
	});

	it("can carry In-Reply-To without References", () => {
		// A direct reply to a thread root: there is a parent but no ancestry yet.
		expect(buildOutgoingHeaders({ inReplyTo: "a@example.com" })).toEqual({
			"In-Reply-To": "<a@example.com>",
		});
	});

	it("returns a fresh object each call", () => {
		// Callers spread these into a request body; a shared object would let one
		// send leak headers into the next.
		const a = buildOutgoingHeaders({ inReplyTo: "a@example.com" });
		const b = buildOutgoingHeaders({ inReplyTo: "b@example.com" });
		expect(a).not.toBe(b);
		expect(a["In-Reply-To"]).toBe("<a@example.com>");
	});
});

describe("the provider header contract", () => {
	it("classifies every platform-controlled header as unsendable", () => {
		for (const name of PLATFORM_CONTROLLED_HEADERS) {
			expect(rejectionFor(name), name).toBe("platform-controlled");
		}
	});

	it("classifies Message-ID specifically — the header that caused the outage", () => {
		expect(rejectionFor("Message-ID")).toBe("platform-controlled");
	});

	it("matches header names case-insensitively, per RFC 5322 §2.2", () => {
		// A case-sensitive guard would let the same outage back in via `message-id`.
		for (const variant of ["message-id", "MESSAGE-ID", "Message-Id", "mEsSaGe-iD"]) {
			expect(rejectionFor(variant), variant).toBe("platform-controlled");
		}
	});

	it("points first-class fields at their API field instead", () => {
		for (const name of API_FIELD_HEADERS) {
			expect(rejectionFor(name), name).toBe("use-api-field");
		}
	});

	it("accepts every documented allowlisted header", () => {
		for (const name of ALLOWLISTED_HEADERS) {
			expect(rejectionFor(name), name).toBeNull();
		}
	});

	it("accepts any X- prefixed header, including underscores", () => {
		for (const name of ["X-Mailer", "X-Campaign-ID", "X-Tapetide_Trace"]) {
			expect(isSendableHeader(name), name).toBe(true);
		}
	});

	it("rejects Sender, which is plausible but not allowlisted", () => {
		expect(rejectionFor("Sender")).toBe("not-allowlisted");
	});

	it("treats the ARC-* family as platform-controlled", () => {
		expect(rejectionFor("ARC-Seal")).toBe("platform-controlled");
		expect(rejectionFor("arc-authentication-results")).toBe("platform-controlled");
	});

	it("rejects an empty or whitespace-only name rather than passing it on", () => {
		for (const name of ["", "   "]) {
			expect(rejectionFor(name)).toBe("not-allowlisted");
		}
	});
});

describe("assertSendableHeaders", () => {
	it("accepts a threading-only header set", () => {
		expect(() =>
			assertSendableHeaders({ "In-Reply-To": "<a@x>", References: "<a@x>" }),
		).not.toThrow();
	});

	it("throws on Message-ID, naming the header and the reason", () => {
		// The guard exists so a rejected header fails in CI rather than in a
		// waitUntil nobody reads.
		try {
			assertSendableHeaders({ "Message-ID": "<a@x>" });
			throw new Error("expected assertSendableHeaders to throw");
		} catch (e) {
			expect(e).toBeInstanceOf(UnsendableHeaderError);
			const err = e as UnsendableHeaderError;
			expect(err.headerName).toBe("Message-ID");
			expect(err.rejection).toBe("platform-controlled");
			expect(err.message).toContain("cannot be set");
		}
	});

	it("throws when ANY header in the set is unsendable, not just the first", () => {
		// One bad header fails the whole message at the provider, so the guard must
		// not pass a set just because it starts out valid.
		expect(() =>
			assertSendableHeaders({ "In-Reply-To": "<a@x>", Sender: "someone@x" }),
		).toThrow(UnsendableHeaderError);
	});

	it("accepts an empty header set", () => {
		expect(() => assertSendableHeaders({})).not.toThrow();
	});
});
