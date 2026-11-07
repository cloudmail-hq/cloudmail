// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Turn this mailbox's delivery ledger into webhook events.
 *
 * Outbound events have many writers: the send routes, the undo-window send
 * that runs in this object's alarm, the agent tools, sequences, inbound DSNs,
 * the GraphQL reconciler and the tracking endpoint. They all end up as rows in
 * `delivery_events`. Reading that table from a cursor catches every one of them
 * without touching each call site, and keeps catching them when a new writer
 * is added.
 *
 * The cursor only advances after the webhook object accepted the batch, so a
 * failed hand-off is retried by the next flush. Event ids are derived from the
 * ledger row, and the webhook store ignores an event it already queued, so a
 * replay never double-sends.
 */

import {
	buildEmailSummary,
	buildWebhookPayload,
	webhookTypeForLedgerEvent,
	type EmailSummaryRow,
	type WebhookEmailSummary,
	type WebhookEventType,
} from "../../shared/webhooks";
import type { EnqueueInput } from "../lib/webhooks-store";

const CURSOR_KEY = "webhooks:ledger-cursor";
/** The realtime stream reads the same ledger from its own cursor. */
export const STREAM_CURSOR_KEY = "events:ledger-cursor";
const FLUSH_BATCH = 100;

/** The slice of the webhook DO stub this needs. */
export interface WebhookSink {
	wantedTypes(mailbox: string): Promise<WebhookEventType[]>;
	enqueue(events: EnqueueInput[]): Promise<{ queued: number }>;
}

/** Summary of one stored message, or null when it no longer exists. */
export function emailSummaryFor(ctx: DurableObjectState, emailId: string): WebhookEmailSummary | null {
	const row = ctx.storage.sql
		.exec(
			// `body` only matters when `snippet` is still NULL (a legacy row the
			// lazy backfill has not reached); see `webhookSnippet`.
			`SELECT id, thread_id, sender, sender_name, recipient, cc, subject, snippet,
			        CASE WHEN snippet IS NULL THEN body END AS body, folder_id
			   FROM emails WHERE id = ?1 LIMIT 1`,
			emailId,
		)
		.toArray()[0] as unknown as EmailSummaryRow | undefined;
	if (!row) return null;
	const labels = ctx.storage.sql
		.exec(
			`SELECT l.name FROM email_labels el JOIN labels l ON l.id = el.label_id
			  WHERE el.email_id = ?1 ORDER BY l.sort_order ASC, l.name ASC`,
			emailId,
		)
		.toArray()
		.map((r) => String((r as { name: string }).name));
	const attachments = Number(
		(ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM attachments WHERE email_id = ?1`, emailId).toArray()[0] as
			| { n: number }
			| undefined)?.n ?? 0,
	);
	return buildEmailSummary(row, labels, attachments);
}

interface LedgerRow {
	id: number;
	email_id: string;
	event_type: string;
	source: string;
	recipient: string | null;
	error_cause: string | null;
	error_detail: string | null;
	metadata: string | null;
	occurred_at: string;
}

function metadataUrl(metadata: string | null): string | null {
	if (!metadata) return null;
	try {
		const parsed = JSON.parse(metadata) as { url?: unknown };
		return typeof parsed.url === "string" ? parsed.url : null;
	} catch {
		return null;
	}
}

function isoOrNow(value: string): string {
	const ms = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

async function readCursor(ctx: DurableObjectState, key: string): Promise<number> {
	const stored = await ctx.storage.get<number>(key);
	if (typeof stored === "number") return stored;
	// First flush on this mailbox: start from now-ish, not from the dawn of the
	// ledger, so turning webhooks on does not replay months of history. The
	// five-minute grace keeps the event that triggered this flush.
	const row = ctx.storage.sql
		.exec(
			`SELECT COALESCE(MAX(id), 0) AS id FROM delivery_events
			  WHERE created_at < datetime('now', '-5 minutes')`,
		)
		.toArray()[0] as { id: number } | undefined;
	const start = Number(row?.id ?? 0);
	await ctx.storage.put(key, start);
	return start;
}

/**
 * Forward new ledger rows to the webhook object. Returns how many events were
 * handed over. Throws only if the hand-off itself failed, leaving the cursor
 * where it was.
 */
export async function flushLedgerToWebhooks(
	ctx: DurableObjectState,
	mailbox: string | null,
	sink: WebhookSink,
	wanted: (address: string) => Promise<WebhookEventType[]>,
	cursorKey: string = CURSOR_KEY,
): Promise<number> {
	let handed = 0;
	for (;;) {
		const cursor = await readCursor(ctx, cursorKey);
		const rows = ctx.storage.sql
			.exec(
				`SELECT id, email_id, event_type, source, recipient, error_cause, error_detail,
				        metadata, occurred_at
				   FROM delivery_events WHERE id > ?1 ORDER BY id ASC LIMIT ?2`,
				cursor,
				FLUSH_BATCH,
			)
			.toArray() as unknown as LedgerRow[];
		if (rows.length === 0) return handed;

		const lastId = Number(rows[rows.length - 1].id);
		const events: EnqueueInput[] = [];
		const summaries = new Map<string, WebhookEmailSummary | null>();
		const wantedByAddress = new Map<string, Set<WebhookEventType>>();

		for (const row of rows) {
			const type = webhookTypeForLedgerEvent(row.event_type);
			if (!type) continue;
			if (!summaries.has(row.email_id)) summaries.set(row.email_id, emailSummaryFor(ctx, row.email_id));
			const summary = summaries.get(row.email_id);
			if (!summary) continue;
			// Ledger rows are all outbound, so the sender is this mailbox; that
			// covers a runtime without `ctx.id.name`.
			const address = (mailbox ?? summary.from ?? "").toLowerCase();
			if (!address) continue;
			if (!wantedByAddress.has(address)) wantedByAddress.set(address, new Set(await wanted(address)));
			if (!wantedByAddress.get(address)!.has(type)) continue;

			const eventId = `evt_${address}_${row.id}`;
			const payload = buildWebhookPayload({
				id: eventId,
				type,
				createdAt: isoOrNow(row.occurred_at),
				mailbox: address,
				data: summary,
				detail: {
					recipient: row.recipient,
					reason: row.error_detail,
					cause: row.error_cause,
					url: type === "message.clicked" ? metadataUrl(row.metadata) : null,
					source: row.source,
				},
			});
			events.push({ eventId, type, mailbox: address, payload: JSON.stringify(payload), now: Date.now() });
		}

		if (events.length > 0) {
			await sink.enqueue(events);
			handed += events.length;
		}
		await ctx.storage.put(cursorKey, lastId);
		if (rows.length < FLUSH_BATCH) return handed;
	}
}
