import { describe, expect, it } from "vitest";
import { signWebhookPayload, verifyWebhook, WebhookVerificationError } from "../src/webhooks.js";
// The server's own signer and reference verifier.
import { signWebhook, verifyWebhookSignature } from "../../../shared/webhooks";

const SECRET = "whsec_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TS = 1793059200;
const BODY =
	'{"id":"evt_1","type":"message.received","created_at":"2026-10-27T00:00:00.000Z","mailbox":"support@example.com","data":{"id":"m1","subject":"Hi ✓"}}';
// Computed with shared/webhooks.ts signWebhook; the Python SDK tests pin the same values.
const BODY_SIG = "v1=6fdd771f8f974ef2e6519907a8c1c30ec56752d3eeb12b067b7fe6cac72df768";
const EMPTY_SIG = "v1=2506f3d663603affe43e5062872df8aa9a3cf7347139786c82ca46130f0adf92";

const headers = (sig: string, ts: number | string = TS) => ({ "X-Tapetide-Signature": sig, "X-Tapetide-Timestamp": String(ts) });

describe("verifyWebhook", () => {
	it("matches the fixed vectors", async () => {
		expect(await signWebhookPayload(SECRET, TS, BODY)).toBe(BODY_SIG);
		expect(await signWebhookPayload(SECRET, TS, "")).toBe(EMPTY_SIG);
	});

	it("agrees with the server signer on fresh input", async () => {
		const body = JSON.stringify({ id: "evt_x", type: "message.sent", data: { subject: "Ünïcödé 🎉" } });
		expect(await signWebhookPayload(SECRET, 1700000000, body)).toBe(await signWebhook(SECRET, 1700000000, body));
		const ours = await signWebhookPayload("whsec_other", 1700000001, body);
		expect(await verifyWebhookSignature({ secret: "whsec_other", timestamp: 1700000001, body, signatureHeader: ours, nowSeconds: 1700000001 })).toBe(true);
	});

	it("returns the parsed event", async () => {
		const event = await verifyWebhook(BODY, headers(BODY_SIG), SECRET, { nowSeconds: TS + 10 });
		expect(event.type).toBe("message.received");
		expect(event.data.subject).toBe("Hi ✓");
	});

	it("accepts a Buffer / Uint8Array body and a Headers object", async () => {
		const h = new Headers(headers(BODY_SIG));
		await expect(verifyWebhook(new TextEncoder().encode(BODY), h, SECRET, { nowSeconds: TS })).resolves.toBeTruthy();
		await expect(verifyWebhook(Buffer.from(BODY, "utf8"), h, SECRET, { nowSeconds: TS })).resolves.toBeTruthy();
	});

	it("reads headers case-insensitively, including Node's lower-case form", async () => {
		const lower = { "x-tapetide-signature": BODY_SIG, "x-tapetide-timestamp": String(TS) };
		await expect(verifyWebhook(BODY, lower, SECRET, { nowSeconds: TS })).resolves.toBeTruthy();
	});

	it("accepts any of several comma-separated signatures", async () => {
		const h = headers(`v1=${"0".repeat(64)}, ${BODY_SIG}`);
		await expect(verifyWebhook(BODY, h, SECRET, { nowSeconds: TS })).resolves.toBeTruthy();
	});

	const reject = async (p: Promise<unknown>, reason: WebhookVerificationError["reason"]) => {
		const err = await p.catch((e) => e);
		expect(err).toBeInstanceOf(WebhookVerificationError);
		expect(err.reason).toBe(reason);
	};

	it("rejects a tampered body", () => reject(verifyWebhook(BODY.replace("Hi", "Ho"), headers(BODY_SIG), SECRET, { nowSeconds: TS }), "signature_mismatch"));
	it("rejects the wrong secret", () => reject(verifyWebhook(BODY, headers(BODY_SIG), "whsec_wrong", { nowSeconds: TS }), "signature_mismatch"));
	it("rejects a moved timestamp", () => reject(verifyWebhook(BODY, headers(BODY_SIG, TS + 1), SECRET, { nowSeconds: TS }), "signature_mismatch"));
	it("rejects an old delivery", () => reject(verifyWebhook(BODY, headers(BODY_SIG), SECRET, { nowSeconds: TS + 301 }), "timestamp_out_of_range"));
	it("rejects a future delivery", () => reject(verifyWebhook(BODY, headers(BODY_SIG), SECRET, { nowSeconds: TS - 301 }), "timestamp_out_of_range"));
	it("honours a custom tolerance", async () => {
		await expect(verifyWebhook(BODY, headers(BODY_SIG), SECRET, { nowSeconds: TS + 1000, toleranceSeconds: 1200 })).resolves.toBeTruthy();
	});
	it("rejects missing headers", () => reject(verifyWebhook(BODY, { "X-Tapetide-Signature": BODY_SIG }, SECRET), "missing_header"));
	it("rejects a malformed timestamp", () => reject(verifyWebhook(BODY, headers(BODY_SIG, "12abc"), SECRET), "bad_timestamp"));
});
