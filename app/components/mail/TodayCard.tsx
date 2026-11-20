// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The daily brief as a dismissible "Today" card at the top of the inbox.
 *
 * Shown only when the user has the brief turned on and the latest brief has
 * not been dismissed. Scoped to the mailbox on screen; the other mailboxes in
 * the brief are summarised as a count so nothing is hidden.
 *
 * Every string from the brief is someone else's mail or model output, rendered
 * as text nodes.
 */

import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ChevronDown, X } from "lucide-react";
import type { BriefItem, Importance, MailboxBrief } from "shared/daily-brief";
import { IMPORTANCE_LABELS } from "shared/daily-brief";
import { formatListDate } from "shared/dates";
import { useUIStore } from "~/hooks/useUIStore";
import { cn } from "~/lib/utils";
import { useAssistantPrefValues, useBrief, useDismissBrief } from "~/queries/assistant";
import { AiMark } from "./AiSummary";

function ItemRow({ item, mailboxId }: { item: BriefItem; mailboxId: string }) {
	const { selectEmail } = useUIStore();
	return (
		<li className="min-w-0">
			<Link
				to={`/mail/${encodeURIComponent(mailboxId)}/inbox`}
				onClick={() => selectEmail(item.id)}
				className="flex min-h-9 min-w-0 items-baseline gap-2 rounded-[6px] px-2 py-1 text-[13px] hover:bg-bg-muted touch:min-h-11"
			>
				<span className="w-24 shrink-0 truncate font-medium text-text-primary sm:w-36">{item.who_name || item.who || "Unknown"}</span>
				<span className="min-w-0 flex-1 truncate text-text-secondary">
					<span className="text-text-primary">{item.subject}</span>
					{item.summary_line && (
						<>
							{" – "}
							<AiMark className="mr-1 align-[-1px]" />
							{item.summary_line}
						</>
					)}
				</span>
				<span className="shrink-0 text-[11px] tabular-nums text-text-tertiary">{formatListDate(item.date)}</span>
			</Link>
		</li>
	);
}

function Section({ title, count, items, mailboxId }: { title: string; count: number; items: BriefItem[]; mailboxId: string }) {
	if (count === 0) return null;
	return (
		<div className="min-w-0">
			<h3 className="px-2 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
				{title} <span className="tabular-nums">({count})</span>
			</h3>
			<ul>
				{items.map((item) => (
					<ItemRow key={item.id} item={item} mailboxId={mailboxId} />
				))}
			</ul>
			{count > items.length && (
				<p className="px-2 pt-0.5 text-[11px] text-text-tertiary">+{count - items.length} more in your inbox</p>
			)}
		</div>
	);
}

export function TodayCard({ mailboxId }: { mailboxId: string }) {
	const prefs = useAssistantPrefValues();
	const { data } = useBrief(prefs.brief.enabled);
	const dismiss = useDismissBrief();
	const [open, setOpen] = useState(true);

	const mine: MailboxBrief | undefined = useMemo(
		() => data?.brief?.mailboxes.find((m) => m.mailbox.toLowerCase() === mailboxId.toLowerCase()),
		[data, mailboxId],
	);

	if (!prefs.brief.enabled || !data?.brief || data.dismissed || !mine) return null;
	const brief = data.brief;
	const others = brief.mailboxes.filter((m) => m !== mine && (m.newCount > 0 || m.needsReplyCount > 0));
	const empty = mine.newCount === 0 && mine.needsReplyCount === 0 && mine.waitingOnCount === 0;

	return (
		<section aria-labelledby="today-card-title" className="border-b border-border bg-card px-3 py-2 md:px-4">
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={() => setOpen((o) => !o)}
					aria-expanded={open}
					aria-controls="today-card-body"
					className="-ml-1 inline-flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-[6px] px-1 text-left hover:bg-bg-muted touch:min-h-11"
				>
					<span id="today-card-title" className="text-sm font-semibold text-text-primary">
						Today
					</span>
					<span className="truncate text-xs text-text-secondary">
						{brief.dateLabel} · {mine.newCount} new · {mine.needsReplyCount} to reply · {mine.waitingOnCount} waiting
					</span>
					<ChevronDown
						size={14}
						className={cn("ml-auto shrink-0 text-text-tertiary transition-transform", !open && "-rotate-90")}
						aria-hidden
					/>
				</button>
				<button
					type="button"
					onClick={() => dismiss.mutate(brief.id)}
					aria-label="Dismiss today's brief"
					title="Dismiss"
					className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary hover:bg-bg-muted hover:text-text-primary touch:h-11 touch:w-11"
				>
					<X size={15} />
				</button>
			</div>

			{open && (
				<div id="today-card-body" className="pb-1">
					{empty ? (
						<p className="px-2 py-2 text-[13px] text-text-secondary">Nothing new since yesterday. Enjoy the quiet.</p>
					) : (
						<div className="grid min-w-0 gap-x-6 2xl:grid-cols-2">
							<div className="min-w-0">
								{(["important", "people", "updates"] as Importance[]).map((imp) => (
									<Section
										key={imp}
										title={`New · ${IMPORTANCE_LABELS[imp]}`}
										count={mine.newCounts?.[imp] ?? mine.newByImportance[imp].length}
										items={mine.newByImportance[imp].slice(0, 4)}
										mailboxId={mailboxId}
									/>
								))}
							</div>
							<div className="min-w-0">
								<Section title="Needs your reply" count={mine.needsReplyCount} items={mine.needsReply.slice(0, 4)} mailboxId={mailboxId} />
								<Section title="Waiting on others" count={mine.waitingOnCount} items={mine.waitingOn.slice(0, 4)} mailboxId={mailboxId} />
								{mine.topSenders.length > 0 && (
									<p className="px-2 pt-2 text-[12px] text-text-secondary">
										<span className="font-semibold text-text-tertiary">Top senders: </span>
										{mine.topSenders.map((s) => `${s.name || s.address} (${s.count})`).join(", ")}
									</p>
								)}
							</div>
						</div>
					)}
					{others.length > 0 && (
						<p className="px-2 pt-2 text-[12px] text-text-tertiary">
							Also in your brief:{" "}
							{others.map((m, i) => (
								<span key={m.mailbox}>
									{i > 0 && ", "}
									<Link className="underline-offset-2 hover:underline" to={`/mail/${encodeURIComponent(m.mailbox)}/inbox`}>
										{m.mailbox}
									</Link>{" "}
									({m.newCount} new)
								</span>
							))}
						</p>
					)}
				</div>
			)}
		</section>
	);
}
