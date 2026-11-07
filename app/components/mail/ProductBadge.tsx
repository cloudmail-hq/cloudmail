// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * A product's badge: a colour dot plus a short name.
 *
 * The colour is a dot rather than a filled pill so the text keeps the theme's
 * own contrast in light and dark regardless of the accent picked, and the name
 * is always present, so colour is never the only signal (WCAG 1.4.1).
 */

import { badgeColor, badgeLabel } from "shared/products";
import { cn } from "~/lib/utils";

export default function ProductBadge({
	product,
	className,
}: {
	product: { id: string; name: string; accentColor?: string | null };
	className?: string;
}) {
	return (
		<span
			title={product.name}
			className={cn(
				"inline-flex max-w-[11rem] shrink-0 items-center gap-1 rounded-full border border-border bg-card px-1.5 text-[11px] font-medium leading-4 text-text-primary",
				className,
			)}
		>
			<span
				aria-hidden
				className="h-1.5 w-1.5 shrink-0 rounded-full"
				style={{ backgroundColor: badgeColor(product) }}
			/>
			<span className="truncate">{badgeLabel(product.name)}</span>
		</span>
	);
}
