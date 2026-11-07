// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The MCP send tools hand their session actor to the pre-send gate, where the
 * agent approval rule holds them.
 *
 * `EmailMCP` needs a Durable Object runtime to import, so this asserts on the
 * source, the way `capability-non-http.test.ts` does. The gate's behaviour is
 * covered in `agent-send-approval.test.ts`; this pins that every send tool uses it.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../workers/mcp/index.ts", import.meta.url), "utf8");

function block(name: string): string {
	const start = src.indexOf(`this.server.tool(\n\t\t\t"${name}",`);
	expect(start, name).toBeGreaterThan(-1);
	const next = src.indexOf("this.server.tool(", start + 10);
	return src.slice(start, next === -1 ? undefined : next);
}

describe("MCP send tools go through the approval gate", () => {
	it.each([
		["send_email", "toolSendEmail"],
		["send_reply", "toolSendReply"],
		["forward_email", "toolForwardEmail"],
		["schedule_send", "toolScheduleSend"],
		["send_template", "toolSendTemplate"],
	])("%s calls %s once, with this session's actor, so the pre-send approval rule sees it", (tool, fn) => {
		const body = block(tool);
		expect(body.match(new RegExp(`${fn}\\(`, "g"))).toHaveLength(1);
		expect(body).toMatch(new RegExp(`${fn}\\(env, mailboxId, [\\s\\S]*?sendActor\\(who\\.principal\\)\\)`));
		expect(body).toContain("SEND_POLICY_NOTE");
	});

	it("the session actor carries the credential, the MCP surface and the injection state", () => {
		expect(src).toMatch(/const sendActor = \(principal: Principal\): SendActor => \(\{[\s\S]*?credential: principal\.credential[\s\S]*?via: "mcp"[\s\S]*?injectionSuspected: this\.injectionSuspected\(\)/);
	});

	it("get_email and get_thread scan for injection and mark results untrusted", () => {
		expect(block("get_email")).toMatch(/scanForInjection[\s\S]*markUntrustedEmail/);
		expect(block("get_thread")).toMatch(/scanForInjection[\s\S]*markUntrustedThread/);
	});

	it("approving and rejecting are not MCP tools, so an agent cannot release its own send", () => {
		expect(src).not.toMatch(/this\.server\.tool\(\s*"(approve|reject)/);
	});

	it("revise_pending_send only revises the caller's own pending send, never releases it", () => {
		const body = block("revise_pending_send");
		expect(body).toMatch(/reviseHeld\(\{[\s\S]*principal: who\.principal[\s\S]*via: "mcp"/);
		expect(body).toContain("editVerifier(env)");
		expect(body).toContain("revisionRecipientRefusal");
		expect(body).not.toMatch(/approveHeld|claimSendApproval|sendComposed/);
	});

	it("every non-read MCP tool is audited by the server.tool wrapper", () => {
		expect(src).toMatch(/annotations\.readOnlyHint === false && !MCP_GATED_SEND_TOOLS\.has\(name\)/);
		expect(src).toContain('action: "agent.write"');
	});
});
