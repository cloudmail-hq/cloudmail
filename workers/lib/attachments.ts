// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared attachment storage logic.
 * Eliminates the triplicated atob → Uint8Array → R2.put pattern.
 */
import type { Env } from "../types";

export interface StoredAttachment {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id: string | null;
	disposition: string;
	/**
	 * True when the part was refused and no blob was written.
	 *
	 * The row exists so the reader can be told the file was blocked rather than
	 * left wondering where it went. See `shared/attachment-types.ts`.
	 */
	blocked?: boolean;
}

/**
 * Characters that must not reach an R2 key: path separators, Windows-reserved
 * characters, and control characters.
 */
const UNSAFE_FILENAME_CHARS = /[\/\\:*?"<>|\x00-\x1f]/g;

/**
 * Normalise an attachment filename for safe use inside an R2 key.
 *
 * INVARIANT: apply this exactly once, on write, before the name is persisted to
 * the `attachments.filename` column. Never apply it again when rebuilding a key
 * for a read, delete, or purge — those must pass the stored value verbatim.
 *
 * The stored column is the authoritative record of what the key contains. If the
 * deny-list below is ever widened, re-sanitising on read would derive keys that
 * do not match blobs written under the previous rule, silently orphaning them.
 * Reading the column verbatim keeps working across sanitiser changes.
 *
 * `attachmentKeyRoundTrips` in test/attachments.test.ts pins this.
 */
export function sanitizeAttachmentFilename(filename: string | undefined | null): string {
	const base = filename || "untitled";
	const safe = base.replace(UNSAFE_FILENAME_CHARS, "_");
	// A name consisting solely of unsafe characters would collapse to "___",
	// which is valid; but an empty result would produce a trailing-slash key.
	return safe.length > 0 ? safe : "untitled";
}

/**
 * The canonical R2 key for an attachment blob.
 *
 * Single source of truth. Mailbox deletion enumerates attachment rows and
 * rebuilds keys with this function; if a write site formatted keys differently
 * the blobs would be orphaned in the bucket forever, since the bucket is shared
 * across mailboxes and cannot be swept by prefix.
 *
 * `filename` must be the value stored in `attachments.filename` — already
 * sanitised at write time. See `sanitizeAttachmentFilename`.
 */
export function attachmentKey(
	emailId: string,
	attachmentId: string,
	filename: string,
): string {
	return `attachments/${emailId}/${attachmentId}/${filename}`;
}

/**
 * Media types this app is willing to render inside its own origin.
 *
 * An allowlist, deliberately. This was a deny-list of types that execute script
 * — text/html, application/xhtml+xml, image/svg+xml and the two XML types — and
 * a deny-list is the wrong shape for the question being asked: it has to
 * enumerate every current and future type a browser might sniff as a document,
 * and anything it misses is served inline from this origin. `text/html;
 * charset=utf-8` slipped past nothing, but MHTML, XSLT, a namespaced XML type,
 * or whatever the next content-sniffing quirk turns out to be all did.
 *
 * Inbound mail carries attacker-controlled parts, so an inline miss is stored
 * XSS against every mailbox in the deployment. Downloading a file this list does
 * not name is a mild inconvenience; the inverse mistake is not recoverable.
 *
 * These six are what the reader actually needs inline: the `cid:` images
 * rewritten into message bodies, and the preview overlay's PDF and plain text.
 */
const INLINE_SAFE_TYPES: Record<string, true> = {
	"image/png": true,
	"image/jpeg": true,
	"image/gif": true,
	"image/webp": true,
	"application/pdf": true,
	"text/plain": true,
};

/**
 * Whether an attachment may be served with `Content-Disposition: inline`.
 *
 * Inline is opt-in via the caller's `disposition` query parameter, because the
 * same URL backs the download link, the inline `cid:` images and the preview
 * overlay, and only the caller knows which it is. This function is the second
 * half: the caller's request is honoured only for a type on the allowlist.
 *
 * Parameters are stripped and the type lower-cased before the check, so
 * `TEXT/HTML; charset=utf-8` cannot dodge it on formatting alone.
 */
export function canServeInline(
	mimetype: string | undefined | null,
	requestedDisposition: string | undefined | null,
): boolean {
	if (requestedDisposition !== "inline") return false;
	const baseType = (mimetype ?? "").split(";")[0]!.trim().toLowerCase();
	return INLINE_SAFE_TYPES[baseType] === true;
}

/**
 * Store base64-encoded attachments to R2 and return metadata for the DO.
 */
export async function storeAttachments(
	bucket: Env["BUCKET"],
	emailId: string,
	attachments?: {
		content: string;
		filename: string;
		type: string;
		disposition: string;
		contentId?: string;
	}[],
): Promise<StoredAttachment[]> {
	if (!attachments?.length) return [];

	const results: StoredAttachment[] = [];
	for (const att of attachments) {
		const attachmentId = crypto.randomUUID();
		const safeFilename = sanitizeAttachmentFilename(att.filename);
		const key = attachmentKey(emailId, attachmentId, safeFilename);
		const binaryStr = atob(att.content);
		const bytes = Uint8Array.from(binaryStr, (c) => c.charCodeAt(0));
		await bucket.put(key, bytes);
		results.push({
			id: attachmentId,
			email_id: emailId,
			filename: safeFilename,
			mimetype: att.type,
			size: bytes.byteLength,
			content_id: att.contentId || null,
			disposition: att.disposition,
		});
	}
	return results;
}
