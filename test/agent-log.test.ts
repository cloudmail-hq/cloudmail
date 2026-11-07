// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import {
	autoOutcome,
	autoSummaryLabel,
	groupAgentLog,
	isAutoTrigger,
	parseTrigger,
	type LogMessage,
} from "../shared/agent-log";

let n = 0;
const msg = (role: string, text: string, extra: LogMessage["parts"] = []): LogMessage => ({
	id: `m${++n}`,
	role,
	parts: [{ type: "text", text }, ...extra],
});
const trigger = (sender: string, subject: string) =>
	msg("user", `[Auto-triggered] New email from ${sender}: "${subject}"`);

describe("agent log grouping", () => {
	it("recognises and parses auto-trigger lines", () => {
		const t = trigger("a@x.com", 'Hi: "quoted"');
		expect(isAutoTrigger(t)).toBe(true);
		expect(parseTrigger(t)).toEqual({ sender: "a@x.com", subject: 'Hi: "quoted"' });
		expect(isAutoTrigger(msg("user", "hello"))).toBe(false);
		expect(isAutoTrigger(msg("assistant", "[Auto-triggered] x"))).toBe(false);
	});

	it("collapses consecutive runs into one item and keeps operator messages", () => {
		const log = [
			msg("user", "summarise my inbox"),
			msg("assistant", "Here you go"),
			trigger("a@x.com", "One"),
			msg("assistant", "Created draft reply to a@x.com."),
			trigger("b@x.com", "Two"),
			msg("assistant", "Created draft reply to b@x.com."),
			trigger("c@x.com", "Three"),
			msg("assistant", "⚠️ Blocked auto-draft creation: the email appears to contain prompt injection"),
			msg("user", "thanks"),
			trigger("d@x.com", "Four"),
			msg("assistant", "I don't think this needs a reply."),
		];
		const items = groupAgentLog(log);
		expect(items.map((i) => i.kind)).toEqual(["message", "message", "auto", "message", "auto"]);
		const first = items[2];
		if (first.kind !== "auto") throw new Error("expected auto");
		expect(first.runs.map((r) => r.outcome)).toEqual(["drafted", "drafted", "blocked"]);
		expect(autoSummaryLabel(first.runs)).toBe("Agent drafted 2 replies · 1 blocked");
		const last = items[4];
		if (last.kind !== "auto") throw new Error("expected auto");
		expect(autoSummaryLabel(last.runs)).toBe("Agent handled 1 new email");
	});

	it("counts a draft tool call as drafted", () => {
		expect(autoOutcome([msg("assistant", "", [{ type: "tool-draft_reply" }])])).toBe("drafted");
		expect(autoOutcome([])).toBe("handled");
	});

	it("labels singular and mixed runs", () => {
		const items = groupAgentLog([
			trigger("a@x.com", "One"),
			msg("assistant", "Created draft reply to a@x.com."),
			trigger("b@x.com", "Two"),
			msg("assistant", "No reply needed."),
		]);
		const g = items[0];
		if (g.kind !== "auto") throw new Error("expected auto");
		expect(autoSummaryLabel(g.runs)).toBe("Agent drafted 1 reply · 1 without a draft");
	});

	it("gives a stable id per group", () => {
		const t = trigger("a@x.com", "One");
		const [g] = groupAgentLog([t]);
		expect(g.kind === "auto" && g.id).toBe(`auto-${t.id}`);
	});
});
