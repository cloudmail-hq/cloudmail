// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Every POST route that honours `Idempotency-Key`. One list read by the
 * middleware mounts (./idempotency.ts) and the OpenAPI document (./openapi.ts),
 * so the two cannot disagree.
 */

/** Per-mailbox sends and creates; keys live in the mailbox's MailboxDO. */
export const MAILBOX_IDEMPOTENT_PATHS = [
	"/api/v1/mailboxes/:mailboxId/emails",
	"/api/v1/mailboxes/:mailboxId/emails/:id/reply",
	"/api/v1/mailboxes/:mailboxId/emails/:id/forward",
	"/api/v1/mailboxes/:mailboxId/drafts",
	"/api/v1/mailboxes/:mailboxId/scheduled-sends",
	"/api/v1/mailboxes/:mailboxId/scheduled-sends/:emailId/send-now",
	"/api/v1/mailboxes/:mailboxId/template-sends",
	"/api/v1/mailboxes/:mailboxId/emails/:id/followup",
	"/api/v1/mailboxes/:mailboxId/emails/:id/followup/cancel",
	"/api/v1/mailboxes/:mailboxId/screener/:sender",
	// Approving sends a held message; a retried approve must not send twice.
	"/api/v1/mailboxes/:mailboxId/approvals/:id/approve",
	// A retried create must not start a second import (or a second upload).
	"/api/v1/mailboxes/:mailboxId/imports",
] as const;

/** Instance-level creates; keys live in the global AuthDO. */
export const INSTANCE_IDEMPOTENT_PATHS = [
	"/api/v1/mailboxes",
	"/api/v1/webhooks",
	"/api/v1/domains",
	"/api/v1/suppressions",
	"/api/v1/sequences/:id/enroll",
	"/api/v1/agent-inboxes",
	// A retried create must not add the gateway twice. Only a hash of the
	// body (which holds the token) is kept; the stored response never has one.
	"/api/v1/ai/providers",
] as const;

export const IDEMPOTENT_PATHS: ReadonlySet<string> = new Set([
	...MAILBOX_IDEMPOTENT_PATHS,
	...INSTANCE_IDEMPOTENT_PATHS,
]);
