// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * What inbound mail means for sending compliance.
 *
 * Called from `receiveEmail` after the message is durably stored, so nothing
 * here can cost us received mail. Three signals:
 *
 *   1. A permanent, address-level bounce (5.1.x, 5.2.1) for a message this
 *      mailbox really sent: global `hard_bounce` suppression, sequences stopped.
 *      Requiring the DSN to match one of our Sent rows (`matchedSentRow`) is what
 *      stops a forged bounce from suppressing an arbitrary address.
 *   2. A reply to our `mailto:` List-Unsubscribe (subject exactly
 *      "unsubscribe"): `unsubscribed` for the mailbox's sending domain, but
 *      only when our MX authenticated the From domain (DMARC pass, or SPF/DKIM
 *      pass aligned with From). Otherwise anyone could put a third party's
 *      address in From and suppress them.
 *   3. Any other human reply from someone enrolled in a sequence sent from this
 *      mailbox: stop-on-reply cancels the enrollment.
 */

import {
	isAddressLevelBounce,
	isMailtoUnsubscribeRequest,
	normalizeSuppressionAddress,
	sendingDomainOf,
} from "../../shared/suppressions";
import { isComplaintFeedback, isFeedbackReport, parseFeedbackReport } from "../../shared/feedback-report";
import {
	cancelEnrollmentsFor,
	handleComplaint,
	handleHardBounce,
	isAutomatedInbound,
	recordSuppression,
	stopSequencesOnReply,
	suppressionStore,
} from "./suppressions";
import type { Env } from "../types";

export interface InboundComplianceInput {
	mailboxId: string;
	sender: string;
	subject: string | null | undefined;
	header: (name: string) => string | undefined;
	/**
	 * `undefined` when the message is not a DSN; `null` for a DSN that reported
	 * no permanent failure; the details for a permanent one.
	 */
	bounce?: {
		status: string | null;
		recipient: string | null;
		/** Whether the DSN named a message this mailbox sent to that recipient. */
		matchedSentRow: boolean;
	} | null;
	/**
	 * Whether the From domain is authenticated by our own MX. Absent is false:
	 * an unsubscribe is only honoured from a sender we can show is real.
	 */
	senderAuthenticated?: boolean;
}

export type InboundComplianceOutcome =
	| "hard_bounce"
	| "unsubscribed"
	| "stopped_sequence"
	| "none";

/** The MailboxDO surface the feedback-loop handler needs. */
export interface ComplaintStub {
	recordComplaint(
		originalMessageId: string | null,
		reportedRecipient: string | null,
		detail: string | null,
	): Promise<{ emailId: string; recipient: string } | null>;
}

/**
 * Act on an inbound feedback-loop (ARF, RFC 5965) report.
 *
 * Three checks before anything is suppressed:
 *
 *   1. The report's sender is authenticated by our MX (DMARC pass, or SPF/DKIM
 *      aligned with From), so a stranger cannot forge one from a mailbox
 *      provider's domain.
 *   2. The original message it names was SENT by a mailbox on this deployment:
 *      the embedded original's `From:` picks the mailbox (so a report delivered
 *      to a central `abuse@` still matches), falling back to the receiving one,
 *      and that mailbox's DO matches the `Message-ID` against its Sent folder.
 *   3. The complainer is a recipient of that message (or, for a redacted
 *      report, its only recipient).
 *
 * So a forged report can at most suppress someone we really mailed, and only
 * once it has passed authentication. The report itself is stored like any
 * other message. Never throws.
 */
export async function onFeedbackReportForCompliance(
	env: Env,
	input: {
		mailboxId: string;
		headers: Record<string, string | undefined>;
		contentTypes: string[];
		raw: ArrayBuffer | Uint8Array | string;
		/** Whether our MX authenticated the report's From domain. Absent is false. */
		senderAuthenticated?: boolean;
		/** Resolve a mailbox's DO; null for an address that is not a mailbox here. */
		stubFor: (mailboxId: string) => Promise<ComplaintStub | null> | ComplaintStub | null;
	},
): Promise<"complaint" | "unmatched" | "not_a_complaint" | "unauthenticated" | "none"> {
	try {
		if (!isFeedbackReport({ headers: input.headers, contentTypes: input.contentTypes })) return "none";
		if (!input.senderAuthenticated) {
			console.log(`Ignoring feedback report for ${input.mailboxId}: sender is not authenticated.`);
			return "unauthenticated";
		}
		const text =
			typeof input.raw === "string" ? input.raw : new TextDecoder("utf-8", { fatal: false }).decode(input.raw);
		const report = parseFeedbackReport(text);
		if (!isComplaintFeedback(report)) return "not_a_complaint";

		const candidates = [...new Set([report.originalFrom, input.mailboxId.toLowerCase()].filter((m): m is string => !!m))];
		const detail = `Feedback-loop report (${report.feedbackType ?? "abuse"})${report.userAgent ? ` from ${report.userAgent}` : ""}`;
		for (const sender of candidates) {
			const stub = await input.stubFor(sender);
			if (!stub) continue;
			const matched = await stub.recordComplaint(report.originalMessageId, report.recipient, detail);
			if (!matched) continue;
			await handleComplaint(env, { address: matched.recipient, fromAddress: sender, source: `fbl:${sender}` });
			console.log(`Spam complaint for ${sender}: suppressed ${matched.recipient}.`);
			return "complaint";
		}
		console.log(
			`Feedback report to ${input.mailboxId} names <${report.originalMessageId ?? "unknown"}>, which no mailbox here sent to that recipient; stored only.`,
		);
		return "unmatched";
	} catch (e) {
		console.error(`Feedback report handling failed for ${input.mailboxId}:`, (e as Error).message);
		return "none";
	}
}

/** Never throws: failures are logged and reported as `"none"`. */
export async function onInboundForCompliance(
	env: Env,
	input: InboundComplianceInput,
): Promise<InboundComplianceOutcome> {
	try {
		// `null` is a DSN that was not an actionable failure; `undefined` is not a DSN.
		if (input.bounce !== undefined) {
			const address = normalizeSuppressionAddress(input.bounce?.recipient ?? "");
			if (address && input.bounce?.matchedSentRow && isAddressLevelBounce(input.bounce.status)) {
				await handleHardBounce(env, { address, source: `dsn:${input.mailboxId}` });
				return "hard_bounce";
			}
			// A DSN is never a reply, whatever else it is.
			return "none";
		}

		const sender = normalizeSuppressionAddress(input.sender);
		if (!sender) return "none";

		if (isMailtoUnsubscribeRequest(input.subject)) {
			if (!input.senderAuthenticated) {
				console.log(
					`Ignoring mailto unsubscribe for ${input.mailboxId}: sender ${sender} is not authenticated.`,
				);
				return "none";
			}
			const domain = sendingDomainOf(input.mailboxId);
			await recordSuppression(suppressionStore(env), {
				address: sender,
				scope: domain || "global",
				reason: "unsubscribed",
				source: `mailto:${input.mailboxId}`,
			});
			await cancelEnrollmentsFor(env.BUCKET, sender, { domain });
			return "unsubscribed";
		}

		const stopped = await stopSequencesOnReply(env, {
			mailboxId: input.mailboxId,
			sender,
			automated: isAutomatedInbound(input.header),
		});
		return stopped > 0 ? "stopped_sequence" : "none";
	} catch (e) {
		console.error(
			`Inbound compliance handling failed for ${input.mailboxId}:`,
			(e as Error).message,
		);
		return "none";
	}
}
