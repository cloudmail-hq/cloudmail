// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Delivery and engagement status for mail this mailbox sent.
 *
 * `SentStatusIcon` is the compact mark on a list row, the way chat and modern
 * mail clients show it: a clock while sending, one check when handed to the
 * provider, two once the recipient's server accepted it, two in the accent
 * colour plus an eye once the tracking image loaded, and a link once a tracked
 * link was clicked. Failures keep the existing red triangle in `MailList`.
 *
 * Everything it says comes from `shared/engagement.ts`, which the MCP tools use
 * too. "Opened" is never called "Read": an image load is not proof of reading.
 */

import { Check, CheckCheck, Clock, Eye, Link2 } from "lucide-react";
import {
	OPENED_CAVEAT,
	outboundState,
	outboundStatusDescription,
	type EngagementFields,
} from "shared/engagement";
import { cn } from "~/lib/utils";

export function SentStatusIcon({
	email,
	className,
}: {
	email: EngagementFields;
	className?: string;
}) {
	const state = outboundState(email);
	// Failures are drawn by the list's existing destructive marker.
	if (state === "failed" || state === "bounced") return null;

	const description = outboundStatusDescription(email);
	const engaged = state === "opened" || state === "clicked";
	const title = engaged ? `${description} ${OPENED_CAVEAT}` : description;

	return (
		<span
			role="img"
			aria-label={description}
			title={title}
			className={cn(
				"inline-flex shrink-0 items-center gap-1",
				// `violet` is the accent's marker token: identical in light mode and
				// a lighter indigo on dark surfaces, where the button accent is dim.
				engaged ? "text-violet" : "text-text-secondary",
				className,
			)}
		>
			{state === "queued" && <Clock size={14} strokeWidth={2} aria-hidden />}
			{state === "sent" && <Check size={14} strokeWidth={2} aria-hidden />}
			{(state === "delivered" || engaged) && (
				<CheckCheck size={15} strokeWidth={2} aria-hidden />
			)}
			{engaged && <Eye size={14} strokeWidth={2} aria-hidden />}
			{state === "clicked" && <Link2 size={14} strokeWidth={2} aria-hidden />}
		</span>
	);
}
