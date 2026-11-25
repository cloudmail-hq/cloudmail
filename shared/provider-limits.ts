/**
 * Per-message limits for the bring-your-own providers (Amazon SES v2 Simple
 * content, and Resend), checked before any request so a message the provider
 * would refuse fails as a definite rejection with nothing sent.
 *
 * The Cloudflare rules stay in `./send-validation.ts`. These differ: 40 MB
 * after base64 instead of 5 MiB, at most 15 custom headers with printable
 * ASCII values of at most 995 characters, no executable attachments.
 *
 * Sources: SES research §1.1 and §1.3 (MessageHeader, Attachment, quotas);
 * Resend research Decision 10. The same rules are applied to Resend: its
 * documented size and recipient limits match, and Resend sends through SES.
 */

import { SendValidationError, countAddresses } from "./send-validation";
import { MESSAGE_OVERHEAD_RESERVE_BYTES, formatBytesShort, utf8Size } from "./limits";

export type ProviderName = "Amazon SES" | "Resend";

/** 40 MB per message after base64 encoding (SES v2, Resend). */
export const PROVIDER_MAX_MESSAGE_BYTES = 40_000_000;
/** To + Cc + Bcc. */
export const PROVIDER_MAX_RECIPIENTS = 50;
/** Custom headers in SES Simple content. */
export const PROVIDER_MAX_HEADERS = 15;
/** One header value, characters. */
export const PROVIDER_MAX_HEADER_VALUE = 995;
/** Name plus value, characters. */
export const PROVIDER_MAX_HEADER_LINE = 996;
/** One header name, characters. */
export const PROVIDER_MAX_HEADER_NAME = 126;
/** MIME parts per message. */
export const PROVIDER_MAX_PARTS = 500;

/** SES `MessageHeader.Name`: printable ASCII 33–126 except `:`. */
const HEADER_NAME = /^[!-9;-@A-~]+$/;
/** SES `MessageHeader.Value`: printable ASCII. */
const HEADER_VALUE = /^[ -~]*$/;

/** Headers SES refuses as custom headers in Simple mode (they are API fields or SES's own). */
export const PROVIDER_RESERVED_HEADERS: ReadonlySet<string> = new Set([
	"bcc",
	"cc",
	"content-disposition",
	"content-type",
	"date",
	"from",
	"message-id",
	"mime-version",
	"reply-to",
	"return-path",
	"subject",
	"to",
	"sender",
	"content-transfer-encoding",
]);

/** Attachment extensions SES refuses (research §1.1). */
export const BLOCKED_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set(
	(
		"ade adp app asp bas bat cer chm cmd com cpl crt csh der exe fxp gadget hlp hta inf ins isp its js jse ksh " +
		"lib lnk mad maf mag mam maq mar mas mat mau mav maw mda mdb mde mdt mdw mdz msc msh msh1 msh2 mshxml " +
		"msh1xml msh2xml msi msp mst ops pcd pif plg prf prg reg scf scr sct shb shs sys ps1 ps1xml ps2 ps2xml " +
		"psc1 psc2 tmp url vb vbe vbs vps vsmacros vss vst vsw vxd ws wsc wsf wsh xnk"
	).split(" "),
);

/** The lower-case extension of a file name, without the dot, or "". */
export function extensionOf(filename: string): string {
	const base = filename.trim().replace(/[.\s]+$/, "");
	const dot = base.lastIndexOf(".");
	return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

export interface ProviderMessage {
	to: string | string[] | null | undefined;
	cc?: string | string[] | null;
	bcc?: string | string[] | null;
	html?: string | null;
	text?: string | null;
	attachments?: { content: string; filename?: string }[] | null;
	headers?: Record<string, string> | null;
}

/**
 * Encode a non-ASCII header value as RFC 2047 encoded-words (UTF-8, base64),
 * each at most 75 characters, separated by a space. ASCII values pass through.
 * Used for unstructured values such as a `List-Id` phrase; structured headers
 * we send (`In-Reply-To`, `References`, `List-Unsubscribe`) are ASCII already.
 */
export function encodeHeaderWords(value: string): string {
	if (HEADER_VALUE.test(value)) return value;
	const words: string[] = [];
	const bytes = new TextEncoder().encode(value);
	// 75 - "=?UTF-8?B?".length - "?=".length = 63 base64 chars, so 45 bytes per
	// word; never split a UTF-8 sequence across two words.
	let i = 0;
	while (i < bytes.length) {
		let end = Math.min(i + 45, bytes.length);
		while (end < bytes.length && end > i && (bytes[end]! & 0xc0) === 0x80) end--;
		let bin = "";
		for (const b of bytes.subarray(i, end)) bin += String.fromCharCode(b);
		words.push(`=?UTF-8?B?${btoa(bin)}?=`);
		i = end;
	}
	return words.join(" ");
}

/**
 * Trim a `References` value (`<a> <b> ...`) to `max` characters, keeping the
 * first id and as many of the newest as fit (RFC 5322 §3.6.4 allows trimming).
 */
export function trimReferences(value: string, max: number): string {
	if (value.length <= max) return value;
	const ids = value.split(/\s+/).filter(Boolean);
	if (ids.length === 0) return "";
	const first = ids[0]!;
	if (first.length > max) return "";
	const tail: string[] = [];
	let len = first.length;
	for (let i = ids.length - 1; i > 0; i--) {
		const add = ids[i]!.length + 1;
		if (len + add > max) break;
		tail.unshift(ids[i]!);
		len += add;
	}
	return [first, ...tail].join(" ");
}

/**
 * The headers as they will be sent: non-ASCII values encoded, `References`
 * trimmed to fit the 996-character line. Validation runs on this form.
 */
export function providerHeaders(headers: Record<string, string> | null | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, raw] of Object.entries(headers ?? {})) {
		if (typeof raw !== "string") {
			out[name] = raw as unknown as string;
			continue;
		}
		// A line break is refused, never encoded away: it means someone tried to
		// add a header through a value.
		if (/[\r\n\0]/.test(raw)) {
			out[name] = raw;
			continue;
		}
		let value = encodeHeaderWords(raw);
		if (name.toLowerCase() === "references") {
			value = trimReferences(value, Math.min(PROVIDER_MAX_HEADER_VALUE, PROVIDER_MAX_HEADER_LINE - name.length));
		}
		out[name] = value;
	}
	return out;
}

/** Validate already-mapped headers (see {@link providerHeaders}). */
export function validateProviderHeaders(headers: Record<string, string>, provider: ProviderName): void {
	const entries = Object.entries(headers);
	if (entries.length > PROVIDER_MAX_HEADERS) {
		throw new SendValidationError(
			"E_HEADERS_TOO_MANY",
			`${entries.length} custom headers; ${provider} allows at most ${PROVIDER_MAX_HEADERS}.`,
		);
	}
	const seen = new Set<string>();
	for (const [name, value] of entries) {
		if (!name || name.length > PROVIDER_MAX_HEADER_NAME || !HEADER_NAME.test(name)) {
			throw new SendValidationError("E_HEADER_NAME_INVALID", `Header name '${name.slice(0, 40)}' is not valid.`);
		}
		const lower = name.toLowerCase();
		if (PROVIDER_RESERVED_HEADERS.has(lower)) {
			throw new SendValidationError(
				"E_HEADER_NOT_ALLOWED",
				`Header '${name}' can't be set as a custom header with ${provider}.`,
			);
		}
		if (seen.has(lower)) {
			throw new SendValidationError("E_HEADER_NOT_ALLOWED", `Header '${name}' appears more than once.`);
		}
		seen.add(lower);
		if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value) || !HEADER_VALUE.test(value)) {
			throw new SendValidationError(
				"E_HEADER_VALUE_INVALID",
				`Header '${name}' has an invalid value (it must be one line of printable ASCII).`,
			);
		}
		if (value.length > PROVIDER_MAX_HEADER_VALUE || name.length + value.length > PROVIDER_MAX_HEADER_LINE) {
			throw new SendValidationError(
				"E_HEADER_VALUE_TOO_LONG",
				`Header '${name}' is ${value.length} characters; ${provider} allows ${PROVIDER_MAX_HEADER_VALUE} (and ${PROVIDER_MAX_HEADER_LINE} with the name).`,
			);
		}
	}
}

/** Estimated size after base64 and MIME folding, the figure the 40 MB limit applies to. */
export function providerMessageBytes(message: ProviderMessage): number {
	const attachments = (message.attachments ?? []).reduce((sum, a) => sum + Math.ceil(a.content.length * 1.0263), 0);
	return MESSAGE_OVERHEAD_RESERVE_BYTES + utf8Size(message.html) + utf8Size(message.text) + attachments;
}

/** Throw `SendValidationError` when SES (or Resend) would refuse this message. */
export function validateProviderMessage(message: ProviderMessage, provider: ProviderName): void {
	const recipients = countAddresses(message.to) + countAddresses(message.cc) + countAddresses(message.bcc);
	if (recipients > PROVIDER_MAX_RECIPIENTS) {
		throw new SendValidationError(
			"E_TOO_MANY_RECIPIENTS",
			`Too many recipients: ${recipients} across To, Cc and Bcc. ${provider} allows at most ${PROVIDER_MAX_RECIPIENTS} per message.`,
		);
	}
	const attachments = message.attachments ?? [];
	// multipart/mixed + multipart/alternative + text + html, then one per attachment.
	const parts = 4 + attachments.length;
	if (parts > PROVIDER_MAX_PARTS) {
		throw new SendValidationError(
			"E_TOO_MANY_PARTS",
			`Too many attachments: ${attachments.length}. ${provider} allows at most ${PROVIDER_MAX_PARTS} MIME parts per message.`,
		);
	}
	for (const a of attachments) {
		const ext = extensionOf(a.filename ?? "");
		if (BLOCKED_ATTACHMENT_EXTENSIONS.has(ext)) {
			throw new SendValidationError(
				"E_ATTACHMENT_BLOCKED",
				`${provider} doesn't accept .${ext} attachments ('${(a.filename ?? "").slice(0, 80)}'). Zip the file or send a link instead.`,
			);
		}
	}
	const size = providerMessageBytes(message);
	if (size > PROVIDER_MAX_MESSAGE_BYTES) {
		throw new SendValidationError(
			"E_CONTENT_TOO_LARGE",
			`Message is too large to send: ~${formatBytesShort(size)} exceeds ${provider}'s 40 MB limit (attachments are base64-encoded, which adds about 37%).`,
		);
	}
	validateProviderHeaders(providerHeaders(message.headers), provider);
}
