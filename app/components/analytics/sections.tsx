/**
 * Engagement, Inbound and DMARC tabs of the analytics console. Each reads
 * its own query response, so one slow Cloudflare call doesn't block the rest.
 *
 * Copy rule: labels are short and plain; definitions, units and caveats sit
 * behind an ⓘ (`InfoTip`) next to the number they explain.
 */
import * as React from "react";
import { Link } from "react-router";
import { ShieldCheck } from "lucide-react";
import type { DmarcResponse, EngagementResponse, InboundResponse } from "../../../shared/analytics-types";
import { BarList, ColumnChart } from "./charts";
import {
	authSegments,
	type AuthSegmentKind,
	catchAllBreakdown,
	engagementAttribution,
	engagementBase,
	fillDays,
	formatCount,
	formatDateTime,
	formatRate,
	humanize,
	isCatchAllMatcher,
	isWebUrl,
	knownUnroutedAddresses,
	messageSearchHref,
	nonEmptySeries,
	ofTotal,
	plural,
	rejectionBreakdown,
	safeRate,
	seriesSummary,
	shortUrl,
	sortEngagementMessages,
	type EngagementSort,
	type UnroutedAddress,
	unownedAddressRoute,
	unownedRows,
	type UnownedRow,
} from "./format";
import { isAuthRefusalDetail } from "../../../shared/analytics-types";
import { Addr, Alert, AlertGroup, Chip, EmptyNote, InfoTip, Panel, ResponsiveTable, Segmented, TileRow, type Tone } from "./primitives";
import { PanelTitle } from "./sending";
import { cn } from "~/lib/utils";

// ── Engagement ────────────────────────────────────────────────────────────

/** Nothing tracked and nothing opened: the tab shows one empty state. */
export function engagementIsEmpty(d: EngagementResponse): boolean {
	return d.messages.length === 0 && d.links.length === 0 && d.totals.opens === 0 && d.totals.clicks === 0;
}

export function EngagementPanel({ data }: { data: EngagementResponse }) {
	const [tab, setTab] = React.useState<"messages" | "links">("messages");
	const [showAll, setShowAll] = React.useState(false);
	const [sort, setSort] = React.useState<EngagementSort>("activity");
	const ordered = React.useMemo(() => sortEngagementMessages(data.messages, sort), [data.messages, sort]);
	const t = data.totals;
	const tracked = t.sent_messages ?? data.messages.length;
	const engagedCount = data.messages.filter((m) => m.opens > 0 || m.clicks > 0).length;
	// Every engaged row plus a few more; the long tail of zero rows sits behind "Show all".
	const LIMIT = Math.max(4, engagedCount + 3);
	const messages = showAll ? ordered : ordered.slice(0, LIMIT);
	const tabId = React.useId();
	const attributed = engagementAttribution(t, data.messages) === "ok";
	// The denominator behind open_rate/click_rate (delivered messages).
	const base = engagementBase(t);
	const pending = pendingOf(t, data.messages);
	const tabs = (["messages", "links"] as const).filter((k) => k === "messages" || data.links.length > 0);
	// Below 20 delivered messages a rate is noise ("100%" from 1 of 1): lead with the count.
	const small = base != null && base < 20;
	const rateOr = (n: number, rate: number | null) => (small ? formatCount(n) : formatRate(rate));
	return (
		<div className="space-y-4">
			<div>
			<TileRow
				label="Engagement summary"
				tiles={[
					{
						key: "opened",
						label: "Opened",
						value: rateOr(t.unique_opens, t.open_rate),
						sub: base != null ? (small ? `of ${formatCount(base)} delivered · ${formatRate(t.open_rate)}` : `${ofTotal(t.unique_opens, base)} delivered`) : plural(t.unique_opens, "message"),
						info: `${plural(t.opens, "open")} in all, on delivered messages. ${data.note}`,
					},
					{
						key: "clicked",
						label: "Clicked",
						value: rateOr(t.unique_clicks, t.click_rate),
						sub: base != null ? (small ? `of ${formatCount(base)} delivered · ${formatRate(t.click_rate)}` : `${ofTotal(t.unique_clicks, base)} delivered`) : plural(t.unique_clicks, "message"),
					},
					{
						key: "ctor",
						label: "Click to open",
						value: formatRate(t.ctor),
						sub: t.unique_opens ? `${ofTotal(t.unique_clicks, t.unique_opens)} opened` : "No opens yet",
						info: "Opened messages that were also clicked.",
					},
					{
						key: "tracked",
						label: "Tracked",
						value: formatCount(tracked),
						sub: "messages",
						info: `Messages sent from this app with open and click tracking on: ${trackedBreakdown(tracked, base, pending) || "none yet"}.`,
					},
				]}
			/>
			</div>
			<Panel>
				<div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2 sm:px-5">
					{tabs.length > 1 ? (
						<div role="tablist" aria-label="Engagement detail" className="inline-flex gap-0.5 rounded-[8px] bg-bg-subtle p-0.5 ring-1 ring-border">
							{tabs.map((k) => (
								<button
									key={k}
									type="button"
									role="tab"
									id={`${tabId}-${k}`}
									aria-selected={tab === k}
									aria-controls={tab === k ? `${tabId}-${k}-panel` : undefined}
									tabIndex={tab === k ? 0 : -1}
									onClick={() => setTab(k)}
									onKeyDown={(e) => {
										if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
											e.preventDefault();
											const next = k === "messages" ? "links" : "messages";
											setTab(next);
											document.getElementById(`${tabId}-${next}`)?.focus();
										}
									}}
									className={cn(
										"h-8 rounded-md px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch:h-11",
										tab === k ? "bg-card text-text-primary shadow-sm ring-1 ring-border" : "text-text-secondary hover:text-text-primary",
									)}
								>
									{k === "messages" ? `Messages (${data.messages.length})` : `Links (${data.links.length})`}
								</button>
							))}
						</div>
					) : (
						<h3 className="text-sm font-medium text-text-primary">Messages ({data.messages.length})</h3>
					)}
					{tab === "messages" && data.messages.length > 1 && (
						<Segmented
							label="Sort messages"
							value={sort}
							onChange={setSort}
							options={[
								{ value: "activity", label: "Most active", title: "Clicks, then opens, first" },
								{ value: "newest", label: "Newest" },
							]}
						/>
					)}
				</div>
				<div role={tabs.length > 1 ? "tabpanel" : undefined} id={`${tabId}-${tab}-panel`} aria-labelledby={tabs.length > 1 ? `${tabId}-${tab}` : undefined}>
					{tab === "messages" && !attributed && (
						<p className="flex items-center gap-1 border-b border-border px-4 py-2 text-xs text-text-secondary sm:px-5">
							No per-message counts yet
							<InfoTip label="Why per-message counts are missing">
								{plural(t.opens, "open")} and {plural(t.clicks, "click")} were counted for the period as a whole, but
								aren't attributed to individual messages yet.
							</InfoTip>
						</p>
					)}
					{tab === "messages" ? (
						<ResponsiveTable
							caption="Engagement per message"
							rows={messages}
							rowKey={(m) => m.email_id}
							empty={<EmptyNote title="No tracked messages" />}
							columns={[
								{
									key: "subject",
									header: "Message",
									primary: true,
									cell: (m) => (
										<div className="min-w-0">
											<Link
												to={messageSearchHref(m.mailbox, m.subject)}
												className="block break-words font-medium touch:flex touch:min-h-11 touch:items-center text-text-primary underline-offset-2 hover:text-accent-subtle-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
											>
												{m.subject || "(no subject)"}
											</Link>
											<p className="mt-0.5 flex flex-wrap items-center gap-x-1 gap-y-1 text-xs font-normal text-text-secondary">
												<span>
													<Addr>{m.mailbox}</Addr>, {formatDateTime(m.sent_at)}
													<span className="sm:hidden">, {plural(m.recipients, "recipient")}</span>
												</span>
												{m.outcome === "pending" && (
													<Chip icon={null} title="Cloudflare hasn't confirmed delivery yet, so it's not in the rate.">
														Pending
													</Chip>
												)}
											</p>
										</div>
									),
								},
								{ key: "rcpt", header: "Recipients", align: "right", hideOnMobile: true, cell: (m) => formatCount(m.recipients) },
								...(attributed
									? [
											{
												key: "opens",
												header: "Opened",
												align: "right" as const,
												emptyOnMobile: (m: EngagementResponse["messages"][number]) => !m.unique_opens,
												cell: (m: EngagementResponse["messages"][number]) =>
													m.unique_opens ? (
														<span title={`${plural(m.unique_opens, "recipient")} opened it, ${plural(m.opens, "pixel load")} in all`}>
															{plural(m.opens, "open")}
															<span className="block text-xs text-text-secondary">by {plural(m.unique_opens, "recipient")}</span>
														</span>
													) : (
														<span className="text-text-secondary">0</span>
													),
											},
											{
												key: "clicks",
												header: "Clicks",
												align: "right" as const,
												emptyOnMobile: (m: EngagementResponse["messages"][number]) => !m.clicks,
												cell: (m: EngagementResponse["messages"][number]) =>
													m.clicks ? formatCount(m.clicks) : <span className="text-text-secondary">0</span>,
											},
											{
												key: "first",
												header: "First open",
												align: "right" as const,
												emptyOnMobile: (m: EngagementResponse["messages"][number]) => !m.first_open_at,
												cell: (m: EngagementResponse["messages"][number]) =>
													m.first_open_at ? formatDuration(m.sent_at, m.first_open_at) : <span className="text-text-secondary">—</span>,
											},
										]
									: []),
							]}
						/>
					) : (
						<ResponsiveTable
							caption="Clicks per link"
							rows={data.links}
							rowKey={(l) => l.url}
							columns={[
								{
									key: "url",
									header: "Link",
									primary: true,
									cell: (l) =>
										isWebUrl(l.url) ? (
											<a
												href={l.url}
												target="_blank"
												rel="noopener noreferrer nofollow"
												title={l.url}
												className="font-medium text-text-primary underline-offset-2 [overflow-wrap:anywhere] hover:text-accent-subtle-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
											>
												{shortUrl(l.url)}
											</a>
										) : (
											// Tracked links come from composed mail; only http(s) is clickable.
											<span className="font-medium [overflow-wrap:anywhere]">{l.url}</span>
										),
								},
								{ key: "clicks", header: "Clicks", align: "right", cell: (l) => formatCount(l.clicks) },
								{ key: "unique", header: "Unique", align: "right", cell: (l) => formatCount(l.unique_clicks) },
								{ key: "msgs", header: "In messages", align: "right", cell: (l) => formatCount(l.messages) },
							]}
						/>
					)}
					{tab === "messages" && data.messages.length > LIMIT && (
						<div className="border-t border-border px-4 py-1.5 sm:px-5">
							<button
								type="button"
								onClick={() => setShowAll((v) => !v)}
								aria-expanded={showAll}
								className="h-9 rounded-md text-sm font-medium text-accent-subtle-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								{showAll ? "Show fewer" : `Show all ${data.messages.length}`}
							</button>
						</div>
					)}
				</div>
			</Panel>
		</div>
	);
}

/**
 * Messages waiting for a delivery verdict: the Worker's `pending_messages`
 * (same rule as the overview), else the rows marked pending.
 */
function pendingOf(t: EngagementResponse["totals"], rows: EngagementResponse["messages"]): number {
	if (typeof t.pending_messages === "number") return t.pending_messages;
	if (rows.some((m) => m.outcome)) return rows.filter((m) => m.outcome === "pending").length;
	// An older Worker sends neither: everything not delivered is unconfirmed.
	const sent = t.sent_messages ?? rows.length;
	return typeof t.delivered_messages === "number" && t.rate_base === "delivered" ? Math.max(0, sent - t.delivered_messages) : 0;
}

/** "16 delivered · 1 pending": where every tracked message stands. */
function trackedBreakdown(tracked: number, delivered: number | null, pending: number): string {
	const parts: string[] = [];
	if (delivered != null) parts.push(`${formatCount(delivered)} delivered`);
	if (pending) parts.push(`${formatCount(pending)} pending`);
	const other = delivered != null ? tracked - delivered - pending : 0;
	if (other > 0) parts.push(`${formatCount(other)} failed`);
	return parts.join(" · ");
}

function formatDuration(fromIso: string, toIso: string): string {
	const ms = Date.parse(toIso) - Date.parse(fromIso);
	if (!Number.isFinite(ms) || ms < 0) return "—";
	const m = Math.round(ms / 60_000);
	if (m < 1) return "<1m later";
	if (m < 60) return `${m}m later`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h later`;
	return `${Math.round(h / 24)}d later`;
}

// ── Inbound ───────────────────────────────────────────────────────────────

const AUTH_LABEL = { spf: "SPF", dkim: "DKIM", dmarc: "DMARC" } as const;

/** A routing error that is a refused spoof: the Worker's `reason`, else the detail text. */
const isBlockedSpoof = (e: InboundResponse["routing_errors"][number]) => e.reason === "auth" || isAuthRefusalDetail(e.detail);

export function inboundIsEmpty(d: InboundResponse): boolean {
	return d.received === 0 && d.stored === 0 && d.rules.length === 0;
}

const GAP_REASON: Record<string, string> = {
	date_header: "stored mail is dated by its Date header, while Cloudflare counts by event time",
	local_routing: "aliases can file one message into more than one mailbox",
	scan_cap: "the local count hit its scan limit",
};

/** Why "Stored" can differ from "Handed to this app" (stored_gap). */
function storedGapText(rec: NonNullable<InboundResponse["reconciliation"]>): string {
	const gap = rec.stored_gap;
	const reasons = rec.stored_gap_reasons.map((r) => GAP_REASON[r]).filter(Boolean);
	return `Stored is ${formatCount(Math.abs(gap))} ${gap > 0 ? "more" : "fewer"} than handed to this app because ${
		reasons.length ? reasons.join(", and ") : "the two are counted from different sources"
	}.`;
}

export function InboundPanel({ data, isAdmin }: { data: InboundResponse; isAdmin: boolean }) {
	const rows = React.useMemo(
		() => fillDays(data.timeseries, data.window.start, data.window.end, (date) => ({ date, received: 0, spam: 0 })),
		[data.timeseries, data.window.start, data.window.end],
	);
	const unowned = React.useMemo(() => unownedRows(data.by_address, data.rules), [data.by_address, data.rules]);
	const cf = data.provider.configured && !data.provider.window_capped;
	const rec = data.reconciliation;
	const catchAll = catchAllBreakdown(data.rules, rec?.catch_all);
	const unrouted = knownUnroutedAddresses(data.rules);
	const handled = rec?.handled_by_worker;
	const allBlocked = data.routing_errors.length > 0 && data.routing_errors.every(isBlockedSpoof);
	const rejectedAuth = data.actions.filter((a) => a.reason === "auth").reduce((n, a) => n + a.count, 0);
	const gapInfo = rec && rec.stored_gap !== 0 ? storedGapText(rec) : null;

	return (
		<div className="space-y-4">
			<AlertGroup
				items={[
					unrouted.length > 0 && <UnroutedMailboxes key="unrouted" rows={unrouted} rules={data.rules} isAdmin={isAdmin} />,
					unowned.length > 0 && <UnownedAddresses key="unowned" rows={unowned} isAdmin={isAdmin} catchAll={catchAll} />,
				]}
			/>
			<div>
			<TileRow
				label="Inbound summary"
				tiles={[
					{
						key: "received",
						label: "Received",
						value: formatCount(data.received),
						sub: "On your domains",
						info: cf ? "Messages arriving on your domains, counted by Cloudflare." : "Messages, counted by this app.",
					},
					...(handled != null
						? [
								{
									key: "handled",
									label: "To this app",
									value: formatCount(handled),
									sub: `${formatRate(safeRate(handled, data.received))} of received`,
									info: 'Handed to this app\'s Worker, by Cloudflare event time. Cloudflare labels these "Handled by worker" (dropped).',
								},
							]
						: []),
					{
						key: "stored",
						label: "Stored",
						value: formatCount(data.stored),
						sub: "In mailboxes",
						info: `Messages in this app's mailboxes, dated by their Date header.${gapInfo ? ` ${gapInfo}` : ""}`,
					},
					{
						key: "spam",
						label: "Spam",
						value: formatCount(data.spam_filed),
						sub: `${formatRate(safeRate(data.spam_filed, data.stored))} of stored`,
					},
				]}
			/>
			</div>

			{data.received > 0 && (
				<Panel className="p-4 sm:p-5">
					<h3 className="mb-3 text-sm font-medium text-text-primary">Received per day</h3>
					<ColumnChart
						rows={rows}
						label="Inbound mail per day"
						unit="messages"
						series={nonEmptySeries(rows, [
							{ key: "clean", label: "Not spam", color: "var(--viz-1)", value: (r: (typeof rows)[number]) => Math.max(0, r.received - r.spam) },
							{ key: "spam", label: "Spam", color: "var(--viz-2)", value: (r: (typeof rows)[number]) => r.spam },
						])}
						summary={`${seriesSummary("Received", rows.map((r) => ({ date: r.date, value: r.received })))} ${seriesSummary("Spam", rows.map((r) => ({ date: r.date, value: r.spam })))}`}
					/>
				</Panel>
			)}

			{(cf || data.actions.length > 0 || data.by_address.length > 0) && (
				<div className="grid gap-4">
					{cf && (
						<Panel className="p-4 sm:p-5">
							<h3 className="flex items-center gap-1 text-sm font-medium text-text-primary">
								Sender authentication
								<InfoTip label="About sender authentication">
									Mail arriving on your domains, per check. The rate counts only mail that was evaluated (pass or
									fail). "None" means there was nothing to check: no SPF record, DKIM signature or DMARC policy. It's
									common, not a failure.
								</InfoTip>
							</h3>
							<ul className="mt-3 space-y-4">
								{(Object.keys(AUTH_LABEL) as (keyof typeof AUTH_LABEL)[]).map((k) => (
									<AuthRow key={k} id={k} label={AUTH_LABEL[k]} rec={data.auth[k]} />
								))}
							</ul>
						</Panel>
					)}
					{data.rules.length === 0 && (data.actions.length > 0 || data.by_address.length > 0) && (
						<Panel className="p-4 sm:p-5">
							{data.actions.length > 0 && (
								<>
									<h3 className="flex items-center gap-1 text-sm font-medium text-text-primary">
										Routing
										<InfoTip label="About routing actions">
											What Cloudflare routing did. Mail handed to this app's Worker shows as "dropped" in Cloudflare;
											it is relabelled "To this app" here.
											{rejectedAuth > 0 && ` ${rejectionText(data.auth.spf, rejectedAuth)}`}
										</InfoTip>
									</h3>
									<div className="mt-3">
										<BarList
											label="Routing actions"
											rows={[...data.actions].filter((a) => !(handled != null && a.label === "Handled by worker")).sort((a, b) => b.count - a.count)}
											value={(a) => a.count}
											name={(a) => (
												<>
													<span className="truncate">
														{a.reason === "auth" ? "Rejected (hard SPF fail)" : a.label === "Handled by worker" ? "To this app" : a.label}
													</span>
													{a.reason === "auth" ? (
														<Chip icon={ShieldCheck} title="Spoofed or unauthenticated mail that routing refused, as it should.">
															Blocked spoof
														</Chip>
													) : (
														a.status === "error" && <Chip tone="critical">Error</Chip>
													)}
												</>
											)}
										/>
									</div>
								</>
							)}
							{data.by_address.length > 0 && data.rules.length === 0 && (
								<>
									<h3 className={cn("text-sm font-medium text-text-primary", data.actions.length > 0 && "mt-5 border-t border-border pt-4")}>
										Top addresses
									</h3>
									<div className="mt-3">
										<BarList
											label="Top recipient addresses"
											rows={data.by_address.slice(0, 5)}
											value={(a) => a.count}
											name={(a) => {
												const route = unownedAddressRoute(a.address, a.has_mailbox, data.rules);
												return (
													<>
														<span className="truncate">{a.address}</span>
														{route && (
															<Chip tone={route.kind === "dropped" ? "critical" : "neutral"} icon={null}>
																{route.kind === "dropped" ? "Not kept" : "No mailbox"}
															</Chip>
														)}
													</>
												);
											}}
										/>
									</div>
								</>
							)}
						</Panel>
					)}
				</div>
			)}

			{data.rules.length > 0 && (
				<Panel>
					<PanelTitle
						title="Routing rules"
						info={`Cloudflare Email Routing rules, with messages matched in this period. Mail handed to this app's Worker shows as "dropped" in Cloudflare; it is relabelled "To this app" here.${
							rejectedAuth > 0 ? ` ${rejectionText(data.auth.spf, rejectedAuth)}` : ""
						}`}
						actions={
							data.actions.length > 0 ? (
								<ul aria-label="Routing actions" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
									{[...data.actions]
										.sort((a, b) => b.count - a.count)
										.map((a) => (
											<li key={`${a.action}|${a.status}|${a.reason ?? ""}`}>
												{a.reason === "auth" ? "Rejected (SPF)" : a.label === "Handled by worker" ? "To this app" : a.label}{" "}
												<span className={cn("font-medium tabular-nums", a.status === "error" && !a.reason ? "text-destructive" : "text-text-primary")}>
													{formatCount(a.count)}
												</span>
											</li>
										))}
								</ul>
							) : undefined
						}
					/>
					<ResponsiveTable
						caption="Routing rules"
						mobileLimit={4}
						rows={[...data.rules].sort((a, b) => b.count - a.count)}
						rowKey={(r) => r.id}
						columns={[
							{
								key: "matcher",
								header: "Address",
								primary: true,
								cell: (r) => (
									<div className="min-w-0">
										<span className="flex flex-wrap items-center gap-1.5">
											{isCatchAllMatcher(r.matcher) ? <span>Catch&#8209;all</span> : <Addr>{r.matcher}</Addr>}
											{!r.enabled && <Chip>Off</Chip>}
										</span>
										{r.name && !(isCatchAllMatcher(r.matcher) && /catch.?all/i.test(r.name)) && r.name.toLowerCase() !== r.matcher.toLowerCase() && (
											<p className="mt-0.5 break-words text-xs font-normal text-text-secondary">{r.name}</p>
										)}
									</div>
								),
							},
							{
								key: "action",
								header: "Goes to",
								wideOnMobile: true,
								emptyOnMobile: (r) => r.action === "worker",
								cell: (r) => (
									<span>
										{r.action === "worker" ? (
											"This app"
										) : r.action === "forward" ? (
											<>
												Forward to <Addr>{r.destination ?? "?"}</Addr>
											</>
										) : (
											humanize(r.action)
										)}
									</span>
								),
							},
							{
								key: "count",
								header: "Matched",
								align: "right",
								cell: (r) => (
									<span>
										{formatCount(r.count)}
										{r.errors > 0 && (
											<span className="text-xs text-text-secondary sm:block">
												<span className="sm:hidden"> · </span>
												{formatCount(Math.max(0, r.count - r.errors))} delivered
											</span>
										)}
									</span>
								),
							},
							{
								key: "errors",
								header: "Errors",
								emptyOnMobile: (r) => !r.errors,
								align: "right",
								cell: (r) => {
									if (!r.errors) return <span className="text-text-secondary">—</span>;
									// Errors that are all refused spoofs to this address aren't faults.
									const mine = data.routing_errors.filter((e) => e.to.toLowerCase() === r.matcher.toLowerCase());
									const blocked = mine.length >= r.errors && mine.every(isBlockedSpoof);
									return blocked ? (
										<Chip icon={ShieldCheck} title="Spoofed mail refused on sender authentication, as it should be.">
											{formatCount(r.errors)} blocked
										</Chip>
									) : (
										<Chip tone="critical">{formatCount(r.errors)}</Chip>
									);
								},
							},
						]}
					/>
				</Panel>
			)}

			{data.routing_errors.length > 0 && (
				<Panel>
					<PanelTitle
						title={allBlocked ? "Blocked at routing" : "Routing errors"}
						info={
							allBlocked
								? "Mail Cloudflare refused because the sending server isn't allowed to send for the From domain (hard SPF fail): forged mail blocked as intended. Nothing to fix."
								: "Mail Cloudflare refused or couldn't hand over. Blocked spoofs are routing working as intended."
						}
					/>
					<ResponsiveTable
						caption="Routing errors"
						rows={data.routing_errors}
						rowKey={(e) => `${e.at}|${e.from}|${e.to}`}
						columns={[
							{
								key: "detail",
								header: "Reason",
								primary: true,
								cell: (e) => (
									<div className="min-w-0">
										{isBlockedSpoof(e) ? (
											<Chip icon={ShieldCheck} className="mb-1" title="Refused on sender authentication, as it should be.">
												Blocked spoof
											</Chip>
										) : (
											<Chip tone="critical" className="mb-1">
												Error
											</Chip>
										)}
										<p className="break-words font-normal text-text-secondary">{shortDetail(e.detail, e.from)}</p>
									</div>
								),
							},
							{ key: "from", header: "From", wideOnMobile: true, cell: (e) => <Addr>{e.from}</Addr> },
							{ key: "to", header: "To", wideOnMobile: true, cell: (e) => <Addr>{e.to}</Addr> },
							{ key: "at", header: "When", align: "right", cell: (e) => <span className="whitespace-nowrap">{formatDateTime(e.at)}</span> },
						]}
					/>
				</Panel>
			)}
		</div>
	);
}

/** "66.98.68.188 isn't allowed to send email for X@y.com" → "66.98.68.188 not allowed to send for this sender". */
function shortDetail(detail: string, from: string): string {
	const d = detail.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "this sender");
	return d.replace(/isn't allowed to send email for/i, "not allowed to send for");
}

/**
 * Reconciles "Rejected (hard SPF fail)" with the auth fail counts: routing
 * refuses hard SPF fails only; softfail, temperror and permerror pass through
 * to the rule, and DMARC fail is the sender's policy for receivers to apply.
 */
function rejectionText(spf: Record<string, number>, rejected: number): string {
	const b = rejectionBreakdown(spf, rejected);
	const through = b.passedThrough.reduce((n, v) => n + v.count, 0);
	return `Routing rejects hard SPF fails only: ${formatCount(b.rejected)} of ${plural(b.spfFail, "hard SPF fail")}.${
		through > 0
			? ` ${b.passedThrough.map((v) => `${formatCount(v.count)} ${v.verdict}`).join(", ")} passed through to the rule. DMARC fails aren't rejected at routing.`
			: ""
	}`;
}

/** Address list inside an alert: one column on a phone, two from md up. */
function AddressList({
	label,
	rows,
	isAdmin,
	chip,
}: {
	label: string;
	rows: { address: string; count: number; destination?: string | null; kind?: string }[];
	isAdmin: boolean;
	chip?: (r: { kind?: string }) => React.ReactNode;
}) {
	return (
		<ul aria-label={label} className="mt-2 text-sm sm:ml-6">
			{rows.map((r) => (
				<li key={r.address} className="grid min-w-0 grid-cols-[minmax(0,1fr)_3.5rem_auto] items-center gap-3 border-t border-border py-1">
					<span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 text-text-primary">
						<Addr>{r.address}</Addr>
						{r.destination && (
							<span className="text-xs text-text-secondary">
								{r.destination.includes("→") ? r.destination : <>→ <Addr>{r.destination}</Addr></>}
							</span>
						)}
						{chip?.(r)}
					</span>
					<span className="text-right tabular-nums text-text-primary">
						{formatCount(r.count)}
						<span className="sr-only"> {r.count === 1 ? "message" : "messages"}</span>
					</span>
					{isAdmin && !r.destination ? (
						<Link
							to={`/?new=${encodeURIComponent(r.address)}`}
							aria-label={`Create a mailbox for ${r.address}`}
							className="inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-md px-2 text-xs font-medium text-accent-subtle-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch:h-11 touch:min-w-11 touch:justify-center"
						>
							Create
						</Link>
					) : (
						<span />
					)}
				</li>
			))}
		</ul>
	);
}

/**
 * Addresses that have a mailbox here, but no Cloudflare routing rule hands
 * their mail to this app, so it goes to a forward and never reaches the mailbox.
 */
function UnroutedMailboxes({
	rows,
	rules,
	isAdmin,
}: {
	rows: UnroutedAddress[];
	rules: InboundResponse["rules"];
	isAdmin: boolean;
}) {
	const total = rows.reduce((a, r) => a + r.count, 0);
	// "→ a@gmail.com 4 · catch-all → b@gmail.com 7": every place the mail went.
	const split = (address: string) =>
		rules
			.filter((r) => r.action !== "worker")
			.flatMap((r) => {
				const hit = (r.addresses ?? []).find((a) => a.address.toLowerCase() === address.toLowerCase());
				return hit && hit.count > 0
					? [`${r.catch_all || isCatchAllMatcher(r.matcher) ? "catch-all" : "own rule"} → ${r.destination ?? humanize(r.action)} (${formatCount(hit.count)})`]
					: [];
			})
			.join(" · ");
	return (
		<Alert
			title={
				<>
					{rows.length === 1
						? "1 mailbox's mail is forwarded elsewhere, not to this app"
						: `${rows.length} mailboxes' mail is forwarded elsewhere, not to this app`}{" "}
					<span className="font-normal text-text-secondary">({plural(total, "message")})</span>
				</>
			}
			info={`${rows.length === 1 ? "This address has" : "These addresses have"} a mailbox here, but no enabled routing rule hands ${
				rows.length === 1 ? "its" : "their"
			} mail to this app: a forward rule or the catch-all sends it on instead. Point a rule at this app in Settings → Domains.`}
			action={isAdmin ? { label: "Fix routing", to: "/settings/domains" } : undefined}
		>
			<AddressList
				label="Mailboxes whose mail is forwarded elsewhere"
				rows={rows.map((r) => ({ address: r.address, count: r.count, destination: split(r.address) || r.destination }))}
				isAdmin={false}
			/>
		</Alert>
	);
}

/**
 * Addresses that get mail but have no mailbox here. A catch-all forward to a
 * personal inbox is often on purpose, so only lost mail is a warning.
 */
function UnownedAddresses({
	rows,
	isAdmin,
	catchAll,
}: {
	rows: UnownedRow[];
	isAdmin: boolean;
	catchAll: ReturnType<typeof catchAllBreakdown>;
}) {
	const [expanded, setExpanded] = React.useState(false);
	const LIMIT = 6;
	const sorted = [...rows].sort((a, b) => b.count - a.count);
	const visible = expanded ? sorted : sorted.slice(0, LIMIT);
	const total = rows.reduce((a, r) => a + r.count, 0);
	const kinds = new Set(rows.map((r) => r.route?.kind));
	const lost = kinds.has("dropped") || kinds.has("unrouted") || total >= 25;
	const destinations = [
		...new Set(rows.flatMap((r) => (r.route?.kind === "catch_all" && r.route.destination ? [r.route.destination] : []))),
	];
	const info = [
		kinds.has("catch_all")
			? `This mail goes to the catch-all forward${destinations.length === 1 ? ` to ${destinations[0]}` : ""}, not to this app. That's fine if it's on purpose; create a mailbox to read it here.`
			: "",
		catchAll && catchAll.total > 0 && kinds.has("catch_all")
			? `${formatCount(catchAll.total)} matched the catch-all: ${plural(catchAll.unknown, "message")} to addresses with no mailbox${
					catchAll.known > 0
						? `, ${formatCount(catchAll.known)} to ${catchAll.known === 1 ? "an address that has" : "addresses that have"} a mailbox but no routing rule`
						: ""
				}.`
			: "",
		kinds.has("dropped") ? "Mail marked Not kept reaches this app, which has no mailbox to store it in." : "",
		kinds.has("unrouted") ? "Mail marked Unrouted matches no routing rule." : "",
	]
		.filter(Boolean)
		.join(" ");
	return (
		<Alert
			tone={lost ? "warning" : "neutral"}
			title={
				<>
					{rows.length === 1 ? "1 address has no mailbox" : `${rows.length} addresses have no mailbox`}{" "}
					<span className="font-normal text-text-secondary">({plural(total, "message")})</span>
				</>
			}
			info={info}
			action={isAdmin ? { label: "Domains and aliases", to: "/settings/domains" } : undefined}
		>
			<AddressList
				label="Addresses without a mailbox"
				rows={visible.map((r) => ({ address: r.address, count: r.count, kind: r.route?.kind }))}
				isAdmin={isAdmin}
				chip={(r) =>
					r.kind === "dropped" ? <Chip tone="critical">Not kept</Chip> : r.kind === "unrouted" ? <Chip>Unrouted</Chip> : null
				}
			/>
			{sorted.length > LIMIT && (
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					aria-expanded={expanded}
					className="mt-1 inline-flex h-8 items-center rounded-md text-sm font-medium text-accent-subtle-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch:h-11"
				>
					{expanded ? "Show fewer" : `Show all ${sorted.length}`}
				</button>
			)}
		</Alert>
	);
}

/** What "none" means for each check. */
const NONE_MEANS: Record<keyof typeof AUTH_LABEL, string> = {
	spf: "The sending domain publishes no SPF record, so there was nothing to check. Not a failure.",
	dkim: "The message carried no DKIM signature, so there was nothing to verify. Not a failure.",
	dmarc: "The sender's domain publishes no DMARC policy, so there was nothing to enforce. Common, and not a failure.",
};

const SEGMENT_STYLE: Record<DisplayKind, React.CSSProperties> = {
	other: { backgroundColor: "var(--viz-warn)" },
	blocked: { backgroundColor: "var(--viz-blocked)" },
	pass: { backgroundColor: "var(--viz-1)" },
	// Hatched, so "none" reads as "not evaluated" without relying on colour.
	none: {
		backgroundColor: "var(--viz-none)",
		backgroundImage: "repeating-linear-gradient(135deg, transparent 0 3px, var(--viz-none-stripe) 3px 5px)",
	},
	fail: { backgroundColor: "var(--viz-fail)" },
};

type DisplayKind = AuthSegmentKind | "other" | "blocked";

const SEGMENT_LABEL: Record<DisplayKind, string> = { pass: "Pass", none: "None", fail: "Fail", other: "Soft fail", blocked: "Blocked" };

/**
 * One check as a pass / none / fail bar. The headline rate is pass over
 * evaluated mail (pass + fail); coverage and the verdict detail are in the ⓘ.
 */
function AuthRow({ id, label, rec }: { id: keyof typeof AUTH_LABEL; label: string; rec: Record<string, number> }) {
	const a = authSegments(rec);
	const fail = a.segments[2];
	const coverage = safeRate(a.evaluated, a.total);
	const lowCoverage = coverage != null && coverage < 0.5;
	// Hard "fail" stays red; softfail/temperror/permerror/neutral get amber.
	const hard = fail.verdicts.filter((v) => v.verdict.toLowerCase() === "fail").reduce((n, v) => n + v.count, 0);
	const shown: { kind: DisplayKind; count: number }[] = [
		{ kind: "pass" as const, count: a.segments[0].count },
		{ kind: "none" as const, count: a.segments[1].count },
		// SPF hard fails are refused at routing (blocked), so they are not shown as an alarm.
		{ kind: id === "spf" ? ("blocked" as const) : ("fail" as const), count: hard },
		{ kind: "other" as const, count: fail.count - hard },
	].filter((s) => s.count > 0);
	const soft = fail.verdicts.filter((v) => v.verdict.toLowerCase() !== "fail");
	const summary = `${label}: ${formatRate(a.passRate)} of evaluated mail passed (${ofTotal(a.segments[0].count, a.evaluated)}). ${shown
		.map((s) => `${SEGMENT_LABEL[s.kind]} ${formatCount(s.count)}`)
		.join(", ")} of ${formatCount(a.total)} messages.`;
	const info = [
		`Coverage: ${ofTotal(a.evaluated, a.total)} evaluated (${formatRate(coverage)}); ${ofTotal(a.segments[0].count, a.evaluated)} of those passed.`,
		a.segments[1].count ? `None: ${NONE_MEANS[id]}` : "",
		soft.length ? `Soft fail or error: ${soft.map((v) => `${formatCount(v.count)} ${v.verdict}`).join(", ")}${id === "spf" ? "; these aren't rejected at routing" : ""}.` : "",
		id === "spf" && hard ? "Hard SPF fails are blocked at routing." : "",
		id === "dmarc" && hard ? "Fail: the sender's own DMARC policy didn't pass. Routing still delivers it; check the Spam folder." : "",
	]
		.filter(Boolean)
		.join(" ");
	return (
		<li>
			<div className="flex items-center justify-between gap-3 text-sm">
				<span className="flex items-center gap-1 font-medium text-text-primary">
					{label}
					<InfoTip label={`${label} detail`}>{info}</InfoTip>
				</span>
				<span className="text-right tabular-nums text-text-primary">
					{lowCoverage ? (
						// Most mail wasn't evaluated: lead with coverage so the pass rate isn't read as the whole picture.
						<>
							{formatRate(coverage)} <span className="text-text-secondary">checked, {formatRate(a.passRate)} passed</span>
						</>
					) : (
						<>
							{formatRate(a.passRate)} <span className="text-text-secondary">pass</span>
						</>
					)}
				</span>
			</div>
			<div role="img" aria-label={summary} className="mt-1.5 flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full bg-[var(--viz-track)]">
				{shown.map((s) => (
					<div
						key={s.kind}
						className="h-full first:rounded-l-full last:rounded-r-full"
						style={{ ...SEGMENT_STYLE[s.kind], width: `${(s.count / a.total) * 100}%`, minWidth: 4 }}
					/>
				))}
			</div>
			<ul className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary" aria-hidden>
				{shown.map((s) => (
					<li key={s.kind} className={cn("inline-flex items-center gap-1.5", s.kind === "fail" && "font-medium text-text-primary")}>
						<span className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]" style={SEGMENT_STYLE[s.kind]} />
						{SEGMENT_LABEL[s.kind]} <span className="tabular-nums text-text-primary">{formatCount(s.count)}</span>
					</li>
				))}
			</ul>
		</li>
	);
}

// ── DMARC ─────────────────────────────────────────────────────────────────

const passTone = (r: number): Tone => (r >= 0.98 ? "good" : r >= 0.9 ? "warning" : "critical");

export function dmarcIsEmpty(d: DmarcResponse): boolean {
	return d.totals.messages === 0;
}

export function DmarcPanel({ data }: { data: DmarcResponse }) {
	const t = data.totals;
	const [view, setView] = React.useState<"sources" | "reporters">("sources");
	const rows = React.useMemo(
		() => fillDays(data.timeseries, data.window.start, data.window.end, (date) => ({ date, messages: 0, pass: 0 })),
		[data.timeseries, data.window.start, data.window.end],
	);
	const failed = t.messages - t.pass;
	return (
		<div className="space-y-4">
			<div>
			<TileRow
				label="DMARC summary"
				tiles={[
					{
						key: "reported",
						label: "Reported",
						value: formatCount(t.messages),
						sub: `${plural(t.reporters, "provider")}`,
						info: "Mail sent as your domains, as mailbox providers reported it. Not every provider sends reports, and they lag a day or two. Inbound checks are under Inbound.",
					},
					{
						key: "pass",
						label: "DMARC pass",
						value: formatRate(safeRate(t.pass, t.messages)),
						sub: `${formatCount(failed)} failed`,
						info: "Passed SPF or DKIM with its domain matching the From domain (aligned).",
						tone: failed > 0 && safeRate(t.pass, t.messages)! < 0.9 ? "warning" : undefined,
					},
					{
						key: "spf",
						label: "SPF aligned",
						value: formatRate(safeRate(t.spf_pass, t.messages)),
						sub: ofTotal(t.spf_pass, t.messages),
						info: "SPF passed and its domain matched the From domain. DMARC passes when SPF or DKIM is aligned.",
					},
					{
						key: "dkim",
						label: "DKIM aligned",
						value: formatRate(safeRate(t.dkim_pass, t.messages)),
						sub: ofTotal(t.dkim_pass, t.messages),
					},
				]}
			/>
			</div>

			{data.failures.length > 0 && (
				<Panel>
					<PanelTitle title="Failing sources" info="Servers sending as your domains that failed DMARC: spoofing, or a service you forgot to authorise." />
					<ResponsiveTable
						caption="DMARC failures by source IP"
						rows={data.failures}
						rowKey={(f) => `${f.source_ip}|${f.header_from}`}
						columns={[
							{
								key: "ip",
								header: "Source",
								primary: true,
								cell: (f) => (
									<div className="min-w-0">
										<p className="font-medium tabular-nums [overflow-wrap:anywhere]">{f.source_ip}</p>
										<p className="mt-0.5 min-w-0 text-xs font-normal text-text-secondary">
											{f.org || "Unknown network"}
											{f.ptr && (
												<span className="block max-w-[18rem] truncate" title={f.ptr}>
													{f.ptr}
												</span>
											)}
										</p>
									</div>
								),
							},
							{ key: "from", header: "Header From", wideOnMobile: true, cell: (f) => <Addr>{f.header_from}</Addr> },
							{ key: "msgs", header: "Messages", align: "right", cell: (f) => formatCount(f.messages) },
							{
								key: "disp",
								header: "Disposition",
								cell: (f) =>
									f.disposition ? (
										<Chip tone={f.disposition === "none" ? "warning" : "neutral"} icon={null} title={f.disposition === "none" ? "Delivered anyway: the policy is p=none." : "The receiver refused or quarantined it."}>
											{humanize(f.disposition)}
										</Chip>
									) : (
										"—"
									),
							},
							{ key: "reason", header: "Override", emptyOnMobile: (f) => !f.reason, cell: (f) => <span className="whitespace-nowrap">{f.reason ? humanize(f.reason) : "—"}</span> },
						]}
					/>
				</Panel>
			)}

			<Panel className="p-4 sm:p-5">
				<h3 className="mb-3 text-sm font-medium text-text-primary">Reported per day</h3>
				<ColumnChart
					rows={rows}
					label="DMARC reported messages per day"
					unit="messages"
					series={nonEmptySeries(rows, [
						{ key: "pass", label: "Passed", color: "var(--viz-1)", value: (r: (typeof rows)[number]) => r.pass },
						{ key: "fail", label: "Failed", color: "var(--viz-3)", value: (r: (typeof rows)[number]) => Math.max(0, r.messages - r.pass) },
					])}
					partialLabel="reports still arriving"
					summary={`${seriesSummary("Reported", rows.map((r) => ({ date: r.date, value: r.messages })))} ${seriesSummary("Failed", rows.map((r) => ({ date: r.date, value: Math.max(0, r.messages - r.pass) })))}`}
				/>
			</Panel>

			<Panel>
				<PanelTitle
					title={view === "sources" ? "Sources" : "Reporters"}
					info={view === "sources" ? "Sending infrastructure seen by receivers, with how much of it passed." : "Mailbox providers that sent aggregate reports."}
					actions={
						<Segmented
							label="DMARC view"
							value={view}
							onChange={setView}
							options={[
								{ value: "sources", label: "Sources" },
								{ value: "reporters", label: "Reporters" },
							]}
						/>
					}
				/>
				{view === "sources" ? (
					<ResponsiveTable
						caption="DMARC sources"
						rows={data.sources}
						rowKey={(s) => s.org}
						columns={[
							{ key: "org", header: "Source", primary: true, cell: (s) => <span className="break-words">{s.org}</span> },
							{ key: "msgs", header: "Messages", align: "right", cell: (s) => formatCount(s.messages) },
							{ key: "pass", header: "DMARC pass", align: "right", cell: (s) => <Chip tone={passTone(s.pass_rate)}>{formatRate(s.pass_rate)}</Chip> },
							{ key: "spf", header: "SPF", align: "right", cell: (s) => formatRate(s.spf_pass_rate) },
							{ key: "dkim", header: "DKIM", align: "right", cell: (s) => formatRate(s.dkim_pass_rate) },
							{ key: "ips", header: "IPs", align: "right", cell: (s) => formatCount(s.ips) },
						]}
					/>
				) : (
					<div className="p-4 sm:p-5">
						<BarList label="DMARC reporters" rows={data.reporters} value={(r) => r.messages} name={(r) => <span className="truncate">{r.org}</span>} />
					</div>
				)}
			</Panel>
		</div>
	);
}
