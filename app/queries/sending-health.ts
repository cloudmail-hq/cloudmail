// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Sending health (spam-rate circuit breaker) and per-mailbox send caps. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";

export const sendingHealthKeys = {
	all: ["sending-health"] as const,
	limits: (mailboxId: string) => ["send-limits", mailboxId] as const,
};

/**
 * Per-domain spam rate and pause state. The breaker is evaluated hourly, so a
 * five-minute stale time is plenty and keeps the banner cheap on every page.
 */
export function useSendingHealth(options: { enabled?: boolean } = {}) {
	return useQuery({
		queryKey: sendingHealthKeys.all,
		queryFn: ({ signal }) => api.getSendingHealth({ signal }),
		staleTime: 5 * 60_000,
		enabled: options.enabled ?? true,
		retry: false,
	});
}

export function useResumeBulkSending() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (domain: string) => api.resumeBulkSending(domain),
		onSuccess: () => qc.invalidateQueries({ queryKey: sendingHealthKeys.all }),
	});
}

export function useSendLimits(mailboxId: string | undefined) {
	return useQuery({
		queryKey: sendingHealthKeys.limits(mailboxId ?? ""),
		queryFn: () => api.getSendLimits(mailboxId!),
		enabled: !!mailboxId,
	});
}

export function useUpdateSendLimits(mailboxId: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (caps: { hourly?: number; daily?: number }) => api.updateSendLimits(mailboxId, caps),
		onSuccess: (data) => qc.setQueryData(sendingHealthKeys.limits(mailboxId), data),
	});
}
