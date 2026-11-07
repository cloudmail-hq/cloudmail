/**
 * Response contract for the analytics console (`/api/v1/analytics/{overview,
 * engagement,inbound,dmarc}`). Shared by the Worker routes and the React page.
 *
 * Conventions:
 * - Rates are fractions in [0, 1], or `null` when the denominator is 0.
 * - Dates in `timeseries` are `YYYY-MM-DD` (UTC); `start`/`end` are ISO 8601.
 * - Cloudflare data covers at most 31 days. For `days=90` only local data is
 *   returned and `provider.window_capped` is true.
 */

export const ANALYTICS_DAYS = [1, 7, 30, 90] as const;
export type Days = (typeof ANALYTICS_DAYS)[number];

export type AnalyticsScope = "app" | "zone";

export interface AnalyticsWindow {
	days: Days;
	start: string;
	end: string;
}

export interface ProviderStatus {
	/** False when no Cloudflare token is configured; UI shows a setup hint. */
	configured: boolean;
	/** True when the requested window exceeds Cloudflare's 31-day retention. */
	window_capped: boolean;
	/** ISO time the Cloudflare data was fetched (may be up to 5 min old). */
	cached_at?: string;
	/** Set when a Cloudflare call failed; local data is still returned. */
	error?: string;
	/** True when any Cloudflare row had sampleInterval > 1 (counts are estimates). */
	sampled?: boolean;
}

export interface SendingRates {
	delivery: number | null;
	bounce: number | null;
	complaint: number | null;
}

export interface SendingSummary {
	sent: number;
	delivered: number;
	bounced: number;
	failed: number;
	rejected: number;
	complaints: number;
	pending: number;
	deferred: number | null;
	rates: SendingRates;
	/** "messages" for app scope (local ledger), "recipients" for zone (CF rows). */
	unit: "messages" | "recipients";
}

export type ReputationMetricKey = "bounce" | "complaint" | "spam_rejection";

export interface ReputationMetric {
	key: ReputationMetricKey;
	value: number | null;
	warning_at: number;
	at_risk_at: number;
	denominator: number;
	minimum_denominator: number;
}

export interface Reputation {
	status: string;
	since: string | null;
	metrics: ReputationMetric[];
}

export interface Quota {
	used: number;
	limit: number;
	resets_at: string | null;
}

export interface OverviewTimeseriesPoint {
	date: string;
	sent: number;
	delivered: number;
	bounced: number;
	failed: number;
	opened: number;
	clicked: number;
	received: number;
}

export interface DomainRow {
	domain: string;
	enabled: boolean;
	dns_status: string | null;
	sent: number;
	delivered: number;
	bounced: number;
	complaints: number | null;
	top_senders: { from: string; count: number }[];
}

export interface SenderRow {
	from: string;
	/** True when the address is one of this app's mailboxes or aliases. */
	app: boolean;
	sent: number;
	delivered: number;
}

export interface ErrorRow {
	cause: string;
	attribution: string | null;
	bucket: string | null;
	count: number;
	example: string | null;
	last_seen: string | null;
}

export interface MailboxRow {
	mailbox: string;
	sent: number;
	delivered: number;
	bounced: number;
	failed: number;
	opened: number;
	clicked: number;
	open_rate: number | null;
	click_rate: number | null;
}

export interface SuppressionCounts {
	total: number;
	by_reason: Record<string, number>;
}

/**
 * What a block of numbers covers. `app` = this app's mailboxes only, `zone` =
 * every sender on the Cloudflare zone(s), `account` = the whole Cloudflare
 * account (reputation, quota, provider suppressions).
 */
export type DataScope = "app" | "zone" | "account";

/** The unit a block counts in. Cloudflare sending rows are per envelope recipient. */
export type DataUnit = "messages" | "recipients" | "addresses";

export interface SectionScope {
	scope: DataScope;
	unit: DataUnit;
}

/**
 * Scope and unit of every overview block (additive). In app scope only
 * `reputation`, `quota` and `suppressions_provider` are wider than the app;
 * they say so here so the UI can label them instead of mixing them in.
 */
export interface OverviewSections {
	sending: SectionScope;
	timeseries: SectionScope;
	reputation: SectionScope;
	quota: SectionScope;
	domains: SectionScope;
	senders: SectionScope;
	errors: SectionScope;
	mailboxes: SectionScope;
	suppressions_provider: SectionScope;
	suppressions_local: SectionScope;
}

/**
 * Suppression lists are current state, not events: `total`/`by_reason` are
 * every address on the list now (`window: "all_time"`), and `in_window` counts
 * only entries created inside the selected window.
 */
export interface SuppressionsBlock {
	provider: SuppressionCounts | null;
	local: SuppressionCounts;
	/** Window of `provider`/`local` (additive). Always "all_time". */
	window?: "all_time";
	/** Entries created inside the selected window (additive). */
	in_window?: {
		provider: SuppressionCounts | null;
		local: SuppressionCounts | null;
	};
}

export interface Overview {
	window: AnalyticsWindow;
	scope: AnalyticsScope;
	provider: ProviderStatus;
	sending: SendingSummary;
	reputation: Reputation | null;
	quota: Quota | null;
	timeseries: OverviewTimeseriesPoint[];
	domains: DomainRow[];
	/** Zone scope: app mailboxes plus other senders (noreply@ etc.). */
	senders: SenderRow[];
	errors: ErrorRow[];
	mailboxes: MailboxRow[];
	suppressions: SuppressionsBlock;
	/** Scope/unit of each block (additive). */
	sections?: OverviewSections;
}

export interface EngagementTotals {
	opens: number;
	unique_opens: number;
	clicks: number;
	unique_clicks: number;
	open_rate: number | null;
	click_rate: number | null;
	/** Click-to-open rate: unique clicks / unique opens. */
	ctor: number | null;
	/** Messages sent in the window (the cohort). Additive. */
	sent_messages?: number;
	/**
	 * The open/click-rate denominator (additive): cohort messages that were
	 * delivered (a delivered verdict, or an open/click, which proves delivery,
	 * with no later failure). Equals `sent_messages` when `rate_base` is "sent".
	 */
	delivered_messages?: number;
	/**
	 * Cohort messages still waiting for a delivery verdict (additive). Same
	 * per-message rule as the app-scope overview (`messageOutcome`); the
	 * overview's `sending.pending` also adds scheduled sends, which are not in
	 * this cohort. With `rate_base: "delivered"`,
	 * `delivered_messages + pending_messages` + failures = `sent_messages`.
	 */
	pending_messages?: number;
	/** Distinct messages opened: the open-rate numerator. Additive. */
	opened_messages?: number;
	/** Distinct messages clicked: the click-rate numerator. Additive. */
	clicked_messages?: number;
	/** "sent" when nothing is confirmed delivered yet, so rates fall back to sent. Additive. */
	rate_base?: "delivered" | "sent";
}

export interface EngagementMessage {
	email_id: string;
	mailbox: string;
	subject: string;
	sent_at: string;
	recipients: number;
	opens: number;
	unique_opens: number;
	clicks: number;
	first_open_at: string | null;
	/** Delivery outcome, by the overview's rule (additive). */
	outcome?: "delivered" | "pending" | "bounced" | "rejected" | "failed";
}

export interface EngagementLink {
	url: string;
	clicks: number;
	unique_clicks: number;
	messages: number;
}

export interface Engagement {
	totals: EngagementTotals;
	/** Top 50 by sent date, newest first. */
	messages: EngagementMessage[];
	/** Top 50 by clicks. */
	links: EngagementLink[];
	note: string;
}

export interface InboundAction {
	/**
	 * Human label, e.g. worker+dropped => "Handled by worker". A worker+error
	 * row whose detail is an SPF/DMARC refusal is split out as
	 * "Rejected (failed SPF/DMARC)" with `reason: "auth"`.
	 */
	label: string;
	action: string;
	status: string;
	count: number;
	/** "auth" when the row is a sender-authentication refusal (additive). */
	reason?: "auth";
}

export interface InboundRule {
	id: string;
	name: string | null;
	matcher: string;
	action: string;
	destination: string | null;
	enabled: boolean;
	count: number;
	errors: number;
	/** True for the zone's catch-all rule (additive). */
	catch_all?: boolean;
	/**
	 * `count` by recipient address (additive), from the same rows as
	 * `by_address`; sums to `count` (up to Cloudflare's 10k raw-row cap).
	 */
	addresses?: { address: string; count: number; has_mailbox: boolean }[];
}

export interface InboundAddress {
	address: string;
	/** Every incoming row for this address, whichever rule matched. */
	count: number;
	/** The app has a mailbox or alias for this address. */
	has_mailbox: boolean;
	/**
	 * Per-rule split of `count` (additive): an address with its own rule can
	 * still reach the catch-all (e.g. manish@ = 4 own rule + 3 catch-all).
	 */
	via?: { rule_id: string; matcher: string; action: string; count: number }[];
	/** Of `count`, handed to this app's Worker (additive). */
	to_app?: number;
}

/**
 * How the inbound numbers relate (additive). All from one window and the
 * `eventType: "incoming"` filter.
 */
export interface InboundReconciliationBlock {
	received: number;
	handled_by_worker: number;
	worker_errors: number;
	forwarded: number;
	dropped: number;
	stored: number;
	/** `stored - handled_by_worker`. */
	stored_gap: number;
	/**
	 * Why `stored` and `handled_by_worker` legitimately differ:
	 * `date_header` (stored mail is dated by its Date header, Cloudflare by
	 * event time), `local_routing` (aliases/catch-all assignments file mail into
	 * another mailbox; duplicates and unknown addresses are skipped),
	 * `scan_cap` (the local scan hit its cap).
	 */
	stored_gap_reasons: ("date_header" | "local_routing" | "scan_cap")[];
	/**
	 * The catch-all's rows split by whether the app knows the address. The
	 * catch-all count minus `known_addresses` is the "no mailbox" sum.
	 */
	catch_all: { count: number; known_addresses: number; unknown_addresses: number } | null;
}

/** One routing error event. */
export interface InboundRoutingError {
	at: string;
	from: string;
	to: string;
	detail: string;
	/**
	 * "auth" when Cloudflare refused the message on sender authentication
	 * (a spoof blocked as intended, not a fault). Additive.
	 */
	reason?: "auth";
}

/**
 * True when a routing error's detail is Cloudflare refusing the message on
 * sender authentication, e.g. `66.98.68.188 isn't allowed to send email for
 * x@y.com`. Shared by the Worker (labels) and the UI (fallback when `reason`
 * is absent).
 */
export function isAuthRefusalDetail(detail: string | null | undefined): boolean {
	const d = (detail ?? "").toLowerCase();
	return /(is ?n[o']t|not) allowed to send|\bspf\b|\bdmarc\b|\bdkim\b|authentication|sender policy/.test(d);
}

export interface Inbound {
	received: number;
	stored: number;
	spam_filed: number;
	/**
	 * SPF/DKIM/DMARC verdict histograms. Each sums to `auth_total`, and always
	 * carries `pass`, `fail` and `none` (0 when unseen); other RFC 8601 verdicts
	 * (softfail, temperror, permerror, neutral) keep their own keys.
	 */
	auth: {
		spf: Record<string, number>;
		dkim: Record<string, number>;
		dmarc: Record<string, number>;
	};
	actions: InboundAction[];
	rules: InboundRule[];
	by_address: InboundAddress[];
	routing_errors: InboundRoutingError[];
	/** `spam` uses the same source as `spam_filed` (see `spam_source`). */
	timeseries: { date: string; received: number; spam: number }[];
	/** What every histogram in `auth` sums to: `received` (Cloudflare) or `stored` (local). Additive. */
	auth_total?: number;
	/** Where `auth` comes from (additive). */
	auth_source?: "cloudflare" | "local";
	/**
	 * Where `spam_filed` and `timeseries[].spam` come from (additive): "local"
	 * = messages this app filed to Spam, dated by the message.
	 */
	spam_source?: "local";
	/** Cloudflare's own inbound spam flag (`isSpam`), for comparison. Additive. */
	cloudflare_spam?: number;
	/** How the numbers reconcile (additive; Cloudflare data only). */
	reconciliation?: InboundReconciliationBlock;
}

export interface DmarcSource {
	org: string;
	messages: number;
	pass_rate: number;
	spf_pass_rate: number;
	dkim_pass_rate: number;
	ips: number;
}

export interface DmarcFailure {
	source_ip: string;
	ptr: string | null;
	org: string | null;
	header_from: string;
	messages: number;
	disposition: string | null;
	reason: string | null;
}

export interface Dmarc {
	totals: {
		messages: number;
		pass: number;
		spf_pass: number;
		dkim_pass: number;
		sources: number;
		reporters: number;
	};
	sources: DmarcSource[];
	reporters: { org: string; messages: number }[];
	failures: DmarcFailure[];
	timeseries: { date: string; messages: number; pass: number }[];
}

/**
 * Engagement, Inbound and Dmarc responses also carry the window and provider
 * envelope so each section can render its own cache/setup state.
 */
export interface SectionEnvelope {
	window: AnalyticsWindow;
	provider: ProviderStatus;
}

export type EngagementResponse = Engagement & SectionEnvelope;
export type InboundResponse = Inbound & SectionEnvelope;
export type DmarcResponse = Dmarc & SectionEnvelope;
export type OverviewResponse = Overview;

export const ENGAGEMENT_NOTE =
	"Opens are pixel loads; image proxies (Apple Mail Privacy Protection, Gmail) inflate them.";

/** Fraction n/d, or null when d is 0 (or not finite). */
export function rate(n: number, d: number): number | null {
	if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(n)) return null;
	return n / d;
}

export function parseDays(raw: string | null | undefined): Days {
	const n = Number(raw);
	return (ANALYTICS_DAYS as readonly number[]).includes(n) ? (n as Days) : 7;
}
