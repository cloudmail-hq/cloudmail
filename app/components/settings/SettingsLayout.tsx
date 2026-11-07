import { SideNavLayout, type SideNavItem } from "~/components/ui/SideNavLayout";

export type SettingsNavItem = SideNavItem;

/**
 * Settings as a section list on the left and one section on the right.
 *
 * Every section is its own URL (`/settings/<id>`, or `<base>/<id>` for the
 * mailbox settings). The old single page was about 7,000px with toggles that
 * saved instantly beside forms that needed a Save button; one section per page
 * keeps one save model in view at a time and makes each section linkable.
 *
 * The layout itself is `SideNavLayout`, shared with Analytics.
 */
export function SettingsLayout({
	items,
	active,
	basePath,
	title = "Settings",
}: {
	items: SettingsNavItem[];
	/** The current section id. */
	active: string;
	/** Prefix for section links, e.g. `/settings`. */
	basePath: string;
	title?: string;
}) {
	return (
		<SideNavLayout
			items={items}
			active={active}
			basePath={basePath}
			title={title}
			navLabel="Settings sections"
			pickerLabel="Settings section"
		/>
	);
}
