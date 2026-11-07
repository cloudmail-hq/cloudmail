// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * `/api/v1/usage` through the real Hono app, as `analytics-routes.test.ts`
 * does: a real AuthStore on node:sqlite behind AUTH_STORE, an R2 fake,
 * mailbox stub fakes, and a mocked Cloudflare GraphQL.
 */

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../workers/index";
import { AuthStore, type AuthSql } from "../workers/auth/store-core";
import { DomainStore } from "../workers/lib/domain-store";
import { UsageStore } from "../workers/lib/usage-store";
import type { UsageResponse } from "../shared/usage";
import { resetAiProvidersCache } from "../workers/lib/ai-providers-store";

const ADMIN = "owner@example.com";
const MEMBER = "member@example.com";
const SUPPORT = "support@example.com";

let auth: AuthStore;
let domains: DomainStore;
let usage: UsageStore;
let objects: Map<string, string>;
let gql: string[];

function makeEnv(extra: Record<string, unknown> = {}) {
	const rpc = new Proxy(
		{},
		{
			get: (_t, name: string) => async (...args: unknown[]) => {
				const usageApi: Record<string, (...a: any[]) => unknown> = {
					aiUsage: (f: string, t: string) => usage.aiCalls(f, t),
					pruneAiUsage: (t: string) => usage.pruneAiCalls(t),
					recordAiUsage: (e: never) => usage.recordAiUsage(e),
					aiUsageByProvider: (f: string, t: string) => usage.aiUsageByProvider(f, t),
					aiUsageByRole: (f: string, t: string) => usage.aiUsageByRole(f, t),
					getUsageBudget: () => usage.getBudget(),
					setUsageBudget: (p: never, b: string | null, n: number) => usage.setBudget(p, b, n),
				};
				if (name in usageApi) return usageApi[name](...args);
				const target = name in domains ? domains : auth;
				return (target as any)[name](...args);
			},
		},
	);
	return {
		AUTH_MODE: "access",
		ADMIN_EMAILS: ADMIN,
		DOMAINS: "example.com",
		EMAIL_ADDRESSES: [],
		AUTH_STORE: { idFromName: () => "global", get: () => rpc },
		BUCKET: {
			head: async (key: string) => (objects.has(key) ? { key } : null),
			get: async (key: string) => {
				const raw = objects.get(key);
				return raw === undefined ? null : { json: async () => JSON.parse(raw) };
			},
			put: async (key: string, value: string) => void objects.set(key, value),
			list: async (opts: { prefix?: string }) => ({
				objects: [...objects.keys()].filter((k) => k.startsWith(opts?.prefix ?? "")).map((key) => ({ key })),
				truncated: false,
			}),
		},
		MAILBOX: {
			idFromName: (n: string) => n,
			get: () => ({
				getSendUsage: async () => ({ caps: { hourly: 20, daily: 100 }, default: true, sent_last_hour: 1, sent_last_day: 4 }),
				triageStatus: async () => ({ ai_calls_today: 7 }),
				getSendingAnalytics: async () => ({ sent: 12 }),
			}),
		},
		CF_ANALYTICS_TOKEN: "test-token",
		CF_ACCOUNT_ID: "acct",
		...extra,
	} as never;
}

let realFetch: typeof fetch;
beforeEach(() => {
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
	auth = new AuthStore(sql, tx);
	domains = new DomainStore(sql, tx);
	usage = new UsageStore(sql, tx);
	objects = new Map([
		[`mailboxes/${SUPPORT}.json`, JSON.stringify({ triage: { enabled: true, dailyAiCap: 150 } })],
		[`access/users/${MEMBER}.json`, JSON.stringify({ id: MEMBER, role: "member", mailboxes: [{ id: SUPPORT, role: "viewer" }] })],
	]);
	gql = [];
	resetAiProvidersCache();
	realFetch = globalThis.fetch;
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/graphql")) {
			const { query } = JSON.parse(String(init?.body));
			gql.push(query.split("(")[0].trim());
			return Response.json({
				data: {
					viewer: {
						accounts: [
							{
								email: [{ count: 4000, dimensions: { status: "delivered", sampleInterval: 1 } }],
								ai: [{ count: 10, sum: { totalNeurons: 50_000 }, dimensions: { date: new Date().toISOString().slice(0, 10), modelId: "@cf/m" } }],
								r2: [{ max: { payloadSize: 1000, metadataSize: 24, objectCount: 3 }, dimensions: { datetime: "x" } }],
								durableObjects: [{ sum: { requests: 99 }, dimensions: { date: "x" } }],
							},
						],
					},
				},
			});
		}
		return Response.json({ success: false, errors: [{ message: "no route" }] }, { status: 404 });
	}) as unknown as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;

function as(identity: string, token?: { scopes: string[] | null }) {
	const outer = new Hono();
	outer.use("*", async (c, next) => {
		(c as any).set("accessIdentity", { kind: "user", id: identity, subject: "s" });
		if (token) {
			(c as any).set("authMethod", "token");
			(c as any).set("authToken", {
				id: "tok",
				userId: "u",
				name: "t",
				createdAt: 0,
				lastUsedAt: null,
				lastUsedIp: null,
				expiresAt: null,
				scopes: token.scopes,
				mailboxes: null,
				parentId: null,
			});
		}
		return next();
	});
	outer.route("/", app as never);
	return (path: string, init: RequestInit = {}, env = makeEnv()) =>
		outer.fetch(
			new Request(`https://mailer.example.com${path}`, {
				...init,
				headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", ...(init.headers ?? {}) },
			}),
			env,
			ctx,
		);
}

describe("GET /api/v1/usage", () => {
	it("is admin-only", async () => {
		expect((await as(MEMBER)("/api/v1/usage")).status).toBe(403);
		expect((await as(ADMIN, { scopes: ["mail:read"] })("/api/v1/usage")).status).toBe(403);
		expect((await as(ADMIN, { scopes: ["admin"] })("/api/v1/usage")).status).toBe(200);
	});

	it("combines Cloudflare's numbers, the local AI counts and the caps", async () => {
		const today = new Date().toISOString().slice(0, 10);
		usage.recordAiCall("triage", today, 3);
		const res = await as(ADMIN)("/api/v1/usage");
		expect(res.status).toBe(200);
		const body = (await res.json()) as UsageResponse;
		expect(gql).toEqual(["query UsageAccount"]);
		expect(body.email).toMatchObject({ source: "cloudflare", unit: "recipients", included: 3000, sent_mtd: 4000, cost_mtd: 0.35 });
		expect(body.ai.by_feature.find((f) => f.feature === "triage")).toMatchObject({ calls_mtd: 3, calls_today: 3 });
		expect(body.ai.neurons).toMatchObject({ neurons_mtd: 50_000, today: 50_000, cost_mtd: 0.44 });
		expect(body.r2).toEqual({ bucket: "cloudmail", bytes: 1024, objects: 3 });
		expect(body.durable_objects?.requests_mtd).toBe(99);
		expect(body.mailboxes).toEqual([
			{
				email: SUPPORT,
				triage: { enabled: true, daily_ai_cap: 150, calls_today: 7 },
				send_caps: { hourly: 20, daily: 100, sent_last_hour: 1, sent_last_day: 4, default: true },
			},
		]);
		expect(body.provider.configured).toBe(true);
		expect(body.budget).toMatchObject({ ai_usd: null, email_usd: null, exceeded: false, alerts: [] });
	});

	it("reports requests by provider and role, with labels", async () => {
		const today = new Date().toISOString().slice(0, 10);
		objects.set(
			"ai/providers.json",
			JSON.stringify({
				version: 1,
				providers: [{ id: "my-gw", label: "My gateway", wire: "openai", baseUrl: "https://gw.example.com/v1", auth: { scheme: "bearer" } }],
				routing: { gatewayProviderId: "my-gw" },
			}),
		);
		usage.recordAiUsage({ day: today, providerId: "my-gw", role: "summary", calls: 2, inputTokens: 300, outputTokens: 40, costUsd: 0.002 });
		usage.recordAiUsage({ day: today, providerId: "workers-ai", role: "injection_scanner", calls: 1, inputTokens: null, outputTokens: null, costUsd: null });
		usage.recordAiUsage({ day: today, providerId: "gone", role: "triage", calls: 1, inputTokens: null, outputTokens: null, costUsd: null });
		const body = (await (await as(ADMIN)("/api/v1/usage")).json()) as UsageResponse;
		expect(body.ai.by_provider).toEqual([
			{ provider_id: "my-gw", label: "My gateway", calls_mtd: 2, calls_today: 2, input_tokens_mtd: 300, output_tokens_mtd: 40, cost_mtd_usd: 0.002 },
			{ provider_id: "gone", label: "gone", calls_mtd: 1, calls_today: 1, input_tokens_mtd: null, output_tokens_mtd: null, cost_mtd_usd: null },
			{ provider_id: "workers-ai", label: "Workers AI", calls_mtd: 1, calls_today: 1, input_tokens_mtd: null, output_tokens_mtd: null, cost_mtd_usd: null },
		]);
		expect(body.ai.by_role).toContainEqual({
			role: "summary",
			label: "Summaries",
			provider_id: "my-gw",
			calls_mtd: 2,
			calls_today: 2,
			input_tokens_mtd: 300,
			output_tokens_mtd: 40,
		});
		expect(body.ai.by_role.find((r) => r.role === "injection_scanner")).toMatchObject({ label: "Prompt-injection scanner", provider_id: "workers-ai" });
	});

	it("returns empty provider and role arrays from a store without the new methods", async () => {
		const env = makeEnv() as unknown as { AUTH_STORE: { get: () => unknown } };
		const inner = env.AUTH_STORE.get() as Record<string, unknown>;
		const older = new Proxy({}, { get: (_t, name: string) => (name === "aiUsageByProvider" || name === "aiUsageByRole" ? undefined : inner[name]) });
		const res = await as(ADMIN)("/api/v1/usage", {}, { ...env, AUTH_STORE: { idFromName: () => "global", get: () => older } } as never);
		expect(res.status).toBe(200);
		const body = (await res.json()) as UsageResponse;
		expect(body.ai.by_provider).toEqual([]);
		expect(body.ai.by_role).toEqual([]);
	});

	it("falls back to the ledger without a Cloudflare token", async () => {
		const res = await as(ADMIN)("/api/v1/usage", {}, makeEnv({ CF_ANALYTICS_TOKEN: undefined }));
		const body = (await res.json()) as UsageResponse;
		expect(gql).toEqual([]);
		expect(body.provider.configured).toBe(false);
		expect(body.email).toMatchObject({ source: "local", unit: "messages", sent_mtd: 12 });
		expect(body.ai.neurons).toBeNull();
		expect(body.r2).toBeNull();
	});
});

describe("PUT /api/v1/usage/budget", () => {
	it("is admin-only and validated", async () => {
		const put = (who: string, body: unknown) => as(who)("/api/v1/usage/budget", { method: "PUT", body: JSON.stringify(body) });
		expect((await put(MEMBER, { ai_usd: 1 })).status).toBe(403);
		expect((await put(ADMIN, { ai_usd: -1 })).status).toBe(400);
		expect((await put(ADMIN, { nope: 1 })).status).toBe(400);
	});

	it("stores thresholds, writes an audit entry, and turns the banner on", async () => {
		const res = await as(ADMIN)("/api/v1/usage/budget", { method: "PUT", body: JSON.stringify({ ai_usd: 0.1, email_usd: null }) });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { budget: unknown }).budget).toMatchObject({ ai_usd: 0.1, email_usd: null, updated_by: ADMIN });
		expect([...objects.keys()].some((k) => k.startsWith("audit/"))).toBe(true);
		const body = (await (await as(ADMIN)("/api/v1/usage")).json()) as UsageResponse;
		expect(body.budget.exceeded).toBe(true);
		expect(body.budget.alerts[0]).toMatchObject({ kind: "ai", threshold_usd: 0.1, exceeded: true });
	});
});
