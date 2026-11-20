// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The agent must not draft replies to robots: bounces, newsletters, alerts and
 * noreply senders. Every case here is mail that previously got a draft.
 */

import { describe, expect, it } from "vitest";
import { autoDraftSkipReason } from "../shared/auto-draft";

const human = {
	headers: {
		subject: "Can you help?",
		from: "Alice <alice@customer.example>",
	} as Record<string, string | undefined>,
	sender: "alice@customer.example",
	folder: "inbox",
};

function withHeaders(extra: Record<string, string>) {
	return { ...human, headers: { ...human.headers, ...extra } };
}

describe("autoDraftSkipReason", () => {
	it("drafts for ordinary human mail", () => {
		expect(autoDraftSkipReason(human)).toBeNull();
	});

	it("drafts for Outlook mail carrying X-Auto-Response-Suppress", () => {
		// Outlook sets it on ordinary messages; it is not a robot marker.
		expect(
			autoDraftSkipReason(withHeaders({ "x-auto-response-suppress": "All" })),
		).toBeNull();
	});

	it("treats Auto-Submitted: no as human", () => {
		expect(autoDraftSkipReason(withHeaders({ "auto-submitted": "no" }))).toBeNull();
	});

	it.each(["auto-generated", "auto-replied", "auto-notified; owner=x"])(
		"skips Auto-Submitted: %s",
		(value) => {
			expect(autoDraftSkipReason(withHeaders({ "auto-submitted": value }))).toBe(
				"automated",
			);
		},
	);

	it.each(["bulk", "list", "junk", "Bulk"])("skips Precedence: %s", (precedence) => {
		expect(autoDraftSkipReason(withHeaders({ precedence }))).toBe("bulk");
	});

	it.each(["list-id", "list-unsubscribe", "List-Unsubscribe"])(
		"skips mailing-list mail (%s)",
		(key) => {
			expect(
				autoDraftSkipReason(withHeaders({ [key]: "<https://x.example/u>" })),
			).toBe("mailing_list");
		},
	);

	it.each([
		"noreply@service.example",
		"no-reply@service.example",
		"no_reply@service.example",
		"donotreply@service.example",
		"do-not-reply@service.example",
		"mailer-daemon@mx.example",
		"postmaster@mx.example",
		"noreply+alerts@service.example",
		"NoReply@Service.example",
	])("skips no-reply sender %s", (sender) => {
		expect(autoDraftSkipReason({ ...human, sender })).toBe("no_reply_sender");
	});

	it("does not skip a person whose address merely contains 'reply'", () => {
		expect(autoDraftSkipReason({ ...human, sender: "replyguy@x.example" })).toBeNull();
	});

	it("skips delivery status notifications by content type", () => {
		expect(
			autoDraftSkipReason({
				...human,
				headers: {
					"content-type":
						"multipart/report; report-type=delivery-status; boundary=x",
				},
			}),
		).toBe("dsn");
	});

	it("skips delivery status notifications by part type", () => {
		expect(
			autoDraftSkipReason({
				...human,
				headers: {},
				contentTypes: ["message/delivery-status"],
			}),
		).toBe("dsn");
	});

	it("skips mail filed to spam", () => {
		expect(autoDraftSkipReason({ ...human, folder: "spam" })).toBe("spam");
	});
});
