// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The analytics console API. Response shapes: `shared/analytics-types.ts`.
 *
 *   GET /api/v1/analytics/overview?days=1|7|30|90&scope=app|zone&domain=&refresh=1
 *   GET /api/v1/analytics/engagement?days=&mailbox=
 *   GET /api/v1/analytics/inbound?days=
 *   GET /api/v1/analytics/dmarc?days=
 *
 * ## Authorization
 *
 * - Every route needs `mail:read` on a scoped token (token-scope-guard).
 * - App scope: any caller, over the mailboxes they can see that are on a
 *   served domain (so a stale mailbox from a dropped domain never shows up).
 *   Sending numbers come from each mailbox's own ledger, in messages.
 * - Zone scope and anything describing the whole Cloudflare account or zone
 *   (reputation, quota, sending domains, other senders, provider suppressions,
 *   routing rules, DMARC) is admin-only: `isAdminFor(principal, "admin")`,
 *   which a scoped token satisfies only with `admin`. A member asking for zone
 *   scope gets 403; a member's overview simply omits those sections.
 *
 * ## Cloudflare data
 *
 * One combined GraphQL query per section across every configured zone, plus
 * the REST reads, each bundle cached for 5 minutes (`cf-analytics.ts`). The
 * bundles are zone-wide and keyed without the caller; authorization is
 * applied after, when the bundle is filtered. A window over 31 days skips
 * Cloudflare entirely and sets `provider.window_capped`. A Cloudflare failure
 * is reported in `provider.error` and the local data is still returned.
 */

import { Hono, type Context } from "hono";
import {
	ENGAGEMENT_NOTE,
	parseDays,
	rate,
	type DmarcResponse,
	type EngagementResponse,
	type InboundResponse,
	type MailboxRow,
	type Overview,
	type OverviewSections,
	type ProviderStatus,
	type SuppressionCounts,
} from "../../shared/analytics-types";
import { SUPPRESSION_REASONS } from "../../shared/suppressions";
import { isAdminFor, normalizeAddress, visibleMailboxes, type Principal } from "../lib/authz";
import {
	analyticsCacheKey,
	analyticsWindow,
	analyticsZoneTags,
	cachedJson,
	analyticsAccountId,
	analyticsClient,
	datesInWindow,
	defaultCache,
	type AnalyticsTimeWindow,
	type CfAnalyticsClient,
	type CfLimits,
	type CfReputation,
	type CfRule,
	type CfSuppression,
	type DmarcZoneData,
	type InboundZoneData,
	type OverviewZoneData,
} from "../lib/cf-analytics";
import * as agg from "../lib/analytics-aggregate";
import { listMailboxes } from "../lib/email-helpers";
import type { MailboxContext } from "../lib/mailbox";
import { suppressionStore } from "../lib/suppressions";
import { domainOfAddress, isDomainAllowed } from "../lib/zones";
import { liveAliasMap } from "./domains";
import { listProducts } from "../lib/products";
import { domainsForProducts } from "../../shared/products";
import type { Env } from "../types";
import type { MailboxEngagement, MailboxInboundStats, MailboxSendingStats } from "../durableObject/analytics";

type AppContext = Context<MailboxContext>;

export const analyticsRoutes = new Hono<MailboxContext>();

/** The MailboxDO methods these routes call. */
interface AnalyticsMailboxStub {
	getSendingAnalytics(window: { start: string; end: string }): Promise<MailboxSendingStats>;
	getEngagementAnalytics(window: { start: string; end: string }, limit?: number): Promise<MailboxEngagement>;
	getInboundAnalytics(window: { start: string; end: string }): Promise<MailboxInboundStats>;
}

function stubFor(env: Env, mailboxId: string): AnalyticsMailboxStub {
	return env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId)) as unknown as AnalyticsMailboxStub;
}

// -- shared request plumbing -------------------------------------------------

function isZoneAdmin(principal: Principal): boolean {
	return isAdminFor(principal, "admin");
}

/**
 * Mailboxes the caller may see that still exist on a served domain. The
 * legacy route listed every R2 key, which is how a mailbox on a domain that is
 * no longer served (e.g. devops@ on a dropped domain) leaked into analytics.
 */
async function scopedMailboxes(c: AppContext): Promise<string[]> {
	const all = await listMailboxes(c.env.BUCKET);
	const served = all.filter((m) => isDomainAllowed(c.env, domainOfAddress(m.email)));
	return visibleMailboxes(c.var.principal, served, (m) => m.email).map((m) => normalizeAddress(m.id));
}

async function aliasMap(env: Env): Promise<Record<string, string>> {
	if (!(env as { AUTH_STORE?: unknown }).AUTH_STORE) return {};
	return liveAliasMap(env).catch(() => ({}));
}

/** The sending addresses that belong to `mailboxes`: the mailboxes plus their aliases. */
function appAddressSet(mailboxes: readonly string[], aliases: Record<string, string>): Set<string> {
	const owned = new Set(mailboxes);
	const out = new Set(mailboxes);
	for (const [alias, owner] of Object.entries(aliases)) {
		if (owned.has(normalizeAddress(owner))) out.add(normalizeAddress(alias));
	}
	return out;
}

interface ProviderCtx {
	client: CfAnalyticsClient | null;
	zones: string[];
	window: AnalyticsTimeWindow;
	refresh: boolean;
	status: ProviderStatus;
	/** Oldest `cachedAt` seen, reported as `provider.cached_at`. */
	note(cachedAt: string): void;
	fail(e: unknown, what: string): void;
	/** Whether Cloudflare should be queried at all. */
	readonly usable: boolean;
}

async function providerCtx(c: AppContext, days: number): Promise<ProviderCtx> {
	const client = await analyticsClient(c.env);
	const zones = analyticsZoneTags(c.env);
	const window = analyticsWindow(days);
	const status: ProviderStatus = { configured: !!client?.hasGraphql, window_capped: window.capped };
	const errors: string[] = [];
	return {
		client,
		zones,
		window,
		// Only admins may force a bypass of the shared cache (GraphQL is rate limited).
		refresh: c.req.query("refresh") === "1" && isZoneAdmin(c.var.principal),
		status,
		note(cachedAt) {
			if (!status.cached_at || cachedAt < status.cached_at) status.cached_at = cachedAt;
		},
		fail(e, what) {
			const message = `${what}: ${(e as Error)?.message ?? String(e)}`;
			console.error("analytics provider error —", message);
			errors.push(message);
			status.error = errors.join("; ");
		},
		get usable() {
			return !!client?.hasGraphql && zones.length > 0 && !window.capped;
		},
	};
}

/** Cached GraphQL bundle for a section, or null on failure (recorded on `p`). */
async function graphqlBundle<T>(p: ProviderCtx, section: string, load: () => Promise<T>): Promise<T | null> {
	if (!p.usable) {
		if (p.status.configured && p.zones.length === 0 && !p.window.capped) {
			p.fail(new Error("no zone ids configured (set ZONES or EMAIL_ANALYTICS_ZONE_TAG)"), section);
		}
		return null;
	}
	try {
		const key = analyticsCacheKey(section, { zones: p.zones, start: p.window.start, end: p.window.end });
		const got = await cachedJson(defaultCache(), key, load, { refresh: p.refresh });
		p.note(got.cachedAt);
		return got.data;
	} catch (e) {
		p.fail(e, section);
		return null;
	}
}

// -- REST bundle ---------------------------------------------------------------

interface RestBundle {
	reputation: CfReputation | null;
	limits: CfLimits | null;
	suppressions: CfSuppression[] | null;
	subdomains: { zone: string; name: string; enabled?: boolean; dnsStatus: string | null }[] | null;
	rules: (CfRule & { zoneName: string | null })[] | null;
	errors: string[];
}

const accountIds = new Map<string, string>();

async function resolveAccountId(env: Env, client: CfAnalyticsClient, zones: string[]): Promise<string | null> {
	const configured = await analyticsAccountId(env);
	if (configured) return configured;
	const zone = zones[0];
	if (!zone) return null;
	const known = accountIds.get(zone);
	if (known) return known;
	const id = await client.accountIdFor(zone);
	accountIds.set(zone, id);
	return id;
}

async function loadRest(env: Env, client: CfAnalyticsClient, zones: string[]): Promise<RestBundle> {
	const errors: string[] = [];
	const attempt = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
		try {
			return await fn();
		} catch (e) {
			errors.push(`${what}: ${(e as Error).message}`);
			return null;
		}
	};
	const accountId = await attempt("account", () => resolveAccountId(env, client, zones));
	const [reputation, limits, suppressions, subdomains, rules] = await Promise.all([
		accountId ? attempt("reputation", () => client.reputation(accountId)) : null,
		accountId ? attempt("limits", () => client.limits(accountId)) : null,
		accountId ? attempt("suppressions", () => client.suppressions(accountId)) : null,
		attempt("subdomains", async () => {
			const out: RestBundle["subdomains"] & object = [];
			for (const zone of zones) {
				const subs = await client.subdomains(zone);
				const withDns = await Promise.all(
					subs.map(async (sub) => {
						const id = sub.id ?? sub.tag;
						let dnsStatus: string | null = null;
						try {
							dnsStatus = (await client.subdomainDnsStatus(zone, id)).status ?? null;
						} catch (e) {
							errors.push(`dns status ${sub.name}: ${(e as Error).message}`);
						}
						return { zone, name: sub.name, enabled: sub.enabled, dnsStatus };
					}),
				);
				out.push(...withDns);
			}
			return out;
		}),
		attempt("rules", async () =>
			(
				await Promise.all(
					zones.map(async (zone) => {
						// The zone apex names the catch-all ("*@example.com").
						const [rules, info] = await Promise.all([
							client.routingRules(zone),
							client.zone(zone).catch(() => null),
						]);
						return rules.map((rule) => ({ ...rule, zoneName: info?.name ?? null }));
					}),
				)
			).flat(),
		),
	]);
	return { reputation, limits, suppressions, subdomains, rules, errors };
}

async function restBundle(c: AppContext, p: ProviderCtx): Promise<RestBundle | null> {
	if (!p.client?.hasRest || p.zones.length === 0) return null;
	try {
		const key = analyticsCacheKey("rest", { zones: p.zones, account: await analyticsAccountId(c.env) });
		const got = await cachedJson(defaultCache(), key, () => loadRest(c.env, p.client!, p.zones), { refresh: p.refresh });
		p.note(got.cachedAt);
		for (const err of got.data.errors) p.fail(new Error(err), "rest");
		return got.data;
	} catch (e) {
		p.fail(e, "rest");
		return null;
	}
}

// -- local -----------------------------------------------------------------------

/** Pages read when counting local suppressions created in the window (500 each). */
const SUPPRESSION_WINDOW_PAGES = 10;

/**
 * Local suppression counts: the whole list by reason (all-time), plus entries
 * created inside the window. The list is newest first, so the window count
 * pages until it passes the window start; `inWindow` is null if that takes
 * more than `SUPPRESSION_WINDOW_PAGES` pages (a floor would mislabel).
 */
async function localSuppressionCounts(
	env: Env,
	window: { start: string; end: string },
): Promise<{ all: SuppressionCounts; inWindow: SuppressionCounts | null }> {
	try {
		const store = suppressionStore(env);
		const [all, ...perReason] = await Promise.all([
			store.listSuppressions({ limit: 1 }),
			...SUPPRESSION_REASONS.map((reason) => store.listSuppressions({ reason, limit: 1 })),
		]);
		const by_reason: Record<string, number> = {};
		SUPPRESSION_REASONS.forEach((reason, i) => {
			const n = perReason[i]?.total ?? 0;
			if (n > 0) by_reason[reason] = n;
		});

		const startMs = Date.parse(window.start);
		const endMs = Date.parse(window.end);
		const recent: { reason: string }[] = [];
		let complete = false;
		for (let page = 0; page < SUPPRESSION_WINDOW_PAGES; page++) {
			const res = await store.listSuppressions({ limit: 500, offset: page * 500 });
			let passed = false;
			for (const item of res.items) {
				if (item.created_at < startMs) {
					passed = true;
					break;
				}
				if (item.created_at < endMs) recent.push(item);
			}
			if (passed || res.items.length < 500) {
				complete = true;
				break;
			}
		}
		return { all: { total: all.total, by_reason }, inWindow: complete ? agg.countByReason(recent) : null };
	} catch (e) {
		console.error("analytics: local suppressions failed:", (e as Error).message);
		return { all: { total: 0, by_reason: {} }, inWindow: null };
	}
}

/**
 * Scope and unit of each overview block. App scope is app-only except the
 * account-wide blocks (reputation, quota, Cloudflare's suppression list),
 * which say so instead of mixing into app numbers. When zone scope falls back
 * to local data (no provider data), sending is labelled as the app's.
 */
function overviewSections(scope: "app" | "zone", zoneMode: boolean): OverviewSections {
	const app = { scope: "app", unit: "messages" } as const;
	const zone = { scope: "zone", unit: "recipients" } as const;
	const sending = zoneMode ? zone : app;
	return {
		sending,
		timeseries: sending,
		errors: zoneMode ? zone : app,
		reputation: { scope: "zone", unit: "recipients" },
		quota: { scope: "account", unit: "messages" },
		domains: scope === "zone" ? zone : { scope: "app", unit: "recipients" },
		senders: scope === "zone" ? zone : { scope: "app", unit: "recipients" },
		mailboxes: app,
		suppressions_provider: { scope: "account", unit: "addresses" },
		suppressions_local: { scope: "app", unit: "addresses" },
	};
}

const EMPTY_SENDING: MailboxSendingStats = {
	sent: 0,
	delivered: 0,
	bounced: 0,
	failed: 0,
	rejected: 0,
	complaints: 0,
	pending: 0,
	soft_bounced: 0,
	errors: [],
	by_date: [],
};
const EMPTY_ENGAGEMENT: MailboxEngagement = {
	sent: 0,
	delivered: 0,
	pending: 0,
	opens: 0,
	opened_messages: 0,
	unique_opens: 0,
	clicks: 0,
	clicked_messages: 0,
	unique_clicks: 0,
	messages: [],
	links: [],
	by_date: [],
};
const EMPTY_INBOUND: MailboxInboundStats = {
	stored: 0,
	spam_filed: 0,
	auth: { spf: {}, dkim: {}, dmarc: {} },
	by_date: [],
};

/** Run `fn` against every mailbox in parallel; a failing mailbox yields `fallback`. */
async function perMailbox<T>(
	env: Env,
	mailboxes: readonly string[],
	what: string,
	fn: (stub: AnalyticsMailboxStub) => Promise<T>,
	fallback: T,
): Promise<{ mailbox: string; data: T }[]> {
	return Promise.all(
		mailboxes.map(async (mailbox) => {
			try {
				return { mailbox, data: await fn(stubFor(env, mailbox)) };
			} catch (e) {
				console.error(`analytics ${what} failed for ${mailbox}:`, (e as Error).message);
				return { mailbox, data: fallback };
			}
		}),
	);
}

/** Open rate denominator: delivered messages, or sent before the reconciler has run. */
function engagementBase(delivered: number, sent: number): number {
	return delivered > 0 ? delivered : sent;
}

function windowOut(days: ReturnType<typeof parseDays>, w: AnalyticsTimeWindow) {
	return { days, start: w.start, end: w.end };
}

// -- overview --------------------------------------------------------------------

analyticsRoutes.get("/api/v1/analytics/overview", async (c) => {
	const principal = c.var.principal;
	const days = parseDays(c.req.query("days"));
	const scope = c.req.query("scope") === "zone" ? "zone" : "app";
	/*
	 * `domain=` narrows to one sending domain; `product=<id|slug>` (repeatable or
	 * comma-separated) to every domain of those products. Both may be given; the
	 * filter is their union. An unknown product matches nothing rather than
	 * silently widening to everything.
	 */
	const domainParam = c.req.query("domain")?.trim().toLowerCase() || null;
	const productParam = (c.req.queries("product") ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
	const productDomains = productParam.length ? domainsForProducts(await listProducts(c.env), productParam) : [];
	const domainSet: Set<string> | null =
		domainParam || productParam.length ? new Set([...(domainParam ? [domainParam] : []), ...productDomains]) : null;
	const inFilter = (d: string | null | undefined) => !domainSet || domainSet.has(String(d ?? "").toLowerCase());
	const domainFilter = domainSet ? [...domainSet] : null;
	const admin = isZoneAdmin(principal);
	if (scope === "zone" && !admin) {
		return c.json({ error: "Whole-zone analytics are for administrators.", code: "admin_required" }, 403);
	}

	const p = await providerCtx(c, days);
	const w = p.window;
	const local = { start: w.start, end: w.end };
	const dates = datesInWindow(w.start, w.end);

	let mailboxes = await scopedMailboxes(c);
	if (domainSet && scope === "app") mailboxes = mailboxes.filter((m) => inFilter(domainOfAddress(m)));
	const aliases = await aliasMap(c.env);

	const [sendingRows, engagementRows, inboundRows, localSuppressions, overviewData, rest] = await Promise.all([
		perMailbox(c.env, mailboxes, "sending", (s) => s.getSendingAnalytics(local), EMPTY_SENDING),
		perMailbox(c.env, mailboxes, "engagement", (s) => s.getEngagementAnalytics(local, 0), EMPTY_ENGAGEMENT),
		perMailbox(c.env, mailboxes, "inbound", (s) => s.getInboundAnalytics(local), EMPTY_INBOUND),
		localSuppressionCounts(c.env, local),
		graphqlBundle<OverviewZoneData[]>(p, "overview", () => p.client!.overview(p.zones, w)),
		admin ? restBundle(c, p) : Promise.resolve(null),
	]);

	// Local roll-ups.
	const localTotals = { ...EMPTY_SENDING, errors: [] as MailboxSendingStats["errors"] };
	const localByDate = new Map<string, { sent: number; delivered: number; bounced: number; failed: number }>();
	const errorMap = new Map<string, MailboxSendingStats["errors"][number]>();
	for (const { data } of sendingRows) {
		for (const key of ["sent", "delivered", "bounced", "failed", "rejected", "complaints", "pending", "soft_bounced"] as const) {
			localTotals[key] += data[key];
		}
		for (const d of data.by_date) {
			const cur = localByDate.get(d.date) ?? { sent: 0, delivered: 0, bounced: 0, failed: 0 };
			cur.sent += d.sent;
			cur.delivered += d.delivered;
			cur.bounced += d.bounced;
			cur.failed += d.failed;
			localByDate.set(d.date, cur);
		}
		for (const e of data.errors) {
			const key = `${e.cause}|${e.bucket ?? ""}`;
			const cur = errorMap.get(key) ?? { ...e, count: 0 };
			cur.count += e.count;
			if (e.last_seen && (!cur.last_seen || e.last_seen > cur.last_seen)) {
				cur.last_seen = e.last_seen;
				cur.example = e.example ?? cur.example;
			}
			errorMap.set(key, cur);
		}
	}
	const engagementByDate = new Map<string, { opened: number; clicked: number }>();
	for (const { data } of engagementRows) {
		for (const d of data.by_date) {
			const cur = engagementByDate.get(d.date) ?? { opened: 0, clicked: 0 };
			cur.opened += d.opened;
			cur.clicked += d.clicked;
			engagementByDate.set(d.date, cur);
		}
	}
	const localReceived = new Map<string, number>();
	for (const { data } of inboundRows) {
		for (const d of data.by_date) localReceived.set(d.date, (localReceived.get(d.date) ?? 0) + d.received);
	}

	const engagementOf = new Map(engagementRows.map((r) => [r.mailbox, r.data]));
	const mailboxRows: MailboxRow[] = sendingRows
		.map(({ mailbox, data }) => {
			const e = engagementOf.get(mailbox) ?? EMPTY_ENGAGEMENT;
			const base = engagementBase(data.delivered, data.sent);
			return {
				mailbox,
				sent: data.sent,
				delivered: data.delivered,
				bounced: data.bounced,
				failed: data.failed + data.rejected,
				opened: e.opened_messages,
				clicked: e.clicked_messages,
				open_rate: rate(e.opened_messages, base),
				click_rate: rate(e.clicked_messages, base),
			};
		})
		.sort((a, b) => b.sent - a.sent || a.mailbox.localeCompare(b.mailbox));

	// Cloudflare roll-ups (zone-wide; filtered below by scope).
	const zonesData = overviewData ?? [];
	const cfSending = zonesData.flatMap((z) => z.sending);
	const cfRep = zonesData.flatMap((z) => z.reputation);
	const cfComplaints = zonesData.flatMap((z) => z.complaints);
	const cfRepComplaints = zonesData.flatMap((z) => z.reputationComplaints);
	const cfReceived = zonesData.flatMap((z) => z.received);
	const cfRaw = zonesData.flatMap((z) => z.raw);
	p.status.sampled = agg.anySampled(cfSending) || agg.anySampled(cfRaw) || agg.anySampled(cfReceived);

	const appAddresses = appAddressSet(mailboxes, aliases);
	const zoneMode = scope === "zone" && overviewData !== null;
	const filteredGroups = domainSet ? cfSending.filter((g) => inFilter(g.dimensions.sendingDomain)) : cfSending;
	const filteredRaw = domainSet ? cfRaw.filter((r) => inFilter(r.sendingDomain)) : cfRaw;
	const split = agg.splitSenders(filteredRaw, appAddresses);

	let sending: Overview["sending"];
	let timeseries: Overview["timeseries"];
	let errors: Overview["errors"];
	if (zoneMode) {
		const t = agg.sumSendingGroups(filteredGroups);
		const complaints = agg.sumComplaints(
			domainSet ? cfComplaints.filter((g) => inFilter(g.dimensions.sendingDomain)) : cfComplaints,
		);
		sending = {
			sent: t.sent,
			delivered: t.delivered,
			bounced: t.bounced,
			failed: t.failed,
			rejected: t.rejected,
			complaints,
			// Zone scope stays zone-only: rows Cloudflare reports with no terminal
			// bucket yet. The app's scheduled queue is not zone data.
			pending: Math.max(0, t.sent - t.delivered - t.bounced - t.failed - t.rejected - t.deferred),
			deferred: t.deferred,
			rates: { delivery: rate(t.delivered, t.sent), bounce: rate(t.bounced, t.sent), complaint: rate(complaints, t.delivered) },
			unit: "recipients",
		};
		const byDate = agg.sendingByDate(filteredGroups);
		const received = new Map<string, number>();
		for (const g of cfReceived) {
			if (g.dimensions.date) received.set(g.dimensions.date, (received.get(g.dimensions.date) ?? 0) + agg.weight(g.count, g.dimensions.sampleInterval));
		}
		timeseries = dates.map((date) => {
			const s = byDate.get(date) ?? agg.emptyTotals();
			const e = engagementByDate.get(date);
			return {
				date,
				sent: s.sent,
				delivered: s.delivered,
				bounced: s.bounced,
				failed: s.failed + s.rejected,
				opened: e?.opened ?? 0,
				clicked: e?.clicked ?? 0,
				received: received.get(date) ?? 0,
			};
		});
		errors = agg.errorRowsFromRaw(filteredRaw);
	} else {
		const t = localTotals;
		sending = {
			sent: t.sent,
			delivered: t.delivered,
			bounced: t.bounced,
			failed: t.failed,
			rejected: t.rejected,
			complaints: t.complaints,
			pending: t.pending,
			deferred: t.soft_bounced,
			rates: { delivery: rate(t.delivered, t.sent), bounce: rate(t.bounced, t.sent), complaint: rate(t.complaints, t.delivered) },
			unit: "messages",
		};
		timeseries = dates.map((date) => {
			const s = localByDate.get(date);
			const e = engagementByDate.get(date);
			return {
				date,
				sent: s?.sent ?? 0,
				delivered: s?.delivered ?? 0,
				bounced: s?.bounced ?? 0,
				failed: s?.failed ?? 0,
				opened: e?.opened ?? 0,
				clicked: e?.clicked ?? 0,
				received: localReceived.get(date) ?? 0,
			};
		});
		errors = [...errorMap.values()]
			.sort((a, b) => b.count - a.count)
			.map((e) => ({ cause: e.cause, attribution: null, bucket: e.bucket, count: e.count, example: e.example, last_seen: e.last_seen }));
	}

	// Admins see account/zone health in both scopes (it can pause the app's sending).
	const reputation = admin && overviewData ? agg.reputationFrom(rest?.reputation ?? null, cfRep, cfRepComplaints) : null;
	const quota =
		admin && rest?.limits?.quota
			? { used: rest.limits.usage?.sent ?? 0, limit: rest.limits.quota.value, resets_at: rest.limits.usage?.resets_at ?? null }
			: null;
	/*
	 * Domain rows. Zone scope counts every sender (Cloudflare groups). App scope
	 * counts only this app's rows (the from-matched raw rows), so a domain's
	 * sent/delivered never mixes zone-wide volume into an app view; complaints
	 * are not attributable to a sender, so they are null there.
	 */
	const domains =
		admin && (overviewData || rest?.subdomains)
			? scope === "zone"
				? agg.domainRows({
						groups: cfSending,
						raw: cfRaw,
						complaints: cfComplaints,
						subdomains: rest?.subdomains ?? null,
						only: domainFilter,
					})
				: agg
						.domainRows({
							groups: agg.groupsFromRaw(split.app),
							raw: split.app,
							complaints: [],
							subdomains: rest?.subdomains ?? null,
							only: domainFilter,
						})
						.map((d) => ({ ...d, complaints: null }))
			: [];
	// Zone scope: every sender, flagged. App scope: only this caller's senders.
	const senders = scope === "zone" ? split.senders : split.senders.filter((s) => s.app);

	const body: Overview = {
		window: windowOut(days, w),
		scope,
		provider: p.status,
		sending,
		reputation,
		quota,
		timeseries,
		domains,
		senders,
		errors,
		mailboxes: mailboxRows,
		suppressions: {
			provider: admin ? agg.providerSuppressionCounts(rest?.suppressions ?? null) : null,
			local: localSuppressions.all,
			// Lists are current state: the counts above are every entry on the list
			// now. `in_window` is what was added during the selected period.
			window: "all_time",
			in_window: {
				provider: admin ? agg.providerSuppressionsInWindow(rest?.suppressions ?? null, w.start, w.end) : null,
				local: localSuppressions.inWindow,
			},
		},
		sections: overviewSections(scope, zoneMode),
	};
	return c.json(body);
});

// -- engagement --------------------------------------------------------------------

analyticsRoutes.get("/api/v1/analytics/engagement", async (c) => {
	const days = parseDays(c.req.query("days"));
	const w = analyticsWindow(days);
	let mailboxes = await scopedMailboxes(c);
	const only = c.req.query("mailbox")?.trim();
	if (only) {
		const wanted = normalizeAddress(only);
		if (!mailboxes.includes(wanted)) return c.json({ error: "Mailbox not found" }, 404);
		mailboxes = [wanted];
	}
	const rows = await perMailbox(
		c.env,
		mailboxes,
		"engagement",
		(s) => s.getEngagementAnalytics({ start: w.start, end: w.end }, 50),
		EMPTY_ENGAGEMENT,
	);

	let sent = 0;
	let delivered = 0;
	let pending = 0;
	let opens = 0;
	let uniqueOpens = 0;
	let openedMessages = 0;
	let clicks = 0;
	let uniqueClicks = 0;
	let clickedMessages = 0;
	const messages: EngagementResponse["messages"] = [];
	const links = new Map<string, EngagementResponse["links"][number]>();
	for (const { mailbox, data } of rows) {
		sent += data.sent;
		delivered += data.delivered;
		pending += data.pending ?? 0;
		opens += data.opens;
		uniqueOpens += data.unique_opens;
		openedMessages += data.opened_messages;
		clicks += data.clicks;
		uniqueClicks += data.unique_clicks;
		clickedMessages += data.clicked_messages;
		for (const m of data.messages) {
			messages.push({
				email_id: m.email_id,
				mailbox,
				subject: m.subject,
				sent_at: m.sent_at,
				recipients: m.recipients,
				opens: m.opens,
				unique_opens: m.unique_opens,
				clicks: m.clicks,
				first_open_at: m.first_open_at,
				outcome: m.outcome,
			});
		}
		// Per-mailbox unique counts are over disjoint messages, so they add exactly.
		for (const l of data.links) {
			const cur = links.get(l.url) ?? { url: l.url, clicks: 0, unique_clicks: 0, messages: 0 };
			cur.clicks += l.clicks;
			cur.unique_clicks += l.unique_clicks;
			cur.messages += l.messages;
			links.set(l.url, cur);
		}
	}
	const base = engagementBase(delivered, sent);
	const body: EngagementResponse = {
		window: windowOut(days, w),
		// Engagement is local tracking only; Cloudflare has no open/click data.
		provider: { configured: !!(await analyticsClient(c.env))?.hasGraphql, window_capped: false },
		totals: {
			opens,
			unique_opens: uniqueOpens,
			clicks,
			unique_clicks: uniqueClicks,
			open_rate: rate(openedMessages, base),
			click_rate: rate(clickedMessages, base),
			ctor: rate(clickedMessages, openedMessages),
			// The numerators and denominators behind the rates, so the UI can
			// say "1 of 15 delivered messages opened" instead of guessing.
			sent_messages: sent,
			delivered_messages: base,
			// Same rule as the overview's app-scope `sending.pending`.
			pending_messages: pending,
			opened_messages: openedMessages,
			clicked_messages: clickedMessages,
			rate_base: delivered > 0 ? "delivered" : "sent",
		},
		messages: agg.engagementMessageRows(messages, 50),
		links: [...links.values()].sort((a, b) => b.clicks - a.clicks || a.url.localeCompare(b.url)).slice(0, 50),
		note: ENGAGEMENT_NOTE,
	};
	return c.json(body);
});

// -- inbound -----------------------------------------------------------------------

analyticsRoutes.get("/api/v1/analytics/inbound", async (c) => {
	const days = parseDays(c.req.query("days"));
	const admin = isZoneAdmin(c.var.principal);
	const p = await providerCtx(c, days);
	const w = p.window;
	const mailboxes = await scopedMailboxes(c);
	const dates = datesInWindow(w.start, w.end);

	const [localRows, cf, rest, aliases] = await Promise.all([
		perMailbox(c.env, mailboxes, "inbound", (s) => s.getInboundAnalytics({ start: w.start, end: w.end }), EMPTY_INBOUND),
		admin ? graphqlBundle<InboundZoneData[]>(p, "inbound", () => p.client!.inbound(p.zones, w)) : Promise.resolve(null),
		admin ? restBundle(c, p) : Promise.resolve(null),
		admin ? aliasMap(c.env) : Promise.resolve({} as Record<string, string>),
	]);

	let stored = 0;
	let spamFiled = 0;
	let scanCapped = false;
	const localAuthRaw = { spf: {} as Record<string, number>, dkim: {} as Record<string, number>, dmarc: {} as Record<string, number> };
	const localByDate = new Map<string, { received: number; spam: number }>();
	for (const { data } of localRows) {
		stored += data.stored;
		spamFiled += data.spam_filed;
		if (data.capped) scanCapped = true;
		for (const key of ["spf", "dkim", "dmarc"] as const) {
			for (const [verdict, n] of Object.entries(data.auth[key])) localAuthRaw[key][verdict] = (localAuthRaw[key][verdict] ?? 0) + n;
		}
		for (const d of data.by_date) {
			const cur = localByDate.get(d.date) ?? { received: 0, spam: 0 };
			cur.received += d.received;
			cur.spam += d.spam;
			localByDate.set(d.date, cur);
		}
	}
	const localAuth = agg.normalizeAuthHistograms(localAuthRaw);

	const groups = (cf ?? []).flatMap((z) => z.groups);
	const errorRows = (cf ?? []).flatMap((z) => z.errors);
	const recipients = (cf ?? []).flatMap((z) => z.recipients);
	p.status.sampled = agg.anySampled(groups) || agg.anySampled(recipients);
	const known = new Set([...mailboxes, ...Object.keys(aliases).map(normalizeAddress)]);
	const hasMailbox = (a: string) => known.has(a);

	/*
	 * Spam has one source: messages this app filed to its Spam folder, dated
	 * like `stored`. Both `spam_filed` and `timeseries[].spam` read it, so the
	 * tile and the chart always agree. Cloudflare's own `isSpam` flag (0 today)
	 * is reported beside it as `cloudflare_spam`.
	 */
	const spamByDate = (date: string) => localByDate.get(date)?.spam ?? 0;

	let body: InboundResponse;
	if (cf) {
		const cfReceived = new Map<string, number>();
		let cfSpam = 0;
		for (const g of groups) {
			const n = agg.weight(g.count, g.dimensions.sampleInterval);
			if (g.dimensions.isSpam === 1) cfSpam += n;
			const date = g.dimensions.date;
			if (date) cfReceived.set(date, (cfReceived.get(date) ?? 0) + n);
		}
		const received = groups.reduce((n, g) => n + agg.weight(g.count, g.dimensions.sampleInterval), 0);
		const rules = rest?.rules ?? null;
		body = {
			window: windowOut(days, w),
			provider: p.status,
			received,
			stored,
			spam_filed: spamFiled,
			auth: agg.authCounts(groups),
			auth_total: received,
			auth_source: "cloudflare",
			actions: agg.routingActions(groups, errorRows),
			rules: rules ? agg.ruleRows(rules, groups, recipients, hasMailbox) : [],
			by_address: agg.byAddress(recipients, hasMailbox, 50, rules ?? []),
			routing_errors: agg.routingErrors(errorRows),
			timeseries: dates.map((date) => ({ date, received: cfReceived.get(date) ?? 0, spam: spamByDate(date) })),
			spam_source: "local",
			cloudflare_spam: cfSpam,
			reconciliation: agg.inboundReconciliation({ groups, recipients, rules, hasMailbox, stored, scanCapped }),
		};
	} else {
		// Local only: a member, an unconfigured provider, a capped window, or a failure.
		body = {
			window: windowOut(days, w),
			provider: p.status,
			received: stored,
			stored,
			spam_filed: spamFiled,
			auth: localAuth,
			auth_total: stored,
			auth_source: "local",
			actions: [],
			rules: [],
			by_address: [],
			routing_errors: [],
			timeseries: dates.map((date) => ({ date, received: localByDate.get(date)?.received ?? 0, spam: spamByDate(date) })),
			spam_source: "local",
		};
	}
	return c.json(body);
});

// -- DMARC -------------------------------------------------------------------------

analyticsRoutes.get("/api/v1/analytics/dmarc", async (c) => {
	if (!isZoneAdmin(c.var.principal)) {
		return c.json({ error: "DMARC reports cover the whole zone and are for administrators.", code: "admin_required" }, 403);
	}
	const days = parseDays(c.req.query("days"));
	const p = await providerCtx(c, days);
	const w = p.window;
	const data = await graphqlBundle<DmarcZoneData[]>(p, "dmarc", () => p.client!.dmarc(p.zones, w));
	const bySource = (data ?? []).flatMap((z) => z.bySource);
	const byReporter = (data ?? []).flatMap((z) => z.byReporter);
	const byDate = (data ?? []).flatMap((z) => z.byDate);
	const detail = (data ?? []).flatMap((z) => z.detail);
	p.status.sampled = bySource.some((g) => (g.dimensions.sampleInterval ?? 1) > 1);

	const sources = agg.dmarcSources(bySource);
	const reporters = agg.dmarcReporters(byReporter);
	const sum = (pick: (g: (typeof bySource)[number]) => number | undefined) =>
		bySource.reduce((n, g) => n + agg.weight(pick(g) ?? 0, g.dimensions.sampleInterval), 0);
	const series = new Map<string, { messages: number; pass: number }>();
	for (const g of byDate) {
		const date = g.dimensions.date;
		if (!date) continue;
		const cur = series.get(date) ?? { messages: 0, pass: 0 };
		cur.messages += agg.weight(g.sum.totalMatchingMessages, g.dimensions.sampleInterval);
		cur.pass += agg.weight(g.sum.dmarc ?? 0, g.dimensions.sampleInterval);
		series.set(date, cur);
	}

	const body: DmarcResponse = {
		window: windowOut(days, w),
		provider: p.status,
		totals: {
			messages: sum((g) => g.sum.totalMatchingMessages),
			pass: sum((g) => g.sum.dmarc),
			spf_pass: sum((g) => g.sum.spfPass),
			dkim_pass: sum((g) => g.sum.dkimPass),
			sources: sources.length,
			reporters: reporters.length,
		},
		sources,
		reporters,
		failures: agg.dmarcFailures(detail),
		timeseries: data
			? datesInWindow(w.start, w.end).map((date) => ({ date, ...(series.get(date) ?? { messages: 0, pass: 0 }) }))
			: [],
	};
	return c.json(body);
});
