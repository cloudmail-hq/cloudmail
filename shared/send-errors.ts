// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * What Cloudflare Email Service's send errors mean to a person.
 *
 * `env.EMAIL.send()` throws an Error carrying a machine `code` (`E_*`) and a
 * terse message. That message used to be stored verbatim in
 * `delivery_error`, so the reading pane said things like
 * `E_SENDER_DOMAIN_NOT_AVAILABLE: domain not onboarded` — accurate, but not
 * something the person who pressed Send can act on.
 *
 * The stored reason is now `"<friendly sentence> (<CODE>)"`: the sentence for
 * the reader, the code so support (and agents reading the API) can still tell
 * exactly which failure it was. Unknown codes keep the provider's own words.
 *
 * Codes from the Workers API reference:
 * https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 */

/** Delivery states stored in `emails.delivery_status`. */
export type DeliveryStatusValue =
	/** Written to Sent; the provider has not answered yet. */
	| "queued"
	/** The provider accepted it (returned a messageId). Not yet confirmed delivered. */
	| "sent"
	/** The provider (via the reconciler) confirmed delivery to the recipient's server. */
	| "delivered"
	/** We could not hand it to the provider, or the provider refused it. */
	| "failed"
	/** Accepted, then a remote server rejected it (DSN or provider verdict). */
	| "bounced";

/** The two states that mean "this did not get there", which the UI flags. */
export function isDeliveryProblem(status: string | null | undefined): status is "failed" | "bounced" {
	return status === "failed" || status === "bounced";
}

const FRIENDLY: Record<string, string> = {
	E_VALIDATION_ERROR: "The message was rejected as malformed. Check the addresses and try again.",
	E_FIELD_MISSING: "The message is missing a recipient, sender or subject.",
	E_TOO_MANY_RECIPIENTS: "Too many recipients. Cloudflare allows at most 50 across To, Cc and Bcc.",
	E_TOO_MANY_ATTACHMENTS: "Too many attachments. Cloudflare allows at most 32 per message.",
	E_CONTENT_TOO_LARGE: "The message is too large. The limit is 5 MiB including attachments.",
	E_SENDER_NOT_VERIFIED: "This sending address isn't verified with Cloudflare Email Service yet.",
	E_SENDER_DOMAIN_NOT_AVAILABLE:
		"This domain isn't set up for sending in Cloudflare Email Service. Onboard it in the Cloudflare dashboard.",
	E_RECIPIENT_NOT_ALLOWED:
		"Cloudflare isn't allowed to send to this recipient on this account (it's not in the allowed destination list).",
	E_RECIPIENT_SUPPRESSED:
		"A recipient is on the suppression list after an earlier bounce or complaint, so Cloudflare didn't send to them.",
	E_ACCOUNT_SUSPENDED: "Sending is paused for this Cloudflare account. Check the Email Service dashboard.",
	E_RATE_LIMIT_EXCEEDED: "Cloudflare's sending rate limit was reached. Try again in a few minutes.",
	E_DAILY_LIMIT_EXCEEDED: "Today's sending quota for this Cloudflare account is used up. Try again tomorrow.",
	E_DELIVERY_FAILED: "The recipient's mail server refused the message.",
	E_INTERNAL_SERVER_ERROR: "Cloudflare Email Service had a temporary problem. Try sending again.",
	E_HEADER_NOT_ALLOWED: "The message carried a header Cloudflare doesn't accept.",
	E_HEADER_USE_API_FIELD: "The message set a header that must be sent as its own field instead.",
	E_HEADER_VALUE_INVALID: "A message header had an invalid value.",
	E_HEADER_VALUE_TOO_LONG: "A message header was longer than Cloudflare allows (2,048 bytes).",
	E_HEADER_NAME_INVALID: "A message header had an invalid name.",
	E_HEADERS_TOO_LARGE: "The message headers were larger than Cloudflare allows (16 KB in total).",
	E_HEADERS_TOO_MANY: "The message had more custom headers than Cloudflare allows (20).",
};

/** Codes for which retrying later can succeed without changing the message. */
const TRANSIENT = new Set([
	"E_RATE_LIMIT_EXCEEDED",
	"E_DAILY_LIMIT_EXCEEDED",
	"E_INTERNAL_SERVER_ERROR",
]);

/** The `E_*` code on a thrown send error, if it carries one. */
export function sendErrorCode(error: unknown): string | null {
	if (!error || typeof error !== "object") return null;
	const code = (error as { code?: unknown }).code;
	if (typeof code === "string" && /^E_[A-Z0-9_]+$/.test(code)) return code;
	// Some runtimes only put the code in the message ("E_FOO: details").
	const message = (error as { message?: unknown }).message;
	if (typeof message === "string") {
		const match = /\b(E_[A-Z0-9_]{3,})\b/.exec(message);
		if (match) return match[1];
	}
	return null;
}

/** A human sentence for a code, or null when the code is not one we know. */
export function friendlySendError(code: string | null | undefined): string | null {
	if (!code) return null;
	if (FRIENDLY[code]) return FRIENDLY[code];
	if (code.startsWith("E_HEADER")) return "A message header was refused by Cloudflare.";
	return null;
}

/** Whether a failure with this code is worth retrying unchanged. */
export function isTransientSendError(code: string | null | undefined): boolean {
	return !!code && TRANSIENT.has(code);
}

/**
 * The reason stored in `delivery_error` for a thrown send.
 *
 * `"<friendly> (<CODE>)"` when the code is known, `"<provider message> (<CODE>)"`
 * when it is not, and the bare message for an error with no code at all (a
 * binding missing, a network failure inside the runtime).
 */
export function describeSendError(error: unknown): string {
	const code = sendErrorCode(error);
	const raw =
		error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
			? ((error as { message: string }).message || "").trim()
			: String(error ?? "Unknown error");
	const friendly = friendlySendError(code);
	if (friendly) return `${friendly} (${code})`;
	if (code) {
		// Avoid "E_FOO: bar (E_FOO)".
		const withoutCode = raw.replace(new RegExp(`^${code}\\s*[:\\-]?\\s*`), "").trim();
		return `${withoutCode || "Sending failed"} (${code})`;
	}
	return raw || "Sending failed";
}
