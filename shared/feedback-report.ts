// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Feedback-loop (ARF) reports: recognise one and read who complained.
 *
 * Mailbox providers with a complaint feedback loop (Yahoo CFL, Microsoft JMRP,
 * most ISPs) send a `multipart/report; report-type=feedback-report` message
 * (RFC 5965) when a recipient presses "This is spam". It carries:
 *
 *   1. a human-readable part;
 *   2. a `message/feedback-report` part with `Feedback-Type: abuse` and, when
 *      the provider does not redact it, `Original-Rcpt-To:`;
 *   3. the original message (or its headers) as `message/rfc822` or
 *      `text/rfc822-headers`.
 *
 * The complainer is `Original-Rcpt-To` (or `Removal-Recipient`) when present.
 * Many providers redact it, which is why the caller matches the original
 * `Message-ID` against its Sent rows and, for a single-recipient message,
 * takes the recipient from there. The original's `To:` is deliberately not
 * used: on a message with Cc it may name someone other than the complainer.
 *
 * Pure, so it is shared by the inbound handler and the tests.
 */

export interface FeedbackReport {
	/** `abuse`, `fraud`, `virus`, `not-spam`, ... lowercased; null when absent. */
	feedbackType: string | null;
	/** The complaining recipient, when the report names one. */
	recipient: string | null;
	/** `From:` of the embedded original: the mailbox that sent it. */
	originalFrom: string | null;
	/** `Message-ID` of the original message, without brackets. */
	originalMessageId: string | null;
	/** `User-Agent:` of the report generator, for the suppression source. */
	userAgent: string | null;
	/** `Source-IP` or `Reporting-MTA`, informational. */
	reportingMta: string | null;
}

type HeaderMap = Record<string, string | undefined>;

function header(headers: HeaderMap, name: string): string | undefined {
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name) return value;
	}
	return undefined;
}

/**
 * Whether an inbound message is an ARF report.
 *
 * Either the top-level `Content-Type` says so, or the parser surfaced a
 * `message/feedback-report` part (postal-mime files unknown parts as
 * attachments, so the caller passes their MIME types).
 */
export function isFeedbackReport(input: { headers: HeaderMap; contentTypes?: string[] }): boolean {
	const ct = (header(input.headers, "content-type") ?? "").toLowerCase().replace(/\s+/g, "");
	if (ct.includes("multipart/report") && /report-type="?feedback-report"?/.test(ct)) return true;
	return (input.contentTypes ?? []).some((t) => t.trim().toLowerCase().startsWith("message/feedback-report"));
}

function unfold(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]+/g, " ");
}

function bareAddress(value: string | null | undefined): string | null {
	if (!value) return null;
	const angled = value.match(/<([^>]+)>/);
	// RFC 5965 §3.2: `Original-Rcpt-To: rfc822;user@example.com` (RFC 3464 syntax).
	const bare = (angled ? angled[1] : value)
		.trim()
		.replace(/^rfc822\s*;\s*/i, "")
		.toLowerCase();
	// "redacted" and similar placeholders are not addresses.
	return /^[^\s@,;<>"]+@[^\s@,;<>".]+(?:\.[^\s@,;<>".]+)+$/.test(bare) ? bare : null;
}

/** First value of a `Name: value` field in a block of unfolded header text. */
function field(block: string, name: string): string | null {
	const re = new RegExp(`^${name}\\s*:\\s*(.+)$`, "im");
	const m = re.exec(block);
	return m ? m[1].trim() : null;
}

/**
 * Read an ARF report from the raw message text.
 *
 * Works on the raw source rather than parsed parts because the
 * `message/feedback-report` part and the embedded headers are not body text
 * to most MIME parsers. Field lookups are anchored to line starts, so a value
 * quoted in the human-readable part does not count.
 */
export function parseFeedbackReport(raw: string): FeedbackReport {
	const text = unfold(raw ?? "");

	// The feedback-report part: from its Content-Type to the next boundary.
	let reportBlock = "";
	const start = text.search(/^content-type:\s*message\/feedback-report/im);
	if (start !== -1) {
		const rest = text.slice(start);
		const end = rest.search(/\n--[^\n]+\n|\n--[^\n]+--/);
		reportBlock = end === -1 ? rest : rest.slice(0, end);
	}

	// The embedded original: after its rfc822 Content-Type.
	let originalBlock = "";
	const origStart = text.search(/^content-type:\s*(?:message\/rfc822|text\/rfc822-headers)/im);
	if (origStart !== -1) originalBlock = text.slice(origStart);

	const feedbackType = field(reportBlock, "feedback-type")?.toLowerCase() ?? null;
	// Only the report's own recipient fields. The embedded original's `To:` is
	// NOT a fallback: on a message with Cc/Bcc it names someone who may not be
	// the complainer. A redacted report is attributed by the caller only when
	// the original had a single recipient.
	const recipient =
		bareAddress(field(reportBlock, "original-rcpt-to")) ?? bareAddress(field(reportBlock, "removal-recipient"));
	// The original's `From:` names the sending mailbox, so a report delivered to
	// a central abuse@/fbl@ address can still be matched to the right Sent folder.
	const originalFrom = bareAddress(field(originalBlock.replace(/^content-type:[^\n]*\n/i, ""), "from"));

	const idRaw = field(originalBlock, "message-id") ?? field(reportBlock, "original-message-id");
	const idMatch = idRaw ? /<([^>]+)>/.exec(idRaw) : null;
	const originalMessageId = idRaw ? (idMatch ? idMatch[1] : idRaw.split(/\s+/)[0]).trim() || null : null;

	return {
		feedbackType,
		recipient,
		originalFrom,
		originalMessageId,
		userAgent: field(reportBlock, "user-agent"),
		reportingMta: field(reportBlock, "reporting-mta") ?? field(reportBlock, "source-ip"),
	};
}

/**
 * Whether a report is a spam complaint worth a suppression. `abuse` is the
 * standard value; a missing type is treated as abuse because some FBLs omit
 * it. `not-spam` and `virus` are not complaints about wanting the mail.
 */
export function isComplaintFeedback(report: Pick<FeedbackReport, "feedbackType">): boolean {
	const type = report.feedbackType;
	return type === null || type === "abuse" || type === "fraud" || type === "other";
}
