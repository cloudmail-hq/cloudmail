// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Sign in: email + password, then a second factor when the account has one.
 *
 * Public. Data is fetched client-side through TanStack Query like every other
 * route, so the server render is the empty form and needs no session.
 *
 * Success navigates with `window.location.assign` rather than the router: the
 * session cookie has just been set, and a full load lets the Worker's SSR guard
 * and every cached query start from the signed-in state.
 */

import { Fingerprint, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
	AuthLoading,
	AuthShell,
	Field,
	FormError,
	FormNotice,
	PasswordField,
	SubmitButton,
} from "~/components/auth/AuthShell";
import { Turnstile, type TurnstileHandle } from "~/components/auth/Turnstile";
import { looksLikeEmail, normalizeMfaInput, safeNextPath } from "~/lib/auth-helpers";
import {
	cancelPasskeyCeremony,
	describePasskeyError,
	getPasskey,
	isPasskeyCancel,
	passkeyAutofillSupported,
	passkeysSupported,
} from "~/lib/passkeys";
import { useAuthState } from "~/queries/auth";
import authApi, { authErrorCode, authErrorMessage } from "~/services/auth-api";

export function meta() {
	return [{ title: "Sign in" }, { name: "robots", content: "noindex" }];
}

type Step = { kind: "password" } | { kind: "mfa"; challenge: string; passkeys: boolean };

export default function LoginRoute() {
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const next = safeNextPath(params.get("next"));
	const { data: state, isLoading, isError, refetch } = useAuthState();

	const [step, setStep] = useState<Step>({ kind: "password" });
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [codeMode, setCodeMode] = useState<"totp" | "recovery">("totp");
	const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
	const [turnstileBroken, setTurnstileBroken] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [passkeyPending, setPasskeyPending] = useState(false);
	const [canPasskey, setCanPasskey] = useState(false);

	const turnstile = useRef<TurnstileHandle>(null);
	const emailRef = useRef<HTMLInputElement>(null);
	const passwordRef = useRef<HTMLInputElement>(null);
	const codeRef = useRef<HTMLInputElement>(null);

	// First run: nobody can sign in until the owner exists.
	useEffect(() => {
		if (state?.setupRequired) navigate("/setup", { replace: true });
	}, [state?.setupRequired, navigate]);

	// Already signed in (e.g. Back after signing in): go where they were headed.
	useEffect(() => {
		if (state?.authenticated && state.mode === "password") window.location.assign(next);
	}, [state?.authenticated, state?.mode, next]);

	useEffect(() => {
		if (step.kind === "mfa") codeRef.current?.focus();
	}, [step.kind, codeMode]);

	// Decided after hydration: the server render cannot know what the browser supports.
	useEffect(() => setCanPasskey(passkeysSupported()), []);

	/**
	 * Conditional UI: while the password form is showing, a passkey request
	 * waits in the background and the browser lists this site's passkeys in
	 * the email field's autofill. Picking one signs in; ignoring it costs
	 * nothing. Cancelled when the step changes or the button takes over.
	 */
	const passwordStep = step.kind === "password";
	const ready = Boolean(state) && state?.mode === "password" && !state.setupRequired && !state.authenticated;
	useEffect(() => {
		if (!passwordStep || !ready) return;
		let cancelled = false;
		(async () => {
			if (!(await passkeyAutofillSupported()) || cancelled) return;
			try {
				const { options } = await authApi.passkeyLoginOptions();
				if (cancelled) return;
				const response = await getPasskey(options, true);
				setPasskeyPending(true);
				await authApi.passkeyLoginVerify({ response });
				window.location.assign(next);
			} catch (err) {
				setPasskeyPending(false);
				// Superseded by the button, or the user ignored autofill: not an error.
				if (cancelled || isPasskeyCancel(err)) return;
				setError(authErrorMessage(err, "That passkey didn't work. Try again or use your password."));
			}
		})();
		return () => {
			cancelled = true;
			cancelPasskeyCeremony();
		};
	}, [passwordStep, ready, next]);

	async function onPasskeySignIn() {
		setError(null);
		setPasskeyPending(true);
		try {
			const { options } = await authApi.passkeyLoginOptions();
			// Replaces the waiting autofill request, if any.
			const response = await getPasskey(options);
			await authApi.passkeyLoginVerify({ response });
			window.location.assign(next);
		} catch (err) {
			setPasskeyPending(false);
			if (isPasskeyCancel(err)) return;
			setError(
				authErrorCode(err)
					? authErrorMessage(err, "That passkey didn't work. Try again or use your password.")
					: describePasskeyError(err, "That passkey didn't work. Try again or use your password."),
			);
		}
	}

	async function onPasskeyMfa() {
		if (step.kind !== "mfa") return;
		setError(null);
		setPending(true);
		try {
			const { options } = await authApi.passkeyMfaOptions({ challenge: step.challenge });
			const response = await getPasskey(options);
			await authApi.passkeyMfaVerify({ challenge: step.challenge, response });
			window.location.assign(next);
		} catch (err) {
			setPending(false);
			if (isPasskeyCancel(err)) return;
			const status = authErrorCode(err);
			if (status === "challenge_expired") {
				setStep({ kind: "password" });
				setPassword("");
				setError(`${authErrorMessage(err, "That sign-in attempt expired.")} Enter your password again.`);
				return;
			}
			setError(
				status
					? authErrorMessage(err, "That passkey didn't work.")
					: describePasskeyError(err, "That passkey didn't work."),
			);
		}
	}

	const siteKey = state?.turnstileSiteKey ?? null;
	const needsTurnstile = Boolean(siteKey) && step.kind === "password";

	async function onPasswordSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!looksLikeEmail(email)) {
			setError("Enter the email address for your account.");
			emailRef.current?.focus();
			return;
		}
		if (!password) {
			setError("Enter your password.");
			passwordRef.current?.focus();
			return;
		}
		if (needsTurnstile && !turnstileToken) {
			setError("Complete the human check first.");
			return;
		}

		setPending(true);
		try {
			const result = await authApi.login({
				email: email.trim(),
				password,
				...(turnstileToken ? { turnstileToken } : {}),
			});
			if (result.status === "mfa_required") {
				setStep({ kind: "mfa", challenge: result.challenge, passkeys: result.passkeys === true });
				setCode("");
				setPending(false);
				return;
			}
			window.location.assign(next);
		} catch (err) {
			setPending(false);
			setError(authErrorMessage(err, "Couldn't sign in. Try again."));
			// Turnstile tokens are single-use.
			turnstile.current?.reset();
			if (authErrorCode(err) === "invalid_credentials") {
				setPassword("");
				passwordRef.current?.focus();
			}
		}
	}

	async function onMfaSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (step.kind !== "mfa") return;
		setError(null);
		const value = normalizeMfaInput(code, codeMode);
		if (codeMode === "totp" && value.length !== 6) {
			setError("Enter the 6-digit code from your authenticator app.");
			codeRef.current?.focus();
			return;
		}
		if (codeMode === "recovery" && value.length < 8) {
			setError("Enter one of your recovery codes.");
			codeRef.current?.focus();
			return;
		}

		setPending(true);
		try {
			await authApi.loginMfa({ challenge: step.challenge, code: value });
			window.location.assign(next);
		} catch (err) {
			setPending(false);
			const status = authErrorCode(err);
			// An expired or exhausted challenge cannot be retried: start over.
			if (status !== "invalid_code" && status !== "rate_limited") {
				setStep({ kind: "password" });
				setPassword("");
				setError(
					`${authErrorMessage(err, "That sign-in attempt expired.")} Enter your password again.`,
				);
				return;
			}
			setError(authErrorMessage(err, "That code didn't work."));
			setCode("");
			codeRef.current?.focus();
		}
	}

	if (isLoading) {
		return (
			<AuthShell title="Sign in">
				<AuthLoading label="Loading" />
			</AuthShell>
		);
	}

	if (state?.mode === "access") {
		return (
			<AuthShell
				title="Signed in through Cloudflare Access"
				description="This deployment uses Cloudflare Access instead of built-in accounts."
			>
				<FormNotice>
					Your identity provider handles sign-in. If you reached this page by mistake, open the
					app again and Cloudflare Access will ask you to sign in.
				</FormNotice>
				<a
					href="/"
					className="inline-flex h-10 w-full items-center justify-center rounded-[8px] bg-accent text-sm font-semibold text-accent-foreground hover:bg-accent-hover"
				>
					Open the app
				</a>
			</AuthShell>
		);
	}

	if (step.kind === "mfa") {
		return (
			<AuthShell
				title="Two-factor verification"
				description={
					codeMode === "totp"
						? "Enter the 6-digit code from your authenticator app."
						: "Enter one of the recovery codes you saved when you set up two-factor sign-in. Each code works once."
				}
				footer={
					<button
						type="button"
						onClick={() => {
							setStep({ kind: "password" });
							setPassword("");
							setError(null);
						}}
						className="font-medium text-text-secondary hover:text-text-primary hover:underline"
					>
						Use a different account
					</button>
				}
			>
				<form onSubmit={onMfaSubmit} noValidate className="space-y-4">
					<FormError message={error} />
					{codeMode === "totp" ? (
						<Field
							ref={codeRef}
							key="totp"
							label="Authentication code"
							name="code"
							inputMode="numeric"
							autoComplete="one-time-code"
							pattern="[0-9]*"
							maxLength={6}
							placeholder="123456"
							value={code}
							onChange={(e) => setCode(normalizeMfaInput(e.target.value, "totp"))}
							disabled={pending}
							className="text-center font-mono text-lg tracking-[0.4em]"
						/>
					) : (
						<Field
							ref={codeRef}
							key="recovery"
							label="Recovery code"
							name="recovery-code"
							autoComplete="off"
							autoCapitalize="none"
							spellCheck={false}
							placeholder="xxxxx-xxxxx"
							value={code}
							onChange={(e) => setCode(e.target.value)}
							disabled={pending}
							className="font-mono"
						/>
					)}
					<SubmitButton pending={pending}>Verify</SubmitButton>
					{step.passkeys && canPasskey ? (
						<button
							type="button"
							onClick={onPasskeyMfa}
							disabled={pending}
							className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-[8px] text-sm font-medium text-text-primary ring-1 ring-border hover:bg-bg-subtle disabled:opacity-50"
						>
							<Fingerprint size={15} aria-hidden />
							Use a passkey instead
						</button>
					) : null}
					<button
						type="button"
						onClick={() => {
							setCodeMode((m) => (m === "totp" ? "recovery" : "totp"));
							setCode("");
							setError(null);
						}}
						className="flex w-full items-center justify-center gap-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
					>
						{codeMode === "totp" ? (
							<>
								<KeyRound size={12} aria-hidden /> Use a recovery code instead
							</>
						) : (
							<>
								<ShieldCheck size={12} aria-hidden /> Use your authenticator app instead
							</>
						)}
					</button>
				</form>
			</AuthShell>
		);
	}

	return (
		<AuthShell
			title="Sign in"
			description="Welcome back. Sign in to your mailbox."
			footer={
				state?.passwordResetByEmail ? (
					<span>
						<Link to="/forgot" className="font-medium text-text-secondary underline-offset-2 hover:text-text-primary hover:underline">
							Forgot password?
						</Link>{" "}
						·{" "}
						<Link to="/recover" className="font-medium text-text-secondary underline-offset-2 hover:text-text-primary hover:underline">
							Owner recovery
						</Link>
					</span>
				) : (
					<span>
						Forgot your password? Ask an administrator for a reset link.{" "}
						<Link to="/recover" className="font-medium text-text-secondary underline-offset-2 hover:text-text-primary hover:underline">
							Owner recovery
						</Link>
					</span>
				)
			}
		>
			<form onSubmit={onPasswordSubmit} noValidate className="space-y-4">
				{isError ? (
					<FormNotice tone="warning">
						Couldn't reach the server.{" "}
						<button type="button" onClick={() => refetch()} className="font-medium underline">
							Retry
						</button>
					</FormNotice>
				) : null}
				<FormError message={error} />
				<Field
					ref={emailRef}
					label="Email"
					type="email"
					name="email"
					// `webauthn` lets the browser offer passkeys here (conditional UI).
					autoComplete="username webauthn"
					autoCapitalize="none"
					spellCheck={false}
					// biome-ignore lint/a11y/noAutofocus: the only task on this page.
					autoFocus
					required
					placeholder="you@example.com"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					disabled={pending}
				/>
				<PasswordField
					ref={passwordRef}
					label="Password"
					name="password"
					autoComplete="current-password"
					required
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					disabled={pending}
				/>
				{siteKey ? (
					<div className="space-y-1">
						<Turnstile
							ref={turnstile}
							siteKey={siteKey}
							action="login"
							onToken={setTurnstileToken}
							onError={() => setTurnstileBroken(true)}
						/>
						{turnstileBroken ? (
							<p className="text-center text-[11px] text-destructive" role="alert">
								The human check couldn't load. Disable content blockers for this site and reload.
							</p>
						) : null}
					</div>
				) : null}
				<SubmitButton pending={pending} disabled={passkeyPending || (needsTurnstile && !turnstileToken)}>
					Sign in
				</SubmitButton>
				{canPasskey ? (
					<>
						<div className="flex items-center gap-3 text-[11px] text-text-tertiary" aria-hidden>
							<span className="h-px flex-1 bg-border" />
							or
							<span className="h-px flex-1 bg-border" />
						</div>
						<button
							type="button"
							onClick={onPasskeySignIn}
							disabled={pending || passkeyPending}
							className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-[8px] text-sm font-medium text-text-primary ring-1 ring-border hover:bg-bg-subtle disabled:opacity-50"
						>
							{passkeyPending ? (
								<Loader2 size={15} className="animate-spin" aria-hidden />
							) : (
								<Fingerprint size={15} aria-hidden />
							)}
							Sign in with a passkey
						</button>
					</>
				) : null}
			</form>
		</AuthShell>
	);
}
