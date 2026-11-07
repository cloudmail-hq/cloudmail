// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Small pieces shared by the AI providers settings files. */

import { MoreHorizontal } from "lucide-react";
import { forwardRef } from "react";
import { DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { Switch } from "~/components/ui/switch";
import type { Cap } from "../../../../shared/ai-providers";
import { cn } from "~/lib/utils";
import { ApiError } from "~/services/api";
import { CAP_BADGE_LABELS, capDescription, capSourceLabel, capSymbol, type CapBadgeName } from "./logic";

/**
 * 44px on touch (`touch:` = coarse pointer or below md, see app/index.css),
 * the compact size otherwise. For text buttons.
 */
export const TOUCH = "touch:h-11 touch:min-w-11";

/** Same font and size as SETTINGS_INPUT_CLASS, so selects match the inputs beside them. */
export const SELECT_CLASS =
	"h-9 w-full min-w-0 rounded-[6px] border border-border bg-card px-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-violet/40 disabled:opacity-60 aria-[invalid=true]:border-destructive/60 touch:h-11";

/** Text inputs: SETTINGS_INPUT_CLASS plus the touch height. */
export const INPUT_TOUCH = "touch:h-11";

/**
 * Radio dot: an accent ring with a filled centre when checked, a plain ring
 * otherwise. Native radios rendered as solid circles in dark mode.
 */
export const RADIO_CLASS =
	"mt-0.5 grid h-4 w-4 shrink-0 cursor-pointer appearance-none place-content-center rounded-full border-[1.5px] border-text-tertiary bg-card before:h-2 before:w-2 before:scale-0 before:rounded-full before:bg-accent before:content-[''] checked:border-accent checked:before:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/60";

/** Radio option row; the selected card takes the accent border. */
export const RADIO_ROW_CLASS =
	"flex min-h-9 cursor-pointer items-start gap-2.5 rounded-[6px] px-2.5 py-2 ring-1 ring-border hover:bg-bg-subtle has-[:checked]:bg-accent-subtle has-[:checked]:ring-2 has-[:checked]:ring-accent touch:min-h-11";

export function errorMessage(e: unknown, fallback: string): string {
	return e instanceof ApiError ? e.message : fallback;
}

/** "⋯" menu trigger: 32px on desktop, 44px on touch. */
export const MoreTrigger = forwardRef<HTMLButtonElement, { label: string; disabled?: boolean; children?: React.ReactNode }>(
	function MoreTrigger({ label, disabled, children, ...props }, ref) {
		return (
			<DropdownMenuTrigger
				ref={ref}
				aria-label={label}
				disabled={disabled}
				className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] text-text-secondary hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/60 disabled:opacity-50 touch:h-11 touch:w-11"
				{...props}
			>
				{children ?? <MoreHorizontal size={16} aria-hidden />}
			</DropdownMenuTrigger>
		);
	},
);

/** Switch in a 44px touch box; the pseudo-element widens its hit area to match. */
export function TouchSwitch(props: React.ComponentProps<typeof Switch>) {
	return (
		<span className="inline-flex shrink-0 items-center justify-center touch:h-11 touch:w-11">
			<Switch
				{...props}
				className={cn("relative touch:before:absolute touch:before:-inset-3 touch:before:content-['']", props.className)}
			/>
		</span>
	);
}

/**
 * Class for DialogContent: gives the built-in close × a 44px target on touch
 * without touching the shared dialog component.
 */
export const DIALOG_TOUCH_CLOSE =
	"touch:[&>button[type=button]:last-child]:right-2 touch:[&>button[type=button]:last-child]:top-2 touch:[&>button[type=button]:last-child]:inline-flex touch:[&>button[type=button]:last-child]:h-11 touch:[&>button[type=button]:last-child]:w-11 touch:[&>button[type=button]:last-child]:items-center touch:[&>button[type=button]:last-child]:justify-center";

/** "Tools ✓ tested". Plain when the gateway itself reported it. */
export function CapBadge({ name, cap, dims }: { name: CapBadgeName; cap: Cap; dims?: number | null }) {
	const source = capSourceLabel(cap.source);
	return (
		<span
			title={capDescription(name, cap)}
			className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] leading-4 text-text-primary ring-1 ring-inset ring-border"
		>
			<span className="sr-only">{capDescription(name, cap)}</span>
			<span aria-hidden className={cn("font-medium", cap.value === false && "text-text-secondary")}>
				{CAP_BADGE_LABELS[name]}
				{name === "embed" && dims ? ` ${dims}d` : ""}
			</span>
			{/* success and destructive are the text-contrast tokens in both themes. */}
			<span
				aria-hidden
				className={cn(
					"font-semibold",
					cap.value === true && "text-success",
					cap.value === false && "text-destructive",
					cap.value === null && "text-text-primary",
				)}
			>
				{capSymbol(cap.value)}
			</span>
			{source ? (
				<span aria-hidden className="text-text-secondary">
					{source}
				</span>
			) : null}
		</span>
	);
}
