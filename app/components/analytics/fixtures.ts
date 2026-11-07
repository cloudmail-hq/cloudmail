/**
 * Fixture responses for the analytics console.
 *
 * Shaped on the live tapetide.com numbers from 2026-09-25 → 2026-10-26: 709
 * recipient rows zone-wide, 17 messages from this app (16 delivered, 1 still
 * pending; one sent to 3 recipients, so the app's senders sum to 18
 * recipients), one engaged message (12 opens, 3 clicks) well past the newest
 * rows, a catch-all that matched 106 (105 unknown addresses + tech@, which has
 * a mailbox but no routing rule), product
 * mail from noreply@ and alerts@mail., DMARC sources Cloudflare 261 / Amazon
 * SES 201, about 2,000 inbound with their SPF/DKIM/DMARC splits, a healthy
 * reputation on the live 0.4/0.9, 0.02/0.04, 0.2/0.6 policy and a 5,000/day
 * quota.
 *
 * Used by unit tests, and by local development through `?fixtures=<scenario>`
 * on /analytics (dev builds only, see `app/queries/analytics.ts`). Production
 * always calls the Worker.
 */
import type {
	AnalyticsScope,
	Days,
	DmarcResponse,
	EngagementResponse,
	InboundResponse,
	OverviewResponse,
	ProviderStatus,
} from "../../../shared/analytics-types";
import { ENGAGEMENT_NOTE } from "../../../shared/analytics-types";

export const FIXTURE_SCENARIOS = ["demo", "issues", "empty", "unconfigured", "error", "loading", "unattributed"] as const;
export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number];

export function isFixtureScenario(s: string | null | undefined): s is FixtureScenario {
	return !!s && (FIXTURE_SCENARIOS as readonly string[]).includes(s);
}

/** Fixed "now" so fixtures, screenshots and tests agree. */
export const FIXTURE_NOW = Date.parse("2026-10-26T09:40:00Z");

/** Deterministic 0..1 noise, so the chart looks the same on every reload. */
function noise(seed: number): number {
	const x = Math.sin(seed * 12.9898) * 43758.5453;
	return x - Math.floor(x);
}

/** Split `total` across `n` days with a weekday shape and some noise. */
function spread(total: number, n: number, seed: number): number[] {
	const weights = Array.from({ length: n }, (_, i) => {
		const weekday = (i + 3) % 7;
		const shape = weekday >= 5 ? 0.45 : 1;
		return shape * (0.6 + noise(seed + i));
	});
	const sum = weights.reduce((a, b) => a + b, 0);
	const out = weights.map((w) => Math.floor((w / sum) * total));
	let rest = total - out.reduce((a, b) => a + b, 0);
	for (let i = 0; rest > 0; i = (i + 7) % n, rest--) out[i]++;
	return out;
}

function windowFor(days: Days) {
	const end = new Date(FIXTURE_NOW);
	const start = new Date(FIXTURE_NOW - days * 86_400_000);
	return { days, start: start.toISOString(), end: end.toISOString() };
}

function dayList(days: Days): string[] {
	const n = days === 1 ? 2 : days;
	return Array.from({ length: n }, (_, i) =>
		new Date(FIXTURE_NOW - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10),
	);
}

function provider(days: Days, scenario: FixtureScenario): ProviderStatus {
	if (scenario === "unconfigured") return { configured: false, window_capped: false };
	return {
		configured: true,
		window_capped: days > 30,
		cached_at: new Date(Date.now() - 3 * 60_000).toISOString(),
		...(scenario === "issues" ? { error: "Cloudflare GraphQL: rate limited (300 queries / 5 min). Showing cached data.", sampled: true } : {}),
	};
}

/** Scale 30-day live counts to another window. 90 days keeps local data only. */
function scale(n: number, days: Days): number {
	const f = days === 1 ? 1 / 30 : days === 7 ? 7 / 30 : 1;
	return Math.round(n * f);
}

// ── Overview ──────────────────────────────────────────────────────────────

export function overviewFixture(
	scenario: FixtureScenario = "demo",
	days: Days = 30,
	scope: AnalyticsScope = "zone",
): OverviewResponse {
	const window = windowFor(days);
	const prov = provider(days, scenario);
	const cfAvailable = prov.configured && !prov.window_capped;
	const issues = scenario === "issues";
	const dates = dayList(days);

	if (scenario === "empty") {
		return {
			window,
			scope,
			provider: prov,
			sending: {
				sent: 0, delivered: 0, bounced: 0, failed: 0, rejected: 0, complaints: 0, pending: 0, deferred: null,
				rates: { delivery: null, bounce: null, complaint: null },
				unit: scope === "zone" ? "recipients" : "messages",
			},
			reputation: {
				status: "healthy",
				since: null,
				metrics: [
					{ key: "bounce", value: null, warning_at: 0.4, at_risk_at: 0.9, denominator: 0, minimum_denominator: 100 },
					{ key: "complaint", value: null, warning_at: 0.02, at_risk_at: 0.04, denominator: 0, minimum_denominator: 100 },
					{ key: "spam_rejection", value: null, warning_at: 0.2, at_risk_at: 0.6, denominator: 0, minimum_denominator: 100 },
				],
			},
			quota: { used: 0, limit: 5000, resets_at: "2026-10-26T10:22:26Z" },
			timeseries: dates.map((date) => ({ date, sent: 0, delivered: 0, bounced: 0, failed: 0, opened: 0, clicked: 0, received: 0 })),
			domains: [],
			senders: [],
			errors: [],
			mailboxes: [],
			suppressions: { provider: { total: 0, by_reason: {} }, local: { total: 0, by_reason: {} } },
		};
	}

	const zone = scope === "zone" && cfAvailable;
	// Zone: Cloudflare rows (one per recipient). App: local ledger messages.
	const sent = zone ? scale(709, days) : scale(17, days === 90 ? 30 : days) + (days === 90 ? 21 : 0);
	const bounced = issues ? Math.max(3, Math.round(sent * 0.031)) : 0;
	const failed = issues ? 2 : 0;
	const rejected = issues ? 4 : 0;
	const pending = zone ? 0 : 1;
	const delivered = Math.max(0, sent - bounced - failed - rejected - pending);
	const complaints = issues ? 1 : 0;

	const sentByDay = spread(sent, dates.length, 7);
	// Engagement is app-only: the same opened/clicked counts in both scopes.
	const appOpened = days === 1 ? 0 : 1;
	const appClicked = days === 1 ? 0 : 1;
	const opensByDay = spread(appOpened, dates.length, 19);
	const clicksByDay = spread(appClicked, dates.length, 31);
	const recvByDay = spread(cfAvailable ? scale(2145, days) : scale(212, days), dates.length, 43);
	const bouncedByDay = spread(bounced, dates.length, 59);
	const failedByDay = spread(failed + rejected, dates.length, 67);
	const lastSendDay = sentByDay.reduce((acc, n, i) => (n > 0 ? i : acc), -1);
	const timeseries = dates.map((date, i) => {
		const bad = Math.min(sentByDay[i], bouncedByDay[i] + failedByDay[i]);
		const b = Math.min(bouncedByDay[i], bad);
		// The pending message was sent on the last day with sends and isn't delivered yet.
		const still = i === lastSendDay ? Math.min(pending, sentByDay[i] - bad) : 0;
		return {
			date,
			sent: sentByDay[i],
			delivered: sentByDay[i] - bad - still,
			bounced: b,
			failed: bad - b,
			opened: opensByDay[i],
			clicked: clicksByDay[i],
			received: recvByDay[i],
		};
	});

	const bounceRate7d = issues ? 0.12 : 0;
	return {
		window,
		scope: zone ? "zone" : "app",
		provider: prov,
		sending: {
			sent,
			delivered,
			bounced,
			failed,
			rejected,
			complaints,
			pending,
			deferred: null,
			rates: {
				delivery: sent ? delivered / sent : null,
				bounce: sent ? bounced / sent : null,
				complaint: delivered ? complaints / delivered : null,
			},
			unit: zone ? "recipients" : "messages",
		},
		reputation: prov.configured
			? {
					status: issues ? "warning" : "healthy",
					since: issues ? "2026-10-24T06:00:00Z" : null,
					metrics: [
						{ key: "bounce", value: bounceRate7d, warning_at: 0.4, at_risk_at: 0.9, denominator: issues ? 182 : 151, minimum_denominator: 100 },
						{ key: "complaint", value: issues ? 0.021 : 0, warning_at: 0.02, at_risk_at: 0.04, denominator: issues ? 140 : 151, minimum_denominator: 100 },
						{ key: "spam_rejection", value: issues ? 0.03 : 0, warning_at: 0.2, at_risk_at: 0.6, denominator: issues ? 64 : 151, minimum_denominator: 100 },
					],
				}
			: null,
		quota: prov.configured ? { used: issues ? 4120 : 41, limit: 5000, resets_at: "2026-10-26T10:22:26Z" } : null,
		timeseries,
		domains: cfAvailable
			? [
					{
						domain: "tapetide.com",
						enabled: true,
						dns_status: "ready",
						sent: scale(503, days),
						delivered: scale(503, days) - (issues ? bounced : 0),
						bounced: issues ? bounced : 0,
						complaints: issues ? 1 : 0,
						top_senders: [
							{ from: "noreply@tapetide.com", count: scale(485, days) },
							{ from: "support@tapetide.com", count: scale(11, days) },
							{ from: "govind@tapetide.com", count: scale(3, days) },
							{ from: "tech@tapetide.com", count: scale(3, days) },
						],
					},
					{
						domain: "mail.tapetide.com",
						enabled: true,
						dns_status: issues ? "misconfigured" : "ready",
						sent: scale(206, days),
						delivered: scale(206, days),
						bounced: 0,
						complaints: 0,
						top_senders: [{ from: "alerts@mail.tapetide.com", count: scale(206, days) }],
					},
				]
			: [],
		senders: zone
			? [
					{ from: "noreply@tapetide.com", app: false, sent: scale(485, days), delivered: scale(485, days) - (issues ? bounced : 0) },
					{ from: "alerts@mail.tapetide.com", app: false, sent: scale(206, days), delivered: scale(206, days) },
					{ from: "support@tapetide.com", app: true, sent: scale(12, days), delivered: scale(12, days) },
					{ from: "govind@tapetide.com", app: true, sent: scale(3, days), delivered: scale(3, days) },
					{ from: "tech@tapetide.com", app: true, sent: scale(3, days), delivered: scale(3, days) },
				]
			: [
					// Cloudflare rows: one per recipient (the to+cc QA message counts 3).
					{ from: "support@tapetide.com", app: true, sent: scale(12, days), delivered: scale(12, days) - (issues ? 1 : 0) },
					{ from: "govind@tapetide.com", app: true, sent: scale(3, days), delivered: scale(3, days) },
					{ from: "tech@tapetide.com", app: true, sent: scale(3, days), delivered: scale(3, days) },
				],
		errors: issues
			? [
					{ cause: "mailbox_does_not_exist", attribution: "recipient", bucket: "recipient", count: bounced, example: "550 5.1.1 The email account that you tried to reach does not exist.", last_seen: "2026-10-26T07:12:00Z" },
					{ cause: "E_RECIPIENT_SUPPRESSED", attribution: "sender", bucket: "internal", count: rejected, example: "Recipient is on the suppression list (hard_bounce).", last_seen: "2026-10-25T16:40:00Z" },
					{ cause: "content_rejected", attribution: null, bucket: null, count: failed, example: "554 5.7.1 Message rejected due to content restrictions", last_seen: "2026-10-23T11:03:00Z" },
				]
			: [],
		mailboxes: [
			{ mailbox: "support@tapetide.com", sent: scale(12, days), delivered: Math.max(0, scale(12, days) - (days === 1 ? 0 : 1) - (issues ? 1 : 0)), bounced: issues ? 1 : 0, failed: 0, opened: 0, clicked: 0, open_rate: 0, click_rate: 0 },
			{ mailbox: "govind@tapetide.com", sent: scale(3, days), delivered: scale(3, days), bounced: 0, failed: 0, opened: appOpened, clicked: appClicked, open_rate: days === 1 ? null : 1 / 3, click_rate: days === 1 ? null : 1 / 3 },
			{ mailbox: "tech@tapetide.com", sent: scale(2, days), delivered: scale(2, days), bounced: 0, failed: issues ? 1 : 0, opened: 0, clicked: 0, open_rate: days === 1 ? null : 0, click_rate: days === 1 ? null : 0 },
		],
		suppressions: {
			provider: prov.configured ? { total: issues ? 9 : 5, by_reason: issues ? { hard_bounce: 7, complaint: 1, soft_bounce: 1 } : { hard_bounce: 5 } } : null,
			local: { total: issues ? 6 : 3, by_reason: issues ? { hard_bounce: 4, unsubscribed: 1, manual: 1 } : { hard_bounce: 2, unsubscribed: 1 } },
		},
		sections: sectionsFor(zone),
	};
}

/** The `sections{}` scope/unit map, as the Worker sends it (#109). */
function sectionsFor(zone: boolean): NonNullable<OverviewResponse["sections"]> {
	const z = zone ? "zone" : "app";
	return {
		sending: { scope: z, unit: zone ? "recipients" : "messages" },
		timeseries: { scope: z, unit: zone ? "recipients" : "messages" },
		errors: { scope: z, unit: zone ? "recipients" : "messages" },
		reputation: { scope: "zone", unit: "recipients" },
		quota: { scope: "account", unit: "messages" },
		domains: { scope: z, unit: "recipients" },
		senders: { scope: z, unit: "recipients" },
		mailboxes: { scope: "app", unit: "messages" },
		suppressions_provider: { scope: "account", unit: "addresses" },
		suppressions_local: { scope: "app", unit: "addresses" },
	};
}

// ── Engagement ────────────────────────────────────────────────────────────

export function engagementFixture(scenario: FixtureScenario = "demo", days: Days = 30): EngagementResponse {
	const window = windowFor(days);
	const prov = provider(days, scenario);
	if (scenario === "empty") {
		return {
			window, provider: prov,
			totals: { opens: 0, unique_opens: 0, clicks: 0, unique_clicks: 0, open_rate: null, click_rate: null, ctor: null },
			messages: [], links: [], note: ENGAGEMENT_NOTE,
		};
	}
	// The app's 30-day cohort, as in production: 17 messages (12 support@,
	// 3 govind@, 2 tech@), one to 3 recipients (to+cc), and a single engaged
	// message, old enough to fall past the newest rows: 12 opens, 3 clicks
	// from one recipient. The newest message is still pending.
	const base: { subject: string; mailbox: string; recipients: number; opens: number; unique_opens: number; clicks: number }[] = [
		{ subject: "Re: Inquiry Regarding Tapetide Enterprise", mailbox: "support@tapetide.com", recipients: 1, opens: 0, unique_opens: 0, clicks: 0 },
		{ subject: "Tapetide QA test #2 (to+cc)", mailbox: "tech@tapetide.com", recipients: 3, opens: 0, unique_opens: 0, clicks: 0 },
		{ subject: "Tapetide QA test #1", mailbox: "support@tapetide.com", recipients: 1, opens: 0, unique_opens: 0, clicks: 0 },
		{ subject: "Re: Clarification on Local Storage of API data", mailbox: "support@tapetide.com", recipients: 1, opens: 0, unique_opens: 0, clicks: 0 },
		{ subject: "Re: Query: NSE option chain and futures", mailbox: "support@tapetide.com", recipients: 1, opens: 0, unique_opens: 0, clicks: 0 },
		{ subject: "Re: Inquiry Regarding Tapetide Enterprise", mailbox: "support@tapetide.com", recipients: 1, opens: 0, unique_opens: 0, clicks: 0 },
		{ subject: "Re: Inquiry Regarding Tapetide Enterprise (2)", mailbox: "support@tapetide.com", recipients: 1, opens: 0, unique_opens: 0, clicks: 0 },
		{ subject: "Re: Enterprise data licence for a public app", mailbox: "support@tapetide.com", recipients: 1, opens: 0, unique_opens: 0, clicks: 0 },
		{ subject: "Re: Enterprise data licence (follow-up)", mailbox: "support@tapetide.com", recipients: 1, opens: 0, unique_opens: 0, clicks: 0 },
		{ subject: "Re: Inquiry Regarding Tapetide Enterprise (3)", mailbox: "support@tapetide.com", recipients: 1, opens: 0, unique_opens: 0, clicks: 0 },
		{ subject: "Re: Enterprise data licence (pricing)", mailbox: "support@tapetide.com", recipients: 1, opens: 0, unique_opens: 0, clicks: 0 },
		{ subject: "Re: Inquiry Regarding Tapetide Enterprise (4)", mailbox: "support@tapetide.com", recipients: 1, opens: 0, unique_opens: 0, clicks: 0 },
		{ subject: "Re: RE: Unable to create new Kiro subscriptions", mailbox: "govind@tapetide.com", recipients: 1, opens: 0, unique_opens: 0, clicks: 0 },
		{ subject: "Tapetide MCP: Indian equities data for your agent", mailbox: "govind@tapetide.com", recipients: 1, opens: 12, unique_opens: 1, clicks: 3 },
		{ subject: "Unable to create new Kiro subscriptions", mailbox: "govind@tapetide.com", recipients: 1, opens: 0, unique_opens: 0, clicks: 0 },
		{ subject: "Re: upgrade to Pro", mailbox: "support@tapetide.com", recipients: 1, opens: 0, unique_opens: 0, clicks: 0 },
		{ subject: "Upgrading from Starter to Pro on Tapetide", mailbox: "tech@tapetide.com", recipients: 1, opens: 0, unique_opens: 0, clicks: 0 },
	];
	const messages = base.map((m, i) => {
		const sent = new Date(FIXTURE_NOW - (i * 1.8 + 0.5) * 86_400_000 * (days === 1 ? 1 / 30 : days === 7 ? 7 / 30 : 1));
		return {
			email_id: `em_fixture_${i + 1}`,
			...m,
			sent_at: sent.toISOString(),
			// The newest message is still waiting for Cloudflare to confirm delivery.
			outcome: (i === 0 ? "pending" : "delivered") as "pending" | "delivered",
			first_open_at: m.opens ? new Date(sent.getTime() + (12 + i * 7) * 60_000).toISOString() : null,
		};
	});
	// Shorter windows keep the newest messages: 4 in 7 days, 1 in 24 hours.
	const shown = messages.slice(0, days === 1 ? 1 : days === 7 ? 4 : 17);
	// Rates are over delivered messages, like the overview tiles (the app's
	// overview for the same window), so the two sections always agree.
	const ov = overviewFixture(scenario, days, "app");
	const delivered = ov.mailboxes.reduce((a, m) => a + m.delivered, 0) || ov.mailboxes.reduce((a, m) => a + m.sent, 0);
	const uniqueOpened = ov.mailboxes.reduce((a, m) => a + m.opened, 0);
	const uniqueClicked = ov.mailboxes.reduce((a, m) => a + m.clicked, 0);
	return {
		window,
		provider: prov,
		totals: {
			opens: shown.reduce((a, m) => a + m.opens, 0),
			unique_opens: uniqueOpened,
			clicks: shown.reduce((a, m) => a + m.clicks, 0),
			unique_clicks: uniqueClicked,
			open_rate: delivered ? uniqueOpened / delivered : null,
			click_rate: delivered ? uniqueClicked / delivered : null,
			ctor: uniqueOpened ? uniqueClicked / uniqueOpened : null,
			sent_messages: shown.length,
			delivered_messages: delivered,
			pending_messages: shown.filter((m) => m.outcome === "pending").length,
			opened_messages: uniqueOpened,
			clicked_messages: uniqueClicked,
			rate_base: "delivered",
		},
		// "unattributed": totals are known but no open or click is tied to a message
		// (what production shows while per-message attribution is missing).
		messages: scenario === "unattributed" ? shown.map((m) => ({ ...m, opens: 0, unique_opens: 0, clicks: 0, first_open_at: null })) : shown,
		links: [
			{ url: "https://tapetide.com/mcp?ref=email", clicks: 2, unique_clicks: 1, messages: 1 },
			{ url: "https://tapetide.com/docs/getting-started", clicks: 1, unique_clicks: 1, messages: 1 },
		].slice(0, days === 1 ? 0 : 2),
		note: ENGAGEMENT_NOTE,
	};
}

// ── Inbound ───────────────────────────────────────────────────────────────

export function inboundFixture(scenario: FixtureScenario = "demo", days: Days = 30): InboundResponse {
	const window = windowFor(days);
	const prov = provider(days, scenario);
	const dates = dayList(days);
	const cf = prov.configured && !prov.window_capped;
	if (scenario === "empty") {
		return {
			window, provider: prov, received: 0, stored: 0, spam_filed: 0,
			auth: { spf: {}, dkim: {}, dmarc: {} }, actions: [], rules: [], by_address: [], routing_errors: [],
			timeseries: dates.map((date) => ({ date, received: 0, spam: 0 })),
		};
	}
	const s = (n: number) => scale(n, days);
	// Live 30 days: 2,096 received, 1,984 handed to the Worker, 110 forwarded,
	// 2 refused on SPF; 1,987 stored (dated by the Date header, so 3 more than
	// Cloudflare's event-time count). The catch-all matched 106: 105 to
	// addresses with no mailbox, 1 to tech@, which has a mailbox but no rule.
	const received = cf ? s(2096) : s(212);
	const recv = spread(received, dates.length, 43);
	const spam = spread(s(1), dates.length, 71);
	const issues = scenario === "issues";
	// "issues": manish@ also has a mailbox but only its own forward rule plus
	// catch-all hits, so two addresses are known but unrouted.
	const catchAllAddresses = [
		{ address: "jobs@tapetide.com", count: s(69), has_mailbox: false },
		{ address: "hello@tapetide.com", count: s(13), has_mailbox: false },
		{ address: "hit@tapetide.com", count: s(5), has_mailbox: false },
		{ address: "mayur@tapetide.com", count: s(5), has_mailbox: false },
		{ address: "nimisha@tapetide.com", count: s(4), has_mailbox: false },
		{ address: "manish@tapetide.com", count: s(3), has_mailbox: issues },
		{ address: "sudhir@tapetide.com", count: s(3), has_mailbox: false },
		{ address: "tech.team@tapetide.com", count: s(2), has_mailbox: false },
		{ address: "dev1@tapetide.com", count: s(1), has_mailbox: false },
		{ address: "tech@tapetide.com", count: Math.max(1, s(1)), has_mailbox: true },
	].filter((a) => a.count > 0);
	const catchAll = catchAllAddresses.reduce((a, r) => a + r.count, 0);
	const known = catchAllAddresses.filter((a) => a.has_mailbox).reduce((a, r) => a + r.count, 0);
	const handled = cf ? s(1984) : 0;
	const refused = cf && days !== 1 ? 2 : 0;
	const stored = cf ? handled + (days === 1 ? 0 : 3) : received;
	const rule = (id: string, matcher: string, action: string, destination: string, count: number, extra: Partial<InboundResponse["rules"][number]> = {}) => ({
		id, name: null, matcher, action, destination, enabled: true, count, errors: 0,
		addresses: count ? [{ address: matcher, count, has_mailbox: action === "worker" }] : [],
		...extra,
	});
	return {
		window,
		provider: prov,
		received,
		stored,
		spam_filed: s(1),
		auth: cf
			? {
					spf: { pass: s(2085), fail: s(2), none: s(2), permerror: s(3), temperror: s(3), softfail: s(1) },
					dkim: { pass: s(2091), fail: 0, none: s(5) },
					dmarc: { pass: s(272), fail: s(1), none: s(1823) },
				}
			: { spf: {}, dkim: {}, dmarc: {} },
		auth_total: received,
		auth_source: cf ? "cloudflare" : "local",
		actions: cf
			? [
					{ label: "Handled by worker", action: "worker", status: "dropped", count: handled },
					{ label: "Forwarded", action: "forward", status: "delivered", count: s(110) },
					...(refused ? [{ label: "Rejected (failed SPF/DMARC)", action: "worker", status: "error", count: refused, reason: "auth" as const }] : []),
				]
			: [],
		rules: cf
			? [
					rule("e1d933d063e14046a8f604142e7fd7b3", "updates@tapetide.com", "worker", "tapetide-agentic-inbox", s(1704), { name: "updates -> agentic-inbox" }),
					rule("ecc3bcd66d5f4d09b34cb2ed1234d08c", "*@tapetide.com", "forward", "forward@example.net", catchAll, { name: "Catch-all", catch_all: true, addresses: catchAllAddresses }),
					rule("c031ace4ec3d4d288c65462e503f95a8", "devops@tapetide.com", "worker", "tapetide-agentic-inbox", s(92)),
					rule("84139028096a4d7fa0fd41778fb47944", "support@tapetide.com", "worker", "tapetide-agentic-inbox", s(63)),
					rule("0d33e6e998f6479a98ac0ca10b953f76", "hr@tapetide.com", "worker", "tapetide-agentic-inbox", s(61), { errors: refused }),
					rule("db164dfc0d17400b9bf95137647bf6ed", "govind@tapetide.com", "worker", "tapetide-agentic-inbox", s(54)),
					rule("0c49c1eddf2e4aa98da17852490a58f3", "hitesh@tapetide.com", "worker", "tapetide-agentic-inbox", s(12)),
					rule("076cc246bdd14b83ac7d1e2e14d28e3d", "manish@tapetide.com", "forward", "manishsisara99@gmail.com", s(4), {
						addresses: s(4) ? [{ address: "manish@tapetide.com", count: s(4), has_mailbox: issues }] : [],
					}),
					rule("eed35ea60d17400b9bf95137647bf6ed", "ceo@tapetide.com", "worker", "tapetide-agentic-inbox", 0, { enabled: !issues }),
				]
			: [],
		by_address: [
			{ address: "updates@tapetide.com", count: s(1704), has_mailbox: true },
			{ address: "devops@tapetide.com", count: s(92), has_mailbox: true },
			{ address: "jobs@tapetide.com", count: s(69), has_mailbox: false },
			{ address: "support@tapetide.com", count: s(63), has_mailbox: true },
			{ address: "hr@tapetide.com", count: s(61), has_mailbox: true },
			{ address: "govind@tapetide.com", count: s(54), has_mailbox: true },
			{ address: "hello@tapetide.com", count: s(13), has_mailbox: false },
			{ address: "hitesh@tapetide.com", count: s(12), has_mailbox: true },
			{ address: "manish@tapetide.com", count: s(7), has_mailbox: issues },
			{ address: "hit@tapetide.com", count: s(5), has_mailbox: false },
			{ address: "mayur@tapetide.com", count: s(5), has_mailbox: false },
			{ address: "nimisha@tapetide.com", count: s(4), has_mailbox: false },
			{ address: "sudhir@tapetide.com", count: s(3), has_mailbox: false },
			{ address: "tech.team@tapetide.com", count: s(2), has_mailbox: false },
			{ address: "dev1@tapetide.com", count: s(1), has_mailbox: false },
			{ address: "tech@tapetide.com", count: Math.max(1, s(1)), has_mailbox: true },
		].filter((a) => a.count > 0),
		routing_errors: cf
			? [
					{ at: "2026-10-12T20:36:48Z", from: "information@emailrelay.com", to: "hr@tapetide.com", detail: "66.98.68.188 isn't allowed to send email for Information@emailrelay.com", reason: "auth" as const },
					{ at: "2026-10-01T02:57:23Z", from: "uservice@interus.com", to: "hr@tapetide.com", detail: "177.136.244.186 isn't allowed to send email for Uservice@interus.com", reason: "auth" as const },
				].slice(0, refused)
			: [],
		timeseries: dates.map((date, i) => ({ date, received: recv[i], spam: Math.min(recv[i], spam[i]) })),
		spam_source: "local",
		cloudflare_spam: 0,
		...(cf
			? {
					reconciliation: {
						received,
						handled_by_worker: handled,
						worker_errors: refused,
						forwarded: s(110),
						dropped: 0,
						stored,
						stored_gap: stored - handled,
						stored_gap_reasons: ["date_header", "local_routing"] as ("date_header" | "local_routing")[],
						catch_all: { count: catchAll, known_addresses: known, unknown_addresses: catchAll - known },
					},
				}
			: {}),
	};
}

// ── DMARC ─────────────────────────────────────────────────────────────────

export function dmarcFixture(scenario: FixtureScenario = "demo", days: Days = 30): DmarcResponse {
	const window = windowFor(days);
	const prov = provider(days, scenario);
	const dates = dayList(days);
	if (scenario === "empty" || !prov.configured || prov.window_capped) {
		return {
			window, provider: prov,
			totals: { messages: 0, pass: 0, spf_pass: 0, dkim_pass: 0, sources: 0, reporters: 0 },
			sources: [], reporters: [], failures: [],
			timeseries: dates.map((date) => ({ date, messages: 0, pass: 0 })),
		};
	}
	const s = (n: number) => scale(n, days);
	const issues = scenario === "issues";
	const spoof = issues ? s(38) : 0;
	const cfMsgs = s(261);
	const sesMsgs = s(201);
	const messages = cfMsgs + sesMsgs + spoof;
	const pass = cfMsgs + sesMsgs;
	const per = spread(messages, dates.length, 83);
	const failPer = spread(spoof, dates.length, 89);
	return {
		window,
		provider: prov,
		totals: { messages, pass, spf_pass: cfMsgs + Math.round(sesMsgs * 0.98), dkim_pass: pass, sources: issues ? 3 : 2, reporters: 4 },
		sources: [
			{ org: "Cloudflare, Inc.", messages: cfMsgs, pass_rate: 1, spf_pass_rate: 1, dkim_pass_rate: 1, ips: 6 },
			{ org: "Amazon.com, Inc.", messages: sesMsgs, pass_rate: 1, spf_pass_rate: 0.98, dkim_pass_rate: 1, ips: 11 },
			...(issues ? [{ org: "Hetzner Online GmbH", messages: spoof, pass_rate: 0, spf_pass_rate: 0, dkim_pass_rate: 0, ips: 2 }] : []),
		],
		reporters: [
			{ org: "google.com", messages: Math.round(messages * 0.71) },
			{ org: "Outlook.com", messages: Math.round(messages * 0.17) },
			{ org: "Yahoo", messages: Math.round(messages * 0.08) },
			{ org: "Mail.Ru", messages: messages - Math.round(messages * 0.71) - Math.round(messages * 0.17) - Math.round(messages * 0.08) },
		],
		failures: issues
			? [
					{ source_ip: "88.198.17.44", ptr: "static.44.17.198.88.clients.your-server.de", org: "Hetzner Online GmbH", header_from: "tapetide.com", messages: Math.ceil(spoof * 0.7), disposition: "reject", reason: null },
					{ source_ip: "88.198.17.45", ptr: null, org: "Hetzner Online GmbH", header_from: "tapetide.com", messages: Math.floor(spoof * 0.3), disposition: "reject", reason: "local_policy" },
				]
			: [],
		timeseries: dates.map((date, i) => ({ date, messages: per[i], pass: Math.max(0, per[i] - failPer[i]) })),
	};
}
