// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Make stored tool-call ids safe for every provider.
 *
 * The agent replays its saved chat history to the model on every turn. Tool
 * calls in that history keep the id the provider of the day generated, and
 * providers disagree on what an id may contain. Anthropic accepts only
 * `^[a-zA-Z0-9_-]+$`, and Workers AI models produce ids with other characters,
 * so after switching to an Anthropic-compatible gateway every turn failed with
 * `tool_use.id: String should match pattern`, and the agent never replied.
 *
 * `normaliseToolCallIds` rewrites every `toolCallId` in a list of model
 * messages through one map, so a call and its result (and an approval request
 * and response) still pair up. Ids that are already safe are kept as they are,
 * so a conversation that only ever used one provider is unchanged.
 */

const SAFE_ID = /^[a-zA-Z0-9_-]{1,64}$/;

/** A safe id derived from `raw`: unsafe characters become `_`, then a short hash keeps distinct ids distinct. */
export function safeToolCallId(raw: string): string {
	if (SAFE_ID.test(raw)) return raw;
	let h = 2166136261;
	for (let i = 0; i < raw.length; i++) {
		h ^= raw.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	const base = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "call";
	return `${base}_${(h >>> 0).toString(36)}`;
}

/** Rewrite every `toolCallId` (at any depth) through one id map. Returns new objects; the input is not mutated. */
export function normaliseToolCallIds<T>(messages: T[]): T[] {
	const map = new Map<string, string>();
	const used = new Set<string>();
	const idFor = (raw: string): string => {
		const known = map.get(raw);
		if (known) return known;
		let id = safeToolCallId(raw);
		// Two different raw ids must never collapse onto one safe id.
		for (let n = 2; used.has(id) && map.get(raw) !== id; n++) id = `${safeToolCallId(raw)}_${n}`;
		map.set(raw, id);
		used.add(id);
		return id;
	};
	const walk = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(walk);
		if (value === null || typeof value !== "object") return value;
		const out: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
			out[key] = key === "toolCallId" && typeof v === "string" ? idFor(v) : walk(v);
		}
		return out;
	};
	return messages.map((m) => walk(m) as T);
}
