/**
 * The verifier an edited or revised held body passes: the same one an agent's
 * first draft passes in `toolSendEmail`, so editing or revising a held send
 * can never store text a fresh send would have refused. Shared by the REST
 * routes (`workers/routes/approvals.ts`), the MCP `revise_pending_send` tool
 * and the in-app agent. A Markdown body is checked as text, then rendered into
 * the HTML part and the text part.
 */

import { neutraliseAgentHtml } from "../../shared/agent-output";
import { renderMarkdownEmail } from "../../shared/markdown-email";
import type { EditVerifier } from "./agent-send-gate";
import { isSendable, verifyDraft } from "./ai";
import { aiFor } from "./ai-router";
import type { Env } from "../types";

const NO_TEXT_LEFT = "That body has no message text left after checking. Write the message and try again.";

export function editVerifier(env: Env): EditVerifier {
	return async (body, format = "html") => {
		// Markdown is checked as the text it is, then rendered.
		const verified = await verifyDraft(aiFor(env, { feature: "verifier" }), body, format === "markdown" ? { format: "text" } : {});
		if (!isSendable(verified)) {
			return {
				ok: false,
				error:
					verified.status === "unavailable"
						? "The draft check is unavailable right now, so the edit was not saved. Try again shortly."
						: NO_TEXT_LEFT,
			};
		}
		if (format === "markdown") {
			const rendered = renderMarkdownEmail(verified.body);
			if (!rendered.html) return { ok: false, error: NO_TEXT_LEFT };
			return { ok: true, html: neutraliseAgentHtml(rendered.html), text: rendered.text };
		}
		return { ok: true, html: neutraliseAgentHtml(verified.body) };
	};
}
