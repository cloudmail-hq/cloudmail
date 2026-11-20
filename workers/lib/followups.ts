// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Follow-up reminders, Worker side: the one hook every send path calls, and
 * the helpers the REST routes, MCP tools and agent share.
 *
 * The Durable Object half (storage, the alarm, cancellation) is
 * ../durableObject/followups.ts.
 */

import {
	FollowupRequestSchema,
	MAX_FOLLOWUP_SECONDS,
	resolveFollowup,
	type FollowupDefault,
	type FollowupRequest,
	type FollowupView,
} from "../../shared/followups";
import { parseStoredMailboxSettings } from "../../shared/mailbox-settings";
import { expectsReply } from "./ai";
import { aiFor, type RouterEnv } from "./ai-router";
import type { Env } from "../types";

/** The slice of the MailboxDO stub this module calls. */
export interface FollowupStub {
	setFollowup(args: {
		emailId: string;
		followupAt: string;
		mode: "manual" | "auto";
		durationSeconds: number;
	}): Promise<FollowupView | null>;
	cancelFollowup?(emailId: string): Promise<FollowupView | null>;
}

/** Read the mailbox's follow-up default. Never throws; "off" on any failure. */
export async function mailboxFollowupDefault(
	env: Pick<Env, "BUCKET">,
	mailboxId: string,
): Promise<FollowupDefault> {
	try {
		const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
		if (!obj) return "off";
		return parseStoredMailboxSettings(await obj.json()).followups.default;
	} catch {
		return "off";
	}
}

/**
 * Pull a `followup` field out of a send body without disturbing the route's own
 * schema. An invalid value is ignored rather than failing the send: the message
 * matters more than the reminder.
 */
export function parseFollowupField(body: unknown): FollowupRequest | undefined {
	if (!body || typeof body !== "object" || !("followup" in body)) return undefined;
	const parsed = FollowupRequestSchema.safeParse((body as { followup: unknown }).followup);
	return parsed.success ? parsed.data : undefined;
}

/**
 * The send-path hook: after a message is stored, set the reminder the request
 * (or the mailbox default) asks for.
 *
 * Auto mode classifies the outbound body first and sets nothing unless the
 * model clearly says it expects a reply (fail closed). Callers run this under
 * `waitUntil` so the classifier never adds latency to a send; it never throws.
 */
export async function applySendFollowup(
	env: Pick<Env, "BUCKET"> & RouterEnv,
	stub: FollowupStub,
	args: {
		mailboxId: string;
		emailId: string;
		/** What the request carried, from `parseFollowupField`. */
		request: FollowupRequest | undefined;
		/** The outbound body, for auto mode. */
		body: string | null | undefined;
		/** When the message goes out: now, or the scheduled time. */
		sentAtMs?: number;
	},
): Promise<FollowupView | null> {
	try {
		const sentAtMs = args.sentAtMs ?? Date.now();
		const mailboxDefault = args.request
			? "off"
			: await mailboxFollowupDefault(env, args.mailboxId);
		// An explicit "off" on a reply means "stop reminding me about this
		// thread". Replying already restarted the thread's clock (see
		// onEmailStored), so it has to be cancelled, not merely left unset.
		if (args.request?.mode === "off") {
			await stub.cancelFollowup?.(args.emailId);
			return null;
		}
		const resolved = resolveFollowup(args.request, mailboxDefault, sentAtMs);
		if (resolved.kind === "none") return null;

		if (resolved.kind === "auto") {
			if (!(await expectsReply(aiFor(env, { feature: "followups" }), args.body))) return null;
			return await stub.setFollowup({
				emailId: args.emailId,
				followupAt: new Date(sentAtMs + resolved.durationSeconds * 1000).toISOString(),
				mode: "auto",
				durationSeconds: resolved.durationSeconds,
			});
		}

		return await stub.setFollowup({
			emailId: args.emailId,
			followupAt: resolved.at,
			mode: "manual",
			durationSeconds: resolved.durationSeconds,
		});
	} catch (e) {
		console.error(`Could not set a follow-up on ${args.emailId}:`, (e as Error).message);
		return null;
	}
}

/**
 * Validate an explicit set (REST, MCP, CLI): exactly one of `at` or
 * `delay_seconds`, in the future and within `MAX_FOLLOWUP_SECONDS`.
 */
export function resolveExplicitFollowup(
	params: { at?: string; delaySeconds?: number },
	nowMs = Date.now(),
): { ok: true; at: string; durationSeconds: number } | { ok: false; error: string } {
	if (Boolean(params.at) === (params.delaySeconds !== undefined)) {
		return { ok: false, error: "Provide exactly one of 'at' or 'delay_seconds'" };
	}
	const atMs = params.at ? Date.parse(params.at) : nowMs + params.delaySeconds! * 1000;
	if (!Number.isFinite(atMs)) return { ok: false, error: "Invalid 'at' timestamp; use ISO 8601" };
	const durationSeconds = Math.round((atMs - nowMs) / 1000);
	if (durationSeconds <= 0) return { ok: false, error: "The reminder time must be in the future" };
	if (durationSeconds > MAX_FOLLOWUP_SECONDS) {
		return { ok: false, error: "The reminder must be within 90 days" };
	}
	return { ok: true, at: new Date(atMs).toISOString(), durationSeconds };
}
