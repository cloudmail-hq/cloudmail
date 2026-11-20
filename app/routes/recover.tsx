// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Owner break-glass recovery.
 *
 * For the owner who has lost their password or authenticator: proving control
 * of the Worker (the `SETUP_TOKEN` secret) resets the owner's password, turns
 * off their two-factor sign-in and signs them out everywhere.
 */

import { useState } from "react";
import { Link } from "react-router";
import {
	AuthShell,
	Field,
	FormError,
	FormNotice,
	PasswordField,
	PasswordStrengthMeter,
	SubmitButton,
} from "~/components/auth/AuthShell";
import { PASSWORD_MIN_LENGTH } from "~/lib/auth-helpers";
import authApi, { authErrorCode, authErrorMessage } from "~/services/auth-api";

export function meta() {
	return [{ title: "Owner recovery" }, { name: "robots", content: "noindex" }];
}

export default function RecoverRoute() {
	const [setupToken, setSetupToken] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [fieldErrors, setFieldErrors] = useState<{
		setupToken?: string;
		password?: string;
		confirm?: string;
	}>({});
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [done, setDone] = useState(false);

	if (done) {
		return (
			<AuthShell title="Owner account recovered">
				<FormNotice tone="success">
					The owner password has been reset, two-factor sign-in was turned off, and every session
					was signed out. Sign in, then set up two-factor again from Settings.
				</FormNotice>
				<Link
					to="/login"
					className="inline-flex h-10 w-full items-center justify-center rounded-[8px] bg-accent text-sm font-semibold text-accent-foreground hover:bg-accent-hover"
				>
					Sign in
				</Link>
			</AuthShell>
		);
	}

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		const errors: typeof fieldErrors = {};
		if (!setupToken.trim()) errors.setupToken = "Paste the SETUP_TOKEN secret.";
		if ([...password].length < PASSWORD_MIN_LENGTH)
			errors.password = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
		if (confirm !== password) errors.confirm = "The passwords don't match.";
		setFieldErrors(errors);
		if (Object.keys(errors).length > 0) {
			document
				.querySelector<HTMLInputElement>(`[name="${Object.keys(errors)[0]}"]`)
				?.focus();
			return;
		}
		setPending(true);
		try {
			await authApi.recover({ setupToken: setupToken.trim(), password });
			setDone(true);
		} catch (err) {
			setPending(false);
			const code = authErrorCode(err);
			if (code === "bad_setup_token") {
				setFieldErrors({ setupToken: authErrorMessage(err, "That token isn't right.") });
				return;
			}
			if (code === "weak_password") {
				setFieldErrors({ password: authErrorMessage(err, "Choose a stronger password.") });
				return;
			}
			setError(authErrorMessage(err, "Recovery failed. Try again."));
		}
	}

	return (
		<AuthShell
			title="Owner recovery"
			description="Locked out of the owner account? Reset it with the Worker's setup token."
			footer={
				<Link to="/login" className="font-medium text-text-secondary hover:text-text-primary hover:underline">
					Back to sign in
				</Link>
			}
		>
			<FormNotice>
				This only works when the <code className="font-mono">SETUP_TOKEN</code> secret is set on the
				Worker (<code className="font-mono">npx wrangler secret put SETUP_TOKEN</code>). Other users
				should ask an administrator for a reset link instead.
			</FormNotice>
			<form onSubmit={onSubmit} noValidate className="space-y-4">
				<FormError message={error} />
				<Field
					label="Setup token"
					name="setupToken"
					autoComplete="off"
					autoCapitalize="none"
					spellCheck={false}
					// biome-ignore lint/a11y/noAutofocus: the first field to fill in.
					autoFocus
					value={setupToken}
					onChange={(e) => setSetupToken(e.target.value)}
					error={fieldErrors.setupToken}
					disabled={pending}
					className="font-mono text-xs"
				/>
				<PasswordField
					label="New owner password"
					name="password"
					autoComplete="new-password"
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					error={fieldErrors.password}
					hint={<PasswordStrengthMeter password={password} />}
					disabled={pending}
				/>
				<PasswordField
					label="Confirm new password"
					name="confirm"
					autoComplete="new-password"
					value={confirm}
					onChange={(e) => setConfirm(e.target.value)}
					error={fieldErrors.confirm}
					disabled={pending}
				/>
				<SubmitButton pending={pending}>Reset owner account</SubmitButton>
			</form>
		</AuthShell>
	);
}
