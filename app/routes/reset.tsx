// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Set a new password from a reset link, admin-issued or emailed from /forgot.
 *
 * Resetting signs the account out everywhere, so success sends the reader to
 * sign in with the new password rather than straight into the app.
 */

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
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
import { PASSWORD_MIN_LENGTH } from "~/lib/auth-helpers";
import authApi, { authErrorCode, authErrorMessage } from "~/services/auth-api";

export function meta() {
	return [{ title: "Reset password" }, { name: "robots", content: "noindex" }];
}

export default function ResetRoute() {
	const { token = "" } = useParams();
	const reset = useQuery({
		queryKey: ["auth", "reset", token],
		queryFn: ({ signal }) => authApi.getReset(token, { signal }),
		enabled: Boolean(token),
		staleTime: Infinity,
	});

	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [fieldErrors, setFieldErrors] = useState<{ password?: string; confirm?: string }>({});
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [done, setDone] = useState(false);

	if (reset.isLoading) {
		return (
			<AuthShell title="Reset your password">
				<AuthLoading label="Checking your link" />
			</AuthShell>
		);
	}

	if (done) {
		return (
			<AuthShell title="Password updated">
				<FormNotice tone="success">
					Your password has been changed and every existing session was signed out.
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

	if (reset.isError || !reset.data) {
		return (
			<AuthShell
				title="This link can't be used"
				description="Reset links work once and expire (emailed links after 30 minutes, admin links after an hour). Request a new one or ask an administrator."
			>
				<Link
					to="/login"
					className="inline-flex h-10 w-full items-center justify-center rounded-[8px] bg-accent text-sm font-semibold text-accent-foreground hover:bg-accent-hover"
				>
					Go to sign in
				</Link>
			</AuthShell>
		);
	}

	const { email } = reset.data;

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		const errors: typeof fieldErrors = {};
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
			await authApi.resetPassword({ token, password });
			setDone(true);
		} catch (err) {
			setPending(false);
			if (authErrorCode(err) === "weak_password") {
				setFieldErrors({ password: authErrorMessage(err, "Choose a stronger password.") });
				return;
			}
			setError(authErrorMessage(err, "Couldn't reset the password. Try again."));
		}
	}

	return (
		<AuthShell
			title="Reset your password"
			description="Choose a new password. You'll be signed out on every device."
		>
			<form onSubmit={onSubmit} noValidate className="space-y-4">
				<FormError message={error} />
				<Field
					label="Email"
					type="email"
					name="email"
					autoComplete="username"
					value={email}
					readOnly
					aria-readonly="true"
					className="text-text-secondary"
				/>
				<PasswordField
					label="New password"
					name="password"
					autoComplete="new-password"
					// biome-ignore lint/a11y/noAutofocus: the only field to fill in.
					autoFocus
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					error={fieldErrors.password}
					hint={<PasswordStrengthMeter password={password} context={[email]} />}
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
				<SubmitButton pending={pending}>Set new password</SubmitButton>
			</form>
		</AuthShell>
	);
}
