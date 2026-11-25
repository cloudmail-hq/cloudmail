/**
 * Conditional responses for the `/state` poll.
 *
 * The UI polls `/api/v1/mailboxes/:id/state` every few seconds. The answer
 * changes only when a message is written, and the Durable Object's `version`
 * counter is bumped by a trigger on every insert, update and delete of
 * `emails` (migration 19), so it identifies the answer exactly. The unread
 * figures are folded into the tag anyway, so it stays correct even if a future
 * change moves them off that table.
 *
 * `private, no-cache` rather than the old `no-store`: the browser keeps the
 * body and revalidates every time (`no-cache` never serves without asking), so
 * an unchanged poll is a bodiless 304 and the client code is unchanged —
 * `fetch` hands it the cached 200. `private` keeps shared caches out of it.
 */

import type { Context } from "hono";

export interface MailboxStateBody {
	version: number;
	inboxUnread: number;
	inboxUnreadHighPriority: number;
}

/** Weak validator for a state snapshot. */
export function stateEtag(state: MailboxStateBody): string {
	return `W/"s${state.version}-${state.inboxUnread}-${state.inboxUnreadHighPriority}"`;
}

/**
 * Whether an `If-None-Match` header matches `etag`, using the weak comparison
 * RFC 9110 prescribes for it (the `W/` prefix is ignored on both sides).
 */
export function etagMatches(ifNoneMatch: string | undefined | null, etag: string): boolean {
	if (!ifNoneMatch) return false;
	const strip = (t: string) => t.trim().replace(/^W\//, "");
	const target = strip(etag);
	return ifNoneMatch.split(",").some((t) => t.trim() === "*" || strip(t) === target);
}

export function stateResponse(c: Context, state: MailboxStateBody): Response {
	const etag = stateEtag(state);
	c.header("Cache-Control", "private, no-cache");
	c.header("ETag", etag);
	if (etagMatches(c.req.header("if-none-match"), etag)) {
		return c.body(null, 304);
	}
	return c.json(state);
}
