/**
 * Licence status as the API reports it and the UI shows it. Pure: no
 * storage, no network. The server side is `workers/lib/licence.ts`.
 *
 * Licences are one-time purchases. The token is still short-lived (30 days)
 * and refreshed daily, but `exp` is never tied to a billing period, so there
 * is nothing to "renew": the token stays valid as long as refresh succeeds.
 */

/** Where the app stands. */
export type LicenceStatus =
	/** Enforcement is off (the vendor's own deployment, local dev). */
	| "off"
	/** No licence activated on this deployment. */
	| "none"
	| "active"
	/** The token is past `exp` but within the 7-day refresh grace. Not locked. */
	| "grace"
	/** Past the grace window: re-activate with the key. */
	| "expired"
	/** Signature, binding or claims failed. */
	| "invalid"
	/** The licence server revoked it (refund, lost dispute, deactivation, key replaced). */
	| "revoked";

/** Statuses that lock the app. */
export const LOCKED_STATUSES: ReadonlySet<LicenceStatus> = new Set(["none", "expired", "invalid", "revoked"]);

export function isLockedStatus(status: LicenceStatus): boolean {
	return LOCKED_STATUSES.has(status);
}

export interface LicenceView {
	status: LicenceStatus;
	locked: boolean;
	enforcement: "enforce" | "off";
	plan: string | null;
	/** Unix seconds. When the current token stops being valid without a refresh. */
	expiresAt: number | null;
	/** Unix seconds; the last successful refresh or activation. */
	lastRefreshAt: number | null;
	/** Refreshes that failed in a row since the last success. */
	failureCount: number;
	/** Whole days left before a `grace` token stops refreshing. */
	graceDaysLeft: number | null;
	/** Why the licence server last refused, when it did (e.g. `revoked`). */
	serverReason: string | null;
	customerEmail: string | null;
	/** Activation limit, for display only. */
	instances: number | null;
	/** Where the customer manages the purchase. */
	manageUrl: string;
	deploymentId: string;
	host: string | null;
}

/** The error the API answers while the app is locked. */
export const LICENCE_REQUIRED_CODE = "licence_required";

export const LICENCE_REQUIRED_MESSAGE = "This deployment needs an active licence. An administrator can activate it.";

/** Licence keys are opaque strings from Dodo; bound only to keep requests sane. */
export function normaliseLicenceKey(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const key = raw.trim();
	if (key.length < 8 || key.length > 256 || /\s/.test(key)) return null;
	return key;
}
