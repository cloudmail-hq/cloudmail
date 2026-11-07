// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Message-ID parsing for inbound threading.
 *
 * ## How a Gmail reply finds our conversation
 *
 * Cloudflare Email Service will not let us set `Message-ID`; it assigns its own
 * (`<36 random chars>@<our sending domain>`, e.g. `YETKMAan…@tapetide.com`) and
 * returns that exact id from `send()` as `messageId`. `recordDelivery` stores it
 * in `emails.message_id`, so when the recipient replies, Gmail's `In-Reply-To`
 * and `References` cite an id we hold, and `findThreadByMessageIds` joins the
 * reply onto our thread. Verified against production on 2026-10-25: the stored
 * `message_id` of a sent row matched the `Message-ID` header Gmail received
 * byte for byte.
 *
 * These helpers turn the raw header values into bare ids in the shape that join
 * expects (no angle brackets, no whitespace).
 */

/** Bare ids in a header value, in order. Accepts `<a> <b>`, `<a><b>`, folded. */
export function parseMessageIdList(value: string | null | undefined): string[] {
	if (!value) return [];
	const bracketed = [...value.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]);
	if (bracketed.length > 0) return bracketed;
	// Some senders omit the brackets entirely.
	return value
		.split(/[\s,]+/)
		.map((part) => part.trim())
		.filter((part) => part.includes("@"));
}

/**
 * A provider `messageId` as stored in `emails.message_id`: trimmed, without
 * angle brackets. `send()` returns `<…@domain>`; every join (threading, DSN,
 * the delivery reconciler) expects the bare form.
 */
export function bareMessageId(value: string): string {
	return value.trim().replace(/^<|>$/g, "");
}

/** The single id a `Message-ID` / `In-Reply-To` value names, or null. */
export function parseMessageId(value: string | null | undefined): string | null {
	return parseMessageIdList(value)[0] ?? null;
}

/**
 * The ids an inbound message cites, nearest ancestor first.
 *
 * `In-Reply-To` names the direct parent; `References` runs oldest-first, so its
 * tail is nearest. Duplicates (the parent normally appears in both) are dropped.
 */
export function threadCandidates(headers: {
	inReplyTo?: string | null;
	references?: string | null;
}): { inReplyTo: string | null; references: string[]; candidates: string[] } {
	const inReplyTo = parseMessageId(headers.inReplyTo);
	const references = parseMessageIdList(headers.references);
	const candidates: string[] = [];
	for (const id of [inReplyTo, ...[...references].reverse()]) {
		if (id && !candidates.includes(id)) candidates.push(id);
	}
	return { inReplyTo, references, candidates };
}
