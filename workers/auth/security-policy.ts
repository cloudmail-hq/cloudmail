/**
 * "Require two-factor for everyone" (Settings → Security policy).
 *
 * Checked on every signed-in browser request, so the policy is cached per
 * isolate for {@link POLICY_CACHE_MS}; turning it on reaches every isolate
 * within that. The user's own second factor comes from the session's cached
 * user (`totpEnabled`, `hasPasskey`), which enrolling invalidates at once.
 *
 * Enforced on browser sessions, where a person signs in. API tokens and
 * connected apps were created by someone already signed in, and a token
 * holder cannot enrol anything, so blocking them would only break scripts.
 * Someone without a second factor reaches the account-security endpoints
 * (`/api/auth/*`) and the few reads the app shell needs to show the
 * enrolment screen; everything else answers 403 `mfa_enrollment_required`.
 */

import type { AuthUser, SecurityPolicy } from "./types";

export const POLICY_CACHE_MS = 30_000;

export const MFA_ENROLLMENT_REQUIRED_CODE = "mfa_enrollment_required";

const cache = new WeakMap<object, { policy: SecurityPolicy; at: number }>();

export async function cachedSecurityPolicy(
	key: object,
	load: () => Promise<SecurityPolicy>,
	now = Date.now(),
): Promise<SecurityPolicy> {
	const hit = cache.get(key);
	if (hit && now - hit.at < POLICY_CACHE_MS) return hit.policy;
	try {
		const policy = await load();
		cache.set(key, { policy, at: now });
		return policy;
	} catch (e) {
		// Fail open on a read error only with a policy we have seen; with none,
		// the safe default is the one every deployment starts with (off).
		console.error("security policy read failed:", (e as Error).message);
		return hit?.policy ?? { requireMfa: false };
	}
}

export function invalidateSecurityPolicy(key: object): void {
	cache.delete(key);
}

/** Whether this user has a second factor of any kind. */
export function hasSecondFactor(user: Pick<AuthUser, "totpEnabled" | "hasPasskey">): boolean {
	return user.totpEnabled || user.hasPasskey === true;
}

/** Reads the app shell makes while showing the enrolment screen. */
const ALLOWED_WHILE_ENROLLING = new Set([
	"/api/v1/me",
	"/api/v1/config",
	"/api/v1/branding",
	"/api/v1/preferences",
]);

/**
 * Whether this signed-in person must enrol before doing anything else. Also
 * used by the two `/api/auth/*` routes that mint a credential (API tokens and
 * the MCP OAuth consent): tokens are exempt from the policy, so minting one
 * would otherwise be a way around it.
 */
export async function mustEnrolFirst(
	user: Pick<AuthUser, "totpEnabled" | "hasPasskey"> | undefined | null,
	key: object,
	load: () => Promise<SecurityPolicy>,
): Promise<boolean> {
	if (!user || hasSecondFactor(user)) return false;
	return (await cachedSecurityPolicy(key, load)).requireMfa;
}

export function allowedWhileEnrolling(method: string, pathname: string): boolean {
	if (pathname.startsWith("/api/auth/")) return true;
	return (method === "GET" || method === "HEAD") && ALLOWED_WHILE_ENROLLING.has(pathname);
}
