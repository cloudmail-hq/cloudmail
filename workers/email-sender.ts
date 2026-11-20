// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The one send function. Every outbound message passes through `sendEmail`.
 *
 * It prepares the body, asks `resolveTransport` (./lib/mail-transport.ts) for
 * the From domain's provider, lets that provider validate the message, then
 * sends. A domain with no setting sends through Cloudflare Email Service
 * exactly as before; a domain set to Amazon SES never falls back to Cloudflare.
 *
 * See: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 */
import { prepareOutgoingHtml } from "../shared/outgoing-html";
import { isSendClearance, type SendClearance } from "./lib/pre-send";
import {
	fromAddressOf,
	resolveTransport,
	type OutgoingMessage,
	type SendVia,
	type TransportSendResult,
} from "./lib/mail-transport";

export type { SendVia } from "./lib/mail-transport";

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
	/**
	 * The local `emails.id` this send belongs to, sent to SES and Resend as the
	 * `cm_send` tag. Their events carry it back, which is how a send whose
	 * answer was lost (timeout, 5xx) is matched to its row. Cloudflare ignores it.
	 */
	sendTag?: string;
}

/**
 * Send an email through the From domain's provider.
 *
 * @param via      - The Worker env (production: honours the domain's sending
 *                   setting), or a bare `EMAIL` binding (tests: always Cloudflare)
 * @param params   - Email parameters (to, from, subject, body, etc.)
 * @returns The send result with messageId
 * @throws On validation or delivery errors (error has `.code` property). A
 *         domain whose provider cannot be used throws a `TransportError`
 *         (`E_PROVIDER_*`) before anything is sent.
 */
export async function sendEmail(
	via: SendVia,
	params: SendEmailParams,
	/**
	 * Proof the message passed `preSend` (workers/lib/pre-send.ts): suppressions,
	 * caps, the spam-rate breaker and the provider's limits. Required, so a send
	 * path that skips the gate does not compile.
	 */
	clearance: SendClearance,
): Promise<TransportSendResult> {
	if (!isSendClearance(clearance)) {
		throw new Error("sendEmail called without a pre-send clearance; call preSend() first");
	}
	const message: OutgoingMessage = {
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
	if (params.headers && Object.keys(params.headers).length > 0) message.headers = params.headers;
	if (params.attachments && params.attachments.length > 0) message.attachments = params.attachments;
	if (params.sendTag) message.sendTag = params.sendTag;

	const transport = await resolveTransport(via, fromAddressOf(params.from));

	// The provider's per-message limits, checked here so no path (including the
	// agent tools, forwarding and auto-reply, which have no route-level check)
	// can spend a provider call on a message it will refuse. For Cloudflare this
	// is also THE header chokepoint: Email Service rejects the WHOLE message for
	// one refused header, which is exactly what `Message-ID` once caused.
	transport.validate(message);

	return transport.send(message);
}
