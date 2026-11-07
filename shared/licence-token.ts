// Vendored unchanged from tapetide-licence-server, src/shared/licence-token.ts
// (SHA-256 of the original: efe4140a27a45616006a0f7a8d3effaef3f34c56bff45611263e997006a1a174).
// Do not edit it here. Change it in the licence server, copy it again and
// update the hash; test/licence-gate.test.ts checks the body below this header.

/**
 * Tapetide licence token: types and offline verification.
 *
 * This file is meant to be vendored into the Tapetide Mail app unchanged.
 * It uses only Web Crypto and has no imports, so it runs in Workers,
 * browsers, Node 20+, Deno and Bun.
 *
 * Token format: JWS compact serialisation, `header.payload.signature`.
 *   header  = {"alg":"EdDSA","typ":"tapetide-lic+jwt","kid":"<kid>"}
 *   payload = LicenceClaims
 *   signature = Ed25519 over the ASCII bytes of `header.payload`
 */

export const LICENCE_TOKEN_TYP = "tapetide-lic+jwt";
export const RELEASE_MANIFEST_TYP = "tapetide-release+jwt";
export const TOKEN_ISSUER = "https://tapetide.com";
export const TOKEN_AUDIENCE = "tapetide-mail";
export const RELEASE_AUDIENCE = "tapetide-mail-releases";
export const CLAIMS_VERSION = 1;

/** How long after `exp` the licence server still accepts a token for refresh. */
export const REFRESH_GRACE_SECONDS = 7 * 24 * 60 * 60;
/** Allowed clock skew for `nbf` and `iat`. */
export const CLOCK_SKEW_SECONDS = 60;

export type SubStatus =
	| "active"
	| "past_due"
	| "cancelled_until_period_end"
	/** One-time purchase: no subscription. */
	| "none";

export interface LicenceClaims {
	iss: string;
	aud: string;
	v: number;
	/** Our licence ID (`lic_…`). */
	licence_id: string;
	customer: { id: string; email: string | null };
	plan: string;
	/** Activation limit, for display only. `null` means unlimited or unknown. Enforced server-side. */
	instances: number | null;
	deployment_id: string;
	bind: { host: string; cf_account: string | null };
	features: string[];
	sub_status: SubStatus;
	/** Unix seconds. Present only for plans that include updates for a fixed term. */
	updates_until?: number;
	iat: number;
	nbf: number;
	exp: number;
}

export interface ReleaseManifestClaims {
	iss: string;
	aud: string;
	version: string;
	min_supported: string;
	notes_url: string;
	iat: number;
}

export interface Ed25519PublicJwk {
	kty: "OKP";
	crv: "Ed25519";
	x: string;
	kid: string;
	alg?: "EdDSA";
	use?: "sig";
}

export interface Jwks {
	keys: Ed25519PublicJwk[];
}

export interface JwsHeader {
	alg: string;
	typ: string;
	kid: string;
}

/**
 * - `valid`: signature, claims and binding check out and `now < exp`.
 * - `grace`: everything checks out but the token expired less than 7 days ago.
 *   The app should treat the licence as locked, and call refresh, which the
 *   server still accepts.
 * - `expired`: the token expired more than 7 days ago. Only re-activation with
 *   the licence key helps.
 * - `invalid`: malformed, bad signature, unknown `kid`, wrong audience or binding mismatch.
 */
export type LicenceTokenState = "valid" | "grace" | "expired" | "invalid";

export type LicenceTokenReason =
	| "malformed"
	| "bad_header"
	| "unknown_kid"
	| "bad_signature"
	| "bad_claims"
	| "wrong_issuer"
	| "wrong_audience"
	| "not_yet_valid"
	| "expired"
	| "deployment_mismatch"
	| "host_mismatch";

export interface VerifyResult {
	/** True only when `state` is `valid`. */
	ok: boolean;
	/** Present when the signature verified, including for `grace`, `expired` and binding mismatches. */
	claims?: LicenceClaims;
	state: LicenceTokenState;
	reason?: LicenceTokenReason;
}

export interface VerifyOptions {
	/** Unix seconds. Defaults to the current time. */
	now?: number;
	deployment_id: string;
	host: string;
	/** Defaults to REFRESH_GRACE_SECONDS. */
	grace_seconds?: number;
}

// ---------------------------------------------------------------------------
// base64url

export function base64UrlEncode(bytes: Uint8Array | ArrayBuffer): string {
	const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let s = "";
	for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(s: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64url");
	const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
	const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function decodeJson(segment: string): unknown {
	return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));
}

export function normaliseHost(host: string): string {
	return host.trim().toLowerCase().replace(/\.$/, "");
}

// ---------------------------------------------------------------------------
// Generic JWS verification

const keyCache = new Map<string, Promise<CryptoKey>>();

function importPublicJwk(jwk: Ed25519PublicJwk): Promise<CryptoKey> {
	const cacheKey = `${jwk.kid}:${jwk.x}`;
	let p = keyCache.get(cacheKey);
	if (!p) {
		p = crypto.subtle.importKey(
			"jwk",
			{ kty: "OKP", crv: "Ed25519", x: jwk.x },
			{ name: "Ed25519" },
			false,
			["verify"],
		);
		// Don't cache a failed import.
		p.catch(() => keyCache.delete(cacheKey));
		keyCache.set(cacheKey, p);
	}
	return p;
}

export type JwsVerifyResult =
	| { ok: true; header: JwsHeader; payload: unknown }
	| { ok: false; reason: "malformed" | "bad_header" | "unknown_kid" | "bad_signature" };

/**
 * Verify a compact JWS signed with Ed25519 against a JWKS, and check `typ`.
 * Does not look at claims.
 */
export async function verifyJws(token: string, jwks: Jwks, expectedTyp: string): Promise<JwsVerifyResult> {
	if (typeof token !== "string" || token.length > 8192) return { ok: false, reason: "malformed" };
	const parts = token.split(".");
	if (parts.length !== 3) return { ok: false, reason: "malformed" };
	const [h, p, s] = parts as [string, string, string];

	let header: unknown;
	let payload: unknown;
	let sig: Uint8Array;
	try {
		header = decodeJson(h);
		payload = decodeJson(p);
		sig = base64UrlDecode(s);
	} catch {
		return { ok: false, reason: "malformed" };
	}
	if (!header || typeof header !== "object") return { ok: false, reason: "bad_header" };
	const hd = header as Record<string, unknown>;
	if (hd.alg !== "EdDSA" || hd.typ !== expectedTyp || typeof hd.kid !== "string" || "crit" in hd) {
		return { ok: false, reason: "bad_header" };
	}
	const jwk = jwks.keys.find((k) => k.kid === hd.kid && k.kty === "OKP" && k.crv === "Ed25519");
	if (!jwk) return { ok: false, reason: "unknown_kid" };
	if (sig.length !== 64) return { ok: false, reason: "bad_signature" };

	let valid = false;
	try {
		const key = await importPublicJwk(jwk);
		// A fresh ArrayBuffer-backed copy: DOM lib typings reject a view over ArrayBufferLike.
		valid = await crypto.subtle.verify({ name: "Ed25519" }, key, new Uint8Array(sig), new TextEncoder().encode(`${h}.${p}`));
	} catch {
		valid = false;
	}
	if (!valid) return { ok: false, reason: "bad_signature" };
	return { ok: true, header: { alg: "EdDSA", typ: expectedTyp, kid: hd.kid }, payload };
}

// ---------------------------------------------------------------------------
// Licence tokens

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isNum(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

function parseClaims(payload: unknown): LicenceClaims | null {
	if (!payload || typeof payload !== "object") return null;
	const c = payload as Record<string, unknown>;
	const customer = c.customer as Record<string, unknown> | undefined;
	const bind = c.bind as Record<string, unknown> | undefined;
	if (
		typeof c.iss !== "string" ||
		typeof c.aud !== "string" ||
		c.v !== CLAIMS_VERSION ||
		typeof c.licence_id !== "string" ||
		!customer ||
		typeof customer.id !== "string" ||
		!(typeof customer.email === "string" || customer.email === null) ||
		typeof c.plan !== "string" ||
		!(isNum(c.instances) || c.instances === null) ||
		typeof c.deployment_id !== "string" ||
		!bind ||
		typeof bind.host !== "string" ||
		!(typeof bind.cf_account === "string" || bind.cf_account === null) ||
		!isStringArray(c.features) ||
		typeof c.sub_status !== "string" ||
		!(c.updates_until === undefined || isNum(c.updates_until)) ||
		!isNum(c.iat) ||
		!isNum(c.nbf) ||
		!isNum(c.exp)
	) {
		return null;
	}
	return payload as LicenceClaims;
}

export interface SignatureCheck {
	state: LicenceTokenState;
	reason?: LicenceTokenReason;
	claims?: LicenceClaims;
}

/**
 * Verify signature, header and claims, and classify by time. Does NOT check the
 * deployment binding. The licence server uses this for refresh; apps should call
 * verifyLicenceToken instead.
 */
export async function verifyLicenceTokenSignature(
	token: string,
	jwks: Jwks,
	opts: { now?: number; grace_seconds?: number } = {},
): Promise<SignatureCheck> {
	const now = opts.now ?? Math.floor(Date.now() / 1000);
	const grace = opts.grace_seconds ?? REFRESH_GRACE_SECONDS;

	const jws = await verifyJws(token, jwks, LICENCE_TOKEN_TYP);
	if (!jws.ok) return { state: "invalid", reason: jws.reason };

	const claims = parseClaims(jws.payload);
	if (!claims) return { state: "invalid", reason: "bad_claims" };
	if (claims.iss !== TOKEN_ISSUER) return { state: "invalid", reason: "wrong_issuer", claims };
	if (claims.aud !== TOKEN_AUDIENCE) return { state: "invalid", reason: "wrong_audience", claims };
	if (claims.nbf > now + CLOCK_SKEW_SECONDS || claims.iat > now + CLOCK_SKEW_SECONDS) {
		return { state: "invalid", reason: "not_yet_valid", claims };
	}
	if (now >= claims.exp + grace) return { state: "expired", reason: "expired", claims };
	if (now >= claims.exp) return { state: "grace", reason: "expired", claims };
	return { state: "valid", claims };
}

/**
 * Verify a licence token offline in the app.
 *
 * Checks the Ed25519 signature against `jwks` (by `kid`), the header `typ`, the
 * issuer, audience, `nbf`/`exp`, and that the token is bound to this
 * deployment's `deployment_id` and host.
 */
export async function verifyLicenceToken(token: string, jwks: Jwks, opts: VerifyOptions): Promise<VerifyResult> {
	const check = await verifyLicenceTokenSignature(token, jwks, opts);
	if (check.state === "invalid" && !check.claims) return { ok: false, state: "invalid", reason: check.reason };
	if (check.state === "invalid") return { ok: false, state: "invalid", reason: check.reason, claims: check.claims };

	const claims = check.claims!;
	if (claims.deployment_id !== opts.deployment_id) {
		return { ok: false, state: "invalid", reason: "deployment_mismatch", claims };
	}
	if (normaliseHost(claims.bind.host) !== normaliseHost(opts.host)) {
		return { ok: false, state: "invalid", reason: "host_mismatch", claims };
	}
	return { ok: check.state === "valid", state: check.state, reason: check.reason, claims };
}

/** Verify the signed release manifest from GET /v1/releases/latest. */
export async function verifyReleaseManifest(
	jws: string,
	jwks: Jwks,
): Promise<{ ok: true; manifest: ReleaseManifestClaims } | { ok: false; reason: string }> {
	const r = await verifyJws(jws, jwks, RELEASE_MANIFEST_TYP);
	if (!r.ok) return { ok: false, reason: r.reason };
	const m = r.payload as Record<string, unknown>;
	if (
		!m ||
		m.iss !== TOKEN_ISSUER ||
		m.aud !== RELEASE_AUDIENCE ||
		typeof m.version !== "string" ||
		typeof m.min_supported !== "string" ||
		typeof m.notes_url !== "string" ||
		!isNum(m.iat)
	) {
		return { ok: false, reason: "bad_claims" };
	}
	return { ok: true, manifest: m as unknown as ReleaseManifestClaims };
}
