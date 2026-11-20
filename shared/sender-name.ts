// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The display name a sender gave themselves, for `emails.sender_name`.
 *
 * `emails.sender` holds a bare, lowercased address, so the list could only
 * title-case its local part ("priya.sharma" → "Priya Sharma"), which is wrong
 * for anyone whose name is not their address and useless for role mailboxes. The
 * `From:` header almost always carries the real name; this keeps it.
 *
 * Inbound mail gets it from the parsed `From` (postal-mime has already decoded
 * RFC 2047). Rows that predate the column are backfilled from `raw_headers`,
 * where the stored value is the raw header and may still be encoded — hence the
 * small decoder here. Sent mail uses the name the mailbox sends under.
 */

/** Longest name stored. Display names past this are spam or a parse error. */
export const SENDER_NAME_MAX_CHARS = 200;

/** Decode one RFC 2047 encoded word's payload. Returns null when undecodable. */
function decodeEncodedWord(charset: string, encoding: string, text: string): string | null {
	let bytes: Uint8Array;
	try {
		if (encoding.toUpperCase() === "B") {
			const binary = atob(text);
			bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
		} else {
			// Q encoding: `_` is a space, `=XX` is a byte, anything else is itself.
			const out: number[] = [];
			const src = text.replace(/_/g, " ");
			for (let i = 0; i < src.length; i++) {
				const ch = src[i];
				if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
					out.push(Number.parseInt(src.slice(i + 1, i + 3), 16));
					i += 2;
				} else {
					out.push(ch.charCodeAt(0) & 0xff);
				}
			}
			bytes = Uint8Array.from(out);
		}
		return new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(bytes);
	} catch {
		// Unknown charset or malformed base64: leave the word as written.
		return null;
	}
}

/**
 * Decode RFC 2047 encoded words in a header value.
 *
 * Whitespace between two adjacent encoded words is dropped, as §6.2 requires —
 * that is how a long name is split across words without gaining spaces.
 */
export function decodeMimeWords(value: string): string {
	if (!value.includes("=?")) return value;
	const word = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
	const joined = value.replace(/(\?=)\s+(?==\?)/g, "$1");
	return joined.replace(word, (match, charset: string, enc: string, text: string) => {
		// `charset*lang` (RFC 2231) — the language tag is irrelevant here.
		const decoded = decodeEncodedWord(charset.split("*")[0], enc, text);
		return decoded ?? match;
	});
}

/**
 * Normalise a candidate display name, or return null when there is none worth
 * showing.
 *
 * A "name" that is just the address again (`"bob@x.com" <bob@x.com>`, common
 * from automated senders) is not a name: storing it would make the list show
 * the raw address where it would otherwise show the humanised one.
 */
export function cleanSenderName(
	name: string | null | undefined,
	address?: string | null,
): string | null {
	if (!name) return null;
	let cleaned = decodeMimeWords(name)
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	// Strip one layer of quoting, then unescape quoted-pair backslashes.
	if (cleaned.length >= 2 && cleaned.startsWith('"') && cleaned.endsWith('"')) {
		cleaned = cleaned.slice(1, -1).trim();
	}
	if (cleaned.length >= 2 && cleaned.startsWith("'") && cleaned.endsWith("'")) {
		cleaned = cleaned.slice(1, -1).trim();
	}
	cleaned = cleaned.replace(/\\(.)/g, "$1");
	if (!cleaned) return null;

	const bare = cleaned.replace(/^<|>$/g, "").toLowerCase();
	if (address && bare === address.trim().toLowerCase()) return null;
	// A name that is nothing but an address — someone else's — is not shown either.
	if (/^[^\s@<>]+@[^\s@<>]+$/.test(bare)) return null;

	const points = Array.from(cleaned);
	return points.length > SENDER_NAME_MAX_CHARS
		? points.slice(0, SENDER_NAME_MAX_CHARS).join("").trimEnd()
		: cleaned;
}

/**
 * Split a `From:`-style header value into name and address.
 *
 * Handles the shapes that actually arrive: `Name <addr>`, `"Last, First"
 * <addr>`, a bare `addr`, and the obsolete `addr (Name)` comment form. Only the
 * first mailbox of a list is considered, since `From` names the author.
 */
export function parseFromHeader(
	value: string | null | undefined,
): { name: string | null; address: string | null } {
	if (!value) return { name: null, address: null };
	const header = value.replace(/\r?\n[ \t]+/g, " ").trim();

	const angle = /^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>/.exec(header);
	if (angle) {
		const address = angle[2].toLowerCase();
		return { name: cleanSenderName(angle[1], address), address };
	}

	const comment = /^\s*([^\s()<>]+@[^\s()<>,]+)\s*\(([^()]*)\)/.exec(header);
	if (comment) {
		const address = comment[1].toLowerCase();
		return { name: cleanSenderName(comment[2], address), address };
	}

	const bare = /([^\s<>,"]+@[^\s<>,"]+)/.exec(header);
	return { name: null, address: bare ? bare[1].toLowerCase() : null };
}

/**
 * The sender's display name from a stored `raw_headers` JSON array.
 *
 * Returns null for anything unparseable rather than throwing: this runs during
 * a backfill over every legacy row, and one malformed blob must not stop it.
 */
export function senderNameFromRawHeaders(
	rawHeaders: string | null | undefined,
	senderAddress?: string | null,
): string | null {
	if (!rawHeaders) return null;
	let headers: unknown;
	try {
		headers = JSON.parse(rawHeaders);
	} catch {
		return null;
	}
	if (!Array.isArray(headers)) return null;
	const from = headers.find(
		(h): h is { key: string; value: string } =>
			!!h &&
			typeof h === "object" &&
			typeof (h as { key?: unknown }).key === "string" &&
			(h as { key: string }).key.toLowerCase() === "from" &&
			typeof (h as { value?: unknown }).value === "string",
	);
	if (!from) return null;
	const parsed = parseFromHeader(from.value);
	if (!parsed.name) return null;
	// The header is the source of truth for the name only when it names the
	// same address the row was filed under.
	if (senderAddress && parsed.address && parsed.address !== senderAddress.trim().toLowerCase()) {
		return null;
	}
	return parsed.name;
}

/** The display name an outbound `from` field carries, or null. */
export function senderNameFromOutbound(
	from: string | { email: string; name?: string | null } | null | undefined,
): string | null {
	if (!from) return null;
	if (typeof from === "string") return parseFromHeader(from).name;
	return cleanSenderName(from.name ?? null, from.email);
}
