// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for resolving the recipients of an inbound message.
 *
 * This exists because of a production incident, not a hypothetical. Delivery
 * keyed off the parsed `To:` header and threw `received email with empty to`
 * when it was absent. The email handler deliberately re-throws so Cloudflare
 * Email Routing can retry rather than silently dropping mail, so that throw
 * turned every header-less message into a retry-then-bounce: real inbound mail
 * was rejected at the door. Worker logs recorded it firing on live deliveries.
 *
 * A `To:` header is not guaranteed. Mail Bcc'd to us names someone else, list
 * expansion rewrites it, and automated senders omit it. The SMTP envelope
 * recipient is the address Email Routing actually delivered to, and it is always
 * there — so it leads, and the header only adds the rest of the audience.
 */

import { describe, expect, it } from "vitest";
import { resolveInboundRecipients } from "../workers/lib/email-helpers";

describe("resolveInboundRecipients", () => {
	it("accepts a message with no To: header at all", () => {
		// The regression. This used to throw and bounce the message.
		expect(
			resolveInboundRecipients({ envelopeTo: "support@tapetide.com", headerTo: [] }),
		).toEqual(["support@tapetide.com"]);
	});

	it("accepts a message whose To: header holds only null addresses", () => {
		// PostalMime yields entries with an undefined `address` for malformed
		// headers; the old guard checked `to[0].address` and threw on these.
		expect(
			resolveInboundRecipients({
				envelopeTo: "hr@tapetide.com",
				headerTo: [undefined, null],
			}),
		).toEqual(["hr@tapetide.com"]);
	});

	it("puts the envelope recipient first so routing prefers it", () => {
		// A message Bcc'd to us: the header names a third party, but we were
		// delivered to via the envelope, and that is the mailbox it belongs in.
		expect(
			resolveInboundRecipients({
				envelopeTo: "ceo@tapetide.com",
				headerTo: ["announce@othercompany.com"],
			}),
		).toEqual(["ceo@tapetide.com", "announce@othercompany.com"]);
	});

	it("keeps the rest of the audience so the stored recipient line is complete", () => {
		expect(
			resolveInboundRecipients({
				envelopeTo: "support@tapetide.com",
				headerTo: ["support@tapetide.com", "sales@tapetide.com"],
			}),
		).toEqual(["support@tapetide.com", "sales@tapetide.com"]);
	});

	it("de-duplicates case-insensitively", () => {
		// Envelope and header routinely disagree on casing for the same address.
		expect(
			resolveInboundRecipients({
				envelopeTo: "Support@Tapetide.com",
				headerTo: ["support@tapetide.com", "SUPPORT@TAPETIDE.COM"],
			}),
		).toEqual(["support@tapetide.com"]);
	});

	it("lowercases every address", () => {
		// Downstream routing compares against lowercased mailbox ids and the
		// allow-list, so a mixed-case address here would fail to match.
		const result = resolveInboundRecipients({
			envelopeTo: "HR@Tapetide.COM",
			headerTo: ["Team@Tapetide.com"],
		});
		expect(result).toEqual(["hr@tapetide.com", "team@tapetide.com"]);
	});

	it("trims surrounding whitespace", () => {
		expect(
			resolveInboundRecipients({ envelopeTo: "  tech@tapetide.com  ", headerTo: [] }),
		).toEqual(["tech@tapetide.com"]);
	});

	it("falls back to the header when there is no envelope recipient", () => {
		// The event shape does not guarantee `to` either; header-only must work.
		expect(
			resolveInboundRecipients({
				envelopeTo: undefined,
				headerTo: ["devops@tapetide.com"],
			}),
		).toEqual(["devops@tapetide.com"]);
	});

	it("ignores blank and whitespace-only addresses", () => {
		expect(
			resolveInboundRecipients({
				envelopeTo: "   ",
				headerTo: ["", "  ", "govind@tapetide.com"],
			}),
		).toEqual(["govind@tapetide.com"]);
	});

	it("returns empty when there is genuinely no recipient", () => {
		// The caller turns this into a throw, which is correct: with no address at
		// all there is no mailbox to file the message in. The point of the fix is
		// that this is now rare rather than routine.
		expect(resolveInboundRecipients({})).toEqual([]);
		expect(
			resolveInboundRecipients({ envelopeTo: null, headerTo: [undefined] }),
		).toEqual([]);
	});

	it("preserves header order after the envelope address", () => {
		// Routing picks the first recipient on a served domain, so order is
		// load-bearing rather than cosmetic.
		expect(
			resolveInboundRecipients({
				envelopeTo: "a@tapetide.com",
				headerTo: ["b@tapetide.com", "c@tapetide.com"],
			}),
		).toEqual(["a@tapetide.com", "b@tapetide.com", "c@tapetide.com"]);
	});
});
