/**
 * Pure formatting and geometry helpers for the analytics console.
 *
 * Kept free of React and the DOM so they unit-test in the Node test runner
 * (`test/analytics-format.test.ts`).
 */
import type { ReputationMetric, ReputationMetricKey } from "../../../shared/analytics-types";

/** "1,284", "12.9K", "4.2M". Below 10,000 the exact number is kept. */
export function formatCount(n: number | null | undefined): string {
	if (n == null || !Number.isFinite(n)) return "—";
	const abs = Math.abs(n);
	if (abs < 10_000) return Math.round(n).toLocaleString("en-US");
	// 999,950 rounds to "1000.0K"; promote it to millions instead.
	if (abs < 999_950) return `${trimZero((n / 1_000).toFixed(1))}K`;
	return `${trimZero((n / 1_000_000).toFixed(1))}M`;
}

function trimZero(s: string): string {
	return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/**
 * A 0–1 fraction as a percentage. Small non-zero rates keep enough precision
 * to tell 0.04% from 0, which is what a complaint rate needs.
 */
export function formatRate(r: number | null | undefined): string {
	if (r == null || !Number.isFinite(r)) return "—";
	const pct = r * 100;
	if (pct === 0) return "0%";
	// Never print a non-zero rate as 0%.
	if (pct > 0 && pct < 0.005) return "<0.01%";
	if (pct === 100) return "100%";
	if (Math.abs(pct) < 0.1) return `${trimZeroes(pct.toFixed(2))}%`;
	if (Math.abs(pct) < 10) return `${trimZeroes(pct.toFixed(1))}%`;
	if (pct > 99.9 && pct < 100) return ">99.9%";
	if (pct > 99 && pct < 100) return `${trimZeroes(pct.toFixed(1))}%`;
	return `${Math.round(pct)}%`;
}

function trimZeroes(s: string): string {
	return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** n/d as a fraction, or null when there is nothing to divide by. */
export function safeRate(n: number, d: number): number | null {
	if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return null;
	return n / d;
}

/** "just now", "4m ago", "3h ago", "2d ago". */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
	if (!iso) return "";
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return "";
	const s = Math.max(0, Math.round((now - t) / 1000));
	if (s < 45) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h ago`;
	return `${Math.round(h / 24)}d ago`;
}

/** "Oct 26" for a `YYYY-MM-DD` day bucket, read as UTC. */
export function formatDay(day: string): string {
	const t = Date.parse(`${day}T00:00:00Z`);
	if (Number.isNaN(t)) return day;
	return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "Oct 26, 14:05" for an ISO timestamp, in the viewer's zone. */
export function formatDateTime(iso: string | null | undefined): string {
	if (!iso) return "—";
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return iso;
	return new Date(t).toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

export const RANGE_OPTIONS = [
	{ days: 1, label: "24h", long: "Last 24 hours" },
	{ days: 7, label: "7d", long: "Last 7 days" },
	{ days: 30, label: "30d", long: "Last 30 days" },
	{ days: 90, label: "90d", long: "Last 90 days" },
] as const;

/** Labels for the three reputation metrics, in Cloudflare's own words. */
export const REPUTATION_LABELS: Record<ReputationMetricKey, { title: string; basis: string }> = {
	bounce: { title: "Bounce rate", basis: "bounces" },
	complaint: { title: "Complaint rate", basis: "spam complaints" },
	spam_rejection: { title: "Spam rejection rate", basis: "rejected as spam" },
};

export type ReputationTone = "healthy" | "warning" | "at_risk" | "suspended" | "unknown";

/** Normalise Cloudflare's status enum. The docs call `suspended` "Paused". */
export function reputationStatus(status: string | null | undefined): {
	tone: ReputationTone;
	label: string;
} {
	switch ((status ?? "").toLowerCase()) {
		case "healthy":
			return { tone: "healthy", label: "Healthy" };
		case "warning":
			return { tone: "warning", label: "Warning" };
		case "at_risk":
		case "at-risk":
			return { tone: "at_risk", label: "At risk" };
		case "suspended":
		case "paused":
			return { tone: "suspended", label: "Paused" };
		default:
			return { tone: "unknown", label: status ? humanize(status) : "Unknown" };
	}
}

export type GaugeZone = "insufficient" | "unknown" | "healthy" | "warning" | "at_risk";

/**
 * Where a reputation metric sits against its live thresholds, plus the
 * geometry to draw it on a rail.
 *
 * The rail is piecewise: 0 → warning fills the first third, warning → at risk
 * the second, and at risk → 1.5 × at risk the last. Thresholds differ by two
 * orders of magnitude (2% complaints, 90% bounces), so a linear rail would
 * put the same severity in different places; this way a marker one third of
 * the way along means "at the warning line" on every gauge. A value past the
 * end pins to the right edge.
 */
export function gaugeModel(m: ReputationMetric): {
	zone: GaugeZone;
	scaleMax: number;
	warnPos: number;
	riskPos: number;
	valuePos: number | null;
} {
	const warn = Math.max(m.warning_at, 1e-6);
	const risk = Math.max(m.at_risk_at, warn * 1.0001);
	const scaleMax = Math.min(1, Math.max(risk * 1.5, risk + 1e-6));
	const pos = (v: number) => {
		if (v <= warn) return clamp((v / warn) / 3, 0, 1 / 3);
		if (v <= risk) return 1 / 3 + ((v - warn) / (risk - warn)) / 3;
		return clamp(2 / 3 + ((v - risk) / Math.max(1e-6, scaleMax - risk)) / 3, 2 / 3, 1);
	};
	const insufficient = m.denominator < m.minimum_denominator;
	let zone: GaugeZone;
	if (insufficient) zone = "insufficient";
	else if (m.value == null) zone = "unknown";
	else if (m.value >= m.at_risk_at) zone = "at_risk";
	else if (m.value >= m.warning_at) zone = "warning";
	else zone = "healthy";
	return {
		zone,
		scaleMax,
		warnPos: pos(m.warning_at),
		riskPos: pos(m.at_risk_at),
		valuePos: m.value == null ? null : pos(m.value),
	};
}

export function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

/**
 * Round axis ticks: 0 and up to `count` evenly spaced clean steps (1, 2, 2.5,
 * 5 × 10ⁿ) covering `max`. Returns at least [0, 1] so an empty series still
 * gets an axis.
 */
export function niceTicks(max: number, count = 4): number[] {
	if (!Number.isFinite(max) || max <= 0) return [0, 1];
	const raw = max / count;
	const mag = 10 ** Math.floor(Math.log10(raw));
	const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw) ?? 10 * mag;
	// Counts are integers: a step below 1 would label 0.5 messages.
	const s = Math.max(1, step);
	const top = Math.ceil(max / s) * s;
	const ticks: number[] = [];
	for (let v = 0; v <= top + s / 2; v += s) ticks.push(Math.round(v * 1000) / 1000);
	return ticks;
}

/**
 * Fill missing days with zeros. Cloudflare omits empty buckets, so a quiet day
 * would otherwise vanish from the axis and the bars would lie about spacing.
 */
export function fillDays<T extends { date: string }>(
	rows: T[],
	start: string,
	end: string,
	empty: (date: string) => T,
): T[] {
	const byDate = new Map(rows.map((r) => [r.date, r]));
	const s = Date.parse(`${start.slice(0, 10)}T00:00:00Z`);
	const e = Date.parse(`${end.slice(0, 10)}T00:00:00Z`);
	if (Number.isNaN(s) || Number.isNaN(e) || e < s) return rows;
	const out: T[] = [];
	for (let t = s; t <= e; t += 86_400_000) {
		const d = new Date(t).toISOString().slice(0, 10);
		out.push(byDate.get(d) ?? empty(d));
	}
	// Rows outside the window (clock skew) are kept rather than dropped.
	const inWindow = new Set(out.map((o) => o.date));
	const extra = rows.filter((r) => !inWindow.has(r.date));
	return extra.length ? [...out, ...extra].sort((a, b) => a.date.localeCompare(b.date)) : out;
}

/** Sum of a record's values. */
export function sumValues(rec: Record<string, number> | null | undefined): number {
	if (!rec) return 0;
	let n = 0;
	for (const v of Object.values(rec)) if (Number.isFinite(v)) n += v;
	return n;
}

/**
 * An auth verdict histogram as pass rate plus the other verdicts, largest
 * first. Verdicts follow RFC 8601 (`pass`, `fail`, `softfail`, `none`, …).
 */
export function authBreakdown(rec: Record<string, number> | null | undefined): {
	total: number;
	pass: number;
	passRate: number | null;
	others: { verdict: string; count: number }[];
} {
	const total = sumValues(rec);
	const pass = rec?.pass ?? 0;
	const others = Object.entries(rec ?? {})
		.filter(([k, v]) => k !== "pass" && v > 0)
		.map(([verdict, count]) => ({ verdict, count }))
		.sort((a, b) => b.count - a.count);
	return { total, pass, passRate: safeRate(pass, total), others };
}

/** Verdicts that mean something failed, as opposed to "not evaluated". */
export function isFailingVerdict(verdict: string): boolean {
	return ["fail", "softfail", "permerror", "temperror"].includes(verdict.toLowerCase());
}

/** "hard_bounce" -> "Hard bounce"; "deliveryFailed" -> "Delivery failed". */
export function humanize(s: string): string {
	if (!s) return s;
	// Send-binding error codes: "E_RECIPIENT_SUPPRESSED" -> "Recipient suppressed".
	if (/^E_[A-Z0-9_]+$/.test(s)) s = s.slice(2);
	const spaced = s
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.trim()
		.toLowerCase();
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Bare address from `"Name" <addr>` or `addr`. */
export function bareAddress(from: string): string {
	const m = from.match(/<([^>]+)>/);
	return (m ? m[1] : from).trim().toLowerCase();
}

/**
 * Where a per-message row links to. There is no single-message URL in the
 * mail workspace, so this opens the mailbox's search for the subject in Sent,
 * which lands on the message (and its thread) in one click.
 */
export function messageSearchHref(mailbox: string, subject: string): string {
	const clean = subject.replace(/"/g, "").trim();
	const q = clean ? `in:sent subject:"${clean}"` : "in:sent";
	return `/mail/${encodeURIComponent(mailbox)}/search?q=${encodeURIComponent(q)}`;
}

/** Whether a URL is safe to render as a clickable link: http or https only. */
export function isWebUrl(url: string): boolean {
	try {
		const { protocol } = new URL(url);
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

/** Shorten a URL for a table cell: host + path, without the scheme. */
export function shortUrl(url: string): string {
	try {
		const u = new URL(url);
		const path = u.pathname === "/" ? "" : u.pathname;
		return `${u.host}${path}${u.search ? "?…" : ""}`;
	} catch {
		return url;
	}
}

/** Bar heights for a stacked column, in pixels, with a 2px gap between segments. */
export function stackSegments(
	values: number[],
	max: number,
	height: number,
	gap = 2,
): number[] {
	if (max <= 0) return values.map(() => 0);
	const present = values.filter((v) => v > 0).length;
	const total = values.reduce((a, b) => a + Math.max(0, b), 0);
	const gaps = Math.max(0, present - 1) * gap;
	const available = Math.max(0, (total / max) * height - gaps);
	// Every non-zero segment gets at least 3px so a single bounce stays visible.
	return values.map((v) => (v > 0 ? Math.max(3, (v / total) * available) : 0));
}

/**
 * Merge consecutive days into larger buckets when there are more days than
 * the plot has room for (90 days on a 390px phone), summing every numeric
 * field. Each bucket keeps its first and last day for labels.
 */
export function bucketSeries<T extends { date: string }>(
	rows: T[],
	maxBuckets: number,
): { start: string; end: string; values: T }[] {
	const size = Math.max(1, Math.ceil(rows.length / Math.max(1, Math.floor(maxBuckets))));
	const out: { start: string; end: string; values: T }[] = [];
	for (let i = 0; i < rows.length; i += size) {
		const chunk = rows.slice(i, i + size);
		const merged = { ...chunk[0] } as Record<string, unknown>;
		for (const row of chunk.slice(1)) {
			for (const [k, v] of Object.entries(row)) {
				if (typeof v === "number") merged[k] = ((merged[k] as number) ?? 0) + v;
			}
		}
		out.push({ start: chunk[0].date, end: chunk[chunk.length - 1].date, values: merged as T });
	}
	return out;
}

/** "Oct 26" or "Oct 20 – Oct 26" for a bucket. */
export function formatSpan(start: string, end: string): string {
	return start === end ? formatDay(start) : `${formatDay(start)} – ${formatDay(end)}`;
}

export interface RoutingRuleLike {
	matcher: string;
	action: string;
	destination: string | null;
	enabled: boolean;
}

/**
 * What happens to mail for an address that has no mailbox in this app.
 *
 * - A literal rule sends it to this Worker: the Worker finds no mailbox and
 *   drops it, so the mail is lost ("dropped").
 * - A literal rule forwards it elsewhere: fine, it isn't meant for the app.
 * - No literal rule: the catch-all decides; usually a forward to a personal
 *   inbox (tech@ → forward@example.net), which is easy to miss.
 *
 * Returns null when the address has a mailbox or the mail goes somewhere on
 * purpose (a literal forward).
 */
export function unownedAddressRoute(
	address: string,
	hasMailbox: boolean,
	rules: RoutingRuleLike[],
): { kind: "dropped" | "catch_all" | "unrouted"; destination: string | null } | null {
	if (hasMailbox) return null;
	const a = address.trim().toLowerCase();
	const enabled = rules.filter((r) => r.enabled);
	const literal = enabled.find((r) => r.matcher.trim().toLowerCase() === a);
	if (literal) {
		if (literal.action === "worker") return { kind: "dropped", destination: literal.destination };
		return null;
	}
	const catchAll = enabled.find((r) => isCatchAllMatcher(r.matcher));
	if (catchAll) {
		if (catchAll.action === "worker") return { kind: "dropped", destination: catchAll.destination };
		if (catchAll.action === "drop") return { kind: "unrouted", destination: null };
		return { kind: "catch_all", destination: catchAll.destination };
	}
	return { kind: "unrouted", destination: null };
}

export function isCatchAllMatcher(matcher: string): boolean {
	const m = matcher.trim().toLowerCase();
	return m === "*" || m === "all" || m === "catch-all" || m === "catch_all" || m.startsWith("*@");
}

/** A one-sentence summary of a series, for a chart's accessible name. */
export function seriesSummary(
	label: string,
	points: { date: string; value: number }[],
): string {
	if (points.length === 0) return `${label}: no data.`;
	const total = points.reduce((a, p) => a + p.value, 0);
	let peak = points[0];
	for (const p of points) if (p.value > peak.value) peak = p;
	const span =
		points.length === 1
			? formatDay(points[0].date)
			: `${formatDay(points[0].date)} to ${formatDay(points[points.length - 1].date)}`;
	if (total === 0) return `${label}: none from ${span}.`;
	return `${label}: ${formatCount(total)} from ${span}, peaking at ${formatCount(peak.value)} on ${formatDay(peak.date)}.`;
}

/** "1 message", "2 messages", "1,284 opens". `many` defaults to `one` + "s". */
export function plural(n: number, one: string, many: string = `${one}s`): string {
	return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** "3 of 14 delivered": the numerator and denominator behind a rate. */
export function ofTotal(n: number, d: number, suffix = ""): string {
	return `${formatCount(n)} of ${formatCount(d)}${suffix ? ` ${suffix}` : ""}`;
}

/**
 * The denominator behind the engagement open and click rates: delivered
 * messages. Uses `totals.delivered_messages` when the Worker sends it (an
 * optional, additive field), otherwise recovers it from count / rate.
 */
export function engagementBase(t: {
	unique_opens: number;
	unique_clicks: number;
	open_rate: number | null;
	click_rate: number | null;
	delivered_messages?: number | null;
}): number | null {
	if (typeof t.delivered_messages === "number" && t.delivered_messages > 0) return t.delivered_messages;
	if (t.open_rate && t.unique_opens > 0) return Math.round(t.unique_opens / t.open_rate);
	if (t.click_rate && t.unique_clicks > 0) return Math.round(t.unique_clicks / t.click_rate);
	return null;
}

export type AuthSegmentKind = "pass" | "none" | "fail";

/**
 * An SPF/DKIM/DMARC verdict histogram split three ways, for a segmented bar.
 *
 * - pass: the check passed.
 * - none: nothing to evaluate (no SPF record, no DKIM signature, no DMARC
 *   policy). Common and not a failure, so it is left out of the headline rate.
 * - fail: every other verdict (fail, softfail, permerror, temperror, neutral,
 *   policy…), so no message silently disappears from the bar.
 *
 * `passRate` is pass / (pass + fail), the share of mail that was evaluated and
 * passed; `evaluated` is that denominator.
 */
export function authSegments(rec: Record<string, number> | null | undefined): {
	total: number;
	evaluated: number;
	passRate: number | null;
	segments: { kind: AuthSegmentKind; count: number; verdicts: { verdict: string; count: number }[] }[];
} {
	const groups: Record<AuthSegmentKind, { verdict: string; count: number }[]> = { pass: [], none: [], fail: [] };
	for (const [verdict, count] of Object.entries(rec ?? {})) {
		if (!Number.isFinite(count) || count <= 0) continue;
		const v = verdict.toLowerCase();
		groups[v === "pass" ? "pass" : v === "none" ? "none" : "fail"].push({ verdict, count });
	}
	const sum = (k: AuthSegmentKind) => groups[k].reduce((a, g) => a + g.count, 0);
	const pass = sum("pass");
	const none = sum("none");
	const fail = sum("fail");
	return {
		total: pass + none + fail,
		evaluated: pass + fail,
		passRate: safeRate(pass, pass + fail),
		segments: (["pass", "none", "fail"] as const).map((kind) => ({
			kind,
			count: sum(kind),
			verdicts: groups[kind].sort((a, b) => b.count - a.count),
		})),
	};
}

/**
 * Whether the per-message engagement rows can explain the totals above them.
 *
 * Opens and clicks are attributed to a message only when the tracking event
 * can be tied back to it. When the rows are null, or all zero while the
 * totals say something was opened, a column of dashes beside "12 opens" reads
 * as a bug; the table drops those columns and says why instead.
 */
export function engagementAttribution(
	totals: { opens: number; clicks: number },
	messages: { opens: number | null; clicks: number | null }[],
): "ok" | "missing" {
	if (messages.length === 0) return "ok";
	if (messages.every((m) => m.opens == null && m.clicks == null)) return "missing";
	const rowOpens = messages.reduce((a, m) => a + (m.opens ?? 0), 0);
	const rowClicks = messages.reduce((a, m) => a + (m.clicks ?? 0), 0);
	if ((totals.opens > 0 && rowOpens === 0) || (totals.clicks > 0 && rowClicks === 0)) return "missing";
	return "ok";
}

/**
 * Index of today's (UTC) bucket in a day series, or -1. Today's bucket only
 * holds the hours so far, so charts mark it rather than let the short bar read
 * as a drop.
 */
export function partialDayIndex(dates: string[], now: number = Date.now()): number {
	return dates.lastIndexOf(new Date(now).toISOString().slice(0, 10));
}

/**
 * Series worth drawing: those with something in the window. An empty "Spam"
 * legend entry is noise. Keeps the first series when all are empty, so the
 * chart still has a key.
 */
export function nonEmptySeries<R, S extends { value: (r: R) => number }>(rows: R[], series: S[]): S[] {
	const kept = series.filter((s) => rows.some((r) => s.value(r) > 0));
	return kept.length ? kept : series.slice(0, 1);
}

/**
 * Whether suppression counts cover the selected period or all time.
 * Suppression lists are current state rather than events, so when the Worker
 * doesn't say (no `window` field), they are all-time.
 */
export function suppressionScope(window: unknown): "period" | "all_time" {
	if (window == null) return "all_time";
	if (typeof window === "string") return /^(all|all_time|all-time|lifetime)$/i.test(window) ? "all_time" : "period";
	if (typeof window === "object") {
		const w = window as { days?: unknown; all_time?: unknown; start?: unknown };
		if (w.all_time === true) return "all_time";
		if ((typeof w.days === "number" && w.days > 0) || typeof w.start === "string") return "period";
	}
	return "all_time";
}

export type CountUnit = "messages" | "recipients" | "addresses";

/** "messages" / "recipients" / "addresses", singular for exactly one. */
export function unitNoun(unit: CountUnit | undefined, n = 2): string {
	const u = unit ?? "messages";
	if (n !== 1) return u;
	return u === "addresses" ? "address" : u.slice(0, -1);
}

/** "18 recipients", "1 message". */
export function countWithUnit(n: number, unit: CountUnit | undefined): string {
	return `${formatCount(n)} ${unitNoun(unit, n)}`;
}

export interface RuleWithAddresses extends RoutingRuleLike {
	count?: number;
	catch_all?: boolean;
	addresses?: { address: string; count: number; has_mailbox: boolean }[];
}

export interface UnroutedAddress {
	address: string;
	/** Mail for this address that went somewhere other than its mailbox. */
	count: number;
	destination: string | null;
	via: "catch_all" | "forward";
}

/**
 * Addresses that have a mailbox in this app but no enabled routing rule that
 * hands their mail to the Worker: Cloudflare sends it to the catch-all (or a
 * literal forward) instead, so it never reaches the mailbox. Taken from the
 * per-rule `addresses` split, so `count` is the mail that went elsewhere.
 */
export function knownUnroutedAddresses(rules: RuleWithAddresses[]): UnroutedAddress[] {
	// A catch-all that hands mail to the Worker routes every address here.
	if (rules.some((r) => r.enabled && r.action === "worker" && (r.catch_all || isCatchAllMatcher(r.matcher)))) return [];
	const workerRouted = new Set(
		rules
			.filter((r) => r.enabled && r.action === "worker" && !isCatchAllMatcher(r.matcher))
			.map((r) => r.matcher.trim().toLowerCase()),
	);
	const out = new Map<string, UnroutedAddress>();
	for (const r of rules) {
		if (r.action === "worker") continue;
		const via = r.catch_all || isCatchAllMatcher(r.matcher) ? "catch_all" : "forward";
		for (const a of r.addresses ?? []) {
			const addr = a.address.trim().toLowerCase();
			if (!a.has_mailbox || workerRouted.has(addr)) continue;
			const cur = out.get(addr) ?? { address: a.address, count: 0, destination: r.destination, via };
			cur.count += a.count;
			out.set(addr, cur);
		}
	}
	return [...out.values()].sort((a, b) => b.count - a.count || a.address.localeCompare(b.address));
}

/**
 * How the catch-all's count splits: to addresses with no mailbox, and to
 * addresses that have a mailbox but no routing rule. Prefers the Worker's
 * reconciliation block, falling back to the rule's per-address split.
 */
export function catchAllBreakdown(
	rules: RuleWithAddresses[],
	reconciliation?: { count: number; known_addresses: number; unknown_addresses: number } | null,
): { total: number; unknown: number; known: number; destination: string | null } | null {
	const rule = rules.find((r) => r.catch_all || isCatchAllMatcher(r.matcher));
	if (reconciliation) {
		return {
			total: reconciliation.count,
			unknown: reconciliation.unknown_addresses,
			known: reconciliation.known_addresses,
			destination: rule?.destination ?? null,
		};
	}
	if (!rule) return null;
	const addrs = rule.addresses ?? [];
	const known = addrs.filter((a) => a.has_mailbox).reduce((n, a) => n + a.count, 0);
	const total = rule.count ?? addrs.reduce((n, a) => n + a.count, 0);
	return { total, unknown: Math.max(0, total - known), known, destination: rule.destination };
}

export interface UnownedRow {
	address: string;
	count: number;
	route: NonNullable<ReturnType<typeof unownedAddressRoute>>;
}

/**
 * Addresses with no mailbox that get mail, for the "no mailbox" banner.
 *
 * Catch-all mail is counted from the catch-all rule's own per-address split,
 * so the banner's total is exactly the catch-all's unknown-address count
 * (105 of its 106; the other is an address that has a mailbox). Summing the
 * per-address totals instead mixed in mail that matched a literal rule and
 * left out addresses that have one (manish@: 4 via its forward + 3 via the
 * catch-all), which is how the banner said 102 while the rule said 106.
 * Addresses whose mail is lost (a literal worker rule, no mailbox) or matches
 * no rule keep their full count.
 */
export function unownedRows(
	byAddress: { address: string; count: number; has_mailbox: boolean }[],
	rules: RuleWithAddresses[],
): UnownedRow[] {
	const catchAll = rules.find((r) => r.enabled && (r.catch_all || isCatchAllMatcher(r.matcher)));
	const split = catchAll?.addresses;
	const out = new Map<string, UnownedRow>();
	if (catchAll && split && catchAll.action !== "worker" && catchAll.action !== "drop") {
		for (const a of split) {
			if (a.has_mailbox || a.count <= 0) continue;
			out.set(a.address.toLowerCase(), {
				address: a.address,
				count: a.count,
				route: { kind: "catch_all", destination: catchAll.destination },
			});
		}
	}
	for (const a of byAddress) {
		const key = a.address.toLowerCase();
		if (out.has(key)) continue;
		const route = unownedAddressRoute(a.address, a.has_mailbox, rules);
		// With a per-address split, catch-all rows come from it alone (above).
		if (!route || (route.kind === "catch_all" && split)) continue;
		out.set(key, { address: a.address, count: a.count, route });
	}
	return [...out.values()].sort((a, b) => b.count - a.count || a.address.localeCompare(b.address));
}

export type EngagementSort = "activity" | "newest";

/**
 * Engagement rows in display order. "activity" (the default) puts messages
 * with clicks, then opens, first, so the one message that explains "12 opens"
 * isn't buried under ten rows of zeros; ties keep newest first.
 */
export function sortEngagementMessages<T extends { sent_at: string; opens: number; clicks: number }>(
	rows: readonly T[],
	sort: EngagementSort,
): T[] {
	const newest = (a: T, b: T) => (a.sent_at < b.sent_at ? 1 : a.sent_at > b.sent_at ? -1 : 0);
	if (sort === "newest") return [...rows].sort(newest);
	return [...rows].sort((a, b) => b.clicks - a.clicks || b.opens - a.opens || newest(a, b));
}

/**
 * What the "Rejected (failed SPF/DMARC)" routing action reconciles with:
 * routing refuses hard SPF fails only; softfail, temperror, permerror and
 * neutral pass through to the rule. `passedThrough` is those verdicts.
 */
export function rejectionBreakdown(
	spf: Record<string, number> | null | undefined,
	rejected: number,
): { rejected: number; spfFail: number; passedThrough: { verdict: string; count: number }[] } {
	const passedThrough = ["softfail", "temperror", "permerror", "neutral"]
		.map((verdict) => ({ verdict, count: spf?.[verdict] ?? 0 }))
		.filter((v) => v.count > 0);
	return { rejected, spfFail: spf?.fail ?? 0, passedThrough };
}
