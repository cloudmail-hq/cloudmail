// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-mailbox send caps: usage against the hourly and daily caps, the
 * Cloudflare account's daily quota (administrators), and an editor for
 * administrators. Everyone else sees the numbers read-only.
 */

import { type FormEvent, useEffect, useId, useState } from "react";
import { Gauge } from "lucide-react";
import { errorMessage, showToast } from "~/lib/toast";
import { useSendLimits, useUpdateSendLimits } from "~/queries/sending-health";

function Usage({ label, used, cap }: { label: string; used: number; cap: number }) {
	const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
	const tone = pct >= 100 ? "bg-destructive" : pct >= 80 ? "bg-warning-text" : "bg-accent";
	return (
		<div className="min-w-0">
			<div className="flex items-baseline justify-between gap-2 text-sm">
				<span className="text-text-secondary">{label}</span>
				<span className="tabular-nums text-text-primary">
					{used.toLocaleString()} / {cap.toLocaleString()}
				</span>
			</div>
			<div
				className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-muted"
				role="meter"
				aria-label={`${label}: ${used} of ${cap}`}
				aria-valuemin={0}
				aria-valuemax={cap}
				aria-valuenow={Math.min(used, cap)}
			>
				<div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
			</div>
		</div>
	);
}

export default function SendLimitsSettings({ mailboxId }: { mailboxId: string }) {
	const { data, isLoading, error } = useSendLimits(mailboxId);
	const update = useUpdateSendLimits(mailboxId);
	const [hourly, setHourly] = useState("");
	const [daily, setDaily] = useState("");
	const hourlyId = useId();
	const dailyId = useId();

	useEffect(() => {
		if (data) {
			setHourly(String(data.caps.hourly));
			setDaily(String(data.caps.daily));
		}
	}, [data?.caps.hourly, data?.caps.daily]);

	const onSubmit = (e: FormEvent) => {
		e.preventDefault();
		update.mutate(
			{ hourly: Number(hourly), daily: Number(daily) },
			{
				onSuccess: () => showToast({ message: "Send caps saved", kind: "success" }),
				onError: (err) => showToast({ message: errorMessage(err, "Could not save send caps"), kind: "error" }),
			},
		);
	};

	const dirty = !!data && (Number(hourly) !== data.caps.hourly || Number(daily) !== data.caps.daily);
	const inputClass =
		"h-11 w-full rounded-[6px] border border-border bg-card px-2.5 text-sm tabular-nums text-text-primary outline-none focus:ring-2 focus:ring-ring/30 sm:h-9";

	return (
		<section id="send-limits" className="scroll-mt-20 rounded-[8px] border border-border bg-card p-5">
			<div className="mb-4">
				<h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
					<Gauge size={15} className="text-text-tertiary" aria-hidden />
					Send caps
				</h2>
				<p className="mt-1 text-sm text-text-secondary">
					How many messages this mailbox may send, over a rolling hour and a rolling day. Every send counts:
					replies, the agent, sequences, template sends, auto-replies and forwarding.
				</p>
			</div>

			{isLoading ? <p className="text-sm text-text-secondary">Loading…</p> : null}
			{error ? <p className="text-sm text-destructive">{errorMessage(error, "Couldn't load send caps.")}</p> : null}

			{data ? (
				<div className="space-y-4">
					<div className="grid gap-4 sm:grid-cols-2">
						<Usage label="Last hour" used={data.sent_last_hour} cap={data.caps.hourly} />
						<Usage label="Last 24 hours" used={data.sent_last_day} cap={data.caps.daily} />
					</div>

					{data.account_quota ? (
						<p className="text-xs text-text-secondary">
							Cloudflare account quota: {data.account_quota.used.toLocaleString()} of{" "}
							{data.account_quota.limit.toLocaleString()} per {data.account_quota.unit} used across every sender on
							the account.
						</p>
					) : null}

					{data.editable ? (
						<form onSubmit={onSubmit} className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
							<div>
								<label htmlFor={hourlyId} className="mb-1 block text-xs font-medium text-text-secondary">
									Per hour (max {data.maxima.hourly.toLocaleString()})
								</label>
								<input
									id={hourlyId}
									type="number"
									inputMode="numeric"
									min={1}
									max={data.maxima.hourly}
									required
									value={hourly}
									onChange={(e) => setHourly(e.target.value)}
									className={inputClass}
								/>
							</div>
							<div>
								<label htmlFor={dailyId} className="mb-1 block text-xs font-medium text-text-secondary">
									Per day (max {data.maxima.daily.toLocaleString()})
								</label>
								<input
									id={dailyId}
									type="number"
									inputMode="numeric"
									min={1}
									max={data.maxima.daily}
									required
									value={daily}
									onChange={(e) => setDaily(e.target.value)}
									className={inputClass}
								/>
							</div>
							<button
								type="submit"
								disabled={!dirty || update.isPending}
								className="h-11 rounded-[6px] bg-accent px-4 text-sm font-medium text-accent-foreground hover:bg-accent-hover disabled:opacity-40 sm:h-9"
							>
								{update.isPending ? "Saving…" : "Save caps"}
							</button>
						</form>
					) : (
						<p className="text-xs text-text-tertiary">
							{data.default ? "Default caps. " : ""}An administrator can change these.
						</p>
					)}
				</div>
			) : null}
		</section>
	);
}
