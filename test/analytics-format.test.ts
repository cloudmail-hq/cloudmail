import { describe, expect, it } from "vitest";
import {
	authBreakdown,
	bareAddress,
	bucketSeries,
	fillDays,
	formatCount,
	formatRate,
	formatRelative,
	gaugeModel,
	humanize,
	isFailingVerdict,
	isWebUrl,
	messageSearchHref,
	niceTicks,
	reputationStatus,
	safeRate,
	seriesSummary,
	shortUrl,
	stackSegments,
	unownedAddressRoute,
} from "~/components/analytics/format";
import {
	dmarcFixture,
	engagementFixture,
	inboundFixture,
	overviewFixture,
} from "~/components/analytics/fixtures";

describe("formatCount", () => {
	it("keeps exact numbers below 10k and compacts above", () => {
		expect(formatCount(0)).toBe("0");
		expect(formatCount(1284)).toBe("1,284");
		expect(formatCount(12_900)).toBe("12.9K");
		expect(formatCount(20_000)).toBe("20K");
		expect(formatCount(4_200_000)).toBe("4.2M");
		expect(formatCount(999_960)).toBe("1M");
		expect(formatCount(null)).toBe("—");
		expect(formatCount(Number.NaN)).toBe("—");
	});
});

describe("formatRate", () => {
	it("formats fractions with precision where it matters", () => {
		expect(formatRate(null)).toBe("—");
		expect(formatRate(0)).toBe("0%");
		expect(formatRate(1)).toBe("100%");
		expect(formatRate(0.4)).toBe("40%");
		expect(formatRate(0.02)).toBe("2%");
		expect(formatRate(0.031)).toBe("3.1%");
		expect(formatRate(0.0004)).toBe("0.04%");
		expect(formatRate(0.9957)).toBe("99.6%");
		expect(formatRate(0.125)).toBe("13%");
		expect(formatRate(0.00001)).toBe("<0.01%");
	});
	it("never rounds a not-quite-perfect rate up to 100%", () => {
		expect(formatRate(0.9999)).not.toBe("100%");
	});
});

describe("safeRate", () => {
	it("is null for a zero or invalid denominator", () => {
		expect(safeRate(1, 0)).toBeNull();
		expect(safeRate(1, -1)).toBeNull();
		expect(safeRate(1, Number.NaN)).toBeNull();
		expect(safeRate(1, 4)).toBe(0.25);
	});
});

describe("formatRelative", () => {
	const now = Date.parse("2026-10-26T10:00:00Z");
	it("buckets into seconds, minutes, hours and days", () => {
		expect(formatRelative("2026-10-26T09:59:40Z", now)).toBe("just now");
		expect(formatRelative("2026-10-26T09:57:00Z", now)).toBe("3m ago");
		expect(formatRelative("2026-10-26T07:00:00Z", now)).toBe("3h ago");
		expect(formatRelative("2026-10-23T10:00:00Z", now)).toBe("3d ago");
		expect(formatRelative(undefined, now)).toBe("");
		expect(formatRelative("garbage", now)).toBe("");
	});
});

describe("reputationStatus", () => {
	it("maps Cloudflare's enum, calling suspended Paused as the docs do", () => {
		expect(reputationStatus("healthy")).toEqual({ tone: "healthy", label: "Healthy" });
		expect(reputationStatus("at_risk").label).toBe("At risk");
		expect(reputationStatus("suspended").label).toBe("Paused");
		expect(reputationStatus("under_review")).toEqual({ tone: "unknown", label: "Under review" });
		expect(reputationStatus(null).label).toBe("Unknown");
	});
});

describe("gaugeModel", () => {
	const base = { key: "bounce" as const, warning_at: 0.4, at_risk_at: 0.9, denominator: 151, minimum_denominator: 100 };
	it("places both live thresholds on the rail", () => {
		const g = gaugeModel({ ...base, value: 0 });
		expect(g.zone).toBe("healthy");
		expect(g.warnPos).toBeGreaterThan(0);
		expect(g.riskPos).toBeLessThanOrEqual(1);
		expect(g.riskPos).toBeGreaterThan(g.warnPos);
	});
	it("classifies warning and at-risk values", () => {
		expect(gaugeModel({ ...base, value: 0.46 }).zone).toBe("warning");
		expect(gaugeModel({ ...base, value: 0.95 }).zone).toBe("at_risk");
	});
	it("greys out below the minimum denominator", () => {
		expect(gaugeModel({ ...base, value: 0.95, denominator: 64 }).zone).toBe("insufficient");
	});
	it("puts every threshold at the same place on the rail", () => {
		const complaint = gaugeModel({ ...base, key: "complaint", warning_at: 0.02, at_risk_at: 0.04, value: 0.01 });
		const bounce = gaugeModel({ ...base, value: 0.2 });
		expect(complaint.warnPos).toBeCloseTo(1 / 3);
		expect(complaint.riskPos).toBeCloseTo(2 / 3);
		expect(bounce.warnPos).toBeCloseTo(1 / 3);
		// Half-way to the warning line reads the same on both.
		expect(complaint.valuePos).toBeCloseTo(1 / 6);
		expect(bounce.valuePos).toBeCloseTo(1 / 6);
	});
	it("is monotonic across the bands", () => {
		const at = (value: number) => gaugeModel({ ...base, value }).valuePos!;
		expect(at(0.3)).toBeLessThan(at(0.5));
		expect(at(0.5)).toBeLessThan(at(0.95));
		expect(at(0.95)).toBeLessThanOrEqual(1);
	});
	it("pins values past the end of the scale", () => {
		const g = gaugeModel({ ...base, value: 1 });
		expect(g.valuePos).toBeLessThanOrEqual(1);
	});
});

describe("niceTicks", () => {
	it("returns clean integer steps covering the max", () => {
		expect(niceTicks(0)).toEqual([0, 1]);
		expect(niceTicks(3)).toEqual([0, 1, 2, 3]);
		expect(niceTicks(47)).toEqual([0, 20, 40, 60]);
		const t = niceTicks(709);
		expect(t[0]).toBe(0);
		expect(t[t.length - 1]).toBeGreaterThanOrEqual(709);
		expect(t.length).toBeLessThanOrEqual(6);
	});
});

describe("fillDays", () => {
	it("fills gaps with zero rows so the axis stays honest", () => {
		const rows = [{ date: "2026-10-24", n: 3 }];
		const out = fillDays(rows, "2026-10-23T09:00:00Z", "2026-10-26T09:00:00Z", (date) => ({ date, n: 0 }));
		expect(out.map((r) => r.date)).toEqual(["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"]);
		expect(out[1].n).toBe(3);
	});
	it("keeps rows that fall outside the window", () => {
		const rows = [{ date: "2026-10-20", n: 1 }];
		const out = fillDays(rows, "2026-10-25", "2026-10-26", (date) => ({ date, n: 0 }));
		expect(out[0]).toEqual({ date: "2026-10-20", n: 1 });
		expect(out).toHaveLength(3);
	});
});

describe("bucketSeries", () => {
	it("merges days when there are more than the plot can fit", () => {
		const rows = Array.from({ length: 90 }, (_, i) => ({ date: `d${String(i).padStart(2, "0")}`, sent: 1 }));
		const b = bucketSeries(rows, 30);
		expect(b).toHaveLength(30);
		expect(b[0].values.sent).toBe(3);
		expect(b[0].start).toBe("d00");
		expect(b[0].end).toBe("d02");
		expect(b.reduce((a, x) => a + x.values.sent, 0)).toBe(90);
	});
	it("leaves short series alone", () => {
		const rows = [{ date: "a", sent: 1 }, { date: "b", sent: 2 }];
		expect(bucketSeries(rows, 30).map((b) => b.values.sent)).toEqual([1, 2]);
	});
});

describe("stackSegments", () => {
	it("gives every non-zero segment a visible height", () => {
		const h = stackSegments([100, 1, 0], 101, 168);
		expect(h[1]).toBeGreaterThanOrEqual(2);
		expect(h[2]).toBe(0);
	});
	it("accounts for the 2px gaps between segments", () => {
		const h = stackSegments([50, 50], 100, 100);
		expect(h[0] + h[1] + 2).toBeCloseTo(100);
	});
	it("is all zeros for an empty max", () => {
		expect(stackSegments([1, 2], 0, 100)).toEqual([0, 0]);
	});
});

describe("authBreakdown", () => {
	it("computes pass rate and lists the other verdicts by size", () => {
		const b = authBreakdown({ pass: 2135, temperror: 3, permerror: 3, fail: 2, softfail: 1, none: 3 });
		expect(b.total).toBe(2147);
		expect(b.passRate).toBeCloseTo(2135 / 2147);
		expect(b.others[0].count).toBe(3);
		expect(b.others.map((o) => o.verdict)).toContain("softfail");
	});
	it("handles an empty histogram", () => {
		expect(authBreakdown({})).toEqual({ total: 0, pass: 0, passRate: null, others: [] });
	});
	it("knows which verdicts are failures", () => {
		expect(isFailingVerdict("softfail")).toBe(true);
		expect(isFailingVerdict("none")).toBe(false);
		expect(isFailingVerdict("pass")).toBe(false);
	});
});

describe("unownedAddressRoute", () => {
	const rules = [
		{ matcher: "updates@tapetide.com", action: "worker", destination: "tapetide-agentic-inbox", enabled: true },
		{ matcher: "devops@tapetide.com", action: "worker", destination: "tapetide-agentic-inbox", enabled: true },
		{ matcher: "manish@tapetide.com", action: "forward", destination: "m@example.com", enabled: true },
		{ matcher: "*@tapetide.com", action: "forward", destination: "forward@example.net", enabled: true },
	];
	it("is null for addresses with a mailbox", () => {
		expect(unownedAddressRoute("updates@tapetide.com", true, rules)).toBeNull();
	});
	it("flags a worker rule with no mailbox as dropped", () => {
		expect(unownedAddressRoute("DevOps@tapetide.com", false, rules)?.kind).toBe("dropped");
	});
	it("accepts a deliberate literal forward", () => {
		expect(unownedAddressRoute("manish@tapetide.com", false, rules)).toBeNull();
	});
	it("names the catch-all destination for everything else", () => {
		expect(unownedAddressRoute("tech@tapetide.com", false, rules)).toEqual({
			kind: "catch_all",
			destination: "forward@example.net",
		});
	});
	it("reports unrouted mail when nothing matches", () => {
		expect(unownedAddressRoute("x@tapetide.com", false, rules.slice(0, 2))?.kind).toBe("unrouted");
	});
	it("ignores disabled rules", () => {
		const off = rules.map((r) => ({ ...r, enabled: r.matcher.startsWith("*") ? false : r.enabled }));
		expect(unownedAddressRoute("tech@tapetide.com", false, off)?.kind).toBe("unrouted");
	});
});

describe("small helpers", () => {
	it("humanizes enum values", () => {
		expect(humanize("hard_bounce")).toBe("Hard bounce");
		expect(humanize("deliveryFailed")).toBe("Delivery failed");
		expect(humanize("E_RECIPIENT_SUPPRESSED")).toBe("Recipient suppressed");
	});
	it("extracts bare addresses", () => {
		expect(bareAddress('"Tapetide" <NoReply@tapetide.com>')).toBe("noreply@tapetide.com");
		expect(bareAddress("support@tapetide.com")).toBe("support@tapetide.com");
	});
	it("builds a search link to the message in its mailbox", () => {
		const href = messageSearchHref("support@tapetide.com", 'Re: "Invoice"');
		expect(href.startsWith("/mail/support%40tapetide.com/search?q=")).toBe(true);
		expect(decodeURIComponent(href.split("q=")[1])).toBe('in:sent subject:"Re: Invoice"');
		expect(decodeURIComponent(messageSearchHref("a@b.c", "").split("q=")[1])).toBe("in:sent");
	});
	it("only treats http(s) URLs as links", () => {
		expect(isWebUrl("https://tapetide.com/x")).toBe(true);
		expect(isWebUrl("http://a.b")).toBe(true);
		expect(isWebUrl("javascript:alert(1)")).toBe(false);
		expect(isWebUrl("data:text/html,hi")).toBe(false);
		expect(isWebUrl("not a url")).toBe(false);
	});
	it("shortens URLs for table cells", () => {
		expect(shortUrl("https://tapetide.com/billing?ref=email")).toBe("tapetide.com/billing?…");
		expect(shortUrl("https://tapetide.com/")).toBe("tapetide.com");
		expect(shortUrl("not a url")).toBe("not a url");
	});
	it("summarises a series for screen readers", () => {
		expect(seriesSummary("Sent", [])).toBe("Sent: no data.");
		expect(seriesSummary("Sent", [{ date: "2026-10-25", value: 0 }])).toBe("Sent: none from Oct 25.");
		expect(
			seriesSummary("Sent", [
				{ date: "2026-10-25", value: 2 },
				{ date: "2026-10-26", value: 5 },
			]),
		).toBe("Sent: 7 from Oct 25 to Oct 26, peaking at 5 on Oct 26.");
	});
});

describe("fixtures", () => {
	it("match the live 30-day numbers", () => {
		const zone = overviewFixture("demo", 30, "zone");
		expect(zone.sending.sent).toBe(709);
		expect(zone.sending.unit).toBe("recipients");
		// Recipients: support 12 + govind 3 + tech 3 (one message had 3 recipients).
		expect(zone.senders.filter((s) => s.app).reduce((a, s) => a + s.sent, 0)).toBe(18);
		expect(zone.sections?.senders.unit).toBe("recipients");
		expect(zone.reputation?.metrics.map((m) => [m.warning_at, m.at_risk_at])).toEqual([
			[0.4, 0.9],
			[0.02, 0.04],
			[0.2, 0.6],
		]);
		expect(zone.quota).toMatchObject({ limit: 5000 });
		const app = overviewFixture("demo", 30, "app");
		expect(app.sending.sent).toBe(17);
		expect(app.sending).toMatchObject({ delivered: 16, pending: 1, unit: "messages" });
		expect(app.scope).toBe("app");
		const dm = dmarcFixture("demo", 30);
		expect(dm.sources.map((s) => s.messages)).toEqual([261, 201]);
		expect(inboundFixture("demo", 30).received).toBe(2096);
	});
	it("keep the timeseries consistent with the totals", () => {
		for (const days of [1, 7, 30] as const) {
			const o = overviewFixture("issues", days, "zone");
			expect(o.timeseries.reduce((a, p) => a + p.sent, 0)).toBe(o.sending.sent);
			for (const p of o.timeseries) expect(p.delivered + p.bounced + p.failed).toBe(p.sent);
		}
	});
	it("cap Cloudflare data at 90 days", () => {
		const o = overviewFixture("demo", 90, "zone");
		expect(o.provider.window_capped).toBe(true);
		expect(o.scope).toBe("app");
		expect(o.domains).toEqual([]);
	});
	it("model an unconfigured provider", () => {
		const o = overviewFixture("unconfigured", 30, "zone");
		expect(o.provider.configured).toBe(false);
		expect(o.reputation).toBeNull();
		expect(o.quota).toBeNull();
		expect(o.suppressions.provider).toBeNull();
	});
	it("have empty variants for every section", () => {
		expect(overviewFixture("empty").sending.rates.delivery).toBeNull();
		expect(engagementFixture("empty").messages).toEqual([]);
		expect(inboundFixture("empty").received).toBe(0);
		expect(dmarcFixture("empty").totals.messages).toBe(0);
	});
	it("agree on open and click rates between overview and engagement", () => {
		const o = overviewFixture("demo", 30, "app");
		const e = engagementFixture("demo", 30);
		const opened = o.mailboxes.reduce((a, m) => a + m.opened, 0);
		const clicked = o.mailboxes.reduce((a, m) => a + m.clicked, 0);
		const delivered = o.mailboxes.reduce((a, m) => a + m.delivered, 0);
		expect(opened / delivered).toBeCloseTo(e.totals.open_rate!);
		expect(clicked / delivered).toBeCloseTo(e.totals.click_rate!);
		// The per-message list adds up to the same totals.
		expect(e.messages).toHaveLength(17);
		expect(e.totals).toMatchObject({ sent_messages: 17, delivered_messages: 16, pending_messages: 1 });
		expect(e.messages.filter((m) => m.unique_opens > 0)).toHaveLength(opened);
		expect(e.messages.filter((m) => m.clicks > 0)).toHaveLength(clicked);
		const d = dmarcFixture("demo", 30);
		expect(d.totals.spf_pass).toBeLessThan(d.totals.messages);
	});
	it("flag inbound addresses without a mailbox", () => {
		const i = inboundFixture("demo", 30);
		const jobs = i.by_address.find((a) => a.address === "jobs@tapetide.com");
		expect(jobs?.has_mailbox).toBe(false);
		expect(unownedAddressRoute("jobs@tapetide.com", false, i.rules)?.kind).toBe("catch_all");
	});
	it("reconcile the catch-all like production: 106 = 105 unknown + 1 known", () => {
		const i = inboundFixture("demo", 30);
		expect(i.reconciliation?.catch_all).toEqual({ count: 106, known_addresses: 1, unknown_addresses: 105 });
		expect(i.reconciliation?.stored_gap).toBe(3);
	});
});
