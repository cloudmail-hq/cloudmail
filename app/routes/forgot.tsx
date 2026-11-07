// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Forgot password: ask for a reset link by email.
 *
 * Public. The server answers the same way whether or not the address has an
 * account, so the success state can only ever say "if an account exists". The
 * link itself opens `/reset/:token`, which handles the rest.
 *
 * When the deployment cannot send email (no sender address), this page says
 * so and points at the administrator, rather than offering a form that would
 * quietly send nothing.
 */

import { useRef, useState } from "react";
import { Link } from "react-router";
import {
	AuthLoading,
	AuthShell,
	Field,
	FormError,
	FormNotice,
	SubmitButton,
} from "~/components/auth/AuthShell";
import { Turnstile, type TurnstileHandle } from "~/components/auth/Turnstile";
import { looksLikeEmail } from "~/lib/auth-helpers";
import { useAuthState } from "~/queries/auth";
import authApi, { authErrorMessage } from "~/services/auth-api";

export function meta() {
	return [{ title: "Forgot password" }, { name: "robots", content: "noindex" }];
}

const BACK_LINK =
	"inline-flex h-10 w-full items-center justify-center rounded-[8px] bg-accent text-sm font-semibold text-accent-foreground hover:bg-accent-hover";

export default function ForgotRoute() {
	const { data: state, isLoading } = useAuthState();
	const [email, setEmail] = useState("");
	const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
	const [turnstileBroken, setTurnstileBroken] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [sent, setSent] = useState(false);
	const turnstile = useRef<TurnstileHandle>(null);
	const emailRef = useRef<HTMLInputElement>(null);

	const siteKey = state?.turnstileSiteKey ?? null;

	if (isLoading) {
		return (
			<AuthShell title="Forgot password">
				<AuthLoading label="Loading" />
			</AuthShell>
		);
	}

	if (sent) {
		return (
			<AuthShell title="Check your email">
				<FormNotice tone="success">
					If an account exists for that address, we've sent a link to reset its password. The
					link expires in 30 minutes.
				</FormNotice>
				<Link to="/login" className={BACK_LINK}>
					Back to sign in
				</Link>
			</AuthShell>
		);
	}

	if (!state?.passwordResetByEmail) {
		return (
			<AuthShell title="Forgot password">
				<FormNotice>
					This deployment can't send reset emails. Ask an administrator for a reset link.
				</FormNotice>
				<Link to="/login" className={BACK_LINK}>
					Back to sign in
				</Link>
			</AuthShell>
		);
	}

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!looksLikeEmail(email)) {
			setError("Enter the email address for your account.");
			emailRef.current?.focus();
			return;
		}
		if (siteKey && !turnstileToken) {
			setError("Complete the human check first.");
			return;
		}
		setPending(true);
		try {
			await authApi.forgotPassword({
				email: email.trim(),
				...(turnstileToken ? { turnstileToken } : {}),
			});
			setSent(true);
		} catch (err) {
			setPending(false);
			setError(authErrorMessage(err, "Couldn't send the link. Try again."));
			// Turnstile tokens are single-use.
			turnstile.current?.reset();
		}
	}

	return (
		<AuthShell
			title="Forgot password"
			description="Enter your account's email address and we'll send you a link to choose a new password."
			footer={
				<Link
					to="/login"
					className="font-medium text-text-secondary underline-offset-2 hover:text-text-primary hover:underline"
				>
					Back to sign in
				</Link>
			}
		>
			<form onSubmit={onSubmit} noValidate className="space-y-4">
				<FormError message={error} />
				<Field
					ref={emailRef}
					label="Email"
					type="email"
					name="email"
					autoComplete="username"
					autoCapitalize="none"
					spellCheck={false}
					// biome-ignore lint/a11y/noAutofocus: the only field on this page.
					autoFocus
					required
					placeholder="you@example.com"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					disabled={pending}
				/>
				{siteKey ? (
					<div className="space-y-1">
						<Turnstile
							ref={turnstile}
							siteKey={siteKey}
							action="forgot"
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
				<SubmitButton pending={pending} disabled={Boolean(siteKey) && !turnstileToken}>
					Send reset link
				</SubmitButton>
			</form>
		</AuthShell>
	);
}
