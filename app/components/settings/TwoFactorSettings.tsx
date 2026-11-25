/**
 * Two-factor sign-in: the authenticator app (TOTP) and the recovery codes that
 * back up every second factor. Set up, show codes once, regenerate them, remove
 * the app. Passkeys have their own panel; either one turns two-factor on.
 *
 * Setting up the app on an account that has a passkey, and making new codes,
 * need a recent passkey or app code rather than the password
 * (`factorChangeGuard` in the Worker). On `reauth_required` the panel asks for
 * one (`StepUpPrompt`), then carries on.
 *
 * The QR code is rendered locally from the `otpauth://` URI with `uqr`, so the
 * secret never leaves the browser for a third-party QR service.
 */

import { AlertTriangle, KeyRound, Loader2, ShieldCheck, ShieldOff } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { renderSVG } from "uqr";
import { describeSecondFactor, normalizeMfaInput, recoveryCodesWarning } from "~/lib/auth-helpers";
import { describePasskeyError, isPasskeyCancel } from "~/lib/passkeys";
import { toast } from "~/lib/toast";
import {
	useDisableTotp,
	useEnableTotp,
	usePasskeys,
	useReauth,
	useRefreshAccount,
	useRegenerateRecoveryCodes,
	useSetupTotp,
	useTwoFactorStatus,
} from "~/queries/auth";
import { authErrorCode, authErrorMessage, needsSecondFactorStepUp } from "~/services/auth-api";
import RecoveryCodesBox from "./RecoveryCodesBox";
import StepUpPrompt, { type StepUpInput } from "./StepUpPrompt";
import {
	CopyButton,
	DANGER_BUTTON_CLASS,
	InlineError,
	Pill,
	PRIMARY_BUTTON_CLASS,
	SECONDARY_BUTTON_CLASS,
	SettingsField,
} from "./settings-ui";

type Mode =
	| { kind: "idle" }
	| { kind: "setup-password" }
	| { kind: "setup-scan"; secret: string; otpauthUrl: string }
	| { kind: "codes"; codes: string[]; fresh: boolean }
	| { kind: "disable" }
	| { kind: "regenerate" }
	/** Confirm with a passkey or app code, then carry on with `then`. */
	| { kind: "reauth"; then: "setup" | "regenerate"; secondFactor: boolean };

/** Group a base32 secret in fours so it can be typed in by hand. */
function groupSecret(secret: string): string {
	return secret.replace(/(.{4})/g, "$1 ").trim();
}

function QrCode({ value }: { value: string }) {
	// Generated locally from a value we hold; contains no user-controlled markup
	// beyond the encoded modules.
	const svg = useMemo(
		() => renderSVG(value, { ecc: "M", border: 2, pixelSize: 6, whiteColor: "#ffffff", blackColor: "#0a0a0a" }),
		[value],
	);
	return (
		<div
			role="img"
			aria-label="QR code for your authenticator app"
			className="h-[180px] w-[180px] shrink-0 overflow-hidden rounded-[8px] bg-white p-1 ring-1 ring-border [&>svg]:h-full [&>svg]:w-full"
			// biome-ignore lint/security/noDangerouslySetInnerHtml: SVG produced locally by uqr.
			dangerouslySetInnerHTML={{ __html: svg }}
		/>
	);
}

export default function TwoFactorSettings({ enabled }: { enabled: boolean }) {
	const [mode, setMode] = useState<Mode>({ kind: "idle" });
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [error, setError] = useState<string | null>(null);

	const setup = useSetupTotp();
	const enable = useEnableTotp();
	const disable = useDisableTotp();
	const regenerate = useRegenerateRecoveryCodes();
	const reauth = useReauth();
	const refreshAccount = useRefreshAccount();

	// Fresh codes hold back the `/me` refresh until "I've saved them". If the
	// panel goes away first (another page, a closed tab section), refresh then.
	const refreshPending = useRef(false);
	refreshPending.current = mode.kind === "codes" && mode.fresh;
	const refreshRef = useRef(refreshAccount);
	refreshRef.current = refreshAccount;
	useEffect(
		() => () => {
			if (refreshPending.current) refreshRef.current();
		},
		[],
	);

	function reset(next: Mode = { kind: "idle" }) {
		setMode(next);
		setPassword("");
		setCode("");
		setError(null);
	}

	/** `password` for an account with no second factor; one with a passkey steps up instead. */
	async function runSetup(password?: string) {
		setError(null);
		try {
			const result = await setup.mutateAsync(password);
			setPassword("");
			setMode({ kind: "setup-scan", ...result });
		} catch (err) {
			if (authErrorCode(err) === "reauth_required") {
				reset({ kind: "reauth", then: "setup", secondFactor: needsSecondFactorStepUp(err) });
				return;
			}
			setError(authErrorMessage(err, "Couldn't start two-factor setup."));
		}
	}

	async function startSetup(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!password) return setError("Enter your current password.");
		await runSetup(password);
	}

	async function runRegenerate() {
		setError(null);
		try {
			const { recoveryCodes } = await regenerate.mutateAsync();
			reset({ kind: "codes", codes: recoveryCodes, fresh: false });
		} catch (err) {
			if (authErrorCode(err) === "reauth_required") {
				reset({ kind: "reauth", then: "regenerate", secondFactor: needsSecondFactorStepUp(err) });
				return;
			}
			setError(authErrorMessage(err, "Couldn't generate new codes."));
		}
	}

	async function confirmStepUp(input: StepUpInput) {
		if (mode.kind !== "reauth") return;
		const next = mode.then;
		setError(null);
		try {
			await reauth.mutateAsync(input);
		} catch (err) {
			if (isPasskeyCancel(err)) return;
			setError(
				authErrorCode(err)
					? authErrorMessage(err, "Couldn't confirm it's you.")
					: describePasskeyError(err, "Couldn't confirm it's you."),
			);
			return;
		}
		if (next === "setup") await runSetup();
		else await runRegenerate();
	}

	async function confirmSetup(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (code.length !== 6) return setError("Enter the 6-digit code your app shows.");
		try {
			const { recoveryCodes, recoveryCodesKept } = await enable.mutateAsync(code);
			if (recoveryCodesKept || recoveryCodes.length === 0) {
				reset();
				toast.success("Authenticator app added", { description: "Your existing recovery codes still work." });
			} else {
				reset({ kind: "codes", codes: recoveryCodes, fresh: true });
				toast.success("Two-factor sign-in is on");
			}
		} catch (err) {
			setCode("");
			setError(authErrorMessage(err, "That code didn't work."));
		}
	}

	async function confirmDisable(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!password || !code) return setError("Enter your password and a current code.");
		try {
			await disable.mutateAsync({ password, code: normalizeMfaInput(code, /^\d+$/.test(code) ? "totp" : "recovery") });
			reset();
			toast.success("Two-factor sign-in is off");
		} catch (err) {
			setError(authErrorMessage(err, "Couldn't turn off two-factor sign-in."));
		}
	}

	async function confirmRegenerate(e: React.FormEvent) {
		e.preventDefault();
		await runRegenerate();
	}

	const pending =
		setup.isPending || enable.isPending || disable.isPending || regenerate.isPending || reauth.isPending;
	const { data: passkeys } = usePasskeys();
	const { data: twoFactor } = useTwoFactorStatus();
	// `/settings/account#two-factor` (the recovery codes banner) lands here.
	// Routed settings pages don't scroll to a hash on their own.
	useEffect(() => {
		if (window.location.hash !== "#two-factor") return;
		document.getElementById("two-factor")?.scrollIntoView({ block: "start" });
	}, []);

	const passkeyCount = passkeys?.length ?? 0;
	const status = describeSecondFactor({ totpEnabled: enabled, passkeyCount });
	const twoFactorOn = enabled || passkeyCount > 0;
	const codesLeft = twoFactor?.recoveryCodesLeft ?? null;
	const lowCodes =
		codesLeft === null
			? null
			: (recoveryCodesWarning(codesLeft, twoFactorOn) ??
				(twoFactorOn && twoFactor?.recoveryCodesOutdated
					? "Your recovery codes are an older, shorter kind. Make a new set to replace them."
					: null));

	return (
		<div id="two-factor" className="scroll-mt-24 space-y-4 p-5">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<h3 className="flex items-center gap-2 text-sm font-medium text-text-primary">
						Two-factor sign-in
						<Pill tone={status.tone}>{status.label}</Pill>
					</h3>
					<p className="mt-1 text-sm text-text-secondary">{status.detail}</p>
					{!enabled ? (
						<p className="mt-1 text-sm text-text-tertiary">
							Set up an authenticator app (1Password, Google Authenticator, Authy…) to get a
							6-digit code after your password{passkeyCount > 0 ? ", as a backup to your passkeys" : ""}.
						</p>
					) : null}
					{twoFactorOn && codesLeft !== null ? (
						<p className="mt-1 text-sm text-text-tertiary">{codesLeft} of 10 recovery codes left.</p>
					) : null}
				</div>
				{mode.kind === "idle" ? (
					<div className="flex flex-wrap gap-2">
						{twoFactorOn ? (
							<button type="button" onClick={() => reset({ kind: "regenerate" })} className={SECONDARY_BUTTON_CLASS}>
								<KeyRound size={13} aria-hidden />
								New recovery codes
							</button>
						) : null}
						{enabled ? (
							<button type="button" onClick={() => reset({ kind: "disable" })} className={DANGER_BUTTON_CLASS}>
								<ShieldOff size={13} aria-hidden />
								Remove app
							</button>
						) : (
							<button
								type="button"
								// With a passkey there is no password to ask: the passkey confirms it.
								onClick={() => (passkeyCount > 0 ? void runSetup() : reset({ kind: "setup-password" }))}
								disabled={pending}
								className={PRIMARY_BUTTON_CLASS}
							>
								{setup.isPending ? (
									<Loader2 size={13} className="animate-spin" aria-hidden />
								) : (
									<ShieldCheck size={13} aria-hidden />
								)}
								Set up app
							</button>
						)}
					</div>
				) : null}
			</div>

			{twoFactor?.totpSuspended ? (
				<p role="alert" className="flex items-start gap-2 rounded-[6px] bg-destructive-subtle p-3 text-sm text-destructive">
					<AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
					Authenticator codes are paused after too many wrong guesses. Sign in once with a passkey or a recovery
					code to turn them back on, and change your password: someone may know it.
				</p>
			) : lowCodes && mode.kind === "idle" ? (
				<p role="status" className="flex items-start gap-2 rounded-[6px] bg-warning-bg p-3 text-sm text-warning-text">
					<AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
					{lowCodes}
				</p>
			) : null}

			{mode.kind === "idle" ? <InlineError message={error} /> : null}

			{mode.kind === "reauth" ? (
				<StepUpPrompt
					message={
						mode.then === "setup"
							? "Adding an authenticator app changes how you sign in. Confirm with a passkey first."
							: "Making new recovery codes changes how you sign in. Confirm with a passkey or a code from your app."
					}
					passkeys={passkeyCount > 0}
					totp={enabled}
					secondFactorRequired={mode.secondFactor}
					busy={pending}
					error={error}
					onConfirm={confirmStepUp}
					onCancel={() => reset()}
				/>
			) : null}

			{mode.kind === "regenerate" ? (
				<form onSubmit={confirmRegenerate} className="space-y-3 rounded-[6px] bg-bg-subtle/60 p-4 ring-1 ring-border">
					<p className="text-sm text-text-secondary">
						Making new codes invalidates every old one. Save the new set somewhere safe.
					</p>
					<InlineError message={error} />
					<div className="flex gap-2">
						<button type="submit" disabled={pending} className={PRIMARY_BUTTON_CLASS}>
							{pending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
							Make new codes
						</button>
						<button type="button" onClick={() => reset()} className={SECONDARY_BUTTON_CLASS}>
							Cancel
						</button>
					</div>
				</form>
			) : null}

			{mode.kind === "setup-password" ? (
				<form onSubmit={startSetup} className="space-y-3 rounded-[6px] bg-bg-subtle/60 p-4 ring-1 ring-border">
					<p className="text-sm text-text-secondary">Confirm your password to start.</p>
					<SettingsField
						label="Current password"
						type="password"
						autoComplete="current-password"
						// biome-ignore lint/a11y/noAutofocus: opened by an explicit click.
						autoFocus
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						disabled={pending}
						className="max-w-xs"
					/>
					<InlineError message={error} />
					<div className="flex gap-2">
						<button type="submit" disabled={pending} className={PRIMARY_BUTTON_CLASS}>
							{pending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
							Continue
						</button>
						<button type="button" onClick={() => reset()} className={SECONDARY_BUTTON_CLASS}>
							Cancel
						</button>
					</div>
				</form>
			) : null}

			{mode.kind === "setup-scan" ? (
				<form onSubmit={confirmSetup} className="space-y-4 rounded-[6px] bg-bg-subtle/60 p-4 ring-1 ring-border">
					<div className="flex flex-col gap-4 sm:flex-row">
						<QrCode value={mode.otpauthUrl} />
						<div className="min-w-0 space-y-3">
							<ol className="list-decimal space-y-1 pl-4 text-sm text-text-secondary">
								<li>Scan the QR code with your authenticator app.</li>
								<li>Or enter this key by hand (time-based, 6 digits):</li>
							</ol>
							<div className="flex flex-wrap items-center gap-2">
								<code className="break-all rounded-[4px] bg-card px-2 py-1 font-mono text-xs text-text-primary ring-1 ring-border">
									{groupSecret(mode.secret)}
								</code>
								<CopyButton text={mode.secret} label="Copy key" what="Setup key copied" />
							</div>
							<SettingsField
								label="Code from your app"
								inputMode="numeric"
								autoComplete="one-time-code"
								pattern="[0-9]*"
								maxLength={6}
								placeholder="123456"
								// biome-ignore lint/a11y/noAutofocus: the next step of a flow the reader started.
								autoFocus
								value={code}
								onChange={(e) => setCode(normalizeMfaInput(e.target.value, "totp"))}
								disabled={pending}
								className="max-w-[180px]"
								inputClassName="font-mono tracking-[0.3em]"
							/>
						</div>
					</div>
					<InlineError message={error} />
					<div className="flex gap-2">
						<button type="submit" disabled={pending} className={PRIMARY_BUTTON_CLASS}>
							{pending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
							Turn on two-factor
						</button>
						<button type="button" onClick={() => reset()} className={SECONDARY_BUTTON_CLASS}>
							Cancel
						</button>
					</div>
				</form>
			) : null}

			{mode.kind === "codes" ? (
				<div className="rounded-[6px] bg-bg-subtle/60 p-4 ring-1 ring-border">
					<RecoveryCodesBox
						codes={mode.codes}
						onDone={() => {
							reset();
							if (mode.fresh) refreshAccount();
						}}
					/>
				</div>
			) : null}

			{mode.kind === "disable" ? (
				<form onSubmit={confirmDisable} className="space-y-3 rounded-[6px] bg-bg-subtle/60 p-4 ring-1 ring-border">
					<p className="text-sm text-text-secondary">
						{passkeyCount > 0
							? "Password sign-ins will ask for a passkey instead. Enter your password and a code from your app (or a recovery code)."
							: "Your account will be protected by your password alone. Enter your password and a code from your app (or a recovery code)."}
					</p>
					<div className="grid max-w-md gap-3 sm:grid-cols-2">
						<SettingsField
							label="Current password"
							type="password"
							autoComplete="current-password"
							// biome-ignore lint/a11y/noAutofocus: opened by an explicit click.
							autoFocus
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							disabled={pending}
						/>
						<SettingsField
							label="Authentication code"
							autoComplete="one-time-code"
							autoCapitalize="none"
							spellCheck={false}
							value={code}
							onChange={(e) => setCode(e.target.value.trim())}
							disabled={pending}
							inputClassName="font-mono"
						/>
					</div>
					<InlineError message={error} />
					<div className="flex gap-2">
						<button type="submit" disabled={pending} className={DANGER_BUTTON_CLASS}>
							{pending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
							Remove authenticator app
						</button>
						<button type="button" onClick={() => reset()} className={SECONDARY_BUTTON_CLASS}>
							Cancel
						</button>
					</div>
				</form>
			) : null}
		</div>
	);
}
