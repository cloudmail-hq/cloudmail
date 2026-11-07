import { useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Link } from "react-router";
import { ChevronDown, LayoutGrid, PanelLeft, X } from "lucide-react";
import { cn } from "~/lib/utils";

/**
 * The phone's module bar: one 48px row directly under the top bar that says
 * where you are in a module and opens its navigation ("Inbox ▾", "Domains ▾").
 *
 * The phone counterpart of the module pane beside the rail on desktop, and the
 * same component in every module that has one (Mail's folders, Settings' and
 * Analytics' sections), so the row under the bar has one shape everywhere.
 * Hidden from `md`, where the pane itself is on screen.
 */
export function ModuleBar({
	label,
	navLabel,
	onOpen,
	actions,
	icon,
	className,
	children,
}: {
	/** Where you are: the folder or section name. */
	label: string;
	/** What the button opens, for its accessible name ("Folders", "Settings sections"). */
	navLabel: string;
	/** Opens the module's navigation. Omit and pass `children` for the built-in sheet. */
	onOpen?: () => void;
	/** Icon actions at the right of the row. */
	actions?: React.ReactNode;
	/** The module's icon, shown in the leading slot when there is nothing to open. */
	icon?: React.ElementType;
	className?: string;
	/** The sheet's content, when the bar owns it (see `ModuleSheetLinks`). */
	children?: (close: () => void) => React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const button = (
		<button
			type="button"
			onClick={onOpen}
			aria-label={`${navLabel}: ${label}`}
			aria-haspopup="dialog"
			className="inline-flex h-11 min-w-0 items-center gap-1.5 rounded-[6px] px-2 text-[15px] font-semibold text-text-primary hover:bg-bg-muted"
		>
			<PanelLeft size={16} className="shrink-0 text-text-secondary" aria-hidden />
			<span className="truncate">{label}</span>
			<ChevronDown size={14} className="shrink-0 text-text-tertiary" aria-hidden />
		</button>
	);

	return (
		<div
			data-module-bar
			className={cn("flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-2 md:hidden", className)}
		>
			{!children && !onOpen ? (
				// A module with no sub-navigation: the bar is its title, behind the
				// module's icon in the slot the pane toggle uses elsewhere, so the
				// title starts at the same x on every page.
				<ModuleTitle label={label} icon={icon} />
			) : children ? (
				<DialogPrimitive.Root open={open} onOpenChange={setOpen}>
					<DialogPrimitive.Trigger asChild>{button}</DialogPrimitive.Trigger>
					<DialogPrimitive.Portal>
						<DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-slate-900/40 md:hidden" />
						<DialogPrimitive.Content
							aria-describedby={undefined}
							className="pb-safe fixed inset-x-0 bottom-0 z-[61] flex max-h-[80dvh] flex-col rounded-t-[16px] border-t border-border bg-card text-text-primary shadow-lg focus:outline-none md:hidden"
						>
							<div className="flex h-14 shrink-0 items-center justify-between pl-4 pr-2">
								<DialogPrimitive.Title className="text-sm font-semibold">{navLabel}</DialogPrimitive.Title>
								<DialogPrimitive.Close
									aria-label="Close"
									className="flex h-11 w-11 items-center justify-center rounded-[6px] text-text-secondary hover:bg-bg-muted"
								>
									<X className="h-5 w-5" aria-hidden />
								</DialogPrimitive.Close>
							</div>
							<div className="min-h-0 overflow-y-auto overscroll-contain px-2 pb-3">{children(() => setOpen(false))}</div>
						</DialogPrimitive.Content>
					</DialogPrimitive.Portal>
				</DialogPrimitive.Root>
			) : (
				button
			)}
			{actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
		</div>
	);
}

export interface ModulePaneLink {
	id: string;
	label: string;
	to: string;
	icon?: React.ElementType;
	/** An unread count, shown bold at the right like Mail's folder counts. */
	count?: number;
	active?: boolean;
}

/**
 * The desktop module pane: the column at the left edge, full height,
 * 208px, the same frame as Mail's folder pane. Settings, Analytics and the
 * Mailboxes page put their navigation in it, so a module's own navigation is
 * always in this one place. Hidden below `md`, where `ModuleBar` stands in.
 */
export function ModulePane({
	title,
	navLabel,
	links,
	header,
	footer,
}: {
	title: string;
	navLabel: string;
	links: ModulePaneLink[];
	/**
	 * Replaces the title row. Mail's panes use it so the account card and
	 * Compose sit in the same place whether a mailbox is open or not; the title
	 * stays in the outline either way.
	 */
	header?: React.ReactNode;
	footer?: React.ReactNode;
}) {
	return (
		<nav
			aria-label={navLabel}
			data-module-pane
			className="sticky top-[var(--app-topbar-h)] hidden h-[calc(100dvh-var(--app-topbar-h))] w-[208px] shrink-0 flex-col border-r border-border bg-card md:flex"
		>
			{header ? (
				<>
					<h1 className="sr-only">{title}</h1>
					{header}
				</>
			) : (
				<h1 className="shrink-0 px-4 pb-2 pt-4 text-[15px] font-semibold tracking-tight text-text-primary">{title}</h1>
			)}
			<ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
				{links.map((link) => {
					const Icon = link.icon;
					return (
						<li key={link.id}>
							<Link
								to={link.to}
								preventScrollReset={false}
								aria-current={link.active ? "page" : undefined}
								className={cn(
									// The same row as Mail's folder links (`RailLink`).
									"flex h-8 items-center gap-3 rounded-[6px] px-2.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
									link.active
										? "bg-accent-subtle font-semibold text-accent-subtle-fg"
										: "text-text-secondary hover:bg-bg-muted hover:text-text-primary",
								)}
							>
								{Icon && <Icon size={15} className="shrink-0" aria-hidden />}
								<span className="min-w-0 flex-1 truncate">{link.label}</span>
								{!!link.count && link.count > 0 && (
									<span className="shrink-0 text-xs font-semibold tabular-nums">
										{link.count > 999 ? "999+" : link.count}
									</span>
								)}
							</Link>
						</li>
					);
				})}
			</ul>
			{footer && <div className="shrink-0 border-t border-border px-2 py-1.5">{footer}</div>}
		</nav>
	);
}

/** A bar's title with nothing to open: the same box as the toggle, not a control. */
export function ModuleTitle({ label, icon: Icon = LayoutGrid }: { label: string; icon?: React.ElementType }) {
	return (
		<span className="inline-flex h-11 min-w-0 items-center gap-1.5 px-2">
			<Icon size={16} className="shrink-0 text-text-secondary" aria-hidden />
			<h1 className="truncate text-[15px] font-semibold text-text-primary">{label}</h1>
		</span>
	);
}

/** Section links for a `ModuleBar` sheet, styled like the More sheet's rows. */
export function ModuleSheetLinks({
	items,
	activeId,
	href,
	onNavigate,
}: {
	items: { id: string; label: string; icon?: React.ElementType }[];
	activeId?: string;
	href: (id: string) => string;
	onNavigate: () => void;
}) {
	return (
		<ul>
			{items.map((item) => {
				const Icon = item.icon;
				const on = item.id === activeId;
				return (
					<li key={item.id}>
						<Link
							to={href(item.id)}
							onClick={onNavigate}
							aria-current={on ? "page" : undefined}
							className={cn(
								"flex h-12 items-center gap-3 rounded-[8px] px-3 text-[15px] font-medium",
								on ? "bg-accent-subtle text-accent-subtle-fg" : "text-text-primary hover:bg-bg-muted",
							)}
						>
							{Icon && <Icon className="h-5 w-5 shrink-0" aria-hidden />}
							{item.label}
						</Link>
					</li>
				);
			})}
		</ul>
	);
}
