// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * `/api/auth/passkeys/*`: WebAuthn passkeys, for sign-in and as a second factor.
 *
 * Mounted inside `createAuthRoutes`, so it inherits that sub-app's access-mode
 * guard and `Cache-Control: no-store`. The wire contract is
 * `docs/auth-contract.md`.
 *
 * Ceremony challenges live in the AuthDO, hashed, single use, five minutes,
 * bound to a purpose and (except for usernameless sign-in) to a user. The
 * challenge is not echoed back as a separate token: the browser returns it
 * inside the signed `clientDataJSON`, which is where it is read from, so the
 * value the store burns is exactly the value the authenticator signed.
 *
 * The relying party is the deployment's own origin: `APP_URL` when set, else
 * the origin the request arrived on. A passkey is bound by the browser to that
 * hostname, so moving the deployment to another domain leaves every existing
 * passkey unusable there (users sign in with their password and register new
 * ones).
 *
 * Every passkey ceremony requires user verification (biometric or PIN), which
 * is why a passkey sign-in is a complete sign-in and skips the TOTP step: it
 * is already something you have plus something you are or know.
 */

import { Hono, type Context } from "hono";
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { decodeClientDataJSON, isoBase64URL, isoUint8Array } from "@simplewebauthn/server/helpers";
import { z } from "zod";
import type { MailboxContext } from "../lib/mailbox";
import type { Env } from "../types";
import { sha256Hex } from "./crypto";
import { requireSession, requireUser, type AuthDeps } from "./middleware";
import { authLimitAll } from "./ratelimit";
import { authAudit } from "./audit-events";
import {
	checkPassword,
	clientIp,
	issueSession,
	issuerName,
	lockedResponse,
	parseBody,
	publicUser,
	rateLimited,
	TOTP_UNAVAILABLE,
	verifySecondFactor,
} from "./routes";
import { WEBAUTHN_CHALLENGE_MS } from "./store-core";
import type { AuthStoreApi, AuthUser, PasskeyCredential } from "./types";

type C = Context<MailboxContext>;

/**
 * How long a sign-in counts as "just now" for adding a passkey. Registering
 * one is a new way into the account, so a session left open on a shared
 * machine should not be enough on its own; within this window of signing in
 * (or re-confirming) it is.
 */
export const PASSKEY_REAUTH_MS = 15 * 60 * 1000;

/**
 * The cryptographic half, injectable so route tests can exercise the HTTP
 * flow without a real authenticator. Production uses the library directly.
 */
export interface WebAuthnVerifier {
	verifyRegistrationResponse: typeof verifyRegistrationResponse;
	verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}

const defaultVerifier: WebAuthnVerifier = { verifyRegistrationResponse, verifyAuthenticationResponse };

/**
 * The relying party: rpID is the hostname, and the origin must match exactly.
 *
 * `APP_URL` wins so that a deployment reachable on several hostnames binds
 * passkeys to the canonical one. A malformed value falls back to the request,
 * as `appBaseUrl` does.
 */
export function relyingParty(env: Pick<Env, "APP_URL">, requestUrl: string): { rpID: string; origin: string } {
	const configured = env.APP_URL?.trim();
	if (configured) {
		try {
			const url = new URL(configured);
			if (url.protocol === "https:" || url.protocol === "http:") {
				return { rpID: url.hostname, origin: url.origin };
			}
		} catch {
			/* fall through */
		}
	}
	const url = new URL(requestUrl);
	return { rpID: url.hostname, origin: url.origin };
}

// -- input schemas ---------------------------------------------------------

const b64url = z.string().max(16_384).regex(/^[A-Za-z0-9_-]*={0,2}$/);

/**
 * The JSON a browser's `PublicKeyCredential.toJSON()` (or the browser
 * library) produces. Shapes are checked loosely here and strictly by the
 * verifier; this only bounds what is parsed and guarantees the fields read
 * before verification exist.
 */
const credentialBase = {
	id: b64url.min(1),
	rawId: b64url.min(1),
	type: z.literal("public-key"),
	clientExtensionResults: z.record(z.unknown()).default({}),
	authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
};

const registrationResponse = z
	.object({
		...credentialBase,
		response: z
			.object({
				clientDataJSON: b64url.min(1),
				attestationObject: b64url.min(1).max(65_536),
				transports: z.array(z.string().max(32)).max(10).optional(),
			})
			.passthrough(),
	})
	.passthrough();

const authenticationResponse = z
	.object({
		...credentialBase,
		response: z
			.object({
				clientDataJSON: b64url.min(1),
				authenticatorData: b64url.min(1),
				signature: b64url.min(1),
				userHandle: b64url.optional(),
			})
			.passthrough(),
	})
	.passthrough();

const passkeyName = z.string().trim().min(1).max(64);
const mfaChallenge = z.string().min(16).max(256);

const schemas = {
	registerVerify: z.object({ response: registrationResponse, name: passkeyName.optional() }),
	rename: z.object({ name: passkeyName }),
	reauth: z.union([
		z.object({ password: z.string().min(1).max(1024) }),
		z.object({ code: z.string().trim().min(1).max(16) }),
		z.object({ response: authenticationResponse }),
	]),
	loginVerify: z.object({ response: authenticationResponse }),
	mfaOptions: z.object({ challenge: mfaChallenge }),
	mfaVerify: z.object({ challenge: mfaChallenge, response: authenticationResponse }),
};

// -- helpers ---------------------------------------------------------------

const PASSKEY_INVALID = { error: "That passkey couldn't be verified.", code: "passkey_invalid" } as const;
const CHALLENGE_EXPIRED = {
	error: "This passkey request expired. Try again.",
	code: "challenge_expired",
} as const;

/** The challenge the authenticator signed, read from its `clientDataJSON`. Null when unreadable. */
function signedChallenge(clientDataJSON: string): string | null {
	try {
		const challenge = decodeClientDataJSON(clientDataJSON).challenge;
		return typeof challenge === "string" && challenge.length > 0 && challenge.length <= 512 ? challenge : null;
	} catch {
		return null;
	}
}

/** Issue a server-side challenge for `options.challenge`. False when the store refused (too many outstanding). */
async function storeChallenge(
	store: AuthStoreApi,
	challenge: string,
	purpose: "register" | "authenticate",
	userId: string | null,
	now: number,
): Promise<boolean> {
	return store.createWebAuthnChallenge({ challengeHash: await sha256Hex(challenge), purpose, userId, now });
}

function busy(c: C): Response {
	return c.json({ error: "Too many passkey requests in flight. Try again shortly.", code: "rate_limited", retryAfter: 60 }, 429);
}

/** `allowCredentials` entries for a user's own passkeys. */
function allowList(passkeys: PasskeyCredential[]) {
	return passkeys.map((p) => ({ id: p.credentialId, transports: p.transports }));
}

type AssertionResult =
	| { ok: true; user: AuthUser; passkey: PasskeyCredential }
	| { ok: false; reason: "expired" | "invalid" };

/**
 * Verify a sign-in assertion end to end: burn the challenge, find the
 * credential, check the signature, user verification and counter, and record
 * the use.
 *
 * `userId` null means a usernameless sign-in, whose challenge was issued to
 * nobody; otherwise the challenge and the credential must both belong to that
 * user. A disabled account fails exactly like an unknown credential.
 */
async function verifyAssertion(
	c: C,
	store: AuthStoreApi,
	verifier: WebAuthnVerifier,
	response: AuthenticationResponseJSON,
	userId: string | null,
	now: number,
): Promise<AssertionResult> {
	const challenge = signedChallenge(response.response.clientDataJSON);
	if (!challenge) return { ok: false, reason: "invalid" };
	if (!(await store.consumeWebAuthnChallenge(await sha256Hex(challenge), "authenticate", userId, now))) {
		return { ok: false, reason: "expired" };
	}

	const found = await store.getPasskeyByCredentialId(response.id);
	if (!found || found.user.disabled) return { ok: false, reason: "invalid" };
	if (userId !== null && found.user.id !== userId) return { ok: false, reason: "invalid" };

	// The credential says whose it is; for a discoverable credential it must
	// agree with the account we stored it under.
	const handle = response.response.userHandle;
	if (handle) {
		let owner: string | null = null;
		try {
			owner = isoBase64URL.toUTF8String(handle);
		} catch {
			/* unreadable handle: refused below */
		}
		if (owner !== found.user.id) return { ok: false, reason: "invalid" };
	}

	const { rpID, origin } = relyingParty(c.env, c.req.url);
	let verified;
	try {
		verified = await verifier.verifyAuthenticationResponse({
			response,
			expectedChallenge: challenge,
			expectedOrigin: origin,
			expectedRPID: rpID,
			requireUserVerification: true,
			credential: {
				id: found.passkey.credentialId,
				publicKey: isoBase64URL.toBuffer(found.passkey.publicKey),
				counter: found.passkey.counter,
				transports: found.passkey.transports,
			},
		});
	} catch (e) {
		const message = (e as Error).message ?? "";
		if (/counter/i.test(message)) warnCounter(found.user, found.passkey);
		else console.warn(`[auth] Passkey assertion rejected for ${found.user.email}: ${message}`);
		return { ok: false, reason: "invalid" };
	}
	if (!verified.verified || !verified.authenticationInfo.userVerified) return { ok: false, reason: "invalid" };

	// Compare-and-set in the store: a counter that did not advance (when the
	// authenticator counts at all) means two devices share one private key.
	const recorded = await store.recordPasskeyUse({
		credentialId: found.passkey.credentialId,
		newCounter: verified.authenticationInfo.newCounter,
		backedUp: verified.authenticationInfo.credentialBackedUp,
		now,
	});
	if (!recorded) {
		warnCounter(found.user, found.passkey);
		return { ok: false, reason: "invalid" };
	}
	return { ok: true, user: found.user, passkey: found.passkey };
}

function warnCounter(user: AuthUser, passkey: PasskeyCredential): void {
	console.warn(
		`[auth] Passkey "${passkey.name}" (${passkey.id}) of ${user.email} presented a signature counter that ` +
			`did not advance (stored ${passkey.counter}). The authenticator may have been cloned; the sign-in ` +
			`was refused. If this repeats, delete the passkey from Account & security.`,
	);
}

function assertionFailure(c: C, reason: "expired" | "invalid"): Response {
	return reason === "expired" ? c.json(CHALLENGE_EXPIRED, 401) : c.json(PASSKEY_INVALID, 401);
}

// -- the routes -----------------------------------------------------------

export function createPasskeyRoutes(deps: AuthDeps) {
	const now = deps.now ?? Date.now;
	const verifier = deps.webauthn ?? defaultVerifier;
	const routes = new Hono<MailboxContext>();
	const store = (c: C) => deps.getStore(c.env);

	/** Whether this session signed in, or re-confirmed, recently enough to add a passkey. */
	async function isFresh(c: C, s: AuthStoreApi, t: number): Promise<boolean> {
		const hash = c.var.authSessionHash;
		if (!hash) return false;
		const at = await s.getSessionAuthenticatedAt(hash);
		return at !== null && t - at < PASSKEY_REAUTH_MS;
	}

	// -- managing your own passkeys ----------------------------------------

	routes.get("/", requireUser, async (c) => {
		return c.json({ passkeys: await store(c).listPasskeys(c.var.authUser!.id) });
	});

	/**
	 * Session-only, and only within 15 minutes of signing in or re-confirming
	 * (`POST /reauth`): adding a passkey is adding a way in.
	 */
	routes.post("/register/options", requireSession, async (c) => {
		const user = c.var.authUser!;
		if (!(await authLimitAll(c.env, [`passkey-register:user:${user.id}`]))) return rateLimited(c);
		const s = store(c);
		const t = now();
		if (!(await isFresh(c, s, t))) {
			return c.json(
				{ error: "Confirm it's you before adding a passkey.", code: "reauth_required" },
				403,
			);
		}
		const { rpID } = relyingParty(c.env, c.req.url);
		const existing = await s.listPasskeyCredentials(user.id);
		const options = await generateRegistrationOptions({
			rpName: await issuerName(c.env),
			rpID,
			userName: user.email,
			userDisplayName: user.name,
			// The user handle is the account id, never the email: it is stored on
			// the authenticator and returned on every sign-in, and the email can change.
			userID: isoUint8Array.fromUTF8String(user.id),
			timeout: WEBAUTHN_CHALLENGE_MS,
			attestationType: "none",
			excludeCredentials: allowList(existing),
			authenticatorSelection: { residentKey: "required", userVerification: "required" },
		});
		if (!(await storeChallenge(s, options.challenge, "register", user.id, t))) return busy(c);
		return c.json({ options });
	});

	routes.post("/register/verify", requireSession, async (c) => {
		const user = c.var.authUser!;
		if (!(await authLimitAll(c.env, [`passkey-register:user:${user.id}`]))) return rateLimited(c);
		const body = await parseBody(c, schemas.registerVerify);
		if (!body.ok) return body.res;
		const response = body.data.response as unknown as RegistrationResponseJSON;
		const s = store(c);
		const t = now();

		const challenge = signedChallenge(response.response.clientDataJSON);
		if (!challenge) return c.json(PASSKEY_INVALID, 400);
		// Bound to this user: a challenge issued to anyone else is refused.
		if (!(await s.consumeWebAuthnChallenge(await sha256Hex(challenge), "register", user.id, t))) {
			return c.json(CHALLENGE_EXPIRED, 400);
		}

		const { rpID, origin } = relyingParty(c.env, c.req.url);
		let verified;
		try {
			verified = await verifier.verifyRegistrationResponse({
				response,
				expectedChallenge: challenge,
				expectedOrigin: origin,
				expectedRPID: rpID,
				requireUserVerification: true,
			});
		} catch (e) {
			console.warn(`[auth] Passkey registration rejected for ${user.email}: ${(e as Error).message}`);
			return c.json(PASSKEY_INVALID, 400);
		}
		if (!verified.verified || !verified.registrationInfo.userVerified) return c.json(PASSKEY_INVALID, 400);

		const info = verified.registrationInfo;
		const existing = await s.listPasskeys(user.id);
		try {
			const passkey = await s.addPasskey({
				userId: user.id,
				credentialId: info.credential.id,
				publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
				counter: info.credential.counter,
				transports: info.credential.transports ?? response.response.transports ?? [],
				aaguid: info.aaguid,
				deviceType: info.credentialDeviceType,
				backedUp: info.credentialBackedUp,
				name: body.data.name ?? `Passkey ${existing.length + 1}`,
				now: t,
			});
			await authAudit(c, "auth.passkey_add", { target: passkey.id, detail: { name: passkey.name } });
			return c.json({ passkey }, 201);
		} catch (e) {
			const message = (e as Error).message ?? "";
			if (message.includes("passkey_exists")) {
				return c.json({ error: "This passkey is already registered.", code: "passkey_exists" }, 409);
			}
			if (message.includes("passkey_limit")) {
				return c.json({ error: "You have the maximum number of passkeys. Remove one first.", code: "passkey_limit" }, 409);
			}
			throw e;
		}
	});

	routes.patch("/:id", requireSession, async (c) => {
		const body = await parseBody(c, schemas.rename);
		if (!body.ok) return body.res;
		const passkey = await store(c).renamePasskey(c.var.authUser!.id, c.req.param("id"), body.data.name);
		if (!passkey) return c.json({ error: "Passkey not found", code: "not_found" }, 404);
		return c.json({ passkey });
	});

	routes.delete("/:id", requireSession, async (c) => {
		const ok = await store(c).deletePasskey(c.var.authUser!.id, c.req.param("id"));
		if (!ok) return c.json({ error: "Passkey not found", code: "not_found" }, 404);
		await authAudit(c, "auth.passkey_remove", { target: c.req.param("id") });
		return c.body(null, 204);
	});

	// -- re-confirming who you are ------------------------------------------

	/** Options for re-confirming with one of your existing passkeys. */
	routes.post("/reauth/options", requireSession, async (c) => {
		const user = c.var.authUser!;
		if (!(await authLimitAll(c.env, [`passkey-reauth:user:${user.id}`]))) return rateLimited(c);
		const s = store(c);
		const passkeys = await s.listPasskeyCredentials(user.id);
		if (passkeys.length === 0) {
			return c.json({ error: "You have no passkeys yet.", code: "no_passkeys" }, 400);
		}
		const options = await generateAuthenticationOptions({
			rpID: relyingParty(c.env, c.req.url).rpID,
			allowCredentials: allowList(passkeys),
			userVerification: "required",
			timeout: WEBAUTHN_CHALLENGE_MS,
		});
		if (!(await storeChallenge(s, options.challenge, "authenticate", user.id, now()))) return busy(c);
		return c.json({ options });
	});

	/**
	 * Re-confirm the session's user with a password, an authenticator code, or
	 * a passkey. Wrong guesses count against the same locks sign-in uses, so a
	 * stolen session cannot be used to guess the password or the code at
	 * leisure.
	 */
	routes.post("/reauth", requireSession, async (c) => {
		const user = c.var.authUser!;
		const ip = clientIp(c);
		if (!(await authLimitAll(c.env, [`passkey-reauth:user:${user.id}`]))) return rateLimited(c);
		const body = await parseBody(c, schemas.reauth);
		if (!body.ok) return body.res;
		const s = store(c);
		const t = now();
		const data = body.data;

		if ("password" in data) {
			const lock = await s.getLoginLock(user.email, ip, t);
			if (lock.lockedUntil > t) return lockedResponse(c, lock.lockedUntil, t);
			if (!(await checkPassword(s, user, data.password))) {
				const failure = await s.recordLoginFailure(user.email, ip, t);
				if (failure.lockedUntil > t) return lockedResponse(c, failure.lockedUntil, t);
				return c.json({ error: "Password is incorrect", code: "wrong_password" }, 400);
			}
		} else if ("code" in data) {
			// Authenticator codes only: spending a single-use recovery code to
			// confirm an action that is not a sign-in would waste it.
			if (!user.totpEnabled || !/^\d{6}$/.test(data.code.replace(/\s/g, ""))) {
				return c.json({ error: "Invalid code", code: "invalid_code" }, 400);
			}
			const lock = await s.getMfaLock(user.id, t);
			if (lock.lockedUntil > t) return lockedResponse(c, lock.lockedUntil, t);
			const result = await verifySecondFactor(c.env, s, user, data.code, t);
			if (result === "totp_unavailable") return c.json(TOTP_UNAVAILABLE, 400);
			if (result !== "ok") {
				const failure = await s.recordMfaFailure(user.id, t);
				if (failure.lockedUntil > t) return lockedResponse(c, failure.lockedUntil, t);
				return c.json({ error: "Invalid code", code: "invalid_code" }, 400);
			}
		} else {
			const result = await verifyAssertion(
				c,
				s,
				verifier,
				data.response as unknown as AuthenticationResponseJSON,
				user.id,
				t,
			);
			if (!result.ok) {
				return result.reason === "expired" ? c.json(CHALLENGE_EXPIRED, 400) : c.json(PASSKEY_INVALID, 400);
			}
		}

		await s.markSessionAuthenticated(c.var.authSessionHash!, t);
		return c.json({ status: "ok", validUntil: t + PASSKEY_REAUTH_MS });
	});

	// -- signing in -----------------------------------------------------------

	/**
	 * Usernameless: no account is named, and `allowCredentials` stays empty so
	 * the browser offers whichever passkeys it holds for this site. Also used
	 * for conditional UI (passkeys offered in the email field's autofill).
	 */
	routes.post("/login/options", async (c) => {
		if (!(await authLimitAll(c.env, [`passkey-login:ip:${clientIp(c)}`]))) return rateLimited(c);
		const s = store(c);
		const options = await generateAuthenticationOptions({
			rpID: relyingParty(c.env, c.req.url).rpID,
			userVerification: "required",
			timeout: WEBAUTHN_CHALLENGE_MS,
		});
		if (!(await storeChallenge(s, options.challenge, "authenticate", null, now()))) return busy(c);
		return c.json({ options });
	});

	/**
	 * A complete sign-in: the assertion is user-verified, so it already counts
	 * as two factors and no TOTP step follows.
	 */
	routes.post("/login/verify", async (c) => {
		const ip = clientIp(c);
		const body = await parseBody(c, schemas.loginVerify);
		if (!body.ok) return body.res;
		const response = body.data.response as unknown as AuthenticationResponseJSON;
		if (!(await authLimitAll(c.env, [`passkey-login:ip:${ip}`, `passkey-login:cred:${response.id.slice(0, 128)}`]))) {
			return rateLimited(c);
		}
		const s = store(c);
		const t = now();
		const result = await verifyAssertion(c, s, verifier, response, null, t);
		if (!result.ok) {
			await authAudit(c, "auth.login_failed", { user: null, detail: { method: "passkey", reason: result.reason } });
			return assertionFailure(c, result.reason);
		}

		await s.recordLoginSuccess(result.user.id, ip, t);
		await issueSession(c, s, result.user, t);
		await authAudit(c, "auth.login", { user: result.user, detail: { method: "passkey" } });
		return c.json({ status: "ok", user: await publicUser(c.env, result.user) });
	});

	/**
	 * The second-factor step with a passkey instead of a code, after a correct
	 * password. Uses the same MFA challenge and the same account-wide lock as
	 * codes, so the two cannot be alternated to get more guesses.
	 */
	routes.post("/mfa/options", async (c) => {
		const ip = clientIp(c);
		if (!(await authLimitAll(c.env, [`mfa:ip:${ip}`]))) return rateLimited(c);
		const body = await parseBody(c, schemas.mfaOptions);
		if (!body.ok) return body.res;
		const s = store(c);
		const t = now();
		const mfa = await s.useMfaChallenge(await sha256Hex(body.data.challenge), t);
		if (!mfa) return c.json(CHALLENGE_EXPIRED, 401);
		const user = await s.getUser(mfa.userId);
		if (!user || user.disabled) return c.json(CHALLENGE_EXPIRED, 401);
		const passkeys = await s.listPasskeyCredentials(user.id);
		if (passkeys.length === 0) return c.json({ error: "You have no passkeys yet.", code: "no_passkeys" }, 400);
		const options = await generateAuthenticationOptions({
			rpID: relyingParty(c.env, c.req.url).rpID,
			allowCredentials: allowList(passkeys),
			userVerification: "required",
			timeout: WEBAUTHN_CHALLENGE_MS,
		});
		if (!(await storeChallenge(s, options.challenge, "authenticate", user.id, t))) return busy(c);
		return c.json({ options });
	});

	routes.post("/mfa/verify", async (c) => {
		const ip = clientIp(c);
		if (!(await authLimitAll(c.env, [`mfa:ip:${ip}`]))) return rateLimited(c);
		const body = await parseBody(c, schemas.mfaVerify);
		if (!body.ok) return body.res;
		const s = store(c);
		const t = now();
		const challengeHash = await sha256Hex(body.data.challenge);
		const mfa = await s.useMfaChallenge(challengeHash, t);
		if (!mfa) return c.json(CHALLENGE_EXPIRED, 401);
		const user = await s.getUser(mfa.userId);
		if (!user || user.disabled) return c.json(CHALLENGE_EXPIRED, 401);
		if (!(await authLimitAll(c.env, [`mfa:user:${user.id}`]))) return rateLimited(c);

		const lock = await s.getMfaLock(user.id, t);
		if (lock.lockedUntil > t) return lockedResponse(c, lock.lockedUntil, t);

		const result = await verifyAssertion(
			c,
			s,
			verifier,
			body.data.response as unknown as AuthenticationResponseJSON,
			user.id,
			t,
		);
		if (!result.ok) {
			if (result.reason === "invalid") {
				const failure = await s.recordMfaFailure(user.id, t);
				if (failure.lockedUntil > t) return lockedResponse(c, failure.lockedUntil, t);
			}
			return assertionFailure(c, result.reason);
		}

		await s.deleteMfaChallenge(challengeHash);
		await s.recordLoginSuccess(user.id, ip, t);
		await issueSession(c, s, user, t);
		await authAudit(c, "auth.login", { user, detail: { method: "password+passkey" } });
		return c.json({ status: "ok", user: await publicUser(c.env, user) });
	});

	return routes;
}
