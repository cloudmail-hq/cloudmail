// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Held messages: what an agent asked to send, composed in full, waiting for a
 * person. See `workers/lib/agent-send-gate.ts` for who gets held.
 *
 * ## What you see is what gets sent
 *
 * Every send path (REST and MCP) composes its message completely BEFORE the
 * gate: validation, threading, the quoted reply, the forward body and its
 * attachments, a rendered template, unsubscribe headers, and the AI verifier's
 * output. A hold stores that result as one immutable {@link ComposedMessage}
 * on the approval row, and approving sends exactly those bytes through
 * {@link sendComposed}. Nothing model-driven runs between the preview and the
 * send. The only change made at send time is open/click tracking, which is our
 * own instrumentation and is named in the preview.
 *
 * Attachments are written to R2 under `held/<approval>/` at hold time and read
 * back at send, so the row stays small.
 *
 * ## Exactly once
 *
 * Approving claims the row (`pending → sending`, atomic in the Durable Object,
 * with a fresh fencing token) before the provider call, and only the holder of
 * that token can record the outcome. The provider binding has no idempotency
 * key, so a call that fails ambiguously (a timeout, a 5xx, an unknown error)
 * may still have been delivered: it becomes `sent_unconfirmed`, which is final
 * and can never be retried. Only a deterministic refusal the provider made
 * before accepting (a validation, sender, recipient, header or quota error) is
 * `failed`, which a person may edit and approve again. A crash between the
 * claim and the outcome leaves the row in `sending`, shown as "not confirmed",
 * and it is likewise never retried.
 */

import { sendEmail } from "../email-sender";
import { Folders } from "../../shared/folders";
import { bareMessageId } from "../../shared/message-ids";
import { sendErrorCode, describeSendError } from "../../shared/send-errors";
import { getMailboxStub } from "./email-helpers";
import { storeAttachments } from "./attachments";
import { trackOutgoingHtml, type TrackingStub } from "./tracking-send";
import { preSend, type SendActor } from "./pre-send";
import type { Env } from "../types";

export type Address = string | { email: string; name: string };

/** An address field (string, comma list or array) as a list. */
export function listOf(v: string | string[] | undefined | null): string[] {
	if (!v) return [];
	return (Array.isArray(v) ? v : v.split(",")).map((a) => a.trim()).filter(Boolean);
}

export interface ComposedAttachment {
	/** R2 key of the bytes, under `held/`. */
	key: string;
	filename: string;
	type: string;
	disposition: "attachment" | "inline";
	contentId?: string;
}

/** One fully composed outgoing message. Immutable once held. */
export interface ComposedMessage {
	/** How the pre-send gate treats it: one-to-one mail is `transactional`, template sends `bulk`. */
	kind?: "transactional" | "bulk";
	to: string[];
	cc?: string[];
	bcc?: string[];
	from: Address;
	subject: string;
	html?: string;
	text?: string;
	/** Threading, List-Unsubscribe and the like; already validated. */
	headers?: Record<string, string>;
	attachments?: ComposedAttachment[];
	/** Columns for the stored Sent row. */
	row: {
		threadId: string | null;
		inReplyTo: string | null;
		references: string[];
		/** `raw_headers` JSON for the Sent row. */
		rawHeaders: string | null;
	};
	/** Mark this thread read once sent (a reply). */
	markThreadRead?: string | null;
	/** Queue for later instead of sending now. ISO time. */
	sendAt?: string | null;
	/** Origin for tracking links; captured while a request was in hand. `null` sends untracked. */
	trackingBaseUrl: string | null;
}

/** A batch: one approval, several messages (template sends fan out per recipient). */
export interface HeldBatch {
	messages: ComposedMessage[];
	/** What the preview says about this batch, beyond the messages themselves. */
	note?: string;
}

/** What gets stored for a held sequence enrollment. */
export interface HeldEnrollment {
	sequenceId: string;
	sequenceName: string;
	steps: { order: number; delayHours: number; subject: string; bodyHtml: string }[];
	enroll: {
		personId: string;
		personEmail: string;
		personName: string | null;
		fromAddress: string;
		variables?: Record<string, string>;
		skipSteps?: number[];
		delayOverrides?: Record<string, number>;
	};
}

/**
 * A composed message before its attachments are stashed: what every send path
 * hands to its gate at the exact point it would otherwise call the provider.
 */
export type ComposedDraft = Omit<ComposedMessage, "attachments"> & { rawAttachments?: RawAttachment[] };

/**
 * The hook every send tool takes. Called with the final composed message just
 * before the provider call; returning `{ proceed: true }` lets the tool send
 * as it always did, anything else is returned to the caller instead (a pending
 * approval or a refusal).
 */
export type SendGateHook = (draft: ComposedDraft) => Promise<{ proceed: true } | { proceed: false; result: Record<string, unknown> }>;

/** Turn drafts into a held batch, stashing their attachments under `approvalKey`. */
export async function draftsToBatch(bucket: R2Bucket, approvalKey: string, drafts: ComposedDraft[], note?: string): Promise<HeldBatch> {
	const messages: ComposedMessage[] = [];
	for (let i = 0; i < drafts.length; i++) {
		const { rawAttachments, ...rest } = drafts[i]!;
		const attachments = await stashAttachments(bucket, `${approvalKey}/${i}`, rawAttachments);
		messages.push({ ...rest, ...(attachments.length ? { attachments } : {}) });
	}
	return { messages, ...(note ? { note } : {}) };
}

/** Attachments as the send paths have them (base64 content). */
export interface RawAttachment {
	content: string;
	filename: string;
	type: string;
	disposition?: string;
	contentId?: string;
}

/** Write a message's attachments to R2 under `held/<approvalKey>/`. */
export async function stashAttachments(
	bucket: R2Bucket,
	approvalKey: string,
	attachments: RawAttachment[] | undefined,
): Promise<ComposedAttachment[]> {
	if (!attachments?.length) return [];
	const out: ComposedAttachment[] = [];
	for (let i = 0; i < attachments.length; i++) {
		const a = attachments[i]!;
		const key = `held/${approvalKey}/${i}`;
		const bytes = Uint8Array.from(atob(a.content), (ch) => ch.charCodeAt(0));
		await bucket.put(key, bytes);
		out.push({
			key,
			filename: a.filename,
			type: a.type,
			disposition: a.disposition === "inline" ? "inline" : "attachment",
			...(a.contentId ? { contentId: a.contentId } : {}),
		});
	}
	return out;
}

/** Read stashed attachments back as base64, for the provider. */
async function loadAttachments(bucket: R2Bucket, list: ComposedAttachment[] | undefined): Promise<RawAttachment[]> {
	if (!list?.length) return [];
	const out: RawAttachment[] = [];
	for (const a of list) {
		const obj = await bucket.get(a.key);
		if (!obj) throw Object.assign(new Error(`Held attachment ${a.filename} is missing`), { code: "E_VALIDATION_ERROR" });
		const bytes = new Uint8Array(await obj.arrayBuffer());
		let bin = "";
		for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		out.push({ content: btoa(bin), filename: a.filename, type: a.type, disposition: a.disposition, contentId: a.contentId });
	}
	return out;
}

/** Remove a held message's stashed attachments (after it is sent or rejected). */
export async function dropStash(bucket: R2Bucket, approvalKey: string): Promise<void> {
	try {
		const listed = await bucket.list({ prefix: `held/${approvalKey}/` });
		const keys = listed.objects.map((o) => o.key);
		if (keys.length) await bucket.delete(keys);
	} catch (e) {
		console.error(`held attachment cleanup failed for ${approvalKey}:`, (e as Error).message);
	}
}

/**
 * Codes the provider returns BEFORE accepting a message. These mean "not sent",
 * so a retry cannot duplicate anything. Everything else is ambiguous.
 */
const DEFINITE_REJECTIONS = new Set([
	"E_VALIDATION_ERROR",
	"E_FIELD_MISSING",
	"E_TOO_MANY_RECIPIENTS",
	"E_TOO_MANY_ATTACHMENTS",
	"E_CONTENT_TOO_LARGE",
	"E_SENDER_NOT_VERIFIED",
	"E_SENDER_DOMAIN_NOT_AVAILABLE",
	"E_RECIPIENT_NOT_ALLOWED",
	"E_RECIPIENT_SUPPRESSED",
	"E_ACCOUNT_SUSPENDED",
	"E_RATE_LIMIT_EXCEEDED",
	"E_DAILY_LIMIT_EXCEEDED",
	"E_HEADER_NOT_ALLOWED",
	"E_HEADER_USE_API_FIELD",
	"E_HEADER_VALUE_INVALID",
	"E_HEADER_VALUE_TOO_LONG",
	"E_HEADER_NAME_INVALID",
	"E_HEADERS_TOO_LARGE",
	"E_HEADERS_TOO_MANY",
]);

/**
 * How to record a thrown send. `rejected`: the provider refused before
 * accepting, so a retry is safe. `unconfirmed`: it may have gone out (timeout,
 * network, 5xx, `E_DELIVERY_FAILED`, anything unknown), so it must never be
 * retried. Pure; exported for tests.
 */
export function classifySendFailure(error: unknown): "rejected" | "unconfirmed" {
	const code = sendErrorCode(error);
	return code && DEFINITE_REJECTIONS.has(code) ? "rejected" : "unconfirmed";
}

export type SendComposedResult =
	| { ok: true; results: { emailId: string; providerMessageId: string | null; scheduled: boolean }[] }
	| { ok: false; kind: "rejected" | "unconfirmed"; error: string; sentSoFar: number };

type DeliveryStub = TrackingStub & {
	createEmail: (folder: string, email: Record<string, unknown>, attachments: unknown[]) => Promise<unknown>;
	createScheduledEmail: (
		email: Record<string, unknown>,
		attachments: unknown[],
		sendAtIso: string,
		tracking?: { trackingBaseUrl?: string | null; mailboxId?: string | null },
	) => Promise<unknown>;
	recordDelivery: (emailId: string, outcome: { providerMessageId?: string; error?: string }) => Promise<unknown>;
	markThreadRead: (threadId: string) => Promise<unknown>;
	checkSendRateLimit: () => Promise<string | null>;
};

export interface SendComposedDeps {
	/** The person releasing the send, for the pre-send gate and its rules. */
	releasedBy?: SendActor;
}

function joinList(list: string[] | undefined): string | null {
	return list && list.length ? list.join(", ").toLowerCase() : null;
}

/**
 * Send (or queue) held messages exactly as composed.
 *
 * The Sent row is written only after the provider accepts, with the provider's
 * id. Messages in a batch go one at a time; on a failure the rest are not
 * attempted, and `sentSoFar` says how many went.
 */
export async function sendComposed(
	env: Env,
	mailboxId: string,
	batch: HeldBatch,
	deps: SendComposedDeps = {},
): Promise<SendComposedResult> {
	const stub = getMailboxStub(env, mailboxId) as unknown as DeliveryStub;
	const results: { emailId: string; providerMessageId: string | null; scheduled: boolean }[] = [];

	for (const m of batch.messages) {
		const fromDomain = (typeof m.from === "string" ? m.from : m.from.email).split("@")[1] ?? "";
		const emailId = crypto.randomUUID();
		const local = `<${emailId}@${fromDomain}>`;
		const rowBase = {
			id: emailId,
			subject: m.subject,
			sender: (typeof m.from === "string" ? m.from : m.from.email).toLowerCase(),
			recipient: joinList(m.to) ?? "",
			cc: joinList(m.cc),
			bcc: joinList(m.bcc),
			body: m.html || m.text || "",
			in_reply_to: m.row.inReplyTo,
			email_references: m.row.references.length ? JSON.stringify(m.row.references) : null,
			thread_id: m.row.threadId || emailId,
			raw_headers: m.row.rawHeaders,
		};
		const raw = await loadAttachments(env.BUCKET, m.attachments).catch((e) => e as Error);
		if (raw instanceof Error) {
			return { ok: false, kind: "rejected", error: raw.message, sentSoFar: results.length };
		}

		if (m.sendAt) {
			// Queued: the scheduled-send alarm owns delivery from here, with its own
			// claim, tracking and retry rules.
			const stored = await storeAttachments(env.BUCKET, emailId, raw.map((a) => ({ ...a, disposition: a.disposition ?? "attachment" })));
			await stub.createScheduledEmail(
				{ ...rowBase, date: m.sendAt, message_id: local },
				stored,
				m.sendAt,
				{ trackingBaseUrl: m.trackingBaseUrl, mailboxId: mailboxId.toLowerCase() },
			);
			if (m.markThreadRead) await stub.markThreadRead(m.markThreadRead);
			results.push({ emailId, providerMessageId: null, scheduled: true });
			continue;
		}

		/**
		 * The shared pre-send gate again, at release: an address may have been
		 * suppressed, a cap reached or the domain paused since the hold. The actor
		 * is the person releasing it (`released: true`), so the approval rule lets
		 * it through instead of holding it a second time.
		 */
		const gate = await preSend(env, {
			kind: m.kind ?? "transactional",
			from: typeof m.from === "string" ? m.from : m.from.email,
			mailboxId,
			to: m.to,
			cc: m.cc,
			bcc: m.bcc,
			html: m.html,
			text: m.text,
			attachments: raw,
			headers: m.headers,
			actor: { ...(deps.releasedBy ?? { via: "rest" }), released: true },
		});
		if (!gate.ok) {
			// Not sent: every refusal here happens before the provider is called.
			return { ok: false, kind: "rejected", error: gate.error, sentSoFar: results.length };
		}
		if (gate.to.length !== m.to.length || gate.cc.length !== (m.cc?.length ?? 0) || gate.bcc.length !== (m.bcc?.length ?? 0)) {
			// A recipient became suppressed since the hold. Sending to the rest would
			// not be what the person approved.
			return {
				ok: false,
				kind: "rejected",
				error: `Not sent: ${gate.suppressed.map((s) => `${s.address} (${s.reason.replace("_", " ")})`).join(", ")} can no longer be mailed. Edit the recipients and approve again.`,
				sentSoFar: results.length,
			};
		}

		const outgoingHtml = await trackOutgoingHtml({
			stub,
			mailboxId: mailboxId.toLowerCase(),
			emailId,
			html: m.html,
			baseUrl: m.trackingBaseUrl,
			to: m.to,
			cc: m.cc,
			bcc: m.bcc,
			text: m.text,
			attachments: raw,
		});

		let providerMessageId: string;
		try {
			({ messageId: providerMessageId } = await sendEmail(env.EMAIL, {
				to: m.to,
				...(m.cc?.length ? { cc: m.cc } : {}),
				...(m.bcc?.length ? { bcc: m.bcc } : {}),
				from: m.from,
				subject: m.subject,
				...(outgoingHtml ?? m.html ? { html: outgoingHtml ?? m.html } : {}),
				...(m.text ? { text: m.text } : {}),
				...(raw.length
					? {
							attachments: raw.map((a) => ({
								content: a.content,
								filename: a.filename,
								type: a.type,
								disposition: (a.disposition === "inline" ? "inline" : "attachment") as "inline" | "attachment",
								...(a.contentId ? { contentId: a.contentId } : {}),
							})),
						}
					: {}),
				...(m.headers && Object.keys(m.headers).length ? { headers: m.headers } : {}),
			}, gate.clearance));
		} catch (e) {
			return { ok: false, kind: classifySendFailure(e), error: describeSendError(e), sentSoFar: results.length };
		}

		// Accepted. Everything below is bookkeeping and must not turn a sent
		// message into a failure.
		try {
			const stored = await storeAttachments(
				env.BUCKET,
				emailId,
				raw.map((a) => ({ ...a, disposition: a.disposition ?? "attachment" })),
			);
			await stub.createEmail(
				Folders.SENT,
				{
					...rowBase,
					date: new Date().toISOString(),
					message_id: bareMessageId(providerMessageId),
					delivery_status: "sent",
				},
				stored,
			);
			await stub.recordDelivery(emailId, { providerMessageId });
			if (m.markThreadRead) await stub.markThreadRead(m.markThreadRead);
		} catch (e) {
			console.error(`held send ${emailId} went out but bookkeeping failed:`, (e as Error).message);
		}
		results.push({ emailId, providerMessageId, scheduled: false });
	}
	return { ok: true, results };
}

/** A short plain-text preview of a batch, for lists and the audit log. */
export function batchSummary(batch: HeldBatch): { recipients: string[]; subject: string } {
	const recipients: string[] = [];
	for (const m of batch.messages) {
		for (const r of [...m.to, ...(m.cc ?? []), ...(m.bcc ?? [])]) {
			const v = r.toLowerCase();
			if (!recipients.includes(v)) recipients.push(v);
		}
	}
	return { recipients, subject: batch.messages[0]?.subject ?? "" };
}
