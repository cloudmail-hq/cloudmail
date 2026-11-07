// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Usage and cost: the month math, the Cloudflare query and its parsing, the
 * per-feature AI counter, the AuthDO store on real SQLite through the
 * AuthStore's migrations, the budget alert, and the UI's pure formatters.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	AI_FREE_NEURONS_PER_DAY,
	EMAIL_INCLUDED_PER_MONTH,
	UsageBudgetPatchSchema,
	aiCostForDays,
	billableEmails,
	emailCost,
	evaluateBudget,
	monthWindow,
	projectAi,
	projectEmail,
	projectMonthEnd,
} from "../shared/usage";
import { USAGE_QUERY, fetchUsage, summarizeUsage, type UsageAccountData } from "../workers/lib/usage-cf";
import { meteredAi, type AiCallRecorder } from "../workers/lib/ai-usage";
import { UsageStore } from "../workers/lib/usage-store";
import { AuthStore, AUTH_MIGRATION_NAMES, type AuthSql } from "../workers/auth/store-core";
import { buildBudgetPayload, checkUsageBudget, type CloudflareUsage, type UsageStoreApi } from "../workers/lib/usage";
import { CfAnalyticsClient } from "../workers/lib/cf-analytics";
import { WEBHOOK_EVENT_LABELS, WEBHOOK_EVENT_TYPES } from "../shared/webhooks";
import { budgetAlertTitles, formatBytes, formatUsd, parseThreshold, usageTiles } from "../app/components/analytics/usage";
import type { Env } from "../workers/types";

beforeEach(() => {
	vi.restoreAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

function sqlite() {
	const db = new DatabaseSync(":memory:");
	const sql: AuthSql = {
		exec(query: string, ...bindings: unknown[]) {
			const rows = db.prepare(query).all(...(bindings as never[])) as any[];
			return { toArray: () => rows };
		},
	};
	const tx = <T>(fn: () => T): T => {
		db.exec("SAVEPOINT tx");
		try {
			const out = fn();
			db.exec("RELEASE tx");
			return out;
		} catch (e) {
			db.exec("ROLLBACK TO tx");
			db.exec("RELEASE tx");
			throw e;
		}
	};
	new AuthStore(sql, tx); // runs the migrations, including 0019
	return new UsageStore(sql, tx);
}

function api(store: UsageStore): UsageStoreApi {
	return {
		aiUsage: async (f, t) => store.aiCalls(f, t),
		pruneAiUsage: async (t) => store.pruneAiCalls(t),
		getUsageBudget: async () => store.getBudget(),
		setUsageBudget: async (p, b, n) => store.setBudget(p, b, n),
		claimBudgetAlert: async (m, k, p, t, n) => store.claimBudgetAlert(m, k, p, t, n),
		firedBudgetAlerts: async (m) => store.firedAlerts(m),
		claimBudgetCheck: async (n, i) => store.claimBudgetCheck(n, i),
	};
}

// 2026-10-16T00:00Z: halfway through a 31-day month (15 of 31 days elapsed).
const MID_OCT = Date.UTC(2026, 9, 16);

describe("month window", () => {
	it("spans the UTC calendar month", () => {
		const w = monthWindow(MID_OCT);
		expect(w).toMatchObject({ month: "2026-10", start: "2026-10-01T00:00:00.000Z", startDate: "2026-10-01", today: "2026-10-16", days_in_month: 31 });
		expect(w.elapsed_fraction).toBeCloseTo(15 / 31);
	});

	it("handles February and the first minute of a month", () => {
		expect(monthWindow(Date.UTC(2026, 1, 10)).days_in_month).toBe(28);
		expect(monthWindow(Date.UTC(2028, 1, 10)).days_in_month).toBe(29);
		const first = monthWindow(Date.UTC(2026, 10, 1));
		expect(first.elapsed_fraction).toBeGreaterThan(0);
		expect(Number.isFinite(projectMonthEnd(5, first.elapsed_fraction))).toBe(true);
	});
});

describe("usage math", () => {
	it("projects linearly and never below the month to date", () => {
		expect(projectMonthEnd(100, 0.5)).toBe(200);
		expect(projectMonthEnd(100, 1)).toBe(100);
		expect(projectMonthEnd(0, 0.5)).toBe(0);
		expect(projectMonthEnd(10, 0)).toBe(10);
	});

	it("bills email only past the 3,000 included, at $0.35 per 1,000", () => {
		expect(EMAIL_INCLUDED_PER_MONTH).toBe(3000);
		expect(billableEmails(2999)).toBe(0);
		expect(emailCost(3000)).toBe(0);
		expect(billableEmails(4000)).toBe(1000);
		expect(emailCost(4000)).toBeCloseTo(0.35);
		expect(emailCost(13_000)).toBeCloseTo(3.5);
	});

	it("projects email cost from the month-end volume", () => {
		const w = monthWindow(MID_OCT);
		const p = projectEmail(2000, w);
		expect(p.projected).toBeCloseTo(2000 * (31 / 15));
		expect(p.cost_mtd).toBe(0);
		expect(p.projected_cost).toBeCloseTo(((2000 * (31 / 15) - 3000) / 1000) * 0.35, 2);
	});

	it("applies the 10,000-neuron free allocation per day, not per month", () => {
		expect(AI_FREE_NEURONS_PER_DAY).toBe(10_000);
		expect(aiCostForDays([9_000, 9_000])).toBe(0);
		// A busy day is not offset by a quiet one.
		expect(aiCostForDays([20_000, 0])).toBeCloseTo(0.11);
		expect(aiCostForDays([1_010_000])).toBeCloseTo(11);
	});

	it("projects AI cost with each remaining day getting its own free allocation", () => {
		const w = monthWindow(MID_OCT);
		const byDate: Record<string, number> = {};
		for (let d = 1; d <= 15; d++) byDate[`2026-10-${String(d).padStart(2, "0")}`] = 30_000;
		const p = projectAi(byDate, w);
		expect(p.neurons_mtd).toBe(450_000);
		expect(p.cost_mtd).toBeCloseTo(15 * 0.22);
		// 16 more days at 30,000 each, 20,000 billable each.
		expect(p.projected_cost).toBeCloseTo(31 * 0.22);
		expect(projectAi({}, w).projected_cost).toBe(0);
	});
});

describe("budget evaluation", () => {
	it("flags a kind only when strictly over its threshold", () => {
		const alerts = evaluateBudget({ ai_usd: 5, email_usd: 1 }, { ai: 5, email: 1.004 });
		expect(alerts).toEqual([
			{ kind: "ai", projected_usd: 5, threshold_usd: 5, exceeded: false },
			{ kind: "email", projected_usd: 1, threshold_usd: 1, exceeded: false },
		]);
		expect(evaluateBudget({ ai_usd: 5, email_usd: null }, { ai: 5.01, email: 100 })).toEqual([
			{ kind: "ai", projected_usd: 5.01, threshold_usd: 5, exceeded: true },
		]);
	});

	it("skips a kind with no projection", () => {
		expect(evaluateBudget({ ai_usd: 1, email_usd: 1 }, { ai: null, email: 0 })).toEqual([
			{ kind: "email", projected_usd: 0, threshold_usd: 1, exceeded: false },
		]);
	});

	it("validates the patch", () => {
		expect(UsageBudgetPatchSchema.safeParse({ ai_usd: 10, email_usd: null }).success).toBe(true);
		expect(UsageBudgetPatchSchema.safeParse({ ai_usd: -1 }).success).toBe(false);
		expect(UsageBudgetPatchSchema.safeParse({ other: 1 }).success).toBe(false);
	});
});

describe("Cloudflare usage query", () => {
	const fixture: { data: { viewer: { accounts: UsageAccountData[] } } } = {
		data: {
			viewer: {
				accounts: [
					{
						email: [
							{ count: 600, dimensions: { status: "delivered", sampleInterval: 1 } },
							{ count: 10, dimensions: { status: "deliveryFailed", sampleInterval: 2 } },
						],
						ai: [
							{ count: 50, sum: { totalNeurons: 12_000.4 }, dimensions: { date: "2026-10-15", modelId: "@cf/a" } },
							{ count: 5, sum: { totalNeurons: 3_000 }, dimensions: { date: "2026-10-15", modelId: "@cf/b" } },
							{ count: 7, sum: { totalNeurons: 1_000 }, dimensions: { date: "2026-10-16", modelId: "@cf/a" } },
						],
						r2: [{ max: { payloadSize: 94_841_831, metadataSize: 15_267, objectCount: 750 }, dimensions: { datetime: "2026-10-16T00:00:00Z" } }],
						durableObjects: [
							{ sum: { requests: 2905 }, dimensions: { date: "2026-10-05" } },
							{ sum: { requests: 100 }, dimensions: { date: "2026-10-06" } },
						],
					},
				],
			},
		},
	};

	it("asks for the account's sends, neurons, storage and DO requests in one request", async () => {
		const fetchImpl = vi.fn(async () => Response.json(fixture));
		const client = new CfAnalyticsClient({ graphqlToken: "t", restToken: null, fetchImpl: fetchImpl as never });
		const data = await fetchUsage(client, {
			accountId: "acct",
			start: "2026-10-01T00:00:00.000Z",
			end: "2026-10-16T00:00:00.000Z",
			startDate: "2026-10-01",
			endDate: "2026-10-16",
			script: "tapetide-agentic-inbox",
			bucket: "tapetide-agentic-inbox",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
		expect(body.query).toBe(USAGE_QUERY);
		for (const ds of ["emailSendingAdaptiveGroups", "aiInferenceAdaptiveGroups", "r2StorageAdaptiveGroups", "durableObjectsInvocationsAdaptiveGroups"]) {
			expect(body.query).toContain(ds);
		}
		expect(body.variables).toMatchObject({ account: "acct", script: "tapetide-agentic-inbox", bucket: "tapetide-agentic-inbox", r2Start: "2026-10-14T00:00:00.000Z" });
		expect(data.ai).toHaveLength(3);
	});

	it("weights sampled sends and folds neurons by day and model", () => {
		const s = summarizeUsage(fixture.data.viewer.accounts[0]);
		expect(s.emails).toBe(620);
		expect(s.email_sampled).toBe(true);
		expect(s.neurons_by_date).toEqual({ "2026-10-15": 15_000.4, "2026-10-16": 1_000 });
		expect(s.by_model[0]).toEqual({ model: "@cf/a", neurons: 13_000.4, requests: 57 });
		expect(s.r2).toEqual({ bytes: 94_857_098, objects: 750 });
		expect(s.do_requests).toBe(3005);
	});

	it("tolerates an account with no rows", () => {
		const s = summarizeUsage({ email: [], ai: [], r2: [], durableObjects: [] });
		expect(s).toMatchObject({ emails: 0, r2: null, do_requests: 0, by_model: [] });
	});

	it("surfaces a GraphQL error", async () => {
		const client = new CfAnalyticsClient({
			graphqlToken: "t",
			restToken: null,
			fetchImpl: (async () => Response.json({ data: null, errors: [{ message: "not authorized" }] })) as never,
		});
		await expect(fetchUsage(client, { accountId: "a", start: "x", end: "2026-10-16T00:00:00Z", startDate: "a", endDate: "b", script: "s", bucket: "b" })).rejects.toThrow(/not authorized/);
	});
});

describe("metered AI binding", () => {
	function recorder() {
		const calls: [string, string][] = [];
		const rec: AiCallRecorder = { recordAiCall: async (f, d) => void calls.push([f, d]) };
		return { calls, rec };
	}

	it("counts one call per run under the feature, and returns the model's answer", async () => {
		const { calls, rec } = recorder();
		const ai = { run: vi.fn(async () => ({ response: "YES" })), models: async () => ["m"] };
		const metered = meteredAi({}, "triage", ai as never, { recorder: rec, now: () => MID_OCT });
		await expect((metered as any).run("@cf/x", {})).resolves.toEqual({ response: "YES" });
		await (metered as any).run("@cf/x", {});
		expect(calls).toEqual([
			["triage", "2026-10-16"],
			["triage", "2026-10-16"],
		]);
		// Other members pass through.
		await expect((metered as any).models()).resolves.toEqual(["m"]);
	});

	it("never fails the call when counting fails", async () => {
		const ai = { run: async () => ({ response: "ok" }) };
		const throwing: AiCallRecorder = { recordAiCall: async () => { throw new Error("AuthDO down"); } };
		const sync: AiCallRecorder = { recordAiCall: () => { throw new Error("sync"); } };
		await expect((meteredAi({}, "summaries", ai as never, { recorder: throwing }) as any).run("m", {})).resolves.toEqual({ response: "ok" });
		await expect((meteredAi({}, "summaries", ai as never, { recorder: sync }) as any).run("m", {})).resolves.toEqual({ response: "ok" });
	});

	it("counts a failed model call and still throws its error", async () => {
		const { calls, rec } = recorder();
		const ai = { run: async () => { throw new Error("model down"); } };
		await expect((meteredAi({}, "agent", ai as never, { recorder: rec }) as any).run("m", {})).rejects.toThrow("model down");
		expect(calls).toHaveLength(1);
	});

	it("passes through when there is no binding or nowhere to count", () => {
		const ai = { run: async () => 1 };
		expect(meteredAi({}, "agent", undefined)).toBeUndefined();
		expect(meteredAi({}, "agent", ai as never)).toBe(ai);
	});
});

describe("usage store (AuthDO, migration 0019)", () => {
	it("is appended after every earlier migration", () => {
		// After every migration that shipped before it. Later PRs append after it.
		const names = [...AUTH_MIGRATION_NAMES];
		expect(names.indexOf("0019_ai_usage_and_budget")).toBeGreaterThan(names.indexOf("0010_oauth_grant_send_auto"));
	});

	it("counts calls per day and feature", () => {
		const store = sqlite();
		store.recordAiCall("triage", "2026-10-15");
		store.recordAiCall("triage", "2026-10-16", 2);
		store.recordAiCall("summaries", "2026-10-16");
		store.recordAiCall("summaries", "2026-09-30");
		store.recordAiCall("bogus" as never, "2026-10-16");
		const rows = store.aiCalls("2026-10-01", "2026-10-16").sort((a, b) => a.feature.localeCompare(b.feature));
		expect(rows).toEqual([
			{ feature: "summaries", calls_mtd: 1, calls_today: 1 },
			{ feature: "triage", calls_mtd: 3, calls_today: 2 },
		]);
		store.pruneAiCalls("2026-12-18");
		// Kept 62 days: by Dec 18 every October row is gone.
		expect(store.aiCalls("2026-01-01", "2026-12-18")).toEqual([]);
	});

	it("records requests per provider and role, with nullable tokens and cost (0021)", () => {
		const names = [...AUTH_MIGRATION_NAMES];
		expect(names.indexOf("0021_ai_usage_by_provider")).toBeGreaterThan(names.indexOf("0019_ai_usage_and_budget"));
		const store = sqlite();
		const base = { providerId: "workers-ai", role: "triage" as const, calls: 1, inputTokens: null, outputTokens: null, costUsd: null };
		// Workers AI, no tokens reported: token and cost sums stay null.
		store.recordAiUsage({ ...base, day: "2026-10-15" });
		store.recordAiUsage({ ...base, day: "2026-10-16" });
		// A gateway: tokens on one call, not on the other; cost on one.
		const gw = { ...base, providerId: "openrouter", role: "summary" as const };
		store.recordAiUsage({ ...gw, day: "2026-10-16", inputTokens: 100, outputTokens: 20, costUsd: 0.0015 });
		store.recordAiUsage({ ...gw, day: "2026-10-16" });
		store.recordAiUsage({ ...gw, day: "2026-10-14", role: "agent_chat", inputTokens: 50, outputTokens: 5, fallback: true });
		// Ignored: bad role, bad provider id, no calls, bad day.
		store.recordAiUsage({ ...base, day: "2026-10-16", role: "bogus" as never });
		store.recordAiUsage({ ...base, day: "2026-10-16", providerId: "Bad Id" });
		store.recordAiUsage({ ...base, day: "2026-10-16", providerId: "x".repeat(33) });
		store.recordAiUsage({ ...base, day: "2026-10-16", calls: 0 });
		store.recordAiUsage({ ...base, day: "nope" });
		// Before the window.
		store.recordAiUsage({ ...base, day: "2026-09-30", calls: 9 });

		expect(store.aiUsageByProvider("2026-10-01", "2026-10-16")).toEqual([
			{ provider_id: "openrouter", calls_mtd: 3, calls_today: 2, input_tokens_mtd: 150, output_tokens_mtd: 25, cost_mtd_usd: 0.0015 },
			{ provider_id: "workers-ai", calls_mtd: 2, calls_today: 1, input_tokens_mtd: null, output_tokens_mtd: null, cost_mtd_usd: null },
		]);
		const roles = store.aiUsageByRole("2026-10-01", "2026-10-16");
		expect(roles).toEqual([
			{ role: "summary", provider_id: "openrouter", calls_mtd: 2, calls_today: 2, input_tokens_mtd: 100, output_tokens_mtd: 20 },
			{ role: "triage", provider_id: "workers-ai", calls_mtd: 2, calls_today: 1, input_tokens_mtd: null, output_tokens_mtd: null },
			{ role: "agent_chat", provider_id: "openrouter", calls_mtd: 1, calls_today: 0, input_tokens_mtd: 50, output_tokens_mtd: 5 },
		]);

		store.pruneAiCalls("2026-12-02");
		// 62 days before Dec 2 is Oct 1: September's row is gone, October's kept.
		expect(store.aiUsageByProvider("2026-01-01", "2026-12-02").reduce((n, r) => n + r.calls_mtd, 0)).toBe(5);
		store.pruneAiCalls("2026-12-18");
		expect(store.aiUsageByProvider("2026-01-01", "2026-12-18")).toEqual([]);
		expect(store.aiUsageByRole("2026-01-01", "2026-12-18")).toEqual([]);
	});

	it("keeps a reported token count when later calls report none", () => {
		const store = sqlite();
		const e = { day: "2026-10-16", providerId: "gw", role: "triage" as const, calls: 1, costUsd: null };
		store.recordAiUsage({ ...e, inputTokens: 10, outputTokens: null });
		store.recordAiUsage({ ...e, inputTokens: null, outputTokens: 4 });
		store.recordAiUsage({ ...e, inputTokens: null, outputTokens: null });
		expect(store.aiUsageByProvider("2026-10-01", "2026-10-16")[0]).toMatchObject({ calls_mtd: 3, input_tokens_mtd: 10, output_tokens_mtd: 4, cost_mtd_usd: null });
	});

	it("keeps an omitted threshold and clears a null one", () => {
		const store = sqlite();
		expect(store.getBudget()).toMatchObject({ ai_usd: null, email_usd: null });
		store.setBudget({ ai_usd: 5, email_usd: 2 }, "owner", 1);
		expect(store.setBudget({ email_usd: null }, "owner", 2)).toEqual({ ai_usd: 5, email_usd: null, updated_at: 2, updated_by: "owner" });
	});

	it("claims each month's alert per kind once", () => {
		const store = sqlite();
		expect(store.claimBudgetAlert("2026-10", "ai", 6, 5, 1)).toBe(true);
		expect(store.claimBudgetAlert("2026-10", "ai", 7, 5, 2)).toBe(false);
		expect(store.claimBudgetAlert("2026-10", "email", 3, 2, 3)).toBe(true);
		expect(store.claimBudgetAlert("2026-11", "ai", 6, 5, 4)).toBe(true);
		expect(store.firedAlerts("2026-10").map((a) => a.kind).sort()).toEqual(["ai", "email"]);
	});

	it("claims the hourly check across isolates", () => {
		const store = sqlite();
		const hour = 3_600_000;
		expect(store.claimBudgetCheck(MID_OCT, hour)).toBe(true);
		expect(store.claimBudgetCheck(MID_OCT + 1_000, hour)).toBe(false);
		expect(store.claimBudgetCheck(MID_OCT + hour, hour)).toBe(true);
	});
});

describe("budget alert", () => {
	const env = {} as Env;
	const MAILBOXES = ["a@product.dev", "b@product.dev"];
	// 15 days at 30,000 neurons: AI projects to $6.82; 2,000 emails project to ~$0.40.
	function cf(): CloudflareUsage {
		const byDate: Record<string, number> = {};
		for (let d = 1; d <= 15; d++) byDate[`2026-10-${String(d).padStart(2, "0")}`] = 30_000;
		return {
			configured: true,
			quota: null,
			summary: { emails: 4000, email_sampled: false, neurons_by_date: byDate, by_model: [], r2: null, do_requests: 0 },
		};
	}

	it("is a known webhook event", () => {
		expect(WEBHOOK_EVENT_TYPES).toContain("usage.budget_exceeded");
		expect(WEBHOOK_EVENT_LABELS["usage.budget_exceeded"].label).toBeTruthy();
	});

	it("fires once per month per kind, to every mailbox under one event id", async () => {
		const store = api(sqlite());
		await store.setUsageBudget({ ai_usd: 5, email_usd: 100 }, "owner", 0);
		const enqueue = vi.fn(async (events: unknown[]) => ({ queued: events.length }));
		const deps = { store, now: MID_OCT, mailboxes: MAILBOXES, cf: cf(), hooks: { enqueue } };

		const first = await checkUsageBudget(env, deps);
		expect(first.fired).toEqual(["ai"]);
		expect(first.queued).toBe(2);
		const events = enqueue.mock.calls[0][0] as { eventId: string; type: string; mailbox: string; payload: string }[];
		expect(new Set(events.map((e) => e.eventId))).toEqual(new Set(["evt_budget_ai_2026-10"]));
		expect(events.map((e) => e.mailbox)).toEqual(MAILBOXES);
		expect(JSON.parse(events[0].payload)).toMatchObject({
			id: "evt_budget_ai_2026-10",
			type: "usage.budget_exceeded",
			mailbox: "a@product.dev",
			data: { kind: "ai", month: "2026-10", threshold_usd: 5, used: 450_000, unit: "neurons" },
		});
		expect(JSON.parse(events[0].payload).data.projected_usd).toBeCloseTo(6.82, 2);

		const again = await checkUsageBudget(env, deps);
		expect(again.fired).toEqual([]);
		expect(enqueue).toHaveBeenCalledTimes(1);

		// Next month, it may fire again.
		const nov = await checkUsageBudget(env, { ...deps, now: Date.UTC(2026, 10, 16) });
		expect(nov.fired).toEqual(["ai"]);
	});

	it("does nothing below the threshold or without one", async () => {
		const store = api(sqlite());
		const enqueue = vi.fn(async () => ({ queued: 0 }));
		const deps = { store, now: MID_OCT, mailboxes: MAILBOXES, cf: cf(), hooks: { enqueue } };
		expect((await checkUsageBudget(env, deps)).alerts).toEqual([]);
		await store.setUsageBudget({ ai_usd: 50, email_usd: 50 }, null, 0);
		const r = await checkUsageBudget(env, deps);
		expect(r.alerts.every((a) => !a.exceeded)).toBe(true);
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("builds the email payload with the billed unit", () => {
		const p = buildBudgetPayload({ kind: "email", projected_usd: 2, threshold_usd: 1, exceeded: true }, "2026-10", { value: 9000, unit: "recipients" }, "a@x.dev", "evt", 0);
		expect(p).toEqual({
			id: "evt",
			type: "usage.budget_exceeded",
			created_at: "1970-01-01T00:00:00.000Z",
			mailbox: "a@x.dev",
			data: { kind: "email", month: "2026-10", projected_usd: 2, threshold_usd: 1, used: 9000, unit: "recipients" },
		});
	});
});

describe("Usage tab formatting", () => {
	it("formats money and bytes", () => {
		expect(formatUsd(0)).toBe("$0");
		expect(formatUsd(0.004)).toBe("<$0.01");
		expect(formatUsd(1234.5)).toBe("$1,234.50");
		expect(formatUsd(null)).toBe("—");
		expect(formatBytes(94_857_098)).toBe("95 MB");
		expect(formatBytes(1_500)).toBe("1.5 KB");
		expect(formatBytes(12)).toBe("12 B");
	});

	it("parses a threshold field", () => {
		expect(parseThreshold("")).toBeNull();
		expect(parseThreshold(" $12.5 ")).toBe(12.5);
		expect(parseThreshold("-1")).toBeNaN();
		expect(parseThreshold("abc")).toBeNaN();
	});

	it("titles the banner only for exceeded kinds", () => {
		expect(
			budgetAlertTitles({
				budget: {
					ai_usd: 5,
					email_usd: 1,
					updated_at: null,
					updated_by: null,
					exceeded: true,
					alerts: [
						{ kind: "ai", projected_usd: 6.82, threshold_usd: 5, exceeded: true },
						{ kind: "email", projected_usd: 0.4, threshold_usd: 1, exceeded: false },
					],
				},
			}),
		).toEqual(["Projected Workers AI cost $6.82 is over your $5.00 budget"]);
	});

	it("leads with emails against the included 3,000, and drops tiles it has no data for", () => {
		const tiles = usageTiles({
			email: { source: "local", unit: "messages", included: 3000, sent_mtd: 1200, projected: 2480, cost_mtd: 0, projected_cost: 0 },
			ai: { by_feature: [], calls_mtd: 40, neurons: null },
			r2: null,
			durable_objects: null,
			quota: null,
		} as never);
		expect(tiles.map((t) => t.key)).toEqual(["email", "ai"]);
		expect(tiles[0]).toMatchObject({ value: "1,200", meter: { value: 1200, max: 3000 } });
		expect(tiles[1].value).toBe("40");
	});
});
