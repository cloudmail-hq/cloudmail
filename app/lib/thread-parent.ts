// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Finding the message a draft is answering.
 *
 * `in_reply_to` names the parent, but not always in the same terms. Four write
 * paths store the parent's RFC `Message-ID` — inbound delivery, the reply and
 * forward routes, the scheduled-send path and the agent's auto-reply — while
 * three store our own row UUID: the composer's draft saves, `draft_reply` and
 * the auto-drafter. Matching on `id` alone therefore worked or silently failed
 * depending on which path had written the draft in front of you.
 *
 * The case that made it visible: cancelling Undo Send drops the queued message
 * back into Drafts with an RFC-form `in_reply_to`. Reopening that draft found no
 * parent, so Edit opened a reply composer with nothing to reply to and Send
 * posted the Message-ID where a row id was expected — which came back as
 * "Original email not found".
 *
 * Kept as its own module so the reading pane and the composer cannot drift on
 * the answer, and so the precedence is pinned by tests.
 */

/** The fields this needs; `Email` satisfies it, and so does a list projection. */
export interface ThreadParentCandidate {
	id: string;
	message_id?: string | null;
	date?: string | null;
}

/**
 * The message `ref` points at, or undefined.
 *
 * Row id wins over `message_id`, matching the server's `getEmailByRef`: ids are
 * unique by construction, while `message_id` carries whatever the counterparty
 * sent and is not enforced unique by an index — see workers/durableObject/dedupe.ts
 * for why that index cannot be made UNIQUE.
 *
 * Because duplicates are therefore possible, the tie-break has to match the
 * server's too: newest by `date`, then by `id` descending. It previously took
 * whichever came first in the array, which is ascending by id — so with two
 * same-dated duplicates the client resolved to one row and `findIdByMessageId`
 * to the other. This function's whole purpose is to agree with the server, so a
 * divergence here would make its own contract false.
 */
export function findThreadParent<T extends ThreadParentCandidate>(
	messages: readonly T[],
	ref: string | null | undefined,
): T | undefined {
	if (!ref) return undefined;

	const byId = messages.find((m) => m.id === ref);
	if (byId) return byId;

	const byMessageId = messages.filter(
		(m) => !!m.message_id && m.message_id === ref,
	);
	if (byMessageId.length <= 1) return byMessageId[0];

	// `ORDER BY date DESC, id DESC LIMIT 1`, in the one place the server cannot
	// answer for us.
	return [...byMessageId].sort((a, b) => {
		const byDate = (b.date ?? "").localeCompare(a.date ?? "");
		return byDate !== 0 ? byDate : b.id.localeCompare(a.id);
	})[0];
}

/**
 * What to hand the server as `reply_to_email_id` for a draft.
 *
 * Prefers the row id of a parent we can see, and otherwise passes the raw
 * reference through for the server to resolve. The fallback matters because the
 * loaded thread is capped (`MAX_THREAD_MESSAGES`): in a long conversation the
 * parent may simply not be in the window, and returning nothing there meant the
 * reply went out with no `In-Reply-To` and no `References` and started a fresh
 * conversation in the recipient's client. The draft has always known its parent;
 * only this lookup did not.
 */
export function replyTargetForDraft<T extends ThreadParentCandidate>(
	messages: readonly T[],
	draft: { in_reply_to?: string | null },
): string | undefined {
	if (!draft.in_reply_to) return undefined;
	return findThreadParent(messages, draft.in_reply_to)?.id ?? draft.in_reply_to;
}
