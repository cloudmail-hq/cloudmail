// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The verifier an edited or revised held body passes: the same one an agent's
 * first draft passes in `toolSendEmail`, so editing or revising a held send
 * can never store text a fresh send would have refused. Shared by the REST
 * routes (`workers/routes/approvals.ts`), the MCP `revise_pending_send` tool
 * and the in-app agent.
 */

import { neutraliseAgentHtml } from "../../shared/agent-output";
import type { EditVerifier } from "./agent-send-gate";
import { isSendable, verifyDraft } from "./ai";
import { aiFor } from "./ai-router";
import type { Env } from "../types";

export function editVerifier(env: Env): EditVerifier {
	return async (html) => {
		const verified = await verifyDraft(aiFor(env, { feature: "verifier" }), html);
		if (!isSendable(verified)) {
			return {
				ok: false,
				error:
					verified.status === "unavailable"
						? "The draft check is unavailable right now, so the edit was not saved. Try again shortly."
						: "That body has no message text left after checking. Write the message and try again.",
			};
		}
		return { ok: true, html: neutraliseAgentHtml(verified.body) };
	};
}
