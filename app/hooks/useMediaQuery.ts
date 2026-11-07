// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useSyncExternalStore } from "react";

/**
 * Whether a CSS media query matches, kept in sync as it changes.
 *
 * `false` during SSR and the first client render (the server cannot know the
 * viewport), so layouts that branch on it render the desktop shape first.
 */
export function useMediaQuery(query: string): boolean {
	return useSyncExternalStore(
		(onChange) => {
			if (typeof window === "undefined" || !window.matchMedia) return () => {};
			const mql = window.matchMedia(query);
			mql.addEventListener("change", onChange);
			return () => mql.removeEventListener("change", onChange);
		},
		() => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false),
		() => false,
	);
}

/** Below Tailwind's `md` breakpoint, where lists load more instead of paging. */
export const MOBILE_QUERY = "(max-width: 767.98px)";

export function useIsMobile(): boolean {
	return useMediaQuery(MOBILE_QUERY);
}
