// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared tool business logic for the Agent and MCP server.
 *
 * Each function takes an `env: Env` (or a DO stub) and tool-specific params,
 * performs the business logic (DO calls, data fetching, formatting), and
 * returns a plain object. The Agent and MCP server wrap these results in
 * their own response formats.
 *
 * Functions that already exist in email-helpers.ts (getFullEmail, getFullThread)
 * are reused directly — this module covers the remaining shared operations.
 */

import type { EmailFull } from "./schemas";
import { warningsFor } from "./message-security";
import { assessSenderTrust, extractAuthenticationResults } from "../../shared/auth-results";
import {
	getMailboxStub,
	getFullEmail,
	getFullThread,
	buildQuotedReplyBlock,
	textToHtml,
	listMailboxes,
	generateMessageId,
	buildReferencesChain,
	buildOutgoingHeaders,
	assertMessageWithinSizeLimit,
	MessageTooLargeError,
	escapeHtml,
	resolveThreadedSend,
	stripHtmlToText,
} from "./email-helpers";
import {
	verifyDraft,
	isDraftable,
	isSendable,
	type DraftVerification,
} from "./ai";
import { aiFor } from "./ai-router";
import { describeSendError } from "../../shared/send-errors";
import { bareMessageId } from "../../shared/message-ids";
import { redactSecrets } from "../../shared/redact-secrets";
import { replyRecipients } from "../../shared/headers";
import { TERMINAL_FOLDERS } from "../durableObject/trash";
import type { MailboxDO } from "../durableObject";
import type { ThreadSummaryView } from "../durableObject/summaries";
import { briefRange, buildDailyBrief, type DailyBrief } from "../../shared/daily-brief";
import { collectForMailboxes } from "./daily-brief";

/**
 * Explain a refusal to send in terms of the actual cause, so a Workers AI
 * outage is not reported to the user as a problem with their message.
 */
function verificationRefusalMessage(result: DraftVerification): string {
	if (result.status === "unavailable") {
		return "Could not verify the draft because the AI verifier is unavailable, so it was not sent. The draft is unchanged — try again shortly, or send it from the UI.";
	}
	return "Draft verification failed — the body was entirely assistant commentary, so nothing was sent.";
}
import { sendEmail } from "../email-sender";
import {
	preSend,
	refusalBody,
	type QuotaStub,
	type SendActor,
	type SendClearance,
	type SendHoldRequest,
	type SuppressedRecipient,
} from "./pre-send";
import { bulkCompliance } from "./send-compliance";
import type { ComposedDraft } from "./held-send";
import { neutraliseAgentHtml } from "../../shared/agent-output";
import { UNSUBSCRIBE_PLACEHOLDER } from "../../shared/list-unsubscribe";
import { trackOutgoingHtml, trackingBaseUrl, type TrackingStub } from "./tracking-send";
import { trackingOptOutStore } from "./tracking-opt-outs";
import { engagementSummary, type EngagementFields } from "../../shared/engagement";
import { canMoveInto, Folders } from "../../shared/folders";
import type { Env } from "../types";
import type { FollowupView } from "../../shared/followups";
import { resolveExplicitFollowup } from "./followups";
import { TRIAGE_PRESET_KEYS, verdictLabel, type TriagePresetKey } from "../../shared/ai-triage";
import { readMailboxSettings, runBackfillStep, type TriageStub } from "./triage";
import { attachmentKey, storeAttachments } from "./attachments";
import { isBlockedAttachment } from "../../shared/attachment-types";
import { htmlToTextLines } from "../../shared/html-text";
import {
	buildForwardHeaderBlock,
	forwardBodyBytes,
	selectForwardAttachments,
} from "../../shared/forwarding";
import {
	filterPeople,
	mergePeople,
	parseDisplayName,
	sortPeople,
	type MailboxPersonRow,
} from "../../shared/people";
import {
	extractVariables,
	getTemplate,
	listTemplates,
	renderTemplate,
	type EmailTemplate,
} from "./templates";
import type { RuleInput } from "../durableObject/rules";
import { productTemplateVariables } from "./products";
import type { MailboxCapability } from "./capabilities";
import type { ApprovalRecord } from "../durableObject/approvals";
import type { ApprovalStatus } from "../../shared/agent-send-policy";
import type { HeldBatch, HeldEnrollment } from "./held-send";
import { previewEnrollment } from "./held-enrollment";
import { enrollPerson, getPersonEnrollment, listSequences } from "./sequences";
import { createTemplate, updateTemplate } from "./templates";
import { TRANSACTIONAL_BLOCKING_REASONS } from "./pre-send";
import { suppressionStore } from "./suppressions";
import { normalizeSuppressionAddress, sendingDomainOf } from "../../shared/suppressions";
import type { SuppressionRecord } from "../auth/types";
import type { MailboxEngagement, MailboxSendingStats } from "../durableObject/analytics";
import { analyticsWindow } from "./cf-analytics";
import type { ImportJobView } from "../../shared/mail-import";
import { buildUsage } from "./usage";
import { domainOfAddress, isDomainAllowed } from "./zones";

// ── Type casts for DO methods not on the base stub type ────────────
type MailboxSearchStub = {
	searchEmails: (options: {
		query: string;
		folder?: string;
	}) => Promise<unknown>;
};

type RateLimitStub = {
	checkSendRateLimit: () => Promise<string | null>;
};

// ── list_mailboxes ─────────────────────────────────────────────────

export async function toolListMailboxes(env: Env) {
	return listMailboxes(env.BUCKET);
}

// ── list_emails ────────────────────────────────────────────────────

export async function toolListEmails(
	env: Env,
	mailboxId: string,
	params: { folder: string; limit: number; page: number },
) {
	const stub = getMailboxStub(env, mailboxId);
	return stub.getEmails({
		folder: params.folder,
		limit: params.limit,
		page: params.page,
		sortColumn: "date",
		sortDirection: "DESC",
	});
}

// ── get_email ──────────────────────────────────────────────────────

export async function toolGetEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const email = await getFullEmail(stub, emailId);
	if (!email) return { error: "Email not found" };
	return email;
}

// ── get_thread ─────────────────────────────────────────────────────

export async function toolGetThread(
	env: Env,
	mailboxId: string,
	threadId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	return getFullThread(stub, threadId);
}

// ── search_emails ──────────────────────────────────────────────────

export async function toolSearchEmails(
	env: Env,
	mailboxId: string,
	params: { query: string; folder?: string },
) {
	const stub = getMailboxStub(env, mailboxId);
	return (stub as unknown as MailboxSearchStub).searchEmails({
		query: params.query,
		folder: params.folder,
	});
}

// ── draft_reply ────────────────────────────────────────────────────

/**
 * Shared draft-reply logic.
 *
 * @param bodyInput - The reply body text. Can be plain text or HTML.
 * @param options.isPlainText - If true, body is treated as plain text and
 *   converted to HTML. If false, body is treated as HTML.
 * @param options.runVerifyDraft - If true, runs AI verifyDraft on the body.
 *   The agent and MCP both do this, but the agent does it on plain text
 *   while MCP does it on HTML.
 */
export async function toolDraftReply(
	env: Env,
	mailboxId: string,
	params: {
		originalEmailId: string;
		to: string;
		subject: string;
		body: string;
		isPlainText?: boolean;
		runVerifyDraft?: boolean;
	},
): Promise<
	| { status: "draft_saved"; draftId: string; message: string; draft: Record<string, string> }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	// Verify/sanitize if requested
	let processedBody = params.body.trim();
	if (params.runVerifyDraft) {
		const verified = await verifyDraft(aiFor(env, { feature: "verifier" }), processedBody);
		if (!isDraftable(verified)) {
			return { error: "Draft verification failed — the body was entirely assistant commentary. Please try again." };
		}
		processedBody = neutraliseAgentHtml(verified.body);
	}

	// Convert plain text to HTML if needed
	if (params.isPlainText) {
		processedBody = textToHtml(processedBody);
	}

	const draftId = crypto.randomUUID();

	// Get the original email for thread_id and quoted text
	const original = (await stub.getEmail(params.originalEmailId)) as EmailFull | null;
	const threadId = original?.thread_id || params.originalEmailId;

	/**
	 * Where the reply actually goes, decided here rather than taken from the model.
	 *
	 * RFC 5322 §3.6.2: `Reply-To` names where the author asked replies to be sent.
	 * The prompt tells the model this address, but a prompt is guidance and this is
	 * a boundary — a model that ignores the instruction, or an MCP client calling
	 * the tool directly, would otherwise address the draft at a no-reply robot.
	 *
	 * Falls back to the model's `to` when the original cannot be read, since there
	 * is then nothing better to go on.
	 */
	const resolvedTo = original
		? (replyRecipients({
				raw_headers: original.raw_headers,
				sender: original.sender,
			})[0] ?? params.to)
		: params.to;

	// Append quoted original message
	const quotedBlock = original
		? buildQuotedReplyBlock({
				date: original.date,
				sender: original.sender || resolvedTo,
				body: original.body ?? undefined,
			})
		: "";
	const bodyHtml = processedBody + quotedBlock;

	await stub.createEmail(
		Folders.DRAFT,
		{
			id: draftId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: resolvedTo.toLowerCase(),
			date: new Date().toISOString(),
			body: bodyHtml,
			in_reply_to: params.originalEmailId,
			email_references: null,
			thread_id: threadId,
		},
		[],
	);

	return {
		status: "draft_saved",
		draftId,
		message: "Draft saved to Drafts folder. Review it and confirm to send.",
		draft: {
			originalEmailId: params.originalEmailId,
			// Reported as the address actually used, not the one asked for.
			to: resolvedTo,
			subject: params.subject,
			body: params.isPlainText ? params.body.trim() : bodyHtml,
		},
	};
}

// ── draft_email (new email, not a reply) ───────────────────────────

export async function toolDraftEmail(
	env: Env,
	mailboxId: string,
	params: {
		to: string;
		subject: string;
		body: string;
		isPlainText?: boolean;
		runVerifyDraft?: boolean;
		/** Optional in_reply_to for create_draft style */
		in_reply_to?: string;
		/** Optional thread_id for create_draft style */
		thread_id?: string;
	},
): Promise<
	| { status: string; draftId: string; threadId?: string; message: string; draft?: Record<string, string> }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	let processedBody = params.body.trim();
	if (params.runVerifyDraft) {
		const verified = await verifyDraft(aiFor(env, { feature: "verifier" }), processedBody);
		if (!isDraftable(verified)) {
			return { error: "Draft verification failed — the body was entirely assistant commentary. Please try again." };
		}
		processedBody = neutraliseAgentHtml(verified.body);
	}

	if (params.isPlainText) {
		processedBody = textToHtml(processedBody);
	}

	const draftId = crypto.randomUUID();

	// Resolve thread ID
	let resolvedThreadId = params.thread_id;
	if (!resolvedThreadId && params.in_reply_to) {
		const original = (await stub.getEmail(params.in_reply_to)) as EmailFull | null;
		resolvedThreadId = original?.thread_id || params.in_reply_to;
	}
	if (!resolvedThreadId) {
		resolvedThreadId = draftId;
	}

	await stub.createEmail(
		Folders.DRAFT,
		{
			id: draftId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: (params.to || "").toLowerCase(),
			date: new Date().toISOString(),
			body: processedBody,
			in_reply_to: params.in_reply_to || null,
			email_references: null,
			thread_id: resolvedThreadId,
		},
		[],
	);

	return {
		status: "draft_saved",
		draftId,
		threadId: resolvedThreadId,
		message: "Draft saved to Drafts folder. Review it and confirm to send.",
		draft: {
			to: params.to,
			subject: params.subject,
			body: params.isPlainText ? params.body.trim() : processedBody,
		},
	};
}

// ── update_draft ───────────────────────────────────────────────────

export async function toolUpdateDraft(
	env: Env,
	mailboxId: string,
	params: {
		draftId: string;
		to?: string;
		subject?: string;
		bodyHtml?: string;
	},
): Promise<
	| { status: string; newDraftId: string; oldDraftId: string; message: string }
	| { error: string }
> {
	const stub = getMailboxStub(env, mailboxId);

	const oldDraft = (await stub.getEmail(params.draftId)) as EmailFull | null;
	if (!oldDraft) {
		return { error: "Draft not found" };
	}

	// Verify the body BEFORE deleting the old draft to prevent data loss
	const newDraftId = crypto.randomUUID();
	const rawBody = params.bodyHtml ?? oldDraft.body ?? "";
	const verified = await verifyDraft(aiFor(env, { feature: "verifier" }), rawBody);

	if (!isDraftable(verified)) {
		return { error: "Draft verification failed — keeping existing draft unchanged. Please try again." };
	}
	const verifiedBody = neutraliseAgentHtml(verified.body);

	// Permanent: this replaces the draft in place. Binning the old copy would
	// leave a discarded revision in Trash every time the agent edits a draft.
	await stub.deleteEmail(params.draftId, { permanent: true });
	await stub.createEmail(
		Folders.DRAFT,
		{
			id: newDraftId,
			subject: params.subject ?? oldDraft.subject,
			sender: mailboxId.toLowerCase(),
			recipient: (params.to ?? oldDraft.recipient).toLowerCase(),
			date: new Date().toISOString(),
			body: verifiedBody,
			in_reply_to: oldDraft.in_reply_to || null,
			email_references: oldDraft.email_references || null,
			thread_id: oldDraft.thread_id || newDraftId,
		},
		[],
	);

	return {
		status: "draft_updated",
		newDraftId,
		oldDraftId: params.draftId,
		message: "Draft updated in Drafts folder.",
	};
}

// ── mark_email_read ────────────────────────────────────────────────

export async function toolMarkEmailRead(
	env: Env,
	mailboxId: string,
	emailId: string,
	read: boolean,
) {
	const stub = getMailboxStub(env, mailboxId);
	await stub.updateEmail(emailId, { read });
	return { status: "updated", emailId, read };
}

// ── move_email ─────────────────────────────────────────────────────

export async function toolMoveEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
	folderId: string,
) {
	// Named separately from a generic failure so the model is told *why* and does
	// not retry the same call. Drafts and Scheduled are not filing destinations —
	// see `canMoveInto`.
	if (!canMoveInto(folderId)) {
		return {
			error: `Messages cannot be moved into ${folderId}. Use draft_reply or draft_email to create a draft.`,
			emailId,
		};
	}

	const stub = getMailboxStub(env, mailboxId);
	const success = await stub.moveEmail(emailId, folderId);
	if (success) {
		return { status: "moved", emailId, folder: folderId };
	}
	return { error: "Failed to move email" };
}

// ── discard_draft ──────────────────────────────────────────────────

export async function toolDiscardDraft(
	env: Env,
	mailboxId: string,
	draftId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const email = (await stub.getEmail(draftId)) as { folder_id?: string } | null;
	if (!email) {
		return { error: "Draft not found" };
	}
	if (email.folder_id !== Folders.DRAFT) {
		return { error: "Cannot discard: email is not a draft" };
	}
	// Binned rather than destroyed: an agent discarding the wrong draft should be
	// recoverable from Trash.
	await stub.deleteEmail(draftId);
	return { status: "discarded", draftId };
}

// ── delete_email ───────────────────────────────────────────────────

/**
 * Delete a message, which means bin it — except in Trash and Spam, where a
 * second delete destroys it. See `TERMINAL_FOLDERS` in
 * `workers/durableObject/trash.ts`.
 *
 * `mayDestroy` says whether the caller holds `deletePermanently`. It is a
 * separate argument from reachability because the same tool call is recoverable
 * or not depending on where the message happens to sit, so the authority needed
 * cannot be decided by the gate at the call site — only here, once the folder is
 * known.
 *
 * A caller without it is refused rather than quietly having the delete skipped
 * or downgraded: the message is already in the bin, so there is no weaker action
 * left to take, and reporting success without destroying anything would tell the
 * user their mail is gone when it is not.
 */
export async function toolDeleteEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
	options: { mayDestroy: boolean },
) {
	const stub = getMailboxStub(env, mailboxId);

	if (!options.mayDestroy) {
		const folder = await stub.getEmailFolder(emailId);
		if (folder === null) return { error: "Email not found", emailId };
		if (TERMINAL_FOLDERS.includes(folder)) {
			return {
				error: `This message is in ${folder}, so deleting it destroys it, which needs the "deletePermanently" capability.`,
				emailId,
			};
		}
	}

	const result = await stub.deleteEmail(emailId);
	if (result === null) {
		return { error: "Email not found", emailId };
	}
	// Reported accurately so the agent does not tell someone their mail is gone
	// when it is sitting in Trash, or that it is recoverable when it is not.
	return result.trashed > 0
		? { status: "trashed", emailId, message: "Moved to Trash." }
		: { status: "deleted", emailId, message: "Permanently deleted." };
}

// ── Pre-send gate for the agent/MCP tools ─────────────────────────

/** A send a pre-send rule held for a person to approve (see pre-send.ts). */
export type PendingApproval = { status: "pending_approval" } & Record<string, unknown>;

/**
 * Run the shared pre-send gate (workers/lib/pre-send.ts) for an agent or MCP
 * send. One-to-one tool sends are `transactional`: a hard-bounced or
 * complaining recipient is refused, an unsubscribed one is not (it is noted
 * for the model). Template sends pass `bulk` and every suppression blocks.
 *
 * The callers keep their own `checkSendRateLimit` call ahead of this, so the
 * quota is not counted twice here (`quotaChecked`).
 */
async function agentGate(
	env: Env,
	stub: DurableObjectStub<MailboxDO>,
	mailboxId: string,
	recipients: { to: string | string[]; cc?: string | string[]; bcc?: string | string[] },
	bulk?: { headers: Record<string, string> },
	/**
	 * Who asked, and the fully composed message. A pre-send rule (the agent
	 * approval rule, `workers/lib/agent-send-gate.ts`) may hold it: the draft is
	 * stored as-is and is exactly what approval sends.
	 */
	policy?: { actor?: SendActor; action?: string; draft?: ComposedDraft; html?: string; attachments?: { content: string; filename: string; type: string }[]; headers?: Record<string, string> },
): Promise<
	| { clearance: SendClearance; warnings: SuppressedRecipient[] }
	| { error: string; suppressed?: SuppressedRecipient[] }
	| { error: string; pending: Record<string, unknown> }
> {
	const gate = await preSend(
		env,
		{
			kind: bulk ? "bulk" : "transactional",
			from: mailboxId,
			mailboxId,
			to: recipients.to,
			cc: recipients.cc,
			bcc: recipients.bcc,
			html: policy?.html,
			attachments: policy?.attachments,
			headers: policy?.headers ?? bulk?.headers,
			quotaChecked: true,
			actor: policy?.actor ?? { via: "agent" },
			...(policy?.draft
				? {
						hold: {
							action: policy.action ?? "send_email",
							subject: policy.draft.subject,
							payload: { composed: [policy.draft] },
						} satisfies SendHoldRequest,
					}
				: {}),
		},
		{ quota: () => stub as unknown as QuotaStub },
	);
	if (!gate.ok) {
		if (gate.outcome === "hold_for_approval") {
			// Not an error for the model: the send is queued for a person.
			return { error: "Held for approval", pending: { status: "pending_approval", ...refusalBody(gate) } };
		}
		if (gate.code === "all_suppressed") {
			const list = gate.suppressed.map((s) => `${s.address} (${s.reason})`).join(", ");
			return {
				error: bulk
					? `Not sent: the recipient is on the suppression list: ${list}.`
					: `Not sent: ${list}. The address hard-bounced or reported this sender for spam.`,
				suppressed: gate.suppressed,
			};
		}
		return { error: gate.error };
	}
	// Every recipient must be deliverable for a tool send: silently dropping a
	// Cc the model asked for would misreport what was sent.
	if (gate.suppressed.length > 0) {
		const list = gate.suppressed.map((s) => `${s.address} (${s.reason})`).join(", ");
		return { error: `Not sent: ${list} cannot receive mail from this sender. Remove them and retry.`, suppressed: gate.suppressed };
	}
	return { clearance: gate.clearance, warnings: gate.warnings };
}

// ── send_reply ─────────────────────────────────────────────────────

export async function toolSendReply(
	env: Env,
	mailboxId: string,
	params: {
		originalEmailId: string;
		to: string;
		subject: string;
		bodyHtml: string;
		/**
		 * Address to attribute the send to in `Sender:`, when the session holds
		 * `sendOnBehalf` rather than `sendAs`. See `workers/lib/capabilities.ts`.
		 *
		 * The caller decides this, because only it knows who is driving the
		 * session; this function is given the answer rather than resolving a
		 * principal it cannot see.
		 */
		sender?: string | null;
		/** `false` sends this message untracked, whatever the mailbox setting. */
		track?: boolean;
	},
	/** Who asked (credential, surface, injection state); see {@link agentGate}. */
	actor?: SendActor,
): Promise<
	| { status: "sent"; messageId: string; message: string }
	| { error: string }
	| PendingApproval
> {
	const stub = getMailboxStub(env, mailboxId);

	// Check send rate limit
	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit();
	if (rateLimitError) {
		return { error: rateLimitError };
	}

	const originalEmail = (await stub.getEmail(params.originalEmailId)) as EmailFull | null;
	if (!originalEmail) {
		return { error: "Original email not found" };
	}

	const { originalMsgId, references, threadId } = buildReferencesChain(originalEmail);
	const fromDomain = mailboxId.split("@")[1];
	if (!fromDomain) throw new Error("Invalid mailbox email address");
	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	// Verify and append quoted original message. Sends hold a stricter bar than
	// drafts: an unreachable verifier blocks the send, because no human will
	// review this body before it leaves.
	const verified = await verifyDraft(aiFor(env, { feature: "verifier" }), params.bodyHtml);
	if (!isSendable(verified)) {
		return { error: verificationRefusalMessage(verified) };
	}
	const sanitizedBody = neutraliseAgentHtml(verified.body);
	const quotedBlock = buildQuotedReplyBlock({
		date: originalEmail.date,
		sender: originalEmail.sender || params.to,
		body: originalEmail.body ?? undefined,
	});
	const fullBodyHtml = sanitizedBody + quotedBlock;

	// Quoting a long thread can push a reply past the platform limit even with
	// no attachments, so check after the quoted block is appended.
	try {
		assertMessageWithinSizeLimit({ html: fullBodyHtml });
	} catch (e) {
		if (e instanceof MessageTooLargeError) return { error: e.message };
		throw e;
	}

	// The pre-send gate, on the final message. Suppressions with transactional
	// semantics: a hard-bounced or complaining recipient is refused; an
	// unsubscribe does not stop a reply. A held reply stores this exact body.
	const replyHeaders = buildOutgoingHeaders({ inReplyTo: originalMsgId, references });
	const gate = await agentGate(env, stub, mailboxId, { to: params.to }, undefined, {
		actor,
		action: "send_reply",
		html: fullBodyHtml,
		headers: replyHeaders,
		draft: {
			kind: "transactional",
			to: [params.to],
			from: mailboxId,
			subject: params.subject,
			html: fullBodyHtml,
			headers: replyHeaders,
			row: { threadId, inReplyTo: originalMsgId, references, rawHeaders: null },
			trackingBaseUrl: await trackingBaseUrl(env),
		},
	});
	if ("error" in gate) return "pending" in gate ? (gate.pending as PendingApproval) : gate;

	/**
	 * The id the provider assigns, which is the only one the outside world sees.
	 *
	 * This path sends BEFORE it stores, so there is no write-back to arrange: the
	 * real id is simply used for the row. Storing the locally-minted
	 * `outgoingMessageId` instead would record an id that never existed anywhere
	 * but our database, and an inbound reply citing the provider's id would then
	 * miss `findThreadByMessageIds` and split the conversation.
	 */
	let providerMessageId: string;
	try {
		// Threading only — `Message-ID` and `Sender` are refused by Email Service
		// and one rejected header fails the entire message.
		const outgoingHtml = await trackAgentSend(env, stub, mailboxId, messageId, fullBodyHtml, {
			to: params.to,
		}, undefined, params.track);
		({ messageId: providerMessageId } = await sendEmail(env.EMAIL, {
			to: params.to,
			from: mailboxId,
			subject: params.subject,
			html: outgoingHtml ?? fullBodyHtml,
			headers: buildOutgoingHeaders({
				inReplyTo: originalMsgId,
				references,
			}),
		}, gate.clearance));
	} catch (e) {
		console.error("Email send failed:", (e as Error).message);
		return { error: `Failed to send reply: ${describeSendError(e)}` };
	}

	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: new Date().toISOString(),
			body: fullBodyHtml,
			in_reply_to: originalMsgId,
			email_references:
				references.length > 0 ? JSON.stringify(references) : null,
			thread_id: threadId,
			// The provider's id, not our locally-minted one: it is what an inbound
			// reply will cite, so it is what `findThreadByMessageIds` must match.
			message_id: bareMessageId(providerMessageId),
			delivery_status: "sent",
		},
		[],
	);

	// See `appendSendEvent`: this path stores after sending, so the ledger entry
	// has to be appended explicitly or agent replies never appear in the timeline.
	await appendSendEvent(stub, messageId, providerMessageId);

	return { status: "sent", messageId, message: `Reply sent to ${params.to}` };
}

/**
 * Record a `sent` ledger event for a send-then-store path.
 *
 * The HTTP send route hands its outcome to `recordDelivery`, which writes both
 * the coarse status cache and the ledger. The agent tool paths cannot: they call
 * the provider BEFORE the row exists, so there is nothing to write back to at
 * the moment the provider answers. Reaching the call site means the send
 * succeeded and the row is now stored, so the event is appended directly.
 *
 * Deliberately only the success case. A failure in these paths returns an error
 * to the agent and never creates a Sent row, so there is no message for a
 * `failed` event to belong to.
 *
 * Never throws: the message is already sent, and losing its ledger entry must
 * not turn a delivered email into a tool error.
 */
async function appendSendEvent(
	stub: DurableObjectStub<MailboxDO>,
	emailId: string,
	providerMessageId: string,
): Promise<void> {
	try {
		await stub.appendDeliveryEvent({
			emailId,
			type: "sent",
			source: "send",
			providerMessageId,
		});
	} catch (e) {
		console.error(
			"Could not record send event for",
			emailId,
			(e as Error)?.message,
		);
	}
}

/**
 * Instrument an agent/MCP send for open/click tracking.
 *
 * These paths send BEFORE they store, but the local id is minted first, so the
 * tokens name the row that is about to be written. The row keeps the clean
 * body; only the provider's copy is instrumented. The tool layer has no
 * request, so the origin is `deploymentOrigin(env)`; with none known the
 * message goes out untracked.
 */
async function trackAgentSend(
	env: Env,
	stub: DurableObjectStub<MailboxDO>,
	mailboxId: string,
	emailId: string,
	html: string,
	recipients: { to?: string | string[]; cc?: string | string[] },
	attachments?: { content: string }[],
	track?: boolean,
): Promise<string | undefined> {
	return trackOutgoingHtml({
		stub: stub as unknown as TrackingStub,
		mailboxId: mailboxId.toLowerCase(),
		emailId,
		html,
		baseUrl: await trackingBaseUrl(env),
		to: recipients.to,
		cc: recipients.cc,
		attachments,
		track,
		optOuts: trackingOptOutStore(env),
		fromAddress: mailboxId,
	});
}

// ── send_email ─────────────────────────────────────────────────────

export async function toolSendEmail(
	env: Env,
	mailboxId: string,
	params: {
		to: string;
		subject: string;
		bodyHtml: string;
		/** See {@link toolSendReply}. */
		sender?: string | null;
		/**
		 * Run the agent-artifact verifier. Off only for bodies a person wrote,
		 * such as a stored template; anything the model composed is verified.
		 */
		verify?: boolean;
		/** `false` sends this message untracked, whatever the mailbox setting. */
		track?: boolean;
		/**
		 * Bulk (template) mail: gated as `bulk` (every suppression blocks, a
		 * paused domain refuses) and sent with these headers (the RFC 8058
		 * unsubscribe pair and List-Id). The body already carries the link.
		 */
		bulk?: { headers: Record<string, string> };
		/** How a hold is filed: `send_template` for a template send. */
		action?: string;
	},
	/** Who asked; see {@link agentGate}. */
	actor?: SendActor,
): Promise<
	| { status: "sent"; messageId: string; message: string }
	| { error: string }
	| PendingApproval
> {
	const stub = getMailboxStub(env, mailboxId);

	// Check send rate limit
	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit();
	if (rateLimitError) {
		return { error: rateLimitError };
	}

	const fromDomain = mailboxId.split("@")[1];
	if (!fromDomain) throw new Error("Invalid mailbox email address");
	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	let sanitizedBody = params.bodyHtml;
	if (params.verify !== false) {
		const verified = await verifyDraft(aiFor(env, { feature: "verifier" }), params.bodyHtml);
		if (!isSendable(verified)) {
			return { error: verificationRefusalMessage(verified) };
		}
		sanitizedBody = neutraliseAgentHtml(verified.body);
	}

	try {
		assertMessageWithinSizeLimit({ html: sanitizedBody });
	} catch (e) {
		if (e instanceof MessageTooLargeError) return { error: e.message };
		throw e;
	}

	// The pre-send gate on the final message; a hold stores exactly this.
	const gate = await agentGate(env, stub, mailboxId, { to: params.to }, params.bulk, {
		actor,
		action: params.action ?? "send_email",
		html: sanitizedBody,
		draft: {
			kind: params.bulk ? "bulk" : "transactional",
			to: [params.to],
			from: mailboxId,
			subject: params.subject,
			html: sanitizedBody,
			...(params.bulk && Object.keys(params.bulk.headers).length ? { headers: params.bulk.headers } : {}),
			row: { threadId: null, inReplyTo: null, references: [], rawHeaders: null },
			trackingBaseUrl: await trackingBaseUrl(env),
		},
	});
	if ("error" in gate) return "pending" in gate ? (gate.pending as PendingApproval) : gate;

	// Same reasoning as the reply path above: this sends before it stores, so the
	// provider's id goes straight onto the row rather than the one we minted.
	let providerMessageId: string;
	try {
		const outgoingHtml = await trackAgentSend(env, stub, mailboxId, messageId, sanitizedBody, {
			to: params.to,
		}, undefined, params.track);
		({ messageId: providerMessageId } = await sendEmail(env.EMAIL, {
			to: params.to,
			from: mailboxId,
			subject: params.subject,
			html: outgoingHtml ?? sanitizedBody,
			// A new message has no ancestor, so there are no threading headers. A
			// bulk (template) send carries the unsubscribe pair and List-Id.
			// `Message-ID` used to go out here; Email Service generates its own and
			// rejects ours, which failed the whole send.
			...(params.bulk && Object.keys(params.bulk.headers).length > 0
				? { headers: params.bulk.headers }
				: {}),
		}, gate.clearance));
	} catch (e) {
		console.error("Email send failed:", (e as Error).message);
		return { error: `Failed to send email: ${describeSendError(e)}` };
	}

	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: params.to.toLowerCase(),
			date: new Date().toISOString(),
			body: sanitizedBody,
			in_reply_to: null,
			email_references: null,
			thread_id: messageId,
			// The provider's id — the only one a reply can cite back at us.
			message_id: bareMessageId(providerMessageId),
			delivery_status: "sent",
		},
		[],
	);

	// Record the outcome in the delivery ledger, as every other send path does.
	// This path sends BEFORE it stores, so there is no `recordDelivery`
	// write-back to piggyback on: reaching here means the provider accepted the
	// message, and without an explicit append an agent-originated send would be
	// absent from the timeline and from Sent analytics entirely.
	await appendSendEvent(stub, messageId, providerMessageId);

	return { status: "sent", messageId, message: `Email sent to ${params.to}` };
}

// ════════════════════════════════════════════════════════════════════
// Agent-first tools (MCP).
//
// Everything below returns compact, model-friendly shapes: plain-text
// snippets instead of HTML, short field names that match the REST API, and
// a `next_page` hint on every list. None of these functions checks authority;
// the caller (`workers/mcp/index.ts`) gates each one on the same capability
// its REST route requires before calling in.
// ════════════════════════════════════════════════════════════════════

/**
 * Plain text from a stored snippet.
 *
 * List rows now carry the stored plain-text `snippet` (migration 26), but a
 * row the lazy backfill has not reached yet still falls back to
 * `SUBSTR(body, 1, 300)` of the HTML body, which can end in the middle of a
 * tag that `stripHtmlToText` would not recognise as one. A dangling `<…` is
 * dropped before stripping.
 */
export function snippetText(raw: unknown, max = 200): string {
	if (typeof raw !== "string" || !raw) return "";
	// Masked: list rows are previews, and an agent listing a folder does not
	// need the password a customer pasted. `get_email` still returns the body.
	const text = redactSecrets(stripHtmlToText(raw.replace(/<[^>]*$/, "")));
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Truncate long plain text, saying so, so a model knows there is more. */
function clip(text: string, max: number): { text: string; truncated: boolean } {
	if (text.length <= max) return { text, truncated: false };
	return { text: `${text.slice(0, max)}…`, truncated: true };
}

/** One message as a list row: metadata plus a text snippet, never HTML. */
export function compactEmail(row: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {
		id: row.id,
		thread_id: row.thread_id ?? null,
		folder: row.folder_id ?? null,
		subject: row.subject ?? "",
		from: row.sender ?? null,
		// The display name from `From:` (migration 26), when the sender gave one.
		...(row.sender_name ? { from_name: row.sender_name } : {}),
		to: row.recipient ?? null,
		date: row.date ?? null,
		read: !!row.read,
		starred: !!row.starred,
	};
	if (row.cc) out.cc = row.cc;
	if (row.priority) out.priority = row.priority;
	if (row.has_attachment) out.has_attachment = true;
	if (row.needs_reply) out.needs_reply = true;
	if (row.thread_count && Number(row.thread_count) > 1) out.thread_count = row.thread_count;
	if (row.snoozed_until) out.snoozed_until = row.snoozed_until;
	if (row.delivery_status) out.delivery_status = row.delivery_status;
	// Reader warnings (lookalike domain, display-name spoof, link mismatch,
	// first-time sender), so an agent sees what the reading pane shows.
	const warnings = warningsFor(row as { folder_id?: string | null; security_warnings?: string | null });
	if (warnings.length > 0) out.warnings = warnings;
	// Sent mail only: an `engagement` block on a received message would invite a
	// model to report on opens that cannot exist. Recognised by folder, by a
	// delivery status (only this app's sends have one), or by recorded opens.
	if (
		row.folder_id === Folders.SENT ||
		row.delivery_status ||
		Number(row.open_count ?? 0) > 0 ||
		Number(row.click_count ?? 0) > 0
	) {
		out.engagement = engagementSummary(row as EngagementFields);
	}
	const snippet = snippetText(row.snippet ?? row.body);
	if (snippet) out.snippet = snippet;
	// AI one-liner for the conversation, when one has been generated. Cheaper for
	// a model to triage on than the snippet. Never present for Spam or Trash.
	if (typeof row.summary_line === "string" && row.summary_line) out.summary_line = row.summary_line;
	return out;
}

/** The From-domain trust level from our own MX's verdicts; see shared/auth-results. */
function senderTrustLevel(rawHeaders: string | null | undefined): string {
	return assessSenderTrust(extractAuthenticationResults(rawHeaders)).level;
}

/** Attachment metadata, without storage internals. */
function compactAttachment(a: Record<string, unknown>) {
	return {
		id: a.id,
		filename: a.filename,
		mimetype: a.mimetype,
		size: a.size,
		inline: a.disposition === "inline",
		...(a.blocked || isBlockedAttachment(a.filename as string) ? { blocked: true } : {}),
	};
}

/** The detail view of a message. HTML only on request. */
export function detailedEmail(
	email: EmailFull & Record<string, unknown>,
	options: { includeBody?: boolean; maxChars?: number } = {},
) {
	const maxChars = options.maxChars ?? 20_000;
	const body = clip(email.body ? htmlToTextLines(email.body) : "", maxChars);
	const { snippet: _snippet, ...head } = compactEmail(email);
	return {
		...head,
		// Always present on a full read, even when empty, so an agent can rely on it.
		warnings: warningsFor(email as { folder_id?: string | null; security_warnings?: string | null }),
		sender_trust: senderTrustLevel(email.raw_headers as string | null | undefined),
		in_reply_to: email.in_reply_to ?? null,
		message_id: email.message_id ?? null,
		body_text: body.text,
		...(body.truncated ? { body_truncated: true } : {}),
		attachments: (email.attachments ?? []).map((a) =>
			compactAttachment(a as unknown as Record<string, unknown>),
		),
		...(options.includeBody ? { body_html: email.body ?? "" } : {}),
	};
}

/**
 * Wrap a page of rows with the hint a model needs to continue.
 *
 * `next_page` is null on the last page. The DO does not return totals for
 * every list, so a full page is taken to mean "there may be more"; at worst
 * the model asks once more and gets an empty page with `next_page: null`.
 */
export function pageOf<T>(items: T[], page: number, limit: number) {
	return { items, page, next_page: items.length >= limit ? page + 1 : null };
}

// ── list_emails / search_emails / get_email / get_thread (compact) ─

export async function toolListEmailsCompact(
	env: Env,
	mailboxId: string,
	params: { folder: string; limit: number; page: number; unread?: boolean; starred?: boolean },
) {
	const stub = getMailboxStub(env, mailboxId);
	const rows = (await stub.getEmails({
		folder: params.folder,
		limit: params.limit,
		page: params.page,
		sortColumn: "date",
		sortDirection: "DESC",
		unread: params.unread,
		starred: params.starred,
	})) as unknown as Record<string, unknown>[];
	const { items, ...rest } = pageOf(rows.map(compactEmail), params.page, params.limit);
	return { emails: items, ...rest };
}

export async function toolSearchEmailsCompact(
	env: Env,
	mailboxId: string,
	params: { query: string; folder?: string; limit: number; page: number },
) {
	const stub = getMailboxStub(env, mailboxId) as unknown as {
		searchEmails: (o: {
			query: string;
			folder?: string;
			page?: number;
			limit?: number;
		}) => Promise<Record<string, unknown>[]>;
	};
	const rows = await stub.searchEmails(params);
	const { items, ...rest } = pageOf(rows.map(compactEmail), params.page, params.limit);
	return { emails: items, ...rest };
}

export async function toolGetEmailCompact(
	env: Env,
	mailboxId: string,
	emailId: string,
	options: { includeBody?: boolean; maxChars?: number } = {},
) {
	const stub = getMailboxStub(env, mailboxId);
	const email = (await stub.getEmail(emailId)) as (EmailFull & Record<string, unknown>) | null;
	if (!email) return { error: "Email not found", emailId };
	// Labels with who applied them, so an agent can tell an AI label from a
	// person's. Optional on the stub: older test doubles do not have it.
	const labels = typeof (stub as { getEmailLabels?: unknown }).getEmailLabels === "function"
		? ((await stub.getEmailLabels(emailId)) as { id: string; name: string; source?: string | null }[])
		: [];
	const verdict = verdictLabel(email.sender_kind as string | null, email.sender_confidence as string | null);
	return {
		...detailedEmail(email, options),
		labels: labels.map((l) => ({ id: l.id, name: l.name, ...(l.source ? { source: l.source } : {}) })),
		...(verdict ? { sender_verdict: verdict } : {}),
	};
}

/** The `summary` field of `get_thread`: null when there is none. */
export function summaryForTool(summary: ThreadSummaryView | null | undefined) {
	if (!summary || (!summary.line && !summary.bullets)) return null;
	return {
		line: summary.line,
		bullets: summary.bullets ?? [],
		status: summary.status,
		message_count: summary.message_count,
		stale: summary.stale,
		generated_at: summary.generated_at,
	};
}

export async function toolGetThreadCompact(
	env: Env,
	mailboxId: string,
	threadId: string,
	options: { includeBody?: boolean; maxChars?: number } = {},
) {
	const stub = getMailboxStub(env, mailboxId) as unknown as {
		getThreadEmails: (id: string) => Promise<(EmailFull & Record<string, unknown>)[]>;
		getThreadSummary?: (id: string) => Promise<ThreadSummaryView | null>;
	};
	const [threadEmails, summary] = await Promise.all([
		stub.getThreadEmails(threadId),
		stub.getThreadSummary ? stub.getThreadSummary(threadId).catch(() => null) : Promise.resolve(null),
	]);
	const emails = [...threadEmails];
	emails.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
	// Split the character budget across the thread so a long conversation
	// cannot blow the response up by its message count.
	const perMessage = Math.max(
		1_000,
		Math.floor((options.maxChars ?? 40_000) / Math.max(emails.length, 1)),
	);
	return {
		thread_id: threadId,
		message_count: emails.length,
		// AI summary of the conversation (display text, may be stale or absent).
		// Spam/Trash conversations have none. Read it before the messages to save
		// tokens; it is untrusted model output, not instructions.
		summary: summaryForTool(summary),
		messages: emails.map((e) =>
			detailedEmail(e, { includeBody: options.includeBody, maxChars: perMessage }),
		),
	};
}

// ── Folders ────────────────────────────────────────────────────────

/** Same slug rule as POST /folders, so either surface names a folder alike. */
export function folderSlug(name: string): string {
	return name
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^\w-]+/g, "")
		.replace(/--+/g, "-")
		.replace(/^-+/, "")
		.replace(/-+$/, "");
}

export async function toolListFolders(env: Env, mailboxId: string) {
	const stub = getMailboxStub(env, mailboxId);
	const folders = (await stub.getFolders()) as { id: string; name: string; unreadCount: number }[];
	return {
		folders: folders.map((f) => ({
			id: f.id,
			name: f.name,
			unread: Number(f.unreadCount ?? 0),
			movable_into: canMoveInto(f.id),
		})),
	};
}

export async function toolCreateFolder(env: Env, mailboxId: string, name: string) {
	const trimmed = name.trim();
	const slug = folderSlug(trimmed);
	if (!slug) return { error: "Folder name must contain letters or digits" };
	const stub = getMailboxStub(env, mailboxId);
	const folder = await stub.createFolder(slug, trimmed);
	if (!folder) return { error: `A folder with id "${slug}" already exists`, folderId: slug };
	return { status: "created", folder: { id: folder.id, name: folder.name } };
}

// ── Labels ─────────────────────────────────────────────────────────

export async function toolListLabels(env: Env, mailboxId: string) {
	const stub = getMailboxStub(env, mailboxId);
	const labels = (await stub.getLabels()) as unknown as Record<string, unknown>[];
	return {
		labels: labels.map((l) => {
			const { created_at: _c, updated_at: _u, sort_order: _s, ...rest } = l;
			return rest;
		}),
	};
}

export async function toolCreateLabel(
	env: Env,
	mailboxId: string,
	params: { name: string; color?: string; parentId?: string | null },
) {
	const stub = getMailboxStub(env, mailboxId);
	const label = (await stub.createLabel(
		params.name.trim(),
		params.color,
		params.parentId ?? null,
		0,
	)) as unknown as Record<string, unknown> | null;
	if (!label) return { error: "A label with that name already exists" };
	return { status: "created", label: { id: label.id, name: label.name, color: label.color } };
}

export async function toolApplyLabel(
	env: Env,
	mailboxId: string,
	emailId: string,
	labelId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	const ok = await stub.addEmailLabel(emailId, labelId);
	if (!ok) {
		return { error: "Email or label not found. Use list_labels for label ids.", emailId, labelId };
	}
	return { status: "labelled", emailId, labelId };
}

export async function toolRemoveLabel(
	env: Env,
	mailboxId: string,
	emailId: string,
	labelId: string,
) {
	const stub = getMailboxStub(env, mailboxId);
	await stub.removeEmailLabel(emailId, labelId);
	return { status: "unlabelled", emailId, labelId };
}

// ── Per-message state ──────────────────────────────────────────────

export async function toolStarEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
	starred: boolean,
) {
	const stub = getMailboxStub(env, mailboxId);
	const email = await stub.updateEmail(emailId, { starred });
	if (!email) return { error: "Email not found", emailId };
	return { status: "updated", emailId, starred };
}

/** Longest snooze, matching the REST route's `delay_seconds` ceiling. */
export const MAX_SNOOZE_SECONDS = 365 * 24 * 60 * 60;

export async function toolSnoozeEmail(
	env: Env,
	mailboxId: string,
	emailId: string,
	params: { until?: string; delaySeconds?: number; now?: number },
) {
	const now = params.now ?? Date.now();
	if (Boolean(params.until) === (params.delaySeconds !== undefined)) {
		return { error: "Provide exactly one of 'until' or 'delay_seconds'" };
	}
	const untilMs = params.until
		? Date.parse(params.until)
		: now + params.delaySeconds! * 1000;
	if (Number.isNaN(untilMs)) return { error: "Invalid 'until' timestamp; use ISO 8601" };
	if (untilMs <= now) return { error: "Snooze time must be in the future" };
	if (untilMs - now > MAX_SNOOZE_SECONDS * 1000) {
		return { error: "Snooze time must be within a year" };
	}

	const stub = getMailboxStub(env, mailboxId);
	const until = new Date(untilMs).toISOString();
	const email = await stub.snoozeEmail(emailId, until);
	if (!email) return { error: "Email not found", emailId };
	return { status: "snoozed", emailId, until };
}

export async function toolUnsnoozeEmail(env: Env, mailboxId: string, emailId: string) {
	const stub = getMailboxStub(env, mailboxId);
	const email = (await stub.unsnoozeEmail(emailId)) as { folder_id?: string } | null;
	if (!email) return { error: "Email not found or not snoozed", emailId };
	return { status: "unsnoozed", emailId, folder: email.folder_id ?? null };
}

// ── Follow-up reminders ────────────────────────────────────────────

/** A reminder as a compact, model-friendly row. */
function compactFollowup(row: FollowupView) {
	return {
		email_id: row.email_id,
		thread_id: row.thread_id,
		subject: row.subject ?? "",
		to: row.recipient ?? null,
		sent_at: row.sent_at ?? null,
		followup_at: row.followup_at,
		mode: row.followup_mode,
		status: row.status,
	};
}

/** Sent mail still waiting on a reply: fired reminders first, then pending by due date. */
export async function toolListAwaitingReply(
	env: Env,
	mailboxId: string,
	params: { status?: "pending" | "fired" | "active"; limit?: number } = {},
) {
	const stub = getMailboxStub(env, mailboxId);
	const rows = await stub.listFollowups({ status: params.status ?? "active", limit: params.limit ?? 50 });
	return { awaiting_reply: rows.map(compactFollowup) };
}

/**
 * Set, replace or cancel the reminder on a sent message. `cancel` takes
 * precedence; otherwise exactly one of `at` or `delaySeconds`.
 */
export async function toolSetFollowup(
	env: Env,
	mailboxId: string,
	emailId: string,
	params: { at?: string; delaySeconds?: number; cancel?: boolean; now?: number },
) {
	const stub = getMailboxStub(env, mailboxId);
	if (params.cancel) {
		const row = await stub.cancelFollowup(emailId);
		if (!row) return { error: "No active reminder on this message or its thread", emailId };
		return { status: row.status, followup: compactFollowup(row) };
	}
	const resolved = resolveExplicitFollowup(
		{ at: params.at, delaySeconds: params.delaySeconds },
		params.now,
	);
	if (!resolved.ok) return { error: resolved.error };
	const row = await stub.setFollowup({
		emailId,
		followupAt: resolved.at,
		mode: "manual",
		durationSeconds: resolved.durationSeconds,
	});
	if (!row) return { error: "Email not found, or it is a draft or in Trash or Spam", emailId };
	return { status: "set", followup: compactFollowup(row) };
}

// ── AI triage and the Screener ─────────────────────────────────────

interface TriageToolStub extends TriageStub {
	listLabelPrompts(): Promise<Record<string, unknown>[]>;
	triagePresets(): Promise<Record<string, unknown>[]>;
	triageStatus(): Promise<{ ai_calls_today: number; corrections: number; backfill_remaining: number }>;
	setLabelPrompt(
		labelId: string,
		patch: { prompt?: string | null; autoArchive?: boolean; showTab?: boolean },
	): Promise<Record<string, unknown> | null>;
	setTriagePreset(
		key: TriagePresetKey,
		options: { enabled: boolean; autoArchive?: boolean; showTab?: boolean },
	): Promise<Record<string, unknown> | null>;
	listScreener(limit?: number): Promise<
		{ sender: string; sender_kind: string | null; sender_confidence: string | null; [k: string]: unknown }[]
	>;
	screenSender(sender: string, decision: "allow" | "block", target?: "spam" | "trash"): Promise<Record<string, unknown> | null>;
}

/** Labels with their prompts, the presets, and today's AI usage against the cap. */
export async function toolListLabelPrompts(env: Env, mailboxId: string) {
	const stub = getMailboxStub(env, mailboxId) as unknown as TriageToolStub;
	const [settings, labels, presets, status] = await Promise.all([
		readMailboxSettings(env, mailboxId),
		stub.listLabelPrompts(),
		stub.triagePresets(),
		stub.triageStatus(),
	]);
	return {
		triage_enabled: settings.triage.enabled,
		screener: settings.screener,
		daily_ai_cap: settings.triage.dailyAiCap,
		...status,
		labels,
		presets,
	};
}

/**
 * Set a label's prompt (or a preset), and optionally run one backfill step.
 * Exactly one of `labelId` or `preset`.
 */
export async function toolSetLabelPrompt(
	env: Env,
	mailboxId: string,
	params: {
		labelId?: string;
		preset?: string;
		prompt?: string | null;
		enabled?: boolean;
		autoArchive?: boolean;
		showTab?: boolean;
		backfill?: boolean;
	},
) {
	const stub = getMailboxStub(env, mailboxId) as unknown as TriageToolStub;
	if (!!params.labelId === !!params.preset) return { error: "Give exactly one of labelId or preset" };
	let label: Record<string, unknown> | null;
	try {
		if (params.preset) {
			if (!(TRIAGE_PRESET_KEYS as readonly string[]).includes(params.preset)) {
				return { error: `Unknown preset. One of: ${TRIAGE_PRESET_KEYS.join(", ")}` };
			}
			label = await stub.setTriagePreset(params.preset as TriagePresetKey, {
				enabled: params.enabled ?? true,
				autoArchive: params.autoArchive,
				showTab: params.showTab,
			});
		} else {
			label = await stub.setLabelPrompt(params.labelId!, {
				prompt: params.prompt,
				autoArchive: params.autoArchive,
				showTab: params.showTab,
			});
			if (!label) return { error: "Label not found. Use list_labels or list_label_prompts.", labelId: params.labelId };
		}
	} catch (e) {
		return { error: (e as Error).message };
	}
	const out: Record<string, unknown> = { status: "set", label };
	if (params.backfill) {
		const settings = await readMailboxSettings(env, mailboxId);
		out.backfill = settings.triage.enabled
			? await runBackfillStep(env, stub, settings)
			: { error: "AI triage is off for this mailbox" };
	}
	return out;
}

/** Senders waiting in the Screener, one row each, with the AI pre-verdict. */
export async function toolListScreener(env: Env, mailboxId: string, params: { limit?: number } = {}) {
	const stub = getMailboxStub(env, mailboxId) as unknown as TriageToolStub;
	const senders = await stub.listScreener(params.limit ?? 50);
	return {
		senders: senders.map((s) => ({
			...s,
			verdict: verdictLabel(s.sender_kind, s.sender_confidence),
		})),
	};
}

/** Yes (allow) or No (block) for a screened sender. */
export async function toolScreenSender(
	env: Env,
	mailboxId: string,
	params: { sender: string; decision: "allow" | "block"; target?: "spam" | "trash" },
) {
	const stub = getMailboxStub(env, mailboxId) as unknown as TriageToolStub;
	const result = await stub.screenSender(params.sender, params.decision, params.target ?? "spam");
	if (!result) return { error: "Not an email address", sender: params.sender };
	return result;
}

export async function toolSetPriority(
	env: Env,
	mailboxId: string,
	emailId: string,
	priority: "high" | "low" | null,
) {
	const stub = getMailboxStub(env, mailboxId);
	const email = await stub.setEmailPriority(emailId, priority);
	if (!email) return { error: "Email not found", emailId };
	return { status: "updated", emailId, priority };
}

// ── Archive / trash / restore / not spam ───────────────────────────

export async function toolArchiveEmail(env: Env, mailboxId: string, emailId: string) {
	const stub = getMailboxStub(env, mailboxId);
	const ok = await stub.moveEmail(emailId, Folders.ARCHIVE);
	if (!ok) return { error: "Failed to archive email", emailId };
	return { status: "archived", emailId, folder: Folders.ARCHIVE };
}

/**
 * Move to Trash, and only that.
 *
 * Unlike `delete_email`, this never escalates to destroying a message that is
 * already in Trash or Spam: permanent deletion is not offered here at all. A
 * message already there is reported as such, so the model does not retry.
 */
export async function toolTrashEmail(env: Env, mailboxId: string, emailId: string) {
	const stub = getMailboxStub(env, mailboxId);
	// One DO call that checks the folder and moves the row together, so a
	// message binned by someone else in the meantime is not destroyed.
	const { trashed, alreadyBinned } = await stub.trashEmailsOnly([emailId]);
	if (alreadyBinned.length > 0) {
		return {
			error:
				"This message is already in Trash or Spam. Permanent deletion is not available over MCP; Trash is purged automatically after its retention period.",
			emailId,
		};
	}
	if (trashed.length === 0) return { error: "Email not found", emailId };
	return { status: "trashed", emailId, message: "Moved to Trash. Use restore_email to undo." };
}

export async function toolRestoreEmail(env: Env, mailboxId: string, emailId: string) {
	const stub = getMailboxStub(env, mailboxId);
	const restored = await stub.restoreEmails([emailId]);
	if (restored === 0) return { error: "Email is not in Trash", emailId };
	const folder = await stub.getEmailFolder(emailId);
	return { status: "restored", emailId, folder };
}

export async function toolMarkNotSpam(env: Env, mailboxId: string, emailId: string) {
	const stub = getMailboxStub(env, mailboxId);
	const result = await stub.markNotSpam(emailId);
	if (!result) return { error: "Email not found", emailId };
	return { status: "not_spam", emailId, ...result };
}

// ── bulk_update ────────────────────────────────────────────────────

export const BULK_TOOL_ACTIONS = [
	"read",
	"unread",
	"star",
	"unstar",
	"archive",
	"move",
	"label",
	"unlabel",
	"trash",
	"restore",
] as const;

export type BulkToolAction = (typeof BULK_TOOL_ACTIONS)[number];

/**
 * The capability each bulk action needs. Mirrors `BULK_ACTION_CAPABILITIES`
 * in `workers/index.ts`, minus `delete_permanently`, which MCP does not offer.
 */
export const BULK_TOOL_CAPABILITIES = {
	read: "organise",
	unread: "organise",
	star: "organise",
	unstar: "organise",
	archive: "organise",
	move: "organise",
	label: "organise",
	unlabel: "organise",
	trash: "delete",
	restore: "delete",
} as const satisfies Record<BulkToolAction, MailboxCapability>;

/** Ids per bulk call. Lower than the REST ceiling to keep one tool call cheap. */
export const MCP_BULK_LIMIT = 100;

export async function toolBulkUpdate(
	env: Env,
	mailboxId: string,
	params: { ids: string[]; action: BulkToolAction; folderId?: string; labelId?: string },
): Promise<Record<string, unknown>> {
	const ids = [...new Set(params.ids.filter((id) => typeof id === "string" && id))];
	if (ids.length === 0) return { error: "No ids given" };
	if (ids.length > MCP_BULK_LIMIT) {
		return { error: `At most ${MCP_BULK_LIMIT} ids per call; split the list` };
	}
	const stub = getMailboxStub(env, mailboxId);

	switch (params.action) {
		case "read":
		case "unread":
			return {
				action: params.action,
				affected: await stub.bulkUpdateFlags(ids, { read: params.action === "read" }),
			};
		case "star":
		case "unstar":
			return {
				action: params.action,
				affected: await stub.bulkUpdateFlags(ids, { starred: params.action === "star" }),
			};
		case "archive":
		case "move": {
			const folderId = params.action === "archive" ? Folders.ARCHIVE : params.folderId;
			if (!folderId) return { error: "folderId is required for move" };
			if (!canMoveInto(folderId)) {
				return { error: `Messages cannot be moved into ${folderId}` };
			}
			const affected = await stub.bulkMoveEmails(ids, folderId);
			if (affected === null) return { error: `Folder "${folderId}" not found. Use list_folders.` };
			return { action: params.action, folder: folderId, affected };
		}
		case "label":
		case "unlabel": {
			if (!params.labelId) return { error: "labelId is required for label/unlabel" };
			const affected = await stub.bulkSetLabel(ids, params.labelId, params.action === "label");
			if (affected === null) return { error: "Label not found. Use list_labels." };
			return { action: params.action, labelId: params.labelId, affected };
		}
		case "trash": {
			// Not `bulkDeleteEmails`, which destroys whatever is already binned.
			const { trashed, alreadyBinned, missing } = await stub.trashEmailsOnly(ids);
			return {
				action: "trash",
				affected: trashed.length,
				...(alreadyBinned.length ? { skipped_already_binned: alreadyBinned } : {}),
				...(missing.length ? { not_found: missing } : {}),
			};
		}
		case "restore":
			return { action: "restore", affected: await stub.restoreEmails(ids) };
	}
}

// ── forward_email ──────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
	let bin = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(bin);
}

export function forwardSubject(subject: string | null | undefined): string {
	const s = (subject ?? "").trim();
	if (!s) return "Fwd:";
	return /^fwd?:/i.test(s) ? s : `Fwd: ${s}`;
}

function joinAddressList(v: string | string[] | undefined): string | null {
	if (!v || (Array.isArray(v) && v.length === 0)) return null;
	return Array.isArray(v) ? v.join(", ") : v;
}

/**
 * Forward a stored message, with its attachments where they fit.
 *
 * Stays in the original conversation (RFC 5322 §3.6.4), as the REST forward
 * route does. The note, if any, is verified like every other agent-written
 * body; the forwarded original is not, because it is quoted rather than
 * authored. Executable attachments are left out, and anything over the size
 * budget is named in the header block instead of being silently dropped.
 */
export async function toolForwardEmail(
	env: Env,
	mailboxId: string,
	params: {
		emailId: string;
		to: string | string[];
		cc?: string | string[];
		note?: string;
		includeAttachments?: boolean;
		/** See {@link toolSendReply}. */
		sender?: string | null;
		/** `false` sends this message untracked, whatever the mailbox setting. */
		track?: boolean;
	},
	/** Who asked; see {@link agentGate}. */
	actor?: SendActor,
): Promise<
	| { status: "sent"; messageId: string; message: string; omitted_attachments?: string[] }
	| { error: string }
	| PendingApproval
> {
	const stub = getMailboxStub(env, mailboxId);

	const rateLimitError = await (stub as unknown as RateLimitStub).checkSendRateLimit();
	if (rateLimitError) return { error: rateLimitError };

	const original = (await stub.getEmailByRef(params.emailId)) as EmailFull | null;
	if (!original) return { error: "Original email not found" };
	const threading = await resolveThreadedSend(stub, original.id, "forward");
	if (!threading) return { error: "Original email not found" };

	let noteHtml = "";
	if (params.note?.trim()) {
		const verified = await verifyDraft(aiFor(env, { feature: "verifier" }), textToHtml(params.note.trim()));
		if (!isSendable(verified)) return { error: verificationRefusalMessage(verified) };
		noteHtml = neutraliseAgentHtml(verified.body);
	}

	const candidates =
		params.includeAttachments === false
			? []
			: (original.attachments ?? []).filter(
					(a) => !(a as { blocked?: unknown }).blocked && !isBlockedAttachment(a.filename),
				);
	const originalBody = original.body ?? "";
	const selection = selectForwardAttachments(
		candidates,
		forwardBodyBytes(noteHtml + originalBody, ""),
	);

	const header = buildForwardHeaderBlock({
		from: original.sender,
		date: original.date,
		subject: original.subject,
		to: original.recipient,
		cc: original.cc ?? null,
		omittedAttachments: selection.omitted,
	});
	const html =
		`${noteHtml}<br><div>---------- Forwarded message ----------</div>` +
		header.html +
		originalBody;

	const attachments: {
		content: string;
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
		contentId?: string;
	}[] = [];
	for (const a of selection.included) {
		const obj = await env.BUCKET.get(attachmentKey(original.id, a.id, a.filename));
		if (!obj) continue;
		attachments.push({
			content: bytesToBase64(new Uint8Array(await obj.arrayBuffer())),
			filename: a.filename,
			type: a.mimetype,
			disposition: a.disposition === "inline" ? "inline" : "attachment",
			...(a.content_id ? { contentId: a.content_id } : {}),
		});
	}

	try {
		assertMessageWithinSizeLimit({ html, attachments });
	} catch (e) {
		if (e instanceof MessageTooLargeError) return { error: e.message };
		throw e;
	}

	const fromDomain = mailboxId.split("@")[1];
	if (!fromDomain) throw new Error("Invalid mailbox email address");
	const { messageId } = generateMessageId(fromDomain);
	const subject = forwardSubject(original.subject);
	const cc = joinAddressList(params.cc);

	// The pre-send gate on the final message, attachments included. A hold
	// stores this exact forward (attachments stashed in R2).
	const forwardHeaders = buildOutgoingHeaders({ inReplyTo: threading.inReplyTo, references: threading.references });
	const toList = Array.isArray(params.to) ? params.to : [params.to];
	const ccList = params.cc ? (Array.isArray(params.cc) ? params.cc : [params.cc]) : [];
	const gate = await agentGate(env, stub, mailboxId, { to: params.to, cc: params.cc }, undefined, {
		actor,
		action: "forward_email",
		html,
		attachments,
		headers: forwardHeaders,
		draft: {
			kind: "transactional",
			to: toList,
			...(ccList.length ? { cc: ccList } : {}),
			from: mailboxId,
			subject,
			html,
			headers: forwardHeaders,
			rawAttachments: attachments,
			row: { threadId: threading.threadId, inReplyTo: threading.inReplyTo, references: threading.references, rawHeaders: null },
			trackingBaseUrl: await trackingBaseUrl(env),
		},
	});
	if ("error" in gate) return "pending" in gate ? (gate.pending as PendingApproval) : gate;

	let providerMessageId: string;
	try {
		const outgoingHtml = await trackAgentSend(
			env,
			stub,
			mailboxId,
			messageId,
			html,
			{ to: params.to, cc: params.cc },
			attachments,
			params.track,
		);
		({ messageId: providerMessageId } = await sendEmail(env.EMAIL, {
			to: params.to,
			...(cc ? { cc: params.cc } : {}),
			from: mailboxId,
			subject,
			html: outgoingHtml ?? html,
			...(attachments.length ? { attachments } : {}),
			headers: buildOutgoingHeaders({
				inReplyTo: threading.inReplyTo,
				references: threading.references,
			}),
		}, gate.clearance));
	} catch (e) {
		console.error("Forward send failed:", (e as Error).message);
		return { error: `Failed to forward email: ${describeSendError(e)}` };
	}

	const stored = await storeAttachments(env.BUCKET, messageId, attachments);
	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject,
			sender: mailboxId.toLowerCase(),
			recipient: (joinAddressList(params.to) ?? "").toLowerCase(),
			cc: cc?.toLowerCase() ?? null,
			date: new Date().toISOString(),
			body: html,
			in_reply_to: threading.inReplyTo,
			email_references:
				threading.references.length > 0 ? JSON.stringify(threading.references) : null,
			thread_id: threading.threadId,
			message_id: bareMessageId(providerMessageId),
			delivery_status: "sent",
		},
		stored,
	);
	await appendSendEvent(stub, messageId, providerMessageId);

	return {
		status: "sent",
		messageId,
		message: `Forwarded to ${joinAddressList(params.to)}`,
		...(selection.omitted.length ? { omitted_attachments: selection.omitted } : {}),
	};
}

// ── Scheduled sends ────────────────────────────────────────────────

/** Furthest ahead a send may be scheduled; matches POST /scheduled-sends. */
export const MAX_SCHEDULE_SECONDS = 90 * 24 * 60 * 60;

export async function toolScheduleSend(
	env: Env,
	mailboxId: string,
	params: {
		to: string | string[];
		cc?: string | string[];
		bcc?: string | string[];
		subject: string;
		bodyHtml: string;
		sendAt?: string;
		delaySeconds?: number;
		replyToEmailId?: string;
		threadedMode?: "reply" | "forward";
		now?: number;
		/** `false` sends this message untracked, whatever the mailbox setting. */
		track?: boolean;
	},
	/** Who asked; see {@link agentGate}. */
	actor?: SendActor,
): Promise<
	| { status: "scheduled"; id: string; send_at: string; message: string }
	| { error: string }
	| PendingApproval
> {
	const now = params.now ?? Date.now();
	if (Boolean(params.sendAt) === (params.delaySeconds !== undefined)) {
		return { error: "Provide exactly one of 'send_at' or 'delay_seconds'" };
	}
	const sendAtMs = params.sendAt ? Date.parse(params.sendAt) : now + params.delaySeconds! * 1000;
	if (Number.isNaN(sendAtMs)) return { error: "Invalid 'send_at' timestamp; use ISO 8601" };
	if (sendAtMs <= now) return { error: "send_at must be in the future" };
	if (sendAtMs - now > MAX_SCHEDULE_SECONDS * 1000) {
		return { error: "send_at must be within 90 days" };
	}

	const verified = await verifyDraft(aiFor(env, { feature: "verifier" }), params.bodyHtml);
	if (!isSendable(verified)) return { error: verificationRefusalMessage(verified) };
	const html = neutraliseAgentHtml(verified.body);
	try {
		assertMessageWithinSizeLimit({ html });
	} catch (e) {
		if (e instanceof MessageTooLargeError) return { error: e.message };
		throw e;
	}

	const stub = getMailboxStub(env, mailboxId);
	const fromDomain = mailboxId.split("@")[1];
	if (!fromDomain) throw new Error("Invalid mailbox email address");
	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);

	let inReplyTo: string | null = null;
	let references: string[] = [];
	let threadId = messageId;
	let markRead: string | null = null;
	if (params.replyToEmailId) {
		const threading = await resolveThreadedSend(
			stub,
			params.replyToEmailId,
			params.threadedMode ?? "reply",
		);
		if (!threading) return { error: "Original email not found" };
		inReplyTo = threading.inReplyTo;
		references = threading.references;
		threadId = threading.threadId;
		markRead = threading.markThreadRead;
	}

	const sendAtIso = new Date(sendAtMs).toISOString();
	const to = joinAddressList(params.to) ?? "";
	const cc = joinAddressList(params.cc);
	const bcc = joinAddressList(params.bcc);

	/**
	 * The pre-send gate now, while the agent's credential is known: the alarm
	 * that delivers this has no caller, so a short delay must not skip approval.
	 * A held message keeps its `send_at` and is queued only once approved.
	 */
	const asList = (v: string | string[] | undefined) => (v ? (Array.isArray(v) ? v : v.split(",")).map((a) => a.trim()).filter(Boolean) : []);
	const gate = await agentGate(env, stub, mailboxId, { to: params.to, cc: params.cc, bcc: params.bcc }, undefined, {
		actor,
		action: "schedule_send",
		html,
		draft: {
			kind: "transactional",
			to: asList(params.to),
			cc: asList(params.cc),
			bcc: asList(params.bcc),
			from: mailboxId,
			subject: params.subject,
			html,
			row: {
				threadId: threadId === messageId ? null : threadId,
				inReplyTo,
				references,
				rawHeaders: JSON.stringify([
					{ key: "from", value: mailboxId },
					{ key: "subject", value: params.subject },
					...(inReplyTo ? [{ key: "in-reply-to", value: `<${inReplyTo}>` }] : []),
					...(references.length ? [{ key: "references", value: references.map((r) => `<${r}>`).join(" ") }] : []),
				]),
			},
			markThreadRead: markRead,
			sendAt: sendAtIso,
			trackingBaseUrl: await trackingBaseUrl(env),
		},
	});
	if ("error" in gate) return "pending" in gate ? (gate.pending as PendingApproval) : gate;

	// Same row shape as POST /scheduled-sends, which the cron dispatcher reads
	// back at delivery: notably `raw_headers`, where cc/bcc and threading live.
	await stub.createScheduledEmail(
		{
			id: messageId,
			subject: params.subject,
			sender: mailboxId.toLowerCase(),
			recipient: to.toLowerCase(),
			cc: cc?.toLowerCase() ?? null,
			bcc: bcc?.toLowerCase() ?? null,
			date: sendAtIso,
			body: html,
			in_reply_to: inReplyTo,
			email_references: references.length > 0 ? JSON.stringify(references) : null,
			thread_id: threadId,
			message_id: outgoingMessageId,
			raw_headers: JSON.stringify([
				{ key: "from", value: mailboxId },
				{ key: "to", value: to },
				...(cc ? [{ key: "cc", value: cc }] : []),
				...(bcc ? [{ key: "bcc", value: bcc }] : []),
				{ key: "subject", value: params.subject },
				{ key: "date", value: sendAtIso },
				...(inReplyTo ? [{ key: "in-reply-to", value: `<${inReplyTo}>` }] : []),
				...(references.length > 0
					? [{ key: "references", value: references.map((r) => `<${r}>`).join(" ") }]
					: []),
			]),
		},
		[],
		sendAtIso,
		// No request here, so delivery takes the tracking origin from APP_URL.
		{ mailboxId: mailboxId.toLowerCase(), track: params.track },
	);
	if (markRead) await stub.markThreadRead(markRead);

	return {
		status: "scheduled",
		id: messageId,
		send_at: sendAtIso,
		message: `Scheduled for ${sendAtIso}. cancel_scheduled with this id stops it and returns it to Drafts.`,
	};
}

export async function toolListScheduled(
	env: Env,
	mailboxId: string,
	params: { status?: string } = {},
) {
	const stub = getMailboxStub(env, mailboxId);
	const rows = (await stub.listScheduledSends()) as Record<string, unknown>[];
	const wanted = params.status ?? "pending";
	return {
		scheduled: rows
			.filter((r) => wanted === "all" || r.status === wanted)
			.map((r) => ({
				id: r.email_id,
				send_at: r.send_at,
				status: r.status,
				subject: r.subject ?? "",
				to: r.recipient ?? null,
				...(r.cc ? { cc: r.cc } : {}),
				...(r.attempts ? { attempts: r.attempts } : {}),
				...(r.last_error ? { last_error: r.last_error } : {}),
				snippet: snippetText(r.snippet),
			})),
	};
}

export async function toolCancelScheduled(env: Env, mailboxId: string, emailId: string) {
	const stub = getMailboxStub(env, mailboxId);
	const result = await stub.cancelScheduledSend(emailId);
	if (!result) return { error: "Scheduled send not found", emailId };
	if (!result.cancelled) {
		return { error: `Cannot cancel: already ${result.status}`, emailId };
	}
	return { status: "cancelled", emailId, message: "Cancelled. The message is back in Drafts." };
}

// ── Attachments ────────────────────────────────────────────────────

const TEXT_LIKE_TYPES = new Set([
	"application/json",
	"application/xml",
	"application/x-yaml",
	"application/yaml",
	"application/csv",
	"application/x-ndjson",
	"application/javascript",
	"application/sql",
	"message/rfc822",
]);

/** Types returned as text rather than base64. */
export function isTextLikeMime(mimetype: string | null | undefined): boolean {
	const m = (mimetype ?? "").toLowerCase().split(";")[0]!.trim();
	if (!m) return false;
	return (
		m.startsWith("text/") ||
		TEXT_LIKE_TYPES.has(m) ||
		m.endsWith("+json") ||
		m.endsWith("+xml")
	);
}

/** Default and ceiling for binary attachment payloads returned inline. */
export const ATTACHMENT_DEFAULT_MAX_BYTES = 256 * 1024;
export const ATTACHMENT_MAX_BYTES = 1024 * 1024;
export const ATTACHMENT_TEXT_MAX_CHARS = 100_000;

export async function toolListAttachments(env: Env, mailboxId: string, emailId: string) {
	const stub = getMailboxStub(env, mailboxId);
	const email = (await stub.getEmail(emailId)) as EmailFull | null;
	if (!email) return { error: "Email not found", emailId };
	return {
		emailId,
		attachments: (email.attachments ?? []).map((a) =>
			compactAttachment(a as unknown as Record<string, unknown>),
		),
	};
}

export type AttachmentToolResult =
	| { error: string; blocked?: boolean }
	| {
			id: string;
			filename: string;
			mimetype: string;
			size: number;
			encoding: "text" | "base64" | "none";
			text?: string;
			base64?: string;
			truncated?: boolean;
			note?: string;
	  };

/**
 * Read an attachment for a model.
 *
 * Text-like types come back as text (capped). Everything else comes back as
 * base64 only when it fits `maxBytes`; otherwise metadata only, so a 20 MB
 * video cannot flood the context.
 */
export async function toolGetAttachment(
	env: Env,
	mailboxId: string,
	emailId: string,
	attachmentId: string,
	options: { maxBytes?: number } = {},
): Promise<AttachmentToolResult> {
	const maxBytes = Math.min(
		Math.max(options.maxBytes ?? ATTACHMENT_DEFAULT_MAX_BYTES, 1),
		ATTACHMENT_MAX_BYTES,
	);
	const stub = getMailboxStub(env, mailboxId);
	const attachment = (await stub.getAttachment(attachmentId)) as {
		id: string;
		email_id: string;
		filename: string;
		mimetype: string;
		size: number;
		blocked?: unknown;
	} | null;
	// Scoped to the message named, so an attachment id lifted from another
	// message is not a way to read it.
	if (!attachment || attachment.email_id !== emailId) {
		return { error: "Attachment not found" };
	}
	if (attachment.blocked || isBlockedAttachment(attachment.filename)) {
		return {
			error: "This attachment was blocked because its file type can run code.",
			blocked: true,
		};
	}

	const meta = {
		id: attachment.id,
		filename: attachment.filename,
		mimetype: attachment.mimetype,
		size: Number(attachment.size ?? 0),
	};
	const tooBig = {
		...meta,
		encoding: "none" as const,
		note: `Larger than max_bytes (${maxBytes}); content not returned. Raise max_bytes (up to ${ATTACHMENT_MAX_BYTES}) or download it in the app.`,
	};
	const textLike = isTextLikeMime(attachment.mimetype);
	if (!textLike && meta.size > maxBytes) return tooBig;

	// Text is clipped to ATTACHMENT_TEXT_MAX_CHARS anyway, so a large text file
	// is read with a range request rather than loaded whole into memory. Four
	// bytes per character covers the worst case of UTF-8.
	const key = attachmentKey(emailId, attachment.id, attachment.filename);
	const textReadBytes = ATTACHMENT_TEXT_MAX_CHARS * 4;
	const obj =
		textLike && meta.size > textReadBytes
			? await env.BUCKET.get(key, { range: { offset: 0, length: textReadBytes } })
			: await env.BUCKET.get(key);
	if (!obj) return { error: "Attachment file not found" };
	const bytes = new Uint8Array(await obj.arrayBuffer());

	if (textLike) {
		const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
		const clipped = clip(text, ATTACHMENT_TEXT_MAX_CHARS);
		return {
			...meta,
			encoding: "text",
			text: clipped.text,
			...(clipped.truncated || meta.size > bytes.byteLength ? { truncated: true } : {}),
		};
	}
	if (bytes.byteLength > maxBytes) return tooBig;
	return { ...meta, encoding: "base64", base64: bytesToBase64(bytes) };
}

// ── Templates ──────────────────────────────────────────────────────

export async function toolListTemplates(env: Env) {
	const list = await listTemplates(env.BUCKET);
	return {
		templates: list.map((t) => ({
			slug: t.slug,
			name: t.name,
			subject: t.subject,
			variables: extractVariables(t.subject, t.bodyHtml),
		})),
	};
}

/**
 * Render a template for sending.
 *
 * Variable values are HTML-escaped into the body: they come from the model,
 * and an unescaped value would let it inject markup into a message a person
 * designed. The subject is plain text and takes them as-is. Any placeholder
 * left unfilled is an error, so a recipient never sees `{{first_name}}`.
 */
export function renderTemplateForSend(
	template: EmailTemplate,
	variables: Record<string, string>,
): { subject: string; bodyHtml: string } | { error: string; missing: string[] } {
	const required = extractVariables(template.subject, template.bodyHtml);
	const missing = required.filter((v) => typeof variables[v] !== "string");
	if (missing.length > 0) {
		return { error: `Missing template variables: ${missing.join(", ")}`, missing };
	}
	const escaped = Object.fromEntries(
		Object.entries(variables).map(([k, v]) => [k, escapeHtml(v)]),
	);
	// Line breaks are flattened in subject values: a subject is one header line.
	const flat = Object.fromEntries(
		Object.entries(variables).map(([k, v]) => [k, v.replace(/[\r\n]+/g, " ")]),
	);
	return {
		subject: renderTemplate(template, flat).subject,
		bodyHtml: renderTemplate(template, escaped).bodyHtml,
	};
}

export async function toolSendTemplate(
	env: Env,
	mailboxId: string,
	params: {
		slug: string;
		to: string;
		variables: Record<string, string>;
		sender?: string | null;
		/** `false` sends this message untracked, whatever the mailbox setting. */
		track?: boolean;
	},
	/** Who asked; see {@link agentGate}. */
	actor?: SendActor,
): Promise<Record<string, unknown>> {
	const template = await getTemplate(env.BUCKET, params.slug);
	if (!template) return { error: `Template "${params.slug}" not found. Use list_templates.` };
	// `unsubscribe_url` is never caller-supplied: the signed link fills it below.
	const { unsubscribe_url: _ignored, ...callerVariables } = params.variables;
	const rendered = renderTemplateForSend(template, {
		...(await productTemplateVariables(env, mailboxId)),
		...callerVariables,
		unsubscribe_url: UNSUBSCRIBE_PLACEHOLDER,
	});
	if ("error" in rendered) return rendered;

	/**
	 * A template send is bulk mail, exactly like REST template-sends: the same
	 * compliance step adds the RFC 8058 one-click unsubscribe pair, the visible
	 * link and `List-Id`, and the gate refuses a suppressed recipient or a
	 * paused domain.
	 */
	const compliance = await bulkCompliance(env, {
		recipient: params.to,
		fromAddress: mailboxId,
		listSlug: template.slug,
		html: rendered.bodyHtml,
	});
	return toolSendEmail(env, mailboxId, {
		to: params.to,
		subject: rendered.subject,
		bodyHtml: compliance.html ?? rendered.bodyHtml,
		sender: params.sender,
		// A person wrote this body, so the agent-artifact verifier has nothing to
		// remove, and an outage of it should not block the send.
		verify: false,
		track: params.track,
		bulk: { headers: compliance.headers },
		action: "send_template",
	}, actor);
}

// ── People ─────────────────────────────────────────────────────────

type PeopleStub = {
	getPeople: (o: { folder?: string; limit?: number }) => Promise<MailboxPersonRow[]>;
	getPersonEmails: (o: { person: string; limit?: number }) => Promise<Record<string, unknown>[]>;
};

/**
 * Correspondents across the given mailboxes, merged per person.
 *
 * `mailboxIds` must already be narrowed to what the caller may read; this
 * fans out to exactly those. An unreachable mailbox is reported in
 * `degraded` rather than failing the whole call.
 */
export async function toolListPeople(
	env: Env,
	mailboxIds: string[],
	params: { folder?: string; search?: string; unread?: boolean; page: number; limit: number },
) {
	const folder = params.folder ?? Folders.INBOX;
	const settled = await Promise.allSettled(
		mailboxIds.map(async (mailbox) => ({
			mailbox,
			people: await (getMailboxStub(env, mailbox) as unknown as PeopleStub).getPeople({ folder }),
		})),
	);
	const ok = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
	const degraded = mailboxIds.filter((_, i) => settled[i]!.status === "rejected");
	const people = sortPeople(
		filterPeople(mergePeople(ok), { search: params.search, unread: params.unread }),
		{ key: "recency", direction: "desc" },
	);
	const start = (params.page - 1) * params.limit;
	const slice = people.slice(start, start + params.limit);
	return {
		people: slice.map((p) => ({
			email: p.email,
			name: p.name,
			last_email_at: p.lastEmailAt ? new Date(p.lastEmailAt * 1000).toISOString() : null,
			unread: p.unreadCount,
			total: p.totalCount,
			mailboxes: p.recipients,
		})),
		total: people.length,
		page: params.page,
		next_page: start + params.limit < people.length ? params.page + 1 : null,
		...(degraded.length ? { degraded } : {}),
	};
}

export async function toolGetPersonHistory(
	env: Env,
	mailboxIds: string[],
	params: { person: string; limit: number },
) {
	const person = params.person.trim().toLowerCase();
	if (!person) return { error: "person is required" };
	const settled = await Promise.allSettled(
		mailboxIds.map(async (mailbox) => {
			const rows = await (getMailboxStub(env, mailbox) as unknown as PeopleStub).getPersonEmails({
				person,
				limit: params.limit,
			});
			return rows.map(
				(r): Record<string, unknown> => ({ ...compactEmail(r), mailboxId: mailbox }),
			);
		}),
	);
	const emails = settled
		.flatMap((r) => (r.status === "fulfilled" ? r.value : []))
		.sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")))
		.slice(0, params.limit);
	return { person, emails, count: emails.length };
}

// ── Rules ──────────────────────────────────────────────────────────

export async function toolListRules(env: Env, mailboxId: string) {
	const stub = getMailboxStub(env, mailboxId);
	return { rules: await stub.getRules() };
}

export async function toolCreateRule(env: Env, mailboxId: string, input: RuleInput) {
	const stub = getMailboxStub(env, mailboxId);
	try {
		return { status: "created", rule: await stub.createRule(input) };
	} catch (e) {
		// RPC does not preserve the class, so the name is what survives.
		if ((e as Error).name === "RuleLimitError" || /at most/i.test((e as Error).message ?? "")) {
			return { error: (e as Error).message };
		}
		throw e;
	}
}

// ── Signatures ─────────────────────────────────────────────────────

export async function toolListSignatures(
	env: Env,
	mailboxId: string,
	options: { includeBody?: boolean } = {},
) {
	const stub = getMailboxStub(env, mailboxId);
	const rows = (await stub.getSignatures()) as unknown as Record<string, unknown>[];
	return {
		signatures: rows.map((s) => ({
			id: s.id,
			name: s.name,
			is_default: !!s.is_default,
			text: htmlToTextLines(String(s.body_html ?? "")),
			...(options.includeBody ? { body_html: s.body_html } : {}),
		})),
	};
}

// ── get_daily_brief ────────────────────────────────────────────────

/**
 * A brief over `mailboxes`, built live for the window ending at the most
 * recent `time` in `timeZone`. The caller resolves which mailboxes the session
 * may read; nothing here widens that.
 */
export async function toolGetDailyBrief(
	env: Env,
	mailboxes: string[],
	options: { time: string; timeZone: string; now?: number },
): Promise<DailyBrief> {
	const now = options.now ?? Date.now();
	// Live: from the start of the latest brief day up to now.
	const window = briefRange(now, options.time, options.timeZone, true);
	const data = await collectForMailboxes(env, mailboxes, window);
	return buildDailyBrief({ data, now, time: options.time, timeZone: options.timeZone, throughNow: true });
}

// ── get_mailbox_summary ────────────────────────────────────────────

/** Conversations `needs_reply` is counted over. */
export const SUMMARY_NEEDS_REPLY_WINDOW = 100;

/**
 * One call that answers "what is going on in this mailbox".
 *
 * `needs_reply` is counted over the newest inbox conversations (the window
 * the inbox list itself evaluates) and is reported with that window, so a
 * model does not present it as an exact total.
 */
export async function toolMailboxSummary(
	env: Env,
	mailboxId: string,
	options: { topSenders?: number } = {},
) {
	// A narrowed view of the stub: inferring the RPC types of five calls in one
	// `Promise.all` exceeds the compiler's instantiation depth.
	const stub = getMailboxStub(env, mailboxId) as unknown as PeopleStub & {
		getFolders: () => Promise<{ id: string; name: string; unreadCount: number }[]>;
		getThreadedEmails: (o: { folder: string; limit: number }) => Promise<{ needs_reply?: boolean }[]>;
		listScheduledSends: () => Promise<{ status?: unknown }[]>;
		getSnoozedEmails: () => Promise<unknown[]>;
	};
	const top = Math.min(Math.max(options.topSenders ?? 5, 1), 25);

	const [folders, threads, people, scheduled, snoozed] = await Promise.all([
		stub.getFolders(),
		stub.getThreadedEmails({ folder: Folders.INBOX, limit: SUMMARY_NEEDS_REPLY_WINDOW }),
		stub.getPeople({ folder: Folders.INBOX, limit: 500 }),
		stub.listScheduledSends(),
		stub.getSnoozedEmails(),
	]);

	const unread: Record<string, number> = Object.fromEntries(
		folders.map((f) => [f.id, Number(f.unreadCount ?? 0)]),
	);
	const topSenders = [...people]
		.sort((a, b) => b.unreadCount - a.unreadCount || b.totalCount - a.totalCount)
		.slice(0, top)
		.map((p) => ({
			email: p.email,
			name: parseDisplayName(p.fromHeader),
			unread: p.unreadCount,
			total: p.totalCount,
			last_email_at: p.lastEmailAt,
		}));

	return {
		mailboxId,
		unread_by_folder: unread,
		inbox_unread: unread[Folders.INBOX] ?? 0,
		needs_reply: threads.filter((t) => t.needs_reply).length,
		needs_reply_window: `newest ${SUMMARY_NEEDS_REPLY_WINDOW} inbox conversations`,
		scheduled_pending: scheduled.filter((s) => s.status === "pending").length,
		snoozed: snoozed.length,
		top_senders: topSenders,
	};
}

// ── Held sends (read-only) ─────────────────────────────────────────

/**
 * One held send as a model sees it. Nothing here decides or releases it:
 * there is no approve or reject tool.
 *
 * `body_text` (only with `includeBody`) is the composed message, which can
 * quote third-party mail (a reply or forward), so the MCP tool fences it.
 */
export function pendingSendView(
	a: ApprovalRecord,
	options: { yours: boolean; includeBody?: boolean; maxChars?: number; now?: number },
): Record<string, unknown> {
	const now = options.now ?? Date.now();
	const payload = a.payload as { batch?: HeldBatch; enrollment?: HeldEnrollment };
	const expired = a.status === "pending" && a.expiresAt <= now;
	const messages = payload.batch?.messages ?? [];
	const out: Record<string, unknown> = {
		approval_id: a.id,
		status: expired ? "expired" : a.status,
		kind: a.kind,
		reason: a.reason,
		recipients: a.recipients,
		subject: a.subject,
		revision: a.revision,
		...(a.revisedBy ? { revised_by: a.revisedBy } : {}),
		yours: options.yours,
		// Only the requester may revise, only while pending, only a single message.
		revisable: options.yours && a.status === "pending" && !expired && messages.length === 1,
		created_at: new Date(a.createdAt).toISOString(),
		decided_at: a.decidedAt ? new Date(a.decidedAt).toISOString() : null,
		expires_at: new Date(a.expiresAt).toISOString(),
	};
	// A rejection stores the reviewer's note in `error`; a failure, the provider's reason.
	if (a.status === "rejected") {
		if (a.error) out.rejection_note = a.error;
	} else if (a.error) {
		out.error = a.error;
	}
	if (a.status === "sent" && a.result) out.result = a.result;
	if (payload.enrollment) {
		out.enrollment = {
			sequence_id: payload.enrollment.sequenceId,
			sequence_name: payload.enrollment.sequenceName,
			person: payload.enrollment.enroll.personEmail,
			from: payload.enrollment.enroll.fromAddress,
			steps: payload.enrollment.steps.length,
		};
	}
	if (messages.length > 1) out.message_count = messages.length;
	const message = messages[0];
	if (options.includeBody && message) {
		const text = message.text ?? (message.html ? htmlToTextLines(message.html) : "");
		const clipped = clip(text, options.maxChars ?? 20_000);
		out.to = message.to;
		if (message.cc?.length) out.cc = message.cc;
		if (message.bcc?.length) out.bcc = message.bcc;
		if (message.sendAt) out.send_at = message.sendAt;
		if (message.attachments?.length) out.attachments = message.attachments.map((x) => x.filename);
		out.body_text = clipped.text;
		if (clipped.truncated) out.body_truncated = true;
	}
	return out;
}

/** Most held sends read for one list call. */
export const PENDING_SEND_SCAN = 200;

type ApprovalStub = {
	listSendApprovals(o: { status?: ApprovalStatus | "all"; limit?: number }): Promise<ApprovalRecord[]>;
	getSendApproval(id: string): Promise<ApprovalRecord | null>;
};

/**
 * Held sends in a mailbox, newest first. `isYours` says whether this session
 * asked for one (`isRequester` in agent-send-gate.ts); `onlyYours` keeps just
 * those. Read-only.
 */
export async function toolListPendingSends(
	env: Env,
	mailboxId: string,
	params: {
		status: ApprovalStatus | "all";
		onlyYours: boolean;
		isYours: (a: ApprovalRecord) => boolean;
		limit: number;
		page: number;
	},
) {
	const stub = getMailboxStub(env, mailboxId) as unknown as ApprovalStub;
	const rows = await stub.listSendApprovals({ status: params.status, limit: PENDING_SEND_SCAN });
	const views = rows.map((a) => ({ a, yours: params.isYours(a) })).filter((r) => !params.onlyYours || r.yours);
	const start = (params.page - 1) * params.limit;
	const slice = views.slice(start, start + params.limit);
	return {
		pending_sends: slice.map(({ a, yours }) => pendingSendView(a, { yours })),
		page: params.page,
		next_page: start + params.limit < views.length ? params.page + 1 : null,
		...(rows.length >= PENDING_SEND_SCAN ? { note: `Only the newest ${PENDING_SEND_SCAN} held sends are searched.` } : {}),
	};
}

export async function toolGetPendingSend(
	env: Env,
	mailboxId: string,
	approvalId: string,
	params: { isYours: (a: ApprovalRecord) => boolean; maxChars?: number },
) {
	const stub = getMailboxStub(env, mailboxId) as unknown as ApprovalStub;
	const row = await stub.getSendApproval(approvalId);
	if (!row) return { error: `No held send "${approvalId}" in ${mailboxId}. Use list_pending_sends.` };
	return pendingSendView(row, { yours: params.isYours(row), includeBody: true, maxChars: params.maxChars });
}

// ── Sequences ──────────────────────────────────────────────────────

export async function toolListSequences(env: Env) {
	const list = await listSequences(env.BUCKET);
	return {
		sequences: list.map((s) => ({
			id: s.id,
			name: s.name,
			steps: s.steps.map((st) => ({ order: st.order, template: st.templateSlug, delay_hours: st.delayHours })),
		})),
	};
}

/**
 * Enroll one person in a sequence, sending from `mailboxId`.
 *
 * Enrolling schedules mail the cron dispatcher sends later with no caller, so
 * it passes the shared pre-send gate now, with the session's actor, exactly as
 * REST `POST /sequences/:id/enroll` does. The agent approval rule holds it
 * with every rendered step for the preview, and approving enrolls exactly this
 * request (`enrollHeld` in routes/approvals.ts). Only a send the gate allows
 * outright enrolls here.
 */
export async function toolEnrollInSequence(
	env: Env,
	mailboxId: string,
	params: {
		sequenceId: string;
		personEmail: string;
		personName?: string | null;
		variables?: Record<string, string>;
		skipSteps?: number[];
	},
	actor: SendActor,
): Promise<Record<string, unknown>> {
	const personEmail = params.personEmail.trim().toLowerCase();
	// A person's id in the people aggregate is the lowercased address, which is
	// what the app's enroll dialog passes.
	const request = {
		sequenceId: params.sequenceId,
		personId: personEmail,
		personEmail,
		personName: params.personName ?? null,
		fromAddress: mailboxId,
		...(params.variables ? { variables: params.variables } : {}),
		...(params.skipSteps ? { skipSteps: params.skipSteps } : {}),
	};
	const preview = await previewEnrollment(env, request);
	if (!preview) return { error: `Sequence "${params.sequenceId}" not found. Use list_sequences.` };
	if (preview.steps.length === 0) return { error: "Every step is skipped; nothing would be sent." };
	if (await getPersonEnrollment(env.BUCKET, personEmail)) {
		return { error: `${personEmail} is already enrolled in an active sequence.` };
	}
	const gate = await preSend(env, {
		kind: "bulk",
		from: mailboxId,
		mailboxId,
		to: personEmail,
		// Each step is counted against the cap when it is sent.
		quotaChecked: true,
		actor,
		hold: {
			action: "sequence_enroll",
			subject: `Sequence: ${preview.sequenceName}`,
			payload: { enrollment: preview },
		},
	});
	if (!gate.ok) {
		if (gate.outcome === "hold_for_approval") return { status: "pending_approval", ...refusalBody(gate) };
		if (gate.code === "all_suppressed") {
			return { error: `Not enrolled: ${personEmail} is on the suppression list.`, suppressed: gate.suppressed };
		}
		return { error: gate.error };
	}
	try {
		const result = await enrollPerson(env.BUCKET, request);
		return {
			status: "enrolled",
			enrollment_id: result.enrollment.id,
			scheduled: result.scheduledEmails.length,
			message: `Enrolled. ${result.scheduledEmails.length} message(s) are scheduled from ${mailboxId}.`,
		};
	} catch (e) {
		const msg = (e as Error).message;
		if (/already enrolled|not found/i.test(msg)) return { error: msg };
		throw e;
	}
}

// ── Templates (write) ──────────────────────────────────────────────

/** Template slugs some sequence step sends. */
async function sequenceTemplateSlugs(env: Env): Promise<Set<string>> {
	const list = await listSequences(env.BUCKET);
	return new Set(list.flatMap((s) => s.steps.map((st) => st.templateSlug)));
}

/**
 * Create a template. The body is model-written, so it is neutralised like an
 * agent draft (remote images, unsafe links): `send_template` skips the draft
 * verifier because it assumes a person wrote the template.
 */
export async function toolCreateTemplate(
	env: Env,
	params: { slug: string; name: string; subject: string; bodyHtml: string },
) {
	// A sequence step naming a slug that does not exist yet would start sending
	// whatever is created under it, without anyone approving that content.
	if ((await sequenceTemplateSlugs(env)).has(params.slug)) {
		return { error: `A sequence already refers to "${params.slug}". Pick another slug.` };
	}
	try {
		const t = await createTemplate(env.BUCKET, { ...params, bodyHtml: neutraliseAgentHtml(params.bodyHtml) });
		return { status: "created", slug: t.slug, name: t.name, variables: extractVariables(t.subject, t.bodyHtml) };
	} catch (e) {
		if (/already exists/i.test((e as Error).message)) {
			return { error: `A template with slug "${params.slug}" already exists. Use update_template or another slug.` };
		}
		throw e;
	}
}

/**
 * Update a template. Refused for one a sequence uses: the dispatcher renders
 * sequence steps when it sends them, with no approval, so editing one would
 * change mail a person already approved (or never saw).
 */
export async function toolUpdateTemplate(
	env: Env,
	slug: string,
	patch: { name?: string; subject?: string; bodyHtml?: string },
) {
	if ((await sequenceTemplateSlugs(env)).has(slug)) {
		return { error: `"${slug}" is used by a sequence, so it can only be edited in the app.` };
	}
	const t = await updateTemplate(env.BUCKET, slug, {
		...patch,
		...(patch.bodyHtml !== undefined ? { bodyHtml: neutraliseAgentHtml(patch.bodyHtml) } : {}),
	});
	if (!t) return { error: `Template "${slug}" not found. Use list_templates.` };
	return { status: "updated", slug: t.slug, name: t.name, variables: extractVariables(t.subject, t.bodyHtml) };
}

// ── Signatures (write) ─────────────────────────────────────────────

export async function toolCreateSignature(
	env: Env,
	mailboxId: string,
	params: { name: string; bodyHtml: string; isDefault: boolean },
) {
	const stub = getMailboxStub(env, mailboxId);
	const row = (await stub.createSignature(params.name, neutraliseAgentHtml(params.bodyHtml), params.isDefault)) as {
		id: string;
		name: string;
		is_default: boolean;
	};
	return { status: "created", id: row.id, name: row.name, is_default: !!row.is_default };
}

// ── Suppressions (read) ────────────────────────────────────────────

/**
 * Which of these addresses the suppression list blocks for mail from
 * `mailboxId`, and for what kind of mail. Read-only.
 */
export async function toolCheckSuppressions(env: Env, mailboxId: string, addresses: string[]) {
	const normalized = addresses.map((input) => ({ input, address: normalizeSuppressionAddress(input) }));
	const valid = [...new Set(normalized.flatMap((n) => (n.address ? [n.address] : [])))];
	const rows = valid.length
		? await suppressionStore(env).findSuppressions(valid, sendingDomainOf(mailboxId) || null)
		: [];
	const byAddress = new Map<string, SuppressionRecord>();
	for (const row of rows) if (!byAddress.has(row.address)) byAddress.set(row.address, row);
	return {
		from: mailboxId,
		results: normalized.map(({ input, address }) => {
			if (!address) return { address: input, error: "not an email address" };
			const hit = byAddress.get(address);
			if (!hit) return { address, suppressed: false };
			return {
				address,
				suppressed: true,
				reason: hit.reason,
				scope: hit.scope,
				// The pre-send gate's rule: an unsubscribe stops bulk mail only.
				blocks: TRANSACTIONAL_BLOCKING_REASONS.has(hit.reason) ? "all mail" : "bulk mail (templates, sequences)",
			};
		}),
	};
}

// ── Thread summary ─────────────────────────────────────────────────

type SummaryStub = {
	getThreadSummary(id: string): Promise<ThreadSummaryView | null>;
	summarizeThreadNow(id: string): Promise<
		| { kind: "ok"; summary: ThreadSummaryView | null }
		| { kind: "capped" }
		| { kind: "not_found" }
		| { kind: "unavailable" }
		| { kind: "failed" }
	>;
};

/**
 * The AI summary of one conversation. With `generate`, a missing or stale one
 * is made now within the mailbox's daily summary cap, as the reader's
 * Summarize button does. Changes no mail.
 */
export async function toolGetThreadSummary(env: Env, mailboxId: string, threadId: string, params: { generate: boolean }) {
	const stub = getMailboxStub(env, mailboxId) as unknown as SummaryStub;
	if (!params.generate) {
		const summary = summaryForTool(await stub.getThreadSummary(threadId));
		return { thread_id: threadId, summary, ...(summary ? {} : { note: "No summary yet. Pass generate: true to make one." }) };
	}
	const outcome = await stub.summarizeThreadNow(threadId);
	switch (outcome.kind) {
		case "ok":
			return { thread_id: threadId, summary: summaryForTool(outcome.summary) };
		case "capped":
			return { error: "Today's summary limit for this mailbox is used up; it resets at 00:00 UTC. Read the thread with get_thread instead." };
		case "not_found":
			return { error: "Nothing to summarise in this conversation (unknown thread, or only in Spam or Trash)." };
		case "failed":
			return { error: "The summary model is unavailable right now; a retry is queued. Read the thread with get_thread instead." };
		default:
			return { error: "AI summaries are turned off on this deployment." };
	}
}

// ── Analytics (read) ───────────────────────────────────────────────

type AnalyticsStub = {
	getSendingAnalytics(w: { start: string; end: string }): Promise<MailboxSendingStats>;
	getEngagementAnalytics(w: { start: string; end: string }, limit?: number): Promise<MailboxEngagement>;
};

/** Delivery and engagement for mail this mailbox sent over the last `days`. */
export async function toolGetAnalytics(env: Env, mailboxId: string, params: { days: number; top: number }) {
	const stub = getMailboxStub(env, mailboxId) as unknown as AnalyticsStub;
	const w = analyticsWindow(params.days);
	const window = { start: w.start, end: w.end };
	const [sending, engagement] = await Promise.all([
		stub.getSendingAnalytics(window),
		stub.getEngagementAnalytics(window, params.top),
	]);
	// Same denominator as the analytics console: delivered, or sent before any verdict.
	const base = engagement.delivered > 0 ? engagement.delivered : engagement.sent;
	const rate = (n: number) => (base > 0 ? Math.round((n / base) * 1000) / 10 : null);
	return {
		mailboxId,
		window: { days: params.days, start: w.start, end: w.end },
		sending: {
			sent: sending.sent,
			delivered: sending.delivered,
			bounced: sending.bounced,
			soft_bounced: sending.soft_bounced,
			failed: sending.failed,
			rejected: sending.rejected,
			complaints: sending.complaints,
			pending: sending.pending,
			top_errors: sending.errors.slice(0, 5).map((e) => ({ cause: e.cause, count: e.count })),
		},
		engagement: {
			messages: engagement.sent,
			opened_messages: engagement.opened_messages,
			clicked_messages: engagement.clicked_messages,
			open_rate_pct: rate(engagement.opened_messages),
			click_rate_pct: rate(engagement.clicked_messages),
			top_messages: engagement.messages.slice(0, params.top).map((m) => ({
				id: m.email_id,
				subject: m.subject,
				sent_at: m.sent_at,
				unique_opens: m.unique_opens,
				unique_clicks: m.unique_clicks,
				outcome: m.outcome,
			})),
			top_links: engagement.links.slice(0, params.top).map((l) => ({ url: l.url, clicks: l.clicks, unique_clicks: l.unique_clicks })),
		},
		note: "Open counts are estimates: image blocking hides some opens and privacy proxies add others.",
	};
}

// ── Imports (read) ─────────────────────────────────────────────────

export async function toolListImports(env: Env, mailboxId: string, params: { limit: number }) {
	const stub = getMailboxStub(env, mailboxId) as unknown as {
		listImportJobs(limit?: number): Promise<ImportJobView[]>;
	};
	const jobs = await stub.listImportJobs(params.limit);
	return {
		imports: jobs.map((j) => ({
			id: j.id,
			source: j.source,
			status: j.status,
			label: j.label,
			progress: j.progress,
			counts: j.counts,
			last_error: j.last_error,
			created_at: j.created_at,
			finished_at: j.finished_at,
			// The IMAP username is left out; it is a login, not progress.
			...(j.imap
				? { imap: { host: j.imap.host, folders_total: j.imap.folders_total, folders_done: j.imap.folders_done, current_folder: j.imap.current_folder } }
				: {}),
		})),
	};
}

/** The deployment's suppression list, newest first. Read-only; callers gate it to admins. */
export async function toolListSuppressions(
	env: Env,
	params: { query?: string; reason?: string; limit: number; page: number },
) {
	const offset = (params.page - 1) * params.limit;
	const page = await suppressionStore(env).listSuppressions({
		query: params.query,
		reason: params.reason,
		limit: params.limit,
		offset,
	});
	return {
		suppressions: page.items.map((s) => ({
			address: s.address,
			scope: s.scope,
			reason: s.reason,
			source: s.source,
			created_at: new Date(s.created_at).toISOString(),
		})),
		total: page.total,
		page: params.page,
		next_page: offset + page.items.length < page.total ? params.page + 1 : null,
	};
}

/**
 * Month-to-date usage and cost, as GET /api/v1/usage builds it, for the
 * mailboxes on the domains this deployment serves. Callers gate it to admins.
 */
export async function toolGetUsage(env: Env) {
	const mailboxes = (await listMailboxes(env.BUCKET))
		.map((m) => m.email.toLowerCase())
		.filter((m) => isDomainAllowed(env, domainOfAddress(m)))
		.sort();
	const usage = await buildUsage(env, mailboxes);
	// The price table is static reference data; leave it out to keep the result small.
	const { pricing: _pricing, ...rest } = usage;
	return rest;
}
