// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Context } from "hono";
import { sendEmail } from "../email-sender";
import { storeAttachments } from "../lib/attachments";
import type { EmailFull } from "../lib/schemas";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildReferencesChain,
	buildOutgoingHeaders,
	recordDelivery,
	resolveOriginalEmail,
} from "../lib/email-helpers";
import { httpRefusal, preSend, requestActor, type QuotaStub } from "../lib/pre-send";
import { SendEmailRequestSchema } from "../lib/schemas";
import type { HoldPayload } from "../lib/agent-send-gate";
import { listOf } from "../lib/held-send";
import { Folders } from "../../shared/folders";
import { sendAttributionFor } from "../lib/authz";
import type { MailboxContext } from "../lib/mailbox";
import { senderAddressesFor } from "./domains";
import { trackOutgoingHtml, trackingBaseUrlFromRequest } from "../lib/tracking-send";
import { trackingOptOutStore } from "../lib/tracking-opt-outs";

type AppContext = Context<MailboxContext>;

/**
 * Reply and forward differ only in whether the outgoing message is treated as
 * a direct response (which also clears the thread's unread state). Both must
 * stay attached to the original conversation: RFC 5322 §3.6.4 threading is
 * driven by `In-Reply-To`/`References`, and every major client (Gmail, Outlook)
 * keeps a forward inside the source conversation.
 *
 * Previously `handleForwardEmail` wrote `in_reply_to: null`, `references: null`
 * and `thread_id: <its own id>`, and sent no threading headers at all — so each
 * forward split into a standalone thread locally *and* for the recipient.
 */
type SendMode = "reply" | "forward";

function joinAddresses(value: string | string[] | undefined): string | null {
	if (!value) return null;
	return (Array.isArray(value) ? value.join(", ") : value).toLowerCase();
}

async function handleThreadedSend(c: AppContext, mode: SendMode) {
	const mailboxId = c.req.param("mailboxId") ?? "";
	const id = c.req.param("id") ?? "";
	const body = SendEmailRequestSchema.parse(await c.req.json());
	let { to, cc, bcc } = body;
	const { from, subject, html, text, attachments } = body;

	/**
	 * Whose name this leaves under. See the send route in `workers/index.ts`.
	 *
	 * This is the path that matters most for a shared inbox: a support reply
	 * should be traceable to the person who wrote it, which `sendOnBehalf` does
	 * by naming them in `Sender:`. A `sendAs` grant suppresses that deliberately.
	 */
	const attribution = sendAttributionFor(c.var.principal, mailboxId);
	if (!attribution) {
		return c.json(
			{ error: "You do not have permission to send from this mailbox" },
			403,
		);
	}
	const onBehalfOf = attribution.mode === "onBehalfOf" ? attribution.sender : null;

	const stub = c.var.mailboxStub;
	const rawOriginal = (await stub.getEmail(id)) as EmailFull | null;

	if (!rawOriginal) {
		return c.json({ error: "Original email not found" }, 404);
	}

	const originalEmail = await resolveOriginalEmail(stub, rawOriginal);
	const {
		originalMsgId,
		references,
		threadId: thread_id,
	} = buildReferencesChain(originalEmail);

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(
			to,
			from,
			mailboxId,
			await senderAddressesFor(c.env, mailboxId),
		));
	} catch (e) {
		if (e instanceof SenderValidationError) {
			return c.json({ error: e.message }, 400);
		}
		throw e;
	}

	// Threading only — `Message-ID` and `Sender` are refused by Email Service
	// and a rejected header fails the whole message. Built before the limits
	// check so the References chain (trimmed to the 2,048-byte value limit) is
	// part of what is validated.
	const outgoingHeaders = buildOutgoingHeaders({
		inReplyTo: originalMsgId,
		references,
	});
	// The shared pre-send gate (workers/lib/pre-send.ts): provider limits, the
	// mailbox's caps, and suppressions with transactional semantics — a hard
	// bounce or complaint removes that recipient, an unsubscribe only warns.
	const gate = await preSend(c.env, {
		kind: "transactional",
		from: fromEmail,
		mailboxId,
		to, cc, bcc, html, text, attachments,
		headers: outgoingHeaders,
		actor: requestActor(c),
		// Held (API token, OAuth grant) as this exact message; approve sends it.
		hold: {
			action: mode === "reply" ? "send_reply" : "forward_email",
			subject,
			payload: {
				composed: [
					{
						kind: "transactional",
						to: listOf(to),
						cc: listOf(cc),
						bcc: listOf(bcc),
						from,
						subject,
						html,
						text,
						headers: outgoingHeaders,
						rawAttachments: attachments,
						row: {
							threadId: thread_id,
							inReplyTo: originalMsgId,
							references,
							rawHeaders: JSON.stringify([
								...(originalMsgId ? [{ key: "in-reply-to", value: `<${originalMsgId}>` }] : []),
								...(references.length ? [{ key: "references", value: references.map((r: string) => `<${r}>`).join(" ") }] : []),
							]),
						},
						markThreadRead: mode === "reply" ? thread_id : null,
						trackingBaseUrl: trackingBaseUrlFromRequest(c.req.url),
					},
				],
			} satisfies HoldPayload,
		},
	}, { quota: () => stub as unknown as QuotaStub });
	if (!gate.ok) return c.json(...httpRefusal(gate));
	if (gate.suppressed.length) {
		to = gate.to;
		cc = gate.cc.length ? gate.cc : undefined;
		bcc = gate.bcc.length ? gate.bcc : undefined;
		toStr = gate.to.join(", ").toLowerCase();
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	const attachmentData = await storeAttachments(
		c.env.BUCKET,
		messageId,
		attachments,
	);

	const sentAt = new Date().toISOString();
	const ccStr = joinAddresses(cc);
	const bccStr = joinAddresses(bcc);

	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject,
			sender: fromEmail,
			recipient: toStr,
			cc: ccStr,
			bcc: bccStr,
			date: sentAt,
			body: html || text || "",
			in_reply_to: originalMsgId,
			email_references: JSON.stringify(references),
			thread_id,
			message_id: outgoingMessageId,
			delivery_status: "queued",
			raw_headers: JSON.stringify([
				{
					key: "from",
					value:
						typeof from === "string" ? from : `${from.name} <${from.email}>`,
				},
				{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
				...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
				...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
				{ key: "subject", value: subject },
				{ key: "date", value: sentAt },
				// No `message-id`: the provider assigns it and `recordDelivery` writes
				// the real value to the `message_id` COLUMN. An entry here would take
				// precedence over that column in the `.eml`/mbox exporters, so a
				// downloaded message would advertise an id that was never sent.
				...(originalMsgId
					? [{ key: "in-reply-to", value: `<${originalMsgId}>` }]
					: []),
				...(references.length > 0
					? [
							{
								key: "references",
								value: references.map((r: string) => `<${r}>`).join(" "),
							},
						]
					: []),
			]),
		},
		attachmentData,
	);

	// Replying implies you've read the conversation; forwarding does not.
	if (mode === "reply") {
		await stub.markThreadRead(thread_id);
	}

	// Only the provider's copy is instrumented; the Sent row above keeps `html`.
	const outgoingHtml = await trackOutgoingHtml({
		stub: stub as unknown as Parameters<typeof trackOutgoingHtml>[0]["stub"],
		mailboxId,
		emailId: messageId,
		html,
		baseUrl: trackingBaseUrlFromRequest(c.req.url),
		to: toStr,
		cc,
		bcc,
		text,
		attachments,
		track: body.track,
		optOuts: trackingOptOutStore(c.env),
		fromAddress: mailboxId,
	});

	c.executionCtx.waitUntil(
		sendEmail(c.env.EMAIL, {
			to,
			cc,
			bcc,
			from,
			subject,
			html: outgoingHtml,
			text,
			attachments: attachments?.map((att) => ({
				content: att.content,
				filename: att.filename,
				type: att.type,
				disposition: att.disposition,
				contentId: att.contentId,
			})),
			headers: outgoingHeaders,
		}, gate.clearance)
			.then(async (result) => {
				await recordDelivery(stub, messageId, {
					providerMessageId: result.messageId,
				});
			})
			.catch(async (e) => {
				console.error(`Deferred ${mode} delivery failed:`, (e as Error).message);
				await recordDelivery(stub, messageId, { thrown: e });
			}),
	);

	return c.json(
		{
			id: messageId,
			status: "sent",
			...(gate.suppressed.length ? { suppressed: gate.suppressed } : {}),
			...(gate.warnings.length ? { suppression_warnings: gate.warnings } : {}),
		},
		202,
	);
}

export function handleReplyEmail(c: AppContext) {
	return handleThreadedSend(c, "reply");
}

export function handleForwardEmail(c: AppContext) {
	return handleThreadedSend(c, "forward");
}
