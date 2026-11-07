/**
 * Search results across every readable mailbox: what the top bar's search box
 * does on pages outside a mailbox (People, Templates, Analytics, Settings…).
 *
 * Backed by `GET /api/v1/search` (#132): keywords plus meaning across every
 * readable mailbox, one ranked page. Each row is tagged with its mailbox and
 * product and deep-links into that mailbox's reader with `?m=`. With `ask=1`
 * the "Ask my inbox" answer sits above the results, over every inbox.
 */

import { Link, useNavigate, useSearchParams } from "react-router";
import { AlertTriangle, Search, SearchX } from "lucide-react";
import DashboardLayout from "~/components/DashboardLayout";
import AskAnswerPanel from "~/components/mail/AskAnswerPanel";
import MailAccountsPane from "~/components/mail/MailAccountsPane";
import ProductBadge from "~/components/mail/ProductBadge";
import { PageContainer, PageHeader } from "~/components/ui/page";
import { senderAvatarTint, senderDisplayName, senderInitials } from "~/lib/sender-display";
import { cn } from "~/lib/utils";
import { useProducts } from "~/queries/products";
import { useSearchAllMailboxes } from "~/queries/search";
import type { CrossMailboxHit } from "~/services/api";
import { resolveProduct } from "shared/products";
import { formatListDate } from "shared/dates";
import { SNIPPET_MARK_CLOSE, SNIPPET_MARK_OPEN } from "shared/fts";
import { redactSecrets } from "shared/redact-secrets";

const enc = encodeURIComponent;

function messageHref(row: CrossMailboxHit): string {
	const folder = row.folder_id || "inbox";
	return `/mail/${enc(row.mailboxId)}/${enc(folder)}?m=${enc(row.id)}`;
}

/** The FTS excerpt with its highlight markers removed, for a one-line preview. */
function plainSnippet(snippet: unknown): string {
	return typeof snippet === "string"
		? snippet.split(SNIPPET_MARK_OPEN).join("").split(SNIPPET_MARK_CLOSE).join("")
		: "";
}

export default function AllInboxesSearchPage() {
	const [searchParams] = useSearchParams();
	const navigate = useNavigate();
	const query = (searchParams.get("q") ?? "").trim();
	const asking = searchParams.get("ask") === "1" && query.length > 0;
	const search = useSearchAllMailboxes(query);
	const { data: products = [] } = useProducts();
	const data = search.data;
	const rows = data?.results ?? [];
	const byMailbox = [...new Set(rows.map((r) => r.mailboxId))];

	return (
		<DashboardLayout>
			{/* Mail's pane, as on every Mail page; the phone gets Mail's module bar. */}
			<div className="flex w-full">
				<MailAccountsPane active="search" />
				<div className="min-w-0 flex-1">
			<PageContainer>
				<PageHeader
					icon={Search}
					title={query ? `Results for “${query}”` : "Search all inboxes"}
					description={
						data
							? `Across ${data.mailboxes.length} mailbox${data.mailboxes.length === 1 ? "" : "es"}, ${data.semantic ? "by keywords and meaning" : "by keywords"}.`
							: undefined
					}
				/>

				{asking && (
					<AskAnswerPanel
						question={query}
						mailbox="*"
						className="mb-4"
						onDismiss={() => {
							const next = new URLSearchParams(searchParams);
							next.delete("ask");
							navigate({ search: `?${next}` }, { replace: true });
						}}
					/>
				)}

				{data && data.truncated.length > 0 && (
					<p
						role="status"
						className="mb-3 flex items-start gap-2 rounded-[6px] bg-warning-bg px-3 py-2 text-xs text-warning-text ring-1 ring-warning-border"
					>
						<AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
						<span>
							{`${data.truncated.length} mailboxes were left out.`}
						</span>
					</p>
				)}

				<div className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
					{!query ? (
						<Empty title="Type in the search box above" body="It searches every inbox you can read from here." />
					) : search.isPending ? (
						<ul aria-busy="true" aria-label="Searching" className="divide-y divide-border/70">
							{Array.from({ length: 6 }, (_, i) => (
								<li key={i} className="flex items-center gap-3 px-4 py-3">
									<span className="h-9 w-9 animate-pulse rounded-full bg-bg-muted" />
									<span className="h-4 flex-1 animate-pulse rounded bg-bg-muted" />
								</li>
							))}
						</ul>
					) : search.isError ? (
						<Empty title="Search failed" body={(search.error as Error)?.message || "Try again in a moment."} />
					) : rows.length === 0 ? (
						<Empty title="No matches" body="Try fewer words, or an operator like from: or has:attachment." />
					) : (
						<ul aria-label={`${rows.length} results`} className="divide-y divide-border/70">
							{rows.map((row) => {
								const unread = !row.read;
								// The row's recipient decides the product, else the mailbox, as on the server.
								const resolved =
									resolveProduct(products, (row.recipient ?? "").split(",")[0]) ?? resolveProduct(products, row.mailboxId);
								const product = resolved ? { id: resolved.id, name: resolved.displayName || resolved.name, accentColor: resolved.accentColor } : null;
								return (
									<li key={`${row.mailboxId}/${row.id}`}>
										<Link
											to={messageHref(row)}
											className="flex items-start gap-3 py-2.5 pl-4 pr-4 outline-none hover:bg-bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
										>
											<span
												aria-hidden
												className={cn(
													"mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold",
													senderAvatarTint(row.sender ?? ""),
												)}
											>
												{senderInitials(row.sender ?? "", row.sender_name)}
											</span>
											<span className="min-w-0 flex-1">
												<span className="flex items-baseline gap-2">
													<span className={cn("truncate text-sm", unread ? "font-semibold text-text-primary" : "text-text-secondary")}>
														{senderDisplayName(row.sender ?? "", row.sender_name)}
													</span>
{product && <ProductBadge product={product} />}
													<span className="ml-auto shrink-0 text-xs text-text-tertiary">{formatListDate(row.date ?? "")}</span>
												</span>
												<span className={cn("block truncate text-[13px] text-text-primary", unread && "font-semibold")}>
													{row.subject || "(no subject)"}
												</span>
												<span className="block truncate text-xs text-text-tertiary">
													<span className="font-medium text-text-secondary">{row.mailboxId}</span>
													{" · "}
													{redactSecrets(plainSnippet(row.snippet))}
												</span>
											</span>
										</Link>
									</li>
								);
							})}
						</ul>
					)}
				</div>

				{query && byMailbox.length > 0 && (
					<div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
						<span>Search one mailbox for more:</span>
						{byMailbox.map((m) => (
							<Link
								key={m}
								to={`/mail/${enc(m)}/search?q=${enc(query)}`}
								className="inline-flex h-8 items-center rounded-full border border-border bg-card px-3 font-medium text-text-primary hover:bg-bg-muted touch:h-11"
							>
								{m}
							</Link>
						))}
					</div>
				)}
			</PageContainer>
				</div>
			</div>
		</DashboardLayout>
	);
}

function Empty({ title, body }: { title: string; body: string }) {
	return (
		<div className="flex flex-col items-center px-6 py-16 text-center">
			<SearchX size={32} className="mb-3 text-text-tertiary" strokeWidth={1.25} aria-hidden />
			<h2 className="mb-1 text-sm font-semibold text-text-primary">{title}</h2>
			<p className="max-w-[320px] text-xs text-text-secondary">{body}</p>
		</div>
	);
}
