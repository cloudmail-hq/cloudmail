// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * "All inboxes": one list across every mailbox the user can read.
 *
 * Read-mostly by design. Each row carries the mailbox it came from, so the
 * quick actions (read, star, archive) go to that mailbox's own routes and
 * opening a row deep-links into its reader (`/mail/<mailbox>/<folder>?m=<id>`),
 * where reply, labels and everything else already work. Product chips filter
 * the list; `?product=` keeps the choice in the URL.
 */

import { useMemo } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Archive, Inbox, Layers, Mail, MailOpen, RefreshCw, Star } from "lucide-react";
import DashboardLayout from "~/components/DashboardLayout";
import { ModuleBar } from "~/components/ModuleBar";
import MailAccountsPane from "~/components/mail/MailAccountsPane";
import ProductBadge from "~/components/mail/ProductBadge";
import { PageContainer } from "~/components/ui/page";
import { productKeys, useProducts, useUnifiedInbox } from "~/queries/products";
import api from "~/services/api";
import type { UnifiedEmail } from "~/services/products-api";
import { senderAvatarTint, senderDisplayName, senderInitials } from "~/lib/sender-display";
import { announce, showToast } from "~/lib/toast";
import { cn, getSnippetText } from "~/lib/utils";
import { formatListDate } from "shared/dates";
import { Folders, getFolderDisplayName } from "shared/folders";
import { badgeColor } from "shared/products";
import { redactSecrets } from "shared/redact-secrets";

const PAGE_SIZE = 30;
const FOLDERS = [Folders.INBOX, Folders.ARCHIVE, Folders.SENT] as const;

function messageHref(row: UnifiedEmail, folder: string): string {
	return `/mail/${encodeURIComponent(row.mailboxId)}/${encodeURIComponent(folder)}?m=${encodeURIComponent(row.id)}`;
}

export default function AllInboxesPage() {
	const navigate = useNavigate();
	const qc = useQueryClient();
	const { folder: folderParam } = useParams<{ folder?: string }>();
	const folder = folderParam && (FOLDERS as readonly string[]).includes(folderParam) ? folderParam : Folders.INBOX;
	const [searchParams, setSearchParams] = useSearchParams();
	const selected = useMemo(
		() => (searchParams.get("product") ?? "").split(",").filter(Boolean),
		[searchParams],
	);
	const unreadOnly = searchParams.get("unread") === "1";

	const params = useMemo(() => {
		const p: Record<string, string> = { folder, limit: String(PAGE_SIZE) };
		if (selected.length) p.product = selected.join(",");
		if (unreadOnly) p.unread = "true";
		return p;
	}, [folder, selected, unreadOnly]);

	const { data: products = [] } = useProducts();
	const inbox = useUnifiedInbox(params);
	const pages = inbox.data?.pages ?? [];
	const rows = pages.flatMap((p) => p.emails);
	const first = pages[0];

	const setProducts = (next: string[]) => {
		const sp = new URLSearchParams(searchParams);
		if (next.length) sp.set("product", next.join(","));
		else sp.delete("product");
		setSearchParams(sp, { replace: true });
	};
	const toggleProduct = (id: string) =>
		setProducts(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
	const toggleUnread = () => {
		const sp = new URLSearchParams(searchParams);
		if (unreadOnly) sp.delete("unread");
		else sp.set("unread", "1");
		setSearchParams(sp, { replace: true });
	};

	/** Writes go to the owning mailbox, then the unified list refetches. */
	const act = async (row: UnifiedEmail, kind: "read" | "star" | "archive") => {
		try {
			if (kind === "archive") {
				await api.moveEmail(row.mailboxId, row.id, Folders.ARCHIVE);
				announce("Archived");
			} else if (kind === "star") {
				await api.updateEmail(row.mailboxId, row.id, { starred: !row.starred });
				announce(row.starred ? "Unstarred" : "Starred");
			} else {
				await api.updateEmail(row.mailboxId, row.id, { read: !row.read });
				announce(row.read ? "Marked as unread" : "Marked as read");
			}
			void qc.invalidateQueries({ queryKey: productKeys.unifiedAll });
			void qc.invalidateQueries({ queryKey: ["emails", row.mailboxId] });
		} catch (e) {
			showToast({ kind: "error", message: (e as Error).message || "That didn't work." });
		}
	};

	// A product with no domain and no alias can own no mail, so it gets no chip.
	const productsInView = products.filter((p) => p.domains.length > 0 || p.aliases.length > 0);
	const unread = first?.unread ?? 0;
	const title = folder === Folders.INBOX ? "All inboxes" : `All ${getFolderDisplayName(folder).toLowerCase()}`;

	return (
		<DashboardLayout>
			{/* Mail's pane, as on every Mail page; the phone gets Mail's module bar. */}
			<div className="flex w-full">
				<MailAccountsPane active="all" />
				<div className="min-w-0 flex-1">
			<ModuleBar label={title} navLabel="Mailboxes" onOpen={() => navigate("/")} />
			<PageContainer>
				<div className="mb-4 flex flex-wrap items-center gap-3">
					<Layers size={18} className="hidden text-text-tertiary md:block" aria-hidden />
					{/* On a phone the module bar above carries the title. */}
					<h1 className="sr-only text-xl font-semibold tracking-tight text-text-primary md:not-sr-only">{title}</h1>
					{unread > 0 && (
						<span className="rounded-full bg-accent-subtle px-2 text-xs font-semibold leading-5 text-accent">
							{unread} unread
						</span>
					)}
					<div className="flex-1" />
					<nav aria-label="Folder" className="flex gap-1">
						{FOLDERS.map((f) => (
							<Link
								key={f}
								to={`/mail/all/${f}${searchParams.toString() ? `?${searchParams}` : ""}`}
								aria-current={f === folder ? "page" : undefined}
								className={cn(
									"inline-flex h-8 items-center rounded-[6px] px-2.5 text-[13px] font-medium touch:h-11",
									f === folder ? "bg-bg-muted text-text-primary" : "text-text-secondary hover:bg-bg-muted",
								)}
							>
								{getFolderDisplayName(f)}
							</Link>
						))}
					</nav>
					<button
						type="button"
						onClick={() => void inbox.refetch()}
						aria-label="Refresh"
						title="Refresh"
						className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] text-text-secondary hover:bg-bg-muted touch:h-11 touch:w-11"
					>
						<RefreshCw size={15} className={inbox.isFetching ? "animate-spin" : undefined} />
					</button>
				</div>

				<div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
				{/* Product chips. Toggle buttons; several can be on at once. */}
				<div role="group" aria-label="Filter by product" className="flex flex-wrap items-center gap-1.5">
					<button
						type="button"
						onClick={() => setProducts([])}
						aria-pressed={selected.length === 0}
						className={cn(
							"inline-flex h-8 items-center rounded-full border px-3 text-[13px] font-medium touch:h-11",
							selected.length === 0
								? "border-transparent bg-accent text-accent-foreground"
								: "border-border bg-card text-text-secondary hover:bg-bg-muted",
						)}
					>
						All products
					</button>
					{productsInView.map((p) => {
						const on = selected.includes(p.id);
						return (
							<button
								key={p.id}
								type="button"
								onClick={() => toggleProduct(p.id)}
								aria-pressed={on}
								className={cn(
									"inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium touch:h-11",
									on ? "border-text-primary bg-bg-muted text-text-primary" : "border-border bg-card text-text-secondary hover:bg-bg-muted",
								)}
							>
								<span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: badgeColor(p) }} />
								{p.displayName || p.name}
							</button>
						);
					})}
				</div>
				<div role="group" aria-label="Filter by status" className="flex items-center gap-1.5">
					<button
						type="button"
						onClick={toggleUnread}
						aria-pressed={unreadOnly}
						className={cn(
							"inline-flex h-8 items-center rounded-full border px-3 text-[13px] font-medium touch:h-11",
							unreadOnly ? "border-text-primary bg-bg-muted text-text-primary" : "border-border bg-card text-text-secondary hover:bg-bg-muted",
						)}
					>
						<Mail size={13} aria-hidden className="mr-1" />
						Unread only
					</button>
				</div>
				</div>

				{first && (first.truncated.length > 0 || first.degraded.length > 0) && (
					<p role="status" className="mb-3 flex items-start gap-2 rounded-[6px] bg-warning-bg px-3 py-2 text-xs text-warning-text ring-1 ring-warning-border">
						<AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
						<span>
							{first.truncated.length > 0 &&
								`Showing the first ${first.mailboxes.length} mailboxes; ${first.truncated.length} more are left out. Filter by product to see them. `}
							{first.degraded.length > 0 && `Couldn't reach ${first.degraded.join(", ")}.`}
						</span>
					</p>
				)}

				<div className="overflow-hidden rounded-[8px] bg-card ring-1 ring-border">
					{inbox.isPending ? (
						<ul aria-busy="true" aria-label="Loading messages" className="divide-y divide-border/70">
							{Array.from({ length: 8 }, (_, i) => (
								<li key={i} className="flex items-center gap-3 px-4 py-3">
									<span className="h-9 w-9 animate-pulse rounded-full bg-bg-muted" />
									<span className="h-4 flex-1 animate-pulse rounded bg-bg-muted" />
								</li>
							))}
						</ul>
					) : inbox.isError ? (
						<div className="px-6 py-16 text-center">
							<p className="mb-3 text-sm text-text-secondary">Couldn't load your inboxes.</p>
							<button
								type="button"
								onClick={() => void inbox.refetch()}
								className="rounded-[6px] bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground"
							>
								Try again
							</button>
						</div>
					) : rows.length === 0 ? (
						<div className="flex flex-col items-center px-6 py-20 text-center">
							<Inbox size={34} className="mb-3 text-text-tertiary" strokeWidth={1.25} aria-hidden />
							<h2 className="mb-1 text-sm font-bold text-text-primary">
								{selected.length || unreadOnly ? "No messages match" : "Nothing here"}
							</h2>
							<p className="max-w-[280px] text-xs font-light text-text-secondary">
								{selected.length || unreadOnly
									? "Try another product, or clear the filters."
									: "Mail to any of your mailboxes shows up here."}
							</p>
						</div>
					) : (
						<ul aria-label={`${title}, ${rows.length} conversations shown`} className="divide-y divide-border/70">
							{rows.map((row) => {
								const unreadRow = !row.read || (row.thread_unread_count ?? 0) > 0;
								const snippet = redactSecrets(getSnippetText(row.snippet, 140));
								return (
									<li key={`${row.mailboxId}/${row.id}`} className={cn("group relative", unreadRow ? "bg-card" : "bg-bg-subtle")}>
										<Link
											to={messageHref(row, folder)}
											className="flex items-start gap-3 py-2.5 pl-5 pr-4 outline-none hover:bg-bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
										>
											{unreadRow && (
												<span aria-label="Unread" className="absolute left-2 top-[24px] h-2 w-2 rounded-full bg-unread" />
											)}
											<span
												aria-hidden
												className={cn(
													"mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold",
													senderAvatarTint(row.sender),
												)}
											>
												{senderInitials(row.sender, row.sender_name)}
											</span>
											<span className="min-w-0 flex-1">
												<span className="flex items-baseline gap-2">
													<span className={cn("truncate text-sm", unreadRow ? "font-semibold text-text-primary" : "text-text-secondary")}>
														{senderDisplayName(row.sender, row.sender_name)}
													</span>
													{(row.thread_count ?? 1) > 1 && (
														<span className="shrink-0 rounded-full bg-bg-muted px-1.5 text-[10px] font-semibold leading-4 text-text-secondary">
															{row.thread_count}
														</span>
													)}
													{row.product && <ProductBadge product={row.product} />}
													<span className="ml-auto shrink-0 text-xs text-text-tertiary">{formatListDate(row.date)}</span>
												</span>
												<span className={cn("block truncate text-[13px]", unreadRow ? "font-semibold text-text-primary" : "text-text-primary")}>
													{row.subject || "(no subject)"}
												</span>
												<span className="block truncate text-xs text-text-tertiary">
													<span className="sr-only">To {row.mailboxId}. </span>
													{snippet}
												</span>
											</span>
										</Link>
										{/* Quick actions, on the owning mailbox. Hidden on phones, where the row opens the reader. */}
										<div className="absolute right-2 top-1.5 hidden items-center gap-0.5 rounded-[8px] bg-card shadow-sm ring-1 ring-border sm:group-focus-within:flex sm:group-hover:flex">
											<button
												type="button"
												onClick={() => void act(row, "read")}
												aria-label={row.read ? `Mark "${row.subject}" unread` : `Mark "${row.subject}" read`}
												title={row.read ? "Mark unread" : "Mark read"}
												className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] text-text-secondary hover:bg-bg-muted"
											>
												{row.read ? <Mail size={15} /> : <MailOpen size={15} />}
											</button>
											<button
												type="button"
												onClick={() => void act(row, "star")}
												aria-label={row.starred ? `Unstar "${row.subject}"` : `Star "${row.subject}"`}
												aria-pressed={row.starred}
												title={row.starred ? "Unstar" : "Star"}
												className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] text-text-secondary hover:bg-bg-muted"
											>
												<Star size={15} className={row.starred ? "fill-current text-warning-text" : undefined} />
											</button>
											{folder === Folders.INBOX && (
												<button
													type="button"
													onClick={() => void act(row, "archive")}
													aria-label={`Archive "${row.subject}"`}
													title="Archive"
													className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] text-text-secondary hover:bg-bg-muted"
												>
													<Archive size={15} />
												</button>
											)}
										</div>
									</li>
								);
							})}
						</ul>
					)}
				</div>

				{inbox.hasNextPage && (
					<div className="mt-4 flex justify-center">
						<button
							type="button"
							onClick={() => void inbox.fetchNextPage()}
							disabled={inbox.isFetchingNextPage}
							className="inline-flex h-9 items-center rounded-[6px] border border-border bg-card px-4 text-[13px] font-medium text-text-primary hover:bg-bg-muted disabled:opacity-60 touch:h-11"
						>
							{inbox.isFetchingNextPage ? "Loading…" : "Load more"}
						</button>
					</div>
				)}

				{first && first.mailboxes.length > 0 && (
					<p className="mt-4 text-center text-xs text-text-tertiary">
						Across {first.mailboxes.length} mailbox{first.mailboxes.length === 1 ? "" : "es"}.{" "}
						<button type="button" onClick={() => navigate("/")} className="font-medium text-accent underline-offset-2 hover:underline touch:min-h-11">
							Open one mailbox
						</button>
					</p>
				)}
			</PageContainer>
				</div>
			</div>
		</DashboardLayout>
	);
}
