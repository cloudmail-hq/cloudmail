/**
 * Regressions around transport resolution and the paths that feed it:
 *
 * - The settings lookup is retried once; when it still fails the deployment-
 *   wide `anyNonCloudflare` marker decides (false: Cloudflare; true or never
 *   read, with nothing cached: fail closed).
 * - Password reset mail from an SES domain goes through SES.
 * - The transport is chosen by the bare From address for every `from` form.
 * - Tracking is applied exactly once for SES- and Resend-routed sends, and
 *   not at all when it is off: `sendEmail` sends the body it is given.
 *
 * No network: SES and Resend answer from in-test fakes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "../workers/email-sender";
import { clearanceForTest } from "../workers/lib/pre-send";
import {
	CloudflareTransport,
	ResendTransport,
	SesTransport,
	invalidateTransportCache,
	mailTransportDeps,
	resolveTransport,
	type TransportStoreApi,
} from "../workers/lib/mail-transport";
import { sealResendKey, sealSesSecret, type DomainSendingRecord } from "../workers/lib/domain-sending-store";
import { sesTransportDeps } from "../workers/lib/ses-transport";
import { resendTransportDeps } from "../workers/lib/resend-transport";
import { providerSendDeps } from "../workers/lib/provider-send";
import { sendResetEmail } from "../workers/auth/reset-email";
import { trackOutgoingHtml, type TrackingStub } from "../workers/lib/tracking-send";

const AUTH_SECRET = "transport-regression-secret-0123456789";
const KEY_ID = ["AKIA", "TESTKEY00000", "LAST"].join("");
const SECRET = ["fake", "Secret", "/+="].join("").padEnd(40, "q");
const RESEND_KEY = ["re", "_", "testkey", "0123456789abcdef"].join("");

function record(over: Partial<DomainSendingRecord>): DomainSendingRecord {
	return {
		hostname: "ses.example",
		provider: "ses",
		region: "eu-west-1",
		accessKeyId: KEY_ID,
		secretEnc: null,
		configurationSet: "cloudmail",
		snsTopicArn: null,
		webhookId: "0".repeat(32),
		resendKeyEnc: null,
		resendKeyLast4: null,
		resendWebhookSecretEnc: null,
		lastTest: null,
		lastEvent: null,
		updatedAt: 1,
		updatedBy: null,
		...over,
	};
}

function binding() {
	const send = vi.fn(async (_m: unknown) => ({ messageId: "cf-id" }));
	return { b: { send } as unknown as SendEmail, send };
}

function env(b: SendEmail) {
	// AUTH_STORE only has to look like a namespace; `mailTransportDeps.store` answers.
	return { EMAIL: b, AUTH_SECRET, AUTH_STORE: { idFromName: () => "global", get: () => ({}) } };
}

let now = 1_000_000;
beforeEach(() => {
	invalidateTransportCache();
	now = 1_000_000;
	mailTransportDeps.now = () => now;
	mailTransportDeps.sleep = async () => {};
	providerSendDeps.sleep = async () => {};
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	mailTransportDeps.store = undefined;
	sesTransportDeps.fetchImpl = undefined;
	resendTransportDeps.fetchImpl = undefined;
	vi.restoreAllMocks();
});

function storeOf(api: Partial<TransportStoreApi> & { getDomainSending: TransportStoreApi["getDomainSending"] }): TransportStoreApi {
	return { getOrInitMeta: async () => "unused", ...api } as TransportStoreApi;
}

describe("settings lookup failures", () => {
	it("retries the lookup once after a short wait", async () => {
		const sleeps: number[] = [];
		mailTransportDeps.sleep = async (ms) => void sleeps.push(ms);
		let calls = 0;
		const secretEnc = await sealSesSecret(SECRET, AUTH_SECRET, "ses.example");
		mailTransportDeps.store = () =>
			storeOf({
				anyNonCloudflareSending: async () => true,
				getDomainSending: async () => {
					if (calls++ === 0) throw new Error("AuthDO blip");
					return record({ secretEnc });
				},
			});
		expect(await resolveTransport(env(binding().b), "a@ses.example")).toBeInstanceOf(SesTransport);
		expect(calls).toBe(2);
		expect(sleeps).toEqual([150]);
	});

	it("AuthDO throwing with the marker false still sends through Cloudflare", async () => {
		const { b, send } = binding();
		let lookups = 0;
		mailTransportDeps.store = () =>
			storeOf({
				anyNonCloudflareSending: async () => false,
				getDomainSending: async () => {
					lookups++;
					throw new Error("AuthDO down");
				},
			});
		await sendEmail(env(b), { to: "x@y.example", from: "a@cf.example", subject: "s", text: "t" }, clearanceForTest());
		expect(send).toHaveBeenCalledTimes(1);
		expect(lookups).toBe(0); // known false: the per-domain read is skipped
	});

	it("keeps the last good marker when the marker read fails", async () => {
		const { b, send } = binding();
		let markerFails = false;
		mailTransportDeps.store = () =>
			storeOf({
				anyNonCloudflareSending: async () => {
					if (markerFails) throw new Error("down");
					return false;
				},
				getDomainSending: async () => {
					throw new Error("down");
				},
			});
		await sendEmail(env(b), { to: "x@y.example", from: "a@cf.example", subject: "s" }, clearanceForTest());
		markerFails = true;
		now += 60_000; // past the TTL: a refresh is attempted and fails
		await sendEmail(env(b), { to: "x@y.example", from: "a@cf.example", subject: "s" }, clearanceForTest());
		expect(send).toHaveBeenCalledTimes(2);
	});

	it.each([
		["true", async () => true],
		["unknown (the marker read fails, never read before)", async () => {
			throw new Error("down");
		}],
	])("AuthDO throwing with the marker %s and nothing cached fails closed", async (_label, marker) => {
		const { b, send } = binding();
		mailTransportDeps.store = () =>
			storeOf({
				anyNonCloudflareSending: marker as () => Promise<boolean>,
				getDomainSending: async () => {
					throw new Error("AuthDO down");
				},
			});
		const err = await sendEmail(env(b), { to: "x@y.example", from: "a@ses.example", subject: "s" }, clearanceForTest()).catch((e) => e);
		expect(err.code).toBe("E_PROVIDER_LOOKUP_FAILED");
		expect(send).not.toHaveBeenCalled();
	});

	it("a cached SES setting keeps being used through a later lookup failure", async () => {
		const secretEnc = await sealSesSecret(SECRET, AUTH_SECRET, "ses.example");
		let fail = false;
		mailTransportDeps.store = () =>
			storeOf({
				anyNonCloudflareSending: async () => true,
				getDomainSending: async () => {
					if (fail) throw new Error("down");
					return record({ secretEnc });
				},
			});
		expect(await resolveTransport(env(binding().b), "a@ses.example")).toBeInstanceOf(SesTransport);
		fail = true;
		now += 60_000;
		expect(await resolveTransport(env(binding().b), "a@ses.example")).toBeInstanceOf(SesTransport);
	});
});

describe("From address forms", () => {
	it("resolves by the bare address for {email,name}, 'Name <a@b>' and 'a@b'", async () => {
		const secretEnc = await sealSesSecret(SECRET, AUTH_SECRET, "ses.example");
		const asked: string[] = [];
		mailTransportDeps.store = () =>
			storeOf({
				anyNonCloudflareSending: async () => true,
				getDomainSending: async (h) => {
					asked.push(h);
					return h === "ses.example" ? record({ secretEnc }) : null;
				},
			});
		const ok = { status: 200, body: { MessageId: "m-1" } };
		sesTransportDeps.fetchImpl = (async () => new Response(JSON.stringify(ok.body), { status: 200 })) as typeof fetch;
		const { b, send } = binding();
		for (const from of [{ email: "a@ses.example", name: "Support Team" }, "Support <a@ses.example>", "a@ses.example"]) {
			invalidateTransportCache();
			const res = await sendEmail(env(b), { to: "x@y.example", from, subject: "s" }, clearanceForTest());
			expect(res.providerMessageId).toBe("m-1");
		}
		expect(send).not.toHaveBeenCalled();
		expect(new Set(asked)).toEqual(new Set(["ses.example"]));
	});
});

describe("password reset", () => {
	it("an AUTH_EMAIL_FROM on an SES domain sends through SES, not the binding", async () => {
		const secretEnc = await sealSesSecret(SECRET, AUTH_SECRET, "ses.example");
		mailTransportDeps.store = () =>
			storeOf({ anyNonCloudflareSending: async () => true, getDomainSending: async () => record({ secretEnc }) });
		const bodies: any[] = [];
		sesTransportDeps.fetchImpl = (async (input: RequestInfo | URL) => {
			bodies.push(JSON.parse(await (input as Request).text()));
			return new Response(JSON.stringify({ MessageId: "reset-1" }), { status: 200 });
		}) as typeof fetch;
		const { b, send } = binding();
		await sendResetEmail(
			env(b) as never,
			{ email: "no-reply@ses.example", name: "cloudmail" },
			"owner@elsewhere.example",
			{ subject: "Reset your password", text: "link", html: "<p>link</p>" },
			"cloudmail",
		);
		expect(send).not.toHaveBeenCalled();
		expect(bodies).toHaveLength(1);
		expect(bodies[0].FromEmailAddress).toBe('"cloudmail" <no-reply@ses.example>');
		expect(bodies[0].Destination.ToAddresses).toEqual(["owner@elsewhere.example"]);
	});
});

// -- tracking parity ------------------------------------------------------------------

function trackingStub(on: boolean): TrackingStub {
	return {
		getTrackingSettings: async () => ({ openTracking: on, clickTracking: on, attachmentTracking: false }),
		getOrCreateTrackingSecret: async () => "tracking-secret-0123456789abcdef",
	};
}

const HTML = '<html><body><p>Hi <a href="https://example.org/page">read</a></p></body></html>';
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

async function viaProvider(provider: "ses" | "resend", track: boolean): Promise<string> {
	const keyMaterial = AUTH_SECRET;
	const rec =
		provider === "ses"
			? record({ secretEnc: await sealSesSecret(SECRET, keyMaterial, "ses.example") })
			: record({ provider: "resend", region: null, accessKeyId: null, resendKeyEnc: await sealResendKey(RESEND_KEY, keyMaterial, "ses.example") });
	mailTransportDeps.store = () => storeOf({ anyNonCloudflareSending: async () => true, getDomainSending: async () => rec });
	let sentHtml = "";
	const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const text = input instanceof Request ? await input.text() : String(init?.body ?? "");
		const body = JSON.parse(text);
		sentHtml = provider === "ses" ? body.Content.Simple.Body.Html.Data : body.html;
		return new Response(JSON.stringify(provider === "ses" ? { MessageId: "m-1" } : { id: "11111111-2222-3333-4444-555555555555" }), { status: 200 });
	}) as typeof fetch;
	sesTransportDeps.fetchImpl = fakeFetch;
	resendTransportDeps.fetchImpl = fakeFetch;
	const html = await trackOutgoingHtml({
		stub: trackingStub(track),
		mailboxId: "a@ses.example",
		emailId: "row-1",
		html: HTML,
		baseUrl: "https://mail.example.org",
		to: "x@y.example",
	});
	const { b, send } = binding();
	const t = await resolveTransport(env(b), "a@ses.example");
	expect(t).toBeInstanceOf(provider === "ses" ? SesTransport : ResendTransport);
	await sendEmail(env(b), { to: "x@y.example", from: "a@ses.example", subject: "s", html, sendTag: "row-1" }, clearanceForTest());
	expect(send).not.toHaveBeenCalled();
	return sentHtml;
}

describe("tracking parity for SES and Resend", () => {
	it.each(["ses", "resend"] as const)("%s: tracking on gives exactly one pixel and rewritten links", async (provider) => {
		const html = await viaProvider(provider, true);
		expect(count(html, /\/t\/o\//g)).toBe(1);
		expect(count(html, /\/t\/c\//g)).toBe(1);
		expect(html).not.toContain('href="https://example.org/page"');
	});

	it.each(["ses", "resend"] as const)("%s: tracking off sends no pixel and the original links", async (provider) => {
		const html = await viaProvider(provider, false);
		expect(count(html, /\/t\/[oc]\//g)).toBe(0);
		expect(html).toContain('href="https://example.org/page"');
	});

	it("Cloudflare is unchanged for a domain with no provider setting", async () => {
		mailTransportDeps.store = () => storeOf({ anyNonCloudflareSending: async () => false, getDomainSending: async () => null });
		expect(await resolveTransport(env(binding().b), "a@cf.example")).toBeInstanceOf(CloudflareTransport);
	});
});
