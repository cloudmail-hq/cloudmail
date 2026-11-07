// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * AI roles and the deployment's optional AI provider config (R2
 * `ai/providers.json`).
 *
 * Every model call in the app names one role, and `workers/lib/ai-router.ts`
 * turns a role into a model. With no config file each role resolves to the
 * Workers AI model it has always used.
 *
 * Settings → AI providers writes the file (workers/routes/ai-providers.ts).
 * Tokens and secret header values are stored encrypted (`tokenEnc`,
 * `valueEnc`) and never returned by any API: reads carry `tokenHint` only.
 */

import { z } from "zod";

/** Every place the app calls a model. */
export const AI_ROLES = [
	/** Agent side panel: streaming chat with tools. */
	"agent_chat",
	/** Auto-draft on new mail: tools, non-streaming. */
	"auto_draft",
	/** Follow-up nudge draft. */
	"nudge",
	/** Thread summary: one-liner and bullets in one JSON call. */
	"summary",
	/** Post-ingest labels and Screener verdict, JSON schema output. */
	"triage",
	/** "Does this outbound message expect a reply?" yes/no. */
	"followup_classifier",
	/** Prompt-injection scan. Pinned to Workers AI in every configuration. */
	"injection_scanner",
	/** Removes agent artifacts from drafts before they are saved or sent. */
	"draft_verifier",
	/** Semantic search vectors (index and query). */
	"embeddings",
	/** "Ask my inbox" answer synthesis. */
	"ask_answer",
	/** Daily brief prose. The brief is model-free today; reserved. */
	"daily_brief",
] as const;
export type AiRole = (typeof AI_ROLES)[number];

export function isAiRole(value: unknown): value is AiRole {
	return typeof value === "string" && (AI_ROLES as readonly string[]).includes(value);
}

/**
 * Roles that never leave Workers AI, whatever the config says. The scanner
 * fails closed, so a gateway outage there would block every auto-draft and
 * every held MCP send; it stays in-network (lead decision, Oct 27 2026).
 */
export const WORKERS_AI_PINNED_ROLES: readonly AiRole[] = ["injection_scanner"];

/** Roles an admin may route to a gateway: every role but the pinned scanner. */
export const GATEWAY_ROLES: readonly AiRole[] = AI_ROLES.filter((r) => !WORKERS_AI_PINNED_ROLES.includes(r));

/** The id the router uses for the Workers AI binding as a provider. */
export const WORKERS_AI_PROVIDER_ID = "workers-ai";

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
export const MODEL_ID = /^[\w.\-/:@]{1,200}$/;
export const PROVIDER_ID = /^[a-z0-9-]{1,32}$/;

const HeaderSchema = z
	.object({
		name: z.string().regex(HEADER_NAME),
		value: z.string().max(4096).optional(),
		valueEnc: z.string().optional(),
		secret: z.boolean().default(false),
	})
	.strict();
export type AiProviderHeader = z.infer<typeof HeaderSchema>;

// ── Catalogue ──────────────────────────────────────────────────────

/** Where a capability value came from. Only `hint` is a guess. */
export const CAP_SOURCES = ["provider", "hint", "probe", "admin"] as const;
export type CapSource = (typeof CAP_SOURCES)[number];
export const CapSchema = z.object({ value: z.boolean().nullable(), source: z.enum(CAP_SOURCES) }).strict();
export type Cap = z.infer<typeof CapSchema>;

export const CAP_NAMES = ["tools", "json", "vision", "reasoning", "embed"] as const;
export type CapName = (typeof CAP_NAMES)[number];

const unknownCap = (): Cap => ({ value: null, source: "hint" });

/** One model a gateway serves, normalised from its list or entered by the admin. */
export const CatalogModelSchema = z
	.object({
		/** Exact string sent as `model`. */
		id: z.string().regex(MODEL_ID),
		label: z.string().max(200),
		kind: z.enum(["chat", "embedding", "other"]),
		contextTokens: z.number().int().positive().nullable().default(null),
		maxOutputTokens: z.number().int().positive().nullable().default(null),
		caps: z
			.object({
				tools: CapSchema.default(unknownCap),
				json: CapSchema.default(unknownCap),
				vision: CapSchema.default(unknownCap),
				reasoning: CapSchema.default(unknownCap),
				embed: CapSchema.default(unknownCap),
			})
			.strict()
			.default({}),
		embeddingDims: z.number().int().positive().nullable().optional(),
		lifecycle: z.enum(["active", "deprecated", "retired"]).optional(),
		/** USD per million tokens, only when the gateway publishes prices. */
		pricing: z
			.object({ inputPerMTok: z.number().min(0), outputPerMTok: z.number().min(0) })
			.strict()
			.nullable()
			.optional(),
		/** Size tier from the hints table, for suggestions. */
		tier: z.enum(["small", "mid", "strong"]).nullable().optional(),
		/** Entered by the admin (Azure deployments, AI Gateway ids, unlisted models). */
		custom: z.boolean().optional(),
		/** When Test last ran on this model. */
		testedAt: z.string().max(40).nullable().optional(),
	})
	.strict();
export type CatalogModel = z.infer<typeof CatalogModelSchema>;

export const CATALOGUE_STATUSES = ["never", "ok", "no-discovery", "auth-failed", "error"] as const;
export type CatalogueStatus = (typeof CATALOGUE_STATUSES)[number];
export const CatalogueSchema = z
	.object({
		fetchedAt: z.string().nullable().default(null),
		status: z.enum(CATALOGUE_STATUSES).default("never"),
		/** Short, redacted reason when status is not ok. */
		detail: z.string().max(300).nullable().optional(),
		models: z.array(CatalogModelSchema).max(2000).default([]),
	})
	.strict();
export type Catalogue = z.infer<typeof CatalogueSchema>;

// ── Provider ───────────────────────────────────────────────────────

export const AUTH_SCHEMES = ["bearer", "x-api-key", "api-key", "custom", "none"] as const;
export type AuthScheme = (typeof AUTH_SCHEMES)[number];

export const AuthSchema = z.discriminatedUnion("scheme", [
	z.object({ scheme: z.literal("bearer") }),
	z.object({ scheme: z.literal("x-api-key") }),
	z.object({ scheme: z.literal("api-key") }),
	z.object({ scheme: z.literal("custom"), header: z.string().regex(HEADER_NAME) }),
	z.object({ scheme: z.literal("none") }),
]);
export type AiProviderAuth = z.infer<typeof AuthSchema>;

export const AiProviderOptionsSchema = z
	.object({
		structuredOutputs: z.enum(["auto", "on", "off"]).default("auto"),
		includeUsage: z.boolean().default(true),
		timeoutScale: z.number().min(0.5).max(4).default(1),
		/** Allow a base URL on a port other than 443. */
		allowCustomPorts: z.boolean().default(false),
		/** Also read LiteLLM's `/model/info` during discovery (auto for LiteLLM-looking hosts). */
		litellmInfo: z.boolean().default(false),
	})
	.strict();

export const AiProviderSchema = z
	.object({
		id: z.string().regex(PROVIDER_ID).refine((id) => id !== WORKERS_AI_PROVIDER_ID, "reserved id"),
		label: z.string().trim().min(1).max(60),
		wire: z.enum(["openai", "anthropic"]),
		baseUrl: z.string().max(2048),
		exactBaseUrl: z.boolean().default(false),
		auth: AuthSchema,
		tokenEnc: z.string().nullable().default(null),
		tokenHint: z.string().max(8).nullable().default(null),
		headers: z.array(HeaderSchema).max(8).default([]),
		options: AiProviderOptionsSchema.default({}),
		enabled: z.boolean().default(true),
		catalogue: CatalogueSchema.default({}),
		customModels: z.array(CatalogModelSchema).max(50).default([]),
		createdAt: z.string().max(40).optional(),
		updatedAt: z.string().max(40).optional(),
	})
	// Fields written by a newer build are kept, not rejected.
	.passthrough();
export type AiProvider = z.infer<typeof AiProviderSchema>;

/** A role's model: which provider, which model id there. */
export const ModelRefSchema = z
	.object({
		/** Defaults to the routing's gateway provider. */
		providerId: z.string().max(32).optional(),
		modelId: z.string().regex(MODEL_ID),
	})
	.strict();
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const AiRoutingSchema = z
	.object({
		/** null: Workers AI for everything (today's behaviour). */
		gatewayProviderId: z.string().nullable().default(null),
		/** Per-role model. A role with no entry uses `default`, when set. */
		models: z.record(z.string(), ModelRefSchema).default({}),
		/** One model for every chat role without its own entry (no-discovery gateways). */
		default: ModelRefSchema.optional(),
		/** Off by default. When on, a failed gateway call retries once on Workers AI. */
		fallbackToWorkersAi: z.boolean().default(false),
		/** Roles kept on Workers AI by admin choice. The scanner is always pinned regardless. */
		workersAiExceptions: z.array(z.string()).default([]),
		/**
		 * Roles switched off by admin choice while a gateway is active. Only
		 * `embeddings` in v1 ("Semantic search off" for a gateway with no
		 * embedding model).
		 */
		disabledRoles: z.array(z.string()).default([]),
	})
	.strict();
export type AiRouting = z.infer<typeof AiRoutingSchema>;

/** A Workers AI model id: `@cf/…` or `@hf/…`. */
export const WORKERS_AI_MODEL_ID = /^@(cf|hf)\/[\w.\-/]{1,190}$/;

/** What the Test button found on one Workers AI model. Absent checks were not run. */
export const WorkersAiTestedSchema = z
	.object({
		testedAt: z.string().max(40),
		text: z.boolean().optional(),
		json: z.boolean().optional(),
		tools: z.boolean().optional(),
		embed: z.boolean().optional(),
		dims: z.number().int().positive().optional(),
	})
	.strict();
export type WorkersAiTested = z.infer<typeof WorkersAiTestedSchema>;

/**
 * The built-in provider's settings. `models` is the admin's per-role pick on
 * Workers AI (a role with no entry uses its default); the router uses it
 * whenever a role runs on Workers AI: no gateway, an exception, or fallback.
 * The injection scanner is never in it. `tested` keeps Test results by model.
 */
export const WorkersAiSettingsSchema = z
	.object({
		models: z.record(z.string(), z.string().regex(WORKERS_AI_MODEL_ID)).default({}),
		tested: z.record(z.string(), WorkersAiTestedSchema).default({}),
	})
	.strict();
export type WorkersAiSettings = z.infer<typeof WorkersAiSettingsSchema>;

export const AiProvidersFileSchema = z
	.object({
		version: z.literal(1).default(1),
		providers: z.array(AiProviderSchema).max(10).default([]),
		routing: AiRoutingSchema.default({}),
		workersAi: WorkersAiSettingsSchema.default({}),
	})
	.strict();
export type AiProvidersFile = z.infer<typeof AiProvidersFileSchema>;

/** Parse the stored file. Null when absent or invalid (the router then uses Workers AI). */
export function parseAiProvidersFile(raw: unknown): AiProvidersFile | null {
	if (raw === null || raw === undefined) return null;
	const parsed = AiProvidersFileSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

/** Every model a provider offers: discovered first, then the admin's custom ids. */
export function providerModels(provider: Pick<AiProvider, "catalogue" | "customModels">): CatalogModel[] {
	const seen = new Set<string>();
	const out: CatalogModel[] = [];
	for (const m of [...provider.customModels, ...provider.catalogue.models]) {
		if (seen.has(m.id)) continue;
		seen.add(m.id);
		out.push(m);
	}
	return out;
}
