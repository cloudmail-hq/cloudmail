// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The analytics console routes through the real Hono app, as
 * `domains-routes.test.ts` does: a real AuthStore + DomainStore on
 * node:sqlite behind AUTH_STORE (aliases, local suppressions), an R2 fake,
 * per-mailbox stub fakes, and a mocked global fetch serving recorded-shape
 * Cloudflare fixtures.
 *
 * Covers authz (zone scope admin-only, members limited to visible mailboxes,
 * token scopes), the app/zone split, the stale-mailbox filter, ledger-based
 * numbers, the 31-day cap, the unconfigured state and provider failure.
 */

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../workers/index";
import { AuthStore, type AuthSql } from "../workers/auth/store-core";
import { DomainStore } from "../workers/lib/domain-store";
import type { MailboxEngagement, MailboxInboundStats, MailboxSendingStats } from "../workers/durableObject/analytics";
import type { DmarcResponse, EngagementResponse, InboundResponse, Overview } from "../shared/analytics-types";
import overviewFixture from "./fixtures/cf-analytics/graphql-overview.json";
import inboundFixture from "./fixtures/cf-analytics/graphql-inbound.json";
import dmarcFixture from "./fixtures/cf-analytics/graphql-dmarc.json";
import reputationFixture from "./fixtures/cf-analytics/rest-reputation.json";
import limitsFixture from "./fixtures/cf-analytics/rest-limits.json";
import suppressionsFixture from "./fixtures/cf-analytics/rest-suppressions.json";
import subdomainsFixture from "./fixtures/cf-analytics/rest-subdomains.json";
import rulesFixture from "./fixtures/cf-analytics/rest-rules.json";
import dnsFixture from "./fixtures/cf-analytics/rest-dns-status.json";

const ZONE = "b8f81bfc13367df4146457bcd04befe4";
const ADMIN = "owner@example.com";
const MEMBER = "member@example.com";
const SUPPORT = "support@example.com";
const TECH = "tech@example.com";
const STALE = "devops@retired.example"; // a mailbox on a domain no longer served

function adapter(db: DatabaseSync): { sql: AuthSql; tx: <T>(fn: () => T) => T } {
	return {
		sql: {
			exec(query: string, ...bindings: unknown[]) {
				const rows = db.prepare(query).all(...(bindings as never[])) as any[];
				return { toArray: () => rows };
			},
		},
		tx<T>(fn: () => T): T {
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
		},
	};
}

let auth: AuthStore;
let domains: DomainStore;
let objects: Map<string, string>;
let mailboxCalls: string[];

function sending(over: Partial<MailboxSendingStats> = {}): MailboxSendingStats {
	return { sent: 0, delivered: 0, bounced: 0, failed: 0, rejected: 0, complaints: 0, pending: 0, soft_bounced: 0, errors: [], by_date: [], ...over };
}
function engagement(over: Partial<MailboxEngagement> = {}): MailboxEngagement {
	return { sent: 0, delivered: 0, opens: 0, opened_messages: 0, unique_opens: 0, clicks: 0, clicked_messages: 0, unique_clicks: 0, messages: [], links: [], by_date: [], ...over };
}
const inboundStats = (over: Partial<MailboxInboundStats> = {}): MailboxInboundStats => ({
	stored: 0,
	spam_filed: 0,
	auth: { spf: {}, dkim: {}, dmarc: {} },
	by_date: [],
	...over,
});

/** Per-mailbox DO answers. support@ mirrors the live "16 vs 13" case. */
const STUBS: Record<string, { sending: MailboxSendingStats; engagement: MailboxEngagement; inbound: MailboxInboundStats }> = {
	[SUPPORT]: {
		sending: sending({ sent: 11, delivered: 9, pending: 2, by_date: [{ date: "2026-10-25", sent: 11, delivered: 9, bounced: 0, failed: 0 }] }),
		engagement: engagement({
			sent: 11,
			delivered: 9,
			opens: 6,
			opened_messages: 3,
			unique_opens: 4,
			clicks: 2,
			clicked_messages: 1,
			unique_clicks: 1,
			messages: [
				{ email_id: "s1", subject: "Hi", sent_at: "2026-10-25T10:00:00.000Z", recipients: 1, opens: 6, unique_opens: 4, clicks: 2, unique_clicks: 1, first_open_at: "2026-10-25T11:00:00.000Z" },
			],
			links: [{ url: "https://example.com/a", clicks: 2, unique_clicks: 1, messages: 1 }],
			by_date: [{ date: "2026-10-25", opened: 6, clicked: 2 }],
		}),
		inbound: inboundStats({
			stored: 60,
			spam_filed: 2,
			auth: { spf: { pass: 58, fail: 1, none: 1 }, dkim: { pass: 59, fail: 0, none: 1 }, dmarc: { pass: 20, fail: 0, none: 40 } },
			by_date: [{ date: "2026-10-25", received: 60, spam: 2 }],
		}),
	},
	[TECH]: {
		sending: sending({
			sent: 2,
			delivered: 1,
			bounced: 1,
			errors: [{ cause: "bounced", bucket: "recipient", count: 1, example: "550 no such user", last_seen: "2026-10-24T00:00:00.000Z" }],
		}),
		engagement: engagement({
			sent: 2,
			delivered: 1,
			links: [{ url: "https://example.com/a", clicks: 1, unique_clicks: 1, messages: 1 }],
			messages: [
				{ email_id: "t1", subject: "QA", sent_at: "2026-10-26T01:00:00.000Z", recipients: 2, opens: 0, unique_opens: 0, clicks: 1, unique_clicks: 1, first_open_at: null },
			],
			clicks: 1,
			clicked_messages: 1,
			unique_clicks: 1,
		}),
		inbound: inboundStats({ stored: 1, auth: { spf: { none: 1 }, dkim: { none: 1 }, dmarc: { none: 1 } } }),
	},
};

function mailboxNamespace() {
	return {
		idFromName: (n: string) => n,
		get: (id: string) => ({
			getSendingAnalytics: async () => {
				mailboxCalls.push(`sending:${id}`);
				if (id === STALE) throw new Error("stale mailbox should never be queried");
				return STUBS[id]?.sending ?? sending();
			},
			getEngagementAnalytics: async () => {
				mailboxCalls.push(`engagement:${id}`);
				return STUBS[id]?.engagement ?? engagement();
			},
			getInboundAnalytics: async () => {
				mailboxCalls.push(`inbound:${id}`);
				return STUBS[id]?.inbound ?? inboundStats();
			},
			getFolders: async () => [],
		}),
	};
}

function makeEnv(extra: Record<string, unknown> = {}) {
	// DomainStore first (aliases), then AuthStore (suppressions).
	const rpc = new Proxy(
		{},
		{
			get: (_t, name: string) => async (...args: unknown[]) => {
				const target = name in domains ? domains : auth;
				return (target as any)[name](...args);
			},
		},
	);
	return {
		AUTH_MODE: "access",
		ADMIN_EMAILS: ADMIN,
		DOMAINS: "example.com,mail.example.com",
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
		MAILBOX: mailboxNamespace(),
		CF_ANALYTICS_TOKEN: "test-token",
		CF_ACCOUNT_ID: "acct",
		EMAIL_ANALYTICS_ZONE_TAG: ZONE,
		...extra,
	} as never;
}

/** Mocked Cloudflare API serving the recorded fixtures; records every call. */
let cfCalls: { method: string; url: string; query?: string }[];
function cfFetch(options: { graphqlError?: string } = {}) {
	return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		if (url.endsWith("/graphql")) {
			const { query } = JSON.parse(String(init?.body));
			cfCalls.push({ method, url, query: query.split("(")[0].trim() });
			if (options.graphqlError) return Response.json({ data: null, errors: [{ message: options.graphqlError }] });
			if (query.startsWith("query AnalyticsOverview")) return Response.json(overviewFixture);
			if (query.startsWith("query AnalyticsInbound")) return Response.json(inboundFixture);
			if (query.startsWith("query AnalyticsDmarc")) return Response.json(dmarcFixture);
			return Response.json({ data: null, errors: [{ message: "unexpected query" }] });
		}
		cfCalls.push({ method, url });
		const path = new URL(url).pathname.replace("/client/v4", "");
		if (path === "/accounts/acct/email/sending/reputation") return Response.json(reputationFixture);
		if (path === "/accounts/acct/email/sending/limits") return Response.json(limitsFixture);
		if (path === "/accounts/acct/email/sending/suppressions") return Response.json(suppressionsFixture);
		if (path === `/zones/${ZONE}/email/sending/subdomains`) return Response.json(subdomainsFixture);
		if (path.endsWith("/dns/status")) return Response.json(dnsFixture);
		if (path === `/zones/${ZONE}/email/routing/rules`) return Response.json(rulesFixture);
		if (path === `/zones/${ZONE}`) return Response.json({ success: true, errors: [], result: { id: ZONE, name: "example.com", account: { id: "acct" } } });
		return Response.json({ success: false, errors: [{ code: 7003, message: "No route" }] }, { status: 404 });
	});
}

let realFetch: typeof fetch;
beforeEach(() => {
	// The Cloudflare fixtures are dated 2026-10-19..26; pin "now" inside that
	// week so the 7-day window keeps covering them. Only Date is faked, so
	// timers and promises run normally.
	vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-26T12:00:00Z") });
	const db = new DatabaseSync(":memory:");
	const { sql, tx } = adapter(db);
	auth = new AuthStore(sql, tx);
	domains = new DomainStore(sql, tx);
	objects = new Map([
		[`mailboxes/${SUPPORT}.json`, "{}"],
		[`mailboxes/${TECH}.json`, "{}"],
		[`mailboxes/${STALE}.json`, "{}"],
		[`access/users/${MEMBER}.json`, JSON.stringify({ id: MEMBER, role: "member", mailboxes: [{ id: SUPPORT, role: "viewer" }] })],
	]);
	mailboxCalls = [];
	cfCalls = [];
	realFetch = globalThis.fetch;
	globalThis.fetch = cfFetch() as unknown as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
	vi.useRealTimers();
});

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;

/** The real app behind an identity (Access) or an API token. */
function as(identity: string, token?: { scopes: string[] | null; mailboxes?: string[] | null }) {
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
				mailboxes: token.mailboxes ?? null,
				parentId: null,
			});
		}
		return next();
	});
	outer.route("/", app as never);
	return (path: string, env = makeEnv()) =>
		outer.fetch(new Request(`https://mailer.example.com${path}`, { headers: { "Sec-Fetch-Site": "same-origin" } }), env, ctx);
}

describe("overview, app scope", () => {
	it("serves ledger numbers in messages, never the legacy optimistic count", async () => {
		const res = await as(ADMIN)("/api/v1/analytics/overview?days=30");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Overview;
		expect(body.scope).toBe("app");
		expect(body.window.days).toBe(30);
		expect(body.sending).toMatchObject({ sent: 13, delivered: 10, bounced: 1, pending: 2, unit: "messages" });
		expect(body.sending.rates.delivery).toBeCloseTo(10 / 13);
		expect(body.sending.rates.complaint).toBe(0);
		expect(body.errors).toEqual([
			{ cause: "bounced", attribution: null, bucket: "recipient", count: 1, example: "550 no such user", last_seen: "2026-10-24T00:00:00.000Z" },
		]);
		expect(body.timeseries).toHaveLength(31);
		expect(body.timeseries.find((p) => p.date === "2026-10-25")).toMatchObject({ sent: 11, delivered: 9, opened: 6, clicked: 2, received: 60 });
	});

	it("leaves stale mailboxes (unserved domains) out entirely", async () => {
		const body = (await (await as(ADMIN)("/api/v1/analytics/overview")).json()) as Overview;
		expect(body.mailboxes.map((m) => m.mailbox)).toEqual([SUPPORT, TECH]);
		expect(mailboxCalls.some((c) => c.endsWith(STALE))).toBe(false);
	});

	it("computes per-mailbox open/click rates over delivered", async () => {
		const body = (await (await as(ADMIN)("/api/v1/analytics/overview")).json()) as Overview;
		expect(body.mailboxes[0]).toEqual({
			mailbox: SUPPORT,
			sent: 11,
			delivered: 9,
			bounced: 0,
			failed: 0,
			opened: 3,
			clicked: 1,
			open_rate: 3 / 9,
			click_rate: 1 / 9,
		});
	});

	it("admin app scope lists only the app's senders, plus reputation/quota/domains", async () => {
		const body = (await (await as(ADMIN)("/api/v1/analytics/overview")).json()) as Overview;
		expect(body.senders.every((s) => s.app)).toBe(true);
		expect(body.senders.map((s) => s.from).sort()).toEqual([SUPPORT, TECH]);
		expect(body.reputation?.status).toBe("healthy");
		expect(body.quota).toEqual({ used: 17, limit: 5000, resets_at: "2026-10-26T10:22:26Z" });
		expect(body.domains.map((d) => d.domain).sort()).toEqual(["example.com", "mail.example.com"]);
		expect(body.domains.find((d) => d.domain === "example.com")!.dns_status).toBe("ready");
		expect(body.suppressions.provider).toEqual({ total: 5, by_reason: { hard_bounce: 5 } });
		expect(body.provider).toMatchObject({ configured: true, window_capped: false });
		expect(body.provider.cached_at).toMatch(/^\d{4}-/);
		expect(body.provider.error).toBeUndefined();
	});

	it("an alias counts as the owning mailbox's sender", async () => {
		domains.setAliases(SUPPORT, ["noreply@example.com"], 1);
		const body = (await (await as(ADMIN)("/api/v1/analytics/overview")).json()) as Overview;
		expect(body.senders.map((s) => s.from).sort()).toEqual(["noreply@example.com", SUPPORT, TECH]);
	});

	it("reports local suppressions by reason from the AuthDO", async () => {
		await auth.addSuppressions(
			[
				{ address: "a@example.org", scope: "global", reason: "hard_bounce", source: "dsn" },
				{ address: "b@example.org", scope: "example.com", reason: "unsubscribed", source: "unsubscribe-link" },
				{ address: "c@example.org", scope: "global", reason: "hard_bounce", source: "dsn" },
			],
			1,
		);
		const body = (await (await as(ADMIN)("/api/v1/analytics/overview")).json()) as Overview;
		expect(body.suppressions.local).toEqual({ total: 3, by_reason: { hard_bounce: 2, unsubscribed: 1 } });
	});

	it("filters by sending domain", async () => {
		const body = (await (await as(ADMIN)("/api/v1/analytics/overview?domain=mail.example.com")).json()) as Overview;
		expect(body.mailboxes).toEqual([]);
		expect(body.domains.map((d) => d.domain)).toEqual(["mail.example.com"]);
	});

	it("labels suppressions all-time and counts what was added in the window", async () => {
		const now = Date.now();
		await auth.addSuppressions([{ address: "old@example.org", scope: "global", reason: "hard_bounce", source: "dsn" }], now - 40 * 86_400_000);
		await auth.addSuppressions([{ address: "new@example.org", scope: "global", reason: "manual", source: "api" }], now - 86_400_000);
		const body = (await (await as(ADMIN)("/api/v1/analytics/overview?days=7")).json()) as Overview;
		expect(body.suppressions.window).toBe("all_time");
		expect(body.suppressions.local).toEqual({ total: 2, by_reason: { hard_bounce: 1, manual: 1 } });
		expect(body.suppressions.in_window?.local).toEqual({ total: 1, by_reason: { manual: 1 } });
		// Cloudflare's 5 hard bounces all predate the window (the "5 vs 0%" case).
		expect(body.suppressions.provider).toEqual({ total: 5, by_reason: { hard_bounce: 5 } });
		expect(body.suppressions.in_window?.provider).toEqual({ total: 0, by_reason: {} });
	});

	it("app scope is app-only: every block carries its scope, and domain rows count only app senders", async () => {
		const body = (await (await as(ADMIN)("/api/v1/analytics/overview?days=7")).json()) as Overview;
		expect(body.sections).toMatchObject({
			sending: { scope: "app", unit: "messages" },
			timeseries: { scope: "app", unit: "messages" },
			errors: { scope: "app" },
			mailboxes: { scope: "app" },
			domains: { scope: "app", unit: "recipients" },
			senders: { scope: "app" },
			reputation: { scope: "zone" },
			quota: { scope: "account" },
			suppressions_provider: { scope: "account", unit: "addresses" },
			suppressions_local: { scope: "app", unit: "addresses" },
		});
		// Domain sent counts equal the app senders' rows, not the zone groups.
		const appRows = body.senders.reduce((n, s) => n + s.sent, 0);
		expect(body.domains.reduce((n, d) => n + d.sent, 0)).toBe(appRows);
		expect(body.domains.every((d) => d.complaints === null)).toBe(true);
		const zone = (await (await as(ADMIN)("/api/v1/analytics/overview?days=7&scope=zone")).json()) as Overview;
		expect(zone.domains.reduce((n, d) => n + d.sent, 0)).toBeGreaterThan(appRows);
		expect(zone.sections?.sending).toEqual({ scope: "zone", unit: "recipients" });
	});

	it("zone pending is zone-only, not the app's scheduled queue", async () => {
		const body = (await (await as(ADMIN)("/api/v1/analytics/overview?days=7&scope=zone")).json()) as Overview;
		const s = body.sending;
		expect(s.pending).toBe(s.sent - s.delivered - s.bounced - s.failed - s.rejected - (s.deferred ?? 0));
	});
});

describe("overview, zone scope", () => {
	it("uses Cloudflare rows and lists every sender, flagging the app's", async () => {
		const body = (await (await as(ADMIN)("/api/v1/analytics/overview?scope=zone&days=7")).json()) as Overview;
		expect(body.scope).toBe("zone");
		expect(body.sending.unit).toBe("recipients");
		const zone = overviewFixture.data.viewer.zones[0];
		const rows = zone.sending.reduce((n, g) => n + g.count, 0);
		expect(body.sending.sent).toBe(rows);
		expect(body.sending.delivered).toBe(rows);
		expect(body.sending.rates.delivery).toBe(1);
		expect(body.sending.rates.bounce).toBe(0);
		const bySender = Object.fromEntries(body.senders.map((s) => [s.from, s.app]));
		expect(bySender).toMatchObject({ [SUPPORT]: true, [TECH]: true, "noreply@example.com": false, "alerts@mail.example.com": false });
		expect(body.timeseries).toHaveLength(8);
		expect(body.timeseries.reduce((n, p) => n + p.sent, 0)).toBe(rows);
		expect(body.timeseries.some((p) => p.received > 0)).toBe(true);
	});

	it("issues one combined GraphQL query for the overview, then serves from cache", async () => {
		await as(ADMIN)("/api/v1/analytics/overview?scope=zone");
		const gql = cfCalls.filter((c) => c.url.endsWith("/graphql"));
		expect(gql).toEqual([{ method: "POST", url: "https://api.cloudflare.com/client/v4/graphql", query: "query AnalyticsOverview" }]);
		// Every REST call is a GET.
		expect(cfCalls.filter((c) => !c.url.endsWith("/graphql")).every((c) => c.method === "GET")).toBe(true);
	});

	it("is refused to a member (403)", async () => {
		const res = await as(MEMBER)("/api/v1/analytics/overview?scope=zone");
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ code: "admin_required" });
		expect(cfCalls).toEqual([]);
	});

	it("is refused to an admin's token without the admin scope", async () => {
		expect((await as(ADMIN, { scopes: ["mail:read"] })("/api/v1/analytics/overview?scope=zone")).status).toBe(403);
		expect((await as(ADMIN, { scopes: ["admin", "mail:read"] })("/api/v1/analytics/overview?scope=zone")).status).toBe(200);
	});
});

describe("members", () => {
	it("get app scope over their visible mailboxes only, with no provider-wide data", async () => {
		const res = await as(MEMBER)("/api/v1/analytics/overview?days=7");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Overview;
		expect(body.mailboxes.map((m) => m.mailbox)).toEqual([SUPPORT]);
		expect(body.sending).toMatchObject({ sent: 11, delivered: 9 });
		expect(body.reputation).toBeNull();
		expect(body.quota).toBeNull();
		expect(body.domains).toEqual([]);
		expect(body.suppressions.provider).toBeNull();
		expect(body.senders.map((s) => s.from)).toEqual([SUPPORT]);
		expect(mailboxCalls.some((c) => c.endsWith(TECH))).toBe(false);
		// No REST call was made on a member's behalf.
		expect(cfCalls.filter((c) => !c.url.endsWith("/graphql"))).toEqual([]);
	});

	it("cannot read engagement for a mailbox they cannot see", async () => {
		expect((await as(MEMBER)(`/api/v1/analytics/engagement?mailbox=${TECH}`)).status).toBe(404);
		expect((await as(MEMBER)(`/api/v1/analytics/engagement?mailbox=${SUPPORT}`)).status).toBe(200);
	});

	it("get local-only inbound and no DMARC", async () => {
		const inbound = (await (await as(MEMBER)("/api/v1/analytics/inbound")).json()) as InboundResponse;
		expect(inbound).toMatchObject({ received: 60, stored: 60, spam_filed: 2, rules: [], actions: [], by_address: [] });
		expect(cfCalls).toEqual([]);
		expect((await as(MEMBER)("/api/v1/analytics/dmarc")).status).toBe(403);
	});

	it("a token limited to one mailbox sees only that mailbox", async () => {
		const body = (await (await as(ADMIN, { scopes: ["mail:read"], mailboxes: [TECH] })("/api/v1/analytics/overview")).json()) as Overview;
		expect(body.mailboxes.map((m) => m.mailbox)).toEqual([TECH]);
		// An admin user's token without `admin` gets no provider-wide sections.
		expect(body.reputation).toBeNull();
	});
});

describe("token scopes", () => {
	it("every analytics route needs mail:read", async () => {
		for (const path of ["overview", "engagement", "inbound", "dmarc"]) {
			const refused = await as(ADMIN, { scopes: ["mail:send"] })(`/api/v1/analytics/${path}`);
			expect(refused.status).toBe(403);
			expect(await refused.json()).toMatchObject({ code: "insufficient_scope", scope: "mail:read" });
		}
		expect((await as(ADMIN, { scopes: ["mail:read"] })("/api/v1/analytics/engagement")).status).toBe(200);
	});
});

describe("engagement", () => {
	it("merges mailboxes: totals, messages newest first, links by URL", async () => {
		const body = (await (await as(ADMIN)("/api/v1/analytics/engagement?days=30")).json()) as EngagementResponse;
		expect(body.totals).toEqual({
			opens: 6,
			unique_opens: 4,
			clicks: 3,
			unique_clicks: 2,
			open_rate: 3 / 10,
			click_rate: 2 / 10,
			ctor: 2 / 3,
			// The numerators and denominators behind the rates.
			sent_messages: 13,
			delivered_messages: 10,
			pending_messages: 0,
			opened_messages: 3,
			clicked_messages: 2,
			rate_base: "delivered",
		});
		expect(body.messages.map((m) => [m.email_id, m.mailbox])).toEqual([
			["t1", TECH],
			["s1", SUPPORT],
		]);
		expect(body.links).toEqual([{ url: "https://example.com/a", clicks: 3, unique_clicks: 2, messages: 2 }]);
		expect(body.note).toMatch(/pixel loads/);
	});

	it("rates are null with no denominator", async () => {
		objects.delete(`mailboxes/${SUPPORT}.json`);
		objects.delete(`mailboxes/${TECH}.json`);
		const body = (await (await as(ADMIN)("/api/v1/analytics/engagement")).json()) as EngagementResponse;
		expect(body.totals).toMatchObject({ open_rate: null, click_rate: null, ctor: null });
	});
});

describe("inbound (admin)", () => {
	it("returns Cloudflare routing with the dropped quirk relabelled", async () => {
		const body = (await (await as(ADMIN)("/api/v1/analytics/inbound?days=7")).json()) as InboundResponse;
		const groups = inboundFixture.data.viewer.zones[0].groups;
		expect(body.received).toBe(groups.reduce((n, g) => n + g.count, 0));
		expect(body.stored).toBe(61);
		const handled = body.actions.find((a) => a.action === "worker" && a.status === "dropped")!;
		expect(handled.label).toBe("Handled by worker");
		expect(body.rules.find((r) => r.matcher === "*@example.com")).toMatchObject({ action: "forward", destination: "forward-target@example.com" });
		const updates = body.by_address.find((a) => a.address === "updates@example.com")!;
		expect(updates.has_mailbox).toBe(false);
		expect(body.by_address.find((a) => a.address === SUPPORT)!.has_mailbox).toBe(true);
		expect(body.timeseries).toHaveLength(8);
	});

	it("sources spam_filed and the spam series from the same local count", async () => {
		const body = (await (await as(ADMIN)("/api/v1/analytics/inbound?days=7")).json()) as InboundResponse;
		expect(body.spam_source).toBe("local");
		expect(body.spam_filed).toBe(2);
		expect(body.timeseries.reduce((n, p) => n + p.spam, 0)).toBe(body.spam_filed);
		expect(body.cloudflare_spam).toBe(0);
	});

	it("auth histograms each sum to received, with pass/fail/none present", async () => {
		const body = (await (await as(ADMIN)("/api/v1/analytics/inbound?days=7")).json()) as InboundResponse;
		expect(body.auth_source).toBe("cloudflare");
		expect(body.auth_total).toBe(body.received);
		for (const key of ["spf", "dkim", "dmarc"] as const) {
			expect(Object.values(body.auth[key]).reduce((a, b) => a + b, 0)).toBe(body.received);
			expect(Object.keys(body.auth[key])).toEqual(expect.arrayContaining(["pass", "fail", "none"]));
		}
	});

	it("reconciles received, handled, stored and the catch-all from one window", async () => {
		const body = (await (await as(ADMIN)("/api/v1/analytics/inbound?days=7")).json()) as InboundResponse;
		const rec = body.reconciliation!;
		expect(rec.received).toBe(body.received);
		expect(rec.stored).toBe(body.stored);
		expect(rec.stored_gap).toBe(body.stored - rec.handled_by_worker);
		const handled = body.actions.filter((a) => a.label === "Handled by worker").reduce((n, a) => n + a.count, 0);
		expect(rec.handled_by_worker).toBe(handled);
		const catchAll = body.rules.find((r) => r.catch_all)!;
		expect(rec.catch_all!.count).toBe(catchAll.count);
		expect(catchAll.addresses!.reduce((n, a) => n + a.count, 0)).toBe(catchAll.count);
		expect(rec.catch_all!.known_addresses + rec.catch_all!.unknown_addresses).toBe(catchAll.count);
	});

	it("members get local auth histograms that sum to stored", async () => {
		const body = (await (await as(MEMBER)("/api/v1/analytics/inbound?days=7")).json()) as InboundResponse;
		expect(body.auth_source).toBe("local");
		expect(body.auth_total).toBe(body.stored);
		expect(body.reconciliation).toBeUndefined();
	});
});

describe("DMARC (admin)", () => {
	it("returns sources, reporters, totals and an empty failures table", async () => {
		const body = (await (await as(ADMIN)("/api/v1/analytics/dmarc?days=30")).json()) as DmarcResponse;
		expect(body.totals).toEqual({ messages: 462, pass: 462, spf_pass: 462, dkim_pass: 462, sources: 2, reporters: 2 });
		expect(body.sources[0]).toMatchObject({ org: "Cloudflare, Inc.", pass_rate: 1 });
		expect(body.reporters[0]).toEqual({ org: "google.com", messages: 461 });
		expect(body.failures).toEqual([]);
		expect(body.timeseries.reduce((n, p) => n + p.messages, 0)).toBe(462);
	});
});

describe("provider states", () => {
	it("days=90 is local only and sets window_capped", async () => {
		const body = (await (await as(ADMIN)("/api/v1/analytics/overview?scope=zone&days=90")).json()) as Overview;
		expect(body.provider).toMatchObject({ configured: true, window_capped: true });
		expect(cfCalls.filter((c) => c.url.endsWith("/graphql"))).toEqual([]);
		// Zone scope without CF data falls back to the ledger.
		expect(body.sending.unit).toBe("messages");
		expect(body.timeseries).toHaveLength(91);
	});

	it("reports configured=false without any token, and makes no Cloudflare call", async () => {
		const env = makeEnv({ CF_ANALYTICS_TOKEN: undefined, EMAIL_ANALYTICS_TOKEN: undefined });
		const body = (await (await as(ADMIN)("/api/v1/analytics/overview?scope=zone", env)).json()) as Overview;
		expect(body.provider).toEqual({ configured: false, window_capped: false, sampled: false });
		expect(body.reputation).toBeNull();
		expect(body.sending.sent).toBe(13);
		expect(cfCalls).toEqual([]);
	});

	it("falls back to EMAIL_ANALYTICS_TOKEN for GraphQL, without REST", async () => {
		const env = makeEnv({ CF_ANALYTICS_TOKEN: undefined, EMAIL_ANALYTICS_TOKEN: "legacy" });
		const body = (await (await as(ADMIN)("/api/v1/analytics/overview?scope=zone", env)).json()) as Overview;
		expect(body.provider.configured).toBe(true);
		expect(body.sending.unit).toBe("recipients");
		expect(body.quota).toBeNull();
		expect(cfCalls.every((c) => c.url.endsWith("/graphql"))).toBe(true);
	});

	it("a GraphQL error is reported and local data is still served", async () => {
		globalThis.fetch = cfFetch({ graphqlError: "rate limited" }) as unknown as typeof fetch;
		const res = await as(ADMIN)("/api/v1/analytics/overview?scope=zone");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Overview;
		expect(body.provider.error).toMatch(/overview: GraphQL: rate limited/);
		expect(body.sending.unit).toBe("messages");
		expect(body.mailboxes).toHaveLength(2);
	});
});
