// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Settings → Cloudflare connection. Server side in `workers/routes/cloudflare.ts`. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CfConnectionView } from "../../shared/cf-connection";
import { request } from "~/services/api";
import { queryKeys } from "./keys";

const PATH = "/api/v1/cloudflare/connection";
export const cloudflareConnectionKey = ["cloudflare", "connection"] as const;

export function useCloudflareConnection(enabled = true) {
	return useQuery({
		queryKey: cloudflareConnectionKey,
		queryFn: ({ signal }) => request<CfConnectionView>(PATH, { signal }),
		enabled,
	});
}

/** Every mutation answers the new view; domains change their manual-mode notice with it. */
function useConnectionMutation<I>(fn: (input: I) => Promise<CfConnectionView>) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSuccess: (view) => {
			qc.setQueryData(cloudflareConnectionKey, view);
			void qc.invalidateQueries({ queryKey: queryKeys.domains.all });
		},
		// A refused re-check (token revoked) still updated the stored capabilities.
		onError: () => void qc.invalidateQueries({ queryKey: cloudflareConnectionKey }),
	});
}

export function useConnectCloudflare() {
	return useConnectionMutation((input: { token: string; accountId?: string }) =>
		request<CfConnectionView>(PATH, { method: "PUT", body: JSON.stringify(input) }),
	);
}

export function useVerifyCloudflare() {
	return useConnectionMutation((_: void) => request<CfConnectionView>(`${PATH}/verify`, { method: "POST" }));
}

export function useDisconnectCloudflare() {
	return useConnectionMutation((_: void) => request<CfConnectionView>(PATH, { method: "DELETE" }));
}
