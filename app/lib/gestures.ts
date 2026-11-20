/**
 * Touch gesture maths for the mail list, kept free of React and the DOM so it
 * can be unit tested (`test/gestures.test.ts`).
 *
 * Two gestures:
 * - Swipe a row sideways: right to archive, left to trash, Gmail-style.
 * - Pull the list down from the top to refresh.
 *
 * Both have to coexist with vertical scrolling, which is the thing a finger on a
 * list is doing almost all the time. So neither commits to a direction until the
 * movement is unambiguous, and a gesture that starts vertical stays vertical.
 */

/** Movement before a direction is decided, in CSS px. Below this a tap is still a tap. */
export const AXIS_LOCK_PX = 10;
/** How far a row must travel, as a fraction of its width, to commit on release. */
export const SWIPE_COMMIT_RATIO = 0.35;
/** Or this far in px, whichever is smaller, so wide tablets don't need a long drag. */
export const SWIPE_COMMIT_MAX_PX = 160;
/** A quick flick commits from a shorter distance. px per ms. */
export const SWIPE_FLICK_VELOCITY = 0.6;
/** And has to travel at least this far, so a jitter is never a flick. */
export const SWIPE_FLICK_MIN_PX = 48;

export type Axis = "undecided" | "x" | "y";

/**
 * Decide which way a touch is going.
 *
 * Horizontal wins only when it clearly dominates (dx > 1.2 * dy), because a
 * slightly diagonal scroll is still a scroll and hijacking it into a swipe that
 * archives mail is the worst possible misreading.
 */
export function lockAxis(dx: number, dy: number): Axis {
	const ax = Math.abs(dx);
	const ay = Math.abs(dy);
	if (ax < AXIS_LOCK_PX && ay < AXIS_LOCK_PX) return "undecided";
	return ax > ay * 1.2 ? "x" : "y";
}

export type SwipeAction = "archive" | "trash";

/** Threshold for a given row width. */
export function swipeThreshold(rowWidth: number): number {
	return Math.min(rowWidth * SWIPE_COMMIT_RATIO, SWIPE_COMMIT_MAX_PX);
}

/**
 * What releasing the row here does.
 *
 * `dx` is the signed travel (positive is rightwards), `velocity` the signed
 * px/ms over the last few samples. A disabled direction (e.g. Archive in the
 * Archive folder) never commits; the row springs back instead.
 */
export function swipeOutcome(
	dx: number,
	velocity: number,
	rowWidth: number,
	enabled: { archive: boolean; trash: boolean },
): SwipeAction | null {
	const threshold = swipeThreshold(rowWidth);
	const flick =
		Math.abs(velocity) >= SWIPE_FLICK_VELOCITY &&
		Math.abs(dx) >= SWIPE_FLICK_MIN_PX &&
		Math.sign(velocity) === Math.sign(dx);
	if (dx > 0 && enabled.archive && (dx >= threshold || flick)) return "archive";
	if (dx < 0 && enabled.trash && (-dx >= threshold || flick)) return "trash";
	return null;
}

/**
 * Rubber-band a drag past what the gesture allows.
 *
 * Used for a disabled direction (the row moves a little, then resists, which
 * reads as "not here" rather than "broken") and for pull-to-refresh, which
 * should slow down as it is pulled further.
 */
export function rubberBand(distance: number, limit: number): number {
	if (limit <= 0) return 0;
	const sign = Math.sign(distance);
	const d = Math.abs(distance);
	// Approaches `limit` asymptotically; 1:1 for small d.
	return sign * (limit * (1 - 1 / (d / limit + 1)));
}

/** Pull distance (after damping) that triggers a refresh on release. */
export const PULL_TRIGGER_PX = 64;
/** The damped pull approaches this and never passes it. */
export const PULL_MAX_PX = 160;

/**
 * Damped pull distance for a raw downward finger travel.
 *
 * About 1:1 for the first few px, then resisting: the trigger point is reached
 * at roughly 107px of finger travel, which is a deliberate pull rather than the
 * overscroll at the end of a fling.
 */
export function pullDistance(rawDy: number): number {
	if (rawDy <= 0) return 0;
	return rubberBand(rawDy, PULL_MAX_PX);
}

export function pullTriggers(rawDy: number): boolean {
	return pullDistance(rawDy) >= PULL_TRIGGER_PX;
}
