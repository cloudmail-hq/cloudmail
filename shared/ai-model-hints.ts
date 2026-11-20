// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Curated capability hints by model family, for gateway lists that say
 * nothing about what a model can do (most OpenAI-shape `/v1/models`).
 *
 * A hint is a guess: the UI labels it "inferred", and the routing gate
 * (shared/ai-gateway.ts) never accepts a hint for tools or JSON. The Test
 * button or an admin override turns a guess into a fact.
 *
 * Matched against the model id with any vendor prefix dropped
 * (`anthropic/claude-…`, `accounts/fireworks/models/…`, `models/gemini-…`),
 * lower-cased. First match wins, so specific rows come before families.
 */

export type ModelTier = "small" | "mid" | "strong";

export interface ModelHint {
	pattern: RegExp;
	tools?: boolean;
	json?: boolean;
	vision?: boolean;
	reasoning?: boolean;
	contextTokens?: number;
	tier?: ModelTier;
}

export const MODEL_HINTS: readonly ModelHint[] = [
	// Anthropic
	{ pattern: /^claude-.*haiku/, tools: true, json: true, vision: true, tier: "small", contextTokens: 200_000 },
	{ pattern: /^claude-.*opus/, tools: true, json: true, vision: true, reasoning: true, tier: "strong", contextTokens: 200_000 },
	{ pattern: /^claude-/, tools: true, json: true, vision: true, reasoning: true, tier: "mid", contextTokens: 200_000 },
	// OpenAI
	{ pattern: /^gpt-5.*(mini|nano)/, tools: true, json: true, vision: true, tier: "small" },
	{ pattern: /^gpt-5/, tools: true, json: true, vision: true, reasoning: true, tier: "strong" },
	{ pattern: /^gpt-4\.1.*(mini|nano)/, tools: true, json: true, vision: true, tier: "small" },
	{ pattern: /^gpt-4\.1/, tools: true, json: true, vision: true, tier: "mid" },
	{ pattern: /^gpt-4o-mini/, tools: true, json: true, vision: true, tier: "small" },
	{ pattern: /^gpt-4o/, tools: true, json: true, vision: true, tier: "mid" },
	{ pattern: /^o[134](-|$)/, tools: true, json: true, reasoning: true, tier: "strong" },
	{ pattern: /^gpt-oss/, tools: true, tier: "mid" },
	// Google
	{ pattern: /^gemini-.*(flash-lite|flash-8b)/, tools: true, json: true, vision: true, tier: "small" },
	{ pattern: /^gemini-.*flash/, tools: true, json: true, vision: true, tier: "small" },
	{ pattern: /^gemini-/, tools: true, json: true, vision: true, reasoning: true, tier: "strong" },
	{ pattern: /^gemma-/, tier: "small" },
	// DeepSeek
	{ pattern: /^deepseek-v4.*flash/, tools: true, json: true, tier: "small" },
	{ pattern: /^deepseek-(v4|chat|reasoner)/, tools: true, json: true, tier: "mid" },
	// Open-weight families with tool calling
	{ pattern: /^qwen3/, tools: true, tier: "mid" },
	{ pattern: /^kimi-k2/, tools: true, tier: "strong" },
	{ pattern: /^glm-4/, tools: true, tier: "mid" },
	{ pattern: /^(mistral|ministral|codestral|magistral)-.*(small|tiny|3b|8b)/, tools: true, tier: "small" },
	{ pattern: /^(mistral|ministral|magistral)-/, tools: true, tier: "mid" },
	{ pattern: /^llama-3\.1-8b|^llama3\.1:8b|^meta-llama-3\.1-8b/, tools: false, tier: "small" },
	{ pattern: /^(llama-4|llama4)/, tools: true, tier: "mid" },
];

/** The id without vendor prefixes, lower-cased, for matching. */
export function hintKey(id: string): string {
	const lower = id.toLowerCase();
	const parts = lower.split("/");
	return parts[parts.length - 1]!.replace(/^models\//, "");
}

export function hintFor(id: string): ModelHint | null {
	const key = hintKey(id);
	return MODEL_HINTS.find((h) => h.pattern.test(key)) ?? null;
}

/** Embedding model ids, when the list has no type field. */
export const EMBEDDING_ID = /embed|bge-|(^|[/-])e5-|gte-|nomic-embed|voyage|text-embedding/i;
/** Ids that are neither chat nor embeddings: images, speech, moderation, rerank. */
export const OTHER_ID =
	/whisper|tts|dall-e|gpt-image|moderation|rerank|flux|stable-diffusion|imagen|veo|sora|transcribe|realtime|audio|davinci|babbage|computer-use/i;
