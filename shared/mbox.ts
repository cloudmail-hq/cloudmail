// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Writing a mailbox out as mbox.
 *
 * ## Why mbox
 *
 * "Let me have my mail" is the one feature whose absence is not a missing
 * convenience but a lock-in. Gmail answers it with Takeout, which produces mbox;
 * Thunderbird, Apple Mail and every migration tool read mbox. Under GDPR Article
 * 20 a data-portability request has to be answerable in "a structured, commonly
 * used and machine-readable format", and for mail that means this file format.
 *
 * The format itself is barely a format: messages concatenated, each preceded by a
 * line beginning `From `, separated by a blank line. It is described in
 * [RFC 4155](https://www.rfc-editor.org/rfc/rfc4155.txt), which registers the
 * `application/mbox` media type and pins the details that actually matter for
 * interoperability.
 *
 * ## The one thing implementations get wrong
 *
 * A line in the *message body* that begins with `From ` is indistinguishable from
 * the separator that starts the next message. A reader hitting one splits one
 * message into two, and everything after it is misattributed. RFC 4155 §3 calls
 * for the `mboxo` quoting that fixes it: prefix such a line with `>`. This costs
 * a byte on the rare line that needs it and prevents silent corruption of the
 * archive, which is the whole point of having one.
 *
 * `mboxrd`, the variant that also quotes already-quoted `>From ` lines so the
 * transformation is reversible, is what this implements — see `quoteFromLines`.
 *
 * ## What an exported message contains
 *
 * As much as was stored. The original MIME is not kept — see the note on
 * `messageToMbox` — so each message is reconstructed from its columns and its
 * `raw_headers` blob. That is enough to be read by any mail client and to satisfy
 * a portability request, and it is honest about not being a byte-exact original.
 */

import { formatHeaderLines, parseStoredHeaders, type StoredHeader } from "./headers";

/** The `From ` line that opens each message (RFC 4155 §2). */
export function mboxFromLine(sender: string | null | undefined, date: string | null | undefined): string {
	// RFC 4155 wants an envelope sender and a UTC ctime-format date. A message with
	// no sender still needs the line, so it gets the placeholder every mbox writer
	// uses for one.
	const address = (sender || "MAILER-DAEMON").trim().replace(/\s+/g, "") || "MAILER-DAEMON";

	const parsed = date ? new Date(date) : null;
	const when =
		parsed && !Number.isNaN(parsed.getTime())
			? // asctime: "Mon Jan  2 15:04:05 2006". `toUTCString` is the wrong shape,
				// and a wrong-shaped date makes some readers reject the separator.
				formatAsctime(parsed)
			: formatAsctime(new Date(0));

	return `From ${address} ${when}`;
}

/** ctime/asctime format, which is what the `From ` line carries. */
function formatAsctime(date: Date): string {
	const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	const months = [
		"Jan",
		"Feb",
		"Mar",
		"Apr",
		"May",
		"Jun",
		"Jul",
		"Aug",
		"Sep",
		"Oct",
		"Nov",
		"Dec",
	];

	const pad = (n: number) => String(n).padStart(2, "0");
	// Day of month is space-padded, not zero-padded, in asctime.
	const day = String(date.getUTCDate()).padStart(2, " ");

	return [
		days[date.getUTCDay()],
		months[date.getUTCMonth()],
		day,
		`${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`,
		date.getUTCFullYear(),
	].join(" ");
}

/**
 * Quote body lines that would otherwise be read as message separators.
 *
 * `mboxrd`: a line matching `>*From ` gains one more `>`. Quoting the
 * already-quoted forms as well as the bare one is what makes the transformation
 * reversible — a reader can strip exactly one `>` from any `>+From ` line and
 * recover the original text. The `mboxo` variant quotes only bare `From `, which
 * loses the distinction between a body line that started `>From ` and one that
 * started `From `.
 *
 * Without this, a message whose body contains a line like
 * `From the desk of the CEO:` splits the archive at that point and every message
 * after it is attributed to the wrong sender.
 */
export function quoteFromLines(body: string): string {
	return body.replace(/^(>*From )/gm, ">$1");
}

/** A message as the export path reads it out of the database. */
export interface ExportableMessage {
	id: string;
	subject?: string | null;
	sender?: string | null;
	recipient?: string | null;
	cc?: string | null;
	bcc?: string | null;
	date?: string | null;
	body?: string | null;
	message_id?: string | null;
	in_reply_to?: string | null;
	email_references?: string | null;
	raw_headers?: string | null;
	folder_id?: string | null;
	read?: number | boolean | null;
	starred?: number | boolean | null;
}

/**
 * Headers describing the *original* MIME structure, which the export must not
 * carry over.
 *
 * The stored body is not the original bytes: the inbound path saves
 * `parsedEmail.html || parsedEmail.text`, already decoded and with the multipart
 * container discarded. So the original `Content-Type: multipart/alternative;
 * boundary="XYZ"` describes a structure the exported message does not have — a
 * reader looking for that boundary finds none and shows the message as blank. A
 * retained `Content-Transfer-Encoding: base64` is worse: the client base64-decodes
 * text that is already plain, and renders rubbish.
 *
 * These are dropped and replaced with headers describing what is actually being
 * written. Everything else the sender set is preserved.
 */
const MIME_STRUCTURE_HEADERS = new Set([
	"content-type",
	"content-transfer-encoding",
	"content-disposition",
	"content-id",
	"content-description",
	// Not a real RFC 5322 header, but some gateways emit it and a stale byte count
	// over a rewritten body is actively misleading.
	"content-length",
	// MIME-Version is re-added below; dropping it here keeps the pairing obvious.
	"mime-version",
]);

/**
 * Headers synthesized from current mailbox state, which a stored blob must not
 * also supply.
 *
 * These are appended unconditionally at the end of `exportHeaders`, so a stored
 * value would survive alongside the fresh one. Clients disagree about which
 * duplicate wins, and the stored copy is by definition stale — a message read,
 * starred or moved since it arrived would export with its old state. An inbound
 * message can carry `Status` (some gateways add one), and a message imported from
 * another archive carries whatever that archive wrote.
 */
const SYNTHESIZED_HEADERS = new Set([
	"status",
	"x-status",
	"x-tapetide-folder",
	// Attachment names are rebuilt from the rows too.
	"x-tapetide-attachment",
]);

/**
 * Headers for one exported message.
 *
 * Stored headers are preferred, because they are what the sender actually sent.
 * They are then *topped up* rather than trusted to be complete: outbound messages
 * store only a handful of fields, and a message with no `Date` or `Subject` is
 * awkward to read in an archive. A field already present is never duplicated —
 * `Subject` appearing twice is malformed, and readers disagree about which wins.
 *
 * MIME structure headers are the exception to "preferred": they describe bytes
 * that no longer exist, so they are dropped and rebuilt. See
 * {@link MIME_STRUCTURE_HEADERS}.
 *
 * `X-Tapetide-Folder` and the status flags are added last. RFC 4155 has nothing
 * to say about folders, and mbox is a flat format, so the only way to preserve
 * where a message lived is an `X-` header. `Status`/`X-Status` are the de-facto
 * flags Thunderbird and mutt read, which is how "unread" survives the round trip.
 */
export function exportHeaders(message: ExportableMessage): StoredHeader[] {
	const headers = parseStoredHeaders(message.raw_headers).filter((header) => {
		const key = header.key.toLowerCase();
		return !MIME_STRUCTURE_HEADERS.has(key) && !SYNTHESIZED_HEADERS.has(key);
	});
	const present = new Set(headers.map((h) => h.key.toLowerCase()));

	const add = (key: string, value: string | null | undefined) => {
		if (!value || present.has(key.toLowerCase())) return;
		present.add(key.toLowerCase());
		headers.push({ key, value });
	};

	add("From", message.sender);
	add("To", message.recipient);
	add("Cc", message.cc);
	// Bcc is deliberately included. This is the owner's own archive of their own
	// mail, and a sent message's Bcc list is information they put there — dropping
	// it would quietly lose who a message actually went to.
	add("Bcc", message.bcc);
	add("Subject", message.subject);
	if (message.date) {
		const parsed = new Date(message.date);
		if (!Number.isNaN(parsed.getTime())) add("Date", parsed.toUTCString());
	}
	add("Message-ID", wrapMessageId(message.message_id));
	add("In-Reply-To", wrapMessageId(message.in_reply_to));
	add("References", referencesHeader(message.email_references));

	/**
	 * MIME headers describing the body actually written, not the one that arrived.
	 *
	 * Always emitted, because the originals were stripped above. `8bit` rather than
	 * `base64` or `quoted-printable`: the body is written as UTF-8 text and no
	 * transfer encoding is applied, so claiming one would make a client decode text
	 * that needs no decoding.
	 */
	headers.push({ key: "MIME-Version", value: "1.0" });
	headers.push({
		key: "Content-Type",
		value: looksLikeHtml(message.body)
			? 'text/html; charset="utf-8"'
			: 'text/plain; charset="utf-8"',
	});
	headers.push({ key: "Content-Transfer-Encoding", value: "8bit" });

	if (message.folder_id) {
		headers.push({ key: "X-Tapetide-Folder", value: message.folder_id });
	}
	// `R` = read, `O` = old (i.e. not new this session). An unread message gets
	// neither, which is how mutt and Thunderbird represent it.
	const read = message.read === 1 || message.read === true;
	headers.push({ key: "Status", value: read ? "RO" : "O" });
	if (message.starred === 1 || message.starred === true) {
		headers.push({ key: "X-Status", value: "F" });
	}

	return headers;
}

/**
 * Whether a stored body is HTML.
 *
 * Most are — anything this app sent, and any inbound message with an HTML part.
 * But a plain-text-only message is stored as plain text, and declaring that
 * `text/html` makes a client swallow the line breaks, turning a readable message
 * into one run-on paragraph.
 *
 * A tag-shaped match is enough. The cost of being wrong either way is cosmetic,
 * and this runs over every message in an export.
 */
function looksLikeHtml(body: string | null | undefined): boolean {
	return /<[a-z][\s\S]*>/i.test(body ?? "");
}

/** `<id>`, adding the angle brackets iff they are absent. */
function wrapMessageId(id: string | null | undefined): string | null {
	const trimmed = id?.trim();
	if (!trimmed) return null;
	return trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
}

/**
 * The `References` header from the stored JSON array.
 *
 * Stored as JSON, emitted as the space-separated bracketed list RFC 5322 §3.6.4
 * defines — the form that makes an archive thread correctly when it is imported
 * somewhere else.
 */
function referencesHeader(stored: string | null | undefined): string | null {
	if (!stored) return null;
	try {
		const parsed: unknown = JSON.parse(stored);
		if (!Array.isArray(parsed)) return null;
		const ids = parsed
			.filter((entry): entry is string => typeof entry === "string" && !!entry.trim())
			.map((entry) => wrapMessageId(entry))
			.filter((entry): entry is string => !!entry);
		return ids.length > 0 ? ids.join(" ") : null;
	} catch {
		return null;
	}
}

/**
 * One message as an mbox entry, including its trailing blank line.
 *
 * Not byte-exact with what arrived: the original MIME is not stored, so this is a
 * faithful reconstruction from the parsed columns rather than the bytes on the
 * wire. That is enough for a client to read and for a portability request, and it
 * is worth being explicit that a signature over the original body will not verify
 * against it.
 *
 * Attachments are not inlined. A mailbox's attachments can run to gigabytes,
 * base64 expands them by a third, and building a multipart body per message would
 * turn a streamable export into one that has to fetch every blob from R2 first.
 * Each attachment is named in an `X-Tapetide-Attachment` header so nothing is
 * silently absent from the archive.
 */
export function messageToMbox(
	message: ExportableMessage,
	attachments: { filename: string; mimetype: string; size: number }[] = [],
): string {
	const headers = exportHeaders(message);

	for (const attachment of attachments) {
		headers.push({
			key: "X-Tapetide-Attachment",
			value: `${attachment.filename}; type=${attachment.mimetype}; size=${attachment.size}`,
		});
	}

	// CRLF throughout: RFC 5322 line endings, which every reader accepts.
	const body = quoteFromLines((message.body ?? "").replace(/\r\n|\r|\n/g, "\r\n"));

	return [
		mboxFromLine(message.sender, message.date),
		formatHeaderLines(headers),
		"",
		body,
		"",
		"",
	].join("\r\n");
}
