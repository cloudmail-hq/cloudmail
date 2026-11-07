// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { BlockedSender } from "~/types";
import { queryKeys } from "./keys";

/**
 * Block rules are matched when mail arrives, so blocking a sender affects
 * future deliveries only — existing messages stay where they are. Callers that
 * want both behaviours should also move the open message to Spam.
 */

export function useBlockedSenders(mailboxId: string | undefined) {
	return useQuery<BlockedSender[]>({
		queryKey: mailboxId
			? queryKeys.blockedSenders.list(mailboxId)
			: ["blocked-senders", "_disabled"],
		queryFn: ({ signal }) => api.listBlockedSenders(mailboxId!, { signal }),
		enabled: !!mailboxId,
	});
}

function useInvalidateBlockedSenders() {
	const qc = useQueryClient();
	return (mailboxId: string) => {
		qc.invalidateQueries({ queryKey: queryKeys.blockedSenders.list(mailboxId) });
	};
}

/**
 * `pattern` is either a full address ("spam@example.com") or a domain suffix
 * ("@example.com"). It is lower-cased server-side; a duplicate returns 409.
 */
export function useBlockSender() {
	const invalidate = useInvalidateBlockedSenders();
	return useMutation({
		mutationFn: ({
			mailboxId,
			pattern,
			reason,
		}: { mailboxId: string; pattern: string; reason?: string | null }) =>
			api.blockSender(mailboxId, pattern, reason),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useUnblockSender() {
	const invalidate = useInvalidateBlockedSenders();
	return useMutation({
		mutationFn: ({ mailboxId, blockId }: { mailboxId: string; blockId: string }) =>
			api.unblockSender(mailboxId, blockId),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

/**
 * Allowed senders: exempt from heuristic spam scoring, so mail from them stays
 * in the inbox however it scores. Populated mostly by "Not spam" rather than by
 * hand; listed here so a mistake can be undone.
 */

export function useAllowedSenders(mailboxId: string | undefined) {
	return useQuery<BlockedSender[]>({
		queryKey: mailboxId
			? queryKeys.allowedSenders.list(mailboxId)
			: ["allowed-senders", "_disabled"],
		queryFn: ({ signal }) => api.listAllowedSenders(mailboxId!, { signal }),
		enabled: !!mailboxId,
	});
}

function useInvalidateAllowedSenders() {
	const qc = useQueryClient();
	return (mailboxId: string) => {
		qc.invalidateQueries({ queryKey: queryKeys.allowedSenders.list(mailboxId) });
	};
}

export function useAllowSender() {
	const invalidate = useInvalidateAllowedSenders();
	return useMutation({
		mutationFn: ({
			mailboxId,
			pattern,
			reason,
		}: { mailboxId: string; pattern: string; reason?: string | null }) =>
			api.allowSender(mailboxId, pattern, reason),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useDisallowSender() {
	const invalidate = useInvalidateAllowedSenders();
	return useMutation({
		mutationFn: ({ mailboxId, allowId }: { mailboxId: string; allowId: string }) =>
			api.disallowSender(mailboxId, allowId),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}
