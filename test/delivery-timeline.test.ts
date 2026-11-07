// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The reading pane's delivery-timeline presentation logic: labels, fault
 * wording, the engagement tally, and the single headline state. Pure, so it is
 * tested without rendering — the component only maps these descriptors to icons.
 */

import { describe, expect, it } from "vitest";
import {
	awaitingTerminalEvent,
	buildDeliveryTimeline,
	describeFailure,
	headlineState,
	summarizeEngagement,
} from "~/lib/delivery-timeline";
import type { DeliveryEvent } from "~/types";

function ev(overrides: Partial<DeliveryEvent>): DeliveryEvent {
	return {
		id: 1,
		email_id: "m1",
		recipient: "user@example.org",
		event_type: "sent",
		source: "send",
		provider_message_id: null,
		error_cause: null,
		error_detail: null,
		metadata: null,
		occurred_at: "2026-08-21T10:00:00Z",
		created_at: "2026-08-21T10:00:00Z",
		...overrides,
	};
}

describe("describeFailure — our-bug-vs-their-mailbox in plain words", () => {
	it("says it's our side for an internal cause and appends the provider's words", () => {
		const text = describeFailure(
			ev({
				event_type: "failed",
				error_cause: "internal",
				error_detail: "550 SPF check failed",
			}),
		);
		expect(text).toContain("our side");
		expect(text).toContain("550 SPF check failed");
	});

	it("says it's the recipient's server for a recipient cause", () => {
		const text = describeFailure(
			ev({
				event_type: "bounced",
				error_cause: "recipient",
				error_detail: "552 mailbox full",
			}),
		);
		expect(text).toContain("recipient's mail server");
		expect(text).toContain("552 mailbox full");
	});

	it("is null for a non-failure", () => {
		expect(describeFailure(ev({ event_type: "delivered" }))).toBeNull();
	});

	it("falls back to just the detail when no attribution is known", () => {
		const text = describeFailure(
			ev({ event_type: "bounced", error_cause: null, error_detail: "weird" }),
		);
		expect(text).toBe("weird");
	});
});

describe("buildDeliveryTimeline", () => {
	it("keeps server order and labels each step", () => {
		const steps = buildDeliveryTimeline([
			ev({ id: 1, event_type: "sent" }),
			ev({ id: 2, event_type: "delivered" }),
			ev({ id: 3, event_type: "opened" }),
		]);
		expect(steps.map((s) => s.label)).toEqual(["Sent", "Delivered", "Opened"]);
		expect(steps.map((s) => s.tone)).toEqual([
			"pending",
			"success",
			"engagement",
		]);
	});

	it("surfaces the clicked URL from metadata", () => {
		const steps = buildDeliveryTimeline([
			ev({
				event_type: "clicked",
				metadata: JSON.stringify({ url: "https://tapetide.com/pricing" }),
			}),
		]);
		expect(steps[0].detail).toBe("https://tapetide.com/pricing");
	});

	it("passes an unknown event type through instead of dropping it", () => {
		const steps = buildDeliveryTimeline([ev({ event_type: "teleported" })]);
		expect(steps[0].label).toBe("teleported");
		expect(steps[0].tone).toBe("pending");
	});

	it("survives malformed click metadata without throwing", () => {
		const steps = buildDeliveryTimeline([
			ev({ event_type: "clicked", metadata: "{not json" }),
		]);
		expect(steps[0].detail).toBeNull();
	});
});

describe("summarizeEngagement", () => {
	it("counts opens, clicks and downloads separately", () => {
		const summary = summarizeEngagement([
			ev({ event_type: "opened" }),
			ev({ event_type: "opened" }),
			ev({ event_type: "clicked" }),
			ev({ event_type: "attachment_downloaded" }),
			ev({ event_type: "delivered" }),
		]);
		expect(summary).toEqual({ opens: 2, clicks: 1, attachmentDownloads: 1 });
	});
});

describe("headlineState", () => {
	it("is the latest terminal event", () => {
		const head = headlineState([
			ev({ id: 1, event_type: "sent", occurred_at: "2026-08-21T10:00:00Z" }),
			ev({
				id: 2,
				event_type: "delivered",
				occurred_at: "2026-08-21T10:05:00Z",
			}),
			ev({ id: 3, event_type: "opened", occurred_at: "2026-08-21T10:30:00Z" }),
		]);
		expect(head?.label).toBe("Delivered");
	});

	it("is the latest pending state when nothing terminal has happened", () => {
		const head = headlineState([
			ev({ id: 1, event_type: "queued" }),
			ev({ id: 2, event_type: "sent" }),
		]);
		expect(head?.label).toBe("Sent");
	});

	it("is null for an empty ledger, so the section can hide", () => {
		expect(headlineState([])).toBeNull();
	});
});

describe("awaitingTerminalEvent", () => {
	it("is true while a send has only pending events", () => {
		expect(
			awaitingTerminalEvent([
				ev({ id: 1, event_type: "queued" }),
				ev({ id: 2, event_type: "sent" }),
			]),
		).toBe(true);
	});

	it("is false once a terminal success arrives", () => {
		expect(
			awaitingTerminalEvent([
				ev({ id: 1, event_type: "sent" }),
				ev({ id: 2, event_type: "delivered" }),
			]),
		).toBe(false);
	});

	it("is false once a terminal failure arrives", () => {
		expect(
			awaitingTerminalEvent([
				ev({ id: 1, event_type: "sent" }),
				ev({ id: 2, event_type: "bounced", error_cause: "recipient" }),
			]),
		).toBe(false);
	});

	it("is true for an empty ledger — the send may be moments old", () => {
		expect(awaitingTerminalEvent([])).toBe(true);
	});

	it("stays true on a soft bounce, which is not yet an outcome", () => {
		expect(
			awaitingTerminalEvent([
				ev({ id: 1, event_type: "sent" }),
				ev({ id: 2, event_type: "soft_bounced" }),
			]),
		).toBe(true);
	});
});
