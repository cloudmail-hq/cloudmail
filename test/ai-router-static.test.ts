// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * No AI call bypasses the router.
 *
 * Every model call goes through workers/lib/ai-router.ts, which picks the
 * model per role, pins the injection scanner to Workers AI, applies the
 * timeouts and the breaker, and counts usage. A direct `env.AI.run`, a model
 * built by hand, or an AI SDK call with a hand-picked model anywhere else
 * would silently skip all of that, so this test reads the source and fails on
 * one. The router is the only file allowed to do these things.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const SCANNED = ["workers", "shared", "app"];
const ALLOWED = new Set(["workers/lib/ai-router.ts"]);

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
	{ name: "env.AI read", pattern: /\benv\s*\.\s*AI\b(?!_)/ },
	{ name: "AI binding run()", pattern: /\.AI\s*\.\s*run\s*\(|\bai\s*\.\s*run\s*\(|\bbinding\s*\.\s*run\s*\(/ },
	{ name: "createAI (agents/models/ai-sdk)", pattern: /\bcreateAI\s*\(|from\s+["']agents\/models\/ai-sdk["']/ },
	{ name: "workers-ai-provider", pattern: /\bcreateWorkersAI\s*\(|from\s+["']workers-ai-provider["']/ },
	{
		name: "an AI SDK provider",
		pattern: /from\s+["']@ai-sdk\/(anthropic|openai|openai-compatible|gateway)["']|\bcreate(Anthropic|OpenAI|OpenAICompatible|Gateway)\s*\(/,
	},
	// A bare call; `model.generateText(...)` (a router method) is a `.` call and allowed.
	{ name: "a direct AI SDK model call", pattern: /(?<![.\w$])(generateText|streamText|generateObject|streamObject|embedMany|embed)\s*\(/ },
	{ name: "importing generation functions from 'ai'", pattern: /import\s*\{[^}]*\b(generateText|streamText|generateObject|streamObject|embed|embedMany|wrapLanguageModel)\b[^}]*\}\s*from\s*["']ai["']/ },
	{ name: "meteredAi outside the router", pattern: /\bmeteredAi\s*\(/ },
];

/** Code without comments or string contents, so prose and prompts never trip a rule. */
function stripCommentsAndStrings(src: string): string {
	let out = "";
	let i = 0;
	while (i < src.length) {
		const c = src[i]!;
		const n = src[i + 1];
		if (c === "/" && n === "/") {
			while (i < src.length && src[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && n === "*") {
			i += 2;
			while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
				if (src[i] === "\n") out += "\n";
				i++;
			}
			i += 2;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			// Keep import specifiers (a string right after `from`), blank everything else.
			const keep = /\bfrom\s*$/.test(out);
			let j = i + 1;
			let body = "";
			while (j < src.length && src[j] !== c) {
				if (src[j] === "\\") {
					body += src[j]! + (src[j + 1] ?? "");
					j += 2;
					continue;
				}
				body += src[j]!;
				j++;
			}
			out += keep ? `${c}${body}${c}` : `${c}${body.replace(/[^\n]/g, " ")}${c}`;
			i = j + 1;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name.startsWith(".")) continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
		else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
	}
	return out;
}

/**
 * The gateway client builder may construct the provider SDK clients, and
 * nothing else: no model calls, no env.AI. The router still makes every call.
 */
const RULE_EXEMPTIONS: Record<string, readonly string[]> = {
	"workers/lib/ai-gateway-providers.ts": ["an AI SDK provider"],
};

function violations(file: string, code: string): string[] {
	const found: string[] = [];
	for (const { name, pattern } of FORBIDDEN) {
		if (RULE_EXEMPTIONS[file]?.includes(name)) continue;
		const lines = code.split("\n");
		lines.forEach((line, idx) => {
			if (pattern.test(line)) found.push(`${file}:${idx + 1} ${name}: ${line.trim()}`);
		});
	}
	return found;
}

describe("no AI call bypasses workers/lib/ai-router.ts", () => {
	it("no file outside the router calls env.AI.run, builds a model, or calls the AI SDK directly", () => {
		const found: string[] = [];
		for (const top of SCANNED) {
			for (const abs of sourceFiles(join(ROOT, top))) {
				const rel = relative(ROOT, abs);
				if (ALLOWED.has(rel)) continue;
				found.push(...violations(rel, stripCommentsAndStrings(readFileSync(abs, "utf8"))));
			}
		}
		expect(found).toEqual([]);
	});

	it("the router itself is where those calls live (the allowlist is not stale)", () => {
		const code = stripCommentsAndStrings(readFileSync(join(ROOT, "workers/lib/ai-router.ts"), "utf8"));
		expect(code).toMatch(/\.run\(/);
		expect(code).toMatch(/\bcreateAI\(/);
		expect(code).toMatch(/\benv\.AI\b/);
		expect(code).toMatch(/\bmeteredAi\(/);
	});

	// The rules themselves, so a loosened regex shows up here.
	it.each([
		["const r = await env.AI.run(model, body);"],
		["const r = await this.env.AI.run(model, body);"],
		["await ai.run('@cf/x', {});"],
		["const m = createAI({ binding })('@cf/x');"],
		['import { createAI } from "agents/models/ai-sdk";'],
		['import { createAnthropic } from "@ai-sdk/anthropic";'],
		["const r = await generateText({ model, prompt });"],
		["const s = streamText({ model, messages });"],
		["const v = await embedMany({ model, values });"],
		['import { generateText, tool } from "ai";'],
		['const b = meteredAi(env, "triage", raw);'],
	])("flags %s", (line) => {
		expect(violations("x.ts", stripCommentsAndStrings(line))).not.toEqual([]);
	});

	it.each([
		["const result = model.streamText({ instructions, tools });"],
		["const result = await model.generateText({ prompt });"],
		['return (await ai.resolve("embeddings")).embed(texts);'],
		["// env.AI.run is not called here"],
		['const s = "call env.AI.run(…) for the model";'],
		["const enabled = env.AI_FEATURES;"],
		['import { convertToModelMessages, isStepCount } from "ai";'],
		["/* generateText({ model }) */"],
	])("allows %s", (line) => {
		expect(violations("x.ts", stripCommentsAndStrings(line))).toEqual([]);
	});
});
