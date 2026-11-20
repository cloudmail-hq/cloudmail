// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Settings for AI summaries and the daily brief.
 *
 * Two records, because they answer to different people:
 *
 * - `AiConfig` is instance-wide and admin-owned (R2 `ai/settings.json`): whether
 *   summaries are generated at all, whether bulk mail is summarised too, and
 *   the per-mailbox daily cap. It decides what the deployment spends.
 * - `AssistantPrefs` is per user (the `AssistantDO` keyed by the signed-in
 *   identity): whether *I* see one-liners in the list, and *my* brief's time,
 *   zone and delivery. One person's 07:00 Europe/Berlin is not another's.
 */

import { z } from "zod";
import { DEFAULT_EMBED_DAILY_CAP, MAX_EMBED_DAILY_CAP } from "./semantic";

export { DEFAULT_EMBED_DAILY_CAP, MAX_EMBED_DAILY_CAP };

export const MIN_DAILY_CAP = 0;
export const MAX_DAILY_CAP = 5000;
export const DEFAULT_DAILY_CAP = 300;

export const AiConfigSchema = z
	.object({
		/** Generate summaries at all. Off stops new model calls; stored ones stay. */
		summaries: z.boolean().default(true),
		/**
		 * Summaries (the one-liner and the bullets) for known bulk/automated mail:
		 * newsletters, notifications, receipts. Stored as `bulkOneLiners` before
		 * bullets covered bulk mail; that name is still read and accepted.
		 */
		bulkSummaries: z.boolean().default(true),
		/**
		 * Generations per mailbox per UTC day, live, backfill and on-demand
		 * together. One generation is one model call for the line and bullets.
		 */
		dailyCapPerMailbox: z.number().int().min(MIN_DAILY_CAP).max(MAX_DAILY_CAP).default(DEFAULT_DAILY_CAP),
		/**
		 * Semantic search and "Ask my inbox": embed new mail into Vectorize.
		 * Off stops new embedding calls and hybrid queries; search falls back to
		 * full-text. Vectors already stored stay until their mail is deleted.
		 */
		semantic: z.boolean().default(true),
		/** Embedding calls (one per chunk) per mailbox per UTC day, live and backfill together. */
		embedDailyCapPerMailbox: z
			.number()
			.int()
			.min(MIN_DAILY_CAP)
			.max(MAX_EMBED_DAILY_CAP)
			.default(DEFAULT_EMBED_DAILY_CAP),
	})
	.strict();

export type AiConfig = z.infer<typeof AiConfigSchema>;

/** A patch. `bulkOneLiners` is the old name for `bulkSummaries`, still accepted. */
export const AiConfigPatchSchema = AiConfigSchema.partial()
	.extend({ bulkOneLiners: z.boolean().optional() })
	.strict()
	.transform(({ bulkOneLiners, ...rest }) =>
		rest.bulkSummaries === undefined && bulkOneLiners !== undefined ? { ...rest, bulkSummaries: bulkOneLiners } : rest,
	);
export type AiConfigPatch = z.output<typeof AiConfigPatchSchema>;

export const DEFAULT_AI_CONFIG: AiConfig = AiConfigSchema.parse({});

/** Tolerant read of whatever is in the bucket. */
export function normalizeAiConfig(raw: unknown): AiConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_AI_CONFIG };
	const r = raw as Record<string, unknown>;
	const cap = Number(r.dailyCapPerMailbox);
	const embedCap = Number(r.embedDailyCapPerMailbox);
	return {
		summaries: typeof r.summaries === "boolean" ? r.summaries : DEFAULT_AI_CONFIG.summaries,
		bulkSummaries:
			typeof r.bulkSummaries === "boolean"
				? r.bulkSummaries
				: typeof r.bulkOneLiners === "boolean"
					? r.bulkOneLiners
					: DEFAULT_AI_CONFIG.bulkSummaries,
		dailyCapPerMailbox:
			Number.isInteger(cap) && cap >= MIN_DAILY_CAP && cap <= MAX_DAILY_CAP
				? cap
				: DEFAULT_AI_CONFIG.dailyCapPerMailbox,
		semantic: typeof r.semantic === "boolean" ? r.semantic : DEFAULT_AI_CONFIG.semantic,
		embedDailyCapPerMailbox:
			Number.isInteger(embedCap) && embedCap >= MIN_DAILY_CAP && embedCap <= MAX_EMBED_DAILY_CAP
				? embedCap
				: DEFAULT_AI_CONFIG.embedDailyCapPerMailbox,
	};
}

// ── Per-user ───────────────────────────────────────────────────────

/** `HH:MM`, 24-hour. */
const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, 24-hour");

/** Accept only zones the runtime can format with. */
export function isValidTimeZone(zone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}

const TimeZone = z.string().min(1).max(64).refine(isValidTimeZone, "Unknown time zone");

export const AssistantPrefsSchema = z
	.object({
		/** Show the AI one-liner instead of the snippet in the message list. */
		listSummaries: z.boolean().default(true),
		brief: z
			.object({
				enabled: z.boolean().default(false),
				time: LocalTime.default("07:00"),
				timeZone: TimeZone.default("UTC"),
				/** Also email the brief to me, from `AUTH_EMAIL_FROM`. */
				email: z.boolean().default(false),
			})
			.strict()
			.default({}),
	})
	.strict();

export type AssistantPrefs = z.infer<typeof AssistantPrefsSchema>;

export const AssistantPrefsPatchSchema = z
	.object({
		listSummaries: z.boolean(),
		brief: z
			.object({
				enabled: z.boolean(),
				time: LocalTime,
				timeZone: TimeZone,
				email: z.boolean(),
			})
			.strict()
			.partial(),
	})
	.strict()
	.partial();

export type AssistantPrefsPatch = z.infer<typeof AssistantPrefsPatchSchema>;

export const DEFAULT_ASSISTANT_PREFS: AssistantPrefs = AssistantPrefsSchema.parse({});

export function normalizeAssistantPrefs(raw: unknown): AssistantPrefs {
	const parsed = AssistantPrefsSchema.safeParse(raw ?? {});
	if (parsed.success) return parsed.data;
	// Field-by-field fallback for a record written by another version.
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
	const b = (r.brief && typeof r.brief === "object" ? r.brief : {}) as Record<string, unknown>;
	const d = DEFAULT_ASSISTANT_PREFS;
	return {
		listSummaries: typeof r.listSummaries === "boolean" ? r.listSummaries : d.listSummaries,
		brief: {
			enabled: typeof b.enabled === "boolean" ? b.enabled : d.brief.enabled,
			time: LocalTime.safeParse(b.time).success ? (b.time as string) : d.brief.time,
			timeZone: typeof b.timeZone === "string" && isValidTimeZone(b.timeZone) ? b.timeZone : d.brief.timeZone,
			email: typeof b.email === "boolean" ? b.email : d.brief.email,
		},
	};
}

export function mergeAssistantPrefs(current: AssistantPrefs, patch: AssistantPrefsPatch): AssistantPrefs {
	return {
		listSummaries: patch.listSummaries ?? current.listSummaries,
		brief: { ...current.brief, ...patch.brief },
	};
}
