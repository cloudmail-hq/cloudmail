// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The analytics transforms against recorded-shape fixtures
 * (`test/fixtures/cf-analytics`, captured live from the tapetide.com zone on
 * 2026-10-26 with a read-only token, every address scrubbed to example.com).
 */

import { describe, expect, it } from "vitest";
import { parseDays, rate } from "../shared/analytics-types";
import * as agg from "../workers/lib/analytics-aggregate";
import type {
	CfReputation,
	CfRule,
	DmarcZoneData,
	InboundZoneData,
	OverviewZoneData,
	RoutingGroup,
	RoutingRecipientRow,
	SendingGroup,
	SendingRawRow,
} from "../workers/lib/cf-analytics";
import overviewFixture from "./fixtures/cf-analytics/graphql-overview.json";
import inboundFixture from "./fixtures/cf-analytics/graphql-inbound.json";
import inboundErrorsFixture from "./fixtures/cf-analytics/graphql-inbound-errors.json";
import dmarcFixture from "./fixtures/cf-analytics/graphql-dmarc.json";
import reputationFixture from "./fixtures/cf-analytics/rest-reputation.json";
import rulesFixture from "./fixtures/cf-analytics/rest-rules.json";
import suppressionsFixture from "./fixtures/cf-analytics/rest-suppressions.json";

const overview = overviewFixture.data.viewer.zones[0] as unknown as OverviewZoneData;
const inbound = inboundFixture.data.viewer.zones[0] as unknown as InboundZoneData;
const dmarc = dmarcFixture.data.viewer.zones[0] as unknown as DmarcZoneData;
const reputation = reputationFixture.result as CfReputation;
const rules = rulesFixture.result as CfRule[];

const APP = new Set(["support@example.com", "govind@example.com", "tech@example.com"]);

describe("rate", () => {
	it("is a fraction, or null when the denominator is 0", () => {
		expect(rate(1, 4)).toBe(0.25);
		expect(rate(0, 0)).toBeNull();
		expect(rate(5, 0)).toBeNull();
		expect(rate(0, 10)).toBe(0);
		expect(rate(1, Number.NaN)).toBeNull();
	});

	it("parseDays accepts only 1|7|30|90, default 7", () => {
		expect(parseDays("30")).toBe(30);
		expect(parseDays("90")).toBe(90);
		expect(parseDays("14")).toBe(7);
		expect(parseDays(undefined)).toBe(7);
		expect(parseDays("abc")).toBe(7);
	});
});

describe("app/zone split by From address", () => {
	it("splits the fixture's raw rows into app mailboxes vs other senders", () => {
		const { senders, app, other } = agg.splitSenders(overview.raw, APP);
		expect(app.length + other.length).toBe(overview.raw.length);
		const appSenders = senders.filter((s) => s.app).map((s) => s.from).sort();
		expect(appSenders).toEqual(["support@example.com", "tech@example.com"]);
		const others = senders.filter((s) => !s.app).map((s) => s.from).sort();
		expect(others).toEqual(["alerts@mail.example.com", "noreply@example.com"]);
		// Display-name and bare forms both match.
		expect(app.some((r) => r.from.startsWith('"'))).toBe(true);
		expect(app.some((r) => !r.from.includes("<"))).toBe(true);
	});

	it("does not use sendingDomain to separate: app and noreply share the apex", () => {
		const { senders } = agg.splitSenders(overview.raw, APP);
		const noreply = senders.find((s) => s.from === "noreply@example.com")!;
		expect(noreply.app).toBe(false);
		expect(overview.raw.find((r) => r.from.includes("noreply@"))!.sendingDomain).toBe("example.com");
		expect(overview.raw.find((r) => r.from.includes("support@"))!.sendingDomain).toBe("example.com");
	});

	it("counts delivered per sender and weights by sampleInterval", () => {
		const rows: SendingRawRow[] = [
			{ ...overview.raw[0], from: "support@example.com", status: "delivered", sampleInterval: 1 },
			{ ...overview.raw[0], from: '"S" <support@example.com>', status: "deliveryFailed", sampleInterval: 3 },
		];
		const { senders } = agg.splitSenders(rows, APP);
		expect(senders).toEqual([{ from: "support@example.com", app: true, sent: 4, delivered: 1 }]);
	});

	it("with an alias in the set, the alias counts as the app", () => {
		const row = { ...overview.raw[0], from: "sales@example.com" };
		expect(agg.splitSenders([row], new Set([...APP, "sales@example.com"])).senders[0].app).toBe(true);
		expect(agg.splitSenders([row], APP).senders[0].app).toBe(false);
	});
});

describe("sending totals", () => {
	it("sums the fixture groups and matches the raw rows", () => {
		const totals = agg.sumSendingGroups(overview.sending);
		expect(totals.sent).toBeGreaterThan(0);
		expect(totals.delivered).toBe(totals.sent); // live data: all delivered
		const byDomain = agg.sendingByDomain(overview.sending);
		expect([...byDomain.keys()].sort()).toEqual(["example.com", "mail.example.com"]);
		const byDate = agg.sendingByDate(overview.sending);
		expect([...byDate.values()].reduce((n, t) => n + t.sent, 0)).toBe(totals.sent);
	});

	it("buckets every known status and keeps unknown ones in sent only", () => {
		const g = (status: string, count: number, sampleInterval = 1): SendingGroup => ({
			count,
			dimensions: { status, sendingDomain: "example.com", errorCause: "", errorAttribution: "", isSpam: 0, sampleInterval },
		});
		const t = agg.sumSendingGroups([
			g("delivered", 10),
			g("deliveryFailed", 2),
			g("failed", 1),
			g("rejected", 1),
			g("deferred", 1),
			g("somethingNew", 1),
			g("delivered", 5, 2),
		]);
		expect(t).toEqual({ sent: 26, delivered: 20, bounced: 2, failed: 1, rejected: 1, deferred: 1 });
	});

	it("fills missing days with zero", () => {
		const series = agg.fillSeries(["2026-10-01", "2026-10-02"], [{ date: "2026-10-02", n: 3 }], (date) => ({ date, n: 0 }));
		expect(series).toEqual([
			{ date: "2026-10-01", n: 0 },
			{ date: "2026-10-02", n: 3 },
		]);
	});

	it("detects sampling", () => {
		expect(agg.anySampled(overview.raw)).toBe(false);
		expect(agg.anySampled([{ sampleInterval: 2 }])).toBe(true);
		expect(agg.anySampled([{ dimensions: { sampleInterval: 4 } }])).toBe(true);
	});
});

describe("domains and errors", () => {
	it("joins subdomains, groups, top senders and complaints", () => {
		const rows = agg.domainRows({
			groups: overview.sending,
			raw: overview.raw,
			complaints: [],
			subdomains: [
				{ name: "example.com", enabled: true, dnsStatus: "ready" },
				{ name: "mail.example.com", enabled: true, dnsStatus: "ready" },
				{ name: "new.example.com", enabled: false, dnsStatus: null },
			],
		});
		expect(rows.map((r) => r.domain)).toEqual(["example.com", "mail.example.com", "new.example.com"]);
		expect(rows[0]).toMatchObject({ enabled: true, dns_status: "ready", complaints: 0 });
		expect(rows[0].top_senders[0].from).toBe("noreply@example.com");
		expect(rows[1].top_senders).toEqual([{ from: "alerts@mail.example.com", count: 6 }]);
		expect(rows[2]).toMatchObject({ sent: 0, enabled: false, top_senders: [] });
	});

	it("reports complaints as null when subdomains could not be read", () => {
		const rows = agg.domainRows({ groups: overview.sending, raw: [], complaints: [], subdomains: null });
		expect(rows.every((r) => r.complaints === null)).toBe(true);
	});

	it("groups failures by cause and attribution with an example and last_seen", () => {
		const base = overview.raw[0];
		const errors = agg.errorRowsFromRaw([
			base,
			{ ...base, status: "deliveryFailed", errorCause: "mailbox_full", errorAttribution: "recipient", errorDetail: "552 full", datetime: "2026-10-20T00:00:00Z" },
			{ ...base, status: "deliveryFailed", errorCause: "mailbox_full", errorAttribution: "recipient", errorDetail: "552 full again", datetime: "2026-10-21T00:00:00Z" },
			{ ...base, status: "failed", errorCause: "", errorAttribution: "", errorDetail: "" },
		]);
		expect(errors[0]).toEqual({
			cause: "mailbox_full",
			attribution: "recipient",
			bucket: "recipient",
			count: 2,
			example: "552 full again",
			last_seen: "2026-10-21T00:00:00Z",
		});
		expect(errors[1]).toMatchObject({ cause: "failed", attribution: null, bucket: "internal", count: 1 });
		expect(agg.errorRowsFromRaw(overview.raw)).toEqual([]);
	});
});

describe("reputation", () => {
	it("renders the live active_policy, not the docs' numbers", () => {
		const rep = agg.reputationFrom(reputation, overview.reputation, [])!;
		expect(rep.status).toBe("healthy");
		expect(rep.since).toBeNull();
		const bounce = rep.metrics.find((m) => m.key === "bounce")!;
		expect(bounce).toMatchObject({ warning_at: 0.4, at_risk_at: 0.9, minimum_denominator: 100, value: 0 });
		const complaint = rep.metrics.find((m) => m.key === "complaint")!;
		expect(complaint).toMatchObject({ warning_at: 0.02, at_risk_at: 0.04, value: 0 });
		expect(rep.metrics.map((m) => m.key)).toEqual(["bounce", "complaint", "spam_rejection"]);
	});

	it("is null without the REST reputation", () => {
		expect(agg.reputationFrom(null, overview.reputation, [])).toBeNull();
	});

	it("has null rates when the denominator is 0", () => {
		const rep = agg.reputationFrom(reputation, [], [])!;
		for (const metric of rep.metrics) {
			expect(metric.value).toBeNull();
			expect(metric.denominator).toBe(0);
		}
	});

	it("takes the worst domain above the minimum denominator", () => {
		const g = (domain: string, status: string, count: number, extra: Partial<SendingGroup["dimensions"]> = {}): SendingGroup => ({
			count,
			dimensions: { status, sendingDomain: domain, errorCause: "", errorAttribution: "", isSpam: 0, sampleInterval: 1, ...extra },
		});
		const groups = [
			g("a.example.com", "delivered", 190),
			g("a.example.com", "deliveryFailed", 10, { errorCause: "user_unknown", errorAttribution: "recipient" }),
			g("b.example.com", "delivered", 70),
			g("b.example.com", "deliveryFailed", 30, { errorCause: "mailbox_full" }),
			// Small domain with a terrible rate but under the minimum: ignored.
			g("c.example.com", "deliveryFailed", 5, { errorCause: "user_unknown" }),
			// A spam-caused failure counts as spam rejection, not bounce.
			g("a.example.com", "deliveryFailed", 0),
		];
		const rep = agg.reputationFrom(reputation, groups, [
			{ count: 3, dimensions: { sendingDomain: "b.example.com" } },
		])!;
		const bounce = rep.metrics.find((m) => m.key === "bounce")!;
		expect(bounce.value).toBeCloseTo(0.3);
		expect(bounce.denominator).toBe(100);
		const complaint = rep.metrics.find((m) => m.key === "complaint")!;
		// b's 3 complaints sit on 70 delivered, under the minimum of 100, so b does
		// not count (as in Cloudflare's evaluation); a (190 delivered) is the only
		// eligible domain.
		expect(complaint.denominator).toBe(190);
		expect(complaint.value).toBe(0);
		// With no eligible domain the largest one is shown, under the minimum (greyed out).
		const small = agg.reputationFrom(reputation, [groups[2]], [{ count: 1, dimensions: { sendingDomain: "b.example.com" } }])!;
		expect(small.metrics.find((m) => m.key === "complaint")).toMatchObject({ denominator: 70, minimum_denominator: 100 });
	});

	it("never pools sub-minimum domains into a rate that looks valid", () => {
		const g = (domain: string, count: number): SendingGroup => ({
			count,
			dimensions: { status: "delivered", sendingDomain: domain, errorCause: "", errorAttribution: "", isSpam: 0, sampleInterval: 1 },
		});
		// 60 + 60 = 120 rows overall, but each domain is under 100.
		const rep = agg.reputationFrom(reputation, [g("a.example.com", 60), g("b.example.com", 60)], [])!;
		for (const metric of rep.metrics) expect(metric.denominator).toBeLessThan(metric.minimum_denominator);
	});

	it("counts isSpam and spam-like causes as spam rejection", () => {
		const groups: SendingGroup[] = [
			{ count: 90, dimensions: { status: "delivered", sendingDomain: "x", errorCause: "", errorAttribution: "", isSpam: 0, sampleInterval: 1 } },
			{ count: 6, dimensions: { status: "deliveryFailed", sendingDomain: "x", errorCause: "spam", errorAttribution: "recipient", isSpam: 0, sampleInterval: 1 } },
			{ count: 4, dimensions: { status: "rejected", sendingDomain: "x", errorCause: "", errorAttribution: "", isSpam: 1, sampleInterval: 1 } },
		];
		const rep = agg.reputationFrom(reputation, groups, [])!;
		expect(rep.metrics.find((m) => m.key === "spam_rejection")!.value).toBeCloseTo(0.1);
		expect(rep.metrics.find((m) => m.key === "bounce")!.value).toBe(0);
	});
});

describe("routing relabel", () => {
	it("labels worker+dropped as handled, and only action=drop as a drop", () => {
		expect(agg.routingLabel("worker", "dropped")).toBe("Handled by worker");
		expect(agg.routingLabel("worker", "error")).toBe("Worker error");
		expect(agg.routingLabel("forward", "delivered")).toBe("Forwarded");
		expect(agg.routingLabel("forward", "deliveryFailed")).toBe("Forward failed");
		expect(agg.routingLabel("drop", "dropped")).toBe("Dropped by rule");
		expect(agg.routingLabel("reject", "rejected")).toBe("Rejected (auth failure)");
		expect(agg.routingLabel("mystery", "odd")).toBe("mystery / odd");
	});

	it("aggregates the fixture's routing actions", () => {
		const actions = agg.routingActions(inbound.groups);
		const handled = actions.find((a) => a.action === "worker" && a.status === "dropped")!;
		expect(handled.label).toBe("Handled by worker");
		expect(actions.find((a) => a.action === "forward")!.label).toBe("Forwarded");
		expect(actions.some((a) => a.label === "Dropped by rule")).toBe(false);
		const total = inbound.groups.reduce((n, g) => n + g.count, 0);
		expect(actions.reduce((n, a) => n + a.count, 0)).toBe(total);
	});
});

describe("inbound", () => {
	it("counts SPF/DKIM/DMARC verdicts", () => {
		const auth = agg.authCounts(inbound.groups);
		const total = inbound.groups.reduce((n, g) => n + g.count, 0);
		for (const key of ["spf", "dkim", "dmarc"] as const) {
			expect(Object.values(auth[key]).reduce((a, b) => a + b, 0)).toBe(total);
		}
		expect(auth.spf.pass).toBeGreaterThan(0);
	});

	it("joins dashed ruleMatched to dashless REST rule ids, including the catch-all", () => {
		expect(agg.normalizeRuleId("e1d933d0-63e1-4046-a8f6-04142e7fd7b3")).toBe("e1d933d063e14046a8f604142e7fd7b3");
		const table = agg.ruleRows(rules, inbound.groups);
		expect(table).toHaveLength(rules.length);
		const updates = table.find((r) => r.matcher === "updates@example.com")!;
		expect(updates).toMatchObject({ action: "worker", destination: "tapetide-agentic-inbox", name: "updates -> agentic-inbox" });
		expect(updates.count).toBeGreaterThan(0);
		const catchAll = table.find((r) => r.matcher === "*")!;
		expect(catchAll).toMatchObject({ action: "forward", destination: "forward-target@example.com" });
		expect(catchAll.name).toBeNull();
		// Sum of rule counts equals routed rows that carried a rule id.
		const matched = inbound.groups.filter((g) => g.dimensions.ruleMatched).reduce((n, g) => n + g.count, 0);
		expect(table.reduce((n, r) => n + r.count, 0)).toBe(matched);
	});

	it("counts recipients per address and flags those without a mailbox", () => {
		const rows = agg.byAddress(inbound.recipients, (a) => a === "support@example.com");
		expect(rows[0].address).toBe("updates@example.com");
		expect(rows.find((r) => r.address === "support@example.com")!.has_mailbox).toBe(true);
		expect(rows.find((r) => r.address === "updates@example.com")!.has_mailbox).toBe(false);
	});

	it("shapes routing errors with bare addresses", () => {
		const errors = agg.routingErrors(inboundErrorsFixture.errors as never);
		expect(errors[0]).toEqual({
			at: "2026-10-12T20:36:48Z",
			from: "person18@example.net",
			to: "hr@example.com",
			detail: "66.98.68.188 isn't allowed to send email for person18@example.net",
			reason: "auth",
		});
	});
});

describe("DMARC", () => {
	it("computes per-source pass rates from the fixture", () => {
		const sources = agg.dmarcSources(dmarc.bySource);
		expect(sources.map((s) => s.org)).toEqual(["Cloudflare, Inc.", "Amazon.com, Inc."]);
		expect(sources[0]).toMatchObject({ messages: 261, pass_rate: 1, spf_pass_rate: 1, dkim_pass_rate: 1, ips: 2 });
		expect(sources[1]).toMatchObject({ messages: 201, ips: 15 });
	});

	it("lists reporters", () => {
		expect(agg.dmarcReporters(dmarc.byReporter)).toEqual([
			{ org: "google.com", messages: 461 },
			{ org: "Yahoo", messages: 1 },
		]);
	});

	it("lists only failing source IPs", () => {
		expect(agg.dmarcFailures(dmarc.detail)).toEqual([]);
		const failing = agg.dmarcFailures([
			{
				sum: { totalMatchingMessages: 12, dmarc: 2 },
				dimensions: { sourceIP: "192.0.2.10", sourcePTR: "", sourceOrgName: "Spoofer", headerFrom: "example.com", disposition: "reject", evaluatedReason: "", sampleInterval: 1 },
			},
		]);
		expect(failing).toEqual([
			{ source_ip: "192.0.2.10", ptr: null, org: "Spoofer", header_from: "example.com", messages: 10, disposition: "reject", reason: null },
		]);
	});

	it("rates are 0, not NaN, for a source with no messages", () => {
		expect(agg.dmarcSources([{ sum: { totalMatchingMessages: 0 }, dimensions: { sourceOrgName: "x" } }])[0].pass_rate).toBe(0);
	});
});

describe("suppressions", () => {
	it("counts provider suppressions by reason", () => {
		expect(agg.providerSuppressionCounts(suppressionsFixture.result as never)).toEqual({
			total: 5,
			by_reason: { hard_bounce: 5 },
		});
		expect(agg.providerSuppressionCounts(null)).toBeNull();
	});
});

// ── Production-shaped consistency (vision review, 2026-10-26) ─────────────
//
// Shapes taken from the live tapetide.com zone, 30-day window, addresses
// scrubbed: the catch-all matched 106 rows, 3 of them for manish@ (which also
// has its own forward rule with 4) and 1 for tech@ (an app mailbox with no
// literal rule). Two SPF refusals to hr@ arrive as worker/error.

const CATCH = "ecc3bcd6-6d5f-4d09-b34c-b2ed1234d08c";
const MANISH = "076cc246-bdd1-4b83-ac7d-1e2e14d28e3d";
const HR = "0d33e6e9-98f6-479a-98ac-0ca10b953f76";
const SUPPORT_RULE = "84139028-096a-4d7f-a0fd-41778fb47944";

function recipientsLike(): RoutingRecipientRow[] {
	const out: RoutingRecipientRow[] = [];
	const add = (to: string, ruleMatched: string, action: string, status: string, n: number) => {
		for (let i = 0; i < n; i++) out.push({ to, ruleMatched, action, status, sampleInterval: 1 });
	};
	add("jobs@example.com", CATCH, "forward", "delivered", 69);
	add("hello@example.com", CATCH, "forward", "delivered", 13);
	add("other@example.com", CATCH, "forward", "delivered", 20);
	add("manish@example.com", CATCH, "forward", "delivered", 3);
	add("tech@example.com", CATCH, "forward", "delivered", 1);
	add("manish@example.com", MANISH, "forward", "delivered", 4);
	add("hr@example.com", HR, "worker", "dropped", 58);
	add("hr@example.com", HR, "worker", "error", 2);
	add("support@example.com", SUPPORT_RULE, "worker", "dropped", 63);
	return out;
}

function groupsLike(): RoutingGroup[] {
	const g = (ruleMatched: string, action: string, status: string, count: number, auth: [string, string, string] = ["pass", "pass", "none"]): RoutingGroup => ({
		count,
		dimensions: { date: "2026-10-20", action, status, ruleMatched, spf: auth[0], dkim: auth[1], dmarc: auth[2], isSpam: 0, sampleInterval: 1 },
	});
	return [
		g(CATCH, "forward", "delivered", 106),
		g(MANISH, "forward", "delivered", 4),
		g(HR, "worker", "dropped", 58),
		g(HR, "worker", "error", 1, ["fail", "", "fail"]),
		g(HR, "worker", "error", 1, ["fail", "none", "none"]),
		g(SUPPORT_RULE, "worker", "dropped", 62),
		g(SUPPORT_RULE, "worker", "dropped", 1, ["temperror", "unknown", ""]),
	];
}

const knownAddresses = new Set(["support@example.com", "tech@example.com", "manish@example.com", "hr@example.com"]);
const hasMailbox = (a: string) => knownAddresses.has(a);

describe("inbound reconciliation", () => {
	it("SPF/DKIM/DMARC each sum to received and always carry pass, fail and none", () => {
		const groups = groupsLike();
		const received = groups.reduce((n, x) => n + x.count, 0);
		const auth = agg.authCounts(groups);
		for (const key of ["spf", "dkim", "dmarc"] as const) {
			expect(agg.histogramTotal(auth[key])).toBe(received);
			expect(auth[key]).toHaveProperty("pass");
			expect(auth[key]).toHaveProperty("fail");
			expect(auth[key]).toHaveProperty("none");
		}
		// Empty and "unknown" verdicts are `none`, never a bucket that silently
		// disappears; rarer verdicts keep their own key.
		expect(auth.dkim).toEqual({ pass: 230, fail: 0, none: 3 });
		expect(auth.spf).toEqual({ pass: 230, fail: 2, none: 0, temperror: 1 });
		expect(auth.dmarc).toEqual({ pass: 0, fail: 1, none: 232 });
	});

	it("normalizes merged local histograms the same way", () => {
		expect(agg.normalizeAuthHistograms({ spf: { pass: 2, unknown: 1 }, dkim: {}, dmarc: { PASS: 1, none: 2 } })).toEqual({
			spf: { pass: 2, fail: 0, none: 1 },
			dkim: { pass: 0, fail: 0, none: 0 },
			dmarc: { pass: 1, fail: 0, none: 2 },
		});
	});

	it("relabels worker+error SPF refusals as Rejected (failed SPF/DMARC) without changing the total", () => {
		const groups = groupsLike();
		const actions = agg.routingActions(groups, inboundErrorsFixture.errors as never);
		const refused = actions.find((a) => a.reason === "auth")!;
		expect(refused).toMatchObject({ label: "Rejected (failed SPF/DMARC)", action: "worker", status: "error", count: 2 });
		expect(actions.some((a) => a.label === "Worker error")).toBe(false);
		expect(actions.reduce((n, a) => n + a.count, 0)).toBe(groups.reduce((n, g) => n + g.count, 0));
		// A genuine worker error stays a worker error.
		const real = agg.routingActions(groups, [
			{ datetime: "x", from: "a@b", to: "hr@example.com", status: "error", action: "worker", errorDetail: "script threw", sampleInterval: 1 },
		]);
		expect(real.find((a) => a.label === "Worker error")!.count).toBe(2);
		expect(agg.isAuthRefusal("66.98.68.188 isn't allowed to send email for x@y.com")).toBe(true);
		expect(agg.isAuthRefusal("Worker threw an exception")).toBe(false);
	});

	it("catch-all: the rule count, its address breakdown and the reconciliation agree (106)", () => {
		const recipients = recipientsLike();
		const table = agg.ruleRows(rules, groupsLike(), recipients, hasMailbox);
		const catchAll = table.find((r) => r.catch_all)!;
		expect(catchAll.count).toBe(106);
		expect(catchAll.addresses!.reduce((n, a) => n + a.count, 0)).toBe(106);

		// The "no mailbox" addresses on the catch-all sum to 102: manish@ (3) and
		// tech@ (1) are known to the app but have no rule sending them to it.
		const unknownSum = catchAll.addresses!.filter((a) => !a.has_mailbox).reduce((n, a) => n + a.count, 0);
		expect(unknownSum).toBe(102);
		const rec = agg.inboundReconciliation({ groups: groupsLike(), recipients, rules, hasMailbox, stored: 120, scanCapped: false });
		expect(rec.catch_all).toEqual({ count: 106, known_addresses: 4, unknown_addresses: 102 });
	});

	it("by_address explains manish@: 4 on its own rule + 3 via the catch-all = 7", () => {
		const rows = agg.byAddress(recipientsLike(), hasMailbox, 50, rules);
		const manish = rows.find((r) => r.address === "manish@example.com")!;
		expect(manish.count).toBe(7);
		expect(manish.via).toEqual([
			{ rule_id: "076cc246bdd14b83ac7d1e2e14d28e3d", matcher: "manish@example.com", action: "forward", count: 4 },
			{ rule_id: "ecc3bcd66d5f4d09b34cb2ed1234d08c", matcher: "*", action: "forward", count: 3 },
		]);
		expect(manish.to_app).toBe(0);
		expect(agg.ruleRows(rules, groupsLike()).find((r) => r.matcher === "manish@example.com")!.count).toBe(4);
		expect(rows.find((r) => r.address === "hr@example.com")).toMatchObject({ count: 60, to_app: 60 });
	});

	it("explains stored vs handled by worker as a residual with reasons", () => {
		const rec = agg.inboundReconciliation({ groups: groupsLike(), recipients: recipientsLike(), rules, hasMailbox, stored: 118, scanCapped: false });
		expect(rec).toMatchObject({ received: 233, handled_by_worker: 121, worker_errors: 2, forwarded: 110, dropped: 0, stored: 118, stored_gap: -3 });
		expect(rec.stored_gap_reasons).toEqual(["date_header", "local_routing"]);
		const exact = agg.inboundReconciliation({ groups: groupsLike(), recipients: [], rules: null, hasMailbox, stored: 121, scanCapped: true });
		expect(exact.stored_gap_reasons).toEqual(["scan_cap"]);
		expect(exact.catch_all).toBeNull();
	});
});

describe("suppressions window", () => {
	it("counts only entries created inside the window; Cloudflare's 5 hard bounces are all older", () => {
		const items = suppressionsFixture.result as never;
		expect(agg.providerSuppressionsInWindow(items, "2026-09-26T07:00:00.000Z", "2026-10-26T07:00:00.000Z")).toEqual({ total: 0, by_reason: {} });
		expect(agg.providerSuppressionsInWindow(items, "2026-09-24T00:00:00.000Z", "2026-10-26T07:00:00.000Z")).toEqual({
			total: 1,
			by_reason: { hard_bounce: 1 },
		});
		expect(agg.providerSuppressionsInWindow(null, "a", "b")).toBeNull();
	});

	it("parses Cloudflare's zone-less timestamps as UTC", () => {
		expect(agg.parseProviderTime("2026-09-24 09:28:19.873")).toBe(Date.parse("2026-09-24T09:28:19.873Z"));
		expect(agg.parseProviderTime("2026-09-24T09:28:19Z")).toBe(Date.parse("2026-09-24T09:28:19Z"));
		expect(agg.parseProviderTime("nope")).toBeNull();
	});
});

describe("engagement rows", () => {
	it("keep every engaged message even past the newest-N cut", () => {
		const rows = Array.from({ length: 17 }, (_, i) => ({
			sent_at: `2026-10-${String(10 + i).padStart(2, "0")}T00:00:00.000Z`,
			opens: i === 0 ? 12 : 0,
			clicks: i === 0 ? 3 : 0,
		}));
		const out = agg.engagementMessageRows(rows, 10);
		expect(out).toHaveLength(11);
		expect(out.reduce((n, r) => n + r.opens, 0)).toBe(12);
		expect(out[0].sent_at > out[out.length - 1].sent_at).toBe(true);
	});
});

describe("app-scope domain rows", () => {
	it("folds app-only raw rows into groups so domain counts never include other senders", () => {
		const row = (messageId: string, status: string): SendingRawRow => ({
			datetime: "2026-10-20T00:00:00Z",
			messageId,
			from: "support@example.com",
			sendingDomain: "example.com",
			status,
			errorCause: status === "delivered" ? "" : "user_unknown",
			errorAttribution: "",
			errorDetail: "",
			sampleInterval: 1,
		});
		const totals = agg.sumSendingGroups(agg.groupsFromRaw([row("<a@x>", "delivered"), row("<b@x>", "deliveryFailed")]));
		expect(totals).toMatchObject({ sent: 2, delivered: 1, bounced: 1 });
	});
});
