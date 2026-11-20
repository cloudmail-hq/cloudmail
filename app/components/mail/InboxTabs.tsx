// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The split-inbox tab bar: Primary plus one tab per label marked "show as
 * tab". Each tab is a saved search on `label:` (see `inboxTabs` in
 * shared/ai-triage.ts); the active one lives in `?tab=` so a reload or a
 * shared link keeps it.
 *
 * A row of links in a scrollable strip rather than a WAI-ARIA tablist: each
 * tab changes the URL and the list below, which is navigation.
 */

import { Link } from "react-router";
import type { InboxTab } from "shared/ai-triage";
import { cn } from "~/lib/utils";

export default function InboxTabs({
	tabs,
	active,
	hrefFor,
}: {
	tabs: InboxTab[];
	active: string;
	hrefFor: (tabId: string) => string;
}) {
	if (tabs.length === 0) return null;
	return (
		<nav
			aria-label="Inbox tabs"
			className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-card px-2 [scrollbar-width:none]"
		>
			{tabs.map((tab) => {
				const current = tab.id === active;
				return (
					<Link
						key={tab.id}
						to={hrefFor(tab.id)}
						replace
						aria-current={current ? "page" : undefined}
						className={cn(
							"relative inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap px-3 text-[13px] font-medium transition-colors touch:h-11",
							current
								? "text-text-primary after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent"
								: "text-text-secondary hover:text-text-primary",
						)}
					>
						{tab.color && (
							<span
								aria-hidden
								className="h-2 w-2 shrink-0 rounded-full"
								style={{ backgroundColor: tab.color }}
							/>
						)}
						{tab.name}
					</Link>
				);
			})}
		</nav>
	);
}
