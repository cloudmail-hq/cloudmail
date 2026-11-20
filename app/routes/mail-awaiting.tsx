// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Awaiting reply: sent mail with a follow-up reminder.
 *
 * Fired reminders (the thread is back in the Inbox) are listed first, then
 * pending ones by due date. A row opens the message in the reading pane like
 * any list; "Cancel" removes the reminder without leaving the view.
 */

import { useParams } from "react-router";
import { BellRing, MailQuestion, X } from "lucide-react";
import MailWorkspace from "~/components/mail/MailWorkspace";
import { useUIStore } from "~/hooks/useUIStore";
import { formatDueLabel } from "shared/dates";
import { cn } from "~/lib/utils";
import { errorMessage, showToast } from "~/lib/toast";
import { useCancelFollowup, useFollowups } from "~/queries/followups";

export default function MailAwaitingRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const { data: followups = [], isPending, error } = useFollowups(mailboxId);
	const cancel = useCancelFollowup();
	const { selectedEmailId, selectEmail } = useUIStore();
	const firedCount = followups.filter((f) => f.status === "fired").length;

	if (!mailboxId) return null;

	return (
		<MailWorkspace mailboxId={mailboxId}>
			<div className="flex h-full min-h-0 flex-col">
				<div className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-subtle/60 px-3 py-2 touch:min-h-11">
					<MailQuestion size={14} className="shrink-0 text-text-tertiary" aria-hidden />
					<h1 className="min-w-0 truncate text-sm font-bold text-text-primary">Awaiting reply</h1>
					{followups.length > 0 && (
						<span className="min-w-0 truncate text-sm text-text-secondary">
							{firedCount > 0 ? `${firedCount} to follow up · ` : ""}
							{followups.length - firedCount} waiting
						</span>
					)}
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto">
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
							{errorMessage(error, "Could not load reminders.")}
						</p>
					) : followups.length === 0 ? (
						<div className="flex flex-col items-center justify-center px-6 py-20 text-center">
							<BellRing size={32} className="mb-3 text-text-tertiary" strokeWidth={1.25} aria-hidden />
							<h2 className="mb-1 text-sm font-bold text-text-primary">Nothing awaiting a reply</h2>
							<p className="max-w-[300px] text-xs text-text-secondary">
								Use the bell beside Send to get a reminder if nobody answers. Replies cancel it
								automatically.
							</p>
						</div>
					) : (
						<ul className="divide-y divide-border">
							{followups.map((f) => {
								const fired = f.status === "fired";
								const due = formatDueLabel(f.followup_at);
								const open = selectedEmailId === f.email_id;
								return (
									<li
										key={f.email_id}
										className={cn(
											"group flex items-center gap-2 pr-2 transition-colors",
											open ? "bg-accent-subtle" : "hover:bg-bg-muted",
										)}
									>
										<button
											type="button"
											onClick={() => selectEmail(f.email_id)}
											aria-current={open ? "true" : undefined}
											className="flex min-w-0 flex-1 flex-col gap-0.5 px-4 py-3 text-left touch:min-h-11"
										>
											<span className="flex min-w-0 items-center gap-2">
												<span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
													{f.subject || "(no subject)"}
												</span>
												<span
													className={cn(
														"shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
														fired
															? "bg-accent text-accent-foreground"
															: "bg-bg-muted text-text-secondary",
													)}
												>
													{fired ? "Follow up now" : due}
												</span>
											</span>
											<span className="truncate text-xs text-text-secondary">
												To {f.recipient || "unknown"}
												{f.followup_mode === "auto" ? " · auto" : ""}
											</span>
										</button>
										<button
											type="button"
											onClick={() =>
												cancel.mutate(
													{ mailboxId, emailId: f.email_id },
													{
														onSuccess: () =>
															showToast({
																kind: "success",
																message: fired ? "Reminder dismissed" : "Reminder cancelled",
															}),
														onError: (err) =>
															showToast({
																kind: "error",
																message: errorMessage(err, "Could not cancel the reminder."),
															}),
													},
												)
											}
											aria-label={`Cancel reminder for ${f.subject || "this message"}`}
											title="Cancel reminder"
											className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary hover:bg-bg-muted hover:text-text-primary touch:h-11 touch:w-11"
										>
											<X size={15} aria-hidden />
										</button>
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
