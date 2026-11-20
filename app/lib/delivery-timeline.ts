// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Turn the raw delivery-event ledger into what the reading pane draws.
 *
 * Kept out of the component and pure so the label/attribution rules can be
 * tested without rendering. The component maps the returned descriptors to
 * icons and colours; everything about *what a row means* lives here.
 */

import type { DeliveryEvent } from "~/types";

export type TimelineTone = "pending" | "success" | "engagement" | "failure";

export interface TimelineStep {
	key: string;
	/** Short label shown on the row, e.g. "Delivered" or "Opened". */
	label: string;
	/** One-line human description; the reason for a failure, the URL for a click. */
	detail: string | null;
	tone: TimelineTone;
	/** ISO timestamp the event occurred, for the row's time. */
	at: string;
	/** Recipient the event is about, when it is recipient-specific. */
	recipient: string | null;
}

const LABELS: Record<string, string> = {
	queued: "Queued",
	sent: "Sent",
	delivered: "Delivered",
	soft_bounced: "Temporary delivery issue",
	bounced: "Bounced",
	rejected: "Rejected",
	failed: "Couldn't be sent",
	complained: "Marked as spam",
	provider_status: "Provider status",
	opened: "Opened",
	clicked: "Clicked a link",
	attachment_downloaded: "Downloaded an attachment",
};

const TONES: Record<string, TimelineTone> = {
	queued: "pending",
	sent: "pending",
	delivered: "success",
	soft_bounced: "pending",
	bounced: "failure",
	rejected: "failure",
	failed: "failure",
	complained: "failure",
	provider_status: "pending",
	opened: "engagement",
	clicked: "engagement",
	attachment_downloaded: "engagement",
};

/**
 * The human sentence for why a failure happened, folding in the coarse fault
 * attribution the reconciler assigned.
 *
 * This is the operator's actual question — our bug or their mailbox — surfaced
 * in plain words. `internal` means the send failed on our side (config, auth,
 * reputation) and is worth an engineer's attention; `recipient` means the far
 * side refused it (mailbox full, address unknown) and there is nothing in our
 * code to fix. The provider's own words (`error_detail`) are appended verbatim
 * because they are the only text that says exactly what to do next.
 */
export function describeFailure(event: DeliveryEvent): string | null {
	if (TONES[event.event_type] !== "failure") return null;

	const attribution =
		event.error_cause === "internal"
			? "A problem on our side stopped this from being delivered."
			: event.error_cause === "recipient"
				? "The recipient's mail server refused it (for example a full or unknown mailbox)."
				: null;

	const detail = event.error_detail?.trim() || null;

	if (attribution && detail) return `${attribution} ${detail}`;
	return attribution ?? detail;
}

/** The clicked URL out of a `clicked` event's metadata, when present. */
function clickedUrl(event: DeliveryEvent): string | null {
	if (event.event_type !== "clicked" || !event.metadata) return null;
	try {
		const parsed = JSON.parse(event.metadata) as { url?: unknown };
		return typeof parsed.url === "string" ? parsed.url : null;
	} catch {
		return null;
	}
}

/**
 * Build the ordered timeline the pane renders from the raw ledger.
 *
 * Events arrive oldest-first from the server; that order is kept. Each becomes
 * one step with a label, tone, and a detail line appropriate to its kind — the
 * failure reason for a failure, the clicked URL for a click, otherwise nothing.
 * An unrecognised event type is passed through with its raw name rather than
 * dropped, so a new server-side event kind still shows up instead of silently
 * vanishing.
 */
export function buildDeliveryTimeline(
	events: readonly DeliveryEvent[],
): TimelineStep[] {
	return events.map((event) => {
		const tone = TONES[event.event_type] ?? "pending";
		const label = LABELS[event.event_type] ?? event.event_type;

		let detail: string | null = null;
		if (tone === "failure") {
			detail = describeFailure(event);
		} else if (event.event_type === "clicked") {
			detail = clickedUrl(event);
		} else if (event.event_type === "provider_status") {
			// The raw provider status the reconciler did not recognise.
			detail = event.error_detail?.trim() || null;
		}

		return {
			key: `${event.id}`,
			label,
			detail,
			tone,
			at: event.occurred_at,
			recipient: event.recipient,
		};
	});
}

/**
 * A one-line summary of engagement for the pane's header chips: how many opens
 * and clicks a message has seen. Zero counts are omitted by the caller; this
 * only tallies.
 */
export function summarizeEngagement(events: readonly DeliveryEvent[]): {
	opens: number;
	clicks: number;
	attachmentDownloads: number;
} {
	let opens = 0;
	let clicks = 0;
	let attachmentDownloads = 0;
	for (const event of events) {
		if (event.event_type === "opened") opens += 1;
		else if (event.event_type === "clicked") clicks += 1;
		else if (event.event_type === "attachment_downloaded")
			attachmentDownloads += 1;
	}
	return { opens, clicks, attachmentDownloads };
}

/**
 * The single headline the pane shows above the timeline: the newest meaningful
 * state, so a message reads as "Delivered" or "Bounced" at a glance without
 * expanding the full list.
 *
 * Prefers the latest terminal lifecycle event; failing that, the latest
 * lifecycle event at all; and if only engagement exists (which cannot happen
 * without a prior delivery, but is handled defensively) reports delivered.
 * Returns null for an empty ledger so the caller can hide the section entirely.
 */
export function headlineState(
	events: readonly DeliveryEvent[],
): TimelineStep | null {
	if (events.length === 0) return null;
	const steps = buildDeliveryTimeline(events);

	const terminalTones: TimelineTone[] = ["success", "failure"];
	for (let i = steps.length - 1; i >= 0; i -= 1) {
		if (terminalTones.includes(steps[i].tone)) return steps[i];
	}
	// No terminal event yet: the latest lifecycle step (queued/sent) is the state.
	for (let i = steps.length - 1; i >= 0; i -= 1) {
		if (steps[i].tone === "pending") return steps[i];
	}
	return steps[steps.length - 1];
}

/**
 * Whether this message's story is still unfinished — no delivered/bounced verdict
 * has arrived yet.
 *
 * Cloudflare's analytics dataset is the only source of delivery truth here, and a
 * cron polls it every five minutes, so a fresh send legitimately reads "Sent" for
 * a while. The pane used that as its excuse for never advancing: the reader sat on
 * an open message, the reconciler wrote `delivered` two minutes later, and nothing
 * ever asked again. This predicate is what tells the query to keep asking, and —
 * just as importantly — to STOP once the answer can no longer change.
 *
 * A soft bounce counts as unfinished, because it is a retry in progress rather
 * than an outcome. An empty ledger counts as unfinished too: a send moments old
 * has not had its first event written yet, and treating "nothing" as "settled"
 * would strand exactly the message the reader is watching.
 */
export function awaitingTerminalEvent(
	events: readonly DeliveryEvent[],
): boolean {
	return !events.some((event) => {
		const tone = TONES[event.event_type];
		return tone === "success" || tone === "failure";
	});
}
