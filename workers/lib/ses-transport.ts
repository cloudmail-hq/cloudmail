/**
 * Amazon SES v2 `SendEmail` with Simple content, signed with SigV4 by
 * `aws4fetch` (`retries: 0`: this module owns the retry loop).
 *
 *   POST https://email.<region>.amazonaws.com/v2/email/outbound-emails
 *
 * @see https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html
 *
 * ## Retry and classification (research §6)
 *
 * - Retried, at most twice with full jitter (`random() * min(20 s, 1 s * 2^n)`):
 *   `TooManyRequestsException` (429), `ThrottlingException` other than the
 *   daily quota, and `RequestTimeoutException` (408). SES did not accept those.
 * - Every other 4xx is a definite rejection with an `E_SES_*` code.
 * - A 5xx, `RequestAbortedException`, a timeout, a network error or a 2xx
 *   without a readable `MessageId` is `E_SES_UNCONFIRMED`: SES may have sent
 *   it. Never retried; the `cm_send` tag on the request lets an event settle it.
 *
 * The access key and secret live in private fields and in a client built for
 * one call. Neither appears in an error, a log line or a result.
 */

import { AwsClient } from "aws4fetch";
import { providerHeaders, validateProviderMessage } from "../../shared/provider-limits";
import { SendValidationError } from "../../shared/send-validation";
import { isSesRegion, sesMessageIdDomain } from "../../shared/ses-sending";
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
import { encodeHeaderWords } from "../../shared/provider-limits";

export interface SesTransportConfig {
	domain: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	configurationSet: string | null;
}

/** Overridable in tests only: a fake endpoint, never a real AWS call. */
export const sesTransportDeps = {
	fetchImpl: undefined as typeof fetch | undefined,
	/** Replaces `https://email.<region>.amazonaws.com` (tests). */
	endpoint: undefined as ((region: string) => string) | undefined,
};

export function sesApiBase(region: string): string {
	if (sesTransportDeps.endpoint) return sesTransportDeps.endpoint(region);
	if (!isSesRegion(region)) throw new Error(`Unsupported SES region: ${region}`);
	return `https://email.${region}.amazonaws.com`;
}

/** The AWS error name of a failed response: `x-amzn-ErrorType`, else body `__type` / `code`. */
export function awsErrorName(headerType: string | null, body: Record<string, unknown>): string {
	const raw = headerType ?? String(body.__type ?? body.code ?? body.Code ?? "");
	// "Name:http://..." or "com.amazon...#Name".
	const name = raw.split(":")[0] ?? "";
	return (name.includes("#") ? name.split("#").pop() : name)?.trim() ?? "";
}

export function awsErrorMessage(body: Record<string, unknown>): string {
	const m = body.message ?? body.Message;
	return typeof m === "string" ? m : "";
}

type Verdict =
	| { kind: "retry" }
	| { kind: "rejected"; code: string; message: string }
	| { kind: "unconfirmed"; message: string };

const CREDENTIAL_ERRORS = /^(UnrecognizedClient|IncompleteSignature|InvalidSignature|SignatureDoesNotMatch|ExpiredToken|InvalidClientTokenId|MissingAuthenticationToken)/i;

/** How to treat one SES answer. Pure; exported for tests. */
export function classifySesResponse(status: number, name: string, message: string): Verdict {
	const detail = message ? `: ${redactSecrets(message).slice(0, 300)}` : "";
	if (status >= 500) {
		return { kind: "unconfirmed", message: `Amazon SES answered ${status}${name ? ` (${name})` : ""}; the message may have been sent.` };
	}
	if (/^RequestAborted/i.test(name)) {
		return { kind: "unconfirmed", message: "Amazon SES closed the request before answering; the message may have been sent." };
	}
	if (/^(TooManyRequests|Throttling)/i.test(name) || status === 429) {
		if (/daily message quota/i.test(message)) {
			return { kind: "rejected", code: "E_SES_DAILY_QUOTA", message: `Amazon SES daily sending quota reached${detail}` };
		}
		// "Maximum sending rate exceeded", or a 429: SES didn't take it; retry.
		return { kind: "retry" };
	}
	if (status === 408 || /^RequestTimeout/i.test(name)) return { kind: "retry" };
	if (CREDENTIAL_ERRORS.test(name)) {
		// AWS's own text for these can quote the canonical request; leave it out.
		return { kind: "rejected", code: "E_SES_INVALID_CREDENTIALS", message: `Amazon SES didn't accept the access key (${name}).` };
	}
	const table: [RegExp, string][] = [
		[/^MessageRejected/i, "E_SES_MESSAGE_REJECTED"],
		[/^MailFromDomainNotVerified/i, "E_SES_MAIL_FROM_NOT_VERIFIED"],
		[/^AccountSuspended/i, "E_SES_ACCOUNT_SUSPENDED"],
		[/^SendingPaused/i, "E_SES_SENDING_PAUSED"],
		[/^LimitExceeded/i, "E_SES_LIMIT_EXCEEDED"],
		[/^NotFound/i, "E_SES_NOT_FOUND"],
		[/^(AccessDenied|NotAuthorized)/i, "E_SES_ACCESS_DENIED"],
		[/^OptInRequired/i, "E_SES_REGION_NOT_ENABLED"],
		[/^RequestEntityTooLarge/i, "E_SES_TOO_LARGE"],
		[/^(BadRequest|ValidationError|MalformedHttpRequest|UnknownOperation|SerializationException)/i, "E_SES_BAD_REQUEST"],
	];
	for (const [re, code] of table) {
		if (re.test(name)) return { kind: "rejected", code, message: `Amazon SES refused the message (${name})${detail}` };
	}
	if (status === 413) return { kind: "rejected", code: "E_SES_TOO_LARGE", message: `Amazon SES refused the message as too large${detail}` };
	if (status === 403) return { kind: "rejected", code: "E_SES_ACCESS_DENIED", message: `Amazon SES refused the request (403${name ? `, ${name}` : ""})${detail}` };
	if (status >= 400) {
		return { kind: "rejected", code: "E_SES_REJECTED", message: `Amazon SES refused the message (${status}${name ? `, ${name}` : ""})${detail}` };
	}
	return { kind: "unconfirmed", message: `Amazon SES answered ${status} without a message id; the message may have been sent.` };
}

/** The SES v2 SendEmail body for a message. Pure; exported for tests. */
export function sesSendEmailBody(
	message: OutgoingMessage,
	options: { configurationSet: string | null; sendTag: string; domain: string },
): Record<string, unknown> {
	const simple: Record<string, unknown> = {};
	const subject = oneLine(message.subject ?? "");
	simple.Subject = { Data: encodeHeaderWords(subject) };
	const body: Record<string, unknown> = {};
	if (message.html) body.Html = { Data: message.html, Charset: "UTF-8" };
	if (message.text) body.Text = { Data: message.text, Charset: "UTF-8" };
	if (!message.html && !message.text) body.Text = { Data: "", Charset: "UTF-8" };
	simple.Body = body;
	const headers = Object.entries(providerHeaders(message.headers));
	if (headers.length) simple.Headers = headers.map(([Name, Value]) => ({ Name, Value }));
	if (message.attachments?.length) {
		simple.Attachments = message.attachments.map((a) => {
			if (/[\r\n\0"]/.test(a.filename) || a.filename.length > 255 || !a.filename.trim()) {
				throw new SendValidationError("E_HEADER_VALUE_INVALID", `Attachment name '${a.filename.slice(0, 40)}' is not valid.`);
			}
			const type = a.type && /^[!-~]{1,78}$/.test(a.type) ? a.type : undefined;
			const att: Record<string, unknown> = {
				FileName: a.filename,
				RawContent: a.content,
				ContentDisposition: a.disposition === "inline" ? "INLINE" : "ATTACHMENT",
				ContentTransferEncoding: "BASE64",
			};
			if (type) att.ContentType = type;
			if (a.contentId) {
				const cid = a.contentId.replace(/^<|>$/g, "");
				if (!/^[!-~]{1,78}$/.test(cid)) {
					throw new SendValidationError("E_HEADER_VALUE_INVALID", "An inline attachment's Content-ID is not valid.");
				}
				att.ContentId = cid;
			}
			return att;
		});
	}
	const destination: Record<string, string[]> = {};
	const to = formatAddressList(message.to);
	const cc = formatAddressList(message.cc);
	const bcc = formatAddressList(message.bcc);
	if (to.length) destination.ToAddresses = to;
	if (cc.length) destination.CcAddresses = cc;
	if (bcc.length) destination.BccAddresses = bcc;
	const out: Record<string, unknown> = {
		FromEmailAddress: formatAddress(message.from),
		Destination: destination,
		Content: { Simple: simple },
		EmailTags: [
			{ Name: "cm_send", Value: tagValue(options.sendTag) },
			{ Name: "cm_domain", Value: tagValue(options.domain) },
		],
	};
	if (message.replyTo) out.ReplyToAddresses = [formatAddress(message.replyTo)];
	if (options.configurationSet) out.ConfigurationSetName = options.configurationSet;
	return out;
}

export class SesTransport implements MailTransport {
	readonly kind = "ses" as const;
	readonly domain: string;
	readonly region: string;
	readonly configurationSet: string | null;
	// Private fields are invisible to JSON.stringify, util.inspect and logs.
	readonly #accessKeyId: string;
	readonly #secretAccessKey: string;

	constructor(config: SesTransportConfig) {
		this.domain = config.domain;
		this.region = config.region;
		this.configurationSet = config.configurationSet;
		this.#accessKeyId = config.accessKeyId;
		this.#secretAccessKey = config.secretAccessKey;
	}

	/** True when credentials were supplied; never the credentials themselves. */
	get hasCredentials(): boolean {
		return !!this.#accessKeyId && !!this.#secretAccessKey;
	}

	validate(message: OutgoingMessage): void {
		validateProviderMessage(message, "Amazon SES");
	}

	async send(message: OutgoingMessage): Promise<TransportSendResult> {
		const sendTag = message.sendTag ?? newSendTag();
		const payload = JSON.stringify(
			sesSendEmailBody(message, { configurationSet: this.configurationSet, sendTag, domain: this.domain }),
		);
		const client = new AwsClient({
			accessKeyId: this.#accessKeyId,
			secretAccessKey: this.#secretAccessKey,
			service: "ses",
			region: this.region,
			retries: 0,
		});
		const url = `${sesApiBase(this.region)}/v2/email/outbound-emails`;
		const fetchImpl = sesTransportDeps.fetchImpl ?? fetch;
		const fail = (code: string, msg: string, status: number | null) =>
			new ProviderSendError(code, msg, "ses", sendTag, status);

		for (let attempt = 0; ; attempt++) {
			let res: Response;
			try {
				const signed = await client.sign(url, {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: payload,
				});
				res = await fetchWithTimeout(fetchImpl, signed);
			} catch (e) {
				const timeout = (e as Error)?.name === "AbortError" || (e as Error)?.name === "TimeoutError";
				throw fail(
					"E_SES_UNCONFIRMED",
					timeout
						? "Amazon SES didn't answer in time; the message may have been sent."
						: "The connection to Amazon SES failed; the message may have been sent.",
					null,
				);
			}
			let text = "";
			try {
				text = await res.text();
			} catch {
				throw fail("E_SES_UNCONFIRMED", "Amazon SES's answer couldn't be read; the message may have been sent.", res.status);
			}
			let body: Record<string, unknown> = {};
			try {
				body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
			} catch {
				body = {};
			}
			if (res.ok) {
				const id = typeof body.MessageId === "string" ? body.MessageId.trim() : "";
				if (!/^[A-Za-z0-9._-]{1,200}$/.test(id)) {
					throw fail("E_SES_UNCONFIRMED", "Amazon SES answered without a message id; the message may have been sent.", res.status);
				}
				return {
					messageId: `${id}@${sesMessageIdDomain(this.region)}`,
					providerMessageId: id,
					sendTag,
				};
			}
			const verdict = classifySesResponse(res.status, awsErrorName(res.headers.get("x-amzn-errortype"), body), awsErrorMessage(body));
			if (verdict.kind === "retry") {
				if (attempt < providerSendDeps.maxRetries) {
					await providerSendDeps.sleep(backoffMs(attempt));
					continue;
				}
				// Throttled every time: SES didn't take it.
				throw fail(
					res.status === 408 ? "E_SES_REQUEST_TIMEOUT" : "E_SES_THROTTLED",
					res.status === 408
						? "Amazon SES timed out receiving the request. The message was not sent."
						: "Amazon SES is throttling this account. The message was not sent; try again shortly.",
					res.status,
				);
			}
			if (verdict.kind === "unconfirmed") throw fail("E_SES_UNCONFIRMED", verdict.message, res.status);
			throw fail(verdict.code, verdict.message, res.status);
		}
	}
}
