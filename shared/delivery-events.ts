// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The vocabulary of what can happen to an outbound message, shared by the
 * ledger writers (send path, DSN handler, GraphQL reconciler, tracking
 * endpoint), the derived-status recompute, and the analytics aggregates.
 *
 * Kept in `shared/` for the same reason `dsn.ts` and `folders.ts` are: the
 * Worker writes these strings, the frontend renders chips off them, and a
 * second definition is a second thing to forget to update.
 *
 * ## The two families
 *
 * **Lifecycle** events describe delivery, observed by the provider and our
 * bounce handling. They form a rough progression — `queued` → `sent` →
 * `delivered`, with `soft_bounced` a recoverable detour and `bounced` /
 * `rejected` / `failed` terminal failures. Exactly one of them is the message's
 * current delivery truth, which is why `latestTerminalStatus` collapses them
 * back to the single `emails.delivery_status` cache.
 *
 * **Engagement** events describe what the recipient did — `opened`, `clicked`,
 * `attachment_downloaded`. These are additive: a message can be opened many
 * times, and each is real signal, so they never dedupe and never overwrite a
 * lifecycle status.
 *
 * The split matters because the two families answer different questions and
 * must never be conflated: an open does not make a bounced message delivered,
 * and a delivery does not count as engagement.
 */

/** Delivery-lifecycle event kinds, provider- or bounce-observed. */
export const LIFECYCLE_EVENT_TYPES = [
	/** Accepted by us and queued; the row exists before the provider is called. */
	"queued",
	/** Handed to Email Service without immediate rejection. */
	"sent",
	/** Provider or DSN confirms the recipient's server accepted it. */
	"delivered",
	/** Temporary failure (4xx). The provider retries; not terminal. */
	"soft_bounced",
	/** Permanent failure reported by a downstream MTA (5xx DSN). */
	"bounced",
	/** Refused before send because the recipient is on the suppression list. */
	"rejected",
	/** Our own send call threw — a header rejection, a binding error, a timeout. */
	"failed",
	/** Recipient marked it as spam (feedback loop). */
	"complained",
	/**
	 * A provider status this code does not recognise, kept verbatim in
	 * `error_detail` rather than dropped. Non-terminal: it never changes the
	 * derived `delivery_status`, it only makes the unknown value visible.
	 */
	"provider_status",
] as const;

/** Recipient-engagement event kinds, observed by the tracking endpoint. */
export const ENGAGEMENT_EVENT_TYPES = [
	"opened",
	"clicked",
	"attachment_downloaded",
] as const;

export const DELIVERY_EVENT_TYPES = [
	...LIFECYCLE_EVENT_TYPES,
	...ENGAGEMENT_EVENT_TYPES,
] as const;

export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];
export type EngagementEventType = (typeof ENGAGEMENT_EVENT_TYPES)[number];
export type DeliveryEventType = (typeof DELIVERY_EVENT_TYPES)[number];

/** Which system observed an event. Used to de-duplicate double-reports. */
export const DELIVERY_EVENT_SOURCES = [
	"send", // our own env.EMAIL.send() call returned or threw
	"dsn", // an inbound delivery-status notification
	"graphql", // the Cloudflare Email Service analytics reconciler
	"pixel", // the open-tracking pixel was fetched
	"redirect", // a wrapped link was followed
	"attachment", // a tracked attachment link was fetched
] as const;

export type DeliveryEventSource = (typeof DELIVERY_EVENT_SOURCES)[number];

/**
 * The shape a caller hands to the ledger writer.
 *
 * Lives in `shared/` rather than beside the SQL because both the DO (which
 * writes it) and the reconciler (which builds it before sending it over RPC)
 * need the type, and the reconciler must not import the Durable Object layer.
 *
 * `emailId`, `type` and `source` are the only required parts because they are
 * the only ones every event has. A whole-message rejection has no `recipient`;
 * a `sent` event has no `errorCause`; an `opened` event has neither but does
 * carry `metadata`.
 */
export interface DeliveryEventInput {
	emailId: string;
	type: DeliveryEventType;
	source: DeliveryEventSource;
	recipient?: string | null;
	providerMessageId?: string | null;
	errorCause?: string | null;
	errorDetail?: string | null;
	metadata?: Record<string, unknown> | null;
	/**
	 * When the event actually happened per its source. Defaults to now; a bounce
	 * or a reconciled provider event passes the timestamp it carries so the
	 * ledger reflects real chronology rather than write time.
	 */
	occurredAt?: string;
	/**
	 * Idempotency key for provider-observed lifecycle events. Pass a stable
	 * identity for anything that can be re-reported — a repeat insert is silently
	 * ignored. Leave undefined for engagement events, which must accumulate.
	 */
	dedupeKey?: string | null;
}

const LIFECYCLE_SET = new Set<string>(LIFECYCLE_EVENT_TYPES);
const ENGAGEMENT_SET = new Set<string>(ENGAGEMENT_EVENT_TYPES);
const TYPE_SET = new Set<string>(DELIVERY_EVENT_TYPES);
const SOURCE_SET = new Set<string>(DELIVERY_EVENT_SOURCES);

export function isDeliveryEventType(value: string): value is DeliveryEventType {
	return TYPE_SET.has(value);
}

export function isLifecycleEvent(value: string): value is LifecycleEventType {
	return LIFECYCLE_SET.has(value);
}

export function isEngagementEvent(value: string): value is EngagementEventType {
	return ENGAGEMENT_SET.has(value);
}

export function isDeliveryEventSource(
	value: string,
): value is DeliveryEventSource {
	return SOURCE_SET.has(value);
}

/**
 * Terminal delivery outcomes, in order of precedence for the derived status.
 *
 * When a message has several lifecycle events (queued, then delivered, then a
 * late complaint), the single `emails.delivery_status` cache has to pick one.
 * The rule is *worst wins among the latest*, but "latest" is by time — see
 * `latestTerminalStatus`.
 */
const TERMINAL: ReadonlySet<string> = new Set([
	"delivered",
	"bounced",
	"rejected",
	"failed",
	// A spam complaint is terminal and, when it arrives after a delivery, is the
	// newer truth: the message reached the recipient and they rejected it, which
	// the cache should reflect as a failure rather than a success.
	"complained",
]);

/**
 * A dated lifecycle event, the minimum `latestTerminalStatus` needs.
 */
export interface DatedLifecycleEvent {
	event_type: string;
	occurred_at: string;
}

/**
 * Collapse a message's lifecycle events into the single value cached on
 * `emails.delivery_status`.
 *
 * ## The rule
 *
 * The most recent *terminal* event wins. `queued`, `sent` and `soft_bounced`
 * are transient — a message that soft-bounced and then delivered is delivered —
 * so they are ignored once any terminal event exists. Among terminal events the
 * latest `occurred_at` is authoritative, because a `complained` arriving after a
 * `delivered` is the newer truth and a re-send that delivers after an earlier
 * `failed` supersedes it.
 *
 * Returns:
 * - `"delivered"` when the latest terminal event is a delivery. The existing UI
 *   treats a non-`failed` status as success, and this maps to a green chip.
 * - `"failed"` when the latest terminal event is any failure kind. Collapsed to
 *   the one string the current `delivery_status` column and its UI already
 *   understand, so the ledger does not force a UI change to be useful.
 * - `null` when nothing terminal has happened yet (only queued/sent/soft), which
 *   is exactly the "nothing known, assume in-flight" state a NULL already means.
 *
 * The nuance beyond delivered-vs-failed (which failure, mailbox-full vs our bug)
 * lives in the event rows themselves; this function only feeds the coarse cache.
 */
export function latestTerminalStatus(
	events: readonly DatedLifecycleEvent[],
): "delivered" | "failed" | null {
	let latest: DatedLifecycleEvent | null = null;
	for (const event of events) {
		if (!TERMINAL.has(event.event_type)) continue;
		if (latest === null) {
			latest = event;
			continue;
		}
		if (event.occurred_at > latest.occurred_at) {
			latest = event;
			continue;
		}
		// Equal timestamps need an explicit tie-break, or the winner is whichever
		// row the caller's query happened to return first — and callers read the
		// ledger without an ORDER BY. Batched per-recipient verdicts really do
		// share a timestamp, so a simultaneous `delivered` and `bounced` would
		// otherwise collapse to either answer run to run. Failure wins: claiming
		// delivery for a message that also bounced is the more harmful error, and
		// it matches the "worst wins" reading this function documents.
		if (
			event.occurred_at === latest.occurred_at &&
			latest.event_type === "delivered" &&
			event.event_type !== "delivered"
		) {
			latest = event;
		}
	}
	if (latest === null) return null;
	return latest.event_type === "delivered" ? "delivered" : "failed";
}

/**
 * Map a Cloudflare Email Service `status` string to a lifecycle event type.
 *
 * The GraphQL datasets report `delivered` and `deliveryFailed` (confirmed live
 * against the tapetide.com zone). `deferred`, `failed` and `rejected` come from
 * the activity log and Queues vocabulary and are mapped defensively.
 *
 * Anything else maps to `provider_status`, never null: an unrecognised status
 * used to be skipped, which silently hid a new failure kind. The reconciler
 * stores the raw text so it shows up in the timeline and analytics. Only an
 * empty status is skipped (null).
 */
export function lifecycleFromProviderStatus(
	status: string,
): LifecycleEventType | null {
	switch (status) {
		case "delivered":
			return "delivered";
		case "deliveryFailed":
		case "bounced":
			return "bounced";
		case "rejected":
			return "rejected";
		case "deferred":
			return "soft_bounced";
		case "failed":
			return "failed";
		// A spam complaint (feedback loop). The raw dataset has not been seen to
		// carry one yet; both spellings are accepted so the first one is acted on.
		case "complained":
		case "complaint":
			return "complained";
		default:
			return status.trim() === "" ? null : "provider_status";
	}
}
