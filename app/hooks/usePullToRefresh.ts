/**
 * Pull the mail list down from the top to refresh it.
 *
 * Touch only, and only when the list is already scrolled to the top: anywhere
 * else a downward drag is a scroll. The browser's own pull-to-refresh (which
 * reloads the whole app) is switched off for the list with
 * `overscroll-behavior-y: contain` on the scroller, so the two never both fire.
 *
 * Like the row swipe, the drag moves the indicator through a ref, not state.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { lockAxis, PULL_TRIGGER_PX, pullDistance, pullTriggers } from "~/lib/gestures";

export function usePullToRefresh({
	onRefresh,
	disabled,
}: {
	onRefresh: () => void | Promise<unknown>;
	disabled?: boolean;
}) {
	const scrollerRef = useRef<HTMLDivElement | null>(null);
	const indicatorRef = useRef<HTMLDivElement | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const drag = useRef<{ y0: number; x0: number; active: boolean; locked: boolean; dy: number } | null>(
		null,
	);

	const paint = useCallback((distance: number, animate: boolean) => {
		const el = indicatorRef.current;
		if (!el) return;
		el.style.transition = animate ? "transform 200ms ease, opacity 200ms ease" : "none";
		el.style.transform = `translate3d(0, ${distance - 48}px, 0) rotate(${distance * 3}deg)`;
		el.style.opacity = String(Math.min(1, distance / PULL_TRIGGER_PX));
		el.dataset.armed = String(distance >= PULL_TRIGGER_PX);
	}, []);

	useEffect(() => {
		const scroller = scrollerRef.current;
		if (!scroller || disabled) return;

		const onStart = (e: TouchEvent) => {
			if (e.touches.length !== 1 || scroller.scrollTop > 0 || refreshing) {
				drag.current = null;
				return;
			}
			const t = e.touches[0];
			drag.current = { y0: t.clientY, x0: t.clientX, active: false, locked: false, dy: 0 };
		};

		const onMove = (e: TouchEvent) => {
			const d = drag.current;
			if (!d) return;
			const t = e.touches[0];
			const dy = t.clientY - d.y0;
			const dx = t.clientX - d.x0;
			if (!d.locked) {
				const axis = lockAxis(dx, dy);
				if (axis === "undecided") return;
				d.locked = true;
				// Sideways is a row swipe; upwards is a scroll. Neither is a pull.
				if (axis === "x" || dy < 0) {
					drag.current = null;
					return;
				}
				d.active = true;
			}
			if (!d.active) return;
			if (scroller.scrollTop > 0) {
				drag.current = null;
				paint(0, true);
				return;
			}
			d.dy = dy;
			// Stops the page rubber-banding under the indicator. Needs the
			// listener to be non-passive, which is why this is not a React prop.
			if (e.cancelable) e.preventDefault();
			paint(pullDistance(dy), false);
		};

		const onEnd = () => {
			const d = drag.current;
			drag.current = null;
			if (!d?.active) return;
			if (!pullTriggers(d.dy)) {
				paint(0, true);
				return;
			}
			setRefreshing(true);
			paint(PULL_TRIGGER_PX, true);
			Promise.resolve()
				.then(onRefresh)
				.catch(() => {})
				.finally(() => {
					setRefreshing(false);
					paint(0, true);
				});
		};

		scroller.addEventListener("touchstart", onStart, { passive: true });
		scroller.addEventListener("touchmove", onMove, { passive: false });
		scroller.addEventListener("touchend", onEnd);
		scroller.addEventListener("touchcancel", onEnd);
		return () => {
			scroller.removeEventListener("touchstart", onStart);
			scroller.removeEventListener("touchmove", onMove);
			scroller.removeEventListener("touchend", onEnd);
			scroller.removeEventListener("touchcancel", onEnd);
		};
	}, [disabled, onRefresh, paint, refreshing]);

	return { scrollerRef, indicatorRef, refreshing };
}
