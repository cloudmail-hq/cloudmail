// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Client for `/api/v1/agent-inboxes`. See workers/routes/agent-inboxes.ts. */

import type { AgentInboxView } from "shared/agent-inboxes";
import { request } from "./api";

const BASE = "/api/v1/agent-inboxes";

export interface AgentInboxEnded {
	address: string;
	token_revoked: boolean;
	webhook_disabled: boolean;
	archive: { key: string; messages: number; truncated: boolean } | null;
	mailbox_deleted: boolean;
}

export const agentInboxesApi = {
	list: () => request<{ agent_inboxes: AgentInboxView[] }>(BASE).then((r) => r.agent_inboxes),
	remove: (address: string) =>
		request<{ ended: AgentInboxEnded }>(`${BASE}/${encodeURIComponent(address)}`, { method: "DELETE" }).then((r) => r.ended),
};
