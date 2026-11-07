// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The reconciler's grouping and per-mailbox dispatch, with fake stubs so no
 * Durable Object is needed. The DO-side `reconcileProviderEvents` (the row
 * resolution and dedupe) is covered against real sqlite in
 * `delivery-events-sql.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_LOOKBACK_MINUTES,
	providerEventToLedgerInput,
	reconcileDeliveryEvents,
	type ReconcilerMailboxStub,
} from "../workers/lib/email-reconciler";
import type { ProviderSendEvent } from "../workers/lib/email-analytics";

function event(overrides: Partial<ProviderSendEvent>): ProviderSendEvent {
	return {
		datetime: "2026-08-21T10:00:00Z",
		messageId: "<m1@tapetide.com>",
		from: '"Support" <support@tapetide.com>',
		to: "user@example.org",
		status: "delivered",
		eventType: "newEmailSending",
		sendingDomain: "tapetide.com",
		errorCause: "",
		errorDetail: "",
		...overrides,
	};
}

describe("providerEventToLedgerInput", () => {
	it("maps a delivered event, stripping brackets and carrying the timestamp", () => {
		const input = providerEventToLedgerInput(event({}));
		expect(input).not.toBeNull();
		expect(input!.type).toBe("delivered");
		expect(input!.source).toBe("graphql");
		expect(input!.providerMessageId).toBe("m1@tapetide.com");
		expect(input!.errorCause).toBeNull(); // delivery has no fault
		expect(input!.occurredAt).toBe("2026-08-21T10:00:00Z");
		expect(input!.dedupeKey).toBe("graphql:delivered:m1@tapetide.com:user@example.org");
	});

	it("maps a failure and attaches the fault bucket", () => {
		const input = providerEventToLedgerInput(
			event({ status: "deliveryFailed", errorCause: "mailbox_full" }),
		);
		expect(input!.type).toBe("bounced");
		expect(input!.errorCause).toBe("recipient");
	});

	it("skips an event with no messageId — nothing to join on", () => {
		expect(providerEventToLedgerInput(event({ messageId: "" }))).toBeNull();
	});

	it("keeps an unrecognised status as a non-terminal provider_status row", () => {
		const input = providerEventToLedgerInput(event({ status: "queuedSomewhere" }));
		expect(input).toMatchObject({
			type: "provider_status",
			errorCause: null,
			errorDetail: "status: queuedSomewhere",
			metadata: { providerStatus: "queuedSomewhere" },
			dedupeKey: "graphql:provider_status:queuedSomewhere:m1@tapetide.com:user@example.org",
		});
	});

	it("maps deferred to soft_bounced and failed to failed", () => {
		expect(providerEventToLedgerInput(event({ status: "deferred" }))?.type).toBe("soft_bounced");
		expect(providerEventToLedgerInput(event({ status: "failed", errorCause: "internal" }))?.type).toBe("failed");
	});

	it("still skips an empty status", () => {
		expect(providerEventToLedgerInput(event({ status: "" }))).toBeNull();
	});
});

describe("reconcileDeliveryEvents", () => {
	function fakeStub(): ReconcilerMailboxStub & { received: unknown[] } {
		const received: unknown[] = [];
		return {
			received,
			async reconcileProviderEvents(events) {
				received.push(events);
				// Pretend every event resolved to a row and was new.
				return { applied: events.length };
			},
		};
	}

	it("groups events by sending mailbox and dispatches to each", async () => {
		const fetchImpl = vi.fn(async () =>
			({
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					data: {
						viewer: {
							zones: [
								{
									emailSendingAdaptive: [
										event({ from: "support@tapetide.com", messageId: "<a@t>" }),
										event({ from: "hitesh@tapetide.com", messageId: "<b@t>" }),
										event({ from: "support@tapetide.com", messageId: "<c@t>" }),
									],
								},
							],
						},
					},
					errors: null,
				}),
			}) as unknown as Response,
		);

		const stubs = new Map<string, ReturnType<typeof fakeStub>>();
		const resolve = (mailboxId: string) => {
			const stub = stubs.get(mailboxId) ?? fakeStub();
			stubs.set(mailboxId, stub);
			return stub;
		};

		const result = await reconcileDeliveryEvents(
			{ apiToken: "t", zoneTag: "z" },
			resolve,
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
		);

		expect(result.fetched).toBe(3);
		expect(result.mailboxes).toBe(2);
		expect(result.applied).toBe(3);
		// support@ got two events in one call, hitesh@ got one.
		expect((stubs.get("support@tapetide.com")!.received[0] as unknown[])).toHaveLength(2);
		expect((stubs.get("hitesh@tapetide.com")!.received[0] as unknown[])).toHaveLength(1);
	});

	it("files a send from an alias in the owning mailbox", async () => {
		const fetchImpl = vi.fn(async () =>
			({
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					data: {
						viewer: {
							zones: [{ emailSendingAdaptive: [event({ from: "Support <support@producta.com>", messageId: "<a@p>" })] }],
						},
					},
					errors: null,
				}),
			}) as unknown as Response,
		);
		const seen: string[] = [];
		await reconcileDeliveryEvents(
			{ apiToken: "t", zoneTag: "z" },
			(mailboxId) => {
				seen.push(mailboxId);
				return fakeStub();
			},
			{ fetchImpl: fetchImpl as unknown as typeof fetch, aliases: { "support@producta.com": "support@tapetide.com" } },
		);
		expect(seen).toEqual(["support@tapetide.com"]);
	});

	it("splits the window when a response saturates the row limit", async () => {
		// The API returns newest-first with no offset pagination, so a saturated
		// response means the OLDEST events were silently dropped. Splitting the
		// window is the only pagination available; without it those verdicts stay
		// behind the same cap on every later tick and are lost for good.
		const LIMIT = 10000;
		let call = 0;
		const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
			call += 1;
			const body = JSON.parse((init as RequestInit).body as string) as {
				variables: { start: string; end: string };
			};
			// First call (the full window) saturates; the two halves do not.
			const saturated = call === 1;
			const rows = saturated
				? Array.from({ length: LIMIT }, (_, i) =>
						event({ messageId: `<full-${i}@t>` }),
					)
				: [event({ messageId: `<half-${body.variables.start}@t>` })];
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					data: { viewer: { zones: [{ emailSendingAdaptive: rows }] } },
					errors: null,
				}),
			} as unknown as Response;
		});

		const result = await reconcileDeliveryEvents(
			{ apiToken: "t", zoneTag: "z" },
			() => ({
				async reconcileProviderEvents(events) {
					return { applied: events.length };
				},
			}),
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
		);

		// One saturated query, then one per half.
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		// The halves' results replace the truncated page, so nothing is lost.
		expect(result.fetched).toBe(2);
	});

	it("isolates a mailbox whose stub throws, so the rest still reconcile", async () => {
		const fetchImpl = vi.fn(async () =>
			({
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					data: {
						viewer: {
							zones: [
								{
									emailSendingAdaptive: [
										event({ from: "good@tapetide.com", messageId: "<a@t>" }),
										event({ from: "bad@tapetide.com", messageId: "<b@t>" }),
									],
								},
							],
						},
					},
					errors: null,
				}),
			}) as unknown as Response,
		);

		vi.spyOn(console, "error").mockImplementation(() => {});
		const resolve = (mailboxId: string): ReconcilerMailboxStub => {
			if (mailboxId === "bad@tapetide.com") {
				return {
					async reconcileProviderEvents() {
						throw new Error("DO unreachable");
					},
				};
			}
			return {
				async reconcileProviderEvents(events) {
					return { applied: events.length };
				},
			};
		};

		const result = await reconcileDeliveryEvents(
			{ apiToken: "t", zoneTag: "z" },
			resolve,
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
		);

		expect(result.applied).toBe(1); // the good mailbox
		expect(result.failed).toBe(1); // the bad one, isolated
	});
});

describe("reconciler lookback", () => {
	it("defaults to a 7-day window so a week-long outage loses nothing", async () => {
		expect(DEFAULT_LOOKBACK_MINUTES).toBe(7 * 24 * 60);
		let variables: { start: string; end: string } | null = null;
		const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
			variables = JSON.parse((init as { body: string }).body).variables;
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({ data: { viewer: { zones: [{ emailSendingAdaptive: [] }] } }, errors: null }),
			} as unknown as Response;
		});
		await reconcileDeliveryEvents(
			{ apiToken: "t", zoneTag: "z" },
			() => ({ reconcileProviderEvents: async () => ({ applied: 0 }) }),
			{ fetchImpl: fetchImpl as unknown as typeof fetch, now: new Date("2026-10-26T06:00:00.000Z") },
		);
		expect(variables).toMatchObject({ start: "2026-10-19T06:00:00.000Z", end: "2026-10-26T06:00:00.000Z" });
	});
});
