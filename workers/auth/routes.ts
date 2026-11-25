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
import { buildSessionCookie, buildTrustCookie, clearSessionCookie, clearTrustCookie, readTrustCookie } from "./cookies";
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
import { ACCOUNT_ALERT_THRESHOLD, LOCKOUT_THRESHOLD, MFA_TOTP_DISABLE_AFTER, RECOVERY_HASH_PREFIX } from "./store-core";
import { notifySecurityEvent } from "./security-email";
import { buildResetEmail, sendResetEmail } from "./reset-email";
import { createPasskeyRoutes, PASSKEY_REAUTH_MS } from "./passkeys";
import { authAudit } from "./audit-events";
import { recordAuditDeferred } from "../lib/audit";
import { hasSecondFactor, invalidateSecurityPolicy, mustEnrolFirst } from "./security-policy";
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
	mfa: z.object({
		challenge: opaqueToken,
		code: z.string().trim().min(1).max(64),
		/** "Trust this browser for 30 days": later password sign-ins here skip this step. */
		trustBrowser: z.boolean().optional(),
	}),
	acceptInvite: z.object({ token: opaqueToken, name: displayName, password, turnstileToken }),
	reset: z.object({ token: opaqueToken, password }),
	forgot: z.object({ email, turnstileToken }),
	recover: z.object({ setupToken: z.string().min(1).max(512), password }),
	profile: z.object({ name: displayName }),
	changePassword: z.object({ currentPassword: password, newPassword: password }),
	passwordOnly: z.object({ password }),
	/** Needed only by accounts with no second factor yet (see `factorChangeGuard`). */
	optionalPassword: z.object({ password: password.optional() }),
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
		/**
		 * Role per mailbox in `mailboxes`: viewer, agent, manager or owner. A
		 * mailbox left out is granted as owner, which is what every invite did
		 * before roles could be chosen.
		 */
		mailboxRoles: z.record(z.string(), z.enum(["viewer", "agent", "manager", "owner"])).optional(),
		expiresInDays: z.number().int().min(1).max(30).optional(),
	}),
	setDisabled: z.object({ disabled: z.boolean() }),
	securityPolicy: z.object({ requireMfa: z.boolean() }),
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
 * Start a fresh session and attach its cookie. Returns the new token's hash.
 *
 * Always a new token, never a reused one, so a token planted before sign-in
 * (session fixation) is worthless. Any session the browser already held is
 * ended, so switching accounts does not leave the old one live. A browser
 * trusted for this account gets its session linked to that trust, so signing
 * the session out from Settings forgets the browser too.
 */
export async function issueSession(
	c: C,
	store: AuthStoreApi,
	user: AuthUser,
	now: number,
	options: { secondFactor?: boolean } = {},
): Promise<string> {
	if (c.var.authSessionHash) await store.deleteSession(c.var.authSessionHash);
	const token = randomToken(32);
	const tokenHash = await sha256Hex(token);
	const trustTokenHash = await trustedBrowserHash(c);
	await store.createSession({
		userId: user.id,
		tokenHash,
		ip: c.req.header("cf-connecting-ip") ?? null,
		userAgent: c.req.header("user-agent")?.slice(0, 512) ?? null,
		now,
		// A sign-in with a second factor counts as a fresh proof for changing factors.
		...(options.secondFactor ? { secondFactor: true } : {}),
		...(trustTokenHash ? { trustTokenHash } : {}),
	});
	c.header("Set-Cookie", buildSessionCookie(token, c.req.url), { append: true });
	return tokenHash;
}

/** Hash of this browser's trusted-browser token, or null when it holds none. */
export async function trustedBrowserHash(c: C): Promise<string | null> {
	const token = readTrustCookie(c.req.header("cookie"), c.req.url);
	return token ? sha256Hex(token) : null;
}

/**
 * "Trust this browser for 30 days", after a completed second step. A new
 * token every time; the one the browser held before is dropped, since the new
 * cookie overwrites it. `sessionTokenHash` is the session just issued, linked
 * to the new trust.
 *
 * Best effort: the sign-in has already succeeded, so a storage error here is
 * logged and the browser is simply not trusted. Returns whether it is.
 */
export async function trustThisBrowser(
	c: C,
	store: AuthStoreApi,
	user: AuthUser,
	now: number,
	sessionTokenHash: string,
): Promise<boolean> {
	const token = randomToken(32);
	try {
		await store.trustBrowser({
			userId: user.id,
			tokenHash: await sha256Hex(token),
			replaceTokenHash: await trustedBrowserHash(c),
			ip: c.req.header("cf-connecting-ip") ?? null,
			userAgent: c.req.header("user-agent")?.slice(0, 512) ?? null,
			now,
			sessionTokenHash,
		});
	} catch (e) {
		console.error(
			`[auth] Couldn't trust this browser for ${user.email}: ${(e as Error).message}. ` +
				`The sign-in went ahead; the next one here asks for the second step.`,
		);
		return false;
	}
	c.header("Set-Cookie", buildTrustCookie(token, c.req.url), { append: true });
	return true;
}

/**
 * Outcome of a second-factor check. `totp_unavailable` is its own answer
 * because it is not a wrong guess: the stored secret cannot be decrypted, so no
 * authenticator code can ever pass, and the user needs to hear "use a recovery
 * code" rather than "try again".
 */
type SecondFactorResult = "ok" | "invalid" | "totp_unavailable" | "totp_suspended";

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
		// After this many wrong second factors in a row, codes stop counting
		// until a passkey or recovery code (which reset the count) gets in.
		if (await store.isTotpSuspended(user.id, now)) return "totp_suspended";
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
	if (await store.consumeRecoveryCode(user.id, await recoveryCodeHash(user.id, normalized))) return "ok";
	// Codes issued before per-user hashing: plain SHA-256, until the set is replaced.
	return (await store.consumeRecoveryCode(user.id, await sha256Hex(normalized))) ? "ok" : "invalid";
}

/**
 * How a recovery code is stored: SHA-256 over the user id and the code, as
 * `v2.<hex>`. The user id salts it, so one table of hashes cannot be checked
 * against every account at once; with 80-bit codes no offline search is
 * practical anyway. Deliberately not keyed by `AUTH_SECRET`: recovery codes
 * are the way back in when that secret changes and TOTP stops decrypting.
 * The `v2.` prefix tells these apart from older plain hashes.
 */
export async function recoveryCodeHash(userId: string, normalizedCode: string): Promise<string> {
	return `${RECOVERY_HASH_PREFIX}${await sha256Hex(`${userId}:${normalizedCode}`)}`;
}

export const TOTP_SUSPENDED = {
	error:
		"Too many wrong codes. Authenticator codes are turned off for this account for a day, or until you sign in with a passkey or a recovery code.",
	code: "totp_suspended",
} as const;

/** The error body for a failed second factor that is not a plain wrong guess, or null. */
export function secondFactorProblem(result: SecondFactorResult) {
	if (result === "totp_unavailable") return TOTP_UNAVAILABLE;
	if (result === "totp_suspended") return TOTP_SUSPENDED;
	return null;
}

export const TOTP_UNAVAILABLE = {
	error:
		"Authenticator codes can't be checked for this account right now. Sign in with one of your recovery codes, then set up two-factor authentication again.",
	code: "totp_unavailable",
} as const;

/** Fresh recovery codes: plaintext for the user (once), hashes for the store. */
export async function mintRecoveryCodes(userId: string): Promise<{ codes: string[]; hashes: string[] }> {
	const codes = generateRecoveryCodes();
	const hashes = await Promise.all(codes.map((code) => recoveryCodeHash(userId, normalizeRecoveryCode(code))));
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

		/**
		 * Two-factor is on when the account has an authenticator app or a
		 * passkey, and then a password alone never signs in: the second step
		 * takes a passkey, an app code or a recovery code. Signing in with a
		 * passkey directly skips this (user verification makes it two factors).
		 *
		 * A browser the user trusted at an earlier second step skips it too,
		 * for this account only. Its sign-in is not a second-factor proof, so
		 * changing factors from it still asks for a passkey or code, and it
		 * leaves the wrong-code count alone.
		 */
		if (hasSecondFactor(candidate.user)) {
			const trustHash = await trustedBrowserHash(c);
			if (trustHash && (await s.useTrustedBrowser(candidate.user.id, trustHash, t))) {
				await s.recordLoginSuccess(candidate.user.id, ip, t, { keepMfaFailures: true });
				await issueSession(c, s, candidate.user, t);
				await authAudit(c, "auth.login", { user: candidate.user, detail: { method: "password+trusted_browser" } });
				return c.json({ status: "ok", user: await publicUser(c.env, candidate.user) });
			}
			const challenge = randomToken(32);
			await s.createMfaChallenge({
				userId: candidate.user.id,
				challengeHash: await sha256Hex(challenge),
				now: t,
			});
			// Past the password, so saying which second factors the account has
			// reveals nothing the caller has not just proven they may know.
			const passkeys = (await s.listPasskeys(candidate.user.id)).length > 0;
			return c.json({ status: "mfa_required", challenge, passkeys, totp: candidate.user.totpEnabled });
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
		const problem = secondFactorProblem(result);
		if (problem) return c.json(problem, 401);
		if (result === "invalid") {
			const failure = await s.recordMfaFailure(user.id, t);
			await authAudit(c, "auth.login_failed", { user: null, target: user.email, detail: { reason: "wrong_2fa_code" } });
			noteSecondStepFailure(c, user, failure.failures, t);
			if (failure.lockedUntil > t) return lockedResponse(c, failure.lockedUntil, t);
			return c.json({ error: "Invalid code", code: "invalid_code" }, 401);
		}

		await s.deleteMfaChallenge(challengeHash);
		await s.recordLoginSuccess(user.id, ip, t);
		const sessionHash = await issueSession(c, s, user, t, { secondFactor: true });
		const trusted = body.data.trustBrowser ? await trustThisBrowser(c, s, user, t, sessionHash) : false;
		const usedRecoveryCode = !/^\d{6}$/.test(body.data.code.replace(/\s/g, ""));
		await authAudit(c, "auth.login", {
			user,
			detail: {
				method: usedRecoveryCode ? "password+recovery_code" : "password+totp",
				...(trusted ? { trustedBrowser: true } : {}),
			},
		});
		if (usedRecoveryCode) {
			notifySecurityEvent(c, user.email, { kind: "recovery_code_used", codesLeft: await s.countRecoveryCodes(user.id) }, t);
		}
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
				mailboxes: [] as string[],
				access: invite.role === "admin" ? [] : invite.access,
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
		const resetUser = await store(c).getUser(consumed.userId);
		await authAudit(c, "auth.password_reset", { user: resetUser, detail: { via: "reset_link" } });
		if (resetUser) notifySecurityEvent(c, resetUser.email, { kind: "password_reset" }, now());
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
				await sendResetEmail(env, sender, result.user.email, content, appName);
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
		notifySecurityEvent(c, recovered.email, { kind: "owner_recovered" }, t);
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
		// Other browsers are signed out and forgotten; this one stays trusted.
		await s.revokeOtherSessions(user.id, c.var.authSessionHash ?? null, await trustedBrowserHash(c));
		await authAudit(c, "auth.password_change");
		notifySecurityEvent(c, user.email, { kind: "password_changed" }, now());
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
		// Also forgets every other trusted browser: a lost device must not skip the second step.
		const revoked = await store(c).revokeOtherSessions(
			c.var.authUser!.id,
			c.var.authSessionHash ?? null,
			await trustedBrowserHash(c),
		);
		await authAudit(c, "auth.session_revoke", { detail: { scope: "others", sessions: revoked } });
		return c.json({ revoked });
	});

	/** Also forgets the trusted browser that session ran in: this is the lost-device button. */
	routes.delete("/sessions/:id", requireSession, async (c) => {
		const ok = await store(c).revokeSession(c.var.authUser!.id, c.req.param("id"));
		if (!ok) return c.json({ error: "Session not found", code: "not_found" }, 404);
		await authAudit(c, "auth.session_revoke", { target: c.req.param("id") });
		return c.body(null, 204);
	});

	/**
	 * Browsers trusted to skip the second step. `current` marks this one.
	 * Signing out keeps a browser trusted; these routes, "sign out all
	 * others", a password change or reset, and losing every factor forget them.
	 */
	routes.get("/trusted-browsers", requireUser, async (c) => {
		const browsers = await store(c).listTrustedBrowsers(c.var.authUser!.id, now(), await trustedBrowserHash(c));
		return c.json({ browsers });
	});

	routes.delete("/trusted-browsers/:id", requireSession, async (c) => {
		const s = store(c);
		const user = c.var.authUser!;
		const id = c.req.param("id");
		const browsers = await s.listTrustedBrowsers(user.id, now(), await trustedBrowserHash(c));
		if (!(await s.revokeTrustedBrowser(user.id, id))) {
			return c.json({ error: "Trusted browser not found", code: "not_found" }, 404);
		}
		if (browsers.some((b) => b.id === id && b.current)) c.header("Set-Cookie", clearTrustCookie(c.req.url));
		await authAudit(c, "auth.trusted_browser_revoke", { target: id });
		return c.body(null, 204);
	});

	routes.post("/trusted-browsers/revoke-all", requireSession, async (c) => {
		const revoked = await store(c).revokeTrustedBrowsers(c.var.authUser!.id);
		c.header("Set-Cookie", clearTrustCookie(c.req.url));
		await authAudit(c, "auth.trusted_browser_revoke", { detail: { scope: "all", browsers: revoked } });
		return c.json({ revoked });
	});

	/**
	 * Start setting up the authenticator app. An account that already has a
	 * passkey proves it with that passkey (`factorChangeGuard`); one with no
	 * second factor yet confirms its password. A password sent anyway is checked.
	 */
	routes.post("/2fa/setup", requireSession, async (c) => {
		const body = await parseBody(c, schemas.optionalPassword);
		if (!body.ok) return body.res;
		const s = store(c);
		const user = c.var.authUser!;
		if (body.data.password !== undefined) {
			const wrong = await checkPasswordCounted(c, s, user, body.data.password, now());
			if (wrong) return wrong;
		}
		if (hasSecondFactor(user)) {
			const blocked = await factorChangeGuard(c, s, user, now());
			if (blocked) return blocked;
		} else if (body.data.password === undefined) {
			return c.json({ error: "Enter your current password", code: "password_required" }, 400);
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

		// Someone who already has two-factor through a passkey keeps the
		// recovery codes they saved then; everyone else gets their first set.
		const keep = hasSecondFactor(user) && (await s.countRecoveryCodes(user.id)) > 0;
		const minted = keep ? null : await mintRecoveryCodes(user.id);
		await s.enableTotp(user.id, step, minted?.hashes ?? null);
		// A code from the app was just entered: a second-factor proof (see `factorChangeGuard`).
		if (c.var.authSessionHash) await s.markSessionAuthenticated(c.var.authSessionHash, now(), { secondFactor: true });
		await authAudit(c, "auth.2fa_enable");
		notifySecurityEvent(c, user.email, { kind: "totp_added" }, now());
		return c.json({ recoveryCodes: minted?.codes ?? [], recoveryCodesKept: keep });
	});

	routes.post("/2fa/disable", requireSession, async (c) => {
		const body = await parseBody(c, schemas.disable2fa);
		if (!body.ok) return body.res;
		const s = store(c);
		const user = c.var.authUser!;
		const wrong = await checkPasswordCounted(c, s, user, body.data.password, now());
		if (wrong) return wrong;
		const blocked = await lastFactorGuard(c, s, user, "totp");
		if (blocked) return blocked;
		const result = await verifySecondFactor(c.env, s, user, body.data.code, now());
		const problem = secondFactorProblem(result);
		if (problem) return c.json(problem, 400);
		if (result === "invalid") return c.json({ error: "Invalid code", code: "invalid_code" }, 400);
		try {
			await s.disableTotp(user.id, { requireOneLeft: (await s.getSecurityPolicy()).requireMfa });
		} catch (e) {
			if ((e as Error).message === "last_factor") return lastFactorConflict(c);
			throw e;
		}
		// A browser trusted with the app (it may be why the app is going) must
		// not keep skipping the second step. This one just proved a code.
		await s.revokeTrustedBrowsers(user.id, await trustedBrowserHash(c));
		await authAudit(c, "auth.2fa_disable");
		notifySecurityEvent(c, user.email, { kind: "totp_removed" }, now());
		return c.body(null, 204);
	});

	/** A new set replaces every old code, so it needs a recent second factor (`factorChangeGuard`). */
	routes.post("/2fa/recovery-codes", requireSession, async (c) => {
		const body = await parseBody(c, schemas.optionalPassword);
		if (!body.ok) return body.res;
		const s = store(c);
		const user = c.var.authUser!;
		if (body.data.password !== undefined) {
			const wrong = await checkPasswordCounted(c, s, user, body.data.password, now());
			if (wrong) return wrong;
		}
		if (!hasSecondFactor(user)) {
			return c.json({ error: "Two-factor authentication is off", code: "not_enabled" }, 400);
		}
		const blocked = await factorChangeGuard(c, s, user, now());
		if (blocked) return blocked;
		const { codes, hashes } = await mintRecoveryCodes(user.id);
		await s.replaceRecoveryCodes(user.id, hashes);
		await authAudit(c, "auth.recovery_codes");
		notifySecurityEvent(c, user.email, { kind: "recovery_codes_new" }, now());
		return c.json({ recoveryCodes: codes });
	});

	/** What protects this account: the Account & security screen reads it. */
	routes.get("/2fa", requireUser, async (c) => {
		const s = store(c);
		const user = c.var.authUser!;
		const [passkeys, recoveryCodesLeft, legacy] = await Promise.all([
			s.listPasskeys(user.id),
			s.countRecoveryCodes(user.id),
			s.countRecoveryCodes(user.id, { legacyOnly: true }),
		]);
		return c.json({
			enabled: hasSecondFactor(user),
			totpEnabled: user.totpEnabled,
			passkeys: passkeys.length,
			recoveryCodesLeft,
			// Shorter codes from before 80-bit codes: worth replacing.
			recoveryCodesOutdated: legacy > 0,
			totpSuspended: user.totpEnabled && (await s.isTotpSuspended(user.id, now())),
		});
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
		// Tokens are exempt from "require two-factor", so minting one must not be.
		if (
			c.var.authMethod === "session" &&
			(await mustEnrolFirst(c.var.authUser, (c.env.AUTH_STORE as object) ?? c.env, () => store(c).getSecurityPolicy()))
		) {
			return c.json(
				{ error: "Set up two-factor sign-in before creating API tokens.", code: "mfa_enrollment_required" },
				403,
			);
		}
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
	/**
	 * Administration is held behind "require two-factor" too: otherwise an
	 * admin without a second factor, stuck at enrolment for mail, could still
	 * mint reset links, disable people, or switch the policy off.
	 */
	const requireEnrolledAdmin = createMiddleware<MailboxContext>(async (c, next) => {
		if (
			c.var.authMethod === "session" &&
			(await mustEnrolFirst(c.var.authUser, (c.env.AUTH_STORE as object) ?? c.env, () => store(c).getSecurityPolicy()))
		) {
			return c.json(
				{ error: "Set up two-factor sign-in before using administration.", code: "mfa_enrollment_required" },
				403,
			);
		}
		return next();
	});
	routes.use("/admin/*", requireUser, resolvePrincipal, requireAuthAdmin, requireSessionToMutate, requireEnrolledAdmin);

	routes.get("/admin/users", async (c) => {
		const users = await store(c).listUsers();
		const withRoles = await Promise.all(
			users.map(async (user) => ({ ...user, isAdmin: isAdmin(await principalForUser(c.env, user)) })),
		);
		return c.json({ users: withRoles });
	});

	routes.get("/admin/security-policy", async (c) => {
		return c.json(await store(c).getSecurityPolicy());
	});

	/**
	 * Turning two-factor on for everyone needs the admin to have it first:
	 * otherwise the change would put the person making it straight onto the
	 * enrolment screen, mid-click.
	 */
	routes.put("/admin/security-policy", async (c) => {
		const body = await parseBody(c, schemas.securityPolicy);
		if (!body.ok) return body.res;
		const caller = c.var.authUser!;
		if (body.data.requireMfa && !hasSecondFactor(caller)) {
			return c.json(
				{
					error: "Set up two-factor on your own account first (Account & security), then require it for everyone.",
					code: "mfa_required_first",
				},
				400,
			);
		}
		const s = store(c);
		const before = await s.getSecurityPolicy();
		const saved = await s.setSecurityPolicy({ requireMfa: body.data.requireMfa });
		invalidateSecurityPolicy((c.env.AUTH_STORE as object) ?? c.env);
		if (before.requireMfa !== saved.requireMfa) {
			await recordAuditDeferred(c, {
				action: "security.policy",
				actor: caller.email,
				actorRole: "admin",
				mailboxId: null,
				detail: { requireMfa: saved.requireMfa },
			});
		}
		return c.json(saved);
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
		const roles = Object.fromEntries(
			Object.entries(body.data.mailboxRoles ?? {}).map(([k, v]) => [normalizeEmail(k), v] as const),
		);
		const mailboxes =
			body.data.role === "member"
				? [...new Set((body.data.mailboxes ?? []).map(normalizeEmail))].map((id) => ({ id, role: roles[id] ?? ("owner" as const) }))
				: [];
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
		await adminAudit(c, "user.invite", address, {
			role: body.data.role,
			mailboxes: mailboxes.map((m) => `${m.id} (${m.role})`).join(", "),
		});
		return c.json({ invite, url: `${appBaseUrl(c.env, c.req.url)}/invite/${token}` }, 201);
	});

	routes.delete("/admin/invites/:id", async (c) => {
		const ok = await store(c).revokeInvite(c.req.param("id"));
		if (!ok) return c.json({ error: "Invite not found", code: "not_found" }, 404);
		await adminAudit(c, "user.invite_revoke", c.req.param("id"));
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
		const floor = await adminFloor(c, user);
		if (floor) return floor;
		const t = now();
		const token = randomToken(32);
		const expiresAt = t + RESET_LINK_MS;
		await s.createPasswordReset({ userId: user.id, tokenHash: await sha256Hex(token), expiresAt, now: t });
		await adminAudit(c, "user.reset_link", user.email);
		return c.json({ url: `${appBaseUrl(c.env, c.req.url)}/reset/${token}`, expiresAt });
	});

	/**
	 * Remove someone's second factors (authenticator app, passkeys, recovery
	 * codes) and sign them out everywhere, for a person who lost all of them.
	 * They sign in with their password and set two-factor up again (the
	 * enrolment screen asks, when the deployment requires it).
	 *
	 * Same floor as a reset link, and a fresh sign-in: with a reset link this
	 * is a full takeover of the account, so an unattended admin tab is not
	 * enough. The owner resets their own with `/recover`.
	 */
	routes.post("/admin/users/:id/reset-2fa", async (c) => {
		const s = store(c);
		const caller = c.var.authUser!;
		const user = await s.getUser(c.req.param("id"));
		if (!user) return c.json({ error: "User not found", code: "not_found" }, 404);
		if (user.id === caller.id) {
			return c.json(
				{ error: "Manage your own two-factor under Account & security instead", code: "self_protected" },
				400,
			);
		}
		if (user.isOwner && !caller.isOwner) {
			return c.json({ error: "Only the owner can reset the owner's two-factor", code: "owner_protected" }, 403);
		}
		const floor = await adminFloor(c, user);
		if (floor) return floor;
		const at = c.var.authSessionHash ? await s.getSessionAuthenticatedAt(c.var.authSessionHash) : null;
		if (at === null || now() - at >= PASSKEY_REAUTH_MS) {
			return c.json({ error: "Confirm it's you with your password or a passkey first.", code: "reauth_required" }, 403);
		}
		if (!(await s.resetSecondFactors(user.id))) return c.json({ error: "User not found", code: "not_found" }, 404);
		cleanupProviderGrants(c, user.id);
		await adminAudit(c, "user.reset_2fa", user.email);
		notifySecurityEvent(c, user.email, { kind: "two_factor_reset", by: caller.email }, now());
		return c.body(null, 204);
	});

	routes.post("/admin/users/:id/disable", async (c) => {
		const body = await parseBody(c, schemas.setDisabled);
		if (!body.ok) return body.res;
		const s = store(c);
		const target = await guardTarget(c, s);
		if (target instanceof Response) return target;
		const floor = await adminFloor(c, target);
		if (floor) return floor;
		await s.setDisabled(target.id, body.data.disabled);
		if (body.data.disabled) cleanupProviderGrants(c, target.id);
		await adminAudit(c, "user.disable", target.email, { disabled: body.data.disabled });
		return c.body(null, 204);
	});

	routes.delete("/admin/users/:id", async (c) => {
		const s = store(c);
		const target = await guardTarget(c, s);
		if (target instanceof Response) return target;
		const floor = await adminFloor(c, target);
		if (floor) return floor;
		await s.deleteUser(target.id);
		cleanupProviderGrants(c, target.id);
		// Otherwise re-inviting the same address would silently restore the old access.
		await deleteGrant(c.env.BUCKET, "user", target.email);
		await adminAudit(c, "user.delete", target.email);
		return c.body(null, 204);
	});

	return routes;
}

/**
 * Administrators are peers below the owner: one admin taking over or locking
 * out another (a reset link is a takeover) needs the owner. Without this a
 * single compromised admin account could disable every other admin.
 */
/**
 * How long a second factor proved on a session counts for changing the
 * account's factors: 5 minutes, against 15 for other recent-sign-in checks.
 */
export const FACTOR_STEP_UP_MS = 5 * 60 * 1000;

/**
 * Changing how the account signs in (adding or removing a passkey, setting up
 * the authenticator app, new recovery codes) needs proof from a factor it
 * already has. Otherwise someone holding a stolen session, or a session and the
 * password, could add their own passkey or app and keep a way in.
 *
 * - With a second factor: a passkey, an app code or a recovery code proved on
 *   this session in the last 5 minutes, at sign-in or through
 *   `POST /passkeys/reauth`. A password step-up does not count.
 * - Without one yet: any sign-in or re-confirmation, password included, in the
 *   last 15 minutes (the rule for adding a first passkey).
 *
 * Returns the 403 to send, or null. `secondFactor: true` in the body tells the
 * client a password will not do.
 */
export async function factorChangeGuard(
	c: C,
	store: AuthStoreApi,
	user: AuthUser,
	now: number,
): Promise<Response | null> {
	const hash = c.var.authSessionHash;
	if (hasSecondFactor(user)) {
		const at = hash ? await store.getSessionSecondFactorAt(hash) : null;
		if (at !== null && now - at < FACTOR_STEP_UP_MS) return null;
		return c.json(
			{
				error: "Confirm it's you with a passkey or a code first.",
				code: "reauth_required",
				secondFactor: true,
			},
			403,
		);
	}
	const at = hash ? await store.getSessionAuthenticatedAt(hash) : null;
	if (at !== null && now - at < PASSKEY_REAUTH_MS) return null;
	return c.json({ error: "Confirm it's you before changing how you sign in.", code: "reauth_required" }, 403);
}

/**
 * While the deployment requires two-factor, the last second factor cannot be
 * removed: that would drop the account straight onto the enrolment screen, or
 * leave a password that signs in alone. `removing` is what is about to go.
 */
export async function lastFactorGuard(
	c: C,
	store: AuthStoreApi,
	user: AuthUser,
	removing: "totp" | "passkey",
): Promise<Response | null> {
	const passkeys = (await store.listPasskeys(user.id)).length;
	const remaining = removing === "totp" ? passkeys : passkeys - 1 + (user.totpEnabled ? 1 : 0);
	if (remaining > 0) return null;
	if (!(await store.getSecurityPolicy()).requireMfa) return null;
	return lastFactorConflict(c);
}

/**
 * The 409 for removing the last factor under "Require two-factor". The store
 * re-checks inside the transaction that removes (`requireOneLeft`), so two
 * removals racing each other cannot both pass `lastFactorGuard`.
 */
export function lastFactorConflict(c: C): Response {
	return c.json(
		{
			error: "Your organization requires two-factor sign-in. Add another passkey or an authenticator app before removing this one.",
			code: "last_factor",
		},
		409,
	);
}

/**
 * Check the caller's password for a two-factor change, counting a wrong one
 * against the same per-address lock as sign-in, so a stolen session cannot be
 * used to guess the password at leisure.
 */
export async function checkPasswordCounted(
	c: C,
	store: AuthStoreApi,
	user: AuthUser,
	password: string,
	now: number,
): Promise<Response | null> {
	const ip = clientIp(c);
	const lock = await store.getLoginLock(user.email, ip, now);
	if (lock.lockedUntil > now) return lockedResponse(c, lock.lockedUntil, now);
	if (await checkPassword(store, user, password)) return null;
	const failure = await store.recordLoginFailure(user.email, ip, now);
	if (failure.lockedUntil > now) return lockedResponse(c, failure.lockedUntil, now);
	return c.json({ error: "Password is incorrect", code: "wrong_password" }, 400);
}

async function adminFloor(c: C, target: AuthUser): Promise<Response | null> {
	if (c.var.authUser?.isOwner) return null;
	if (!isAdmin(await principalForUser(c.env, target))) return null;
	return c.json(
		{ error: "Only the owner can do this to another administrator", code: "admin_protected" },
		403,
	);
}

/** An administrator's action on someone else's account, in the deployment log. */
function adminAudit(
	c: C,
	action: "user.invite" | "user.invite_revoke" | "user.reset_link" | "user.reset_2fa" | "user.disable" | "user.delete",
	target: string,
	detail: Record<string, string | number | boolean | null> = {},
): Promise<void> {
	return recordAuditDeferred(c, {
		action,
		actor: c.var.authUser?.email ?? null,
		actorRole: "admin",
		mailboxId: null,
		target,
		...(Object.keys(detail).length ? { detail } : {}),
	});
}

/**
 * The same body for every lock — a real account, an unknown address, or the
 * second factor — so the response itself never says which one it was.
 */
/**
 * After a wrong second factor following a correct password: email the account
 * holder when the run of failures reaches the lock (5) and when app codes
 * switch off (100). Someone knows the password. Once per threshold, not per guess.
 *
 * `failures` must be the count `recordMfaFailure` returned, which it read in
 * the same transaction as its increment. Reading the counter again afterwards
 * would let two parallel wrong guesses both see 6 and skip the notice at 5.
 */
export function noteSecondStepFailure(c: C, user: AuthUser, failures: number, now: number): void {
	if (failures !== LOCKOUT_THRESHOLD && failures !== MFA_TOTP_DISABLE_AFTER) return;
	notifySecurityEvent(
		c,
		user.email,
		{ kind: "second_step_failing", failures, appCodesOff: failures === MFA_TOTP_DISABLE_AFTER && user.totpEnabled },
		now,
	);
}

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
