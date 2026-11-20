// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * AI summary UI: the small marker on list rows and the Gmail-style "Summary"
 * card at the top of the reader.
 *
 * Every string here is model output about other people's mail. It is rendered
 * as React text nodes only, never as HTML.
 */

import { useEffect, useId, useState } from "react";
import { ChevronDown, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { cn } from "~/lib/utils";
import { ApiError } from "~/services/api";
import {
	useAiSettings,
	useGenerateThreadSummary,
	useRefreshThreadSummary,
	useThreadSummary,
} from "~/queries/assistant";

/** The "this was written by AI" marker. Decorative to sighted users; named for screen readers. */
export function AiMark({ className }: { className?: string }) {
	return (
		<Sparkles
			size={11}
			strokeWidth={2}
			className={cn("inline-block shrink-0 text-accent", className)}
			aria-label="AI summary"
			role="img"
		/>
	);
}

export const COLLAPSE_KEY = "tt.ai-summary.collapsed";

function readCollapsed(): boolean {
	if (typeof window === "undefined") return false;
	try {
		return window.localStorage.getItem(COLLAPSE_KEY) === "1";
	} catch {
		return false;
	}
}

function generateError(err: unknown): string {
	if (err instanceof ApiError) {
		if (err.status === 429) return "Today's summary limit for this mailbox is used up. It resets at 00:00 UTC.";
		if (err.status === 503 && err.body.code === "summaries_off") return "AI summaries are turned off for this deployment.";
		if (err.status === 404) return "There's nothing here to summarise.";
	}
	return "Couldn't summarise this right now. Try again in a minute.";
}

/**
 * The summary card at the top of an open message or thread: a sparkle, three
 * bullets covering the conversation so far, and an "AI-generated" note.
 *
 * - Collapsible; the choice is remembered per device, like the theme.
 * - A stale summary (the thread grew) still shows, labelled, and a refresh is
 *   requested once; the mailbox poller brings the new one in.
 * - A conversation with no bullets yet gets a "Summarize" button that
 *   generates one now, within the mailbox's daily cap.
 * - Nothing for Spam/Trash, mail with almost no text, or bulk mail the admin
 *   has excluded (stored as "skipped").
 */
export function ThreadSummaryPanel({
	mailboxId,
	threadId,
	disabled,
}: {
	mailboxId: string;
	threadId: string | null | undefined;
	/** Spam/Trash/Drafts: never shown. */
	disabled?: boolean;
}) {
	const { data: summary, isLoading } = useThreadSummary(mailboxId, threadId, !disabled);
	const { data: aiSettings } = useAiSettings();
	const refresh = useRefreshThreadSummary();
	const generate = useGenerateThreadSummary();
	const [collapsed, setCollapsed] = useState(readCollapsed);
	const [asked, setAsked] = useState<string | null>(null);
	const [triedFor, setTriedFor] = useState<string | null>(null);
	const headingId = useId();
	const bodyId = useId();

	useEffect(() => {
		if (!summary?.stale || !threadId || asked === threadId) return;
		setAsked(threadId);
		refresh.mutate({ mailboxId, threadId });
	}, [summary?.stale, threadId, mailboxId, asked, refresh]);

	// A new conversation starts without the previous one's result or error.
	const { reset } = generate;
	useEffect(() => reset(), [threadId, reset]);

	if (disabled || !threadId || isLoading) return null;
	if (summary?.status === "skipped") return null;

	const blocked = summary?.status === "blocked";
	const bullets = summary?.bullets ?? [];
	// Generated before every message got bullets, or the model only managed a
	// line: offer to summarise, and once that has been tried show the line.
	const lineOnly = !blocked && bullets.length === 0 && !!summary?.line;
	const shownBullets = lineOnly && triedFor === threadId ? [summary!.line!] : bullets;

	if (!blocked && shownBullets.length === 0) {
		if (aiSettings && !aiSettings.summaries) return null;
		// Tried, and there was nothing to summarise: no button to press again.
		if (triedFor === threadId && generate.isSuccess && !summary) return null;
		const pending = generate.isPending;
		const stuck =
			generate.error instanceof ApiError &&
			(generate.error.status === 429 || generate.error.body.code === "summaries_off");
		return (
			<div className="px-4 pt-3">
				<button
					type="button"
					onClick={() =>
						generate.mutate(
							{ mailboxId, threadId },
							{ onSettled: () => setTriedFor(threadId) },
						)
					}
					// Capped or off: pressing again today cannot help.
					disabled={pending || stuck}
					aria-busy={pending || undefined}
					className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-xs font-medium text-text-primary hover:bg-bg-muted disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-card touch:min-h-11"
				>
					{pending ? (
						<Loader2 size={13} className="animate-spin text-accent" aria-hidden />
					) : (
						<Sparkles size={13} className="text-accent" aria-hidden />
					)}
					{pending ? "Summarizing…" : "Summarize"}
				</button>
				<p role="status" className="mt-1 text-[11px] text-text-secondary empty:hidden">
					{generate.isError ? generateError(generate.error) : ""}
				</p>
			</div>
		);
	}

	const toggle = () => {
		setCollapsed((c) => {
			try {
				window.localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
			} catch {
				// Private mode: remember for this session only.
			}
			return !c;
		});
	};

	return (
		<section aria-labelledby={headingId} className="px-4 pt-3">
			<div className="rounded-[10px] bg-ai-subtle px-3 py-2 ring-1 ring-ai-border">
				<div className="flex flex-wrap items-center gap-x-2">
					<h3 id={headingId} className="m-0">
						<button
							type="button"
							onClick={toggle}
							aria-expanded={!collapsed}
							aria-controls={bodyId}
							className="-ml-1.5 inline-flex min-h-8 items-center gap-1.5 rounded-[6px] px-1.5 text-[13px] font-semibold text-text-primary hover:bg-bg-muted touch:min-h-11"
						>
							<Sparkles size={14} className="text-ai" aria-hidden />
							Summary
							<ChevronDown
								size={14}
								className={cn("text-text-tertiary transition-transform motion-reduce:transition-none", collapsed && "-rotate-90")}
								aria-hidden
							/>
						</button>
					</h3>
					<span className="text-[11px] text-text-tertiary">AI-generated, can be wrong</span>
					{summary?.stale && (
						<span className="inline-flex items-center gap-1 text-[11px] text-text-secondary">
							<RefreshCw size={10} className="animate-spin motion-reduce:animate-none" aria-hidden />
							Updating for new messages
						</span>
					)}
				</div>
				<div id={bodyId} hidden={collapsed} className="pb-0.5">
					{blocked ? (
						<p className="text-[13px] italic text-text-secondary">{summary?.line}</p>
					) : (
						<ul className="list-disc space-y-1 pl-5 text-[13px] leading-snug text-text-primary marker:text-ai">
							{shownBullets.map((b, i) => (
								<li key={i}>{b}</li>
							))}
						</ul>
					)}
				</div>
			</div>
		</section>
	);
}
