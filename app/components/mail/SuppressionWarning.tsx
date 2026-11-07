// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * A warning chip in the composer when a recipient is on the suppression list.
 *
 * Informational only. A message written by hand in the composer is
 * transactional and is sent regardless: someone who unsubscribed from a drip
 * and then emails support still gets a reply. The chip exists so the person
 * writing knows the recipient opted out (or bounced) before they hit Send.
 */

import { AlertTriangle } from "lucide-react";
import { describeSuppressionReason, type SuppressionReason } from "shared/suppressions";
import { useSuppressionCheck } from "~/queries/suppressions";

export default function SuppressionWarning({
	recipients,
	from,
}: {
	recipients: string[];
	from: string;
}) {
	const { data } = useSuppressionCheck(recipients, from);
	const items = data?.items ?? [];
	if (items.length === 0) return null;

	// One chip per address; an address suppressed in two scopes shows once.
	const byAddress = new Map<string, (typeof items)[number]>();
	for (const item of items) if (!byAddress.has(item.address)) byAddress.set(item.address, item);

	return (
		<div role="status" className="flex shrink-0 flex-wrap gap-1.5 border-b border-border bg-card px-4 py-2">
			{[...byAddress.values()].map((item) => (
				<span
					key={item.address}
					className="inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-full bg-warning-bg px-2.5 py-1 text-xs text-warning-text"
					title="Messages you write are still sent. Sequences and bulk sends skip this address."
				>
					<AlertTriangle size={12} aria-hidden className="shrink-0" />
					<span className="truncate">
						{item.address}: {describeSuppressionReason(item.reason as SuppressionReason).toLowerCase()}
						{item.scope === "global" ? "" : ` (${item.scope})`}
					</span>
				</span>
			))}
		</div>
	);
}
