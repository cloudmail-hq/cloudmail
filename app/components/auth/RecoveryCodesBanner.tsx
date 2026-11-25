/**
 * App-wide nudge for an account that has two-factor but no recovery codes.
 *
 * Accounts that added a passkey before passkeys counted as two-factor never
 * got codes. A password sign-in now asks them for the passkey, so losing it
 * (or using a browser without passkeys) would leave them nothing to type.
 * Shown under the top bar until they make a set; dismissing hides it for this
 * browser session only.
 */

import { useState } from "react";
import { Link } from "react-router";
import { KeyRound, X } from "lucide-react";
import { useTwoFactorStatus } from "~/queries/auth";
import { useCurrentUser } from "~/queries/people";

const DISMISS_KEY = "recovery-codes-banner-dismissed";

function readDismissed(): boolean {
	try {
		return sessionStorage.getItem(DISMISS_KEY) === "1";
	} catch {
		return false;
	}
}

export default function RecoveryCodesBanner() {
	const { data: me } = useCurrentUser();
	const twoFactorOn = me?.authMode === "password" && (me.totpEnabled === true || me.hasPasskey === true);
	const { data: status } = useTwoFactorStatus({ enabled: twoFactorOn });
	const [dismissed, setDismissed] = useState(() => (typeof window === "undefined" ? false : readDismissed()));

	if (!twoFactorOn || dismissed || !status?.enabled || status.recoveryCodesLeft > 0) return null;
	return (
		<div
			role="status"
			className="flex items-start gap-3 border-b border-warning-border bg-warning-bg px-4 py-2 text-sm text-warning-text"
		>
			<KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			<div className="min-w-0 flex-1 space-y-0.5">
				<p>
					Signing in with your password asks for your passkey or authenticator app. You have no recovery codes,
					so losing them would lock you out.
				</p>
				<Link to="/settings/account#two-factor" className="inline-block font-medium underline underline-offset-2">
					Make recovery codes
				</Link>
			</div>
			<button
				type="button"
				onClick={() => {
					setDismissed(true);
					try {
						sessionStorage.setItem(DISMISS_KEY, "1");
					} catch {
						/* private mode: dismiss for this render only */
					}
				}}
				className="-m-2 inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-black/5 dark:hover:bg-white/10"
				aria-label="Dismiss recovery codes warning"
			>
				<X className="size-4" aria-hidden="true" />
			</button>
		</div>
	);
}
