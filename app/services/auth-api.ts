// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Typed client for the built-in auth endpoints (`/api/auth/*`).
 *
 * The shapes mirror `docs/auth-contract.md` and `workers/auth/types.ts`. They are
 * restated here rather than imported so the browser bundle never reaches into
 * Worker modules.
 *
 * These calls go through the shared `request()`, but the global 401 redirect
 * only fires for `/api/v1/*`: a wrong password on `/api/auth/login` is also a
 * 401, and must surface as a form error, not a navigation.
 */

import type { TokenScope } from "../../shared/token-scopes";
import { describeAuthError } from "~/lib/auth-helpers";
import { ApiError, request } from "./api";

/** Human copy for anything an auth call rejected with. */
export function authErrorMessage(error: unknown, fallback: string): string {
	if (error instanceof ApiError) return describeAuthError(error.status, error.body, fallback);
	if (error instanceof DOMException && error.name === "AbortError") {
		return "The request timed out. Try again.";
	}
	if (error instanceof TypeError) return describeAuthError(0, undefined, fallback);
	return fallback;
}

/** The `code` an auth endpoint answered with, if any. */
export function authErrorCode(error: unknown): string | undefined {
	return error instanceof ApiError && typeof error.body.code === "string"
		? error.body.code
		: undefined;
}

export type AuthMode = "password" | "access";
export type InviteRole = "admin" | "member";

export interface PublicUser {
	id: string;
	email: string;
	name: string;
	isOwner: boolean;
	totpEnabled: boolean;
	isAdmin: boolean;
}

export interface AuthState {
	mode: AuthMode;
	setupRequired: boolean;
	authenticated: boolean;
	user: PublicUser | null;
	turnstileSiteKey: string | null;
	setupTokenConfigured: boolean;
	/** Whether `/forgot` can email a reset link (a sender address is configured). */
	passwordResetByEmail: boolean;
}

export interface AuthUser {
	id: string;
	email: string;
	name: string;
	isOwner: boolean;
	disabled: boolean;
	totpEnabled: boolean;
	createdAt: number;
	lastLoginAt: number | null;
	passwordChangedAt: number | null;
}

export interface AdminUser extends AuthUser {
	isAdmin: boolean;
}

export interface SessionInfo {
	id: string;
	userId: string;
	createdAt: number;
	lastSeenAt: number;
	expiresAt: number;
	ip: string | null;
	userAgent: string | null;
	current: boolean;
}

export interface ApiTokenInfo {
	id: string;
	userId: string;
	name: string;
	createdAt: number;
	lastUsedAt: number | null;
	lastUsedIp: string | null;
	expiresAt: number | null;
	/** null = acts with the user's full access (every token from before scopes). */
	scopes: TokenScope[] | null;
	/** null = every mailbox the user can reach. */
	mailboxes: string[] | null;
	parentId: string | null;
}

/** An MCP client the user approved through OAuth ("Connected apps"). */
export interface OAuthGrantInfo {
	id: string;
	userId: string;
	clientId: string;
	clientName: string;
	redirectHost: string;
	createdAt: number;
	lastUsedAt: number | null;
	/** Trusted to send without approval on mailboxes set to send automatically. */
	sendAuto?: boolean;
}

export interface InviteInfo {
	id: string;
	email: string;
	role: InviteRole;
	mailboxes: string[];
	createdBy: string | null;
	createdAt: number;
	expiresAt: number;
}

export type LoginResult =
	| { status: "ok"; user: PublicUser }
	| { status: "mfa_required"; challenge: string; passkeys?: boolean };

export interface PasskeyInfo {
	id: string;
	userId: string;
	name: string;
	createdAt: number;
	lastUsedAt: number | null;
	deviceType: "singleDevice" | "multiDevice";
	backedUp: boolean;
	transports: string[];
	aaguid: string;
}

/**
 * WebAuthn options and responses are passed through as opaque JSON: the
 * browser library (`@simplewebauthn/browser`) owns their shape, and only this
 * module and the Worker touch them.
 */
type WebAuthnJSON = Record<string, unknown>;

/** How to re-confirm before adding a passkey. */
export type ReauthInput = { password: string } | { code: string } | { response: WebAuthnJSON };

export interface CredentialsInput {
	email: string;
	password: string;
	turnstileToken?: string;
}

function json(method: string, body?: unknown, signal?: AbortSignal): RequestInit {
	return {
		method,
		signal,
		body: body === undefined ? undefined : JSON.stringify(body),
	};
}

const enc = encodeURIComponent;

const authApi = {
	// ---------------------------------------------------------------- public
	getState: (opts?: { signal?: AbortSignal }) =>
		request<AuthState>("/api/auth/state", { method: "GET", signal: opts?.signal }),

	setup: (input: {
		setupToken: string;
		email: string;
		name: string;
		password: string;
		turnstileToken?: string;
		/** Whether new mailboxes start with open/click tracking on. */
		trackingDefault?: boolean;
	}) => request<{ status: "ok"; user: PublicUser }>("/api/auth/setup", json("POST", input)),

	login: (input: CredentialsInput) =>
		request<LoginResult>("/api/auth/login", json("POST", input)),

	loginMfa: (input: { challenge: string; code: string }) =>
		request<{ status: "ok"; user: PublicUser }>("/api/auth/login/mfa", json("POST", input)),

	logout: () => request<void>("/api/auth/logout", json("POST")),

	getInvite: (token: string, opts?: { signal?: AbortSignal }) =>
		request<{ email: string; role: InviteRole; expiresAt: number }>(
			`/api/auth/invites/${enc(token)}`,
			{ method: "GET", signal: opts?.signal },
		),

	acceptInvite: (input: {
		token: string;
		name: string;
		password: string;
		turnstileToken?: string;
	}) => request<{ status: "ok"; user: PublicUser }>("/api/auth/invites/accept", json("POST", input)),

	getReset: (token: string, opts?: { signal?: AbortSignal }) =>
		request<{ email: string }>(`/api/auth/reset/${enc(token)}`, {
			method: "GET",
			signal: opts?.signal,
		}),

	resetPassword: (input: { token: string; password: string }) =>
		request<void>("/api/auth/reset", json("POST", input)),

	passkeyLoginOptions: () =>
		request<{ options: WebAuthnJSON }>("/api/auth/passkeys/login/options", json("POST", {})),

	passkeyLoginVerify: (input: { response: WebAuthnJSON }) =>
		request<{ status: "ok"; user: PublicUser }>("/api/auth/passkeys/login/verify", json("POST", input)),

	passkeyMfaOptions: (input: { challenge: string }) =>
		request<{ options: WebAuthnJSON }>("/api/auth/passkeys/mfa/options", json("POST", input)),

	passkeyMfaVerify: (input: { challenge: string; response: WebAuthnJSON }) =>
		request<{ status: "ok"; user: PublicUser }>("/api/auth/passkeys/mfa/verify", json("POST", input)),

	forgotPassword: (input:{ email: string; turnstileToken?: string }) =>
		request<{ status: "accepted"; message: string }>("/api/auth/password/forgot", json("POST", input)),

	recover: (input: { setupToken: string; password: string }) =>
		request<void>("/api/auth/recover", json("POST", input)),

	// --------------------------------------------------------- authenticated
	updateProfile: (input: { name: string }) =>
		request<{ user: PublicUser }>("/api/auth/profile", json("PATCH", input)),

	changePassword: (input: { currentPassword: string; newPassword: string }) =>
		request<void>("/api/auth/password", json("POST", input)),

	listSessions: (opts?: { signal?: AbortSignal }) =>
		request<{ sessions: SessionInfo[] }>("/api/auth/sessions", {
			method: "GET",
			signal: opts?.signal,
		}),

	revokeSession: (id: string) =>
		request<void>(`/api/auth/sessions/${enc(id)}`, json("DELETE")),

	revokeOtherSessions: () =>
		request<{ revoked: number }>("/api/auth/sessions/revoke-others", json("POST")),

	setupTotp: (input: { password: string }) =>
		request<{ secret: string; otpauthUrl: string }>("/api/auth/2fa/setup", json("POST", input)),

	enableTotp: (input: { code: string }) =>
		request<{ recoveryCodes: string[] }>("/api/auth/2fa/enable", json("POST", input)),

	disableTotp: (input: { password: string; code: string }) =>
		request<void>("/api/auth/2fa/disable", json("POST", input)),

	regenerateRecoveryCodes: (input: { password: string }) =>
		request<{ recoveryCodes: string[] }>("/api/auth/2fa/recovery-codes", json("POST", input)),

	listTokens: (opts?: { signal?: AbortSignal }) =>
		request<{ tokens: ApiTokenInfo[] }>("/api/auth/tokens", {
			method: "GET",
			signal: opts?.signal,
		}),

	createToken: (input: {
		name: string;
		expiresInDays?: number | null;
		scopes?: TokenScope[] | null;
		mailboxes?: string[] | null;
	}) =>
		request<{ token: ApiTokenInfo; secret: string }>("/api/auth/tokens", json("POST", input)),

	revokeToken: (id: string) => request<void>(`/api/auth/tokens/${enc(id)}`, json("DELETE")),

	listOAuthGrants: (opts?: { signal?: AbortSignal }) =>
		request<{ grants: OAuthGrantInfo[] }>("/api/auth/oauth-grants", {
			method: "GET",
			signal: opts?.signal,
		}),

	revokeOAuthGrant: (id: string) =>
		request<void>(`/api/auth/oauth-grants/${enc(id)}`, json("DELETE")),
	setOAuthGrantSendAuto: (id: string, sendAuto: boolean) =>
		request<{ grant: OAuthGrantInfo }>(`/api/auth/oauth-grants/${enc(id)}`, json("PATCH", { sendAuto })),

	listPasskeys: (opts?: { signal?: AbortSignal }) =>
		request<{ passkeys: PasskeyInfo[] }>("/api/auth/passkeys", { method: "GET", signal: opts?.signal }),

	passkeyRegisterOptions: () =>
		request<{ options: WebAuthnJSON }>("/api/auth/passkeys/register/options", json("POST", {})),

	passkeyRegisterVerify: (input: { response: WebAuthnJSON; name?: string }) =>
		request<{ passkey: PasskeyInfo }>("/api/auth/passkeys/register/verify", json("POST", input)),

	passkeyReauthOptions: () =>
		request<{ options: WebAuthnJSON }>("/api/auth/passkeys/reauth/options", json("POST", {})),

	passkeyReauth: (input: ReauthInput) =>
		request<{ status: "ok"; validUntil: number }>("/api/auth/passkeys/reauth", json("POST", input)),

	renamePasskey: (id: string, name: string) =>
		request<{ passkey: PasskeyInfo }>(`/api/auth/passkeys/${enc(id)}`, json("PATCH", { name })),

	deletePasskey: (id: string) => request<void>(`/api/auth/passkeys/${enc(id)}`, json("DELETE")),

	// ----------------------------------------------------------------- admin
	listUsers: (opts?: { signal?: AbortSignal }) =>
		request<{ users: AdminUser[] }>("/api/auth/admin/users", {
			method: "GET",
			signal: opts?.signal,
		}),

	listInvites: (opts?: { signal?: AbortSignal }) =>
		request<{ invites: InviteInfo[] }>("/api/auth/admin/invites", {
			method: "GET",
			signal: opts?.signal,
		}),

	createInvite: (input: {
		email: string;
		role: InviteRole;
		mailboxes?: string[];
		expiresInDays?: number;
	}) => request<{ invite: InviteInfo; url: string }>("/api/auth/admin/invites", json("POST", input)),

	revokeInvite: (id: string) =>
		request<void>(`/api/auth/admin/invites/${enc(id)}`, json("DELETE")),

	createResetLink: (userId: string) =>
		request<{ url: string; expiresAt: number }>(
			`/api/auth/admin/users/${enc(userId)}/reset-link`,
			json("POST"),
		),

	setUserDisabled: (userId: string, disabled: boolean) =>
		request<void>(`/api/auth/admin/users/${enc(userId)}/disable`, json("POST", { disabled })),

	deleteUser: (userId: string) =>
		request<void>(`/api/auth/admin/users/${enc(userId)}`, json("DELETE")),
};

export default authApi;
