/**
 * Browser side of passkeys: run a WebAuthn ceremony from options the Worker
 * issued, and turn the browser's failures into copy a person can act on.
 *
 * `@simplewebauthn/browser` only reads `window` / `navigator` when a function
 * is called, so importing it is safe during the server render.
 */

import {
	browserSupportsWebAuthn,
	browserSupportsWebAuthnAutofill,
	startAuthentication,
	startRegistration,
	WebAuthnAbortService,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

type Options = Record<string, unknown>;
type CredentialJSON = Record<string, unknown>;

/** Whether this browser can do WebAuthn at all. False during SSR. */
export function passkeysSupported(): boolean {
	return typeof window !== "undefined" && browserSupportsWebAuthn();
}

/** Whether the browser can offer passkeys in an input's autofill (conditional UI). */
export async function passkeyAutofillSupported(): Promise<boolean> {
	if (!passkeysSupported()) return false;
	try {
		return await browserSupportsWebAuthnAutofill();
	} catch {
		return false;
	}
}

export async function createPasskey(options: Options): Promise<CredentialJSON> {
	const response = await startRegistration({
		optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON,
	});
	return response as unknown as CredentialJSON;
}

/**
 * Ask for a passkey assertion. With `autofill`, the request waits silently
 * for the user to pick a passkey from the email field's suggestions instead
 * of opening a dialog.
 */
export async function getPasskey(options: Options, autofill = false): Promise<CredentialJSON> {
	const response = await startAuthentication({
		optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON,
		useBrowserAutofill: autofill,
	});
	return response as unknown as CredentialJSON;
}

/**
 * The Signal API (WebAuthn L3): tells the passkey provider (iCloud Keychain,
 * Google Password Manager, 1Password …) which passkeys this site still
 * accepts, so a deleted one stops being offered. Chrome 132+, Safari 26+;
 * elsewhere these do nothing. Best effort: they never throw.
 */
type SignalApi = {
	signalUnknownCredential?: (input: { rpId: string; credentialId: string }) => Promise<void>;
	signalAllAcceptedCredentials?: (input: {
		rpId: string;
		userId: string;
		allAcceptedCredentialIds: string[];
	}) => Promise<void>;
};

function signalApi(): SignalApi | null {
	if (typeof window === "undefined" || typeof window.PublicKeyCredential === "undefined") return null;
	return window.PublicKeyCredential as unknown as SignalApi;
}

/** After the Worker answered `passkey_unknown`: this credential is gone here. */
export async function signalUnknownPasskey(rpId: string | undefined, credentialId: string | undefined): Promise<void> {
	const api = signalApi();
	if (!api?.signalUnknownCredential || !rpId || !credentialId) return;
	try {
		await api.signalUnknownCredential({ rpId, credentialId });
	} catch {
		/* the provider may refuse; nothing to show */
	}
}

/** Every passkey the account still has (`GET /api/auth/passkeys` → `accepted`). */
export interface AcceptedPasskeys {
	rpId: string;
	userId: string;
	credentialIds: string[];
}

/** After a passkey is removed: the provider drops the ones not listed. */
export async function signalAcceptedPasskeys(accepted: AcceptedPasskeys | undefined): Promise<void> {
	const api = signalApi();
	if (!api?.signalAllAcceptedCredentials || !accepted) return;
	try {
		await api.signalAllAcceptedCredentials({
			rpId: accepted.rpId,
			userId: accepted.userId,
			allAcceptedCredentialIds: accepted.credentialIds,
		});
	} catch {
		/* best effort */
	}
}

/** Abandon any pending ceremony, e.g. the autofill request when leaving the page. */
export function cancelPasskeyCeremony(): void {
	WebAuthnAbortService.cancelCeremony();
}

/**
 * True when the user dismissed the browser's dialog (or it timed out, or a
 * newer ceremony replaced it). That is a choice, not an error, so callers
 * show nothing.
 */
export function isPasskeyCancel(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as { code?: string }).code;
	return error.name === "NotAllowedError" || error.name === "AbortError" || code === "ERROR_CEREMONY_ABORTED";
}

/** Copy for a failure inside the browser's ceremony (not the server's answer). */
export function describePasskeyError(error: unknown, fallback: string): string {
	if (!(error instanceof Error)) return fallback;
	const code = (error as { code?: string }).code;
	switch (code) {
		case "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED":
			return "This device already has a passkey for your account.";
		case "ERROR_INVALID_DOMAIN":
		case "ERROR_INVALID_RP_ID":
			return "Passkeys don't work on this address. Open the app on its main web address and try again.";
		case "ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT":
		case "ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT":
			return "This security key can't be used as a passkey. It needs a PIN or fingerprint.";
	}
	if (error.name === "SecurityError") {
		return "Passkeys need a secure (https) connection on the app's own address.";
	}
	return fallback;
}
