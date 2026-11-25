/**
 * When to suggest adding a passkey. Pure, so it is unit-testable; the banner
 * (`AddPasskeyPrompt`) supplies the browser state.
 */

/** "Not now" hides the prompt in this browser for this long. */
export const PASSKEY_PROMPT_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

/** localStorage key, per account, so another account on this browser still sees it. */
export function passkeyPromptKey(userId: string): string {
	return `passkey-prompt-snoozed-until:${userId}`;
}

/** Whether a stored snooze is still running. Garbage or a missing value counts as none. */
export function passkeyPromptSnoozed(stored: string | null, now: number): boolean {
	if (!stored) return false;
	const until = Number(stored);
	return Number.isFinite(until) && until > now;
}

export function shouldOfferPasskey(input: {
	/** Built-in password auth, in a browser session (not a token, not Access). */
	passwordSession: boolean;
	hasPasskey: boolean;
	/** The deployment's "require two-factor" enrolment screen has its own path. */
	mfaEnrollmentRequired: boolean;
	/** The browser can make a passkey with this device's fingerprint, face or PIN. */
	platformPasskey: boolean;
	snoozed: boolean;
	/** Already on the page with the Passkeys panel. */
	onAccountSettings: boolean;
}): boolean {
	return (
		input.passwordSession &&
		!input.hasPasskey &&
		!input.mfaEnrollmentRequired &&
		input.platformPasskey &&
		!input.snoozed &&
		!input.onAccountSettings
	);
}
