// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { nextPageNumber } from "../../shared/paged-list";
import api, {
	type CurrentUser,
	type PeopleQuery,
	type PeopleResponse,
	type PersonEmailsResponse,
} from "~/services/api";
import { queryKeys } from "./keys";

/**
 * Person-centric inbox rows.
 *
 * Filtering, sorting and pagination all happen server-side: the aggregate spans
 * every mailbox, so the client only ever holds one page and cannot correctly
 * filter or sort what it hasn't seen.
 */
export function usePeople(
	query: PeopleQuery = {},
	options?: { enabled?: boolean },
) {
	return useQuery<PeopleResponse>({
		queryKey: queryKeys.people.list(query as Record<string, unknown>),
		queryFn: ({ signal }) => api.listPeople(query, { signal }),
		// Recipient autocomplete shares this hook and must stay idle until the
		// user has typed enough to be worth a round trip.
		enabled: options?.enabled ?? true,
		// Keep the previous page visible while the next one loads instead of
		// flashing an empty list on every page or filter change.
		placeholderData: (previous) => previous,
	});
}

/**
 * People rows as an accumulating list, for "load more" on phones.
 *
 * Same endpoint and key prefix as `usePeople`, so the mark-read invalidation
 * (`["people"]`) refreshes it too.
 */
export function usePeopleInfinite(
	query: Omit<PeopleQuery, "page"> = {},
	options?: { enabled?: boolean },
) {
	const pageSize = query.pageSize ?? 40;
	return useInfiniteQuery({
		queryKey: [...queryKeys.people.list(query as Record<string, unknown>), "infinite"] as const,
		queryFn: ({ signal, pageParam }) =>
			api.listPeople({ ...query, pageSize, page: pageParam }, { signal }),
		initialPageParam: 1,
		getNextPageParam: (last: PeopleResponse, all: PeopleResponse[]) =>
			nextPageNumber(all.length, pageSize, last.total ?? 0),
		enabled: options?.enabled ?? true,
	});
}

/** Every message exchanged with one person, newest first. */
export function usePersonEmails(personEmail: string | undefined, limit = 100) {
	return useQuery<PersonEmailsResponse>({
		queryKey: personEmail
			? queryKeys.people.emails(personEmail)
			: ["people", "_disabled", "emails"],
		queryFn: ({ signal }) =>
			api.listPersonEmails(personEmail!, { limit }, { signal }),
		enabled: !!personEmail,
	});
}

/** Signed-in teammate. Stable for the session, so it never needs refetching. */
export function useCurrentUser() {
	return useQuery<CurrentUser>({
		queryKey: queryKeys.currentUser,
		queryFn: ({ signal }) => api.getCurrentUser({ signal }),
		staleTime: Infinity,
	});
}

/**
 * The signed-in user shaped for `DashboardLayout`.
 *
 * Returns null until the identity resolves; `TopNav` already renders a neutral
 * state for a null user, which is preferable to briefly showing a placeholder
 * name that then changes.
 */
export function useDashboardUser() {
	const { data } = useCurrentUser();

	if (!data) return null;

	return {
		name: data.name,
		email: data.email ?? undefined,
		role: data.role,
	};
}

/**
 * Mark every unread message from one person as read.
 *
 * A person's messages can be spread across several mailboxes and threads, so
 * this walks their timeline and marks each distinct thread read through the
 * existing per-mailbox endpoint.
 */
export function useMarkPersonRead() {
	const qc = useQueryClient();

	return useMutation({
		mutationFn: async (personEmail: string) => {
			const { emails } = await api.listPersonEmails(personEmail, { limit: 200 });

			// One call per (mailbox, thread) pair rather than per message.
			const threads = new Map<string, { mailboxId: string; threadId: string }>();
			for (const email of emails) {
				if (email.read || !email.thread_id) continue;
				threads.set(`${email.mailboxId}:${email.thread_id}`, {
					mailboxId: email.mailboxId,
					threadId: email.thread_id,
				});
			}

			await Promise.all(
				[...threads.values()].map(({ mailboxId, threadId }) =>
					api.markThreadRead(mailboxId, threadId),
				),
			);
		},
		onSuccess: (_data, personEmail) => {
			qc.invalidateQueries({ queryKey: ["people"] });
			qc.invalidateQueries({ queryKey: queryKeys.people.emails(personEmail) });
		},
	});
}
