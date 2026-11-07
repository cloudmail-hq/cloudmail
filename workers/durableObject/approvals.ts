// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Pending send approvals (migration 33), stored in the mailbox they send from.
 *
 *   pending ──claim(fence)──▶ sending ──finish(fence)──▶ sent | failed | sent_unconfirmed
 *      │  ▲                                                       │
 *      │  └────────────────── reopen (failed only) ◀──────────────┘
 *      └──reject──▶ rejected
 *
 * `claim` is one conditional UPDATE (`WHERE status = 'pending'`) that also
 * writes a fresh random `fence`. A Durable Object runs one call at a time and
 * the UPDATE is atomic, so two approvals racing for one item cannot both win.
 * `finish` only applies when the caller's fence still matches, so a stale
 * caller cannot overwrite the outcome. `reopen` only touches `failed`, which
 * means "the provider refused before accepting"; `sent_unconfirmed` and a
 * `sending` row left by a crash are never reopened, because the message may
 * already have been delivered.
 *
 * The payload is the composed message, and can be replaced only while pending
 * (an edit), so the bytes a person last saw are the bytes that are sent. Each
 * edit bumps `revision`; an approve that names the revision it previewed is
 * refused (`changed`) when an edit landed after that preview.
 */

import type { ApprovalActor, ApprovalKind, ApprovalStatus } from "../../shared/agent-send-policy";
import { APPROVAL_TTL_MS } from "../../shared/agent-send-policy";

export interface ApprovalRecord {
	id: string;
	kind: ApprovalKind;
	status: ApprovalStatus;
	reason: string;
	recipients: string[];
	subject: string;
	payload: Record<string, unknown>;
	actor: ApprovalActor;
	result: Record<string, unknown> | null;
	error: string | null;
	decidedBy: string | null;
	/** 1 when stored; +1 per edit. */
	revision: number;
	revisedAt: number | null;
	/** Who made the last edit. */
	revisedBy: ApprovalReviser | null;
	createdAt: number;
	decidedAt: number | null;
	expiresAt: number;
}

/** `requester`: the agent revising its own send. `reviewer`: a person editing before approving. */
export type ApprovalReviser = "requester" | "reviewer";

export interface CreateApprovalInput {
	/** Pre-minted id, so attachments can be stashed under it before the row exists. */
	id?: string;
	kind: ApprovalKind;
	reason: string;
	recipients: string[];
	subject: string;
	payload: Record<string, unknown>;
	actor: ApprovalActor;
	now?: number;
}

/** A `sending` row older than this is shown as not confirmed. */
export const SENDING_STALE_MS = 10 * 60 * 1000;

function parseJson<T>(value: unknown, fallback: T): T {
	if (typeof value !== "string") return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function toRecord(row: Record<string, unknown>, now = Date.now()): ApprovalRecord {
	let status = row.status as ApprovalStatus;
	// A claim whose outcome was never recorded (the worker died mid-send) may
	// have been delivered. Reported as unconfirmed; the stored status stays
	// `sending`, so nothing can claim or reopen it.
	if (status === "sending" && typeof row.decided_at === "number" && now - row.decided_at > SENDING_STALE_MS) {
		status = "sent_unconfirmed";
	}
	return {
		id: String(row.id),
		kind: row.kind as ApprovalKind,
		status,
		reason: String(row.reason ?? ""),
		recipients: parseJson<string[]>(row.recipients, []),
		subject: String(row.subject ?? ""),
		payload: parseJson<Record<string, unknown>>(row.payload, {}),
		actor: parseJson<ApprovalActor>(row.actor, { user: null, via: "mcp", method: null }),
		result: parseJson<Record<string, unknown> | null>(row.result, null),
		error: typeof row.error === "string" ? row.error : null,
		decidedBy: typeof row.decided_by === "string" ? row.decided_by : null,
		revision: typeof row.revision === "number" ? row.revision : 1,
		revisedAt: typeof row.revised_at === "number" ? row.revised_at : null,
		revisedBy: row.revised_by === "requester" || row.revised_by === "reviewer" ? row.revised_by : null,
		createdAt: Number(row.created_at),
		decidedAt: row.decided_at === null || row.decided_at === undefined ? null : Number(row.decided_at),
		expiresAt: Number(row.expires_at),
	};
}

function rows(ctx: DurableObjectState, query: string, ...bindings: unknown[]): Record<string, unknown>[] {
	return [...ctx.storage.sql.exec(query, ...bindings)] as Record<string, unknown>[];
}

export function newApprovalId(): string {
	return `apr_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function createApproval(ctx: DurableObjectState, input: CreateApprovalInput): ApprovalRecord {
	const now = input.now ?? Date.now();
	const id = input.id && /^apr_[0-9a-f]{20}$/.test(input.id) ? input.id : newApprovalId();
	ctx.storage.sql.exec(
		`INSERT INTO send_approvals (id, kind, status, reason, recipients, subject, payload, actor, created_at, expires_at)
		 VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
		id,
		input.kind,
		input.reason,
		JSON.stringify(input.recipients),
		input.subject.slice(0, 998),
		JSON.stringify(input.payload),
		JSON.stringify(input.actor),
		now,
		now + APPROVAL_TTL_MS,
	);
	return getApproval(ctx, id)!;
}

export function getApproval(ctx: DurableObjectState, id: string): ApprovalRecord | null {
	const row = rows(ctx, `SELECT * FROM send_approvals WHERE id = ?`, id)[0];
	return row ? toRecord(row) : null;
}

export function listApprovals(
	ctx: DurableObjectState,
	options: { status?: ApprovalStatus | "all"; limit?: number } = {},
): ApprovalRecord[] {
	const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
	const status = options.status ?? "pending";
	const list =
		status === "all"
			? rows(ctx, `SELECT * FROM send_approvals ORDER BY created_at DESC LIMIT ?`, limit)
			: status === "sent_unconfirmed"
				? rows(
						ctx,
						`SELECT * FROM send_approvals
						  WHERE status = 'sent_unconfirmed' OR (status = 'sending' AND decided_at < ?)
						  ORDER BY created_at DESC LIMIT ?`,
						Date.now() - SENDING_STALE_MS,
						limit,
					)
				: rows(ctx, `SELECT * FROM send_approvals WHERE status = ? ORDER BY created_at DESC LIMIT ?`, status, limit);
	return list.map((r) => toRecord(r));
}

export function countPendingApprovals(ctx: DurableObjectState, now = Date.now()): number {
	const row = rows(
		ctx,
		`SELECT COUNT(*) AS n FROM send_approvals WHERE status = 'pending' AND expires_at > ?`,
		now,
	)[0];
	return Number(row?.n ?? 0);
}

export type ClaimOutcome =
	| { ok: true; approval: ApprovalRecord; fence: string }
	| { ok: false; reason: "not_found" | "already_decided" | "expired" | "changed"; approval: ApprovalRecord | null };

/**
 * Move a pending item to `sending` under a fresh fence. Exactly one caller wins.
 *
 * `expectedRevision`, when given, is the revision the approver previewed: the
 * claim is refused (`changed`) if an edit has landed since, so nobody approves
 * text they have not seen. The check is in the same UPDATE as the claim.
 */
export function claimApproval(
	ctx: DurableObjectState,
	id: string,
	options: { decidedBy: string | null; expectedRevision?: number | null; now?: number },
): ClaimOutcome {
	const now = options.now ?? Date.now();
	const existing = getApproval(ctx, id);
	if (!existing) return { ok: false, reason: "not_found", approval: null };
	if (existing.status !== "pending") return { ok: false, reason: "already_decided", approval: existing };
	if (existing.expiresAt <= now) return { ok: false, reason: "expired", approval: existing };
	const expected = options.expectedRevision ?? null;
	if (expected !== null && existing.revision !== expected) return { ok: false, reason: "changed", approval: existing };

	const fence = crypto.randomUUID();
	const changed = rows(
		ctx,
		`UPDATE send_approvals
		    SET status = 'sending', decided_by = ?, decided_at = ?, fence = ?
		  WHERE id = ? AND status = 'pending' AND (? IS NULL OR revision = ?)
		 RETURNING *`,
		options.decidedBy,
		now,
		fence,
		id,
		expected,
		expected,
	);
	if (changed.length === 0) {
		const latest = getApproval(ctx, id);
		const reason = latest?.status === "pending" ? "changed" : "already_decided";
		return { ok: false, reason, approval: latest };
	}
	return { ok: true, approval: toRecord(changed[0]!, now), fence };
}

export type FinishOutcome =
	| { status: "sent"; result: Record<string, unknown> }
	| { status: "failed"; error: string }
	| { status: "sent_unconfirmed"; error: string; result?: Record<string, unknown> };

/** Record the outcome of a claimed send. Ignored unless `fence` still matches. */
export function finishApproval(
	ctx: DurableObjectState,
	id: string,
	fence: string,
	outcome: FinishOutcome,
): ApprovalRecord | null {
	ctx.storage.sql.exec(
		`UPDATE send_approvals SET status = ?, result = ?, error = ?, fence = NULL
		  WHERE id = ? AND status = 'sending' AND fence = ?`,
		outcome.status,
		"result" in outcome && outcome.result ? JSON.stringify(outcome.result) : null,
		"error" in outcome ? outcome.error.slice(0, 2000) : null,
		id,
		fence,
	);
	return getApproval(ctx, id);
}

/**
 * Replace the composed content of a pending item (an edit) and bump its
 * revision. Returns null when it is no longer pending, so an edit can never
 * change what is being sent.
 */
export function updatePendingApproval(
	ctx: DurableObjectState,
	id: string,
	update: {
		payload: Record<string, unknown>;
		recipients: string[];
		subject: string;
		revisedBy?: ApprovalReviser;
		/** Set the hold reason (an injection trip since the hold). Never cleared by an edit. */
		reason?: string;
		now?: number;
	},
): ApprovalRecord | null {
	const changed = rows(
		ctx,
		`UPDATE send_approvals
		    SET payload = ?, recipients = ?, subject = ?, revision = revision + 1, revised_at = ?, revised_by = ?,
		        reason = COALESCE(?, reason)
		  WHERE id = ? AND status = 'pending'
		 RETURNING *`,
		JSON.stringify(update.payload),
		JSON.stringify(update.recipients),
		update.subject.slice(0, 998),
		update.now ?? Date.now(),
		update.revisedBy ?? "reviewer",
		update.reason ?? null,
		id,
	);
	return changed[0] ? toRecord(changed[0]) : null;
}

/** A `failed` item (refused before acceptance) goes back to pending. Nothing else does. */
export function reopenApproval(ctx: DurableObjectState, id: string, now = Date.now()): ApprovalRecord | null {
	ctx.storage.sql.exec(
		`UPDATE send_approvals
		    SET status = 'pending', decided_by = NULL, decided_at = NULL, fence = NULL,
		        expires_at = MAX(expires_at, ?)
		  WHERE id = ? AND status = 'failed'`,
		now + APPROVAL_TTL_MS,
		id,
	);
	return getApproval(ctx, id);
}

export function rejectApproval(
	ctx: DurableObjectState,
	id: string,
	options: { decidedBy: string | null; note?: string | null; now?: number },
): ClaimOutcome {
	const now = options.now ?? Date.now();
	const existing = getApproval(ctx, id);
	if (!existing) return { ok: false, reason: "not_found", approval: null };
	const changed = rows(
		ctx,
		`UPDATE send_approvals SET status = 'rejected', decided_by = ?, decided_at = ?, error = ?
		  WHERE id = ? AND status IN ('pending', 'failed')
		 RETURNING *`,
		options.decidedBy,
		now,
		options.note ? options.note.slice(0, 500) : null,
		id,
	);
	if (changed.length === 0) return { ok: false, reason: "already_decided", approval: existing };
	return { ok: true, approval: toRecord(changed[0]!), fence: "" };
}

/** Drop decided items older than 90 days, and pending ones 30 days past expiry. */
export function sweepApprovals(ctx: DurableObjectState, now = Date.now()): void {
	const day = 24 * 60 * 60 * 1000;
	ctx.storage.sql.exec(
		`DELETE FROM send_approvals
		  WHERE (status IN ('sent', 'rejected', 'failed', 'sent_unconfirmed') AND COALESCE(decided_at, created_at) < ?)
		     OR (status = 'pending' AND expires_at < ?)`,
		now - 90 * day,
		now - 30 * day,
	);
}
