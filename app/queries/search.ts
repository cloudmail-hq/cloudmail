// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";
import type { Email } from "~/types";
import { queryKeys } from "./keys";

export const SEARCH_PAGE_SIZE = 25;

interface SearchResponse {
	emails: Email[];
	totalCount: number;
}

/**
 * Run a search.
 *
 * The query string is sent verbatim rather than parsed here first. Parsing on
 * the client and shipping one query parameter per filter is what capped the
 * operator set: that flat shape had nowhere to put negation, OR or grouping, so
 * the server could never answer more than the client could describe. The worker
 * parses it with `shared/search-query.ts` instead.
 */
export function useSearchEmails(
	mailboxId: string | undefined,
	query: string,
	page: number,
	/** `hybrid` merges full-text and semantic results (one ranked page). */
	mode?: "hybrid",
) {
	return useQuery<{ results: Email[]; totalCount: number }>({
		queryKey: mailboxId && query
			? [...queryKeys.search.results(mailboxId, query, page), ...(mode ? [mode] : [])]
			: ["search", "_disabled"],
		queryFn: async () => {
			const data = await api.searchEmails(mailboxId!, {
				query,
				page: String(page),
				limit: String(SEARCH_PAGE_SIZE),
				...(mode ? { mode } : {}),
			}) as SearchResponse | Email[];

			if (data && typeof data === "object" && "emails" in data) {
				return {
					results: data.emails ?? [],
					totalCount: data.totalCount ?? 0,
				};
			}
			const arr = Array.isArray(data) ? data : [];
			return { results: arr, totalCount: arr.length };
		},
		enabled: !!mailboxId && !!query,
	});
}

/**
 * Search every readable mailbox, for the top bar's search off Mail. Uses
 * `GET /api/v1/search` (#132): keywords plus meaning, narrowed server-side to
 * what the caller may read.
 */
export function useSearchAllMailboxes(query: string) {
	const q = query.trim();
	return useQuery({
		queryKey: ["search", "all-mailboxes", q] as const,
		queryFn: ({ signal }) => api.searchAllMailboxes({ q, limit: "50" }, { signal }),
		enabled: q.length > 0,
	});
}
