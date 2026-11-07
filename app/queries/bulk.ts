// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Bulk message actions and mark-all-read.
 *
 * Unlike the single-message mutations in ./emails.ts these do not update the
 * cache optimistically. A bulk action can move, delete or re-label a whole page
 * at once, and the server's `affected` count is the only honest answer about
 * what changed — patching rows locally and then correcting them produces a
 * visible flicker for no benefit. They invalidate and let the list refetch.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import api, { type BulkActionRequest } from "~/services/api";
import { queryKeys } from "./keys";

/**
 * Invalidate everything a bulk action can shift.
 *
 * Wider than the single-email invalidation because one request can change
 * folder membership, label membership and unread counts together.
 */
function useInvalidateAfterBulk() {
	const qc = useQueryClient();
	return (mailboxId: string) => {
		qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
		qc.invalidateQueries({ queryKey: queryKeys.folders.list(mailboxId) });
		qc.invalidateQueries({ queryKey: ["labels", mailboxId] });
		qc.invalidateQueries({ queryKey: queryKeys.snoozed.list(mailboxId) });
	};
}

export function useBulkAction() {
	const invalidate = useInvalidateAfterBulk();
	return useMutation({
		mutationFn: ({
			mailboxId,
			body,
		}: { mailboxId: string; body: BulkActionRequest }) =>
			api.bulkAction(mailboxId, body),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

/** Omit `scope` to clear unread across the whole mailbox. */
export function useMarkAllRead() {
	const invalidate = useInvalidateAfterBulk();
	return useMutation({
		mutationFn: ({
			mailboxId,
			scope,
		}: {
			mailboxId: string;
			scope?: { folder?: string; label_id?: string };
		}) => api.markAllRead(mailboxId, scope),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}
