// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Pulling stored attachments back into the composer.
 *
 * Two flows need this and neither worked before:
 *
 *   - Reopening a draft. The files were staged in the browser, so a draft
 *     restored from the server had nothing to show and the composer explicitly
 *     reset its attachment list to empty.
 *   - Forwarding. The original's attachments live in R2 under the *original*
 *     message's id, so a forward went out without them.
 *
 * Both are solved by fetching the bytes and handing the composer ordinary
 * `File` objects, which makes the rest of the send path — validation, size
 * accounting, base64 encoding — work unchanged. The alternative, a server-side
 * "copy these attachment ids onto the new message" endpoint, would avoid the
 * round trip through the browser but needs its own authorisation story and a
 * second code path for size limits. Messages are capped at a few MB, so the
 * round trip is cheap and this keeps one way to attach a file.
 */

import type { AttachmentFile } from "~/components/mail/AttachmentPicker";
import { fileToBase64, getAttachmentUrl, isImageMimeType } from "~/lib/utils";
import type { Attachment } from "~/types";

/** An attachment encoded the way the send and draft routes expect it. */
export interface ApiAttachment {
	content: string;
	filename: string;
	type: string;
	disposition: "attachment" | "inline";
}

/**
 * Base64-encode staged files for the API.
 *
 * Shared rather than private to the composer because the reading pane sends
 * drafts too, and the copy that lived there omitted attachments entirely — a
 * draft sent from the list went out without the files it was saved with.
 */
export async function prepareAttachmentsForApi(
	attachments: AttachmentFile[],
): Promise<ApiAttachment[]> {
	return Promise.all(
		attachments.map(async (att) => ({
			content: await fileToBase64(att.file),
			filename: att.file.name,
			type: att.file.type || "application/octet-stream",
			disposition: "attachment" as const,
		})),
	);
}

/**
 * Fetch attachments belonging to `emailId` and stage them as composer files.
 *
 * Inline parts are skipped: they are `cid:` references inside the original HTML
 * body, and re-attaching them would show the reader a duplicate of an image
 * already embedded in the quoted message.
 *
 * Individual failures are dropped rather than thrown. A forward that loses one
 * of four attachments is worth completing — the caller reports the shortfall so
 * the user can decide, which is better than refusing to open the composer at
 * all because one blob is missing.
 */
export async function stageStoredAttachments(
	mailboxId: string,
	emailId: string,
	attachments: Attachment[] | undefined,
): Promise<{ files: AttachmentFile[]; failed: string[] }> {
	const source = (attachments ?? []).filter(
		(att) => att.disposition !== "inline" || !att.content_id,
	);
	if (source.length === 0) return { files: [], failed: [] };

	const files: AttachmentFile[] = [];
	const failed: string[] = [];

	const results = await Promise.all(
		source.map(async (att) => {
			try {
				// Plain fetch rather than the API client: this is a binary body, and
				// the client's JSON-first response handling would have to be worked
				// around anyway.
				const response = await fetch(
					getAttachmentUrl(mailboxId, emailId, att.id),
				);
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const blob = await response.blob();
				return {
					att,
					file: new File([blob], att.filename, {
						type: att.mimetype || "application/octet-stream",
					}),
				};
			} catch {
				return { att, file: null };
			}
		}),
	);

	for (const { att, file } of results) {
		if (!file) {
			failed.push(att.filename);
			continue;
		}
		files.push({
			id: crypto.randomUUID(),
			file,
			preview: isImageMimeType(file.type)
				? URL.createObjectURL(file)
				: undefined,
		});
	}

	return { files, failed };
}

/**
 * A stable identity for a staged attachment set.
 *
 * Autosave compares this against the last saved value to decide whether to
 * re-upload. Without it every save would re-encode and re-store bytes that had
 * not changed, on a timer, while the user typed.
 *
 * Keyed on name, size and last-modified time rather than content: reading every
 * file to hash it would cost more than the upload it is meant to avoid, and two
 * distinct files agreeing on all three is not a case worth paying for.
 */
export function attachmentsSignature(attachments: AttachmentFile[]): string {
	return attachments
		.map((a) => `${a.file.name}:${a.file.size}:${a.file.lastModified}`)
		.join("|");
}

/**
 * Load a stored message's attachments straight into API payload form.
 *
 * For send paths that have no composer to stage files into — sending a draft
 * from the reading pane or the list. Object URLs are deliberately not created
 * here: nothing is going to render a thumbnail, and there would be no unmount
 * to revoke them on.
 *
 * Failures are returned rather than thrown so the caller can decide. Refusing
 * to send a draft because one blob is unreachable is worse than sending it and
 * saying which file did not make it.
 */
export async function loadAttachmentsForSend(
	mailboxId: string,
	emailId: string,
	attachments: Attachment[] | undefined,
): Promise<{ attachments: ApiAttachment[]; failed: string[] }> {
	const source = (attachments ?? []).filter(
		(att) => att.disposition !== "inline" || !att.content_id,
	);
	if (source.length === 0) return { attachments: [], failed: [] };

	const failed: string[] = [];
	const results = await Promise.all(
		source.map(async (att): Promise<ApiAttachment | null> => {
			try {
				const response = await fetch(
					getAttachmentUrl(mailboxId, emailId, att.id),
				);
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const blob = await response.blob();
				const file = new File([blob], att.filename, {
					type: att.mimetype || "application/octet-stream",
				});
				return {
					content: await fileToBase64(file),
					filename: att.filename,
					type: file.type,
					disposition: "attachment" as const,
				};
			} catch {
				failed.push(att.filename);
				return null;
			}
		}),
	);

	return {
		attachments: results.filter((r): r is ApiAttachment => r !== null),
		failed,
	};
}
