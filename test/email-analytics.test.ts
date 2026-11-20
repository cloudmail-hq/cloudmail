// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The GraphQL client and the fault-attribution classifier. Network is faked so
 * these are pure and deterministic; the query shape here mirrors the one
 * verified live against the tapetide.com zone.
 */

import { describe, expect, it, vi } from "vitest";
import {
	classifyErrorCause,
	EmailAnalyticsError,
	fetchSendEvents,
} from "../workers/lib/email-analytics";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
	return {
		ok,
		status,
		statusText: ok ? "OK" : "Error",
		json: async () => body,
	} as unknown as Response;
}

const config = { apiToken: "tok", zoneTag: "zone123" };

describe("fetchSendEvents", () => {
	it("flattens the zone's event list", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				data: {
					viewer: {
						zones: [
							{
								emailSendingAdaptive: [
									{
										datetime: "2026-08-21T10:44:28Z",
										messageId: "<abc@tapetide.com>",
										from: '"Support" <support@tapetide.com>',
										to: "user@example.org",
										status: "delivered",
										eventType: "newEmailSending",
										sendingDomain: "tapetide.com",
										errorCause: "",
										errorDetail: "",
									},
								],
							},
						],
					},
				},
				errors: null,
			}),
		);

		const events = await fetchSendEvents(
			config,
			{ start: "2026-08-20T00:00:00Z", end: "2026-08-21T00:00:00Z" },
			10000,
			fetchImpl as unknown as typeof fetch,
		);

		expect(events).toHaveLength(1);
		expect(events[0].messageId).toBe("<abc@tapetide.com>");
		// The Authorization header carries the token.
		const call = fetchImpl.mock.calls[0][1] as RequestInit;
		expect((call.headers as Record<string, string>).Authorization).toBe(
			"Bearer tok",
		);
	});

	it("throws on an HTTP error rather than returning empty", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({}, false, 403));
		await expect(
			fetchSendEvents(
				config,
				{ start: "s", end: "e" },
				10,
				fetchImpl as unknown as typeof fetch,
			),
		).rejects.toBeInstanceOf(EmailAnalyticsError);
	});

	it("throws on a GraphQL errors array, so a misscoped token is not a false all-clear", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({ data: null, errors: [{ message: "not authorized" }] }),
		);
		await expect(
			fetchSendEvents(
				config,
				{ start: "s", end: "e" },
				10,
				fetchImpl as unknown as typeof fetch,
			),
		).rejects.toThrow(/not authorized/);
	});

	it("returns empty for a zone with no events, without throwing", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({ data: { viewer: { zones: [{}] } }, errors: null }),
		);
		const events = await fetchSendEvents(
			config,
			{ start: "s", end: "e" },
			10,
			fetchImpl as unknown as typeof fetch,
		);
		expect(events).toEqual([]);
	});
});

describe("classifyErrorCause — the our-bug-vs-their-mailbox split", () => {
	it("is null for a delivery", () => {
		expect(classifyErrorCause("delivered", "")).toBeNull();
	});

	it("blames us when a non-delivery has no cause", () => {
		// The send failed before the recipient's server weighed in.
		expect(classifyErrorCause("deliveryFailed", "")).toBe("internal");
	});

	it("blames us for auth/reputation causes we control", () => {
		for (const cause of ["spf", "dkim", "bad_reputation", "rate_limited"]) {
			expect(classifyErrorCause("deliveryFailed", cause)).toBe("internal");
		}
	});

	it("blames the recipient for a full or unknown mailbox", () => {
		for (const cause of ["mailbox_full", "quota_exceeded", "user_unknown"]) {
			expect(classifyErrorCause("deliveryFailed", cause)).toBe("recipient");
		}
	});

	it("defaults an unknown cause to the recipient rather than crying wolf about our code", () => {
		expect(classifyErrorCause("deliveryFailed", "some_new_bucket")).toBe(
			"recipient",
		);
	});

	it("is case-insensitive", () => {
		expect(classifyErrorCause("deliveryFailed", "MAILBOX_FULL")).toBe(
			"recipient",
		);
	});
});
