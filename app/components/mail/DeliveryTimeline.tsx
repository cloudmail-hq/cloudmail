// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The delivery timeline for a sent message, shown in the reading pane.
 *
 * A collapsible section under a message this mailbox sent: a one-line headline
 * chip ("Delivered", "Bounced", "Opened 3×") that is always visible, and the
 * full per-event timeline behind a disclosure. The events themselves are loaded
 * lazily — the query only fires when the section is expanded, so opening a
 * message costs no extra request.
 *
 * All of what a row *means* (label, tone, failure wording, click URL) is decided
 * by the pure helpers in `~/lib/delivery-timeline`; this file only maps those
 * descriptors to icons and colours.
 */

import { useState } from "react";
import {
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Clock,
	Eye,
	Loader2,
	MailCheck,
	MousePointerClick,
	Paperclip,
	TriangleAlert,
} from "lucide-react";
import {
	OPENED_CAVEAT,
	outboundState,
	outboundStatusLine,
	type EngagementFields,
} from "shared/engagement";
import { useDeliveryEvents } from "~/queries/emails";
import {
	buildDeliveryTimeline,
	headlineState,
	summarizeEngagement,
	type TimelineStep,
	type TimelineTone,
} from "~/lib/delivery-timeline";

const TONE_CLASS: Record<TimelineTone, string> = {
	pending: "text-text-tertiary",
	success: "text-emerald-600",
	engagement: "text-sky-600",
	failure: "text-destructive",
};

function StepIcon({ step }: { step: TimelineStep }) {
	const className = `mt-px shrink-0 ${TONE_CLASS[step.tone]}`;
	if (step.tone === "failure")
		return <TriangleAlert size={13} className={className} aria-hidden />;
	if (step.tone === "engagement") {
		if (step.label.startsWith("Clicked"))
			return <MousePointerClick size={13} className={className} aria-hidden />;
		if (step.label.startsWith("Downloaded"))
			return <Paperclip size={13} className={className} aria-hidden />;
		return <MailCheck size={13} className={className} aria-hidden />;
	}
	if (step.tone === "success")
		return <CheckCircle2 size={13} className={className} aria-hidden />;
	return <Clock size={13} className={className} aria-hidden />;
}

function formatTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

/** "10:42" today, "Oct 24, 10:42" otherwise. */
function formatOpenTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const today = new Date();
	const sameDay = date.toDateString() === today.toDateString();
	return date.toLocaleString(
		undefined,
		sameDay
			? { hour: "numeric", minute: "2-digit" }
			: { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
	);
}

export default function DeliveryTimeline({
	mailboxId,
	emailId,
	email,
}: {
	mailboxId: string;
	emailId: string;
	/**
	 * The message's own cached status (delivery status plus the engagement
	 * cache). When given, the collapsed header reads as one status line,
	 * "Delivered · Opened 2× · clicked 1 link · last opened 10:42", without
	 * waiting for the ledger to load.
	 */
	email?: EngagementFields;
}) {
	const [expanded, setExpanded] = useState(false);

	/**
	 * The events load whether or not the section is open.
	 *
	 * An earlier revision gated the query on `expanded` to save a request, which
	 * made the promised at-a-glance chips a lie: a freshly opened message showed
	 * only the words "Delivery details", and the reader had to expand the full
	 * timeline to learn whether their mail had arrived. The summary IS the
	 * feature, so it has to be there without being asked for.
	 *
	 * The cost is one small read per opened sent message, and only for outbound
	 * mail — `MessageView` does not render this for anything received.
	 */
	const { data: events = [], isLoading } = useDeliveryEvents(mailboxId, emailId);

	const head = headlineState(events);
	const steps = buildDeliveryTimeline(events);
	const engagement = summarizeEngagement(events);

	/**
	 * The status line, from the cache when we have it, topped up from the ledger
	 * once that has loaded (the ledger is fresher while the pane polls). The two
	 * agree by construction: the cache is recomputed from the ledger.
	 */
	const merged: EngagementFields | null = email
		? {
				...email,
				open_count: Math.max(email.open_count ?? 0, engagement.opens),
				click_count: Math.max(email.click_count ?? 0, engagement.clicks),
				delivery_status:
					head?.label === "Delivered" && email.delivery_status !== "bounced"
						? "delivered"
						: email.delivery_status,
				last_opened_at:
					[...events].reverse().find((e) => e.event_type === "opened")?.occurred_at ??
					email.last_opened_at,
			}
		: null;
	const state = merged ? outboundState(merged) : null;
	const statusLine =
		merged && state !== "failed" && state !== "bounced"
			? outboundStatusLine(merged, formatOpenTime)
			: null;
	const opened = (merged?.open_count ?? 0) > 0;

	return (
		<div className="shrink-0 border-b border-border bg-bg-muted/40 px-4 py-2">
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
				className="flex w-full items-center gap-1.5 text-[11px] font-semibold text-text-secondary hover:text-text-primary"
			>
				{expanded ? (
					<ChevronDown size={13} aria-hidden />
				) : (
					<ChevronRight size={13} aria-hidden />
				)}
				{statusLine ? (
					// One plain status line for a message that went out. The words
					// say "Opened", never "Read"; the eye carries the caveat.
					<span className="flex min-w-0 items-center gap-1.5 text-left text-xs font-normal text-text-primary/80">
						{opened && (
							<span
								role="img"
								aria-label={OPENED_CAVEAT}
								title={OPENED_CAVEAT}
								className="inline-flex shrink-0 text-violet"
							>
								<Eye size={14} strokeWidth={2} aria-hidden />
							</span>
						)}
						<span className="truncate" title={opened ? OPENED_CAVEAT : undefined}>
							{statusLine}
						</span>
						<span className="sr-only">. Show delivery details</span>
					</span>
				) : (
					<span>Delivery details</span>
				)}
				{/* Visible collapsed as well as expanded: these chips are the
				    at-a-glance answer, so hiding them behind the disclosure would
				    defeat the point of having them. Replaced by the status line
				    above when the message's cached status is available. */}
				{!statusLine && head && (
					<span
						className={`ml-1 inline-flex items-center gap-1 ${TONE_CLASS[head.tone]}`}
					>
						<StepIcon step={head} />
						<span>{head.label}</span>
					</span>
				)}
				{!statusLine &&
					(engagement.opens > 0 ||
						engagement.clicks > 0 ||
						engagement.attachmentDownloads > 0) && (
						<span className="ml-2 flex items-center gap-2 font-light text-text-tertiary">
							{engagement.opens > 0 && (
								<span>
									{engagement.opens} open{engagement.opens > 1 ? "s" : ""}
								</span>
							)}
							{engagement.clicks > 0 && (
								<span>
									{engagement.clicks} click{engagement.clicks > 1 ? "s" : ""}
								</span>
							)}
							{engagement.attachmentDownloads > 0 && (
								<span>
									{engagement.attachmentDownloads} download
									{engagement.attachmentDownloads > 1 ? "s" : ""}
								</span>
							)}
						</span>
					)}
			</button>

			{expanded && (
				<div className="mt-2 pl-1">
					{isLoading ? (
						<div className="flex items-center gap-2 text-[11px] text-text-tertiary">
							<Loader2 size={12} className="animate-spin" aria-hidden />
							Loading delivery history…
						</div>
					) : steps.length === 0 ? (
						<p className="text-[11px] font-light text-text-tertiary">
							No delivery events recorded yet. Cloudflare's delivery status is
							reconciled a few minutes after sending.
						</p>
					) : (
						<ol className="flex flex-col gap-2">
							{steps.map((step) => (
								<li key={step.key} className="flex items-start gap-2">
									<StepIcon step={step} />
									<div className="min-w-0 flex-1">
										<div className="flex items-baseline justify-between gap-2">
											<span
												className={`text-[11px] font-semibold ${TONE_CLASS[step.tone]}`}
											>
												{step.label}
											</span>
											<span className="shrink-0 text-[10px] font-light text-text-tertiary">
												{formatTime(step.at)}
											</span>
										</div>
										{step.recipient && (
											<p className="text-[10px] font-light text-text-tertiary">
												{step.recipient}
											</p>
										)}
										{step.detail && (
											<p className="mt-0.5 break-words text-[11px] font-light leading-snug text-text-secondary">
												{step.detail}
											</p>
										)}
									</div>
								</li>
							))}
						</ol>
					)}
				</div>
			)}
		</div>
	);
}
