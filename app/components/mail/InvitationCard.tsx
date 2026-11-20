/**
 * A calendar invitation, rendered inline in the reading pane.
 *
 * ## Why this exists
 *
 * An invitation is the one kind of mail whose body is routinely empty. The event
 * — when, where, who else is coming — lives in a `text/calendar` part, so a
 * client that treats it as an ordinary attachment shows the reader a subject line
 * and a `.ics` file they have to download and find something to open. Gmail and
 * Outlook both render it inline for that reason.
 *
 * ## Where the data comes from
 *
 * The calendar part is already stored as an attachment in R2, so this fetches and
 * parses it in the browser rather than adding a column and a migration. Two
 * consequences, both wanted: invitations already sitting in the mailbox render
 * without a backfill, and the parser — which reads adversarial sender-controlled
 * text — runs in the tab rather than in the Worker.
 *
 * The cost is a request per invitation. Acceptable because it is one small blob,
 * `immutable`-cached by the attachment endpoint, and only fetched for a message
 * that actually has a calendar part.
 *
 * ## No RSVP button
 *
 * Answering means sending a `METHOD=REPLY` with `PARTSTAT` set (RFC 5546 §3.2.3),
 * which is a send: it needs the send capability, an outbound `text/calendar` part
 * and its own tests. Rendering is worth having without it, and a card that shows
 * the meeting is strictly better than an opaque attachment even while the answer
 * still has to go by hand.
 */

import { useEffect, useState } from "react";
import { CalendarX2, Clock, MapPin, Repeat, Users } from "lucide-react";
import {
	awaitsResponse,
	describeRecurrence,
	parseCalendarEvent,
	type CalendarEvent,
	type CalendarTime,
	type ParticipationStatus,
} from "shared/icalendar";
import { getAttachmentUrl } from "~/lib/utils";
import type { Attachment } from "~/types";

/**
 * The calendar part of a message, if it has one.
 *
 * Matched on the base type so a `text/calendar; method=REQUEST; charset=utf-8`
 * parameter list still matches — senders vary in what they append, and the
 * method is read from the body's own `METHOD` property rather than trusted from
 * the MIME parameter.
 *
 * Falls back to a `.ics` filename because some senders label the part
 * `application/octet-stream`, which is indistinguishable from any other binary
 * without looking at the name.
 */
export function findCalendarAttachment(
	attachments?: Attachment[],
): Attachment | undefined {
	return attachments?.find((att) => {
		const base = att.mimetype?.split(";")[0]?.trim().toLowerCase();
		if (base === "text/calendar" || base === "application/ics") return true;
		return /\.ics$/i.test(att.filename ?? "");
	});
}

/** Longest calendar part worth fetching, in bytes. */
const MAX_CALENDAR_BYTES = 512 * 1024;

const PARTSTAT_LABELS: Record<ParticipationStatus, string> = {
	"NEEDS-ACTION": "No reply yet",
	ACCEPTED: "Accepted",
	DECLINED: "Declined",
	TENTATIVE: "Maybe",
	DELEGATED: "Delegated",
};

/**
 * The calendar day before `date`, in local time.
 *
 * Calendar arithmetic, not 24 hours of milliseconds. Across a spring-forward
 * boundary a day is 23 hours, so subtracting 86,400,000 ms from local midnight
 * lands at 23:00 on the day *before* the one intended — turning an all-day event
 * on 9 March into the reversed range "9 Mar – 7 Mar". Setting the date component
 * lets the platform resolve the offset.
 */
export function previousDay(date: Date): Date {
	const out = new Date(date);
	out.setDate(out.getDate() - 1);
	return out;
}

/**
 * Render one end of the event.
 *
 * An all-day event prints as a date with no time: RFC 5545 gives it a date only,
 * and adding "00:00" invents precision the sender did not send. A value carrying
 * a `TZID` prints the zone alongside it, because this does not read `VTIMEZONE`
 * and so cannot claim the instant is exact — naming the zone is the honest
 * version of that.
 */
function formatEventTime(start: CalendarTime, end?: CalendarTime): string {
	if (!start.date) return start.raw;

	const dateFormat: Intl.DateTimeFormatOptions = {
		weekday: "short",
		day: "numeric",
		month: "short",
		year: "numeric",
	};

	if (start.allDay) {
		const from = start.date.toLocaleDateString(undefined, dateFormat);
		// An all-day DTEND is exclusive (RFC 5545 §3.8.2.2), so a single-day event
		// ends on the following day and printing that verbatim reads as two days.
		if (end?.date) {
			const to = previousDay(end.date).toLocaleDateString(undefined, dateFormat);
			if (to !== from) return `${from} – ${to}`;
		}
		return `${from} (all day)`;
	}

	const timeFormat: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
	const day = start.date.toLocaleDateString(undefined, dateFormat);
	const from = start.date.toLocaleTimeString(undefined, timeFormat);
	const zone = start.tzid && !start.utc ? ` ${start.tzid}` : "";

	if (!end?.date) return `${day}, ${from}${zone}`;

	const sameDay = end.date.toDateString() === start.date.toDateString();
	const to = end.date.toLocaleTimeString(undefined, timeFormat);
	return sameDay
		? `${day}, ${from} – ${to}${zone}`
		: `${day}, ${from} – ${end.date.toLocaleDateString(undefined, dateFormat)}, ${to}${zone}`;
}

function attendeeLabel(attendee: CalendarEvent["attendees"][number]): string {
	return attendee.name || attendee.email || "Unnamed";
}

interface InvitationCardProps {
	mailboxId: string;
	emailId: string;
	attachment: Attachment;
	/** The reader's own address, to work out whether they still owe an answer. */
	mailboxEmail?: string;
}

export default function InvitationCard({
	mailboxId,
	emailId,
	attachment,
	mailboxEmail,
}: InvitationCardProps) {
	const [event, setEvent] = useState<CalendarEvent | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		// Nothing legitimate is this large, and the body is sender-controlled.
		if (attachment.size > MAX_CALENDAR_BYTES) {
			setFailed(true);
			return;
		}

		const controller = new AbortController();
		setEvent(null);
		setFailed(false);

		fetch(getAttachmentUrl(mailboxId, emailId, attachment.id, { inline: true }), {
			signal: controller.signal,
		})
			.then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
			.then((text) => {
				const parsed = parseCalendarEvent(text);
				if (parsed) setEvent(parsed);
				else setFailed(true);
			})
			.catch((e) => {
				// An aborted fetch is a re-render, not a failure.
				if ((e as Error)?.name !== "AbortError") setFailed(true);
			});

		return () => controller.abort();
	}, [mailboxId, emailId, attachment.id, attachment.size]);

	/**
	 * Nothing is rendered while loading, and nothing on failure.
	 *
	 * The attachment list below already offers the `.ics`, so a card that cannot
	 * be built costs the reader nothing — whereas a spinner or an error box would
	 * draw attention to a part of the message they may not care about. This is
	 * additive: it either explains the invitation or gets out of the way.
	 */
	if (failed || !event) return null;

	const cancelled = event.method === "CANCEL" || event.status === "CANCELLED";
	const unanswered = awaitsResponse(event, mailboxEmail);
	const recurrence = describeRecurrence(event.recurrence);
	const accepted = event.attendees.filter((a) => a.partstat === "ACCEPTED").length;

	return (
		<section
			aria-label={cancelled ? "Cancelled event" : "Calendar invitation"}
			className={
				cancelled
					? "mb-3 rounded-[8px] border border-border bg-bg-subtle px-3 py-2.5"
					: "mb-3 rounded-[8px] border border-accent/30 bg-accent/[0.04] px-3 py-2.5"
			}
		>
			<div className="flex items-start gap-2.5">
				{cancelled ? (
					<CalendarX2 size={15} className="mt-0.5 shrink-0 text-text-tertiary" aria-hidden />
				) : (
					<Clock size={15} className="mt-0.5 shrink-0 text-accent" aria-hidden />
				)}

				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
						<h3
							className={
								cancelled
									? "text-[13px] font-semibold text-text-secondary line-through"
									: "text-[13px] font-semibold text-text-primary"
							}
						>
							{event.summary || "Untitled event"}
						</h3>
						{cancelled && (
							<span className="text-xs font-medium text-text-secondary">
								Cancelled
							</span>
						)}
						{/*
						  Only when the reader is an attendee who has not answered. A
						  badge on somebody else's forwarded invitation would be asking
						  for a reply they cannot give.
						*/}
						{unanswered && !cancelled && (
							<span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
								Awaiting your reply
							</span>
						)}
					</div>

					{event.start && (
						<p className="mt-1 text-[12px] text-text-secondary">
							{formatEventTime(event.start, event.end)}
						</p>
					)}

					<dl className="mt-1.5 space-y-1 text-[11px] text-text-secondary">
						{recurrence && (
							<div className="flex items-center gap-1.5">
								<dt className="sr-only">Repeats</dt>
								<Repeat size={11} className="shrink-0 text-text-tertiary" aria-hidden />
								<dd>{recurrence}</dd>
							</div>
						)}
						{event.location && (
							<div className="flex items-start gap-1.5">
								<dt className="sr-only">Location</dt>
								<MapPin
									size={11}
									className="mt-0.5 shrink-0 text-text-tertiary"
									aria-hidden
								/>
								<dd className="min-w-0 break-words">{event.location}</dd>
							</div>
						)}
						{event.attendees.length > 0 && (
							<div className="flex items-start gap-1.5">
								<dt className="sr-only">Attendees</dt>
								<Users
									size={11}
									className="mt-0.5 shrink-0 text-text-tertiary"
									aria-hidden
								/>
								<dd className="min-w-0">
									{event.attendees.length} invited
									{accepted > 0 ? `, ${accepted} accepted` : ""}
									{event.organizer && (
										<>
											{" · organised by "}
											{event.organizer.name || event.organizer.email}
										</>
									)}
								</dd>
							</div>
						)}
					</dl>

					{/*
					  The guest list is behind a disclosure. A meeting with forty
					  attendees would otherwise push the message body off the screen,
					  and the count above is what a reader usually wants.
					*/}
					{event.attendees.length > 0 && (
						<details className="mt-1.5">
							<summary className="cursor-pointer text-[11px] font-medium text-text-tertiary hover:text-text-secondary">
								Guest list
							</summary>
							<ul className="mt-1 space-y-0.5">
								{event.attendees.map((attendee) => (
									<li
										key={attendee.email || attendeeLabel(attendee)}
										className="flex items-baseline justify-between gap-2 text-[11px]"
									>
										<span className="min-w-0 truncate text-text-secondary">
											{attendeeLabel(attendee)}
										</span>
										<span className="shrink-0 text-text-tertiary">
											{PARTSTAT_LABELS[attendee.partstat]}
										</span>
									</li>
								))}
							</ul>
						</details>
					)}
				</div>
			</div>
		</section>
	);
}
