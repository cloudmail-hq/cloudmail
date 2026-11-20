// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { normaliseToolCallIds, safeToolCallId } from "../shared/tool-call-ids";

const ANTHROPIC_ID = /^[a-zA-Z0-9_-]+$/;

describe("safeToolCallId", () => {
	it("keeps ids that are already safe", () => {
		expect(safeToolCallId("toolu_01ABC-def")).toBe("toolu_01ABC-def");
		expect(safeToolCallId("call_123")).toBe("call_123");
	});

	it("rewrites Workers AI style ids into the Anthropic pattern", () => {
		for (const raw of ["chatcmpl-tool-9f:0", "functions.list_emails:1", "call 1", "a/b+c=", "ünïcode"]) {
			expect(safeToolCallId(raw)).toMatch(ANTHROPIC_ID);
		}
	});

	it("keeps different unsafe ids distinct", () => {
		expect(safeToolCallId("functions.a:1")).not.toBe(safeToolCallId("functions.a:2"));
		expect(safeToolCallId("x:y")).not.toBe(safeToolCallId("x.y"));
	});

	it("is stable for the same input", () => {
		expect(safeToolCallId("functions.list_emails:0")).toBe(safeToolCallId("functions.list_emails:0"));
	});
});

describe("normaliseToolCallIds", () => {
	const history = [
		{ role: "user", content: [{ type: "text", text: "list my mail" }] },
		{
			role: "assistant",
			content: [{ type: "tool-call", toolCallId: "functions.list_emails:0", toolName: "list_emails", input: {} }],
		},
		{
			role: "tool",
			content: [{ type: "tool-result", toolCallId: "functions.list_emails:0", toolName: "list_emails", output: { type: "json", value: [] } }],
		},
	];

	it("gives every tool part a safe id, and a call keeps pairing with its result", () => {
		const out = normaliseToolCallIds(history) as typeof history;
		const callId = (out[1].content[0] as { toolCallId: string }).toolCallId;
		const resultId = (out[2].content[0] as { toolCallId: string }).toolCallId;
		expect(callId).toMatch(ANTHROPIC_ID);
		expect(resultId).toBe(callId);
	});

	it("leaves a single-provider conversation with safe ids unchanged", () => {
		const safe = [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "toolu_01X", toolName: "t", input: {} }] }];
		expect(normaliseToolCallIds(safe)).toEqual(safe);
	});

	it("does not mutate its input and leaves other fields alone", () => {
		const before = JSON.stringify(history);
		const out = normaliseToolCallIds(history) as typeof history;
		expect(JSON.stringify(history)).toBe(before);
		expect((out[0].content[0] as { text: string }).text).toBe("list my mail");
		expect((out[1].content[0] as { toolName: string }).toolName).toBe("list_emails");
	});

	it("never maps two different ids onto the same safe id", () => {
		const two = [
			{ role: "assistant", content: [{ type: "tool-call", toolCallId: "a:1", toolName: "t", input: {} }, { type: "tool-call", toolCallId: "a:2", toolName: "t", input: {} }] },
		];
		const out = normaliseToolCallIds(two) as typeof two;
		const [x, y] = out[0].content.map((p) => (p as { toolCallId: string }).toolCallId);
		expect(x).not.toBe(y);
	});
});
