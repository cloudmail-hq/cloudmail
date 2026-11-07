// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * App-wide deliverability warning.
 *
 * Shown under the top bar when a sending domain's 7-day spam complaint rate is
 * above 0.1%, or when the circuit breaker paused its bulk sends at 0.3%. One
 * line per domain; the link goes to the analytics overview, where an administrator
 * can resume. Dismissal is per session and per state, so a domain that gets
 * worse shows again.
 */

import { useState } from "react";
import { Link } from "react-router";
import { AlertTriangle, X } from "lucide-react";
import { formatRate, needsAttention } from "shared/sending-health";
import { useSendingHealth } from "~/queries/sending-health";

const DISMISS_KEY = "deliverability-banner-dismissed";

function readDismissed(): string | null {
	try {
		return sessionStorage.getItem(DISMISS_KEY);
	} catch {
		return null;
	}
}

export default function DeliverabilityBanner() {
	const { data } = useSendingHealth();
	const [dismissed, setDismissed] = useState<string | null>(() => (typeof window === "undefined" ? null : readDismissed()));

	const flagged = (data?.domains ?? []).filter(needsAttention);
	if (flagged.length === 0) return null;
	// The signature of what is shown: dismissing hides exactly this state.
	const signature = flagged.map((d) => `${d.domain}:${d.level}:${d.bulk_paused ? 1 : 0}`).join("|");
	if (dismissed === signature) return null;

	const anyPaused = flagged.some((d) => d.bulk_paused);
	return (
		<div
			role={anyPaused ? "alert" : "status"}
			className="flex items-start gap-3 border-b border-warning-border bg-warning-bg px-4 py-2 text-sm text-warning-text"
		>
			<AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			<div className="min-w-0 flex-1 space-y-0.5">
				{flagged.map((d) => (
					<p key={d.domain}>
						<span className="font-medium">{d.domain}</span>
						{d.bulk_paused ? (
							<>: bulk sending is paused ({d.paused_reason ?? `spam rate ${formatRate(d.spam_rate)}`}). One-to-one mail still goes out.</>
						) : (
							<>: spam complaint rate is {formatRate(d.spam_rate)} over 7 days. Gmail and Yahoo start rejecting above 0.3%.</>
						)}
					</p>
				))}
				<Link to="/analytics#sending-health" className="inline-block font-medium underline underline-offset-2">
					Review sending health
				</Link>
			</div>
			<button
				type="button"
				onClick={() => {
					setDismissed(signature);
					try {
						sessionStorage.setItem(DISMISS_KEY, signature);
					} catch {
						/* private mode: dismiss for this render only */
					}
				}}
				className="-m-2 inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-black/5 dark:hover:bg-white/10"
				aria-label="Dismiss deliverability warning"
			>
				<X className="size-4" aria-hidden="true" />
			</button>
		</div>
	);
}
