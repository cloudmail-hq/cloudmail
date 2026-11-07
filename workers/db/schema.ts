// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const folders = sqliteTable("folders", {
	id: text("id").primaryKey(),
	name: text("name").notNull().unique(),
	is_deletable: integer("is_deletable").notNull().default(1),
});

export const emails = sqliteTable("emails", {
	id: text("id").primaryKey(),
	folder_id: text("folder_id")
		.notNull()
		.references(() => folders.id, { onDelete: "cascade" }),
	subject: text("subject"),
	sender: text("sender"),
	recipient: text("recipient"),
	cc: text("cc"),
	bcc: text("bcc"),
	date: text("date"),
	read: integer("read").default(0),
	starred: integer("starred").default(0),
	body: text("body"),
	in_reply_to: text("in_reply_to"),
	email_references: text("email_references"),
	thread_id: text("thread_id"),
	message_id: text("message_id"),
	raw_headers: text("raw_headers"),
	/** ISO timestamp at which a snoozed message returns (migration 11). */
	snoozed_until: text("snoozed_until"),
	/** Folder to restore to when the snooze expires (migration 11). */
	snooze_return_folder: text("snooze_return_folder"),
	/** "high" | "low"; NULL means normal priority (migration 11). */
	priority: text("priority"),
	/** Folder this message was in before it was binned (migration 14). */
	trashed_from: text("trashed_from"),
	/** ISO timestamp of when it was binned; NULL unless it is in Trash. */
	trashed_at: text("trashed_at"),
	/**
	 * Heuristic spam score at delivery (migration 20). NULL for messages that
	 * were never scored: anything this app sent, and mail received before spam
	 * filtering existed.
	 */
	spam_score: real("spam_score"),
	/** JSON array of `{id, label}` explaining the score (migration 20). */
	spam_signals: text("spam_signals"),
	/** JSON array of reader warnings, see `shared/sender-warnings` (migration 31). */
	security_warnings: text("security_warnings"),
	/**
	 * Why this message never got where it was going (migration 22).
	 *
	 * `"failed"` — this app could not hand it to the provider, after exhausting
	 * the scheduled-send retries. `"bounced"` — the provider accepted it and a
	 * remote server then rejected it, reported back by a DSN. NULL is the normal
	 * case: nothing is known to have gone wrong.
	 */
	delivery_status: text("delivery_status"),
	/** Human-readable reason for `delivery_status`, capped at 500 chars. */
	delivery_error: text("delivery_error"),
	/**
	 * Plain-text preview, computed from `body` by `shared/plain-snippet.ts`
	 * (migration 26). NULL until computed; readers fall back to the old
	 * `SUBSTR(body, 1, 300)` via `derived.snippetSql`.
	 */
	snippet: text("snippet"),
	/** The sender's display name, from `From:` or the mailbox's send name. */
	sender_name: text("sender_name"),
	/** Derivation version that produced `snippet` / `sender_name`; 0 = pending. */
	derived_v: integer("derived_v").notNull().default(0),
	/**
	 * Engagement cache (migration 28), recomputed from `delivery_events` by
	 * `workers/durableObject/engagement.ts` whenever an open or click lands.
	 */
	opened_at: text("opened_at"),
	last_opened_at: text("last_opened_at"),
	open_count: integer("open_count").notNull().default(0),
	/** Opens fetched by a known mail-privacy proxy (Apple MPP, Gmail, …). */
	open_proxy_count: integer("open_proxy_count").notNull().default(0),
	clicked_at: text("clicked_at"),
	click_count: integer("click_count").notNull().default(0),
	/** 1 once the cache has been computed from the ledger; 0 = pending. */
	engagement_v: integer("engagement_v").notNull().default(0),
});

export const attachments = sqliteTable("attachments", {
	id: text("id").primaryKey(),
	email_id: text("email_id")
		.notNull()
		.references(() => emails.id, { onDelete: "cascade" }),
	filename: text("filename").notNull(),
	mimetype: text("mimetype").notNull(),
	size: integer("size").notNull(),
	content_id: text("content_id"),
	disposition: text("disposition"),
	/** 1 when the part was refused and no blob written (migration 23). */
	blocked: integer("blocked").notNull().default(0),
});

export const labels = sqliteTable("labels", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	color: text("color").notNull().default("#6b7280"),
	parent_id: text("parent_id"),
	sort_order: integer("sort_order").notNull().default(0),
	created_at: text("created_at"),
});

export const emailLabels = sqliteTable("email_labels", {
	email_id: text("email_id")
		.notNull()
		.references(() => emails.id, { onDelete: "cascade" }),
	label_id: text("label_id")
		.notNull()
		.references(() => labels.id, { onDelete: "cascade" }),
	created_at: text("created_at"),
});

export const signatures = sqliteTable("signatures", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	body_html: text("body_html").notNull(),
	is_default: integer("is_default").notNull().default(0),
	created_at: text("created_at"),
	updated_at: text("updated_at"),
});

export const scheduledSends = sqliteTable("scheduled_sends", {
	email_id: text("email_id")
		.primaryKey()
		.references(() => emails.id, { onDelete: "cascade" }),
	send_at: text("send_at").notNull(),
	status: text("status").notNull().default("pending"),
	attempts: integer("attempts").notNull().default(0),
	last_error: text("last_error"),
	created_at: text("created_at"),
});

export const blockedSenders = sqliteTable("blocked_senders", {
	id: text("id").primaryKey(),
	pattern: text("pattern").notNull(),
	reason: text("reason"),
	created_at: text("created_at"),
});

/**
 * Senders exempt from heuristic spam filtering (migration 20).
 *
 * Same `pattern` grammar as `blocked_senders`. An explicit block still wins:
 * both are deliberate user actions, and "I don't want this" is the more specific
 * of the two.
 */
export const allowedSenders = sqliteTable("allowed_senders", {
	id: text("id").primaryKey(),
	pattern: text("pattern").notNull(),
	reason: text("reason"),
	created_at: text("created_at"),
});
