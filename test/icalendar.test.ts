// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Reading calendar invitations.
 *
 * The fixtures are shaped like real invitations rather than like minimal test
 * input, because the failures worth catching here all come from things real
 * senders do and hand-written fixtures omit: folded lines, a `VTIMEZONE` carrying
 * its own `DTSTART`, quoted parameter values containing a colon, and escaped text.
 */

import { describe, expect, it } from "vitest";
import {
	awaitsResponse,
	describeRecurrence,
	parseCalendarEvent,
	parseCalendarTime,
	parseContentLine,
	unescapeText,
	unfoldLines,
} from "../shared/icalendar";

/** Join lines with CRLF, as an iCalendar body actually arrives. */
function ics(...lines: string[]): string {
	return lines.join("\r\n");
}

describe("unfoldLines", () => {
	it("joins a folded line, dropping only the fold whitespace", () => {
		// RFC 5545 §3.1. A SUMMARY of any length arrives folded, so a parser that
		// skips this reads every long value truncated at 75 characters.
		expect(
			unfoldLines("SUMMARY:Quarterly planning\r\n  session\r\nLOCATION:Room 4"),
		).toEqual(["SUMMARY:Quarterly planning session", "LOCATION:Room 4"]);
	});

	it("unfolds a tab continuation as well as a space", () => {
		expect(unfoldLines("SUMMARY:one\r\n\ttwo")).toEqual(["SUMMARY:onetwo"]);
	});

	it("accepts bare LF, which plenty of senders emit", () => {
		expect(unfoldLines("A:1\nB:2")).toEqual(["A:1", "B:2"]);
	});

	it("drops blank lines without treating them as continuations", () => {
		expect(unfoldLines("A:1\r\n\r\nB:2")).toEqual(["A:1", "B:2"]);
	});
});

describe("parseContentLine", () => {
	it("splits name, parameters and value", () => {
		expect(parseContentLine("DTSTART;TZID=Europe/London:20260901T090000")).toEqual({
			name: "DTSTART",
			params: { TZID: "Europe/London" },
			value: "20260901T090000",
		});
	});

	it("does not split on a colon inside a quoted parameter", () => {
		// RFC 5545 §3.2 requires quoting for values containing a colon, and this
		// exact shape appears on real DESCRIPTION properties. Taking the first colon
		// would yield a value of `part3.msg@example.com":Project XYZ`.
		expect(
			parseContentLine(
				'DESCRIPTION;ALTREP="CID:part3.msg@example.com":Project XYZ',
			),
		).toEqual({
			name: "DESCRIPTION",
			params: { ALTREP: "CID:part3.msg@example.com" },
			value: "Project XYZ",
		});
	});

	it("does not split parameters on a semicolon inside quotes", () => {
		const parsed = parseContentLine('ATTENDEE;CN="Doe; Jane":mailto:jane@example.com');
		expect(parsed?.params.CN).toBe("Doe; Jane");
		expect(parsed?.value).toBe("mailto:jane@example.com");
	});

	it("upper-cases the name and parameter keys, leaving the value alone", () => {
		const parsed = parseContentLine("summary;language=en:Keep My Case");
		expect(parsed?.name).toBe("SUMMARY");
		expect(parsed?.params).toEqual({ LANGUAGE: "en" });
		expect(parsed?.value).toBe("Keep My Case");
	});

	it("returns null for a line that is not a property", () => {
		expect(parseContentLine("no colon here")).toBeNull();
		expect(parseContentLine(":empty name")).toBeNull();
		expect(parseContentLine("")).toBeNull();
	});
});

describe("unescapeText", () => {
	it("decodes the escapes RFC 5545 defines", () => {
		expect(unescapeText("Line one\\nLine two")).toBe("Line one\nLine two");
		expect(unescapeText("\\N also means newline")).toBe("\n also means newline");
		expect(unescapeText("Comma\\, semicolon\\; done")).toBe("Comma, semicolon; done");
	});

	it("treats an escaped backslash as a literal, not as an escape character", () => {
		// The bug a chain of .replace() calls produces: `\\n` becomes a backslash
		// followed by a newline instead of a backslash followed by `n`.
		expect(unescapeText("path\\\\name")).toBe("path\\name");
		expect(unescapeText("C:\\\\next")).toBe("C:\\next");
	});

	it("keeps a trailing backslash rather than dropping a character", () => {
		expect(unescapeText("trailing\\")).toBe("trailing\\");
	});
});

describe("parseCalendarTime", () => {
	it("reads a UTC value as an exact instant", () => {
		const time = parseCalendarTime("20260901T090000Z");
		expect(time.utc).toBe(true);
		expect(time.allDay).toBe(false);
		expect(time.date?.toISOString()).toBe("2026-09-01T09:00:00.000Z");
	});

	it("reads a date-only value as all-day at local midnight", () => {
		// Constructed local, not UTC: UTC midnight renders as the previous day for
		// anyone west of Greenwich, which moves an all-day event by a day.
		const time = parseCalendarTime("20260901", { VALUE: "DATE" });
		expect(time.allDay).toBe(true);
		expect(time.date?.getHours()).toBe(0);
		expect(time.date?.getDate()).toBe(1);
		expect(time.date?.getMonth()).toBe(8);
	});

	it("infers all-day from an 8-digit value even without VALUE=DATE", () => {
		expect(parseCalendarTime("20260901").allDay).toBe(true);
	});

	it("keeps the TZID for display without pretending to apply it", () => {
		const time = parseCalendarTime("20260901T090000", { TZID: "Europe/London" });
		expect(time.tzid).toBe("Europe/London");
		expect(time.utc).toBe(false);
		// Floating: built in the reader's zone, so the wall-clock time is preserved.
		expect(time.date?.getHours()).toBe(9);
	});

	it("keeps the raw value when the form is unrecognised", () => {
		const time = parseCalendarTime("sometime next week");
		expect(time.date).toBeNull();
		expect(time.raw).toBe("sometime next week");
	});
});

// -- Whole invitations ---------------------------------------------

const INVITATION = ics(
	"BEGIN:VCALENDAR",
	"PRODID:-//Example Corp//Calendar//EN",
	"VERSION:2.0",
	"METHOD:REQUEST",
	// A VTIMEZONE with its own DTSTART. Reading that as the event's start yields
	// an event in 1601, which is the bug this fixture exists to catch.
	"BEGIN:VTIMEZONE",
	"TZID:Europe/London",
	"BEGIN:STANDARD",
	"DTSTART:16011028T020000",
	"TZOFFSETFROM:+0100",
	"TZOFFSETTO:+0000",
	"END:STANDARD",
	"END:VTIMEZONE",
	"BEGIN:VEVENT",
	"UID:abc123@example.com",
	"SEQUENCE:2",
	"DTSTART;TZID=Europe/London:20260901T090000",
	"DTEND;TZID=Europe/London:20260901T100000",
	"SUMMARY:Quarterly planning",
	"DESCRIPTION:Agenda:\\n1. Budget\\n2. Hiring",
	"LOCATION:Room 4\\, second floor",
	"ORGANIZER;CN=Ada Lovelace:mailto:ada@example.com",
	"ATTENDEE;CN=Grace Hopper;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:grace@example.com",
	"ATTENDEE;CN=Alan Turing;PARTSTAT=ACCEPTED:mailto:alan@example.com",
	"RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=6",
	"STATUS:CONFIRMED",
	// A VALARM carrying its own SUMMARY and DESCRIPTION, which RFC 5545 §3.6.6
	// permits. Without the nested-component skip these overwrite the event's, so
	// the card shows "Reminder!" as the meeting title.
	"BEGIN:VALARM",
	"TRIGGER:-PT15M",
	"ACTION:DISPLAY",
	"SUMMARY:Reminder!",
	"DESCRIPTION:Your meeting starts in 15 minutes",
	"END:VALARM",
	"END:VEVENT",
	"END:VCALENDAR",
);

describe("parseCalendarEvent", () => {
	it("reads a complete invitation", () => {
		const event = parseCalendarEvent(INVITATION);

		expect(event?.method).toBe("REQUEST");
		expect(event?.uid).toBe("abc123@example.com");
		expect(event?.sequence).toBe(2);
		expect(event?.summary).toBe("Quarterly planning");
		expect(event?.status).toBe("CONFIRMED");
		expect(event?.recurrence).toBe("FREQ=WEEKLY;INTERVAL=2;COUNT=6");
	});

	it("takes the event's DTSTART, not the VTIMEZONE's", () => {
		const event = parseCalendarEvent(INVITATION);
		expect(event?.start?.raw).toBe("20260901T090000");
		expect(event?.start?.tzid).toBe("Europe/London");
		expect(event?.start?.date?.getFullYear()).toBe(2026);
	});

	it("decodes escaped text in DESCRIPTION and LOCATION", () => {
		const event = parseCalendarEvent(INVITATION);
		expect(event?.description).toBe("Agenda:\n1. Budget\n2. Hiring");
		expect(event?.location).toBe("Room 4, second floor");
	});

	it("reads the organizer and every attendee with their status", () => {
		const event = parseCalendarEvent(INVITATION);

		expect(event?.organizer).toEqual({ email: "ada@example.com", name: "Ada Lovelace" });
		expect(event?.attendees).toEqual([
			{
				email: "grace@example.com",
				name: "Grace Hopper",
				partstat: "NEEDS-ACTION",
				role: "REQ-PARTICIPANT",
				rsvp: true,
			},
			{
				email: "alan@example.com",
				name: "Alan Turing",
				partstat: "ACCEPTED",
				rsvp: false,
			},
		]);
	});

	it("does not let a VALARM's own SUMMARY become the event's", () => {
		// RFC 5545 §3.6.6 lets a VALARM carry SUMMARY and DESCRIPTION. They belong
		// to the reminder, not the meeting, and a parser that does not track the
		// nested component reads whichever came last — so the card ends up titled
		// "Reminder!".
		const event = parseCalendarEvent(INVITATION);
		expect(event?.summary).toBe("Quarterly planning");
		expect(event?.description).toBe("Agenda:\n1. Budget\n2. Hiring");
	});

	it("ignores a VTIMEZONE's DTSTART", () => {
		// VTIMEZONE sub-components carry DTSTART values in the 1600s. Reading one as
		// the event's start dates the meeting four centuries early.
		const event = parseCalendarEvent(INVITATION);
		expect(event?.start?.raw).toBe("20260901T090000");
		expect(event?.start?.date?.getFullYear()).toBe(2026);
	});

	it("defaults a missing PARTSTAT to NEEDS-ACTION", () => {
		// RFC 5545 §3.2.12. An unanswered invitation frequently omits it.
		const event = parseCalendarEvent(
			ics(
				"BEGIN:VCALENDAR",
				"METHOD:REQUEST",
				"BEGIN:VEVENT",
				"SUMMARY:Standup",
				"DTSTART:20260901T090000Z",
				"ATTENDEE:mailto:grace@example.com",
				"END:VEVENT",
				"END:VCALENDAR",
			),
		);

		expect(event?.attendees[0]).toEqual({
			email: "grace@example.com",
			partstat: "NEEDS-ACTION",
			rsvp: false,
		});
	});

	it("reads a folded SUMMARY in full", () => {
		const event = parseCalendarEvent(
			ics(
				"BEGIN:VCALENDAR",
				"BEGIN:VEVENT",
				"DTSTART:20260901T090000Z",
				"SUMMARY:A rather long meeting title that a sender would",
				"  fold across two lines",
				"END:VEVENT",
				"END:VCALENDAR",
			),
		);

		expect(event?.summary).toBe(
			"A rather long meeting title that a sender would fold across two lines",
		);
	});

	it("reads a CANCEL", () => {
		const event = parseCalendarEvent(
			ics(
				"BEGIN:VCALENDAR",
				"METHOD:CANCEL",
				"BEGIN:VEVENT",
				"UID:abc123@example.com",
				"DTSTART:20260901T090000Z",
				"SUMMARY:Quarterly planning",
				"STATUS:CANCELLED",
				"END:VEVENT",
				"END:VCALENDAR",
			),
		);

		expect(event?.method).toBe("CANCEL");
		expect(event?.status).toBe("CANCELLED");
	});

	it("takes only the first event when a calendar holds several", () => {
		const event = parseCalendarEvent(
			ics(
				"BEGIN:VCALENDAR",
				"BEGIN:VEVENT",
				"DTSTART:20260901T090000Z",
				"SUMMARY:First",
				"END:VEVENT",
				"BEGIN:VEVENT",
				"DTSTART:20261001T090000Z",
				"SUMMARY:Second",
				"END:VEVENT",
				"END:VCALENDAR",
			),
		);

		expect(event?.summary).toBe("First");
	});

	it("returns null when there is no event to show", () => {
		expect(parseCalendarEvent("")).toBeNull();
		expect(parseCalendarEvent("not a calendar at all")).toBeNull();
		// A calendar carrying only a VTODO renders nothing here.
		expect(
			parseCalendarEvent(
				ics(
					"BEGIN:VCALENDAR",
					"BEGIN:VTODO",
					"SUMMARY:Buy milk",
					"DTSTART:20260901T090000Z",
					"END:VTODO",
					"END:VCALENDAR",
				),
			),
		).toBeNull();
		// An event with neither a title nor a start is not worth a card.
		expect(
			parseCalendarEvent(
				ics("BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:x", "END:VEVENT", "END:VCALENDAR"),
			),
		).toBeNull();
	});

	it("does not throw on truncated or malformed input", () => {
		// A calendar part is written by whoever sent the mail. An invitation that
		// fails to render must not take the message down with it.
		expect(() =>
			parseCalendarEvent("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:2026"),
		).not.toThrow();
		expect(() => parseCalendarEvent("BEGIN:VCALENDAR\r\n\u0000\u0001")).not.toThrow();
	});
});

describe("awaitsResponse", () => {
	it("is true for a REQUEST this address has not answered", () => {
		expect(awaitsResponse(parseCalendarEvent(INVITATION)!, "grace@example.com")).toBe(
			true,
		);
	});

	it("is case-insensitive about the address", () => {
		expect(awaitsResponse(parseCalendarEvent(INVITATION)!, "GRACE@Example.com")).toBe(
			true,
		);
	});

	it("is false once this address has replied maybe", () => {
		// RFC 5545 §3.2.12 lists TENTATIVE alongside ACCEPTED and DECLINED as a
		// participation status. Someone who said "maybe" has replied, and telling
		// them otherwise teaches people to ignore the badge.
		const tentative = parseCalendarEvent(
			ics(
				"BEGIN:VCALENDAR",
				"METHOD:REQUEST",
				"BEGIN:VEVENT",
				"DTSTART:20260901T090000Z",
				"SUMMARY:Standup",
				"ATTENDEE;PARTSTAT=TENTATIVE:mailto:grace@example.com",
				"END:VEVENT",
				"END:VCALENDAR",
			),
		)!;
		expect(awaitsResponse(tentative, "grace@example.com")).toBe(false);
	});

	it("is false once this address has declined", () => {
		const declined = parseCalendarEvent(
			ics(
				"BEGIN:VCALENDAR",
				"METHOD:REQUEST",
				"BEGIN:VEVENT",
				"DTSTART:20260901T090000Z",
				"SUMMARY:Standup",
				"ATTENDEE;PARTSTAT=DECLINED:mailto:grace@example.com",
				"END:VEVENT",
				"END:VCALENDAR",
			),
		)!;
		expect(awaitsResponse(declined, "grace@example.com")).toBe(false);
	});

	it("is false once this address has accepted", () => {
		expect(awaitsResponse(parseCalendarEvent(INVITATION)!, "alan@example.com")).toBe(
			false,
		);
	});

	it("is false for somebody else's invitation", () => {
		// Forwarded or Bcc'd: the reader is not an attendee, so there is nothing for
		// them to answer.
		expect(awaitsResponse(parseCalendarEvent(INVITATION)!, "nobody@example.com")).toBe(
			false,
		);
	});

	it("is false for a cancellation and for a plain PUBLISH", () => {
		const cancelled = parseCalendarEvent(
			ics(
				"BEGIN:VCALENDAR",
				"METHOD:REQUEST",
				"BEGIN:VEVENT",
				"DTSTART:20260901T090000Z",
				"SUMMARY:Off",
				"STATUS:CANCELLED",
				"ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:grace@example.com",
				"END:VEVENT",
				"END:VCALENDAR",
			),
		)!;
		expect(awaitsResponse(cancelled, "grace@example.com")).toBe(false);

		const published = parseCalendarEvent(
			ics(
				"BEGIN:VCALENDAR",
				"METHOD:PUBLISH",
				"BEGIN:VEVENT",
				"DTSTART:20260901T090000Z",
				"SUMMARY:Webinar",
				"ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:grace@example.com",
				"END:VEVENT",
				"END:VCALENDAR",
			),
		)!;
		expect(awaitsResponse(published, "grace@example.com")).toBe(false);
	});

	it("is false with no address to check", () => {
		expect(awaitsResponse(parseCalendarEvent(INVITATION)!, null)).toBe(false);
	});
});

describe("describeRecurrence", () => {
	it("describes the shapes that appear on invitations", () => {
		expect(describeRecurrence("FREQ=WEEKLY")).toBe("Every week");
		expect(describeRecurrence("FREQ=DAILY;INTERVAL=3")).toBe("Every 3 days");
		expect(describeRecurrence("FREQ=WEEKLY;INTERVAL=2;COUNT=6")).toBe(
			"Every 2 weeks, 6 times",
		);
		expect(describeRecurrence("FREQ=MONTHLY;UNTIL=20261201T000000Z")).toMatch(
			/^Every month, until /,
		);
	});

	it("says nothing rather than guessing", () => {
		expect(describeRecurrence(undefined)).toBeNull();
		expect(describeRecurrence("")).toBeNull();
		// No FREQ: not a rule this can summarise.
		expect(describeRecurrence("COUNT=4")).toBeNull();
		expect(describeRecurrence("FREQ=SECONDLY")).toBeNull();
	});

	it("refuses rules whose selectors it would misstate", () => {
		// "Every month" for a rule that fires on the 1st and the 15th is not a
		// vaguer truth, it is a false one — it hides half the occurrences. Showing no
		// recurrence line is honest; a confident wrong summary gets someone to the
		// wrong meeting.
		expect(describeRecurrence("FREQ=MONTHLY;BYMONTHDAY=1,15")).toBeNull();
		expect(describeRecurrence("FREQ=MONTHLY;BYDAY=-1FR")).toBeNull();
		expect(describeRecurrence("FREQ=MONTHLY;BYDAY=TU;BYSETPOS=3")).toBeNull();
		expect(describeRecurrence("FREQ=YEARLY;BYMONTH=3")).toBeNull();
		expect(describeRecurrence("FREQ=WEEKLY;BYDAY=MO,WE,FR")).toBeNull();
	});

	it("still summarises the plain rules, including with WKST", () => {
		// WKST does not change which occurrences happen for these shapes, so it is
		// not grounds for refusing.
		expect(describeRecurrence("FREQ=WEEKLY;WKST=MO")).toBe("Every week");
		expect(describeRecurrence("FREQ=WEEKLY;INTERVAL=2;WKST=SU;COUNT=4")).toBe(
			"Every 2 weeks, 4 times",
		);
	});
});
