// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The retention purge, driven from the five-minute cron.
 *
 * Once a day (tracked in `retention/state.json`) it walks every mailbox and
 * applies the operator's policy (`shared/privacy.ts`):
 *
 *   - tracking and delivery events, and Trash, in each MailboxDO
 *     (`applyRetention`, bounded batches; the mailbox's alarm finishes a
 *     backlog in further batches);
 *   - agent chat in each EmailAgent (`purgeOlderThan`);
 *   - the R2 audit log (`purgeExpiredAudit`).
 *
 * Bounded per tick: at most `MAILBOXES_PER_TICK` mailboxes and
 * `AUDIT_DELETES_PER_TICK` audit keys. A pass that does not finish records its
 * place and the next tick carries on, so a large deployment spreads the work
 * over several ticks instead of one long invocation. Counts are logged.
 */

import { retentionCutoff, type RetentionPolicy } from "../../shared/privacy";
import type { Env } from "../types";
import { purgeExpiredAudit } from "./audit";
import { listMailboxes } from "./email-helpers";
import { getPrivacySettings } from "./privacy";

export const RETENTION_STATE_KEY = "retention/state.json";
export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MAILBOXES_PER_TICK = 25;
export const AUDIT_DELETES_PER_TICK = 1000;

export interface RetentionState {
	/** When the last complete pass started. */
	lastCompletedAt: number;
	/** A pass in progress: where to resume, and when it started. */
	inProgress: { startedAt: number; nextMailbox: number; auditDone: boolean } | null;
}

export interface RetentionTotals {
	mailboxes: number;
	trackingEvents: number;
	deliveryEvents: number;
	trash: number;
	agentMessages: number;
	auditEntries: number;
	done: boolean;
}

async function readState(bucket: R2Bucket): Promise<RetentionState> {
	try {
		const obj = await bucket.get(RETENTION_STATE_KEY);
		const raw = obj ? ((await obj.json()) as Partial<RetentionState>) : null;
		return {
			lastCompletedAt: typeof raw?.lastCompletedAt === "number" ? raw.lastCompletedAt : 0,
			inProgress: raw?.inProgress ?? null,
		};
	} catch {
		return { lastCompletedAt: 0, inProgress: null };
	}
}

/** Whether a pass should run (or continue) now. Pure, for tests. */
export function retentionDue(state: RetentionState, now: number): boolean {
	return state.inProgress !== null || now - state.lastCompletedAt >= RETENTION_INTERVAL_MS;
}

interface MailboxRetentionStub {
	applyRetention(policy: RetentionPolicy): Promise<{
		trackingEvents: number;
		deliveryEvents: number;
		trash: number;
		more: boolean;
	}>;
}

interface AgentRetentionStub {
	purgeOlderThan(days: number): Promise<number>;
}

/**
 * Run (or continue) the retention pass if it is due. Never throws; a failure
 * in one mailbox is logged and the pass moves on.
 */
export async function runRetentionTick(
	env: Env,
	options: { now?: number } = {},
): Promise<RetentionTotals | null> {
	const now = options.now ?? Date.now();
	const state = await readState(env.BUCKET);
	if (!retentionDue(state, now)) return null;

	const policy = (await getPrivacySettings(env.BUCKET)).retention;
	const progress = state.inProgress ?? { startedAt: now, nextMailbox: 0, auditDone: false };
	const totals: RetentionTotals = {
		mailboxes: 0,
		trackingEvents: 0,
		deliveryEvents: 0,
		trash: 0,
		agentMessages: 0,
		auditEntries: 0,
		done: false,
	};

	// Sorted so the resume index means the same mailbox from tick to tick.
	const mailboxes = (await listMailboxes(env.BUCKET)).map((m) => m.id).sort();
	const end = Math.min(mailboxes.length, progress.nextMailbox + MAILBOXES_PER_TICK);
	for (let i = progress.nextMailbox; i < end; i++) {
		const id = mailboxes[i];
		try {
			const stub = env.MAILBOX.get(env.MAILBOX.idFromName(id)) as unknown as MailboxRetentionStub;
			const result = await stub.applyRetention(policy);
			totals.trackingEvents += result.trackingEvents;
			totals.deliveryEvents += result.deliveryEvents;
			totals.trash += result.trash;
		} catch (e) {
			console.error(`retention: mailbox ${id} failed:`, (e as Error).message);
		}
		try {
			const agent = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(id)) as unknown as AgentRetentionStub;
			totals.agentMessages += await agent.purgeOlderThan(policy.agentChatDays);
		} catch (e) {
			// A mailbox that never opened the agent has nothing to purge.
			console.error(`retention: agent chat for ${id} failed:`, (e as Error).message);
		}
		totals.mailboxes += 1;
	}
	progress.nextMailbox = end;

	if (!progress.auditDone) {
		try {
			const audit = await purgeExpiredAudit(
				env.BUCKET,
				retentionCutoff(now, policy.auditLogDays).getTime(),
				{ maxDeletes: AUDIT_DELETES_PER_TICK },
			);
			totals.auditEntries = audit.deleted;
			progress.auditDone = !audit.more;
		} catch (e) {
			console.error("retention: audit purge failed:", (e as Error).message);
		}
	}

	totals.done = progress.nextMailbox >= mailboxes.length && progress.auditDone;
	const next: RetentionState = totals.done
		? { lastCompletedAt: progress.startedAt, inProgress: null }
		: { lastCompletedAt: state.lastCompletedAt, inProgress: progress };
	await env.BUCKET.put(RETENTION_STATE_KEY, JSON.stringify(next));

	console.log(
		`retention: mailboxes=${totals.mailboxes} tracking_events=${totals.trackingEvents} delivery_events=${totals.deliveryEvents} trash=${totals.trash} agent_messages=${totals.agentMessages} audit_entries=${totals.auditEntries}${totals.done ? "" : " (continuing)"}`,
	);
	return totals;
}
