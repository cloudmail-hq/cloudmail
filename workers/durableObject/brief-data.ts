// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * One mailbox's contribution to a daily brief.
 *
 * Read-only SQL over this mailbox's tables; assembly, grouping and rendering
 * are in `shared/daily-brief.ts`.
 *
 * ## "Waiting on others"
 *
 * The follow-up reminders feature (built in parallel) records outbound mail that
 * expects a reply. When its table exists (`followups` with `email_id` and a
 * pending status), that is the source of truth: it knows which sends the user
 * actually asked to chase. Otherwise the list is derived: conversations whose
 * latest countable message is one this mailbox sent, between
 * `WAITING_GRACE_HOURS` and `WAITING_WINDOW_DAYS` old, excluding sends that
 * were themselves bulk or automated.
 */

import { Folders } from "../../shared/folders";
import { parseStoredHeaders } from "../../shared/headers";
import { isBulkMail } from "../../shared/ai-summary";
import {
	BRIEF_SECTION_LIMIT,
	WAITING_GRACE_HOURS,
	WAITING_WINDOW_DAYS,
	type BriefMessageRow,
	type BriefThreadRow,
	type MailboxBriefData,
} from "../../shared/daily-brief";
import { THREAD_KEY_SQL, summaryLinesFor } from "./summaries";

/** New-message rows read per brief. Counts above this are reported as truncated. */
export const BRIEF_NEW_ROW_CAP = 200;

const EXCLUDED = [Folders.DRAFT, Folders.SCHEDULED, Folders.TRASH, Folders.SPAM].map((f) => `'${f}'`).join(", ");

function tableColumns(ctx: DurableObjectState, table: string): Set<string> {
	try {
		return new Set(
			(ctx.storage.sql.exec(`SELECT name FROM pragma_table_info(?1)`, table).toArray() as { name: string }[]).map(
				(r) => r.name,
			),
		);
	} catch {
		return new Set();
	}
}

interface RawNew {
	id: string;
	thread_id: string | null;
	subject: string | null;
	sender: string | null;
	sender_name: string | null;
	date: string;
	read: number;
	starred: number;
	priority: string | null;
	raw_headers: string | null;
}

function newMessages(ctx: DurableObjectState, sinceIso: string, untilIso: string): { rows: BriefMessageRow[]; truncated: boolean } {
	const raw = ctx.storage.sql
		.exec(
			`SELECT id, thread_id, subject, sender, sender_name, date, read, starred, priority, raw_headers
			   FROM emails
			  WHERE folder_id = ?1 AND date > ?2 AND date <= ?3 AND imported = 0
			  ORDER BY date DESC
			  LIMIT ?4`,
			Folders.INBOX,
			sinceIso,
			untilIso,
			BRIEF_NEW_ROW_CAP + 1,
		)
		.toArray() as unknown as RawNew[];
	const truncated = raw.length > BRIEF_NEW_ROW_CAP;
	const rows = raw.slice(0, BRIEF_NEW_ROW_CAP);
	const lines = summaryLinesFor(ctx, rows.map((r) => r.thread_id ?? r.id));
	return {
		truncated,
		rows: rows.map((r) => {
			const s = lines.get(r.thread_id ?? r.id);
			return {
				id: r.id,
				thread_id: r.thread_id,
				subject: r.subject,
				sender: r.sender,
				sender_name: r.sender_name,
				date: r.date,
				read: !!r.read,
				starred: !!r.starred,
				priority: r.priority,
				bulk: isBulkMail(parseStoredHeaders(r.raw_headers), r.sender),
				summary_line: s && s.status === "ok" ? s.line : null,
			};
		}),
	};
}

function withSummaries(ctx: DurableObjectState, rows: BriefThreadRow[]): BriefThreadRow[] {
	const lines = summaryLinesFor(ctx, rows.map((r) => r.thread_id ?? r.id));
	return rows.map((r) => {
		const s = lines.get(r.thread_id ?? r.id);
		return { ...r, summary_line: s && s.status === "ok" ? s.line : null };
	});
}

/** From the follow-up feature's table, or null when it does not exist here. */
function waitingFromFollowups(ctx: DurableObjectState): BriefThreadRow[] | null {
	const cols = tableColumns(ctx, "followups");
	if (!cols.has("email_id")) return null;
	// Migration 32's lifecycle: `pending` is still waiting, `fired` came due
	// with no reply (still waiting, now surfaced); replied/done/cancelled are not.
	const pending = cols.has("status") ? `AND f.status IN ('pending', 'fired')` : "";
	try {
		const rows = ctx.storage.sql
			.exec(
				`SELECT e.id, e.thread_id, e.subject, e.recipient AS who, e.date
				   FROM followups f JOIN emails e ON e.id = f.email_id
				  WHERE e.folder_id NOT IN (${EXCLUDED}) ${pending}
				  ORDER BY e.date DESC
				  LIMIT ?1`,
				BRIEF_SECTION_LIMIT * 4,
			)
			.toArray() as { id: string; thread_id: string | null; subject: string | null; who: string | null; date: string }[];
		return rows.map((r) => ({ ...r, who: firstAddress(r.who), who_name: null, summary_line: null }));
	} catch {
		return null;
	}
}

/** Threads whose only follow-up rows are finished. */
function resolvedFollowupThreads(ctx: DurableObjectState): string[] {
	if (!tableColumns(ctx, "followups").has("thread_id")) return [];
	try {
		return (
			ctx.storage.sql
				.exec(
					`SELECT thread_id FROM followups
					  GROUP BY thread_id
					 HAVING SUM(CASE WHEN status IN ('pending', 'fired') THEN 1 ELSE 0 END) = 0`,
				)
				.toArray() as { thread_id: string }[]
		).map((r) => r.thread_id);
	} catch {
		return [];
	}
}

function firstAddress(list: string | null): string | null {
	return list?.split(",")[0]?.trim() || null;
}

/** Derived: conversations whose newest countable message is ours, aged into the window. */
function waitingDerived(ctx: DurableObjectState, now: number): BriefThreadRow[] {
	const newest = new Date(now - WAITING_GRACE_HOURS * 3_600_000).toISOString();
	const oldest = new Date(now - WAITING_WINDOW_DAYS * 86_400_000).toISOString();
	const rows = ctx.storage.sql
		.exec(
			`WITH latest AS (
				SELECT id, thread_id, subject, recipient, date, folder_id, raw_headers, sender,
				       ROW_NUMBER() OVER (PARTITION BY ${THREAD_KEY_SQL} ORDER BY date DESC, id DESC) AS rn
				  FROM emails
				 WHERE folder_id NOT IN (${EXCLUDED})
			)
			SELECT id, thread_id, subject, recipient, date, raw_headers, sender
			  FROM latest
			 WHERE rn = 1 AND folder_id = ?1 AND date <= ?2 AND date >= ?3
			 ORDER BY date DESC
			 LIMIT ?4`,
			Folders.SENT,
			newest,
			oldest,
			BRIEF_SECTION_LIMIT * 4,
		)
		.toArray() as {
		id: string;
		thread_id: string | null;
		subject: string | null;
		recipient: string | null;
		date: string;
		raw_headers: string | null;
		sender: string | null;
	}[];
	return rows
		.filter((r) => !isBulkMail(parseStoredHeaders(r.raw_headers), null))
		.map((r) => ({
			id: r.id,
			thread_id: r.thread_id,
			subject: r.subject,
			who: firstAddress(r.recipient),
			who_name: null,
			date: r.date,
			summary_line: null,
		}));
}

export function collectBriefData(
	ctx: DurableObjectState,
	input: {
		mailbox: string;
		since: string;
		until: string;
		now?: number;
		/** Inbox conversations flagged `needs_reply` by the threaded list. */
		needsReply: { id: string; thread_id: string | null; subject: string | null; sender: string | null; sender_name: string | null; date: string }[];
	},
): MailboxBriefData {
	const now = input.now ?? Date.now();
	const fresh = newMessages(ctx, input.since, input.until);
	// Reminders the user set come first (they asked to chase those); derived
	// "our message is the latest" threads fill in the rest, one row per thread.
	const fromFollowups = waitingFromFollowups(ctx) ?? [];
	// Threads the reminder feature has already ruled on (replied, dismissed,
	// cancelled) are not re-derived: it knows about replies the derivation
	// cannot see, such as one filed by a rule.
	const seen = new Set([...fromFollowups.map((r) => r.thread_id ?? r.id), ...resolvedFollowupThreads(ctx)]);
	const derived = waitingDerived(ctx, now).filter((r) => !seen.has(r.thread_id ?? r.id));
	const waiting = [...fromFollowups, ...derived];
	const waitingSource: MailboxBriefData["waitingSource"] =
		fromFollowups.length > 0 ? (derived.length > 0 ? "mixed" : "followups") : "derived";
	return {
		mailbox: input.mailbox,
		newMessages: fresh.rows,
		newTruncated: fresh.truncated,
		needsReply: withSummaries(
			ctx,
			input.needsReply.map((r) => ({
				id: r.id,
				thread_id: r.thread_id,
				subject: r.subject,
				who: r.sender,
				who_name: r.sender_name,
				date: r.date,
				summary_line: null,
			})),
		),
		waitingOn: withSummaries(ctx, waiting),
		waitingSource,
	};
}
