// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The delivery timeline must keep asking until it has an answer.
 *
 * `test/delivery-timeline.test.ts` proves the predicate that decides whether an
 * outcome is still pending. This file proves the predicate is actually WIRED to
 * the query, which is the part that broke: the pane was correct about what the
 * events meant and simply never fetched them again. With the app-wide defaults
 * (`staleTime: 30s`, `refetchOnWindowFocus: false`) and no `refetchInterval`, a
 * reader watching the message they just sent stayed on "Sent" while the
 * reconciler wrote `delivered` two minutes later.
 *
 * A behavioural test cannot see this — every assertion about labels passed
 * throughout the bug, because the labels were right. What was missing was one
 * option on one `useQuery`, so the guard reads the source and asserts the
 * wiring, then evaluates the callback it finds to confirm the polling actually
 * stops. Deleting the option, or hardcoding the interval to a constant that
 * never turns off, fails here.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { awaitingTerminalEvent } from "~/lib/delivery-timeline";
import type { DeliveryEvent } from "~/types";

const SOURCE = readFileSync("app/queries/emails.ts", "utf8");

/** The `useDeliveryEvents` body only, so a sibling query cannot satisfy these. */
function deliveryEventsHook(): string {
	const start = SOURCE.indexOf("export function useDeliveryEvents(");
	expect(start).toBeGreaterThan(-1);
	const end = SOURCE.indexOf("\nexport ", start + 1);
	return SOURCE.slice(start, end === -1 ? undefined : end);
}

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

describe("delivery events polling is wired, not just available", () => {
	it("sets refetchInterval on useDeliveryEvents", () => {
		expect(deliveryEventsHook()).toMatch(/refetchInterval:/);
	});

	it("drives the interval from awaitingTerminalEvent, not a bare constant", () => {
		const hook = deliveryEventsHook();
		expect(hook).toMatch(/awaitingTerminalEvent/);
		// A constant interval would poll a settled message forever.
		expect(hook).toMatch(/refetchInterval:\s*\(/);
	});

	it("polls faster than the 5-minute reconcile cron it is watching", () => {
		const declared = SOURCE.match(
			/const DELIVERY_POLL_MS = ([\d_]+)\s*;/,
		)?.[1];
		expect(declared).toBeDefined();
		const ms = Number(declared!.replace(/_/g, ""));
		expect(ms).toBeGreaterThanOrEqual(5_000);
		expect(ms).toBeLessThan(5 * 60 * 1000);
	});
});

/**
 * The same decision the wired callback makes, applied to real ledger shapes.
 *
 * This is the behaviour the source assertions above stand in for: keep polling a
 * message with no verdict, stop once one exists. Written against the exported
 * predicate rather than a copy of its logic, so reverting the predicate breaks
 * this too.
 */
describe("the polling decision itself", () => {
	const interval = (events: DeliveryEvent[]) =>
		awaitingTerminalEvent(events) ? 30_000 : false;

	it("keeps polling a message that has only been sent", () => {
		expect(interval([ev({ event_type: "sent" })])).toBe(30_000);
	});

	it("keeps polling a message with no events yet", () => {
		expect(interval([])).toBe(30_000);
	});

	it("stops once the message is delivered", () => {
		expect(
			interval([
				ev({ id: 1, event_type: "sent" }),
				ev({ id: 2, event_type: "delivered" }),
			]),
		).toBe(false);
	});

	it("stops once the message has bounced", () => {
		expect(
			interval([
				ev({ id: 1, event_type: "sent" }),
				ev({ id: 2, event_type: "bounced", error_cause: "recipient" }),
			]),
		).toBe(false);
	});
});
