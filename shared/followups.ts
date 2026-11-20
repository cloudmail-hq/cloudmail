// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Follow-up reminders on sent mail: the parts the composer, the Worker and the
 * tests all need to agree on.
 *
 * A reminder watches one outbound message. If nobody else writes into its
 * thread before `followup_at`, the Durable Object alarm brings the thread back
 * to the Inbox, unread, with a "Follow up" label. A reply cancels it; replying
 * again yourself restarts the clock.
 *
 * Two modes:
 *   - `manual`: the sender picked a delay (1 day, 3 days, 1 week, or a time).
 *   - `auto`: a Workers AI yes/no classifier decides whether the message asks a
 *     question or requests an action, and only those get a reminder, after
 *     `AUTO_FOLLOWUP_DELAY_SECONDS`.
 */

import { z } from "zod";

export const FOLLOWUP_MODES = ["manual", "auto"] as const;
export type FollowupMode = (typeof FOLLOWUP_MODES)[number];

/** `pending` waits for its time; `fired` has surfaced the thread. */
export const FOLLOWUP_STATUSES = [
	"pending",
	"fired",
	"replied",
	"cancelled",
	"done",
] as const;
export type FollowupStatus = (typeof FOLLOWUP_STATUSES)[number];

export const DAY_SECONDS = 24 * 60 * 60;

/** How long auto mode waits before resurfacing a message that expects a reply. */
export const AUTO_FOLLOWUP_DELAY_SECONDS = 3 * DAY_SECONDS;

/** Upper bound on a reminder, matching the "within reason" bound on snooze. */
export const MAX_FOLLOWUP_SECONDS = 90 * DAY_SECONDS;

/** Name of the label applied to a thread a reminder brings back. */
export const FOLLOWUP_LABEL_NAME = "Follow up";
export const FOLLOWUP_LABEL_COLOR = "#f97316";

/** The composer's choices, in menu order. */
export const FOLLOWUP_PRESETS = [
	{ id: "1d", label: "1 day", seconds: DAY_SECONDS },
	{ id: "3d", label: "3 days", seconds: 3 * DAY_SECONDS },
	{ id: "1w", label: "1 week", seconds: 7 * DAY_SECONDS },
] as const;

/** The per-mailbox default the composer starts from. */
export const FOLLOWUP_DEFAULTS = ["off", "3d", "auto"] as const;
export type FollowupDefault = (typeof FOLLOWUP_DEFAULTS)[number];

/**
 * The `followup` field a send request may carry.
 *
 * `manual` takes exactly one of `delay_seconds` (counted from when the message
 * goes out, so a scheduled send's reminder starts at its delivery time) or `at`
 * (an absolute time). Absent altogether, the mailbox default applies.
 */
export const FollowupRequestSchema = z
	.object({
		mode: z.enum(["off", "manual", "auto"]),
		delay_seconds: z.number().int().positive().max(MAX_FOLLOWUP_SECONDS).optional(),
		at: z
			.string()
			.refine((v) => Number.isFinite(Date.parse(v)), { message: "must be an ISO 8601 time" })
			.optional(),
	})
	.strict()
	.refine(
		(v) => v.mode !== "manual" || (v.delay_seconds !== undefined) !== (v.at !== undefined),
		{ message: "manual follow-ups need exactly one of delay_seconds or at" },
	);

export type FollowupRequest = z.infer<typeof FollowupRequestSchema>;

export type ResolvedFollowup =
	| { kind: "none" }
	| { kind: "manual"; at: string; durationSeconds: number }
	| { kind: "auto"; durationSeconds: number };

/**
 * What a send should do about a reminder.
 *
 * `sentAtMs` is when the message goes out: now for an immediate send, the
 * `send_at` for a queued one. An explicit request wins over the mailbox
 * default; an `at` in the past (or not after the send) sets nothing rather than
 * firing immediately.
 */
export function resolveFollowup(
	request: FollowupRequest | undefined,
	mailboxDefault: FollowupDefault,
	sentAtMs: number,
): ResolvedFollowup {
	const effective: FollowupRequest =
		request ??
		(mailboxDefault === "3d"
			? { mode: "manual", delay_seconds: 3 * DAY_SECONDS }
			: { mode: mailboxDefault === "auto" ? "auto" : "off" });

	if (effective.mode === "off") return { kind: "none" };
	if (effective.mode === "auto") {
		return { kind: "auto", durationSeconds: AUTO_FOLLOWUP_DELAY_SECONDS };
	}

	if (effective.at !== undefined) {
		const atMs = Date.parse(effective.at);
		const duration = Math.round((atMs - sentAtMs) / 1000);
		if (!Number.isFinite(atMs) || duration <= 0 || duration > MAX_FOLLOWUP_SECONDS) {
			return { kind: "none" };
		}
		return { kind: "manual", at: new Date(atMs).toISOString(), durationSeconds: duration };
	}

	const seconds = effective.delay_seconds ?? 0;
	if (seconds <= 0) return { kind: "none" };
	return {
		kind: "manual",
		at: new Date(sentAtMs + seconds * 1000).toISOString(),
		durationSeconds: seconds,
	};
}

/** A reminder as the API returns it. */
export interface FollowupView {
	email_id: string;
	thread_id: string;
	followup_at: string;
	followup_mode: FollowupMode;
	status: FollowupStatus;
	duration_seconds: number;
	created_at: string;
	fired_at: string | null;
	resolved_at: string | null;
	surfaced_email_id: string | null;
	subject: string | null;
	recipient: string | null;
	sent_at: string | null;
}
