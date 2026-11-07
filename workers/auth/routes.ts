// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * `/api/auth/*`: sign-in, account self-service and user administration for
 * built-in password auth. The wire contract is `docs/auth-contract.md`.
 *
 * Mounted by `workers/app.ts` at `/api/auth`, after `authenticate` (so a
 * signed-in caller is recognised) and before the gate (so the sign-in endpoints
 * are reachable without a session). Everything sensitive is hashed here, in the
 * stateless Worker: passwords with scrypt, tokens with SHA-256. The AuthDO only
 * ever sees hashes, and one slow scrypt cannot serialize every login behind the
 * single-threaded object.
 *
 * Responses are deliberately uninformative where information would help an
 * attacker: an unknown email and a wrong password produce the same body after
 * the same amount of work, and nothing returns a setup token.
 */

import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { deleteGrant, isAdmin, putGrant } from "../lib/authz";
import { getBranding } from "../lib/branding";
import { getPrivacySettings, putPrivacySettings } from "../lib/privacy";
import { mergePrivacySettings } from "../../shared/privacy";
import { resolvePrincipal, type MailboxContext } from "../lib/mailbox";
import type { Env } from "../types";
import {
	appBaseUrl,
	authSecret,
	resolveAuthEmailSender,
	logGeneratedSetupToken,
	resolveAuthMode,
	RECOVERY_TOKEN_MIN_LENGTH,
	recoveryTokenUsable,
	resolveSetupToken,
	setupTokenConfigured,
} from "./config";
import { buildSessionCookie, clearSessionCookie } from "./cookies";
import {
	decryptSecret,
	dummyVerifyPassword,
	encryptSecret,
	hashPassword,
	needsRehash,
	normalizeEmail,
	randomAlphanumeric,
	randomToken,
	sha256Hex,
	timingSafeEqualString,
	validatePassword,
	verifyPassword,
} from "./crypto";
import {
	principalForUser,
	requireSession,
	requireUser,
	type AuthDeps,
} from "./middleware";
import { AUTH_RATE_LIMIT_PERIOD_SECONDS, authLimitAll } from "./ratelimit";
import {
	generateRecoveryCodes,
	generateTotpSecret,
	normalizeRecoveryCode,
	totpUri,
	verifyTotp,
} from "./totp";
import { turnstileEnabled, turnstileSiteKey, verifyTurnstile } from "./turnstile";
import { ACCOUNT_ALERT_THRESHOLD } from "./store-core";
import { buildResetEmail, sendResetEmail } from "./reset-email";
import { createPasskeyRoutes } from "./passkeys";
import { authAudit } from "./audit-events";
import { recordDeploymentOrigin } from "../lib/deployment-origin";
import type { ApiTokenInfo, AuthStoreApi, AuthUser } from "./types";
import {
	TOKEN_SCOPES,
	effectiveTokenScopes,
	isMailboxSubset,
	isScopeSubset,
	normalizeTokenMailboxes,
	normalizeTokenScopes,
} from "../../shared/token-scopes";

type C = Context<MailboxContext>;

/** The calling API token when it is restricted (scopes or mailboxes), else null. */
function scopedCaller(c: C): ApiTokenInfo | null {
	const token = c.var.authMethod === "token" ? c.var.authToken : undefined;
	return token && effectiveTokenScopes(token) !== null ? token : null;
}

/** Whether `targetId` was minted, directly or transitively, by `ancestorId`. */
export function isDescendantToken(tokens: ApiTokenInfo[], targetId: string, ancestorId: string): boolean {
	const byId = new Map(tokens.map((t) => [t.id, t]));
	let current = byId.get(targetId);
	const seen = new Set<string>();
	while (current?.parentId && !seen.has(current.id)) {
		if (current.parentId === ancestorId) return true;
		seen.add(current.id);
		current = byId.get(current.parentId);
	}
	return false;
}

const INVALID_CREDENTIALS = { error: "Invalid email or password", code: "invalid_credentials" } as const;
const RESET_LINK_MS = 60 * 60 * 1000;
/**
 * Shorter than an admin-issued link: an emailed one sits in an inbox that may
 * be read by more than its owner (forwarding rules, shared devices), and the
 * person who asked is waiting for it right now.
 */
const EMAIL_RESET_LINK_MINUTES = 30;
/** The one body `/password/forgot` ever returns on success, whatever happened. */
const FORGOT_ACCEPTED = {
	status: "accepted",
	message: "If an account exists for that address, we've sent a link to reset its password.",
} as const;
const DAY_MS = 24 * 60 * 60 * 1000;

// -- input schemas ---------------------------------------------------------

const email = z.string().trim().max(254).email();
// Length is checked by `validatePassword`, which owns the message; the cap here
// only bounds what we are willing to parse.
const password = z.string().max(1024);
const displayName = z.string().trim().min(1).max(100);
const turnstileToken = z.string().max(2048).optional();
const opaqueToken = z.string().min(16).max(256);

const schemas = {
	setup: z.object({
		setupToken: z.string().min(1).max(512),
		email,
		name: displayName,
		password,
		turnstileToken,
		/** Whether new mailboxes start with open/click tracking on. Default on. */
		trackingDefault: z.boolean().optional(),
	}),
	login: z.object({ email, password, turnstileToken }),
	mfa: z.object({ challenge: opaqueToken, code: z.string().trim().min(1).max(64) }),
	acceptInvite: z.object({ token: opaqueToken, name: displayName, password, turnstileToken }),
	reset: z.object({ token: opaqueToken, password }),
	forgot: z.object({ email, turnstileToken }),
	recover: z.object({ setupToken: z.string().min(1).max(512), password }),
	profile: z.object({ name: displayName }),
	changePassword: z.object({ currentPassword: password, newPassword: password }),
	passwordOnly: z.object({ password }),
	code: z.object({ code: z.string().trim().min(1).max(64) }),
	disable2fa: z.object({ password, code: z.string().trim().min(1).max(64) }),
	createToken: z.object({
		name: displayName,
		expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
		/** Omitted or null: unrestricted (acts with the user's full access). */
		scopes: z.array(z.enum(TOKEN_SCOPES)).max(TOKEN_SCOPES.length).nullable().optional(),
		/** Omitted or null: every mailbox the user can reach. */
		mailboxes: z.array(email).max(500).nullable().optional(),
	}),
	createInvite: z.object({
		email,
		role: z.enum(["admin", "member"]),
		mailboxes: z.array(email).max(500).optional(),
		expiresInDays: z.number().int().min(1).max(30).optional(),
	}),
	setDisabled: z.object({ disabled: z.boolean() }),
};

// -- helpers ---------------------------------------------------------------

/** Parse a JSON body against a schema; null (and a 400 sent) when it does not fit. */
export async function parseBody<T extends z.ZodTypeAny>(
	c: C,
	schema: T,
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; res: Response }> {
	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		return { ok: false, res: c.json({ error: "Expected a JSON body", code: "invalid_input" }, 400) };
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
		return {
			ok: false,
			res: c.json({ error: `${where}${issue?.message ?? "Invalid input"}`, code: "invalid_input" }, 400),
		};
	}
	return { ok: true, data: parsed.data };
}

export function clientIp(c: C): string {
	return c.req.header("cf-connecting-ip") ?? "unknown";
}

export function rateLimited(c: C): Response {
	return c.json(
		{ error: "Too many attempts. Try again shortly.", code: "rate_limited", retryAfter: AUTH_RATE_LIMIT_PERIOD_SECONDS },
		429,
		{ "Retry-After": String(AUTH_RATE_LIMIT_PERIOD_SECONDS) },
	);
}

function weakPassword(c: C, message: string): Response {
	return c.json({ error: message, code: "weak_password" }, 400);
}

/**
 * Turnstile, when configured. A missing token and a failed one are told apart
 * so the form can tell "you skipped the check" from "the check said no".
 */
async function checkTurnstile(c: C, token: string | undefined): Promise<Response | null> {
	if (!turnstileEnabled(c.env)) return null;
	if (!token) {
		return c.json({ error: "Complete the human check first.", code: "turnstile_required" }, 400);
	}
	const ok = await verifyTurnstile(c.env, token, c.req.header("cf-connecting-ip") ?? null);
	return ok ? null : c.json({ error: "The human check failed. Try again.", code: "turnstile_failed" }, 403);
}

/** Constant-time comparison of two secrets of arbitrary length, via their hashes. */
async function secretsEqual(a: string, b: string): Promise<boolean> {
	return timingSafeEqualString(await sha256Hex(a), await sha256Hex(b));
}

/** The user as the browser may see it. */
export async function publicUser(env: Env, user: AuthUser) {
	const principal = await principalForUser(env, user);
	return {
		id: user.id,
		email: user.email,
		name: user.name,
		isOwner: user.isOwner,
		totpEnabled: user.totpEnabled,
		isAdmin: isAdmin(principal),
	};
}

/**
 * Start a fresh session and attach its cookie.
 *
 * Always a new token, never a reused one, so a token planted before sign-in
 * (session fixation) is worthless. Any session the browser already held is
 * ended, so switching accounts does not leave the old one live.
 */
export async function issueSession(c: C, store: AuthStoreApi, user: AuthUser, now: number): Promise<void> {
	if (c.var.authSessionHash) await store.deleteSession(c.var.authSessionHash);
	const token = randomToken(32);
	await store.createSession({
		userId: user.id,
		tokenHash: await sha256Hex(token),
		ip: c.req.header("cf-connecting-ip") ?? null,
		userAgent: c.req.header("user-agent")?.slice(0, 512) ?? null,
		now,
	});
	c.header("Set-Cookie", buildSessionCookie(token, c.req.url), { append: true });
}

/**
 * Outcome of a second-factor check. `totp_unavailable` is its own answer
 * because it is not a wrong guess: the stored secret cannot be decrypted, so no
 * authenticator code can ever pass, and the user needs to hear "use a recovery
 * code" rather than "try again".
 */
type SecondFactorResult = "ok" | "invalid" | "totp_unavailable";

/** TOTP code or single-use recovery code. */
export async function verifySecondFactor(
	env: Env,
	store: AuthStoreApi,
	user: AuthUser,
	code: string,
	now: number,
): Promise<SecondFactorResult> {
	const trimmed = code.replace(/\s/g, "");
	if (/^\d{6}$/.test(trimmed)) {
		const totp = await store.getTotp(user.id);
		if (!totp.enabled || !totp.secretEnc) return "invalid";
		let secret: string;
		try {
			secret = await decryptSecret(totp.secretEnc, await authSecret(env, store));
		} catch (e) {
			// Almost always AUTH_SECRET set or changed after this user enrolled. An
			// operator reading the logs needs the cause, not a stack trace.
			console.error(
				`[auth] Cannot decrypt the 2FA secret of ${user.email} (${user.id}): ${(e as Error).message}. ` +
					`AUTH_SECRET was most likely set or changed after they enabled 2FA. They must sign in ` +
					`with a recovery code and re-enrol 2FA (or the owner can use /recover).`,
			);
			return "totp_unavailable";
		}
		const step = await verifyTotp(secret, trimmed, now);
		// Replay: a code already used (or an older one) is refused.
		return step !== null && (await store.recordTotpStep(user.id, step)) ? "ok" : "invalid";
	}
	const normalized = normalizeRecoveryCode(code);
	if (normalized.length < 8) return "invalid";
	return (await store.consumeRecoveryCode(user.id, await sha256Hex(normalized))) ? "ok" : "invalid";
}

export const TOTP_UNAVAILABLE = {
	error:
		"Authenticator codes can't be checked for this account right now. Sign in with one of your recovery codes, then set up two-factor authentication again.",
	code: "totp_unavailable",
} as const;

/** Fresh recovery codes: plaintext for the user (once), hashes for the store. */
async function mintRecoveryCodes(): Promise<{ codes: string[]; hashes: string[] }> {
	const codes = generateRecoveryCodes();
	const hashes = await Promise.all(codes.map((code) => sha256Hex(normalizeRecoveryCode(code))));
	return { codes, hashes };
}

// -- the routes -----------------------------------------------------------

/**
 * Build the `/api/auth` sub-app. Mount with `app.route("/api/auth", ...)`.
 *
 * Paths are relative so that the sub-app's own middleware stays scoped to
 * `/api/auth/*` once mounted — a `use("*")` here would otherwise apply to every
 * route registered on the parent after it.
 */
export function createAuthRoutes(deps: AuthDeps) {
	const now = deps.now ?? Date.now;
	const routes = new Hono<MailboxContext>();
	const store = (c: C) => deps.getStore(c.env);

	/**
	 * Built-in accounts exist only in password mode. In access mode the state
	 * endpoint still answers (the sign-in screens use it to step aside), and
	 * everything else is absent rather than half-working beside Access.
	 */
	routes.use("*", async (c, next) => {
		if (resolveAuthMode(c.env) === "access" && new URL(c.req.url).pathname !== "/api/auth/state") {
			return c.json({ error: "Built-in accounts are not enabled on this deployment", code: "not_enabled" }, 404);
		}
		return next();
	});

	/**
	 * A scoped API token reaches only its own token tree here (plus `/state`,
	 * and `/admin/*`, whose admin check already requires the `admin` scope).
	 * Profile, sessions, connected apps and passkeys are the account itself,
	 * which no scope describes. Legacy unscoped tokens are unaffected.
	 */
	routes.use("*", async (c, next) => {
		if (!scopedCaller(c)) return next();
		const path = new URL(c.req.url).pathname.replace(/^\/api\/auth/, "");
		if (path === "/state" || path === "/tokens" || path.startsWith("/tokens/") || path.startsWith("/admin/")) {
			return next();
		}
		return c.json(
			{ error: "API tokens with scopes cannot manage the account.", code: "insufficient_scope", scope: "admin" },
			403,
		);
	});

	// Responses here carry credentials or describe them; never cache.
	routes.use("*", async (c, next) => {
		await next();
		c.header("Cache-Control", "no-store");
	});

	// -- public ----------------------------------------------------------------

	routes.get("/state", async (c) => {
		const mode = resolveAuthMode(c.env);
		const configured = setupTokenConfigured(c.env);
		if (mode === "access") {
			return c.json({
				mode,
				setupRequired: false,
				authenticated: Boolean(c.var.accessIdentity) || c.var.developmentBypass === true,
				user: null,
				turnstileSiteKey: null,
				setupTokenConfigured: configured,
				passwordResetByEmail: false,
			});
		}

		const s = store(c);
		const setupRequired = await s.isSetupRequired();
		if (setupRequired && !configured) {
			// Delivered through the logs, never the response; see config.ts.
			logGeneratedSetupToken(await resolveSetupToken(c.env, s));
		}
		const user = c.var.authUser;
		return c.json({
			mode,
			setupRequired,
			authenticated: Boolean(user) || c.var.developmentBypass === true,
			user: user ? await publicUser(c.env, user) : null,
			turnstileSiteKey: turnstileSiteKey(c.env),
			setupTokenConfigured: configured,
			passwordResetByEmail: resolveAuthEmailSender(c.env) !== null,
		});
	});

	routes.post("/setup", async (c) => {
		if (!(await authLimitAll(c.env, [`setup:ip:${clientIp(c)}`]))) return rateLimited(c);
		const body = await parseBody(c, schemas.setup);
		if (!body.ok) return body.res;
		const s = store(c);

		if (!(await s.isSetupRequired())) {
			return c.json({ error: "This deployment is already set up", code: "already_setup" }, 409);
		}
		const blocked = await checkTurnstile(c, body.data.turnstileToken);
		if (blocked) return blocked;

		const expected = await resolveSetupToken(c.env, s);
		if (!(await secretsEqual(body.data.setupToken.trim(), expected))) {
			return c.json({ error: "Invalid setup token", code: "bad_setup_token" }, 403);
		}
		const weak = validatePassword(body.data.password);
		if (weak) return weakPassword(c, weak);

		const t = now();
		const result = await s.createOwner({
			email: normalizeEmail(body.data.email),
			name: body.data.name,
			passwordHash: await hashPassword(body.data.password),
			now: t,
		});
		// Lost a race with a concurrent setup: the store's transaction decided.
		if (!result.ok) {
			return c.json({ error: "This deployment is already set up", code: "already_setup" }, 409);
		}
		await issueSession(c, s, result.user, t);
		console.log(`[auth] owner account created: ${result.user.email}`);
		// The setup token proved this request is the operator's, so its origin
		// is the deployment's. Awaited: it is cheap, and cron needs it next.
		await recordDeploymentOrigin(c.env, c.req.url, "setup");
		if (body.data.trackingDefault !== undefined) {
			// The setup-time choice. Best effort: failing to store it leaves the
			// default (on), which Settings can change later.
			try {
				const current = await getPrivacySettings(c.env.BUCKET);
				await putPrivacySettings(
					c.env.BUCKET,
					mergePrivacySettings(current, { trackingDefault: body.data.trackingDefault }, t),
				);
			} catch (e) {
				console.error("[auth] could not store the tracking default:", (e as Error).message);
			}
		}
		return c.json({ status: "ok", user: await publicUser(c.env, result.user) }, 201);
	});

	routes.post("/login", async (c) => {
		const body = await parseBody(c, schemas.login);
		if (!body.ok) return body.res;
		const address = normalizeEmail(body.data.email);
		const ip = clientIp(c);
		/**
		 * Per IP, and per (email, IP). Not per email alone: that key would let
		 * anyone who knows an address keep its owner out of sign-in from any
		 * network just by failing on purpose.
		 */
		if (!(await authLimitAll(c.env, [`login:ip:${ip}`, `login:email-ip:${address}:${ip}`]))) {
			return rateLimited(c);
		}
		const blocked = await checkTurnstile(c, body.data.turnstileToken);
		if (blocked) return blocked;

		const s = store(c);
		const t = now();
		const [lock, candidate] = await Promise.all([s.getLoginLock(address, ip, t), s.getLoginCandidate(address)]);

		/**
		 * Every path below pays exactly one scrypt, and the lock and the failure
		 * count are keyed by the address string rather than an account. Together
		 * that makes an unknown email indistinguishable from a real one by body,
		 * status or timing, locked or not.
		 */
		if (lock.lockedUntil > t) {
			await dummyVerifyPassword(body.data.password);
			return lockedResponse(c, lock.lockedUntil, t);
		}
		let ok = false;
		if (candidate) ok = await verifyPassword(body.data.password, candidate.passwordHash);
		else await dummyVerifyPassword(body.data.password);

		// A disabled account is indistinguishable from a wrong password: telling
		// a caller the password was right is information they should not get. So
		// it counts as a failure too, or the absence of a lock would tell them.
		if (!candidate || !ok || candidate.user.disabled) {
			const failure = await s.recordLoginFailure(address, ip, t);
			await authAudit(c, "auth.login_failed", {
				user: null,
				target: address,
				detail: { reason: !candidate ? "unknown_account" : candidate.user.disabled ? "disabled" : "wrong_password" },
			});
			if (failure.accountAlert) {
				console.warn(
					`[auth] More than ${ACCOUNT_ALERT_THRESHOLD} failed sign-ins for ${address} within an hour, ` +
						`across all addresses. Possible distributed password guessing; the account is not locked.`,
				);
			}
			if (failure.lockedUntil > t) return lockedResponse(c, failure.lockedUntil, t);
			return c.json(INVALID_CREDENTIALS, 401);
		}

		// Upgrade hashes made under older parameters while we hold the password.
		if (needsRehash(candidate.passwordHash)) {
			await s.updatePassword(candidate.user.id, await hashPassword(body.data.password), t);
		}

		if (candidate.user.totpEnabled) {
			const challenge = randomToken(32);
			await s.createMfaChallenge({
				userId: candidate.user.id,
				challengeHash: await sha256Hex(challenge),
				now: t,
			});
			// Past the password, so saying whether a passkey can stand in for the
			// code reveals nothing the caller has not just proven they may know.
			const passkeys = (await s.listPasskeys(candidate.user.id)).length > 0;
			return c.json({ status: "mfa_required", challenge, passkeys });
		}

		await s.recordLoginSuccess(candidate.user.id, ip, t);
		await issueSession(c, s, candidate.user, t);
		await authAudit(c, "auth.login", { user: candidate.user, detail: { method: "password" } });
		return c.json({ status: "ok", user: await publicUser(c.env, candidate.user) });
	});

	routes.post("/login/mfa", async (c) => {
		const ip = clientIp(c);
		if (!(await authLimitAll(c.env, [`mfa:ip:${ip}`]))) return rateLimited(c);
		const body = await parseBody(c, schemas.mfa);
		if (!body.ok) return body.res;
		const s = store(c);
		const t = now();
		const challengeHash = await sha256Hex(body.data.challenge);

		const expired = () =>
			c.json({ error: "This sign-in attempt expired. Sign in again.", code: "challenge_expired" }, 401);

		// Counts an attempt; null once expired or out of attempts.
		const challenge = await s.useMfaChallenge(challengeHash, t);
		if (!challenge) return expired();
		const user = await s.getUser(challenge.userId);
		if (!user || user.disabled) return expired();
		if (!(await authLimitAll(c.env, [`mfa:user:${user.id}`]))) return rateLimited(c);

		/**
		 * The account-wide second-factor lock, checked before the code so a
		 * locked account learns nothing from a guess. It spans challenges: a new
		 * challenge costs only the password, so a per-challenge cap alone would
		 * leave the code space open five guesses at a time.
		 */
		const mfaLock = await s.getMfaLock(user.id, t);
		if (mfaLock.lockedUntil > t) return lockedResponse(c, mfaLock.lockedUntil, t);

		const result = await verifySecondFactor(c.env, s, user, body.data.code, t);
		if (result === "totp_unavailable") return c.json(TOTP_UNAVAILABLE, 401);
		if (result === "invalid") {
			const failure = await s.recordMfaFailure(user.id, t);
			await authAudit(c, "auth.login_failed", { user: null, target: user.email, detail: { reason: "wrong_2fa_code" } });
			if (failure.lockedUntil > t) return lockedResponse(c, failure.lockedUntil, t);
			return c.json({ error: "Invalid code", code: "invalid_code" }, 401);
		}

		await s.deleteMfaChallenge(challengeHash);
		await s.recordLoginSuccess(user.id, ip, t);
		await issueSession(c, s, user, t);
		await authAudit(c, "auth.login", { user, detail: { method: "password+totp" } });
		return c.json({ status: "ok", user: await publicUser(c.env, user) });
	});

	routes.post("/logout", async (c) => {
		if (c.var.authUser) await authAudit(c, "auth.logout");
		if (c.var.authSessionHash) await store(c).deleteSession(c.var.authSessionHash);
		c.header("Set-Cookie", clearSessionCookie(c.req.url));
		return c.body(null, 204);
	});

	routes.get("/invites/:token", async (c) => {
		if (!(await authLimitAll(c.env, [`invite:ip:${clientIp(c)}`]))) return rateLimited(c);
		const invite = await store(c).getInvite(await sha256Hex(c.req.param("token")), now());
		if (!invite) return c.json({ error: "This invite is invalid or has expired", code: "not_found" }, 404);
		return c.json({ email: invite.email, role: invite.role, expiresAt: invite.expiresAt });
	});

	routes.post("/invites/accept", async (c) => {
		if (!(await authLimitAll(c.env, [`invite:ip:${clientIp(c)}`]))) return rateLimited(c);
		const body = await parseBody(c, schemas.acceptInvite);
		if (!body.ok) return body.res;
		const blocked = await checkTurnstile(c, body.data.turnstileToken);
		if (blocked) return blocked;
		const weak = validatePassword(body.data.password);
		if (weak) return weakPassword(c, weak);

		const s = store(c);
		const t = now();
		const result = await s.acceptInvite({
			tokenHash: await sha256Hex(body.data.token),
			name: body.data.name,
			passwordHash: await hashPassword(body.data.password),
			now: t,
		});
		if (!result.ok) {
			return result.reason === "email_taken"
				? c.json({ error: "An account with this email already exists", code: "email_taken" }, 409)
				: c.json({ error: "This invite is invalid or has expired", code: "not_found" }, 404);
		}

		/**
		 * The invite's authority becomes an ordinary grant, so what an invited
		 * user may reach is managed in the same Access screen as everyone else.
		 * Written after the account exists: if this write fails the user has an
		 * account with no grant, which denies — the safe half to lose.
		 */
		const { user, invite } = result;
		try {
			await putGrant(c.env.BUCKET, {
				id: user.email,
				kind: "user",
				role: invite.role,
				mailboxes: invite.role === "admin" ? [] : invite.mailboxes,
				label: user.name,
			});
		} catch (e) {
			console.error(`Failed to write the grant for invited user ${user.email}:`, (e as Error).message);
		}

		await issueSession(c, s, user, t);
		return c.json({ status: "ok", user: await publicUser(c.env, user) });
	});

	routes.get("/reset/:token", async (c) => {
		if (!(await authLimitAll(c.env, [`reset:ip:${clientIp(c)}`]))) return rateLimited(c);
		const reset = await store(c).getPasswordReset(await sha256Hex(c.req.param("token")), now());
		if (!reset) return c.json({ error: "This reset link is invalid or has expired", code: "not_found" }, 404);
		return c.json({ email: reset.email });
	});

	routes.post("/reset", async (c) => {
		if (!(await authLimitAll(c.env, [`reset:ip:${clientIp(c)}`]))) return rateLimited(c);
		const body = await parseBody(c, schemas.reset);
		if (!body.ok) return body.res;
		const weak = validatePassword(body.data.password);
		if (weak) return weakPassword(c, weak);

		const consumed = await store(c).consumePasswordReset({
			tokenHash: await sha256Hex(body.data.token),
			passwordHash: await hashPassword(body.data.password),
			now: now(),
		});
		if (!consumed) return c.json({ error: "This reset link is invalid or has expired", code: "not_found" }, 404);
		await authAudit(c, "auth.password_reset", {
			user: await store(c).getUser(consumed.userId),
			detail: { via: "reset_link" },
		});
		// Every session of that user is gone, including this browser's if it was theirs.
		c.header("Set-Cookie", clearSessionCookie(c.req.url));
		return c.body(null, 204);
	});

	/**
	 * Self-service "forgot password": email a reset link to the account holder.
	 *
	 * The answer never depends on the address. Everything that does — looking
	 * the account up, the per-account cap, issuing the link, rendering and
	 * sending the email — runs after the response, in `waitUntil`, so an unknown
	 * address, a disabled account, a capped one and a real one all return the
	 * same 202 after the same work. What runs before the response (rate limits,
	 * Turnstile) is keyed by strings the caller chose, never by an account.
	 *
	 * The link is an ordinary reset link: hashed, single use, replaces any
	 * earlier one, and using it revokes every session. It does not touch 2FA,
	 * unlike `/recover`: whoever controls the inbox gets the password, not the
	 * second factor, so an owner with TOTP still needs their authenticator.
	 */
	routes.post("/password/forgot", async (c) => {
		const body = await parseBody(c, schemas.forgot);
		if (!body.ok) return body.res;
		const address = normalizeEmail(body.data.email);
		/**
		 * Per IP, and per address. The per-address key is safe here where it is
		 * not for sign-in: exhausting it only delays a reset email for a minute,
		 * it never keeps anyone from signing in. It applies to unknown addresses
		 * identically, so a 429 says nothing about whether an account exists.
		 */
		if (!(await authLimitAll(c.env, [`forgot:ip:${clientIp(c)}`, `forgot:email:${address}`]))) {
			return rateLimited(c);
		}
		const blocked = await checkTurnstile(c, body.data.turnstileToken);
		if (blocked) return blocked;

		const sender = resolveAuthEmailSender(c.env);
		if (!sender) {
			return c.json(
				{ error: "Password reset by email is not available on this deployment", code: "not_enabled" },
				404,
			);
		}

		const s = store(c);
		const t = now();
		const base = appBaseUrl(c.env, c.req.url);
		const env = c.env;
		c.executionCtx.waitUntil(
			(async () => {
				const token = randomToken(32);
				const result = await s.issueEmailPasswordReset({
					email: address,
					tokenHash: await sha256Hex(token),
					expiresAt: t + EMAIL_RESET_LINK_MINUTES * 60_000,
					now: t,
				});
				if (!result.ok) {
					// Logged by account id only when one exists: the logs should not
					// become a list of every address someone typed into the form.
					if (result.reason === "capped") {
						console.warn("[auth] Reset email cap reached for an account; no email sent.");
					}
					return;
				}
				const appName = await issuerName(env);
				const content = buildResetEmail({
					appName,
					url: `${base}/reset/${token}`,
					expiresInMinutes: EMAIL_RESET_LINK_MINUTES,
				});
				await sendResetEmail(env.EMAIL, sender, result.user.email, content, appName);
			})().catch((e) => {
				console.error("[auth] Failed to send a password reset email:", (e as Error).message);
			}),
		);
		return c.json(FORGOT_ACCEPTED, 202);
	});

	/**
	 * Break-glass owner recovery.
	 *
	 * Only with a configured `SETUP_TOKEN` of at least 16 characters: a
	 * generated one was printed to the logs, and a value that has been in a log
	 * is not a credential that should be able to take over the owner account
	 * months later; a short one could be guessed. Because this endpoint resets
	 * the owner, wrong tokens are also capped globally, in the AuthDO, so no
	 * number of IP addresses (and no missing rate limiter binding) buys more
	 * than ten guesses an hour.
	 */
	routes.post("/recover", async (c) => {
		if (!(await authLimitAll(c.env, [`recover:ip:${clientIp(c)}`, "recover:global"]))) return rateLimited(c);
		const body = await parseBody(c, schemas.recover);
		if (!body.ok) return body.res;
		const unavailable = () =>
			c.json(
				{
					error: `Recovery requires a SETUP_TOKEN secret of at least ${RECOVERY_TOKEN_MIN_LENGTH} characters`,
					code: "recovery_unavailable",
				},
				404,
			);
		if (!setupTokenConfigured(c.env)) return unavailable();
		if (!recoveryTokenUsable(c.env)) {
			console.error(
				`[auth] /recover is disabled: SETUP_TOKEN is shorter than ${RECOVERY_TOKEN_MIN_LENGTH} characters, ` +
					`too short to guard owner recovery. Set a longer one with \`wrangler secret put SETUP_TOKEN\`.`,
			);
			return unavailable();
		}

		const s = store(c);
		const t = now();
		const lock = await s.getRecoveryLock(t);
		if (lock.lockedUntil > t) return recoveryLockedResponse(c, lock.lockedUntil, t);

		if (!(await secretsEqual(body.data.setupToken.trim(), c.env.SETUP_TOKEN!.trim()))) {
			const failure = await s.recordRecoveryFailure(t);
			await authAudit(c, "auth.login_failed", { user: null, target: "owner-recovery", detail: { reason: "bad_setup_token" } });
			console.warn(
				`[auth] Failed owner recovery attempt from ${clientIp(c)} ` +
					`(${failure.failures} in the current hour).` +
					(failure.lockedUntil > t ? " /recover is now closed for an hour." : ""),
			);
			if (failure.lockedUntil > t) return recoveryLockedResponse(c, failure.lockedUntil, t);
			return c.json({ error: "Invalid setup token", code: "bad_setup_token" }, 403);
		}
		const weak = validatePassword(body.data.password);
		if (weak) return weakPassword(c, weak);

		const recovered = await s.recoverOwner({
			passwordHash: await hashPassword(body.data.password),
			now: t,
		});
		if (!recovered) return c.json({ error: "There is no owner account yet", code: "not_found" }, 404);
		console.warn(`[auth] owner account ${recovered.email} recovered with SETUP_TOKEN`);
		await authAudit(c, "auth.password_reset", { user: recovered, detail: { via: "setup_token_recovery" } });
		return c.body(null, 204);
	});

	// Passkeys (WebAuthn): sign-in, second factor and management. See passkeys.ts.
	routes.route("/passkeys", createPasskeyRoutes(deps));

	// -- signed in -------------------------------------------------------------

	routes.patch("/profile", requireUser, async (c) => {
		const body = await parseBody(c, schemas.profile);
		if (!body.ok) return body.res;
		const user = await store(c).updateProfile(c.var.authUser!.id, { name: body.data.name });
		if (!user) return c.json({ error: "Account not found", code: "not_found" }, 404);
		return c.json({ user: await publicUser(c.env, user) });
	});

	/**
	 * Session-only, like 2FA changes and token creation: an API token is a
	 * delegated credential, and letting it change the password would let a leaked
	 * token take the account over outright.
	 */
	routes.post("/password", requireSession, async (c) => {
		const body = await parseBody(c, schemas.changePassword);
		if (!body.ok) return body.res;
		const s = store(c);
		const user = c.var.authUser!;
		const candidate = await s.getLoginCandidate(user.email);
		if (!candidate || !(await verifyPassword(body.data.currentPassword, candidate.passwordHash))) {
			return c.json({ error: "Current password is incorrect", code: "wrong_password" }, 400);
		}
		const weak = validatePassword(body.data.newPassword);
		if (weak) return weakPassword(c, weak);

		await s.updatePassword(user.id, await hashPassword(body.data.newPassword), now());
		await s.revokeOtherSessions(user.id, c.var.authSessionHash ?? null);
		await authAudit(c, "auth.password_change");
		return c.body(null, 204);
	});

	routes.get("/sessions", requireUser, async (c) => {
		const sessions = await store(c).listSessions(c.var.authUser!.id, now());
		const current = c.var.authSessionId ?? null;
		return c.json({ sessions: sessions.map((s) => ({ ...s, current: s.id === current })) });
	});

	/**
	 * Session-only: with a token there is no "current" session to keep, so this
	 * would sign the user out everywhere, and a leaked token should not be able
	 * to evict the owner from their own browser.
	 */
	routes.post("/sessions/revoke-others", requireSession, async (c) => {
		const revoked = await store(c).revokeOtherSessions(c.var.authUser!.id, c.var.authSessionHash ?? null);
		await authAudit(c, "auth.session_revoke", { detail: { scope: "others", sessions: revoked } });
		return c.json({ revoked });
	});

	routes.delete("/sessions/:id", requireSession, async (c) => {
		const ok = await store(c).revokeSession(c.var.authUser!.id, c.req.param("id"));
		if (!ok) return c.json({ error: "Session not found", code: "not_found" }, 404);
		await authAudit(c, "auth.session_revoke", { target: c.req.param("id") });
		return c.body(null, 204);
	});

	routes.post("/2fa/setup", requireSession, async (c) => {
		const body = await parseBody(c, schemas.passwordOnly);
		if (!body.ok) return body.res;
		const s = store(c);
		const user = c.var.authUser!;
		if (!(await checkPassword(s, user, body.data.password))) {
			return c.json({ error: "Password is incorrect", code: "wrong_password" }, 400);
		}
		if ((await s.getTotp(user.id)).enabled) {
			return c.json({ error: "Two-factor authentication is already on", code: "already_enabled" }, 409);
		}
		const secret = generateTotpSecret();
		await s.setPendingTotp(user.id, await encryptSecret(secret, await authSecret(c.env, s)));
		const issuer = await issuerName(c.env);
		return c.json({ secret, otpauthUrl: totpUri({ secret, account: user.email, issuer }) });
	});

	routes.post("/2fa/enable", requireSession, async (c) => {
		const body = await parseBody(c, schemas.code);
		if (!body.ok) return body.res;
		const s = store(c);
		const user = c.var.authUser!;
		const totp = await s.getTotp(user.id);
		if (totp.enabled) {
			return c.json({ error: "Two-factor authentication is already on", code: "already_enabled" }, 409);
		}
		if (!totp.secretEnc) {
			return c.json({ error: "Start two-factor setup first", code: "no_pending_totp" }, 400);
		}
		let secret: string;
		try {
			secret = await decryptSecret(totp.secretEnc, await authSecret(c.env, s));
		} catch {
			return c.json({ error: "Start two-factor setup again", code: "no_pending_totp" }, 400);
		}
		const step = await verifyTotp(secret, body.data.code, now());
		if (step === null) return c.json({ error: "Invalid code", code: "invalid_code" }, 400);

		const { codes, hashes } = await mintRecoveryCodes();
		await s.enableTotp(user.id, step, hashes);
		await authAudit(c, "auth.2fa_enable");
		return c.json({ recoveryCodes: codes });
	});

	routes.post("/2fa/disable", requireSession, async (c) => {
		const body = await parseBody(c, schemas.disable2fa);
		if (!body.ok) return body.res;
		const s = store(c);
		const user = c.var.authUser!;
		if (!(await checkPassword(s, user, body.data.password))) {
			return c.json({ error: "Password is incorrect", code: "wrong_password" }, 400);
		}
		const result = await verifySecondFactor(c.env, s, user, body.data.code, now());
		if (result === "totp_unavailable") return c.json(TOTP_UNAVAILABLE, 400);
		if (result === "invalid") return c.json({ error: "Invalid code", code: "invalid_code" }, 400);
		await s.disableTotp(user.id);
		await authAudit(c, "auth.2fa_disable");
		return c.body(null, 204);
	});

	routes.post("/2fa/recovery-codes", requireSession, async (c) => {
		const body = await parseBody(c, schemas.passwordOnly);
		if (!body.ok) return body.res;
		const s = store(c);
		const user = c.var.authUser!;
		if (!(await checkPassword(s, user, body.data.password))) {
			return c.json({ error: "Password is incorrect", code: "wrong_password" }, 400);
		}
		if (!(await s.getTotp(user.id)).enabled) {
			return c.json({ error: "Two-factor authentication is off", code: "not_enabled" }, 400);
		}
		const { codes, hashes } = await mintRecoveryCodes();
		await s.replaceRecoveryCodes(user.id, hashes);
		await authAudit(c, "auth.recovery_codes");
		return c.json({ recoveryCodes: codes });
	});

	routes.get("/tokens", requireUser, async (c) => {
		const tokens = await store(c).listApiTokens(c.var.authUser!.id);
		// A scoped token sees itself and what it minted, not its user's other tokens.
		const caller = scopedCaller(c);
		if (caller) {
			return c.json({
				tokens: tokens.filter((t) => t.id === caller.id || isDescendantToken(tokens, t.id, caller.id)),
			});
		}
		return c.json({ tokens });
	});

	/**
	 * Mint a token.
	 *
	 * From a browser session: any scopes and mailboxes (the user's grants still
	 * bound what the token can really do, at request time).
	 *
	 * From a *scoped* API token (the CLI's `tapemail token create`): only a child
	 * no broader than the caller — scopes a subset, mailboxes a subset, expiry no
	 * later — recorded as its child, so revoking the caller revokes it too. A
	 * delegated credential can hand out less of itself but never outlive or
	 * outgrow itself. A legacy unscoped token still cannot mint, as before: it
	 * carries the whole account, and minting from it is exactly the escalation
	 * `requireSession` exists to stop.
	 */
	routes.post("/tokens", requireUser, async (c) => {
		const body = await parseBody(c, schemas.createToken);
		if (!body.ok) return body.res;
		const t = now();
		const days = body.data.expiresInDays ?? null;
		let expiresAt = days === null ? null : t + days * DAY_MS;
		let scopes = body.data.scopes === undefined ? null : normalizeTokenScopes(body.data.scopes);
		let mailboxes = body.data.mailboxes === undefined ? null : normalizeTokenMailboxes(body.data.mailboxes);
		let parentId: string | null = null;

		if (c.var.authMethod === "token") {
			const parent = c.var.authToken;
			// Effective, not stored: a mailbox-only parent holds the mail scopes
			// and nothing admin-class, so it cannot mint an `admin` child.
			const parentScopes = parent ? effectiveTokenScopes(parent) : null;
			if (!parent || parentScopes === null) {
				return c.json(
					{
						error: "This token has full account access, so it cannot create tokens. Create one from a signed-in browser session, or use a scoped token.",
						code: "session_required",
					},
					403,
				);
			}
			// Omitted fields inherit the parent's, rather than defaulting to "everything".
			scopes ??= parentScopes;
			mailboxes ??= parent.mailboxes;
			if (!isScopeSubset(scopes, parentScopes)) {
				return c.json(
					{ error: "A token can only create tokens with a subset of its own scopes.", code: "scope_exceeds_parent" },
					403,
				);
			}
			if (!isMailboxSubset(mailboxes, parent.mailboxes)) {
				return c.json(
					{ error: "A token can only create tokens for a subset of its own mailboxes.", code: "mailbox_exceeds_parent" },
					403,
				);
			}
			if (parent.expiresAt !== null && (expiresAt === null || expiresAt > parent.expiresAt)) {
				expiresAt = parent.expiresAt;
			}
			parentId = parent.id;
		} else if (c.var.authMethod !== "session") {
			return c.json(
				{ error: "This action requires a signed-in browser session, not an API token.", code: "session_required" },
				403,
			);
		}

		const id = randomAlphanumeric(12);
		const secret = randomToken(32);
		let token: ApiTokenInfo;
		try {
			token = await store(c).createApiToken({
				id,
				userId: c.var.authUser!.id,
				name: body.data.name,
				secretHash: await sha256Hex(secret),
				expiresAt,
				now: t,
				scopes,
				mailboxes,
				parentId,
			});
		} catch (e) {
			// The parent was revoked or expired between authenticating this
			// request and the insert (the store re-checks inside its transaction).
			if ((e as Error).message?.includes("parent_token_inactive")) {
				return c.json({ error: "This token has been revoked or has expired.", code: "parent_token_inactive" }, 403);
			}
			throw e;
		}
		await authAudit(c, "auth.token_create", {
			target: token.id,
			detail: {
				name: token.name,
				scopes: scopes === null ? "all" : scopes.join(" "),
				mailboxes: mailboxes === null ? "all" : mailboxes.length,
				...(parentId ? { parent: parentId } : {}),
			},
		});
		return c.json({ token, secret: `ttk_${id}_${secret}` }, 201);
	});

	/**
	 * A session may revoke any of the user's tokens; a scoped token only itself
	 * or tokens it minted, so a narrow token cannot cut off its siblings.
	 */
	routes.delete("/tokens/:id", requireUser, async (c) => {
		const s = store(c);
		const userId = c.var.authUser!.id;
		const targetId = c.req.param("id");
		const caller = scopedCaller(c);
		if (caller && caller.id !== targetId) {
			const tokens = await s.listApiTokens(userId);
			if (!isDescendantToken(tokens, targetId, caller.id)) {
				return c.json({ error: "Token not found", code: "not_found" }, 404);
			}
		}
		const ok = await s.revokeApiToken(userId, targetId);
		if (!ok) return c.json({ error: "Token not found", code: "not_found" }, 404);
		await authAudit(c, "auth.token_revoke", { target: targetId });
		return c.body(null, 204);
	});

	// -- connected apps (MCP OAuth) ------------------------------------------------

	/**
	 * Best-effort removal of the provider's KV records once the AuthDO row is
	 * gone. Not needed for correctness — every `/mcp` request and every refresh
	 * checks the AuthDO row first — but it keeps KV from holding dead grants for
	 * their 30-day lifetime. In `waitUntil` so a slow KV list never delays the UI.
	 */
	function cleanupProviderGrants(c: C, userId: string, grantId?: string) {
		if (!deps.mcpOAuth || !c.env.OAUTH_KV) return;
		const work = deps.mcpOAuth
			.revokeProviderGrants(c.env, new URL(c.req.url).origin, userId, grantId)
			.catch((e) => console.error("[oauth] provider grant cleanup failed:", (e as Error).message));
		try {
			c.executionCtx.waitUntil(work);
		} catch {
			// No execution context (unit tests): the promise still runs.
		}
	}

	routes.get("/oauth-grants", requireUser, async (c) => {
		return c.json({ grants: await store(c).listOAuthGrants(c.var.authUser!.id) });
	});

	/**
	 * Trust a connected app to send without approval, on mailboxes whose owner
	 * set agent sends to "auto". Session-only: an app must never be able to grant
	 * itself this, and neither should any token.
	 */
	routes.patch("/oauth-grants/:id", requireSession, async (c) => {
		const body = await parseBody(c, z.object({ sendAuto: z.boolean() }).strict());
		if (!body.ok) return body.res;
		const grant = await store(c).setOAuthGrantSendAuto(c.var.authUser!.id, c.req.param("id"), body.data.sendAuto);
		if (!grant) return c.json({ error: "App not found", code: "not_found" }, 404);
		await authAudit(c, "auth.oauth_send_auto", {
			target: grant.id,
			detail: { sendAuto: grant.sendAuto, oauthClient: grant.clientId, oauthClientName: grant.clientName },
		});
		return c.json({ grant });
	});

	routes.delete("/oauth-grants/:id", requireUser, async (c) => {
		const userId = c.var.authUser!.id;
		const grantId = c.req.param("id");
		const ok = await store(c).revokeOAuthGrant(userId, grantId);
		if (!ok) return c.json({ error: "App not found", code: "not_found" }, 404);
		cleanupProviderGrants(c, userId, grantId);
		await authAudit(c, "auth.oauth_revoke", { target: grantId });
		return c.body(null, 204);
	});

	// -- administration --------------------------------------------------------

	/**
	 * Admin is decided by the same principal the rest of the API uses — owner,
	 * `ADMIN_EMAILS`, or an admin grant — so there is one answer to "is this an
	 * administrator" across the app.
	 */
	const requireAuthAdmin = createMiddleware<MailboxContext>(async (c, next) => {
		if (!isAdmin(c.var.principal)) {
			return c.json({ error: "Administrator access required", code: "forbidden" }, 403);
		}
		return next();
	});
	/**
	 * Reading the user and invite lists works with an API token, for scripts.
	 * Anything that changes accounts needs a browser session: otherwise a leaked
	 * admin token could mint a reset link for its own account, invite a new
	 * admin, or disable the people who would revoke it — turning a delegated
	 * credential into the account itself, which is what `requireSession` exists
	 * to prevent.
	 */
	const requireSessionToMutate = createMiddleware<MailboxContext>(async (c, next) => {
		if (c.req.method === "GET" || c.req.method === "HEAD") return next();
		return requireSession(c, next);
	});
	routes.use("/admin/*", requireUser, resolvePrincipal, requireAuthAdmin, requireSessionToMutate);

	routes.get("/admin/users", async (c) => {
		const users = await store(c).listUsers();
		const withRoles = await Promise.all(
			users.map(async (user) => ({ ...user, isAdmin: isAdmin(await principalForUser(c.env, user)) })),
		);
		return c.json({ users: withRoles });
	});

	routes.get("/admin/invites", async (c) => {
		return c.json({ invites: await store(c).listInvites(now()) });
	});

	routes.post("/admin/invites", async (c) => {
		const body = await parseBody(c, schemas.createInvite);
		if (!body.ok) return body.res;
		const s = store(c);
		const address = normalizeEmail(body.data.email);
		if (await s.getUserByEmail(address)) {
			return c.json({ error: "An account with this email already exists", code: "email_taken" }, 409);
		}
		const t = now();
		const token = randomToken(32);
		const mailboxes =
			body.data.role === "member" ? [...new Set((body.data.mailboxes ?? []).map(normalizeEmail))] : [];
		let invite;
		try {
			invite = await s.createInvite({
				tokenHash: await sha256Hex(token),
				email: address,
				role: body.data.role,
				mailboxes,
				createdBy: c.var.authUser!.id,
				expiresAt: t + (body.data.expiresInDays ?? 7) * DAY_MS,
				now: t,
			});
		} catch (e) {
			// The store re-checks inside its transaction; a race lands here.
			if ((e as Error).message?.includes("email_taken")) {
				return c.json({ error: "An account with this email already exists", code: "email_taken" }, 409);
			}
			throw e;
		}
		return c.json({ invite, url: `${appBaseUrl(c.env, c.req.url)}/invite/${token}` }, 201);
	});

	routes.delete("/admin/invites/:id", async (c) => {
		const ok = await store(c).revokeInvite(c.req.param("id"));
		if (!ok) return c.json({ error: "Invite not found", code: "not_found" }, 404);
		return c.body(null, 204);
	});

	/**
	 * A reset link is a takeover of the target account, so it follows the
	 * owner's floor: only the owner can mint one for the owner (other admins
	 * are below it), and nobody mints one for themselves — that is the password
	 * change, which asks for the current password.
	 */
	routes.post("/admin/users/:id/reset-link", async (c) => {
		const s = store(c);
		const caller = c.var.authUser!;
		const user = await s.getUser(c.req.param("id"));
		if (!user) return c.json({ error: "User not found", code: "not_found" }, 404);
		if (user.id === caller.id) {
			return c.json(
				{ error: "Change your own password under Account & security instead", code: "self_protected" },
				400,
			);
		}
		if (user.isOwner && !caller.isOwner) {
			return c.json({ error: "Only the owner can reset the owner's password", code: "owner_protected" }, 403);
		}
		const t = now();
		const token = randomToken(32);
		const expiresAt = t + RESET_LINK_MS;
		await s.createPasswordReset({ userId: user.id, tokenHash: await sha256Hex(token), expiresAt, now: t });
		return c.json({ url: `${appBaseUrl(c.env, c.req.url)}/reset/${token}`, expiresAt });
	});

	routes.post("/admin/users/:id/disable", async (c) => {
		const body = await parseBody(c, schemas.setDisabled);
		if (!body.ok) return body.res;
		const s = store(c);
		const target = await guardTarget(c, s);
		if (target instanceof Response) return target;
		await s.setDisabled(target.id, body.data.disabled);
		if (body.data.disabled) cleanupProviderGrants(c, target.id);
		return c.body(null, 204);
	});

	routes.delete("/admin/users/:id", async (c) => {
		const s = store(c);
		const target = await guardTarget(c, s);
		if (target instanceof Response) return target;
		await s.deleteUser(target.id);
		cleanupProviderGrants(c, target.id);
		// Otherwise re-inviting the same address would silently restore the old access.
		await deleteGrant(c.env.BUCKET, "user", target.email);
		return c.body(null, 204);
	});

	return routes;
}

/**
 * The same body for every lock — a real account, an unknown address, or the
 * second factor — so the response itself never says which one it was.
 */
export function lockedResponse(c: C, lockedUntil: number, now: number): Response {
	const retryAfter = Math.max(1, Math.ceil((lockedUntil - now) / 1000));
	return c.json(
		{ error: "Too many failed attempts. Sign-in is temporarily locked.", code: "locked", retryAfter },
		423,
		{ "Retry-After": String(retryAfter) },
	);
}

function recoveryLockedResponse(c: C, lockedUntil: number, now: number): Response {
	const retryAfter = Math.max(1, Math.ceil((lockedUntil - now) / 1000));
	return c.json(
		{ error: "Too many failed recovery attempts. Recovery is closed for now.", code: "locked", retryAfter },
		423,
		{ "Retry-After": String(retryAfter) },
	);
}

export async function checkPassword(store: AuthStoreApi, user: AuthUser, password: string): Promise<boolean> {
	const candidate = await store.getLoginCandidate(user.email);
	return Boolean(candidate && (await verifyPassword(password, candidate.passwordHash)));
}

/** The account an admin action targets, refusing the owner and the caller themselves. */
async function guardTarget(c: C, store: AuthStoreApi): Promise<AuthUser | Response> {
	const target = await store.getUser(c.req.param("id") ?? "");
	if (!target) return c.json({ error: "User not found", code: "not_found" }, 404);
	if (target.isOwner) {
		return c.json({ error: "The owner account cannot be changed here", code: "owner_protected" }, 400);
	}
	if (target.id === c.var.authUser?.id) {
		return c.json({ error: "You cannot do this to your own account", code: "self_protected" }, 400);
	}
	return target;
}

/** Name shown in authenticator apps: the deployment's configured app name. */
export async function issuerName(env: Env): Promise<string> {
	try {
		return (await getBranding(env.BUCKET)).appName || "cloudmail";
	} catch {
		return "cloudmail";
	}
}
