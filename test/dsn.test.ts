// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Delivery-status notification handling.
 *
 * The header shapes here are copied from what Postfix, Exim and Gmail actually
 * send, because the cost of getting detection wrong runs both ways: a missed
 * bounce leaves a sent message looking delivered forever, and a false positive
 * rewrites the delivery state of mail that is fine. The vacation-auto-reply case
 * is the one that matters most — it sets the same `Auto-Submitted` header a
 * bounce does, and treating it as a bounce would mark a perfectly delivered
 * message as failed every time a correspondent went on holiday.
 */

import { describe, expect, it } from "vitest";
import PostalMime from "postal-mime";
import {
	describeDsnFailure,
	extractOriginalMessageId,
	isDeliveryStatusNotification,
	parseDsn,
} from "../shared/dsn";

describe("isDeliveryStatusNotification", () => {
	it("detects the Postfix multipart/report shape", () => {
		expect(
			isDeliveryStatusNotification({
				headers: {
					"content-type":
						'multipart/report; report-type=delivery-status; boundary="ABC123"',
					"auto-submitted": "auto-replied",
					subject: "Undelivered Mail Returned to Sender",
				},
				sender: "mailer-daemon@mx.example.com",
			}),
		).toBe(true);
	});

	it("detects a quoted report-type parameter", () => {
		// Exim brackets the parameter value; an unquoted-only substring test misses it.
		expect(
			isDeliveryStatusNotification({
				headers: {
					"content-type":
						'multipart/report; report-type="delivery-status"; boundary=xyz',
				},
				sender: "mailer-daemon@relay.example.net",
			}),
		).toBe(true);
	});

	it("detects the Gmail shape regardless of header case", () => {
		// Callers key the map from whatever the parser gave them, so a
		// canonically-cased header must resolve the same as a lowercased one.
		expect(
			isDeliveryStatusNotification({
				headers: {
					"Content-Type":
						"multipart/report; boundary=00000000; report-type=delivery-status",
					From: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
				},
				sender: "mailer-daemon@googlemail.com",
			}),
		).toBe(true);
	});

	it("detects a message/delivery-status part when parts are enumerable", () => {
		// Definitive on its own: no other kind of mail carries this part.
		expect(
			isDeliveryStatusNotification({
				headers: { "content-type": "multipart/mixed; boundary=zz" },
				contentTypes: ["text/plain", "message/delivery-status"],
				sender: "postmaster@example.org",
			}),
		).toBe(true);
	});

	it("detects a plain-text bounce via Auto-Submitted plus a daemon sender", () => {
		// Older and misconfigured MTAs skip the structured format entirely. This is
		// the only signal such a bounce carries.
		expect(
			isDeliveryStatusNotification({
				headers: {
					"content-type": "text/plain; charset=us-ascii",
					"auto-submitted": "auto-generated",
				},
				sender: "MAILER-DAEMON@legacy.example.com",
			}),
		).toBe(true);
	});

	it("accepts an Auto-Submitted value carrying parameters", () => {
		expect(
			isDeliveryStatusNotification({
				headers: { "auto-submitted": "auto-generated; type=failure" },
				sender: "postmaster@example.com",
			}),
		).toBe(true);
	});

	it("treats a null envelope sender as a daemon sender", () => {
		// RFC 3464 §4.1 requires notifications to use a null reverse-path, and some
		// systems leave the From: header looking human while doing so.
		expect(
			isDeliveryStatusNotification({
				headers: { "auto-submitted": "auto-replied" },
				sender: "delivery-report@example.com",
				envelopeSender: "",
			}),
		).toBe(true);
	});

	it("is false for ordinary mail", () => {
		expect(
			isDeliveryStatusNotification({
				headers: {
					"content-type": 'multipart/alternative; boundary="000abc"',
					subject: "Lunch on Thursday?",
				},
				sender: "ada@example.com",
			}),
		).toBe(false);
	});

	it("is false for a vacation auto-reply", () => {
		// The header is identical to a bounce's; only the sender separates them. A
		// false positive here would mark delivered mail as failed.
		expect(
			isDeliveryStatusNotification({
				headers: {
					"content-type": "text/plain; charset=utf-8",
					"auto-submitted": "auto-replied",
					subject: "Out of office: Re: Lunch on Thursday?",
					precedence: "bulk",
				},
				sender: "ada@example.com",
			}),
		).toBe(false);
	});

	it("is false for a daemon sender with no auto-submitted marker", () => {
		// Mailing-list and monitoring mail legitimately comes from no-reply
		// addresses. Being from a robot is not being a bounce.
		expect(
			isDeliveryStatusNotification({
				headers: {
					"content-type": "text/html; charset=utf-8",
					subject: "Your weekly digest",
				},
				sender: "no-reply@newsletter.example.com",
			}),
		).toBe(false);
	});

	it("is false for multipart/report that is not a delivery status", () => {
		// `multipart/report` also carries DMARC aggregate reports and MDNs, which
		// say nothing about whether a message was delivered.
		expect(
			isDeliveryStatusNotification({
				headers: {
					"content-type": 'multipart/report; report-type=disposition-notification',
				},
				sender: "ada@example.com",
			}),
		).toBe(false);
	});

	it("is false for an empty header set", () => {
		expect(
			isDeliveryStatusNotification({ headers: {}, sender: "" }),
		).toBe(false);
	});
});

describe("parseDsn", () => {
	it("reads a permanent Postfix failure", () => {
		const report = parseDsn(
			[
				"Reporting-MTA: dns; mx.example.com",
				"X-Postfix-Queue-ID: 4A1B2C3D",
				"Arrival-Date: Tue, 18 Aug 2026 09:14:02 +0000",
				"",
				"Final-Recipient: rfc822; nobody@example.org",
				"Original-Recipient: rfc822;nobody@example.org",
				"Action: failed",
				"Status: 5.1.1",
				"Diagnostic-Code: smtp; 550 5.1.1 <nobody@example.org>: Recipient address rejected: User unknown in local recipient table",
			].join("\n"),
		);

		expect(report.action).toBe("failed");
		expect(report.status).toBe("5.1.1");
		expect(report.recipient).toBe("nobody@example.org");
		expect(report.diagnosticCode).toContain("User unknown");
		// No `smtp;` prefix survives — it is never worth showing.
		expect(report.diagnosticCode?.startsWith("smtp")).toBe(false);
		expect(report.permanent).toBe(true);
	});

	it("does not treat a transient 4.x.x delay as permanent", () => {
		// The message may still arrive; marking it bounced is a claim the user
		// cannot undo.
		const report = parseDsn(
			[
				"Final-Recipient: rfc822; busy@example.org",
				"Action: delayed",
				"Status: 4.4.1",
				"Diagnostic-Code: smtp; 451 4.4.1 Connection timed out",
			].join("\n"),
		);

		expect(report.action).toBe("delayed");
		expect(report.status).toBe("4.4.1");
		expect(report.permanent).toBe(false);
	});

	it("lets a transient status overrule an Action of failed", () => {
		// A report that says both is malformed, and 4.x.x is the more specific
		// claim. Retryable must win, because the irreversible reading is the wrong
		// one to guess.
		const report = parseDsn(
			["Action: failed", "Status: 4.2.2 Mailbox full"].join("\n"),
		);
		expect(report.permanent).toBe(false);
	});

	it("treats Action: failed with no status as permanent", () => {
		// RFC 3464 §2.3.3 defines "failed" as permanent; the status code refines it
		// rather than being its source.
		const report = parseDsn(
			["Final-Recipient: rfc822; nobody@example.org", "Action: failed"].join("\n"),
		);
		expect(report.status).toBeNull();
		expect(report.permanent).toBe(true);
	});

	it("reports the failing recipient when another succeeded", () => {
		// A notification about several recipients has a block each. The whole reason
		// the report was sent is the one that failed.
		const report = parseDsn(
			[
				"Reporting-MTA: dns; mx.example.com",
				"",
				"Final-Recipient: rfc822; ok@example.org",
				"Action: delivered",
				"Status: 2.0.0",
				"",
				"Final-Recipient: rfc822; gone@example.org",
				"Action: failed",
				"Status: 5.2.1",
				"Diagnostic-Code: smtp; 550 mailbox disabled",
			].join("\n"),
		);

		expect(report.recipient).toBe("gone@example.org");
		expect(report.status).toBe("5.2.1");
		expect(report.permanent).toBe(true);
	});

	it("joins a folded Diagnostic-Code onto one value", () => {
		// Long diagnostics are routinely wrapped; a line-based reader truncates them
		// at the fold and loses the part that says what went wrong.
		const report = parseDsn(
			[
				"Final-Recipient: rfc822; nobody@example.org",
				"Action: failed",
				"Status: 5.7.1",
				"Diagnostic-Code: smtp; 550 5.7.1 Message rejected due to policy:",
				"\tsender domain does not pass DMARC",
			].join("\n"),
		);

		expect(report.diagnosticCode).toContain("policy: sender domain");
		expect(report.permanent).toBe(true);
	});

	it("parses CRLF input the same as LF", () => {
		const report = parseDsn(
			"Final-Recipient: rfc822; nobody@example.org\r\nAction: failed\r\nStatus: 5.1.1\r\n",
		);
		expect(report.status).toBe("5.1.1");
		expect(report.permanent).toBe(true);
	});

	it("extracts a bare status code from a value carrying trailing text", () => {
		const report = parseDsn("Action: failed\nStatus: 5.1.1 (bad destination mailbox)");
		expect(report.status).toBe("5.1.1");
	});

	it("drops an unparseable status rather than guessing", () => {
		// The first character of this value decides whether a message is marked
		// permanently bounced. A guess is not good enough.
		const report = parseDsn(
			["Final-Recipient: rfc822; nobody@example.org", "Status: unknown"].join("\n"),
		);
		expect(report.status).toBeNull();
	});

	it("returns empty fields for text carrying no report", () => {
		const report = parseDsn("Hi, are we still on for Thursday?");
		expect(report).toEqual({
			action: null,
			status: null,
			diagnosticCode: null,
			recipient: null,
			permanent: false,
		});
	});

	it("returns empty fields for an empty body", () => {
		expect(parseDsn("").permanent).toBe(false);
	});

	it("prefers Original-Recipient over Final-Recipient", () => {
		// Original-Recipient is the address the sender used; Final-Recipient may be
		// the alias it expanded to, which the user will not recognise.
		const report = parseDsn(
			[
				"Original-Recipient: rfc822; sales@example.org",
				"Final-Recipient: rfc822; sales-inbox-7@internal.example.org",
				"Action: failed",
				"Status: 5.1.1",
			].join("\n"),
		);
		expect(report.recipient).toBe("sales@example.org");
	});
});

describe("extractOriginalMessageId", () => {
	it("strips the angle brackets", () => {
		const id = extractOriginalMessageId(
			[
				"Content-Type: text/rfc822-headers",
				"",
				"From: ada@example.com",
				"To: nobody@example.org",
				"Message-ID: <abc123@example.com>",
				"Subject: Invoice",
			].join("\n"),
		);
		expect(id).toBe("abc123@example.com");
	});

	it("returns the original's id, not the notification's own", () => {
		// The bounce has a Message-ID of its own and it comes first. Correlating on
		// that would look up a message the mailbox has never seen.
		const id = extractOriginalMessageId(
			[
				"Message-ID: <bounce-9f8e@mx.example.com>",
				"Content-Type: multipart/report; report-type=delivery-status",
				"",
				"Final-Recipient: rfc822; nobody@example.org",
				"Action: failed",
				"",
				"From: ada@example.com",
				"Message-ID: <original-42@example.com>",
			].join("\n"),
		);
		expect(id).toBe("original-42@example.com");
	});

	it("reads a folded Message-ID header", () => {
		const id = extractOriginalMessageId(
			"Message-ID:\n <folded-id@example.com>\nSubject: Hi",
		);
		expect(id).toBe("folded-id@example.com");
	});

	it("accepts an unbracketed value", () => {
		expect(extractOriginalMessageId("Message-Id: bare-id@example.com")).toBe(
			"bare-id@example.com",
		);
	});

	it("matches the header case-insensitively", () => {
		expect(extractOriginalMessageId("message-id: <x@y.example>")).toBe(
			"x@y.example",
		);
	});

	it("returns null when absent", () => {
		expect(
			extractOriginalMessageId("Action: failed\nStatus: 5.1.1"),
		).toBeNull();
	});

	it("returns null for empty text", () => {
		expect(extractOriginalMessageId("")).toBeNull();
	});
});

describe("describeDsnFailure", () => {
	it("prefers the remote server's own diagnostic", () => {
		const text = describeDsnFailure({
			action: "failed",
			status: "5.1.1",
			diagnosticCode: "550 5.1.1 User unknown",
			recipient: "nobody@example.org",
			permanent: true,
		});
		expect(text).toBe("nobody@example.org: 550 5.1.1 User unknown");
	});

	it("falls back to the status code when there is no diagnostic", () => {
		const text = describeDsnFailure({
			action: "failed",
			status: "5.2.2",
			diagnosticCode: null,
			recipient: null,
			permanent: true,
		});
		expect(text).toBe("Status 5.2.2");
	});

	it("does not repeat a recipient the diagnostic already names", () => {
		const text = describeDsnFailure({
			action: "failed",
			status: "5.1.1",
			diagnosticCode: "550 <nobody@example.org>: Recipient rejected",
			recipient: "nobody@example.org",
			permanent: true,
		});
		expect(text).toBe("550 <nobody@example.org>: Recipient rejected");
	});

	it("still says something for a report stripped of every field", () => {
		const text = describeDsnFailure({
			action: null,
			status: null,
			diagnosticCode: null,
			recipient: null,
			permanent: false,
		});
		expect(text).toBe("The receiving server rejected this message.");
	});

	it("truncates a diagnostic that runs long", () => {
		// A Diagnostic-Code is a remote server's free-form reply and can run to
		// kilobytes; the column is rendered in a banner.
		const text = describeDsnFailure({
			action: "failed",
			status: "5.7.1",
			diagnosticCode: "x".repeat(900),
			recipient: null,
			permanent: true,
		});
		expect(text.length).toBe(500);
	});
});

/**
 * The adaptation `receiveEmail` performs, against real postal-mime output.
 *
 * Everything above tests the pure functions on hand-built inputs. This is the
 * seam where that could still be wrong in production: the header map is built
 * from `parsedEmail.headers`, and the part list from `parsedEmail.attachments`
 * (postal-mime files a `message/delivery-status` part there rather than as body
 * text). Both are assumptions about a library's output, so they are checked
 * against a parse of a real bounce rather than asserted in a comment.
 */
describe("receiveEmail's DSN adaptation, on parsed messages", () => {
	/** A Postfix bounce, verbatim down to the CRLF line endings. */
	const BOUNCE = [
		"From: MAILER-DAEMON@mx.example.com (Mail Delivery System)",
		"To: ada@example.com",
		"Subject: Undelivered Mail Returned to Sender",
		"Date: Tue, 18 Aug 2026 09:14:02 +0000",
		"Message-ID: <bounce-9f8e@mx.example.com>",
		"Auto-Submitted: auto-replied",
		"MIME-Version: 1.0",
		'Content-Type: multipart/report; report-type=delivery-status; boundary="XYZ"',
		"",
		"--XYZ",
		"Content-Type: text/plain; charset=us-ascii",
		"",
		"This is the mail system at host mx.example.com.",
		"I'm sorry to have to inform you that your message could not be delivered.",
		"",
		"--XYZ",
		"Content-Type: message/delivery-status",
		"",
		"Reporting-MTA: dns; mx.example.com",
		"X-Postfix-Queue-ID: 4A1B2C3D",
		"",
		"Final-Recipient: rfc822; nobody@example.org",
		"Original-Recipient: rfc822;nobody@example.org",
		"Action: failed",
		"Status: 5.1.1",
		"Diagnostic-Code: smtp; 550 5.1.1 <nobody@example.org>: Recipient address rejected: User unknown",
		"",
		"--XYZ",
		"Content-Type: message/rfc822",
		"",
		"From: ada@example.com",
		"To: nobody@example.org",
		"Subject: Invoice",
		"Message-ID: <original-42@example.com>",
		"",
		"Please find attached.",
		"",
		"--XYZ--",
		"",
	].join("\r\n");

	const VACATION = [
		"From: Ada Lovelace <ada@example.com>",
		"To: bob@example.net",
		"Subject: Out of office: Re: Lunch",
		"Auto-Submitted: auto-replied",
		"Precedence: bulk",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"I am away until Monday.",
		"",
	].join("\r\n");

	/** Mirrors the inbound handler's adaptation exactly. */
	async function detect(raw: string, envelopeFrom: string | null) {
		const parsed = await new PostalMime().parse(new TextEncoder().encode(raw));
		const headers: Record<string, string | undefined> = {};
		for (const h of parsed.headers ?? []) {
			if (h.key) headers[h.key.toLowerCase()] = h.value;
		}
		const isDsn = isDeliveryStatusNotification({
			headers,
			contentTypes: (parsed.attachments ?? []).map((att) => att.mimeType ?? ""),
			sender: (parsed.from?.address || "").toLowerCase(),
			envelopeSender: envelopeFrom,
		});
		return { isDsn, parsed };
	}

	it("recognises a real bounce and correlates it to the original message", async () => {
		// Envelope sender is null per RFC 3464 §4.1, which is what Cloudflare hands
		// the handler as `event.from`.
		const { isDsn } = await detect(BOUNCE, "");
		expect(isDsn).toBe(true);

		const report = parseDsn(BOUNCE);
		expect(report.permanent).toBe(true);
		expect(report.status).toBe("5.1.1");
		// The original's id, not the notification's own — the join key that makes
		// the whole feature work.
		expect(extractOriginalMessageId(BOUNCE)).toBe("original-42@example.com");
		expect(describeDsnFailure(report)).toContain("User unknown");
	});

	it("does not treat a parsed vacation auto-reply as a bounce", async () => {
		const { isDsn } = await detect(VACATION, "ada@example.com");
		expect(isDsn).toBe(false);
	});

	it("leaves the bounce readable as ordinary mail", async () => {
		// The notification is stored and delivered, never swallowed: the remote
		// server's own words are the only thing that says what to do next.
		const { parsed } = await detect(BOUNCE, "");
		expect(parsed.html || parsed.text || "").toContain("could not be delivered");
	});
});
