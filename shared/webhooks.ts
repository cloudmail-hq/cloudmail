// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Outbound webhooks: the vocabulary, payload shape, signing, URL guard and
 * retry schedule.
 *
 * Pure on purpose. The Worker signs and schedules with these, the settings UI
 * renders the event list and the verification snippet from them, and the tests
 * pin them without a Durable Object in sight.
 */

import { toPlainSnippet } from "./plain-snippet";
import { Folders } from "./folders";
import { validatePublicHttpsUrl, type OutboundUrlCheck } from "./outbound-url";

const SPAM_FOLDER_ID = Folders.SPAM;

// ── Events ──────────────────────────────────────────────────────────

export const WEBHOOK_EVENT_TYPES = [
	"message.received",
	"message.sent",
	"message.delivery_failed",
	"message.bounced",
	"message.opened",
	"message.clicked",
	"deliverability.warning",
	"usage.budget_exceeded",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const WEBHOOK_EVENT_LABELS: Record<WebhookEventType, { label: string; hint: string }> = {
	"message.received": { label: "Message received", hint: "Inbound mail was stored in a mailbox." },
	"message.sent": { label: "Message sent", hint: "Email Service accepted an outgoing message." },
	"message.delivery_failed": {
		label: "Delivery failed",
		hint: "The send was refused or failed before reaching the recipient's server.",
	},
	"message.bounced": { label: "Bounced", hint: "The recipient's server permanently rejected it." },
	"message.opened": { label: "Opened", hint: "The tracking pixel was loaded." },
	"message.clicked": { label: "Link clicked", hint: "A tracked link was followed." },
	"deliverability.warning": {
		label: "Deliverability warning",
		hint: "A sending domain's spam complaint rate crossed 0.1%, or bulk sending was paused at 0.3%.",
	},
	"usage.budget_exceeded": {
		label: "Budget exceeded",
		hint: "Projected Workers AI or Email Service cost for the month passed the admin's budget. Once per month per kind.",
	},
};

export function isWebhookEventType(value: unknown): value is WebhookEventType {
	return typeof value === "string" && (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Which webhook event a delivery-ledger row becomes, or null for none.
 *
 * `rejected` (suppressed recipient) and `failed` (our send threw, or the
 * provider gave up) are both "it never arrived", which is the question a
 * backend reacting to this wants answered. `soft_bounced` is deliberately not
 * mapped: it is a retry in progress, not an outcome.
 */
export function webhookTypeForLedgerEvent(eventType: string): WebhookEventType | null {
	switch (eventType) {
		case "sent":
			return "message.sent";
		case "failed":
		case "rejected":
			return "message.delivery_failed";
		case "bounced":
			return "message.bounced";
		case "opened":
			return "message.opened";
		case "clicked":
			return "message.clicked";
		default:
			return null;
	}
}

// ── Payload ─────────────────────────────────────────────────────────

/** The message a webhook is about. Never carries the body, only a snippet. */
export interface WebhookEmailSummary {
	id: string;
	thread_id: string | null;
	from: string | null;
	/** Display name from the `From:` header, or null when it had none. */
	from_name: string | null;
	to: string[];
	cc: string[];
	subject: string;
	snippet: string;
	has_attachments: boolean;
	labels: string[];
	folder: string;
	/** True when the message sits in Spam, so a receiver can ignore it. */
	spam: boolean;
}

/** Extra facts about the event itself (who bounced, which link was clicked). */
export interface WebhookEventDetail {
	recipient?: string | null;
	reason?: string | null;
	cause?: string | null;
	url?: string | null;
	source?: string | null;
}

export interface WebhookPayload {
	id: string;
	type: WebhookEventType;
	created_at: string;
	mailbox: string;
	/** Present and true only on deliveries sent from the "Send test" button. */
	test?: true;
	data: WebhookEmailSummary & { detail?: WebhookEventDetail };
}

/**
 * The plain-text preview: the stored `emails.snippet` (migration 26) when the
 * row has one, else the same derivation from the body, for a legacy row the
 * lazy backfill has not reached. Same function either way, so the two agree.
 */
export function webhookSnippet(stored: string | null | undefined, body: string | null | undefined): string {
	return stored ?? toPlainSnippet(body);
}

function splitAddresses(value: string | null | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((part) => part.trim().toLowerCase())
		.filter(Boolean);
}

export interface EmailSummaryRow {
	id: string;
	thread_id: string | null;
	sender: string | null;
	recipient: string | null;
	cc: string | null;
	subject: string | null;
	body: string | null;
	folder_id: string;
	/** Stored plain snippet; null on a legacy row not yet backfilled. */
	snippet?: string | null;
	sender_name?: string | null;
}

/** Build the summary from a stored row, its label names and attachment count. */
export function buildEmailSummary(
	row: EmailSummaryRow,
	labels: string[],
	attachmentCount: number,
): WebhookEmailSummary {
	return {
		id: row.id,
		thread_id: row.thread_id ?? null,
		from: row.sender ? row.sender.toLowerCase() : null,
		from_name: row.sender_name?.trim() || null,
		to: splitAddresses(row.recipient),
		cc: splitAddresses(row.cc),
		subject: row.subject ?? "",
		snippet: webhookSnippet(row.snippet, row.body),
		has_attachments: attachmentCount > 0,
		labels,
		folder: row.folder_id,
		spam: row.folder_id === SPAM_FOLDER_ID,
	};
}

export function buildWebhookPayload(input: {
	id: string;
	type: WebhookEventType;
	createdAt: string;
	mailbox: string;
	data: WebhookEmailSummary;
	detail?: WebhookEventDetail | null;
	test?: boolean;
}): WebhookPayload {
	const detail = input.detail
		? Object.fromEntries(Object.entries(input.detail).filter(([, v]) => v != null && v !== ""))
		: null;
	return {
		id: input.id,
		type: input.type,
		created_at: input.createdAt,
		mailbox: input.mailbox,
		...(input.test ? { test: true as const } : {}),
		data: {
			...input.data,
			...(detail && Object.keys(detail).length > 0 ? { detail } : {}),
		},
	};
}

/** A plausible message for the "Send test" button. */
export function sampleEmailSummary(mailbox: string): WebhookEmailSummary {
	return {
		id: "test_00000000-0000-0000-0000-000000000000",
		thread_id: "test_thread",
		from: "sender@example.com",
		from_name: "Example Sender",
		to: [mailbox],
		cc: [],
		subject: "Test delivery from cloudmail",
		snippet: "This is a test webhook. If your endpoint verified the signature, it is set up correctly.",
		has_attachments: false,
		labels: [],
		folder: "inbox",
		spam: false,
	};
}

// ── Signing ─────────────────────────────────────────────────────────

export const SIGNATURE_VERSION = "v1";

/** How far a receiver should let `X-Tapetide-Timestamp` drift, in seconds. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

function toHex(bytes: ArrayBuffer): string {
	return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/**
 * `v1=<hex hmac-sha256(secret, "${timestamp}.${body}")>`.
 *
 * The timestamp is inside the MAC so a captured request cannot be replayed with
 * a fresh header: the receiver checks it is recent, and changing it breaks the
 * signature.
 */
export async function signWebhook(secret: string, timestamp: number, body: string): Promise<string> {
	return `${SIGNATURE_VERSION}=${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * Reference verifier, the same check the docs ask receivers to implement.
 * Accepts a header carrying several comma-separated signatures.
 */
export async function verifyWebhookSignature(input: {
	secret: string;
	timestamp: string | number;
	body: string;
	signatureHeader: string;
	nowSeconds?: number;
	toleranceSeconds?: number;
}): Promise<boolean> {
	const ts = Number(input.timestamp);
	if (!Number.isFinite(ts)) return false;
	const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
	if (Math.abs(now - ts) > (input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS)) return false;
	const expected = await signWebhook(input.secret, ts, input.body);
	return input.signatureHeader
		.split(",")
		.map((s) => s.trim())
		.some((candidate) => constantTimeEqual(candidate, expected));
}

/** `whsec_` + 32 random bytes as hex. The whole string is the HMAC key. */
export function generateWebhookSecret(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return `whsec_${toHex(bytes.buffer)}`;
}

// ── Retry schedule ──────────────────────────────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Waits after attempts 1..5. A sixth failure is final. */
export const WEBHOOK_RETRY_DELAYS_MS = [MINUTE, 5 * MINUTE, 30 * MINUTE, 2 * HOUR, 6 * HOUR] as const;
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;

/**
 * Milliseconds to wait after `attemptsMade` failed attempts, or null when the
 * delivery has used them all.
 */
export function webhookRetryDelayMs(attemptsMade: number): number | null {
	if (!Number.isInteger(attemptsMade) || attemptsMade < 1) return WEBHOOK_RETRY_DELAYS_MS[0];
	if (attemptsMade >= WEBHOOK_MAX_ATTEMPTS) return null;
	return WEBHOOK_RETRY_DELAYS_MS[attemptsMade - 1];
}

/**
 * Auto-disable after this many consecutive failed attempts, provided the
 * failures span at least {@link WEBHOOK_DISABLE_MIN_STREAK_MS}.
 *
 * Both conditions, so a busy endpoint that is down for ten minutes is not
 * switched off by the burst of failures a deploy produces, and a quiet one that
 * has been dead for a day is.
 */
export const WEBHOOK_DISABLE_AFTER_FAILURES = 20;
export const WEBHOOK_DISABLE_MIN_STREAK_MS = 12 * HOUR;

export function shouldAutoDisable(
	consecutiveFailures: number,
	failingSince: number | null,
	now: number,
): boolean {
	if (consecutiveFailures < WEBHOOK_DISABLE_AFTER_FAILURES) return false;
	if (failingSince === null) return false;
	return now - failingSince >= WEBHOOK_DISABLE_MIN_STREAK_MS;
}

// ── URL guard ───────────────────────────────────────────────────────

/**
 * The webhook destination check. The rules live in ./outbound-url.ts, shared
 * with the AI gateway guard; this wrapper keeps the webhook wording.
 */
export {
	ipv4Octets,
	ipv6Hextets,
	isPrivateIpv4,
	isPrivateIpv6,
	OUTBOUND_URL_MAX_LENGTH as WEBHOOK_URL_MAX_LENGTH,
	type OutboundUrlCheck as WebhookUrlCheck,
} from "./outbound-url";

export function validateWebhookUrl(raw: string): OutboundUrlCheck {
	return validatePublicHttpsUrl(raw, { purpose: "webhook" });
}
