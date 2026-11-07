// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared types for built-in email + password authentication.
 *
 * Authentication only answers "who is this". What they may reach is still
 * decided by the grant model in `workers/lib/authz.ts`: a signed-in user becomes
 * an `AccessIdentity` of kind `"user"` whose id is their email, exactly the shape
 * a Cloudflare Access token used to produce.
 *
 * All timestamps are milliseconds since the epoch.
 */

import type { TokenScope } from "../../shared/token-scopes";

/** How this deployment authenticates callers. See `workers/auth/config.ts`. */
export type AuthMode = "password" | "access";

/** Role carried by an invite. Applied as an R2 grant when it is accepted. */
export type InviteRole = "admin" | "member";

export interface AuthUser {
	/** `usr_` + random id. Stable; the email can change, this cannot. */
	id: string;
	/** Normalized (trimmed, lower-cased). Unique. */
	email: string;
	name: string;
	/**
	 * The account created by first-run setup. Always an administrator, and cannot
	 * be disabled or deleted — the floor that a bad grant write cannot revoke,
	 * playing the role `ADMIN_EMAILS` plays for Access deployments.
	 */
	isOwner: boolean;
	disabled: boolean;
	totpEnabled: boolean;
	createdAt: number;
	lastLoginAt: number | null;
	passwordChangedAt: number | null;
}

export interface SessionInfo {
	/** Random public id, safe to show and to revoke by. Never the token. */
	id: string;
	userId: string;
	createdAt: number;
	lastSeenAt: number;
	/** The earlier of the idle and absolute deadlines. */
	expiresAt: number;
	ip: string | null;
	userAgent: string | null;
}

export interface ApiTokenInfo {
	/** Public id, the middle segment of `ttk_<id>_<secret>`. */
	id: string;
	userId: string;
	name: string;
	createdAt: number;
	lastUsedAt: number | null;
	/** `cf-connecting-ip` of the most recent use, or null if never used (or used before this was tracked). */
	lastUsedIp: string | null;
	/** null = never expires. */
	expiresAt: number | null;
	/**
	 * Scopes the token is limited to (see `shared/token-scopes.ts`), or null for
	 * a token that acts with its user's full authority — every token minted
	 * before scopes existed.
	 */
	scopes: TokenScope[] | null;
	/** Mailboxes the token is limited to, or null for every mailbox its user can reach. */
	mailboxes: string[] | null;
	/** The token that created this one, when a token minted it. */
	parentId: string | null;
}

/** An MCP client a user approved on the OAuth consent page ("Connected apps"). */
export interface OAuthGrantInfo {
	/** `ogr_` + random id; also carried in the OAuth grant's encrypted props. */
	id: string;
	userId: string;
	/** The OAuth client_id (from dynamic registration). */
	clientId: string;
	/** Self-asserted by the client at registration: shown, never trusted. */
	clientName: string;
	/** Where the approval sent the tokens. */
	redirectHost: string;
	createdAt: number;
	lastUsedAt: number | null;
	/**
	 * The user trusts this app to send without approval on mailboxes set to
	 * `auto` (the OAuth counterpart of the `mail:send:auto` scope).
	 */
	sendAuto: boolean;
}

export interface InviteInfo {
	/** Public id for listing and revoking. Never the token. */
	id: string;
	email: string;
	role: InviteRole;
	/** Mailbox addresses granted on acceptance (members only). */
	mailboxes: string[];
	createdBy: string | null;
	createdAt: number;
	expiresAt: number;
}

/** What a WebAuthn challenge was issued for. A challenge only works for its purpose. */
export type WebAuthnPurpose = "register" | "authenticate";

/** A registered passkey as the account owner may see it. */
export interface PasskeyInfo {
	/** `pk_` + random id. Public; not the WebAuthn credential id. */
	id: string;
	userId: string;
	name: string;
	createdAt: number;
	lastUsedAt: number | null;
	/** "multiDevice" = synced (iCloud Keychain, Google Password Manager...). */
	deviceType: "singleDevice" | "multiDevice";
	backedUp: boolean;
	transports: string[];
	/** Authenticator model id; all zeros when the authenticator withholds it. */
	aaguid: string;
}

/** A passkey with the material needed to verify an assertion. Never sent to the browser. */
export interface PasskeyCredential extends PasskeyInfo {
	/** base64url WebAuthn credential id. */
	credentialId: string;
	/** base64url COSE public key. */
	publicKey: string;
	counter: number;
}

export interface LoginCandidate {
	user: AuthUser;
	passwordHash: string;
}

/** A lock deadline in ms; 0 when not locked (including one already expired). */
export interface LockState {
	lockedUntil: number;
}

export interface TotpState {
	/** Encrypted secret (see `encryptSecret`), pending or active. */
	secretEnc: string | null;
	enabled: boolean;
	lastStep: number | null;
}

export type CreateOwnerResult =
	| { ok: true; user: AuthUser }
	| { ok: false; reason: "already_setup" };

/**
 * Outcome of a self-service reset request. The reasons exist for logs and
 * tests only; the HTTP response is identical for all of them.
 */
export type IssueEmailResetResult =
	| { ok: true; user: AuthUser }
	| { ok: false; reason: "unknown" | "disabled" | "capped" };

export type AcceptInviteResult =
	| { ok: true; user: AuthUser; invite: InviteInfo }
	| { ok: false; reason: "invalid" | "email_taken" };

/**
 * The RPC surface of the global `AuthDO` (one instance, `idFromName("global")`).
 *
 * The Durable Object stores; it never hashes passwords. scrypt runs in the
 * stateless Worker so one slow hash cannot serialize every login behind the
 * single-threaded object. Everything that must be atomic — "only if no users
 * exist", single-use tokens, lockout counters, TOTP replay — happens here.
 *
 * Secrets arrive already hashed (`sha256Hex`), so the store never holds a usable
 * session, invite, reset or API token.
 */
export interface AuthStoreApi {
	// -- setup ---------------------------------------------------------------
	/** Whether first-run setup is still open (no users exist). */
	isSetupRequired(): Promise<boolean>;
	/**
	 * Return the persisted generated setup token, creating it on first call.
	 * Used only when no `SETUP_TOKEN` secret is configured.
	 */
	ensureGeneratedSetupToken(): Promise<string>;
	/** Atomic: succeeds only while no user exists. */
	createOwner(input: {
		email: string;
		name: string;
		passwordHash: string;
		now: number;
	}): Promise<CreateOwnerResult>;
	/**
	 * Break-glass: reset the owner's password, disable their 2FA, revoke
	 * sessions, and clear the owner's sign-in locks and the recovery counter.
	 */
	recoverOwner(input: { passwordHash: string; now: number }): Promise<{ email: string } | null>;
	/** Whether `/recover` is closed after too many wrong setup tokens (global). */
	getRecoveryLock(now: number): Promise<LockState>;
	/**
	 * Count a wrong setup token at `/recover`, globally across all callers. After
	 * 10 within an hour, `/recover` is closed for an hour.
	 */
	recordRecoveryFailure(now: number): Promise<LockState & { failures: number }>;

	// -- login ---------------------------------------------------------------
	getLoginCandidate(email: string): Promise<LoginCandidate | null>;
	/**
	 * The password lock for `(email, ip)`. Keyed by the address string, not an
	 * account, so an unknown email locks exactly like a real one.
	 */
	getLoginLock(email: string, ip: string, now: number): Promise<LockState>;
	/**
	 * Count a wrong password (or unknown email) for `(email, ip)`; locks that
	 * pair with exponential backoff after 5 (30s doubling, 15 min max).
	 * `accountAlert` is true once per hour when the address passes 100 failures
	 * across all IPs: a signal to log, never a lock, so a distributed attacker
	 * cannot lock the real user out.
	 */
	recordLoginFailure(
		email: string,
		ip: string,
		now: number,
	): Promise<LockState & { accountAlert: boolean }>;
	/**
	 * A completed sign-in from `ip`: clears that pair's password failures and
	 * the account's second-factor failures, and stamps `lastLoginAt`.
	 */
	recordLoginSuccess(userId: string, ip: string, now: number): Promise<void>;

	// -- sessions ------------------------------------------------------------
	createSession(input: {
		userId: string;
		tokenHash: string;
		ip: string | null;
		userAgent: string | null;
		now: number;
	}): Promise<SessionInfo>;
	/**
	 * Null when unknown, expired (idle 14 days / absolute 30 days) or the user is
	 * disabled. Slides the idle deadline at most once an hour.
	 */
	validateSession(
		tokenHash: string,
		now: number,
	): Promise<{ user: AuthUser; session: SessionInfo; epoch?: number } | null>;
	deleteSession(tokenHash: string): Promise<void>;
	listSessions(userId: string, now: number): Promise<SessionInfo[]>;
	revokeSession(userId: string, sessionId: string): Promise<boolean>;
	/** Revoke every session of the user except the one with `keepTokenHash`. */
	revokeOtherSessions(userId: string, keepTokenHash: string | null): Promise<number>;

	// -- second factor -------------------------------------------------------
	/** 5-minute challenge issued after a correct password when TOTP is on. */
	createMfaChallenge(input: { userId: string; challengeHash: string; now: number }): Promise<void>;
	/** Counts an attempt. Null once expired or after 5 attempts. */
	useMfaChallenge(challengeHash: string, now: number): Promise<{ userId: string } | null>;
	deleteMfaChallenge(challengeHash: string): Promise<void>;
	/** The account's second-factor lock, which applies across challenges. */
	getMfaLock(userId: string, now: number): Promise<LockState>;
	/**
	 * Count a wrong second factor against the account, whichever challenge it
	 * came through; locks with the password backoff after 5 total. Reset by a
	 * successful second factor (`recordLoginSuccess`) or by disabling 2FA.
	 * Lives in the store, not the rate limiter, so it holds without that binding.
	 */
	recordMfaFailure(userId: string, now: number): Promise<LockState>;
	getTotp(userId: string): Promise<TotpState>;
	setPendingTotp(userId: string, secretEnc: string): Promise<void>;
	enableTotp(userId: string, step: number, recoveryCodeHashes: string[]): Promise<void>;
	disableTotp(userId: string): Promise<void>;
	/** False when `step` is not newer than the last accepted step (replay). */
	recordTotpStep(userId: string, step: number): Promise<boolean>;
	replaceRecoveryCodes(userId: string, hashes: string[]): Promise<void>;
	/** Single-use. */
	consumeRecoveryCode(userId: string, hash: string): Promise<boolean>;
	countRecoveryCodes(userId: string): Promise<number>;

	// -- account -------------------------------------------------------------
	getUser(userId: string): Promise<AuthUser | null>;
	getUserByEmail(email: string): Promise<AuthUser | null>;
	listUsers(): Promise<AuthUser[]>;
	updatePassword(userId: string, passwordHash: string, now: number): Promise<void>;
	updateProfile(userId: string, patch: { name?: string }): Promise<AuthUser | null>;
	/** Disabling also revokes every session and API token. Refuses the owner. */
	setDisabled(userId: string, disabled: boolean): Promise<boolean>;
	/** Cascades. Refuses the owner. */
	deleteUser(userId: string): Promise<boolean>;

	// -- invites -------------------------------------------------------------
	createInvite(input: {
		tokenHash: string;
		email: string;
		role: InviteRole;
		mailboxes: string[];
		createdBy: string | null;
		expiresAt: number;
		now: number;
	}): Promise<InviteInfo>;
	getInvite(tokenHash: string, now: number): Promise<InviteInfo | null>;
	listInvites(now: number): Promise<InviteInfo[]>;
	revokeInvite(inviteId: string): Promise<boolean>;
	/** Atomic: validates, creates the user, marks the invite used. */
	acceptInvite(input: {
		tokenHash: string;
		name: string;
		passwordHash: string;
		now: number;
	}): Promise<AcceptInviteResult>;

	// -- password reset links (admin-issued, or emailed on request) -----------
	/** Invalidates any earlier unused link for the same user. */
	createPasswordReset(input: {
		userId: string;
		tokenHash: string;
		expiresAt: number;
		now: number;
	}): Promise<void>;
	/**
	 * Self-service ("forgot password"): issue a link for the account with this
	 * email if it exists, is enabled and has had fewer than three such links in
	 * the past hour. Invalidates earlier links like `createPasswordReset`.
	 */
	issueEmailPasswordReset(input: {
		email: string;
		tokenHash: string;
		expiresAt: number;
		now: number;
	}): Promise<IssueEmailResetResult>;
	getPasswordReset(tokenHash: string, now: number): Promise<{ userId: string; email: string } | null>;
	/** Single-use: sets the password and revokes every session. */
	consumePasswordReset(input: {
		tokenHash: string;
		passwordHash: string;
		now: number;
	}): Promise<{ userId: string } | null>;

	// -- API tokens ----------------------------------------------------------
	createApiToken(input: {
		id: string;
		userId: string;
		name: string;
		secretHash: string;
		expiresAt: number | null;
		now: number;
		/** Omitted or null = unrestricted. Unknown scopes are dropped. */
		scopes?: string[] | null;
		/** Omitted or null = every mailbox the user can reach. */
		mailboxes?: string[] | null;
		parentId?: string | null;
	}): Promise<ApiTokenInfo>;
	listApiTokens(userId: string): Promise<ApiTokenInfo[]>;
	/** Also revokes every token this one (transitively) minted. */
	revokeApiToken(userId: string, tokenId: string): Promise<boolean>;
	/**
	 * Null when unknown, revoked, expired, hash mismatch (constant-time) or the
	 * user is disabled. Touches `lastUsedAt` / `lastUsedIp` at most once an hour,
	 * or sooner when the IP changes.
	 */
	validateApiToken(
		tokenId: string,
		secretHash: string,
		now: number,
		ip?: string | null,
	): Promise<{ user: AuthUser; token: ApiTokenInfo; epoch?: number } | null>;

	// -- MCP OAuth grants ----------------------------------------------------
	/** Record a consent-page approval; replaces the user's earlier grant to the same client. */
	createOAuthGrant(input: {
		userId: string;
		clientId: string;
		clientName: string;
		redirectHost: string;
		now: number;
	}): Promise<OAuthGrantInfo>;
	/**
	 * Null when the grant was revoked (by the user, or by disable / delete /
	 * reset / "sign out everywhere") or the user is gone or disabled.
	 */
	validateOAuthGrant(
		grantId: string,
		userId: string,
		now: number,
	): Promise<{ user: AuthUser; grant: OAuthGrantInfo; epoch?: number } | null>;
	listOAuthGrants(userId: string): Promise<OAuthGrantInfo[]>;
	revokeOAuthGrant(userId: string, grantId: string): Promise<boolean>;
	setOAuthGrantSendAuto(userId: string, grantId: string, sendAuto: boolean): Promise<OAuthGrantInfo | null>;

	// -- passkeys (WebAuthn) -------------------------------------------------
	/**
	 * Store a 5-minute ceremony challenge (by hash), bound to its purpose and,
	 * for registration or a second factor, to the user. False when too many
	 * are outstanding globally.
	 */
	createWebAuthnChallenge(input: {
		challengeHash: string;
		purpose: WebAuthnPurpose;
		userId: string | null;
		now: number;
	}): Promise<boolean>;
	/** Single-use: deleted on any lookup. True only if live and purpose and user match. */
	consumeWebAuthnChallenge(
		challengeHash: string,
		purpose: WebAuthnPurpose,
		userId: string | null,
		now: number,
	): Promise<boolean>;
	/** Throws `passkey_exists` / `passkey_limit`. */
	addPasskey(input: {
		userId: string;
		credentialId: string;
		publicKey: string;
		counter: number;
		transports: string[];
		aaguid: string;
		deviceType: "singleDevice" | "multiDevice";
		backedUp: boolean;
		name: string;
		now: number;
	}): Promise<PasskeyInfo>;
	listPasskeys(userId: string): Promise<PasskeyInfo[]>;
	listPasskeyCredentials(userId: string): Promise<PasskeyCredential[]>;
	getPasskeyByCredentialId(
		credentialId: string,
	): Promise<{ passkey: PasskeyCredential; user: AuthUser } | null>;
	/** Compare-and-set on the signature counter; false on a regression. */
	recordPasskeyUse(input: {
		credentialId: string;
		newCounter: number;
		backedUp: boolean;
		now: number;
	}): Promise<boolean>;
	renamePasskey(userId: string, passkeyId: string, name: string): Promise<PasskeyInfo | null>;
	deletePasskey(userId: string, passkeyId: string): Promise<boolean>;
	/** When the session last proved its user (sign-in or step-up). */
	getSessionAuthenticatedAt(tokenHash: string): Promise<number | null>;
	markSessionAuthenticated(tokenHash: string, now: number): Promise<boolean>;

	// -- metadata ------------------------------------------------------------
	/** Returns the stored value, or stores and returns `fallback` if absent. */
	getOrInitMeta(key: string, fallback: string): Promise<string>;

	// -- credential cache ----------------------------------------------------
	/**
	 * The auth epoch: a counter every credential-ending or user-changing write
	 * advances. Validations also return it (`epoch`), read with the rows they
	 * checked. See `workers/auth/session-cache.ts`. Optional so simple fakes
	 * need not implement it; without it nothing is cached.
	 */
	getAuthEpoch?(): Promise<number>;
}

// -- suppressions -------------------------------------------------------------

/** One suppression-list row as stored. `scope` is `"global"` or a domain. */
export interface SuppressionRecord {
	id: string;
	address: string;
	scope: string;
	reason: string;
	source: string;
	/** Epoch milliseconds. */
	created_at: number;
}

export interface SuppressionEntryInput {
	address: string;
	scope: string;
	reason: string;
	source: string;
}

export interface SuppressionListOptions {
	query?: string;
	scope?: string;
	reason?: string;
	limit?: number;
	offset?: number;
}

export interface SuppressionPage {
	items: SuppressionRecord[];
	total: number;
	limit: number;
	offset: number;
}

/**
 * The suppression list's RPC surface on `AuthDO`. Kept apart from
 * `AuthStoreApi` because it is not authentication; it only shares the global
 * object because that is the deployment's one global SQLite store.
 */
export interface SuppressionStoreApi {
	listSuppressions(options?: SuppressionListOptions): Promise<SuppressionPage>;
	addSuppressions(
		entries: SuppressionEntryInput[],
		now: number,
	): Promise<{ added: number; existing: number; items: SuppressionRecord[] }>;
	deleteSuppression(id: string): Promise<boolean>;
	findSuppressions(addresses: string[], domain?: string | null): Promise<SuppressionRecord[]>;
	/** Raise an existing entry's reason (unsubscribed → complaint). Optional for fakes. */
	escalateSuppression?(entry: SuppressionEntryInput): Promise<boolean>;
}

// -- privacy ------------------------------------------------------------------

/** One account-export job. `state` is the builder's resumable cursor (JSON). */
export interface ExportJobRecord {
	id: string;
	userId: string;
	status: "pending" | "running" | "ready" | "failed";
	objectKey: string | null;
	size: number | null;
	error: string | null;
	state: string | null;
	createdAt: number;
	completedAt: number | null;
	expiresAt: number;
}

/**
 * The privacy surface on `AuthDO`: recipient tracking opt-outs, self-service
 * account deletion and account exports. See `workers/lib/account-privacy.ts`.
 */
export interface PrivacyStoreApi {
	addTrackingOptOut(input: { address: string; scope: string; source: string; now: number }): Promise<boolean>;
	findTrackingOptOuts(addresses: string[], domain?: string | null): Promise<{ address: string; scope: string }[]>;
	scheduleAccountDeletion(input: {
		userId: string;
		now: number;
		graceMs: number;
		mailboxes: string[];
	}): Promise<
		| { ok: true; requestedAt: number; purgeAfter: number }
		| { ok: false; reason: "not_found" | "sole_owner" }
	>;
	getAccountDeletion(userId: string): Promise<{ requestedAt: number; purgeAfter: number } | null>;
	cancelAccountDeletion(userId: string): Promise<boolean>;
	listDueAccountDeletions(
		now: number,
		limit?: number,
	): Promise<{ userId: string; email: string; mailboxes: string[]; purgeAfter: number }[]>;
	completeAccountDeletion(userId: string, now: number): Promise<boolean>;
	createExportJob(input: { id: string; userId: string; now: number; expiresAt: number; state: string }): Promise<ExportJobRecord>;
	getExportJob(id: string): Promise<ExportJobRecord | null>;
	listExportJobs(userId: string): Promise<ExportJobRecord[]>;
	listActiveExportJobs(limit?: number): Promise<ExportJobRecord[]>;
	updateExportJob(
		id: string,
		patch: {
			status?: ExportJobRecord["status"];
			state?: string;
			objectKey?: string;
			error?: string | null;
			size?: number;
			completedAt?: number;
			expiresAt?: number;
		},
	): Promise<ExportJobRecord | null>;
	takeExpiredExportJobs(now: number, limit?: number): Promise<ExportJobRecord[]>;
}
