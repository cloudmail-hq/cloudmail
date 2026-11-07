/**
 * Swipe a mail row sideways to archive or trash it.
 *
 * Touch only: a mouse drag on a row is a text selection or the start of a
 * shift-click range, and desktop already has the hover actions. The row's
 * content moves under the finger while a coloured layer behind it says what
 * letting go will do; past the threshold (or on a flick) the row slides out and
 * the action runs.
 *
 * The drag writes `transform` straight to the DOM through refs rather than
 * through state: re-rendering a list row 60 times a second to move it is the
 * jank this avoids. React only hears about the gesture at the end.
 *
 * The thresholds and direction locking are in `~/lib/gestures`, which is tested
 * on its own.
 */

import { useCallback, useEffect, useRef } from "react";
import {
	lockAxis,
	rubberBand,
	type Axis,
	type SwipeAction,
	swipeOutcome,
	swipeThreshold,
} from "~/lib/gestures";

interface Options {
	onArchive?: () => void;
	onTrash?: () => void;
	/** Off while ticking rows, so a sideways drag never acts on a selection. */
	disabled?: boolean;
}

export function useSwipeRow({ onArchive, onTrash, disabled }: Options) {
	/** The element that moves (the row's content). */
	const contentRef = useRef<HTMLDivElement | null>(null);
	/** The coloured layer behind it. Carries `data-swipe` for styling. */
	const revealRef = useRef<HTMLDivElement | null>(null);

	const state = useRef<{
		id: number | null;
		x0: number;
		y0: number;
		axis: Axis;
		dx: number;
		width: number;
		samples: { t: number; x: number }[];
		/** Set after a horizontal drag so the click that follows is swallowed. */
		suppressClick: boolean;
	}>({
		id: null,
		x0: 0,
		y0: 0,
		axis: "undecided",
		dx: 0,
		width: 0,
		samples: [],
		suppressClick: false,
	});

	const enabled = { archive: !!onArchive, trash: !!onTrash };

	const paint = useCallback(
		(dx: number, animate: boolean) => {
			const content = contentRef.current;
			const reveal = revealRef.current;
			if (!content || !reveal) return;
			content.style.transition = animate ? "transform 200ms cubic-bezier(0.32,0.72,0,1)" : "none";
			content.style.transform = dx === 0 ? "" : `translate3d(${dx}px,0,0)`;
			const side = dx > 0 ? "archive" : dx < 0 ? "trash" : "";
			reveal.dataset.swipe = side;
			const width = state.current.width || content.offsetWidth || 1;
			reveal.dataset.armed = String(Math.abs(dx) >= swipeThreshold(width));
		},
		[],
	);

	const reset = useCallback(
		(animate = true) => {
			state.current.id = null;
			state.current.axis = "undecided";
			state.current.dx = 0;
			paint(0, animate);
		},
		[paint],
	);

	// A row recycled for another message must not keep the last one's offset.
	useEffect(() => () => reset(false), [reset]);

	const onPointerDown = (e: React.PointerEvent) => {
		if (disabled || e.pointerType !== "touch" || !e.isPrimary) return;
		const s = state.current;
		s.id = e.pointerId;
		s.x0 = e.clientX;
		s.y0 = e.clientY;
		s.axis = "undecided";
		s.dx = 0;
		s.width = contentRef.current?.offsetWidth ?? 0;
		s.samples = [{ t: e.timeStamp, x: e.clientX }];
		s.suppressClick = false;
	};

	const onPointerMove = (e: React.PointerEvent) => {
		const s = state.current;
		if (s.id !== e.pointerId) return;
		const dx = e.clientX - s.x0;
		const dy = e.clientY - s.y0;
		if (s.axis === "undecided") {
			s.axis = lockAxis(dx, dy);
			if (s.axis === "y") {
				// A scroll: let it go and forget this pointer.
				s.id = null;
				return;
			}
			if (s.axis === "x") {
				// Keep receiving moves even if the finger leaves the row.
				(e.currentTarget as Element).setPointerCapture?.(e.pointerId);
			}
		}
		if (s.axis !== "x") return;
		// A direction with no action resists instead of tracking the finger.
		const allowed = (dx > 0 && enabled.archive) || (dx < 0 && enabled.trash);
		const shown = allowed ? dx : rubberBand(dx, 24);
		s.dx = dx;
		s.samples.push({ t: e.timeStamp, x: e.clientX });
		if (s.samples.length > 5) s.samples.shift();
		paint(shown, false);
	};

	const finish = (e: React.PointerEvent, cancelled: boolean) => {
		const s = state.current;
		if (s.id !== e.pointerId) return;
		const wasSwipe = s.axis === "x";
		if (!wasSwipe) {
			s.id = null;
			return;
		}
		s.suppressClick = true;
		const first = s.samples[0];
		const last = s.samples[s.samples.length - 1];
		const velocity =
			first && last && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
		const action: SwipeAction | null = cancelled
			? null
			: swipeOutcome(s.dx, velocity, s.width || 1, enabled);
		if (!action) {
			reset(true);
			return;
		}
		// Slide the rest of the way out, then act. The list removes the row when
		// the mutation settles; if it fails, the row is still there and is reset.
		const off = (action === "archive" ? 1 : -1) * (s.width + 32);
		paint(off, true);
		s.id = null;
		window.setTimeout(() => {
			if (action === "archive") onArchive?.();
			else onTrash?.();
			// Back in place for the case the row survives (an error, or Undo).
			window.setTimeout(() => reset(false), 400);
		}, 180);
	};

	const onPointerUp = (e: React.PointerEvent) => finish(e, false);
	const onPointerCancel = (e: React.PointerEvent) => finish(e, true);

	/** Swallow the click a swipe ends with, so it does not also open the row. */
	const onClickCapture = (e: React.MouseEvent) => {
		if (state.current.suppressClick) {
			state.current.suppressClick = false;
			e.preventDefault();
			e.stopPropagation();
		}
	};

	return {
		contentRef,
		revealRef,
		handlers: {
			onPointerDown,
			onPointerMove,
			onPointerUp,
			onPointerCancel,
			onClickCapture,
		},
	};
}
