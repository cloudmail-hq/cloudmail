// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The Usage tab and the budget alert.
 *
 * `buildUsage` assembles `GET /api/v1/usage`: Cloudflare's month-to-date
 * numbers (`usage-cf.ts`, cached 5 minutes like the analytics console), the
 * local per-feature AI counts (`ai-usage.ts`), and each mailbox's caps.
 * Without a Cloudflare token the email count falls back to the mailboxes' own
 * ledgers and the Cloudflare-only parts are null.
 *
 * `maybeCheckUsageBudget` runs from the cron at most hourly (claimed in the
 * AuthDO) and enqueues `usage.budget_exceeded` once per month per kind when a
 * projection passes its threshold.
 */

import {
	AI_FEATURE_LABELS,
	AI_FEATURES,
	DO_INCLUDED_REQUESTS_PER_MONTH,
	EMAIL_INCLUDED_PER_MONTH,
	USAGE_PRICING,
	evaluateBudget,
	monthWindow,
	projectAi,
	projectEmail,
	projectMonthEnd,
	roundUsd,
	type AiFeature,
	type BudgetAlert,
	type BudgetKind,
	type MonthWindow,
	type UsageBudget,
	type UsageBudgetPatch,
	type UsageMailboxRow,
	type UsageAiProviderRow,
	type UsageAiRoleRow,
	type UsageResponse,
} from "../../shared/usage";
import { ROLE_LABELS } from "../../shared/ai-gateway";
import { WORKERS_AI_PROVIDER_ID } from "../../shared/ai-providers";
import { getAiProvidersFile } from "./ai-providers-store";
import type { AiProviderUsageRow, AiRoleUsageRow } from "./usage-store";
import type { SendUsage } from "../../shared/send-caps";
import type { Env } from "../types";
import { analyticsAccountId, analyticsCacheKey, analyticsClient, analyticsZoneTags, cachedJson, defaultCache, type CacheLike, type CfAnalyticsClient, type CfLimits } from "./cf-analytics";
import { workerScriptName } from "./cloudflare-api";
import { resolveWorkerScriptName } from "./cf-connection";
import { listMailboxes } from "./email-helpers";
import { readMailboxSettings } from "./triage";
import { fetchUsage, summarizeUsage, type UsageSummary } from "./usage-cf";
import { webhookStub } from "./webhooks";
import type { EnqueueInput } from "./webhooks-store";
import { loadStoredDomains } from "../routes/domains";

type AiCallRow = { feature: AiFeature; calls_mtd: number; calls_today: number };

/** The AuthDO methods this module calls. */
export interface UsageStoreApi {
	aiUsage(fromDay: string, today: string): Promise<{ feature: AiFeature; calls_mtd: number; calls_today: number }[]>;
	/** Optional: an older AuthDO isolate (or a test fake) may not have them yet. */
	aiUsageByProvider?(fromDay: string, today: string): Promise<AiProviderUsageRow[]>;
	aiUsageByRole?(fromDay: string, today: string): Promise<AiRoleUsageRow[]>;
	pruneAiUsage(today: string): Promise<void>;
	getUsageBudget(): Promise<UsageBudget>;
	setUsageBudget(patch: UsageBudgetPatch, by: string | null, now: number): Promise<UsageBudget>;
	claimBudgetAlert(month: string, kind: BudgetKind, projected: number, threshold: number, now: number): Promise<boolean>;
	firedBudgetAlerts(month: string): Promise<{ kind: BudgetKind; fired_at: number }[]>;
	claimBudgetCheck(now: number, intervalMs: number): Promise<boolean>;
}

export function usageStore(env: Env): UsageStoreApi | null {
	const ns = (env as unknown as { AUTH_STORE?: DurableObjectNamespace }).AUTH_STORE;
	if (!ns) return null;
	return ns.get(ns.idFromName("global")) as unknown as UsageStoreApi;
}

/** The MailboxDO methods read for the caps table. */
interface UsageMailboxStub {
	getSendUsage(): Promise<SendUsage>;
	triageStatus(): Promise<{ ai_calls_today: number }>;
}

/** The bucket R2 storage is read for: `R2_BUCKET_NAME`, else the Worker's name (they match in wrangler.jsonc). */
export function usageBucketName(env: Env): string {
	return (env as { R2_BUCKET_NAME?: string }).R2_BUCKET_NAME?.trim() || workerScriptName(env);
}

const accountIds = new Map<string, string>();

/** The Cloudflare account: `CF_ACCOUNT_ID` or the stored connection, else the owner of the first configured zone (cached per isolate). */
export async function accountIdFor(env: Env, client: CfAnalyticsClient): Promise<string | null> {
	const configured = await analyticsAccountId(env);
	if (configured) return configured;
	if (!client.hasRest) return null;
	await loadStoredDomains(env).catch(() => {});
	const zone = analyticsZoneTags(env)[0];
	if (!zone) return null;
	const known = accountIds.get(zone);
	if (known) return known;
	const id = await client.accountIdFor(zone);
	accountIds.set(zone, id);
	return id;
}

export interface CloudflareUsage {
	summary: UsageSummary | null;
	quota: UsageResponse["quota"];
	cachedAt?: string;
	error?: string;
	configured: boolean;
}

/** Cloudflare's numbers for the month, cached. Never throws. */
export async function cloudflareUsage(
	env: Env,
	window: MonthWindow,
	options: { client?: CfAnalyticsClient | null; cache?: CacheLike | null; refresh?: boolean } = {},
): Promise<CloudflareUsage> {
	const client = options.client === undefined ? await analyticsClient(env) : options.client;
	if (!client?.hasGraphql) return { summary: null, quota: null, configured: false };
	const cache = options.cache === undefined ? defaultCache() : options.cache;
	const errors: string[] = [];
	let accountId: string | null = null;
	try {
		accountId = await accountIdFor(env, client);
	} catch (e) {
		errors.push(`account: ${(e as Error).message}`);
	}
	if (!accountId) {
		if (!errors.length) errors.push("Connect Cloudflare in Settings → Cloudflare connection, set CF_ACCOUNT_ID, or give the token Zone Read so the account can be found");
		return { summary: null, quota: null, configured: true, error: errors.join("; ") };
	}
	// The window's end is floored to 5 minutes so the cache key is stable.
	const end = new Date(Math.floor(Date.parse(window.end) / 300_000) * 300_000).toISOString();
	const input = {
		accountId,
		start: window.start,
		end,
		startDate: window.startDate,
		endDate: window.today,
		script: await resolveWorkerScriptName(env),
		bucket: usageBucketName(env),
	};
	let summary: UsageSummary | null = null;
	let cachedAt: string | undefined;
	try {
		const got = await cachedJson(
			cache,
			analyticsCacheKey("usage", { account: accountId, start: input.start, end, script: input.script, bucket: input.bucket }),
			async () => summarizeUsage(await fetchUsage(client, input)),
			{ refresh: options.refresh },
		);
		summary = got.data;
		cachedAt = got.cachedAt;
	} catch (e) {
		errors.push((e as Error).message);
	}
	let quota: UsageResponse["quota"] = null;
	if (client.hasRest) {
		try {
			const { data } = await cachedJson<CfLimits>(cache, analyticsCacheKey("limits", { account: accountId }), () => client.limits(accountId!));
			if (data?.quota) {
				quota = { limit: data.quota.value, used: data.usage?.sent ?? 0, unit: data.quota.unit, resets_at: data.usage?.resets_at ?? null };
			}
		} catch (e) {
			errors.push(`limits: ${(e as Error).message}`);
		}
	}
	return { summary, quota, cachedAt, configured: true, ...(errors.length ? { error: errors.join("; ") } : {}) };
}

/** Messages sent this month by this app's mailboxes, from their ledgers. The fallback when Cloudflare is unavailable. */
async function localSentThisMonth(env: Env, mailboxes: string[], window: MonthWindow): Promise<number> {
	let total = 0;
	await Promise.all(
		mailboxes.map(async (m) => {
			try {
				const stub = env.MAILBOX.get(env.MAILBOX.idFromName(m)) as unknown as {
					getSendingAnalytics(w: { start: string; end: string }): Promise<{ sent: number }>;
				};
				total += (await stub.getSendingAnalytics({ start: window.start, end: window.end })).sent ?? 0;
			} catch {
				// One unreadable mailbox leaves the rest counted.
			}
		}),
	);
	return total;
}

async function mailboxRows(env: Env, mailboxes: string[]): Promise<UsageMailboxRow[]> {
	return Promise.all(
		mailboxes.map(async (email): Promise<UsageMailboxRow> => {
			const stub = env.MAILBOX.get(env.MAILBOX.idFromName(email)) as unknown as UsageMailboxStub;
			const [settings, send, triage] = await Promise.all([
				readMailboxSettings(env, email),
				stub.getSendUsage().catch(() => null),
				stub.triageStatus().catch(() => null),
			]);
			return {
				email,
				triage: {
					enabled: settings.triage.enabled,
					daily_ai_cap: settings.triage.dailyAiCap,
					calls_today: triage?.ai_calls_today ?? 0,
				},
				send_caps: send
					? {
							hourly: send.caps.hourly,
							daily: send.caps.daily,
							sent_last_hour: send.sent_last_hour,
							sent_last_day: send.sent_last_day,
							default: send.default,
						}
					: null,
			};
		}),
	);
}

/**
 * Call a store read that may be missing (older isolate, test fake). Over RPC
 * a missing method surfaces as a rejected call or a thrown TypeError, so
 * both, like a failed read, yield [].
 */
async function optionalRows<T>(read: (() => Promise<T[]>) | null): Promise<T[]> {
	if (!read) return [];
	try {
		const rows = await read();
		return Array.isArray(rows) ? rows : [];
	} catch {
		return [];
	}
}

/** Display names for provider ids: the configured label, "Workers AI", else the id. */
async function providerLabels(env: Env): Promise<(id: string) => string> {
	const file = await getAiProvidersFile((env as { BUCKET?: R2Bucket }).BUCKET).catch(() => null);
	const labels = new Map((file?.providers ?? []).map((p) => [p.id, p.label] as const));
	return (id) => (id === WORKERS_AI_PROVIDER_ID ? "Workers AI" : (labels.get(id) ?? id));
}

/** Projections that feed the budget check, from whichever source is available. */
export function projections(
	summary: UsageSummary | null,
	localSent: number | null,
	window: MonthWindow,
): { email: ReturnType<typeof projectEmail>; ai: ReturnType<typeof projectAi> | null; emailSource: "cloudflare" | "local" } {
	const fromCf = summary !== null;
	const sent = fromCf ? summary.emails : (localSent ?? 0);
	return {
		email: projectEmail(sent, window),
		ai: summary ? projectAi(summary.neurons_by_date, window) : null,
		emailSource: fromCf ? "cloudflare" : "local",
	};
}

export async function buildUsage(
	env: Env,
	mailboxes: string[],
	options: { now?: number; refresh?: boolean; client?: CfAnalyticsClient | null; cache?: CacheLike | null } = {},
): Promise<UsageResponse> {
	const now = options.now ?? Date.now();
	const window = monthWindow(now);
	const store = usageStore(env);
	const [cf, calls, budget, rows, providerRows, roleRows] = await Promise.all([
		cloudflareUsage(env, window, options),
		store
			? store.aiUsage(window.startDate, window.today).catch(() => [] as AiCallRow[])
			: Promise.resolve([] as AiCallRow[]),
		store ? store.getUsageBudget().catch(() => null) : Promise.resolve(null),
		mailboxRows(env, mailboxes),
		optionalRows(store ? () => store.aiUsageByProvider!(window.startDate, window.today) : null),
		optionalRows(store ? () => store.aiUsageByRole!(window.startDate, window.today) : null),
	]);
	const labelFor = providerRows.length || roleRows.length ? await providerLabels(env) : (id: string) => id;
	const byProvider: UsageAiProviderRow[] = providerRows.map((r) => ({
		provider_id: r.provider_id,
		label: labelFor(r.provider_id),
		calls_mtd: r.calls_mtd,
		calls_today: r.calls_today,
		input_tokens_mtd: r.input_tokens_mtd,
		output_tokens_mtd: r.output_tokens_mtd,
		cost_mtd_usd: r.cost_mtd_usd == null ? null : Math.round(r.cost_mtd_usd * 10_000) / 10_000,
	}));
	const byRole: UsageAiRoleRow[] = roleRows
		.filter((r) => r.role in ROLE_LABELS)
		.map((r) => ({
			role: r.role,
			label: ROLE_LABELS[r.role],
			provider_id: r.provider_id,
			calls_mtd: r.calls_mtd,
			calls_today: r.calls_today,
			input_tokens_mtd: r.input_tokens_mtd,
			output_tokens_mtd: r.output_tokens_mtd,
		}));
	const summary = cf.summary;
	const localSent = summary ? null : await localSentThisMonth(env, mailboxes, window);
	const p = projections(summary, localSent, window);

	const byFeature = new Map<AiFeature, AiCallRow>(calls.map((c) => [c.feature, c] as const));
	const featureRows = AI_FEATURES.map((feature) => ({
		feature,
		label: AI_FEATURE_LABELS[feature],
		calls_mtd: byFeature.get(feature)?.calls_mtd ?? 0,
		calls_today: byFeature.get(feature)?.calls_today ?? 0,
	}));

	const b = budget ?? { ai_usd: null, email_usd: null, updated_at: null, updated_by: null };
	const alerts = evaluateBudget(b, { ai: p.ai?.projected_cost ?? null, email: p.email.projected_cost });

	return {
		window,
		email: {
			source: p.emailSource,
			unit: p.emailSource === "cloudflare" ? "recipients" : "messages",
			included: EMAIL_INCLUDED_PER_MONTH,
			...p.email,
			cost_mtd: roundUsd(p.email.cost_mtd),
			projected_cost: roundUsd(p.email.projected_cost),
			projected: Math.round(p.email.projected),
		},
		ai: {
			by_feature: featureRows,
			by_provider: byProvider,
			by_role: byRole,
			calls_mtd: featureRows.reduce((a, r) => a + r.calls_mtd, 0),
			neurons:
				summary && p.ai
					? {
							...p.ai,
							neurons_mtd: Math.round(p.ai.neurons_mtd),
							neurons_projected: Math.round(p.ai.neurons_projected),
							cost_mtd: roundUsd(p.ai.cost_mtd),
							projected_cost: roundUsd(p.ai.projected_cost),
							today: Math.round(summary.neurons_by_date[window.today] ?? 0),
							by_model: summary.by_model.map((m) => ({ ...m, neurons: Math.round(m.neurons) })),
						}
					: null,
		},
		r2: summary?.r2 ? { bucket: usageBucketName(env), ...summary.r2 } : null,
		durable_objects: summary
			? {
					requests_mtd: summary.do_requests,
					projected: Math.round(projectMonthEnd(summary.do_requests, window.elapsed_fraction)),
					included: DO_INCLUDED_REQUESTS_PER_MONTH,
				}
			: null,
		quota: cf.quota,
		mailboxes: rows,
		budget: { ...b, alerts, exceeded: alerts.some((a) => a.exceeded) },
		pricing: USAGE_PRICING,
		provider: {
			configured: cf.configured,
			...(cf.cachedAt ? { cached_at: cf.cachedAt } : {}),
			...(cf.error ? { error: cf.error } : {}),
			...(summary?.email_sampled ? { sampled: true } : {}),
		},
	};
}

// ── Budget alert ────────────────────────────────────────────────────

export const BUDGET_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface BudgetExceededPayload {
	id: string;
	type: "usage.budget_exceeded";
	created_at: string;
	mailbox: string;
	data: {
		kind: BudgetKind;
		month: string;
		projected_usd: number;
		threshold_usd: number;
		/** Month-to-date units: emails (recipients or messages) or neurons. */
		used: number;
		unit: string;
	};
}

export function buildBudgetPayload(
	alert: BudgetAlert,
	month: string,
	used: { value: number; unit: string },
	mailbox: string,
	eventId: string,
	now: number,
): BudgetExceededPayload {
	return {
		id: eventId,
		type: "usage.budget_exceeded",
		created_at: new Date(now).toISOString(),
		mailbox,
		data: {
			kind: alert.kind,
			month,
			projected_usd: alert.projected_usd,
			threshold_usd: alert.threshold_usd,
			used: Math.round(used.value),
			unit: used.unit,
		},
	};
}

export interface BudgetCheckDeps {
	store?: UsageStoreApi | null;
	now?: number;
	mailboxes?: string[];
	cf?: CloudflareUsage;
	hooks?: { enqueue(events: EnqueueInput[]): Promise<{ queued: number }> } | null;
}

export interface BudgetCheckResult {
	alerts: BudgetAlert[];
	fired: BudgetKind[];
	queued: number;
}

/**
 * Evaluate the budget once and fire `usage.budget_exceeded` for each kind
 * over its threshold that has not fired this month. One event id per kind
 * and month, one row per mailbox: the webhook store sends an all-mailbox
 * endpoint the event once.
 */
export async function checkUsageBudget(env: Env, deps: BudgetCheckDeps = {}): Promise<BudgetCheckResult> {
	const now = deps.now ?? Date.now();
	const store = deps.store === undefined ? usageStore(env) : deps.store;
	if (!store) return { alerts: [], fired: [], queued: 0 };
	const budget = await store.getUsageBudget();
	if (budget.ai_usd == null && budget.email_usd == null) return { alerts: [], fired: [], queued: 0 };

	const window = monthWindow(now);
	const mailboxes = deps.mailboxes ?? (await listMailboxes(env.BUCKET)).map((m) => m.email);
	const cf = deps.cf ?? (await cloudflareUsage(env, window));
	const localSent = cf.summary ? null : await localSentThisMonth(env, mailboxes, window);
	const p = projections(cf.summary, localSent, window);
	const alerts = evaluateBudget(budget, { ai: p.ai?.projected_cost ?? null, email: p.email.projected_cost });

	const hooks = deps.hooks === undefined ? webhookStub(env) : deps.hooks;
	const fired: BudgetKind[] = [];
	let queued = 0;
	for (const alert of alerts) {
		if (!alert.exceeded) continue;
		if (!(await store.claimBudgetAlert(window.month, alert.kind, alert.projected_usd, alert.threshold_usd, now))) continue;
		fired.push(alert.kind);
		if (!hooks || mailboxes.length === 0) continue;
		const used =
			alert.kind === "ai"
				? { value: p.ai?.neurons_mtd ?? 0, unit: "neurons" }
				: { value: p.email.sent_mtd, unit: p.emailSource === "cloudflare" ? "recipients" : "messages" };
		const eventId = `evt_budget_${alert.kind}_${window.month}`;
		const events: EnqueueInput[] = mailboxes.map((mailbox) => ({
			eventId,
			type: "usage.budget_exceeded",
			mailbox,
			payload: JSON.stringify(buildBudgetPayload(alert, window.month, used, mailbox, eventId, now)),
			now,
		}));
		queued += (await hooks.enqueue(events)).queued;
	}
	if (fired.length) console.log(`usage budget: fired=${fired.join(",")} queued=${queued}`);
	await store.pruneAiUsage(window.today).catch(() => {});
	return { alerts, fired, queued };
}

/** The cron's entry: at most hourly across isolates. */
export async function maybeCheckUsageBudget(env: Env, now = Date.now()): Promise<BudgetCheckResult | null> {
	const store = usageStore(env);
	if (!store) return null;
	if (!(await store.claimBudgetCheck(now, BUDGET_CHECK_INTERVAL_MS))) return null;
	return checkUsageBudget(env, { store, now });
}
