// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Read delivery outcomes back from Cloudflare Email Service's own analytics.
 *
 * ## Why this exists
 *
 * The mailer's own records stop at the handoff. `recordDelivery` knows only
 * whether `env.EMAIL.send()` returned or threw — a `202` means Email Service
 * accepted the message, NOT that the recipient's server did. What happened next
 * (delivered, bounced, and crucially *why* it bounced) lives only in
 * Cloudflare's `emailSendingAdaptive` GraphQL dataset, which nothing queried.
 *
 * That dataset is the piece that answers the actual question behind this
 * feature: "is mail not arriving because of our bug, or because the recipient's
 * mailbox is full / rejecting us?" Its `errorCause` distinguishes an internal
 * failure from a recipient-side one, and it is keyed by `messageId` — the same
 * provider id `recordDelivery` now stores on the row. So the two can be joined.
 *
 * ## What this module is
 *
 * A thin, pure client over the GraphQL Analytics API plus the shapes the
 * reconciler consumes. The reconciler itself (which owns DO stubs and the
 * ledger) lives in `email-reconciler.ts`; keeping the HTTP here means it can be
 * tested against recorded fixtures without a Durable Object.
 *
 * Datasets and fields verified live against the tapetide.com zone: the query
 * returns `delivered` and `deliveryFailed` statuses today, with `errorCause`
 * populated on failures. Retention is 31 days, so the reconciler must run often
 * enough that no send ages out before it is reconciled.
 */

/** One individual send event as returned by `emailSendingAdaptive`. */
export interface ProviderSendEvent {
	datetime: string;
	messageId: string;
	from: string;
	to: string;
	status: string;
	eventType: string;
	sendingDomain: string;
	errorCause: string;
	errorDetail: string;
}

export interface EmailAnalyticsConfig {
	/** API token with Analytics Read on the zone. A Worker secret. */
	apiToken: string;
	/** Zone tag (id) to query. Email Service datasets are zone-level. */
	zoneTag: string;
	/** GraphQL endpoint; overridable for tests. */
	endpoint?: string;
}

const DEFAULT_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

/**
 * The query is deliberately the individual-event dataset, not the aggregated
 * groups: the reconciler needs the `messageId` on each event to join it to a
 * local row, and only `emailSendingAdaptive` carries it. `orderBy` newest-first
 * and a bounded `limit` keep a single call cheap; the reconciler pages by
 * shrinking the time window rather than by offset, which this API does not
 * support.
 */
const SEND_EVENTS_QUERY = `
query ProviderSendEvents($zoneTag: string!, $start: Time!, $end: Time!, $limit: Int!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      emailSendingAdaptive(
        filter: { datetime_geq: $start, datetime_leq: $end }
        limit: $limit
        orderBy: [datetime_DESC]
      ) {
        datetime
        messageId
        from
        to
        status
        eventType
        sendingDomain
        errorCause
        errorDetail
      }
    }
  }
}`.trim();

export class EmailAnalyticsError extends Error {}

/**
 * Fetch individual send events for a zone over a time window.
 *
 * Throws `EmailAnalyticsError` on an HTTP error or a GraphQL `errors` array,
 * rather than returning an empty list — a silent empty result would let the
 * reconciler report "nothing to do" when the token is actually misscoped, which
 * is exactly the kind of false all-clear this whole effort is removing.
 *
 * `limit` defaults to 10000, the API's documented ceiling for this dataset.
 */
export async function fetchSendEvents(
	config: EmailAnalyticsConfig,
	window: { start: string; end: string },
	limit = 10000,
	fetchImpl: typeof fetch = fetch,
): Promise<ProviderSendEvent[]> {
	const response = await fetchImpl(config.endpoint ?? DEFAULT_ENDPOINT, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${config.apiToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			query: SEND_EVENTS_QUERY,
			variables: {
				zoneTag: config.zoneTag,
				start: window.start,
				end: window.end,
				limit,
			},
		}),
	});

	if (!response.ok) {
		throw new EmailAnalyticsError(
			`GraphQL HTTP ${response.status} ${response.statusText}`,
		);
	}

	const payload = (await response.json()) as {
		data?: {
			viewer?: {
				zones?: { emailSendingAdaptive?: ProviderSendEvent[] }[];
			};
		};
		errors?: { message?: string }[] | null;
	};

	if (payload.errors && payload.errors.length > 0) {
		throw new EmailAnalyticsError(
			`GraphQL errors: ${payload.errors
				.map((e) => e.message ?? "unknown")
				.join("; ")}`,
		);
	}

	const zones = payload.data?.viewer?.zones ?? [];
	return zones.flatMap((zone) => zone.emailSendingAdaptive ?? []);
}

/**
 * Classify a provider event into the coarse "whose fault" bucket the UI shows.
 *
 * The nuance the operator asked for — "our internal code bug vs the recipient's
 * mailbox being full" — is exactly this split, and the provider's `errorCause`
 * is the authoritative source for it. We do NOT re-derive it from the free-text
 * `errorDetail`, which varies per receiving MTA.
 *
 * - `internal`  — the failure is on our side (auth/config/reputation we control,
 *   or an empty cause on a failure, which means the send never got far enough to
 *   blame the recipient). These are the ones an engineer should look at.
 * - `recipient` — the failure is on the far side (mailbox full, address unknown,
 *   recipient policy). Nothing to fix in our code; surface it and move on.
 * - `null`      — a success, no fault to attribute.
 *
 * A cause we do not recognise is treated as `recipient`: assuming the far side
 * avoids crying wolf about our own code on an unfamiliar-but-benign bounce, and
 * an unknown cause on a genuinely internal problem still shows as a failure —
 * just filed under the more conservative bucket.
 */
export function classifyErrorCause(
	status: string,
	errorCause: string,
): "internal" | "recipient" | null {
	if (status === "delivered") return null;

	const cause = errorCause.trim().toLowerCase();

	// An empty cause on a non-delivery is our side: the send failed before the
	// recipient's server ever weighed in.
	if (cause === "") return "internal";

	const INTERNAL = new Set([
		"internal",
		"internal_error",
		"authentication",
		"auth_failure",
		"spf",
		"dkim",
		"dmarc",
		"reputation",
		"bad_reputation",
		"rate_limited",
		"configuration",
		"suppressed",
	]);
	const RECIPIENT = new Set([
		"mailbox_full",
		"quota_exceeded",
		"user_unknown",
		"no_such_user",
		"invalid_recipient",
		"recipient_rejected",
		"policy",
		"blocked",
		"spam",
		"greylisted",
		"domain_not_found",
	]);

	if (INTERNAL.has(cause)) return "internal";
	if (RECIPIENT.has(cause)) return "recipient";
	return "recipient";
}
