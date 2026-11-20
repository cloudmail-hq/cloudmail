// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The follow-up reminder on an open conversation, in the reading pane.
 *
 * Pending: "Reminder Tue, 9:00 AM if no reply" with Cancel. Fired: "No reply
 * yet" with Dismiss, which returns the message to Sent. For sent mail with no
 * reminder, a small "Remind me" picker sets one after the fact.
 */

import { BellRing, ChevronDown } from "lucide-react";
import { FOLLOWUP_PRESETS } from "shared/followups";
import { formatDueLabel } from "shared/dates";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { errorMessage, showToast } from "~/lib/toast";
import { useCancelFollowup, useFollowup, useSetFollowup } from "~/queries/followups";

interface FollowupBannerProps {
	mailboxId: string;
	/** Any message in the conversation; the reminder is looked up by thread. */
	emailId: string;
	/** The latest message we sent in the thread, for setting a new reminder. */
	sentEmailId?: string;
}

export default function FollowupBanner({ mailboxId, emailId, sentEmailId }: FollowupBannerProps) {
	const { data: followup } = useFollowup(mailboxId, emailId);
	const cancel = useCancelFollowup();
	const set = useSetFollowup();

	const active = followup && (followup.status === "pending" || followup.status === "fired");

	if (!active) {
		if (!sentEmailId) return null;
		return (
			<div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-1.5">
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							className="inline-flex h-7 items-center gap-1.5 rounded-[6px] px-1.5 text-[11px] font-medium text-text-secondary hover:bg-bg-muted hover:text-text-primary touch:h-11"
						>
							<BellRing size={13} aria-hidden />
							Remind me if no reply
							<ChevronDown size={11} aria-hidden />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="w-48">
						<DropdownMenuLabel>Remind me if no reply</DropdownMenuLabel>
						{FOLLOWUP_PRESETS.map((preset) => (
							<DropdownMenuItem
								key={preset.id}
								className="cursor-pointer"
								onClick={() =>
									set.mutate(
										{ mailboxId, emailId: sentEmailId, when: { delay_seconds: preset.seconds } },
										{
											onSuccess: () =>
												showToast({ kind: "success", message: `Reminder set for ${preset.label}` }),
											onError: (err) =>
												showToast({ kind: "error", message: errorMessage(err, "Could not set the reminder.") }),
										},
									)
								}
							>
								In {preset.label}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		);
	}

	const fired = followup.status === "fired";
	return (
		<div
			role="status"
			className="flex shrink-0 items-center gap-2 border-b border-border bg-accent-subtle/60 px-4 py-2"
		>
			<BellRing size={13} className="shrink-0 text-accent-subtle-fg" aria-hidden />
			<p className="min-w-0 flex-1 text-[12px] text-text-primary">
				{fired ? (
					<>
						<span className="font-semibold">No reply yet.</span> You asked to be reminded about this
						conversation.
					</>
				) : (
					<>
						<span className="font-semibold">{formatDueLabel(followup.followup_at)}</span> if nobody
						replies{followup.followup_mode === "auto" ? " (auto)" : ""}.
					</>
				)}
			</p>
			<button
				type="button"
				disabled={cancel.isPending}
				onClick={() =>
					cancel.mutate(
						{ mailboxId, emailId: followup.email_id },
						{
							onSuccess: () =>
								showToast({ kind: "success", message: fired ? "Reminder dismissed" : "Reminder cancelled" }),
							onError: (err) =>
								showToast({ kind: "error", message: errorMessage(err, "Could not cancel the reminder.") }),
						},
					)
				}
				className="shrink-0 rounded-[6px] border border-border bg-card px-2 py-1 text-[11px] font-semibold text-text-primary hover:bg-bg-muted disabled:opacity-50 touch:min-h-11"
			>
				{fired ? "Dismiss" : "Cancel reminder"}
			</button>
		</div>
	);
}
