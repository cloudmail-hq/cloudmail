/** Group addresses (Settings → Groups). See workers/routes/groups.ts. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { request } from "~/services/api";

export interface MailGroup {
	address: string;
	name: string;
	members: string[];
	createdAt: number;
	updatedAt: number;
}

const KEY = ["groups"] as const;
const path = (address: string) => `/api/v1/groups/${encodeURIComponent(address)}`;

export function useGroups(enabled = true) {
	return useQuery({
		queryKey: KEY,
		queryFn: ({ signal }) => request<{ groups: MailGroup[] }>("/api/v1/groups", { method: "GET", signal }),
		enabled,
		select: (d) => d.groups,
	});
}

export function useSaveGroup() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (g: { address: string; name: string; members: string[] }) =>
			request<{ group: MailGroup }>(path(g.address), {
				method: "PUT",
				body: JSON.stringify({ name: g.name, members: g.members }),
			}),
		onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
	});
}

export function useDeleteGroup() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (address: string) => request<void>(path(address), { method: "DELETE" }),
		onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
	});
}
