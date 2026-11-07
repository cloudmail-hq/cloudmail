// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useId } from "react";
import { cn } from "~/lib/utils";

/**
 * The cloudmail mark: an @ whose outer ring is an envelope, white on a blue
 * tile. Shown where no logo has been uploaded (Settings → Branding).
 *
 * Source of truth: the cloudmail-brand repo (`cloudmail-mark.svg`,
 * `tokens.json`). The tile is the brand gradient #2D61DA → #12309E, which
 * keeps the white glyph above 5:1 in both themes, so it needs no dark-mode
 * variant. The gradient id is per instance because the mark can render more
 * than once on a page.
 */
export function BrandMark({ className }: { className?: string }) {
	const id = `cm-tile-${useId().replace(/:/g, "")}`;
	return (
		<svg viewBox="0 0 64 64" className={cn("h-7 w-7 shrink-0", className)} aria-hidden focusable="false">
			<defs>
				<linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" stopColor="#2D61DA" />
					<stop offset="1" stopColor="#12309E" />
				</linearGradient>
			</defs>
			<rect width="64" height="64" rx="14" fill={`url(#${id})`} />
			<g fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" transform="translate(8.32 8.32) scale(0.74)">
				<path d="M39 32a8 8 0 1 1-16 0a8 8 0 1 1 16 0" strokeWidth={5} />
				<path d="M39 25V33a8.5 8.5 0 0 0 17 0V23a8 8 0 0 0-8-8H16a8 8 0 0 0-8 8V41a8 8 0 0 0 8 8H31" strokeWidth={6.5} />
			</g>
		</svg>
	);
}
