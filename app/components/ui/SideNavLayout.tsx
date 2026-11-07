import { ModuleBar, ModulePane, ModuleSheetLinks } from "~/components/ModuleBar";
import { cn } from "~/lib/utils";

export interface SideNavItem {
	id: string;
	label: string;
	icon?: React.ElementType;
	content: React.ReactNode;
}

/**
 * A module with sections: a section pane on the left and one section on the
 * right, shared by Settings and Analytics so the two read as one product.
 *
 * From `md` the pane is the module's own column, at the left edge and the
 * full height of the window, the same place and width as Mail's folder pane.
 * The top bar switches modules, the pane switches within one, and both stay
 * put while the content scrolls. Below `md` the list becomes a sticky native select under the page
 * title, one 44px control that opens the platform picker.
 *
 * Every section is its own URL (`<basePath>/<id>`); only the active one renders.
 */
export function SideNavLayout({
	items,
	active,
	basePath,
	navLabel,
	pickerLabel,
	title,
	actions,
	search = "",
	contentClassName = "max-w-3xl",
	phoneToolbar,
}: {
	items: SideNavItem[];
	/** The current section id. */
	active: string;
	/** Prefix for section links, e.g. `/settings`. */
	basePath: string;
	/** Accessible name of the nav landmark. */
	navLabel: string;
	/** Accessible name of the phone module bar's section sheet. */
	pickerLabel: string;
	/** The module's name, at the head of the pane and as the page's `h1`. */
	title: string;
	/**
	 * Page-level controls (Analytics' range and scope), right of the section
	 * heading row from `sm` up. Stays in the page, never in the global bar.
	 */
	actions?: React.ReactNode;
	/** Query string carried across sections (`?days=7`), with its `?`. */
	search?: string;
	contentClassName?: string;
	/**
	 * Page controls shown under the phone picker, so the section choice leads on
	 * a phone. `actions` renders from `sm` up; this one is `display: none` there,
	 * so only one is ever in the tree.
	 */
	phoneToolbar?: React.ReactNode;
}) {
	const current = items.find((item) => item.id === active) ?? items[0];
	const href = (id: string) => `${basePath}/${id}${search}`;

	return (
		<div className="flex min-h-[calc(100dvh-var(--app-topbar-h)-var(--app-tabbar-h))] w-full flex-col md:flex-row">
			{/* Phone: the module bar, the same row Mail has, sticky under the top bar. */}
			<ModuleBar
				// "Settings · Domains": the module stays named once a section is open.
				label={current ? `${title} · ${current.label}` : title}
				navLabel={pickerLabel}
				className="sticky top-[var(--app-topbar-h)] z-20"
			>
				{(close) => (
					<ModuleSheetLinks items={items} activeId={current?.id} href={href} onNavigate={close} />
				)}
			</ModuleBar>

			{/* The module pane, from `md`: the same frame as Mail's folder pane. */}
			<ModulePane
				title={title}
				navLabel={navLabel}
				links={items.map((item) => ({
					id: item.id,
					label: item.label,
					icon: item.icon,
					to: href(item.id),
					active: current?.id === item.id,
				}))}
			/>

			<div className="min-w-0 flex-1">
				<div className="mx-auto w-full max-w-[1120px] px-4 py-6 md:px-8 md:py-8">
					{/* Phone: the module name for the page outline; the bar above shows the section. */}
					<h1 className="sr-only md:hidden">{title}</h1>
					{phoneToolbar && <div className="mb-4 sm:hidden">{phoneToolbar}</div>}

					{/* The page's own toolbar row, from `sm`. */}
					{actions && <div className="mb-6 hidden justify-end sm:flex">{actions}</div>}

					<div className={cn("min-w-0", contentClassName)} id={current?.id}>
						{current?.content}
					</div>
				</div>
			</div>
		</div>
	);
}
