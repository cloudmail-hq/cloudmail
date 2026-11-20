// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Mail import: the pure parts, shared by the Worker, the UI and the tests.
 *
 * Gmailify and POP fetch shut down in 2026, so moving years of old mail in is
 * the first thing a new user needs. Three sources: an mbox file (Google
 * Takeout produces one), a zip of `.eml` files or a single `.eml`, and an IMAP
 * account. Everything here is free of I/O: splitting an mbox window into
 * messages, mapping Gmail labels and IMAP folders onto folders and labels, and
 * validating an IMAP host.
 *
 * ## mbox, and why a window
 *
 * Takeout files run to several GB, far more than a Worker may hold. The job
 * reads the file from R2 in byte ranges, and `splitMboxWindow` turns one range
 * into the complete messages it contains plus the offset where the first
 * incomplete one starts. That offset is the resume cursor: the next run reads
 * from it, so an interrupted import picks up at the message it was on.
 */

import { decodeMimeWords } from "./sender-name";
import { validateWebhookUrl } from "./webhooks";

// ── Limits ──────────────────────────────────────────────────────────

/** Largest single message imported; the same cap inbound mail has. */
export const IMPORT_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
/** Largest upload accepted (R2 multipart: 10,000 parts). */
export const IMPORT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024 * 1024;
/** Upload part size bounds. R2 needs at least 5 MiB for every part but the last. */
export const IMPORT_MIN_PART_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_PART_BYTES = 50 * 1024 * 1024;
export const IMPORT_DEFAULT_PART_BYTES = 10 * 1024 * 1024;
export const IMPORT_MAX_PARTS = 10_000;

export const IMPORT_SOURCES = ["mbox", "zip", "eml", "imap"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];
export const IMPORT_FILE_SOURCES = ["mbox", "zip", "eml"] as const;
export type ImportFileSource = (typeof IMPORT_FILE_SOURCES)[number];

export const IMPORT_STATUSES = [
	"uploading",
	"queued",
	"running",
	"paused",
	"completed",
	"failed",
	"cancelled",
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** Statuses a job never leaves. */
export const TERMINAL_IMPORT_STATUSES: readonly ImportStatus[] = ["completed", "failed", "cancelled"];

export function isTerminalImportStatus(status: string): boolean {
	return (TERMINAL_IMPORT_STATUSES as readonly string[]).includes(status);
}

/** Everything the API and UI show about a job. Never carries a credential. */
export interface ImportJobView {
	id: string;
	source: ImportSource;
	status: ImportStatus;
	/** Upload filename, or `user@host` for IMAP. */
	label: string;
	created_at: string;
	updated_at: string;
	started_at: string | null;
	finished_at: string | null;
	/** Bytes of the uploaded file (file sources). */
	size_bytes: number | null;
	/** Upload progress, file sources only. */
	upload: { part_size: number; parts_uploaded: number; parts_total: number } | null;
	counts: { imported: number; duplicates: number; failed: number; skipped: number };
	/** Estimated messages or bytes still to go; null while unknown. */
	progress: { done: number; total: number | null; unit: "bytes" | "messages" };
	last_error: string | null;
	imap: { host: string; username: string; folders_total: number; folders_done: number; current_folder: string | null } | null;
}

// ── mbox ────────────────────────────────────────────────────────────

/** One message found in an mbox window. Offsets are absolute in the file. */
export interface MboxMessage {
	/** Offset of the `From ` separator line. */
	start: number;
	/** Offset just past the message (where the next separator begins, or EOF). */
	end: number;
	/** The RFC 5322 message, separator removed and `>From ` unquoted. */
	raw: Uint8Array;
}

export interface MboxWindowResult {
	messages: MboxMessage[];
	/**
	 * Where the next window must start: the separator of the first message not
	 * returned, or the end of the window at EOF.
	 */
	next: number;
	/** The window ended inside a message that is still going (no separator yet). */
	incomplete: boolean;
	/** Absolute offset of the first separator seen in the window, or null. */
	firstSeparator: number | null;
}

const LF = 0x0a;
const CR = 0x0d;

/** `From ` at `i`, byte-wise. */
function startsWithFrom(buf: Uint8Array, i: number): boolean {
	return (
		buf[i] === 0x46 && // F
		buf[i + 1] === 0x72 && // r
		buf[i + 2] === 0x6f && // o
		buf[i + 3] === 0x6d && // m
		buf[i + 4] === 0x20 // space
	);
}

/** asctime-ish tail on a separator: a 4-digit year somewhere after the sender. */
const SEPARATOR_DATE = /\b(19|20)\d{2}\b|\d{1,2}:\d{2}/;

/**
 * Whether the line starting at `i` is a message separator.
 *
 * RFC 4155: a `From ` line that follows a blank line (or starts the file). Some
 * writers (older Thunderbird, a few exporters) omit the blank line, so a
 * `From ` line that also looks like `From sender date` is accepted without one.
 * A body line that begins `From ` is quoted to `>From ` by every conforming
 * writer, so it never reaches this test.
 */
function isSeparatorAt(buf: Uint8Array, i: number, lineEnd: number, prevBlank: boolean): boolean {
	if (!startsWithFrom(buf, i)) return false;
	if (prevBlank) return true;
	const line = new TextDecoder("latin1").decode(buf.subarray(i, Math.min(lineEnd, i + 200)));
	return /^From \S+\s+\S/.test(line) && SEPARATOR_DATE.test(line);
}

/** Index of the next LF at or after `from`, or -1. */
function indexOfLf(buf: Uint8Array, from: number): number {
	return buf.indexOf(LF, from);
}

/**
 * Remove the separator line, drop the blank line that precedes the next
 * separator, and undo mboxrd quoting (`>From ` → `From `, `>>From ` → `>From `).
 */
export function unquoteMboxMessage(body: Uint8Array): Uint8Array {
	const out = new Uint8Array(body.length);
	let o = 0;
	let i = 0;
	while (i < body.length) {
		let end = indexOfLf(body, i);
		end = end === -1 ? body.length : end + 1;
		// A line of one or more '>' followed by "From " loses one '>'.
		let j = i;
		while (j < end && body[j] === 0x3e) j++;
		if (j > i && startsWithFrom(body, j)) {
			out.set(body.subarray(i + 1, end), o);
			o += end - i - 1;
		} else {
			out.set(body.subarray(i, end), o);
			o += end - i;
		}
		i = end;
	}
	return out.subarray(0, o);
}

/** Trim one trailing line break (the separator's blank line belongs to the format). */
function trimSeparatorNewline(buf: Uint8Array): Uint8Array {
	let end = buf.length;
	if (end > 0 && buf[end - 1] === LF) {
		end--;
		if (end > 0 && buf[end - 1] === CR) end--;
	}
	return buf.subarray(0, end);
}

/**
 * Split one window of an mbox file.
 *
 * `window` must begin at a separator (or at the start of the file); `base` is
 * its absolute offset. When `eof` is false, the last message is only returned
 * if a following separator proves it complete. Otherwise it is left for the
 * next window, whose start is `next`.
 *
 * Handles LF and CRLF line endings, `>From ` quoting, a final message without a
 * trailing newline, and junk before the first separator (skipped).
 */
export function splitMboxWindow(window: Uint8Array, base: number, eof: boolean): MboxWindowResult {
	const separators: number[] = [];
	let i = 0;
	let prevBlank = true;
	while (i < window.length) {
		const lf = indexOfLf(window, i);
		const lineEnd = lf === -1 ? window.length : lf;
		// A line still being written at the window edge cannot be judged yet.
		if (lf === -1 && !eof) break;
		if (isSeparatorAt(window, i, lineEnd, prevBlank)) separators.push(i);
		const contentEnd = lineEnd > i && window[lineEnd - 1] === CR ? lineEnd - 1 : lineEnd;
		prevBlank = contentEnd === i;
		i = lf === -1 ? window.length : lf + 1;
	}

	const messages: MboxMessage[] = [];
	for (let s = 0; s < separators.length; s++) {
		const start = separators[s];
		const isLast = s === separators.length - 1;
		if (isLast && !eof) break;
		const end = isLast ? window.length : separators[s + 1];
		const lineLf = indexOfLf(window, start);
		const bodyStart = lineLf === -1 || lineLf >= end ? end : lineLf + 1;
		let body = window.subarray(bodyStart, end);
		if (!isLast) body = trimSeparatorNewline(body);
		messages.push({ start: base + start, end: base + end, raw: unquoteMboxMessage(body) });
	}

	const firstSeparator = separators.length > 0 ? base + separators[0] : null;
	if (eof) {
		return { messages, next: base + window.length, incomplete: false, firstSeparator };
	}
	const pending = separators.length > messages.length ? separators[messages.length] : null;
	if (pending !== null) {
		return { messages, next: base + pending, incomplete: messages.length === 0, firstSeparator };
	}
	// No separator at all in this window: everything is junk before the first
	// message, or the tail of one we are skipping.
	return { messages, next: base + Math.max(0, i), incomplete: true, firstSeparator };
}

/**
 * Offset of the first separator in `window` after its first line, for skipping
 * past a message too large to import. -1 when there is none yet.
 */
export function findNextSeparator(window: Uint8Array, eof: boolean): number {
	let i = indexOfLf(window, 0);
	if (i === -1) return -1;
	i += 1;
	let prevBlank = false;
	while (i < window.length) {
		const lf = indexOfLf(window, i);
		if (lf === -1 && !eof) return -1;
		const lineEnd = lf === -1 ? window.length : lf;
		if (isSeparatorAt(window, i, lineEnd, prevBlank)) return i;
		const contentEnd = lineEnd > i && window[lineEnd - 1] === CR ? lineEnd - 1 : lineEnd;
		prevBlank = contentEnd === i;
		i = lf === -1 ? window.length : lf + 1;
	}
	return -1;
}

// ── Gmail labels ────────────────────────────────────────────────────

/** Where an imported message is filed and how it is marked. */
export interface ImportPlacement {
	folder: "inbox" | "sent" | "archive" | "spam" | "trash";
	/** Label names to apply, created when missing. */
	labels: string[];
	read: boolean;
	starred: boolean;
}

/**
 * Split an `X-Gmail-Labels` value.
 *
 * Comma separated; a label containing a comma is quoted (`"Work, Clients"`),
 * and non-ASCII names arrive as RFC 2047 encoded words.
 */
export function parseGmailLabels(value: string | null | undefined): string[] {
	if (!value) return [];
	const out: string[] = [];
	let current = "";
	let quoted = false;
	const unfolded = value.replace(/\r?\n[ \t]+/g, " ");
	for (let i = 0; i < unfolded.length; i++) {
		const ch = unfolded[i];
		if (ch === '"') {
			quoted = !quoted;
			continue;
		}
		if (ch === "\\" && quoted && i + 1 < unfolded.length) {
			current += unfolded[++i];
			continue;
		}
		if (ch === "," && !quoted) {
			out.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	out.push(current);
	return out.map((l) => decodeMimeWords(l.trim())).filter((l) => l.length > 0);
}

/** Gmail's category labels, as Takeout writes them, to the label shown here. */
const GMAIL_CATEGORIES: Record<string, string | null> = {
	"category personal": null,
	"category promotions": "Promotions",
	"category social": "Social",
	"category updates": "Updates",
	"category forums": "Forums",
	"category purchases": "Purchases",
	"category reservations": "Reservations",
};

/** System labels that carry state rather than a user's filing. */
const GMAIL_DROPPED = new Set(["important", "opened", "unread", "starred", "inbox", "sent", "spam", "trash", "archived"]);

/** Longest label name kept; anything past this is truncated. */
export const IMPORT_LABEL_MAX_CHARS = 80;

function cleanLabel(name: string): string | null {
	// Control characters never belong in a label, and a label is shown as-is.
	const trimmed = name.replace(/[\x00-\x1f\x7f]/g, "").trim();
	if (!trimmed) return null;
	return trimmed.slice(0, IMPORT_LABEL_MAX_CHARS);
}

/**
 * Map Takeout's `X-Gmail-Labels` onto a folder, labels and flags.
 *
 * Folder precedence follows what the user saw last: Trash, then Spam, then
 * Inbox, then Sent, otherwise Archive (in Gmail, mail without Inbox is
 * archived). `Unread` marks it unread; `Starred` stars it; drafts and chats
 * keep a label so they are findable and are filed in Archive, never Drafts,
 * where a stale draft could be sent by accident.
 */
export function placementFromGmailLabels(labels: string[]): ImportPlacement {
	const lower = new Set(labels.map((l) => l.toLowerCase()));
	const has = (l: string) => lower.has(l);
	let folder: ImportPlacement["folder"] = "archive";
	if (has("trash")) folder = "trash";
	else if (has("spam")) folder = "spam";
	else if (has("inbox")) folder = "inbox";
	else if (has("sent")) folder = "sent";

	const out: string[] = [];
	for (const raw of labels) {
		const key = raw.toLowerCase();
		if (GMAIL_DROPPED.has(key)) continue;
		if (key in GMAIL_CATEGORIES) {
			const mapped = GMAIL_CATEGORIES[key];
			if (mapped) out.push(mapped);
			continue;
		}
		if (key === "draft" || key === "drafts") {
			out.push("Drafts");
			continue;
		}
		const cleaned = cleanLabel(raw);
		if (cleaned) out.push(cleaned);
	}
	return {
		folder,
		labels: [...new Set(out)],
		read: !has("unread"),
		starred: has("starred"),
	};
}

// ── IMAP folders ────────────────────────────────────────────────────

/** How one IMAP mailbox is imported. `skip` mailboxes are never selected. */
export interface ImapFolderPlan {
	name: string;
	folder: ImportPlacement["folder"];
	/** Label applied to every message from this mailbox, or null. */
	label: string | null;
	skip: boolean;
	/** Import order: Inbox first, catch-alls last so labels land on real copies. */
	order: number;
}

/**
 * Plan an IMAP mailbox from its LIST attributes (RFC 6154 special-use) and
 * name. Gmail's `[Gmail]/All Mail` is imported last, into Archive, so mail that
 * was only in All Mail is kept while every message seen in a labelled folder
 * first gets that label (the duplicate in All Mail is then skipped).
 */
export function planImapFolder(name: string, attributes: string[], delimiter: string | null): ImapFolderPlan {
	const attrs = new Set(attributes.map((a) => a.toLowerCase()));
	const lower = name.toLowerCase();
	const leaf = delimiter ? name.split(delimiter).pop() ?? name : name;
	const plan = (folder: ImapFolderPlan["folder"], label: string | null, order: number, skip = false): ImapFolderPlan => ({
		name,
		folder,
		label,
		skip,
		order,
	});

	if (attrs.has("\\noselect") || attrs.has("\\nonexistent")) return plan("archive", null, 99, true);
	if (lower === "inbox") return plan("inbox", null, 0);
	if (attrs.has("\\drafts") || /^(drafts?|\[gmail\]\/drafts)$/i.test(name)) return plan("archive", null, 99, true);
	// Virtual views of mail that is also elsewhere: flags carry the meaning.
	if (attrs.has("\\flagged") || attrs.has("\\important")) return plan("archive", null, 99, true);
	if (attrs.has("\\sent") || /^(sent( items| mail| messages)?|\[gmail\]\/sent mail)$/i.test(name)) return plan("sent", null, 2);
	if (attrs.has("\\junk") || /^(spam|junk( e-?mail)?|bulk mail|\[gmail\]\/spam)$/i.test(name)) return plan("spam", null, 3);
	if (attrs.has("\\trash") || /^(trash|deleted( items| messages)?|bin|\[gmail\]\/(trash|bin))$/i.test(name)) return plan("trash", null, 4);
	if (attrs.has("\\all") || /^\[gmail\]\/all mail$/i.test(name)) return plan("archive", null, 6);
	if (attrs.has("\\archive") || /^archives?$/i.test(name)) return plan("archive", null, 5);
	// `[Gmail]` itself is \Noselect (handled above); any other `[Gmail]/…` view
	// (Starred, Important, Chats) is skipped as a duplicate of real mail.
	if (/^\[(gmail|google mail)\]\//i.test(name)) return plan("archive", null, 99, true);
	return plan("archive", cleanLabel(delimiter ? name.split(delimiter).join("/") : leaf), 1);
}

// ── IMAP host guard ─────────────────────────────────────────────────

export const IMAP_PORT = 993;

export type ImapHostCheck = { ok: true; host: string } | { ok: false; error: string };

/**
 * Validate the IMAP host a user typed.
 *
 * The import opens a TCP connection to it from inside Cloudflare, so this is
 * an SSRF guard: a bare public hostname or IP only, no port, path or
 * credentials, and nothing private, loopback, link-local, CGNAT, metadata or
 * internal-suffixed. The checks are the webhook URL validator's (#102), run on
 * `https://<host>/`; the port is fixed at 993 with TLS elsewhere.
 */
export function validateImapHost(raw: string): ImapHostCheck {
	const input = (raw ?? "").trim().toLowerCase().replace(/\.$/, "");
	if (!input) return { ok: false, error: "Enter the IMAP server's hostname." };
	if (input.length > 253) return { ok: false, error: "That hostname is too long." };
	// Bare hostnames and IPv4 only. Brackets would let an IPv6 literal through
	// the label check below; it is validated on its own.
	const isV6 = /^\[[0-9a-f:.]+\]$/.test(input);
	if (!isV6 && !/^[a-z0-9.-]+$/.test(input)) {
		return { ok: false, error: "Enter just the hostname, like imap.example.com (no port, scheme or path)." };
	}
	const check = validateWebhookUrl(`https://${input}/`);
	if (!check.ok) {
		return { ok: false, error: check.error.replace("Webhook URLs must use https://.", "Invalid host.") };
	}
	const parsed = new URL(check.url);
	if (parsed.port !== "" || parsed.pathname !== "/") return { ok: false, error: "Enter just the hostname." };
	return { ok: true, host: parsed.hostname };
}

/** Folder ids an import may file into, in display order. */
export const IMPORT_FOLDERS = ["inbox", "sent", "archive", "spam", "trash"] as const;
