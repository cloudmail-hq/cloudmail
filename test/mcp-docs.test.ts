/**
 * docs/mcp.md lists every tool the MCP server registers.
 *
 * `EmailMCP` needs a Durable Object runtime to import, so the tool names are
 * read from the source, the way `mcp-send-gate-wiring.test.ts` does. A tool
 * added to `workers/mcp/index.ts` without a row in the docs table fails here,
 * and so does a row left behind for a tool that was removed or renamed.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../workers/mcp/index.ts", import.meta.url), "utf8");
const doc = readFileSync(new URL("../docs/mcp.md", import.meta.url), "utf8");

/** Names passed to `this.server.<method>(`, in source order. */
function registered(method: "tool" | "prompt"): string[] {
	return [...src.matchAll(new RegExp(`this\\.server\\.${method}\\(\\s*"([a-z0-9_]+)"`, "g"))].map((m) => m[1]);
}

/** The body of one tool registration, up to the next one. */
function block(name: string): string {
	const start = src.indexOf(`this.server.tool(\n\t\t\t"${name}",`);
	expect(start, name).toBeGreaterThan(-1);
	const next = src.indexOf("this.server.tool(", start + 10);
	return src.slice(start, next === -1 ? undefined : next);
}

/** One section of the doc: from its `## ` heading to the next one. */
function section(heading: string): string {
	const start = doc.indexOf(`\n## ${heading}\n`);
	expect(start, `"## ${heading}" in docs/mcp.md`).toBeGreaterThan(-1);
	const next = doc.indexOf("\n## ", start + 1);
	return doc.slice(start, next === -1 ? undefined : next);
}

/** Tool names that start a table row: "| `name` | ...". */
function tableRows(text: string): string[] {
	return [...text.matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map((m) => m[1]);
}

const tools = registered("tool");
const rows = tableRows(section("Tools"));

describe("docs/mcp.md covers the MCP server", () => {
	it("finds the registrations in the source", () => {
		// Guards the parser: if the registration style changes and nothing
		// matches, every check below would pass on an empty list.
		expect(tools.length).toBeGreaterThanOrEqual(73);
		expect(tools).toContain("list_mailboxes");
		expect(new Set(tools).size).toBe(tools.length);
	});

	it("has a table row for every registered tool", () => {
		const missing = tools.filter((name) => !rows.includes(name));
		expect(missing, "tools registered in workers/mcp/index.ts with no row in the Tools table of docs/mcp.md").toEqual([]);
	});

	it("has no row for a tool that is not registered", () => {
		const stale = rows.filter((name) => !tools.includes(name));
		expect(stale, "rows in docs/mcp.md for tools workers/mcp/index.ts does not register").toEqual([]);
	});

	it("lists each tool once", () => {
		const repeated = rows.filter((name, i) => rows.indexOf(name) !== i);
		expect(repeated).toEqual([]);
	});

	it("names every tool that takes an idempotency_key in the Idempotency keys section", () => {
		const keyed = tools.filter((name) => block(name).includes("idempotency_key: idempotencyKeyParam"));
		expect(keyed.length).toBeGreaterThan(0);
		const text = section("Idempotency keys");
		const named = [...text.matchAll(/`([a-z0-9_]+)`/g)].map((m) => m[1]).filter((name) => tools.includes(name));
		expect([...new Set(named)].sort()).toEqual([...keyed].sort());
	});

	it("names every registered prompt", () => {
		const prompts = registered("prompt");
		expect(prompts.length).toBeGreaterThan(0);
		const text = section("Prompts");
		expect(prompts.filter((name) => !text.includes(`\`${name}`))).toEqual([]);
	});
});
