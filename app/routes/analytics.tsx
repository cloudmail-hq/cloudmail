// Analytics: a deliverability console for every product sending on the zone.
//
// `/analytics/:section`, one tab per section in the same left nav as Settings
// (`SideNavLayout`). One compact header row carries the controls every tab
// shares (range, and on the sending tabs the scope and domain filter), and
// each tab fetches only the endpoints it reads (`shared/analytics-sections`).
// See app/components/analytics/.
import * as React from "react";
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { Ban, Gauge, Inbox, LayoutDashboard, MousePointerClick, RefreshCw, Send, ShieldCheck } from "lucide-react";
import DashboardLayout from "~/components/DashboardLayout";
import { SideNavLayout } from "~/components/ui/SideNavLayout";
import { useCurrentUser, useDashboardUser } from "~/queries/people";
import { useProducts } from "~/queries/products";
import {
	useAnalyticsDmarc,
	useAnalyticsEngagement,
	useAnalyticsInbound,
	useAnalyticsOverview,
	useRefreshAnalytics,
	useUsage,
} from "~/queries/analytics";
import { parseDays, type AnalyticsScope, type Days, type OverviewResponse } from "../../shared/analytics-types";
import {
	analyticsFilter,
	analyticsSectionForLegacyHash,
	resolveAnalyticsSection,
	sectionIsScoped,
	sectionNeeds,
	visibleAnalyticsSections,
	type AnalyticsSectionId,
} from "../../shared/analytics-sections";
import { RANGE_OPTIONS, formatRelative, suppressionScope } from "~/components/analytics/format";
import { AlertGroup, InfoTip, Panel, QueryState, Segmented, SkeletonRows, TabEmpty, VIZ_VARS } from "~/components/analytics/primitives";
import {
	ChartSkeleton,
	DomainsPanel,
	ErrorsPanel,
	dnsAlert,
	failingAlert,
	hasVolume,
	KpiSkeleton,
	KpiTiles,
	PanelTitle,
	providerNotices,
	QuotaPanel,
	ReputationPanel,
	reputationAlert,
	ReputationStrip,
	SendersPanel,
	SendingDetailTiles,
	SetupCard,
	SuppressionsPanel,
	VolumePanel,
} from "~/components/analytics/sending";
import {
	DmarcPanel,
	dmarcIsEmpty,
	EngagementPanel,
	engagementIsEmpty,
	InboundPanel,
	inboundIsEmpty,
} from "~/components/analytics/sections";
import { UsagePanel, UsageSkeleton } from "~/components/analytics/usage";
import { cn } from "~/lib/utils";
import SendingHealthPanel from "~/components/SendingHealthPanel";
import { useSendingHealth } from "~/queries/sending-health";

export function meta() {
	return [{ title: "Analytics" }];
}

const ICONS: Record<AnalyticsSectionId, React.ElementType> = {
	overview: LayoutDashboard,
	sending: Send,
	engagement: MousePointerClick,
	inbound: Inbox,
	dmarc: ShieldCheck,
	suppressions: Ban,
	usage: Gauge,
};

export default function AnalyticsPage() {
	const user = useDashboardUser();
	// Same cached query as `useDashboardUser`; read for its settled state.
	const me = useCurrentUser();
	const isAdmin = user?.role === "admin";
	const { section } = useParams();
	const location = useLocation();
	const navigate = useNavigate();
	const [params, setParams] = useSearchParams();

	const visible = React.useMemo(() => visibleAnalyticsSections({ isAdmin }), [isAdmin]);
	const current = resolveAnalyticsSection(section, visible);
	const tab = current.id;

	const days: Days = params.has("days") ? parseDays(params.get("days")) : 30;
	// Whole-zone numbers are admin-only; everyone else sees their own mail.
	const scope: AnalyticsScope = isAdmin && params.get("scope") !== "app" ? "zone" : "app";
	const productParam = params.get("product");
	const domainParam = params.get("domain");

	const update = (patch: Record<string, string | null>) => {
		setParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				for (const [k, v] of Object.entries(patch)) {
					if (v == null || v === "") next.delete(k);
					else next.set(k, v);
				}
				return next;
			},
			{ replace: true, preventScrollReset: true },
		);
	};

	// Products group sending domains (`GET /api/v1/products`). The filter only
	// exists in zone scope; it is never applied invisibly.
	const { data: products = [] } = useProducts();
	const filterOn = isAdmin && scope === "zone" && days !== 90;
	const filter = analyticsFilter(products, filterOn ? productParam : null, domainParam);
	// Each tab fetches only what it shows. The overview waits for `/me`: the
	// scope depends on the role, and starting early fired an `app` request that
	// was dropped the moment the role arrived.
	const settled = !me.isPending;
	const overview = useAnalyticsOverview({ days, scope, ...filter.query }, settled && sectionNeeds(tab, "overview"));
	const engagement = useAnalyticsEngagement({ days }, sectionNeeds(tab, "engagement"));
	// Inbound and DMARC are zone-wide Cloudflare data: admins only.
	const inbound = useAnalyticsInbound({ days }, isAdmin && sectionNeeds(tab, "inbound"));
	const dmarc = useAnalyticsDmarc({ days }, isAdmin && sectionNeeds(tab, "dmarc"));
	// Month to date from its own endpoint; admins only.
	const usage = useUsage(isAdmin && tab === "usage");
	const refresh = useRefreshAnalytics();

	// `/analytics#dmarc` from the single-page days.
	React.useEffect(() => {
		if (section) return;
		const legacy = analyticsSectionForLegacyHash(location.hash);
		if (legacy) navigate(`/analytics/${legacy}${location.search}`, { replace: true });
	}, [section, location.hash, location.search, navigate]);

	if (!section && !analyticsSectionForLegacyHash(location.hash)) {
		return <Navigate to={`/analytics/${current.id}${location.search}`} replace />;
	}
	// A hidden or unknown tab falls back to Overview, once the role is known.
	if (settled && section && current.id !== section) {
		return <Navigate to={`/analytics/${current.id}${location.search}`} replace />;
	}

	const ov = overview.data;
	const providerOff = ov?.provider.configured === false;
	// Zone numbers come from Cloudflare: none without a token, none past 31 days.
	const zoneAvailable = !providerOff && days !== 90;
	// The requested scope, not the (possibly placeholder) response's, so the
	// control answers the click immediately.
	const shownScope: AnalyticsScope = zoneAvailable ? scope : "app";
	const scoped = sectionIsScoped(tab);

	// The status line reads only this tab's queries.
	const active = [
		sectionNeeds(tab, "overview") && overview,
		sectionNeeds(tab, "engagement") && engagement,
		sectionNeeds(tab, "inbound") && inbound,
		sectionNeeds(tab, "dmarc") && dmarc,
	].filter((q): q is NonNullable<typeof q> & object => !!q);
	const usageActive = tab === "usage";
	const fetching = usageActive ? usage.isFetching : active.some((q) => q.isFetching);
	const hasData = usageActive ? !!usage.data : active.some((q) => q.data);
	const cachedAt = usageActive ? usage.data?.provider.cached_at : active.map((q) => q.data?.provider.cached_at).find(Boolean);
	const sampled = tab !== "suppressions" && active.some((q) => q.data?.provider.sampled);
	const providerError = tab === "suppressions" ? undefined : active.map((q) => q.data?.provider.error).find(Boolean);

	const range = RANGE_OPTIONS.find((r) => r.days === days)?.long ?? "";
	const scopeLabel =
		shownScope !== "zone" ? "this app" : filter.domain ? filter.domain : filter.product ? filter.product.name : "whole zone";
	const captions: Record<AnalyticsSectionId, string> = {
		overview: `${range} · ${scopeLabel}`,
		sending: `${range} · ${scopeLabel}`,
		engagement: `${range} · this app`,
		inbound: `${range} · your domains`,
		dmarc: `${range} · mail sent as your domains`,
		suppressions: "Addresses that won't be sent to · all time",
		usage: `${usage.data?.window.month ?? "This month"} to date · projected to month end`,
	};
	const status = (
		<span className="inline-flex items-center gap-1" aria-live="polite">
			{fetching ? (hasData ? "Updating…" : "Loading…") : <UpdatedAgo at={cachedAt} />}
			{(providerError || sampled) && !fetching && (
				<InfoTip label={providerError ? "Some data didn't load" : "Counts are estimates"}>
					{[
						providerError ? `Some Cloudflare data didn't load: ${providerError}. Refresh to try again.` : "",
						sampled ? "Cloudflare sampled some events in this window, so its counts are estimates." : "",
					]
						.filter(Boolean)
						.join(" ")}
				</InfoTip>
			)}
		</span>
	);
	const heading = (id: AnalyticsSectionId, label: string) => {
		const Icon = ICONS[id];
		return (
			<div className="mb-4 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
				<h2 className="hidden items-center gap-2 text-base font-semibold text-text-primary sm:flex">
					<Icon size={14} className="text-text-tertiary" aria-hidden />
					{label}
				</h2>
				<span className="flex flex-wrap items-center gap-x-1.5 text-sm text-text-secondary">
					{captions[id]}
					{(cachedAt || fetching) && (
						<>
							<span aria-hidden>·</span>
							{status}
						</>
					)}
				</span>
			</div>
		);
	};

	const content: Record<AnalyticsSectionId, React.ReactNode> = {
		overview: (
			<QueryState query={overview} label="the overview" skeleton={<OverviewSkeleton />}>
				{(d) => <OverviewTab data={d} isAdmin={isAdmin} search={location.search} />}
			</QueryState>
		),
		sending: (
			<QueryState query={overview} label="sending" skeleton={<OverviewSkeleton />}>
				{(d) => <SendingTab data={d} isAdmin={isAdmin} />}
			</QueryState>
		),
		engagement: (
			<QueryState
				query={engagement}
				label="engagement"
				skeleton={<SkeletonRows rows={6} />}
				isEmpty={engagementIsEmpty}
				empty={<TabEmpty title="No tracked messages in this period">Turn on open and click tracking in a mailbox's settings.</TabEmpty>}
			>
				{(d) => <EngagementPanel data={d} />}
			</QueryState>
		),
		inbound: (
			<QueryState
				query={inbound}
				label="inbound mail"
				skeleton={<SkeletonRows rows={6} />}
				isEmpty={inboundIsEmpty}
				empty={<TabEmpty title="No inbound mail in this period" />}
			>
				{(d) => <InboundPanel data={d} isAdmin={isAdmin} />}
			</QueryState>
		),
		dmarc: (
			<QueryState
				query={dmarc}
				label="DMARC reports"
				skeleton={<SkeletonRows rows={5} />}
				isEmpty={(d) => !d.provider.configured || dmarcIsEmpty(d)}
				empty={
					dmarc.data?.provider.configured === false ? (
						<SetupCard isAdmin={isAdmin} />
					) : (
						<TabEmpty title="No DMARC reports in this period">
							{dmarc.data?.provider.window_capped
								? "Cloudflare keeps 31 days of reports. Pick 30 days or less."
								: "Reports arrive daily once your DMARC record has a Cloudflare rua= address."}
						</TabEmpty>
					)
				}
			>
				{(d) => <DmarcPanel data={d} />}
			</QueryState>
		),
		suppressions: (
			<QueryState query={overview} label="suppressions" skeleton={<SkeletonRows rows={3} />}>
				{(d) => <SuppressionsPanel data={d} isAdmin={isAdmin} />}
			</QueryState>
		),
		usage: (
			<QueryState query={usage} label="usage" skeleton={<UsageSkeleton />}>
				{(d) => <UsagePanel data={d} />}
			</QueryState>
		),
	};

	const toolbar = (
			<div className="flex min-w-0 flex-wrap items-center gap-2">
				{scoped && isAdmin && (
					<Segmented
						label="Scope"
						value={shownScope}
						onChange={(s) => update({ scope: s === "app" ? "app" : null, product: null, domain: null })}
						options={[
							{ value: "app", label: "This app" },
							{
								value: "zone",
								label: "Zone",
								disabled: !zoneAvailable,
								title: providerOff
									? "Needs a Cloudflare token on the Worker"
									: days === 90
										? "Cloudflare keeps 31 days of data"
										: "Every sender on the Cloudflare zone",
							},
						]}
					/>
				)}
				{scoped && shownScope === "zone" && products.length > 1 && (
					<label className="flex min-w-0 flex-1 items-center sm:flex-none">
						<span className="sr-only">Product</span>
						<select
							value={filter.product?.slug ?? ""}
							onChange={(e) => update({ product: e.target.value || null, domain: null })}
							className="h-9 w-full min-w-0 sm:w-auto sm:max-w-[12rem] rounded-[8px] bg-bg-subtle px-2.5 text-sm font-medium text-text-primary ring-1 ring-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch:h-11"
						>
							<option value="">All products</option>
							{products.map((p) => (
								<option key={p.id} value={p.slug}>
									{p.name}
								</option>
							))}
						</select>
					</label>
				)}
				{scoped && shownScope === "zone" && filter.domainOptions.length > 0 && (
					<label className="flex min-w-0 flex-1 items-center sm:flex-none">
						<span className="sr-only">Sending domain</span>
						<select
							value={filter.domain ?? ""}
							onChange={(e) => update({ domain: e.target.value || null })}
							className="h-9 w-full min-w-0 sm:w-auto sm:max-w-[12rem] rounded-[8px] bg-bg-subtle px-2.5 text-sm font-medium text-text-primary ring-1 ring-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch:h-11"
						>
							<option value="">All its domains</option>
							{filter.domainOptions.map((d) => (
								<option key={d} value={d}>
									{d}
								</option>
							))}
						</select>
					</label>
				)}
				{!usageActive && !(tab === "suppressions" && ov && suppressionsAllTime(ov)) && (
				<Segmented
					className="flex-1 sm:flex-none [&>button]:flex-1 sm:[&>button]:flex-none"
					label="Time range"
					value={days}
					onChange={(d) => update({ days: String(d) })}
					options={RANGE_OPTIONS.map((r) => ({ value: r.days as Days, label: r.label, title: r.long }))}
				/>
				)}
				<span className="flex items-center">
					<button
						type="button"
						onClick={() => {
							if (!fetching) refresh();
						}}
						aria-disabled={fetching}
						aria-label="Refresh analytics"
						title={cachedAt ? `Updated ${formatRelative(cachedAt)}. Refresh, skipping the 5-minute cache` : "Refresh, skipping the 5-minute cache"}
						className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary ring-1 ring-border hover:bg-bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:opacity-70 touch:h-11 touch:w-11"
					>
						<RefreshCw className={cn("h-4 w-4", fetching && "animate-spin motion-reduce:animate-none")} aria-hidden />
					</button>
				</span>
			</div>
	);

	return (
		<DashboardLayout>
			<div className={cn("min-w-0", VIZ_VARS)}>
				{/*
				  The section pane sits at the left edge like Mail's folder
				  pane; range, scope and product stay in the page's own toolbar row.
				*/}
				<SideNavLayout
					basePath="/analytics"
					active={current.id}
					title="Analytics"
					actions={toolbar}
					phoneToolbar={toolbar}
					navLabel="Analytics sections"
					pickerLabel="Analytics section"
					search={location.search}
					contentClassName=""
					items={visible.map((s) => ({
						id: s.id,
						label: s.label,
						icon: ICONS[s.id],
						content: (
							<section aria-label={s.label}>
								{heading(s.id, s.label)}
								{content[s.id]}
							</section>
						),
					}))}
				/>
			</div>
		</DashboardLayout>
	);
}

function OverviewSkeleton() {
	return (
		<div className="space-y-4">
			<KpiSkeleton />
			<ChartSkeleton />
		</div>
	);
}

type Overview = OverviewResponse;

/** Suppression lists are current state; the range only matters when the Worker scopes them to it. */
function suppressionsAllTime(d: Overview): boolean {
	const w = d.suppressions as { window?: unknown; provider_window?: unknown; local_window?: unknown };
	return [w.provider_window ?? w.window, w.local_window ?? w.window].every((x) => suppressionScope(x) === "all_time");
}

/** Nothing sent, nothing received: one empty state instead of a page of zeros. */
function isQuiet(d: Overview): boolean {
	return d.sending.sent === 0 && !hasVolume(d) && d.mailboxes.every((m) => m.sent === 0);
}

/** The 3–5 numbers that matter, reputation in a line, and a compact volume chart. */
function OverviewTab({ data, isAdmin, search }: { data: Overview; isAdmin: boolean; search: string }) {
	const sendingHref = `/analytics/sending${search}`;
	return (
		<div className="space-y-4">
			{!data.provider.configured && <SetupCard isAdmin={isAdmin} />}
			<AlertGroup items={[failingAlert(data, sendingHref), reputationAlert(data, sendingHref), dnsAlert(data), ...providerNotices(data)]} />

			{isQuiet(data) ? (
				<TabEmpty title="Nothing sent in this period">Try a longer range.</TabEmpty>
			) : (
				<>
					<KpiTiles data={data} />
					{!reputationAlert(data) && <ReputationStrip data={data} detailHref={sendingHref} />}
					{hasVolume(data) && <VolumePanel data={data} compact />}
				</>
			)}
		</div>
	);
}

/** Volume, reputation detail, quota, errors, domains and senders. */
function SendingTab({ data, isAdmin }: { data: Overview; isAdmin: boolean }) {
	const quiet = isQuiet(data) && data.domains.length === 0 && data.senders.length === 0 && data.errors.length === 0;
	return (
		<div className="space-y-4">
			{!data.provider.configured && <SetupCard isAdmin={isAdmin} />}
			<AlertGroup items={[dnsAlert(data), ...providerNotices(data)]} />

			{quiet ? (
				<>
					<TabEmpty title="Nothing sent in this period">Try a longer range.</TabEmpty>
					<QuotaPanel data={data} />
				</>
			) : (
				<>
					<SendingDetailTiles data={data} />
					{hasVolume(data) && <VolumePanel data={data} withInbound={!isAdmin} />}
					<ReputationPanel data={data} />
					<SpamComplaints isAdmin={isAdmin} />
					<ErrorsPanel data={data} />
					<DomainsPanel data={data} />
					<SendersPanel data={data} />
				</>
			)}
		</div>
	);
}

/**
 * The complaint-rate breaker's per-domain state (shared with Settings →
 * Domains). Hidden until the first hourly evaluation exists.
 */
function SpamComplaints({ isAdmin }: { isAdmin: boolean }) {
	const { data } = useSendingHealth();
	if (!data?.domains.length) return null;
	return (
		<Panel>
			<PanelTitle
				title="Spam complaints"
				info="7-day complaint rate per sending domain, checked hourly. Above 0.1% you are warned; above 0.3% bulk sending pauses until an administrator resumes it."
			/>
			<SendingHealthPanel isAdmin={isAdmin} />
		</Panel>
	);
}

/** "Updated 3m ago", ticking once a minute. */
function UpdatedAgo({ at }: { at?: string }) {
	const [, tick] = React.useReducer((n: number) => n + 1, 0);
	React.useEffect(() => {
		const t = setInterval(tick, 60_000);
		return () => clearInterval(t);
	}, []);
	if (!at) return null;
	return <>Updated {formatRelative(at)}</>;
}
