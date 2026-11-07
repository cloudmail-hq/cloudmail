/**
 * Webhook signature verification, matching the server's signer
 * (`shared/webhooks.ts`):
 *
 *   X-Tapetide-Timestamp: <unix seconds>
 *   X-Tapetide-Signature: v1=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
 *
 * The HMAC key is the whole secret string, `whsec_` prefix included. The
 * signature header may carry several comma-separated values (during a secret
 * rotation); any match passes. Uses Web Crypto only, so it runs in Node 20+,
 * Workers, Deno, Bun and browsers.
 */

import type { WebhookEvent } from "./types.js";

export const SIGNATURE_HEADER = "X-Tapetide-Signature";
export const TIMESTAMP_HEADER = "X-Tapetide-Timestamp";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export class WebhookVerificationError extends Error {
	override name = "WebhookVerificationError";
	constructor(
		message: string,
		readonly reason: "missing_header" | "bad_timestamp" | "timestamp_out_of_range" | "signature_mismatch" | "invalid_json",
	) {
		super(message);
	}
}

export type HeaderSource = Headers | Record<string, string | string[] | undefined> | Iterable<[string, string]>;

export interface VerifyOptions {
	/** Allowed clock drift in seconds (default 300). */
	toleranceSeconds?: number;
	/** Current time in unix seconds (tests). */
	nowSeconds?: number;
}

function header(headers: HeaderSource, name: string): string | undefined {
	if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
	const lower = name.toLowerCase();
	const entries: Iterable<[string, unknown]> =
		Symbol.iterator in (headers as object) ? (headers as Iterable<[string, string]>) : Object.entries(headers as Record<string, unknown>);
	for (const [k, v] of entries) {
		if (k.toLowerCase() !== lower) continue;
		if (Array.isArray(v)) return v.join(",");
		return typeof v === "string" ? v : undefined;
	}
	return undefined;
}

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
	return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function bodyBytes(rawBody: string | Uint8Array | ArrayBuffer): Uint8Array {
	if (typeof rawBody === "string") return encoder.encode(rawBody);
	return rawBody instanceof Uint8Array ? rawBody : new Uint8Array(rawBody);
}

/** `v1=<hex>` for a timestamp and raw body. Exposed for tests and tooling. */
export async function signWebhookPayload(
	secret: string,
	timestamp: number | string,
	rawBody: string | Uint8Array | ArrayBuffer,
): Promise<string> {
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const prefix = encoder.encode(`${timestamp}.`);
	const body = bodyBytes(rawBody);
	const message = new Uint8Array(prefix.length + body.length);
	message.set(prefix, 0);
	message.set(body, prefix.length);
	return `v1=${toHex(await crypto.subtle.sign("HMAC", key, message))}`;
}

/**
 * Verify a delivery and return the parsed event. Throws
 * `WebhookVerificationError` on any failure.
 *
 * Pass the raw request body exactly as received (before any JSON parsing), e.g.
 * `await request.text()` or Express's `express.raw()` buffer.
 */
export async function verifyWebhook<T = WebhookEvent>(
	rawBody: string | Uint8Array | ArrayBuffer,
	headers: HeaderSource,
	secret: string,
	options: VerifyOptions = {},
): Promise<T> {
	const signature = header(headers, SIGNATURE_HEADER);
	const timestamp = header(headers, TIMESTAMP_HEADER);
	if (!signature || !timestamp) {
		throw new WebhookVerificationError(`Missing ${!signature ? SIGNATURE_HEADER : TIMESTAMP_HEADER} header`, "missing_header");
	}
	if (!/^\d{1,12}$/.test(timestamp.trim())) throw new WebhookVerificationError("Malformed timestamp", "bad_timestamp");
	const ts = Number(timestamp.trim());
	const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
	if (Math.abs(now - ts) > (options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) {
		throw new WebhookVerificationError("Timestamp outside the tolerance window", "timestamp_out_of_range");
	}
	const expected = await signWebhookPayload(secret, ts, rawBody);
	const ok = signature
		.split(",")
		.map((s) => s.trim())
		.some((candidate) => timingSafeEqual(candidate, expected));
	if (!ok) throw new WebhookVerificationError("Signature does not match", "signature_mismatch");
	const text = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(bodyBytes(rawBody));
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new WebhookVerificationError("Body is not JSON", "invalid_json");
	}
}
