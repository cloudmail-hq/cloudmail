// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The agent inbox send policy as a pre-send gate rule (`PRE_SEND_RULES` in
 * ./pre-send.ts), so every outbound path applies it: REST, MCP, the agent,
 * the undo-window and scheduled delivery, sequences, auto-reply and
 * forwarding. The REST middleware and MCP tools check the same policy earlier,
 * for a clearer answer; this is the backstop no new path can skip.
 *
 * Kept free of heavy imports: ./pre-send.ts is loaded by the email sender.
 */

import { agentInboxKey, decideAgentSendPolicy, type AgentInboxRecord } from "../../shared/agent-inboxes";
import type { PreSendRule } from "./pre-send";

export const agentInboxSendRule: PreSendRule = {
	name: "agent-inbox-policy",
	async check({ env, input, to, cc, bcc }) {
		// Password resets and other system mail belong to no mailbox.
		if (input.kind === "system" || !input.mailboxId) return null;
		// No R2 binding (a hand-built test env): no agent inboxes can exist. A
		// failed read throws and the gate fails closed, as for every rule.
		const bucket = (env as { BUCKET?: Partial<R2Bucket> }).BUCKET;
		if (typeof bucket?.get !== "function") return null;
		const object = await bucket.get(agentInboxKey(input.mailboxId));
		if (!object || typeof object.json !== "function") return null;
		const record = (await object.json()) as AgentInboxRecord;
		if (!record || typeof record !== "object" || typeof record.send_mode !== "string") return null;
		const tokenId = input.actor?.credential?.tokenId ?? null;
		const viaAgentToken = tokenId !== null && tokenId === record.token_id;
		const decision = decideAgentSendPolicy(record, [...to, ...cc, ...bcc], viaAgentToken);
		if (decision.ok) return null;
		return { outcome: "block", code: decision.code, status: decision.status, error: decision.error };
	},
};
