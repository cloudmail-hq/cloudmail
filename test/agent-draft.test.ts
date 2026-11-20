// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import {
	getDraftIdFromMessage,
	getToolNameFromPart,
	hasEditableDraft,
} from "~/lib/agent-draft";

/** A finished tool call, in the shape AI SDK v6 streams to the client. */
function toolPart(
	name: string,
	output: unknown,
	state = "output-available",
) {
	return { type: `tool-${name}`, state, output };
}

describe("getToolNameFromPart", () => {
	it("reads the name out of a static tool part type", () => {
		expect(getToolNameFromPart({ type: "tool-draft_reply" })).toBe(
			"draft_reply",
		);
	});

	it("reads the name off a dynamic tool part", () => {
		expect(
			getToolNameFromPart({ type: "dynamic-tool", toolName: "draft_email" }),
		).toBe("draft_email");
	});

	it("ignores parts that are not tool calls", () => {
		expect(getToolNameFromPart({ type: "text" })).toBeNull();
		expect(getToolNameFromPart({ type: "step-start" })).toBeNull();
	});

	it("returns null for a dynamic tool with no usable name", () => {
		expect(getToolNameFromPart({ type: "dynamic-tool" })).toBeNull();
		expect(
			getToolNameFromPart({ type: "dynamic-tool", toolName: 42 }),
		).toBeNull();
	});

	it("only strips the leading prefix", () => {
		// `replace` would have cut the substring out of the middle instead.
		expect(getToolNameFromPart({ type: "tool-my-tool-thing" })).toBe(
			"my-tool-thing",
		);
	});
});

describe("getDraftIdFromMessage", () => {
	it("finds the draft id a draft_reply call returned", () => {
		const message = {
			parts: [
				{ type: "text", text: "Drafted a reply to Tim." },
				toolPart("draft_reply", { status: "draft_saved", draftId: "d-1" }),
			],
		};

		expect(getDraftIdFromMessage(message)).toBe("d-1");
		expect(hasEditableDraft(message)).toBe(true);
	});

	it("treats draft_email the same way", () => {
		const message = {
			parts: [toolPart("draft_email", { status: "draft_saved", draftId: "d-2" })],
		};

		expect(getDraftIdFromMessage(message)).toBe("d-2");
	});

	it("finds the id on a dynamic tool part too", () => {
		const message = {
			parts: [
				{
					type: "dynamic-tool",
					toolName: "draft_reply",
					state: "output-available",
					output: { draftId: "d-3" },
				},
			],
		};

		expect(getDraftIdFromMessage(message)).toBe("d-3");
	});

	/**
	 * The regression this module was extracted for. The panel used to look for
	 * `part.toolName` and `part.result`, which are AI SDK v4 names, so a v6
	 * message yielded nothing and the edit button silently did the wrong thing.
	 */
	it("does not depend on the v4 toolName/result field names", () => {
		const v6Message = {
			parts: [toolPart("draft_reply", { draftId: "d-4" })],
		};

		expect(getDraftIdFromMessage(v6Message)).toBe("d-4");
	});

	it("ignores a call that is still streaming", () => {
		const message = {
			parts: [toolPart("draft_reply", undefined, "input-streaming")],
		};

		expect(getDraftIdFromMessage(message)).toBeNull();
		expect(hasEditableDraft(message)).toBe(false);
	});

	it("ignores a draft tool that returned an error", () => {
		const message = {
			parts: [
				toolPart("draft_reply", {
					error: "Draft verification failed — the body was entirely commentary.",
				}),
			],
		};

		expect(getDraftIdFromMessage(message)).toBeNull();
	});

	it("ignores tools that do not produce drafts", () => {
		const message = {
			parts: [
				toolPart("get_thread", { messages: [] }),
				toolPart("move_email", { draftId: "not-a-draft" }),
			],
		};

		expect(getDraftIdFromMessage(message)).toBeNull();
	});

	it("takes the last draft when a turn redrafted", () => {
		// A single turn can draft twice: the operator means the newer row.
		const message = {
			parts: [
				toolPart("draft_reply", { draftId: "first" }),
				toolPart("draft_reply", { draftId: "second" }),
			],
		};

		expect(getDraftIdFromMessage(message)).toBe("second");
	});

	it("is null for a message with no parts", () => {
		expect(getDraftIdFromMessage({ parts: [] })).toBeNull();
	});

	it("skips a non-object output rather than throwing", () => {
		const message = { parts: [toolPart("draft_reply", "draft saved")] };
		expect(getDraftIdFromMessage(message)).toBeNull();
	});

	it("skips a blank draft id", () => {
		const message = { parts: [toolPart("draft_reply", { draftId: "" })] };
		expect(getDraftIdFromMessage(message)).toBeNull();
	});
});
