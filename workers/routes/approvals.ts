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
import { approvalPath, approveHeld, loadPolicy, editHeld, rejectHeld, reviseHeld, revisionRecipientRefusal, type EnrollExecutor } from "../lib/agent-send-gate";
import { editVerifier } from "../lib/approval-edit-verifier";
import { canDo, hasTokenScope } from "../lib/authz";
import { readableMailboxes } from "../lib/daily-brief";
import { getMailboxStub } from "../lib/email-helpers";
import { decideAgentSend } from "../../shared/agent-send-policy";
import { getAgentInbox } from "../lib/agent-inboxes";
import type { HeldBatch, HeldEnrollment } from "../lib/held-send";
import type { MailboxContext } from "../lib/mailbox";
import { requireAnyCapability, requireCapability } from "../lib/mailbox";
import * as sequences from "../lib/sequences";
import { trackingBaseUrl, trackingBaseUrlFromRequest } from "../lib/tracking-send";
import { MARKDOWN_MAX_CHARS } from "../../shared/markdown-email";

type AppContext = Context<MailboxContext>;

export const approvalRoutes = new Hono<MailboxContext>();

const BASE = "/api/v1/mailboxes/:mailboxId/approvals";
const SEND = ["sendAs", "sendOnBehalf"] as const;

const addressOrList = z.union([z.string().email(), z.array(z.string().email()).min(1).max(50)]);

const EditFields = z.object({
	to: addressOrList.optional(),
	cc: z.union([z.string().email(), z.array(z.string().email()).max(50)]).optional(),
	subject: z.string().max(998).optional(),
	html: z.string().max(5_000_000).optional(),
	/** The new body as Markdown, instead of `html`. */
	markdown: z.string().max(MARKDOWN_MAX_CHARS).optional(),
});
const oneBody = (d: { html?: string; markdown?: string }) => d.html === undefined || d.markdown === undefined;
const ONE_BODY = { message: "Pass 'html' or 'markdown', not both" };

export const EditBody = EditFields.strict().refine(oneBody, ONE_BODY);
/** PATCH also takes `revision`: the version the reviewer started from; a newer one refuses with 409. */
export const ReviewerEditBody = EditFields.extend({ revision: z.number().int().min(1).optional() }).strict().refine(oneBody, ONE_BODY);

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

export interface DeliverySummary {
	id: string;
	deliveryStatus: string | null;
	deliveryError: string | null;
	providerMessageId: string | null;
}

interface SentMessage {
	email_id: string | null;
	provider_message_id: string | null;
	scheduled: boolean;
	delivery_status?: string | null;
	delivery_error?: string | null;
}

function sentMessagesOf(result: Record<string, unknown> | null): SentMessage[] {
	const list = (result as { messages?: unknown } | null)?.messages;
	if (!Array.isArray(list)) return [];
	return list.map((m) => {
		const r = (m ?? {}) as { emailId?: unknown; providerMessageId?: unknown; scheduled?: unknown };
		return {
			email_id: typeof r.emailId === "string" ? r.emailId : null,
			provider_message_id: typeof r.providerMessageId === "string" ? r.providerMessageId : null,
			scheduled: r.scheduled === true,
		};
	});
}

/** Where approval links point: this deployment's origin, or relative when none is known. */
async function linkBase(c: AppContext): Promise<string> {
	return (await trackingBaseUrl(c.env, trackingBaseUrlFromRequest(c.req.url))) ?? "";
}

async function presentContext(c: AppContext): Promise<PresentContext> {
	return { mailbox: mailboxOf(c).toLowerCase(), base: await linkBase(c) };
}

/**
 * One approval with what became of the mail it sent: each message's Sent-row
 * id, the provider's id and its delivery status (`sent`, `queued`, `failed`,
 * `bounced`, ...). Read from the mailbox, so only for single-item responses.
 */
async function presentWithDelivery(
	c: AppContext,
	row: ApprovalRecord,
	where: { mailbox: string; stub: { getDeliverySummaries(ids: string[]): Promise<unknown> } } = { mailbox: mailboxOf(c), stub: c.var.mailboxStub },
) {
	const out = present(row, { mailbox: where.mailbox.toLowerCase(), base: await linkBase(c) });
	const ids = out.sent_messages.map((m) => m.email_id).filter((id): id is string => !!id);
	if (ids.length === 0) return out;
	try {
		const rows = (await where.stub.getDeliverySummaries(ids)) as DeliverySummary[];
		const byId = new Map(rows.map((r) => [r.id, r]));
		return {
			...out,
			sent_messages: out.sent_messages.map((m) => {
				const d = m.email_id ? byId.get(m.email_id) : undefined;
				return d
					? { ...m, delivery_status: d.deliveryStatus, delivery_error: d.deliveryError, provider_message_id: d.providerMessageId ?? m.provider_message_id }
					: m;
			}),
		};
	} catch (e) {
		console.error("approval delivery lookup failed:", (e as Error).message);
		return out;
	}
}

/** Context every presented approval needs: its mailbox and the link origin. */
export interface PresentContext {
	mailbox: string;
	base: string;
}

/** What the API returns for one approval: everything a reviewer needs to decide. */
export function present(a: ApprovalRecord, at: PresentContext) {
	const payload = a.payload as { type?: string; batch?: HeldBatch; enrollment?: HeldEnrollment };
	const messages = payload.batch?.messages ?? [];
	return {
		id: a.id,
		/** The mailbox it was sent from, so a list across mailboxes names each row. */
		mailbox: at.mailbox,
		/** The page that opens this approval directly; the same link a held send returns. */
		approval_url: `${at.base}${approvalPath(at.mailbox, a.id)}`,
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
			/** `false`: the sender asked for no open/click tracking on this message. Null follows the mailbox. */
			track: m.track ?? null,
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
		/**
		 * Whether open/click tracking is added when it is sent (per the mailbox
		 * settings and recipient opt-outs). False when the sender turned tracking
		 * off for every message.
		 */
		tracking_added_at_send: payload.enrollment ? true : messages.length === 0 || messages.some((m) => m.track !== false),
		editable: a.status === "pending" && (payload.batch?.messages.length ?? 0) === 1,
		/** 1 when stored, +1 per edit. Pass it to approve so a newer version is not sent unseen. */
		revision: a.revision,
		revised_at: a.revisedAt ? new Date(a.revisedAt).toISOString() : null,
		/** `requester` when the agent revised its own send, `reviewer` when a person edited it. */
		revised_by: a.revisedBy,
		requested_by: a.actor,
		result: a.result,
		/**
		 * The messages approving produced: the Sent row id and the provider's id.
		 * Single-item responses add `delivery_status` (`sent` when the provider
		 * accepted it, `queued`, `failed` or `bounced`) and `delivery_error`.
		 */
		sent_messages: sentMessagesOf(a.result),
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
	const at = await presentContext(c);
	return c.json({ approvals: rows.map((r) => present(r, at)) });
});

approvalRoutes.get(`${BASE}/count`, requireCapability("read"), async (c) => {
	return c.json({ pending: await c.var.mailboxStub.countPendingSendApprovals() });
});

approvalRoutes.get(`${BASE}/:id`, requireCapability("read"), async (c) => {
	const row = (await c.var.mailboxStub.getSendApproval(c.req.param("id"))) as ApprovalRecord | null;
	if (!row) return c.json({ error: "Approval not found" }, 404);
	return c.json({ approval: await presentWithDelivery(c, row) });
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
	const body = ReviewerEditBody.parse(await c.req.json().catch(() => ({})));
	const outcome = await editHeld({
		env: c.env,
		mailboxId: mailboxOf(c),
		id: row.id,
		expectedRevision: body.revision ?? null,
		edits: {
			...(body.to ? { to: Array.isArray(body.to) ? body.to : [body.to] } : {}),
			...(body.cc ? { cc: Array.isArray(body.cc) ? body.cc : [body.cc] } : {}),
			...(body.subject !== undefined ? { subject: body.subject } : {}),
			...(body.html !== undefined ? { html: body.html } : {}),
			...(body.markdown !== undefined ? { markdown: body.markdown } : {}),
		},
		// The edited body passes the same verifier an agent's body does, and the
		// verified result is what gets stored and shown.
		verify: editVerifier(c.env),
	});
	if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
	return c.json({ approval: present(outcome.approval, await presentContext(c)) });
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
			...(body.markdown !== undefined ? { markdown: body.markdown } : {}),
		},
		verify: editVerifier(c.env),
		checkRecipients: (recipients) => revisionRecipientRefusal(c.env, mailboxOf(c), principal, recipients),
		waitUntil: waitUntilOf(c),
	});
	if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
	return c.json({ approval: present(outcome.approval, await presentContext(c)) });
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
		return c.json({ error: outcome.error, ...(outcome.approval ? { approval: present(outcome.approval, await presentContext(c)) } : {}) }, outcome.status);
	}
	return c.json({ approval: await presentWithDelivery(c, outcome.approval), result: outcome.result });
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
	return c.json({ approval: present(outcome.approval, await presentContext(c)) });
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
	return c.json({ approval: present(reopened, await presentContext(c)) });
});

// ── Across mailboxes ──────────────────────────────────────────────
//
// An agent holds a send in whichever mailbox it sent from; the person (or the
// agent checking on it) should not have to know which. These read every
// mailbox the caller may read, at most CROSS_MAILBOX_MAX of them.

/** Most mailboxes one cross-mailbox call reads. */
export const CROSS_MAILBOX_MAX = 50;

approvalRoutes.get("/api/v1/approvals", async (c) => {
	const raw = c.req.query("status") ?? "pending";
	const status = raw === "all" || (APPROVAL_STATUSES as readonly string[]).includes(raw) ? (raw as ApprovalStatus | "all") : "pending";
	const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
	const all = await readableMailboxes(c.env, c.var.principal);
	const mailboxes = all.slice(0, CROSS_MAILBOX_MAX);
	const base = await linkBase(c);
	const found: ReturnType<typeof present>[] = [];
	await Promise.all(
		mailboxes.map(async (mailbox) => {
			try {
				const rows = (await getMailboxStub(c.env, mailbox).listSendApprovals({ status, limit })) as ApprovalRecord[];
				for (const r of rows) found.push(present(r, { mailbox, base }));
			} catch (e) {
				console.error(`approvals: ${mailbox} unreadable:`, (e as Error).message);
			}
		}),
	);
	found.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
	return c.json({
		approvals: found.slice(0, limit),
		mailboxes_checked: mailboxes,
		truncated: all.length > mailboxes.length,
	});
});

/** One approval by id, wherever it is: the CLI's `approval show <id>` without --mailbox. */
approvalRoutes.get("/api/v1/approvals/:id", async (c) => {
	const id = c.req.param("id") ?? "";
	if (!/^apr_[A-Za-z0-9]{1,64}$/.test(id)) return c.json({ error: "Approval not found" }, 404);
	const mailboxes = (await readableMailboxes(c.env, c.var.principal)).slice(0, CROSS_MAILBOX_MAX);
	const hits = await Promise.all(
		mailboxes.map(async (mailbox) => {
			try {
				const stub = getMailboxStub(c.env, mailbox);
				const row = (await stub.getSendApproval(id)) as ApprovalRecord | null;
				return row ? { mailbox, stub, row } : null;
			} catch {
				return null;
			}
		}),
	);
	const hit = hits.find((h) => h !== null);
	if (!hit) return c.json({ error: "Approval not found in any mailbox you can read" }, 404);
	return c.json({ approval: await presentWithDelivery(c, hit.row, { mailbox: hit.mailbox, stub: hit.stub }) });
});

/**
 * Each readable mailbox's agent send policy, and what happens to a send by
 * THIS caller: `sent` (goes straight out), `held` (waits for a person, unless
 * every recipient is on `skip_approval`), `refused` (draft only) or
 * `not_allowed` (no send capability). Read only; a person changes it in the
 * mailbox settings.
 */
approvalRoutes.get("/api/v1/send-policies", async (c) => {
	const principal = c.var.principal;
	const method = c.var.authMethod ?? principal.credential?.method ?? "session";
	const gated = method === "token" || method === "oauth";
	const mayAutoSend = principal.credential?.sendAuto === true;
	const mailboxes = (await readableMailboxes(c.env, principal)).slice(0, CROSS_MAILBOX_MAX);
	const policies = await Promise.all(
		mailboxes.map(async (mailbox) => {
			const policy = await loadPolicy(c.env, mailbox);
			const inbox = await getAgentInbox(c.env.BUCKET, mailbox).catch(() => null);
			const maySend = canDo(principal, mailbox, "sendAs") || canDo(principal, mailbox, "sendOnBehalf");
			let yourSends: "sent" | "held" | "refused" | "not_allowed";
			if (!maySend) yourSends = "not_allowed";
			else if (!gated) yourSends = "sent";
			else {
				const decision = decideAgentSend({ policy, recipients: [], credentialMayAutoSend: mayAutoSend });
				yourSends = decision.action === "refuse" ? "refused" : decision.action === "send" ? "sent" : "held";
			}
			return {
				mailbox,
				mode: policy.mode,
				/** Recipients an agent may send to without approval in `approve` mode. */
				skip_approval: policy.allowlist,
				/** An agent inbox's hard recipient limit; null when it may send to anyone. */
				allowed_recipients: inbox?.allowed_recipients ?? null,
				your_sends: yourSends,
			};
		}),
	);
	return c.json({ credential_may_auto_send: gated ? mayAutoSend : null, policies });
});
