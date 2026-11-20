// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	type ThemePreference,
	useThemeStore,
} from "~/hooks/useThemeStore";
import { cn } from "~/lib/utils";

const OPTIONS: {
	value: ThemePreference;
	label: string;
	Icon: React.ElementType;
}[] = [
	{ value: "light", label: "Light", Icon: Sun },
	{ value: "dark", label: "Dark", Icon: Moon },
	{ value: "system", label: "System", Icon: Monitor },
];

/**
 * Whether the store has caught up with the DOM.
 *
 * The theme lives in `localStorage`, so the server cannot know it. Rendering the
 * real state on the first client pass would therefore disagree with the server
 * markup and React would discard the tree. These controls render their neutral
 * state until after hydration and only then show the active theme — which is
 * safe, because the page itself was already themed by the blocking script in
 * `root.tsx` and is not waiting on this.
 */
function useHydrated() {
	const [hydrated, setHydrated] = useState(false);
	useEffect(() => setHydrated(true), []);
	return hydrated;
}

/**
 * Compact light/dark switch for the top bar.
 *
 * Two-state on purpose: a nav affordance should do the obvious thing in one
 * click. The three-way choice, including "System", lives in Settings.
 */
export function ThemeToggleButton({
	className,
	variant = "icon",
}: {
	className?: string;
	/** `row` is the full-width menu entry the top bar's phone menu uses. */
	variant?: "icon" | "row";
}) {
	const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
	const toggleTheme = useThemeStore((state) => state.toggleTheme);
	const hydrated = useHydrated();

	const isDark = hydrated && resolvedTheme === "dark";

	if (variant === "row") {
		return (
			<button
				type="button"
				onClick={toggleTheme}
				className={cn(
					"flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary",
					className,
				)}
			>
				{isDark ? (
					<Sun className="h-4 w-4" aria-hidden />
				) : (
					<Moon className="h-4 w-4" aria-hidden />
				)}
				{isDark ? "Light theme" : "Dark theme"}
			</button>
		);
	}

	return (
		<button
			type="button"
			onClick={toggleTheme}
			className={cn(
				"flex h-8 w-8 items-center justify-center rounded-[6px] text-text-secondary transition-colors duration-150 hover:bg-bg-muted hover:text-text-primary",
				className,
			)}
			// Names the destination rather than the current state: a control called
			// "Dark" is ambiguous about whether it reports or acts.
			aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
			title={isDark ? "Switch to light theme" : "Switch to dark theme"}
		>
			{isDark ? (
				<Sun className="h-4 w-4" aria-hidden />
			) : (
				<Moon className="h-4 w-4" aria-hidden />
			)}
		</button>
	);
}

/**
 * Three-way Light / Dark / System picker for the Settings page.
 *
 * A radiogroup rather than three independent buttons, because the semantics of a
 * segmented control are a single choice from a set: assistive tech should
 * announce "2 of 3", not read out three unrelated actions.
 *
 * That contract has to be earned, so the keyboard behaviour is implemented
 * rather than merely declared. A radiogroup is one stop in the tab order, and
 * arrow keys move — and, per the ARIA pattern for radios, select — within it.
 * Leaving three natively focusable buttons in place would have handed screen
 * reader users a group whose promises the widget did not keep.
 */
export function ThemePicker() {
	const theme = useThemeStore((state) => state.theme);
	const setTheme = useThemeStore((state) => state.setTheme);
	const hydrated = useHydrated();
	const refs = useRef<(HTMLButtonElement | null)[]>([]);

	// Before hydration no option is marked selected, so fall back to the first
	// one: a radiogroup with every option at tabindex -1 is unreachable entirely.
	const selectedIndex = Math.max(
		0,
		OPTIONS.findIndex((option) => option.value === theme),
	);

	function move(from: number, delta: number) {
		const next = (from + delta + OPTIONS.length) % OPTIONS.length;
		setTheme(OPTIONS[next].value);
		refs.current[next]?.focus();
	}

	function onKeyDown(event: React.KeyboardEvent, index: number) {
		switch (event.key) {
			case "ArrowRight":
			case "ArrowDown":
				event.preventDefault();
				move(index, 1);
				break;
			case "ArrowLeft":
			case "ArrowUp":
				event.preventDefault();
				move(index, -1);
				break;
			case "Home":
				event.preventDefault();
				move(-1, 1);
				break;
			case "End":
				event.preventDefault();
				move(0, -1);
				break;
		}
	}

	return (
		<div
			role="radiogroup"
			aria-label="Theme"
			className="inline-flex gap-1 rounded-[8px] bg-bg-subtle p-1 ring-1 ring-border"
		>
			{OPTIONS.map(({ value, label, Icon }, index) => {
				const active = hydrated && theme === value;
				return (
					<button
						key={value}
						ref={(node) => {
							refs.current[index] = node;
						}}
						type="button"
						role="radio"
						aria-checked={active}
						// Roving tabindex: the group is a single tab stop, and arrow keys
						// move between the options once inside it.
						tabIndex={index === selectedIndex ? 0 : -1}
						onKeyDown={(event) => onKeyDown(event, index)}
						onClick={() => setTheme(value)}
						className={cn(
							"inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1.5 text-xs font-medium transition-colors",
							"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
							active
								? "bg-card text-text-primary shadow-sm ring-1 ring-border"
								: "text-text-secondary hover:text-text-primary",
						)}
					>
						<Icon className="h-3.5 w-3.5" aria-hidden />
						{label}
					</button>
				);
			})}
		</div>
	);
}
