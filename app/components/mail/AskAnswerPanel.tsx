// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * "Ask my inbox" answer, with citations linking to the messages.
 *
 * Self-contained on purpose: give it a question (and optionally a mailbox
 * scope) and it fetches, renders and handles its own loading and error states,
 * so it can sit above search results wherever the search box ends up.
 *
 * The answer is model output drawn from third-party mail. It is rendered as
 * text only (no HTML, no links other than the citation deep links, which are
 * built from ids, never from model text).
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { AlertCircle, Loader2, RotateCw, Sparkles, X } from "lucide-react";
import { splitCitations } from "shared/semantic";
import api, { type AskInboxResponse } from "~/services/api";

export interface AskAnswerPanelProps {
	question: string;
	/** One mailbox address, or `*` / omitted for every readable mailbox. */
	mailbox?: string;
	onDismiss?: () => void;
	className?: string;
}

export function askQueryKey(question: string, mailbox: string) {
	return ["ask", mailbox, question] as const;
}

function shortDate(iso: string | null): string {
	if (!iso) return "";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function AskAnswerPanel({ question, mailbox = "*", onDismiss, className }: AskAnswerPanelProps) {
	const q = question.trim();
	const { data, isLoading, isFetching, error, refetch } = useQuery<AskInboxResponse>({
		queryKey: askQueryKey(q, mailbox),
		queryFn: ({ signal }) => api.askInbox({ question: q, mailbox }, { signal }),
		enabled: q.length > 0,
		// An answer is a model call; never refetch it behind the reader's back.
		staleTime: 5 * 60_000,
		refetchOnWindowFocus: false,
		retry: false,
	});

	if (!q) return null;
	const byN = new Map((data?.citations ?? []).map((c) => [c.n, c]));

	return (
		<section
			aria-label="Answer from your mail"
			aria-busy={isLoading}
			className={`border-b border-border bg-card px-4 py-3 ${className ?? ""}`}
		>
			<div className="flex items-start gap-2">
				<Sparkles size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden />
				<div className="min-w-0 flex-1">
					<h2 className="text-xs font-semibold text-text-secondary">
						<span className="sr-only">Question: </span>
						{q}
					</h2>

					<div role="status" aria-live="polite" className="mt-1.5 text-sm leading-relaxed text-text-primary">
						{isLoading ? (
							<span className="inline-flex items-center gap-2 text-text-tertiary">
								<Loader2 size={13} className="animate-spin" aria-hidden />
								Reading your mail…
							</span>
						) : error ? (
							<span className="inline-flex items-center gap-2 text-text-secondary">
								<AlertCircle size={13} className="text-red-600" aria-hidden />
								Couldn't get an answer right now.
							</span>
						) : data ? (
							<p className={data.insufficient ? "text-text-secondary" : undefined}>
								{splitCitations(data.answer).map((part, i) => {
									if ("text" in part) return <span key={i}>{part.text}</span>;
									const c = byN.get(part.n);
									if (!c) return null;
									return (
										<Link
											key={i}
											to={c.href}
											title={c.subject || "(no subject)"}
											aria-label={`Source ${c.n}: ${c.subject || "no subject"}`}
											className="mx-0.5 inline-flex min-w-[1.25rem] items-center justify-center rounded-[4px] bg-accent/10 px-1 align-baseline text-[11px] font-semibold text-accent hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
										>
											{c.n}
										</Link>
									);
								})}
							</p>
						) : null}
					</div>

					{data && data.citations.length > 0 && (
						<ol className="mt-2 space-y-1" aria-label="Sources">
							{data.citations.map((c) => (
								<li key={c.n} className="flex min-w-0 items-baseline gap-2 text-xs">
									<span className="shrink-0 font-semibold text-accent">[{c.n}]</span>
									<Link
										to={c.href}
										className="min-w-0 truncate text-text-primary hover:underline touch:py-2"
									>
										{c.subject || "(no subject)"}
									</Link>
									<span className="hidden shrink-0 truncate text-text-tertiary sm:inline">
										{c.from ?? ""}
										{c.date ? ` · ${shortDate(c.date)}` : ""}
									</span>
								</li>
							))}
						</ol>
					)}

					{data && (
						<p className="mt-2 text-[11px] text-text-tertiary">
							AI answer from your mail{data.semantic ? "" : " (keyword search only)"}. It can be wrong; check the sources.
						</p>
					)}
				</div>

				<div className="flex shrink-0 items-center">
					{(data || error) && (
						<button
							type="button"
							onClick={() => refetch()}
							disabled={isFetching}
							aria-label="Ask again"
							title="Ask again"
							className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-text-tertiary hover:bg-bg-muted hover:text-text-primary disabled:opacity-50 touch:h-11 touch:w-11"
						>
							<RotateCw size={13} className={isFetching ? "animate-spin" : undefined} />
						</button>
					)}
					{onDismiss && (
						<button
							type="button"
							onClick={onDismiss}
							aria-label="Close answer"
							title="Close answer"
							className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-text-tertiary hover:bg-bg-muted hover:text-text-primary touch:h-11 touch:w-11"
						>
							<X size={14} />
						</button>
					)}
				</div>
			</div>
		</section>
	);
}
