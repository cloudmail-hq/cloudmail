// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Two-factor sign-in (TOTP): set up, show recovery codes once, regenerate them,
 * and turn it off.
 *
 * The QR code is rendered locally from the `otpauth://` URI with `uqr`, so the
 * secret never leaves the browser for a third-party QR service.
 */

import { Download, KeyRound, Loader2, ShieldCheck, ShieldOff } from "lucide-react";
import { useMemo, useState } from "react";
import { renderSVG } from "uqr";
import { describeSecondFactor, normalizeMfaInput } from "~/lib/auth-helpers";
import { toast } from "~/lib/toast";
import {
	useDisableTotp,
	useEnableTotp,
	usePasskeys,
	useRegenerateRecoveryCodes,
	useSetupTotp,
} from "~/queries/auth";
import { authErrorMessage } from "~/services/auth-api";
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
	| { kind: "regenerate" };

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

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
	const text = codes.join("\n");
	function download() {
		const blob = new Blob(
			[
				`cloudmail recovery codes\nGenerated ${new Date().toLocaleString()}\nEach code can be used once.\n\n${text}\n`,
			],
			{ type: "text/plain" },
		);
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "cloudmail-recovery-codes.txt";
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
	return (
		<div className="space-y-3" role="status">
			<div>
				<h4 className="text-sm font-medium text-text-primary">Save your recovery codes</h4>
				<p className="mt-1 text-sm text-text-secondary">
					If you lose your authenticator, each of these codes signs you in once. They won't be shown
					again, so store them somewhere safe, like a password manager.
				</p>
			</div>
			<ul
				aria-label="Recovery codes"
				className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-[6px] bg-bg-subtle p-3 font-mono text-xs text-text-primary ring-1 ring-border sm:grid-cols-2"
			>
				{codes.map((code) => (
					<li key={code}>{code}</li>
				))}
			</ul>
			<div className="flex flex-wrap items-center gap-2">
				<CopyButton text={text} label="Copy codes" what="Recovery codes copied" />
				<button type="button" onClick={download} className={`${SECONDARY_BUTTON_CLASS} h-8`}>
					<Download size={13} aria-hidden />
					Download
				</button>
				<button type="button" onClick={onDone} className={`${PRIMARY_BUTTON_CLASS} ml-auto h-8`}>
					I've saved them
				</button>
			</div>
		</div>
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

	function reset(next: Mode = { kind: "idle" }) {
		setMode(next);
		setPassword("");
		setCode("");
		setError(null);
	}

	async function startSetup(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!password) return setError("Enter your current password.");
		try {
			const result = await setup.mutateAsync(password);
			setPassword("");
			setMode({ kind: "setup-scan", ...result });
		} catch (err) {
			setError(authErrorMessage(err, "Couldn't start two-factor setup."));
		}
	}

	async function confirmSetup(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (code.length !== 6) return setError("Enter the 6-digit code your app shows.");
		try {
			const { recoveryCodes } = await enable.mutateAsync(code);
			reset({ kind: "codes", codes: recoveryCodes, fresh: true });
			toast.success("Two-factor sign-in is on");
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
		setError(null);
		if (!password) return setError("Enter your current password.");
		try {
			const { recoveryCodes } = await regenerate.mutateAsync(password);
			reset({ kind: "codes", codes: recoveryCodes, fresh: false });
		} catch (err) {
			setError(authErrorMessage(err, "Couldn't generate new codes."));
		}
	}

	const pending = setup.isPending || enable.isPending || disable.isPending || regenerate.isPending;
	const { data: passkeys } = usePasskeys();
	const status = describeSecondFactor({ totpEnabled: enabled, passkeyCount: passkeys?.length ?? 0 });

	return (
		<div className="space-y-4 p-5">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<h3 className="flex items-center gap-2 text-sm font-medium text-text-primary">
						Two-factor sign-in
						<Pill tone={status.tone}>{status.label}</Pill>
					</h3>
					<p className="mt-1 text-sm text-text-secondary">{status.detail}</p>
					{!enabled ? (
						<p className="mt-1 text-sm text-text-tertiary">
							Set up an authenticator app (1Password, Google Authenticator, Authy…) to ask for a
							code after your password.
						</p>
					) : null}
				</div>
				{mode.kind === "idle" ? (
					enabled ? (
						<div className="flex flex-wrap gap-2">
							<button type="button" onClick={() => reset({ kind: "regenerate" })} className={SECONDARY_BUTTON_CLASS}>
								<KeyRound size={13} aria-hidden />
								New recovery codes
							</button>
							<button type="button" onClick={() => reset({ kind: "disable" })} className={DANGER_BUTTON_CLASS}>
								<ShieldOff size={13} aria-hidden />
								Turn off
							</button>
						</div>
					) : (
						<button type="button" onClick={() => reset({ kind: "setup-password" })} className={PRIMARY_BUTTON_CLASS}>
							<ShieldCheck size={13} aria-hidden />
							Set up
						</button>
					)
				) : null}
			</div>

			{mode.kind === "setup-password" || mode.kind === "regenerate" ? (
				<form
					onSubmit={mode.kind === "regenerate" ? confirmRegenerate : startSetup}
					className="space-y-3 rounded-[6px] bg-bg-subtle/60 p-4 ring-1 ring-border"
				>
					<p className="text-sm text-text-secondary">
						{mode.kind === "regenerate"
							? "Generating new codes invalidates every old one. Confirm your password to continue."
							: "Confirm your password to start."}
					</p>
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
					<RecoveryCodes codes={mode.codes} onDone={() => reset()} />
				</div>
			) : null}

			{mode.kind === "disable" ? (
				<form onSubmit={confirmDisable} className="space-y-3 rounded-[6px] bg-bg-subtle/60 p-4 ring-1 ring-border">
					<p className="text-sm text-text-secondary">
						Your account will be protected by your password alone. Enter your password and a code
						from your app (or a recovery code).
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
							Turn off two-factor
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
