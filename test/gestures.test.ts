import { describe, expect, it } from "vitest";
import {
	AXIS_LOCK_PX,
	lockAxis,
	PULL_MAX_PX,
	PULL_TRIGGER_PX,
	pullDistance,
	pullTriggers,
	rubberBand,
	swipeOutcome,
	swipeThreshold,
} from "~/lib/gestures";

const both = { archive: true, trash: true };

describe("lockAxis", () => {
	it("stays undecided inside the dead zone, so a tap is still a tap", () => {
		expect(lockAxis(0, 0)).toBe("undecided");
		expect(lockAxis(AXIS_LOCK_PX - 1, AXIS_LOCK_PX - 1)).toBe("undecided");
	});

	it("locks horizontal only when it clearly dominates", () => {
		expect(lockAxis(30, 2)).toBe("x");
		expect(lockAxis(-30, 5)).toBe("x");
		// A slightly diagonal scroll is still a scroll.
		expect(lockAxis(20, 18)).toBe("y");
		expect(lockAxis(2, 30)).toBe("y");
	});
});

describe("swipeOutcome", () => {
	const width = 390;
	const threshold = swipeThreshold(width);

	it("uses a fraction of the row, capped for wide rows", () => {
		expect(threshold).toBeCloseTo(390 * 0.35);
		expect(swipeThreshold(2000)).toBe(160);
	});

	it("archives right and trashes left past the threshold", () => {
		expect(swipeOutcome(threshold + 1, 0, width, both)).toBe("archive");
		expect(swipeOutcome(-(threshold + 1), 0, width, both)).toBe("trash");
	});

	it("springs back short of the threshold", () => {
		expect(swipeOutcome(threshold - 1, 0, width, both)).toBeNull();
		expect(swipeOutcome(-(threshold - 1), 0, width, both)).toBeNull();
	});

	it("commits a quick flick from a shorter distance, in the flick's direction only", () => {
		expect(swipeOutcome(60, 1, width, both)).toBe("archive");
		expect(swipeOutcome(-60, -1, width, both)).toBe("trash");
		// Flicking back towards the start cancels.
		expect(swipeOutcome(60, -1, width, both)).toBeNull();
		// A jitter is never a flick.
		expect(swipeOutcome(10, 2, width, both)).toBeNull();
	});

	it("never commits a disabled direction", () => {
		expect(swipeOutcome(300, 0, width, { archive: false, trash: true })).toBeNull();
		expect(swipeOutcome(-300, 0, width, { archive: true, trash: false })).toBeNull();
	});
});

describe("rubberBand", () => {
	it("is close to 1:1 for small moves and never passes the limit", () => {
		expect(rubberBand(2, 100)).toBeGreaterThan(1.9);
		expect(rubberBand(10_000, 100)).toBeLessThan(100);
		expect(rubberBand(-10_000, 100)).toBeGreaterThan(-100);
		expect(rubberBand(5, 0)).toBe(0);
	});
});

describe("pull to refresh", () => {
	it("ignores upward travel", () => {
		expect(pullDistance(-50)).toBe(0);
		expect(pullTriggers(-500)).toBe(false);
	});

	it("needs a deliberate pull, not a fling's overscroll", () => {
		expect(pullTriggers(40)).toBe(false);
		expect(pullTriggers(140)).toBe(true);
		expect(pullDistance(10_000)).toBeLessThan(PULL_MAX_PX);
		expect(PULL_TRIGGER_PX).toBeLessThan(PULL_MAX_PX);
	});
});
