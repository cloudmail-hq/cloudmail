// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Reading calendar invitations out of mail.
 *
 * ## Scope, and why it is this narrow
 *
 * This reads enough of [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545.txt) to
 * *show a reader what they have been invited to*, and no more. It is not a
 * calendar: there is no store, no free/busy, no recurrence expansion, and no
 * VTIMEZONE interpretation. Those belong to a calendar product, and building a
 * bad one inside a mail client is worse than linking out to a good one.
 *
 * What it is for is the gap that makes an invitation useless in a mail client
 * that ignores it: a message whose body is often empty, whose subject is the
 * event title, and whose actual content — when, where, who else — is inside a
 * `text/calendar` part the reader cannot open without downloading a `.ics` and
 * finding something to open it with. Gmail and Outlook both render this inline
 * because a bare attachment is not usable.
 *
 * ## What it deliberately does not do
 *
 * **It does not RSVP.** Replying to an invitation means sending a `METHOD=REPLY`
 * with `PARTSTAT` set (RFC 5546 §3.2.3), which is a *send* — a different
 * capability, a different set of tests, and a different failure mode. Recognising
 * and rendering an invitation is worth having on its own, and shipping the render
 * first means the reply can be reviewed as a send rather than as parsing.
 *
 * **It does not expand recurrence.** `RRULE` is surfaced verbatim as a summary
 * string, because "every week until December" is useful to read and a wrong
 * expansion is worse than none. There is no correct way to expand a rule without
 * the timezone rules the message may not carry.
 *
 * ## Parsing posture
 *
 * Every function here tolerates malformed input and returns something rather than
 * throwing. This runs against mail, which is adversarial and also merely sloppy:
 * a calendar part is written by whoever sent it, and an invitation that fails to
 * render must degrade to "here is a .ics attachment" rather than take the message
 * down with it.
 */

/** Scheduling method, from the `METHOD` property (RFC 5546 §1.4). */
export type CalendarMethod =
	| "REQUEST"
	| "REPLY"
	| "CANCEL"
	| "PUBLISH"
	| "ADD"
	| "REFRESH"
	| "COUNTER"
	| "DECLINECOUNTER";

const KNOWN_METHODS: readonly CalendarMethod[] = [
	"REQUEST",
	"REPLY",
	"CANCEL",
	"PUBLISH",
	"ADD",
	"REFRESH",
	"COUNTER",
	"DECLINECOUNTER",
];

/**
 * Participation status, from an attendee's `PARTSTAT` parameter.
 *
 * `NEEDS-ACTION` is the default when the parameter is absent (RFC 5545 §3.2.12),
 * which is what an invitation nobody has answered looks like.
 */
export type ParticipationStatus =
	| "NEEDS-ACTION"
	| "ACCEPTED"
	| "DECLINED"
	| "TENTATIVE"
	| "DELEGATED";

export interface CalendarAttendee {
	/** Bare address, lowercased. Empty when the value was not a `mailto:`. */
	email: string;
	/** `CN` parameter, if the sender supplied one. */
	name?: string;
	partstat: ParticipationStatus;
	/** `ROLE=CHAIR`, or `RSVP=TRUE` meaning the organizer wants an answer. */
	role?: string;
	rsvp: boolean;
}

/** One parsed timestamp, keeping what the original said about its zone. */
export interface CalendarTime {
	/** The instant, when it could be resolved. */
	date: Date | null;
	/**
	 * True for a `VALUE=DATE` property — an all-day event.
	 *
	 * Kept because an all-day event must not be rendered with a time: RFC 5545
	 * gives it a date only, and showing "00:00" invents precision the sender did
	 * not send and shifts the day across timezones.
	 */
	allDay: boolean;
	/** `TZID` parameter verbatim, for display. Not interpreted. */
	tzid?: string;
	/** True when the value carried a `Z` suffix, so `date` is exact. */
	utc: boolean;
	/** The unparsed value, so a form this does not understand still shows. */
	raw: string;
}

export interface CalendarEvent {
	method: CalendarMethod | null;
	uid?: string;
	/** `SEQUENCE`, which increments when an organizer revises an event. */
	sequence?: number;
	summary?: string;
	description?: string;
	location?: string;
	start?: CalendarTime;
	end?: CalendarTime;
	organizer?: { email: string; name?: string };
	attendees: CalendarAttendee[];
	/** `RRULE` verbatim. Not expanded — see the module comment. */
	recurrence?: string;
	/** `STATUS`, e.g. `CONFIRMED` or `CANCELLED`. */
	status?: string;
}

// -- Content lines --------------------------------------------------

/**
 * Split an iCalendar body into unfolded content lines.
 *
 * RFC 5545 §3.1: lines SHOULD NOT exceed 75 octets and are folded by inserting
 * CRLF followed by a single space or tab, which is removed on reading. Folding is
 * not optional to handle — a `DESCRIPTION` or `SUMMARY` of any length arrives
 * folded, so a parser that skips this reads every long value truncated at 75
 * characters.
 *
 * Accepts bare LF as well as CRLF, because plenty of senders emit it.
 */
export function unfoldLines(text: string): string[] {
	const out: string[] = [];

	for (const line of text.split(/\r\n|\n|\r/)) {
		// A continuation begins with one linear whitespace character, which is the
		// fold marker and not part of the value.
		if (/^[ \t]/.test(line) && out.length > 0) {
			out[out.length - 1] += line.slice(1);
			continue;
		}
		out.push(line);
	}

	return out.filter((line) => line.trim() !== "");
}

export interface ContentLine {
	/** Property name, upper-cased. */
	name: string;
	/** Parameters, keys upper-cased, values with quotes stripped. */
	params: Record<string, string>;
	value: string;
}

/**
 * Parse one content line into name, parameters and value.
 *
 * `name *(";" param ) ":" value` — but the colon that ends the name-and-params
 * section cannot be found by taking the first colon, because a quoted parameter
 * value may legally contain one (RFC 5545 §3.2: values containing COLON,
 * SEMICOLON or COMMA MUST be quoted). So this walks the line tracking whether it
 * is inside a quoted string. `ALTREP="CID:part3.msg@example.com"` is the case
 * that breaks a naive split, and it appears on real `DESCRIPTION` properties.
 */
export function parseContentLine(line: string): ContentLine | null {
	let inQuotes = false;
	let colon = -1;

	for (let i = 0; i < line.length; i += 1) {
		const char = line[i];
		if (char === '"') {
			inQuotes = !inQuotes;
			continue;
		}
		if (char === ":" && !inQuotes) {
			colon = i;
			break;
		}
	}

	if (colon <= 0) return null;

	const head = line.slice(0, colon);
	const value = line.slice(colon + 1);

	// Same quote-awareness for the parameter separators.
	const segments: string[] = [];
	let current = "";
	inQuotes = false;
	for (const char of head) {
		if (char === '"') {
			inQuotes = !inQuotes;
			continue;
		}
		if (char === ";" && !inQuotes) {
			segments.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	segments.push(current);

	const name = (segments.shift() ?? "").trim().toUpperCase();
	if (!name) return null;

	const params: Record<string, string> = {};
	for (const segment of segments) {
		const equals = segment.indexOf("=");
		if (equals <= 0) continue;
		params[segment.slice(0, equals).trim().toUpperCase()] = segment
			.slice(equals + 1)
			.trim();
	}

	return { name, params, value };
}

/**
 * Undo TEXT escaping (RFC 5545 §3.3.11).
 *
 * `\n` and `\N` both mean a newline; comma, semicolon and backslash are escaped
 * with a backslash. Done in one pass so an escaped backslash followed by an `n`
 * (`\\n`) yields a literal backslash and an `n`, rather than a backslash and a
 * newline — the bug a chain of `.replace()` calls produces.
 */
export function unescapeText(value: string): string {
	let out = "";

	for (let i = 0; i < value.length; i += 1) {
		if (value[i] !== "\\") {
			out += value[i];
			continue;
		}

		const next = value[i + 1];
		if (next === undefined) {
			// Trailing backslash: keep it rather than dropping a character.
			out += "\\";
			break;
		}
		if (next === "n" || next === "N") out += "\n";
		else out += next;
		i += 1;
	}

	return out;
}

// -- Values ---------------------------------------------------------

/**
 * Parse a DATE or DATE-TIME value (RFC 5545 §3.3.4, §3.3.5).
 *
 * Three DATE-TIME forms exist and they are not interchangeable:
 * `19980118T230000` is floating local time, `19980119T070000Z` is UTC, and a
 * `TZID` parameter names a zone defined in a `VTIMEZONE` this does not read.
 *
 * Floating and TZID forms are constructed as local time in the *reader's* zone,
 * which is right for a floating value and an approximation for a TZID one. The
 * `tzid` is kept so the UI can print the zone alongside the time rather than
 * silently presenting a shifted instant as exact.
 */
export function parseCalendarTime(
	value: string,
	params: Record<string, string> = {},
): CalendarTime {
	const raw = value.trim();
	const allDay = params.VALUE?.toUpperCase() === "DATE" || /^\d{8}$/.test(raw);
	const tzid = params.TZID;

	const dateOnly = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
	if (dateOnly) {
		const [, y, m, d] = dateOnly;
		// Constructed as local midnight: an all-day event is a date, and UTC
		// midnight renders as the previous day for anyone west of Greenwich.
		const date = new Date(Number(y), Number(m) - 1, Number(d));
		return {
			date: Number.isNaN(date.getTime()) ? null : date,
			allDay: true,
			...(tzid ? { tzid } : {}),
			utc: false,
			raw,
		};
	}

	const dateTime = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
	if (dateTime) {
		const [, y, m, d, hh, mm, ss, zulu] = dateTime;
		const date = zulu
			? new Date(
					Date.UTC(
						Number(y),
						Number(m) - 1,
						Number(d),
						Number(hh),
						Number(mm),
						Number(ss),
					),
				)
			: new Date(
					Number(y),
					Number(m) - 1,
					Number(d),
					Number(hh),
					Number(mm),
					Number(ss),
				);

		return {
			date: Number.isNaN(date.getTime()) ? null : date,
			allDay: false,
			...(tzid ? { tzid } : {}),
			utc: !!zulu,
			raw,
		};
	}

	// Unrecognised. `raw` survives so the UI can show what the sender sent.
	return { date: null, allDay, ...(tzid ? { tzid } : {}), utc: false, raw };
}

/** Strip a `mailto:` prefix and lowercase, for a CAL-ADDRESS value. */
function calendarAddress(value: string): string {
	const trimmed = value.trim();
	const withoutScheme = /^mailto:/i.test(trimmed) ? trimmed.slice(7) : trimmed;
	// A CAL-ADDRESS need not be an email at all, so anything without an `@` is
	// reported as no address rather than as a malformed one.
	return withoutScheme.includes("@") ? withoutScheme.toLowerCase() : "";
}

function participationStatus(value: string | undefined): ParticipationStatus {
	switch (value?.toUpperCase()) {
		case "ACCEPTED":
			return "ACCEPTED";
		case "DECLINED":
			return "DECLINED";
		case "TENTATIVE":
			return "TENTATIVE";
		case "DELEGATED":
			return "DELEGATED";
		default:
			// RFC 5545 §3.2.12 makes NEEDS-ACTION the default.
			return "NEEDS-ACTION";
	}
}

// -- The event ------------------------------------------------------

/**
 * Parse the first `VEVENT` out of an iCalendar object.
 *
 * Returns null when there is no event to show — not an iCalendar body, or one
 * carrying only `VTODO`/`VFREEBUSY`/`VTIMEZONE`, which this does not render.
 *
 * Only the first event is read. A `.ics` may hold many (a whole calendar
 * export), but an *invitation* carries one, plus its recurrence overrides. Taking
 * the first is right for the invitation case and honest about the rest: the
 * attachment is still there to download.
 *
 * Nested components are tracked and skipped. The case that bites is a `VALARM`
 * inside the event: RFC 5545 §3.6.6 lets it carry its own `SUMMARY` and
 * `DESCRIPTION`, so without this a reminder's text overwrites the meeting's and
 * the invitation renders titled "Reminder!".
 *
 * Sibling components — `VTIMEZONE`, whose sub-components hold `DTSTART` values in
 * the 1600s — are additionally skipped by name. Belt-and-braces: the `!inEvent`
 * guard below already ignores every property outside the event. Kept because the
 * guard makes that safety implicit, and one property switch reachable from two
 * different paths is how the 1601 bug gets reintroduced.
 */
export function parseCalendarEvent(text: string): CalendarEvent | null {
	if (!text || !/BEGIN:VCALENDAR/i.test(text)) return null;

	const event: CalendarEvent = { method: null, attendees: [] };
	let inEvent = false;
	/** Depth of any component we are inside but not reading. */
	let skipping: string | null = null;
	let sawEvent = false;

	for (const line of unfoldLines(text)) {
		const parsed = parseContentLine(line);
		if (!parsed) continue;

		const { name, params, value } = parsed;

		if (name === "BEGIN") {
			const component = value.trim().toUpperCase();
			if (component === "VEVENT" && !sawEvent) {
				inEvent = true;
				sawEvent = true;
			} else if (!inEvent && component !== "VCALENDAR") {
				// VTIMEZONE, VALARM, VTODO — has properties that would otherwise be
				// read as the event's.
				skipping = component;
			} else if (inEvent && component !== "VEVENT") {
				// A VALARM nested inside the event we are reading.
				skipping = component;
			}
			continue;
		}

		if (name === "END") {
			const component = value.trim().toUpperCase();
			if (skipping === component) skipping = null;
			else if (component === "VEVENT") inEvent = false;
			continue;
		}

		if (skipping) continue;

		// METHOD sits on the VCALENDAR, outside the event.
		if (name === "METHOD" && !inEvent) {
			const method = value.trim().toUpperCase() as CalendarMethod;
			if (KNOWN_METHODS.includes(method)) event.method = method;
			continue;
		}

		if (!inEvent) continue;

		switch (name) {
			case "UID":
				event.uid = value.trim();
				break;
			case "SEQUENCE": {
				const sequence = Number.parseInt(value.trim(), 10);
				if (!Number.isNaN(sequence)) event.sequence = sequence;
				break;
			}
			case "SUMMARY":
				event.summary = unescapeText(value).trim();
				break;
			case "DESCRIPTION":
				event.description = unescapeText(value).trim();
				break;
			case "LOCATION":
				event.location = unescapeText(value).trim();
				break;
			case "STATUS":
				event.status = value.trim().toUpperCase();
				break;
			case "RRULE":
				event.recurrence = value.trim();
				break;
			case "DTSTART":
				event.start = parseCalendarTime(value, params);
				break;
			case "DTEND":
				event.end = parseCalendarTime(value, params);
				break;
			case "ORGANIZER": {
				const email = calendarAddress(value);
				const name_ = params.CN ? unescapeText(params.CN).trim() : undefined;
				if (email || name_) {
					event.organizer = { email, ...(name_ ? { name: name_ } : {}) };
				}
				break;
			}
			case "ATTENDEE": {
				const email = calendarAddress(value);
				const name_ = params.CN ? unescapeText(params.CN).trim() : undefined;
				event.attendees.push({
					email,
					...(name_ ? { name: name_ } : {}),
					partstat: participationStatus(params.PARTSTAT),
					...(params.ROLE ? { role: params.ROLE.toUpperCase() } : {}),
					rsvp: params.RSVP?.toUpperCase() === "TRUE",
				});
				break;
			}
			default:
				break;
		}
	}

	// An event with nothing to show is not worth a card. `DTSTART` is the minimum:
	// RFC 5546 requires it on a REQUEST, and without it there is no invitation.
	if (!sawEvent) return null;
	if (!event.summary && !event.start) return null;

	return event;
}

/**
 * Whether this event is an invitation awaiting an answer from `address`.
 *
 * Used to decide whether to show the invitation prominently or as a record of
 * something already settled. A `CANCEL`, or a `REQUEST` this address has already
 * accepted, is history.
 */
export function awaitsResponse(
	event: CalendarEvent,
	address: string | null | undefined,
): boolean {
	if (event.method !== "REQUEST") return false;
	if (event.status === "CANCELLED") return false;
	if (!address) return false;

	const wanted = address.toLowerCase();
	const self = event.attendees.find(
		(attendee) => attendee.email === wanted,
	);
	// Not an attendee: this is somebody else's invitation, forwarded or Bcc'd.
	if (!self) return false;

	/**
	 * `NEEDS-ACTION` only.
	 *
	 * `TENTATIVE` used to count as unanswered, which was wrong: RFC 5545 §3.2.12
	 * lists it alongside `ACCEPTED` and `DECLINED` as a participation *status*, so
	 * someone who replied "maybe" has replied. Telling them they have not is both
	 * false and the kind of nag that teaches people to ignore the badge.
	 */
	return self.partstat === "NEEDS-ACTION";
}

/**
 * A one-line human summary of an `RRULE`, or null if it says nothing useful.
 *
 * Covers the shapes that actually appear on invitations — a frequency, an
 * interval, an end. Anything more elaborate (`BYSETPOS`, `BYMONTHDAY` lists) is
 * left to the raw value rather than mistranslated: "the 3rd Tuesday unless" is
 * exactly where a summary starts lying.
 */
export function describeRecurrence(rrule: string | undefined): string | null {
	if (!rrule) return null;

	const parts: Record<string, string> = {};
	for (const pair of rrule.split(";")) {
		const equals = pair.indexOf("=");
		if (equals <= 0) continue;
		parts[pair.slice(0, equals).trim().toUpperCase()] = pair
			.slice(equals + 1)
			.trim();
	}

	/**
	 * Selectors this cannot summarise without misstating the schedule.
	 *
	 * `FREQ=MONTHLY;BYMONTHDAY=1,15` reduced to "Every month" is not a vaguer
	 * truth, it is a false one — it hides half the occurrences. `BYSETPOS`
	 * ("the last Friday"), `BYDAY`, `BYWEEKNO` and friends are the same. Returning
	 * null leaves the card showing no recurrence line at all, which is honest,
	 * where a confident wrong summary is what gets someone to the wrong meeting.
	 *
	 * `INTERVAL`, `COUNT`, `UNTIL` and `WKST` are absent from this list because the
	 * summary below either accounts for them or is unaffected by them.
	 */
	const UNSUPPORTED = [
		"BYMONTHDAY",
		"BYDAY",
		"BYMONTH",
		"BYYEARDAY",
		"BYWEEKNO",
		"BYSETPOS",
		"BYHOUR",
		"BYMINUTE",
		"BYSECOND",
	];
	if (UNSUPPORTED.some((part) => parts[part])) return null;

	const interval = Number.parseInt(parts.INTERVAL ?? "1", 10) || 1;
	const unit = (
		{
			DAILY: "day",
			WEEKLY: "week",
			MONTHLY: "month",
			YEARLY: "year",
		} as Record<string, string>
	)[parts.FREQ?.toUpperCase() ?? ""];

	if (!unit) return null;

	let out = interval === 1 ? `Every ${unit}` : `Every ${interval} ${unit}s`;

	const count = Number.parseInt(parts.COUNT ?? "", 10);
	if (!Number.isNaN(count)) {
		out += `, ${count} times`;
	} else if (parts.UNTIL) {
		const until = parseCalendarTime(parts.UNTIL);
		if (until.date) {
			out += `, until ${until.date.toLocaleDateString(undefined, {
				day: "numeric",
				month: "short",
				year: "numeric",
			})}`;
		}
	}

	return out;
}
