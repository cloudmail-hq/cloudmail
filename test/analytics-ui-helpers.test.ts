/**
 * Helpers behind the analytics polish pass: pass/none/fail auth bars, the
 * engagement attribution check, partial-day marking, empty-series hiding,
 * KPI subtitles and the suppression time scope.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	authSegments,
	catchAllBreakdown,
	countWithUnit,
	knownUnroutedAddresses,
	rejectionBreakdown,
	sortEngagementMessages,
	unitNoun,
	unownedRows,
	engagementAttribution,
	engagementBase,
	nonEmptySeries,
	ofTotal,
	partialDayIndex,
	plural,
	suppressionScope,
} from "~/components/analytics/format";
import { engagementFixture, FIXTURE_NOW, inboundFixture } from "~/components/analytics/fixtures";

describe("plural", () => {
	it("uses the singular for exactly one", () => {
		expect(plural(1, "message")).toBe("1 message");
		expect(plural(0, "message")).toBe("0 messages");
		expect(plural(12, "open")).toBe("12 opens");
		expect(plural(1284, "address", "addresses")).toBe("1,284 addresses");
	});
});

describe("ofTotal", () => {
	it("spells out numerator and denominator", () => {
		expect(ofTotal(1, 14)).toBe("1 of 14");
		expect(ofTotal(699, 699, "delivered")).toBe("699 of 699 delivered");
	});
});

describe("authSegments", () => {
	it("leaves DMARC none out of the headline pass rate", () => {
		// Live tapetide.com, 30 days: 1,825 none, 270 pass, 1 fail.
		const a = authSegments({ none: 1825, pass: 270, fail: 1 });
		expect(a.total).toBe(2096);
		expect(a.evaluated).toBe(271);
		expect(a.passRate).toBeCloseTo(270 / 271);
		expect(a.segments.map((s) => [s.kind, s.count])).toEqual([
			["pass", 270],
			["none", 1825],
			["fail", 1],
		]);
	});
	it("groups every non-pass, non-none verdict as fail", () => {
		const a = authSegments({ pass: 2085, permerror: 3, temperror: 3, none: 2, fail: 2, softfail: 1 });
		const fail = a.segments.find((s) => s.kind === "fail")!;
		expect(fail.count).toBe(9);
		expect(fail.verdicts.map((v) => v.verdict)).toEqual(["permerror", "temperror", "fail", "softfail"]);
		expect(a.passRate).toBeCloseTo(2085 / 2094);
	});
	it("has no rate when nothing was evaluated", () => {
		expect(authSegments({ none: 5 }).passRate).toBeNull();
		expect(authSegments({}).total).toBe(0);
		expect(authSegments(null).segments.every((s) => s.count === 0)).toBe(true);
	});
});

describe("engagementAttribution", () => {
	const totals = { opens: 12, clicks: 3 };
	it("is missing when every row is null", () => {
		expect(engagementAttribution(totals, [{ opens: null, clicks: null }])).toBe("missing");
	});
	it("is missing when rows are zero but totals are not (live state)", () => {
		expect(engagementAttribution(totals, [{ opens: 0, clicks: 0 }, { opens: 0, clicks: 0 }])).toBe("missing");
	});
	it("is ok when the rows carry the counts, or there is nothing to explain", () => {
		expect(engagementAttribution(totals, [{ opens: 12, clicks: 3 }])).toBe("ok");
		expect(engagementAttribution({ opens: 0, clicks: 0 }, [{ opens: 0, clicks: 0 }])).toBe("ok");
		expect(engagementAttribution(totals, [])).toBe("ok");
	});
	it("matches the fixtures", () => {
		const demo = engagementFixture("demo", 30);
		expect(engagementAttribution(demo.totals, demo.messages)).toBe("ok");
		const un = engagementFixture("unattributed", 30);
		expect(engagementAttribution(un.totals, un.messages)).toBe("missing");
	});
});

describe("engagementBase", () => {
	it("prefers delivered_messages when the Worker sends it", () => {
		expect(engagementBase({ unique_opens: 1, unique_clicks: 1, open_rate: 0.5, click_rate: 0.5, delivered_messages: 14 })).toBe(14);
	});
	it("recovers the denominator from count and rate", () => {
		expect(engagementBase({ unique_opens: 1, unique_clicks: 1, open_rate: 1 / 14, click_rate: 1 / 14 })).toBe(14);
		expect(engagementBase({ unique_opens: 0, unique_clicks: 2, open_rate: 0, click_rate: 0.2 })).toBe(10);
	});
	it("is null when it can't be known", () => {
		expect(engagementBase({ unique_opens: 0, unique_clicks: 0, open_rate: 0, click_rate: 0 })).toBeNull();
		expect(engagementBase({ unique_opens: 0, unique_clicks: 0, open_rate: null, click_rate: null })).toBeNull();
	});
});

describe("partialDayIndex", () => {
	it("finds today's UTC bucket", () => {
		const dates = ["2026-10-24", "2026-10-25", "2026-10-26"];
		expect(partialDayIndex(dates, FIXTURE_NOW)).toBe(2);
		expect(partialDayIndex(dates, Date.parse("2026-10-27T00:30:00Z"))).toBe(-1);
		expect(partialDayIndex([], FIXTURE_NOW)).toBe(-1);
	});
});

describe("nonEmptySeries", () => {
	const rows = [{ a: 1, b: 0 }, { a: 2, b: 0 }];
	const series = [
		{ key: "a", value: (r: (typeof rows)[number]) => r.a },
		{ key: "b", value: (r: (typeof rows)[number]) => r.b },
	];
	it("drops series with nothing in the window", () => {
		expect(nonEmptySeries(rows, series).map((s) => s.key)).toEqual(["a"]);
	});
	it("keeps the first series when everything is empty", () => {
		expect(nonEmptySeries([{ a: 0, b: 0 }], series).map((s) => s.key)).toEqual(["a"]);
	});
});

describe("suppressionScope", () => {
	it("defaults to all time when the Worker sends no window", () => {
		expect(suppressionScope(undefined)).toBe("all_time");
		expect(suppressionScope(null)).toBe("all_time");
		expect(suppressionScope("all_time")).toBe("all_time");
		expect(suppressionScope({ all_time: true })).toBe("all_time");
	});
	it("is the period when a window is given", () => {
		expect(suppressionScope({ days: 30 })).toBe("period");
		expect(suppressionScope({ start: "2026-09-26T00:00:00Z", end: "2026-10-26T00:00:00Z" })).toBe("period");
		expect(suppressionScope("period")).toBe("period");
	});
});

describe("analytics markup", () => {
	const src = (f: string) => readFileSync(new URL(`../app/components/analytics/${f}`, import.meta.url), "utf8");
	it("has no hard-coded plural bugs", () => {
		for (const f of ["sections.tsx", "sending.tsx"]) {
			expect(src(f)).not.toMatch(/sent messages,/);
			expect(src(f)).not.toMatch(/\{formatCount\([^)]*\)\} messages,/);
		}
	});
	it("doesn't dim text with opacity below what keeps 4.5:1", () => {
		// opacity-60 took secondary text to 3.6:1 on the dark card; 40% to 2.2:1.
		for (const f of ["primitives.tsx", "sections.tsx", "sending.tsx", "charts.tsx"]) {
			expect(src(f)).not.toMatch(/opacity-(40|50|60)\b/);
		}
	});
	it("keeps chart axis text at 12px or more", () => {
		expect(src("charts.tsx")).not.toMatch(/text-\[(9|10|11)px\]/);
	});
});

describe("units", () => {
	it("names the unit, singular for one", () => {
		expect(countWithUnit(18, "recipients")).toBe("18 recipients");
		expect(countWithUnit(1, "messages")).toBe("1 message");
		expect(countWithUnit(1, "addresses")).toBe("1 address");
		expect(unitNoun(undefined)).toBe("messages");
	});
});

describe("catch-all reconciliation", () => {
	const i = inboundFixture("demo", 30);
	it("splits the catch-all into no-mailbox and known-but-unrouted", () => {
		expect(catchAllBreakdown(i.rules, i.reconciliation?.catch_all)).toMatchObject({ total: 106, unknown: 105, known: 1 });
		// Without the Worker's block, the rule's own per-address split gives the same.
		expect(catchAllBreakdown(i.rules, null)).toMatchObject({ total: 106, unknown: 105, known: 1 });
	});
	it("the no-mailbox banner sums to the catch-all's unknown count (was 102 vs 106)", () => {
		const rows = unownedRows(i.by_address, i.rules);
		expect(rows.reduce((a, r) => a + r.count, 0)).toBe(105);
		// manish@ has its own forward rule, but its 3 catch-all hits still count.
		expect(rows.find((r) => r.address === "manish@tapetide.com")?.count).toBe(3);
		expect(rows.some((r) => r.address === "tech@tapetide.com")).toBe(false);
	});
	it("flags addresses with a mailbox but no routing rule", () => {
		expect(knownUnroutedAddresses(i.rules)).toEqual([
			{ address: "tech@tapetide.com", count: 1, destination: "forward@example.net", via: "catch_all" },
		]);
		// "issues": manish@ also has a mailbox: its forward rule and catch-all hits both miss it.
		const issues = inboundFixture("issues", 30);
		expect(knownUnroutedAddresses(issues.rules).map((r) => [r.address, r.count])).toEqual([
			["manish@tapetide.com", 7],
			["tech@tapetide.com", 1],
		]);
	});
	it("an address with a worker rule is routed, whatever else it matched", () => {
		const rules = [
			{ matcher: "a@x.com", action: "worker", destination: null, enabled: true },
			{ matcher: "*@x.com", action: "forward", destination: "me@y.com", enabled: true, catch_all: true, addresses: [{ address: "a@x.com", count: 2, has_mailbox: true }] },
		];
		expect(knownUnroutedAddresses(rules)).toEqual([]);
	});
	it("a catch-all to the Worker routes every address", () => {
		const rules = [
			{ matcher: "*@x.com", action: "worker", destination: null, enabled: true, catch_all: true },
			{ matcher: "a@x.com", action: "forward", destination: "me@y.com", enabled: true, addresses: [{ address: "a@x.com", count: 2, has_mailbox: true }] },
		];
		expect(knownUnroutedAddresses(rules)).toEqual([]);
	});
});

describe("sortEngagementMessages", () => {
	const rows = [
		{ id: "new", sent_at: "2026-10-26T00:00:00Z", opens: 0, clicks: 0 },
		{ id: "opened", sent_at: "2026-10-10T00:00:00Z", opens: 3, clicks: 0 },
		{ id: "clicked", sent_at: "2026-10-07T00:00:00Z", opens: 12, clicks: 3 },
	];
	it("puts engaged messages first by default", () => {
		expect(sortEngagementMessages(rows, "activity").map((r) => r.id)).toEqual(["clicked", "opened", "new"]);
	});
	it("can sort newest first", () => {
		expect(sortEngagementMessages(rows, "newest").map((r) => r.id)).toEqual(["new", "opened", "clicked"]);
	});
	it("surfaces the production engaged message in the first 10", () => {
		const e = engagementFixture("demo", 30);
		const top = sortEngagementMessages(e.messages, "activity").slice(0, 10);
		expect(top[0].opens).toBe(12);
	});
});

describe("rejectionBreakdown", () => {
	it("explains rejected vs SPF fail counts", () => {
		const b = rejectionBreakdown({ pass: 2085, fail: 2, none: 2, permerror: 3, temperror: 3, softfail: 1 }, 2);
		expect(b).toEqual({
			rejected: 2,
			spfFail: 2,
			passedThrough: [
				{ verdict: "softfail", count: 1 },
				{ verdict: "temperror", count: 3 },
				{ verdict: "permerror", count: 3 },
			],
		});
	});
});
