// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { create } from "zustand";
import { persist } from "zustand/middleware";

/** What the reader asked for. `system` defers to the OS setting. */
export type ThemePreference = "light" | "dark" | "system";

/** What is actually painted. `system` has been resolved away. */
export type ResolvedTheme = "light" | "dark";

/**
 * localStorage key, shared with the blocking script in `root.tsx`.
 *
 * The script has to read the preference before first paint, which is well
 * before this module is parsed, so it cannot go through the store. Keeping the
 * key and the payload shape in one exported place is what stops the two readers
 * from drifting apart.
 */
export const THEME_STORAGE_KEY = "theme-storage";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemTheme(): ResolvedTheme {
	if (typeof window === "undefined" || !window.matchMedia) return "light";
	return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
	return preference === "system" ? systemTheme() : preference;
}

/**
 * Writes the theme to the document.
 *
 * `.dark` on <html> is what every `dark:` utility and the `.dark { … }` token
 * block in `index.css` key off. `color-scheme` is set alongside it so native
 * widgets — scrollbars, form controls, the space behind an overscroll — follow
 * too, rather than staying stubbornly light behind a dark page.
 */
function applyTheme(resolved: ResolvedTheme) {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	root.classList.toggle("dark", resolved === "dark");
	root.style.colorScheme = resolved;
}

interface ThemeStore {
	/** The stored preference, including `system`. */
	theme: ThemePreference;
	/**
	 * The preference with `system` resolved to a concrete theme.
	 *
	 * Components that need to branch on the actual appearance — the email
	 * renderer picking a stylesheet, say — want this rather than `theme`.
	 */
	resolvedTheme: ResolvedTheme;
	setTheme: (theme: ThemePreference) => void;
	/**
	 * Flips between light and dark.
	 *
	 * Toggling from `system` commits to the opposite of whatever the OS is
	 * currently showing, so a single click always visibly changes something.
	 */
	toggleTheme: () => void;
	/**
	 * Recomputes `resolvedTheme` from the current preference and applies it.
	 *
	 * Needed because `resolvedTheme` is derived state that `persist` does not
	 * restore: rehydration puts back `theme` alone, so after a reload the store
	 * holds the saved preference next to a stale default resolution. Called once
	 * after mount and again whenever the OS theme changes.
	 */
	reconcile: () => void;
}

export const useThemeStore = create<ThemeStore>()(
	persist(
		(set, get) => ({
			// `system` is the neutral default the server renders with.
			theme: "system",
			/**
			 * Seeded from the class the blocking script already wrote.
			 *
			 * `reconcile` also fixes this up, but not soon enough on its own: React
			 * runs child effects before parent ones, so `EmailIframe` builds its
			 * document before the root's `initThemeSync` gets to run. Defaulting to
			 * `light` there meant a reload with dark saved painted the message body
			 * white and then rebuilt it dark. Reading the DOM here is safe because
			 * nothing renders `resolvedTheme` on the first pass.
			 */
			resolvedTheme:
				typeof document !== "undefined" &&
				document.documentElement.classList.contains("dark")
					? "dark"
					: "light",

			setTheme: (theme) => {
				const resolved = resolveTheme(theme);
				applyTheme(resolved);
				set({ theme, resolvedTheme: resolved });
			},

			toggleTheme: () => {
				const next: ThemePreference =
					get().resolvedTheme === "dark" ? "light" : "dark";
				get().setTheme(next);
			},

			reconcile: () => {
				const resolved = resolveTheme(get().theme);
				if (resolved === get().resolvedTheme) return;
				applyTheme(resolved);
				set({ resolvedTheme: resolved });
			},
		}),
		{
			name: THEME_STORAGE_KEY,
			// Only the preference is durable. `resolvedTheme` is derived, and
			// persisting it would mean a stale value could outlive an OS change.
			//
			// Note there is deliberately no `onRehydrateStorage` hook here. With
			// synchronous storage it fires during `create`, before the `useThemeStore`
			// binding is initialised, so anything it tried to write was silently lost —
			// which left the store reporting "light" while the page was rendering dark.
			// `initThemeSync` does the reconciliation from an effect instead.
			partialize: (state) => ({ theme: state.theme }),
		},
	),
);

/**
 * Aligns the store with the restored preference and keeps it tracking the OS.
 *
 * Called once from the root component, in an effect — which is what guarantees
 * `persist` has already rehydrated and that the module bindings exist. Two jobs:
 *
 * - The initial `reconcile()` fixes the derived `resolvedTheme` after a reload,
 *   so controls reading it agree with what is actually on screen.
 * - The subscription keeps `system` live. Without it the OS setting would be
 *   sampled only at load, and flipping to dark at night would leave an open tab
 *   light until it was reloaded.
 */
export function initThemeSync(): () => void {
	if (typeof window === "undefined") return () => {};
	const reconcile = () => useThemeStore.getState().reconcile();
	reconcile();
	if (!window.matchMedia) return () => {};
	const query = window.matchMedia(DARK_QUERY);
	query.addEventListener("change", reconcile);
	return () => query.removeEventListener("change", reconcile);
}

/**
 * The script inlined into <head> to apply the theme before first paint.
 *
 * This has to run synchronously and ahead of the stylesheet's first use,
 * otherwise the page paints light and then snaps to dark — the "flash of wrong
 * theme". It is deliberately dependency-free and wrapped in try/catch, because
 * a Safari private-mode `localStorage` access throwing here would otherwise take
 * the whole document down before React ever mounts.
 *
 * The parse gets its own inner catch. The outer one already rules out a crash,
 * but it would abandon the whole function on a malformed entry — written by a
 * browser extension, or truncated by a full disk quota — and so skip applying
 * any theme at all. Failing just the preference lookup lets a corrupt entry fall
 * back to the system setting and still be honoured before first paint.
 */
export const themeInitScript = `(function(){try{
var p="system";
var raw=localStorage.getItem("${THEME_STORAGE_KEY}");
if(raw){try{var s=JSON.parse(raw);if(s&&s.state&&s.state.theme)p=s.state.theme;}catch(e){}}
var d=p==="dark"||(p==="system"&&window.matchMedia&&window.matchMedia("${DARK_QUERY}").matches);
var r=document.documentElement;
r.classList.toggle("dark",d);
r.style.colorScheme=d?"dark":"light";
}catch(e){}})();`;
