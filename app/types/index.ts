// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Settings types come from `shared/mailbox-settings.ts`, which is also what the
 * Worker validates against, so the two cannot drift.
 *
 * These were declared separately here and had already drifted: `autoReply` was
 * missing `startsAt`, `endsAt` and `knownSendersOnly`, so the settings screen
 * edited window bounds this type said did not exist.
 *
 * Every field is required rather than optional because the API now resolves the
 * stored blob before returning it — `parseStoredMailboxSettings` fills in
 * defaults — so no component has to decide what an absent `autoDraft` means.
 */
import type {
	MailboxSettings,
	SignatureSettings,
} from "../../shared/mailbox-settings";

// Re-exported so consumers keep importing settings types from `~/types`, while
// the declarations above stay usable inside this file — `export ... from` alone
// re-exports without binding the names locally.
export type { MailboxSettings, SignatureSettings };

export interface Mailbox {
	id: string;
	email: string;
	name: string;
	/** Domain this mailbox belongs to */
	domain?: string;
	settings?: MailboxSettings;
}

/**
 * Zone configuration for multi-domain support.
 * Each zone represents a Cloudflare zone (domain) that can have its own mailboxes.
 */
export interface Zone {
	/** Unique identifier for the zone (usually the domain name) */
	id: string;
	/** Domain name (e.g., "example.com") */
	domain: string;
	/** Display name for the zone */
	name: string;
	/** Cloudflare zone ID (optional - for future API integration) */
	zoneId?: string;
}

export interface Email {
	id: string;
	thread_id?: string | null;
	folder_id?: string | null;
	/**
	 * Folder this was in before it was binned, set only while it sits in Trash.
	 *
	 * Read by the reading pane so a discarded draft is still labelled a draft: it
	 * is the user's own unsent text, and `folder_id` alone says only "trash", so
	 * the pane offered Reply and Forward on a message they wrote themselves.
	 */
	trashed_from?: string | null;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string;
	bcc?: string;
	date: string;
	read: boolean;
	starred: boolean;
	body?: string | null;
	in_reply_to?: string | null;
	email_references?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	attachments?: Attachment[];
	snippet?: string | null;
	/** "high" | "low"; absent or null means normal priority. */
	priority?: EmailPriority;
	/** ISO timestamp at which a snoozed message returns to its folder. */
	snoozed_until?: string | null;
	/** Folder the message returns to when its snooze expires. */
	snooze_return_folder?: string | null;
	/**
	 * Heuristic spam score recorded at delivery. Absent or null for messages
	 * that were never scored — anything this app sent, and mail received before
	 * spam filtering existed.
	 */
	spam_score?: number | null;
	/** JSON array of `{id, label}` explaining the score; see `shared/spam`. */
	spam_signals?: string | null;
	/**
	 * Stored reader warnings (JSON). List rows carry this; full reads also carry
	 * the parsed `warnings`.
	 */
	security_warnings?: string | null;
	/** Parsed reader warnings, on single-message and thread reads. */
	warnings?: import("shared/sender-warning-types").SenderWarning[];
	/** Raw remote `<img src>` → signed same-origin proxy path. */
	image_proxy?: Record<string, string>;
	/**
	 * Why this message never got where it was going; null when nothing is known,
	 * which is every message that went out fine.
	 *
	 * `"failed"` — this app could not hand it to the provider and gave up after
	 * its retries, so the message is sitting in Drafts. `"bounced"` — it was
	 * accepted and a remote server then rejected it, reported back by a DSN.
	 */
	delivery_status?: DeliveryStatus;
	/** Human-readable reason for `delivery_status`, capped at 500 chars. */
	delivery_error?: string | null;
	/**
	 * Engagement cache for mail this mailbox sent (migration 28). "Opened"
	 * means the tracking image loaded; see `shared/engagement.ts`.
	 */
	opened_at?: string | null;
	last_opened_at?: string | null;
	open_count?: number;
	open_proxy_count?: number;
	clicked_at?: string | null;
	click_count?: number;
	/** The sender's display name from `From:`, when the message carried one. */
	sender_name?: string | null;
	/** AI one-line summary of the conversation (list rows). Plain text. */
	summary_line?: string;
	/** Set when `summary_line` is the neutral text rather than a summary. */
	summary_status?: "blocked" | "skipped";
	/** Threaded rows: address → display name for participants that had one. */
	participant_names?: Record<string, string>;
	// Thread aggregate fields (only present in threaded list view)
	thread_count?: number;
	thread_unread_count?: number;
	participants?: string;
	needs_reply?: boolean;
	has_draft?: boolean;
	/**
	 * Whether the message (or, in threaded mode, the conversation) carries a
	 * non-inline attachment.
	 *
	 * A flag rather than the rows: the list projection deliberately omits
	 * attachment metadata, since joining it would multiply rows per attachment
	 * and the list only needs to draw a paperclip. Use `attachments` from the
	 * detail endpoint when the actual files are needed.
	 */
	has_attachment?: boolean;
}

export interface Attachment {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string;
	disposition?: string;
	/**
	 * True when the part was refused at delivery and no blob was stored.
	 *
	 * Arrives as SQLite's 0/1, so read it as truthy rather than `=== true`.
	 * See `shared/attachment-types.ts`.
	 */
	blocked?: boolean | number;
}

export interface Folder {
	id: string;
	name: string;
	unreadCount: number;
	/** Messages in the folder, read or not. Absent from older Workers. */
	totalCount?: number;
}

/**
 * Message priority. Derived from inbound `Importance` / `X-Priority` headers
 * or set by hand; null means normal, which is the overwhelming majority.
 */
export type EmailPriority = "high" | "low" | null;

/**
 * Known delivery failure of an outbound message; null means nothing went wrong
 * as far as anything can tell, which is the overwhelming majority.
 *
 * The two are genuinely different events and the UI says so: `"failed"` never
 * left this app and the draft is still here to retry, while `"bounced"` was
 * accepted and rejected downstream, so retrying the same address is pointless.
 */
export type DeliveryStatus =
	| "queued"
	| "sent"
	| "delivered"
	| "failed"
	| "bounced"
	| null;

/** The two states the UI flags as "this did not get there". */
export function isDeliveryProblem(
	status: DeliveryStatus | undefined,
): status is "failed" | "bounced" {
	return status === "failed" || status === "bounced";
}

/**
 * One row of the delivery ledger for a sent message.
 *
 * The reading pane renders these as a timeline (queued → sent → delivered →
 * opened...) with, on a failure, the coarse fault attribution the reconciler
 * assigned. Mirrors the server's `delivery_events` row; `metadata` is the raw
 * JSON string the server stored, parsed at the point of use.
 */
export interface DeliveryEvent {
	id: number;
	email_id: string;
	recipient: string | null;
	event_type: string;
	source: string;
	provider_message_id: string | null;
	/** "internal" (our side) | "recipient" (their side) | null on a success. */
	error_cause: string | null;
	error_detail: string | null;
	metadata: string | null;
	occurred_at: string;
	created_at: string;
}

/** Per-mailbox (or account-total) Sent-analytics counts. */
export interface SentAnalyticsCounts {
	sent: number;
	delivered: number;
	failed: number;
	opened: number;
	clicked: number;
	/** Failures attributed to our side (config/auth/reputation). */
	failedInternal: number;
	/** Failures attributed to the recipient's server (full/unknown mailbox). */
	failedRecipient: number;
}

/** The account-level Sent-analytics response: a total plus a per-mailbox breakdown. */
export interface SentAnalyticsResponse {
	window: { days: number; start: string; end: string };
	total: SentAnalyticsCounts;
	mailboxes: (SentAnalyticsCounts & { mailboxId: string })[];
}

/** A label, with the counts the sidebar renders next to it. */
export interface Label {
	id: string;
	name: string;
	color: string;
	parent_id: string | null;
	sort_order: number;
	email_count: number;
	unread_count: number;
}

/** The subset of a label carried on an individual email. */
export type EmailLabel = Pick<Label, "id" | "name" | "color"> & {
	/** Who applied it: `ai` / `heuristic` for triage, `rule`, or null for a person. */
	source?: string | null;
};

/** A label's AI triage settings. */
export interface LabelPrompt {
	id: string;
	name: string;
	color: string;
	prompt: string | null;
	preset_key: string | null;
	auto_archive: boolean;
	show_tab: boolean;
}

export interface TriagePresetStatus {
	key: import("../../shared/ai-triage").TriagePresetKey;
	name: string;
	prompt: string;
	enabled: boolean;
	label_id: string | null;
	auto_archive: boolean;
	show_tab: boolean;
}

export interface LabelPromptsView {
	enabled: boolean;
	screener: "off" | "unknown_only";
	daily_ai_cap: number;
	ai_calls_today: number;
	corrections: number;
	backfill_remaining: number;
	labels: LabelPrompt[];
	presets: TriagePresetStatus[];
}

/** One sender waiting in the Screener. */
export interface ScreenerSender {
	sender: string;
	sender_name: string | null;
	count: number;
	unread: number;
	latest_date: string;
	latest_subject: string | null;
	latest_id: string;
	sender_kind: string | null;
	sender_confidence: string | null;
	verdict: string | null;
}

export interface ScreenResult {
	sender: string;
	decision: "allow" | "block";
	folder: string;
	moved: number;
	listed: boolean;
}

export interface Signature {
	id: string;
	name: string;
	body_html: string;
	is_default: boolean;
}

/** Delivery state of a queued outbound message. */
export interface ScheduledSend {
	email_id: string;
	send_at: string;
	status: "pending" | "sent" | "failed";
	attempts: number;
	last_error: string | null;
	subject: string | null;
	sender: string;
	recipient: string;
	cc: string | null;
	bcc: string | null;
	snippet: string | null;
}

export interface BlockedSender {
	id: string;
	/** Full address ("spam@example.com") or a domain suffix ("@example.com"). */
	pattern: string;
	reason: string | null;
	created_at: string;
}
