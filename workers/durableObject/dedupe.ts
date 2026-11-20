// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Duplicate-delivery detection for inbound mail.
 *
 * ## The problem this solves
 *
 * Cloudflare retries the `email()` handler when it throws — deliberately, so a
 * transient failure does not silently drop mail. But the handler mints a fresh
 * `crypto.randomUUID()` as the row's primary key on every attempt, so the second
 * delivery of the same message looked like an entirely different one. Anything
 * that threw *after* the insert stored the message twice, and there were two
 * unwrapped `await`s sitting in exactly that window (the `listMailboxes` calls
 * feeding the forwarding and auto-reply loop guards).
 *
 * The sender's `Message-ID` is the only identifier stable across attempts, so
 * that is what identity is keyed on. Backed by `idx_emails_message_id` from
 * migration 21.
 *
 * Deliberately *not* a UNIQUE constraint. Rows violating it may already exist
 * from before this check, and a migration that fails throws out of the Durable
 * Object constructor — which makes the mailbox permanently unreachable rather
 * than merely leaving a duplicate in it. Enforcing this in the handler means a
 * duplicate can be reported and skipped instead of crashing.
 *
 * Plain function over `DurableObjectState`, matching ./trash.ts and
 * ./rate-limit.ts, so it is testable without standing up a Durable Object.
 */

import { Folders } from "../../shared/folders";

/**
 * Whether an inbound copy of this `Message-ID` is already stored.
 *
 * A blank or missing id returns false: such a message cannot be deduplicated
 * this way, and refusing to store it would lose mail — which is strictly worse
 * than storing it twice.
 *
 * ## Why Sent is excluded
 *
 * Every send path stores its own copy in Sent with `message_id` set to the id it
 * put on the wire. Matching against those would make the check fire on mail that
 * is not a duplicate at all:
 *
 * - a message addressed to your own mailbox, which Email Routing delivers back
 * - a mailing list echoing your own post to subscribers with the id preserved
 *
 * Both would be discarded with nothing but a log line to show for it — the exact
 * data loss this function exists to prevent, arrived at from the other side. The
 * scope is inbound copies only, so Sent is skipped.
 *
 * Other folders are deliberately in scope: rules and spam scoring file mail out
 * of the inbox *before* it is stored, so restricting this to the inbox would
 * miss those and duplicate them.
 */
export function hasMessageId(
	ctx: DurableObjectState,
	messageId: string | null | undefined,
): boolean {
	const needle = (messageId ?? "").trim();
	if (!needle) return false;

	const rows = ctx.storage.sql
		.exec(
			`SELECT 1 FROM emails
			  WHERE message_id = ?1 AND folder_id != ?2
			  LIMIT 1`,
			needle,
			Folders.SENT,
		)
		.toArray();

	return rows.length > 0;
}
