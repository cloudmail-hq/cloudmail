// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Building blocks shared by the public auth pages: `/login`, `/setup`,
 * `/invite/:token`, `/reset/:token` and `/recover`.
 *
 * These render without a session, so nothing here may read `/api/v1/*` other
 * than branding (which the Worker serves publicly enough to name the app, and
 * which the global 401 handler ignores on public pages anyway).
 */

import { AlertCircle, CheckCircle2, Eye, EyeOff, Loader2 } from "lucide-react";
import { BrandMark } from "~/components/ui/brand-mark";
import { forwardRef, useEffect, useId, useRef, useState } from "react";
import { brandingLogoUrl, useBranding } from "~/queries/branding";
import { passwordStrength, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "~/lib/auth-helpers";
import { cn } from "~/lib/utils";

/** The centred card every public auth page sits in. */
export function AuthShell({
	title,
	description,
	children,
	footer,
	wide,
}: {
	title: string;
	description?: React.ReactNode;
	children: React.ReactNode;
	footer?: React.ReactNode;
	wide?: boolean;
}) {
	const { data: branding } = useBranding();
	const logoUrl = brandingLogoUrl(branding);
	const appName = branding?.appName ?? "cloudmail";
	const headingRef = useRef<HTMLHeadingElement>(null);

	// Move focus to the heading when the step changes (e.g. password -> MFA), so
	// a screen reader announces the new step instead of staying on a button
	// that no longer exists. Skipped on first mount so a page's `autoFocus`
	// field keeps focus.
	const mounted = useRef(false);
	useEffect(() => {
		if (!mounted.current) {
			mounted.current = true;
			return;
		}
		headingRef.current?.focus({ preventScroll: true });
	}, [title]);

	return (
		<div className="relative flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-10">

			<main className={cn("relative z-10 w-full", wide ? "max-w-lg" : "max-w-sm")}>
				<div className="mb-6 flex items-center justify-center gap-2">
					{logoUrl ? (
						<img src={logoUrl} alt="" className="h-7 w-auto max-w-[140px] object-contain" />
					) : (
						<BrandMark className="h-8 w-8" />
					)}
					<span className="text-base font-semibold tracking-tight text-text-primary">
						{appName}
					</span>
				</div>

				<div className="rounded-[12px] bg-card p-6 shadow-sm ring-1 ring-border sm:p-7">
					<h1
						ref={headingRef}
						tabIndex={-1}
						className="text-xl font-semibold tracking-tight text-text-primary focus:outline-none"
					>
						{title}
					</h1>
					{description ? (
						<div className="mt-1.5 text-sm font-light text-text-secondary">{description}</div>
					) : null}
					<div className="mt-5">{children}</div>
				</div>

				{footer ? (
					<div className="mt-5 text-center text-xs font-light text-text-secondary">{footer}</div>
				) : null}
				{/* A plain link: /privacy is a Worker page, not a client route. */}
				<p className="mt-4 text-center text-xs font-light text-text-tertiary">
					<a href="/privacy" className="font-medium text-text-secondary underline-offset-2 hover:text-text-primary hover:underline">
						Privacy notice
					</a>
				</p>
			</main>
		</div>
	);
}

/** Error banner. `role="alert"` so it is announced the moment it appears. */
export function FormError({ message, id }: { message: string | null; id?: string }) {
	return (
		<div id={id} aria-live="assertive" aria-atomic="true">
			{message ? (
				<div
					role="alert"
					className="mb-4 flex items-start gap-2 rounded-[8px] bg-destructive-subtle px-3 py-2.5 text-xs text-destructive ring-1 ring-destructive/20"
				>
					<AlertCircle size={14} className="mt-px shrink-0" aria-hidden />
					<span>{message}</span>
				</div>
			) : null}
		</div>
	);
}

/** Success / information banner, announced politely. */
export function FormNotice({
	children,
	tone = "info",
}: {
	children: React.ReactNode;
	tone?: "info" | "success" | "warning";
}) {
	return (
		<div
			role="status"
			className={cn(
				"mb-4 flex items-start gap-2 rounded-[8px] px-3 py-2.5 text-xs ring-1",
				tone === "success" && "bg-accent-subtle text-accent-subtle-fg ring-accent/20",
				tone === "info" && "bg-bg-subtle text-text-secondary ring-border",
				tone === "warning" && "bg-warning-bg text-warning-text ring-warning-border",
			)}
		>
			{tone === "success" ? (
				<CheckCircle2 size={14} className="mt-px shrink-0" aria-hidden />
			) : (
				<AlertCircle size={14} className="mt-px shrink-0" aria-hidden />
			)}
			<div className="min-w-0">{children}</div>
		</div>
	);
}

export const AUTH_INPUT_CLASS =
	"block h-10 w-full rounded-[8px] bg-bg-subtle px-3 text-sm text-text-primary ring-1 ring-border transition-shadow placeholder:text-text-tertiary focus:bg-card focus:outline-none focus:ring-2 focus:ring-violet/50 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:ring-destructive/60";

type FieldProps = React.InputHTMLAttributes<HTMLInputElement> & {
	label: string;
	hint?: React.ReactNode;
	/** Inline error for this field. Wired to `aria-invalid` + `aria-describedby`. */
	error?: string | null;
	trailing?: React.ReactNode;
};

/** A labelled text input with an optional hint and inline error. */
export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
	{ label, hint, error, trailing, className, id: idProp, ...props },
	ref,
) {
	const generated = useId();
	const id = idProp ?? generated;
	const hintId = `${id}-hint`;
	const errorId = `${id}-error`;
	const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");

	return (
		<div className="space-y-1.5">
			<label htmlFor={id} className="block text-xs font-medium text-text-primary">
				{label}
			</label>
			<div className="relative">
				<input
					ref={ref}
					id={id}
					aria-invalid={error ? true : undefined}
					aria-describedby={describedBy || undefined}
					className={cn(AUTH_INPUT_CLASS, trailing ? "pr-10" : "", className)}
					{...props}
				/>
				{trailing ? (
					<div className="absolute inset-y-0 right-1 flex items-center">{trailing}</div>
				) : null}
			</div>
			{error ? (
				<p id={errorId} className="text-[11px] text-destructive">
					{error}
				</p>
			) : null}
			{hint ? (
				<div id={hintId} className="text-[11px] font-light text-text-tertiary">
					{hint}
				</div>
			) : null}
		</div>
	);
});

/** Password input with a show/hide toggle. */
export const PasswordField = forwardRef<
	HTMLInputElement,
	Omit<FieldProps, "type" | "trailing">
>(function PasswordField(props, ref) {
	const [visible, setVisible] = useState(false);
	return (
		<Field
			ref={ref}
			type={visible ? "text" : "password"}
			spellCheck={false}
			autoCapitalize="none"
			maxLength={PASSWORD_MAX_LENGTH}
			trailing={
				<button
					type="button"
					onClick={() => setVisible((v) => !v)}
					aria-label={visible ? "Hide password" : "Show password"}
					aria-pressed={visible}
					className="rounded-[6px] p-2 text-text-tertiary hover:bg-bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/50"
				>
					{visible ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
				</button>
			}
			{...props}
		/>
	);
});

/** Strength meter for a new password. Advisory; the server enforces length. */
export function PasswordStrengthMeter({
	password,
	context,
}: {
	password: string;
	context?: string[];
}) {
	if (!password) {
		return (
			<span>
				At least {PASSWORD_MIN_LENGTH} characters. A short phrase of unrelated words works well.
			</span>
		);
	}
	const strength = passwordStrength(password, context);
	const colours = [
		"bg-destructive",
		"bg-destructive",
		"bg-warning-text",
		"bg-success",
		"bg-success",
	];
	return (
		<div className="space-y-1.5">
			<div className="flex items-center gap-2">
				<div className="flex flex-1 gap-1" aria-hidden>
					{[1, 2, 3, 4].map((step) => (
						<span
							key={step}
							className={cn(
								"h-1 flex-1 rounded-full transition-colors",
								strength.score >= step ? colours[strength.score] : "bg-bg-muted",
							)}
						/>
					))}
				</div>
				<span
					className={cn(
						"text-[11px] font-medium",
						strength.score <= 1 ? "text-destructive" : strength.score === 2 ? "text-warning-text" : "text-success",
					)}
				>
					{strength.label}
				</span>
			</div>
			{strength.hints[0] ? <p>{strength.hints[0]}</p> : null}
		</div>
	);
}

export function SubmitButton({
	children,
	pending,
	disabled,
	className,
}: {
	children: React.ReactNode;
	pending?: boolean;
	disabled?: boolean;
	className?: string;
}) {
	return (
		<button
			type="submit"
			disabled={pending || disabled}
			aria-busy={pending || undefined}
			className={cn(
				"inline-flex h-10 w-full items-center justify-center gap-2 rounded-[8px] bg-accent px-4 text-sm font-semibold text-accent-foreground shadow-sm transition-opacity hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/60 focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
		>
			{pending ? <Loader2 size={15} className="animate-spin" aria-hidden /> : null}
			{children}
		</button>
	);
}

/** Full-card loading state while a token is being checked. */
export function AuthLoading({ label }: { label: string }) {
	return (
		<div role="status" className="flex items-center justify-center gap-2 py-8 text-sm text-text-secondary">
			<Loader2 size={16} className="animate-spin" aria-hidden />
			{label}
		</div>
	);
}
