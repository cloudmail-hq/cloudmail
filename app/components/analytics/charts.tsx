/**
 * Plain HTML/CSS charts for the analytics console. No chart library: a
 * stacked column chart is a flex row of divs, and that keeps the bundle and
 * the theming simple.
 *
 * Mark specs follow the dataviz rules: columns at most 24px wide with a 4px
 * rounded data end, 2px surface gaps between stacked segments, hairline solid
 * gridlines, one y-axis, a legend for two or more series, a tooltip that
 * follows the pointer and the keyboard, and a table twin for every chart.
 */
import * as React from "react";
import { bucketSeries, formatCount, formatSpan, niceTicks, partialDayIndex, stackSegments } from "./format";
import { Swatch } from "./primitives";
import { cn } from "~/lib/utils";

export interface ChartSeries<R> {
	key: string;
	label: string;
	color: string;
	value: (row: R) => number;
}

const PLOT_H = 168;
/** Narrowest slot per column before days are merged into buckets. */
const MIN_SLOT = 9;

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
	const ref = React.useRef<T | null>(null);
	const [w, setW] = React.useState(0);
	React.useEffect(() => {
		const el = ref.current;
		if (!el) return;
		setW(el.clientWidth);
		const ro = new ResizeObserver((entries) => setW(entries[0].contentRect.width));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	return [ref, w];
}

/**
 * Stacked columns per day. `stacked=false` draws the series side by side in
 * each slot instead (opens next to clicks: they overlap, they don't add up).
 */
export function ColumnChart<R extends { date: string }>({
	rows,
	series,
	label,
	summary,
	stacked = true,
	unit,
	partialLabel = "today so far",
	now,
}: {
	rows: R[];
	series: ChartSeries<R>[];
	/** Accessible name of the chart: "Daily sending volume". */
	label: string;
	/** One or two sentences that say what the chart shows. */
	summary: string;
	stacked?: boolean;
	/** Noun for the tooltip total: "messages", "recipients". */
	unit: string;
	/** How today's (UTC) bucket is labelled; it only covers the hours so far. */
	partialLabel?: string;
	/** Clock for the partial-day check; tests and fixtures pin it. */
	now?: number;
}) {
	const [plotRef, width] = useWidth<HTMLDivElement>();
	const maxBuckets = width > 0 ? Math.max(6, Math.floor(width / MIN_SLOT)) : rows.length;
	const buckets = React.useMemo(() => bucketSeries(rows, maxBuckets), [rows, maxBuckets]);
	const [active, setActive] = React.useState<number | null>(null);
	// Screen-reader readout follows the keyboard only, so hovering doesn't
	// stream announcements.
	const [announced, setAnnounced] = React.useState<number | null>(null);
	const descId = React.useId();

	const valuesOf = (b: (typeof buckets)[number]) => series.map((s) => Math.max(0, s.value(b.values)));
	const max = Math.max(
		0,
		...buckets.map((b) => {
			const v = valuesOf(b);
			return stacked ? v.reduce((a, c) => a + c, 0) : Math.max(...v);
		}),
	);
	const ticks = niceTicks(max);
	const top = ticks[ticks.length - 1] || 1;

	const indexAt = (clientX: number) => {
		const el = plotRef.current;
		if (!el || buckets.length === 0) return null;
		const r = el.getBoundingClientRect();
		const i = Math.floor(((clientX - r.left) / r.width) * buckets.length);
		return Math.min(buckets.length - 1, Math.max(0, i));
	};

	const activeBucket = active != null ? buckets[active] : null;
	// The bucket holding today, which is only partly over: hatched and labelled.
	const partialRow = partialDayIndex(rows.map((r) => r.date), now);
	const partialDate = partialRow >= 0 ? rows[partialRow].date : null;
	const partialBucket = partialDate ? buckets.findIndex((b) => b.start <= partialDate && partialDate <= b.end) : -1;
	const spanTitle = (i: number) =>
		`${formatSpan(buckets[i].start, buckets[i].end)}${i === partialBucket ? ` (${partialLabel})` : ""}`;
	// Label every nth column so x labels never collide (about 56px each).
	const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(width / 56))));

	return (
		<figure className="m-0 min-w-0">
			{(series.length > 1 || partialBucket >= 0) && (
				<ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary" aria-label="Legend">
					{(series.length > 1 || partialBucket >= 0) &&
						series.map((s) => (
							<li key={s.key} className="flex items-center gap-1.5">
								<Swatch color={s.color} />
								{s.label}
							</li>
						))}
					{partialBucket >= 0 && (
						<li className="flex items-center gap-1.5">
							<span
								aria-hidden
								className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]"
								style={{ backgroundColor: series[0]?.color, backgroundImage: PARTIAL_HATCH }}
							/>
							{partialLabel.charAt(0).toUpperCase() + partialLabel.slice(1)}
						</li>
					)}
				</ul>
			)}
			<div className="flex min-w-0 gap-2">
				{/* Y axis */}
				<div className="relative w-9 shrink-0 text-right text-xs tabular-nums text-text-secondary" style={{ height: PLOT_H }} aria-hidden>
					{ticks.map((t) => (
						<span key={t} className="absolute right-0 -translate-y-1/2 leading-none" style={{ top: PLOT_H - (t / top) * PLOT_H }}>
							{formatCount(t)}
						</span>
					))}
				</div>
				<div className="min-w-0 flex-1">
					<div
						ref={plotRef}
						role="group"
						aria-label={label}
						aria-describedby={descId}
						tabIndex={0}
						className="relative rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
						style={{ height: PLOT_H }}
						onPointerMove={(e) => setActive(indexAt(e.clientX))}
						onPointerLeave={() => setActive(null)}
						onBlur={() => {
							setActive(null);
							setAnnounced(null);
						}}
						onFocus={() => {
							const i = active ?? buckets.length - 1;
							setActive(i);
							setAnnounced(i);
						}}
						onKeyDown={(e) => {
							if (buckets.length === 0) return;
							const cur = active ?? buckets.length;
							let next: number | null;
							if (e.key === "ArrowRight") next = Math.min(buckets.length - 1, (active ?? -1) + 1);
							else if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
							else if (e.key === "Home") next = 0;
							else if (e.key === "End") next = buckets.length - 1;
							else if (e.key === "Escape") next = null;
							else return;
							e.preventDefault();
							setActive(next);
							setAnnounced(next);
						}}
					>
						{/* Gridlines: solid hairlines, baseline one step darker. */}
						{ticks.map((t) => (
							<div
								key={t}
								aria-hidden
								className={cn("absolute inset-x-0 h-px", t === 0 ? "bg-border" : "bg-[var(--viz-grid)]")}
								style={{ top: PLOT_H - (t / top) * PLOT_H - (t === 0 ? 1 : 0) }}
							/>
						))}
						<div className="absolute inset-0 flex items-end" aria-hidden>
							{buckets.map((b, i) => {
								const vals = valuesOf(b);
								const on = active === i;
								return (
									<div key={b.start} className={cn("flex h-full min-w-0 flex-1 items-end justify-center px-[1px]", on && "bg-bg-subtle")}>
										{stacked ? (
											<StackedColumn values={vals} colors={series.map((s) => s.color)} max={top} partial={i === partialBucket} />
										) : (
											<div className="flex h-full w-full max-w-[28px] items-end justify-center gap-[2px]">
												{vals.map((v, j) => (
													<div
														key={series[j].key}
														className="min-w-0 flex-1 rounded-t-[4px]"
														style={{
															height: v > 0 ? Math.max(2, (v / top) * PLOT_H) : 0,
															backgroundColor: series[j].color,
															maxWidth: 12,
															...(i === partialBucket ? { backgroundImage: PARTIAL_HATCH } : {}),
														}}
													/>
												))}
											</div>
										)}
									</div>
								);
							})}
						</div>
						{activeBucket && (
							<ChartTooltip
								position={(active! + 0.5) / buckets.length}
								title={spanTitle(active!)}
								rows={series.map((s) => ({ label: s.label, color: s.color, value: s.value(activeBucket.values) }))}
								total={stacked && series.length > 1 ? { label: `Total ${unit}`, value: valuesOf(activeBucket).reduce((a, c) => a + c, 0) } : undefined}
							/>
						)}
					</div>
					{/* X axis */}
					<div className="relative mt-1.5 h-4 text-xs text-text-secondary" aria-hidden>
						{buckets.map((b, i) => {
							const last = buckets.length - 1;
							// First and last always; between them every nth, unless it
							// would crowd the last label.
							const show = i === 0 || i === last || (i % labelEvery === 0 && last - i >= labelEvery);
							if (!show) return null;
							// Centred on the column; the first and last stay inside the plot.
							const centre = ((i + 0.5) / buckets.length) * 100;
							const shift = i === 0 && centre < 8 ? "-10%" : i === last && centre > 92 ? "-90%" : "-50%";
							return (
								<span
									key={b.start}
									className="absolute whitespace-nowrap"
									style={{ left: `${centre}%`, transform: `translateX(${shift})` }}
								>
									{i === partialBucket && i === last ? "Today" : formatSpan(b.start, b.start)}
								</span>
							);
						})}
					</div>
				</div>
			</div>
			{/* The text alternative: read with the chart (aria-describedby), not printed under it. */}
			<figcaption id={descId} className="sr-only">
				{summary}
				{buckets.length < rows.length && ` Each column is ${Math.ceil(rows.length / buckets.length)} days.`}
				{partialBucket >= 0 && ` The hatched last column is ${partialLabel}.`}
			</figcaption>
			<p className="sr-only" aria-live="polite">
				{announced != null && buckets[announced]
					? `${spanTitle(announced)}: ${series
							.map((s) => `${s.label} ${formatCount(s.value(buckets[announced].values))}`)
							.join(", ")}`
					: ""}
			</p>
			<ChartTable rows={rows} series={series} label={label} partialDate={partialDate} partialLabel={partialLabel} />
		</figure>
	);
}

/** Diagonal stripes over a bar: "this bucket isn't finished". */
const PARTIAL_HATCH = "repeating-linear-gradient(135deg, var(--viz-hatch) 0 2px, transparent 2px 5px)";

function StackedColumn({ values, colors, max, partial }: { values: number[]; colors: string[]; max: number; partial?: boolean }) {
	const heights = stackSegments(values, max, PLOT_H);
	// Bottom-up: the first series sits on the baseline.
	const order = values.map((_, i) => i).filter((i) => heights[i] > 0);
	return (
		<div className="flex w-full max-w-[24px] flex-col-reverse items-stretch gap-[2px]">
			{order.map((i, k) => (
				<div
					key={i}
					style={{ height: heights[i], backgroundColor: colors[i], ...(partial ? { backgroundImage: PARTIAL_HATCH } : {}) }}
					className={cn(k === order.length - 1 ? "rounded-t-[4px]" : "rounded-none", heights[i] < 4 && "rounded-t-[1px]")}
				/>
			))}
		</div>
	);
}

function ChartTooltip({
	position,
	title,
	rows,
	total,
}: {
	position: number;
	title: string;
	rows: { label: string; color: string; value: number }[];
	total?: { label: string; value: number };
}) {
	// Flip to the left of the column past the middle, so it never leaves the card.
	const right = position > 0.5;
	return (
		<div
			aria-hidden
			className="pointer-events-none absolute top-1 z-10 min-w-[148px] rounded-md border border-border bg-card px-3 py-2 text-xs shadow-md"
			style={right ? { right: `calc(${(1 - position) * 100}% + 10px)` } : { left: `calc(${position * 100}% + 10px)` }}
		>
			<p className="mb-1 font-medium text-text-secondary">{title}</p>
			<ul className="space-y-0.5">
				{rows.map((r) => (
					<li key={r.label} className="flex items-center gap-2">
						<Swatch color={r.color} shape="line" />
						<span className="font-semibold tabular-nums text-text-primary">{formatCount(r.value)}</span>
						<span className="text-text-secondary">{r.label}</span>
					</li>
				))}
			</ul>
			{total && (
				<p className="mt-1 border-t border-border pt-1 text-text-secondary">
					<span className="font-semibold tabular-nums text-text-primary">{formatCount(total.value)}</span> {total.label}
				</p>
			)}
		</div>
	);
}

/** The chart's table twin, behind a disclosure so it doesn't double the page. */
export function ChartTable<R extends { date: string }>({
	rows,
	series,
	label,
	partialDate,
	partialLabel,
}: {
	rows: R[];
	series: { key: string; label: string; value: (row: R) => number }[];
	label: string;
	partialDate?: string | null;
	partialLabel?: string;
}) {
	return (
		<details className="group mt-2">
			<summary className="inline-flex h-8 cursor-pointer select-none items-center rounded-md text-xs font-medium text-accent-subtle-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch:h-11">
				<span className="group-open:hidden">Show as table</span>
				<span className="hidden group-open:inline">Hide table</span>
			</summary>
			<div className="mt-2 max-h-72 overflow-auto rounded-md border border-border">
				<table className="w-full text-xs">
					<caption className="sr-only">{label}, by day</caption>
					<thead className="sticky top-0 bg-bg-subtle">
						<tr className="text-left text-text-secondary">
							<th scope="col" className="px-3 py-2 font-medium">Day</th>
							{series.map((s) => (
								<th key={s.key} scope="col" className="px-3 py-2 text-right font-medium">{s.label}</th>
							))}
						</tr>
					</thead>
					<tbody className="divide-y divide-border">
						{rows.map((r) => (
							<tr key={r.date}>
								<th scope="row" className="whitespace-nowrap px-3 py-1.5 text-left font-normal text-text-secondary">
									{formatSpan(r.date, r.date)}
									{r.date === partialDate && partialLabel && ` (${partialLabel})`}
								</th>
								{series.map((s) => (
									<td key={s.key} className="px-3 py-1.5 text-right tabular-nums text-text-primary">{formatCount(s.value(r))}</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</details>
	);
}

/**
 * Horizontal bars for a ranked list (top recipient addresses, DMARC sources):
 * one series, one colour, value at the bar's tip.
 */
export function BarList<R>({
	rows,
	label,
	value,
	name,
	extra,
	color = "var(--viz-1)",
	format = formatCount,
}: {
	rows: R[];
	label: string;
	value: (r: R) => number;
	name: (r: R) => React.ReactNode;
	extra?: (r: R) => React.ReactNode;
	color?: string;
	format?: (n: number) => string;
}) {
	const max = Math.max(1, ...rows.map(value));
	return (
		<ul className="space-y-3" aria-label={label}>
			{rows.map((r, i) => (
				<li key={i} className="min-w-0">
					<div className="flex min-w-0 items-baseline justify-between gap-3 text-sm">
						<span className="flex min-w-0 items-center gap-2 text-text-primary">{name(r)}</span>
						<span className="shrink-0 tabular-nums text-text-primary">{format(value(r))}</span>
					</div>
					<div className="mt-1 h-1.5 w-full rounded-full bg-[var(--viz-track)]" aria-hidden>
						<div className="h-full rounded-full" style={{ width: `${(value(r) / max) * 100}%`, minWidth: value(r) > 0 ? 3 : 0, backgroundColor: color }} />
					</div>
					{extra && <div className="mt-1">{extra(r)}</div>}
				</li>
			))}
		</ul>
	);
}
