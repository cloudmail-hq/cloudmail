// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Vacation auto-responder.
 *
 * Every test here is a way a naive responder creates a problem: answering a
 * mailing list, answering a bounce, answering another responder, or answering
 * another mailbox on this same deployment — the last of which is a loop that
 * never terminates.
 */

import { describe, expect, it } from "vitest";
import {
	autoReplySubject,
	decideAutoReply,
	type AutoReplyContext,
	type AutoReplySettings,
} from "../shared/auto-reply";

const settings: AutoReplySettings = {
	enabled: true,
	subject: "",
	message: "Away until Monday.",
};

function context(overrides: Partial<AutoReplyContext> = {}): AutoReplyContext {
	const headers: Record<string, string> = {
		subject: "Quick question",
		...((overrides as { headerValues?: Record<string, string> }).headerValues ??
			{}),
	};

	return {
		settings,
		mailboxId: "hello@example.com",
		sender: "alice@vendor.example",
		headerKeys: Object.keys(headers),
		header: (key) => headers[key.toLowerCase()],
		localMailboxes: ["hello@example.com", "support@example.com"],
		...overrides,
	};
}

/** Build a context whose headers include the given extras. */
function withHeaders(
	extra: Record<string, string>,
	overrides: Partial<AutoReplyContext> = {},
): AutoReplyContext {
	const headers: Record<string, string> = { subject: "Quick question", ...extra };
	return context({
		headerKeys: Object.keys(headers),
		header: (key) => headers[key.toLowerCase()],
		...overrides,
	});
}

describe("decideAutoReply", () => {
	it("answers ordinary mail from a stranger", () => {
		const decision = decideAutoReply(context());
		expect(decision.skip).toBeUndefined();
		expect(decision.target).toBe("alice@vendor.example");
		expect(decision.subject).toBe("Automatic reply: Quick question");
	});

	it("stays quiet when disabled or unconfigured", () => {
		expect(decideAutoReply(context({ settings: undefined })).skip).toBe(
			"disabled",
		);
		expect(
			decideAutoReply(context({ settings: { ...settings, enabled: false } })).skip,
		).toBe("disabled");
		expect(
			decideAutoReply(context({ settings: { ...settings, message: "  " } })).skip,
		).toBe("no_message");
	});

	it("honours the away window", () => {
		const dated = {
			...settings,
			startsAt: "2026-03-01T00:00:00.000Z",
			endsAt: "2026-03-08T00:00:00.000Z",
		};

		expect(
			decideAutoReply(
				context({ settings: dated, now: new Date("2026-02-28T12:00:00Z") }),
			).skip,
		).toBe("outside_window");
		expect(
			decideAutoReply(
				context({ settings: dated, now: new Date("2026-03-09T12:00:00Z") }),
			).skip,
		).toBe("outside_window");
		expect(
			decideAutoReply(
				context({ settings: dated, now: new Date("2026-03-04T12:00:00Z") }),
			).skip,
		).toBeUndefined();
	});

	it("never answers itself or another mailbox on this deployment", () => {
		expect(decideAutoReply(context({ sender: "hello@example.com" })).skip).toBe(
			"self",
		);
		expect(
			decideAutoReply(context({ sender: "Support@Example.com" })).skip,
		).toBe("local_mailbox");
	});

	it("never answers a machine", () => {
		expect(
			decideAutoReply(withHeaders({ "auto-submitted": "auto-generated" })).skip,
		).toBe("automated");
		expect(decideAutoReply(withHeaders({ "x-autoreply": "yes" })).skip).toBe(
			"automated",
		);
		// `auto-submitted: no` explicitly means "a person sent this".
		expect(
			decideAutoReply(withHeaders({ "auto-submitted": "no" })).skip,
		).toBeUndefined();
	});

	it("never answers bulk mail or a mailing list", () => {
		expect(decideAutoReply(withHeaders({ precedence: "bulk" })).skip).toBe(
			"bulk",
		);
		expect(
			decideAutoReply(withHeaders({ "list-id": "<dev.example.com>" })).skip,
		).toBe("mailing_list");
		expect(
			decideAutoReply(withHeaders({ "list-unsubscribe": "<https://x/y>" })).skip,
		).toBe("mailing_list");
	});

	it("never answers a bounce", () => {
		expect(decideAutoReply(withHeaders({ "return-path": "<>" })).skip).toBe(
			"no_reply_address",
		);
	});

	it("prefers Reply-To when the sender nominated one", () => {
		const decision = decideAutoReply(
			withHeaders({ "reply-to": "Billing <billing@vendor.example>" }),
		);
		expect(decision.target).toBe("billing@vendor.example");
	});

	it("refuses when Reply-To points back at us", () => {
		expect(
			decideAutoReply(withHeaders({ "reply-to": "hello@example.com" })).skip,
		).toBe("no_reply_address");
	});
});

describe("autoReplySubject", () => {
	it("uses the configured subject when set", () => {
		expect(autoReplySubject("Out of office", "Quick question")).toBe(
			"Out of office",
		);
	});

	it("prefixes the inbound subject otherwise", () => {
		expect(autoReplySubject("", "Quick question")).toBe(
			"Automatic reply: Quick question",
		);
	});

	it("does not stack prefixes on an already-answered thread", () => {
		expect(autoReplySubject("", "Re: Quick question")).toBe("Re: Quick question");
		expect(autoReplySubject("", "Automatic reply: Quick question")).toBe(
			"Automatic reply: Quick question",
		);
	});

	it("falls back to a generic subject for subjectless mail", () => {
		expect(autoReplySubject("", "")).toBe("Automatic reply");
		expect(autoReplySubject(undefined, undefined)).toBe("Automatic reply");
	});
});
