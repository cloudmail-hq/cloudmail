// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Every outbound path goes through the pre-send gate.
 *
 * `sendEmail` requires a `SendClearance` that only `preSend` mints, so the type
 * checker already refuses a path that skips the gate. This test is the second
 * lock: it walks the Worker source for every `sendEmail(` call and asserts
 *
 *   1. the set of call sites is exactly the enumerated list below, so a NEW
 *      send path fails here until someone adds it (and decides its `kind`);
 *   2. each call site passes a clearance as its third argument, obtained from
 *      `preSend`/`preSendOrThrow`/the tools' `agentGate` in the same function;
 *   3. nothing outside `workers/email-sender.ts` calls the binding directly;
 *   4. no production code forges a clearance (`clearanceForTest`,
 *      `as SendClearance`).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else if (/\.(ts|tsx)$/.test(name)) out.push(full);
	}
	return out;
}

// The browser cannot reach the binding; `app/` only calls the REST API.
const SOURCES = [...walk(join(ROOT, "workers")), ...walk(join(ROOT, "shared"))].map(
	(file) => ({ file: relative(ROOT, file).replace(/\\/g, "/"), text: readFileSync(file, "utf8") }),
);

/** Strip comments so prose mentioning `sendEmail(` does not count. */
function code(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The enclosing function's text for a call at `index`, roughly: back to the previous top-level declaration. */
function enclosing(text: string, index: number): string {
	const before = text.slice(0, index);
	const starts = [...before.matchAll(/\n(?:export )?(?:async )?function |\n[a-zA-Z]+Routes\.(?:get|post|put|patch|delete)\(|\napp\.(?:get|post|put|patch|delete)\(|\n\tasync [a-zA-Z]+\(/g)];
	const start = starts.length ? starts[starts.length - 1].index! : 0;
	return text.slice(start, index);
}

/** Text of the call's argument list, balanced on parentheses. */
function callArgs(text: string, openParen: number): string {
	let depth = 0;
	for (let i = openParen; i < text.length; i++) {
		if (text[i] === "(") depth++;
		else if (text[i] === ")") {
			depth--;
			if (depth === 0) return text.slice(openParen + 1, i);
		}
	}
	throw new Error("unbalanced call");
}

interface CallSite {
	file: string;
	/** Name of the enclosing function or handler, for the enumerated list. */
	context: string;
	args: string;
	scope: string;
}

const sites: CallSite[] = [];
for (const { file, text } of SOURCES) {
	if (file === "workers/email-sender.ts") continue;
	const src = code(text);
	// Not `.sendEmail(`: a method of some other object (an API client).
	for (const m of src.matchAll(/(?<![.\w])sendEmail\(/g)) {
		const open = m.index! + "sendEmail".length;
		const scope = enclosing(src, m.index!);
		const name =
			/function ([a-zA-Z0-9_]+)/.exec(scope)?.[1] ??
			/async ([a-zA-Z0-9_]+)\(/.exec(scope)?.[1] ??
			/(?:app|[a-zA-Z]+Routes)\.(?:get|post|put|patch|delete)\(\s*["'`]([^"'`]+)/.exec(scope)?.[1] ??
			"?";
		sites.push({ file, context: name, args: callArgs(src, open), scope });
	}
}

/**
 * Every send path in the product, and the kind of mail it is. Adding a send
 * path means adding it here, which means deciding how suppressions apply.
 */
const EXPECTED: Record<string, string> = {
	"workers/index.ts :: /api/v1/mailboxes/:mailboxId/emails": "REST send (transactional, or bulk with transactional:false)",
	"workers/index.ts :: receiveEmail": "vacation auto-reply (automated)",
	"workers/routes/reply-forward.ts :: handleThreadedSend": "REST reply/forward (transactional)",
	"workers/routes/suppressions.ts :: /api/v1/mailboxes/:mailboxId/template-sends": "REST template sends (bulk)",
	"workers/lib/sequence-dispatch.ts :: dispatchOne": "sequence steps (bulk)",
	"workers/lib/tools.ts :: toolSendReply": "agent/MCP send_reply (transactional)",
	"workers/lib/tools.ts :: toolForwardEmail": "agent/MCP forward_email (transactional)",
	"workers/lib/tools.ts :: toolSendEmail": "agent/MCP send_email, and send_template via bulk (bulk)",
	"workers/lib/forwarding.ts :: forwardInboundMessage": "automatic inbound forwarding (automated)",
	"workers/durableObject/features.ts :: deliverScheduledEmail": "scheduled sends and undo-send (transactional)",
	"workers/auth/reset-email.ts :: sendResetEmail": "password reset (system)",
	"workers/lib/daily-brief.ts :: deliverBriefEmail": "daily brief to its owner (system)",
	"workers/lib/held-send.ts :: sendComposed": "an approved held send, released by a person (re-gated, released: true)",
};

describe("every send path goes through the pre-send gate", () => {
	it("finds exactly the enumerated send paths", () => {
		const found = sites.map((s) => `${s.file} :: ${s.context}`).sort();
		expect(found).toEqual(Object.keys(EXPECTED).sort());
	});

	it.each(sites.map((s) => [`${s.file} :: ${s.context}`, s] as const))(
		"%s passes a clearance from the gate",
		(_label, site) => {
			// Third argument present and named after the gate's result.
			expect(site.args).toMatch(/,\s*gate\.clearance\s*$/);
			// The gate was consulted in the same function.
			expect(site.scope).toMatch(/\b(?:preSend|preSendOrThrow|agentGate)\(/);
		},
	);

	it("only email-sender.ts calls the EMAIL binding", () => {
		const offenders = SOURCES.filter(({ file }) => file !== "workers/email-sender.ts")
			.filter(({ text }) => /\b(?:EMAIL|binding)\.send\(/.test(code(text)))
			.map(({ file }) => file);
		expect(offenders).toEqual([]);
	});

	it("no production code forges a clearance", () => {
		const offenders = SOURCES.filter(({ file }) => file !== "workers/lib/pre-send.ts")
			.filter(({ text }) => /clearanceForTest\(|as SendClearance\b/.test(code(text)))
			.map(({ file }) => file);
		expect(offenders).toEqual([]);
	});

	it("bulk paths are gated as bulk", () => {
		const bulk = sites.filter((s) =>
			["dispatchOne", "/api/v1/mailboxes/:mailboxId/template-sends"].includes(s.context),
		);
		expect(bulk).toHaveLength(2);
		for (const site of bulk) expect(site.scope).toMatch(/kind: "bulk"/);
	});

	it("the MCP send_template path is gated as bulk with unsubscribe headers", () => {
		const tools = SOURCES.find((s) => s.file === "workers/lib/tools.ts")!.text;
		const sendTemplate = tools.slice(tools.indexOf("export async function toolSendTemplate"));
		expect(sendTemplate.slice(0, 2500)).toMatch(/bulkCompliance\(/);
		expect(sendTemplate.slice(0, 2500)).toMatch(/bulk: \{ headers: compliance\.headers \}/);
	});
});

/**
 * Per-credential approval (workers/lib/agent-send-gate.ts) only works if each
 * path that an API token, OAuth grant or agent can reach hands the gate an
 * `actor`, and a composed `hold` payload to store. A path without an actor is
 * treated as a person and would never be held.
 */
describe("every caller-driven send path passes an actor to the gate", () => {
	const file = (name: string) => code(SOURCES.find((s) => s.file === name)!.text);
	const routeBody = (text: string, route: string) => {
		const start = text.indexOf(route);
		expect(start, route).toBeGreaterThan(-1);
		const next = text.slice(start + route.length).search(/\n(?:app|[a-zA-Z]+Routes)\.(?:get|post|put|patch|delete)\(/);
		return text.slice(start, next === -1 ? undefined : start + route.length + next);
	};

	it.each([
		["workers/index.ts", 'app.post("/api/v1/mailboxes/:mailboxId/emails"', "send_email"],
		["workers/index.ts", 'app.post("/api/v1/mailboxes/:mailboxId/scheduled-sends"', "schedule_send"],
		["workers/index.ts", 'app.post("/api/v1/sequences/:id/enroll"', "sequence_enroll"],
		["workers/routes/suppressions.ts", '"/api/v1/mailboxes/:mailboxId/template-sends"', "template_send"],
	])("%s %s", (name, route, action) => {
		const body = routeBody(file(name), route);
		expect(body).toMatch(/requestActor\(c\)/);
		expect(body).toContain(`action: "${action}"`);
		expect(body).toMatch(/payload: \{\s*(composed|enrollment)/);
	});

	it("REST reply and forward", () => {
		const body = file("workers/routes/reply-forward.ts");
		expect(body).toMatch(/actor: requestActor\(c\)/);
		expect(body).toMatch(/payload: \{\s*composed/);
	});

	it.each(["toolSendReply", "toolSendEmail", "toolForwardEmail", "toolScheduleSend"])("%s gates the composed draft with its actor", (fn) => {
		const tools = file("workers/lib/tools.ts");
		const start = tools.indexOf(`export async function ${fn}(`);
		const body = tools.slice(start, tools.indexOf("\nexport ", start + 10));
		expect(body).toMatch(/actor\?: SendActor/);
		expect(body).toMatch(/agentGate\([\s\S]*?\{\s*actor,[\s\S]*?draft: \{/);
	});

	it("every MCP send tool hands its session actor to the tool", () => {
		// Raw source: the comment stripper is line-based and over-strips this file.
		const mcp = SOURCES.find((s) => s.file === "workers/mcp/index.ts")!.text;
		for (const fn of ["toolSendReply", "toolSendEmail", "toolForwardEmail", "toolScheduleSend", "toolSendTemplate"]) {
			const call = mcp.indexOf(`await ${fn}(env, mailboxId,`);
			expect(call, fn).toBeGreaterThan(-1);
			expect(callArgs(mcp, call + `await ${fn}`.length)).toMatch(/sendActor\(who\.principal\)\s*$/);
		}
	});

	it("the approval rule is registered wherever the API and MCP run", () => {
		expect(file("workers/lib/agent-send-gate.ts")).toContain("PRE_SEND_RULES.push(agentApprovalRule)");
		expect(file("workers/mcp/index.ts")).toMatch(/from "\.\.\/lib\/agent-send-gate"/);
		expect(file("workers/index.ts")).toMatch(/from "\.\/lib\/agent-send-gate"/);
	});
});

describe("pre-send rule order", () => {
	it("runs the agent-inbox recipient policy (block) before agent approval (hold), both after the built-in checks", async () => {
		const { PRE_SEND_RULES } = await import("../workers/lib/pre-send");
		await import("../workers/lib/agent-send-gate");
		expect(PRE_SEND_RULES.map((r) => r.name)).toEqual(["agent-inbox-policy", "agent_send_approval"]);
	});
});
