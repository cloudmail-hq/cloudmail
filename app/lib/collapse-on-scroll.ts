/**
 * Collapsing chrome on scroll, with hysteresis. Pure so it can be unit-tested.
 *
 * Hides after the reader has scrolled down `hideAfter` px in one direction
 * (and is past `topZone`), shows again after `showAfter` px of scrolling up, or
 * whenever the list is back near the top. Small back-and-forth jitter from a
 * resting thumb never toggles it, which is what makes a naive "direction of the
 * last scroll event" version flicker.
 */

export interface CollapseState {
	hidden: boolean;
	/** Last scrollTop seen. */
	lastY: number;
	/** Distance travelled in the current direction (positive down). */
	travel: number;
}

export const COLLAPSE_DEFAULTS = { hideAfter: 24, showAfter: 16, topZone: 48 };

export function nextCollapse(
	state: CollapseState,
	y: number,
	opts: { hideAfter: number; showAfter: number; topZone: number } = COLLAPSE_DEFAULTS,
): CollapseState {
	if (y <= opts.topZone / 2) return { hidden: false, lastY: y, travel: 0 };
	const dy = y - state.lastY;
	if (dy === 0) return state;
	// Reset the run when direction flips.
	const travel = Math.sign(dy) === Math.sign(state.travel) ? state.travel + dy : dy;
	let hidden = state.hidden;
	if (!hidden && travel >= opts.hideAfter && y > opts.topZone) hidden = true;
	else if (hidden && -travel >= opts.showAfter) hidden = false;
	return { hidden, lastY: y, travel };
}

/** Pages to fetch: all of `1..page` when accumulating (load more), else just `page`. */
export function pagesToFetch(page: number, accumulate: boolean): number[] {
	const last = Math.max(1, Math.floor(page));
	if (!accumulate) return [last];
	return Array.from({ length: last }, (_, i) => i + 1);
}
