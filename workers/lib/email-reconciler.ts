// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Reconcile Cloudflare Email Service's delivery verdicts into the local ledger.
 *
 * ## The join
 *
 * The provider's `emailSendingAdaptive` dataset is zone-wide, but every local
 * message lives in the Durable Object of the mailbox that sent it. Two facts
 * make the join possible:
 *
 *   1. `recordDelivery` stores the provider's `messageId` on the row, so a
 *      provider event's `messageId` matches a local row's `message_id`.
 *   2. A mailbox's id IS its address, and `validateSender` guarantees the
 *      outgoing `From` equals it. So a provider event's `from` address, reduced
 *      to its bare form, names the mailbox whose DO holds the row.
 *
 * So the reconciler groups the zone's events by sending mailbox, then hands each
 * mailbox's DO the verdicts for its own messages. The DO matches them by
 * `message_id` and appends idempotent ledger events — a `delivered`, a
 * `bounced`, or a `rejected`, each carrying the provider's `errorCause` bucket.
 *
 * ## Idempotency and the window
 *
 * The reconciler re-reads a rolling window every tick (the CF data has 31-day
 * retention, so a window comfortably wider than the tick interval loses
 * nothing). Re-reading means every verdict is seen many times; the ledger's
 * `dedupe_key` makes each one land exactly once. The reconciler counts only
 * genuinely-new rows so a quiet tick logs nothing.
 *
 * Never throws out of `reconcileDeliveryEvents`: it runs on the cron
 * `waitUntil` tail beside sequence dispatch, and one bad mailbox must not stop
 * the batch or bring down the tick.
 */

import {
	classifyErrorCause,
	fetchSendEvents,
	type EmailAnalyticsConfig,
	type ProviderSendEvent,
} from "./email-analytics";
import {
	lifecycleFromProviderStatus,
	type DeliveryEventInput,
} from "../../shared/delivery-events";
import { isAddressLevelProviderCause } from "../../shared/suppressions";

/** The DO surface the reconciler needs, structural for testability. */
export interface ReconcilerMailboxStub {
	reconcileProviderEvents(
		events: DeliveryEventInput[],
	): Promise<{ applied: number }>;
}

/** Resolve a mailbox id to its DO stub. Injected so tests need no namespace. */
export type MailboxStubResolver = (
	mailboxId: string,
) => ReconcilerMailboxStub;

export interface ReconcileResult {
	/** Provider events fetched in the window. */
	fetched: number;
	/** Distinct mailboxes those events touched. */
	mailboxes: number;
	/** Ledger rows genuinely written (deduped repeats excluded). */
	applied: number;
	/** Mailboxes whose reconcile call threw, isolated so the rest proceed. */
	failed: number;
	/** Distinct recipients reported to `onHardBounce`. */
	hardBounces: number;
	/** Distinct recipients reported to `onComplaint`. */
	complaints: number;
}

/** Bare lowercased address from a `Name <addr>` or plain-address string. */
function bareAddress(value: string): string | null {
	if (!value) return null;
	const angled = value.match(/<([^>]*)>/);
	const bare = (angled ? angled[1] : value).trim().toLowerCase();
	return bare === "" ? null : bare;
}

/**
 * Turn one provider event into the ledger input, or null to skip it.
 *
 * An as-yet-unseen provider status becomes a non-terminal `provider_status`
 * row whose `error_detail` holds the raw status text, so it stays visible
 * instead of being dropped. Skips an empty status and any event with no
 * `messageId`: without the join key it cannot be attributed to a row.
 *
 * The `dedupeKey` is the identity of *this provider verdict for this recipient*,
 * so re-reading the window never double-counts, while a genuinely distinct
 * verdict (a later status change) still lands.
 */
export function providerEventToLedgerInput(
	event: ProviderSendEvent,
): DeliveryEventInput | null {
	const type = lifecycleFromProviderStatus(event.status);
	if (type === null) return null;
	const providerId = event.messageId?.trim().replace(/^<|>$/g, "");
	if (!providerId) return null;

	const recipient = bareAddress(event.to);
	const unknown = type === "provider_status";
	const cause = unknown ? null : classifyErrorCause(event.status, event.errorCause);
	const detail = unknown
		? `status: ${event.status}${event.errorDetail ? ` (${event.errorDetail})` : ""}`
		: event.errorDetail || null;

	return {
		// Filled in by the DO once it resolves the provider id to a local row id;
		// the reconciler passes the provider id across and the DO does the lookup.
		emailId: providerId,
		type,
		source: "graphql",
		recipient,
		providerMessageId: providerId,
		errorCause: cause,
		errorDetail: detail,
		metadata: unknown ? { providerStatus: event.status } : null,
		occurredAt: event.datetime,
		// The raw status is part of an unknown verdict's identity, so two
		// different unknown statuses for one recipient both land.
		dedupeKey: unknown
			? `graphql:provider_status:${event.status}:${providerId}:${recipient ?? "-"}`
			: `graphql:${type}:${providerId}:${recipient ?? "-"}`,
	};
}

/**
 * Default rolling window: 7 days. An outage longer than the window loses
 * verdicts for good, and the ledger's dedupe makes re-reading free, so the
 * window is wide; it stays well inside the 31-day retention.
 */
export const DEFAULT_LOOKBACK_MINUTES = 7 * 24 * 60;

/** The API's documented per-query ceiling for `emailSendingAdaptive`. */
const EVENT_PAGE_LIMIT = 10000;

/**
 * How many times a window may be halved when it saturates the limit.
 *
 * A 7-day window bisected 6 times is about 2.6 hours; a zone producing 10,000 events in
 * that span is far beyond anything this deployment sends, and bounding the
 * recursion keeps one pathological tick from running unbounded queries inside a
 * cron invocation.
 */
const MAX_WINDOW_SPLITS = 6;

/**
 * Fetch every send event in a window, splitting the window when a response
 * saturates the API's row limit.
 *
 * `emailSendingAdaptive` returns newest-first with no offset pagination, so a
 * window holding more than `EVENT_PAGE_LIMIT` events silently drops the OLDEST
 * ones. That matters after a reconciler outage or a send burst: the omitted
 * verdicts would stay behind the same cap on every later tick until they aged
 * out of the lookback, losing them permanently. Splitting the window in half and
 * fetching each side is the only pagination this API allows.
 *
 * A saturated response is treated as "possibly truncated" rather than "exactly
 * full" — the two are indistinguishable from the response alone, and re-fetching
 * a genuinely-exactly-full window costs one extra query while missing a
 * truncation costs data.
 */
async function fetchAllSendEvents(
	config: EmailAnalyticsConfig,
	window: { start: string; end: string },
	fetchImpl: typeof fetch | undefined,
	depth = 0,
): Promise<ProviderSendEvent[]> {
	const events = await fetchSendEvents(
		config,
		window,
		EVENT_PAGE_LIMIT,
		fetchImpl,
	);

	if (events.length < EVENT_PAGE_LIMIT || depth >= MAX_WINDOW_SPLITS) {
		if (events.length >= EVENT_PAGE_LIMIT) {
			console.error(
				`Delivery reconcile: window ${window.start}..${window.end} still saturated at max split depth; some verdicts may be missed.`,
			);
		}
		return events;
	}

	const startMs = Date.parse(window.start);
	const endMs = Date.parse(window.end);
	// An unparseable or degenerate window cannot be split further; return what we
	// have rather than looping on the same bounds.
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs - startMs < 2) {
		return events;
	}

	const midpoint = new Date(startMs + Math.floor((endMs - startMs) / 2))
		.toISOString();
	const [older, newer] = await Promise.all([
		fetchAllSendEvents(config, { start: window.start, end: midpoint }, fetchImpl, depth + 1),
		fetchAllSendEvents(config, { start: midpoint, end: window.end }, fetchImpl, depth + 1),
	]);

	// The midpoint is inclusive on both sides, so an event exactly on it appears
	// twice. De-dupe by the identity the ledger keys on; a genuine duplicate would
	// be absorbed by `dedupe_key` anyway, but counting it twice would make the
	// tick log lie about how much work there was.
	const seen = new Set<string>();
	const merged: ProviderSendEvent[] = [];
	for (const event of [...older, ...newer]) {
		const key = `${event.messageId}|${event.to}|${event.status}|${event.datetime}`;
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(event);
	}
	return merged;
}

/**
 * Fetch the zone's recent send events and file each mailbox's verdicts.
 *
 * `lookbackMinutes` sets the rolling window width. It should exceed the tick
 * interval by a safe margin so a delivery reported between ticks is not missed;
 * dedupe makes the overlap free.
 */
export async function reconcileDeliveryEvents(
	config: EmailAnalyticsConfig,
	resolveStub: MailboxStubResolver,
	options: {
		now?: Date;
		lookbackMinutes?: number;
		fetchImpl?: typeof fetch;
		/**
		 * Alias address -> owning mailbox. A message sent from an alias carries
		 * the alias as `from`, but its row lives in the owning mailbox's DO.
		 */
		aliases?: Record<string, string>;
		/**
		 * Called once per recipient whose send failed with an address-level cause
		 * (`user_unknown` and friends), for mailboxes whose reconcile succeeded.
		 * This is how provider bounces reach the suppression list. Repeats across
		 * ticks are harmless: adding a suppression is idempotent.
		 */
		onHardBounce?: (address: string, mailboxId: string) => Promise<unknown>;
		/**
		 * Called once per recipient with a `complained` verdict, for mailboxes
		 * whose reconcile succeeded. This is how provider complaints reach the
		 * suppression list (a permanent `complaint` entry). Idempotent.
		 */
		onComplaint?: (address: string, mailboxId: string) => Promise<unknown>;
	} = {},
): Promise<ReconcileResult> {
	const now = options.now ?? new Date();
	const lookback = options.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES;
	const start = new Date(now.getTime() - lookback * 60_000).toISOString();
	const end = now.toISOString();

	const events = await fetchAllSendEvents(
		config,
		{ start, end },
		options.fetchImpl,
	);

	// Group by sending mailbox. An event whose `from` does not resolve to a bare
	// address, or whose status/id we skip, contributes nothing.
	const byMailbox = new Map<string, DeliveryEventInput[]>();
	const bouncesByMailbox = new Map<string, Set<string>>();
	const complaintsByMailbox = new Map<string, Set<string>>();
	for (const event of events) {
		const fromAddress = bareAddress(event.from);
		if (!fromAddress) continue;
		const mailboxId = options.aliases?.[fromAddress] ?? fromAddress;
		const input = providerEventToLedgerInput(event);
		if (!input) continue;
		const list = byMailbox.get(mailboxId) ?? [];
		list.push(input);
		byMailbox.set(mailboxId, list);
		if (
			input.type === "bounced" &&
			input.recipient &&
			isAddressLevelProviderCause(event.errorCause)
		) {
			const set = bouncesByMailbox.get(mailboxId) ?? new Set<string>();
			set.add(input.recipient);
			bouncesByMailbox.set(mailboxId, set);
		}
		if (input.type === "complained" && input.recipient) {
			const set = complaintsByMailbox.get(mailboxId) ?? new Set<string>();
			set.add(input.recipient);
			complaintsByMailbox.set(mailboxId, set);
		}
	}

	let applied = 0;
	let failed = 0;
	let hardBounces = 0;
	let complaints = 0;
	for (const [mailboxId, inputs] of byMailbox) {
		try {
			const result = await resolveStub(mailboxId).reconcileProviderEvents(
				inputs,
			);
			applied += result.applied;
			const bounced = bouncesByMailbox.get(mailboxId);
			if (bounced && options.onHardBounce) {
				for (const address of bounced) {
					try {
						await options.onHardBounce(address, mailboxId);
						hardBounces += 1;
					} catch (e) {
						console.error(
							`Delivery reconcile: hard-bounce hook failed for ${address}:`,
							(e as Error).message,
						);
					}
				}
			}
			const complained = complaintsByMailbox.get(mailboxId);
			if (complained && options.onComplaint) {
				for (const address of complained) {
					try {
						await options.onComplaint(address, mailboxId);
						complaints += 1;
					} catch (e) {
						console.error(
							`Delivery reconcile: complaint hook failed for ${address}:`,
							(e as Error).message,
						);
					}
				}
			}
		} catch (e) {
			failed += 1;
			console.error(
				`Delivery reconcile failed for ${mailboxId}:`,
				(e as Error).message,
			);
		}
	}

	return {
		fetched: events.length,
		mailboxes: byMailbox.size,
		applied,
		failed,
		hardBounces,
		complaints,
	};
}
