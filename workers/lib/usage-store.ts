// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Storage for the Usage tab (AuthDO tables from migration
 * `0019_ai_usage_and_budget` and `0021_ai_usage_by_provider`): AI calls per
 * day and feature, model requests per day, provider and role (with tokens and
 * cost when reported), the budget thresholds, and the alerts already fired. Pure SQL over the AuthDO's
 * database, like `SendingHealthStore`, so it is testable on `node:sqlite`.
 */

import { PROVIDER_ID, isAiRole, type AiRole } from "../../shared/ai-providers";
import type { AiUsageEntry } from "./ai-usage";
import { EMPTY_BUDGET, isAiFeature, type AiFeature, type BudgetKind, type UsageBudget, type UsageBudgetPatch } from "../../shared/usage";

export interface UsageSql {
	exec(query: string, ...bindings: unknown[]): { toArray(): any[] };
}
export type UsageTransaction = <T>(fn: () => T) => T;

const LAST_RUN_KEY = "usage_budget_last_run";
/** Daily rows are kept this long: the current month plus the one before. */
const KEEP_DAYS = 62;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A non-negative finite count, or null when not reported. */
function count(n: unknown): number | null {
	return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}
function nullableNumber(v: unknown): number | null {
	return v == null ? null : Number(v);
}

export interface AiProviderUsageRow {
	provider_id: string;
	calls_mtd: number;
	calls_today: number;
	input_tokens_mtd: number | null;
	output_tokens_mtd: number | null;
	cost_mtd_usd: number | null;
}

export interface AiRoleUsageRow {
	role: AiRole;
	provider_id: string;
	calls_mtd: number;
	calls_today: number;
	input_tokens_mtd: number | null;
	output_tokens_mtd: number | null;
}

export class UsageStore {
	constructor(
		private readonly sql: UsageSql,
		private readonly transaction: UsageTransaction,
	) {}

	recordAiCall(feature: AiFeature, day: string, calls = 1): void {
		if (!isAiFeature(feature) || !(calls > 0)) return;
		this.sql.exec(
			`INSERT INTO ai_usage_daily (day, feature, calls) VALUES (?, ?, ?)
			 ON CONFLICT(day, feature) DO UPDATE SET calls = calls + excluded.calls`,
			day,
			feature,
			Math.floor(calls),
		);
	}

	/** Calls per feature since `fromDay` (inclusive), plus `today`'s. */
	aiCalls(fromDay: string, today: string): { feature: AiFeature; calls_mtd: number; calls_today: number }[] {
		const rows = this.sql
			.exec(
				`SELECT feature, SUM(calls) AS mtd, SUM(CASE WHEN day = ? THEN calls ELSE 0 END) AS today
				 FROM ai_usage_daily WHERE day >= ? GROUP BY feature`,
				today,
				fromDay,
			)
			.toArray();
		return rows
			.filter((r) => isAiFeature(r.feature))
			.map((r) => ({ feature: r.feature as AiFeature, calls_mtd: Number(r.mtd ?? 0), calls_today: Number(r.today ?? 0) }));
	}

	/**
	 * Add one model request (or `calls` of them) to today's row for its
	 * provider and role. Token and cost columns stay NULL until a call reports
	 * them; a null in the entry leaves the stored value as it is.
	 */
	recordAiUsage(entry: AiUsageEntry): void {
		if (!entry || typeof entry !== "object") return;
		const { day, providerId, role } = entry;
		if (typeof day !== "string" || !DAY.test(day)) return;
		if (typeof providerId !== "string" || !PROVIDER_ID.test(providerId)) return;
		if (!isAiRole(role) || !(typeof entry.calls === "number" && entry.calls > 0 && Number.isFinite(entry.calls))) return;
		const calls = Math.max(1, Math.floor(entry.calls));
		const input = count(entry.inputTokens);
		const output = count(entry.outputTokens);
		const cost = count(entry.costUsd);
		this.sql.exec(
			`INSERT INTO ai_usage_provider_daily (day, provider_id, role, calls, input_tokens, output_tokens, cost_usd, fallback_calls)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(day, provider_id, role) DO UPDATE SET
				calls = calls + excluded.calls,
				input_tokens = CASE WHEN excluded.input_tokens IS NULL THEN input_tokens ELSE COALESCE(input_tokens, 0) + excluded.input_tokens END,
				output_tokens = CASE WHEN excluded.output_tokens IS NULL THEN output_tokens ELSE COALESCE(output_tokens, 0) + excluded.output_tokens END,
				cost_usd = CASE WHEN excluded.cost_usd IS NULL THEN cost_usd ELSE COALESCE(cost_usd, 0) + excluded.cost_usd END,
				fallback_calls = fallback_calls + excluded.fallback_calls`,
			day,
			providerId,
			role,
			calls,
			input === null ? null : Math.round(input),
			output === null ? null : Math.round(output),
			cost,
			entry.fallback ? calls : 0,
		);
	}

	/**
	 * Requests per provider since `fromDay` (inclusive), plus `today`'s. Token
	 * and cost sums are null when no row in the window reported them (SQL SUM
	 * over only NULLs). Busiest first.
	 */
	aiUsageByProvider(fromDay: string, today: string): AiProviderUsageRow[] {
		return this.sql
			.exec(
				`SELECT provider_id, SUM(calls) AS mtd, SUM(CASE WHEN day = ? THEN calls ELSE 0 END) AS today,
					SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cost_usd) AS cost
				 FROM ai_usage_provider_daily WHERE day >= ? GROUP BY provider_id ORDER BY mtd DESC, provider_id`,
				today,
				fromDay,
			)
			.toArray()
			.map((r) => ({
				provider_id: String(r.provider_id),
				calls_mtd: Number(r.mtd ?? 0),
				calls_today: Number(r.today ?? 0),
				input_tokens_mtd: nullableNumber(r.input),
				output_tokens_mtd: nullableNumber(r.output),
				cost_mtd_usd: nullableNumber(r.cost),
			}));
	}

	/** Requests per role and provider since `fromDay` (inclusive), plus `today`'s. */
	aiUsageByRole(fromDay: string, today: string): AiRoleUsageRow[] {
		return this.sql
			.exec(
				`SELECT role, provider_id, SUM(calls) AS mtd, SUM(CASE WHEN day = ? THEN calls ELSE 0 END) AS today,
					SUM(input_tokens) AS input, SUM(output_tokens) AS output
				 FROM ai_usage_provider_daily WHERE day >= ? GROUP BY role, provider_id ORDER BY mtd DESC, role, provider_id`,
				today,
				fromDay,
			)
			.toArray()
			.filter((r) => isAiRole(r.role))
			.map((r) => ({
				role: r.role as AiRole,
				provider_id: String(r.provider_id),
				calls_mtd: Number(r.mtd ?? 0),
				calls_today: Number(r.today ?? 0),
				input_tokens_mtd: nullableNumber(r.input),
				output_tokens_mtd: nullableNumber(r.output),
			}));
	}

	pruneAiCalls(today: string): void {
		const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
		this.sql.exec(`DELETE FROM ai_usage_daily WHERE day < ?`, cutoff);
		this.sql.exec(`DELETE FROM ai_usage_provider_daily WHERE day < ?`, cutoff);
	}

	getBudget(): UsageBudget {
		const row = this.sql.exec(`SELECT ai_usd, email_usd, updated_at, updated_by FROM usage_budget WHERE id = 1`).toArray()[0];
		if (!row) return { ...EMPTY_BUDGET };
		return {
			ai_usd: row.ai_usd == null ? null : Number(row.ai_usd),
			email_usd: row.email_usd == null ? null : Number(row.email_usd),
			updated_at: row.updated_at == null ? null : Number(row.updated_at),
			updated_by: row.updated_by ?? null,
		};
	}

	setBudget(patch: UsageBudgetPatch, by: string | null, now: number): UsageBudget {
		return this.transaction(() => {
			const prev = this.getBudget();
			const next: UsageBudget = {
				ai_usd: patch.ai_usd === undefined ? prev.ai_usd : patch.ai_usd,
				email_usd: patch.email_usd === undefined ? prev.email_usd : patch.email_usd,
				updated_at: now,
				updated_by: by,
			};
			this.sql.exec(
				`INSERT INTO usage_budget (id, ai_usd, email_usd, updated_at, updated_by) VALUES (1, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET ai_usd = excluded.ai_usd, email_usd = excluded.email_usd,
					updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
				next.ai_usd,
				next.email_usd,
				next.updated_at,
				next.updated_by,
			);
			return next;
		});
	}

	/**
	 * Record that the alert for `month` and `kind` fired. True only for the
	 * first caller, so one alert goes out per month per kind.
	 */
	claimBudgetAlert(month: string, kind: BudgetKind, projected: number, threshold: number, now: number): boolean {
		return this.transaction(() => {
			const exists = this.sql.exec(`SELECT 1 AS x FROM usage_budget_alerts WHERE month = ? AND kind = ?`, month, kind).toArray()[0];
			if (exists) return false;
			this.sql.exec(
				`INSERT INTO usage_budget_alerts (month, kind, fired_at, projected_usd, threshold_usd) VALUES (?, ?, ?, ?, ?)`,
				month,
				kind,
				now,
				projected,
				threshold,
			);
			return true;
		});
	}

	firedAlerts(month: string): { kind: BudgetKind; fired_at: number }[] {
		return this.sql
			.exec(`SELECT kind, fired_at FROM usage_budget_alerts WHERE month = ?`, month)
			.toArray()
			.map((r) => ({ kind: r.kind as BudgetKind, fired_at: Number(r.fired_at) }));
	}

	/** At most one budget check per `intervalMs`, across isolates. In the AuthDO `meta` table. */
	claimBudgetCheck(now: number, intervalMs: number): boolean {
		return this.transaction(() => {
			const row = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, LAST_RUN_KEY).toArray()[0];
			const last = row ? Number(row.value) : 0;
			if (Number.isFinite(last) && now - last < intervalMs) return false;
			this.sql.exec(
				`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
				LAST_RUN_KEY,
				String(now),
			);
			return true;
		});
	}
}
