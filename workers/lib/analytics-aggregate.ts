// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Pure transforms from Cloudflare analytics rows (and local per-mailbox
 * stats) to the `shared/analytics-types.ts` contract. No I/O, so every rule
 * here is unit-tested against recorded fixtures.
 *
 * Units: zone-scope sending counts are Cloudflare rows (one per envelope
 * recipient, the unit reputation is evaluated in), labelled "recipients".
 * App-scope counts come from the local ledger in messages.
 */

import {
	rate,
	type DmarcFailure,
	type DmarcSource,
	type DomainRow,
	type ErrorRow,
	type InboundAction,
	type InboundRule,
	type Reputation,
	type ReputationMetric,
	type SenderRow,
} from "../../shared/analytics-types";
import { classifyErrorCause } from "./email-analytics";
import { isAuthRefusalDetail } from "../../shared/analytics-types";
import type {
	CfReputation,
	CfRule,
	CfSuppression,
	ComplaintGroup,
	DmarcGroup,
	RoutingErrorRow,
	RoutingGroup,
	RoutingRecipientRow,
	SendingGroup,
	SendingRawRow,
} from "./cf-analytics";

// -- helpers -----------------------------------------------------------------

/** Bare lowercased address from `"Name" <addr>` or a plain address. */
export function bareAddress(value: string | null | undefined): string | null {
	if (!value) return null;
	const angled = value.match(/<([^>]*)>/);
	const bare = (angled ? angled[1] : value).trim().toLowerCase();
	return bare === "" ? null : bare;
}

/** A row's weight: `count × sampleInterval` (raw rows weigh `sampleInterval`). */
export function weight(count: number, sampleInterval: number | undefined): number {
	const interval = Number.isFinite(sampleInterval) && (sampleInterval as number) > 0 ? (sampleInterval as number) : 1;
	return count * interval;
}

/** True when any row was sampled (`sampleInterval > 1`), so counts are estimates. */
export function anySampled(rows: readonly { sampleInterval?: number; dimensions?: { sampleInterval?: number } }[]): boolean {
	return rows.some((row) => (row.sampleInterval ?? row.dimensions?.sampleInterval ?? 1) > 1);
}

/** Zero-filled series: one point per date, values merged by `date`. */
export function fillSeries<T extends { date: string }>(dates: string[], points: Iterable<T>, empty: (date: string) => T): T[] {
	const byDate = new Map<string, T>();
	for (const point of points) byDate.set(point.date, point);
	return dates.map((date) => byDate.get(date) ?? empty(date));
}

// -- sending status buckets --------------------------------------------------

export type SendingBucket = "delivered" | "bounced" | "failed" | "rejected" | "deferred" | "other";

/**
 * Collapse a Cloudflare sending `status` to a contract bucket. Only
 * `delivered` and `deliveryFailed` are confirmed live; the rest are the
 * activity-log / Queues vocabulary, mapped defensively. Unknown values are
 * `other`: still counted in `sent`, never silently dropped.
 */
export function sendingBucket(status: string): SendingBucket {
	switch (status) {
		case "delivered":
			return "delivered";
		case "deliveryFailed":
		case "bounced":
			return "bounced";
		case "failed":
			return "failed";
		case "rejected":
			return "rejected";
		case "deferred":
			return "deferred";
		default:
			return "other";
	}
}

export interface SendingTotals {
	sent: number;
	delivered: number;
	bounced: number;
	failed: number;
	rejected: number;
	deferred: number;
}

export function emptyTotals(): SendingTotals {
	return { sent: 0, delivered: 0, bounced: 0, failed: 0, rejected: 0, deferred: 0 };
}

function addTo(totals: SendingTotals, bucket: SendingBucket, n: number): void {
	totals.sent += n;
	if (bucket !== "other") totals[bucket] += n;
}

/** Totals over sending groups, weighted by `sampleInterval`. */
export function sumSendingGroups(groups: readonly SendingGroup[]): SendingTotals {
	const totals = emptyTotals();
	for (const group of groups) addTo(totals, sendingBucket(group.dimensions.status), weight(group.count, group.dimensions.sampleInterval));
	return totals;
}

/** Per-day sending series from the date-dimensioned groups. */
export function sendingByDate(groups: readonly SendingGroup[]): Map<string, SendingTotals> {
	const out = new Map<string, SendingTotals>();
	for (const group of groups) {
		const date = group.dimensions.date;
		if (!date) continue;
		const totals = out.get(date) ?? emptyTotals();
		addTo(totals, sendingBucket(group.dimensions.status), weight(group.count, group.dimensions.sampleInterval));
		out.set(date, totals);
	}
	return out;
}

/** Per-sending-domain totals. */
export function sendingByDomain(groups: readonly SendingGroup[]): Map<string, SendingTotals> {
	const out = new Map<string, SendingTotals>();
	for (const group of groups) {
		const domain = group.dimensions.sendingDomain || "(unknown)";
		const totals = out.get(domain) ?? emptyTotals();
		addTo(totals, sendingBucket(group.dimensions.status), weight(group.count, group.dimensions.sampleInterval));
		out.set(domain, totals);
	}
	return out;
}

export function sumComplaints(groups: readonly ComplaintGroup[]): number {
	return groups.reduce((n, group) => n + group.count, 0);
}

// -- app / zone split --------------------------------------------------------

/**
 * Split raw sending rows into this app's senders (mailboxes + aliases) and
 * everyone else on the zone, by bare From address. `sendingDomain` cannot
 * separate them: the app and noreply@ share the apex.
 */
export function splitSenders(
	rows: readonly SendingRawRow[],
	appAddresses: ReadonlySet<string>,
): { senders: SenderRow[]; app: SendingRawRow[]; other: SendingRawRow[] } {
	const bySender = new Map<string, SenderRow>();
	const app: SendingRawRow[] = [];
	const other: SendingRawRow[] = [];
	for (const row of rows) {
		const from = bareAddress(row.from) ?? "(unknown)";
		const isApp = appAddresses.has(from);
		(isApp ? app : other).push(row);
		const entry = bySender.get(from) ?? { from, app: isApp, sent: 0, delivered: 0 };
		const n = weight(1, row.sampleInterval);
		entry.sent += n;
		if (sendingBucket(row.status) === "delivered") entry.delivered += n;
		bySender.set(from, entry);
	}
	const senders = [...bySender.values()].sort((a, b) => b.sent - a.sent || a.from.localeCompare(b.from));
	return { senders, app, other };
}

/** Raw rows folded into groups-shaped rows, so a filtered row set can feed the group helpers. */
export function groupsFromRaw(rows: readonly SendingRawRow[]): SendingGroup[] {
	return rows.map((row) => ({
		count: 1,
		dimensions: {
			date: row.datetime?.slice(0, 10),
			status: row.status,
			sendingDomain: row.sendingDomain,
			errorCause: row.errorCause,
			errorAttribution: row.errorAttribution,
			isSpam: 0,
			sampleInterval: row.sampleInterval,
		},
	}));
}

/** Top senders per sending domain, from raw rows. */
export function topSendersByDomain(rows: readonly SendingRawRow[], limit = 5): Map<string, { from: string; count: number }[]> {
	const counts = new Map<string, Map<string, number>>();
	for (const row of rows) {
		const domain = row.sendingDomain || "(unknown)";
		const from = bareAddress(row.from) ?? "(unknown)";
		const perDomain = counts.get(domain) ?? new Map<string, number>();
		perDomain.set(from, (perDomain.get(from) ?? 0) + weight(1, row.sampleInterval));
		counts.set(domain, perDomain);
	}
	const out = new Map<string, { from: string; count: number }[]>();
	for (const [domain, perDomain] of counts) {
		out.set(
			domain,
			[...perDomain.entries()]
				.map(([from, count]) => ({ from, count }))
				.sort((a, b) => b.count - a.count || a.from.localeCompare(b.from))
				.slice(0, limit),
		);
	}
	return out;
}

export function domainRows(input: {
	groups: readonly SendingGroup[];
	raw: readonly SendingRawRow[];
	complaints: readonly ComplaintGroup[];
	subdomains: readonly { name: string; enabled?: boolean; dnsStatus: string | null }[] | null;
	/** Restrict to one sending domain, or to a set (a product's domains). */
	only?: string | readonly string[] | null;
}): DomainRow[] {
	const byDomain = sendingByDomain(input.groups);
	const top = topSendersByDomain(input.raw);
	const complaints = new Map<string, number>();
	for (const group of input.complaints) {
		const d = group.dimensions.sendingDomain;
		complaints.set(d, (complaints.get(d) ?? 0) + group.count);
	}
	const known = new Map((input.subdomains ?? []).map((s) => [s.name, s]));
	const names = new Set([...known.keys(), ...byDomain.keys()]);
	const rows: DomainRow[] = [];
	for (const domain of names) {
		if (input.only != null) {
			const only = typeof input.only === "string" ? [input.only] : input.only;
			if (!only.includes(domain)) continue;
		}
		const totals = byDomain.get(domain) ?? emptyTotals();
		const sub = known.get(domain);
		rows.push({
			domain,
			enabled: sub ? sub.enabled !== false : false,
			dns_status: sub?.dnsStatus ?? null,
			sent: totals.sent,
			delivered: totals.delivered,
			bounced: totals.bounced,
			// No complaints dataset row means zero, but only if subdomains were readable.
			complaints: complaints.get(domain) ?? (input.subdomains ? 0 : null),
			top_senders: top.get(domain) ?? [],
		});
	}
	return rows.sort((a, b) => b.sent - a.sent || a.domain.localeCompare(b.domain));
}

// -- errors ------------------------------------------------------------------

export function errorRowsFromRaw(rows: readonly SendingRawRow[], limit = 20): ErrorRow[] {
	const byKey = new Map<string, ErrorRow>();
	for (const row of rows) {
		if (row.status === "delivered") continue;
		const cause = row.errorCause || row.status || "(unknown)";
		const attribution = row.errorAttribution || null;
		const key = `${cause}|${attribution ?? ""}`;
		const entry =
			byKey.get(key) ??
			({
				cause,
				attribution,
				bucket: classifyErrorCause(row.status, row.errorCause ?? ""),
				count: 0,
				example: null,
				last_seen: null,
			} satisfies ErrorRow);
		entry.count += weight(1, row.sampleInterval);
		if (!entry.last_seen || row.datetime > entry.last_seen) {
			entry.last_seen = row.datetime;
			if (row.errorDetail) entry.example = row.errorDetail;
		} else if (!entry.example && row.errorDetail) {
			entry.example = row.errorDetail;
		}
		byKey.set(key, entry);
	}
	return [...byKey.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

// -- reputation --------------------------------------------------------------

const SPAM_CAUSE = /spam|content|reputation/i;

/**
 * Reputation gauges mirroring Cloudflare's evaluation: rolling 7 days, per
 * sending domain, account = worst domain. Rates use rows (recipients).
 *
 * - bounce = recipient-attributed `deliveryFailed` / all rows
 * - spam rejection = spam-caused failures, or `isSpam=1`, / all rows
 * - complaint = complaints / delivered
 *
 * The worst domain is picked among domains that meet the minimum denominator.
 * When none do, the domain with the most volume is shown: its denominator is
 * below the minimum, so the gauge greys out. Pooling the domains instead could
 * cross the minimum and present a rate Cloudflare does not evaluate.
 */
export function reputationFrom(
	rep: CfReputation | null,
	groups: readonly SendingGroup[],
	complaints: readonly ComplaintGroup[],
): Reputation | null {
	if (!rep) return null;
	const policy = rep.active_policy ?? {};
	interface Agg {
		rows: number;
		delivered: number;
		bounced: number;
		spam: number;
		complaints: number;
	}
	const perDomain = new Map<string, Agg>();
	const all: Agg = { rows: 0, delivered: 0, bounced: 0, spam: 0, complaints: 0 };
	const slot = (d: string) => {
		let agg = perDomain.get(d);
		if (!agg) {
			agg = { rows: 0, delivered: 0, bounced: 0, spam: 0, complaints: 0 };
			perDomain.set(d, agg);
		}
		return agg;
	};
	for (const group of groups) {
		const dim = group.dimensions;
		const n = weight(group.count, dim.sampleInterval);
		const bucket = sendingBucket(dim.status);
		const isSpam = dim.isSpam === 1 || (bucket !== "delivered" && SPAM_CAUSE.test(dim.errorCause ?? ""));
		const recipientBounce =
			bucket === "bounced" &&
			!isSpam &&
			(dim.errorAttribution ? /recipient/i.test(dim.errorAttribution) : classifyErrorCause(dim.status, dim.errorCause ?? "") === "recipient");
		for (const agg of [all, slot(dim.sendingDomain || "(unknown)")]) {
			agg.rows += n;
			if (bucket === "delivered") agg.delivered += n;
			if (recipientBounce) agg.bounced += n;
			if (isSpam) agg.spam += n;
		}
	}
	for (const group of complaints) {
		all.complaints += group.count;
		slot(group.dimensions.sendingDomain || "(unknown)").complaints += group.count;
	}

	const metric = (
		key: ReputationMetric["key"],
		p: { warning_at: number; at_risk_at: number; minimum_denominator: number } | undefined,
		num: (a: Agg) => number,
		den: (a: Agg) => number,
	): ReputationMetric | null => {
		if (!p) return null;
		let chosen: Agg | null = null;
		let worst = -1;
		for (const agg of perDomain.values()) {
			if (den(agg) < p.minimum_denominator) continue;
			const value = rate(num(agg), den(agg)) ?? 0;
			if (value > worst) {
				worst = value;
				chosen = agg;
			}
		}
		if (!chosen) {
			// None eligible: the largest domain, still under the minimum.
			for (const agg of perDomain.values()) if (!chosen || den(agg) > den(chosen)) chosen = agg;
		}
		chosen ??= all; // no sends at all: zero denominator, null rate
		return {
			key,
			value: rate(num(chosen), den(chosen)),
			warning_at: p.warning_at,
			at_risk_at: p.at_risk_at,
			denominator: den(chosen),
			minimum_denominator: p.minimum_denominator,
		};
	};

	const metrics = [
		metric("bounce", policy.customer_bounce, (a) => a.bounced, (a) => a.rows),
		metric("complaint", policy.complaint, (a) => a.complaints, (a) => a.delivered),
		metric("spam_rejection", policy.spam_rejection, (a) => a.spam, (a) => a.rows),
	].filter((m): m is ReputationMetric => m !== null);

	return { status: rep.status, since: rep.status_since ?? null, metrics };
}

// -- suppressions ------------------------------------------------------------

export function countByReason(items: readonly { reason: string }[]): { total: number; by_reason: Record<string, number> } {
	const by_reason: Record<string, number> = {};
	for (const item of items) by_reason[item.reason] = (by_reason[item.reason] ?? 0) + 1;
	return { total: items.length, by_reason };
}

export function providerSuppressionCounts(items: readonly CfSuppression[] | null) {
	return items ? countByReason(items) : null;
}

/**
 * Provider suppressions created inside [start, end). Cloudflare's 5 live
 * entries are all older than the window, which is why "hard bounce 5" sits
 * beside a 0% bounce rate: the list is all-time state, the rate is not.
 */
export function providerSuppressionsInWindow(items: readonly CfSuppression[] | null, start: string, end: string) {
	if (!items) return null;
	const s = Date.parse(start);
	const e = Date.parse(end);
	return countByReason(
		items.filter((item) => {
			const t = parseProviderTime(item.created_at);
			return t !== null && t >= s && t < e;
		}),
	);
}

/**
 * Cloudflare suppression timestamps come as `2026-09-24 09:28:19.873` (UTC,
 * no zone designator) or ISO 8601. `Date.parse` of the first form is
 * implementation-defined, so it is rewritten to ISO with an explicit `Z`.
 */
export function parseProviderTime(value: string | null | undefined): number | null {
	if (!value) return null;
	const v = value.trim();
	const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v) ? `${v.replace(" ", "T")}${/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? "" : "Z"}` : v;
	const t = Date.parse(iso);
	return Number.isFinite(t) ? t : null;
}

// -- inbound -----------------------------------------------------------------

/**
 * Human label for a routing (action, status) pair.
 *
 * Cloudflare reports every successful Worker action as `status: "dropped"`
 * (documented: Worker-processed mail shows as dropped). Only `action: "drop"`
 * is a real drop. Unknown pairs keep their raw values.
 */
export function routingLabel(action: string, status: string): string {
	const a = action.toLowerCase();
	const s = status.toLowerCase();
	if (a === "worker") {
		if (s === "dropped" || s === "delivered" || s === "handled") return "Handled by worker";
		if (s === "error") return "Worker error";
		if (s === "rejected") return "Rejected (auth failure)";
	}
	if (a === "forward") {
		if (s === "delivered" || s === "forwarded") return "Forwarded";
		if (s === "rejected") return "Rejected (auth failure)";
		return "Forward failed";
	}
	if (a === "drop") return "Dropped by rule";
	if (s === "rejected") return "Rejected (auth failure)";
	if (s === "error") return "Error";
	return `${action || "unknown"} / ${status || "unknown"}`;
}

/**
 * Routing actions by (action, status), relabelled.
 *
 * `errorRows` are the raw error events (with `errorDetail`). An error whose
 * detail is an SPF/DMARC refusal is split out of its (action, status) pair into
 * its own "Rejected (failed SPF/DMARC)" row with `reason: "auth"`, because the
 * message never reached the Worker; calling it "Worker error" blames our code.
 * The split never changes the total: the auth row's count is taken out of the
 * pair it came from, capped at that pair's count.
 */
export function routingActions(groups: readonly RoutingGroup[], errorRows: readonly RoutingErrorRow[] = []): InboundAction[] {
	const byPair = new Map<string, InboundAction>();
	for (const group of groups) {
		const action = group.dimensions.action ?? "";
		const status = group.dimensions.status ?? "";
		const key = `${action}|${status}`;
		const entry = byPair.get(key) ?? { label: routingLabel(action, status), action, status, count: 0 };
		entry.count += weight(group.count, group.dimensions.sampleInterval);
		byPair.set(key, entry);
	}
	const refusals = new Map<string, number>();
	for (const row of errorRows) {
		if (!isAuthRefusal(row.errorDetail)) continue;
		const key = `${row.action ?? ""}|${row.status ?? ""}`;
		refusals.set(key, (refusals.get(key) ?? 0) + weight(1, row.sampleInterval));
	}
	const out: InboundAction[] = [];
	for (const [key, entry] of byPair) {
		const refused = Math.min(refusals.get(key) ?? 0, entry.count);
		if (refused > 0) {
			out.push({ label: AUTH_REFUSAL_LABEL, action: entry.action, status: entry.status, count: refused, reason: "auth" });
			if (entry.count - refused > 0) out.push({ ...entry, count: entry.count - refused });
		} else {
			out.push(entry);
		}
	}
	return out.sort((a, b) => b.count - a.count);
}

/**
 * A verdict token as the contract reports it: lowercased, and `none` for an
 * empty or absent value (nothing was evaluated) or the parser's `unknown`.
 */
export function normalizeVerdict(raw: string | null | undefined): string {
	const v = (raw ?? "").trim().toLowerCase();
	return v === "" || v === "unknown" ? "none" : v;
}

export type AuthHistograms = { spf: Record<string, number>; dkim: Record<string, number>; dmarc: Record<string, number> };

/**
 * SPF/DKIM/DMARC histograms. Every message lands in exactly one verdict per
 * check, so each histogram sums to the received count; `pass`, `fail` and
 * `none` are always present (0 when unseen) so the UI never infers a missing
 * key. Rarer verdicts (softfail, temperror, permerror, neutral) keep their own
 * keys rather than being folded into `fail`.
 */
export function authCounts(groups: readonly RoutingGroup[]): AuthHistograms {
	const out: AuthHistograms = { spf: baseAuth(), dkim: baseAuth(), dmarc: baseAuth() };
	for (const group of groups) {
		const n = weight(group.count, group.dimensions.sampleInterval);
		for (const key of ["spf", "dkim", "dmarc"] as const) {
			const verdict = normalizeVerdict(group.dimensions[key]);
			out[key][verdict] = (out[key][verdict] ?? 0) + n;
		}
	}
	return out;
}

function baseAuth(): Record<string, number> {
	return { pass: 0, fail: 0, none: 0 };
}

/** Normalize a histogram (e.g. merged local ones) to the same rules as `authCounts`. */
export function normalizeAuthHistograms(input: AuthHistograms): AuthHistograms {
	const out: AuthHistograms = { spf: baseAuth(), dkim: baseAuth(), dmarc: baseAuth() };
	for (const key of ["spf", "dkim", "dmarc"] as const) {
		for (const [verdict, n] of Object.entries(input[key] ?? {})) {
			const v = normalizeVerdict(verdict);
			out[key][v] = (out[key][v] ?? 0) + n;
		}
	}
	return out;
}

/** Sum of one histogram. */
export function histogramTotal(h: Record<string, number>): number {
	return Object.values(h).reduce((n, v) => n + v, 0);
}

/**
 * True when a routing error's detail is Cloudflare refusing the message on
 * sender authentication (SPF/DKIM/DMARC), e.g. `66.98.68.188 isn't allowed to
 * send email for x@y.com`. These arrive as `action: worker, status: error`, but
 * the Worker never ran: the mail was refused before hand-off.
 */
export const isAuthRefusal = isAuthRefusalDetail;

export const AUTH_REFUSAL_LABEL = "Rejected (failed SPF/DMARC)";

/** GraphQL `ruleMatched` is a dashed UUID; REST ids are 32-hex without dashes. */
export function normalizeRuleId(id: string | null | undefined): string {
	return (id ?? "").replace(/-/g, "").toLowerCase();
}

/**
 * The address a rule matches. The catch-all (`type: "all"`) is rendered as
 * `*@<zone>` so the UI can tell which unmatched addresses it swallows; without
 * a known zone name it reads `*`.
 */
function describeMatcher(rule: CfRule & { zoneName?: string | null }): string {
	const matcher = rule.matchers?.[0];
	if (!matcher) return "(none)";
	if (matcher.type === "all") return rule.zoneName ? `*@${rule.zoneName}` : "*";
	return matcher.value ?? matcher.type;
}

function isCatchAllRule(rule: CfRule): boolean {
	return rule.matchers?.some((m) => m.type === "all") ?? false;
}

/**
 * Rules joined to routing counts. `addresses` (additive) breaks a rule's count
 * down by recipient from the same incoming rows as `by_address`, so the
 * catch-all's total equals the sum of its addresses: it swallows mail for
 * addresses that have no rule, including ones the app knows (an alias, a
 * mailbox without a literal rule), which is why the catch-all row and the
 * "no mailbox" addresses legitimately differ.
 */
export function ruleRows(
	rules: readonly (CfRule & { zoneName?: string | null })[],
	groups: readonly RoutingGroup[],
	recipients: readonly RoutingRecipientRow[] = [],
	hasMailbox: (address: string) => boolean = () => false,
): InboundRule[] {
	const counts = new Map<string, { count: number; errors: number }>();
	for (const group of groups) {
		const id = normalizeRuleId(group.dimensions.ruleMatched);
		const entry = counts.get(id) ?? { count: 0, errors: 0 };
		const n = weight(group.count, group.dimensions.sampleInterval);
		entry.count += n;
		const status = (group.dimensions.status ?? "").toLowerCase();
		if (status === "error" || status === "rejected" || status === "deliveryfailed") entry.errors += n;
		counts.set(id, entry);
	}
	const perRule = new Map<string, Map<string, number>>();
	for (const row of recipients) {
		const address = bareAddress(row.to);
		if (!address) continue;
		const id = normalizeRuleId(row.ruleMatched);
		const m = perRule.get(id) ?? new Map<string, number>();
		m.set(address, (m.get(address) ?? 0) + weight(1, row.sampleInterval));
		perRule.set(id, m);
	}
	return rules
		.map((rule) => {
			const id = normalizeRuleId(rule.id ?? rule.tag);
			const action = rule.actions?.[0];
			const c = counts.get(id) ?? { count: 0, errors: 0 };
			const addrs = [...(perRule.get(id) ?? new Map<string, number>()).entries()]
				.map(([address, count]) => ({ address, count, has_mailbox: hasMailbox(address) }))
				.sort((a, b) => b.count - a.count || a.address.localeCompare(b.address));
			return {
				id,
				name: rule.name ? rule.name : null,
				matcher: describeMatcher(rule),
				action: action?.type ?? "unknown",
				destination: action?.value?.length ? action.value.join(", ") : null,
				enabled: rule.enabled !== false,
				count: c.count,
				errors: c.errors,
				catch_all: isCatchAllRule(rule),
				addresses: addrs,
			};
		})
		.sort((a, b) => b.count - a.count || a.matcher.localeCompare(b.matcher));
}

export interface ByAddressRow {
	address: string;
	count: number;
	has_mailbox: boolean;
	/** Per-rule split of `count` (additive): an address can match its own rule and the catch-all. */
	via?: { rule_id: string; matcher: string; action: string; count: number }[];
	/** Of `count`, handed to this app's Worker (additive). */
	to_app?: number;
}

/**
 * Inbound per recipient address, from the incoming raw rows.
 *
 * `count` is every incoming row for the address, whichever rule matched it.
 * `via` explains it: e.g. manish@ = 4 on its own forward rule + 3 through the
 * catch-all = 7, while the rules table shows 4 against the manish@ rule.
 */
export function byAddress(
	rows: readonly RoutingRecipientRow[],
	hasMailbox: (address: string) => boolean,
	limit = 50,
	rules: readonly (CfRule & { zoneName?: string | null })[] = [],
): ByAddressRow[] {
	const ruleOf = new Map(rules.map((r) => [normalizeRuleId(r.id ?? r.tag), r]));
	const counts = new Map<string, { count: number; toApp: number; via: Map<string, number> }>();
	for (const row of rows) {
		const address = bareAddress(row.to);
		if (!address) continue;
		const n = weight(1, row.sampleInterval);
		const entry = counts.get(address) ?? { count: 0, toApp: 0, via: new Map<string, number>() };
		entry.count += n;
		if ((row.action ?? "").toLowerCase() === "worker") entry.toApp += n;
		const id = normalizeRuleId(row.ruleMatched);
		entry.via.set(id, (entry.via.get(id) ?? 0) + n);
		counts.set(address, entry);
	}
	return [...counts.entries()]
		.map(([address, e]) => ({
			address,
			count: e.count,
			has_mailbox: hasMailbox(address),
			via: [...e.via.entries()]
				.map(([rule_id, count]) => {
					const rule = ruleOf.get(rule_id);
					return {
						rule_id,
						matcher: rule ? describeMatcher(rule) : rule_id ? "(unknown rule)" : "(no rule)",
						action: rule?.actions?.[0]?.type ?? "unknown",
						count,
					};
				})
				.sort((a, b) => b.count - a.count),
			to_app: e.toApp,
		}))
		.sort((a, b) => b.count - a.count || a.address.localeCompare(b.address))
		.slice(0, limit);
}

export interface InboundReconciliation {
	/** Incoming rows Cloudflare recorded (`received`). */
	received: number;
	/** Of those, handed to this app's Worker (worker/dropped, i.e. "Handled by worker"). */
	handled_by_worker: number;
	/** Worker-action rows that errored (includes auth refusals). */
	worker_errors: number;
	/** Forwarded elsewhere by a rule (never reaches the app). */
	forwarded: number;
	/** Dropped by a drop rule. */
	dropped: number;
	/** Stored locally in app mailboxes, dated by the message's Date header. */
	stored: number;
	/** `stored - handled_by_worker`. Positive or negative; see `stored_gap_reasons`. */
	stored_gap: number;
	/**
	 * Why `stored` and `handled_by_worker` legitimately differ:
	 * - `date_header`: stored mail is dated by its Date header, Cloudflare by event time, so a message near a window edge can fall on either side.
	 * - `local_routing`: the app files mail it received for one address into another mailbox (aliases, catch-all assignments) and skips duplicates and unknown addresses.
	 * - `scan_cap`: the local scan stopped at its row cap.
	 */
	stored_gap_reasons: ("date_header" | "local_routing" | "scan_cap")[];
	/** Catch-all rows, and how many of them were for addresses the app knows (mailbox or alias). */
	catch_all: { count: number; known_addresses: number; unknown_addresses: number } | null;
}

export function inboundReconciliation(input: {
	groups: readonly RoutingGroup[];
	recipients: readonly RoutingRecipientRow[];
	rules: readonly CfRule[] | null;
	hasMailbox: (address: string) => boolean;
	stored: number;
	scanCapped: boolean;
}): InboundReconciliation {
	let received = 0;
	let handled = 0;
	let workerErrors = 0;
	let forwarded = 0;
	let dropped = 0;
	for (const g of input.groups) {
		const n = weight(g.count, g.dimensions.sampleInterval);
		received += n;
		const a = (g.dimensions.action ?? "").toLowerCase();
		const s = (g.dimensions.status ?? "").toLowerCase();
		if (a === "worker" && (s === "dropped" || s === "delivered" || s === "handled")) handled += n;
		else if (a === "worker") workerErrors += n;
		else if (a === "forward") forwarded += n;
		else if (a === "drop") dropped += n;
	}
	let catchAll: InboundReconciliation["catch_all"] = null;
	const catchIds = new Set((input.rules ?? []).filter(isCatchAllRule).map((r) => normalizeRuleId(r.id ?? r.tag)));
	if (catchIds.size > 0) {
		catchAll = { count: 0, known_addresses: 0, unknown_addresses: 0 };
		for (const row of input.recipients) {
			if (!catchIds.has(normalizeRuleId(row.ruleMatched))) continue;
			const n = weight(1, row.sampleInterval);
			catchAll.count += n;
			const address = bareAddress(row.to);
			if (address && input.hasMailbox(address)) catchAll.known_addresses += n;
			else catchAll.unknown_addresses += n;
		}
	}
	const gap = input.stored - handled;
	const reasons: InboundReconciliation["stored_gap_reasons"] = [];
	if (gap !== 0) reasons.push("date_header", "local_routing");
	if (input.scanCapped) reasons.push("scan_cap");
	return {
		received,
		handled_by_worker: handled,
		worker_errors: workerErrors,
		forwarded,
		dropped,
		stored: input.stored,
		stored_gap: gap,
		stored_gap_reasons: reasons,
		catch_all: catchAll,
	};
}

export function routingErrors(rows: readonly RoutingErrorRow[]) {
	return rows.map((row) => ({
		at: row.datetime,
		from: bareAddress(row.from) ?? row.from,
		to: bareAddress(row.to) ?? row.to,
		detail: row.errorDetail || row.status,
		// A refused spoof is routing working as intended, not a fault.
		...(isAuthRefusal(row.errorDetail) ? { reason: "auth" as const } : {}),
	}));
}

// -- engagement --------------------------------------------------------------

/**
 * The per-message rows: the newest `limit` by send date, plus every message
 * with an open or click that falls past the cut, so the rows always explain
 * the totals above them. Newest first.
 */
export function engagementMessageRows<T extends { sent_at: string; opens: number; clicks: number }>(rows: readonly T[], limit: number): T[] {
	const sorted = [...rows].sort((a, b) => (a.sent_at < b.sent_at ? 1 : a.sent_at > b.sent_at ? -1 : 0));
	return sorted.filter((row, i) => i < limit || row.opens > 0 || row.clicks > 0);
}

// -- DMARC -------------------------------------------------------------------

const dw = (g: DmarcGroup, v: number | undefined) => weight(v ?? 0, g.dimensions.sampleInterval);

export function dmarcSources(groups: readonly DmarcGroup[]): DmarcSource[] {
	const byOrg = new Map<string, { messages: number; pass: number; spf: number; dkim: number; ips: number }>();
	for (const group of groups) {
		const org = group.dimensions.sourceOrgName || "(unknown)";
		const entry = byOrg.get(org) ?? { messages: 0, pass: 0, spf: 0, dkim: 0, ips: 0 };
		entry.messages += dw(group, group.sum.totalMatchingMessages);
		entry.pass += dw(group, group.sum.dmarc);
		entry.spf += dw(group, group.sum.spfPass);
		entry.dkim += dw(group, group.sum.dkimPass);
		// uniq across sampleInterval groups can only be approximated by summing.
		entry.ips += group.uniq?.ipCount ?? 0;
		byOrg.set(org, entry);
	}
	return [...byOrg.entries()]
		.map(([org, e]) => ({
			org,
			messages: e.messages,
			pass_rate: rate(e.pass, e.messages) ?? 0,
			spf_pass_rate: rate(e.spf, e.messages) ?? 0,
			dkim_pass_rate: rate(e.dkim, e.messages) ?? 0,
			ips: e.ips,
		}))
		.sort((a, b) => b.messages - a.messages);
}

export function dmarcReporters(groups: readonly DmarcGroup[]) {
	const byOrg = new Map<string, number>();
	for (const group of groups) {
		const org = group.dimensions.orgName || "(unknown)";
		byOrg.set(org, (byOrg.get(org) ?? 0) + dw(group, group.sum.totalMatchingMessages));
	}
	return [...byOrg.entries()].map(([org, messages]) => ({ org, messages })).sort((a, b) => b.messages - a.messages);
}

/** Source IPs whose DMARC did not fully pass, worst first. */
export function dmarcFailures(groups: readonly DmarcGroup[], limit = 50): DmarcFailure[] {
	const out: DmarcFailure[] = [];
	for (const group of groups) {
		const messages = dw(group, group.sum.totalMatchingMessages);
		const failing = messages - dw(group, group.sum.dmarc);
		if (failing <= 0) continue;
		const d = group.dimensions;
		out.push({
			source_ip: d.sourceIP ?? "",
			ptr: d.sourcePTR || null,
			org: d.sourceOrgName || null,
			header_from: d.headerFrom ?? "",
			messages: failing,
			disposition: d.disposition || null,
			reason: d.evaluatedReason || null,
		});
	}
	return out.sort((a, b) => b.messages - a.messages).slice(0, limit);
}
