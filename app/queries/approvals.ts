// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Agent and MCP sends waiting for approval. See `workers/routes/approvals.ts`.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { type SendApproval, type SendApprovalEdits, type SendApprovalStatus } from "~/services/api";
import { queryKeys } from "./keys";

/** Pending count for the sidebar badge. Polls, because agents queue sends in the background. */
export function usePendingApprovalCount(mailboxId: string | undefined) {
	return useQuery<{ pending: number }>({
		queryKey: queryKeys.approvals.count(mailboxId ?? ""),
		queryFn: ({ signal }) => api.countApprovals(mailboxId!, { signal }),
		enabled: Boolean(mailboxId),
		refetchInterval: 60_000,
		// A mailbox the user may read but has no approvals route for (older
		// Worker) should not spam retries.
		retry: false,
	});
}

export function useApprovals(mailboxId: string | undefined, status: SendApprovalStatus | "all" = "pending") {
	return useQuery<{ approvals: SendApproval[] }>({
		queryKey: queryKeys.approvals.list(mailboxId ?? "", status),
		queryFn: ({ signal }) => api.listApprovals(mailboxId!, status, { signal }),
		enabled: Boolean(mailboxId),
	});
}

function useInvalidate(mailboxId: string) {
	const qc = useQueryClient();
	return () => {
		qc.invalidateQueries({ queryKey: queryKeys.approvals.all(mailboxId) });
		// An approved send lands in Sent and writes an audit line.
		qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
		qc.invalidateQueries({ queryKey: ["folders", mailboxId] });
		qc.invalidateQueries({ queryKey: queryKeys.mailboxAudit(mailboxId) });
	};
}

/**
 * Approve sends exactly what is stored; edit first with {@link useEditSend}.
 * Pass the revision on screen: if the agent revised it since, the server
 * refuses (409) and sends nothing, and the refetch shows the new version.
 */
export function useApproveSend(mailboxId: string) {
	const invalidate = useInvalidate(mailboxId);
	return useMutation({
		mutationFn: ({ id, revision }: { id: string; revision?: number }) => api.approveApproval(mailboxId, id, revision),
		onSettled: invalidate,
	});
}

/** Save edits to a held message. The server re-verifies and returns what will now be sent. */
export function useEditSend(mailboxId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, edits }: { id: string; edits: SendApprovalEdits }) => api.editApproval(mailboxId, id, edits),
		onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.approvals.all(mailboxId) }),
	});
}

export function useRejectSend(mailboxId: string) {
	const invalidate = useInvalidate(mailboxId);
	return useMutation({
		mutationFn: ({ id, note }: { id: string; note?: string }) => api.rejectApproval(mailboxId, id, note),
		onSettled: invalidate,
	});
}

export function useRetrySend(mailboxId: string) {
	const invalidate = useInvalidate(mailboxId);
	return useMutation({
		mutationFn: (id: string) => api.retryApproval(mailboxId, id),
		onSettled: invalidate,
	});
}
