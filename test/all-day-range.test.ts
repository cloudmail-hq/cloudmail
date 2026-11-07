// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The last day of an all-day event, across a daylight-saving boundary.
 *
 * RFC 5545 §3.8.2.2 makes an all-day `DTEND` exclusive, so the last day is the one
 * before it. Computing that by subtracting 86,400,000 ms is wrong across a
 * spring-forward transition, where a local day is 23 hours: the result lands at
 * 23:00 on the day *before* the one intended, and the card renders a reversed
 * range like "9 Mar – 7 Mar".
 *
 * Exercises the real `previousDay` from `InvitationCard.tsx` rather than a copy of
 * it, under a DST-observing timezone (see `vitest.config.ts`), so the test cannot
 * pass while the shipped implementation is wrong.
 */

import { describe, expect, it } from "vitest";
import { previousDay } from "../app/components/mail/InvitationCard";

/**
 * A DST-observing zone, set for this file only.
 *
 * CI runs under UTC, where every day is exactly 24 hours — so the millisecond
 * arithmetic this replaced *passes* there. Without pinning a zone that actually
 * transitions, the test would be green on CI while the shipped behaviour is wrong,
 * which is the failure mode it exists to prevent. Set via `process.env.TZ` at
 * module load, before any `Date` is constructed, rather than globally in
 * `vitest.config.ts` where it would change every other suite's assumptions.
 */
process.env.TZ = "America/New_York";

describe("all-day last day", () => {
	it("is the previous calendar date around the spring-forward window", () => {
		// 2026-03-08 is the US spring-forward date. An all-day event on 9 March
		// carries an exclusive DTEND of 2026-03-10.
		const dtend = new Date(2026, 2, 10);
		expect(previousDay(dtend).getDate()).toBe(9);
		expect(previousDay(dtend).getMonth()).toBe(2);

		// And the transition day itself, which is the one that broke.
		expect(previousDay(new Date(2026, 2, 9)).getDate()).toBe(8);
	});

	it("does not depend on a day being 24 hours long", () => {
		/**
		 * Timezone-independent form of the regression.
		 *
		 * CI runs under UTC, where every day is 24 hours and the millisecond form
		 * happens to work — so asserting against `America/New_York` directly would
		 * pass for the wrong reason. Instead: scan a year of dates and require that
		 * `previousDay` always lands on the previous calendar date, whatever the
		 * ambient zone does. Under a DST-observing TZ the millisecond form fails this
		 * on the transition day; `previousDay` never does.
		 */
		for (let day = 0; day < 366; day += 1) {
			const date = new Date(2026, 0, 1 + day);
			const previous = previousDay(date);

			const expected = new Date(date);
			expected.setHours(0, 0, 0, 0);
			expected.setDate(expected.getDate() - 1);

			expect({
				day: previous.getDate(),
				month: previous.getMonth(),
			}).toEqual({ day: expected.getDate(), month: expected.getMonth() });
		}
	});

	it("is stable on an ordinary day", () => {
		const dtend = new Date(2026, 8, 2);
		expect(previousDay(dtend).getDate()).toBe(1);
		expect(previousDay(dtend).getMonth()).toBe(8);
	});

	it("rolls back across a month and a year boundary", () => {
		expect(previousDay(new Date(2026, 8, 1)).getMonth()).toBe(7);
		expect(previousDay(new Date(2026, 8, 1)).getDate()).toBe(31);

		const newYear = previousDay(new Date(2027, 0, 1));
		expect(newYear.getFullYear()).toBe(2026);
		expect(newYear.getMonth()).toBe(11);
		expect(newYear.getDate()).toBe(31);
	});
});
