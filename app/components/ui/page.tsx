import * as React from "react";
import { ModuleTitle } from "~/components/ModuleBar";
import { cn } from "~/lib/utils";

/**
 * The one content column for every page that is not the mail workspace.
 *
 * Pages used to choose their own: 1200px for Templates, Sequences, Analytics
 * and Settings, 1000px for the template editor, 768px for Mailboxes. Moving
 * between them shifted the title, the primary button and the left edge of the
 * content each time. One width and one padding keep all three still.
 *
 * `narrow` is for pages that are a single short column, like the mailbox list.
 * They centre at 768px rather than hugging the left of a 1120px column with
 * nothing on the right.
 */
export function PageContainer({
	className,
	narrow = false,
	children,
	...props
}: React.HTMLAttributes<HTMLDivElement> & { narrow?: boolean }) {
	return (
		<div
			className={cn(
				"mx-auto w-full px-4 py-6 md:px-8 md:py-8",
				narrow ? "max-w-[832px]" : "max-w-[1120px]",
				className,
			)}
			{...props}
		>
			{children}
		</div>
	);
}

/**
 * Title, one line of description and the page's actions, in that order.
 *
 * Actions sit on the title's baseline at the right, so the primary button is
 * always in the same place from page to page.
 */
export function PageHeader({
	title,
	description,
	actions,
	phoneActions,
	icon,
	className,
}: {
	title: string;
	description?: React.ReactNode;
	actions?: React.ReactNode;
	/** Compact (icon) versions of `actions` for the phone's 48px module bar. */
	phoneActions?: React.ReactNode;
	/** The module's icon, leading the phone module bar like the pane toggle elsewhere. */
	icon?: React.ElementType;
	className?: string;
}) {
	return (
		<>
			{/*
			  Phone: the module bar, the same 48px row under the top bar that Mail,
			  Settings and Analytics show (see `ModuleBar`), so every page starts at
			  the same height. Flush with the page edges, cancelling the container's
			  padding; sticky, like theirs.
			*/}
			<div
				data-module-bar
				className="sticky top-[var(--app-topbar-h)] z-20 -mx-4 -mt-6 mb-4 flex h-12 items-center gap-2 border-b border-border bg-card px-2 md:hidden"
			>
				<div className="min-w-0 flex-1">
					<ModuleTitle label={title} icon={icon} />
				</div>
				{(phoneActions ?? actions) && (
					<div className="flex shrink-0 items-center gap-1">{phoneActions ?? actions}</div>
				)}
			</div>
			{description && <p className="mb-4 text-sm text-text-secondary md:hidden">{description}</p>}

			<div className={cn("mb-6 hidden flex-wrap items-end justify-between gap-x-4 gap-y-3 md:flex", className)}>
				<div className="min-w-0">
					<h1 className="text-2xl font-semibold tracking-tight text-text-primary">{title}</h1>
					{description && <p className="mt-1 max-w-2xl text-sm text-text-secondary">{description}</p>}
				</div>
				{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
			</div>
		</>
	);
}

/**
 * Icon, one line of what goes here, one line of why, and the action that fills
 * it. The action is the page's primary CTA while the list is empty, so pages
 * hide their header button until there is something to list.
 */
export function EmptyState({
	icon,
	title,
	description,
	action,
	className,
}: {
	icon: React.ReactNode;
	title: React.ReactNode;
	description?: React.ReactNode;
	action?: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex flex-col items-center justify-center rounded-[8px] border border-border bg-card px-6 py-14 text-center",
				className,
			)}
		>
			<span
				className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-accent-subtle text-accent-subtle-fg [&_svg]:size-5"
				aria-hidden
			>
				{icon}
			</span>
			<p className="text-base font-semibold text-text-primary">{title}</p>
			{description && (
				<p className="mt-1 max-w-sm text-sm text-text-secondary">{description}</p>
			)}
			{action && <div className="mt-5">{action}</div>}
		</div>
	);
}
