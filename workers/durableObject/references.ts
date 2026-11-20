// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Resolving a reference to a message.
 *
 * ## Why a reference is not just an id
 *
 * `emails.in_reply_to` names the message a reply answers, but the value is not
 * drawn from one namespace. Four write paths store the parent's RFC
 * `Message-ID` — inbound delivery, the reply and forward routes, the
 * scheduled-send path, and the agent's auto-reply — while three store our own row
 * UUID: the composer's draft saves, `draft_reply`, and the auto-drafter.
 *
 * Both are defensible. The column has always meant "the parent", and for mail
 * that arrived from outside, the only identifier we have for the parent *is* its
 * `Message-ID`. What was not defensible was resolving the column with a row-id
 * lookup alone, which quietly worked or failed depending on which path had
 * written the row in hand.
 *
 * The case that made it visible: cancelling Undo Send demotes the queued message
 * back into Drafts, and the send path wrote that row, so its `in_reply_to` is a
 * `Message-ID`. Sending the draft again then looked that up as a row id, missed,
 * and either detached the reply from its conversation or failed the send outright
 * with "Original email not found".
 *
 * `findThreadByMessageIds` already resolves inbound citations the same way
 * (`WHERE message_id IN (…) OR id IN (…)`) for the same reason. This module is
 * the per-message counterpart: that one answers "which thread", this one answers
 * "which message".
 *
 * Plain function over `DurableObjectState`, matching ./trash.ts and ./dedupe.ts,
 * so it is testable without standing up a Durable Object. `MailboxDO.getEmailByRef`
 * is the thin delegate, because only class methods are reachable over RPC.
 */

/**
 * The row id of the message carrying this `Message-ID`, or null.
 *
 * ## Why the newest wins
 *
 * `message_id` is indexed but deliberately not UNIQUE — see ./dedupe.ts: rows
 * violating it may predate the duplicate check, and a migration that fails throws
 * out of the Durable Object constructor and makes the mailbox permanently
 * unreachable. So duplicates are possible, and the tie-break has to be
 * deterministic rather than left to whatever the index returns.
 *
 * Newest-first is the right choice for threading: if the same `Message-ID` really
 * does appear twice, a reply belongs on the most recent copy. `id` breaks a tie on
 * identical dates so the result is stable across calls.
 *
 * A blank reference returns null rather than matching rows with a NULL
 * `message_id`, which would otherwise let a draft with no parent resolve to an
 * arbitrary message.
 */
export function findIdByMessageId(
	ctx: DurableObjectState,
	messageId: string | null | undefined,
): string | null {
	const needle = (messageId ?? "").trim();
	if (!needle) return null;

	const row = ctx.storage.sql
		.exec(
			`SELECT id FROM emails
			  WHERE message_id = ?1
			  ORDER BY date DESC, id DESC
			  LIMIT 1`,
			needle,
		)
		.toArray()[0] as { id: string } | undefined;

	return row?.id ?? null;
}

/**
 * The local thread an inbound message joins, from the ids it cites.
 *
 * `candidates` are the `In-Reply-To` and `References` ids, nearest ancestor
 * first, already bounded by the caller. A citation can match either the RFC
 * `Message-ID` we store for a message (for mail we sent, the id Cloudflare
 * assigned and `recordDelivery` wrote back) or a row id. The caller's
 * preference order wins over whatever order the index returns, so a reply
 * threads onto its closest known ancestor.
 *
 * Extracted from `MailboxDO.findThreadByMessageIds` so the join that makes a
 * Gmail reply land in our conversation runs against real SQLite in tests.
 */
export function findThreadByMessageIds(
	ctx: DurableObjectState,
	candidates: string[],
): string | null {
	const ids = candidates
		.map((c) => (c ?? "").trim().replace(/^<|>$/g, ""))
		.filter(Boolean);
	if (ids.length === 0) return null;

	const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
	const rows = ctx.storage.sql
		.exec(
			`SELECT id, message_id, thread_id FROM emails
			  WHERE message_id IN (${placeholders}) OR id IN (${placeholders})`,
			...ids,
		)
		.toArray() as { id: string; message_id: string | null; thread_id: string | null }[];

	if (rows.length === 0) return null;
	for (const candidate of ids) {
		const hit = rows.find((r) => r.message_id === candidate || r.id === candidate);
		if (hit) return String(hit.thread_id || hit.id);
	}
	return null;
}
