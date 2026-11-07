import { describe, expect, it } from "vitest";
import {
	formatSnoozeReturn,
	resolveMessageDate,
	snoozePresets,
} from "../shared/dates";

const RECEIVED = new Date("2026-08-14T12:00:00.000Z");

describe("resolveMessageDate", () => {
	it("prefers the sender's Date header over receive time", () => {
		// A message composed Monday but delivered to us Wednesday must sort
		// under Monday, otherwise delayed mail jumps to the top of the inbox.
		expect(resolveMessageDate("Mon, 10 Aug 2026 09:30:00 +0000", RECEIVED)).toBe(
			"2026-08-10T09:30:00.000Z",
		);
	});

	it("normalises non-UTC offsets", () => {
		expect(resolveMessageDate("Mon, 10 Aug 2026 09:30:00 +0530", RECEIVED)).toBe(
			"2026-08-10T04:00:00.000Z",
		);
	});

	it("accepts a Date instance (postal-mime may hand back either)", () => {
		expect(
			resolveMessageDate(new Date("2026-08-10T09:30:00.000Z"), RECEIVED),
		).toBe("2026-08-10T09:30:00.000Z");
	});

	it("falls back to receive time when the header is absent", () => {
		expect(resolveMessageDate(undefined, RECEIVED)).toBe(RECEIVED.toISOString());
		expect(resolveMessageDate(null, RECEIVED)).toBe(RECEIVED.toISOString());
		expect(resolveMessageDate("", RECEIVED)).toBe(RECEIVED.toISOString());
	});

	it("falls back when the header is unparseable", () => {
		expect(resolveMessageDate("not a date", RECEIVED)).toBe(
			RECEIVED.toISOString(),
		);
		expect(resolveMessageDate(new Date("garbage"), RECEIVED)).toBe(
			RECEIVED.toISOString(),
		);
	});

	it("rejects far-future dates used to pin messages to the top of the inbox", () => {
		expect(resolveMessageDate("Fri, 01 Jan 2100 00:00:00 +0000", RECEIVED)).toBe(
			RECEIVED.toISOString(),
		);
	});

	it("tolerates modest clock skew rather than discarding it", () => {
		// 6h ahead is ordinary client clock drift, not an attack.
		const skewed = "2026-08-14T18:00:00.000Z";
		expect(resolveMessageDate(skewed, RECEIVED)).toBe(skewed);
	});

	it("rejects implausibly old dates", () => {
		expect(resolveMessageDate("Tue, 01 Jan 1980 00:00:00 +0000", RECEIVED)).toBe(
			RECEIVED.toISOString(),
		);
	});
});

describe("snoozePresets", () => {
	/** Local-time constructor, since the presets deal in wall-clock hours. */
	const at = (
		year: number,
		month: number,
		day: number,
		hour: number,
		minute = 0,
	) => new Date(year, month - 1, day, hour, minute, 0, 0);

	const ids = (now: Date) => snoozePresets(now).map((p) => p.id);

	it("always offers tomorrow and next week", () => {
		// Wednesday 2026-08-12, mid-morning.
		expect(ids(at(2026, 8, 12, 10))).toContain("tomorrow");
		expect(ids(at(2026, 8, 12, 10))).toContain("next_week");
	});

	it("resolves tomorrow to 9am the following day", () => {
		const [tomorrow] = snoozePresets(at(2026, 8, 12, 10)).filter(
			(p) => p.id === "tomorrow",
		);
		expect(tomorrow.at).toEqual(at(2026, 8, 13, 9));
	});

	it("offers later today as a three-hour nudge", () => {
		const [later] = snoozePresets(at(2026, 8, 12, 10)).filter(
			(p) => p.id === "later_today",
		);
		expect(later.at).toEqual(at(2026, 8, 12, 13));
	});

	it("drops later today once it is too late to be meaningful", () => {
		// 21:00 — a "later today" would be nearly midnight.
		expect(ids(at(2026, 8, 12, 21))).not.toContain("later_today");
	});

	it("keeps later today inside the current day at the cutoff", () => {
		// 19:59 is the latest qualifying moment; +3h must not roll past midnight.
		const now = at(2026, 8, 12, 19, 59);
		const [later] = snoozePresets(now).filter((p) => p.id === "later_today");
		expect(later.at.getDate()).toBe(now.getDate());
	});

	it("offers this weekend on a weekday, pointing at Saturday", () => {
		const [weekend] = snoozePresets(at(2026, 8, 12, 10)).filter(
			(p) => p.id === "this_weekend",
		);
		// Wednesday the 12th -> Saturday the 15th.
		expect(weekend.at).toEqual(at(2026, 8, 15, 9));
	});

	it("omits this weekend once the weekend has arrived", () => {
		// Saturday 2026-08-15 and Sunday the 16th.
		expect(ids(at(2026, 8, 15, 10))).not.toContain("this_weekend");
		expect(ids(at(2026, 8, 16, 10))).not.toContain("this_weekend");
	});

	it("points next week at the coming Monday, never today", () => {
		// From Monday the 10th, "next week" must mean the 17th, not right now.
		const [nextWeek] = snoozePresets(at(2026, 8, 10, 10)).filter(
			(p) => p.id === "next_week",
		);
		expect(nextWeek.at).toEqual(at(2026, 8, 17, 9));
	});

	it("never returns a preset in the past", () => {
		const now = at(2026, 8, 12, 19, 59);
		for (const preset of snoozePresets(now)) {
			expect(preset.at.getTime()).toBeGreaterThan(now.getTime());
		}
	});
});

describe("formatSnoozeReturn", () => {
	const now = new Date(2026, 7, 12, 10, 0, 0, 0);

	it("describes a same-day return by time alone", () => {
		const later = new Date(2026, 7, 12, 13, 0, 0, 0);
		expect(formatSnoozeReturn(later.toISOString(), now)).toMatch(/^Returns \d/);
	});

	it("includes the weekday for a later date", () => {
		const nextDay = new Date(2026, 7, 13, 9, 0, 0, 0);
		expect(formatSnoozeReturn(nextDay.toISOString(), now)).toMatch(
			/^Returns \w{3}, /,
		);
	});

	it("reports an elapsed deadline as imminent rather than overdue", () => {
		const past = new Date(2026, 7, 12, 9, 0, 0, 0);
		expect(formatSnoozeReturn(past.toISOString(), now)).toBe("Returns soon");
	});

	it("degrades gracefully without a timestamp", () => {
		expect(formatSnoozeReturn(null, now)).toBe("Snoozed");
		expect(formatSnoozeReturn(undefined, now)).toBe("Snoozed");
		expect(formatSnoozeReturn("not a date", now)).toBe("Snoozed");
	});
});
