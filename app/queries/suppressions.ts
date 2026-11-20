// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { SuppressionReason } from "~/services/api";
import { queryKeys } from "./keys";

export interface SuppressionListParams {
	q?: string;
	reason?: string;
	limit: number;
	offset: number;
}

export function useSuppressions(params: SuppressionListParams, enabled = true) {
	return useQuery({
		queryKey: queryKeys.suppressions.list({ ...params, q: params.q ?? "", reason: params.reason ?? "" }),
		queryFn: ({ signal }) => api.listSuppressions(params, { signal }),
		placeholderData: keepPreviousData,
		enabled,
	});
}

function useInvalidate() {
	const qc = useQueryClient();
	return () => qc.invalidateQueries({ queryKey: queryKeys.suppressions.all });
}

export function useAddSuppression() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: (entry: { address: string; scope?: string; reason?: SuppressionReason }) =>
			api.addSuppression(entry),
		onSuccess: invalidate,
	});
}

export function useDeleteSuppression() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: (id: string) => api.deleteSuppression(id),
		onSuccess: invalidate,
	});
}

export function useImportSuppressions() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: (data: { csv: string; reason?: SuppressionReason; scope?: string }) =>
			api.importSuppressions(data),
		onSuccess: invalidate,
	});
}

/**
 * Which of `addresses` are suppressed for mail from `from`, for the composer
 * warning chip. Cached briefly; the answer changes rarely and the composer
 * re-asks on every recipient edit.
 */
export function useSuppressionCheck(addresses: string[], from: string) {
	const sorted = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))].sort();
	return useQuery({
		queryKey: queryKeys.suppressions.check(sorted, from),
		queryFn: ({ signal }) => api.checkSuppressions(sorted, from, { signal }),
		enabled: sorted.length > 0 && !!from,
		staleTime: 60_000,
		// A failed check must never get in the way of composing.
		retry: false,
	});
}
