// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Follow-up reminders ("Remind me if no reply").
 *
 * A reminder set at send time travels as a `followup` field on the send body,
 * so it needs no hook here. These cover the "Awaiting reply" view and managing
 * a reminder afterwards from the reading pane. Cancelling a fired reminder
 * moves its message back out of the Inbox, so the email lists are invalidated
 * along with the reminder queries.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import { queryKeys } from "./keys";

function useInvalidateFollowups() {
	const qc = useQueryClient();
	return (mailboxId: string) => {
		qc.invalidateQueries({ queryKey: queryKeys.followups.all(mailboxId) });
		qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
		qc.invalidateQueries({ queryKey: queryKeys.folders.list(mailboxId) });
		qc.invalidateQueries({ queryKey: queryKeys.labels.list(mailboxId) });
	};
}

export function useFollowups(mailboxId: string | undefined) {
	return useQuery({
		queryKey: queryKeys.followups.list(mailboxId ?? ""),
		queryFn: ({ signal }) => api.listFollowups(mailboxId!, { signal }),
		enabled: !!mailboxId,
		select: (data) => data.followups,
	});
}

/** The reminder on a message or its thread; null when there is none. */
export function useFollowup(mailboxId: string | undefined, emailId: string | undefined) {
	return useQuery({
		queryKey: queryKeys.followups.forEmail(mailboxId ?? "", emailId ?? ""),
		queryFn: async ({ signal }) => {
			try {
				return await api.getFollowup(mailboxId!, emailId!, { signal });
			} catch (err) {
				// 404 is "no reminder", the common case, not an error worth surfacing.
				if ((err as { status?: number })?.status === 404) return null;
				throw err;
			}
		},
		enabled: !!mailboxId && !!emailId,
		retry: false,
	});
}

export function useSetFollowup() {
	const invalidate = useInvalidateFollowups();
	return useMutation({
		mutationFn: ({
			mailboxId,
			emailId,
			when,
		}: {
			mailboxId: string;
			emailId: string;
			when: { at: string } | { delay_seconds: number };
		}) => api.setFollowup(mailboxId, emailId, when),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useCancelFollowup() {
	const invalidate = useInvalidateFollowups();
	return useMutation({
		mutationFn: ({ mailboxId, emailId }: { mailboxId: string; emailId: string }) =>
			api.cancelFollowup(mailboxId, emailId),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}
