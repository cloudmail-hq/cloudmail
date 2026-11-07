// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The Screener: first-time senders waiting for a decision, one row per sender.
 *
 * Yes allowlists the sender and moves their waiting mail to the Inbox. No
 * blocklists them and moves it to Spam (or Trash, from the menu). Opening a
 * row shows their latest message in the reading pane, so the decision can be
 * made with the mail in view. The AI pre-verdict is a hint, never a decision.
 */

import { useParams, Link } from "react-router";
import { Check, ChevronDown, Settings2, Sparkles, UserCheck, X } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import MailWorkspace from "~/components/mail/MailWorkspace";
import { useUIStore } from "~/hooks/useUIStore";
import { cn } from "~/lib/utils";
import { errorMessage, showToast } from "~/lib/toast";
import { senderDisplayName } from "~/lib/sender-display";
import { useMailbox } from "~/queries/mailboxes";
import { useScreener, useScreenSender } from "~/queries/triage";
import type { ScreenerSender } from "~/types";

export default function MailScreenerRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const { data: senders = [], isPending, error } = useScreener(mailboxId);
	const { data: mailbox } = useMailbox(mailboxId);
	const screen = useScreenSender();
	const { selectedEmailId, selectEmail } = useUIStore();
	const screenerOn = mailbox?.settings?.screener === "unknown_only";

	if (!mailboxId) return null;

	const decide = (s: ScreenerSender, decision: "allow" | "block", target?: "spam" | "trash") =>
		screen.mutate(
			{ mailboxId, sender: s.sender, decision, target },
			{
				onSuccess: (r) => {
					if (selectedEmailId && s.latest_id === selectedEmailId) selectEmail(null);
					showToast({
						kind: "success",
						message:
							decision === "allow"
								? `${s.sender} allowed · ${r.moved} moved to Inbox`
								: `${s.sender} blocked · ${r.moved} moved to ${r.folder === "trash" ? "Trash" : "Spam"}`,
					});
				},
				onError: (err) => showToast({ kind: "error", message: errorMessage(err, "Could not screen the sender.") }),
			},
		);

	return (
		<MailWorkspace mailboxId={mailboxId}>
			<div className="flex h-full min-h-0 flex-col bg-card">
				<div className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-subtle/60 px-3 py-2 touch:min-h-11">
					<UserCheck size={14} className="shrink-0 text-text-tertiary" aria-hidden />
					<h1 className="min-w-0 truncate text-sm font-bold text-text-primary">Screener</h1>
					{senders.length > 0 && (
						<span className="min-w-0 truncate text-sm text-text-secondary">
							{senders.length} sender{senders.length === 1 ? "" : "s"} waiting
						</span>
					)}
				</div>

				{!screenerOn && mailbox && (
					<div role="status" className="flex items-center gap-2 border-b border-border bg-bg-subtle px-3 py-2 text-xs text-text-secondary">
						<span className="min-w-0 flex-1">The Screener is off, so new senders go straight to the Inbox.</span>
						<Link
							to={`/mail/${encodeURIComponent(mailboxId)}/settings#triage`}
							className="inline-flex shrink-0 items-center gap-1 rounded-[6px] px-2 py-1 font-medium text-accent hover:bg-accent-subtle touch:min-h-11"
						>
							<Settings2 size={12} aria-hidden /> Turn on
						</Link>
					</div>
				)}

				<div className="min-h-0 flex-1 overflow-y-auto max-md:pb-[calc(5.5rem+env(safe-area-inset-bottom,0px))]">
					{isPending ? (
						<ul aria-label="Loading" className="divide-y divide-border">
							{[0, 1, 2].map((i) => (
								<li key={i} className="flex flex-col gap-2 px-4 py-3">
									<span className="h-3 w-1/3 animate-pulse rounded bg-bg-muted" />
									<span className="h-3 w-2/3 animate-pulse rounded bg-bg-muted" />
								</li>
							))}
						</ul>
					) : error ? (
						<p role="alert" className="px-4 py-10 text-center text-sm text-destructive">
							{errorMessage(error, "Could not load the Screener.")}
						</p>
					) : senders.length === 0 ? (
						<div className="flex flex-col items-center justify-center px-6 py-20 text-center">
							<UserCheck size={32} className="mb-3 text-text-tertiary" strokeWidth={1.25} aria-hidden />
							<h2 className="mb-1 text-sm font-bold text-text-primary">Nobody waiting</h2>
							<p className="max-w-[300px] text-xs text-text-secondary">
								Mail from first-time senders waits here. People you have written to, replies in your
								threads and allowlisted senders always reach the Inbox.
							</p>
						</div>
					) : (
						<ul className="divide-y divide-border">
							{senders.map((s) => {
								const open = selectedEmailId === s.latest_id;
								const name = senderDisplayName(s.sender, s.sender_name);
								return (
									<li
										key={s.sender}
										className={cn(
											"flex flex-col gap-2 px-4 py-3 transition-colors sm:flex-row sm:items-center",
											open ? "bg-accent-subtle" : "hover:bg-bg-muted",
										)}
									>
										<button
											type="button"
											onClick={() => selectEmail(s.latest_id)}
											aria-current={open ? "true" : undefined}
											className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
										>
											<span className="flex min-w-0 items-baseline gap-2">
												<span className={cn("min-w-0 truncate text-sm text-text-primary", s.unread > 0 ? "font-bold" : "font-semibold")}>
													{name}
												</span>
												<span className="min-w-0 truncate text-xs text-text-tertiary">{s.sender}</span>
												{s.count > 1 && (
													<span className="shrink-0 text-xs text-text-secondary">· {s.count} messages</span>
												)}
											</span>
											<span className="truncate text-xs text-text-secondary">
												{s.latest_subject || "(no subject)"}
											</span>
											{s.verdict && (
												<span className="mt-0.5 inline-flex w-fit items-center gap-1 rounded-full bg-bg-muted px-2 py-0.5 text-[11px] text-text-secondary">
													<Sparkles size={11} aria-hidden />
													{s.verdict}
												</span>
											)}
										</button>
										<div className="flex shrink-0 items-center gap-1.5">
											<button
												type="button"
												disabled={screen.isPending}
												onClick={() => decide(s, "allow")}
												aria-label={`Yes, allow ${s.sender}`}
												className="inline-flex h-8 items-center gap-1 rounded-[6px] bg-accent px-3 text-xs font-semibold text-accent-foreground hover:bg-accent-hover disabled:opacity-50 touch:h-11"
											>
												<Check size={13} aria-hidden /> Yes
											</button>
											<div className="inline-flex">
												<button
													type="button"
													disabled={screen.isPending}
													onClick={() => decide(s, "block", "spam")}
													aria-label={`No, block ${s.sender} and move their mail to Spam`}
													className="inline-flex h-8 items-center gap-1 rounded-l-[6px] border border-border px-3 text-xs font-semibold text-text-primary hover:bg-bg-muted disabled:opacity-50 touch:h-11"
												>
													<X size={13} aria-hidden /> No
												</button>
												<DropdownMenu>
													<DropdownMenuTrigger asChild>
														<button
															type="button"
															disabled={screen.isPending}
															aria-label={`More options for ${s.sender}`}
															className="inline-flex h-8 w-7 items-center justify-center rounded-r-[6px] border border-l-0 border-border text-text-secondary hover:bg-bg-muted disabled:opacity-50 touch:h-11 touch:w-11"
														>
															<ChevronDown size={13} aria-hidden />
														</button>
													</DropdownMenuTrigger>
													<DropdownMenuContent align="end" className="w-52">
														<DropdownMenuItem onSelect={() => decide(s, "block", "spam")}>
															No, move to Spam
														</DropdownMenuItem>
														<DropdownMenuItem onSelect={() => decide(s, "block", "trash")}>
															No, move to Trash
														</DropdownMenuItem>
													</DropdownMenuContent>
												</DropdownMenu>
											</div>
										</div>
									</li>
								);
							})}
						</ul>
					)}
				</div>
			</div>
		</MailWorkspace>
	);
}
