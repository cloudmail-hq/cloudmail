/**
 * Search results.
 *
 * The query string is parsed server-side, so operators (`from:`, `is:unread`,
 * `has:attachment`, `before:`) behave the same here as in the agent's tools.
 */

import { useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import AskAnswerPanel from "~/components/mail/AskAnswerPanel";
import { useQueryClient } from "@tanstack/react-query";
import { Info, SearchX } from "lucide-react";
import { searchQueryWarnings } from "shared/search-query";
import MailList from "~/components/mail/MailList";
import MailWorkspace from "~/components/mail/MailWorkspace";
import { queryKeys } from "~/queries/keys";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { usePagedList, type PageResult } from "~/hooks/usePagedList";
import { SEARCH_PAGE_SIZE, useSearchEmails } from "~/queries/search";
import api from "~/services/api";
import type { Email } from "~/types";

const OPERATOR_HINTS = [
	"from:alice@example.com",
	"is:unread",
	"has:attachment",
	"before:2026-01-01",
];

export default function MailSearchRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const [searchParams] = useSearchParams();
	const query = searchParams.get("q") ?? "";
	const asking = searchParams.get("ask") === "1" && query.trim().length > 0;
	const navigate = useNavigate();
	const [page, setPage] = useState(1);
	const queryClient = useQueryClient();

	const isMobile = useIsMobile();

	// Desktop: one page from `useSearchEmails`. Phone: every page so far, under
	// a key of its own (`useSearchEmails` caches a `{ results }` shape, these
	// are `{ emails }`), invalidated by the same `search.all` prefix.
	// An empty query disables the hook, so a phone never fetches both.
	// A question searched as full-text would need every word in one message;
	// hybrid mode (keywords + meaning) finds what the answer is drawn from. It
	// returns one ranked page, so paging stays at 1.
	const mode = asking ? "hybrid" : undefined;
	const single = useSearchEmails(mailboxId, isMobile ? "" : query, asking ? 1 : page, mode);
	const paged = usePagedList({
		page,
		pageSize: SEARCH_PAGE_SIZE,
		accumulate: true,
		enabled: isMobile && !!mailboxId && !!query,
		pageQuery: (n) => ({
			queryKey: [...queryKeys.search.results(mailboxId ?? "", query, n), "list", mode ?? "fts"],
			queryFn: async () => {
				const data = (await api.searchEmails(mailboxId!, {
					query,
					page: String(asking ? 1 : n),
					limit: String(SEARCH_PAGE_SIZE),
					...(mode ? { mode } : {}),
				})) as PageResult | Email[];
				if (Array.isArray(data)) return { emails: data, totalCount: data.length };
				return { emails: data?.emails ?? [], totalCount: data?.totalCount ?? 0 };
			},
		}),
	});

	const singleResults = useMemo(() => single.data?.results ?? [], [single.data?.results]);
	const results = isMobile ? paged.emails : singleResults;
	const totalCount = isMobile ? paged.totalCount : (single.data?.totalCount ?? 0);
	const isFetching = isMobile ? paged.isFetching : single.isFetching;
	const error = isMobile ? paged.error : single.error;
	// Operators that did not parse were searched as text; say so, or a typo
	// like `larger:banana` just reads as "no mail".
	const warnings = useMemo(() => searchQueryWarnings(query), [query]);

	if (!mailboxId) return null;

	return (
		<MailWorkspace mailboxId={mailboxId}>
			<MailList
				mailboxId={mailboxId}
				title={query ? `Results for “${query}”` : "Search"}
				emails={results}
				totalCount={totalCount}
				isRefreshing={isFetching}
				error={error}
				page={page}
				onPageChange={setPage}
				loadMore={
					isMobile ? { hasMore: paged.hasMore, loading: paged.isLoadingMore } : undefined
				}
				onRefresh={() => {
					setPage(1);
					// Resetting the page is a no-op when already on page 1, which left
					// the error state's "Try again" button doing nothing at all.
					queryClient.invalidateQueries({
						queryKey: queryKeys.search.all(mailboxId),
					});
				}}
				collectionKey={`${mailboxId}/search/${query}`}
				countNoun="result"
				notice={
					asking ? (
						<AskAnswerPanel
							question={query}
							// Scoped like the search box: this mailbox here, every inbox off Mail.
							mailbox={mailboxId}
							onDismiss={() => {
								const next = new URLSearchParams(searchParams);
								next.delete("ask");
								navigate({ search: `?${next}` }, { replace: true });
							}}
						/>
					) : warnings.length > 0 ? (
						<div
							role="status"
							className="flex items-start gap-2 border-b border-border bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-400/10 dark:text-amber-200"
						>
							<Info size={13} className="mt-0.5 shrink-0" aria-hidden />
							<ul className="min-w-0 space-y-0.5">
								{warnings.map((w) => (
									<li key={w.token} className="break-words">
										{w.message}
									</li>
								))}
							</ul>
						</div>
					) : undefined
				}
				empty={
					<div className="flex flex-col items-center justify-center px-6 py-20 text-center">
						<SearchX size={32} className="mb-3 text-text-tertiary" strokeWidth={1.25} />
						<h3 className="mb-1 text-sm font-bold text-text-primary">
							{query ? "No matches" : "Search this mailbox"}
						</h3>
						<p className="max-w-[280px] text-xs font-light text-text-secondary">
							{query
								? `Nothing matched “${query}”. Try fewer words, or a different operator.`
								: "Search by sender, subject or body text."}
						</p>
						<ul className="mt-3 flex flex-wrap justify-center gap-1.5">
							{OPERATOR_HINTS.map((hint) => (
								<li
									key={hint}
									className="rounded-[4px] bg-bg-subtle px-1.5 py-0.5 font-mono text-[10px] text-text-secondary"
								>
									{hint}
								</li>
							))}
						</ul>
					</div>
				}
			/>
		</MailWorkspace>
	);
}
