// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Destroy a mailbox and everything that belongs to it.
 *
 * Shared by `DELETE /api/v1/mailboxes/:id` and by agent inboxes (early delete
 * and TTL expiry), so every path that ends a mailbox cleans up the same things
 * in the same order.
 *
 * Order matters. The settings object is the existence check used by
 * `requireMailbox` and by the inbound email handler, so it is removed last: if
 * a step fails the mailbox still resolves and the delete can be retried,
 * rather than leaving unreachable data behind forever.
 */

import type { Env } from "../types";
import { listAuditKeysForMailbox } from "./audit";
import { revokeMailboxFromGrants } from "./authz";
import { forgetMailboxExists } from "./mailbox-exists";
import { forgetMailboxRouting } from "../routes/domains";
import { listAllKeys } from "./r2";

/** R2 accepts at most 1000 keys per bulk delete call. */
export const R2_DELETE_BATCH_SIZE = 1000;

async function deleteInBatches(bucket: R2Bucket, keys: string[]): Promise<void> {
	for (let i = 0; i < keys.length; i += R2_DELETE_BATCH_SIZE) {
		await bucket.delete(keys.slice(i, i + R2_DELETE_BATCH_SIZE));
	}
}

/**
 * Everything except the audit entry: the caller records that, with its own
 * actor, before calling {@link purgeMailboxAuditLog}.
 */
export async function purgeMailbox(env: Env, mailboxId: string): Promise<void> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	const attachmentKeys = await (stub as unknown as { purge: () => Promise<string[]> }).purge();
	await forgetMailboxRouting(env, mailboxId);
	await deleteInBatches(env.BUCKET, attachmentKeys);
	// Import uploads and IMAP passwords of jobs that had not finished. See ./mail-import.ts.
	try {
		await deleteInBatches(env.BUCKET, await listAllKeys(env.BUCKET, `imports/${mailboxId.toLowerCase()}/`));
		const ns = env.AUTH_STORE as unknown as DurableObjectNamespace<
			import("../auth/store").AuthDO
		>;
		await ns.get(ns.idFromName("global")).deleteImportCredentialsForMailbox(mailboxId);
	} catch (e) {
		console.error(`Failed to clean up imports for ${mailboxId}:`, (e as Error).message);
	}

	// Chat history lives in a separate Durable Object and would otherwise
	// survive, and be visible again if the same address were re-created.
	try {
		const agentStub = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxId));
		await (agentStub as unknown as { purge: () => Promise<void> }).purge();
	} catch (e) {
		// A mailbox that never invoked the agent may have no usable instance.
		console.error(`Failed to purge agent history for ${mailboxId}:`, (e as Error).message);
	}

	/**
	 * Drop this address from every grant that named it, so re-creating the
	 * address does not silently restore everyone's access. Logged rather than
	 * thrown: a stale grant naming a missing mailbox is inert.
	 */
	try {
		const cleaned = await revokeMailboxFromGrants(env.BUCKET, mailboxId);
		if (cleaned > 0) console.log(`Removed ${mailboxId} from ${cleaned} access grant(s)`);
	} catch (e) {
		console.error(`Failed to clean access grants for ${mailboxId}:`, (e as Error).message);
	}

	await env.BUCKET.delete(`mailboxes/${mailboxId}.json`);
	// This isolate stops admitting reads now; others within MAILBOX_EXISTS_TTL_MS.
	forgetMailboxExists(mailboxId);
}

/**
 * Destroy the mailbox's own audit log. Run after the deletion entry is written
 * to the instance scope, which survives, so a re-created address does not
 * inherit activity that never happened in it. Never throws.
 */
export async function purgeMailboxAuditLog(bucket: R2Bucket, mailboxId: string): Promise<void> {
	try {
		await deleteInBatches(bucket, await listAuditKeysForMailbox(bucket, mailboxId));
	} catch (e) {
		console.error(`Failed to clean the audit log for ${mailboxId}:`, (e as Error).message);
	}
}
