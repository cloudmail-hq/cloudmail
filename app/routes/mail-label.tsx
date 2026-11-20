/**
 * Every message carrying one label.
 *
 * Labels cut across folders, so this is a view rather than a location: a message
 * listed here still lives wherever it was filed. Trashed mail is excluded
 * server-side.
 */

import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Tag } from "lucide-react";
import MailList, { PAGE_SIZE } from "~/components/mail/MailList";
import MailWorkspace from "~/components/mail/MailWorkspace";
import { useUrlFilters } from "~/hooks/useMailUrlSync";
import {
	filtersKey,
	filtersToParams,
	hasActiveFilters,
	withFiltersCleared,
} from "~/lib/mail-filters";
import { errorMessage, showToast } from "~/lib/toast";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { usePagedList, type PageResult } from "~/hooks/usePagedList";
import { queryKeys } from "~/queries/keys";
import {
	useDeleteLabel,
	useLabels,
	useUpdateLabel,
} from "~/queries/labels";
import api from "~/services/api";

export default function MailLabelRoute() {
	const { mailboxId, labelId } = useParams<{
		mailboxId: string;
		labelId: string;
	}>();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [page, setPage] = useState(1);
	// In the query string, so a reload or a shared link keeps them.
	const [filters, setFilters] = useUrlFilters();
	const [renaming, setRenaming] = useState(false);
	const [draftName, setDraftName] = useState("");

	const { data: labels = [] } = useLabels(mailboxId);
	const label = useMemo(
		() => labels.find((l) => l.id === labelId),
		[labels, labelId],
	);

	const params = useMemo(
		() => ({
			page: String(page),
			limit: String(PAGE_SIZE),
			...filtersToParams(filters),
		}),
		[page, filters],
	);
	// Same keys as `useLabelEmails`, one query per page; see `usePagedList`.
	const isMobile = useIsMobile();
	const list = usePagedList({
		page,
		pageSize: PAGE_SIZE,
		accumulate: isMobile,
		enabled: !!mailboxId && !!labelId,
		pageQuery: (n) => {
			const pageParams = { ...params, page: String(n) };
			return {
				queryKey: queryKeys.labels.emails(mailboxId ?? "", labelId ?? "", pageParams),
				queryFn: ({ signal }) =>
					api.listLabelEmails(mailboxId!, labelId!, pageParams, { signal }) as Promise<PageResult>,
			};
		},
	});

	const updateLabel = useUpdateLabel();
	const deleteLabel = useDeleteLabel();

	if (!mailboxId) return null;

	const name = label?.name ?? "Label";

	const submitRename = (e: React.FormEvent) => {
		e.preventDefault();
		if (!labelId || !draftName.trim()) return;
		updateLabel.mutate(
			{ mailboxId, labelId, patch: { name: draftName.trim() } },
			{
				onSuccess: () => setRenaming(false),
				onError: (err) =>
					showToast({
						kind: "error",
						message: errorMessage(err, "Could not rename that label."),
					}),
			},
		);
	};

	const remove = () => {
		if (!labelId || !label) return;
		if (
			!window.confirm(
				`Delete the label "${label.name}"? The messages carrying it are kept.`,
			)
		) {
			return;
		}
		deleteLabel.mutate(
			{ mailboxId, labelId },
			{
				onSuccess: () =>
					navigate(`/mail/${encodeURIComponent(mailboxId)}/inbox`),
			},
		);
	};

	return (
		<MailWorkspace mailboxId={mailboxId}>
			<div className="flex h-full min-h-0 flex-col">
				<MailList
					mailboxId={mailboxId}
					title={name}
					titleAdornment={
						<Tag
							size={14}
							className="shrink-0"
							style={{ color: label?.color ?? "#6b7280" }}
							fill={label?.color ?? "#6b7280"}
						/>
					}
					emails={list.emails}
					totalCount={list.totalCount}
					isRefreshing={list.isFetching}
					error={list.error}
					page={page}
					onPageChange={setPage}
					loadMore={
						isMobile ? { hasMore: list.hasMore, loading: list.isLoadingMore } : undefined
					}
					onRefresh={() =>
						queryClient.invalidateQueries({ queryKey: ["labels", mailboxId] })
					}
					collectionKey={`${mailboxId}/label/${labelId}/${filtersKey(filters)}`}
					markAllReadScope={labelId ? { label_id: labelId } : undefined}
					countNoun="message"
					filters={filters}
					onFiltersChange={setFilters}
					empty={
						hasActiveFilters(filters) ? (
							<div className="flex flex-col items-center justify-center px-6 py-20 text-center">
								<Tag size={32} className="mb-3 text-text-tertiary" strokeWidth={1.25} />
								<h3 className="mb-1 text-sm font-bold text-text-primary">
									No messages match
								</h3>
								<p className="max-w-[260px] text-xs font-light text-text-secondary">
									This label has mail, but none of it matches the filters you have
									on.
								</p>
								<button
									type="button"
									onClick={() => setFilters(withFiltersCleared(filters))}
									className="mt-4 rounded-[6px] bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground"
								>
									Clear filters
								</button>
							</div>
						) : (
							<div className="flex flex-col items-center justify-center px-6 py-20 text-center">
								<Tag size={32} className="mb-3 text-text-tertiary" strokeWidth={1.25} />
								<h3 className="mb-1 text-sm font-bold text-text-primary">
									Nothing labelled {name}
								</h3>
								<p className="max-w-[260px] text-xs font-light text-text-secondary">
									Apply this label to a message to collect related mail here,
									whatever folder it lives in.
								</p>
							</div>
						)
					}
				/>

				{/* Label admin sits under the list: rarely used, never in the way. */}
				<div className="flex shrink-0 items-center gap-2 border-t border-border bg-bg-subtle/60 px-3 py-2">
					{renaming ? (
						<form onSubmit={submitRename} className="flex flex-1 items-center gap-1.5">
							<input
								autoFocus
								value={draftName}
								onChange={(e) => setDraftName(e.target.value)}
								aria-label="Label name"
								className="min-w-0 flex-1 rounded-[6px] border border-border bg-card px-2 py-1 text-xs text-text-primary outline-none focus:ring-2 focus:ring-text-primary/15"
							/>
							<button
								type="submit"
								disabled={!draftName.trim() || updateLabel.isPending}
								className="rounded-[6px] bg-accent px-2 py-1 text-[11px] font-semibold text-accent-foreground disabled:opacity-50"
							>
								Save
							</button>
							<button
								type="button"
								onClick={() => setRenaming(false)}
								className="rounded-[6px] border border-border px-2 py-1 text-[11px] font-medium text-text-secondary"
							>
								Cancel
							</button>
						</form>
					) : (
						<>
							<button
								type="button"
								onClick={() => {
									setDraftName(name);
									setRenaming(true);
								}}
								className="rounded-[6px] border border-border bg-card px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-bg-muted"
							>
								Rename label
							</button>
							<button
								type="button"
								onClick={remove}
								className="rounded-[6px] border border-border bg-card px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-destructive/10 hover:text-destructive"
							>
								Delete label
							</button>
						</>
					)}
				</div>
			</div>
		</MailWorkspace>
	);
}
