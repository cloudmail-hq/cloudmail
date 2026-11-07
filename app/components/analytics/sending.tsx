/**
 * Sending-side analytics, all fed by the overview response: the lead tiles,
 * reputation, the volume chart, domains and senders, errors, quota and
 * suppressions. Plus the setup card shown when the Worker has no Cloudflare
 * token.
 *
 * Copy rule: labels are short and plain; definitions, units and caveats sit
 * behind an ⓘ (`InfoTip`) next to the number they explain.
 */
import * as React from "react";
import { Link } from "react-router";
import { ChevronRight, KeyRound, ShieldCheck } from "lucide-react";
import type { OverviewResponse, ReputationMetric } from "../../../shared/analytics-types";
import { ColumnChart, type ChartSeries } from "./charts";
import {
	countWithUnit,
	fillDays,
	formatCount,
	formatDateTime,
	formatRate,
	formatRelative,
	gaugeModel,
	humanize,
	nonEmptySeries,
	ofTotal,
	RANGE_OPTIONS,
	REPUTATION_LABELS,
	reputationStatus,
	safeRate,
	seriesSummary,
	suppressionScope,
	unitNoun,
	type CountUnit,
} from "./format";
import {
	Addr,
	Alert,
	Chip,
	EmptyNote,
	InfoTip,
	Meter,
	Panel,
	ResponsiveTable,
	Segmented,
	Skeleton,
	TileRow,
	TileSkeleton,
	type TileData,
	type Tone,
} from "./primitives";
import { cn } from "~/lib/utils";

type Overview = OverviewResponse;

// ── Setup card ────────────────────────────────────────────────────────────

export function SetupCard({ isAdmin }: { isAdmin: boolean }) {
	return (
		<Panel className="flex items-start gap-3 px-4 py-3">
			<KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-accent-subtle-fg" aria-hidden />
			<div className="min-w-0 flex-1 text-sm">
				<p className="flex flex-wrap items-center gap-1 font-medium text-text-primary">
					Connect Cloudflare for deliverability data
					<InfoTip label="What connecting adds">
						Reputation, quota, sending domains, other senders on the zone, inbound routing and DMARC reports
						need a Cloudflare API token. The numbers shown now are this app's own records.
					</InfoTip>
				</p>
				{isAdmin ? (
					<p className="mt-0.5 text-text-secondary">
						<Link
							to="/settings/cloudflare"
							className="inline-flex min-h-8 items-center font-medium text-accent-subtle-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch:min-h-11"
						>
							Connect in Settings → Cloudflare connection
						</Link>{" "}
						or set a read-only <code>CF_ANALYTICS_TOKEN</code> Worker secret. Data is cached for 5 minutes.
					</p>
				) : (
					<p className="mt-0.5 text-text-secondary">Ask an administrator to add the token.</p>
				)}
			</div>
		</Panel>
	);
}

/** One-line notices for partial Cloudflare failures and the 31-day cap. */
export function providerNotices(data: Overview): React.ReactElement[] {
	const p = data.provider;
	if (!p.configured) return [];
	const out: React.ReactElement[] = [];
	if (p.window_capped)
		out.push(
			<Alert
				key="capped"
				tone="neutral"
				title="90 days shows this app's records only"
				info="Cloudflare keeps 31 days of email data. Reputation, domains, inbound and DMARC need 30 days or less."
			/>,
		);
	return out;
}

// ── Lead tiles ────────────────────────────────────────────────────────────

/** App-ledger totals from the overview's mailbox rows. */
function appTotals(data: Overview) {
	const rows = data.mailboxes;
	const sent = rows.reduce((a, m) => a + m.sent, 0);
	const delivered = rows.reduce((a, m) => a + m.delivered, 0);
	const opened = rows.reduce((a, m) => a + m.opened, 0);
	const clicked = rows.reduce((a, m) => a + m.clicked, 0);
	const pending = Math.max(0, sent - delivered - rows.reduce((a, m) => a + m.bounced + m.failed, 0));
	return { sent, delivered, opened, clicked, pending, base: delivered || sent };
}

function unitInfo(unit: CountUnit, zone: boolean): string {
	return unit === "recipients"
		? `Counted in recipients: a message to 3 people counts 3.${zone ? " Whole zone, every sender on Cloudflare Email Service." : ""}`
		: "Counted in messages, from this app's own records.";
}

/**
 * The sending numbers that matter: sent, delivered, bounced, complaints, and
 * (on Overview) opens. Each rate keeps its numerator and denominator in the
 * sub line so it can be checked.
 */
export function sendingTiles(data: Overview, { withOpens }: { withOpens: boolean }): TileData[] {
	const s = data.sending;
	const unit = data.sections?.sending.unit ?? s.unit;
	const zone = data.scope === "zone";
	const app = appTotals(data);
	const tiles: TileData[] = [
		{ key: "sent", label: "Sent", value: formatCount(s.sent), sub: unitNoun(unit, s.sent), info: unitInfo(unit, zone) },
		{
			key: "delivery",
			label: "Delivered",
			value: formatRate(s.rates.delivery),
			sub: ofTotal(s.delivered, s.sent),
			info: s.pending
				? `${formatCount(s.pending)} ${unitNoun(unit, s.pending)} still waiting for Cloudflare to confirm delivery.`
				: undefined,
		},
		{
			key: "bounce",
			label: "Bounced",
			value: formatRate(s.rates.bounce),
			sub: ofTotal(s.bounced, s.sent),
			info: s.failed || s.rejected ? `${formatCount(s.failed + s.rejected)} more failed or were rejected before delivery.` : undefined,
			tone: crossed(data, "bounce", s.rates.bounce),
		},
		{
			key: "complaint",
			label: "Complaints",
			value: formatRate(s.rates.complaint),
			sub: ofTotal(s.complaints, s.delivered),
			info: "Share of delivered mail that recipients marked as spam.",
			tone: crossed(data, "complaint", s.rates.complaint),
		},
	];
	if (withOpens) {
		tiles.push({
			key: "open",
			label: zone ? "Opened (app)" : "Opened",
			value: app.base < 20 ? formatCount(app.opened) : formatRate(safeRate(app.opened, app.base)),
			sub: app.base < 20 ? `of ${formatCount(app.base)} · ${formatRate(safeRate(app.opened, app.base))}` : ofTotal(app.opened, app.base),
			info: `This app's tracked messages only.${zone ? " Not a zone-wide rate." : ""} Opens are pixel loads; image proxies (Apple Mail Privacy Protection, Gmail) inflate them.${app.pending ? ` ${formatCount(app.pending)} still pending confirmation.` : ""}`,
		});
	}
	return tiles;
}

export function KpiTiles({ data }: { data: Overview }) {
	const tiles = sendingTiles(data, { withOpens: true });
	if (data.scope !== "zone") {
		return (
			<div>
				<TileRow label="Sending summary" tiles={tiles} />
			</div>
		);
	}
	const open = tiles.pop()!;
	const app = appTotals(data);
	const clicked: TileData = {
		key: "click",
		label: "Clicked",
		value: app.base < 20 ? formatCount(app.clicked) : formatRate(safeRate(app.clicked, app.base)),
		sub: app.base < 20 ? `of ${formatCount(app.base)} · ${formatRate(safeRate(app.clicked, app.base))}` : ofTotal(app.clicked, app.base),
	};
	return (
		<div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
			<div className="min-w-0">
				<p className="mb-1.5 text-xs font-medium text-text-secondary">Whole zone</p>
				<TileRow label="Sending summary" tiles={tiles} />
			</div>
			<div className="min-w-0">
				<p className="mb-1.5 text-xs font-medium text-text-secondary">This app</p>
				<TileRow label="This app's engagement" tiles={[{ ...open, label: "Opened" }, clicked]} />
			</div>
		</div>
	);
}

/**
 * The Sending tab's lead: sent and delivered, then what the detail below
 * explains (bounced or failed, pending) and the daily quota.
 */
export function SendingDetailTiles({ data }: { data: Overview }) {
	const s = data.sending;
	const unit = data.sections?.sending.unit ?? s.unit;
	const [sent, delivered] = sendingTiles(data, { withOpens: false });
	const failed = s.failed + s.rejected;
	const waiting = s.pending + (s.deferred ?? 0);
	const tiles: TileData[] = [
		sent,
		delivered,
		{
			key: "failed",
			label: "Not delivered",
			value: formatCount(s.bounced + failed),
			sub: `${formatCount(s.bounced)} bounced · ${formatCount(failed)} failed`,
			info: "Bounces were refused by the receiving server; failed and rejected mail never reached it. Causes are under Delivery errors.",
			tone: crossed(data, "bounce", s.rates.bounce),
		},
	];
	if (waiting) {
		tiles.push({
			key: "pending",
			label: "Pending",
			value: formatCount(waiting),
			sub: unitNoun(unit, waiting),
		});
	}
	if (data.quota) {
		const q = data.quota;
		tiles.push({
			key: "quota",
			label: "Account quota today",
			value: formatRate(safeRate(q.used, q.limit)),
			sub: ofTotal(q.used, q.limit),
			toneLabel: "Near limit",
			info: `Whole Cloudflare account, this quota day${q.resets_at ? `; resets ${formatResets(q.resets_at)}` : ""}. The limit grows with reputation.`,
			tone: q.limit && q.used / q.limit >= 0.8 ? "warning" : undefined,
			meter: { value: q.used, max: q.limit },
		});
	}
	return (
		<div>
			<TileRow label="Sending detail" tiles={tiles} />
		</div>
	);
}

/**
 * "warning" when this window's rate is past Cloudflare's live warning
 * threshold, "critical" past at-risk.
 */
function crossed(data: Overview, key: "bounce" | "complaint", value: number | null): Tone | undefined {
	const m = data.reputation?.metrics.find((x) => x.key === key);
	if (!m || value == null) return undefined;
	return value >= m.at_risk_at ? "critical" : value >= m.warning_at ? "warning" : undefined;
}

function formatResets(iso: string): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return "";
	return new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" });
}

export function KpiSkeleton({ count = 5 }: { count?: number }) {
	return <TileSkeleton count={count} />;
}

// ── Reputation ────────────────────────────────────────────────────────────

const STATUS_TONE: Record<string, Tone> = {
	healthy: "good",
	warning: "warning",
	at_risk: "critical",
	suspended: "critical",
	unknown: "neutral",
};

/** Reputation past warning: an alert, since sending may be paused account-wide. */
export function reputationAlert(data: Overview, detailHref?: string): React.ReactElement | null {
	const rep = data.reputation;
	if (!rep) return null;
	const st = reputationStatus(rep.status);
	const tone = STATUS_TONE[st.tone];
	if (tone !== "warning" && tone !== "critical") return null;
	// The worst metric past its warning line, so the alert says what to fix.
	const worst = rep.metrics
		.filter((m) => m.value != null && m.denominator >= m.minimum_denominator && m.value >= m.warning_at)
		.sort((a, b) => b.value! / b.at_risk_at - a.value! / a.at_risk_at)[0];
	const cause = worst
		? `7-day ${(REPUTATION_LABELS[worst.key]?.title ?? humanize(worst.key)).toLowerCase()} ${formatRate(worst.value)}, pauses at ${formatRate(worst.at_risk_at)}`
		: "";
	return (
		<Alert
			key="reputation"
			tone={tone === "critical" ? "critical" : "warning"}
			title={`Reputation ${st.label.toLowerCase()}${cause ? `: ${cause}` : ""} (whole zone)`}
			info={REPUTATION_INFO}
			action={detailHref ? { label: "See rates", to: detailHref } : undefined}
		/>
	);
}

const REPUTATION_INFO =
	"Cloudflare checks bounce, complaint and spam-rejection rates daily over the last 7 days, across every sender on the zone, so they differ from the range picked above. Crossing a threshold pauses sending for the whole account.";

/** Account reputation in one line: status, the window it covers, and the three rates. */
export function ReputationStrip({ data, detailHref }: { data: Overview; detailHref?: string }) {
	const rep = data.reputation;
	if (!rep) return null;
	const st = reputationStatus(rep.status);
	return (
		<Panel className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 text-sm">
			<span className="flex items-center gap-1.5 font-medium text-text-primary">
				Reputation
				<Chip tone={STATUS_TONE[st.tone]} icon={st.tone === "healthy" ? ShieldCheck : undefined}>
					{st.label}
				</Chip>
				<span className="text-xs font-normal text-text-secondary">7 days</span>
				<InfoTip label="About reputation">
					{REPUTATION_INFO}
					{rep.since ? ` ${st.label} since ${formatDateTime(rep.since)}.` : ""}
				</InfoTip>
			</span>
			<ul className="flex flex-wrap gap-x-4 gap-y-1 text-text-secondary">
				{rep.metrics.map((m) => {
					const g = gaugeModel(m);
					const meta = REPUTATION_LABELS[m.key] ?? { title: humanize(m.key) };
					return (
						<li key={m.key}>
							{meta.title.replace(/ rate$/, "")}{" "}
							<span className="font-medium tabular-nums text-text-primary">
								{g.zone === "insufficient" ? "—" : formatRate(m.value)}
							</span>
							<span className="text-xs"> (7d)</span>
						</li>
					);
				})}
			</ul>
			{detailHref && (
				<Link
					to={detailHref}
					className="ml-auto inline-flex h-8 items-center gap-0.5 rounded-md text-sm font-medium text-accent-subtle-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch:h-11"
				>
					Details
					<ChevronRight className="h-3.5 w-3.5" aria-hidden />
				</Link>
			)}
		</Panel>
	);
}

/** The three gauges, for the Sending tab. */
export function ReputationPanel({ data }: { data: Overview }) {
	const rep = data.reputation;
	if (!rep) return null;
	const st = reputationStatus(rep.status);
	return (
		<Panel className="p-4 sm:p-5">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<h3 className="text-sm font-medium text-text-primary">Reputation</h3>
				<Chip tone={STATUS_TONE[st.tone]} icon={st.tone === "healthy" ? ShieldCheck : undefined}>
					{st.label}
				</Chip>
				<span className="inline-flex items-center gap-1 text-xs text-text-secondary">
					Last 7 days · whole zone
					<InfoTip label="About reputation">
						{REPUTATION_INFO}
						{rep.since ? ` ${st.label} since ${formatDateTime(rep.since)}.` : ""}
					</InfoTip>
				</span>
			</div>
			<div className="mt-4 grid gap-6 md:grid-cols-3">
				{rep.metrics.map((m) => (
					<Gauge key={m.key} metric={m} unit={data.sections?.reputation.unit ?? "recipients"} />
				))}
			</div>
		</Panel>
	);
}

const ZONE_TEXT: Record<string, { label: string; tone: Tone }> = {
	healthy: { label: "OK", tone: "good" },
	warning: { label: "Warning", tone: "warning" },
	at_risk: { label: "At risk", tone: "critical" },
	unknown: { label: "No data", tone: "neutral" },
	insufficient: { label: "Low volume", tone: "neutral" },
};

/**
 * One reputation metric on a rail: three bands (OK, warning, at risk), the
 * live thresholds, and the current value as a marker. Under the minimum
 * denominator the gauge greys out, because Cloudflare ignores it.
 */
export function Gauge({ metric, unit = "recipients" }: { metric: ReputationMetric; unit?: CountUnit }) {
	const basisNoun = metric.key === "complaint" ? `delivered ${unitNoun(unit, metric.denominator)}` : `${unitNoun(unit, metric.denominator)} sent`;
	const minNoun = metric.key === "complaint" ? `delivered ${unitNoun(unit)}` : `${unitNoun(unit)} sent`;
	const g = gaugeModel(metric);
	const meta = REPUTATION_LABELS[metric.key] ?? { title: humanize(metric.key), basis: "" };
	const z = ZONE_TEXT[g.zone];
	const greyed = g.zone === "insufficient";
	const valueText = greyed
		? `not enough volume (${formatCount(metric.denominator)} of ${formatCount(metric.minimum_denominator)} needed)`
		: formatRate(metric.value);
	const label = `${meta.title}: ${valueText}. Warning at ${formatRate(metric.warning_at)}, at risk at ${formatRate(metric.at_risk_at)}.`;
	return (
		<div className="min-w-0">
			<div className="flex items-center justify-between gap-2">
				<p className="flex items-center gap-1 text-sm text-text-secondary">
					{meta.title}
					<InfoTip label={`About ${meta.title}`}>
						{greyed
							? `Cloudflare skips this rate below ${formatCount(metric.minimum_denominator)} ${minNoun} in 7 days. ${metric.denominator ? `${formatCount(metric.denominator)} so far` : "None so far"}.`
							: `${meta.basis.charAt(0).toUpperCase()}${meta.basis.slice(1)}, over ${formatCount(metric.denominator)} ${basisNoun} in the last 7 days, whole zone.`}{" "}
						OK under {formatRate(metric.warning_at)}, at risk from {formatRate(metric.at_risk_at)}.
					</InfoTip>
				</p>
				<Chip tone={z.tone}>{z.label}</Chip>
			</div>
			<p className={cn("mt-0.5 text-2xl font-semibold tracking-tight tabular-nums", greyed ? "text-text-secondary" : "text-text-primary")}>
				{greyed ? "—" : formatRate(metric.value)}
			</p>
			{greyed ? (
				<p className="mt-2 text-xs text-text-secondary">
					Not enough volume yet ({ofTotal(metric.denominator, metric.minimum_denominator)})
				</p>
			) : (
				<>
			<div
				{...(metric.value == null || greyed
					? { role: "img" }
					: {
							role: "meter",
							"aria-valuemin": 0,
							"aria-valuemax": g.scaleMax,
							"aria-valuenow": Math.min(metric.value, g.scaleMax),
							"aria-valuetext": valueText,
						})}
				aria-label={label}
				className={cn("relative mt-2 h-7", greyed && "grayscale")}
			>
				<div className="absolute inset-x-0 top-2.5 flex h-2 gap-[2px]">
					<div className="h-full rounded-l-full bg-emerald-500/30 dark:bg-emerald-500/45" style={{ width: `${g.warnPos * 100}%` }} />
					<div className="h-full bg-amber-400/55 dark:bg-amber-500/55" style={{ width: `${(g.riskPos - g.warnPos) * 100}%` }} />
					<div className="h-full flex-1 rounded-r-full bg-red-500/35 dark:bg-red-500/55" />
				</div>
				{g.valuePos != null && !greyed && (
					<div
						aria-hidden
						className="absolute top-1.5 h-4 w-4 -translate-x-1/2 rounded-full border-[3px] border-text-primary bg-card"
						style={{ left: `clamp(8px, ${g.valuePos * 100}%, calc(100% - 8px))` }}
					/>
				)}
			</div>
			{/* Threshold labels under the band edges they mark. */}
			<p aria-hidden className="relative h-4 text-xs tabular-nums text-text-secondary">
				<span className="absolute -translate-x-1/2" style={{ left: `${g.warnPos * 100}%` }}>
					{formatRate(metric.warning_at)}
				</span>
				<span className="absolute -translate-x-1/2" style={{ left: `${g.riskPos * 100}%` }}>
					{formatRate(metric.at_risk_at)}
				</span>
			</p>
				</>
			)}
		</div>
	);
}

export function ReputationSkeleton() {
	return (
		<Panel className="p-5">
			<Skeleton className="h-6 w-28" />
			<div className="mt-5 grid gap-6 md:grid-cols-3">
				{[0, 1, 2].map((i) => (
					<div key={i} className="space-y-2">
						<Skeleton className="h-4 w-24" />
						<Skeleton className="h-7 w-14" />
						<Skeleton className="h-2 w-full" />
					</div>
				))}
			</div>
		</Panel>
	);
}

// ── Volume chart ──────────────────────────────────────────────────────────

type VolumeView = "delivery" | "engagement" | "received";
type Point = Overview["timeseries"][number];

const VOLUME_SERIES: Record<VolumeView, ChartSeries<Point>[]> = {
	delivery: [
		{ key: "delivered", label: "Delivered", color: "var(--viz-1)", value: (r) => r.delivered },
		{ key: "bounced", label: "Bounced", color: "var(--viz-2)", value: (r) => r.bounced },
		{ key: "failed", label: "Failed", color: "var(--viz-3)", value: (r) => r.failed },
	],
	engagement: [
		{ key: "opened", label: "Opened", color: "var(--viz-1)", value: (r) => r.opened },
		{ key: "clicked", label: "Clicked", color: "var(--viz-2)", value: (r) => r.clicked },
	],
	received: [{ key: "received", label: "Received", color: "var(--viz-1)", value: (r) => r.received }],
};

function volumeRows(data: Overview) {
	return fillDays(data.timeseries, data.window.start, data.window.end, (date) => ({
		date, sent: 0, delivered: 0, bounced: 0, failed: 0, opened: 0, clicked: 0, received: 0,
	}));
}

/** True when the window has any sending, opens or inbound to chart. */
export function hasVolume(data: Overview): boolean {
	return data.timeseries.some((r) => r.delivered + r.bounced + r.failed + r.opened + r.clicked + r.received > 0);
}

/**
 * Mail per day. `compact` is the Overview version: delivery outcome only, no
 * view switch. The full version can switch to opens or inbound.
 */
export function VolumePanel({
	data,
	compact = false,
	withInbound = false,
}: {
	data: Overview;
	compact?: boolean;
	/** Members have no Inbound tab, so their volume chart keeps a Received view. */
	withInbound?: boolean;
}) {
	const [view, setView] = React.useState<VolumeView>("delivery");
	// Inbound per day lives on the Inbound tab; this chart is sent mail.
	const hasOpens = data.scope !== "zone" && data.timeseries.some((r) => r.opened + r.clicked > 0);
	const hasInbound = withInbound && data.timeseries.some((r) => r.received > 0);
	const rows = React.useMemo(() => volumeRows(data), [data]);
	const series = React.useMemo(() => nonEmptySeries(rows, VOLUME_SERIES[view]), [rows, view]);
	const unit = view === "received" ? "messages" : data.sending.unit;
	const total = rows.reduce((a, r) => a + series.reduce((b, s) => b + s.value(r), 0), 0);
	const summary = series
		.map((s) => seriesSummary(s.label, rows.map((r) => ({ date: r.date, value: s.value(r) }))))
		.join(" ");
	const titles: Record<VolumeView, string> = {
		delivery: "Sent per day",
		engagement: "Opens and clicks per day",
		received: "Received per day",
	};
	return (
		<Panel className="p-4 sm:p-5">
			<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
				<h3 className="flex items-center gap-1 text-sm font-medium text-text-primary">
					{titles[view]}
					{view === "delivery" && <InfoTip label="About this chart">{`Delivery outcome per day, in ${data.sending.unit}.`}</InfoTip>}
					{view === "engagement" && <InfoTip label="About this chart">This app's tracked mail only.</InfoTip>}
				</h3>
				{!compact && (hasOpens || hasInbound) && (
					<Segmented
						label="Chart"
						value={view}
						onChange={setView}
						options={[
							{ value: "delivery" as const, label: "Sent" },
							...(hasOpens ? [{ value: "engagement" as const, label: "Opens" }] : []),
							...(hasInbound ? [{ value: "received" as const, label: "Inbound" }] : []),
						]}
					/>
				)}
			</div>
			{total === 0 ? (
				<EmptyNote className="py-12" title="Nothing in this period" />
			) : (
				<ColumnChart rows={rows} series={series} label={titles[view]} summary={summary} stacked={view !== "engagement"} unit={unit} />
			)}
		</Panel>
	);
}

export function ChartSkeleton() {
	return (
		<Panel className="p-5">
			<div className="flex justify-between">
				<Skeleton className="h-5 w-48" />
				<Skeleton className="h-8 w-44" />
			</div>
			<div className="mt-6 flex h-[168px] items-end gap-1">
				{Array.from({ length: 24 }, (_, i) => (
					<div
						key={i}
						className="flex-1 animate-pulse rounded-t-[4px] bg-bg-muted motion-reduce:animate-none"
						style={{ height: `${30 + ((i * 37) % 60)}%` }}
					/>
				))}
			</div>
		</Panel>
	);
}

// ── Quota ─────────────────────────────────────────────────────────────────

export function QuotaPanel({ data }: { data: Overview }) {
	const q = data.quota;
	if (!q) return null;
	const share = safeRate(q.used, q.limit);
	const high = !!q.limit && q.used / q.limit >= 0.8;
	return (
		<Panel className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
			<p className="flex items-center gap-1 text-sm font-medium text-text-primary">
				Daily quota
				<InfoTip label="About the daily quota">
					Whole Cloudflare account, this quota day{q.resets_at ? `; resets ${formatResets(q.resets_at)}` : ""}. The
					limit grows with reputation.
				</InfoTip>
			</p>
			<Meter
				className="min-w-24 flex-1"
				value={q.used}
				max={q.limit}
				color={high ? "var(--viz-warn)" : undefined}
				label={`Daily quota: ${formatCount(q.used)} of ${formatCount(q.limit)}`}
			/>
			<p className="text-sm tabular-nums text-text-primary">
				{formatRate(share)} <span className="text-text-secondary">· {ofTotal(q.used, q.limit)}</span>
			</p>
			{high && <Chip tone="warning">Check</Chip>}
		</Panel>
	);
}

// ── Domains and senders ───────────────────────────────────────────────────

const DNS_TONE: Record<string, Tone> = { ready: "good", active: "good", verified: "good" };

export function PanelTitle({ title, info, actions }: { title: string; info?: React.ReactNode; actions?: React.ReactNode }) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5 sm:px-5">
			<h3 className="flex items-center gap-1 text-sm font-medium text-text-primary">
				{title}
				{info && <InfoTip label={`About ${title}`}>{info}</InfoTip>}
			</h3>
			{actions}
		</div>
	);
}

export function DomainsPanel({ data }: { data: Overview }) {
	const domainUnit = data.sections?.domains.unit ?? "recipients";
	if (data.domains.length === 0) return null;
	return (
		<Panel>
			<PanelTitle title="Sending domains" info={`Cloudflare Email Service domains on this zone. Counted in ${domainUnit}.`} />
			<ResponsiveTable
				caption="Sending domains"
				rows={data.domains}
				rowKey={(d) => d.domain}
				columns={[
					{
						key: "domain",
						header: "Domain",
						primary: true,
						cell: (d) => (
							<span className="flex min-w-0 flex-wrap items-center gap-1.5">
								<Addr>{d.domain}</Addr>
								{!d.enabled && <Chip>Disabled</Chip>}
							</span>
						),
					},
					{
						key: "dns",
						header: "DNS",
						cell: (d) =>
							d.dns_status ? (
								DNS_TONE[d.dns_status] ? (
									<Chip tone="good">{humanize(d.dns_status)}</Chip>
								) : (
									<Link
										to="/settings/domains"
										className="inline-flex items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										title="Check its DNS records in Settings → Domains"
									>
										<Chip tone="warning">{humanize(d.dns_status)}</Chip>
									</Link>
								)
							) : (
								<span className="text-text-secondary">Unknown</span>
							),
					},
					{ key: "sent", header: "Sent", align: "right", cell: (d) => formatCount(d.sent) },
					{ key: "bounce", header: "Bounce", align: "right", cell: (d) => formatRate(safeRate(d.bounced, d.sent)) },
					{
						key: "complaints",
						header: "Complaints",
						align: "right",
						emptyOnMobile: (d) => !d.complaints,
						cell: (d) => (d.complaints == null ? "—" : formatCount(d.complaints)),
					},
				]}
			/>
		</Panel>
	);
}

export function SendersPanel({ data }: { data: Overview }) {
	const zone = data.scope === "zone";
	const senderUnit = data.sections?.senders.unit ?? "recipients";
	if (data.senders.length === 0) return null;
	const appSenderTotal = data.senders.filter((s) => s.app).reduce((a, s) => a + s.sent, 0);
	const appMessages = data.mailboxes.reduce((a, m) => a + m.sent, 0);
	const appPending = Math.max(0, appMessages - data.mailboxes.reduce((a, m) => a + m.delivered + m.bounced + m.failed, 0));
	const info = [
		zone ? "Cloudflare judges reputation on all of this mail, not only this app's." : "This app's mailboxes and aliases.",
		`Counted in ${senderUnit}: a message to 3 people counts 3.`,
		appSenderTotal && appMessages && senderUnit !== "messages" && appSenderTotal !== appMessages
			? `This app: ${countWithUnit(appSenderTotal, senderUnit)} here; its own records count ${countWithUnit(appMessages, "messages")}.`
			: "",
		appPending
			? `Delivered is Cloudflare's verdict; this app's records still show ${countWithUnit(appPending, "messages")} pending confirmation.`
			: "",
	]
		.filter(Boolean)
		.join(" ");
	return (
		<Panel>
			<PanelTitle title={zone ? "Senders on this zone" : "Senders"} info={info} />
			<ResponsiveTable
				caption="Senders"
				rows={data.senders}
				rowKey={(s) => s.from}
				columns={[
					{
						key: "from",
						header: "From",
						primary: true,
						cell: (s) => (
							<span className="flex min-w-0 flex-wrap items-center gap-1.5">
								<Addr>{s.from}</Addr>
								{zone && s.app && <Chip tone="accent">This app</Chip>}
							</span>
						),
					},
					{ key: "sent", header: "Sent", align: "right", cell: (s) => formatCount(s.sent) },
					{ key: "rate", header: "Delivered", align: "right", cell: (s) => formatRate(safeRate(s.delivered, s.sent)) },
				]}
			/>
		</Panel>
	);
}

// ── Errors ────────────────────────────────────────────────────────────────

export function ErrorsPanel({ data }: { data: Overview }) {
	if (data.errors.length === 0) return null;
	const total = data.errors.reduce((a, e) => a + e.count, 0);
	const unit = data.sections?.errors.unit ?? data.sending.unit;
	return (
		<Panel>
			<PanelTitle title="Delivery errors" info={`Bounces, failures and rejections with the server's reply, most common first. Counted in ${unit}.`} />
			<ResponsiveTable
				caption="Top delivery errors"
				rows={data.errors}
				rowKey={(e) => `${e.cause}|${e.attribution}|${e.bucket}`}
				columns={[
					{
						key: "cause",
						header: "Cause",
						primary: true,
						cell: (e) => (
							<div className="min-w-0">
								<p className="font-medium text-text-primary">{humanize(e.cause)}</p>
								{e.example && <p className="mt-0.5 break-words text-xs font-normal text-text-secondary">{e.example}</p>}
							</div>
						),
					},
					{
						key: "who",
						header: "Side",
						cell: (e) => <span>{e.attribution ? humanize(e.attribution) : e.bucket ? humanize(e.bucket) : "Unknown"}</span>,
					},
					{ key: "count", header: "Count", align: "right", cell: (e) => formatCount(e.count) },
					{ key: "share", header: "Share", align: "right", cell: (e) => formatRate(safeRate(e.count, total)) },
					{ key: "last", header: "Last seen", align: "right", cell: (e) => <span className="whitespace-nowrap">{formatRelative(e.last_seen) || "—"}</span> },
				]}
			/>
		</Panel>
	);
}

/** Sending domains whose DNS isn't ready: mail from them may be refused. */
export function dnsAlert(data: Overview): React.ReactElement | null {
	const bad = data.domains.filter((d) => d.dns_status && !DNS_TONE[d.dns_status]);
	if (bad.length === 0) return null;
	return (
		<Alert
			key="dns"
			title={
				bad.length === 1
					? `${bad[0].domain}: DNS ${humanize(bad[0].dns_status!).toLowerCase()}`
					: `${bad.length} sending domains need DNS fixes`
			}
			info="Cloudflare reports a DNS record (SPF, DKIM, DMARC or the bounce MX) missing or wrong. Receivers may reject or spam-folder mail from it."
			action={{ label: "Check DNS", to: "/settings/domains" }}
		/>
	);
}

/** "Sends failing" alert, when anything failed or was rejected in the window. */
export function failingAlert(data: Overview, href?: string): React.ReactElement | null {
	const s = data.sending;
	const n = s.failed + s.rejected;
	if (n === 0) return null;
	return (
		<Alert
			key="failing"
			title={`${plural(n, unitNoun(s.unit, 1), unitNoun(s.unit, 2))} failed or rejected before delivery`}
			action={href ? { label: "See errors", to: href } : undefined}
		/>
	);
}

function plural(n: number, one: string, many: string) {
	return `${formatCount(n)} ${n === 1 ? one : many}`;
}

// ── Suppressions ──────────────────────────────────────────────────────────

export function suppressionTiles(data: Overview): TileData[] {
	const { provider, local } = data.suppressions;
	const win = data.suppressions as { window?: unknown; provider_window?: unknown; local_window?: unknown };
	const scopeOf = (w: unknown) =>
		suppressionScope(w) === "period" ? (RANGE_OPTIONS.find((r) => r.days === data.window.days)?.long ?? "This period") : "All time";
	return [
		{
			key: "provider",
			label: "Cloudflare",
			value: provider ? formatCount(provider.total) : "—",
			sub: provider ? scopeOf(win.provider_window ?? win.window) : "Not connected",
			info: "Cloudflare refuses to send to these addresses. Whole account.",
		},
		{
			key: "local",
			label: "This app",
			value: formatCount(local.total),
			sub: scopeOf(win.local_window ?? win.window),
		},
	];
}

export function SuppressionsPanel({ data, isAdmin }: { data: Overview; isAdmin: boolean }) {
	const { provider, local } = data.suppressions;
	const lists = [
		{ title: "Cloudflare", counts: provider },
		{ title: "This app", counts: local },
	].filter((l): l is { title: string; counts: NonNullable<typeof provider> } => !!l.counts && l.counts.total > 0);
	return (
		<div className="space-y-4">
			<div>
				<TileRow label="Suppressed addresses" tiles={suppressionTiles(data)} />
			</div>
			{lists.length > 0 && (
				<div className="grid gap-4 md:grid-cols-2">
					{lists.map((l) => (
						<Panel key={l.title} className="p-4">
							<h3 className="text-sm font-medium text-text-primary">{l.title} by reason</h3>
							<ul className="mt-3 space-y-2.5">
								{Object.entries(l.counts.by_reason)
									.sort((a, b) => b[1] - a[1])
									.map(([reason, n]) => (
										<li key={reason}>
											<div className="flex justify-between text-sm">
												<span className="text-text-primary">{humanize(reason)}</span>
												<span className="tabular-nums text-text-primary">{formatCount(n)}</span>
											</div>
											<Meter className="mt-1 h-1.5" value={n} max={l.counts.total} label={`${humanize(reason)}: ${n} of ${l.counts.total}`} />
										</li>
									))}
							</ul>
						</Panel>
					))}
				</div>
			)}
			{lists.length === 0 && <p className="text-sm text-text-secondary">No suppressed addresses.</p>}
			{isAdmin && (
				<Link
					to="/settings/suppressions"
					className="inline-flex h-9 items-center gap-1 rounded-md text-sm font-medium text-accent-subtle-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch:h-11"
				>
					Manage in Settings
					<ChevronRight className="h-3.5 w-3.5" aria-hidden />
				</Link>
			)}
		</div>
	);
}
