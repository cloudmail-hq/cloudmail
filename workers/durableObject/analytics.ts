// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-mailbox reads for the analytics console, over the `delivery_events`
 * ledger and the `emails` table. Read-only.
 *
 * The cohort rule matches `getSentAnalytics`: a message belongs to the window
 * by its `emails.date`, and every engagement event of that message counts no
 * matter when it occurred. That keeps open rate at or below 100%.
 */

import { Folders } from "../../shared/folders";
import { extractAuthenticationResults } from "../../shared/auth-results";

/**
 * One message's delivery outcome, shared by the overview (`getSendingStats`)
 * and engagement (`getEngagement`) so "delivered" means the same thing in both.
 *
 * - The latest terminal event decides (failure wins a tie; see callers).
 * - A complaint means the message arrived: delivered.
 * - No terminal verdict but an open or click: delivered, because engagement
 *   proves arrival.
 * - Otherwise pending: sent, waiting for Cloudflare to confirm.
 */
export type MessageOutcome = "delivered" | "pending" | "bounced" | "rejected" | "failed";

export function messageOutcome(terminal: string | null | undefined, engaged: boolean): MessageOutcome {
	switch (terminal) {
		case "delivered":
		case "complained":
			return "delivered";
		case "bounced":
			return "bounced";
		case "rejected":
			return "rejected";
		case "failed":
			return "failed";
		default:
			return engaged ? "delivered" : "pending";
	}
}

export interface AnalyticsWindowInput {
	start: string;
	end: string;
}

export interface MailboxEngagementMessage {
	email_id: string;
	subject: string;
	sent_at: string;
	recipients: number;
	opens: number;
	unique_opens: number;
	clicks: number;
	unique_clicks: number;
	first_open_at: string | null;
	/** Delivery outcome, by the same rule as the overview. */
	outcome: MessageOutcome;
}

export interface MailboxEngagementLink {
	url: string;
	clicks: number;
	/** Distinct (message, recipient) pairs that clicked. */
	unique_clicks: number;
	/** Distinct messages the link was clicked in. */
	messages: number;
}

export interface MailboxEngagement {
	/** Messages in the cohort. */
	sent: number;
	/** Cohort messages whose outcome is delivered (see `messageOutcome`). */
	delivered: number;
	/** Cohort messages still waiting for a delivery verdict. */
	pending: number;
	opens: number;
	/** Distinct messages opened (the open-rate numerator). */
	opened_messages: number;
	/** Distinct (message, recipient) pairs that opened; a message-level pixel counts once. */
	unique_opens: number;
	clicks: number;
	clicked_messages: number;
	unique_clicks: number;
	/** Newest first, at most `limit`. */
	messages: MailboxEngagementMessage[];
	/** By clicks, at most `limit`. */
	links: MailboxEngagementLink[];
	/** Opens/clicks per UTC day by occurred_at, for the overview series. */
	by_date: { date: string; opened: number; clicked: number }[];
}

/** Count of comma-separated addresses across To/Cc/Bcc. */
function countRecipients(...fields: (string | null)[]): number {
	let n = 0;
	for (const field of fields) {
		if (!field) continue;
		n += field
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part.includes("@")).length;
	}
	return n;
}

function clickUrl(metadata: string | null): string | null {
	if (!metadata) return null;
	try {
		const parsed = JSON.parse(metadata) as { url?: unknown };
		return typeof parsed.url === "string" && parsed.url !== "" ? parsed.url : null;
	} catch {
		return null;
	}
}

/**
 * Engagement for the messages this mailbox sent in the window: totals, a
 * per-message table and a per-link table.
 */
export function getEngagement(
	ctx: DurableObjectState,
	window: AnalyticsWindowInput,
	limit = 50,
): MailboxEngagement {
	const cohort = ctx.storage.sql
		.exec(
			`SELECT e.id AS id, e.subject AS subject, e.date AS date,
			        e.recipient AS recipient, e.cc AS cc, e.bcc AS bcc
			   FROM emails e
			  WHERE e.date >= ?1 AND e.date <= ?2 AND e.imported = 0
			    AND (
			          e.folder_id = ?3
			          OR EXISTS (
			               SELECT 1 FROM delivery_events de
			                WHERE de.email_id = e.id AND de.event_type IN ('sent', 'queued')
			             )
			        )`,
			window.start,
			window.end,
			Folders.SENT,
		)
		.toArray() as unknown as {
		id: string;
		subject: string | null;
		date: string;
		recipient: string | null;
		cc: string | null;
		bcc: string | null;
	}[];

	const empty: MailboxEngagement = {
		sent: 0,
		delivered: 0,
		pending: 0,
		opens: 0,
		opened_messages: 0,
		unique_opens: 0,
		clicks: 0,
		clicked_messages: 0,
		unique_clicks: 0,
		messages: [],
		links: [],
		by_date: [],
	};
	if (cohort.length === 0) return empty;

	const events = ctx.storage.sql
		.exec(
			`SELECT de.email_id AS email_id, de.event_type AS event_type,
			        de.recipient AS recipient, de.metadata AS metadata,
			        de.occurred_at AS occurred_at
			   FROM delivery_events de
			   JOIN emails e ON e.id = de.email_id
			  WHERE e.date >= ?1 AND e.date <= ?2 AND e.imported = 0
			    AND de.event_type IN ('opened', 'clicked', 'delivered', 'bounced', 'rejected', 'failed', 'complained')`,
			window.start,
			window.end,
		)
		.toArray() as unknown as {
		email_id: string;
		event_type: string;
		recipient: string | null;
		metadata: string | null;
		occurred_at: string;
	}[];

	const ids = new Set(cohort.map((row) => row.id));
	interface PerMessage {
		opens: number;
		openers: Set<string>;
		clicks: number;
		clickers: Set<string>;
		firstOpen: string | null;
		latestTerminal: { type: string; at: string } | null;
	}
	const per = new Map<string, PerMessage>();
	const links = new Map<string, { clicks: number; pairs: Set<string>; messages: Set<string> }>();
	const byDate = new Map<string, { opened: number; clicked: number }>();
	const slot = (id: string): PerMessage => {
		let entry = per.get(id);
		if (!entry) {
			entry = { opens: 0, openers: new Set(), clicks: 0, clickers: new Set(), firstOpen: null, latestTerminal: null };
			per.set(id, entry);
		}
		return entry;
	};

	for (const event of events) {
		if (!ids.has(event.email_id)) continue;
		const entry = slot(event.email_id);
		// NULL recipient = a message-level pixel/link; counts as one recipient.
		const who = event.recipient ?? "-";
		const day = event.occurred_at.slice(0, 10);
		if (event.event_type === "opened") {
			entry.opens += 1;
			entry.openers.add(who);
			if (entry.firstOpen === null || event.occurred_at < entry.firstOpen) entry.firstOpen = event.occurred_at;
			const d = byDate.get(day) ?? { opened: 0, clicked: 0 };
			d.opened += 1;
			byDate.set(day, d);
		} else if (event.event_type === "clicked") {
			entry.clicks += 1;
			entry.clickers.add(who);
			const d = byDate.get(day) ?? { opened: 0, clicked: 0 };
			d.clicked += 1;
			byDate.set(day, d);
			const url = clickUrl(event.metadata);
			if (url) {
				const link = links.get(url) ?? { clicks: 0, pairs: new Set(), messages: new Set() };
				link.clicks += 1;
				link.pairs.add(`${event.email_id}|${who}`);
				link.messages.add(event.email_id);
				links.set(url, link);
			}
		} else {
			// Lifecycle: latest wins, failure wins a tie (same rule as latestTerminalStatus).
			const cur = entry.latestTerminal;
			if (
				!cur ||
				event.occurred_at > cur.at ||
				(event.occurred_at === cur.at && cur.type === "delivered" && event.event_type !== "delivered")
			) {
				entry.latestTerminal = { type: event.event_type, at: event.occurred_at };
			}
		}
	}

	let delivered = 0;
	let pending = 0;
	let opens = 0;
	let openedMessages = 0;
	let uniqueOpens = 0;
	let clicks = 0;
	let clickedMessages = 0;
	let uniqueClicks = 0;
	// The rate denominator is delivered messages, by `messageOutcome`: an opened
	// but unreconciled message counts, or it would sit in the numerator only.
	const outcomeOf = (id: string): MessageOutcome => {
		const entry = per.get(id);
		return messageOutcome(entry?.latestTerminal?.type, !!entry && (entry.opens > 0 || entry.clicks > 0));
	};
	for (const row of cohort) {
		const outcome = outcomeOf(row.id);
		if (outcome === "delivered") delivered += 1;
		else if (outcome === "pending") pending += 1;
	}
	for (const entry of per.values()) {
		opens += entry.opens;
		clicks += entry.clicks;
		uniqueOpens += entry.openers.size;
		uniqueClicks += entry.clickers.size;
		if (entry.opens > 0) openedMessages += 1;
		if (entry.clicks > 0) clickedMessages += 1;
	}

	// Newest `limit`, plus every engaged message older than that, so the rows
	// always account for the totals (an opened message past the cut would leave
	// "12 opens" above a table of zeros).
	const sorted = [...cohort].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1));
	const engaged = (id: string) => {
		const e = per.get(id);
		return !!e && (e.opens > 0 || e.clicks > 0);
	};
	const messages = (limit > 0 ? sorted.filter((row, i) => i < limit || engaged(row.id)) : [])
		.map((row) => {
			const entry = per.get(row.id);
			return {
				email_id: row.id,
				subject: row.subject ?? "",
				sent_at: row.date,
				recipients: countRecipients(row.recipient, row.cc, row.bcc),
				opens: entry?.opens ?? 0,
				unique_opens: entry?.openers.size ?? 0,
				clicks: entry?.clicks ?? 0,
				unique_clicks: entry?.clickers.size ?? 0,
				first_open_at: entry?.firstOpen ?? null,
				outcome: outcomeOf(row.id),
			};
		});

	const linkRows = [...links.entries()]
		.map(([url, link]) => ({ url, clicks: link.clicks, unique_clicks: link.pairs.size, messages: link.messages.size }))
		.sort((a, b) => b.clicks - a.clicks || a.url.localeCompare(b.url))
		.slice(0, limit);

	return {
		sent: cohort.length,
		delivered,
		pending,
		opens,
		opened_messages: openedMessages,
		unique_opens: uniqueOpens,
		clicks,
		clicked_messages: clickedMessages,
		unique_clicks: uniqueClicks,
		messages,
		links: linkRows,
		by_date: [...byDate.entries()]
			.map(([date, v]) => ({ date, ...v }))
			.sort((a, b) => a.date.localeCompare(b.date)),
	};
}

export interface MailboxInboundStats {
	/**
	 * Inbound messages stored in the window: any folder except sent/draft/
	 * scheduled, and never a message this mailbox sent (an archived Sent copy
	 * used to count as inbound).
	 */
	stored: number;
	/** Of those, filed to Spam. */
	spam_filed: number;
	/**
	 * Verdict counts parsed from `Authentication-Results`. Always carries
	 * `pass`, `fail` and `none`; a message with no header counts as `none` (no
	 * verdict to report), so each histogram sums to `stored`.
	 */
	auth: { spf: Record<string, number>; dkim: Record<string, number>; dmarc: Record<string, number> };
	by_date: { date: string; received: number; spam: number }[];
	/** True when the scan stopped at `INBOUND_SCAN_LIMIT` (counts are a floor). Additive. */
	capped?: boolean;
}

/** Hard cap on rows scanned for auth parsing; `raw_headers` is not indexed. */
export const INBOUND_SCAN_LIMIT = 5000;

/** An auth histogram with `pass`, `fail` and `none` always present. */
export function emptyAuthHistogram(): Record<string, number> {
	return { pass: 0, fail: 0, none: 0 };
}

/**
 * Local inbound counts. Auth verdicts are parsed from `raw_headers` on read
 * (they are not columns), bounded to the newest `INBOUND_SCAN_LIMIT` rows.
 *
 * Dated by `emails.date`, the message's own Date header (clamped to receipt
 * time when implausible). There is no received-at column, so a message whose
 * Date header lies just outside the window can be counted on the other side
 * of the boundary from Cloudflare's event time. The route reports that as a
 * legitimate residual.
 */
export function getInboundStats(ctx: DurableObjectState, window: AnalyticsWindowInput): MailboxInboundStats {
	const rows = ctx.storage.sql
		.exec(
			`SELECT e.folder_id AS folder_id, e.date AS date, e.raw_headers AS raw_headers FROM emails e
			  WHERE e.date >= ?1 AND e.date <= ?2 AND e.imported = 0
			    AND e.folder_id NOT IN (?3, ?4, ?5)
			    AND NOT EXISTS (
			          SELECT 1 FROM delivery_events de
			           WHERE de.email_id = e.id AND de.event_type IN ('sent', 'queued')
			        )
			  ORDER BY e.date DESC LIMIT ?6`,
			window.start,
			window.end,
			Folders.SENT,
			Folders.DRAFT,
			Folders.SCHEDULED,
			INBOUND_SCAN_LIMIT,
		)
		.toArray() as unknown as { folder_id: string; date: string; raw_headers: string | null }[];

	const auth = { spf: emptyAuthHistogram(), dkim: emptyAuthHistogram(), dmarc: emptyAuthHistogram() };
	const byDate = new Map<string, { received: number; spam: number }>();
	let spam = 0;
	for (const row of rows) {
		const isSpam = row.folder_id === Folders.SPAM;
		if (isSpam) spam += 1;
		const day = (row.date ?? "").slice(0, 10);
		const d = byDate.get(day) ?? { received: 0, spam: 0 };
		d.received += 1;
		if (isSpam) d.spam += 1;
		byDate.set(day, d);
		const results = extractAuthenticationResults(row.raw_headers);
		for (const key of ["spf", "dkim", "dmarc"] as const) {
			// No header, or no verdict for this method: nothing was evaluated.
			const raw = results?.[key];
			const verdict = !raw || raw === "unknown" ? "none" : raw;
			auth[key][verdict] = (auth[key][verdict] ?? 0) + 1;
		}
	}
	return {
		stored: rows.length,
		spam_filed: spam,
		auth,
		by_date: [...byDate.entries()]
			.map(([date, v]) => ({ date, ...v }))
			.sort((a, b) => a.date.localeCompare(b.date)),
		capped: rows.length >= INBOUND_SCAN_LIMIT,
	};
}

export interface MailboxSendingStats {
	sent: number;
	delivered: number;
	bounced: number;
	failed: number;
	rejected: number;
	complaints: number;
	/** Cohort messages with no terminal verdict yet, plus scheduled sends. */
	pending: number;
	soft_bounced: number;
	errors: { cause: string; bucket: string | null; count: number; example: string | null; last_seen: string | null }[];
	by_date: { date: string; sent: number; delivered: number; bounced: number; failed: number }[];
}

/**
 * Ledger-based sending counts for the overview's app scope, in messages.
 * Each message's terminal verdict is its latest terminal event (failure wins a
 * tie). A complaint means the message reached the recipient, so here it counts
 * as delivered plus one complaint (complaint rate = complaints / delivered, as
 * Cloudflare computes it), unlike the reading-pane chip, which shows it as a
 * failure. Messages with only queued/sent/soft events are pending, never
 * delivered (the legacy route counted those as delivered, the 16-vs-13
 * discrepancy this replaces), unless they were opened or clicked: the same
 * `messageOutcome` rule as `getEngagement`, so both report the same delivered.
 */
export function getSendingStats(ctx: DurableObjectState, window: AnalyticsWindowInput): MailboxSendingStats {
	const cohort = ctx.storage.sql
		.exec(
			`SELECT e.id AS id, e.date AS date FROM emails e
			  WHERE e.date >= ?1 AND e.date <= ?2 AND e.imported = 0
			    AND (
			          e.folder_id = ?3
			          OR EXISTS (
			               SELECT 1 FROM delivery_events de
			                WHERE de.email_id = e.id AND de.event_type IN ('sent', 'queued')
			             )
			        )`,
			window.start,
			window.end,
			Folders.SENT,
		)
		.toArray() as unknown as { id: string; date: string }[];

	const scheduled = Number(
		(
			ctx.storage.sql
				.exec(`SELECT COUNT(*) AS n FROM emails WHERE folder_id = ?1`, Folders.SCHEDULED)
				.toArray()[0] as { n?: number } | undefined
		)?.n ?? 0,
	);

	const events = cohort.length
		? (ctx.storage.sql
				.exec(
					`SELECT de.email_id AS email_id, de.event_type AS event_type,
					        de.error_cause AS error_cause, de.error_detail AS error_detail,
					        de.occurred_at AS occurred_at
					   FROM delivery_events de
					   JOIN emails e ON e.id = de.email_id
					  WHERE e.date >= ?1 AND e.date <= ?2 AND e.imported = 0
					    AND de.event_type IN ('delivered', 'bounced', 'rejected', 'failed', 'complained', 'soft_bounced', 'opened', 'clicked')`,
					window.start,
					window.end,
				)
				.toArray() as unknown as {
				email_id: string;
				event_type: string;
				error_cause: string | null;
				error_detail: string | null;
				occurred_at: string;
			}[])
		: [];

	const dateOf = new Map(cohort.map((row) => [row.id, (row.date ?? "").slice(0, 10)]));
	const latest = new Map<string, (typeof events)[number]>();
	const soft = new Set<string>();
	const engaged = new Set<string>();
	const complained = new Set<string>();
	for (const event of events) {
		if (!dateOf.has(event.email_id)) continue;
		if (event.event_type === "soft_bounced") {
			soft.add(event.email_id);
			continue;
		}
		if (event.event_type === "opened" || event.event_type === "clicked") {
			engaged.add(event.email_id);
			continue;
		}
		if (event.event_type === "complained") complained.add(event.email_id);
		const cur = latest.get(event.email_id);
		if (
			!cur ||
			event.occurred_at > cur.occurred_at ||
			(event.occurred_at === cur.occurred_at && cur.event_type === "delivered" && event.event_type !== "delivered")
		) {
			latest.set(event.email_id, event);
		}
	}

	const stats: MailboxSendingStats = {
		sent: cohort.length,
		delivered: 0,
		bounced: 0,
		failed: 0,
		rejected: 0,
		complaints: complained.size,
		pending: scheduled,
		soft_bounced: 0,
		errors: [],
		by_date: [],
	};
	const byDate = new Map<string, { sent: number; delivered: number; bounced: number; failed: number }>();
	const errors = new Map<string, MailboxSendingStats["errors"][number]>();
	for (const row of cohort) {
		const day = dateOf.get(row.id) ?? "";
		const d = byDate.get(day) ?? { sent: 0, delivered: 0, bounced: 0, failed: 0 };
		d.sent += 1;
		const verdict = latest.get(row.id);
		if (!verdict && messageOutcome(undefined, engaged.has(row.id)) === "pending") {
			stats.pending += 1;
			if (soft.has(row.id)) stats.soft_bounced += 1;
		} else if (!verdict || verdict.event_type === "delivered") {
			// No verdict but opened/clicked: delivered (messageOutcome), as in getEngagement.
			stats.delivered += 1;
			d.delivered += 1;
		} else {
			if (verdict.event_type === "bounced") {
				stats.bounced += 1;
				d.bounced += 1;
			} else if (verdict.event_type === "rejected") {
				stats.rejected += 1;
				d.failed += 1;
			} else if (verdict.event_type === "failed") {
				stats.failed += 1;
				d.failed += 1;
			} else {
				// complained: counted in `complaints`; not a send failure.
				stats.delivered += 1;
				d.delivered += 1;
			}
			if (verdict.event_type !== "complained") {
				const cause = verdict.event_type;
				const key = `${cause}|${verdict.error_cause ?? ""}`;
				const e = errors.get(key) ?? { cause, bucket: verdict.error_cause, count: 0, example: null, last_seen: null };
				e.count += 1;
				if (!e.last_seen || verdict.occurred_at > e.last_seen) {
					e.last_seen = verdict.occurred_at;
					e.example = verdict.error_detail ?? e.example;
				}
				errors.set(key, e);
			}
		}
		byDate.set(day, d);
	}
	stats.errors = [...errors.values()].sort((a, b) => b.count - a.count);
	stats.by_date = [...byDate.entries()]
		.map(([date, v]) => ({ date, ...v }))
		.sort((a, b) => a.date.localeCompare(b.date));
	return stats;
}
