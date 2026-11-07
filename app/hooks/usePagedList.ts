/**
 * One page of a mail listing on desktop, every page so far on a phone.
 *
 * Each page is fetched as its own query under the same key the single-page
 * hooks use (`useEmails`, `useLabelEmails`, `useSearchEmails`), so the cache
 * has one shape: optimistic row updates, invalidation after a mutation and the
 * live-update poll all reach every row on screen, and switching layouts reuses
 * what is already cached.
 */

import { type QueryKey, useQueries } from "@tanstack/react-query";
import { useRef } from "react";
import { pagesToFetch } from "~/lib/collapse-on-scroll";
import { flattenPages, nextPageNumber } from "../../shared/paged-list";
import type { Email } from "~/types";

const EMPTY: Email[] = [];

export interface PageResult {
	emails: Email[];
	totalCount: number;
}

export interface PagedListResult {
	emails: Email[];
	totalCount: number;
	isFetching: boolean;
	/** The newest page is loading for the first time (not a background refetch). */
	isLoadingMore: boolean;
	error: unknown;
	hasMore: boolean;
}

export function usePagedList({
	page,
	pageSize,
	accumulate,
	enabled,
	pageQuery,
}: {
	page: number;
	pageSize: number;
	/** Keep earlier pages on screen and append (the phone layout). */
	accumulate: boolean;
	enabled: boolean;
	/** The query for one page number. Must match the single-page hook's key. */
	pageQuery: (page: number) => {
		queryKey: QueryKey;
		queryFn: (ctx: { signal: AbortSignal }) => Promise<PageResult>;
	};
}): PagedListResult {
	const numbers = pagesToFetch(page, accumulate);
	const results = useQueries({
		queries: numbers.map((n) => ({ ...pageQuery(n), enabled })),
	});

	const datas = results.map((r) => r.data?.emails ?? EMPTY);
	// `useQueries` returns a new array each render. Rebuild the merged rows only
	// when a page's data reference changes: MailList publishes `emails` to the
	// store in an effect, so a fresh array every render would loop.
	const cache = useRef<{ inputs: Email[][]; out: Email[] }>({ inputs: [], out: EMPTY });
	const same =
		cache.current.inputs.length === datas.length &&
		cache.current.inputs.every((d, i) => d === datas[i]);
	if (!same) cache.current = { inputs: datas, out: flattenPages(datas, (e) => e.id) };
	const emails = cache.current.out;
	const known = [...results].reverse().find((r) => r.data);
	const totalCount = known?.data?.totalCount ?? 0;
	const last = results[results.length - 1];

	return {
		emails,
		totalCount,
		isFetching: results.some((r) => r.isFetching),
		isLoadingMore: numbers.length > 1 && !!last?.isLoading,
		error: results.find((r) => r.error)?.error ?? null,
		hasMore: nextPageNumber(page, pageSize, totalCount) !== undefined,
	};
}
