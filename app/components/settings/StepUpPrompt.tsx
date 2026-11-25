/**
 * "Confirm it's you" before changing how the account signs in: adding or
 * removing a passkey, setting up the authenticator app, new recovery codes.
 *
 * An account with a second factor confirms with it, a passkey or an app code:
 * the Worker refuses the password for these changes (`factorChangeGuard`), so
 * someone who has the password and a signed-in browser cannot add their own
 * way in. An account with no second factor yet confirms with its password.
 */

import { Fingerprint, Loader2 } from "lucide-react";
import { useState } from "react";
import { normalizeMfaInput } from "~/lib/auth-helpers";
import { InlineError, PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS, SettingsField } from "./settings-ui";

export type StepUpInput = { password: string } | { code: string } | { passkey: true };

export default function StepUpPrompt({
	message,
	passkeys,
	totp,
	secondFactorRequired = false,
	busy,
	error,
	onConfirm,
	onCancel,
}: {
	message: string;
	/** The account has a passkey to confirm with. */
	passkeys: boolean;
	/** The account has the authenticator app. */
	totp: boolean;
	/**
	 * The Worker said a password won't do (`secondFactor: true` on its 403).
	 * Trusted over `passkeys`, which may be a list still loading or that failed.
	 */
	secondFactorRequired?: boolean;
	busy: boolean;
	error: string | null;
	onConfirm: (input: StepUpInput) => void;
	onCancel: () => void;
}) {
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);
	// Only an account with no second factor confirms with its password. When
	// the Worker says it has one but there is no app, it is a passkey, even if
	// the passkey list hasn't loaded.
	const showPasskey = passkeys || (secondFactorRequired && !totp);
	const usePassword = !secondFactorRequired && !passkeys && !totp;

	return (
		<div className="space-y-3 rounded-[6px] bg-bg-subtle/60 p-4 ring-1 ring-border">
			<div>
				<h4 className="text-sm font-medium text-text-primary">Confirm it's you</h4>
				<p className="mt-1 text-sm text-text-secondary">{message}</p>
			</div>
			{showPasskey ? (
				<button
					type="button"
					onClick={() => {
						setLocalError(null);
						onConfirm({ passkey: true });
					}}
					disabled={busy}
					className={PRIMARY_BUTTON_CLASS}
				>
					{busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Fingerprint size={13} aria-hidden />}
					Use a passkey
				</button>
			) : null}
			{totp ? (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						if (code.length !== 6) return setLocalError("Enter the 6-digit code from your authenticator app.");
						setLocalError(null);
						onConfirm({ code });
						setCode("");
					}}
					className="flex flex-wrap items-end gap-2"
				>
					<SettingsField
						label={showPasskey ? "Or a code from your authenticator app" : "Code from your authenticator app"}
						inputMode="numeric"
						autoComplete="one-time-code"
						maxLength={6}
						// biome-ignore lint/a11y/noAutofocus: opened by an explicit action.
						autoFocus={!showPasskey}
						value={code}
						onChange={(e) => setCode(normalizeMfaInput(e.target.value, "totp"))}
						disabled={busy}
						className="w-64"
						inputClassName="font-mono tracking-[0.3em]"
					/>
					<button type="submit" disabled={busy} className={showPasskey ? SECONDARY_BUTTON_CLASS : PRIMARY_BUTTON_CLASS}>
						{busy && !showPasskey ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
						Confirm
					</button>
				</form>
			) : null}
			{usePassword ? (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						if (!password) return setLocalError("Enter your password.");
						setLocalError(null);
						onConfirm({ password });
						setPassword("");
					}}
					className="flex flex-wrap items-end gap-2"
				>
					<SettingsField
						label="Password"
						type="password"
						autoComplete="current-password"
						// biome-ignore lint/a11y/noAutofocus: opened by an explicit action.
						autoFocus
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						disabled={busy}
						className="w-full max-w-xs"
					/>
					<button type="submit" disabled={busy} className={PRIMARY_BUTTON_CLASS}>
						{busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
						Confirm
					</button>
				</form>
			) : (
				<p className="text-xs text-text-tertiary">
					Lost your passkeys or phone? Sign out and sign in with a recovery code. For 5 minutes after that you can
					change these settings.
				</p>
			)}
			<InlineError message={localError ?? error} />
			<button type="button" onClick={onCancel} className="text-xs font-medium text-text-secondary hover:text-text-primary">
				Cancel
			</button>
		</div>
	);
}
