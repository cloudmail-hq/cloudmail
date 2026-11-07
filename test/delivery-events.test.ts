// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Pure logic of the delivery-event vocabulary: the status-collapse rule and the
 * provider-status mapping. The SQL side (dedupe, recompute against a real
 * database) lives in `delivery-events-sql.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
	DELIVERY_EVENT_TYPES,
	isDeliveryEventType,
	isEngagementEvent,
	isLifecycleEvent,
	latestTerminalStatus,
	lifecycleFromProviderStatus,
} from "../shared/delivery-events";

describe("latestTerminalStatus", () => {
	it("is null when nothing terminal has happened", () => {
		expect(
			latestTerminalStatus([
				{ event_type: "queued", occurred_at: "2026-08-21T10:00:00Z" },
				{ event_type: "sent", occurred_at: "2026-08-21T10:00:01Z" },
			]),
		).toBeNull();
	});

	it("ignores a soft bounce that later delivered", () => {
		// The whole point of the ledger: a retried delivery is delivered, not a
		// bounce, even though the bounce event still exists.
		expect(
			latestTerminalStatus([
				{ event_type: "sent", occurred_at: "2026-08-21T10:00:00Z" },
				{ event_type: "soft_bounced", occurred_at: "2026-08-21T10:05:00Z" },
				{ event_type: "delivered", occurred_at: "2026-08-21T10:12:00Z" },
			]),
		).toBe("delivered");
	});

	it("takes the latest terminal event, so a late complaint wins over delivery", () => {
		expect(
			latestTerminalStatus([
				{ event_type: "delivered", occurred_at: "2026-08-21T10:00:00Z" },
				{ event_type: "complained", occurred_at: "2026-08-23T09:00:00Z" },
			]),
		).toBe("failed");
	});

	it("promotes to delivered when a re-send succeeds after an earlier failure", () => {
		expect(
			latestTerminalStatus([
				{ event_type: "failed", occurred_at: "2026-08-21T10:00:00Z" },
				{ event_type: "delivered", occurred_at: "2026-08-21T11:00:00Z" },
			]),
		).toBe("delivered");
	});

	it("breaks an equal-timestamp tie toward failure, deterministically", () => {
		// Batched per-recipient verdicts really do share a timestamp, and callers
		// read the ledger without an ORDER BY — so without an explicit tie-break
		// the answer depends on row order. Both orderings must agree, and claiming
		// delivery for a message that also bounced is the more harmful error.
		const at = "2026-08-21T10:00:00Z";
		expect(
			latestTerminalStatus([
				{ event_type: "delivered", occurred_at: at },
				{ event_type: "bounced", occurred_at: at },
			]),
		).toBe("failed");
		expect(
			latestTerminalStatus([
				{ event_type: "bounced", occurred_at: at },
				{ event_type: "delivered", occurred_at: at },
			]),
		).toBe("failed");
	});

	it("collapses every failure kind to the single 'failed' the UI understands", () => {
		for (const kind of ["bounced", "rejected", "failed"]) {
			expect(
				latestTerminalStatus([
					{ event_type: kind, occurred_at: "2026-08-21T10:00:00Z" },
				]),
			).toBe("failed");
		}
	});

	it("ignores engagement events entirely", () => {
		// An open does not make an un-delivered message delivered.
		expect(
			latestTerminalStatus([
				{ event_type: "sent", occurred_at: "2026-08-21T10:00:00Z" },
				{ event_type: "opened", occurred_at: "2026-08-21T10:30:00Z" },
			]),
		).toBeNull();
	});
});

describe("event-type classification", () => {
	it("splits lifecycle from engagement without overlap", () => {
		expect(isLifecycleEvent("delivered")).toBe(true);
		expect(isLifecycleEvent("opened")).toBe(false);
		expect(isEngagementEvent("opened")).toBe(true);
		expect(isEngagementEvent("delivered")).toBe(false);
	});

	it("rejects an unknown type", () => {
		expect(isDeliveryEventType("teleported")).toBe(false);
	});

	it("every declared type classifies as exactly one family", () => {
		for (const type of DELIVERY_EVENT_TYPES) {
			expect(isLifecycleEvent(type) !== isEngagementEvent(type)).toBe(true);
		}
	});
});

describe("lifecycleFromProviderStatus", () => {
	it("maps the two statuses the CF datasets actually return", () => {
		// Confirmed live against the tapetide.com zone: delivered + deliveryFailed.
		expect(lifecycleFromProviderStatus("delivered")).toBe("delivered");
		expect(lifecycleFromProviderStatus("deliveryFailed")).toBe("bounced");
	});

	it("keeps an unrecognised status as provider_status instead of dropping it", () => {
		expect(lifecycleFromProviderStatus("somethingNew")).toBe("provider_status");
		expect(lifecycleFromProviderStatus("")).toBeNull();
	});

	it("maps deferred and failed defensively", () => {
		expect(lifecycleFromProviderStatus("deferred")).toBe("soft_bounced");
		expect(lifecycleFromProviderStatus("failed")).toBe("failed");
		expect(lifecycleFromProviderStatus("rejected")).toBe("rejected");
	});

	it("never lets provider_status change the derived status", () => {
		expect(latestTerminalStatus([{ event_type: "provider_status", occurred_at: "2026-10-26T00:00:00Z" }])).toBeNull();
		expect(
			latestTerminalStatus([
				{ event_type: "delivered", occurred_at: "2026-10-25T00:00:00Z" },
				{ event_type: "provider_status", occurred_at: "2026-10-26T00:00:00Z" },
			]),
		).toBe("delivered");
	});
});
