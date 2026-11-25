/**
 * Svix webhook signature verification for Resend, without the Svix SDK
 * (Resend research, Decision 7).
 *
 * - Signed content: `${svix-id}.${svix-timestamp}.${raw body}`.
 * - Key: the base64 after `whsec_`, decoded; HMAC-SHA256.
 * - `svix-signature` is a space-separated list of `v1,<base64>`; any match passes.
 * - The timestamp must be within {@link SVIX_TOLERANCE_S} of now.
 * - Comparison uses `crypto.subtle.verify`, which is constant time.
 *
 * @see https://docs.svix.com/receiving/verifying-payloads/how-manual
 */

export const SVIX_TOLERANCE_S = 5 * 60;

export type SvixVerdict = { ok: true } | { ok: false; reason: string };

function b64decode(value: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
	try {
		const bin = atob(value);
		const out = new Uint8Array(new ArrayBuffer(bin.length));
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	} catch {
		return null;
	}
}

export async function verifySvix(
	secret: string,
	headers: { id: string | null; timestamp: string | null; signature: string | null },
	body: string,
	nowMs: number,
): Promise<SvixVerdict> {
	const { id, timestamp, signature } = headers;
	if (!id || !timestamp || !signature) return { ok: false, reason: "missing svix headers" };
	if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) return { ok: false, reason: "malformed svix-id" };
	if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "malformed svix-timestamp" };
	if (Math.abs(nowMs / 1000 - Number(timestamp)) > SVIX_TOLERANCE_S) return { ok: false, reason: "timestamp outside tolerance" };
	const keyBytes = b64decode(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret);
	if (!keyBytes || keyBytes.length < 16) return { ok: false, reason: "bad secret" };
	const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
	const content = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
	// Space-separated `v1,<b64>` entries. A proxy may have joined repeated
	// headers with ", ", so pick out each `v1,` token rather than splitting.
	const candidates = [...signature.matchAll(/(?:^|[\s,])v1,([A-Za-z0-9+/]+={0,2})(?=$|[\s,])/g)].slice(0, 10);
	for (const match of candidates) {
		const sig = b64decode(match[1]!);
		if (!sig || sig.length !== 32) continue;
		if (await crypto.subtle.verify("HMAC", key, sig, content)) return { ok: true };
	}
	return { ok: false, reason: "no matching signature" };
}
