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
		"Cloudflare only sends to this account's own verified addresses on the Workers Free plan. Upgrade to Workers Paid, or send through Resend or Amazon SES in Settings → Domains → Sending.",
	E_RECIPIENT_PLAN_RESTRICTED:
		"Cloudflare only sends to this account's own verified addresses on the Workers Free plan. Upgrade to Workers Paid, or send through Resend or Amazon SES in Settings → Domains → Sending.",
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
	E_ATTACHMENT_BLOCKED: "An attachment's file type isn't accepted by the sending provider. Zip it or send a link instead.",
	E_TOO_MANY_PARTS: "The message has too many attachments for the sending provider (500 MIME parts at most).",
	E_PROVIDER_NOT_CONFIGURED:
		"This domain is set to send through Amazon SES or Resend, but its settings are incomplete. Fix them in Settings → Domains → Sending.",
	E_PROVIDER_NOT_IMPLEMENTED:
		"This domain's sending provider isn't supported by this version. Switch it back to Cloudflare in Settings → Domains → Sending.",
	E_PROVIDER_LOOKUP_FAILED: "The domain's sending settings couldn't be read. Try again shortly.",
	// Amazon SES (workers/lib/ses-transport.ts)
	E_SES_UNCONFIRMED:
		"Amazon SES didn't confirm this message, so it may or may not have been sent. It won't be retried automatically; its status updates when SES reports on it.",
	E_SES_THROTTLED: "Amazon SES is throttling this account. The message wasn't sent; try again shortly.",
	E_SES_REQUEST_TIMEOUT: "Amazon SES timed out receiving the message. It wasn't sent; try again.",
	E_SES_DAILY_QUOTA: "Today's Amazon SES sending quota is used up. The message wasn't sent; try again tomorrow or raise the quota in AWS.",
	E_SES_MESSAGE_REJECTED:
		"Amazon SES refused the message. In the SES sandbox this usually means the recipient isn't a verified address.",
	E_SES_MAIL_FROM_NOT_VERIFIED: "Amazon SES refused the message because the domain's MAIL FROM MX record is missing.",
	E_SES_ACCOUNT_SUSPENDED: "Sending is suspended for this AWS account in SES. Check the SES console.",
	E_SES_SENDING_PAUSED: "Sending is paused for this AWS account or configuration set in SES. Check the SES console.",
	E_SES_LIMIT_EXCEEDED: "Amazon SES refused the message because an account limit was reached.",
	E_SES_NOT_FOUND: "Amazon SES couldn't find the configuration set. Check it in Settings → Domains → Sending.",
	E_SES_ACCESS_DENIED: "The AWS key isn't allowed to send as this domain. Attach the IAM policy shown in Settings → Domains → Sending.",
	E_SES_INVALID_CREDENTIALS: "Amazon SES didn't accept the access key. Check the key in Settings → Domains → Sending.",
	E_SES_REGION_NOT_ENABLED: "SES isn't enabled in this AWS region for the account.",
	E_SES_TOO_LARGE: "The message is too large for Amazon SES (40 MB after encoding).",
	E_SES_BAD_REQUEST: "Amazon SES refused the request as malformed.",
	E_SES_REJECTED: "Amazon SES refused the message.",
	// Resend (workers/lib/resend-transport.ts)
	E_RESEND_UNCONFIRMED:
		"Resend didn't confirm this message, so it may or may not have been sent. It won't be retried automatically; its status updates when Resend reports on it.",
	E_RESEND_QUOTA_EXCEEDED: "The Resend account's sending quota is used up. The message wasn't sent.",
	E_RESEND_INVALID_KEY: "Resend didn't accept the API key. Check it in Settings → Domains → Sending.",
	E_RESEND_FORBIDDEN: "Resend refused the message. Check that the domain is verified in Resend.",
	E_RESEND_INVALID_ATTACHMENT: "Resend refused an attachment.",
	E_RESEND_REJECTED: "Resend refused the message.",
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
	if (friendly && code && (code.startsWith("E_SES_") || code.startsWith("E_RESEND_"))) {
		// Keep the provider's own short reason ("Email address is not verified…"),
		// which the transport puts after "): ". It never carries a credential.
		const detail = /\):\s(.+)$/.exec(raw)?.[1]?.trim();
		return detail ? `${friendly} ${code.startsWith("E_SES_") ? "SES" : "Resend"} said: ${detail.slice(0, 240)} (${code})` : `${friendly} (${code})`;
	}
	if (friendly) return `${friendly} (${code})`;
	if (code) {
		// Avoid "E_FOO: bar (E_FOO)".
		const withoutCode = raw.replace(new RegExp(`^${code}\\s*[:\\-]?\\s*`), "").trim();
		return `${withoutCode || "Sending failed"} (${code})`;
	}
	return raw || "Sending failed";
}
