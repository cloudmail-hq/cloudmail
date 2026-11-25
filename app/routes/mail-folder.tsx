/** One folder's conversations. */

import { useMemo, useState } from "react";
import { composerPreloadProps } from "~/components/lazy";
import { useParams, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
	Archive,
	Clock,
	FileText,
	Filter,
	Inbox,
	Mail,
	Send,
	ShieldAlert,
	Timer,
	UserCheck,
	Trash2,
} from "lucide-react";
import { Folders, getFolderDisplayName } from "shared/folders";
import MailList, { PAGE_SIZE } from "~/components/mail/MailList";
import MailWorkspace from "~/components/mail/MailWorkspace";
import { TodayCard } from "~/components/mail/TodayCard";
import InboxTabs from "~/components/mail/InboxTabs";
import { useInboxTabs } from "~/queries/triage";
import api from "~/services/api";
import type { Email } from "~/types";
import { useUrlFilters } from "~/hooks/useMailUrlSync";
import { useUIStore } from "~/hooks/useUIStore";
import {
	filtersKey,
	filtersToParams,
	hasActiveFilters,
	withFiltersCleared,
} from "~/lib/mail-filters";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { usePagedList } from "~/hooks/usePagedList";
import { emailListQuery } from "~/queries/emails";
import { useFolders } from "~/queries/folders";
import { queryKeys } from "~/queries/keys";

const EMPTY_STATES: Record<
	string,
	{ Icon: React.ElementType; title: string; body: string; compose?: boolean }
> = {
	[Folders.INBOX]: {
		Icon: Inbox,
		title: "Your inbox is empty",
		body: "New mail lands here. Start a conversation to get things moving.",
		compose: true,
	},
	[Folders.SENT]: {
		Icon: Send,
		title: "Nothing sent yet",
		body: "Messages you send show up here.",
		compose: true,
	},
	[Folders.DRAFT]: {
		Icon: FileText,
		title: "No drafts",
		body: "Anything you start writing is saved here automatically.",
		compose: true,
	},
	[Folders.ARCHIVE]: {
		Icon: Archive,
		title: "Archive is empty",
		body: "Archive mail to clear the inbox without deleting anything.",
	},
	[Folders.TRASH]: {
		Icon: Trash2,
		title: "Trash is empty",
		body: "Deleted messages collect here.",
	},
	[Folders.SPAM]: {
		Icon: ShieldAlert,
		title: "No spam",
		body: "Mail from blocked senders is filed here instead of your inbox.",
	},
	[Folders.SNOOZED]: {
		Icon: Clock,
		title: "Nothing snoozed",
		body: "Snooze a message to hide it until you're ready for it.",
	},
	[Folders.SCREENER]: {
		Icon: UserCheck,
		title: "Nobody waiting",
		body: "Mail from first-time senders waits here when the Screener is on. Decide each sender with Yes or No.",
	},
	[Folders.SCHEDULED]: {
		Icon: Timer,
		title: "Nothing scheduled",
		body: "Queued messages wait here. You can cancel any of them before they send.",
		compose: true,
	},
};

function FolderEmpty({ folder }: { folder?: string }) {
	const { startCompose } = useUIStore();
	const config = (folder && EMPTY_STATES[folder]) || {
		Icon: Mail,
		title: "No messages",
		body: "This folder is empty.",
	};

	return (
		<div className="flex flex-col items-center justify-center px-6 py-20 text-center">
			<config.Icon size={34} className="mb-3 text-text-tertiary" strokeWidth={1.25} />
			<h3 className="mb-1 text-sm font-bold text-text-primary">
				{config.title}
			</h3>
			<p className="max-w-[260px] text-xs font-light text-text-secondary">
				{config.body}
			</p>
			{"compose" in config && config.compose && (
				<button
					type="button"
					onClick={() => startCompose()}
					{...composerPreloadProps}
					className="mt-4 rounded-[6px] bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground"
				>
					Compose
				</button>
			)}
		</div>
	);
}

/**
 * Distinct from `FolderEmpty`: "no mail matches this filter" and "this folder is
 * empty" call for different actions, and showing the folder's empty state while
 * a filter is on reads as data loss.
 */
function FilteredEmpty({ onClear }: { onClear: () => void }) {
	return (
		<div className="flex flex-col items-center justify-center px-6 py-20 text-center">
			<Filter size={34} className="mb-3 text-text-tertiary" strokeWidth={1.25} />
			<h3 className="mb-1 text-sm font-bold text-text-primary">
				No messages match
			</h3>
			<p className="max-w-[260px] text-xs font-light text-text-secondary">
				There is mail in this folder, but none of it matches the filters you have
				on.
			</p>
			<button
				type="button"
				onClick={onClear}
				className="mt-4 rounded-[6px] bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground"
			>
				Clear filters
			</button>
		</div>
	);
}

export default function MailFolderRoute() {
	const { mailboxId, folder } = useParams<{
		mailboxId: string;
		folder: string;
	}>();
	const [page, setPage] = useState(1);
	// In the query string, so a reload or a shared link keeps them.
	const [filters, setFilters] = useUrlFilters();
	const queryClient = useQueryClient();
	const { data: folders = [] } = useFolders(mailboxId);

	// Split inbox: tabs are saved searches on `label:` (shared/ai-triage.ts).
	// With no tab labels there is no bar and the Inbox lists as it always did.
	const [searchParams] = useSearchParams();
	const isInbox = (folder || Folders.INBOX) === Folders.INBOX;
	const { data: tabs = [] } = useInboxTabs(isInbox ? mailboxId : undefined);
	const activeTabId = searchParams.get("tab") || "primary";
	const activeTab = isInbox ? (tabs.find((t) => t.id === activeTabId) ?? tabs[0]) : undefined;

	const params = useMemo(
		() => ({
			folder: folder || Folders.INBOX,
			page: String(page),
			limit: String(PAGE_SIZE),
			...filtersToParams(filters),
		}),
		[folder, page, filters],
	);

	// One page at a time on desktop; on a phone every page so far, appended as
	// the reader scrolls. No refetch interval: the workspace polls a cheap
	// version counter and invalidates these queries when something changed.
	const isMobile = useIsMobile();
	const list = usePagedList({
		page,
		pageSize: PAGE_SIZE,
		accumulate: isMobile,
		enabled: !!mailboxId,
		pageQuery: (n) =>
			activeTab
				? {
						queryKey: ["emails", mailboxId ?? "", "tab", activeTab.query, n],
						queryFn: async () => {
							const data = (await api.searchEmails(mailboxId!, {
								query: activeTab.query,
								page: String(n),
								limit: String(PAGE_SIZE),
							})) as { emails: Email[]; totalCount: number } | Email[];
							if (Array.isArray(data)) return { emails: data, totalCount: data.length };
							return { emails: data?.emails ?? [], totalCount: data?.totalCount ?? 0 };
						},
					}
				: emailListQuery(mailboxId ?? "", { ...params, page: String(n) }),
	});

	const title = useMemo(() => {
		const custom = folders.find((f) => f.id === folder);
		return custom?.name ?? getFolderDisplayName(folder ?? Folders.INBOX);
	}, [folders, folder]);

	if (!mailboxId) return null;

	const tabHref = (tabId: string) => {
		const next = new URLSearchParams(searchParams);
		next.delete("id");
		if (tabId === "primary") next.delete("tab");
		else next.set("tab", tabId);
		const qs = next.toString();
		return `/mail/${encodeURIComponent(mailboxId)}/${Folders.INBOX}${qs ? `?${qs}` : ""}`;
	};

	return (
		<MailWorkspace mailboxId={mailboxId}>
			<MailList
				notice={
					activeTab ? (
						<InboxTabs tabs={tabs} active={activeTab.id} hrefFor={tabHref} />
					) : undefined
				}
				mailboxId={mailboxId}
				title={title}
				// The same name the mail route's module bar shows (`currentViewName`).
				titleInModuleBar
				emails={list.emails}
				totalCount={list.totalCount}
				isRefreshing={list.isFetching}
				error={list.error}
				page={page}
				onPageChange={setPage}
				loadMore={
					isMobile ? { hasMore: list.hasMore, loading: list.isLoadingMore } : undefined
				}
				onRefresh={() => {
					queryClient.invalidateQueries({ queryKey: ["emails", mailboxId] });
					queryClient.invalidateQueries({
						queryKey: queryKeys.folders.list(mailboxId),
					});
				}}
				// Filters are part of the collection identity so changing one resets
				// to page 1 — page 4 of an unfiltered inbox is usually past the end
				// of the filtered one, which would render an empty list instead.
				collectionKey={`${mailboxId}/${folder}/${activeTab?.id ?? ""}/${filtersKey(filters)}`}
				markAllReadScope={folder ? { folder } : undefined}
				folderId={folder}
				// The brief belongs to the whole Inbox, so it shows on Primary only.
				header={
					(folder ?? Folders.INBOX) === Folders.INBOX &&
					page === 1 &&
					!hasActiveFilters(filters) &&
					(!activeTab || activeTab.id === "primary") ? (
						<TodayCard mailboxId={mailboxId} />
					) : undefined
				}
				// A tab lists through search, which has its own order and no filter
				// parameters, so the filter bar is hidden while one is active.
				filters={activeTab ? undefined : filters}
				onFiltersChange={activeTab ? undefined : setFilters}
				empty={
					hasActiveFilters(filters) ? (
						<FilteredEmpty onClear={() => setFilters(withFiltersCleared(filters))} />
					) : (
						<FolderEmpty folder={folder} />
					)
				}
			/>
		</MailWorkspace>
	);
}
