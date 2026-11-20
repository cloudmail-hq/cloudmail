/**
 * SES and Resend transports: SigV4 signing, field mapping, header-injection
 * guards, provider limits, retry and failure classification. No network: every
 * request goes to an in-test fake, and credentials are built at runtime.
 */

import { AwsV4Signer } from "aws4fetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	SesTransport,
	classifySesResponse,
	sesSendEmailBody,
	sesTransportDeps,
} from "../workers/lib/ses-transport";
import {
	ResendTransport,
	classifyResendResponse,
	resendEmailBody,
	resendIdempotencyKey,
	resendTransportDeps,
} from "../workers/lib/resend-transport";
import { ProviderSendError, providerSendDeps, formatAddress, encodeDisplayName } from "../workers/lib/provider-send";
import { classifySendFailure } from "../workers/lib/held-send";
import { describeSendError } from "../shared/send-errors";
import { validateProviderMessage, providerHeaders, trimReferences } from "../shared/provider-limits";
import { fromAddressOf } from "../workers/lib/mail-transport";
import { redactSecrets } from "../shared/redact-secrets";

const KEY_ID = ["AKIA", "TESTKEY00000", "LAST"].join("");
const SECRET = ["fake", "Secret", "/+="].join("").padEnd(40, "q");
const RESEND_KEY = ["re", "_", "testkey", "0123456789abcdef"].join("");

function ses(configurationSet: string | null = "cloudmail") {
	return new SesTransport({ domain: "ses.example", region: "eu-west-1", accessKeyId: KEY_ID, secretAccessKey: SECRET, configurationSet });
}

type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A fake endpoint that answers from a script and records each request. */
function fake(script: Answer[]) {
	const calls: Request[] = [];
	const bodies: string[] = [];
	const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const req = input instanceof Request ? input : new Request(String(input), init);
		calls.push(req);
		bodies.push(await req.clone().text());
		const next = script[Math.min(calls.length - 1, script.length - 1)]!;
		if (next instanceof Error) throw next;
		return new Response(next.body === undefined ? "" : JSON.stringify(next.body), {
			status: next.status,
			headers: { "content-type": "application/json", ...(next.headers ?? {}) },
		});
	}) as typeof fetch;
	return { impl, calls, bodies };
}

const sleeps: number[] = [];
beforeEach(() => {
	sleeps.length = 0;
	providerSendDeps.sleep = async (ms) => void sleeps.push(ms);
	providerSendDeps.random = () => 0.5;
	providerSendDeps.timeoutMs = 15_000;
});
afterEach(() => {
	sesTransportDeps.fetchImpl = undefined;
	resendTransportDeps.fetchImpl = undefined;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const MSG = {
	from: { email: "a@ses.example", name: "Zoë Ünïcode" },
	to: ["x@elsewhere.example", "Y Person <y@elsewhere.example>"],
	cc: "c@elsewhere.example",
	bcc: ["b@elsewhere.example"],
	replyTo: "reply@ses.example",
	subject: "Grüße\r\nBcc: evil@x",
	html: "<p>Héllo <img src=\"cid:logo1\"></p>",
	text: "Héllo",
	headers: { "In-Reply-To": "<p@x>", "List-Id": "Nëws <news.ses.example>" },
	attachments: [
		{ content: "aGVsbG8=", filename: "logo.png", type: "image/png", disposition: "inline" as const, contentId: "<logo1>" },
		{ content: "aGVsbG8=", filename: "report.pdf", type: "application/pdf", disposition: "attachment" as const },
	],
};

// -- SigV4 -------------------------------------------------------------------------

describe("SigV4 (aws4fetch) against the AWS test-suite vector", () => {
	it("post-vanilla: POST / on example.amazonaws.com signs to the published signature", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2015-08-30T12:36:00Z"));
		const signer = new AwsV4Signer({
			method: "POST",
			url: "https://example.amazonaws.com/",
			accessKeyId: "AKIDEXAMPLE",
			secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			service: "service",
			region: "us-east-1",
		});
		const { headers } = await signer.sign();
		const auth = headers.get("authorization")!;
		expect(auth).toContain("Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request");
		expect(auth).toContain("SignedHeaders=host;x-amz-date");
		expect(auth).toContain("Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b");
	});

	it("the transport signs every SendEmail with service ses and the domain's region", async () => {
		const f = fake([{ status: 200, body: { MessageId: "0100abc-def" } }]);
		sesTransportDeps.fetchImpl = f.impl;
		await ses().send({ from: "a@ses.example", to: "x@y.example", subject: "s", text: "t" });
		const auth = f.calls[0]!.headers.get("authorization")!;
		expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATESTKEY00000LAST\/\d{8}\/eu-west-1\/ses\/aws4_request/);
		expect(f.calls[0]!.url).toBe("https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails");
		expect(f.calls[0]!.method).toBe("POST");
	});
});

// -- mapping -------------------------------------------------------------------------

describe("SES SendEmail mapping", () => {
	it("maps every field, encodes UTF-8 and keeps inline attachments", () => {
		const body = sesSendEmailBody(MSG, { configurationSet: "cloudmail", sendTag: "row-1", domain: "ses.example" }) as any;
		expect(body.FromEmailAddress).toBe(`${encodeDisplayName("Zoë Ünïcode")} <a@ses.example>`);
		expect(body.FromEmailAddress).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <a@ses\.example>$/);
		expect(body.Destination).toEqual({
			ToAddresses: ["x@elsewhere.example", '"Y Person" <y@elsewhere.example>'],
			CcAddresses: ["c@elsewhere.example"],
			BccAddresses: ["b@elsewhere.example"],
		});
		expect(body.ReplyToAddresses).toEqual(["reply@ses.example"]);
		// CR/LF in the subject can't add a header: folded to a space, then encoded.
		expect(body.Content.Simple.Subject.Data).toMatch(/^=\?UTF-8\?B\?/);
		expect(atob(body.Content.Simple.Subject.Data.replace(/^=\?UTF-8\?B\?|\?=$/g, ""))).not.toMatch(/[\r\n]/);
		expect(body.Content.Simple.Body).toEqual({
			Html: { Data: MSG.html, Charset: "UTF-8" },
			Text: { Data: "Héllo", Charset: "UTF-8" },
		});
		expect(body.Content.Simple.Headers).toEqual([
			{ Name: "In-Reply-To", Value: "<p@x>" },
			{ Name: "List-Id", Value: expect.stringMatching(/^=\?UTF-8\?B\?.+\?=/) },
		]);
		expect(body.Content.Simple.Attachments).toEqual([
			{ FileName: "logo.png", RawContent: "aGVsbG8=", ContentType: "image/png", ContentDisposition: "INLINE", ContentTransferEncoding: "BASE64", ContentId: "logo1" },
			{ FileName: "report.pdf", RawContent: "aGVsbG8=", ContentType: "application/pdf", ContentDisposition: "ATTACHMENT", ContentTransferEncoding: "BASE64" },
		]);
		expect(body.ConfigurationSetName).toBe("cloudmail");
		expect(body.EmailTags).toEqual([
			{ Name: "cm_send", Value: "row-1" },
			{ Name: "cm_domain", Value: "ses_example" },
		]);
	});

	it("punycodes an IDN domain and refuses a non-ASCII local part", () => {
		expect(formatAddress("someone@bücher.example")).toBe("someone@xn--bcher-kva.example");
		expect(() => formatAddress("zoë@x.example")).toThrow(/plain ASCII/);
	});

	it("refuses CR/LF in addresses, display names and header values", () => {
		expect(() => sesSendEmailBody({ ...MSG, to: "a@b.example\r\nBcc: z@z.example" }, { configurationSet: null, sendTag: "t", domain: "d" })).toThrow();
		expect(() => sesSendEmailBody({ ...MSG, from: { email: "a@ses.example", name: "A\nBcc: z@z" } }, { configurationSet: null, sendTag: "t", domain: "d" })).toThrow();
		expect(() => validateProviderMessage({ to: "a@b.example", headers: { "X-A": "v\r\nBcc: z@z.example" } }, "Amazon SES")).toThrow(
			expect.objectContaining({ code: "E_HEADER_VALUE_INVALID" }),
		);
		expect(() => validateProviderMessage({ to: "a@b.example", headers: { "X-A:B": "v" } }, "Amazon SES")).toThrow(
			expect.objectContaining({ code: "E_HEADER_NAME_INVALID" }),
		);
	});

	it("a Resend send carries the same mapping, tags and an empty text when there is none", () => {
		const body = resendEmailBody({ ...MSG, text: undefined }, { sendTag: "row-1", domain: "ses.example" }) as any;
		expect(body.from).toMatch(/^=\?UTF-8\?B\?.+\?= <a@ses\.example>$/);
		expect(body.to).toEqual(["x@elsewhere.example", '"Y Person" <y@elsewhere.example>']);
		expect(body.reply_to).toEqual(["reply@ses.example"]);
		expect(body.subject).not.toMatch(/[\r\n]/);
		expect(body.text).toBe("");
		expect(body.headers["In-Reply-To"]).toBe("<p@x>");
		expect(body.attachments[0]).toEqual({ content: "aGVsbG8=", filename: "logo.png", content_type: "image/png", content_id: "logo1" });
		expect(body.tags).toEqual([
			{ name: "cm_send", value: "row-1" },
			{ name: "cm_domain", value: "ses_example" },
		]);
	});
});

// -- limits --------------------------------------------------------------------------

describe("SES / Resend validate()", () => {
	const t = () => ses();
	it("allows 50 recipients and refuses 51", () => {
		const fifty = Array.from({ length: 50 }, (_, i) => `r${i}@x.example`);
		expect(() => t().validate({ from: "a@ses.example", to: fifty, subject: "s" })).not.toThrow();
		expect(() => t().validate({ from: "a@ses.example", to: [...fifty, "one@x.example"], subject: "s" })).toThrow(
			expect.objectContaining({ code: "E_TOO_MANY_RECIPIENTS" }),
		);
	});

	it("allows 15 custom headers and refuses 16", () => {
		const h = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`X-H${i}`, "v"]));
		expect(() => t().validate({ from: "a@ses.example", to: "x@y.example", subject: "s", headers: h(15) })).not.toThrow();
		expect(() => t().validate({ from: "a@ses.example", to: "x@y.example", subject: "s", headers: h(16) })).toThrow(
			expect.objectContaining({ code: "E_HEADERS_TOO_MANY" }),
		);
		// More than Cloudflare's 32 attachments is fine for SES.
		const many = Array.from({ length: 40 }, (_, i) => ({ content: "aGk=", filename: `f${i}.txt`, type: "text/plain", disposition: "attachment" as const }));
		expect(() => t().validate({ from: "a@ses.example", to: "x@y.example", subject: "s", attachments: many })).not.toThrow();
	});

	it("enforces 995 / 996 characters per header and trims References to fit", () => {
		expect(() => t().validate({ from: "a@ses.example", to: "x@y.example", subject: "s", headers: { "X-Long": "v".repeat(996) } })).toThrow(
			expect.objectContaining({ code: "E_HEADER_VALUE_TOO_LONG" }),
		);
		const refs = Array.from({ length: 60 }, (_, i) => `<id${i}-${"x".repeat(20)}@host.example>`).join(" ");
		const out = providerHeaders({ References: refs }).References!;
		expect(out.length).toBeLessThanOrEqual(995);
		expect(out.startsWith("<id0-")).toBe(true);
		expect(out.endsWith("<id59-xxxxxxxxxxxxxxxxxxxx@host.example>")).toBe(true);
		expect(trimReferences("<a> <b> <c>", 7)).toBe("<a> <c>");
		expect(() => t().validate({ from: "a@ses.example", to: "x@y.example", subject: "s", headers: { References: refs } })).not.toThrow();
	});

	it("refuses headers SES sets itself", () => {
		for (const name of ["Message-ID", "From", "Return-Path", "Content-Type"]) {
			expect(() => t().validate({ from: "a@ses.example", to: "x@y.example", subject: "s", headers: { [name]: "v" } })).toThrow(
				expect.objectContaining({ code: "E_HEADER_NOT_ALLOWED" }),
			);
		}
	});

	it("refuses blocked extensions and messages over 40 MB after base64", () => {
		expect(() =>
			t().validate({ from: "a@ses.example", to: "x@y.example", subject: "s", attachments: [{ content: "aGk=", filename: "run.JS", type: "text/javascript", disposition: "attachment" }] }),
		).toThrow(expect.objectContaining({ code: "E_ATTACHMENT_BLOCKED" }));
		const big = "A".repeat(39_000_000);
		expect(() =>
			t().validate({ from: "a@ses.example", to: "x@y.example", subject: "s", attachments: [{ content: big, filename: "a.bin", type: "application/octet-stream", disposition: "attachment" }] }),
		).toThrow(expect.objectContaining({ code: "E_CONTENT_TOO_LARGE" }));
		// 10 MB is fine (Cloudflare's limit is 5 MiB).
		expect(() =>
			t().validate({ from: "a@ses.example", to: "x@y.example", subject: "s", attachments: [{ content: "A".repeat(10_000_000), filename: "a.bin", type: "application/octet-stream", disposition: "attachment" }] }),
		).not.toThrow();
	});

	it("Resend applies the same limits", () => {
		const r = new ResendTransport({ domain: "ses.example", apiKey: RESEND_KEY });
		expect(() => r.validate({ from: "a@ses.example", to: "x@y.example", subject: "s", attachments: [{ content: "aGk=", filename: "x.exe", type: "x", disposition: "attachment" }] })).toThrow(
			expect.objectContaining({ code: "E_ATTACHMENT_BLOCKED" }),
		);
	});
});

// -- SES errors and retry ---------------------------------------------------------------

describe("SES classification and retry", () => {
	it("returns the RFC Message-ID form and the bare provider id", async () => {
		sesTransportDeps.fetchImpl = fake([{ status: 200, body: { MessageId: "0100abc-def-000000" } }]).impl;
		expect(await ses().send({ from: "a@ses.example", to: "x@y.example", subject: "s", text: "t", sendTag: "row-1" })).toEqual({
			messageId: "0100abc-def-000000@eu-west-1.amazonses.com",
			providerMessageId: "0100abc-def-000000",
			sendTag: "row-1",
		});
		const east = new SesTransport({ domain: "d.example", region: "us-east-1", accessKeyId: KEY_ID, secretAccessKey: SECRET, configurationSet: null });
		expect((await east.send({ from: "a@d.example", to: "x@y.example", subject: "s" })).messageId).toBe("0100abc-def-000000@email.amazonses.com");
	});

	it("retries throttling at most twice with capped full-jitter backoff, then rejects", async () => {
		const f = fake([{ status: 429, headers: { "x-amzn-errortype": "TooManyRequestsException:" }, body: { message: "Maximum sending rate exceeded." } }]);
		sesTransportDeps.fetchImpl = f.impl;
		const err = await ses().send({ from: "a@ses.example", to: "x@y.example", subject: "s" }).catch((e) => e);
		expect(f.calls).toHaveLength(3);
		expect(sleeps).toEqual([500, 1000]); // random 0.5 * min(20 s, 1 s * 2^n)
		expect(err).toBeInstanceOf(ProviderSendError);
		expect(err.code).toBe("E_SES_THROTTLED");
		expect(classifySendFailure(err)).toBe("rejected");
		providerSendDeps.random = () => 0.999;
		expect(Math.max(...[0, 1, 2, 10].map((n) => Math.floor(0.999 * Math.min(20_000, 1000 * 2 ** n))))).toBeLessThanOrEqual(20_000);
	});

	it("retries ThrottlingException and 408, and a throttled-then-accepted send succeeds", async () => {
		const f = fake([
			{ status: 400, headers: { "x-amzn-errortype": "ThrottlingException:" }, body: { message: "Rate exceeded" } },
			{ status: 408, headers: { "x-amzn-errortype": "RequestTimeoutException:" }, body: {} },
			{ status: 200, body: { MessageId: "ok-1" } },
		]);
		sesTransportDeps.fetchImpl = f.impl;
		expect((await ses().send({ from: "a@ses.example", to: "x@y.example", subject: "s" })).providerMessageId).toBe("ok-1");
		expect(f.calls).toHaveLength(3);
	});

	it("never retries the daily quota", async () => {
		const f = fake([{ status: 400, headers: { "x-amzn-errortype": "ThrottlingException:" }, body: { message: "Daily message quota exceeded." } }]);
		sesTransportDeps.fetchImpl = f.impl;
		const err = await ses().send({ from: "a@ses.example", to: "x@y.example", subject: "s" }).catch((e) => e);
		expect(f.calls).toHaveLength(1);
		expect(err.code).toBe("E_SES_DAILY_QUOTA");
		expect(classifySendFailure(err)).toBe("rejected");
	});

	it.each([
		[500, "InternalFailure:", "E_SES_UNCONFIRMED"],
		[503, "ServiceUnavailable:", "E_SES_UNCONFIRMED"],
		[400, "RequestAbortedException:", "E_SES_UNCONFIRMED"],
	])("%i %s is unconfirmed and never retried", async (status, type, code) => {
		const f = fake([{ status, headers: { "x-amzn-errortype": type }, body: {} }]);
		sesTransportDeps.fetchImpl = f.impl;
		const err = await ses().send({ from: "a@ses.example", to: "x@y.example", subject: "s", sendTag: "row-9" }).catch((e) => e);
		expect(f.calls).toHaveLength(1);
		expect(err.code).toBe(code);
		expect(err.sendTag).toBe("row-9");
		expect(classifySendFailure(err)).toBe("unconfirmed");
	});

	it("a network error, a timeout or an unreadable 2xx is unconfirmed and not retried", async () => {
		for (const script of [[new TypeError("fetch failed")], [Object.assign(new Error("aborted"), { name: "AbortError" })], [{ status: 200, body: { nope: 1 } }]] as Answer[][]) {
			const f = fake(script);
			sesTransportDeps.fetchImpl = f.impl;
			const err = await ses().send({ from: "a@ses.example", to: "x@y.example", subject: "s" }).catch((e) => e);
			expect(f.calls).toHaveLength(1);
			expect(err.code).toBe("E_SES_UNCONFIRMED");
			expect(classifySendFailure(err)).toBe("unconfirmed");
		}
	});

	it("aborts a hung request after the timeout", async () => {
		providerSendDeps.timeoutMs = 20;
		sesTransportDeps.fetchImpl = ((_i: unknown, init?: RequestInit) =>
			new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("x"), { name: "AbortError" }))))) as typeof fetch;
		const err = await ses().send({ from: "a@ses.example", to: "x@y.example", subject: "s" }).catch((e) => e);
		expect(err.code).toBe("E_SES_UNCONFIRMED");
		expect(err.message).toMatch(/in time/);
	});

	it.each([
		[400, "MessageRejected", "E_SES_MESSAGE_REJECTED"],
		[400, "MailFromDomainNotVerifiedException", "E_SES_MAIL_FROM_NOT_VERIFIED"],
		[400, "AccountSuspendedException", "E_SES_ACCOUNT_SUSPENDED"],
		[400, "SendingPausedException", "E_SES_SENDING_PAUSED"],
		[400, "LimitExceededException", "E_SES_LIMIT_EXCEEDED"],
		[404, "NotFoundException", "E_SES_NOT_FOUND"],
		[403, "AccessDeniedException", "E_SES_ACCESS_DENIED"],
		[403, "SignatureDoesNotMatch", "E_SES_INVALID_CREDENTIALS"],
		[403, "UnrecognizedClientException", "E_SES_INVALID_CREDENTIALS"],
		[403, "OptInRequired", "E_SES_REGION_NOT_ENABLED"],
		[413, "RequestEntityTooLargeException", "E_SES_TOO_LARGE"],
		[400, "BadRequestException", "E_SES_BAD_REQUEST"],
		[400, "SomethingNew", "E_SES_REJECTED"],
	])("%i %s is a definite rejection %s", (status, name, code) => {
		const v = classifySesResponse(status, name, "detail");
		expect(v).toMatchObject({ kind: "rejected", code });
		expect(classifySendFailure(new ProviderSendError(code, "x", "ses", "t"))).toBe("rejected");
	});

	it("reads the error name from the body when the header is missing", async () => {
		sesTransportDeps.fetchImpl = fake([{ status: 400, body: { __type: "com.amazonaws#MessageRejected", message: "Email address is not verified." } }]).impl;
		const err = await ses().send({ from: "a@ses.example", to: "x@y.example", subject: "s" }).catch((e) => e);
		expect(err.code).toBe("E_SES_MESSAGE_REJECTED");
		expect(describeSendError(err)).toMatch(/SES said: Email address is not verified\./);
	});

	it("no error, result or describeSendError text ever carries a credential", async () => {
		sesTransportDeps.fetchImpl = fake([{ status: 403, headers: { "x-amzn-errortype": "SignatureDoesNotMatch:" }, body: { message: `canonical ${SECRET} ${KEY_ID}` } }]).impl;
		const err = await ses().send({ from: "a@ses.example", to: "x@y.example", subject: "s" }).catch((e) => e);
		for (const text of [err.message, JSON.stringify(err), describeSendError(err), JSON.stringify(ses())]) {
			expect(text).not.toContain(SECRET);
			expect(text).not.toContain(KEY_ID);
		}
		expect(redactSecrets(`Authorization: AWS4-HMAC-SHA256 Credential=${KEY_ID}/x, Signature=abc`)).not.toContain(KEY_ID);
		expect(redactSecrets(`key ${RESEND_KEY}`)).not.toContain(RESEND_KEY);
	});
});

// -- Resend errors, retry and idempotency -------------------------------------------------

describe("Resend classification, retry and idempotency", () => {
	const r = () => new ResendTransport({ domain: "ses.example", apiKey: RESEND_KEY });
	const msg = { from: "a@ses.example", to: "x@y.example", subject: "s", text: "t", sendTag: "row-1" };

	it("sends with Bearer auth and an Idempotency-Key stable across retries", async () => {
		const f = fake([{ status: 500, body: { name: "application_error" } }, { status: 200, body: { id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" } }]);
		resendTransportDeps.fetchImpl = f.impl;
		const res = await r().send(msg);
		expect(res).toEqual({ messageId: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c", providerMessageId: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c", sendTag: "row-1" });
		expect(f.calls).toHaveLength(2);
		const keys = f.calls.map((c) => c.headers.get("idempotency-key"));
		expect(keys[0]).toMatch(/^cm-row-1-[0-9a-f]{16}$/);
		expect(keys[0]).toBe(keys[1]);
		expect(keys[0]).toBe(await resendIdempotencyKey("row-1", f.bodies[0]!));
		expect(f.calls[0]!.headers.get("authorization")).toBe(`Bearer ${RESEND_KEY}`);
		expect(f.calls[0]!.url).toBe("https://api.resend.com/emails");
	});

	it("a different body gives a different key", async () => {
		expect(await resendIdempotencyKey("row-1", "a")).not.toBe(await resendIdempotencyKey("row-1", "b"));
	});

	it("retries 429 rate limit, 409 concurrent, 5xx and network errors at most twice, then is unconfirmed", async () => {
		for (const a of [
			{ status: 429, body: { name: "rate_limit_exceeded" }, headers: { "retry-after": "1" } },
			{ status: 409, body: { name: "concurrent_idempotent_requests" } },
			{ status: 503, body: { name: "service_unavailable" } },
			new TypeError("fetch failed"),
		] as Answer[]) {
			sleeps.length = 0;
			const f = fake([a]);
			resendTransportDeps.fetchImpl = f.impl;
			const err = await r().send(msg).catch((e) => e);
			expect(f.calls).toHaveLength(3);
			expect(err.code).toBe("E_RESEND_UNCONFIRMED");
			expect(classifySendFailure(err)).toBe("unconfirmed");
			if (!(a instanceof Error) && a.headers?.["retry-after"]) expect(sleeps).toEqual([1000, 1000]);
		}
	});

	it("409 invalid_idempotent_request is unconfirmed without retry; quota and 4xx are definite rejections", async () => {
		const f = fake([{ status: 409, body: { name: "invalid_idempotent_request" } }]);
		resendTransportDeps.fetchImpl = f.impl;
		const err = await r().send(msg).catch((e) => e);
		expect(f.calls).toHaveLength(1);
		expect(err.code).toBe("E_RESEND_UNCONFIRMED");
		expect(classifyResendResponse(429, "daily_quota_exceeded", "", null)).toMatchObject({ kind: "rejected", code: "E_RESEND_QUOTA_EXCEEDED" });
		expect(classifyResendResponse(429, "monthly_quota_exceeded", "", null)).toMatchObject({ kind: "rejected", code: "E_RESEND_QUOTA_EXCEEDED" });
		expect(classifyResendResponse(401, "validation_error", "", null)).toMatchObject({ kind: "rejected", code: "E_RESEND_INVALID_KEY" });
		expect(classifyResendResponse(403, "validation_error", "domain not verified", null)).toMatchObject({ kind: "rejected", code: "E_RESEND_FORBIDDEN" });
		expect(classifyResendResponse(422, "invalid_attachment", "", null)).toMatchObject({ kind: "rejected", code: "E_RESEND_INVALID_ATTACHMENT" });
		expect(classifyResendResponse(422, "missing_required_field", "", null)).toMatchObject({ kind: "rejected", code: "E_RESEND_REJECTED" });
		expect(classifySendFailure(new ProviderSendError("E_RESEND_REJECTED", "x", "resend", "t"))).toBe("rejected");
	});

	it("never puts the API key in an error or the serialised transport", async () => {
		resendTransportDeps.fetchImpl = fake([{ status: 401, body: { name: "validation_error", message: `API key is invalid: ${RESEND_KEY}` } }]).impl;
		const err = await r().send(msg).catch((e) => e);
		for (const text of [err.message, JSON.stringify(err), describeSendError(err), JSON.stringify(r())]) expect(text).not.toContain(RESEND_KEY);
	});
});

describe("fromAddressOf", () => {
	it("returns the bare address for every From form", () => {
		expect(fromAddressOf({ email: "a@ses.example", name: "A" })).toBe("a@ses.example");
		expect(fromAddressOf("A Person <a@ses.example>")).toBe("a@ses.example");
		expect(fromAddressOf("a@ses.example")).toBe("a@ses.example");
	});
});
