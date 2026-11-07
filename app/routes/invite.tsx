// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Accept an invite: choose a name and password, and get signed in. */

import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link, useParams } from "react-router";
import {
	AuthLoading,
	AuthShell,
	Field,
	FormError,
	PasswordField,
	PasswordStrengthMeter,
	SubmitButton,
} from "~/components/auth/AuthShell";
import { Turnstile, type TurnstileHandle } from "~/components/auth/Turnstile";
import { PASSWORD_MIN_LENGTH } from "~/lib/auth-helpers";
import { useAuthState } from "~/queries/auth";
import authApi, { authErrorCode, authErrorMessage } from "~/services/auth-api";

export function meta() {
	return [{ title: "Accept invite" }, { name: "robots", content: "noindex" }];
}

export default function InviteRoute() {
	const { token = "" } = useParams();
	const { data: state } = useAuthState();
	const invite = useQuery({
		queryKey: ["auth", "invite", token],
		queryFn: ({ signal }) => authApi.getInvite(token, { signal }),
		enabled: Boolean(token),
		staleTime: Infinity,
	});

	const [name, setName] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
	const [fieldErrors, setFieldErrors] = useState<{ name?: string; password?: string; confirm?: string }>({});
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const turnstile = useRef<TurnstileHandle>(null);
	const siteKey = state?.turnstileSiteKey ?? null;

	if (invite.isLoading) {
		return (
			<AuthShell title="Accept your invite">
				<AuthLoading label="Checking your invite" />
			</AuthShell>
		);
	}

	if (invite.isError || !invite.data) {
		return (
			<AuthShell
				title="This invite can't be used"
				description="It may have expired, been revoked, or already been accepted. Ask whoever invited you for a new link."
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

	const { email, role, expiresAt } = invite.data;

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		const errors: typeof fieldErrors = {};
		if (!name.trim()) errors.name = "Enter your name.";
		if ([...password].length < PASSWORD_MIN_LENGTH)
			errors.password = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
		if (confirm !== password) errors.confirm = "The passwords don't match.";
		setFieldErrors(errors);
		if (Object.keys(errors).length > 0) {
			const first = Object.keys(errors)[0];
			document.querySelector<HTMLInputElement>(`[name="${first}"]`)?.focus();
			return;
		}
		if (siteKey && !turnstileToken) {
			setError("Complete the human check first.");
			return;
		}

		setPending(true);
		try {
			await authApi.acceptInvite({
				token,
				name: name.trim(),
				password,
				...(turnstileToken ? { turnstileToken } : {}),
			});
			window.location.assign("/");
		} catch (err) {
			setPending(false);
			turnstile.current?.reset();
			if (authErrorCode(err) === "weak_password") {
				setFieldErrors({ password: authErrorMessage(err, "Choose a stronger password.") });
				return;
			}
			setError(authErrorMessage(err, "Couldn't accept the invite. Try again."));
		}
	}

	return (
		<AuthShell
			title="Accept your invite"
			description={
				<>
					You've been invited as {role === "admin" ? "an " : "a "}
					<span className="font-medium text-text-primary">{role}</span>. Choose a password to finish
					creating your account.
				</>
			}
			footer={<span>This invite expires {new Date(expiresAt).toLocaleString()}.</span>}
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
				<Field
					label="Your name"
					name="name"
					autoComplete="name"
					// biome-ignore lint/a11y/noAutofocus: the first field to fill in.
					autoFocus
					value={name}
					onChange={(e) => setName(e.target.value)}
					error={fieldErrors.name}
					disabled={pending}
					maxLength={100}
				/>
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
				{siteKey ? (
					<Turnstile
						ref={turnstile}
						siteKey={siteKey}
						action="invite"
						onToken={setTurnstileToken}
						onError={() => setError("The human check couldn't load. Reload the page and try again.")}
					/>
				) : null}
				<SubmitButton pending={pending} disabled={Boolean(siteKey) && !turnstileToken}>
					Create account
				</SubmitButton>
			</form>
		</AuthShell>
	);
}
