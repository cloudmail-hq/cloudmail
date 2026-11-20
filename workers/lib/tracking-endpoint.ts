// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The PUBLIC tracking endpoint: the open pixel, the click redirect, and the
 * tracked-attachment redirect.
 *
 * ## Why this is mounted outside Access
 *
 * Every other route in this app is behind Cloudflare Access. These cannot be:
 * they are fetched by the *recipient* of an email — an image load, a link
 * click — and the recipient has no Access identity. This is the first and only
 * unauthenticated surface in the app, so it is written to trust nothing but a
 * signed token:
 *
 *   - The token names its mailbox in the clear; we load that mailbox's secret
 *     and verify the HMAC before trusting any other field. A forged or tampered
 *     token fails the signature and is treated exactly like a missing one.
 *   - The pixel ALWAYS returns a 1×1 GIF, and the click ALWAYS redirects (to the
 *     signed URL on success, or refuses on failure). A tracking endpoint that
 *     revealed, through status codes or timing, whether a token was valid would
 *     leak which emails exist; instead a bad open token still yields the pixel
 *     and records nothing.
 *   - The redirect target is INSIDE the signed payload. That is what stops the
 *     endpoint being an open redirect: an attacker cannot append `?url=evil` and
 *     be forwarded there, because the URL they did not sign will not verify.
 *
 * Recording is best-effort and never blocks the response the recipient is
 * waiting for: the pixel and the redirect are what the recipient's client asked
 * for, and a slow or failing ledger write must not hold up their mail or their
 * click. The write is handed to `waitUntil`.
 *
 * These handlers own their own responses (GIF bytes, 302) rather than JSON, and
 * are deliberately tiny — all the security lives in `verifyTrackingToken`.
 */

import {
	readClaimedMailbox,
	verifyTrackingToken,
	type TrackingTokenPayload,
} from "../../shared/tracking-token";
import type { DeliveryEventSource } from "../../shared/delivery-events";
import {
	classifyOpenProxy,
	MAX_STORED_UA,
	type RequestNetwork,
} from "../../shared/open-proxy";
import type { Env } from "../types";

/**
 * What the endpoint knows about the request beyond its token.
 *
 * Optional so the handlers stay callable without a request (and so the tests
 * that exercise only the token logic need not build one).
 */
export interface TrackingRequestContext {
	userAgent?: string | null;
	network?: RequestNetwork;
	/**
	 * Whether this request comes from a signed-in session of someone who can
	 * read `mailboxId`, i.e. the sender looking at their own mail. Injected so
	 * the endpoint does not depend on the auth store directly.
	 */
	isOwnSession?: (mailboxId: string) => Promise<boolean>;
}

/**
 * Event metadata recorded with an open or click: the user agent (truncated)
 * and, when one is recognised, which mail-privacy proxy fetched it. That is
 * what lets the UI hedge "opened (likely via a privacy proxy)".
 */
export function engagementMetadata(
	context: TrackingRequestContext | undefined,
	extra: Record<string, unknown> = {},
): Record<string, unknown> | null {
	const ua = context?.userAgent?.slice(0, MAX_STORED_UA) || null;
	const proxy = classifyOpenProxy(context?.userAgent, context?.network);
	const metadata: Record<string, unknown> = { ...extra };
	if (ua) metadata.ua = ua;
	if (proxy) metadata.proxy = proxy;
	return Object.keys(metadata).length > 0 ? metadata : null;
}

/**
 * Whether this event should be ignored because the sender caused it: the
 * request carries a valid session for someone who can read the mailbox.
 * Never throws; on an auth-store failure the event is recorded rather than a
 * real one being lost.
 */
async function isSelfOpen(
	payload: TrackingTokenPayload,
	context: TrackingRequestContext | undefined,
): Promise<boolean> {
	if (!context?.isOwnSession) return false;
	try {
		return await context.isOwnSession(payload.mailboxId);
	} catch (e) {
		console.error("Self-open check failed:", (e as Error)?.message);
		return false;
	}
}

/** A 1×1 transparent GIF, the smallest valid image to answer a pixel with. */
const TRANSPARENT_GIF = Uint8Array.from([
	0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
	0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00,
	0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02,
	0x44, 0x01, 0x00, 0x3b,
]);

function pixelResponse(): Response {
	return new Response(TRANSPARENT_GIF, {
		status: 200,
		headers: {
			"Content-Type": "image/gif",
			// Never let a proxy cache the pixel, or a second open would not re-fetch
			// it and would go unrecorded.
			"Cache-Control": "no-store, no-cache, must-revalidate, private",
			"Content-Length": String(TRANSPARENT_GIF.length),
		},
	});
}

/**
 * Resolve a token to its mailbox stub and verified payload, or null.
 *
 * ## Never allocate state from an unverified claim
 *
 * The mailbox id in a token is readable WITHOUT the signature — that is how we
 * know whose secret to check. It is therefore attacker-controlled: anyone can
 * base64url a payload naming `whatever-i-like@x` and attach a bogus signature.
 *
 * `idFromName` on such a value, followed by any RPC, would instantiate a Durable
 * Object, run every migration in its constructor and (on the old
 * `getOrCreateTrackingSecret` path) persist a freshly generated secret — all
 * before the signature was ever checked. With no authentication and no rate
 * limiter on these routes, a loop over random names would create unbounded
 * persistent DO storage and billable work.
 *
 * So the claimed mailbox is checked against the R2 mailbox registry FIRST, which
 * is a plain object read that creates nothing. Only a mailbox that genuinely
 * exists gets a DO instantiated, and the secret is read WITHOUT the
 * create-on-miss path: a mailbox that has never sent tracked mail has no secret
 * and no token of ours can exist for it, so there is nothing to mint here.
 */
async function verify(
	token: string,
	env: Env,
): Promise<{
	payload: TrackingTokenPayload;
	stub: ReturnType<Env["MAILBOX"]["get"]>;
} | null> {
	const mailboxId = readClaimedMailbox(token);
	if (!mailboxId) return null;

	// Cheap existence check that allocates nothing. `listMailboxes` keys mailboxes
	// by address under `mailboxes/<id>.json`, so a HEAD on that key answers
	// "is this a real mailbox" without instantiating anything.
	const registered = await env.BUCKET.head(`mailboxes/${mailboxId}.json`);
	if (!registered) return null;

	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	const secret = await stub.getTrackingSecret();
	if (!secret) return null; // never sent tracked mail; no token can be valid

	const payload = await verifyTrackingToken(token, secret);
	if (!payload || payload.mailboxId !== mailboxId) return null;
	return { payload, stub };
}

/** Best-effort engagement write, keyed to the verified token. */
function record(
	stub: ReturnType<Env["MAILBOX"]["get"]>,
	payload: TrackingTokenPayload,
	source: DeliveryEventSource,
	metadata?: Record<string, unknown>,
): Promise<unknown> {
	return stub.recordEngagement({
		emailId: payload.emailId,
		type: payload.kind,
		source,
		recipient: payload.recipient,
		metadata: metadata ?? null,
	});
}

/**
 * The open pixel. `GET /t/o/:token`.
 *
 * Always answers with the GIF, whatever the token's fate — a tracking image that
 * 404'd on a bad token would tell a prober which tokens are real, and would show
 * a broken image in a legitimate reader whose token we somehow could not verify.
 * A valid token records an `opened` event on the way out.
 */
export async function handleOpenPixel(
	token: string,
	env: Env,
	waitUntil: (p: Promise<unknown>) => void,
	context?: TrackingRequestContext,
): Promise<Response> {
	try {
		const verified = await verify(token, env);
		if (verified && verified.payload.kind === "opened") {
			// The self-open check and the write both run after the GIF is on its
			// way: the recipient's client never waits on our bookkeeping.
			const { payload, stub } = verified;
			waitUntil(
				(async () => {
					if (await isSelfOpen(payload, context)) return;
					await record(stub, payload, "pixel", engagementMetadata(context) ?? undefined);
				})(),
			);
		}
	} catch (e) {
		// A transient failure in R2, `idFromName` or the DO RPC must not become a
		// 500: this response is an <img> in someone's mail client, and a broken
		// image is a visible defect in a legitimate reader's message. It would also
		// break the uniform-response property the section above relies on, letting
		// a prober distinguish inputs by status code. Log and still send the GIF.
		console.error("Open-pixel verification failed:", (e as Error)?.message);
	}
	return pixelResponse();
}

/**
 * The click redirect. `GET /t/c/:token`.
 *
 * On a valid token, records a `clicked` event and 302s to the signed
 * destination. On any failure it refuses with 400 rather than redirecting: the
 * only safe destination is the one we signed, so a token we cannot verify has no
 * URL we are willing to send the reader to. This is the open-redirect guard.
 */
export async function handleClickRedirect(
	token: string,
	env: Env,
	waitUntil: (p: Promise<unknown>) => void,
	context?: TrackingRequestContext,
): Promise<Response> {
	let verified: Awaited<ReturnType<typeof verify>> = null;
	try {
		verified = await verify(token, env);
	} catch (e) {
		// Same reasoning as the pixel: a transient R2/DO failure must not surface as
		// a 500. Here the safe fallback is the refusal, not a redirect — the only
		// destination we are willing to send a reader to is one we verified.
		console.error("Click verification failed:", (e as Error)?.message);
	}

	if (
		!verified ||
		verified.payload.kind !== "clicked" ||
		!verified.payload.url
	) {
		return new Response("Invalid or expired tracking link", { status: 400 });
	}

	// Only http(s) destinations. A signed `javascript:` or `data:` URL should be
	// impossible (we only ever sign real links), but the redirect refuses one
	// regardless — defence in depth costs nothing here.
	let destination: URL;
	try {
		destination = new URL(verified.payload.url);
	} catch {
		return new Response("Invalid destination", { status: 400 });
	}
	if (destination.protocol !== "http:" && destination.protocol !== "https:") {
		return new Response("Invalid destination", { status: 400 });
	}

	// A click from the sender's own session (testing a link in their Sent copy,
	// say) still redirects, but is not counted.
	const { payload, stub } = verified;
	waitUntil(
		(async () => {
			if (await isSelfOpen(payload, context)) return;
			await record(
				stub,
				payload,
				"redirect",
				engagementMetadata(context, { url: payload.url }) ?? undefined,
			);
		})(),
	);

	return new Response(null, {
		status: 302,
		headers: {
			Location: verified.payload.url,
			"Cache-Control": "no-store, no-cache, must-revalidate, private",
			// A referrer carrying our tracking URL must not leak to the destination.
			"Referrer-Policy": "no-referrer",
		},
	});
}
