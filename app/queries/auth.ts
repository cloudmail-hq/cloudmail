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
	type TrustedBrowserInfo,
	type TwoFactorStatus,
} from "~/services/auth-api";
import { createPasskey, getPasskey, signalAcceptedPasskeys } from "~/lib/passkeys";
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
		// Changing the password revokes every other session and trusted browser.
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.auth.sessions });
			qc.invalidateQueries({ queryKey: queryKeys.auth.trustedBrowsers });
		},
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
		// Signing a session out also forgets the trusted browser it ran in.
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.auth.sessions });
			qc.invalidateQueries({ queryKey: queryKeys.auth.trustedBrowsers });
		},
	});
}

export function useRevokeOtherSessions() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => authApi.revokeOtherSessions(),
		// Signing out everywhere else also disconnects every OAuth app and
		// forgets every other trusted browser.
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.auth.sessions });
			qc.invalidateQueries({ queryKey: queryKeys.auth.oauthGrants });
			qc.invalidateQueries({ queryKey: queryKeys.auth.trustedBrowsers });
		},
	});
}

// --------------------------------------------------------- trusted browsers

export function useTrustedBrowsers(options?: { enabled?: boolean }) {
	return useQuery<TrustedBrowserInfo[]>({
		queryKey: queryKeys.auth.trustedBrowsers,
		queryFn: async ({ signal }) => (await authApi.listTrustedBrowsers({ signal })).browsers,
		enabled: options?.enabled ?? true,
		staleTime: 0,
	});
}

export function useRevokeTrustedBrowser() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => authApi.revokeTrustedBrowser(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.auth.trustedBrowsers }),
	});
}

export function useRevokeAllTrustedBrowsers() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => authApi.revokeAllTrustedBrowsers(),
		onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.auth.trustedBrowsers }),
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
		qc.invalidateQueries({ queryKey: queryKeys.auth.twoFactor });
		// Removing the last factor forgets every trusted browser.
		qc.invalidateQueries({ queryKey: queryKeys.auth.trustedBrowsers });
	};
}

/**
 * Refresh `/me` and the auth state after a factor change. Called by the panels
 * once fresh recovery codes are dismissed rather than at once: on the
 * "two-factor required" screen, `/me` flipping replaces the screen with the
 * app, and the codes would vanish before anyone saved them.
 */
export function useRefreshAccount() {
	return useTotpInvalidation();
}

/** What protects this account: factors, recovery codes left. */
export function useTwoFactorStatus(options?: { enabled?: boolean }) {
	return useQuery<TwoFactorStatus>({
		queryKey: queryKeys.auth.twoFactor,
		queryFn: ({ signal }) => authApi.getTwoFactor({ signal }),
		enabled: options?.enabled ?? true,
	});
}

export function useSetupTotp() {
	return useMutation({
		/** No password: the account has a passkey and proves it with a step-up instead. */
		mutationFn: (password?: string) => authApi.setupTotp(password === undefined ? {} : { password }),
	});
}

export function useEnableTotp() {
	const qc = useQueryClient();
	const invalidate = useTotpInvalidation();
	return useMutation({
		mutationFn: (code: string) => authApi.enableTotp({ code }),
		// With codes to show, `/me` waits for `useRefreshAccount` (see there).
		onSuccess: (result) => {
			if (result.recoveryCodes.length > 0) qc.invalidateQueries({ queryKey: queryKeys.auth.twoFactor });
			else invalidate();
		},
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
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => authApi.regenerateRecoveryCodes(),
		onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.auth.twoFactor }),
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
		onSuccess: (result) => {
			qc.invalidateQueries({ queryKey: queryKeys.auth.passkeys });
			qc.invalidateQueries({ queryKey: queryKeys.auth.twoFactor });
			// `hasPasskey` on /me decides the two-factor enrolment screen; with
			// recovery codes to show it waits for `useRefreshAccount`.
			if (!result.recoveryCodes?.length) qc.invalidateQueries({ queryKey: queryKeys.currentUser });
		},
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
		mutationFn: async (id: string) => {
			await authApi.deletePasskey(id);
			// Tell the passkey provider which passkeys are left, so the removed one
			// stops being offered at sign-in. Best effort, and never fails the delete.
			try {
				await signalAcceptedPasskeys((await authApi.listPasskeys()).accepted);
			} catch {
				/* the list refetch below shows the result either way */
			}
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.auth.passkeys });
			qc.invalidateQueries({ queryKey: queryKeys.currentUser });
			qc.invalidateQueries({ queryKey: queryKeys.auth.twoFactor });
			// The last factor gone forgets every trusted browser.
			qc.invalidateQueries({ queryKey: queryKeys.auth.trustedBrowsers });
		},
	});
}

// -------------------------------------------------------------------- admin

export function useSecurityPolicy(enabled = true) {
	return useQuery({
		queryKey: ["auth", "security-policy"] as const,
		queryFn: ({ signal }) => authApi.getSecurityPolicy({ signal }),
		enabled,
		staleTime: 30_000,
	});
}

export function useSetSecurityPolicy() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (policy: { requireMfa: boolean }) => authApi.setSecurityPolicy(policy),
		onSuccess: (policy) => qc.setQueryData(["auth", "security-policy"], policy),
	});
}

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

export function useResetTwoFactor() {
	const invalidate = useAdminInvalidation();
	return useMutation({
		mutationFn: (userId: string) => authApi.resetTwoFactor(userId),
		onSuccess: invalidate,
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
