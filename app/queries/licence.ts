/** The app licence. Server side in `workers/routes/licence.ts`. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LicenceView } from "../../shared/licence";
import { request } from "~/services/api";

const PATH = "/api/v1/licence";
export const licenceKey = ["licence"] as const;

/** Members get only `status`, `locked` and `enforcement`. */
export type LicenceResponse = Partial<LicenceView> & Pick<LicenceView, "status" | "locked" | "enforcement">;

export function useLicence(enabled = true) {
	return useQuery({
		queryKey: licenceKey,
		queryFn: ({ signal }) => request<LicenceResponse>(PATH, { signal }),
		enabled,
		staleTime: 60_000,
	});
}

function useLicenceMutation<I>(fn: (input: I) => Promise<LicenceResponse>) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSuccess: (view) => {
			qc.setQueryData(licenceKey, view);
			// Everything that answered 402 can load now (or must stop).
			void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== licenceKey[0] });
		},
	});
}

export function useActivateLicence() {
	return useLicenceMutation((licenceKey: string) =>
		request<LicenceResponse>(`${PATH}/activate`, { method: "POST", body: JSON.stringify({ licenceKey }) }),
	);
}

export function useRefreshLicence() {
	return useLicenceMutation((_: void) => request<LicenceResponse>(`${PATH}/refresh`, { method: "POST" }));
}

export function useDeactivateLicence() {
	return useLicenceMutation((licenceKey: string) =>
		request<LicenceResponse>(`${PATH}/deactivate`, { method: "POST", body: JSON.stringify({ licenceKey }) }),
	);
}
