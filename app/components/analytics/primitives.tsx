/**
 * Building blocks shared by the analytics sections: the section frame with its
 * loading / empty / error states, status chips, the segmented control, meters
 * and a table that turns into stacked rows on a phone.
 *
 * Series colours live here as CSS custom properties on `.viz` so light and
 * dark are each a selected set (validated with the dataviz palette script
 * against the card surfaces #ffffff and #14171f), not an automatic flip:
 *   --viz-1 indigo (the accent), --viz-2 orange, --viz-3 magenta.
 */
import * as React from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, CircleSlash, Info, OctagonAlert, RefreshCw } from "lucide-react";
import { Link } from "react-router";
import { cn } from "~/lib/utils";

/*
 * Auth bars: pass is --viz-1; "none" is a hatched neutral grey (not evaluated,
 * not a failure); fail is red. Each clears 3:1 against the card as a graphic,
 * and the legend repeats every count as text. --viz-hatch is the stripe laid
 * over today's partial bucket.
 */
export const VIZ_VARS =
	"[--viz-1:#4f46e5] [--viz-2:#eb6834] [--viz-3:#c62f9a] [--viz-track:#eef0f4] [--viz-grid:#e5e7eb] " +
	"[--viz-none:#8a92a0] [--viz-warn:#d97706] [--viz-blocked:#475569] [--viz-none-stripe:#c3c8d1] [--viz-fail:#dc2626] [--viz-hatch:rgb(255_255_255/0.6)] " +
	"dark:[--viz-1:#7c83f0] dark:[--viz-2:#d95926] dark:[--viz-3:#d655ad] dark:[--viz-track:#2a3040] dark:[--viz-grid:#343a48] " +
	"dark:[--viz-none:#6b7280] dark:[--viz-warn:#f59e0b] dark:[--viz-blocked:#94a3b8] dark:[--viz-none-stripe:#4b5263] dark:[--viz-fail:#f87171] dark:[--viz-hatch:rgb(20_23_31/0.6)]";

// ── Section frame ─────────────────────────────────────────────────────────

export function Section({
	id,
	title,
	description,
	actions,
	children,
	className,
}: {
	id: string;
	title: string;
	description?: React.ReactNode;
	actions?: React.ReactNode;
	children: React.ReactNode;
	className?: string;
}) {
	const headingId = `${id}-title`;
	return (
		<section id={id} aria-labelledby={headingId} className={cn("min-w-0 scroll-mt-20", className)}>
			<div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
				<div className="min-w-0">
					<h2 id={headingId} className="text-base font-semibold text-text-primary">
						{title}
					</h2>
					{description && <p className="mt-0.5 max-w-2xl text-sm text-text-secondary">{description}</p>}
				</div>
				{actions && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
			</div>
			{children}
		</section>
	);
}

/** Flat bordered surface. No shadow: the page is flat by rule. */
export function Panel({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
	return (
		<div className={cn("min-w-0 rounded-lg border border-border bg-card", className)} {...props}>
			{children}
		</div>
	);
}

/**
 * Loading, error and empty handling for one section's query. Refetches keep
 * the previous render at reduced opacity instead of flashing a skeleton.
 */
export function QueryState<T>({
	query,
	skeleton,
	isEmpty,
	empty,
	label,
	errorFallback,
	children,
}: {
	query: {
		data: T | undefined;
		isPending: boolean;
		isError: boolean;
		error: unknown;
		isPlaceholderData?: boolean;
		isFetching?: boolean;
		refetch: () => unknown;
	};
	skeleton: React.ReactNode;
	isEmpty?: (data: T) => boolean;
	empty?: React.ReactNode;
	/** What failed, in the reader's words: "inbound mail". */
	label: string;
	/** Shown instead of the full error card, when another section already shows it. */
	errorFallback?: React.ReactNode;
	children: (data: T) => React.ReactNode;
}) {
	if (query.isPending) {
		return (
			<div role="status" aria-busy="true">
				<span className="sr-only">Loading {label}</span>
				{skeleton}
			</div>
		);
	}
	if (query.isError && !query.data) {
		return errorFallback ?? <ErrorState label={label} error={query.error} onRetry={() => query.refetch()} />;
	}
	const data = query.data as T;
	const stale = query.isPlaceholderData || (query.isFetching && !query.isPending);
	return (
		<div className={cn("transition-opacity", stale && "opacity-85")} aria-busy={stale || undefined}>
			{isEmpty?.(data) ? empty : children(data)}
		</div>
	);
}

export function ErrorState({ label, error, onRetry }: { label: string; error: unknown; onRetry?: () => void }) {
	const message = error instanceof Error ? error.message : String(error ?? "");
	const status = (error as { status?: number } | null)?.status;
	const forbidden = status === 403;
	return (
		<Panel role="alert" className="flex flex-col gap-3 border-red-500/30 bg-destructive-subtle/50 px-4 py-4 sm:flex-row sm:items-start">
			<div className="min-w-0 flex-1">
				<p className="flex items-start gap-2 text-sm font-medium text-text-primary">
					<OctagonAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
					<span>{forbidden ? `You don't have access to ${label}.` : `Couldn't load ${label}.`}</span>
				</p>
				{message && !forbidden && (
					<p className="mt-0.5 break-words pl-6 text-sm text-text-secondary">{message.replace(/\.?$/, ".")}</p>
				)}
				{forbidden && (
					<p className="mt-0.5 pl-6 text-sm text-text-secondary">Ask an administrator for access to this data.</p>
				)}
			</div>
			{onRetry && !forbidden && (
				<button
					type="button"
					onClick={onRetry}
					className="ml-6 inline-flex h-9 shrink-0 items-center justify-center gap-1.5 self-start rounded-md px-3 sm:ml-0 text-sm font-medium text-text-primary ring-1 ring-border hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<RefreshCw className="h-4 w-4" aria-hidden />
					Try again
				</button>
			)}
		</Panel>
	);
}

/** In-panel empty message: what would be here, and why it isn't. */
export function EmptyNote({ title, children, className }: { title: string; children?: React.ReactNode; className?: string }) {
	return (
		<div className={cn("px-4 py-8 text-center", className)}>
			<p className="text-sm font-medium text-text-primary">{title}</p>
			{children && <p className="mx-auto mt-1 max-w-md text-sm text-text-secondary">{children}</p>}
		</div>
	);
}

export function Skeleton({ className }: { className?: string }) {
	return <div className={cn("animate-pulse rounded-md bg-bg-muted motion-reduce:animate-none", className)} />;
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
	return (
		<Panel className="space-y-3 p-4">
			{Array.from({ length: rows }, (_, i) => (
				<Skeleton key={i} className={cn("h-5", i % 2 ? "w-3/4" : "w-full")} />
			))}
		</Panel>
	);
}

// ── Chips ─────────────────────────────────────────────────────────────────

export type Tone = "good" | "warning" | "critical" | "neutral" | "accent";

const TONE_CLASS: Record<Tone, string> = {
	good: "bg-emerald-500/10 text-emerald-800 ring-emerald-600/25 dark:text-emerald-300 dark:ring-emerald-400/25",
	warning: "bg-warning-bg text-warning-text ring-warning-border",
	critical: "bg-destructive-subtle text-red-800 ring-red-600/25 dark:text-red-300 dark:ring-red-400/30",
	neutral: "bg-bg-subtle text-text-secondary ring-border",
	accent: "bg-accent-subtle text-accent-subtle-fg ring-accent/20",
};

const TONE_ICON: Record<Tone, React.ElementType | null> = {
	good: CheckCircle2,
	warning: AlertTriangle,
	critical: OctagonAlert,
	neutral: null,
	accent: null,
};

/** A status chip. Always an icon plus a word, so colour is never the only signal. */
export function Chip({
	tone = "neutral",
	icon,
	children,
	className,
	title,
}: {
	tone?: Tone;
	icon?: React.ElementType | null;
	children: React.ReactNode;
	className?: string;
	title?: string;
}) {
	const Icon = icon === undefined ? TONE_ICON[tone] : icon;
	return (
		<span
			title={title}
			className={cn(
				"inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
				TONE_CLASS[tone],
				className,
			)}
		>
			{Icon && <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />}
			<span className="truncate">{children}</span>
		</span>
	);
}

export function InfoNote({ children, className }: { children: React.ReactNode; className?: string }) {
	return (
		<p className={cn("flex items-start gap-1.5 text-xs text-text-secondary", className)}>
			<Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
			<span>{children}</span>
		</p>
	);
}

export { CircleSlash };

// ── Segmented control ─────────────────────────────────────────────────────

/**
 * A radio group drawn as joined buttons, with arrow-key movement. 32px on
 * desktop; under `touch:` each option is 44px tall inside the track (the
 * base-layer floor would also apply, but set explicitly so the track grows
 * with it).
 */
export function Segmented<T extends string | number>({
	label,
	value,
	options,
	onChange,
	className,
}: {
	label: string;
	value: T;
	options: { value: T; label: string; title?: string; disabled?: boolean }[];
	onChange: (v: T) => void;
	className?: string;
}) {
	const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
	const idx = options.findIndex((o) => o.value === value);
	const move = (dir: number) => {
		const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
		const pos = enabled.indexOf(idx);
		const next = enabled[(pos + dir + enabled.length) % enabled.length];
		onChange(options[next].value);
		refs.current[next]?.focus();
	};
	return (
		<div
			role="radiogroup"
			aria-label={label}
			className={cn("inline-flex shrink-0 gap-0.5 rounded-[8px] bg-bg-subtle p-0.5 ring-1 ring-border", className)}
			onKeyDown={(e) => {
				if (e.key === "ArrowRight" || e.key === "ArrowDown") {
					e.preventDefault();
					move(1);
				} else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
					e.preventDefault();
					move(-1);
				}
			}}
		>
			{options.map((o, i) => {
				const on = o.value === value;
				return (
					<button
						key={String(o.value)}
						ref={(el) => {
							refs.current[i] = el;
						}}
						type="button"
						role="radio"
						aria-checked={on}
						tabIndex={on ? 0 : -1}
						disabled={o.disabled}
						title={o.title}
						onClick={() => onChange(o.value)}
						className={cn(
							// Disabled keeps the tertiary text colour (5.2:1 on bg-muted) instead
							// of 40% opacity, which measured 2.2:1 in dark mode.
							"h-8 rounded-[6px] px-3 text-sm font-medium transition-colors touch:h-11 touch:min-w-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-text-tertiary disabled:hover:text-text-tertiary",
							on ? "bg-card text-text-primary shadow-sm ring-1 ring-border" : "text-text-secondary hover:text-text-primary",
						)}
					>
						{o.label}
					</button>
				);
			})}
		</div>
	);
}

// ── Meter ─────────────────────────────────────────────────────────────────

/** One horizontal bar against a tinted track of the same hue. */
export function Meter({
	value,
	max,
	label,
	color = "var(--viz-1)",
	className,
}: {
	value: number;
	max: number;
	label: string;
	color?: string;
	className?: string;
}) {
	const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
	return (
		<div
			role="meter"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={Math.max(max, value)}
			aria-valuenow={value}
			className={cn("h-2 w-full overflow-hidden rounded-full bg-[var(--viz-track)]", className)}
		>
			<div
				className="h-full rounded-full"
				style={{ width: `${pct}%`, minWidth: value > 0 ? 4 : 0, backgroundColor: color }}
			/>
		</div>
	);
}

/** A legend swatch beside text. Text stays in text colours. */
export function Swatch({ color, shape = "rect" }: { color: string; shape?: "rect" | "line" }) {
	return (
		<span
			aria-hidden
			className={cn("inline-block shrink-0", shape === "rect" ? "h-2.5 w-2.5 rounded-[3px]" : "h-0.5 w-3 rounded-full")}
			style={{ backgroundColor: color }}
		/>
	);
}

// ── Responsive table ──────────────────────────────────────────────────────

export interface Column<R> {
	key: string;
	header: React.ReactNode;
	cell: (row: R) => React.ReactNode;
	align?: "left" | "right";
	/** The row's title on a phone. Exactly one column should set it. */
	primary?: boolean;
	/** Hide on the phone layout (it is in the title, or not worth the room). */
	hideOnMobile?: boolean;
	/** Phone layout: drop this pair for a row when it has nothing to say ("0", "—"). */
	emptyOnMobile?: (row: R) => boolean;
	/** Phone layout: the value takes the full row (addresses, long text). */
	wideOnMobile?: boolean;
	className?: string;
}

/**
 * A table from `sm` up; below it, one stacked block per row with the primary
 * cell as the title and the rest as label/value pairs. A sideways-scrolling
 * table at 390px hides the column people came for off the right edge.
 */
export function ResponsiveTable<R>({
	columns,
	rows,
	rowKey,
	caption,
	empty,
	rowClassName,
	mobileLimit,
}: {
	columns: Column<R>[];
	rows: R[];
	rowKey: (row: R) => string;
	caption: string;
	empty?: React.ReactNode;
	rowClassName?: (row: R) => string | undefined;
	/** Phone layout: show this many rows, then "Show all". */
	mobileLimit?: number;
}) {
	const [showAll, setShowAll] = React.useState(false);
	if (rows.length === 0 && empty) return <>{empty}</>;
	const primary = columns.find((c) => c.primary) ?? columns[0];
	const rest = columns.filter((c) => c !== primary && !c.hideOnMobile);
	return (
		<>
			<ul className="divide-y divide-border sm:hidden" aria-label={caption}>
				{(mobileLimit && !showAll ? rows.slice(0, mobileLimit) : rows).map((row) => (
					<li key={rowKey(row)} className={cn("px-4 py-3", rowClassName?.(row))}>
						<div className="min-w-0 text-sm font-medium text-text-primary">{primary.cell(row)}</div>
						{rest.length > 0 && (
							<dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
								{rest.filter((c) => !c.emptyOnMobile?.(row)).map((c) => (
									<div key={c.key} className={cn("flex min-w-0 items-baseline gap-1.5", c.wideOnMobile && "col-span-2")}>
										<dt className="shrink-0 text-xs text-text-secondary">{c.header}</dt>
										<dd className="min-w-0 break-words tabular-nums text-text-primary">{c.cell(row)}</dd>
									</div>
								))}
							</dl>
						)}
					</li>
				))}
			</ul>
			{mobileLimit != null && rows.length > mobileLimit && (
				<div className="border-t border-border px-4 sm:hidden">
					<button
						type="button"
						onClick={() => setShowAll((v) => !v)}
						aria-expanded={showAll}
						className="h-11 text-sm font-medium text-accent-subtle-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						{showAll ? "Show fewer" : `Show all ${rows.length}`}
					</button>
				</div>
			)}
			<div className="hidden overflow-x-auto sm:block">
				<table className="w-full text-sm">
					<caption className="sr-only">{caption}</caption>
					<thead>
						<tr className="border-b border-border text-left text-xs font-medium text-text-secondary">
							{columns.map((c) => (
								<th
									key={c.key}
									scope="col"
									className={cn("whitespace-nowrap px-4 py-2.5 font-medium first:pl-5 last:pr-5", c.align === "right" && "text-right", c.className)}
								>
									{c.header}
								</th>
							))}
						</tr>
					</thead>
					<tbody className="divide-y divide-border">
						{rows.map((row) => (
							<tr key={rowKey(row)} className={cn("align-top", rowClassName?.(row))}>
								{columns.map((c) => (
									<td
										key={c.key}
										className={cn(
											"px-4 py-3 first:pl-5 last:pr-5",
											c.align === "right" && "text-right tabular-nums",
											c.primary && "font-medium text-text-primary",
											!c.primary && "whitespace-nowrap text-text-primary",
											c.className,
										)}
									>
										{c.cell(row)}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</>
	);
}

/**
 * An email address or hostname that wraps at its natural seam (after `@`, or
 * before a `.` in a bare hostname) instead of mid-word, so
 * "forward@example.net" never becomes "forward@exa / mple.net".
 * Mid-word breaking stays as a last resort for strings wider than the cell.
 */
export function Addr({ children, className }: { children: string; className?: string }) {
	// Addresses break after "@" only; long hostnames (PTR records) at dots.
	// Short bare domains ("tapetide.com") never break.
	const parts = children.includes("@")
		? children.split(/(?<=@)/)
		: children.length > 24
			? children.split(/(?<=\.)/)
			: [children];
	return (
		<span title={children} className={cn("[overflow-wrap:anywhere]", parts.length === 1 && "whitespace-nowrap", className)}>
			{parts.map((p, i) => (
				<React.Fragment key={i}>
					{i > 0 && <wbr />}
					<span className="whitespace-nowrap">{p}</span>
				</React.Fragment>
			))}
		</span>
	);
}

/** A labelled number for a summary row: value first, label under it. */
export function Figure({
	label,
	value,
	sub,
	className,
}: {
	label: string;
	value: React.ReactNode;
	sub?: React.ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("min-w-0", className)}>
			<p className="text-sm text-text-secondary">{label}</p>
			<p className="mt-0.5 text-2xl font-semibold tracking-tight text-text-primary">{value}</p>
			{sub && <p className="mt-0.5 text-xs text-text-secondary">{sub}</p>}
		</div>
	);
}

// ── Info tip ──────────────────────────────────────────────────────────────

/**
 * A small ⓘ button that explains the number beside it. The text is always in
 * the DOM and wired with `aria-describedby`, so a screen reader hears it on
 * focus; sighted users see it on hover, focus or tap. It is positioned
 * `fixed` and clamped to the viewport, so it never widens a phone layout.
 */
export function InfoTip({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
	const id = React.useId();
	const btn = React.useRef<HTMLButtonElement | null>(null);
	const [pos, setPos] = React.useState<{ left: number; top: number; above: boolean } | null>(null);
	const [pinned, setPinned] = React.useState(false);
	const show = () => {
		const r = btn.current?.getBoundingClientRect();
		if (!r) return;
		const width = Math.min(256, window.innerWidth - 16);
		const left = Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8));
		const above = r.top > 140;
		setPos({ left, top: above ? r.top - 6 : r.bottom + 6, above });
	};
	const hide = () => {
		setPos(null);
		setPinned(false);
	};
	React.useEffect(() => {
		if (!pos) return;
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
		const onScroll = () => hide();
		const onDown = (e: PointerEvent) => {
			if (!btn.current?.contains(e.target as Node)) hide();
		};
		window.addEventListener("keydown", onKey);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("pointerdown", onDown);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("pointerdown", onDown);
		};
	}, [pos]);
	return (
		<span className={cn("inline-flex align-middle", className)}>
			<button
				ref={btn}
				type="button"
				aria-label={label}
				aria-describedby={id}
				aria-expanded={pos ? true : undefined}
				onMouseEnter={show}
				onMouseLeave={() => !pinned && setPos(null)}
				onFocus={show}
				onBlur={hide}
				onClick={() => {
					if (pinned) hide();
					else {
						show();
						setPinned(true);
					}
				}}
				className="-m-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-text-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch:-my-3 touch:h-11 touch:w-11"
			>
				<Info className="h-3.5 w-3.5" aria-hidden />
			</button>
			<span
				role="tooltip"
				id={id}
				hidden={!pos}
				style={pos ? { left: pos.left, top: pos.top, transform: pos.above ? "translateY(-100%)" : undefined } : undefined}
				className="pointer-events-none fixed z-50 w-64 max-w-[calc(100vw-16px)] rounded-md border border-border bg-card px-3 py-2 text-left text-xs font-normal leading-relaxed text-text-primary shadow-md"
			>
				{children}
			</span>
		</span>
	);
}

// ── Tiles ─────────────────────────────────────────────────────────────────

export interface TileData {
	key: string;
	label: string;
	value: React.ReactNode;
	/** One short line: "699 of 699". */
	sub?: React.ReactNode;
	/** Definition or caveat, behind an ⓘ beside the label. */
	info?: React.ReactNode;
	tone?: Tone;
	/** Chip text for a warning tone; defaults to "Check". */
	toneLabel?: string;
	meter?: { value: number; max: number };
}

const GRID_COLS: Record<number, string> = {
	1: "grid-cols-1",
	2: "grid-cols-2",
	3: "grid-cols-2 sm:grid-cols-3",
	4: "grid-cols-2 lg:grid-cols-4",
	5: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5",
};

/**
 * The lead numbers of a tab: one joined strip of 1–5 tiles. Every tab uses
 * this, so the numbers that matter look the same everywhere.
 */
export function TileRow({ tiles, label, className }: { tiles: TileData[]; label: string; className?: string }) {
	const n = Math.min(5, Math.max(1, tiles.length));
	return (
		<ul
			aria-label={label}
			className={cn("grid gap-px overflow-hidden rounded-lg border border-border bg-border", GRID_COLS[n], className)}
		>
			{tiles.map((t, i) => (
				<li
					key={t.key}
					className={cn(
						"min-w-0 bg-card px-4 py-3",
						// An odd last tile on the two-up phone grid spans the row, so no blank cell.
						n % 2 === 1 && i === n - 1 && "col-span-2 sm:col-span-1",
					)}
				>
					<p className="flex items-start gap-1 text-[13px] leading-snug text-text-secondary">
						<span className="min-w-0">{t.label}</span>
						{t.info && <InfoTip label={`About ${t.label}`}>{t.info}</InfoTip>}
					</p>
					<p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xl font-semibold tracking-tight text-text-primary tabular-nums">
						{t.value}
						{(t.tone === "warning" || t.tone === "critical") && (
							<Chip tone={t.tone}>{t.toneLabel ?? (t.tone === "critical" ? "At risk" : "Check")}</Chip>
						)}
					</p>
					{t.meter && (
						<Meter
							className="mt-1.5"
							value={t.meter.value}
							max={t.meter.max}
							label={`${t.label}: ${t.meter.value} of ${t.meter.max}`}
						/>
					)}
					{t.sub && <p className="mt-0.5 text-xs text-text-secondary">{t.sub}</p>}
				</li>
			))}
		</ul>
	);
}

export function TileSkeleton({ count = 4 }: { count?: number }) {
	const n = Math.min(5, Math.max(1, count));
	return (
		<div className={cn("grid gap-px overflow-hidden rounded-lg border border-border bg-border", GRID_COLS[n])}>
			{Array.from({ length: n }, (_, i) => (
				<div key={i} className={cn("space-y-2 bg-card px-4 py-3", n % 2 === 1 && i === n - 1 && "col-span-2 sm:col-span-1")}>
					<Skeleton className="h-4 w-20" />
					<Skeleton className="h-7 w-16" />
					<Skeleton className="h-3 w-24" />
				</div>
			))}
		</div>
	);
}

// ── Alerts ────────────────────────────────────────────────────────────────

/**
 * A warning that needs action: one line and one button. Detail, when there
 * is any, sits behind the ⓘ or below in `children`.
 */
export function Alert({
	tone = "warning",
	title,
	info,
	action,
	children,
	className,
}: {
	tone?: "warning" | "critical" | "neutral";
	title: React.ReactNode;
	info?: React.ReactNode;
	action?: { label: string; to: string; primary?: boolean };
	/** Row detail, shown on "Details". */
	children?: React.ReactNode;
	className?: string;
}) {
	const headingId = React.useId();
	const detailId = React.useId();
	const [open, setOpen] = React.useState(false);
	const grouped = React.useContext(AlertGroupContext);
	const Icon = tone === "neutral" ? Info : tone === "critical" ? OctagonAlert : AlertTriangle;
	const Frame = grouped ? "div" : Panel;
	return (
		<Frame
			role="region"
			aria-labelledby={headingId}
			className={cn(
				"px-4 py-2.5",
				!grouped && tone === "warning" && "border-warning-border",
				!grouped && tone === "critical" && "border-red-500/40",
				className,
			)}
		>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
				<p id={headingId} className="flex min-w-0 flex-1 items-start gap-2 text-sm font-medium text-text-primary">
					<Icon
						className={cn(
							"mt-0.5 h-4 w-4 shrink-0",
							tone === "warning" ? "text-warning-text" : tone === "critical" ? "text-destructive" : "text-text-secondary",
						)}
						aria-hidden
					/>
					<span className="min-w-0">
						{children ? (
							<button
								type="button"
								aria-expanded={open}
								aria-controls={detailId}
								onClick={() => setOpen((v) => !v)}
								className="touch-exempt rounded text-left font-medium text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch:py-3"
							>
								{title}
								<ChevronDown className={cn("ml-1 inline h-3.5 w-3.5 align-[-2px] transition-transform", open && "rotate-180")} aria-hidden />
							</button>
						) : (
							title
						)}
						{info && !children && (
							<>
								{" "}
								<InfoTip label="More about this">{info}</InfoTip>
							</>
						)}
					</span>
				</p>
				{action && (
					<Link
						to={action.to}
						className={cn(
							"-my-2 ml-6 inline-flex h-11 shrink-0 items-center self-start text-sm font-medium text-accent-subtle-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
							"sm:my-0 sm:ml-0 sm:h-8 sm:self-auto sm:rounded-md sm:px-3 sm:no-underline",
							action.primary
								? "sm:bg-accent sm:text-accent-foreground sm:hover:bg-accent-hover"
								: "sm:text-text-primary sm:ring-1 sm:ring-border sm:hover:bg-bg-muted",
						)}
					>
						{action.label}
					</Link>
				)}
			</div>
			{children && (
				<div id={detailId} hidden={!open}>
					{info && <p className="mt-1.5 text-sm text-text-secondary sm:ml-6">{info}</p>}
					{children}
				</div>
			)}
		</Frame>
	);
}

const AlertGroupContext = React.createContext(false);

/**
 * Several alerts as rows of one card, so a tab with three things to fix shows
 * one block instead of a stack of banners. Renders nothing when empty.
 */
export function AlertGroup({ items }: { items: (React.ReactElement | null | false | undefined)[] }) {
	const shown = items.filter((x): x is React.ReactElement => !!x);
	if (shown.length === 0) return null;
	if (shown.length === 1) return shown[0];
	return (
		<AlertGroupContext.Provider value={true}>
			<Panel className="divide-y divide-border border-warning-border">{shown}</Panel>
		</AlertGroupContext.Provider>
	);
}

/** The one empty state a tab shows when it has nothing at all. */
export function TabEmpty({ title, children }: { title: string; children?: React.ReactNode }) {
	return (
		<Panel>
			<EmptyNote title={title} className="py-10">
				{children}
			</EmptyNote>
		</Panel>
	);
}
