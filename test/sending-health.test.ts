// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The spam-rate circuit breaker: thresholds, the state machine, storage on
 * real SQLite through the AuthStore's own migrations, the evaluation run with
 * local and Cloudflare counts, and the `deliverability.warning` webhook.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	RESUME_GRACE_MS,
	SPAM_RATE_PAUSE,
	SPAM_RATE_WARNING,
	evaluateSpamRate,
	formatRate,
	needsAttention,
	nextDomainHealth,
} from "../shared/sending-health";
import { SendingHealthStore } from "../workers/lib/sending-health-store";
import { AuthStore, AUTH_MIGRATION_NAMES, type AuthSql } from "../workers/auth/store-core";
import {
	buildDeliverabilityPayload,
	combineEvaluations,
	evaluateSendingHealth,
	mirrorProviderComplaints,
	providerDomainCounts,
	type SendingHealthApi,
} from "../workers/lib/sending-health";
import { CfAnalyticsClient } from "../workers/lib/cf-analytics";
import { WEBHOOK_EVENT_TYPES, WEBHOOK_EVENT_LABELS } from "../shared/webhooks";
import { authStoreBinding, fakeBucket } from "./helpers/suppression-store";
import type { Env } from "../workers/types";

beforeEach(() => {
	vi.restoreAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
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
	// AuthStore runs the migrations, including 0012_sending_health.
	const auth = new AuthStore(sql, tx);
	return { auth, health: new SendingHealthStore(sql, tx) };
}

function api(health: SendingHealthStore): SendingHealthApi {
	return {
		isBulkPaused: async (d) => health.isBulkPaused(d),
		listSendingHealth: async () => health.list(),
		recordSendingHealth: async (d, e, n) => health.record(d, e, n),
		resumeBulkSending: async (d, b, n) => health.resume(d, b, n),
		pauseBulkSending: async (d, r, n) => health.pause(d, r, n),
		claimSendingHealthRun: async (n, i) => health.claimEvaluation(n, i),
	};
}

describe("evaluateSpamRate", () => {
	it("uses Gmail/Yahoo's thresholds: warn above 0.1%, critical above 0.3%", () => {
		expect(SPAM_RATE_WARNING).toBe(0.001);
		expect(SPAM_RATE_PAUSE).toBe(0.003);
		expect(evaluateSpamRate({ complaints: 1, delivered: 1000 }).level).toBe("ok"); // exactly 0.1%
		expect(evaluateSpamRate({ complaints: 2, delivered: 1000 }).level).toBe("warning");
		expect(evaluateSpamRate({ complaints: 3, delivered: 1000 }).level).toBe("warning"); // exactly 0.3%
		expect(evaluateSpamRate({ complaints: 4, delivered: 1000 }).level).toBe("critical");
	});

	it("does not act below the minimum volume", () => {
		expect(evaluateSpamRate({ complaints: 5, delivered: 40 })).toMatchObject({ level: "insufficient_volume", rate: 0.125 });
		expect(evaluateSpamRate({ complaints: 0, delivered: 0 })).toMatchObject({ level: "insufficient_volume", rate: null });
	});

	it("lets Cloudflare's reputation status make it worse, never better", () => {
		expect(evaluateSpamRate({ complaints: 0, delivered: 1000, providerStatus: "warning" }).level).toBe("warning");
		expect(evaluateSpamRate({ complaints: 0, delivered: 1000, providerStatus: "at_risk" }).level).toBe("critical");
		expect(evaluateSpamRate({ complaints: 5, delivered: 1000, providerStatus: "healthy" }).level).toBe("critical");
	});

	it("formats rates", () => {
		expect(formatRate(0.0012)).toBe("0.12%");
		expect(formatRate(null)).toBe("n/a");
	});
});

describe("nextDomainHealth", () => {
	const ev = (complaints: number, delivered = 1000) => ({ ...evaluateSpamRate({ complaints, delivered }), source: "local" });

	it("warns once per rise, pauses at critical, and never unpauses itself", () => {
		let state = nextDomainHealth(null, ev(0), 1);
		expect(state.notify).toBeNull();
		state = nextDomainHealth({ ...state.next, domain: "d" }, ev(2), 2);
		expect(state).toMatchObject({ notify: "warning", next: { level: "warning", bulk_paused: false } });
		state = nextDomainHealth(state.next, ev(2), 3);
		expect(state.notify).toBeNull(); // still warning: no repeat
		state = nextDomainHealth(state.next, ev(5), 4);
		expect(state).toMatchObject({ notify: "paused", next: { level: "critical", bulk_paused: true, paused_at: 4 } });
		expect(state.next.paused_reason).toContain("0.50%");
		state = nextDomainHealth(state.next, ev(0), 5);
		expect(state.next).toMatchObject({ level: "ok", bulk_paused: true }); // only an admin resumes
		expect(needsAttention(state.next)).toBe(true);
	});

	it("does not re-pause inside the resume grace period, then does", () => {
		const resumed = { ...nextDomainHealth(null, ev(0), 1).next, domain: "d", resumed_at: 100, notified_level: null };
		const inGrace = nextDomainHealth(resumed, ev(5), 100 + RESUME_GRACE_MS - 1);
		expect(inGrace.next.bulk_paused).toBe(false);
		expect(inGrace.notify).toBe("warning"); // still told, just not paused
		const after = nextDomainHealth({ ...inGrace.next, notified_level: null }, ev(5), 100 + RESUME_GRACE_MS + 1);
		expect(after.next.bulk_paused).toBe(true);
	});
});

describe("SendingHealthStore (AuthDO 0012_sending_health)", () => {
	it("is a named, appended AuthDO migration", () => {
		expect(AUTH_MIGRATION_NAMES).toContain("0012_sending_health");
		// Appended, not inserted: after every migration that shipped before it.
		expect(AUTH_MIGRATION_NAMES.indexOf("0012_sending_health")).toBeGreaterThan(
			AUTH_MIGRATION_NAMES.indexOf("0009_idempotency_keys"),
		);
	});

	it("records, pauses, resumes", () => {
		const { health } = sqlite();
		const ev = { ...evaluateSpamRate({ complaints: 5, delivered: 1000 }), source: "local" };
		const { health: row, notify } = health.record("Product.dev", ev, 10);
		expect(notify).toBe("paused");
		expect(row).toMatchObject({ domain: "product.dev", bulk_paused: true });
		expect(health.isBulkPaused("product.dev").paused).toBe(true);
		const resumed = health.resume("product.dev", "usr_admin", 20);
		expect(resumed).toMatchObject({ bulk_paused: false, resumed_at: 20, resumed_by: "usr_admin", paused_reason: null });
		expect(health.isBulkPaused("product.dev").paused).toBe(false);
		expect(health.resume("unknown.dev", null, 1)).toBeNull();
		expect(health.list().map((r) => r.domain)).toEqual(["product.dev"]);
	});

	it("claims an evaluation run once per interval", () => {
		const { health } = sqlite();
		expect(health.claimEvaluation(1_000, 500)).toBe(true);
		expect(health.claimEvaluation(1_400, 500)).toBe(false);
		expect(health.claimEvaluation(1_600, 500)).toBe(true);
	});
});

describe("evaluateSendingHealth", () => {
	it("pauses a domain above 0.3% and sends deliverability.warning once to each endpoint", async () => {
		const { health } = sqlite();
		const enqueue = vi.fn(async (events: unknown[]) => ({ queued: events.length }));
		const env = { WEBHOOKS: { idFromName: () => "g", get: () => ({ enqueue }) } } as unknown as Env;
		const result = await evaluateSendingHealth(env, {
			store: api(health),
			client: null,
			now: 1_000,
			mailboxes: ["a@product.dev", "b@product.dev", "c@clean.dev"],
			local: new Map([
				["product.dev", { delivered: 1000, complaints: 4 }],
				["clean.dev", { delivered: 500, complaints: 0 }],
			]),
		});
		expect(result.paused).toEqual(["product.dev"]);
		expect(health.isBulkPaused("product.dev").paused).toBe(true);
		expect(health.isBulkPaused("clean.dev").paused).toBe(false);
		// One enqueue for the paused domain, one event per mailbox on it, same id.
		expect(enqueue).toHaveBeenCalledTimes(1);
		const events = enqueue.mock.calls[0]![0] as { eventId: string; type: string; mailbox: string; payload: string }[];
		expect(events.map((e) => e.mailbox)).toEqual(["a@product.dev", "b@product.dev"]);
		expect(new Set(events.map((e) => e.eventId)).size).toBe(1);
		expect(events[0].type).toBe("deliverability.warning");
		expect(JSON.parse(events[0].payload).data).toMatchObject({ domain: "product.dev", bulk_paused: true, window_days: 7 });

		// Re-evaluating at the same level does not notify again.
		await evaluateSendingHealth(env, {
			store: api(health),
			client: null,
			now: 2_000,
			mailboxes: ["a@product.dev"],
			local: new Map([["product.dev", { delivered: 1000, complaints: 4 }]]),
		});
		expect(enqueue).toHaveBeenCalledTimes(1);
	});

	it("warns between 0.1% and 0.3% without pausing", async () => {
		const { health } = sqlite();
		const enqueue = vi.fn(async () => ({ queued: 1 }));
		const env = { WEBHOOKS: { idFromName: () => "g", get: () => ({ enqueue }) } } as unknown as Env;
		const result = await evaluateSendingHealth(env, {
			store: api(health),
			client: null,
			now: 1,
			mailboxes: ["a@product.dev"],
			local: new Map([["product.dev", { delivered: 1000, complaints: 2 }]]),
		});
		expect(result.domains[0]).toMatchObject({ level: "warning", bulk_paused: false });
		expect(enqueue).toHaveBeenCalledTimes(1);
	});

	it("combines local and Cloudflare counts, keeping the worse", () => {
		const both = combineEvaluations({ delivered: 1000, complaints: 0 }, { delivered: 2000, complaints: 8 }, "healthy");
		expect(both).toMatchObject({ level: "critical", source: "local+cloudflare", rate: 0.004 });
		expect(combineEvaluations({ delivered: 1000, complaints: 0 }, undefined, null).source).toBe("local");
		expect(combineEvaluations(undefined, { delivered: 1000, complaints: 0 }, null).source).toBe("cloudflare");
	});

	it("reads Cloudflare's per-domain delivered and complaint counts", async () => {
		const fetchImpl = vi.fn(async (url: string) => {
			if (url.includes("graphql")) {
				return new Response(
					JSON.stringify({
						data: {
							viewer: {
								zones: [
									{
										sending: [
											{ count: 900, dimensions: { status: "delivered", sendingDomain: "product.dev", sampleInterval: 1 } },
											{ count: 50, dimensions: { status: "delivered", sendingDomain: "product.dev", sampleInterval: 2 } },
											{ count: 9, dimensions: { status: "deliveryFailed", sendingDomain: "product.dev", sampleInterval: 1 } },
										],
										complaints: [{ count: 3, dimensions: { sendingDomain: "product.dev" } }],
									},
								],
							},
						},
					}),
				);
			}
			return new Response(JSON.stringify({ success: true, result: { status: "warning" } }));
		});
		const client = new CfAnalyticsClient({ graphqlToken: "t", restToken: "t", fetchImpl: fetchImpl as unknown as typeof fetch });
		const out = await providerDomainCounts(client, ["zone"], { start: "a", end: "b" }, "acct");
		expect(out!.counts.get("product.dev")).toEqual({ delivered: 1000, complaints: 3 });
		expect(out!.status).toBe("warning");
	});

	it("builds a stable payload", () => {
		const { next } = nextDomainHealth(null, { ...evaluateSpamRate({ complaints: 2, delivered: 1000 }), source: "local" }, 5);
		const payload = buildDeliverabilityPayload({ ...next, domain: "product.dev" }, "a@product.dev", "evt_1", 5);
		expect(payload).toMatchObject({ id: "evt_1", type: "deliverability.warning", mailbox: "a@product.dev", data: { level: "warning", spam_rate: 0.002 } });
	});
});

describe("deliverability.warning webhook event", () => {
	it("is in the vocabulary with a label", () => {
		expect(WEBHOOK_EVENT_TYPES).toContain("deliverability.warning");
		expect(WEBHOOK_EVENT_LABELS["deliverability.warning"].label).toBeTruthy();
	});
});

describe("mirrorProviderComplaints", () => {
	it("copies Cloudflare complaint suppressions into the local list", async () => {
		const { store, AUTH_STORE } = authStoreBinding();
		const env = { AUTH_STORE, BUCKET: fakeBucket() } as unknown as Env;
		const client = {
			hasRest: true,
			suppressions: async () => [
				{ id: "1", email: "a@x.com", reason: "complaint", created_at: "", expires_at: null, scope: { type: "sending_domain", value: "product.dev" } },
				{ id: "2", email: "b@x.com", reason: "complaint", created_at: "", expires_at: null, scope: { type: "account" } },
				{ id: "3", email: "c@x.com", reason: "hard_bounce", created_at: "", expires_at: null, scope: { type: "account" } },
			],
		} as unknown as CfAnalyticsClient;
		expect(await mirrorProviderComplaints(env, { client, accountId: "acct" })).toBe(2);
		const rows = await store.findSuppressions(["a@x.com", "b@x.com", "c@x.com"]);
		expect(rows.map((r) => [r.address, r.scope, r.reason]).sort()).toEqual([
			["a@x.com", "product.dev", "complaint"],
			["b@x.com", "global", "complaint"],
		]);
		// Idempotent.
		expect(await mirrorProviderComplaints(env, { client, accountId: "acct" })).toBe(0);
	});
});
