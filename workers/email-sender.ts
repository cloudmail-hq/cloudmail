// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Email sending via Cloudflare Email Service binding.
 *
 * Uses the `send_email` Worker binding (`env.EMAIL.send()`) to send emails.
 *
 * See: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 */
import { assertSendableHeaders } from "../shared/email-headers";
import { prepareOutgoingHtml } from "../shared/outgoing-html";
import { validateOutgoingMessage } from "../shared/send-validation";
import { isSendClearance, type SendClearance } from "./lib/pre-send";

export interface SendEmailParams {
	to: string | string[];
	from: string | { email: string; name: string };
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string | { email: string; name: string };
	attachments?: {
		content: string; // base64 encoded
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
		contentId?: string;
	}[];
	headers?: Record<string, string>;
}

/**
 * Send an email using the Cloudflare Email Service binding.
 *
 * @param binding  - The `EMAIL` SendEmail binding from env
 * @param params   - Email parameters (to, from, subject, body, etc.)
 * @returns The send result with messageId
 * @throws On validation or delivery errors (error has `.code` property)
 */
export async function sendEmail(
	binding: SendEmail,
	params: SendEmailParams,
	/**
	 * Proof the message passed `preSend` (workers/lib/pre-send.ts): suppressions,
	 * caps, the spam-rate breaker and the provider's limits. Required, so a send
	 * path that skips the gate does not compile.
	 */
	clearance: SendClearance,
): Promise<{ messageId: string }> {
	if (!isSendClearance(clearance)) {
		throw new Error("sendEmail called without a pre-send clearance; call preSend() first");
	}
	const message: Record<string, unknown> = {
		to: params.to,
		from: params.from,
		subject: params.subject,
	};

	// Colour scheme, one font wrapper, no absolute black/white text. The stored
	// Sent copy keeps the body as written. See shared/outgoing-html.ts.
	const html = prepareOutgoingHtml(params.html);
	if (html) message.html = html;
	if (params.text) message.text = params.text;
	if (params.cc) message.cc = params.cc;
	if (params.bcc) message.bcc = params.bcc;
	if (params.replyTo) message.replyTo = params.replyTo;

	// Email Service's per-message limits, checked here so no path — including
	// the agent tools, forwarding and auto-reply, which have no route-level check
	// — can spend a provider call on a message it will refuse. Throws a
	// `SendValidationError` whose `.code` matches the provider's own.
	validateOutgoingMessage({
		to: params.to,
		cc: params.cc,
		bcc: params.bcc,
		html,
		text: params.text,
		attachments: params.attachments,
		headers: params.headers,
	});

	if (params.headers && Object.keys(params.headers).length > 0) {
		// THE chokepoint. Every send path in the app funnels through this function,
		// including the two that build their header objects by hand and therefore
		// never touch `buildOutgoingHeaders`' own guard.
		//
		// Email Service rejects the WHOLE message when one header is not acceptable,
		// so an unnoticed addition here is a total outage, not a degraded send —
		// which is exactly what `Message-ID` caused. Asserting at the boundary means
		// a rejected header fails loudly in tests and local development instead of
		// inside a `waitUntil` where the rejection reached nothing but a log line.
		assertSendableHeaders(params.headers);
		message.headers = params.headers;
	}

	if (params.attachments && params.attachments.length > 0) {
		message.attachments = params.attachments.map((att) => ({
			content: att.content,
			filename: att.filename,
			type: att.type,
			disposition: att.disposition,
			...(att.contentId ? { contentId: att.contentId } : {}),
		}));
	}

	const result = await binding.send(message as any);
	return { messageId: result.messageId };
}
