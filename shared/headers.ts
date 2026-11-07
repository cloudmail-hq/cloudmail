// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Reading the headers stored alongside a message.
 *
 * ## Why this module exists
 *
 * `emails.raw_headers` holds two different things depending on which code path
 * wrote the row, and every consumer so far has assumed whichever one its author
 * happened to be looking at:
 *
 * - **Inbound** mail stores `JSON.stringify(parsedEmail.headers)` — postal-mime's
 *   array of `{ key, value }` — so the column contains JSON.
 * - **Outbound** mail stores a hand-built array of the same shape, for a narrower
 *   reason: `sender` is a bare address, so the `From` display name would be lost
 *   between the send route and delivery without somewhere to keep it.
 *
 * Both are arrays, so the JSON reading is the correct one. But
 * `app/lib/email-html.ts` regex-matched the column as though it were a block of
 * RFC 5322 header lines, which is what a `.eml` file contains and what a header
 * blob looks like if you have only ever seen one in a message source view. Those
 * regexes are line-anchored, so against real stored JSON they match nothing —
 * silently, because "no `List-Unsubscribe` header" and "could not read the
 * headers" are indistinguishable to a caller that only gets `null` back.
 *
 * So: one parser, used by everything, that accepts either shape.
 *
 * ## Header lookup rules that are easy to get wrong
 *
 * Field names are case-insensitive (RFC 5322 §1.2.2 treats them as unstructured
 * US-ASCII printable characters compared without regard to case), so lookups
 * lowercase both sides. Folded values — a long header continued on following
 * lines beginning with whitespace — are unfolded before use, because
 * `List-Unsubscribe` with two targets routinely wraps and a naive line match
 * would truncate at the fold.
 */

/** One header field, in the shape postal-mime produces and both writers store. */
export interface StoredHeader {
	key: string;
	value: string;
}

/**
 * Parse the `raw_headers` column into fields, whichever shape it holds.
 *
 * Returns `[]` for absent, empty or unreadable input rather than throwing: the
 * headers are supplementary everywhere they are read, and a message with a
 * malformed header blob should still open.
 */
export function parseStoredHeaders(raw?: string | null): StoredHeader[] {
	const text = raw?.trim();
	if (!text) return [];

	/**
	 * The JSON both writers actually produce.
	 *
	 * `{` is checked as well as `[` so a JSON *object* — not a shape anything
	 * writes, but the plausible result of a hand-edited row — is rejected rather
	 * than falling through to the line reader, which would split it on its first
	 * colon and invent a header named `{"key"`.
	 */
	if (text.startsWith("[") || text.startsWith("{")) {
		try {
			const parsed: unknown = JSON.parse(text);
			if (!Array.isArray(parsed)) return [];
			return parsed
				.filter(
					(entry): entry is StoredHeader =>
						!!entry &&
						typeof entry === "object" &&
						typeof (entry as StoredHeader).key === "string",
				)
				.map((entry) => ({
					key: entry.key,
					// A header with no value is legal and means the empty string; coercing
					// keeps `find` callers from having to guard for undefined.
					value: typeof entry.value === "string" ? entry.value : "",
				}));
		} catch {
			// Not the JSON it looked like. Fall through to the line reader, which
			// will find nothing useful but cannot throw.
		}
	}

	return parseHeaderLines(text);
}

/**
 * Parse a block of RFC 5322 header lines.
 *
 * Kept exported because a `.eml` a user drops in, and a message source pasted
 * into a test, are both this shape even though nothing in the database is.
 *
 * Continuation lines — those starting with a space or tab — are joined onto the
 * field before them, per RFC 5322 §2.2.3 folding.
 */
export function parseHeaderLines(text: string): StoredHeader[] {
	const out: StoredHeader[] = [];

	for (const line of text.split(/\r\n|\n|\r/)) {
		// A blank line ends the header section; anything after it is the body.
		if (line === "") break;

		if (/^[ \t]/.test(line) && out.length > 0) {
			// Unfold: one space stands in for the fold, and the continuation's own
			// leading whitespace is not part of the value.
			out[out.length - 1]!.value += ` ${line.trim()}`;
			continue;
		}

		const separator = line.indexOf(":");
		if (separator <= 0) continue;
		out.push({
			key: line.slice(0, separator).trim(),
			value: line.slice(separator + 1).trim(),
		});
	}

	return out;
}

/** First value for `name`, case-insensitively, or null. */
export function headerValue(
	headers: StoredHeader[],
	name: string,
): string | null {
	const wanted = name.toLowerCase();
	const found = headers.find((header) => header.key?.toLowerCase() === wanted);
	const value = found?.value?.trim();
	return value ? value : null;
}

/** Every value for `name`, for the fields that may legally repeat. */
export function headerValues(
	headers: StoredHeader[],
	name: string,
): string[] {
	const wanted = name.toLowerCase();
	return headers
		.filter((header) => header.key?.toLowerCase() === wanted)
		.map((header) => header.value?.trim())
		.filter((value): value is string => !!value);
}

/** Render fields back to RFC 5322 lines, for `.eml` export. */
export function formatHeaderLines(headers: StoredHeader[]): string {
	return headers
		.filter((header) => header.key)
		.map((header) => `${header.key}: ${header.value ?? ""}`)
		.join("\r\n");
}

// -- Addresses ------------------------------------------------------

/**
 * Bare addresses out of an address-list header value.
 *
 * Handles the two forms a `Reply-To`, `To` or `Cc` value takes in practice:
 * `Display Name <addr@example.com>` and a bare `addr@example.com`, comma
 * separated. Display names are dropped, because every caller here wants to
 * compare or send to the address itself.
 *
 * Deliberately not a full RFC 5322 address parser. A quoted display name
 * containing a comma would split wrongly, which costs a spurious extra entry
 * that fails the address test below and is discarded — acceptable, where
 * pulling in a parser for a header this app only reads is not.
 */
export function parseAddressList(value: string | null | undefined): string[] {
	if (!value) return [];

	const out: string[] = [];
	const seen = new Set<string>();

	for (const part of value.split(",")) {
		const angled = part.match(/<([^>]+)>/)?.[1];
		const candidate = (angled ?? part).trim().replace(/^["']|["']$/g, "");
		// One `@` with something either side is the whole test. Anything that fails
		// it is a display-name fragment from a bad split, or a group syntax label.
		if (!/^[^\s@]+@[^\s@]+$/.test(candidate)) continue;

		const key = candidate.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(candidate);
	}

	return out;
}

/**
 * Where a reply to this message should go.
 *
 * RFC 5322 §3.6.2 is explicit: "When the 'Reply-To:' field is present, it
 * indicates the address(es) to which the author of the message suggests that
 * replies be sent." Ignoring it and replying to `From` is wrong in the cases it
 * exists for, and they are the common ones — a mailing list that wants the reply
 * on-list, a ticketing system whose `From` is a `no-reply` robot, a newsletter
 * routing replies to a monitored inbox. The reply either goes nowhere or goes to
 * a mailbox nobody reads, and the sender is not told.
 *
 * Falls back to `From`, which is what the same paragraph specifies when the field
 * is absent.
 *
 * Returns *all* the addresses, since `Reply-To` is an address-list and a sender
 * that names two means both. Callers replying to one correspondent should take
 * the first.
 */
export function replyRecipients(options: {
	raw_headers?: string | null;
	sender?: string | null;
}): string[] {
	const headers = parseStoredHeaders(options.raw_headers);
	const replyTo = parseAddressList(headerValue(headers, "Reply-To"));
	if (replyTo.length > 0) return replyTo;

	const from = parseAddressList(headerValue(headers, "From"));
	if (from.length > 0) return from;

	// `sender` is the stored column, already a bare address. Last resort, because
	// a row written before headers were kept has nothing else.
	return parseAddressList(options.sender);
}

/**
 * Whether replying would send to anyone other than the author.
 *
 * The UI says so when it would. A reply reaching an address the reader did not
 * choose and cannot see is the kind of surprise that gets confidential mail
 * copied to a mailing list, and `Reply-To` is trivially set by whoever sent the
 * message.
 *
 * True whenever the reply targets are anything other than *exactly* the author.
 * An earlier version only warned when the author was absent from the list, on the
 * grounds that `Reply-To: author, list` still reaches them — but that is precisely
 * the dangerous case: the reply goes to the author **and** to the list, and
 * suppressing the warning there hides the added recipient rather than the missing
 * one. Redirected and widened both deserve saying out loud.
 */
export function replyToDiffersFromSender(options: {
	raw_headers?: string | null;
	sender?: string | null;
}): boolean {
	const headers = parseStoredHeaders(options.raw_headers);
	const replyTo = parseAddressList(headerValue(headers, "Reply-To"));
	if (replyTo.length === 0) return false;

	const author =
		parseAddressList(headerValue(headers, "From"))[0] ??
		parseAddressList(options.sender)[0];
	if (!author) return false;

	// Anything but exactly the author is worth naming: a different address, or the
	// author plus somebody else.
	if (replyTo.length !== 1) return true;
	return replyTo[0]!.toLowerCase() !== author.toLowerCase();
}
