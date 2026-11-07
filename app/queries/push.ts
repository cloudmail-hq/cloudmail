// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Web Push devices and preferences. See workers/routes/push.ts. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, request } from "~/services/api";
import { DEFAULT_PUSH_PREFS, type PushPrefs, type PushPrefsPatch } from "shared/push-policy";

export interface PushDevice {
	id: string;
	label: string;
	user_agent: string | null;
	push_service: string;
	created_at: string;
	last_success_at: string | null;
	failures: number;
}

export const pushKeys = {
	devices: ["push", "devices"] as const,
	prefs: ["push", "prefs"] as const,
};

/** A 409 means no person is signed in (local dev bypass, a token): read as empty. */
function orNullOn409<T>(fn: () => Promise<T>): Promise<T | null> {
	return fn().catch((e) => {
		if (e instanceof ApiError && e.status === 409) return null;
		throw e;
	});
}

export function usePushDevices() {
	return useQuery({
		queryKey: pushKeys.devices,
		queryFn: async ({ signal }) =>
			(await orNullOn409(() => request<{ subscriptions: PushDevice[] }>("/api/v1/push/subscriptions", { signal })))
				?.subscriptions ?? null,
	});
}

export function usePushPrefs() {
	return useQuery<PushPrefs | null>({
		queryKey: pushKeys.prefs,
		queryFn: ({ signal }) => orNullOn409(() => request<PushPrefs>("/api/v1/push/preferences", { signal })),
		placeholderData: DEFAULT_PUSH_PREFS,
		staleTime: Infinity,
	});
}

export function useUpdatePushPrefs() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (patch: PushPrefsPatch) =>
			request<PushPrefs>("/api/v1/push/preferences", { method: "PUT", body: JSON.stringify(patch) }),
		onSuccess: (next) => qc.setQueryData(pushKeys.prefs, next),
	});
}

export function useRevokePushDevice() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => request("/api/v1/push/subscriptions", { method: "DELETE", body: JSON.stringify({ id }) }),
		onSettled: () => qc.invalidateQueries({ queryKey: pushKeys.devices }),
	});
}

export function useSendTestPush() {
	return useMutation({
		mutationFn: () =>
			request<{ devices: number; sent: number; removed: number; failed: number }>("/api/v1/push/test", { method: "POST" }),
	});
}
