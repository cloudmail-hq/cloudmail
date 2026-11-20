// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The MCP server surface: tool annotations, the triage prompt, and the shape
 * of every registration.
 *
 * `EmailMCP` extends `McpAgent`, which needs a Durable Object runtime, so the
 * base class is mocked and registrations are read from the source, as in
 * `test/capability-non-http.test.ts`.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("agents/mcp", () => ({ McpAgent: class {} }));

const { ANNOTATIONS, triagePrompt } = await import("../workers/mcp/index");

const source = readFileSync(new URL("../workers/mcp/index.ts", import.meta.url), "utf8");

/** Each `this.server.tool(` call, with its name and full source text. */
function registrations() {
	const starts = [...source.matchAll(/this\.server\.tool\(\s*"([a-z_]+)"/g)];
	return starts.map((m, i) => ({
		name: m[1]!,
		text: source.slice(m.index!, starts[i + 1]?.index ?? source.indexOf("this.server.prompt(")),
	}));
}

const REQUESTED_TOOLS = [
	"list_folders",
	"create_folder",
	"list_labels",
	"apply_label",
	"remove_label",
	"create_label",
	"star_email",
	"snooze_email",
	"unsnooze_email",
	"set_priority",
	"archive_email",
	"trash_email",
	"restore_email",
	"mark_not_spam",
	"bulk_update",
	"forward_email",
	"schedule_send",
	"list_scheduled",
	"cancel_scheduled",
	"list_attachments",
	"get_attachment",
	"list_templates",
	"send_template",
	"list_people",
	"get_person_history",
	"list_rules",
	"create_rule",
	"get_mailbox_summary",
	"list_signatures",
	"list_awaiting_reply",
	"set_followup",
	"list_label_prompts",
	"set_label_prompt",
	"list_screener",
	"screen_sender",
];

describe("MCP tool registrations", () => {
	it("registers every requested tool exactly once", () => {
		const names = registrations().map((r) => r.name);
		for (const tool of REQUESTED_TOOLS) expect(names).toContain(tool);
		expect(new Set(names).size).toBe(names.length);
	});

	it("gives every tool annotations", () => {
		for (const { name, text } of registrations()) {
			expect({ name, annotated: /ANNOTATIONS\.[a-zA-Z]+,/.test(text) }).toEqual({
				name,
				annotated: true,
			});
		}
	});

	it("marks reads read-only and sends destructive and open-world", () => {
		const annotationOf = (name: string) =>
			registrations().find((r) => r.name === name)!.text.match(/ANNOTATIONS\.([a-zA-Z]+),/)![1];

		for (const read of ["list_emails", "get_email", "get_attachment", "get_mailbox_summary", "list_people"]) {
			expect(annotationOf(read)).toBe("readOnly");
		}
		// The admin domain tools only read (the audit re-run is the REST verify route).
		for (const read of ["list_domains", "get_domain_status"]) {
			expect(annotationOf(read)).toBe("readOnly");
		}
		for (const send of ["send_email", "send_reply", "forward_email", "schedule_send", "send_template"]) {
			expect(annotationOf(send)).toBe("send");
		}
		expect(ANNOTATIONS.send).toMatchObject({ destructiveHint: true, openWorldHint: true, readOnlyHint: false });
		expect(ANNOTATIONS.readOnly).toMatchObject({ readOnlyHint: true, destructiveHint: false });
	});

	it("gives every parameter a description", () => {
		// Each `name: z....` field in a tool's schema ends in .describe(...).
		// Shared params (mailboxParam etc.) are described where they are built.
		let checked = 0;
		for (const { name, text } of registrations()) {
			const schema = text.slice(text.indexOf("{"), text.indexOf("ANNOTATIONS."));
			const fields = [...schema.matchAll(/^\t{4}([a-z_A-Z]+): z[\s\S]*?(?=^\t{4}[a-z_A-Z]+: |^\t{3}\})/gm)];
			for (const field of fields) {
				expect({ tool: name, field: field[1], described: field[0].includes(".describe(") }).toEqual({
					tool: name,
					field: field[1],
					described: true,
				});
				checked++;
			}
		}
		// Guards the pattern itself: a regex that matched nothing would pass.
		expect(checked).toBeGreaterThan(40);
	});
});

describe("triage_inbox prompt", () => {
	it("names the mailbox and the tools, and never asks to send", () => {
		const text = triagePrompt("support@tapetide.com");
		expect(text).toContain("support@tapetide.com");
		for (const tool of ["get_mailbox_summary", "list_emails", "bulk_update", "draft_reply"]) {
			expect(text).toContain(tool);
		}
		expect(text).toContain("Never send");
		expect(text).not.toMatch(/send_email|send_reply/);
		expect(text).toMatch(/untrusted/i);
	});

	it("clamps the limit", () => {
		expect(triagePrompt("a@b.com", "500")).toContain("limit 100");
		expect(triagePrompt("a@b.com", "junk")).toContain("limit 25");
		expect(triagePrompt("a@b.com", "10")).toContain("limit 10");
	});
});
