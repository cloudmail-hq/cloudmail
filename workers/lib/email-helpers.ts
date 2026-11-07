// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared email helpers to eliminate duplication across API routes, MCP, and agent.
 *
 * Includes: DO stub helpers, sender validation, message-ID generation,
 * threading, HTML utilities, and tool-logic (getFullEmail / getFullThread).
 */
import type { MailboxDO } from "../durableObject";
import type { EmailFull } from "./schemas";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";
import { formatQuotedDate } from "../../shared/dates";
import {
	MAX_MESSAGE_BYTES,
	estimateMessageBytes,
	formatBytesShort,
} from "../../shared/limits";
import { listAllKeys } from "./r2";
import { splitQuotedBody } from "../../shared/quoted-text";
import { assertSendableHeaders, UnsendableHeaderError } from "../../shared/email-headers";
import { decodeHtmlEntities, htmlToTextLines } from "../../shared/html-text";
import {
	MAX_HEADER_VALUE_BYTES,
	SendValidationError,
	validateOutgoingMessage,
	type SendableMessage,
} from "../../shared/send-validation";
import { describeSendError } from "../../shared/send-errors";

// ── DO Stub ────────────────────────────────────────────────────────

/**
 * Resolve a MailboxDO stub from a mailbox email address.
 * Replaces the repeated 3-line ns.idFromName / ns.get pattern.
 */
export function getMailboxStub(
	env: Env,
	mailboxId: string,
): DurableObjectStub<MailboxDO> {
	const ns = env.MAILBOX;
	const id = ns.idFromName(mailboxId);
	return ns.get(id);
}

// ── Inbound recipients ─────────────────────────────────────────────

/**
 * Every address an inbound message was delivered to, most authoritative first.
 *
 * The envelope recipient — `message.to` on the Cloudflare email event — is what
 * Email Routing actually delivered to, and it is always present. The `To:`
 * header is neither: a message Bcc'd to us carries someone else's address, list
 * expansion rewrites it, and plenty of automated mail omits it entirely.
 *
 * Inbound delivery used to key off the parsed `To:` header alone and throw when
 * it was missing. Because the email handler re-throws so Email Routing can retry
 * rather than silently dropping mail, that turned every header-less message into
 * a bounce — legitimate mail was rejected at the door. Production logs show this
 * firing on real deliveries.
 *
 * The envelope address leads the list so routing prefers it, and the header
 * addresses follow so the stored `recipient` line still shows the whole
 * audience. De-duplicated case-insensitively.
 */
export function resolveInboundRecipients(options: {
	/** `message.to` from the email event: the envelope recipient. */
	envelopeTo?: string | null;
	/** Addresses parsed from the `To:` header. */
	headerTo?: (string | null | undefined)[];
}): string[] {
	const seen = new Set<string>();
	const out: string[] = [];

	const add = (raw: string | null | undefined) => {
		const address = raw?.trim().toLowerCase();
		if (!address || seen.has(address)) return;
		seen.add(address);
		out.push(address);
	};

	add(options.envelopeTo);
	for (const address of options.headerTo ?? []) add(address);

	return out;
}

// ── Mailbox Listing ────────────────────────────────────────────────

/**
 * List all mailboxes from R2 bucket metadata.
 */
export async function listMailboxes(
	bucket: R2Bucket,
): Promise<{ id: string; email: string }[]> {
	// Only the keys are needed — the id is the filename — so this skips the
	// per-object read that the other prefix listings have to do.
	const keys = await listAllKeys(bucket, "mailboxes/");
	return keys.map((key) => {
		const id = key.replace("mailboxes/", "").replace(".json", "");
		return { id, email: id };
	});
}

// ── Sender Validation ──────────────────────────────────────────────

/**
 * Normalise to/from addresses and validate the sender matches the mailbox, or
 * one of its aliases (`aliases`, from `GET /mailboxes/:id/aliases`).
 * Returns the normalised values or throws with a user-facing message.
 */
export function validateSender(
	to: string | string[],
	from: string | { email: string; name: string },
	mailboxId: string,
	aliases: readonly string[] = [],
): { toStr: string; fromEmail: string; fromDomain: string } {
	const toStr = (Array.isArray(to) ? to.join(", ") : to).toLowerCase();
	const fromEmail = (typeof from === "string" ? from : from.email).toLowerCase();

	if (
		fromEmail !== mailboxId.toLowerCase() &&
		!aliases.some((a) => a.toLowerCase() === fromEmail)
	) {
		throw new SenderValidationError(
			aliases.length > 0
				? "From address must be the mailbox address or one of its aliases"
				: "From address must match the mailbox email address",
		);
	}

	const fromDomain = fromEmail.split("@")[1];
	if (!fromDomain) {
		throw new SenderValidationError("Invalid sender email address");
	}

	return { toStr, fromEmail, fromDomain };
}

export class SenderValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SenderValidationError";
	}
}

// ── Message Size ───────────────────────────────────────────────────

export class MessageTooLargeError extends Error {
	readonly estimatedBytes: number;

	constructor(estimatedBytes: number) {
		super(
			`Message is too large to send: ~${formatBytesShort(estimatedBytes)} exceeds the ${formatBytesShort(MAX_MESSAGE_BYTES)} limit (attachments are base64-encoded, which adds about 37%). Remove or shrink attachments and try again.`,
		);
		this.name = "MessageTooLargeError";
		this.estimatedBytes = estimatedBytes;
	}
}

/**
 * Reject messages Cloudflare Email Service would refuse.
 *
 * Must run *before* the message is written to the Sent folder. Sends dispatched
 * over HTTP go out inside `waitUntil()`, so without this check an oversized
 * message is filed in Sent, the caller gets 202, and the rejection is only
 * visible in Worker logs.
 */
export function assertMessageWithinSizeLimit(message: {
	html?: string | null;
	text?: string | null;
	attachments?: { content: string }[];
}): void {
	const estimatedBytes = estimateMessageBytes({
		html: message.html,
		text: message.text,
		encodedAttachmentSizes: message.attachments?.map(
			(att) => att.content.length,
		),
	});

	if (estimatedBytes > MAX_MESSAGE_BYTES) {
		throw new MessageTooLargeError(estimatedBytes);
	}
}

// ── Message ID ─────────────────────────────────────────────────────

/**
 * Generate an internal UUID and a proper RFC 2822 Message-ID.
 */
export function generateMessageId(fromDomain: string): {
	messageId: string;
	outgoingMessageId: string;
} {
	const messageId = crypto.randomUUID();
	const outgoingMessageId = `${messageId}@${fromDomain}`;
	return { messageId, outgoingMessageId };
}

// ── Threading ──────────────────────────────────────────────────────

/**
 * Build the References chain and In-Reply-To from an original email.
 */
export function buildReferencesChain(original: EmailFull): {
	originalMsgId: string;
	references: string[];
	threadId: string;
} {
	const originalMsgId = original.message_id || original.id;
	let existingRefs: string[] = [];
	if (original.email_references) {
		try {
			existingRefs = JSON.parse(original.email_references);
		} catch {
			// Malformed JSON in email_references — treat as empty
		}
	}
	const references = [...existingRefs, originalMsgId].filter(Boolean);
	const threadId = original.thread_id || original.id;
	return { originalMsgId, references, threadId };
}

/**
 * Build the headers for an outgoing message.
 *
 * ## Why `Message-ID` is NOT set here (it used to be, and nothing delivered)
 *
 * An earlier version set `Message-ID` on every send, to make a reply thread back
 * to the row we stored. The intent was right; the mechanism is not available.
 * Email Service treats `Message-ID` as platform-controlled — it generates one for
 * delivery tracking — and refuses to let a caller set it:
 *
 *     custom header 'Message-ID' is not allowed.
 *     Only whitelisted headers and X-* headers are accepted.
 *
 * A rejected header fails the WHOLE message, so every outgoing email in the
 * product silently stopped being delivered. It stayed hidden because the send
 * route writes the Sent copy and returns `202 {"status":"sent"}` before delivery
 * is attempted, and the real `env.EMAIL.send()` runs in `waitUntil` where the
 * rejection only reaches `console.error`.
 *
 * `Sender` was rejected for the same reason — it is not on the allowlist either.
 *
 * ## How threading still works
 *
 * Outgoing threading never depended on our own `Message-ID`: a reply is matched
 * by the `In-Reply-To` / `References` it carries, and those ARE allowlisted, so
 * they are still sent here. What changed is the OTHER direction — the id a remote
 * client will cite when replying to us is now the provider's, so the caller must
 * record the `messageId` that `send()` returns instead of one we invented. That is
 * `recordProviderMessageId` on the mailbox; see `sendEmail`'s return value.
 *
 * Every header produced here is checked against the provider's documented
 * allowlist before it leaves, so a future addition fails in tests instead of in
 * production silence.
 */
export function buildOutgoingHeaders(options: {
	/**
	 * Message-ID of the direct parent, when this is a reply.
	 *
	 * This is the id the message we are answering carried, NOT one of ours, so
	 * citing it is exactly what RFC 5322 asks for.
	 */
	inReplyTo?: string | null;
	/** Full ancestry, oldest first. */
	references?: string[];
}): Record<string, string> {
	const headers: Record<string, string> = {};

	if (options.inReplyTo) {
		headers["In-Reply-To"] = `<${options.inReplyTo}>`;
	}
	if (options.references && options.references.length > 0) {
		headers.References = fitReferences(options.references);
	}

	// Fail loudly rather than at the provider. The outage this replaces was
	// invisible precisely because the rejection happened somewhere nobody looked.
	assertSendableHeaders(headers);

	return headers;
}

/**
 * Format a `References` chain that fits the provider's per-value limit.
 *
 * Email Service refuses any header value over 2,048 bytes, and refuses the
 * whole message with it — so a reply deep into a long thread (each id is ~50–80
 * bytes) would fail outright once the chain passed roughly 30 entries. RFC 5322
 * §3.6.4 allows trimming: keep the root, which is what clients group on when the
 * parent is missing, and as many of the most recent ancestors as fit, nearest
 * last. The direct parent is always last, so `In-Reply-To` and the tail agree.
 */
export function fitReferences(
	references: string[],
	maxBytes: number = MAX_HEADER_VALUE_BYTES,
): string {
	const ids = references.map((r) => r.trim().replace(/^<|>$/g, "")).filter(Boolean);
	const bracketed = ids.map((r) => `<${r}>`);
	const full = bracketed.join(" ");
	const size = (value: string) => new TextEncoder().encode(value).byteLength;
	if (size(full) <= maxBytes || bracketed.length <= 1) return full;

	const root = bracketed[0];
	const tail: string[] = [];
	let used = size(root);
	for (let i = bracketed.length - 1; i > 0; i--) {
		const cost = size(bracketed[i]) + 1; // +1 for the separating space
		if (used + cost > maxBytes) break;
		tail.unshift(bracketed[i]);
		used += cost;
	}
	return [root, ...tail].join(" ");
}

/**
 * The narrow slice of the mailbox stub `recordDelivery` needs.
 *
 * Structural rather than importing the DO type, so the route helpers stay
 * testable with a plain object and cannot accidentally reach for other RPC.
 */
export interface DeliveryRecorder {
	recordDelivery(
		emailId: string,
		outcome: { providerMessageId?: string; error?: string },
	): Promise<unknown>;
}

/**
 * Write the provider's verdict back onto the stored message.
 *
 * Every send path answers the caller (`202`, or a tool result) and writes its
 * Sent copy BEFORE delivery is attempted, then performs the real
 * `env.EMAIL.send()` in `waitUntil`. Until now a rejection there reached nothing
 * but `console.error`, which is precisely why a header the provider refuses took
 * down 100% of outgoing mail while the UI, the API and the database all reported
 * success.
 *
 * On success this stores the provider's own `Message-ID` — the only id the
 * outside world knows the message by, and so the id an inbound reply will cite.
 * On failure it records the reason where the user can see it.
 *
 * NEVER THROWS and never rejects: it is the tail of a fire-and-forget chain, so
 * an exception here would turn a recorded failure into an unhandled rejection
 * and lose the very signal it exists to capture.
 */
export async function recordDelivery(
	stub: DeliveryRecorder,
	emailId: string,
	outcome: { providerMessageId?: string; error?: string } | { thrown: unknown },
): Promise<void> {
	if ("thrown" in outcome) {
		// Stored as "<friendly sentence> (<E_CODE>)" so the reading pane says
		// something actionable and the code survives for support and agents.
		outcome = { error: describeSendError(outcome.thrown) };
	}
	try {
		await stub.recordDelivery(emailId, outcome);
	} catch (e) {
		console.error(
			"Could not record delivery outcome for",
			emailId,
			(e as Error)?.message,
		);
	}
}

// ── Pre-send validation ────────────────────────────────────────────

/**
 * Why a message cannot be sent, as an HTTP status and body, or null when it can.
 *
 * Runs Email Service's documented per-message limits (recipients, attachments,
 * size, headers) before anything is stored, so a message the provider would
 * refuse is a 400 naming the limit instead of a 202 that flips to "failed" a
 * moment later. Size keeps its existing 413, which clients already handle.
 */
export function sendRejection(
	message: SendableMessage,
): { status: 400 | 413; body: { error: string; code: string } } | null {
	try {
		validateOutgoingMessage(message);
		return null;
	} catch (e) {
		if (e instanceof SendValidationError) {
			return {
				status: e.code === "E_CONTENT_TOO_LARGE" ? 413 : 400,
				body: { error: e.message, code: e.code },
			};
		}
		if (e instanceof UnsendableHeaderError) {
			return { status: 400, body: { error: e.message, code: e.code } };
		}
		throw e;
	}
}

// ── Draft-follows-in_reply_to ──────────────────────────────────────

/**
 * If the given email is a draft with an in_reply_to, resolve the real original.
 * Used by reply/forward routes to avoid threading against the draft itself.
 */
export async function resolveOriginalEmail(
	stub: DurableObjectStub<MailboxDO>,
	email: EmailFull,
): Promise<EmailFull> {
	if (email.folder_id === Folders.DRAFT && email.in_reply_to) {
		// `getEmailByRef`, not `getEmail`: a draft's `in_reply_to` is the parent's
		// row id when the composer wrote it and the parent's RFC Message-ID when the
		// send path did — a draft demoted back into Drafts by Undo Send or an
		// exhausted retry carries the latter. Looking only by row id missed those,
		// and this function then returned the *draft*, so the chain was rebuilt from
		// a conversation of one and the reply arrived detached.
		const realOriginal = (await stub.getEmailByRef(
			email.in_reply_to,
		)) as EmailFull | null;
		if (realOriginal) return realOriginal;
	}
	return email;
}

/** Threading for an outgoing message, derived from the one it answers. */
export interface ThreadedSend {
	/** Value for the `In-Reply-To` header and the stored `in_reply_to` column. */
	inReplyTo: string;
	/** Full ancestry for the `References` header, oldest first. */
	references: string[];
	/** Conversation the outgoing message belongs to. */
	threadId: string;
	/** Thread to mark read, or null when the mode doesn't imply reading it. */
	markThreadRead: string | null;
}

/**
 * Work out how an outgoing message attaches to an existing conversation.
 *
 * Callers can only tell us *which* message is being answered — the `References`
 * chain needs the original's whole ancestry (RFC 5322 §3.6.4), and without it the
 * recipient's client files the reply as a new conversation. So the chain is
 * always rebuilt from the stored original rather than taken on trust.
 *
 * Returns null when the original no longer exists, which the caller should treat
 * as a 404 rather than silently sending an unthreaded message.
 */
export async function resolveThreadedSend(
	stub: DurableObjectStub<MailboxDO>,
	originalId: string,
	mode: "reply" | "forward",
): Promise<ThreadedSend | null> {
	// Resolved by row id or Message-ID, because callers hold whichever form the
	// row they are working from happens to carry — see `getEmailByRef`. A draft
	// that came back from Undo Send names its parent by Message-ID, and this used
	// to 404 on it and refuse the send.
	const raw = (await stub.getEmailByRef(originalId)) as EmailFull | null;
	if (!raw) return null;

	const original = await resolveOriginalEmail(stub, raw);
	const { originalMsgId, references, threadId } = buildReferencesChain(original);

	return {
		inReplyTo: originalMsgId,
		references,
		threadId,
		// Replying implies you've read the conversation; forwarding does not.
		markThreadRead: mode === "forward" ? null : threadId,
	};
}

// ── HTML Utilities ─────────────────────────────────────────────────

/**
 * Escape all five OWASP-recommended HTML special characters in plain text.
 * Safe for use in both text content and attribute contexts.
 */
export function escapeHtml(text: string): string {
	if (!text) return "";
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Convert plain text to a simple HTML block with preserved whitespace.
 * Uses both `white-space:pre-wrap` (modern clients) and `<br>` tags
 * (clients that strip inline styles, e.g. Outlook) as a belt-and-suspenders approach.
 */
export function textToHtml(text: string): string {
	if (!text) return "";
	const escaped = escapeHtml(text).replace(/\n/g, "<br>");
	return `<div style="white-space:pre-wrap">${escaped}</div>`;
}

/**
 * Strip HTML tags and normalize whitespace to produce plain text.
 * Removes <style> and <script> blocks first to avoid injecting their
 * content into the output.
 */
export function stripHtmlToText(html: string): string {
	if (!html) return "";
	return decodeHtmlEntities(
		html
			.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
			.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
			.replace(/<[^>]+>/g, " "),
	)
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Format a date string for use in quoted reply blocks.
 * @deprecated Use `formatQuotedDate` from `shared/dates` directly.
 */
export const formatEmailDate = formatQuotedDate;

/**
 * Convert HTML to plain text while keeping paragraph and line breaks, so a
 * quoted block reads like the original instead of one flattened run.
 */
function htmlToQuotableText(html: string): string {
	return htmlToTextLines(html);
}

/**
 * Build a quoted reply block HTML string from original email data.
 *
 * Only the text the original sender wrote is quoted. Their body already
 * ends with the message they replied to, so quoting all of it would add a
 * full copy of the thread on every round trip — the reason threads render
 * as walls of repeated text.
 */
export function buildQuotedReplyBlock(original: {
	date?: string;
	sender?: string;
	body?: string;
}): string {
	if (!original.body) return "";
	
	// HTML-escape sender and date to prevent injection
	const originalSender = escapeHtml(original.sender || "unknown");
	const originalDate = escapeHtml(formatEmailDate(original.date || ""));

	// Sanitize the body to plain text to prevent stored XSS.
	// The original HTML renders safely in the sandboxed iframe, but quoted
	// reply blocks are injected into the compose editor and outgoing emails
	// where raw HTML would execute. Convert to escaped plain text instead.
	const { visible } = splitQuotedBody(original.body);
	const plainBody = htmlToQuotableText(visible);
	if (!plainBody) return "";
	const bodyToQuote = escapeHtml(plainBody).replace(/\n/g, "<br>");

	return `<br><blockquote style="border-left: 2px solid #ccc; margin: 0; padding-left: 1em; color: #666;">On ${originalDate}, ${originalSender} wrote:<br><br>${bodyToQuote}</blockquote>`;
}

// ── Tool Logic (getFullEmail / getFullThread) ──────────────────────

type MailboxThreadReaderStub = {
	getThreadEmails: (threadId: string) => Promise<EmailFull[]>;
};

/**
 * Fetch a single email and return it with both HTML and plain-text body.
 * Returns null if the email is not found.
 */
export async function getFullEmail(
	stub: DurableObjectStub<MailboxDO>,
	emailId: string,
) {
	const email = (await stub.getEmail(emailId)) as EmailFull | null;
	if (!email) return null;

	const textBody = email.body ? stripHtmlToText(email.body) : "";
	return { ...email, body_text: textBody, body_html: email.body };
}

/**
 * Fetch all emails in a thread with full bodies in a single DO call.
 * Uses `getThreadEmails` which runs 2 SQL queries (emails + attachments)
 * instead of the previous N+1 pattern (1 list query + N getEmail calls).
 */
export async function getFullThread(
	stub: DurableObjectStub<MailboxDO>,
	threadId: string,
) {
	const threadStub = stub as unknown as MailboxThreadReaderStub;
	const emails = await threadStub.getThreadEmails(threadId);

	const enriched = emails.map((email) => {
		const textBody = email.body ? stripHtmlToText(email.body) : "";
		return { ...email, body_text: textBody };
	});

	// Already sorted ASC by the DO query, but ensure consistency
	enriched.sort(
		(a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
	);

	return { thread_id: threadId, message_count: enriched.length, messages: enriched };
}

/**
 * Derive a priority hint from inbound headers.
 *
 * Reads the two conventions that are actually widespread: `Importance:
 * high|low` (RFC 2156) and the numeric `X-Priority: 1..5` that Outlook and
 * older clients emit, plus its `X-MSMail-Priority` sibling. Returns null for
 * normal or absent priority so the column stays empty for the overwhelming
 * majority of mail.
 *
 * `Importance` wins when both are present: it is the standardised header, and
 * senders that set both generally derive X-Priority from it.
 */
export function extractPriority(
	headers: { key: string; value: string }[] | undefined,
): "high" | "low" | null {
	if (!headers?.length) return null;

	const lookup = (name: string) =>
		headers.find((h) => h.key?.toLowerCase() === name)?.value?.trim().toLowerCase();

	const importance = lookup("importance");
	if (importance === "high") return "high";
	if (importance === "low") return "low";

	const xPriority = lookup("x-priority") ?? lookup("x-msmail-priority");
	if (xPriority) {
		// Values look like "1", "1 (Highest)", or bare words such as "High".
		const level = Number.parseInt(xPriority, 10);
		if (!Number.isNaN(level)) {
			if (level <= 2) return "high";
			if (level >= 4) return "low";
			return null;
		}
		if (xPriority.startsWith("high")) return "high";
		if (xPriority.startsWith("low")) return "low";
	}

	return null;
}
