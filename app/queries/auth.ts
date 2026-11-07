// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Hooks over the built-in auth endpoints.
 *
 * Account hooks are available to every signed-in user in password mode. The
 * admin hooks stay idle until the caller is known to be an administrator, the
 * same courtesy `useAccess` extends: the Worker refuses a member regardless.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import authApi, {
	type AdminUser,
	type ApiTokenInfo,
	type AuthState,
	type InviteInfo,
	type InviteRole,
	type OAuthGrantInfo,
	type PasskeyInfo,
	type SessionInfo,
} from "~/services/auth-api";
import { createPasskey, getPasskey } from "~/lib/passkeys";
import { queryKeys } from "./keys";
import { useCurrentUser } from "./people";
import { clearServiceWorkerCaches } from "~/lib/service-worker";

export function useAuthState() {
	return useQuery<AuthState>({
		queryKey: queryKeys.auth.state,
		queryFn: ({ signal }) => authApi.getState({ signal }),
		staleTime: 60_000,
	});
}

// ------------------------------------------------------------------ profile

export function useUpdateProfile() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (name: string) => authApi.updateProfile({ name }),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.currentUser });
			qc.invalidateQueries({ queryKey: queryKeys.auth.state });
		},
	});
}

export function useChangePassword() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: { currentPassword: string; newPassword: string }) =>
			authApi.changePassword(input),
		// Changing the password revokes every other session.
		onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.auth.sessions }),
	});
}

// ----------------------------------------------------------------- sessions

export function useSessions(options?: { enabled?: boolean }) {
	return useQuery<SessionInfo[]>({
		queryKey: queryKeys.auth.sessions,
		queryFn: async ({ signal }) => (await authApi.listSessions({ signal })).sessions,
		enabled: options?.enabled ?? true,
		staleTime: 0,
	});
}

export function useRevokeSession() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => authApi.revokeSession(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.auth.sessions }),
	});
}

export function useRevokeOtherSessions() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => authApi.revokeOtherSessions(),
		// Signing out everywhere else also disconnects every OAuth app.
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.auth.sessions });
			qc.invalidateQueries({ queryKey: queryKeys.auth.oauthGrants });
		},
	});
}

// --------------------------------------------------------------------- 2FA

/** Every 2FA change moves `totpEnabled` on `/me` and on the auth state. */
function useTotpInvalidation() {
	const qc = useQueryClient();
	return () => {
		qc.invalidateQueries({ queryKey: queryKeys.currentUser });
		qc.invalidateQueries({ queryKey: queryKeys.auth.state });
		qc.invalidateQueries({ queryKey: queryKeys.auth.users });
	};
}

export function useSetupTotp() {
	return useMutation({
		mutationFn: (password: string) => authApi.setupTotp({ password }),
	});
}

export function useEnableTotp() {
	const invalidate = useTotpInvalidation();
	return useMutation({
		mutationFn: (code: string) => authApi.enableTotp({ code }),
		onSuccess: invalidate,
	});
}

export function useDisableTotp() {
	const invalidate = useTotpInvalidation();
	return useMutation({
		mutationFn: (input: { password: string; code: string }) => authApi.disableTotp(input),
		onSuccess: invalidate,
	});
}

export function useRegenerateRecoveryCodes() {
	return useMutation({
		mutationFn: (password: string) => authApi.regenerateRecoveryCodes({ password }),
	});
}

// --------------------------------------------------------------- API tokens

export function useApiTokens(options?: { enabled?: boolean }) {
	return useQuery<ApiTokenInfo[]>({
		queryKey: queryKeys.auth.tokens,
		queryFn: async ({ signal }) => (await authApi.listTokens({ signal })).tokens,
		enabled: options?.enabled ?? true,
	});
}

export function useCreateApiToken() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: Parameters<typeof authApi.createToken>[0]) => authApi.createToken(input),
		onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.auth.tokens }),
	});
}

export function useRevokeApiToken() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => authApi.revokeToken(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.auth.tokens }),
	});
}

// ------------------------------------------------------- connected apps

export function useOAuthGrants(options?: { enabled?: boolean }) {
	return useQuery<OAuthGrantInfo[]>({
		queryKey: queryKeys.auth.oauthGrants,
		queryFn: async ({ signal }) => (await authApi.listOAuthGrants({ signal })).grants,
		enabled: options?.enabled ?? true,
	});
}

export function useRevokeOAuthGrant() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => authApi.revokeOAuthGrant(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.auth.oauthGrants }),
	});
}

export function useSetOAuthGrantSendAuto() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, sendAuto }: { id: string; sendAuto: boolean }) => authApi.setOAuthGrantSendAuto(id, sendAuto),
		onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.auth.oauthGrants }),
	});
}

// ----------------------------------------------------------------- passkeys

export function usePasskeys(options?: { enabled?: boolean }) {
	return useQuery<PasskeyInfo[]>({
		queryKey: queryKeys.auth.passkeys,
		queryFn: async ({ signal }) => (await authApi.listPasskeys({ signal })).passkeys,
		enabled: options?.enabled ?? true,
	});
}

/**
 * Add a passkey: options from the Worker, the browser's ceremony, then
 * verification. The caller handles `reauth_required` by re-confirming and
 * retrying.
 */
export function useRegisterPasskey() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (name?: string) => {
			const { options } = await authApi.passkeyRegisterOptions();
			const response = await createPasskey(options);
			return authApi.passkeyRegisterVerify({ response, ...(name ? { name } : {}) });
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.auth.passkeys }),
	});
}

export function useReauth() {
	return useMutation({
		mutationFn: async (input: { password: string } | { code: string } | { passkey: true }) => {
			if ("passkey" in input) {
				const { options } = await authApi.passkeyReauthOptions();
				return authApi.passkeyReauth({ response: await getPasskey(options) });
			}
			return authApi.passkeyReauth(input);
		},
	});
}

export function useRenamePasskey() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, name }: { id: string; name: string }) => authApi.renamePasskey(id, name),
		onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.auth.passkeys }),
	});
}

export function useDeletePasskey() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => authApi.deletePasskey(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.auth.passkeys }),
	});
}

// -------------------------------------------------------------------- admin

export function useAdminUsers(options?: { enabled?: boolean }) {
	return useQuery<AdminUser[]>({
		queryKey: queryKeys.auth.users,
		queryFn: async ({ signal }) => (await authApi.listUsers({ signal })).users,
		enabled: options?.enabled ?? true,
	});
}

export function useAdminInvites(options?: { enabled?: boolean }) {
	return useQuery<InviteInfo[]>({
		queryKey: queryKeys.auth.invites,
		queryFn: async ({ signal }) => (await authApi.listInvites({ signal })).invites,
		enabled: options?.enabled ?? true,
	});
}

/** User and invite changes also move grants, so the Access panel refreshes too. */
function useAdminInvalidation() {
	const qc = useQueryClient();
	return () => {
		qc.invalidateQueries({ queryKey: queryKeys.auth.users });
		qc.invalidateQueries({ queryKey: queryKeys.auth.invites });
		qc.invalidateQueries({ queryKey: queryKeys.accessGrants });
		qc.invalidateQueries({ queryKey: queryKeys.accessAudit });
	};
}

export function useCreateInvite() {
	const invalidate = useAdminInvalidation();
	return useMutation({
		mutationFn: (input: {
			email: string;
			role: InviteRole;
			mailboxes?: string[];
			expiresInDays?: number;
		}) => authApi.createInvite(input),
		onSuccess: invalidate,
	});
}

export function useRevokeInvite() {
	const invalidate = useAdminInvalidation();
	return useMutation({
		mutationFn: (id: string) => authApi.revokeInvite(id),
		onSuccess: invalidate,
	});
}

export function useCreateResetLink() {
	return useMutation({
		mutationFn: (userId: string) => authApi.createResetLink(userId),
	});
}

export function useSetUserDisabled() {
	const invalidate = useAdminInvalidation();
	return useMutation({
		mutationFn: ({ userId, disabled }: { userId: string; disabled: boolean }) =>
			authApi.setUserDisabled(userId, disabled),
		onSuccess: invalidate,
	});
}

export function useDeleteUser() {
	const invalidate = useAdminInvalidation();
	return useMutation({
		mutationFn: (userId: string) => authApi.deleteUser(userId),
		onSuccess: invalidate,
	});
}

// ----------------------------------------------------------------- sign-out

/**
 * The sign-out action for the chrome, or undefined when there is nothing to
 * sign out of (local dev bypass, or the identity has not resolved yet).
 *
 * Password mode ends the session server-side, then does a full navigation so
 * no cached query from the old session survives. Access mode hands off to
 * Cloudflare Access's own logout endpoint, which clears the edge cookie.
 */
export function useSignOut(): (() => void) | undefined {
	const { data: me } = useCurrentUser();
	if (!me || me.authMethod === "dev") return undefined;
	if (me.authMode === "access" || me.authMethod === "access") {
		return () => window.location.assign("/cdn-cgi/access/logout");
	}
	if (me.authMode !== "password") return undefined;
	return () => {
		authApi
			.logout()
			.catch(() => {
				// The cookie may already be gone; signing out should still leave.
			})
			// The offline shell belongs to the session that is ending.
			.then(() => clearServiceWorkerCaches())
			.finally(() => window.location.assign("/login"));
	};
}
