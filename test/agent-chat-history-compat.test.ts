// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Agent chat history written before the AI SDK v7 / @cloudflare/ai-chat 0.12
 * upgrade still loads.
 *
 * The rows below are what `@cloudflare/ai-chat@0.1.8` (AI SDK v6) stored in
 * `cf_ai_chat_agent_messages.message`: `JSON.stringify` of a v6 `UIMessage`,
 * including the extra `content`/`createdAt` fields `handleNewEmail` adds to its
 * auto-draft log rows. On first wake 0.12 lifts each row with
 * `autoTransformMessages`, drops anything failing its structure check, and
 * hands the transcript to `onChatMessage`, which converts it with v7's
 * `convertToModelMessages`. This runs those real steps over the fixture; no
 * part of `ai` or `@cloudflare/ai-chat` is mocked.
 */

import { describe, expect, it } from "vitest";
import { autoTransformMessages } from "@cloudflare/ai-chat/ai-chat-v5-migration";
import { convertToModelMessages, type UIMessage } from "ai";
import { z } from "zod";

/** Exactly the stored strings: one per row of the 0.1.8 table. */
const LEGACY_ROWS: string[] = [
	// handleNewEmail's log pair (content + createdAt alongside parts).
	JSON.stringify({
		id: "auto-user-1",
		role: "user",
		content: '[Auto-triggered] New email from ada@example.com: "Invoice 42"',
		createdAt: "2026-10-20T09:00:00.000Z",
		parts: [{ type: "text", text: '[Auto-triggered] New email from ada@example.com: "Invoice 42"' }],
	}),
	JSON.stringify({
		id: "auto-assistant-1",
		role: "assistant",
		content: "Created draft reply to ada@example.com.",
		createdAt: "2026-10-20T09:00:01.000Z",
		parts: [{ type: "text", text: "Created draft reply to ada@example.com." }],
	}),
	// A panel turn: the user asks, the model calls a tool, then answers.
	JSON.stringify({
		id: "panel-user-1",
		role: "user",
		parts: [{ type: "text", text: "What came in today?" }],
	}),
	JSON.stringify({
		id: "panel-assistant-1",
		role: "assistant",
		parts: [
			{ type: "step-start" },
			{
				type: "tool-list_emails",
				toolCallId: "call_1",
				state: "output-available",
				input: { folder: "inbox", limit: 20, page: 1 },
				output: [{ id: "e1", subject: "Invoice 42", sender: "ada@example.com" }],
			},
			{ type: "step-start" },
			{ type: "text", text: "One email: Invoice 42 from Ada.", state: "done" },
		],
	}),
	// A turn that stopped on a tool error, and a draft_reply tool result the
	// panel's "Edit draft" button reads.
	JSON.stringify({
		id: "panel-assistant-2",
		role: "assistant",
		parts: [
			{ type: "step-start" },
			{
				type: "tool-get_email",
				toolCallId: "call_2",
				state: "output-error",
				input: { emailId: "missing" },
				errorText: "Email not found",
			},
			{
				type: "tool-draft_reply",
				toolCallId: "call_3",
				state: "output-available",
				input: { originalEmailId: "e1", to: "ada@example.com", subject: "Re: Invoice 42", body: "Paid, thanks." },
				output: { id: "draft-1", status: "draft" },
			},
			{ type: "text", text: "Drafted a reply to Ada.", state: "done" },
		],
	}),
	// v6 persisted empty reasoning parts with provider metadata.
	JSON.stringify({
		id: "panel-assistant-3",
		role: "assistant",
		parts: [
			{ type: "reasoning", text: "", providerMetadata: { workersai: { note: "x" } } },
			{ type: "text", text: "Done." },
		],
	}),
];

/** The structure gate 0.12 applies to every lifted and hydrated row. */
function isValidMessageStructure(m: unknown): boolean {
	if (typeof m !== "object" || m === null) return false;
	const r = m as Record<string, unknown>;
	return (
		typeof r.id === "string" &&
		r.id.length > 0 &&
		(r.role === "user" || r.role === "assistant" || r.role === "system") &&
		Array.isArray(r.parts)
	);
}

/** The panel's tool names and input shapes (see createEmailTools). */
const tools = {
	list_emails: { inputSchema: z.object({ folder: z.string(), limit: z.number(), page: z.number() }) },
	get_email: { inputSchema: z.object({ emailId: z.string() }) },
	draft_reply: {
		inputSchema: z.object({ originalEmailId: z.string(), to: z.string(), subject: z.string(), body: z.string() }),
	},
};

function lift(rows: string[]): UIMessage[] {
	const out: UIMessage[] = [];
	for (const row of rows) {
		const message = autoTransformMessages([JSON.parse(row)])[0];
		if (message && isValidMessageStructure(message)) out.push(message as UIMessage);
	}
	return out;
}

describe("agent chat history from before the v7 upgrade", () => {
	it("every legacy row survives the 0.12 lift unchanged in shape", () => {
		const lifted = lift(LEGACY_ROWS);
		expect(lifted.map((m) => m.id)).toEqual([
			"auto-user-1",
			"auto-assistant-1",
			"panel-user-1",
			"panel-assistant-1",
			"panel-assistant-2",
			"panel-assistant-3",
		]);
		// Parts are not rewritten: the panel renders the same tool badges,
		// text and draft buttons it did before.
		const before = LEGACY_ROWS.map((r) => (JSON.parse(r) as UIMessage).parts);
		expect(lifted.map((m) => m.parts)).toEqual(before);
	});

	it("hydrating twice is stable (the transform runs on every wake)", () => {
		const once = lift(LEGACY_ROWS);
		const twice = autoTransformMessages(once);
		expect(twice).toEqual(once);
	});

	it("converts to v7 model messages for the next panel turn", async () => {
		const model = await convertToModelMessages(lift(LEGACY_ROWS), { tools: tools as never });
		// No system role can come from stored rows.
		expect(model.some((m) => m.role === "system")).toBe(false);
		const toolCalls = model.flatMap((m) =>
			m.role === "assistant" && Array.isArray(m.content)
				? m.content.filter((p) => p.type === "tool-call").map((p) => (p as { toolName: string }).toolName)
				: [],
		);
		expect(toolCalls).toEqual(["list_emails", "get_email", "draft_reply"]);
		const toolResults = model.flatMap((m) =>
			m.role === "tool" ? m.content.map((p) => (p as { toolCallId: string }).toolCallId) : [],
		);
		expect(toolResults).toEqual(expect.arrayContaining(["call_1", "call_2", "call_3"]));
		// The user text and the final assistant text are carried through.
		const text = JSON.stringify(model);
		expect(text).toContain("What came in today?");
		expect(text).toContain("One email: Invoice 42 from Ada.");
		expect(text).toContain("Drafted a reply to Ada.");
	});
});
