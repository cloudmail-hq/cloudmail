/**
 * Provider event webhooks, PUBLIC (called by AWS SNS and by Resend's Svix,
 * which have no session):
 *
 *   POST /hooks/ses/:webhookId      SNS HTTPS subscription for the SES configuration set
 *   POST /hooks/resend/:webhookId   Resend webhook (Svix-signed)
 *
 * Mounted outside `/api` in `workers/app.ts`, before authentication: the
 * credential is the signature (SNS certificate chain, Svix HMAC), and the
 * random 128-bit `webhookId` only selects which domain's settings to check it
 * against. Neither request carries `Origin` or `Sec-Fetch-Site`, so the CSRF
 * guard lets them through.
 *
 * Every request is size-capped and rate limited per IP. Each provider event id
 * (SNS `MessageId`, `svix-id`) is processed once: a provider retry of an event
 * already stored answers 200 and writes nothing. If storing fails, the id is
 * forgotten and the answer is 500, so the provider retries.
 *
 * Events go into the sending mailbox's delivery ledger, joined on the
 * provider's message id (or, for a send whose answer was lost, the `cm_send`
 * tag). Permanent bounces and complaints become suppressions through
 * `../lib/suppressions.ts`. An event naming no message of ours records nothing
 * and still answers 200.
 */

import { Hono, type Context } from "hono";
import type { Env } from "../types";
import type { MailboxContext } from "../lib/mailbox";
import { domainRpc, aliasOwnerOf } from "./domains";
import { authSecret } from "../auth/config";
import { openResendWebhookSecret, type DomainSendingRecord } from "../lib/domain-sending-store";
import { handleComplaint, handleHardBounce } from "../lib/suppressions";
import { isAllowedSubscribeUrl, parseSnsMessage, verifySnsMessage } from "../lib/sns-verify";
import { verifySvix } from "../lib/svix-verify";
import type { ProviderEventInput } from "../durableObject/features";
import type { SendingLastEvent } from "../../shared/ses-sending";

/** SNS messages are at most 256 KB; Resend payloads are far smaller. */
export const MAX_WEBHOOK_BYTES = 256 * 1024;

type AppContext = Context<MailboxContext>;

interface WebhookRpc {
	getDomainSendingByWebhook(webhookId: string): Promise<DomainSendingRecord | null>;
	recordDomainSendingEvent(hostname: string, event: SendingLastEvent): Promise<void>;
	markSendingEventSeen(eventId: string, now: number): Promise<boolean>;
	forgetSendingEvent(eventId: string): Promise<void>;
	getOrInitMeta(key: string, fallback: string): Promise<string>;
}

interface EventStub {
	applyProviderEvents(events: ProviderEventInput[]): Promise<{ applied: number; matched: number; soleRecipients?: string[] }>;
}

/** Overridable in tests. */
export const sendingWebhookDeps = {
	now: () => Date.now(),
	/** GET of an SNS SubscribeURL (already checked against the topic's host). */
	fetchImpl: undefined as typeof fetch | undefined,
	rpc: (env: Env) => domainRpc(env) as unknown as WebhookRpc,
	mailboxStub: (env: Env, mailboxId: string): EventStub =>
		env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId)) as unknown as EventStub,
	isMailbox: async (env: Env, address: string) => !!(await env.BUCKET.head(`mailboxes/${address}.json`)),
	aliasOwner: (env: Env, address: string) => aliasOwnerOf(env, address),
	hardBounce: (env: Env, address: string, source: string) => handleHardBounce(env, { address, source }),
	complaint: (env: Env, address: string, fromAddress: string, source: string) =>
		handleComplaint(env, { address, fromAddress, source }),
};

// -- mapping (pure) ------------------------------------------------------------------

export interface MappedEvents {
	/** Bare From address of the message the events are about. */
	from: string | null;
	type: string;
	events: ProviderEventInput[];
	hardBounces: string[];
	complaints: string[];
	/**
	 * Suppress the message's recipient only if it had exactly one (To, Cc and
	 * Bcc together, read from the stored row). Used when the provider doesn't
	 * name the recipient (Resend).
	 */
	soleSuppression?: "hard_bounce" | "complaint";
}

/** `"Name" <a@b>` or `a@b` to `a@b`, lower case, or null. */
export function bareAddress(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const m = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value);
	const addr = (m ? m[1]! : value).trim().toLowerCase();
	return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(addr) ? addr : null;
}

function addresses(list: unknown, key?: string): string[] {
	if (!Array.isArray(list)) return [];
	const out: string[] = [];
	for (const item of list.slice(0, 100)) {
		const a = bareAddress(key ? (item as Record<string, unknown> | null)?.[key] : item);
		if (a) out.push(a);
	}
	return out;
}

function iso(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const t = Date.parse(value);
	return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function short(value: unknown, max = 300): string | null {
	return typeof value === "string" && value ? value.slice(0, max) : null;
}

/**
 * One SES event (the parsed SNS `Message`) as ledger events and suppressions
 * (SES research §7.4 and §7.5). Open, Click and Subscription are ignored:
 * cloudmail tracks engagement itself.
 */
export function mapSesEvent(event: Record<string, any>, snsMessageId: string): MappedEvents {
	const type = String(event.eventType ?? event.notificationType ?? "");
	const mail = (event.mail ?? {}) as Record<string, any>;
	const providerId = typeof mail.messageId === "string" ? mail.messageId : null;
	const tag = Array.isArray(mail.tags?.cm_send) ? String(mail.tags.cm_send[0] ?? "") : null;
	const from = bareAddress(mail.source);
	const out: MappedEvents = { from, type, events: [], hardBounces: [], complaints: [] };
	const base = (t: ProviderEventInput["type"], recipient: string | null, at?: string) => ({
		type: t,
		source: "ses" as const,
		providerId,
		sendTag: tag,
		recipient,
		occurredAt: at ?? iso(mail.timestamp),
		dedupeKey: `ses:${snsMessageId}:${t}:${recipient ?? "*"}`,
	});

	switch (type) {
		case "Send":
			out.events.push(base("sent", null, iso(mail.timestamp)));
			break;
		case "Delivery": {
			const d = event.delivery ?? {};
			for (const r of addresses(d.recipients)) {
				out.events.push({ ...base("delivered", r, iso(d.timestamp)), metadata: { smtpResponse: short(d.smtpResponse, 200) } });
			}
			break;
		}
		case "Bounce": {
			const b = event.bounce ?? {};
			const bounceType = String(b.bounceType ?? "");
			const permanent = bounceType === "Permanent";
			for (const item of Array.isArray(b.bouncedRecipients) ? b.bouncedRecipients.slice(0, 100) : []) {
				const r = bareAddress(item?.emailAddress);
				if (!r) continue;
				out.events.push({
					...base(permanent ? "bounced" : "soft_bounced", r, iso(b.timestamp)),
					errorCause: `${bounceType || "Undetermined"}/${String(b.bounceSubType ?? "")}`.slice(0, 80),
					errorDetail: short(item?.diagnosticCode) ?? `${bounceType} bounce (${String(b.bounceSubType ?? "")})`,
					metadata: { bounceType, bounceSubType: short(b.bounceSubType, 60) },
				});
				if (permanent) out.hardBounces.push(r);
			}
			break;
		}
		case "Complaint": {
			const c = event.complaint ?? {};
			if (c.complaintFeedbackType === "not-spam") break;
			const suppressedBySes = c.complaintSubType === "OnAccountSuppressionList" || c.complaintSubType === "OnTenantSuppressionList";
			for (const r of addresses(c.complainedRecipients, "emailAddress")) {
				out.events.push({
					...base(suppressedBySes ? "failed" : "complained", r, iso(c.timestamp)),
					errorCause: suppressedBySes ? "suppressed" : "complaint",
					errorDetail: suppressedBySes
						? "Not sent: the address is on the SES account suppression list after a complaint."
						: `Marked as spam${c.complaintFeedbackType ? ` (${String(c.complaintFeedbackType).slice(0, 40)})` : ""}.`,
				});
				out.complaints.push(r);
			}
			break;
		}
		case "Reject":
			out.events.push({
				...base("failed", null),
				errorCause: "rejected",
				errorDetail: `Amazon SES rejected the message after accepting it (${short(event.reject?.reason, 100) ?? "Bad content"}).`,
			});
			break;
		case "Rendering Failure":
			out.events.push({ ...base("failed", null), errorCause: "rendering", errorDetail: short(event.failure?.errorMessage) });
			break;
		case "DeliveryDelay": {
			const d = event.deliveryDelay ?? {};
			for (const r of addresses(d.delayedRecipients, "emailAddress")) {
				out.events.push({
					...base("soft_bounced", r, iso(d.timestamp)),
					errorCause: `delayed/${String(d.delayType ?? "")}`.slice(0, 80),
					errorDetail: `Delivery delayed (${String(d.delayType ?? "unknown")}).`,
				});
			}
			break;
		}
		default:
			break;
	}
	return out;
}

/** `tags` as `{name: value}` or `[{name, value}]`. */
function resendTag(tags: unknown, name: string): string | null {
	if (Array.isArray(tags)) {
		const hit = tags.find((t) => t && typeof t === "object" && (t as { name?: unknown }).name === name);
		return hit && typeof (hit as { value?: unknown }).value === "string" ? (hit as { value: string }).value : null;
	}
	if (tags && typeof tags === "object") {
		const v = (tags as Record<string, unknown>)[name];
		return typeof v === "string" ? v : null;
	}
	return null;
}

/**
 * One Resend webhook payload as ledger events and suppressions (Resend
 * research, Decision 8).
 *
 * Resend's bounce, complaint and suppression payloads don't say which
 * recipient they are about, and `data.to` omits Cc and Bcc. So those events
 * are recorded once for the whole message (no recipient), and the suppression
 * is requested as `soleSuppression`: it is applied only when the stored
 * message had exactly one recipient across To, Cc and Bcc. Guessing from
 * `data.to` could suppress an innocent To recipient for a Cc's bounce.
 */
export function mapResendEvent(payload: Record<string, any>, svixId: string): MappedEvents {
	const type = String(payload.type ?? "");
	const data = (payload.data ?? {}) as Record<string, any>;
	const providerId = typeof data.email_id === "string" ? data.email_id : null;
	const tag = resendTag(data.tags, "cm_send");
	const from = bareAddress(data.from);
	const to = addresses(data.to);
	const at = iso(payload.created_at) ?? iso(data.created_at);
	const messageIdHeader = typeof data.message_id === "string" ? data.message_id : null;
	const out: MappedEvents = { from, type, events: [], hardBounces: [], complaints: [] };
	const ev = (t: ProviderEventInput["type"], recipient: string | null, extra: Partial<ProviderEventInput> = {}) =>
		out.events.push({
			type: t,
			source: "resend",
			providerId,
			sendTag: tag,
			messageIdHeader,
			recipient,
			occurredAt: at,
			dedupeKey: `resend:${svixId}:${t}:${recipient ?? "*"}`,
			...extra,
		});
	const each = (t: ProviderEventInput["type"], extra: Partial<ProviderEventInput> = {}) => {
		if (to.length === 0) ev(t, null, extra);
		for (const r of to) ev(t, r, extra);
	};

	switch (type) {
		case "email.sent":
			ev("sent", null);
			break;
		case "email.delivered":
			each("delivered");
			break;
		case "email.delivery_delayed":
			each("soft_bounced", { errorCause: "delayed", errorDetail: "Delivery delayed." });
			break;
		case "email.bounced": {
			const b = data.bounce ?? {};
			const permanent = b.type === "Permanent";
			ev(permanent ? "bounced" : "soft_bounced", null, {
				errorCause: `${String(b.type ?? "Undetermined")}/${String(b.subType ?? "")}`.slice(0, 80),
				errorDetail: short(b.diagnosticCode) ?? short(b.message),
			});
			if (permanent) out.soleSuppression = "hard_bounce";
			break;
		}
		case "email.complained":
			ev("complained", null, { errorCause: "complaint", errorDetail: "Marked as spam." });
			out.soleSuppression = "complaint";
			break;
		case "email.failed":
			ev("failed", null, { errorCause: "failed", errorDetail: short(data.failed?.reason) ?? "Resend couldn't send the message." });
			break;
		case "email.suppressed":
			ev("rejected", null, {
				errorCause: "suppressed",
				errorDetail: `Resend didn't send to a suppressed address${data.suppressed?.type ? ` (${String(data.suppressed.type).slice(0, 40)})` : ""}.`,
			});
			out.soleSuppression = "hard_bounce";
			break;
		default:
			// email.opened / email.clicked / email.scheduled: cloudmail tracks itself.
			break;
	}
	return out;
}

// -- shared handling -------------------------------------------------------------------

async function readCapped(c: AppContext): Promise<string | null> {
	const declared = Number(c.req.header("content-length") ?? 0);
	if (declared > MAX_WEBHOOK_BYTES) return null;
	const buf = await c.req.arrayBuffer();
	if (buf.byteLength > MAX_WEBHOOK_BYTES) return null;
	return new TextDecoder().decode(buf);
}

async function rateLimited(c: AppContext): Promise<boolean> {
	const limiter = (c.env as { API_RATE_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> } })
		.API_RATE_LIMITER;
	if (!limiter) return false;
	try {
		const { success } = await limiter.limit({ key: `hooks:${c.req.header("cf-connecting-ip") ?? "unknown"}` });
		return !success;
	} catch {
		return false;
	}
}

/**
 * File mapped events into the sending mailbox and apply suppressions. Only
 * events whose From is on this webhook's domain are used: one topic may carry
 * several domains' events.
 */
async function applyMapped(env: Env, rec: DomainSendingRecord, mapped: MappedEvents, source: string): Promise<number> {
	if (!mapped.from) return 0;
	// The message's own sending domain must be the one this webhook belongs to:
	// the transport is chosen by the exact From domain, so a subdomain's mail
	// arrives on the subdomain's own webhook, never on the parent's.
	const fromDomain = mapped.from.slice(mapped.from.lastIndexOf("@") + 1);
	if (fromDomain !== rec.hostname.toLowerCase()) return 0;
	const owner = (await sendingWebhookDeps.aliasOwner(env, mapped.from)) ?? mapped.from;
	let applied = 0;
	let sole: string[] = [];
	if (mapped.events.length && (await sendingWebhookDeps.isMailbox(env, owner))) {
		const res = await sendingWebhookDeps.mailboxStub(env, owner).applyProviderEvents(mapped.events);
		applied = res.applied;
		sole = res.soleRecipients ?? [];
	}
	const hard = [...mapped.hardBounces, ...(mapped.soleSuppression === "hard_bounce" ? sole : [])];
	const complaints = [...mapped.complaints, ...(mapped.soleSuppression === "complaint" ? sole : [])];
	for (const address of new Set(hard)) await sendingWebhookDeps.hardBounce(env, address, `${source}:bounce`);
	for (const address of new Set(complaints)) await sendingWebhookDeps.complaint(env, address, mapped.from, `${source}:complaint`);
	return applied;
}

async function noteEvent(rpc: WebhookRpc, hostname: string, event: SendingLastEvent): Promise<void> {
	try {
		await rpc.recordDomainSendingEvent(hostname, event);
	} catch (e) {
		console.error("Could not record the last sending event:", (e as Error).message);
	}
}

// -- routes --------------------------------------------------------------------------

export const sendingWebhookRoutes = new Hono<MailboxContext>();

sendingWebhookRoutes.post("/hooks/ses/:webhookId", async (c) => {
	if (await rateLimited(c)) return c.text("Too many requests", 429);
	const body = await readCapped(c);
	if (body === null) return c.text("Payload too large", 413);
	const rpc = sendingWebhookDeps.rpc(c.env);
	const rec = await rpc.getDomainSendingByWebhook(c.req.param("webhookId"));
	if (!rec || !rec.snsTopicArn) return c.text("Not found", 404);
	const msg = parseSnsMessage(body);
	if (!msg) return c.text("Not an SNS message", 400);
	// The stored ARN first: it pins the region the certificate host must be in.
	if (msg.TopicArn !== rec.snsTopicArn) return c.text("Unknown topic", 403);
	const verdict = await verifySnsMessage(msg);
	if (!verdict.ok) {
		console.warn(`SNS message for ${rec.hostname} refused: ${verdict.reason}`);
		return c.text("Invalid signature", 403);
	}
	const eventKey = `sns:${msg.MessageId}`;
	const now = sendingWebhookDeps.now();
	if (!(await rpc.markSendingEventSeen(eventKey, now))) return c.text("OK (duplicate)", 200);

	try {
		if (msg.Type === "SubscriptionConfirmation") {
			// Only after the signature passed, and only to the topic's own SNS host.
			if (!msg.SubscribeURL || !isAllowedSubscribeUrl(msg.SubscribeURL, msg.TopicArn)) {
				await noteEvent(rpc, rec.hostname, { type: "SubscriptionConfirmation", at: now, subscription: "confirm_failed" });
				return c.text("SubscribeURL not allowed", 400);
			}
			const res = await (sendingWebhookDeps.fetchImpl ?? fetch)(msg.SubscribeURL, {
				method: "GET",
				redirect: "error",
				signal: AbortSignal.timeout(5000),
			});
			if (!res.ok) throw new Error(`ConfirmSubscription answered ${res.status}`);
			await noteEvent(rpc, rec.hostname, { type: "SubscriptionConfirmation", at: now, subscription: "confirmed" });
			return c.text("Subscribed", 200);
		}
		if (msg.Type === "UnsubscribeConfirmation") {
			await noteEvent(rpc, rec.hostname, { type: "UnsubscribeConfirmation", at: now, subscription: "unsubscribed" });
			return c.text("OK", 200);
		}
		let event: Record<string, any>;
		try {
			event = JSON.parse(msg.Message) as Record<string, any>;
		} catch {
			return c.text("OK (not an SES event)", 200);
		}
		const mapped = mapSesEvent(event, msg.MessageId);
		await applyMapped(c.env, rec, mapped, "ses");
		if (mapped.type) await noteEvent(rpc, rec.hostname, { type: mapped.type.slice(0, 40), at: now });
		return c.text("OK", 200);
	} catch (e) {
		// Let SNS retry: forget the id so the retry is processed.
		console.error(`SES event for ${rec.hostname} failed:`, (e as Error).message);
		await rpc.forgetSendingEvent(eventKey).catch(() => {});
		return c.text("Error", 500);
	}
});

sendingWebhookRoutes.post("/hooks/resend/:webhookId", async (c) => {
	if (await rateLimited(c)) return c.text("Too many requests", 429);
	const body = await readCapped(c);
	if (body === null) return c.text("Payload too large", 413);
	const rpc = sendingWebhookDeps.rpc(c.env);
	const rec = await rpc.getDomainSendingByWebhook(c.req.param("webhookId"));
	if (!rec || !rec.resendWebhookSecretEnc) return c.text("Not found", 404);
	let secret: string;
	try {
		secret = await openResendWebhookSecret(rec.resendWebhookSecretEnc, await authSecret(c.env, rpc), rec.hostname);
	} catch {
		console.error(`Resend webhook secret for ${rec.hostname} can't be read (AUTH_SECRET changed?)`);
		return c.text("Webhook not configured", 503);
	}
	const headers = {
		id: c.req.header("svix-id") ?? null,
		timestamp: c.req.header("svix-timestamp") ?? null,
		signature: c.req.header("svix-signature") ?? null,
	};
	const now = sendingWebhookDeps.now();
	const verdict = await verifySvix(secret, headers, body, now);
	if (!verdict.ok) {
		console.warn(`Resend webhook for ${rec.hostname} refused: ${verdict.reason}`);
		return c.text("Invalid signature", 401);
	}
	let payload: Record<string, any>;
	try {
		payload = JSON.parse(body) as Record<string, any>;
	} catch {
		return c.text("Bad JSON", 400);
	}
	const eventKey = `svix:${headers.id}`;
	if (!(await rpc.markSendingEventSeen(eventKey, now))) return c.text("OK (duplicate)", 200);
	try {
		const mapped = mapResendEvent(payload, headers.id!);
		await applyMapped(c.env, rec, mapped, "resend");
		if (mapped.type) await noteEvent(rpc, rec.hostname, { type: mapped.type.slice(0, 40), at: now });
		return c.text("OK", 200);
	} catch (e) {
		console.error(`Resend event for ${rec.hostname} failed:`, (e as Error).message);
		await rpc.forgetSendingEvent(eventKey).catch(() => {});
		return c.text("Error", 500);
	}
});
