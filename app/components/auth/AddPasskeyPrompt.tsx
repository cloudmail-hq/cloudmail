/**
 * A nudge to add a passkey, for someone who signs in with a password and has
 * none, on a browser that can make one with this device's fingerprint, face
 * or PIN. "Add a passkey" goes to the Passkeys panel, which handles the
 * confirm-it's-you step. "Not now" hides it in this browser for 30 days.
 *
 * Never adds a passkey by itself: a passkey turns two-factor on, which is the
 * user's choice to make.
 */

import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { Fingerprint, X } from "lucide-react";
import {
	PASSKEY_PROMPT_SNOOZE_MS,
	passkeyPromptKey,
	passkeyPromptSnoozed,
	shouldOfferPasskey,
} from "~/lib/passkey-prompt";
import { passkeysSupported } from "~/lib/passkeys";
import { useCurrentUser } from "~/queries/people";

function readStored(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

export default function AddPasskeyPrompt() {
	const { data: me } = useCurrentUser();
	const { pathname } = useLocation();
	// Decided after hydration: the server render cannot know what the device offers.
	const [platformPasskey, setPlatformPasskey] = useState(false);
	const [snoozed, setSnoozed] = useState(true);
	const userId = me?.userId ?? null;

	useEffect(() => {
		let cancelled = false;
		if (!passkeysSupported()) return;
		PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
			.then((ok) => !cancelled && setPlatformPasskey(ok))
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (userId) setSnoozed(passkeyPromptSnoozed(readStored(passkeyPromptKey(userId)), Date.now()));
	}, [userId]);

	const show =
		userId !== null &&
		shouldOfferPasskey({
			passwordSession: me?.authMode === "password" && me.authMethod === "session",
			hasPasskey: me?.hasPasskey === true,
			mfaEnrollmentRequired: me?.mfaEnrollmentRequired === true,
			platformPasskey,
			snoozed,
			onAccountSettings: pathname.startsWith("/settings/account"),
		});
	if (!show) return null;

	function notNow() {
		setSnoozed(true);
		try {
			localStorage.setItem(passkeyPromptKey(userId!), String(Date.now() + PASSKEY_PROMPT_SNOOZE_MS));
		} catch {
			/* private mode: hidden for this page only */
		}
	}

	return (
		<div role="status" className="flex items-start gap-3 border-b border-border bg-accent-subtle px-4 py-2 text-sm text-accent-subtle-fg">
			<Fingerprint className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			<div className="min-w-0 flex-1 space-y-0.5">
				<p>
					Sign in with your fingerprint, face or device PIN instead of typing your password. A passkey also
					protects your account if your password leaks.
				</p>
				<div className="flex flex-wrap gap-x-4 gap-y-1">
					<Link to="/settings/account#passkeys" className="font-medium underline underline-offset-2">
						Add a passkey
					</Link>
					<button type="button" onClick={notNow} className="font-medium opacity-80 hover:opacity-100">
						Not now
					</button>
				</div>
			</div>
			<button
				type="button"
				onClick={notNow}
				className="-m-2 inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-black/5 dark:hover:bg-white/10"
				aria-label="Don't suggest a passkey for 30 days"
			>
				<X className="size-4" aria-hidden="true" />
			</button>
		</div>
	);
}
