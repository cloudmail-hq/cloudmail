// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * `/api/v1/mailboxes/:mailboxId/approvals`: agent and API-token sends waiting
 * for a person. See `workers/lib/agent-send-gate.ts`.
 *
 * Reading the queue needs `read` on the mailbox. Deciding (approve, reject,
 * edit, retry) needs the authority to send from it AND a person:
 *
 * - a signed-in browser session, or
 * - an API token holding `approvals:manage` (the CLI), and never for a send
 *   that token, an ancestor or a descendant of it asked for.
 *
 * An OAuth grant (an MCP client) can never decide, and a token without that
 * scope cannot either. Otherwise an agent could queue a message and release it
 * itself, and the queue would protect nothing.
 *
 * Revising is different: `POST …/:id/revise` lets the credential that ASKED
 * for the send replace its own pending message (the agent's second draft), and
 * nobody else. It never releases anything, and an approve that names the
 * revision it previewed is refused once a newer revision exists.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { APPROVAL_STATUSES, type ApprovalStatus } from "../../shared/agent-send-policy";
import type { ApprovalRecord } from "../durableObject/approvals";
import type { ApiTokenInfo } from "../auth/types";
import { approveHeld, editHeld, rejectHeld, reviseHeld, revisionRecipientRefusal, type EnrollExecutor } from "../lib/agent-send-gate";
import { editVerifier } from "../lib/approval-edit-verifier";
import { hasTokenScope } from "../lib/authz";
import type { HeldBatch, HeldEnrollment } from "../lib/held-send";
import type { MailboxContext } from "../lib/mailbox";
import { requireAnyCapability, requireCapability } from "../lib/mailbox";
import * as sequences from "../lib/sequences";

type AppContext = Context<MailboxContext>;

export const approvalRoutes = new Hono<MailboxContext>();

const BASE = "/api/v1/mailboxes/:mailboxId/approvals";
const SEND = ["sendAs", "sendOnBehalf"] as const;

const addressOrList = z.union([z.string().email(), z.array(z.string().email()).min(1).max(50)]);

export const EditBody = z
	.object({
		to: addressOrList.optional(),
		cc: z.union([z.string().email(), z.array(z.string().email()).max(50)]).optional(),
		subject: z.string().max(998).optional(),
		html: z.string().max(5_000_000).optional(),
	})
	.strict();

export const RejectBody = z.object({ note: z.string().max(500).optional() }).strict();
/** `revision`: the version the approver previewed; a newer one refuses with 409. */
// Not strict: approve used to ignore its body, so extra keys from older clients stay harmless.
export const ApproveBody = z.object({ revision: z.number().int().min(1).optional() });

function mailboxOf(c: AppContext): string {
	return decodeURIComponent(c.req.param("mailboxId")!);
}

function waitUntilOf(c: AppContext): ((p: Promise<unknown>) => void) | undefined {
	try {
		const ctx = c.executionCtx;
		return (p) => ctx.waitUntil(p);
	} catch {
		return undefined;
	}
}

/** What the API returns for one approval: everything a reviewer needs to decide. */
function present(a: ApprovalRecord) {
	const payload = a.payload as { type?: string; batch?: HeldBatch; enrollment?: HeldEnrollment };
	return {
		id: a.id,
		kind: a.kind,
		status: a.status,
		reason: a.reason,
		recipients: a.recipients,
		subject: a.subject,
		/** The exact message(s) approve will send. Open/click tracking is added at send. */
		messages: payload.batch?.messages.map((m) => ({
			to: m.to,
			cc: m.cc ?? [],
			bcc: m.bcc ?? [],
			from: m.from,
			subject: m.subject,
			html: m.html ?? null,
			text: m.text ?? null,
			attachments: (m.attachments ?? []).map((x) => ({ filename: x.filename, type: x.type })),
			send_at: m.sendAt ?? null,
			bulk: m.kind === "bulk",
		})) ?? [],
		note: payload.batch?.note ?? null,
		enrollment: payload.enrollment
			? {
					sequence_id: payload.enrollment.sequenceId,
					sequence_name: payload.enrollment.sequenceName,
					person: payload.enrollment.enroll.personEmail,
					from: payload.enrollment.enroll.fromAddress,
					steps: payload.enrollment.steps,
				}
			: null,
		tracking_added_at_send: true,
		editable: a.status === "pending" && (payload.batch?.messages.length ?? 0) === 1,
		/** 1 when stored, +1 per edit. Pass it to approve so a newer version is not sent unseen. */
		revision: a.revision,
		revised_at: a.revisedAt ? new Date(a.revisedAt).toISOString() : null,
		/** `requester` when the agent revised its own send, `reviewer` when a person edited it. */
		revised_by: a.revisedBy,
		requested_by: a.actor,
		result: a.result,
		error: a.error,
		decided_by: a.decidedBy,
		created_at: new Date(a.createdAt).toISOString(),
		decided_at: a.decidedAt ? new Date(a.decidedAt).toISOString() : null,
		expires_at: new Date(a.expiresAt).toISOString(),
	};
}

approvalRoutes.get(BASE, requireCapability("read"), async (c) => {
	const raw = c.req.query("status") ?? "pending";
	const status = raw === "all" || (APPROVAL_STATUSES as readonly string[]).includes(raw) ? (raw as ApprovalStatus | "all") : "pending";
	const limit = Number(c.req.query("limit")) || 50;
	const rows = (await c.var.mailboxStub.listSendApprovals({ status, limit })) as ApprovalRecord[];
	return c.json({ approvals: rows.map(present) });
});

approvalRoutes.get(`${BASE}/count`, requireCapability("read"), async (c) => {
	return c.json({ pending: await c.var.mailboxStub.countPendingSendApprovals() });
});

approvalRoutes.get(`${BASE}/:id`, requireCapability("read"), async (c) => {
	const row = (await c.var.mailboxStub.getSendApproval(c.req.param("id"))) as ApprovalRecord | null;
	if (!row) return c.json({ error: "Approval not found" }, 404);
	return c.json({ approval: present(row) });
});

/** Ids of a token and every ancestor it was minted from. */
function lineage(tokens: Pick<ApiTokenInfo, "id" | "parentId">[], id: string): Set<string> {
	const byId = new Map(tokens.map((t) => [t.id, t]));
	const out = new Set<string>();
	let current: string | null | undefined = id;
	while (current && !out.has(current)) {
		out.add(current);
		current = byId.get(current)?.parentId;
	}
	return out;
}

/**
 * Whether two tokens share a lineage (one minted the other, directly or not,
 * or they are the same). Pure; exported for tests.
 */
export function tokensRelated(
	tokens: Pick<ApiTokenInfo, "id" | "parentId">[],
	approverId: string,
	requesterId: string,
): boolean {
	const a = lineage(tokens, approverId);
	const b = lineage(tokens, requesterId);
	for (const id of a) if (b.has(id)) return true;
	return false;
}

/**
 * Who may decide this approval. Null when the caller may; otherwise the
 * refusal. Called by every deciding route.
 */
export async function decisionRefusal(c: AppContext, row: ApprovalRecord | null): Promise<Response | null> {
	const method = c.var.authMethod ?? c.var.principal.credential?.method;
	if (method === "oauth") {
		return c.json({ error: "Connected apps cannot approve or reject sends. Do it in the app.", code: "person_required" }, 403);
	}
	if (method !== "token") return null; // a session (or Access / dev, which are people)
	if (!hasTokenScope(c.var.principal, "approvals:manage") || c.var.principal.token === undefined) {
		return c.json(
			{
				error: "Deciding held sends needs a signed-in browser session, or an API token with the approvals:manage scope.",
				code: "insufficient_scope",
				scope: "approvals:manage",
			},
			403,
		);
	}
	const approverId = c.var.principal.credential?.tokenId ?? c.var.authToken?.id ?? null;
	const requester = row?.actor.tokenId ?? null;
	if (!approverId || !requester) return null;
	let related = approverId === requester;
	if (!related && c.var.authUser) {
		const ns = c.env.AUTH_STORE as unknown as DurableObjectNamespace | undefined;
		const store = ns?.get(ns.idFromName("global")) as unknown as { listApiTokens(userId: string): Promise<ApiTokenInfo[]> } | undefined;
		// Fails closed: a token list we cannot read means we cannot rule a relation out.
		const tokens = await store?.listApiTokens(c.var.authUser.id).catch(() => null);
		related = tokens ? tokensRelated(tokens, approverId, requester) : true;
	}
	if (!related) return null;
	return c.json(
		{
			error: "This API token (or one it was created from or created) asked for the send, so it cannot decide it. Use the app or an unrelated token.",
			code: "self_approval",
		},
		403,
	);
}

async function loadRow(c: AppContext): Promise<ApprovalRecord | null> {
	return (await c.var.mailboxStub.getSendApproval(c.req.param("id") ?? "")) as ApprovalRecord | null;
}

/** Enroll a held enrollment exactly as it was previewed. */
export const enrollHeld: EnrollExecutor = async (env, enrollment) => {
	const result = await sequences.enrollPerson(env.BUCKET, {
		sequenceId: enrollment.sequenceId,
		personId: enrollment.enroll.personId,
		personEmail: enrollment.enroll.personEmail,
		personName: enrollment.enroll.personName,
		fromAddress: enrollment.enroll.fromAddress,
		variables: enrollment.enroll.variables,
		skipSteps: enrollment.enroll.skipSteps,
		delayOverrides: enrollment.enroll.delayOverrides,
	});
	return { enrollment_id: result.enrollment.id, scheduled: result.scheduledEmails.length };
};

approvalRoutes.patch(`${BASE}/:id`, requireAnyCapability([...SEND]), async (c) => {
	const row = await loadRow(c);
	if (!row) return c.json({ error: "Approval not found" }, 404);
	const refused = await decisionRefusal(c, row);
	if (refused) return refused;
	const body = EditBody.parse(await c.req.json().catch(() => ({})));
	const outcome = await editHeld({
		env: c.env,
		mailboxId: mailboxOf(c),
		id: row.id,
		edits: {
			...(body.to ? { to: Array.isArray(body.to) ? body.to : [body.to] } : {}),
			...(body.cc ? { cc: Array.isArray(body.cc) ? body.cc : [body.cc] } : {}),
			...(body.subject !== undefined ? { subject: body.subject } : {}),
			...(body.html !== undefined ? { html: body.html } : {}),
		},
		// The edited body passes the same verifier an agent's body does, and the
		// verified result is what gets stored and shown.
		verify: editVerifier(c.env),
	});
	if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
	return c.json({ approval: present(outcome.approval) });
});

/**
 * The requester revises its own pending send (an API token or OAuth app that
 * got `pending_approval`). Same body as PATCH. Not a decision: no
 * `approvals:manage` needed, and the item stays pending.
 */
approvalRoutes.post(`${BASE}/:id/revise`, requireAnyCapability([...SEND]), async (c) => {
	const body = EditBody.parse(await c.req.json().catch(() => ({})));
	const principal = c.var.principal;
	const outcome = await reviseHeld({
		env: c.env,
		mailboxId: mailboxOf(c),
		id: c.req.param("id") ?? "",
		principal,
		via: "api",
		edits: {
			...(body.to ? { to: Array.isArray(body.to) ? body.to : [body.to] } : {}),
			...(body.cc ? { cc: Array.isArray(body.cc) ? body.cc : [body.cc] } : {}),
			...(body.subject !== undefined ? { subject: body.subject } : {}),
			...(body.html !== undefined ? { html: body.html } : {}),
		},
		verify: editVerifier(c.env),
		checkRecipients: (recipients) => revisionRecipientRefusal(c.env, mailboxOf(c), principal, recipients),
		waitUntil: waitUntilOf(c),
	});
	if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
	return c.json({ approval: present(outcome.approval) });
});

approvalRoutes.post(`${BASE}/:id/approve`, requireAnyCapability([...SEND]), async (c) => {
	const row = await loadRow(c);
	if (!row) return c.json({ error: "Approval not found" }, 404);
	const refused = await decisionRefusal(c, row);
	if (refused) return refused;
	const body = ApproveBody.parse((await c.req.json().catch(() => null)) ?? {});
	const outcome = await approveHeld({
		env: c.env,
		mailboxId: mailboxOf(c),
		id: row.id,
		approver: c.var.principal,
		enroll: enrollHeld,
		deps: { releasedBy: { principal: c.var.principal, via: "rest" } },
		waitUntil: waitUntilOf(c),
		expectedRevision: body.revision ?? null,
	});
	if (!outcome.ok) {
		return c.json({ error: outcome.error, ...(outcome.approval ? { approval: present(outcome.approval) } : {}) }, outcome.status);
	}
	return c.json({ approval: present(outcome.approval), result: outcome.result });
});

approvalRoutes.post(`${BASE}/:id/reject`, requireAnyCapability([...SEND]), async (c) => {
	const row = await loadRow(c);
	if (!row) return c.json({ error: "Approval not found" }, 404);
	const refused = await decisionRefusal(c, row);
	if (refused) return refused;
	const body = RejectBody.parse(await c.req.json().catch(() => ({})));
	const outcome = await rejectHeld({
		env: c.env,
		mailboxId: mailboxOf(c),
		id: row.id,
		approver: c.var.principal,
		note: body.note ?? null,
		waitUntil: waitUntilOf(c),
	});
	if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
	return c.json({ approval: present(outcome.approval) });
});

/**
 * Put a FAILED send back in the queue. Only `failed` qualifies: that status
 * means the provider refused before accepting, so the message was not sent.
 * `sent_unconfirmed` (and a stalled `sending`) may have been delivered and can
 * never be retried.
 */
approvalRoutes.post(`${BASE}/:id/retry`, requireAnyCapability([...SEND]), async (c) => {
	const row = await loadRow(c);
	if (!row) return c.json({ error: "Approval not found" }, 404);
	const refused = await decisionRefusal(c, row);
	if (refused) return refused;
	if (row.status !== "failed") {
		return c.json(
			{
				error:
					row.status === "sent_unconfirmed"
						? "This message may already have been delivered, so it cannot be sent again. Check the recipient's reply or the delivery log."
						: `Only a failed send can be retried; this one is ${row.status}.`,
			},
			409,
		);
	}
	const reopened = (await c.var.mailboxStub.reopenSendApproval(row.id)) as ApprovalRecord | null;
	if (!reopened || reopened.status !== "pending") return c.json({ error: "It could not be reopened." }, 409);
	return c.json({ approval: present(reopened) });
});
