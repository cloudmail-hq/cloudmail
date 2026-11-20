// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-domain spam complaint rate and bulk-pause state, with Resume for admins.
 *
 * Used by the analytics overview and Settings → Domains. The numbers are the
 * circuit breaker's last hourly evaluation (`GET /api/v1/sending-health`).
 */

import { useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog, Pill } from "~/components/settings/settings-ui";
import { errorMessage, showToast } from "~/lib/toast";
import { formatRate, type SendingDomainHealth } from "shared/sending-health";
import { useResumeBulkSending, useSendingHealth } from "~/queries/sending-health";

function levelPill(row: SendingDomainHealth) {
	if (row.bulk_paused) return <Pill tone="warning">Bulk paused</Pill>;
	switch (row.level) {
		case "critical":
			return <Pill tone="warning">Over 0.3%</Pill>;
		case "warning":
			return <Pill tone="warning">Over 0.1%</Pill>;
		case "insufficient_volume":
			return <Pill>Low volume</Pill>;
		default:
			return <Pill tone="success">Healthy</Pill>;
	}
}

export default function SendingHealthPanel({ isAdmin, only }: { isAdmin: boolean; only?: string[] }) {
	const { data, isLoading, error } = useSendingHealth();
	const resume = useResumeBulkSending();
	const [confirm, setConfirm] = useState<string | null>(null);

	if (isLoading) return <p className="px-4 py-3 text-sm text-text-secondary">Loading sending health…</p>;
	if (error) return <p className="px-4 py-3 text-sm text-text-secondary">Sending health is unavailable right now.</p>;
	const rows = (data?.domains ?? []).filter((r) => !only || only.includes(r.domain));
	if (rows.length === 0) {
		return (
			<p className="px-4 py-3 text-sm text-text-secondary">
				No evaluation yet. Spam complaint rates are checked hourly once mail has been sent.
			</p>
		);
	}

	return (
		<>
			<ul className="divide-y divide-border">
				{rows.map((row) => (
					<li key={row.domain} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
						<div className="min-w-0 flex-1">
							<div className="flex flex-wrap items-center gap-2">
								<span className="truncate text-sm font-medium text-text-primary">{row.domain}</span>
								{levelPill(row)}
							</div>
							<p className="mt-0.5 text-xs text-text-secondary">
								Spam complaints {formatRate(row.spam_rate)} ({row.complaints} of {row.delivered} delivered, 7 days
								{row.source ? `, ${row.source}` : ""})
								{row.provider_status ? ` · Cloudflare: ${row.provider_status}` : ""}
							</p>
							{row.bulk_paused && (
								<p className="mt-0.5 text-xs text-warning-text">
									{row.paused_reason ?? "Paused"}. Sequences and template sends from this domain are on hold; one-to-one
									mail is unaffected.
								</p>
							)}
						</div>
						{isAdmin && row.bulk_paused && (
							<Button
								variant="outline"
								size="sm"
								className="min-h-11 sm:min-h-8"
								onClick={() => setConfirm(row.domain)}
								aria-label={`Resume bulk sending for ${row.domain}`}
							>
								Resume
							</Button>
						)}
					</li>
				))}
			</ul>
			<ConfirmDialog
				open={confirm !== null}
				onOpenChange={(open) => !open && setConfirm(null)}
				title={`Resume bulk sending for ${confirm ?? ""}?`}
				description="Sequences and template sends start again on the next tick. Fix what caused the complaints first: the breaker will not re-pause for 24 hours, and Gmail and Yahoo reject mail from domains that stay above 0.3%. This is recorded in the audit log."
				confirmLabel="Resume"
				destructive={false}
				pending={resume.isPending}
				onConfirm={() => {
					const domain = confirm!;
					resume.mutate(domain, {
						onSuccess: () => {
							showToast({ message: `Bulk sending resumed for ${domain}`, kind: "success" });
							setConfirm(null);
						},
						onError: (e) => showToast({ message: errorMessage(e, "Could not resume bulk sending"), kind: "error" }),
					});
				}}
			/>
		</>
	);
}
