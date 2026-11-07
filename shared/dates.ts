// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Consolidated date formatting utilities.
 *
 * Previously spread across `app/lib/utils.ts` (4 functions) and
 * `workers/lib/html.ts` (`formatEmailDate`). Now one canonical set
 * imported by both the frontend and backend.
 */

/** Parse safely — returns null on invalid dates instead of NaN-date. */
function safeParse(dateStr: string | undefined | null): Date | null {
	if (!dateStr) return null;
	try {
		const d = new Date(dateStr);
		return isNaN(d.getTime()) ? null : d;
	} catch {
		return null;
	}
}

/**
 * Email list rows.
 * - Today: "3:42 PM"
 * - This year: "Apr 15"
 * - Older: "Apr 15, 2024"
 */
export function formatListDate(dateStr: string): string {
	const date = safeParse(dateStr);
	if (!date) return dateStr;

	const now = new Date();
	if (date.toDateString() === now.toDateString()) {
		return date.toLocaleTimeString(undefined, {
			hour: "numeric",
			minute: "2-digit",
		});
	}
	if (date.getFullYear() === now.getFullYear()) {
		return date.toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
		});
	}
	return date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

/**
 * Email detail header.
 * "Tue, Apr 15, 3:42 PM"
 */
export function formatDetailDate(dateStr: string): string {
	const date = safeParse(dateStr);
	if (!date) return dateStr;

	return date.toLocaleDateString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

/**
 * Thread message headers — time only.
 * "3:42 PM"
 */
export function formatShortDate(dateStr: string): string {
	const date = safeParse(dateStr);
	if (!date) return dateStr;

	return date.toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
	});
}

/**
 * Compose quoted replies & backend quoted blocks.
 * "Tue, Apr 15, 2026, 3:42 PM"
 *
 * Uses explicit "en-US" locale for deterministic output on both browser
 * and Cloudflare Workers (which support `toLocaleString`).
 */
export function formatQuotedDate(dateStr: string | undefined): string {
	if (!dateStr) return "";
	const date = safeParse(dateStr);
	if (!date) return dateStr;

	return date.toLocaleString("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	});
}

/**
 * Earliest plausible timestamp for an email (SMTP predates this, but no
 * message we can legitimately receive should claim to be older).
 */
const MIN_PLAUSIBLE_EPOCH_MS = Date.UTC(1990, 0, 1);

/** How far into the future a sender's clock may drift before we distrust it. */
const MAX_FUTURE_SKEW_MS = 48 * 60 * 60 * 1000;

/**
 * Resolve the authoritative timestamp for a received message.
 *
 * The `Date` header reflects when the sender composed the message, which is
 * what every mail client displays. Falling back to receive time (as this app
 * previously did unconditionally) reorders conversations whenever delivery is
 * delayed — a message sent Monday but forwarded to us Wednesday appeared as
 * Wednesday, breaking thread chronology.
 *
 * The header is attacker-controlled, so implausible values are rejected:
 * unparseable dates, anything before 1990, and anything more than 48 hours in
 * the future (a common spam trick to pin messages to the top of the inbox).
 *
 * @param headerDate  Raw `Date` header value, if any.
 * @param receivedAt  Fallback — when we actually took delivery.
 * @returns ISO 8601 timestamp string.
 */
export function resolveMessageDate(
	headerDate: string | Date | undefined | null,
	receivedAt: Date = new Date(),
): string {
	const parsed =
		headerDate instanceof Date
			? isNaN(headerDate.getTime())
				? null
				: headerDate
			: safeParse(headerDate);

	if (!parsed) return receivedAt.toISOString();

	const ms = parsed.getTime();
	if (ms < MIN_PLAUSIBLE_EPOCH_MS) return receivedAt.toISOString();
	if (ms > receivedAt.getTime() + MAX_FUTURE_SKEW_MS) {
		return receivedAt.toISOString();
	}

	return parsed.toISOString();
}

// ── Snooze presets ─────────────────────────────────────────────────

/** Hour of the morning that "tomorrow" and later presets resolve to. */
const MORNING_HOUR = 9;

/** How far ahead "later today" pushes a message. */
const LATER_TODAY_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Past this hour, "later today" is no longer a meaningful option.
 *
 * It also keeps the offset inside the current day: the latest qualifying moment
 * is 19:59, which plus three hours is still tonight.
 */
const LATEST_TODAY_HOUR = 20;

export interface SnoozePreset {
	id: "later_today" | "tomorrow" | "this_weekend" | "next_week";
	label: string;
	/** Absolute moment the message should return. */
	at: Date;
}

function atHour(base: Date, dayOffset: number, hour: number): Date {
	const d = new Date(base);
	d.setDate(d.getDate() + dayOffset);
	d.setHours(hour, 0, 0, 0);
	return d;
}

/** Days until the next occurrence of `weekday` (0 = Sunday), never 0. */
function daysUntil(from: Date, weekday: number): number {
	const diff = (weekday - from.getDay() + 7) % 7;
	return diff === 0 ? 7 : diff;
}

/**
 * The snooze options offered in the UI, resolved against `now`.
 *
 * Options that no longer make sense are omitted rather than shown pointing
 * backwards: "later today" disappears in the late evening, and "this weekend"
 * disappears once it is the weekend. Everything is computed in local time
 * because the user is picking a wall-clock moment, then sent to the API as an
 * absolute ISO instant.
 */
export function snoozePresets(now: Date = new Date()): SnoozePreset[] {
	const presets: SnoozePreset[] = [];

	if (now.getHours() < LATEST_TODAY_HOUR) {
		presets.push({
			id: "later_today",
			label: "Later today",
			at: new Date(now.getTime() + LATER_TODAY_OFFSET_MS),
		});
	}

	presets.push({ id: "tomorrow", label: "Tomorrow", at: atHour(now, 1, MORNING_HOUR) });

	const day = now.getDay();
	const isWeekend = day === 0 || day === 6;
	if (!isWeekend) {
		presets.push({
			id: "this_weekend",
			label: "This weekend",
			at: atHour(now, daysUntil(now, 6), MORNING_HOUR),
		});
	}

	presets.push({
		id: "next_week",
		label: "Next week",
		at: atHour(now, daysUntil(now, 1), MORNING_HOUR),
	});

	return presets;
}

/**
 * When a follow-up reminder is due, phrased for a badge: "Due Tue, 9:00 AM",
 * or "Due soon" once the time has passed but the alarm has not yet fired.
 */
export function formatDueLabel(
	isoTime: string | null | undefined,
	now: Date = new Date(),
): string {
	const date = safeParse(isoTime);
	// Past six days a bare weekday is ambiguous (next Mon reads as earlier than
	// this Tue), so the date is spelled out.
	if (date && date.getTime() - now.getTime() > 6 * 24 * 60 * 60 * 1000) {
		return `Due ${date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`;
	}
	return formatSnoozeReturn(isoTime, now).replace(/^Returns/, "Due").replace(/^Snoozed$/, "Due");
}

/**
 * When a snoozed message comes back, phrased for a badge.
 * "Returns Tue, 9:00 AM" — or "Returns soon" once the deadline has passed but
 * the alarm has not yet fired.
 */
export function formatSnoozeReturn(
	untilIso: string | null | undefined,
	now: Date = new Date(),
): string {
	const date = safeParse(untilIso);
	if (!date) return "Snoozed";
	if (date.getTime() <= now.getTime()) return "Returns soon";

	const sameDay = date.toDateString() === now.toDateString();
	const time = date.toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
	});
	if (sameDay) return `Returns ${time}`;

	const weekday = date.toLocaleDateString(undefined, { weekday: "short" });
	return `Returns ${weekday}, ${time}`;
}
