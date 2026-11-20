// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The Test button: one tiny call per capability against one model, so a
 * guess ("inferred") becomes a fact ("tested") before a role relies on it.
 *
 *   text   "Reply with OK." → any text back
 *   json   Output.object({ ok: boolean }) → parses
 *   tools  a `ping` tool with toolChoice "required" → a tool call comes back
 *   embed  embed("probe") → a vector; records its size
 *
 * Each costs a few dozen tokens. Calls go through the router's gateway model
 * (`resolveProbeModel`), so they use the guarded fetch, the breaker and the
 * usage counter like any other call. The prompts are fixed strings: no mail
 * is ever sent by a probe.
 */

import { z } from "zod";
import { jsonSchema, tool } from "ai";
import type { AiProvider, AiRole, CatalogModel } from "../../shared/ai-providers";
import { describeGatewayError } from "./ai-gateway-fetch";
import { probeModel, resolveModel, type ProviderFactory, type ResolvedModel } from "./ai-router";
import type { Env } from "../types";

export const PROBE_CHECKS = ["text", "json", "tools", "embed"] as const;
export type ProbeCheck = (typeof PROBE_CHECKS)[number];

export interface ProbeResult {
	check: ProbeCheck;
	ok: boolean;
	ms: number;
	error?: string;
	dims?: number;
}

export function defaultChecks(model: Pick<CatalogModel, "kind"> | undefined): ProbeCheck[] {
	return model?.kind === "embedding" ? ["embed"] : ["text", "json", "tools"];
}

const PING_SCHEMA = jsonSchema<{ value: string }>({
	type: "object",
	properties: { value: { type: "string" } },
	required: ["value"],
	additionalProperties: false,
});

/** The role a check runs under (its usage feature and timeout). */
function roleForCheck(check: ProbeCheck): AiRole {
	return check === "embed" ? "embeddings" : check === "tools" ? "agent_chat" : "summary";
}

export async function runProbes(
	env: Env,
	provider: AiProvider,
	modelId: string,
	checks: readonly ProbeCheck[],
	factory: ProviderFactory,
	secrets: readonly string[],
): Promise<ProbeResult[]> {
	return runChecks(checks, async (check) => probeModel(env, provider, modelId, factory, roleForCheck(check)), secrets);
}

/**
 * Test one Workers AI model: the same checks as a gateway, through the
 * router's Workers AI backend (the same `run` bodies and `createAI` path the
 * roles use), with exactly this model and no config, so a pass means Workers
 * AI itself answered for it.
 */
export async function runWorkersAiProbes(
	env: Parameters<typeof resolveModel>[0],
	modelId: string,
	checks: readonly ProbeCheck[],
): Promise<ProbeResult[]> {
	return runChecks(checks, (check) => resolveModel(env, roleForCheck(check), { config: null, workersAiModel: modelId }), []);
}

async function runChecks(
	checks: readonly ProbeCheck[],
	modelFor: (check: ProbeCheck) => Promise<ResolvedModel>,
	secrets: readonly string[],
): Promise<ProbeResult[]> {
	const out: ProbeResult[] = [];
	for (const check of checks) {
		const started = Date.now();
		try {
			const m = await modelFor(check);
			if (check === "text") {
				// The same call style the text roles use (`run` on Workers AI, generateText on a gateway).
				const text = String((await m.text({ system: "Answer briefly.", user: "Reply with the word OK.", maxTokens: 16 })) ?? "").trim();
				if (!text) throw new Error("empty reply");
				out.push({ check, ok: true, ms: Date.now() - started });
			} else if (check === "json") {
				const value = await m.json({
					system: "Answer with JSON only.",
					user: 'Return {"ok": true}.',
					maxTokens: 32,
					schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
				});
				const parsed = z.object({ ok: z.boolean() }).safeParse(typeof value === "string" ? safeJson(value) : value);
				if (!parsed.success) throw new Error("the reply was not the requested JSON");
				out.push({ check, ok: true, ms: Date.now() - started });
			} else if (check === "tools") {
				const r = await m.generateText({
					prompt: "Call the ping tool with value 'probe'.",
					tools: { ping: tool({ description: "Connectivity check.", inputSchema: PING_SCHEMA }) },
					toolChoice: "required",
					maxOutputTokens: 64,
					timeout: 20_000,
				} as never);
				const calls = (r as { toolCalls?: { toolName?: string }[] }).toolCalls ?? [];
				if (!calls.some((c) => c.toolName === "ping")) throw new Error("no tool call came back");
				out.push({ check, ok: true, ms: Date.now() - started });
			} else {
				const [vector] = await m.embed(["probe"]);
				if (!Array.isArray(vector) || vector.length === 0) throw new Error("no vector came back");
				out.push({ check, ok: true, ms: Date.now() - started, dims: vector.length });
			}
		} catch (e) {
			const d = describeGatewayError(e, secrets);
			out.push({ check, ok: false, ms: Date.now() - started, error: d.status ? `HTTP ${d.status}: ${d.message}` : d.message });
		}
	}
	return out;
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
	} catch {
		return null;
	}
}

/** Fold probe results into a model's capabilities, as `source: "probe"`. */
export function applyProbeResults(model: CatalogModel, results: readonly ProbeResult[], now: string): CatalogModel {
	const caps = { ...model.caps };
	let dims = model.embeddingDims;
	for (const r of results) {
		// A failed text check says nothing about the other capabilities.
		if (r.check === "json") caps.json = { value: r.ok, source: "probe" };
		if (r.check === "tools") caps.tools = { value: r.ok, source: "probe" };
		if (r.check === "embed") {
			caps.embed = { value: r.ok, source: "probe" };
			if (r.ok && r.dims) dims = r.dims;
		}
	}
	return { ...model, caps, embeddingDims: dims ?? null, testedAt: now };
}
