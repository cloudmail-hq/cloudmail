// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Dispatch for per-mailbox forwarding. The rules and the presentation live in
 * shared/forwarding.ts; this module only does the sending.
 *
 * Forwarding is best-effort by design and never blocks inbound mail: it runs
 * after the message is safely stored and after the blocklist check, so blocked
 * senders are never forwarded and a provider outage can never cost us a
 * received message. There is no retry — a failure is logged.
 */

import type { Email as ParsedEmail } from "postal-mime";
import { isBlockedAttachment } from "../../shared/attachment-types";
import { sanitizeAttachmentFilename } from "./attachments";
import { sendEmail } from "../email-sender";
import {
	FORWARDED_HEADER,
	buildForwardDisplayName,
	buildForwardHeaderBlock,
	forwardBodyBytes,
	selectForwardAttachments,
} from "../../shared/forwarding";
import { extractAuthenticationResults } from "../../shared/auth-results";
import { formatEmailDate, textToHtml } from "./email-helpers";
import { toBase64 } from "../durableObject/features";
import { preSendOrThrow, type PreSendDeps } from "./pre-send";
import type { Env } from "../types";

/** An inbound attachment as postal-mime hands it to us. */
interface InboundAttachment {
	filename: string;
	mimeType: string;
	content: ArrayBuffer | string;
	contentId?: string | null;
	disposition?: string | null;
}

function attachmentBytes(content: ArrayBuffer | string): Uint8Array {
	return typeof content === "string"
		? new TextEncoder().encode(content)
		: new Uint8Array(content);
}

/**
 * Re-send an inbound message to the mailbox's forwarding address.
 *
 * Only the destination is written to. The original `Cc` recipients are
 * deliberately not re-sent to: they already received the message directly, and
 * mailing them a second copy from a different domain looks like spoofing.
 */
export async function forwardInboundMessage(options: {
	binding: SendEmail;
	/** For the pre-send gate (suppressions, caps). */
	env: Env;
	/** Test seam for the gate's lookups. */
	gateDeps?: PreSendDeps;
	/** Address of the mailbox that received the message. */
	mailboxId: string;
	/** Display name configured for the mailbox, used in the `via` suffix. */
	mailboxName?: string | null;
	target: string;
	parsed: ParsedEmail;
	/** Recipients as resolved by the inbound handler. */
	to: readonly string[];
	cc: readonly string[];
}): Promise<void> {
	const { binding, env, mailboxId, mailboxName, target, parsed, to, cc } = options;

	const originalFrom = parsed.from?.address ?? null;
	const originalFromLabel = parsed.from?.name
		? `${parsed.from.name} <${originalFrom ?? ""}>`
		: originalFrom;

	const attachments = (parsed.attachments ?? []) as unknown as InboundAttachment[];

	/**
	 * Executable parts are refused here too, not just on the way into storage.
	 *
	 * This path takes the *original* `parsedEmail`, so filtering only the stored
	 * copy would have refused `setup.exe` locally and then posted it straight to
	 * the forwarding address — turning the control into a redirect. Automatic
	 * forwarding is exactly where that matters, since nobody reviews the message
	 * before it leaves.
	 *
	 * Named in the omission notice rather than dropped silently, reusing the
	 * mechanism that already reports attachments too large for the budget: the
	 * recipient is told what was withheld and why, and can ask for it another way.
	 * See `shared/attachment-types.ts`.
	 */
	const blockedNames: string[] = [];
	const candidates = attachments
		.filter((attachment) => {
			const filename = sanitizeAttachmentFilename(attachment.filename);
			if (!isBlockedAttachment(filename)) return true;
			blockedNames.push(`${filename} (blocked file type)`);
			return false;
		})
		.map((attachment) => {
			const bytes = attachmentBytes(attachment.content);
			return {
				filename: attachment.filename || "attachment",
				size: bytes.byteLength,
				mimeType: attachment.mimeType || "application/octet-stream",
				bytes,
				contentId: attachment.contentId ?? undefined,
			};
		});

	// The body is built twice: once to measure it against the attachment budget,
	// then again with the omission notice the measurement produced. Cheap, and it
	// keeps "what was left out" accurate in the copy the recipient reads.
	const originalHtml = parsed.html || (parsed.text ? textToHtml(parsed.text) : "");
	const originalText = parsed.text || "";

	// `extractAuthenticationResults` reads the serialised header array, the same
	// form stored in `emails.raw_headers`, so the forwarded copy restates exactly
	// the verdicts the UI shows for the stored message.
	const envelope = {
		from: originalFromLabel,
		date: parsed.date ? formatEmailDate(parsed.date) : null,
		subject: parsed.subject || null,
		to: to.join(", ") || null,
		cc: cc.join(", ") || null,
		auth: extractAuthenticationResults(JSON.stringify(parsed.headers ?? [])),
	};

	const provisional = buildForwardHeaderBlock(envelope);

	const { included, omitted: tooLarge } = selectForwardAttachments(
		candidates,
		forwardBodyBytes(
			provisional.html + originalHtml,
			provisional.text + originalText,
		),
	);

	/**
	 * Both reasons an attachment can be missing, in one notice.
	 *
	 * Blocked parts lead, because "we refused this" is a different statement from
	 * "this did not fit" and the reader's next action differs: the first needs the
	 * sender to resend it another way, the second needs a link.
	 */
	const omitted = [...blockedNames, ...tooLarge];

	// Rebuilt only when something was left out, so the notice the recipient reads
	// matches what was actually sent.
	const header =
		omitted.length === 0
			? provisional
			: buildForwardHeaderBlock({ ...envelope, omittedAttachments: omitted });

	const forwardHtml = `${header.html}${originalHtml}`;
	const forwardText = originalText ? `${header.text}${originalText}` : undefined;
	const forwardAttachments = included.map((attachment) => ({
		content: toBase64(attachment.bytes),
		filename: attachment.filename,
		type: attachment.mimeType,
		// Inline images arrive as ordinary attachments: their `cid:` references
		// point into the original MIME tree, which this copy does not reproduce.
		disposition: "attachment" as const,
	}));
	const forwardHeaders = { [FORWARDED_HEADER]: mailboxId };

	// Automated mail through the shared gate: a suppressed target (bounced,
	// complained, unsubscribed) is not mailed, and the copy counts against the
	// mailbox's caps. Throws on refusal; the caller logs it. The message itself
	// is already stored.
	const gate = await preSendOrThrow(
		env,
		{
			kind: "automated",
			from: mailboxId,
			mailboxId,
			to: target,
			html: forwardHtml,
			text: forwardText,
			attachments: forwardAttachments,
			headers: forwardHeaders,
		},
		options.gateDeps,
	);

	await sendEmail(binding, {
		to: target,
		from: {
			email: mailboxId,
			name: buildForwardDisplayName({
				originalName: parsed.from?.name,
				originalAddress: originalFrom,
				mailboxName,
			}),
		},
		// Prefixing with "Fwd:" would break the recipient's own threading of an
		// ongoing conversation, so the subject is passed through untouched.
		subject: parsed.subject || "(no subject)",
		html: forwardHtml,
		...(forwardText ? { text: forwardText } : {}),
		// Replying to the copy must reach the person who wrote, not this mailbox.
		...(originalFrom ? { replyTo: originalFrom } : {}),
		attachments: forwardAttachments,
		headers: forwardHeaders,
	}, gate.clearance);
}
