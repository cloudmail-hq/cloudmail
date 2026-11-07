// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Opaque, signed tokens for the public tracking endpoints.
 *
 * ## The problem these solve
 *
 * A tracking pixel and a click redirect are fetched by the *recipient*, who has
 * no Cloudflare Access identity — so these are the first routes in the app that
 * must be reachable without authentication. That makes the URL itself the only
 * thing the endpoint can trust, and a guessable URL (`?email=123&to=x@y`) would
 * let anyone forge opens and clicks for any message, or enumerate who was mailed
 * what. So the token must be:
 *
 *   - **Unforgeable** — signed with a per-mailbox secret, so a value not minted
 *     by us is rejected. HMAC-SHA256 over the payload; the endpoint recomputes
 *     it and compares in constant time.
 *   - **Self-describing** — it names the mailbox in the clear so the endpoint
 *     knows *whose* secret to verify against, before it trusts anything else.
 *     The mailbox id is not a secret (it is an email address), so revealing it
 *     costs nothing; everything that matters is under the signature.
 *   - **Tamper-evident** — the recipient, the email id, the event kind and (for
 *     clicks) the destination URL are all inside the signed payload, so none can
 *     be swapped without breaking the signature. In particular the click target
 *     is signed, which is what stops the redirect being turned into an open
 *     redirect pointed at an attacker's site.
 *
 * ## Format
 *
 * `<b64url(payload)>.<b64url(hmac)>`, both URL-safe base64 without padding. The
 * payload is compact JSON with single-letter keys to keep the pixel URL short.
 * There is no expiry: a tracking link lives as long as the email does, and a
 * recipient may open a message weeks later — a legitimate open we still want to
 * record. Revocation is by rotating the mailbox secret, which invalidates every
 * outstanding token for that mailbox at once.
 *
 * Pure and dependency-free (Web Crypto only), so it runs in both the Worker and
 * the tests unchanged.
 */

import type { EngagementEventType } from "./delivery-events";

/** What a verified tracking token carries. */
export interface TrackingTokenPayload {
	/** Mailbox id (its address). In the clear, so the endpoint can pick a secret. */
	mailboxId: string;
	/** Local email id the event is about. */
	emailId: string;
	/** Recipient the token was minted for, or null for a message-level pixel. */
	recipient: string | null;
	/** Which engagement kind this token records. */
	kind: EngagementEventType;
	/** For a click: the destination to redirect to. Signed, so it cannot be swapped. */
	url?: string;
	/** For an attachment: the attachment id being fetched. */
	attachmentId?: string;
}

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** The compact on-wire JSON shape. Single-letter keys keep the URL short. */
interface WirePayload {
	m: string;
	e: string;
	r: string | null;
	k: string;
	u?: string;
	a?: string;
}

function toWire(payload: TrackingTokenPayload): WirePayload {
	const wire: WirePayload = {
		m: payload.mailboxId,
		e: payload.emailId,
		r: payload.recipient,
		k: payload.kind,
	};
	if (payload.url !== undefined) wire.u = payload.url;
	if (payload.attachmentId !== undefined) wire.a = payload.attachmentId;
	return wire;
}

async function importKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

/**
 * Constant-time comparison of two byte arrays.
 *
 * `crypto.subtle.verify` is itself constant-time, but the token is verified by
 * recomputing and comparing rather than by `verify` so the same code path serves
 * both signing and checking; this keeps the comparison from leaking timing.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
	return diff === 0;
}

/**
 * Mint a signed tracking token for a mailbox's secret.
 *
 * The mailbox id is read from the payload and travels in the clear; everything
 * (including the mailbox id, so a token cannot be re-pointed at another mailbox)
 * is under the HMAC.
 */
export async function signTrackingToken(
	payload: TrackingTokenPayload,
	secret: string,
): Promise<string> {
	const body = encoder.encode(JSON.stringify(toWire(payload)));
	const key = await importKey(secret);
	const signature = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, body),
	);
	return `${toBase64Url(body)}.${toBase64Url(signature)}`;
}

/**
 * The mailbox id a token claims, WITHOUT verifying the signature.
 *
 * The endpoint needs this to know which mailbox's secret to load before it can
 * verify — a deliberate two-step: read the claim, fetch that mailbox's secret,
 * then `verifyTrackingToken` proves the claim. Never act on this value; it is
 * unauthenticated until the full verify passes.
 */
export function readClaimedMailbox(token: string): string | null {
	try {
		const [body] = token.split(".");
		if (!body) return null;
		const wire = JSON.parse(
			new TextDecoder().decode(fromBase64Url(body)),
		) as WirePayload;
		return typeof wire.m === "string" && wire.m !== "" ? wire.m : null;
	} catch {
		return null;
	}
}

/**
 * Verify a token against a mailbox secret and return its payload, or null.
 *
 * Returns null for any failure — malformed, bad signature, wrong secret — so the
 * caller has one "reject" path and never a partial payload to misuse. The
 * signature is checked before the JSON is trusted, so a tampered payload is
 * rejected at the crypto step rather than parsed.
 */
export async function verifyTrackingToken(
	token: string,
	secret: string,
): Promise<TrackingTokenPayload | null> {
	try {
		const [body, sig] = token.split(".");
		if (!body || !sig) return null;

		const key = await importKey(secret);
		const expected = new Uint8Array(
			await crypto.subtle.sign("HMAC", key, fromBase64Url(body)),
		);
		const provided = fromBase64Url(sig);
		if (!timingSafeEqual(expected, provided)) return null;

		const wire = JSON.parse(
			new TextDecoder().decode(fromBase64Url(body)),
		) as WirePayload;

		if (
			typeof wire.m !== "string" ||
			typeof wire.e !== "string" ||
			typeof wire.k !== "string"
		) {
			return null;
		}

		return {
			mailboxId: wire.m,
			emailId: wire.e,
			recipient: wire.r ?? null,
			kind: wire.k as EngagementEventType,
			url: wire.u,
			attachmentId: wire.a,
		};
	} catch {
		return null;
	}
}
