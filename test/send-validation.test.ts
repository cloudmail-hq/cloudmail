// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Pre-send validation, error mapping and the References budget.
 *
 * Every limit below is one Cloudflare Email Service enforces by rejecting the
 * WHOLE message. The HTTP routes answer 202 before the provider is called, so
 * without these checks a message the provider was always going to refuse was
 * shown as sent and then flipped to failed.
 */

import { describe, expect, it, vi } from "vitest";
import {
	MAX_ATTACHMENTS,
	MAX_RECIPIENTS,
	SendValidationError,
	countAddresses,
	validateOutgoingMessage,
} from "../shared/send-validation";
import {
	describeSendError,
	friendlySendError,
	isDeliveryProblem,
	isTransientSendError,
	sendErrorCode,
} from "../shared/send-errors";
import { UnsendableHeaderError } from "../shared/email-headers";
import { buildOutgoingHeaders, fitReferences, sendRejection } from "../workers/lib/email-helpers";
import { sendEmail } from "../workers/email-sender";
import { clearanceForTest } from "../workers/lib/pre-send";

const addrs = (n: number) => Array.from({ length: n }, (_, i) => `r${i}@example.com`);
const att = (n: number, size = 10) =>
	Array.from({ length: n }, (_, i) => ({
		content: "A".repeat(size),
		filename: `f${i}.txt`,
		type: "text/plain",
		disposition: "attachment" as const,
	}));

function codeOf(fn: () => void): string | null {
	try {
		fn();
		return null;
	} catch (e) {
		return (e as { code?: string }).code ?? "no-code";
	}
}

describe("validateOutgoingMessage", () => {
	it("allows exactly 50 recipients across to/cc/bcc, refuses 51", () => {
		expect(
			codeOf(() =>
				validateOutgoingMessage({ to: addrs(30), cc: addrs(10), bcc: addrs(10), html: "x" }),
			),
		).toBeNull();
		expect(
			codeOf(() =>
				validateOutgoingMessage({ to: addrs(30), cc: addrs(10), bcc: addrs(11), html: "x" }),
			),
		).toBe("E_TOO_MANY_RECIPIENTS");
	});

	it("counts comma-separated strings the way the stored rows hold them", () => {
		expect(countAddresses("a@x.co, b@x.co ,, c@x.co")).toBe(3);
		expect(countAddresses(undefined)).toBe(0);
		expect(
			codeOf(() => validateOutgoingMessage({ to: addrs(MAX_RECIPIENTS + 1).join(", "), html: "x" })),
		).toBe("E_TOO_MANY_RECIPIENTS");
	});

	it("allows 32 attachments, refuses 33", () => {
		expect(
			codeOf(() => validateOutgoingMessage({ to: "a@x.co", html: "x", attachments: att(MAX_ATTACHMENTS) })),
		).toBeNull();
		expect(
			codeOf(() =>
				validateOutgoingMessage({ to: "a@x.co", html: "x", attachments: att(MAX_ATTACHMENTS + 1) }),
			),
		).toBe("E_TOO_MANY_ATTACHMENTS");
	});

	it("refuses a message over 5 MiB including attachments", () => {
		expect(
			codeOf(() =>
				validateOutgoingMessage({ to: "a@x.co", html: "x", attachments: att(1, 6 * 1024 * 1024) }),
			),
		).toBe("E_CONTENT_TOO_LARGE");
	});

	it("enforces the header allowlist with the provider's codes", () => {
		const check = (headers: Record<string, string>) =>
			codeOf(() => validateOutgoingMessage({ to: "a@x.co", html: "x", headers }));
		expect(check({ "In-Reply-To": "<a@b>", "X-Custom": "1", "List-Unsubscribe": "<https://u>" })).toBeNull();
		expect(check({ "Message-ID": "<a@b>" })).toBe("E_HEADER_NOT_ALLOWED");
		expect(check({ Sender: "a@b" })).toBe("E_HEADER_NOT_ALLOWED");
		expect(check({ Subject: "hi" })).toBe("E_HEADER_USE_API_FIELD");
		expect(check({ "X-Bad Name": "1" })).toBe("E_HEADER_NAME_INVALID");
		expect(check({ "X-Inject": "a\r\nBcc: victim@x.co" })).toBe("E_HEADER_VALUE_INVALID");
		expect(check({ "X-Long": "a".repeat(2049) })).toBe("E_HEADER_VALUE_TOO_LONG");
		const many: Record<string, string> = {};
		const allow = [
			"In-Reply-To", "References", "List-Unsubscribe", "List-Unsubscribe-Post", "List-Id",
			"List-Archive", "List-Help", "List-Owner", "List-Post", "List-Subscribe", "Auto-Submitted",
			"Precedence", "Importance", "Sensitivity", "Comments", "Keywords", "Organization",
			"Content-Language", "Archived-At", "Require-Recipient-Valid-Since",
		];
		for (const h of allow) many[h] = "v";
		expect(check(many)).toBeNull(); // exactly 20
		// X- headers do not count toward the 20.
		expect(check({ ...many, "X-Extra": "v" })).toBeNull();
		const big: Record<string, string> = {};
		for (let i = 0; i < 10; i++) big[`X-H${i}`] = "a".repeat(2000);
		expect(check(big)).toBe("E_HEADERS_TOO_LARGE");
	});

	it("keeps refusing a disallowed name as UnsendableHeaderError, now with a code", () => {
		try {
			validateOutgoingMessage({ to: "a@x.co", html: "x", headers: { "Message-ID": "<x@y>" } });
			throw new Error("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(UnsendableHeaderError);
			expect((e as UnsendableHeaderError).code).toBe("E_HEADER_NOT_ALLOWED");
		}
	});
});

describe("sendRejection (route mapping)", () => {
	it("maps limits to 400 with the code, size to the existing 413", () => {
		expect(sendRejection({ to: addrs(51), html: "x" })).toEqual({
			status: 400,
			body: { error: expect.stringContaining("50"), code: "E_TOO_MANY_RECIPIENTS" },
		});
		expect(sendRejection({ to: "a@x.co", html: "x", attachments: att(33) })?.status).toBe(400);
		expect(
			sendRejection({ to: "a@x.co", html: "x", attachments: att(1, 6 * 1024 * 1024) })?.status,
		).toBe(413);
		expect(sendRejection({ to: "a@x.co", html: "x", headers: { Bcc: "x" } })).toEqual({
			status: 400,
			body: { error: expect.any(String), code: "E_HEADER_USE_API_FIELD" },
		});
		expect(sendRejection({ to: "a@x.co", html: "x" })).toBeNull();
	});
});

describe("sendEmail chokepoint", () => {
	it("never calls the binding for a message over the limits", async () => {
		const send = vi.fn().mockResolvedValue({ messageId: "x@y" });
		await expect(
			sendEmail({ send } as unknown as SendEmail, {
				to: addrs(51),
				from: "a@tapetide.com",
				subject: "s",
				html: "x",
			}, clearanceForTest()),
		).rejects.toBeInstanceOf(SendValidationError);
		expect(send).not.toHaveBeenCalled();
	});
});

describe("fitReferences", () => {
	const id = (i: number) => `${"m".repeat(40)}${i}@mail.gmail.com`;

	it("passes a short chain through unchanged", () => {
		expect(fitReferences(["a@b", "c@d"])).toBe("<a@b> <c@d>");
	});

	it("keeps the root and the nearest ancestors under 2,048 bytes", () => {
		const chain = Array.from({ length: 80 }, (_, i) => id(i));
		const out = fitReferences(chain);
		expect(new TextEncoder().encode(out).byteLength).toBeLessThanOrEqual(2048);
		const ids = out.split(" ");
		expect(ids[0]).toBe(`<${id(0)}>`);
		expect(ids[ids.length - 1]).toBe(`<${id(79)}>`);
		expect(ids[ids.length - 2]).toBe(`<${id(78)}>`);
	});

	it("lets buildOutgoingHeaders reply deep into a long thread", () => {
		const chain = Array.from({ length: 80 }, (_, i) => id(i));
		const headers = buildOutgoingHeaders({ inReplyTo: id(79), references: chain });
		expect(() => validateOutgoingMessage({ to: "a@x.co", html: "x", headers })).not.toThrow();
		expect(headers["In-Reply-To"]).toBe(`<${id(79)}>`);
	});
});

describe("send error mapping", () => {
	const err = (code: string, message = "boom") => Object.assign(new Error(message), { code });

	it("maps every documented code to a sentence and keeps the code", () => {
		for (const code of [
			"E_VALIDATION_ERROR", "E_FIELD_MISSING", "E_TOO_MANY_RECIPIENTS", "E_TOO_MANY_ATTACHMENTS",
			"E_CONTENT_TOO_LARGE", "E_SENDER_NOT_VERIFIED", "E_SENDER_DOMAIN_NOT_AVAILABLE",
			"E_RECIPIENT_NOT_ALLOWED", "E_RECIPIENT_SUPPRESSED", "E_ACCOUNT_SUSPENDED",
			"E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED", "E_DELIVERY_FAILED",
			"E_INTERNAL_SERVER_ERROR", "E_HEADER_NOT_ALLOWED", "E_HEADER_USE_API_FIELD",
			"E_HEADER_VALUE_INVALID", "E_HEADER_VALUE_TOO_LONG", "E_HEADER_NAME_INVALID",
			"E_HEADERS_TOO_LARGE", "E_HEADERS_TOO_MANY",
		]) {
			expect(friendlySendError(code), code).toBeTruthy();
			expect(describeSendError(err(code))).toMatch(new RegExp(`\\(${code}\\)$`));
		}
	});

	it("says something actionable for the onboarding failure", () => {
		expect(describeSendError(err("E_SENDER_DOMAIN_NOT_AVAILABLE", "domain not onboarded"))).toBe(
			"This domain isn't set up for sending in Cloudflare Email Service. Onboard it in the Cloudflare dashboard. (E_SENDER_DOMAIN_NOT_AVAILABLE)",
		);
	});

	it("finds a code that only appears in the message", () => {
		expect(sendErrorCode(new Error("E_RATE_LIMIT_EXCEEDED: slow down"))).toBe("E_RATE_LIMIT_EXCEEDED");
		expect(isTransientSendError("E_RATE_LIMIT_EXCEEDED")).toBe(true);
		expect(isTransientSendError("E_RECIPIENT_SUPPRESSED")).toBe(false);
	});

	it("keeps the provider's words for an unknown code, and raw text with none", () => {
		expect(describeSendError(err("E_SOMETHING_NEW", "E_SOMETHING_NEW: new thing"))).toBe(
			"new thing (E_SOMETHING_NEW)",
		);
		expect(describeSendError(new Error("550 mailbox unavailable"))).toBe("550 mailbox unavailable");
		expect(describeSendError("plain string")).toBe("plain string");
	});

	it("flags only failed and bounced as problems", () => {
		expect(["queued", "sent", "delivered", null].map(isDeliveryProblem)).toEqual([
			false, false, false, false,
		]);
		expect(isDeliveryProblem("failed")).toBe(true);
		expect(isDeliveryProblem("bounced")).toBe(true);
	});
});
