// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Agent inboxes: list and end. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentInboxesApi } from "~/services/agent-inboxes-api";
import { queryKeys } from "./keys";

const key = ["agent-inboxes"] as const;

export function useAgentInboxes() {
	return useQuery({
		queryKey: key,
		queryFn: agentInboxesApi.list,
		retry: false,
		// Expiry runs on a five-minute cron; refresh so an ended one drops off.
		refetchInterval: 60_000,
	});
}

export function useEndAgentInbox() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (address: string) => agentInboxesApi.remove(address),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: key });
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}
