// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Canonical message size limits.
 *
 * Cloudflare Email Service caps a sent message at 5 MiB *including*
 * attachments, and rejects anything larger with
 * `email.sending.error.email.too_big`:
 * https://developers.cloudflare.com/email-service/api/send-emails/rest-api/
 *
 * This module is the single source of truth so the composer, the HTTP send
 * routes, and the agent/MCP send tools all agree. Previously the UI advertised
 * 25 MB while the platform allowed 5 MiB, and because HTTP sends are dispatched
 * inside `waitUntil()` the request returned 202 and the delivery failure was
 * only visible in Worker logs — the message sat in Sent as though it had gone.
 */

/** Hard platform ceiling for a single outbound message. */
export const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;

/**
 * Reserved for headers, MIME boundaries, and encoding slop we cannot measure
 * from here. Generous enough to cover long References chains on deep threads.
 */
export const MESSAGE_OVERHEAD_RESERVE_BYTES = 16 * 1024;

/**
 * Base64 inflates payloads by 4/3, and MIME requires a CRLF every 76 output
 * characters which adds a further ~2.6%.
 */
export const BASE64_EXPANSION_RATIO = (4 / 3) * 1.0263;

/** Budget available to attachment payloads once overhead is set aside. */
export const ATTACHMENT_BUDGET_BYTES =
	MAX_MESSAGE_BYTES - MESSAGE_OVERHEAD_RESERVE_BYTES;

/**
 * Largest total of *raw* (pre-encoding) attachment bytes that can still fit.
 * This is what a file picker should validate `File.size` against.
 */
export const MAX_ATTACHMENT_TOTAL_RAW_BYTES = Math.floor(
	ATTACHMENT_BUDGET_BYTES / BASE64_EXPANSION_RATIO,
);

/** Encoded size of `rawBytes` once base64'd and line-folded for MIME. */
export function base64EncodedSize(rawBytes: number): number {
	return Math.ceil((Math.ceil(rawBytes / 3) * 4) * 1.0263);
}

/** UTF-8 byte length of a string (not the same as `.length` for non-ASCII). */
export function utf8Size(value: string | undefined | null): number {
	if (!value) return 0;
	// TextEncoder is available in Workers, Node, and browsers.
	return new TextEncoder().encode(value).byteLength;
}

export interface MessageSizeInput {
	html?: string | null;
	text?: string | null;
	/** Length of each already-base64-encoded attachment payload. */
	encodedAttachmentSizes?: number[];
	/** Raw byte size of each attachment, before base64 encoding. */
	rawAttachmentSizes?: number[];
}

/**
 * Estimate the on-the-wire size of a message.
 *
 * Accepts either encoded sizes (server side, where attachments arrive as base64
 * strings and the length is known exactly) or raw sizes (client side, where only
 * `File.size` is known and expansion must be predicted).
 */
export function estimateMessageBytes(input: MessageSizeInput): number {
	const bodyBytes = utf8Size(input.html) + utf8Size(input.text);

	const encoded = (input.encodedAttachmentSizes ?? []).reduce(
		(sum, size) => sum + Math.ceil(size * 1.0263),
		0,
	);
	const fromRaw = (input.rawAttachmentSizes ?? []).reduce(
		(sum, size) => sum + base64EncodedSize(size),
		0,
	);

	return MESSAGE_OVERHEAD_RESERVE_BYTES + bodyBytes + encoded + fromRaw;
}

/** True when the message is small enough for Cloudflare Email Service to accept. */
export function isMessageWithinLimit(input: MessageSizeInput): boolean {
	return estimateMessageBytes(input) <= MAX_MESSAGE_BYTES;
}

/** Human-readable byte size. Mirrors the composer's `formatBytes`. */
export function formatBytesShort(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
