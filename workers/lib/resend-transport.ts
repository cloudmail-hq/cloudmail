// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Resend `POST /emails` with plain `fetch` (no SDK).
 *
 * @see https://resend.com/docs/api-reference/emails/send-email
 *
 * ## Idempotency and retry (Resend research, Decisions 2 and 3)
 *
 * Every request carries `Idempotency-Key: cm-<sendTag>-<sha256(body)[0..16]>`.
 * Resend keeps a key for 24 hours and answers a replay of the same body with
 * the first response, so our own retries cannot send twice. Retried, at most
 * twice (full jitter on a 1 s base, or `retry-after` when it is at most 5 s):
 * `429 rate_limit_exceeded`, `409 concurrent_idempotent_requests`, 5xx,
 * network errors and timeouts. Still failing after that is
 * `E_RESEND_UNCONFIRMED`, as is `409 invalid_idempotent_request` (an earlier
 * request with this key was processed). Quota errors and every other 4xx are
 * definite rejections (`E_RESEND_*`).
 *
 * The API key is a private field and only ever goes into the Authorization
 * header of the request.
 */

import { providerHeaders, validateProviderMessage } from "../../shared/provider-limits";
import { SendValidationError } from "../../shared/send-validation";
import { redactSecrets } from "../../shared/redact-secrets";
import type { MailTransport, OutgoingMessage, TransportSendResult } from "./mail-transport";
import {
	ProviderSendError,
	backoffMs,
	fetchWithTimeout,
	formatAddress,
	formatAddressList,
	newSendTag,
	oneLine,
	providerSendDeps,
	tagValue,
} from "./provider-send";

export const RESEND_API_BASE = "https://api.resend.com";

/** Overridable in tests only: a fake endpoint, never a real Resend call. */
export const resendTransportDeps = {
	fetchImpl: undefined as typeof fetch | undefined,
	base: undefined as string | undefined,
};

export function resendApiBase(): string {
	return resendTransportDeps.base ?? RESEND_API_BASE;
}

export interface ResendTransportConfig {
	domain: string;
	apiKey: string;
}

/** The Resend body for a message. Pure; exported for tests. */
export function resendEmailBody(
	message: OutgoingMessage,
	options: { sendTag: string; domain: string },
): Record<string, unknown> {
	const to = formatAddressList(message.to);
	const out: Record<string, unknown> = {
		from: formatAddress(message.from),
		to,
		subject: oneLine(message.subject ?? ""),
	};
	const cc = formatAddressList(message.cc);
	const bcc = formatAddressList(message.bcc);
	if (cc.length) out.cc = cc;
	if (bcc.length) out.bcc = bcc;
	if (message.replyTo) out.reply_to = [formatAddress(message.replyTo)];
	if (message.html) out.html = message.html;
	// An empty `text` stops Resend generating one from the HTML; we send exactly
	// what the user wrote.
	out.text = message.text ?? "";
	const headers = providerHeaders(message.headers);
	if (Object.keys(headers).length) out.headers = headers;
	if (message.attachments?.length) {
		out.attachments = message.attachments.map((a) => {
			if (/[\r\n\0"]/.test(a.filename) || a.filename.length > 255 || !a.filename.trim()) {
				throw new SendValidationError("E_HEADER_VALUE_INVALID", `Attachment name '${a.filename.slice(0, 40)}' is not valid.`);
			}
			const att: Record<string, unknown> = { content: a.content, filename: a.filename };
			if (a.type && /^[!-~]{1,78}$/.test(a.type)) att.content_type = a.type;
			if (a.contentId) {
				const cid = a.contentId.replace(/^<|>$/g, "");
				if (!/^[!-~]{1,78}$/.test(cid)) {
					throw new SendValidationError("E_HEADER_VALUE_INVALID", "An inline attachment's Content-ID is not valid.");
				}
				att.content_id = cid;
			}
			return att;
		});
	}
	out.tags = [
		{ name: "cm_send", value: tagValue(options.sendTag) },
		{ name: "cm_domain", value: tagValue(options.domain) },
	];
	return out;
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `cm-<sendTag>-<first 16 hex of sha256(body)>`. Stable for identical retries. */
export async function resendIdempotencyKey(sendTag: string, body: string): Promise<string> {
	return `cm-${tagValue(sendTag).slice(0, 64)}-${(await sha256Hex(body)).slice(0, 16)}`;
}

type Verdict =
	| { kind: "retry"; retryAfterMs: number | null }
	| { kind: "rejected"; code: string; message: string }
	| { kind: "unconfirmed"; message: string };

/** How to treat one Resend answer. Pure; exported for tests. */
export function classifyResendResponse(status: number, name: string, message: string, retryAfter: string | null): Verdict {
	const detail = message ? `: ${redactSecrets(message).slice(0, 300)}` : "";
	const ra = retryAfter !== null && /^\d+(\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : null;
	if (status >= 500) return { kind: "retry", retryAfterMs: ra };
	if (status === 429) {
		if (/quota/i.test(name)) {
			return { kind: "rejected", code: "E_RESEND_QUOTA_EXCEEDED", message: `Resend sending quota reached (${name})${detail}` };
		}
		return { kind: "retry", retryAfterMs: ra };
	}
	if (status === 409) {
		if (name === "concurrent_idempotent_requests") return { kind: "retry", retryAfterMs: ra };
		if (name === "invalid_idempotent_request") {
			return { kind: "unconfirmed", message: "Resend already processed a request for this message; it may have been sent." };
		}
		return { kind: "rejected", code: "E_RESEND_REJECTED", message: `Resend refused the message (409${name ? `, ${name}` : ""})${detail}` };
	}
	// 401: missing_api_key, restricted_api_key ("restricted to only send
	// emails" on a non-send endpoint) or validation_error (an invalid key).
	if (status === 401 || name === "missing_api_key") {
		return { kind: "rejected", code: "E_RESEND_INVALID_KEY", message: `Resend didn't accept the API key (${name || status}).` };
	}
	if (status === 403) {
		if (name === "suspended_api_key" || name === "restricted_api_key" || name === "invalid_permission") {
			return { kind: "rejected", code: "E_RESEND_INVALID_KEY", message: `Resend refused the API key (${name})${detail}` };
		}
		return { kind: "rejected", code: "E_RESEND_FORBIDDEN", message: `Resend refused the message (403${name ? `, ${name}` : ""})${detail}` };
	}
	if (status === 422 && name === "invalid_attachment") {
		return { kind: "rejected", code: "E_RESEND_INVALID_ATTACHMENT", message: `Resend refused an attachment${detail}` };
	}
	if (status >= 400) {
		return { kind: "rejected", code: "E_RESEND_REJECTED", message: `Resend refused the message (${status}${name ? `, ${name}` : ""})${detail}` };
	}
	return { kind: "unconfirmed", message: `Resend answered ${status} without an email id; the message may have been sent.` };
}

export class ResendTransport implements MailTransport {
	readonly kind = "resend" as const;
	readonly domain: string;
	readonly #apiKey: string;

	constructor(config: ResendTransportConfig) {
		this.domain = config.domain;
		this.#apiKey = config.apiKey;
	}

	get hasCredentials(): boolean {
		return !!this.#apiKey;
	}

	validate(message: OutgoingMessage): void {
		validateProviderMessage(message, "Resend");
	}

	async send(message: OutgoingMessage): Promise<TransportSendResult> {
		const sendTag = message.sendTag ?? newSendTag();
		const payload = JSON.stringify(resendEmailBody(message, { sendTag, domain: this.domain }));
		const idempotencyKey = await resendIdempotencyKey(sendTag, payload);
		const fetchImpl = resendTransportDeps.fetchImpl ?? fetch;
		const url = `${resendApiBase()}/emails`;
		const fail = (code: string, msg: string, status: number | null) =>
			new ProviderSendError(code, msg, "resend", sendTag, status);
		const unconfirmed = (status: number | null) =>
			fail(
				"E_RESEND_UNCONFIRMED",
				"Resend didn't confirm the message after retries; it may have been sent.",
				status,
			);

		for (let attempt = 0; ; attempt++) {
			const retry = async (retryAfterMs: number | null, status: number | null): Promise<void> => {
				if (attempt >= providerSendDeps.maxRetries) throw unconfirmed(status);
				const wait = retryAfterMs !== null && retryAfterMs <= 5000 ? retryAfterMs : backoffMs(attempt);
				await providerSendDeps.sleep(wait);
			};
			let res: Response;
			try {
				res = await fetchWithTimeout(fetchImpl, url, {
					method: "POST",
					headers: {
						authorization: `Bearer ${this.#apiKey}`,
						"content-type": "application/json",
						accept: "application/json",
						"idempotency-key": idempotencyKey,
					},
					body: payload,
				});
			} catch {
				// Network error or timeout: the key makes a replay safe.
				await retry(null, null);
				continue;
			}
			let body: Record<string, unknown> = {};
			try {
				const text = await res.text();
				body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
			} catch {
				body = {};
			}
			if (res.ok) {
				const id = typeof body.id === "string" ? body.id.trim() : "";
				if (!/^[A-Za-z0-9-]{1,100}$/.test(id)) throw unconfirmed(res.status);
				// Resend's response has no RFC Message-ID; the `email.sent` webhook
				// replaces `message_id` with it. Until then the id stands in.
				return { messageId: id, providerMessageId: id, sendTag };
			}
			const name = typeof body.name === "string" ? body.name : "";
			const msg = typeof body.message === "string" ? body.message : "";
			const verdict = classifyResendResponse(res.status, name, msg, res.headers.get("retry-after"));
			if (verdict.kind === "retry") {
				await retry(verdict.retryAfterMs, res.status);
				continue;
			}
			if (verdict.kind === "unconfirmed") throw fail("E_RESEND_UNCONFIRMED", verdict.message, res.status);
			throw fail(verdict.code, verdict.message, res.status);
		}
	}
}
