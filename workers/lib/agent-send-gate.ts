// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Agent send approval, as a rule in the shared pre-send gate.
 *
 * `shared/agent-send-policy.ts` decides; {@link agentApprovalRule} applies the
 * decision from inside `preSend` (`workers/lib/pre-send.ts`), which every
 * outbound path must pass before `sendEmail` will run. So the rule covers
 * every transport at once: REST routes, MCP tools, the in-app agent.
 *
 * It keys on the CREDENTIAL, not the transport. A `ttk_` API token or an MCP
 * OAuth grant is an agent credential wherever it is used; a browser session is
 * a person and is never held. Cron, inbound and system mail have no agent
 * behind them. Suppressions, caps and the spam breaker are the gate's
 * built-ins and run first, so nobody is asked to approve undeliverable mail.
 *
 * A hold stores the path's fully composed message ({@link HoldPayload}): the
 * preview shows it and approving sends exactly that ({@link approveHeld},
 * `workers/lib/held-send.ts`). Every outcome is audited with the user and the
 * API token or OAuth app.
 */

import {
	agentSendPolicyFrom,
	collectRecipients,
	decideAgentSend,
	describeActor,
	type ApprovalActor,
	type ApprovalKind,
} from "../../shared/agent-send-policy";
import { parseStoredMailboxSettings } from "../../shared/mailbox-settings";
import { agentInboxKey, decideAgentSendPolicy, isAgentSendMode as isInboxSendMode, stricterSendMode } from "../../shared/agent-inboxes";
import type { ApprovalRecord, ApprovalReviser, ClaimOutcome, FinishOutcome } from "../durableObject/approvals";
import { newApprovalId } from "../durableObject/approvals";
import type { Principal } from "./authz";
import { auditActorRole, credentialDetail, recordAudit } from "./audit";
import { getMailboxStub } from "./email-helpers";
import {
	batchSummary,
	draftsToBatch,
	dropStash,
	sendComposed,
	type ComposedDraft,
	type HeldBatch,
	type HeldEnrollment,
	type SendComposedDeps,
} from "./held-send";
import {
	PRE_SEND_RULES,
	type PreSendRule,
	type PreSendRuleContext,
	type PreSendRuleVerdict,
	type SendActor,
} from "./pre-send";
import { trackingBaseUrl } from "./tracking-send";
import type { Env } from "../types";

// ── Who is gated ───────────────────────────────────────────────────

/**
 * Whether a send is subject to agent approval: an API token or OAuth grant on
 * any surface, or the MCP and in-app agent surfaces whatever the credential.
 * A released approval has already been approved. Pure; exported for tests.
 */
export function actorNeedsGate(actor: SendActor | undefined): boolean {
	if (!actor || actor.released) return false;
	if (actor.via === "cron" || actor.via === "inbound" || actor.via === "system") return false;
	if (actor.via === "mcp" || actor.via === "agent") return true;
	const method = actor.credential?.method ?? actor.principal?.credential?.method;
	return method === "token" || method === "oauth";
}

// ── Audit ──────────────────────────────────────────────────────────

export function actorFor(principal: Principal, via: "mcp" | "agent" | "api"): ApprovalActor {
	const cred = principal.credential;
	return {
		user: principal.identity?.id ?? null,
		via,
		method: cred?.method ?? null,
		tokenId: cred?.tokenId ?? null,
		tokenName: cred?.tokenName ?? null,
		oauthClientId: cred?.oauthClientId ?? null,
		oauthClientName: cred?.oauthClientName ?? null,
	};
}

type WaitUntil = (p: Promise<unknown>) => void;

function audit(env: Env, input: Parameters<typeof recordAudit>[1], waitUntil?: WaitUntil) {
	const write = recordAudit(env.BUCKET, input);
	if (waitUntil) {
		try {
			waitUntil(write);
			return Promise.resolve();
		} catch {
			/* fall through */
		}
	}
	return write;
}

/**
 * The mailbox's agent send policy. For an agent inbox (#127) the inbox's
 * `send_mode` maps onto it, and the stricter of the two wins, so neither a
 * settings change nor an inbox record can loosen the other.
 */
async function loadPolicy(env: Env, mailboxId: string) {
	try {
		const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
		const policy = agentSendPolicyFrom(parseStoredMailboxSettings(obj ? await obj.json() : {}));
		const inbox = await env.BUCKET.get(agentInboxKey(mailboxId));
		const inboxMode = inbox ? ((await inbox.json()) as { send_mode?: unknown } | null)?.send_mode : undefined;
		return isInboxSendMode(inboxMode) ? { ...policy, mode: stricterSendMode(policy.mode, inboxMode) } : policy;
	} catch (e) {
		// Unreadable settings fall back to the safe default (approve), never auto.
		console.error(`agent send policy for ${mailboxId} unreadable:`, (e as Error).message);
		return agentSendPolicyFrom(null);
	}
}

// ── Holding ────────────────────────────────────────────────────────

/**
 * Where a person approves a held send. Relative when no deployment origin is
 * known, so it never names another host.
 */
export async function approvalUrl(env: Env, mailboxId: string, id: string, origin?: string | null): Promise<string> {
	const base = (await trackingBaseUrl(env, origin ?? null)) ?? "";
	return `${base}/mail/${encodeURIComponent(mailboxId)}/approvals?id=${encodeURIComponent(id)}`;
}

export interface HoldInput {
	env: Env;
	principal: Principal;
	mailboxId: string;
	kind: ApprovalKind;
	reason: "approval_required" | "injection_suspected";
	via: "mcp" | "agent" | "api";
	origin?: string | null;
	waitUntil?: WaitUntil;
	/** Pre-minted, when attachments were stashed under it. */
	approvalId?: string;
}

/** The response a held send returns: 202 on REST, the tool result on MCP. */
export interface HeldResponse {
	status: "pending_approval";
	approval_id: string;
	approval_url: string;
	expires_at: string;
	reason: string;
	message: string;
}

async function hold(
	input: HoldInput,
	payload: Record<string, unknown>,
	recipients: string[],
	subject: string,
): Promise<HeldResponse> {
	const { env, principal, mailboxId, kind } = input;
	const stub = getMailboxStub(env, mailboxId);
	const approval = (await stub.createSendApproval({
		id: input.approvalId,
		kind,
		reason: input.reason,
		recipients,
		subject,
		payload,
		actor: actorFor(principal, input.via),
	})) as ApprovalRecord;
	await audit(
		env,
		{
			action: "agent.send_held",
			actor: principal.identity?.id ?? null,
			actorRole: auditActorRole(principal, mailboxId),
			mailboxId,
			target: recipients[0],
			detail: { tool: kind, via: input.via, reason: input.reason, approval: approval.id, recipients: recipients.length, ...credentialDetail(principal) },
		},
		input.waitUntil,
	);
	return {
		status: "pending_approval",
		approval_id: approval.id,
		approval_url: await approvalUrl(env, mailboxId, approval.id, input.origin),
		expires_at: new Date(approval.expiresAt).toISOString(),
		reason: input.reason,
		message:
			input.reason === "injection_suspected"
				? "Not sent yet. Content read in this session looked like it contained instructions, so this waits for the user's approval. Tell the user; do not retry."
				: "Not sent yet. This mailbox requires the user to approve agent sends. Tell the user it is waiting in Pending approval; do not retry or send it another way.",
	};
}

/** Hold fully composed messages. The batch is stored as-is and is what gets sent. */
export function holdBatch(input: HoldInput, batch: HeldBatch): Promise<HeldResponse> {
	const { recipients, subject } = batchSummary(batch);
	return hold(input, { type: "batch", batch }, recipients, subject);
}

/** Hold a sequence enrollment; the preview shows the sequence and its steps. */
export function holdEnrollment(input: HoldInput, enrollment: HeldEnrollment): Promise<HeldResponse> {
	return hold(input, { type: "enrollment", enrollment }, [enrollment.enroll.personEmail.toLowerCase()], `Sequence: ${enrollment.sequenceName}`);
}

/** Mint the id to stash attachments under before holding. */
export const mintApprovalId = newApprovalId;

// ── Approving, editing, rejecting ──────────────────────────────────

/** Enrolls a held enrollment; injected so the gate does not import the sequence store. */
export type EnrollExecutor = (env: Env, enrollment: HeldEnrollment) => Promise<Record<string, unknown>>;

export type ApproveOutcome =
	| { ok: true; approval: ApprovalRecord; result: Record<string, unknown> }
	| { ok: false; status: 404 | 409 | 410 | 422 | 502; error: string; approval: ApprovalRecord | null };

export interface ApproveInput {
	env: Env;
	mailboxId: string;
	id: string;
	approver: Principal;
	enroll: EnrollExecutor;
	deps?: SendComposedDeps;
	waitUntil?: WaitUntil;
	/**
	 * The revision the approver previewed. When given, an approve after a newer
	 * edit (say the agent revised it meanwhile) is refused with 409 and sends
	 * nothing, so nobody approves text they have not seen.
	 */
	expectedRevision?: number | null;
}

/**
 * Approve and send exactly what is stored, at most once.
 *
 * The claim writes a fresh fence; the outcome is recorded only under it. A
 * deterministic provider refusal is `failed` (retryable); anything ambiguous is
 * `sent_unconfirmed` (never retried).
 */
export async function approveHeld(input: ApproveInput): Promise<ApproveOutcome> {
	const { env, mailboxId, id, approver } = input;
	const stub = getMailboxStub(env, mailboxId);
	const current = (await stub.getSendApproval(id)) as ApprovalRecord | null;
	if (!current) return { ok: false, status: 404, error: "Approval not found", approval: null };
	if (current.status !== "pending") {
		return { ok: false, status: 409, error: `Already ${current.status.replace("_", " ")}; nothing was sent again.`, approval: current };
	}

	// Suppressions, caps and the breaker are re-checked at release by the
	// pre-send gate inside `sendComposed`; a refusal there is "not sent".

	const claim = (await stub.claimSendApproval(id, {
		decidedBy: approver.identity?.id ?? null,
		expectedRevision: input.expectedRevision ?? null,
	})) as ClaimOutcome;
	if (!claim.ok) {
		if (claim.reason === "not_found") return { ok: false, status: 404, error: "Approval not found", approval: null };
		if (claim.reason === "expired") return { ok: false, status: 410, error: "This approval has expired.", approval: claim.approval };
		if (claim.reason === "changed") {
			return {
				ok: false,
				status: 409,
				error: "It was changed after you opened it. Nothing was sent. Review the new version, then approve.",
				approval: claim.approval,
			};
		}
		return { ok: false, status: 409, error: `Already ${claim.approval?.status ?? "decided"}; nothing was sent again.`, approval: claim.approval };
	}

	const payload = claim.approval.payload as { type?: string; batch?: HeldBatch; enrollment?: HeldEnrollment };
	let outcome: FinishOutcome;
	if (payload.type === "enrollment" && payload.enrollment) {
		try {
			const result = await input.enroll(env, payload.enrollment);
			outcome = { status: "sent", result };
		} catch (e) {
			// Enrolling writes our own records and sends nothing itself, so a failure
			// here is definitely not a send.
			outcome = { status: "failed", error: (e as Error).message || "Enrollment failed" };
		}
	} else if (payload.type === "batch" && payload.batch) {
		const sent = await sendComposed(env, mailboxId, payload.batch, input.deps);
		if (sent.ok) {
			outcome = { status: "sent", result: { messages: sent.results } };
		} else if (sent.kind === "rejected" && sent.sentSoFar === 0) {
			outcome = { status: "failed", error: sent.error };
		} else {
			// Ambiguous, or part of a batch already went: never retry.
			outcome = {
				status: "sent_unconfirmed",
				error: sent.sentSoFar > 0 ? `${sent.sentSoFar} of ${payload.batch.messages.length} sent, then: ${sent.error}` : sent.error,
			};
		}
	} else {
		outcome = { status: "failed", error: "This approval has no message to send." };
	}

	const finished = (await stub.finishSendApproval(id, claim.fence, outcome)) as ApprovalRecord | null;
	if (outcome.status === "sent") await dropStash(env.BUCKET, id);

	await audit(
		env,
		{
			action: "approval.approve",
			actor: approver.identity?.id ?? null,
			actorRole: auditActorRole(approver, mailboxId),
			mailboxId,
			target: current.recipients[0],
			detail: {
				approval: id,
				tool: current.kind,
				outcome: outcome.status,
				requestedBy: describeActor(current.actor).slice(0, 200),
				...credentialDetail(approver),
			},
		},
		input.waitUntil,
	);

	if (outcome.status === "sent") return { ok: true, approval: finished ?? claim.approval, result: outcome.result };
	return { ok: false, status: 502, error: outcome.error, approval: finished };
}

export async function rejectHeld(input: {
	env: Env;
	mailboxId: string;
	id: string;
	approver: Principal;
	note?: string | null;
	waitUntil?: WaitUntil;
}): Promise<{ ok: true; approval: ApprovalRecord } | { ok: false; status: 404 | 409; error: string }> {
	const stub = getMailboxStub(input.env, input.mailboxId);
	const outcome = (await stub.rejectSendApproval(input.id, {
		decidedBy: input.approver.identity?.id ?? null,
		note: input.note ?? null,
	})) as ClaimOutcome;
	if (!outcome.ok) {
		return outcome.reason === "not_found"
			? { ok: false, status: 404, error: "Approval not found" }
			: { ok: false, status: 409, error: `Already ${outcome.approval?.status ?? "decided"}.` };
	}
	await dropStash(input.env.BUCKET, input.id);
	await audit(
		input.env,
		{
			action: "approval.reject",
			actor: input.approver.identity?.id ?? null,
			actorRole: auditActorRole(input.approver, input.mailboxId),
			mailboxId: input.mailboxId,
			target: outcome.approval.recipients[0],
			detail: { approval: input.id, tool: outcome.approval.kind, requestedBy: describeActor(outcome.approval.actor).slice(0, 200), ...credentialDetail(input.approver) },
		},
		input.waitUntil,
	);
	return { ok: true, approval: outcome.approval };
}

// ── Editing ────────────────────────────────────────────────────────

export interface ApprovalEdits {
	to?: string[];
	cc?: string[];
	subject?: string;
	html?: string;
}

/** Verifies an edited body; injected so tests can stub the AI. Returns the body to store, or an error. */
export type EditVerifier = (html: string) => Promise<{ ok: true; html: string } | { ok: false; error: string }>;

/**
 * Apply a reviewer's edits to a pending single-message approval. The edited
 * body goes through the verifier again and the result REPLACES the stored
 * message, so the next preview is exactly what approve will send.
 */
export async function editHeld(input: {
	env: Env;
	mailboxId: string;
	id: string;
	edits: ApprovalEdits;
	verify: EditVerifier;
	/** Who is editing; recorded on the row. Default `reviewer`. */
	revisedBy?: ApprovalReviser;
	/** Mark the item injection-suspected (the revising session tripped since the hold). */
	injectionSuspected?: boolean;
}): Promise<{ ok: true; approval: ApprovalRecord } | { ok: false; status: 404 | 409 | 422; error: string }> {
	const stub = getMailboxStub(input.env, input.mailboxId);
	const current = (await stub.getSendApproval(input.id)) as ApprovalRecord | null;
	if (!current) return { ok: false, status: 404, error: "Approval not found" };
	if (current.status !== "pending") return { ok: false, status: 409, error: `Already ${current.status}; it can no longer be edited.` };
	const payload = current.payload as { type?: string; batch?: HeldBatch };
	if (payload.type !== "batch" || !payload.batch || payload.batch.messages.length !== 1) {
		return { ok: false, status: 422, error: "Only a single held message can be edited. Reject it and ask again instead." };
	}
	const message = { ...payload.batch.messages[0]! };
	if (input.edits.to) {
		const to = collectRecipients(input.edits.to);
		if (to.length === 0) return { ok: false, status: 422, error: "The message needs at least one recipient." };
		message.to = to;
	}
	if (input.edits.cc) message.cc = collectRecipients(input.edits.cc);
	if (typeof input.edits.subject === "string") message.subject = input.edits.subject.replace(/[\r\n]+/g, " ").slice(0, 998);
	if (typeof input.edits.html === "string") {
		const verified = await input.verify(input.edits.html);
		if (!verified.ok) return { ok: false, status: 422, error: verified.error };
		message.html = verified.html;
		// A plain-text part composed with the old body would now say something
		// else; drop it so the edited HTML is the only version that goes out.
		delete message.text;
	}
	const batch: HeldBatch = { ...payload.batch, messages: [message] };
	const { recipients, subject } = batchSummary(batch);
	const updated = (await stub.updatePendingSendApproval(input.id, {
		payload: { type: "batch", batch },
		recipients,
		subject,
		revisedBy: input.revisedBy ?? "reviewer",
		...(input.injectionSuspected ? { reason: "injection_suspected" } : {}),
	})) as ApprovalRecord | null;
	if (!updated) return { ok: false, status: 409, error: "It was decided while you were editing; nothing was changed." };
	return { ok: true, approval: updated };
}

/**
 * The recipient rule a new send from this mailbox would face, for a revision:
 * an agent inbox's `allowed_recipients` (and `draft_only` for its own token).
 * Null when the recipients are fine. Shared by the REST and MCP revise paths.
 */
export async function revisionRecipientRefusal(env: Env, mailboxId: string, principal: Principal, recipients: string[]): Promise<string | null> {
	const object = await env.BUCKET.get(agentInboxKey(mailboxId));
	if (!object) return null;
	const record = (await object.json()) as Parameters<typeof decideAgentSendPolicy>[0];
	const tokenId = principal.credential?.tokenId ?? null;
	const decision = decideAgentSendPolicy(record, recipients, tokenId !== null && tokenId === (record as { token_id?: string | null } | null)?.token_id);
	return decision.ok ? null : decision.error;
}

/**
 * Whether `principal` is the credential that asked for this held send: the
 * same API token, the same OAuth app, or (for the in-app agent) the same
 * user. Only the requester may revise its own request; anyone else edits as a
 * reviewer, through the deciding routes.
 */
export function isRequester(principal: Principal, actor: ApprovalActor, via: ApprovalActor["via"]): boolean {
	const cred = principal.credential;
	const user = principal.identity?.id ?? null;
	if (!user || actor.user !== user) return false;
	if (actor.tokenId) return cred?.tokenId === actor.tokenId;
	if (actor.oauthClientId) return cred?.oauthClientId === actor.oauthClientId;
	// The in-app agent acts under the user's session; no credential to compare.
	return actor.via === "agent" && via === "agent";
}

/**
 * The agent revises its OWN pending send: new text, subject or recipients,
 * in place, so the person sees one item with the latest version instead of an
 * old one to reject and a new one to approve.
 *
 * Revising is not deciding, so it does not need `approvals:manage`, and it
 * cannot release anything: the item stays pending and a person still has to
 * approve it. The body passes the same verifier as a fresh send. The recipient
 * rules that apply to a new send apply here too (`checkRecipients`), so a
 * revision cannot reach anyone a new request could not. An approve that names
 * the old revision is refused, so a person never sends a version they did not
 * see.
 */
export async function reviseHeld(input: {
	env: Env;
	mailboxId: string;
	id: string;
	principal: Principal;
	via: ApprovalActor["via"];
	edits: ApprovalEdits;
	verify: EditVerifier;
	/** Refusal for recipients a new send could not reach (agent inbox allowlist). Null when they are fine. */
	checkRecipients: (recipients: string[]) => Promise<string | null>;
	/**
	 * The revising session read injection-looking content since the hold. The
	 * item is then shown as injection-suspected, so the person checks the new
	 * recipients and text with that warning.
	 */
	injectionSuspected?: boolean;
	waitUntil?: WaitUntil;
}): Promise<{ ok: true; approval: ApprovalRecord } | { ok: false; status: 403 | 404 | 409 | 422; error: string }> {
	const stub = getMailboxStub(input.env, input.mailboxId);
	const current = (await stub.getSendApproval(input.id)) as ApprovalRecord | null;
	if (!current) return { ok: false, status: 404, error: "Approval not found" };
	if (!isRequester(input.principal, current.actor, input.via)) {
		return { ok: false, status: 403, error: "Only the agent that asked for this send can revise it. A person can edit it in the app." };
	}
	if (current.status !== "pending") {
		return { ok: false, status: 409, error: `Already ${current.status.replace("_", " ")}; it can no longer be revised. Ask again if it still needs sending.` };
	}
	if (input.edits.to || input.edits.cc) {
		const payload = current.payload as { batch?: HeldBatch };
		const message = payload.batch?.messages[0];
		const to = input.edits.to ? collectRecipients(input.edits.to) : (message?.to ?? []);
		const cc = input.edits.cc ? collectRecipients(input.edits.cc) : (message?.cc ?? []);
		const refusal = await input.checkRecipients([...to, ...cc, ...(message?.bcc ?? [])]);
		if (refusal) return { ok: false, status: 422, error: refusal };
	}
	const outcome = await editHeld({
		env: input.env,
		mailboxId: input.mailboxId,
		id: input.id,
		edits: input.edits,
		verify: input.verify,
		revisedBy: "requester",
		injectionSuspected: input.injectionSuspected === true,
	});
	if (!outcome.ok) return outcome;
	await audit(
		input.env,
		{
			action: "agent.send_revised",
			actor: input.principal.identity?.id ?? null,
			actorRole: auditActorRole(input.principal, input.mailboxId),
			mailboxId: input.mailboxId,
			target: outcome.approval.recipients[0],
			detail: {
				approval: input.id,
				tool: outcome.approval.kind,
				via: input.via,
				revision: outcome.approval.revision,
				fields: Object.keys(input.edits).join(","),
				...credentialDetail(input.principal),
			},
		},
		input.waitUntil,
	);
	return outcome;
}

// ── The pre-send rule ──────────────────────────────────────────────

/**
 * What a send path puts in `hold.payload` so this rule can store it: the
 * fully composed message (or batch, or a sequence enrollment), built from the
 * same values the path hands to `preSend`. Storing this, not the request, is
 * what makes approve send exactly what the person previewed.
 */
export type HoldPayload = { composed: ComposedDraft[]; note?: string } | { enrollment: HeldEnrollment };

/** Map a send action to the approval kind it is stored as. */
function kindForAction(action: string, via: SendActor["via"]): ApprovalKind {
	const rest = via === "rest";
	switch (action) {
		case "send_reply":
			return rest ? "rest_reply" : "send_reply";
		case "forward_email":
			return rest ? "rest_forward" : "forward_email";
		case "schedule_send":
			return rest ? "rest_schedule" : "schedule_send";
		case "send_template":
		case "template_send":
			return rest ? "rest_template" : "send_template";
		case "sequence_enroll":
			return "sequence_enroll";
		default:
			return rest ? "rest_send" : "send_email";
	}
}

/**
 * The per-credential approval policy, as a pre-send rule. Runs after the
 * built-ins (limits, caps, breaker, suppressions).
 */
export const agentApprovalRule: PreSendRule = {
	name: "agent_send_approval",
	async check(ctx: PreSendRuleContext): Promise<PreSendRuleVerdict | null> {
		const { env, input } = ctx;
		const actor = input.actor;
		if (!actorNeedsGate(actor) || !input.mailboxId) return null;
		const principal = (actor!.principal ?? null) as Principal | null;
		const recipients = collectRecipients(ctx.to, ctx.cc, ctx.bcc);
		const via: "mcp" | "agent" | "api" = actor!.via === "rest" ? "api" : actor!.via === "agent" ? "agent" : "mcp";

		const policy = await loadPolicy(env, input.mailboxId);
		const decision = decideAgentSend({
			policy,
			recipients,
			credentialMayAutoSend: principal?.credential?.sendAuto === true,
			injectionSuspected: actor!.injectionSuspected === true,
		});
		const auditBase = {
			actor: principal?.identity?.id ?? null,
			actorRole: principal ? auditActorRole(principal, input.mailboxId) : ("system" as const),
			mailboxId: input.mailboxId,
			target: recipients[0],
		};
		const detail = {
			tool: input.hold?.action ?? "send",
			via,
			recipients: recipients.length,
			...(principal ? credentialDetail(principal) : {}),
		};

		if (decision.action === "refuse") {
			await audit(env, { ...auditBase, action: "agent.send_refused", detail: { ...detail, reason: decision.reason } });
			return {
				outcome: "block",
				code: "draft_only",
				status: 403,
				error:
					"Not sent: this mailbox only lets agents and API tokens write drafts. Save a draft instead; the user can send it from the app. Do not retry the send.",
			};
		}
		if (decision.action === "send") {
			await audit(env, { ...auditBase, action: "agent.send", detail: { ...detail, reason: decision.reason } });
			return null;
		}

		const payload = input.hold?.payload as HoldPayload | undefined;
		if (!payload || !principal || !("composed" in payload || "enrollment" in payload)) {
			// A send that has to wait for a person but cannot be stored: refused,
			// never sent (fail closed).
			return {
				outcome: "block",
				code: "approval_required",
				status: 403,
				error: "This send needs a person's approval, which is not available on this path. Ask the user to send it from the app.",
			};
		}
		const holdInput: HoldInput = {
			env,
			principal,
			mailboxId: input.mailboxId,
			kind: kindForAction(input.hold!.action, actor!.via),
			reason: decision.reason,
			via,
		};
		let held: HeldResponse;
		if ("enrollment" in payload) {
			held = await holdEnrollment(holdInput, payload.enrollment);
		} else {
			// Store only what would actually go: the built-ins already removed
			// suppressed recipients, and a message left with no To is dropped.
			const surviving = new Set([...ctx.to, ...ctx.cc, ...ctx.bcc].map((a) => a.toLowerCase()));
			const keep = (list: string[] | undefined) => (list ?? []).filter((a) => surviving.has(a.trim().toLowerCase()));
			const drafts = payload.composed
				.map((d) => ({ ...d, to: keep(d.to), cc: keep(d.cc), bcc: keep(d.bcc) }))
				.filter((d) => d.to.length > 0);
			if (drafts.length === 0) {
				return { outcome: "block", code: "all_suppressed", status: 422, error: "Every recipient is on the suppression list" };
			}
			const id = mintApprovalId();
			const batch = await draftsToBatch(env.BUCKET, id, drafts, payload.note);
			held = await holdBatch({ ...holdInput, approvalId: id }, batch);
		}
		return { outcome: "hold_for_approval", approvalId: held.approval_id, approvalUrl: held.approval_url, response: { ...held } };
	},
};

/**
 * Registered after the built-in rules, so the order in `PRE_SEND_RULES` is:
 * the agent-inbox recipient policy (`agentInboxSendRule`, a hard block), then
 * this one (hold). The gate's own checks (limits, caps, breaker, suppressions)
 * run before every rule. Pushed rather than listed in pre-send.ts because that
 * module is loaded by the email sender and must stay free of this one's imports.
 */
PRE_SEND_RULES.push(agentApprovalRule);
