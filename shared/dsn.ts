// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Recognise and read delivery-status notifications (RFC 3464).
 *
 * When a message this app sent is rejected downstream, the receiving MTA mails
 * a bounce back to us. Nothing looked for them, so a bounce arrived in the inbox
 * as ordinary mail from "Mail Delivery Subsystem" and the sent message it
 * reports on went on looking delivered — the one case where the user most needs
 * to be told, and the only one the app said nothing about.
 *
 * Deliberately plain-data in and out: `isDeliveryStatusNotification` takes a
 * headers map and a sender string rather than a postal-mime object, and the
 * parsers take text. The inbound handler adapts its parse result to that shape.
 * Bounce formats are exactly the thing worth having a large table of test cases
 * for, and a signature tied to a MIME library makes each of those cases a
 * fixture-building exercise instead of two lines.
 *
 * Lives in `shared/` alongside `auto-reply.ts` and `forwarding.ts` because it is
 * the same kind of decision made from the same header set.
 */

/** `Action` values defined by RFC 3464 §2.3.3. */
export type DsnAction =
	| "failed"
	| "delayed"
	| "delivered"
	| "relayed"
	| "expanded";

export interface DsnReport {
	/** RFC 3464 `Action`, lowercased. Null when the field is absent. */
	action: DsnAction | null;
	/** RFC 3463 status code, e.g. "5.1.1". Null when absent or malformed. */
	status: string | null;
	/** The `Diagnostic-Code` value, minus its `smtp;` type prefix. */
	diagnosticCode: string | null;
	/** `Original-Recipient`, else `Final-Recipient`, minus its `rfc822;` prefix. */
	recipient: string | null;
	/**
	 * Whether this reports a permanent failure.
	 *
	 * True for a 5.x.x status, or for `Action: failed` with no usable status —
	 * "failed" is defined as permanent by RFC 3464 §2.3.3, which makes the status
	 * code a refinement rather than the source of truth. A 4.x.x status wins over
	 * the action, since a well-formed report saying "delayed, 4.4.1" must not be
	 * treated as final; the message may still arrive.
	 */
	permanent: boolean;
}

/**
 * Headers as a lookup, lowercased keys to lowercased-or-raw values.
 *
 * A map rather than an array because every check here is by name, and callers
 * hold the header list in several different shapes.
 */
export type HeaderMap = Record<string, string | undefined>;

export interface DsnDetectionInput {
	/** Header values keyed by lowercased header name. */
	headers: HeaderMap;
	/**
	 * Content types of the message's MIME parts, if enumerable. A
	 * `message/delivery-status` part is definitive on its own; postal-mime does
	 * not expose one, so this is usually empty and detection falls to the
	 * headers.
	 */
	contentTypes?: string[];
	/** The `From` address, bare and lowercased. Empty string when absent. */
	sender: string;
	/** The SMTP envelope sender, when the platform provides one. */
	envelopeSender?: string | null;
}

/**
 * Local parts that identify a message as machine-generated postmaster mail.
 *
 * `mailer-daemon` and `postmaster` are the two RFC-blessed ones (RFC 5321 §4.5.1
 * requires `postmaster`); the rest are what real MTAs and hosted platforms
 * actually use.
 */
const DAEMON_LOCAL_PARTS = new Set([
	"mailer-daemon",
	"mailerdaemon",
	"postmaster",
	"bounce",
	"bounces",
	"no-reply",
	"noreply",
]);

/** `Auto-Submitted` values that mean "not typed by a person" (RFC 3834 §5). */
const AUTO_SUBMITTED_MACHINE = new Set([
	"auto-replied",
	"auto-generated",
	"auto-notified",
]);

/**
 * Whether this inbound message is a delivery-status notification.
 *
 * Three independent tests, because no one of them catches every real bounce:
 *
 * 1. `Content-Type: multipart/report; report-type=delivery-status` — what RFC
 *    3462 requires, and what Postfix, Exim and Gmail all send.
 * 2. A `message/delivery-status` part, when the caller can enumerate parts.
 *    Equally definitive and cheaper to be sure about than parsing a parameter.
 * 3. `Auto-Submitted` marking it machine-generated *and* a null-ish or
 *    postmaster-ish sender. This is the fallback for the notifications that skip
 *    the structured format entirely — plain-text "Undelivered Mail Returned to
 *    Sender" from an older or misconfigured MTA.
 *
 * Test 3 needs both halves. `Auto-Submitted: auto-replied` alone is what a
 * vacation responder sets (RFC 3834 §5 tells it to), and a holiday notice is
 * ordinary mail that must not flip a sent message to bounced. Requiring the
 * sender to also be a daemon address is what separates them, and is why
 * `decideAutoReply`'s own bounce checks are not reused here: it is asking
 * whether to *respond*, so it errs towards silence, while this is asking whether
 * to *reinterpret stored mail* and must err towards leaving it alone.
 */
export function isDeliveryStatusNotification(
	input: DsnDetectionInput,
): boolean {
	const contentType = header(input.headers, "content-type");
	if (contentType) {
		const lowered = contentType.toLowerCase();
		if (
			lowered.includes("multipart/report") &&
			lowered.includes("report-type=delivery-status")
		) {
			return true;
		}
		// A report-type parameter can be quoted: `report-type="delivery-status"`.
		if (
			lowered.includes("multipart/report") &&
			/report-type\s*=\s*"?delivery-status"?/.test(lowered)
		) {
			return true;
		}
	}

	for (const type of input.contentTypes ?? []) {
		if (type.toLowerCase().includes("message/delivery-status")) return true;
	}

	const autoSubmitted = header(input.headers, "auto-submitted");
	if (autoSubmitted) {
		// The value may carry parameters: `auto-generated; type=failure`.
		const token = autoSubmitted.split(";")[0].trim().toLowerCase();
		if (AUTO_SUBMITTED_MACHINE.has(token) && isDaemonSender(input)) return true;
	}

	return false;
}

/**
 * Whether the message came from a mail system rather than a person.
 *
 * The envelope sender is checked too, and an empty one counts: RFC 3464 §4.1
 * requires notifications to be sent with a null reverse-path (`MAIL FROM:<>`)
 * precisely so they cannot cause a loop, and some systems leave the `From`
 * header looking like a human address while doing so.
 */
function isDaemonSender(input: DsnDetectionInput): boolean {
	if (input.envelopeSender !== undefined && input.envelopeSender !== null) {
		const envelope = input.envelopeSender.trim().replace(/^<|>$/g, "");
		if (envelope === "") return true;
		if (isDaemonAddress(envelope)) return true;
	}
	return isDaemonAddress(input.sender);
}

/** Whether an address's local part names a mail system. */
export function isDaemonAddress(address: string): boolean {
	const trimmed = address.trim().toLowerCase();
	if (!trimmed) return false;
	const localPart = trimmed.split("@")[0];
	return DAEMON_LOCAL_PARTS.has(localPart);
}

/**
 * Read the machine-readable fields out of a `message/delivery-status` body.
 *
 * The body is two or more RFC 822-style field blocks separated by a blank line:
 * per-message fields first, then one block per recipient. Only the recipient
 * blocks carry `Action` and `Status`, and a notification about several
 * recipients has several — this returns the first *failure* it finds rather than
 * the first block, so a message that reached one address and bounced off another
 * reports the bounce. That is the whole reason the report was sent.
 *
 * Tolerant of being handed the entire raw message rather than just the
 * delivery-status part, which is what a plain-text bounce amounts to. The fields
 * are distinctive enough that scanning for them is safe.
 */
export function parseDsn(text: string): DsnReport {
	const unfolded = unfoldHeaders(text ?? "");

	const blocks = unfolded
		.split(/\n\s*\n/)
		.map((block) => block.trim())
		.filter(Boolean);

	const reports = blocks
		.map(readReportBlock)
		.filter(
			(report) =>
				report.action !== null ||
				report.status !== null ||
				report.diagnosticCode !== null,
		);

	if (reports.length === 0) {
		return {
			action: null,
			status: null,
			diagnosticCode: null,
			recipient: null,
			permanent: false,
		};
	}

	// A failing recipient block outranks a preceding per-message block and any
	// recipient that succeeded.
	const failure = reports.find((report) => report.permanent);
	if (failure) return failure;

	const acted = reports.find((report) => report.action !== null);
	return acted ?? reports[0];
}

/** Read one field block into a report. */
function readReportBlock(block: string): DsnReport {
	const fields = readFields(block);

	const actionRaw = fields["action"]?.split(/[;\s(]/)[0].trim().toLowerCase();
	const action = isDsnAction(actionRaw) ? actionRaw : null;

	const status = normalizeStatus(fields["status"]);
	const diagnosticCode = stripTypePrefix(fields["diagnostic-code"]);
	const recipient =
		stripTypePrefix(fields["original-recipient"]) ??
		stripTypePrefix(fields["final-recipient"]);

	// 4.x.x is explicitly transient, so it overrules `Action` even when that says
	// failed: retrying is still possible and marking the message bounced would be
	// a lie the user cannot undo.
	const transientStatus = status?.startsWith("4.") ?? false;
	const permanent = transientStatus
		? false
		: (status?.startsWith("5.") ?? false) || action === "failed";

	return { action, status, diagnosticCode, recipient, permanent };
}

/**
 * Field name to value for one block.
 *
 * Later duplicates lose to earlier ones: within a single recipient block a
 * repeated field is malformed, and the first occurrence is the one the sender
 * most likely meant.
 */
function readFields(block: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const line of block.split("\n")) {
		const match = /^([A-Za-z0-9-]+)\s*:\s*(.*)$/.exec(line);
		if (!match) continue;
		const key = match[1].toLowerCase();
		if (key in fields) continue;
		fields[key] = match[2].trim();
	}
	return fields;
}

function isDsnAction(value: string | undefined): value is DsnAction {
	return (
		value === "failed" ||
		value === "delayed" ||
		value === "delivered" ||
		value === "relayed" ||
		value === "expanded"
	);
}

/**
 * Extract a bare `class.subject.detail` code.
 *
 * `Status` is defined as exactly that (RFC 3463 §2), but real reports append
 * text — "5.1.1 (bad destination mailbox)" — and some prefix the SMTP reply
 * code. Anything that is not three dot-separated numbers is dropped rather than
 * guessed at, because the first character of this value decides whether a
 * message is marked permanently bounced.
 */
function normalizeStatus(value: string | undefined): string | null {
	if (!value) return null;
	const match = /([2-5])\.(\d{1,3})\.(\d{1,3})/.exec(value);
	return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/**
 * Drop the address-type or diagnostic-type prefix.
 *
 * RFC 3464 writes these as `type; value` — `rfc822; user@example.com`,
 * `smtp; 550 5.1.1 unknown`. The type is never what we want to show, and a value
 * containing a semicolon of its own keeps everything after the first one.
 */
function stripTypePrefix(value: string | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const match = /^[A-Za-z0-9-]+\s*;\s*([\s\S]+)$/.exec(trimmed);
	const stripped = (match ? match[1] : trimmed).trim();
	return stripped || null;
}

/**
 * Recover the Message-ID of the message being reported on.
 *
 * This is the only thing that correlates a bounce back to what bounced. RFC 3462
 * has the notification carry the original as a `message/rfc822` or
 * `text/rfc822-headers` part, so its `Message-ID` is present in the body text —
 * which is where this reads it from, rather than requiring the caller to have
 * decomposed the MIME structure.
 *
 * Scans for the *last* `Message-ID` rather than the first. The notification has
 * its own, and if the caller passed the whole raw message that one comes first;
 * the returned original's appears in the attached part below it. The bracketing
 * is stripped, matching how `emails.message_id` is stored.
 */
export function extractOriginalMessageId(text: string): string | null {
	if (!text) return null;
	const unfolded = unfoldHeaders(text);

	const matches = [
		...unfolded.matchAll(/^message-id\s*:\s*(.+)$/gim),
	];
	if (matches.length === 0) return null;

	const raw = matches[matches.length - 1][1].trim();
	const bracketed = /<([^>]+)>/.exec(raw);
	const id = (bracketed ? bracketed[1] : raw.split(/\s+/)[0]).trim();
	return id || null;
}

/**
 * Join RFC 5322 §2.2.3 folded continuation lines onto their field.
 *
 * A long `Diagnostic-Code` or `Message-ID` is routinely wrapped, and a
 * line-by-line reader sees the tail as a separate unparseable line — truncating
 * the diagnostic, or missing the id entirely. Newlines are also normalised here
 * so CRLF input, which is what arrives over the wire, splits the same as LF.
 */
function unfoldHeaders(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]+/g, " ");
}

/** Read a header case-insensitively from a map that may be keyed either way. */
function header(headers: HeaderMap, name: string): string | undefined {
	const direct = headers[name];
	if (direct !== undefined) return direct;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name) return value;
	}
	return undefined;
}

/**
 * Cap on `emails.delivery_error`.
 *
 * A `Diagnostic-Code` is a remote server's free-form reply and can run to
 * kilobytes. The column is rendered in a banner, so the useful part is the
 * beginning; the rest would only bloat every list query that selects the row.
 */
export const DELIVERY_ERROR_MAX_LENGTH = 500;

/**
 * The sentence to store for a bounce.
 *
 * Prefers the remote server's own diagnostic — it is the only text that says
 * anything specific — and falls back to the status code, then the action, so a
 * report stripped down to one field still produces something better than
 * "delivery failed" with no detail.
 */
export function describeDsnFailure(report: DsnReport): string {
	const parts: string[] = [];
	if (report.diagnosticCode) parts.push(report.diagnosticCode);
	else if (report.status) parts.push(`Status ${report.status}`);
	else if (report.action) parts.push(`Action: ${report.action}`);

	if (report.recipient && !parts.join(" ").includes(report.recipient)) {
		parts.unshift(`${report.recipient}:`);
	}

	const text = parts.join(" ").trim();
	return (text || "The receiving server rejected this message.").slice(
		0,
		DELIVERY_ERROR_MAX_LENGTH,
	);
}
