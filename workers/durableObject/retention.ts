// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Retention purge for one mailbox: tracking and delivery events past their
 * period. Trash has its own sweep (./trash.ts), which takes its period from the
 * same policy.
 *
 * Bounded: each call deletes at most `batchSize` rows per kind, oldest first,
 * through `idx_delivery_events_occurred` (migration 38). The cron hands each
 * mailbox the policy; when a batch is full there is more to do, so the caller
 * re-arms the mailbox's alarm to continue instead of looping inside one
 * invocation.
 *
 * Engagement caches on `emails` (`open_count`, `opened_at`, ...) are recomputed
 * for the messages whose events went, so a purged open does not linger as a
 * count. Delivery status on `emails` is left alone: it is the message's own
 * state, not an event log, and survives as long as the message does.
 */

import {
	ENGAGEMENT_EVENT_TYPES,
	LIFECYCLE_EVENT_TYPES,
} from "../../shared/delivery-events";
import { retentionCutoff, type RetentionPolicy } from "../../shared/privacy";
import { recomputeEngagement } from "./engagement";

export const RETENTION_BATCH_SIZE = 500;

export interface RetentionPurgeResult {
	trackingEvents: number;
	deliveryEvents: number;
	/** True when a batch filled up and another pass is needed. */
	more: boolean;
}

function list(values: readonly string[]): string {
	return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
}

function purgeKind(
	ctx: DurableObjectState,
	types: readonly string[],
	cutoffIso: string,
	limit: number,
): { deleted: number; emailIds: string[] } {
	// Ids first, so the touched messages are known and the delete is a key
	// lookup. Consumed synchronously: no cursor is held across an await.
	const rows = ctx.storage.sql
		.exec(
			`SELECT id, email_id FROM delivery_events
			  WHERE occurred_at < ?1 AND event_type IN (${list(types)})
			  ORDER BY occurred_at ASC
			  LIMIT ?2`,
			cutoffIso,
			limit,
		)
		.toArray() as unknown as { id: number; email_id: string }[];
	if (rows.length === 0) return { deleted: 0, emailIds: [] };

	const ids = rows.map((r) => Number(r.id));
	for (let i = 0; i < ids.length; i += 90) {
		const chunk = ids.slice(i, i + 90);
		ctx.storage.sql.exec(
			`DELETE FROM delivery_events WHERE id IN (${chunk.map(() => "?").join(", ")})`,
			...chunk,
		);
	}
	return { deleted: rows.length, emailIds: [...new Set(rows.map((r) => String(r.email_id)))] };
}

export function purgeExpiredEvents(
	ctx: DurableObjectState,
	policy: Pick<RetentionPolicy, "trackingEventsDays" | "deliveryEventsDays">,
	options: { now?: number; batchSize?: number } = {},
): RetentionPurgeResult {
	const now = options.now ?? Date.now();
	const limit = options.batchSize ?? RETENTION_BATCH_SIZE;

	const tracking = purgeKind(
		ctx,
		ENGAGEMENT_EVENT_TYPES,
		retentionCutoff(now, policy.trackingEventsDays).toISOString(),
		limit,
	);
	const delivery = purgeKind(
		ctx,
		LIFECYCLE_EVENT_TYPES,
		retentionCutoff(now, policy.deliveryEventsDays).toISOString(),
		limit,
	);

	for (const emailId of tracking.emailIds) recomputeEngagement(ctx, emailId);

	return {
		trackingEvents: tracking.deleted,
		deliveryEvents: delivery.deleted,
		more: tracking.deleted >= limit || delivery.deleted >= limit,
	};
}

// ── Policy held by the mailbox ────────────────────────────────────

/**
 * The cron pushes the deployment's policy to each mailbox, which keeps it in
 * DO storage so its own alarm (the trash sweep, a continuation pass) uses the
 * same periods without an R2 read. Absent means the defaults.
 */
export const RETENTION_POLICY_KEY = "retention_policy";
