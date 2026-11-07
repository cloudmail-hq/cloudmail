// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * First-run setup: create the owner account.
 *
 * Gated by a setup token so that whoever finds a freshly deployed Worker first
 * cannot claim it. The token is either the `SETUP_TOKEN` secret, or — when that
 * is not configured — a random one the Worker generated and printed to its logs.
 */

import { Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
	AuthLoading,
	AuthShell,
	Field,
	FormError,
	FormNotice,
	PasswordField,
	PasswordStrengthMeter,
	SubmitButton,
} from "~/components/auth/AuthShell";
import { Turnstile, type TurnstileHandle } from "~/components/auth/Turnstile";
import { looksLikeEmail, PASSWORD_MIN_LENGTH } from "~/lib/auth-helpers";
import { useAuthState } from "~/queries/auth";
import authApi, { authErrorCode, authErrorMessage } from "~/services/auth-api";

export function meta() {
	return [{ title: "Set up" }, { name: "robots", content: "noindex" }];
}

type FieldErrors = Partial<Record<"setupToken" | "name" | "email" | "password" | "confirm", string>>;

export default function SetupRoute() {
	const { data: state, isLoading } = useAuthState();

	const [setupToken, setSetupToken] = useState("");
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
	/** Open/click tracking for new mailboxes. On by default, for continuity. */
	const [trackingDefault, setTrackingDefault] = useState(true);
	const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const turnstile = useRef<TurnstileHandle>(null);
	const formRef = useRef<HTMLFormElement>(null);

	// Focus the first invalid field after a failed validation pass.
	useEffect(() => {
		const first = Object.keys(fieldErrors)[0];
		if (first) formRef.current?.querySelector<HTMLInputElement>(`[name="${first}"]`)?.focus();
	}, [fieldErrors]);

	if (isLoading) {
		return (
			<AuthShell title="Set up your mailbox">
				<AuthLoading label="Loading" />
			</AuthShell>
		);
	}

	if (state && (!state.setupRequired || state.mode === "access")) {
		return (
			<AuthShell
				title="Already set up"
				description={
					state.mode === "access"
						? "This deployment signs people in with Cloudflare Access, so there is no account to create here."
						: "The owner account already exists. Sign in to continue."
				}
			>
				<a
					href={state.mode === "access" ? "/" : "/login"}
					className="inline-flex h-10 w-full items-center justify-center rounded-[8px] bg-accent text-sm font-semibold text-accent-foreground hover:bg-accent-hover"
				>
					{state.mode === "access" ? "Open the app" : "Go to sign in"}
				</a>
			</AuthShell>
		);
	}

	const siteKey = state?.turnstileSiteKey ?? null;

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		const errors: FieldErrors = {};
		if (!setupToken.trim()) errors.setupToken = "Paste the setup token.";
		if (!name.trim()) errors.name = "Enter your name.";
		if (!looksLikeEmail(email)) errors.email = "Enter a valid email address.";
		if ([...password].length < PASSWORD_MIN_LENGTH)
			errors.password = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
		if (confirm !== password) errors.confirm = "The passwords don't match.";
		setFieldErrors(errors);
		if (Object.keys(errors).length > 0) return;
		if (siteKey && !turnstileToken) {
			setError("Complete the human check first.");
			return;
		}

		setPending(true);
		try {
			await authApi.setup({
				setupToken: setupToken.trim(),
				name: name.trim(),
				email: email.trim(),
				password,
				trackingDefault,
				...(turnstileToken ? { turnstileToken } : {}),
			});
			window.location.assign("/onboarding");
		} catch (err) {
			setPending(false);
			turnstile.current?.reset();
			const code = authErrorCode(err);
			if (code === "already_setup") {
				window.location.assign("/login");
				return;
			}
			if (code === "bad_setup_token") {
				setFieldErrors({ setupToken: authErrorMessage(err, "That setup token isn't right.") });
				return;
			}
			if (code === "weak_password") {
				setFieldErrors({ password: authErrorMessage(err, "Choose a stronger password.") });
				return;
			}
			setError(authErrorMessage(err, "Couldn't create the account. Try again."));
		}
	}

	return (
		<AuthShell
			wide
			title="Set up your mailbox"
			description="Create the owner account. The owner is always an administrator and can invite everyone else."
		>
			<FormNotice>
				<p className="font-medium text-text-primary">Where to find the setup token</p>
				{state?.setupTokenConfigured ? (
					<p className="mt-1">
						It's the value of the <code className="font-mono">SETUP_TOKEN</code> secret you set on
						this Worker.
					</p>
				) : (
					<>
						<p className="mt-1">
							No <code className="font-mono">SETUP_TOKEN</code> secret is configured, so the Worker
							generated one and printed it to its logs. Look for the line starting{" "}
							<code className="font-mono">[cloudmail] First-run setup is pending</code>:
						</p>
						<ul className="mt-1.5 list-disc space-y-0.5 pl-4">
							<li>
								Run <code className="font-mono">npx wrangler tail</code>, then reload this page, or
							</li>
							<li>Cloudflare dashboard → Workers &amp; Pages → this Worker → Logs.</li>
						</ul>
					</>
				)}
			</FormNotice>

			<form ref={formRef} onSubmit={onSubmit} noValidate className="space-y-4">
				<FormError message={error} />
				<Field
					label="Setup token"
					name="setupToken"
					autoComplete="off"
					autoCapitalize="none"
					spellCheck={false}
					// biome-ignore lint/a11y/noAutofocus: the first step of a single-task page.
					autoFocus
					value={setupToken}
					onChange={(e) => setSetupToken(e.target.value)}
					error={fieldErrors.setupToken}
					disabled={pending}
					className="font-mono text-xs"
					trailing={<Terminal size={14} className="mr-2 text-text-tertiary" aria-hidden />}
				/>

				<div className="grid gap-4 sm:grid-cols-2">
					<Field
						label="Your name"
						name="name"
						autoComplete="name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						error={fieldErrors.name}
						disabled={pending}
						maxLength={100}
					/>
					<Field
						label="Email"
						type="email"
						name="email"
						autoComplete="username"
						autoCapitalize="none"
						spellCheck={false}
						placeholder="you@example.com"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						error={fieldErrors.email}
						disabled={pending}
					/>
				</div>

				<PasswordField
					label="Password"
					name="password"
					autoComplete="new-password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					error={fieldErrors.password}
					hint={<PasswordStrengthMeter password={password} context={[name, email]} />}
					disabled={pending}
				/>
				<PasswordField
					label="Confirm password"
					name="confirm"
					autoComplete="new-password"
					value={confirm}
					onChange={(e) => setConfirm(e.target.value)}
					error={fieldErrors.confirm}
					disabled={pending}
				/>

				<fieldset className="space-y-2" disabled={pending}>
					<legend className="mb-1 text-[13px] font-medium text-text-primary">Open and click tracking</legend>
					<p className="text-xs text-text-secondary">
						For new mailboxes. Each mailbox can change it later, and recipients can opt out.
					</p>
					{(
						[
							[true, "On", "Measure opens and clicks of mail you send."],
							[false, "Off", "Send mail without a tracking image or wrapped links."],
						] as const
					).map(([value, label, hint]) => (
						<label
							key={label}
							className={`flex cursor-pointer items-start gap-2.5 rounded-[8px] px-3 py-2.5 ring-1 touch:min-h-11 ${
								trackingDefault === value ? "bg-accent-subtle ring-accent" : "ring-border hover:bg-bg-muted"
							}`}
						>
							<input
								type="radio"
								name="tracking-default"
								checked={trackingDefault === value}
								onChange={() => setTrackingDefault(value)}
								className="mt-0.5 accent-[var(--color-accent)]"
							/>
							<span className="min-w-0">
								<span className="block text-sm font-medium text-text-primary">{label}</span>
								<span className="block text-xs text-text-secondary">{hint}</span>
							</span>
						</label>
					))}
				</fieldset>

				{siteKey ? (
					<Turnstile
						ref={turnstile}
						siteKey={siteKey}
						action="setup"
						onToken={setTurnstileToken}
						onError={() => setError("The human check couldn't load. Reload the page and try again.")}
					/>
				) : null}

				<SubmitButton pending={pending} disabled={Boolean(siteKey) && !turnstileToken}>
					Create owner account
				</SubmitButton>
			</form>

			<p className="mt-4 text-center text-[11px] font-light text-text-tertiary">
				Already set up? <Link to="/login" className="font-medium text-text-secondary hover:underline">Sign in</Link>
			</p>
		</AuthShell>
	);
}
