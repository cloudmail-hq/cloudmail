// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Cloudflare Email Service's per-message limits, checked before we call it.
 *
 * Every HTTP send route answers `202` and writes the Sent copy BEFORE the real
 * `env.EMAIL.send()` runs in `waitUntil`. A message the provider was always
 * going to refuse therefore reached the user as "sent", then flipped to failed
 * a moment later. Checking the documented limits up front turns those into a
 * `400` naming the problem, with nothing stored and nothing sent.
 *
 * Mirrors the provider's own codes so a caller sees the same `E_*` either way.
 *
 * @see https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 * @see https://developers.cloudflare.com/email-service/reference/headers/
 */

import { assertSendableHeaders } from "./email-headers";
import { MAX_MESSAGE_BYTES, estimateMessageBytes, formatBytesShort } from "./limits";

/** To + Cc + Bcc, combined. */
export const MAX_RECIPIENTS = 50;
/** Attachment entries per message. */
export const MAX_ATTACHMENTS = 32;
/** Non-`X-` custom headers per message. */
export const MAX_ALLOWLISTED_HEADERS = 20;
/** One header value, in UTF-8 bytes. */
export const MAX_HEADER_VALUE_BYTES = 2048;
/** One header name, in bytes. */
export const MAX_HEADER_NAME_BYTES = 100;
/** All custom headers together (names + values), in bytes. */
export const MAX_HEADERS_TOTAL_BYTES = 16 * 1024;

export type SendValidationCode =
	| "E_TOO_MANY_RECIPIENTS"
	| "E_TOO_MANY_ATTACHMENTS"
	| "E_CONTENT_TOO_LARGE"
	| "E_HEADER_NOT_ALLOWED"
	| "E_HEADER_USE_API_FIELD"
	| "E_HEADER_NAME_INVALID"
	| "E_HEADER_VALUE_INVALID"
	| "E_HEADER_VALUE_TOO_LONG"
	| "E_HEADERS_TOO_LARGE"
	| "E_HEADERS_TOO_MANY";

/** A message the provider would refuse. `code` matches the provider's. */
export class SendValidationError extends Error {
	constructor(
		readonly code: SendValidationCode,
		message: string,
	) {
		super(message);
		this.name = "SendValidationError";
	}
}

type AddressField = string | string[] | null | undefined;

/** Count addresses in a field, accepting either an array or a comma list. */
export function countAddresses(field: AddressField): number {
	if (!field) return 0;
	const list = Array.isArray(field) ? field : field.split(",");
	return list.map((a) => a.trim()).filter(Boolean).length;
}

const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

/** RFC 5322 field-name: printable ASCII except colon. */
const HEADER_NAME = /^[\x21-\x39\x3b-\x7e]+$/;

export interface SendableMessage {
	to: AddressField;
	cc?: AddressField;
	bcc?: AddressField;
	html?: string | null;
	text?: string | null;
	attachments?: { content: string }[] | null;
	headers?: Record<string, string> | null;
}

/**
 * Throw `SendValidationError` when Email Service would refuse this message.
 *
 * Size is the same estimate `assertMessageWithinSizeLimit` uses (base64 and
 * MIME overhead included), so the two checks cannot disagree about a message.
 */
export function validateOutgoingMessage(message: SendableMessage): void {
	const recipients =
		countAddresses(message.to) + countAddresses(message.cc) + countAddresses(message.bcc);
	if (recipients > MAX_RECIPIENTS) {
		throw new SendValidationError(
			"E_TOO_MANY_RECIPIENTS",
			`Too many recipients: ${recipients} across To, Cc and Bcc. Cloudflare Email Service allows at most ${MAX_RECIPIENTS} per message.`,
		);
	}

	const attachmentCount = message.attachments?.length ?? 0;
	if (attachmentCount > MAX_ATTACHMENTS) {
		throw new SendValidationError(
			"E_TOO_MANY_ATTACHMENTS",
			`Too many attachments: ${attachmentCount}. Cloudflare Email Service allows at most ${MAX_ATTACHMENTS} per message.`,
		);
	}

	const estimated = estimateMessageBytes({
		html: message.html,
		text: message.text,
		encodedAttachmentSizes: message.attachments?.map((a) => a.content.length),
	});
	if (estimated > MAX_MESSAGE_BYTES) {
		throw new SendValidationError(
			"E_CONTENT_TOO_LARGE",
			`Message is too large to send: ~${formatBytesShort(estimated)} exceeds the ${formatBytesShort(MAX_MESSAGE_BYTES)} limit (attachments are base64-encoded, which adds about 37%). Remove or shrink attachments and try again.`,
		);
	}

	validateHeaders(message.headers ?? {});
}

/** The header half of {@link validateOutgoingMessage}. */
export function validateHeaders(headers: Record<string, string>): void {
	// Name allowlist first, through the long-standing guard, so a refused name
	// keeps raising `UnsendableHeaderError` (which now carries the same `code`).
	assertSendableHeaders(headers);
	let allowlisted = 0;
	let total = 0;
	for (const [name, value] of Object.entries(headers)) {
		if (!name || byteLength(name) > MAX_HEADER_NAME_BYTES || !HEADER_NAME.test(name)) {
			throw new SendValidationError(
				"E_HEADER_NAME_INVALID",
				`Header name '${name.slice(0, 40)}' is not valid.`,
			);
		}
		if (typeof value !== "string" || /[\r\n]/.test(value)) {
			throw new SendValidationError(
				"E_HEADER_VALUE_INVALID",
				`Header '${name}' has an invalid value (it must be a single-line string).`,
			);
		}
		const valueBytes = byteLength(value);
		if (valueBytes > MAX_HEADER_VALUE_BYTES) {
			throw new SendValidationError(
				"E_HEADER_VALUE_TOO_LONG",
				`Header '${name}' is ${valueBytes} bytes; the limit is ${MAX_HEADER_VALUE_BYTES}.`,
			);
		}
		if (!name.toLowerCase().startsWith("x-")) allowlisted++;
		total += byteLength(name) + valueBytes;
	}
	if (allowlisted > MAX_ALLOWLISTED_HEADERS) {
		throw new SendValidationError(
			"E_HEADERS_TOO_MANY",
			`${allowlisted} non-X- headers; Cloudflare Email Service allows at most ${MAX_ALLOWLISTED_HEADERS}.`,
		);
	}
	if (total > MAX_HEADERS_TOTAL_BYTES) {
		throw new SendValidationError(
			"E_HEADERS_TOO_LARGE",
			`Custom headers total ${total} bytes; the limit is ${MAX_HEADERS_TOTAL_BYTES}.`,
		);
	}
}
