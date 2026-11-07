// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * What Cloudflare Email Service will accept in the `headers` object.
 *
 * ## Why this file exists
 *
 * Every outgoing message from this app failed to deliver, silently, because
 * `buildOutgoingHeaders` set `Message-ID`. Email Service treats that header as
 * platform-controlled — it generates its own for tracking — and rejects any
 * attempt to set it:
 *
 *     custom header 'Message-ID' is not allowed.
 *     Only whitelisted headers and X-* headers are accepted.
 *
 * The send route returns `202 {"status":"sent"}` and writes the message to Sent
 * *before* delivery is attempted, then defers the actual `env.EMAIL.send()` into
 * `waitUntil` where a rejection only reaches `console.error`. So the UI, the
 * database and the API all reported success while nothing left the building.
 *
 * The header rules live in one place here, as DATA, so a send path cannot
 * reintroduce a rejected header and a test can assert the contract without a
 * network call. Sourced from the Email Service reference documentation
 * (`/email-service/reference/headers/`), verified against the live binding.
 *
 * @see https://developers.cloudflare.com/email-service/reference/headers/
 */

/**
 * Headers the platform generates and refuses to let a caller set. Sending any of
 * these fails the whole message with `E_HEADER_NOT_ALLOWED` — they are not
 * dropped, so one bad entry costs the entire delivery.
 */
export const PLATFORM_CONTROLLED_HEADERS = [
	"Date",
	"Message-ID",
	"MIME-Version",
	"Content-Type",
	"Content-Transfer-Encoding",
	"DKIM-Signature",
	"Return-Path",
	"Received",
	"Feedback-ID",
	"TLS-Required",
	"TLS-Report-Domain",
	"TLS-Report-Submitter",
	"CFBL-Address",
	"CFBL-Feedback-ID",
] as const;

/**
 * Headers that belong to a first-class API field. Rejected in `headers` with
 * `E_HEADER_USE_API_FIELD` — set them via `to` / `from` / `subject` and friends.
 */
export const API_FIELD_HEADERS = [
	"From",
	"To",
	"Cc",
	"Bcc",
	"Subject",
	"Reply-To",
] as const;

/**
 * Non-`X-` headers Email Service accepts. Anything outside this list, and not
 * beginning with `X-`, is rejected.
 *
 * Deliberately the FULL documented allowlist rather than only the entries this
 * app happens to use today: the value of the list is telling a future caller
 * what is available, so the next feature reaches for `List-Unsubscribe` instead
 * of an `X-` header nobody honours.
 */
export const ALLOWLISTED_HEADERS = [
	// Threading — the two that make replies land in the right conversation.
	"In-Reply-To",
	"References",
	// List management. Gmail and Yahoo require the unsubscribe pair for bulk mail.
	"List-Unsubscribe",
	"List-Unsubscribe-Post",
	"List-Id",
	"List-Archive",
	"List-Help",
	"List-Owner",
	"List-Post",
	"List-Subscribe",
	// Descriptive / advisory.
	"Auto-Submitted",
	"Precedence",
	"Importance",
	"Sensitivity",
	"Comments",
	"Keywords",
	"Organization",
	"Content-Language",
	"Archived-At",
	"Require-Recipient-Valid-Since",
] as const;

/** `ARC-*` is platform-controlled as a family, not as a single name. */
const PLATFORM_CONTROLLED_PREFIXES = ["ARC-"];

/** Custom headers must start with this to bypass the allowlist. */
export const CUSTOM_HEADER_PREFIX = "X-";

/**
 * Header names are matched case-insensitively per RFC 5322 §2.2, so the guard
 * must be too — `message-id` is rejected exactly like `Message-ID`, and a
 * case-sensitive check would let the same outage back in through a rename.
 */
const lower = (value: string) => value.toLowerCase();

const PLATFORM_SET = new Set(PLATFORM_CONTROLLED_HEADERS.map(lower));
const API_FIELD_SET = new Set(API_FIELD_HEADERS.map(lower));
const ALLOWLIST_SET = new Set(ALLOWLISTED_HEADERS.map(lower));

/** Why a header cannot be sent, or `null` when it is acceptable. */
export type HeaderRejection =
	/** Platform-generated; setting it fails the message. */
	| "platform-controlled"
	/** Belongs to a dedicated API field. */
	| "use-api-field"
	/** Neither allowlisted nor `X-` prefixed. */
	| "not-allowlisted";

/**
 * Decide whether Email Service will accept `name` in the `headers` object.
 *
 * Returns the reason for refusal, or `null` when the header is fine. Callers get
 * a reason rather than a boolean so an error message can explain *why* — the
 * original failure was hard to place precisely because "not allowed" did not say
 * whether the header was platform-owned or simply unknown.
 */
export function rejectionFor(name: string): HeaderRejection | null {
	const key = lower(name.trim());
	if (!key) return "not-allowlisted";
	if (PLATFORM_SET.has(key)) return "platform-controlled";
	if (API_FIELD_SET.has(key)) return "use-api-field";
	if (PLATFORM_CONTROLLED_PREFIXES.some((p) => key.startsWith(lower(p)))) {
		return "platform-controlled";
	}
	if (key.startsWith(lower(CUSTOM_HEADER_PREFIX))) return null;
	if (ALLOWLIST_SET.has(key)) return null;
	return "not-allowlisted";
}

/** True when Email Service will accept this header name. */
export function isSendableHeader(name: string): boolean {
	return rejectionFor(name) === null;
}

/**
 * Throw when a header set would be refused by the provider.
 *
 * Called on the way out of {@link buildOutgoingHeaders} so a rejected header
 * fails LOUDLY in tests and in local development, rather than at the provider
 * where the rejection lands in a `waitUntil` nobody reads. This is the guard
 * that makes the original outage impossible to reintroduce quietly.
 */
export function assertSendableHeaders(headers: Record<string, string>): void {
	for (const name of Object.keys(headers)) {
		const rejection = rejectionFor(name);
		if (!rejection) continue;
		const detail =
			rejection === "platform-controlled"
				? `'${name}' is generated by Cloudflare Email Service and cannot be set`
				: rejection === "use-api-field"
					? `'${name}' must be set via its own API field, not the headers object`
					: `'${name}' is neither allowlisted nor X- prefixed`;
		throw new UnsendableHeaderError(
			`Refusing to send header ${detail}. ` +
				`Email Service would reject the entire message. ` +
				`See shared/email-headers.ts for the accepted set.`,
			name,
			rejection,
		);
	}
}

/** A header set that Email Service would refuse. */
export class UnsendableHeaderError extends Error {
	/** The provider's own code for this refusal, so callers can map it. */
	readonly code: "E_HEADER_NOT_ALLOWED" | "E_HEADER_USE_API_FIELD";

	constructor(
		message: string,
		readonly headerName: string,
		readonly rejection: HeaderRejection,
	) {
		super(message);
		this.name = "UnsendableHeaderError";
		this.code =
			rejection === "use-api-field" ? "E_HEADER_USE_API_FIELD" : "E_HEADER_NOT_ALLOWED";
	}
}
