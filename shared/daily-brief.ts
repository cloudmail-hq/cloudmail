// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The daily brief: scheduling and assembly, with no I/O.
 *
 * ## Time zones
 *
 * A brief is due at a *local* wall-clock time ("07:00 in Europe/Berlin"), so
 * the next run is computed from the zone's calendar, not by adding 24 hours: a
 * DST day is 23 or 25 hours long, and adding a day of milliseconds would drift
 * the brief to 06:00 or 08:00 twice a year. `zonedTimeToUtc` resolves a wall
 * time to an instant with `Intl` only (Workers ship full ICU).
 *
 * - A wall time that does not exist (spring-forward gap) runs at the first
 *   instant after the gap, e.g. 02:30 → 03:30 local.
 * - A wall time that happens twice (fall-back overlap) runs at the first one.
 *
 * "New since yesterday" covers the window from the previous scheduled run to
 * this one, so on a DST day it is honestly 23 or 25 hours long.
 */

export const BRIEF_VERSION = 1;
/** Rows per section per mailbox, so a brief stays readable. */
export const BRIEF_SECTION_LIMIT = 8;
/** Sent mail older than this is not "waiting on others" any more. */
export const WAITING_WINDOW_DAYS = 14;
/** Sent mail younger than this is not waiting yet: give people a day. */
export const WAITING_GRACE_HOURS = 24;

// ── Time-zone arithmetic ───────────────────────────────────────────

interface WallTime {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
	let f = formatters.get(timeZone);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		formatters.set(timeZone, f);
	}
	return f;
}

/** The wall-clock reading of `instant` in `timeZone`. */
export function wallTimeIn(instant: number, timeZone: string): WallTime & { second: number } {
	const parts: Record<string, number> = {};
	for (const p of formatterFor(timeZone).formatToParts(new Date(instant))) {
		if (p.type !== "literal") parts[p.type] = Number(p.value);
	}
	return {
		year: parts.year!,
		month: parts.month!,
		day: parts.day!,
		hour: parts.hour === 24 ? 0 : parts.hour!,
		minute: parts.minute!,
		second: parts.second ?? 0,
	};
}

/** Offset of `timeZone` from UTC at `instant`, in ms (positive east of Greenwich). */
export function zoneOffsetMs(instant: number, timeZone: string): number {
	const w = wallTimeIn(instant, timeZone);
	const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
	return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant at which `timeZone` reads `wall`. See the module comment for how
 * gaps and overlaps resolve.
 */
export function zonedTimeToUtc(wall: WallTime, timeZone: string): number {
	const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
	// Offsets either side of the target; at most two distinct values near a transition.
	const before = zoneOffsetMs(naive - 36 * 3_600_000, timeZone);
	const after = zoneOffsetMs(naive + 36 * 3_600_000, timeZone);
	const candidates = [...new Set([before, after, zoneOffsetMs(naive, timeZone)])]
		.map((off) => naive - off)
		.filter((t) => {
			const w = wallTimeIn(t, timeZone);
			return w.year === wall.year && w.month === wall.month && w.day === wall.day && w.hour === wall.hour && w.minute === wall.minute;
		})
		.sort((a, b) => a - b);
	if (candidates.length > 0) return candidates[0]!;
	// Nonexistent wall time (spring-forward gap): interpreting it with the
	// pre-transition offset lands exactly as far past the gap as it was into it.
	return naive - before;
}

function parseHHMM(time: string): { hour: number; minute: number } {
	const m = /^(\d{2}):(\d{2})$/.exec(time);
	return m ? { hour: Number(m[1]), minute: Number(m[2]) } : { hour: 7, minute: 0 };
}

/** Calendar arithmetic on a local date, independent of any zone. */
function addDays(date: { year: number; month: number; day: number }, days: number) {
	const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
	return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Scheduled run on the local date `offsetDays` from today's in `timeZone`. */
function occurrence(now: number, time: string, timeZone: string, offsetDays: number): number {
	const today = wallTimeIn(now, timeZone);
	const date = addDays(today, offsetDays);
	return zonedTimeToUtc({ ...date, ...parseHHMM(time) }, timeZone);
}

/** The next run strictly after `now`. */
export function nextBriefAt(now: number, time: string, timeZone: string): number {
	const todayRun = occurrence(now, time, timeZone, 0);
	return todayRun > now ? todayRun : occurrence(now, time, timeZone, 1);
}

/** The most recent run at or before `now`. */
export function previousBriefAt(now: number, time: string, timeZone: string): number {
	const todayRun = occurrence(now, time, timeZone, 0);
	return todayRun <= now ? todayRun : occurrence(now, time, timeZone, -1);
}

/**
 * The "since yesterday" window ending at the run at/before `now`: from the run
 * one local day earlier. 23 or 25 hours across a DST change.
 */
export function briefWindow(now: number, time: string, timeZone: string): { since: number; until: number } {
	const until = previousBriefAt(now, time, timeZone);
	const local = wallTimeIn(until, timeZone);
	const since = zonedTimeToUtc({ ...addDays(local, -1), ...parseHHMM(time) }, timeZone);
	return { since, until };
}

/** "Monday 26 October", in the reader's zone. */
export function briefDateLabel(instant: number, timeZone: string): string {
	return new Intl.DateTimeFormat("en-GB", {
		timeZone,
		weekday: "long",
		day: "numeric",
		month: "long",
	}).format(new Date(instant));
}

// ── Inputs from each mailbox ───────────────────────────────────────

export interface BriefMessageRow {
	id: string;
	thread_id: string | null;
	subject: string | null;
	sender: string | null;
	sender_name: string | null;
	date: string;
	read: boolean;
	starred: boolean;
	priority: string | null;
	/** Known automated/bulk mail (List-Id, Precedence, noreply…). */
	bulk: boolean;
	summary_line: string | null;
}

export interface BriefThreadRow {
	id: string;
	thread_id: string | null;
	subject: string | null;
	/** Counterparty: the sender for needs-reply, the recipient for waiting. */
	who: string | null;
	who_name: string | null;
	date: string;
	summary_line: string | null;
}

export type WaitingSource = "followups" | "derived" | "mixed";

/** What one MailboxDO returns for a brief. */
export interface MailboxBriefData {
	mailbox: string;
	newMessages: BriefMessageRow[];
	/** True when `newMessages` was cut at the DO's row cap. */
	newTruncated: boolean;
	needsReply: BriefThreadRow[];
	waitingOn: BriefThreadRow[];
	/** Where `waitingOn` came from: follow-up reminders, derived from Sent, or both. */
	waitingSource: WaitingSource;
}

// ── Output ─────────────────────────────────────────────────────────

export type Importance = "important" | "people" | "updates";

export const IMPORTANCE_LABELS: Record<Importance, string> = {
	important: "Important",
	people: "From people",
	updates: "Updates and notifications",
};

export interface BriefItem {
	id: string;
	thread_id: string | null;
	subject: string;
	who: string | null;
	who_name: string | null;
	date: string;
	summary_line: string | null;
	unread?: boolean;
}

export interface BriefSender {
	address: string;
	name: string | null;
	count: number;
}

export interface MailboxBrief {
	mailbox: string;
	/** New conversations in the window. */
	newCount: number;
	/** New messages in the window (a conversation may have several). */
	newMessageCount: number;
	/** New conversations per group; the lists below are capped, these are not. */
	newCounts: Record<Importance, number>;
	newTruncated: boolean;
	newByImportance: Record<Importance, BriefItem[]>;
	needsReply: BriefItem[];
	needsReplyCount: number;
	waitingOn: BriefItem[];
	waitingOnCount: number;
	waitingSource: WaitingSource;
	topSenders: BriefSender[];
}

export interface DailyBrief {
	id: string;
	v: number;
	generatedAt: string;
	timeZone: string;
	/** Window covered by "new since yesterday". */
	since: string;
	until: string;
	dateLabel: string;
	mailboxes: MailboxBrief[];
	totals: { new: number; needsReply: number; waitingOn: number };
}

export function importanceOf(row: Pick<BriefMessageRow, "priority" | "starred" | "bulk">): Importance {
	if (row.priority === "high" || row.starred) return "important";
	if (row.bulk) return "updates";
	return "people";
}

function itemFromMessage(row: BriefMessageRow): BriefItem {
	return {
		id: row.id,
		thread_id: row.thread_id,
		subject: row.subject?.trim() || "(no subject)",
		who: row.sender,
		who_name: row.sender_name,
		date: row.date,
		summary_line: row.summary_line,
		unread: !row.read,
	};
}

function itemFromThread(row: BriefThreadRow): BriefItem {
	return {
		id: row.id,
		thread_id: row.thread_id,
		subject: row.subject?.trim() || "(no subject)",
		who: row.who,
		who_name: row.who_name,
		date: row.date,
		summary_line: row.summary_line,
	};
}

const byDateDesc = (a: { date: string }, b: { date: string }) => Date.parse(b.date) - Date.parse(a.date);

export function buildMailboxBrief(data: MailboxBriefData, limit = BRIEF_SECTION_LIMIT): MailboxBrief {
	const groups: Record<Importance, BriefItem[]> = { important: [], people: [], updates: [] };
	const senders = new Map<string, BriefSender>();
	// One row per conversation (its newest message, at the highest importance
	// any of its new messages had), so a busy thread does not fill the card.
	const seen = new Map<string, { item: BriefItem; importance: Importance }>();
	const rank: Record<Importance, number> = { important: 0, people: 1, updates: 2 };
	for (const row of [...data.newMessages].sort(byDateDesc)) {
		const key = row.thread_id ?? row.id;
		const imp = importanceOf(row);
		const prior = seen.get(key);
		if (!prior) seen.set(key, { item: itemFromMessage(row), importance: imp });
		else {
			if (rank[imp] < rank[prior.importance]) prior.importance = imp;
			if (!row.read) prior.item.unread = true;
		}
		const address = (row.sender ?? "").toLowerCase();
		if (!address) continue;
		const s = senders.get(address) ?? { address, name: row.sender_name ?? null, count: 0 };
		s.count++;
		if (!s.name && row.sender_name) s.name = row.sender_name;
		senders.set(address, s);
	}
	for (const { item, importance } of seen.values()) {
		const g = groups[importance];
		if (g.length < limit) g.push(item);
	}
	const topSenders = [...senders.values()]
		.sort((a, b) => b.count - a.count || a.address.localeCompare(b.address))
		.slice(0, 5);
	const newCounts: Record<Importance, number> = { important: 0, people: 0, updates: 0 };
	for (const { importance } of seen.values()) newCounts[importance]++;
	return {
		mailbox: data.mailbox,
		// Conversations, not messages: what a reader counts in their inbox.
		newCount: seen.size,
		newMessageCount: data.newMessages.length,
		newCounts,
		newTruncated: data.newTruncated,
		newByImportance: groups,
		needsReply: [...data.needsReply].sort(byDateDesc).slice(0, limit).map(itemFromThread),
		needsReplyCount: data.needsReply.length,
		waitingOn: [...data.waitingOn].sort(byDateDesc).slice(0, limit).map(itemFromThread),
		waitingOnCount: data.waitingOn.length,
		waitingSource: data.waitingSource,
		topSenders,
	};
}

/**
 * The window a brief covers. Scheduled: the local day ending at the run.
 * On demand (`throughNow`): from the start of that same day to now, so a
 * brief built at 14:00 includes this morning's mail.
 */
export function briefRange(
	now: number,
	time: string,
	timeZone: string,
	throughNow = false,
): { since: number; until: number } {
	const w = briefWindow(now, time, timeZone);
	return throughNow ? { since: w.since, until: now } : w;
}

export function buildDailyBrief(input: {
	data: MailboxBriefData[];
	now: number;
	time: string;
	timeZone: string;
	id?: string;
	throughNow?: boolean;
}): DailyBrief {
	const { since, until } = briefRange(input.now, input.time, input.timeZone, input.throughNow);
	const mailboxes = input.data.map((d) => buildMailboxBrief(d));
	return {
		id: input.id ?? `brief_${until}`,
		v: BRIEF_VERSION,
		generatedAt: new Date(input.now).toISOString(),
		timeZone: input.timeZone,
		since: new Date(since).toISOString(),
		until: new Date(until).toISOString(),
		dateLabel: briefDateLabel(until, input.timeZone),
		mailboxes,
		totals: {
			new: mailboxes.reduce((n, m) => n + m.newCount, 0),
			needsReply: mailboxes.reduce((n, m) => n + m.needsReplyCount, 0),
			waitingOn: mailboxes.reduce((n, m) => n + m.waitingOnCount, 0),
		},
	};
}

/** Recompute totals after narrowing `mailboxes` (e.g. to a token's reach). */
export function narrowBrief(brief: DailyBrief, keep: (mailbox: string) => boolean): DailyBrief {
	const mailboxes = brief.mailboxes.filter((m) => keep(m.mailbox));
	return {
		...brief,
		mailboxes,
		totals: {
			new: mailboxes.reduce((n, m) => n + m.newCount, 0),
			needsReply: mailboxes.reduce((n, m) => n + m.needsReplyCount, 0),
			waitingOn: mailboxes.reduce((n, m) => n + m.waitingOnCount, 0),
		},
	};
}

// ── Email rendering ────────────────────────────────────────────────

function esc(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function whoLabel(item: Pick<BriefItem, "who" | "who_name">): string {
	return item.who_name || item.who || "unknown";
}

/**
 * The brief as an email to the user. Every interpolated value is escaped:
 * subjects, names and summaries all come from other people's mail.
 */
export function renderBriefEmail(brief: DailyBrief, appUrl: string | null): { subject: string; text: string; html: string } {
	const subject = `Your brief for ${brief.dateLabel}: ${brief.totals.new} new, ${brief.totals.needsReply} to reply`;
	const text: string[] = [`Daily brief, ${brief.dateLabel}`, ""];
	const html: string[] = [
		`<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;color:#111;max-width:640px">`,
		`<h1 style="font-size:18px;margin:0 0 12px">Daily brief, ${esc(brief.dateLabel)}</h1>`,
	];
	const line = (item: BriefItem) => {
		const extra = item.summary_line ? ` — ${item.summary_line}` : "";
		text.push(`  - ${whoLabel(item)}: ${item.subject}${extra}`);
		html.push(
			`<li style="margin:2px 0"><strong>${esc(whoLabel(item))}</strong>: ${esc(item.subject)}${
				item.summary_line ? `<br><span style="color:#555">${esc(item.summary_line)}</span>` : ""
			}</li>`,
		);
	};
	const section = (title: string, items: BriefItem[], total: number) => {
		if (items.length === 0) return;
		text.push(`${title} (${total})`);
		html.push(`<h3 style="font-size:14px;margin:12px 0 4px">${esc(title)} (${total})</h3><ul style="margin:0;padding-left:18px">`);
		items.forEach(line);
		html.push(`</ul>`);
		text.push("");
	};

	for (const m of brief.mailboxes) {
		text.push(`== ${m.mailbox} ==`);
		html.push(`<h2 style="font-size:15px;margin:18px 0 4px;border-bottom:1px solid #ddd">${esc(m.mailbox)}</h2>`);
		if (m.newCount === 0 && m.needsReplyCount === 0 && m.waitingOnCount === 0) {
			text.push("Nothing new.", "");
			html.push(`<p style="color:#555">Nothing new.</p>`);
			continue;
		}
		for (const imp of ["important", "people", "updates"] as Importance[]) {
			section(`New: ${IMPORTANCE_LABELS[imp]}`, m.newByImportance[imp], m.newCounts[imp]);
		}
		section("Needs your reply", m.needsReply, m.needsReplyCount);
		section("Waiting on others", m.waitingOn, m.waitingOnCount);
		if (m.topSenders.length > 0) {
			const top = m.topSenders.map((s) => `${s.name || s.address} (${s.count})`).join(", ");
			text.push(`Top senders: ${top}`, "");
			html.push(`<p style="color:#555">Top senders: ${esc(top)}</p>`);
		}
	}
	if (appUrl) {
		text.push(`Open your inbox: ${appUrl}`);
		html.push(`<p><a href="${esc(appUrl)}">Open your inbox</a></p>`);
	}
	html.push(`<p style="color:#888;font-size:12px">You get this because the daily brief email is on in Settings → AI assistant. Summaries are generated by AI and may be wrong.</p></div>`);
	return { subject, text: text.join("\n"), html: html.join("") };
}
