import { describe, expect, it } from "vitest";
import {
	COLLAPSE_DEFAULTS,
	type CollapseState,
	nextCollapse,
	pagesToFetch,
} from "~/lib/collapse-on-scroll";

const start: CollapseState = { hidden: false, lastY: 0, travel: 0 };

/** Feed a sequence of scroll positions and return the final state. */
function run(ys: number[], from: CollapseState = start): CollapseState {
	return ys.reduce((s, y) => nextCollapse(s, y), from);
}

describe("nextCollapse", () => {
	it("hides after a sustained scroll down past the top zone", () => {
		const s = run([10, 40, 70, 100]);
		expect(s.hidden).toBe(true);
	});

	it("does not hide inside the top zone, however far the run", () => {
		const s = run([5, 10, 15, 20]);
		expect(s.hidden).toBe(false);
	});

	it("ignores small jitter from a resting thumb", () => {
		// Down past the zone without the run reaching `hideAfter` in one direction.
		const s = run([70, 65, 75, 70, 80], { hidden: false, lastY: 60, travel: 0 });
		expect(s.hidden).toBe(false);
	});

	it("shows again after scrolling up by showAfter", () => {
		const hidden = run([100, 200, 300]);
		expect(hidden.hidden).toBe(true);
		expect(nextCollapse(hidden, 300 - (COLLAPSE_DEFAULTS.showAfter - 1)).hidden).toBe(true);
		expect(run([290, 280], hidden).hidden).toBe(false);
	});

	it("always shows near the top", () => {
		const hidden = run([100, 200, 300]);
		expect(nextCollapse(hidden, 0).hidden).toBe(false);
	});

	it("returns the same state when nothing moved", () => {
		const s = run([100, 200]);
		expect(nextCollapse(s, 200)).toBe(s);
	});
});

describe("pagesToFetch", () => {
	it("is just the current page when paging", () => {
		expect(pagesToFetch(3, false)).toEqual([3]);
	});

	it("is every page so far when accumulating", () => {
		expect(pagesToFetch(3, true)).toEqual([1, 2, 3]);
	});

	it("never goes below page 1", () => {
		expect(pagesToFetch(0, true)).toEqual([1]);
		expect(pagesToFetch(-2, false)).toEqual([1]);
	});
});
