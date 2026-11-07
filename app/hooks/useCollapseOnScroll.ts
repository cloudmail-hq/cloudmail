/**
 * Hide a strip of chrome while the reader scrolls a list down, and bring it
 * back on the way up or near the top. See `nextCollapse` for the hysteresis.
 *
 * Reads scroll position in a passive listener and only sets state when the
 * hidden flag actually flips, so scrolling does not re-render the list.
 */

import { type RefObject, useEffect, useRef, useState } from "react";
import { type CollapseState, nextCollapse } from "~/lib/collapse-on-scroll";

export function useCollapseOnScroll(
	scrollerRef: RefObject<HTMLElement | null>,
	enabled: boolean,
): boolean {
	const [hidden, setHidden] = useState(false);
	const state = useRef<CollapseState>({ hidden: false, lastY: 0, travel: 0 });

	useEffect(() => {
		const el = scrollerRef.current;
		if (!enabled || !el) {
			state.current = { hidden: false, lastY: 0, travel: 0 };
			setHidden(false);
			return;
		}
		state.current = { hidden: false, lastY: el.scrollTop, travel: 0 };
		const onScroll = () => {
			const next = nextCollapse(state.current, el.scrollTop);
			if (next.hidden !== state.current.hidden) setHidden(next.hidden);
			state.current = next;
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, [scrollerRef, enabled]);

	return hidden;
}
