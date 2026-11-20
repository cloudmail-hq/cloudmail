// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Small shared pieces for the account and user-management panels: a copy
 * button, a "shown once" secret box, a confirm dialog and form primitives that
 * match the existing settings cards.
 */

import { Check, Copy, Loader2 } from "lucide-react";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { toast } from "~/lib/toast";
import { cn } from "~/lib/utils";

export const SETTINGS_INPUT_CLASS =
	"h-9 w-full rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-violet/40 disabled:opacity-60 aria-[invalid=true]:border-destructive/60";

export const PRIMARY_BUTTON_CLASS =
	"inline-flex h-9 items-center gap-1.5 rounded-[6px] bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/60 disabled:opacity-50";

export const SECONDARY_BUTTON_CLASS =
	"inline-flex h-9 items-center gap-1.5 rounded-[6px] bg-card px-3.5 text-[13px] font-medium text-text-primary ring-1 ring-border hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/60 disabled:opacity-50";

export const DANGER_BUTTON_CLASS =
	"inline-flex h-9 items-center gap-1.5 rounded-[6px] bg-card px-3.5 text-[13px] font-medium text-destructive ring-1 ring-destructive/30 hover:bg-destructive-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50 disabled:opacity-50";

export const ROW_ACTION_CLASS =
	"rounded-[6px] px-2 py-1 text-[13px] font-medium text-text-secondary hover:bg-bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/50 disabled:opacity-50";

/** Icon-only row action (rename, revoke). 28px on desktop, 44px on touch. */
export const ROW_ICON_ACTION_CLASS =
	"inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-text-tertiary hover:bg-bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/50 disabled:opacity-50";

/**
 * One row of an account list: sessions, passkeys, API tokens, connected apps.
 *
 * These were a single wrapping flex line, so where the action landed depended
 * on how long the name and details were: on a phone the details collapsed to
 * a zero-width truncation and the button dropped to its own line, left-aligned
 * under nothing. Now the title line and the details line stack on the left and
 * the actions are pinned top-right, so every row has the same shape at every
 * width.
 */
export function ListRow({
	icon,
	title,
	badges,
	details,
	actions,
}: {
	icon?: React.ReactNode;
	title: React.ReactNode;
	badges?: React.ReactNode;
	/** Short facts ("used 2 days ago"), joined with dots. */
	details?: (string | null | undefined | false)[];
	actions?: React.ReactNode;
}) {
	const facts = (details ?? []).filter((d): d is string => !!d);
	return (
		<li className="flex items-start gap-3 rounded-[8px] bg-bg-subtle px-3 py-2.5">
			{icon ? (
				<span className="mt-0.5 shrink-0 text-text-tertiary" aria-hidden>
					{icon}
				</span>
			) : null}
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
					<span className="min-w-0 break-words text-sm font-medium text-text-primary">
						{title}
					</span>
					{badges}
				</div>
				{facts.length > 0 ? (
					// Each fact is unbreakable, so lines wrap between facts rather
					// than leaving "ago" or a dangling "·" alone on a line.
					<p className="mt-0.5 text-xs text-text-secondary">
						{facts.map((part, i) => (
							// The space between spans is the only break opportunity;
							// the dot stays with the fact before it, so a wrapped line
							// never starts with one.
							<Fragment key={i}>
								{i > 0 ? " " : null}
								<span className="whitespace-nowrap">
									{part}
									{i < facts.length - 1 ? <span aria-hidden>{" ·"}</span> : null}
								</span>
							</Fragment>
						))}
					</p>
				) : null}
			</div>
			{actions ? (
				<div className="-my-1 -mr-1 flex shrink-0 items-center gap-0.5">{actions}</div>
			) : null}
		</li>
	);
}

/** Section heading row, matching the other settings sections. */
export function SectionHeading({
	icon: Icon,
	title,
	busy,
	children,
}: {
	icon: React.ElementType;
	title: string;
	busy?: boolean;
	children?: React.ReactNode;
}) {
	return (
		<div className="flex items-center gap-2">
			<Icon size={14} className="text-text-tertiary" aria-hidden />
			<h2 className="text-base font-semibold text-text-primary">{title}</h2>
			{busy ? (
				<Loader2 size={12} className="animate-spin text-text-tertiary" aria-label="Working" />
			) : null}
			{children ? <div className="ml-auto">{children}</div> : null}
		</div>
	);
}

/** Labelled input for settings forms. */
export function SettingsField({
	label,
	hint,
	error,
	className,
	inputClassName,
	...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
	label: string;
	hint?: React.ReactNode;
	error?: string | null;
	inputClassName?: string;
}) {
	const id = useId();
	const hintId = `${id}-hint`;
	const errorId = `${id}-error`;
	return (
		<div className={cn("space-y-1.5", className)}>
			<label htmlFor={id} className="block text-[11px] font-medium text-text-secondary">
				{label}
			</label>
			<input
				id={id}
				aria-invalid={error ? true : undefined}
				aria-describedby={[hint ? hintId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined}
				className={cn(SETTINGS_INPUT_CLASS, inputClassName)}
				{...props}
			/>
			{error ? (
				<p id={errorId} className="text-[11px] text-destructive">
					{error}
				</p>
			) : null}
			{hint ? (
				<div id={hintId} className="text-xs text-text-tertiary">
					{hint}
				</div>
			) : null}
		</div>
	);
}

/** Inline error announced as it appears. */
export function InlineError({ message }: { message: string | null }) {
	return (
		<div aria-live="assertive" aria-atomic="true">
			{message ? (
				<p role="alert" className="text-xs text-destructive">
					{message}
				</p>
			) : null}
		</div>
	);
}

export async function copyText(text: string, what = "Copied"): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		toast.success(`${what} to the clipboard`);
		return true;
	} catch {
		toast.error("Couldn't copy. Select the text and copy it manually.");
		return false;
	}
}

export function CopyButton({
	text,
	label = "Copy",
	what,
	className,
}: {
	text: string;
	label?: string;
	what?: string;
	className?: string;
}) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const t = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(t);
	}, [copied]);
	return (
		<button
			type="button"
			onClick={async () => setCopied(await copyText(text, what))}
			className={cn(SECONDARY_BUTTON_CLASS, "h-8", className)}
		>
			{copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
			{copied ? "Copied" : label}
		</button>
	);
}

/**
 * A secret the server returns exactly once (an API token, an invite or reset
 * link). Selected on focus so it is easy to copy by hand too.
 */
export function SecretBox({
	label,
	value,
	what,
	note,
	children,
}: {
	label: string;
	value: string;
	what?: string;
	note?: React.ReactNode;
	children?: React.ReactNode;
}) {
	const ref = useRef<HTMLInputElement>(null);
	const id = useId();
	useEffect(() => {
		ref.current?.focus();
		ref.current?.select();
	}, [value]);
	return (
		<div className="space-y-2 rounded-[6px] bg-accent-subtle/60 p-3 ring-1 ring-accent/25" role="status">
			<label htmlFor={id} className="block text-xs font-medium text-text-primary">
				{label}
			</label>
			<div className="flex items-center gap-2">
				<input
					id={id}
					ref={ref}
					readOnly
					value={value}
					onFocus={(e) => e.currentTarget.select()}
					spellCheck={false}
					className={cn(SETTINGS_INPUT_CLASS, "bg-card font-mono text-xs")}
				/>
				<CopyButton text={value} what={what} />
			</div>
			{note ? <p className="text-xs text-text-secondary">{note}</p> : null}
			{children}
		</div>
	);
}

/** A confirm dialog for destructive actions. */
export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel,
	onConfirm,
	pending,
	destructive = true,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: React.ReactNode;
	confirmLabel: string;
	onConfirm: () => void;
	pending?: boolean;
	destructive?: boolean;
	children?: React.ReactNode;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle className="text-base">{title}</DialogTitle>
					<DialogDescription className="text-xs">{description}</DialogDescription>
				</DialogHeader>
				{children}
				<DialogFooter className="gap-2">
					<button
						type="button"
						onClick={() => onOpenChange(false)}
						className={SECONDARY_BUTTON_CLASS}
						disabled={pending}
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={onConfirm}
						disabled={pending}
						className={cn(
							"inline-flex h-9 items-center gap-1.5 rounded-[6px] px-3 text-xs font-semibold text-white focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50",
							destructive
								? "bg-destructive hover:opacity-90 focus-visible:ring-destructive/50"
								: "bg-accent text-accent-foreground hover:bg-accent-hover",
						)}
					>
						{pending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
						{confirmLabel}
					</button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * The status line for an autosaving settings page: "Saving…", then "Saved",
 * or "Not saved" if the write failed. Announced politely, so a screen reader
 * hears each change land without the focus moving.
 */
export function SaveStatus({
	status,
	className,
}: {
	status: "idle" | "pending" | "success" | "error";
	className?: string;
}) {
	return (
		<span
			role="status"
			aria-live="polite"
			className={cn("inline-flex items-center gap-1 text-xs text-text-tertiary", className)}
		>
			{status === "pending" ? (
				<>
					<Loader2 size={12} className="animate-spin" aria-hidden />
					Saving…
				</>
			) : status === "success" ? (
				<>
					<Check size={12} className="text-success" aria-hidden />
					Saved
				</>
			) : status === "error" ? (
				<span className="text-destructive">Not saved</span>
			) : null}
		</span>
	);
}

/** Small pill used for owner / admin / 2FA / disabled markers. */
export function Pill({
	children,
	tone = "muted",
}: {
	children: React.ReactNode;
	tone?: "muted" | "admin" | "success" | "warning" | "violet";
}) {
	return (
		<span
			className={cn(
				// One badge shape everywhere: sentence case, full radius. Role is
				// not an error, so "admin" is an outline rather than red.
				"shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4",
				tone === "muted" && "bg-bg-muted text-text-secondary dark:ring-1 dark:ring-inset dark:ring-border",
				tone === "admin" && "border border-border text-text-secondary",
				// No tinted fill: success text on a 10% green tint over the grey
				// row was 4.34:1. On the row's own surface it is 4.8:1 or better.
				tone === "success" && "text-success ring-1 ring-inset ring-success/40",
				tone === "warning" && "bg-warning-bg text-warning-text",
				tone === "violet" && "bg-accent-subtle text-accent-subtle-fg",
			)}
		>
			{children}
		</span>
	);
}
