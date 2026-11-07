// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Onboarding: discover, plan, apply and revert. Server side in `workers/routes/cloudflare-setup.ts`. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CfApplyResponse, CfDiscovery, CfDnsChange, CfPlanResponse } from "../../shared/cf-setup";
import { request } from "~/services/api";
import { queryKeys } from "./keys";

const BASE = "/api/v1/cloudflare";
export const cloudflareDiscoveryKey = ["cloudflare", "discover"] as const;
export const cloudflareChangesKey = ["cloudflare", "changes"] as const;

export type CfDiscoveryResponse = CfDiscovery & { cached?: boolean };

export function useCloudflareDiscovery(enabled: boolean) {
	return useQuery({
		queryKey: cloudflareDiscoveryKey,
		queryFn: ({ signal }) => request<CfDiscoveryResponse>(`${BASE}/discover`, { signal }),
		enabled,
		retry: false,
		staleTime: 60_000,
	});
}

export function useRefreshCloudflareDiscovery() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => request<CfDiscoveryResponse>(`${BASE}/discover?refresh=1`),
		onSuccess: (data) => qc.setQueryData(cloudflareDiscoveryKey, data),
	});
}

export function useCloudflarePlan() {
	return useMutation({
		mutationFn: (zones: string[]) => request<CfPlanResponse>(`${BASE}/plan`, { method: "POST", body: JSON.stringify({ zones }) }),
	});
}

export function useApplyCloudflarePlan() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (input: { zones: string[]; planHash: string; items: { id: string; confirm?: true }[] }) =>
			request<CfApplyResponse>(`${BASE}/apply`, { method: "POST", body: JSON.stringify(input) }),
		onSettled: () => {
			void qc.invalidateQueries({ queryKey: cloudflareChangesKey });
			void qc.invalidateQueries({ queryKey: cloudflareDiscoveryKey });
			void qc.invalidateQueries({ queryKey: queryKeys.domains.all });
			void qc.invalidateQueries({ queryKey: queryKeys.config });
		},
	});
}

export function useCloudflareChanges(enabled: boolean) {
	return useQuery({
		queryKey: cloudflareChangesKey,
		queryFn: ({ signal }) => request<{ changes: CfDnsChange[] }>(`${BASE}/changes`, { signal }),
		enabled,
	});
}

export function useRevertCloudflareChange() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) =>
			request<{ change: CfDnsChange; detail?: string }>(`${BASE}/changes/${encodeURIComponent(id)}/revert`, { method: "POST" }),
		onSettled: () => {
			void qc.invalidateQueries({ queryKey: cloudflareChangesKey });
			void qc.invalidateQueries({ queryKey: queryKeys.domains.all });
			void qc.invalidateQueries({ queryKey: queryKeys.config });
		},
	});
}
