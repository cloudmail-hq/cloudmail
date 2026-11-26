/**
 * The daily brief as a dismissible "Today" card at the top of the inbox.
 *
 * Shown only when the user has the brief turned on and the latest brief has
 * not been dismissed. Scoped to the mailbox on screen; the other mailboxes in
 * the brief are linked so nothing is hidden.
 *
 * It starts as one line: the counts. Opening it (the title, or a count) shows
 * one short list at a time, and the choice is remembered per device, like the
 * summary card in the reader.
 *
 * Every string from the brief is someone else's mail or model output, rendered
 * as text nodes.
 */

import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ChevronDown, X } from "lucide-react";
import type { BriefItem, MailboxBrief } from "shared/daily-brief";
import { formatListDate } from "shared/dates";
import { BriefIcon, SummaryIcon } from "~/components/ai-icons";
import { useUIStore } from "~/hooks/useUIStore";
import { cn } from "~/lib/utils";
import { useAssistantPrefValues, useBrief, useDismissBrief } from "~/queries/assistant";

export const TODAY_OPEN_KEY = "tt.today.open";

/** Rows shown per list; the rest are a count, and one click away in the inbox. */
const ROWS = 5;

type TabId = "new" | "reply" | "waiting";

interface Row extends BriefItem {
	important?: boolean;
}

interface Tab {
	id: TabId;
	/** After the count: "6 new", "3 to reply". */
	label: string;
	count: number;
	rows: Row[];
}

function readOpen(): boolean {
	if (typeof window === "undefined") return false;
	try {
		return window.localStorage.getItem(TODAY_OPEN_KEY) === "1";
	} catch {
		return false;
	}
}

function writeOpen(open: boolean) {
	try {
		window.localStorage.setItem(TODAY_OPEN_KEY, open ? "1" : "0");
	} catch {
		// Private mode: remember for this session only.
	}
}

function tabsOf(mine: MailboxBrief): Tab[] {
	const by = mine.newByImportance;
	return [
		{
			id: "new",
			label: "new",
			count: mine.newCount,
			rows: [...by.important.map((item) => ({ ...item, important: true })), ...by.people, ...by.updates],
		},
		{ id: "reply", label: "to reply", count: mine.needsReplyCount, rows: mine.needsReply },
		{ id: "waiting", label: "waiting", count: mine.waitingOnCount, rows: mine.waitingOn },
	];
}

function ItemRow({ item, mailboxId }: { item: Row; mailboxId: string }) {
	const { selectEmail } = useUIStore();
	return (
		<li className="min-w-0">
			{/* Phones: name and date on one line, the subject and summary under it. */}
			<Link
				to={`/mail/${encodeURIComponent(mailboxId)}/inbox`}
				onClick={() => selectEmail(item.id)}
				className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 rounded-[8px] px-2.5 py-1.5 hover:bg-bg-muted sm:grid-cols-[10rem_minmax(0,1fr)_auto] touch:min-h-11"
			>
				<span className={cn("truncate text-[13px] text-text-primary", item.unread ? "font-semibold" : "font-medium")}>
					{item.who_name || item.who || "Unknown"}
				</span>
				<span className="text-[11px] tabular-nums text-text-tertiary sm:order-3">{formatListDate(item.date)}</span>
				<span className="col-span-2 min-w-0 sm:order-2 sm:col-span-1">
					<span className="flex min-w-0 items-baseline gap-2">
						<span className="min-w-0 truncate text-[13px] text-text-primary">{item.subject}</span>
						{item.important && (
							<span className="shrink-0 rounded-full bg-accent-subtle px-1.5 text-[10px] font-semibold leading-4 text-accent-subtle-fg">
								Important
							</span>
						)}
					</span>
					{item.summary_line && (
						<span className="block truncate text-xs leading-snug text-text-secondary">{item.summary_line}</span>
					)}
				</span>
			</Link>
		</li>
	);
}

export function TodayCard({ mailboxId }: { mailboxId: string }) {
	const prefs = useAssistantPrefValues();
	const { data } = useBrief(prefs.brief.enabled);
	const dismiss = useDismissBrief();
	const [open, setOpen] = useState(readOpen);
	const [picked, setPicked] = useState<TabId | null>(null);

	const mine: MailboxBrief | undefined = useMemo(
		() => data?.brief?.mailboxes.find((m) => m.mailbox.toLowerCase() === mailboxId.toLowerCase()),
		[data, mailboxId],
	);
	const tabs = useMemo(() => (mine ? tabsOf(mine).filter((t) => t.count > 0) : []), [mine]);

	if (!prefs.brief.enabled || !data?.brief || data.dismissed || !mine) return null;
	const brief = data.brief;
	const others = brief.mailboxes.filter((m) => m !== mine && (m.newCount > 0 || m.needsReplyCount > 0));
	const tab = tabs.find((t) => t.id === picked) ?? tabs[0];
	const shown = tab?.rows.slice(0, ROWS) ?? [];
	const more = tab ? tab.count - shown.length : 0;
	const hasSummaries = shown.some((item) => item.summary_line);
	const hasTopSenders = tab?.id === "new" && (mine.topSenders[0]?.count ?? 0) > 1;
	const hasFooter = hasSummaries || more > 0 || hasTopSenders || others.length > 0;

	const show = (next: boolean) => {
		setOpen(next);
		writeOpen(next);
	};
	/** A count opens the card on its list; the open one closes it again. */
	const pick = (id: TabId) => {
		if (open && tab?.id === id) return show(false);
		setPicked(id);
		show(true);
	};

	return (
		<section aria-labelledby="today-card-title" className="border-b border-border bg-card px-3 py-2 md:px-4">
			{/* A container, so the header adapts to the list pane's width, not the window's. */}
			<div className={cn("@container rounded-[10px] ring-1 ring-border", open ? "bg-card" : "bg-bg-subtle/60")}>
				<div className="flex min-h-10 items-center gap-1 pl-1.5 pr-1 touch:min-h-12 @max-[330px]:flex-wrap">
					<h2 id="today-card-title" className="m-0 shrink-0">
						<button
							type="button"
							onClick={() => show(!open)}
							aria-expanded={open}
							aria-controls="today-card-body"
							className="inline-flex min-h-8 items-center gap-1.5 rounded-[6px] px-1.5 text-[13px] font-semibold text-text-primary hover:bg-bg-muted touch:min-h-11"
						>
							<BriefIcon size={15} className="text-accent" aria-hidden />
							{/* Narrow panes drop the word so the counts fit on the line; it is back once they wrap. */}
							<span className="@max-[400px]:sr-only @max-[330px]:not-sr-only">Today</span>
							<ChevronDown
								size={14}
								className={cn("text-text-tertiary transition-transform motion-reduce:transition-none", !open && "-rotate-90")}
								aria-hidden
							/>
						</button>
					</h2>
					<span className="hidden min-w-0 truncate text-xs text-text-tertiary @min-[520px]:inline">{brief.dateLabel}</span>

					{/* Narrower still, the counts take a line of their own under the title. */}
					<div className="ml-auto flex min-w-0 items-center gap-1.5 overflow-hidden p-px @max-[400px]:gap-1 @max-[330px]:order-last @max-[330px]:ml-0 @max-[330px]:basis-full @max-[330px]:px-1.5 @max-[330px]:pb-1.5">
						{tabs.length === 0 ? (
							<span className="truncate px-2 text-xs text-text-secondary">Nothing new since yesterday</span>
						) : (
							tabs.map((t) => {
								const active = open && t.id === tab?.id;
								return (
									<button
										key={t.id}
										type="button"
										onClick={() => pick(t.id)}
										aria-label={`${t.count} ${t.label}`}
										aria-pressed={active}
										aria-controls="today-card-body"
										className={cn(
											"inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-xs touch:h-8 @max-[400px]:px-2",
											active
												? "bg-accent-subtle font-medium text-accent-subtle-fg ring-1 ring-transparent"
												: "bg-card text-text-secondary ring-1 ring-border hover:bg-bg-muted hover:text-text-primary",
										)}
									>
										<span className="font-semibold tabular-nums">{t.count}</span>
										{t.label}
									</button>
								);
							})
						)}
					</div>
					<button
						type="button"
						onClick={() => dismiss.mutate(brief.id)}
						aria-label="Dismiss today's brief"
						title="Dismiss"
						className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary hover:bg-bg-muted hover:text-text-primary touch:h-11 touch:w-11 @max-[330px]:ml-auto"
					>
						<X size={15} />
					</button>
				</div>

				{/* The wrapper stays in the page while closed, so the buttons' aria-controls has a target. */}
				<div id="today-card-body" hidden={!open} className="border-t border-border px-1.5 pb-1.5 pt-1.5">
					{open && (
						<>
							{tab ? (
								<ul>
									{shown.map((item) => (
										<ItemRow key={item.id} item={item} mailboxId={mailboxId} />
									))}
								</ul>
							) : (
								<p className="px-2.5 py-2 text-[13px] text-text-secondary">No new mail, nothing to reply to, and nobody you are waiting on.</p>
							)}

							{hasFooter && (
								<p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 pt-1 text-[11px] text-text-tertiary">
									{hasSummaries && (
										<span className="inline-flex items-center gap-1">
											<SummaryIcon size={11} className="text-ai" aria-hidden />
											Summaries are AI-generated, can be wrong
										</span>
									)}
									{more > 0 && <span>+{more} more in your inbox</span>}
									{hasTopSenders && (
										<span className="min-w-0 truncate">
											Most from{" "}
											{mine.topSenders
												.filter((s) => s.count > 1)
												.slice(0, 3)
												.map((s) => `${s.name || s.address} (${s.count})`)
												.join(", ")}
										</span>
									)}
									{others.length > 0 && (
										<span>
											Also:{" "}
											{others.map((m, i) => (
												<span key={m.mailbox}>
													{i > 0 && ", "}
													<Link
														className="text-text-secondary underline-offset-2 hover:underline"
														to={`/mail/${encodeURIComponent(m.mailbox)}/inbox`}
													>
														{m.mailbox}
													</Link>{" "}
													({m.newCount} new)
												</span>
											))}
										</span>
									)}
								</p>
							)}
						</>
					)}
				</div>
			</div>
		</section>
	);
}
