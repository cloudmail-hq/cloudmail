// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared types and Zod schemas for email data.
 *
 * Types (from email-types.ts): used by the agent, MCP server, and route
 * handlers to avoid `as any` casting.
 *
 * Zod schemas: used across route handlers to eliminate duplication.
 */
import { z } from "zod";
import {
	blockedAttachmentMessage,
	isBlockedAttachment,
} from "../../shared/attachment-types";

// ── TypeScript Interfaces ──────────────────────────────────────────

export interface EmailMetadata {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	read: boolean;
	starred: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	folder_id?: string | null;
	snippet?: string | null;
}

export interface EmailFull extends EmailMetadata {
	body?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	attachments?: AttachmentInfo[];
}

export interface AttachmentInfo {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

// ── Zod Schemas ────────────────────────────────────────────────────

const RecipientFieldSchema = z.union([
	z.string().email(),
	z.array(z.string().email()).min(1),
]);

export const ErrorResponseSchema = z.object({
	error: z.string(),
});

/**
 * One attachment on an outbound message or a draft.
 *
 * Shared by the send, schedule and draft routes so a file that can be sent can
 * also be saved to a draft. When these drifted, drafts accepted no attachments
 * at all and dropped whatever the composer had staged.
 */
export const AttachmentPayloadSchema = z.object({
	content: z.string(), // base64 encoded
	/**
	 * Refused here rather than at each send route.
	 *
	 * There are four paths a message can leave by — the send route, the scheduled
	 * send that backs Undo, reply/forward, and the agent's tools — and they all
	 * parse this schema. A check in one of them is a check three paths do not have,
	 * which is the shape this codebase has already been bitten by. Putting it on
	 * the schema means the answer to "which sends are covered" is "all of them, by
	 * construction".
	 *
	 * A refusal is a 400 naming the file, because the person composing can fix it
	 * and needs to know which attachment to remove.
	 */
	filename: z.string().refine((name) => !isBlockedAttachment(name), (name) => ({
		message: blockedAttachmentMessage([name]),
	})),
	type: z.string(),
	disposition: z.enum(["attachment", "inline"]),
	contentId: z.string().optional(),
});

export const SendEmailRequestSchema = z
	.object({
		to: RecipientFieldSchema,
		cc: RecipientFieldSchema.optional(),
		bcc: RecipientFieldSchema.optional(),
		from: z.union([
			z.string().email(),
			z.object({ email: z.string().email(), name: z.string() }),
		]),
		subject: z.string(),
		html: z.string().optional(),
		text: z.string().optional(),
		attachments: AttachmentPayloadSchema.array().optional(),
		in_reply_to: z.string().optional(),
		references: z.array(z.string()).optional(),
		thread_id: z.string().optional(),
		/**
		 * `false` marks bulk/marketing mail: suppressed recipients are dropped and
		 * a single-recipient send gets RFC 8058 unsubscribe headers. Defaults to
		 * transactional, which is what every existing caller means. Honoured by
		 * `POST /emails`; see `workers/lib/send-compliance.ts`.
		 */
		transactional: z.boolean().optional(),
		/** Shorthand for `transactional: false`: this is list mail. */
		list: z.boolean().optional(),
		/**
		 * `false` sends this one message without open/click tracking, whatever the
		 * mailbox setting ("Don't track this message"). Absent or `true` follows
		 * the mailbox. `true` cannot turn tracking on for a mailbox that has it
		 * off, or for a recipient who opted out.
		 */
		track: z.boolean().optional(),
	})
	.refine((data) => data.html || data.text, {
		message: "Either 'html' or 'text' must be provided",
	});

export const SendEmailResponseSchema = z.object({
	id: z.string(),
	status: z.string(),
});
