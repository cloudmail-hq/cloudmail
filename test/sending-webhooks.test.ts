/**
 * Provider event webhooks and the ledger they feed.
 *
 * - SNS signature verification (v1 SHA1, v2 SHA256) against a local RSA key
 *   and self-signed certificate served through the `snsVerifyDeps` test hook;
 *   tampering, a foreign certificate host, a foreign topic, SubscribeURL host
 *   checks, duplicate MessageIds.
 * - Svix verification for Resend: valid, tampered, stale timestamp, several
 *   signatures.
 * - Event mapping (bounce types, complaints, not-spam, reject, Resend events).
 * - `applyProviderEvents` on a real migrated mailbox database: join on the
 *   provider id, the `cm_send` tag settling an unconfirmed send, out-of-order
 *   and duplicate events, unknown ids, breaker counts.
 * - The SES threading fallback on the local part of an amazonses.com id.
 */

import { createHmac, createSign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, mailboxMigrations } from "../workers/durableObject/migrations";
import {
	applyProviderEvents,
	findThreadByProviderLocalPart,
	recordDelivery,
	type ProviderEventInput,
} from "../workers/durableObject/features";
import { findThreadByMessageIds } from "../workers/durableObject/references";
import { getSendingStats } from "../workers/durableObject/analytics";
import {
	clearSnsCertCache,
	isAllowedCertUrl,
	isAllowedSubscribeUrl,
	snsStringToSign,
	snsVerifyDeps,
	verifySnsMessage,
	type SnsMessage,
} from "../workers/lib/sns-verify";
import { verifySvix } from "../workers/lib/svix-verify";
import { mapResendEvent, mapSesEvent, sendingWebhookDeps, sendingWebhookRoutes } from "../workers/routes/sending-webhooks";
import { sealResendWebhookSecret, type DomainSendingRecord } from "../workers/lib/domain-sending-store";
import { OTHER_CERT, OTHER_KEY, TRUSTED_CERT, TRUSTED_KEY } from "./fixtures/sns/test-certs";
import type { MailboxContext } from "../workers/lib/mailbox";
import type { Env } from "../workers/types";

const TOPIC = "arn:aws:sns:us-east-1:123456789012:cloudmail";
const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0123456789abcdef.pem";
const NOW = Date.UTC(2026, 10, 8, 12);

function signSns(msg: Omit<SnsMessage, "Signature">, key = TRUSTED_KEY): SnsMessage {
	const algorithm = msg.SignatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256";
	const unsigned = { ...msg, Signature: "" } as SnsMessage;
	const signature = createSign(algorithm).update(snsStringToSign(unsigned), "utf8").sign(key, "base64");
	return { ...unsigned, Signature: signature };
}

function notification(message: unknown, extra: Partial<SnsMessage> = {}): SnsMessage {
	return signSns({
		Type: "Notification",
		MessageId: extra.MessageId ?? "11111111-2222-3333-4444-555555555555",
		TopicArn: TOPIC,
		Message: typeof message === "string" ? message : JSON.stringify(message),
		Timestamp: "2026-11-08T12:00:00.000Z",
		SignatureVersion: extra.SignatureVersion ?? "2",
		SigningCertURL: extra.SigningCertURL ?? CERT_URL,
		...(extra.Subject !== undefined ? { Subject: extra.Subject } : {}),
	});
}

let certFetches: string[];
beforeEach(() => {
	clearSnsCertCache();
	certFetches = [];
	snsVerifyDeps.now = () => NOW;
	snsVerifyDeps.fetchCert = async (url) => {
		certFetches.push(url);
		return url.includes("attacker") ? OTHER_CERT : TRUSTED_CERT;
	};
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// -- SNS verification ------------------------------------------------------------------

describe("SNS signature verification", () => {
	it("accepts SignatureVersion 2 (SHA256) and 1 (SHA1), with and without Subject", async () => {
		expect(await verifySnsMessage(notification({ a: 1 }))).toEqual({ ok: true });
		expect(await verifySnsMessage(notification({ a: 1 }, { SignatureVersion: "1" }))).toEqual({ ok: true });
		expect(await verifySnsMessage(notification({ a: 1 }, { Subject: "Amazon SES Email Event Notification" }))).toEqual({ ok: true });
	});

	it("builds the exact string to sign", () => {
		const m = { Type: "Notification", MessageId: "m", TopicArn: "t", Message: "x", Timestamp: "ts", SignatureVersion: "2", Signature: "", SigningCertURL: "" };
		expect(snsStringToSign(m)).toBe("Message\nx\nMessageId\nm\nTimestamp\nts\nTopicArn\nt\nType\nNotification\n");
		const c = { ...m, Type: "SubscriptionConfirmation", SubscribeURL: "u", Token: "k" };
		expect(snsStringToSign(c)).toBe(
			"Message\nx\nMessageId\nm\nSubscribeURL\nu\nTimestamp\nts\nToken\nk\nTopicArn\nt\nType\nSubscriptionConfirmation\n",
		);
	});

	it("refuses a tampered message, a foreign key and an unknown SignatureVersion", async () => {
		const good = notification({ eventType: "Bounce" });
		expect(await verifySnsMessage({ ...good, Message: good.Message.replace("Bounce", "Delivery") })).toMatchObject({ ok: false, reason: "bad signature" });
		expect(await verifySnsMessage({ ...good, TopicArn: "arn:aws:sns:us-east-1:123456789012:other" })).toMatchObject({ ok: false });
		expect(await verifySnsMessage(signSns({ ...good, Signature: undefined } as never, OTHER_KEY))).toMatchObject({ ok: false, reason: "bad signature" });
		expect(await verifySnsMessage({ ...good, SignatureVersion: "3" })).toMatchObject({ ok: false, reason: "unsupported SignatureVersion" });
	});

	it("pins the certificate URL to sns.<topic region>.amazonaws.com over https and never fetches anything else", async () => {
		for (const url of [
			"http://sns.us-east-1.amazonaws.com/SimpleNotificationService-0123.pem",
			"https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-0123.pem",
			"https://sns.us-east-1.amazonaws.com.attacker.example/SimpleNotificationService-0123.pem",
			"https://attacker.example/SimpleNotificationService-0123.pem",
			"https://sns.us-east-1.amazonaws.com:8443/SimpleNotificationService-0123.pem",
			"https://user@sns.us-east-1.amazonaws.com/SimpleNotificationService-0123.pem",
			"https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0123.pem?x=1",
			"https://sns.us-east-1.amazonaws.com/other/SimpleNotificationService-0123.pem",
			"https://sns.us-east-1.amazonaws.com/SimpleNotificationService-XYZ.pem",
		]) {
			expect(isAllowedCertUrl(url, TOPIC), url).toBe(false);
			expect(await verifySnsMessage(notification({}, { SigningCertURL: url }))).toMatchObject({ ok: false, reason: "certificate URL not allowed" });
		}
		expect(certFetches).toEqual([]);
		expect(isAllowedCertUrl(CERT_URL, TOPIC)).toBe(true);
	});

	it("caches certificates by URL", async () => {
		await verifySnsMessage(notification({ a: 1 }));
		await verifySnsMessage(notification({ a: 2 }, { MessageId: "other" }));
		expect(certFetches).toEqual([CERT_URL]);
	});

	it("refuses a certificate outside its validity period", async () => {
		snsVerifyDeps.now = () => Date.UTC(2200, 0, 1);
		expect(await verifySnsMessage(notification({}))).toMatchObject({ ok: false, reason: "certificate outside its validity period" });
	});

	it("allows a SubscribeURL only on the topic's SNS host with the confirm action", () => {
		const ok = `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC)}&Token=abc`;
		expect(isAllowedSubscribeUrl(ok, TOPIC)).toBe(true);
		for (const bad of [
			ok.replace("https://", "http://"),
			ok.replace("sns.us-east-1", "sns.eu-west-1"),
			ok.replace("sns.us-east-1.amazonaws.com", "169.254.169.254"),
			ok.replace("sns.us-east-1.amazonaws.com", "sns.us-east-1.amazonaws.com.evil.example"),
			ok.replace("ConfirmSubscription", "Publish"),
			`${ok}&Extra=1`,
			ok.replace("/?", "/x?"),
			ok.replace(encodeURIComponent(TOPIC), "other"),
		]) {
			expect(isAllowedSubscribeUrl(bad, TOPIC), bad).toBe(false);
		}
	});
});

// -- Svix ----------------------------------------------------------------------------------

const WHSEC = `whsec_${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")}`;
function svixSign(id: string, ts: string, body: string, secret = WHSEC) {
	const key = Buffer.from(secret.slice("whsec_".length), "base64");
	return `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`;
}

describe("Svix verification (Resend)", () => {
	const body = JSON.stringify({ type: "email.delivered", data: { email_id: "e1" } });
	const ts = String(Math.floor(NOW / 1000));
	it("accepts a valid signature, including one among several", async () => {
		expect(await verifySvix(WHSEC, { id: "msg_1", timestamp: ts, signature: svixSign("msg_1", ts, body) }, body, NOW)).toEqual({ ok: true });
		const other = svixSign("msg_1", ts, body, `whsec_${Buffer.from("another-secret-another-secret-00").toString("base64")}`);
		expect(
			await verifySvix(WHSEC, { id: "msg_1", timestamp: ts, signature: `v1g,abc ${other} ${svixSign("msg_1", ts, body)}` }, body, NOW),
		).toEqual({ ok: true });
	});

	it("finds the signature when a proxy joined repeated headers with ', '", async () => {
		const other = svixSign("msg_1", ts, body, `whsec_${Buffer.from("another-secret-another-secret-00").toString("base64")}`);
		const good = svixSign("msg_1", ts, body);
		for (const header of [`${other}, ${good}`, `${other},${good}`, `${good}`]) {
			expect(await verifySvix(WHSEC, { id: "msg_1", timestamp: ts, signature: header }, body, NOW), header).toEqual({ ok: true });
		}
		expect(await verifySvix(WHSEC, { id: "msg_1", timestamp: ts, signature: `${other}, v2,${good.slice(3)}` }, body, NOW)).toMatchObject({ ok: false });
	});

	it("refuses a tampered body, a wrong id, a stale or future timestamp, and missing headers", async () => {
		const sig = svixSign("msg_1", ts, body);
		expect(await verifySvix(WHSEC, { id: "msg_1", timestamp: ts, signature: sig }, body.replace("delivered", "bounced"), NOW)).toMatchObject({ ok: false });
		expect(await verifySvix(WHSEC, { id: "msg_2", timestamp: ts, signature: sig }, body, NOW)).toMatchObject({ ok: false });
		const old = String(Math.floor(NOW / 1000) - 301);
		expect(await verifySvix(WHSEC, { id: "msg_1", timestamp: old, signature: svixSign("msg_1", old, body) }, body, NOW)).toMatchObject({
			ok: false,
			reason: "timestamp outside tolerance",
		});
		const future = String(Math.floor(NOW / 1000) + 301);
		expect(await verifySvix(WHSEC, { id: "msg_1", timestamp: future, signature: svixSign("msg_1", future, body) }, body, NOW)).toMatchObject({ ok: false });
		expect(await verifySvix(WHSEC, { id: null, timestamp: ts, signature: sig }, body, NOW)).toMatchObject({ ok: false });
	});
});

// -- mapping ---------------------------------------------------------------------------------

const MAIL = {
	messageId: "0100sesid-000000",
	source: "Support <support@ses.example>",
	timestamp: "2026-11-08T11:59:00.000Z",
	tags: { cm_send: ["row-1"], "ses:configuration-set": ["cloudmail"] },
};

describe("SES event mapping", () => {
	it("a Permanent bounce suppresses; Transient and Undetermined only record", () => {
		const perm = mapSesEvent(
			{ eventType: "Bounce", mail: MAIL, bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "Gone@X.example", diagnosticCode: "550 5.1.1 no such user" }] } },
			"sns-1",
		);
		expect(perm.hardBounces).toEqual(["gone@x.example"]);
		expect(perm.events[0]).toMatchObject({ type: "bounced", recipient: "gone@x.example", providerId: "0100sesid-000000", sendTag: "row-1", errorDetail: "550 5.1.1 no such user", dedupeKey: "ses:sns-1:bounced:gone@x.example" });
		for (const t of ["Transient", "Undetermined"]) {
			const m = mapSesEvent({ eventType: "Bounce", mail: MAIL, bounce: { bounceType: t, bounceSubType: "MailboxFull", bouncedRecipients: [{ emailAddress: "a@x.example" }] } }, "sns-2");
			expect(m.hardBounces).toEqual([]);
			expect(m.events[0]).toMatchObject({ type: "soft_bounced" });
		}
	});

	it("a complaint suppresses unless it is not-spam; an account-suppressed complaint is a failure", () => {
		const c = mapSesEvent({ eventType: "Complaint", mail: MAIL, complaint: { complaintFeedbackType: "abuse", complainedRecipients: [{ emailAddress: "a@x.example" }] } }, "sns-3");
		expect(c.complaints).toEqual(["a@x.example"]);
		expect(c.events[0]).toMatchObject({ type: "complained" });
		const ns = mapSesEvent({ eventType: "Complaint", mail: MAIL, complaint: { complaintFeedbackType: "not-spam", complainedRecipients: [{ emailAddress: "a@x.example" }] } }, "sns-4");
		expect(ns).toMatchObject({ complaints: [], events: [] });
		const sup = mapSesEvent({ eventType: "Complaint", mail: MAIL, complaint: { complaintSubType: "OnAccountSuppressionList", complainedRecipients: [{ emailAddress: "a@x.example" }] } }, "sns-5");
		expect(sup.events[0]).toMatchObject({ type: "failed" });
	});

	it("maps Delivery, Send, Reject and DeliveryDelay; ignores Open and Click", () => {
		expect(mapSesEvent({ eventType: "Delivery", mail: MAIL, delivery: { recipients: ["a@x.example", "b@x.example"], timestamp: "2026-11-08T12:00:01Z" } }, "s").events.map((e) => [e.type, e.recipient])).toEqual([
			["delivered", "a@x.example"],
			["delivered", "b@x.example"],
		]);
		expect(mapSesEvent({ eventType: "Send", mail: MAIL, send: {} }, "s").events[0]).toMatchObject({ type: "sent" });
		expect(mapSesEvent({ eventType: "Reject", mail: MAIL, reject: { reason: "Bad content" } }, "s").events[0]).toMatchObject({ type: "failed", errorCause: "rejected" });
		expect(mapSesEvent({ eventType: "DeliveryDelay", mail: MAIL, deliveryDelay: { delayType: "MailboxFull", delayedRecipients: [{ emailAddress: "a@x.example" }] } }, "s").events[0]).toMatchObject({ type: "soft_bounced" });
		expect(mapSesEvent({ eventType: "Open", mail: MAIL }, "s").events).toEqual([]);
		expect(mapSesEvent({ eventType: "Click", mail: MAIL }, "s").events).toEqual([]);
	});
});

describe("Resend event mapping", () => {
	const data = { email_id: "re-1", from: "Support <support@ses.example>", to: ["a@x.example"], message_id: "<abc@resend.example>", tags: { cm_send: "row-1" } };
	it("maps every event type and suppresses only permanent bounces, complaints and suppressions", () => {
		const m = (type: string, extra: Record<string, unknown> = {}) => mapResendEvent({ type, created_at: "2026-11-08T12:00:00Z", data: { ...data, ...extra } }, "msg_1");
		expect(m("email.sent").events[0]).toMatchObject({ type: "sent", providerId: "re-1", messageIdHeader: "<abc@resend.example>", sendTag: "row-1" });
		expect(m("email.delivered").events[0]).toMatchObject({ type: "delivered", recipient: "a@x.example" });
		expect(m("email.delivery_delayed").events[0]).toMatchObject({ type: "soft_bounced" });
		// Bounce, complaint and suppression don't name a recipient: one message-level
		// event, and a suppression only if the stored row has a single recipient.
		expect(m("email.bounced", { bounce: { type: "Permanent", subType: "General" } })).toMatchObject({
			hardBounces: [],
			soleSuppression: "hard_bounce",
			events: [{ type: "bounced", recipient: null }],
		});
		expect(m("email.bounced", { bounce: { type: "Transient" } })).toMatchObject({ hardBounces: [], events: [{ type: "soft_bounced" }] });
		expect(m("email.bounced", { bounce: { type: "Transient" } }).soleSuppression).toBeUndefined();
		expect(m("email.complained")).toMatchObject({ complaints: [], soleSuppression: "complaint", events: [{ type: "complained", recipient: null }] });
		expect(m("email.failed", { failed: { reason: "reached_daily_quota" } }).events[0]).toMatchObject({ type: "failed", errorDetail: "reached_daily_quota" });
		expect(m("email.suppressed", { suppressed: { type: "OnAccountSuppressionList" } })).toMatchObject({ soleSuppression: "hard_bounce", events: [{ type: "rejected" }] });
		expect(m("email.opened").events).toEqual([]);
		expect(m("email.clicked").events).toEqual([]);
	});

	it("a multi-recipient bounce is one message-level event, never one per To address", () => {
		const m = mapResendEvent({ type: "email.bounced", data: { ...data, to: ["a@x.example", "b@x.example"], bounce: { type: "Permanent" } } }, "msg_2");
		expect(m.hardBounces).toEqual([]);
		expect(m.events).toHaveLength(1);
		expect(m.events[0]!.recipient).toBeNull();
	});
});

// -- ledger on a real mailbox database ----------------------------------------------------------

function sqlStorage(db: DatabaseSync): DurableObjectState {
	const exec = (query: string, ...bindings: unknown[]) => {
		const trimmed = query.trim();
		if (/^(select|with)/i.test(trimmed) || /\bRETURNING\b/i.test(trimmed)) {
			const rows = db.prepare(trimmed).all(...(bindings as never[])) as Record<string, unknown>[];
			return { toArray: () => rows, rowsWritten: rows.length, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
		}
		if (bindings.length === 0) {
			db.exec(trimmed);
			return { toArray: () => [], rowsWritten: 0, one: () => undefined, [Symbol.iterator]: () => [][Symbol.iterator]() };
		}
		const info = db.prepare(trimmed).run(...(bindings as never[]));
		return { toArray: () => [], rowsWritten: Number(info.changes ?? 0), one: () => undefined, [Symbol.iterator]: () => [][Symbol.iterator]() };
	};
	return { storage: { sql: { exec }, transactionSync: <T>(fn: () => T) => fn() } } as unknown as DurableObjectState;
}

let db: DatabaseSync;
let ctx: DurableObjectState;

function seedSent(id: string, extra: Record<string, string | null> = {}) {
	const cols = {
		id,
		folder_id: "sent",
		subject: "Hello",
		sender: "support@ses.example",
		recipient: "a@x.example",
		date: "2026-11-08T11:58:00.000Z",
		body: "",
		thread_id: `thread-${id}`,
		delivery_status: "queued",
		...extra,
	};
	const keys = Object.keys(cols);
	db.prepare(`INSERT INTO emails (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...(Object.values(cols) as never[]));
}

const row = (id: string) =>
	db.prepare(`SELECT message_id, provider_message_id, delivery_status, delivery_error FROM emails WHERE id = ?`).get(id) as Record<string, string | null>;
const events = (id: string) =>
	db.prepare(`SELECT event_type, source, recipient FROM delivery_events WHERE email_id = ? ORDER BY id`).all(id) as Record<string, string>[];

describe("applyProviderEvents (ledger, real migrations)", () => {
	beforeEach(() => {
		db = new DatabaseSync(":memory:");
		ctx = sqlStorage(db);
		applyMigrations(ctx.storage.sql as unknown as SqlStorage, mailboxMigrations, ctx.storage as never);
	});

	it("migration 46 adds provider_message_id", () => {
		const cols = (db.prepare(`PRAGMA table_info(emails)`).all() as { name: string }[]).map((c) => c.name);
		expect(cols).toContain("provider_message_id");
		expect(mailboxMigrations.some((m) => m.name === "46_provider_message_id")).toBe(true);
	});

	it("an SES send stores the RFC id and the bare id; events join on the bare id", () => {
		seedSent("row-1");
		recordDelivery(ctx, "row-1", { providerMessageId: "0100sesid-000000@us-east-1.amazonses.com", providerId: "0100sesid-000000" });
		expect(row("row-1")).toMatchObject({ message_id: "0100sesid-000000@us-east-1.amazonses.com", provider_message_id: "0100sesid-000000", delivery_status: "sent" });
		const delivered = mapSesEvent({ eventType: "Delivery", mail: { ...MAIL, tags: {} }, delivery: { recipients: ["a@x.example"], timestamp: "2026-11-08T12:00:00Z" } }, "sns-d");
		expect(applyProviderEvents(ctx, delivered.events)).toEqual({ applied: 1, matched: 1, soleRecipients: ["a@x.example"] });
		expect(row("row-1").delivery_status).toBe("delivered");
	});

	it("duplicate events are a no-op and an older event can't move the status back", () => {
		seedSent("row-1", { provider_message_id: "0100sesid-000000", delivery_status: "sent" });
		const d = mapSesEvent({ eventType: "Delivery", mail: MAIL, delivery: { recipients: ["a@x.example"], timestamp: "2026-11-08T12:00:05Z" } }, "sns-d").events;
		const s = mapSesEvent({ eventType: "Send", mail: MAIL }, "sns-s").events;
		expect(applyProviderEvents(ctx, d).applied).toBe(1);
		expect(applyProviderEvents(ctx, d).applied).toBe(0);
		expect(applyProviderEvents(ctx, s).applied).toBe(1); // late Send
		expect(row("row-1").delivery_status).toBe("delivered");
		expect(events("row-1").map((e) => e.event_type)).toEqual(["delivered", "sent"]);
	});

	it("a later bounce wins over delivery, and complaints don't change the status", () => {
		seedSent("row-1", { provider_message_id: "0100sesid-000000", delivery_status: "sent" });
		applyProviderEvents(ctx, mapSesEvent({ eventType: "Delivery", mail: MAIL, delivery: { recipients: ["a@x.example"], timestamp: "2026-11-08T12:00:00Z" } }, "1").events);
		applyProviderEvents(ctx, mapSesEvent({ eventType: "Complaint", mail: MAIL, complaint: { complainedRecipients: [{ emailAddress: "a@x.example" }], timestamp: "2026-11-08T13:00:00Z" } }, "2").events);
		expect(row("row-1").delivery_status).toBe("delivered");
		applyProviderEvents(ctx, mapSesEvent({ eventType: "Bounce", mail: MAIL, bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "a@x.example" }], timestamp: "2026-11-08T14:00:00Z" } }, "3").events);
		expect(row("row-1").delivery_status).toBe("bounced");
	});

	it("an unconfirmed send is settled by the first event carrying its cm_send tag", () => {
		seedSent("row-1");
		recordDelivery(ctx, "row-1", { error: "Amazon SES didn't confirm this message (E_SES_UNCONFIRMED)", unconfirmed: true });
		expect(row("row-1")).toMatchObject({ delivery_status: "queued", provider_message_id: null });
		expect(row("row-1").delivery_error).toMatch(/E_SES_UNCONFIRMED/);
		// Send event: fills the provider id, status sent.
		applyProviderEvents(ctx, mapSesEvent({ eventType: "Send", mail: MAIL }, "sns-s").events);
		expect(row("row-1")).toMatchObject({ provider_message_id: "0100sesid-000000", delivery_status: "sent", delivery_error: null });
		// Delivery joins on the id now.
		applyProviderEvents(ctx, mapSesEvent({ eventType: "Delivery", mail: { ...MAIL, tags: {} }, delivery: { recipients: ["a@x.example"] } }, "sns-d").events);
		expect(row("row-1").delivery_status).toBe("delivered");
	});

	it("an unconfirmed send can be settled straight to delivered or bounced", () => {
		seedSent("row-2");
		recordDelivery(ctx, "row-2", { error: "x", unconfirmed: true });
		applyProviderEvents(ctx, mapSesEvent({ eventType: "Bounce", mail: { ...MAIL, messageId: "id-2", tags: { cm_send: ["row-2"] } }, bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "a@x.example" }] } }, "b").events);
		expect(row("row-2")).toMatchObject({ provider_message_id: "id-2", delivery_status: "bounced" });
	});

	it("an event naming no message of ours records nothing; a tag can't claim an inbound row or another send", () => {
		seedSent("in-1", { folder_id: "inbox", delivery_status: null });
		seedSent("row-3", { provider_message_id: "already-joined" });
		const unknown = mapSesEvent({ eventType: "Delivery", mail: { ...MAIL, messageId: "nope", tags: { cm_send: ["in-1"] } }, delivery: { recipients: ["a@x.example"] } }, "u").events;
		expect(applyProviderEvents(ctx, unknown)).toEqual({ applied: 0, matched: 0, soleRecipients: [] });
		const other = mapSesEvent({ eventType: "Delivery", mail: { ...MAIL, messageId: "different", tags: { cm_send: ["row-3"] } }, delivery: { recipients: ["a@x.example"] } }, "o").events;
		expect(applyProviderEvents(ctx, other)).toEqual({ applied: 0, matched: 0, soleRecipients: [] });
		expect(events("in-1")).toEqual([]);
	});

	it("Resend email.sent replaces message_id with the RFC header so replies thread", () => {
		seedSent("row-4");
		recordDelivery(ctx, "row-4", { providerMessageId: "re-uuid-1", providerId: "re-uuid-1" });
		const sent = mapResendEvent({ type: "email.sent", data: { email_id: "re-uuid-1", from: "support@ses.example", to: ["a@x.example"], message_id: "<rfc-1@resend.example>" } }, "msg_1");
		applyProviderEvents(ctx, sent.events);
		expect(row("row-4")).toMatchObject({ message_id: "rfc-1@resend.example", provider_message_id: "re-uuid-1" });
		expect(findThreadByMessageIds(ctx, ["rfc-1@resend.example"])).toBe("thread-row-4");
	});

	it("reports the sole recipient across To, Cc and Bcc, and none when there are several", () => {
		seedSent("one", { provider_message_id: "p-one", recipient: "a@x.example" });
		seedSent("two", { provider_message_id: "p-two", recipient: "a@x.example", cc: "b@x.example" });
		const ev = (id: string) => mapResendEvent({ type: "email.bounced", data: { email_id: id, from: "support@ses.example", to: ["a@x.example"], bounce: { type: "Permanent" } } }, id).events;
		expect(applyProviderEvents(ctx, ev("p-one")).soleRecipients).toEqual(["a@x.example"]);
		expect(applyProviderEvents(ctx, ev("p-two")).soleRecipients).toEqual([]);
		expect(row("two").delivery_status).toBe("bounced");
	});

	it("bounces and complaints from provider events feed the breaker's counts", () => {
		seedSent("row-5", { provider_message_id: "p5", delivery_status: "sent" });
		seedSent("row-6", { provider_message_id: "p6", delivery_status: "sent" });
		db.prepare(`INSERT INTO delivery_events (email_id, event_type, source, occurred_at) VALUES ('row-5','sent','send','2026-11-08T11:58:00Z'), ('row-6','sent','send','2026-11-08T11:58:00Z')`).run();
		applyProviderEvents(ctx, mapSesEvent({ eventType: "Delivery", mail: { ...MAIL, messageId: "p5", tags: {} }, delivery: { recipients: ["a@x.example"], timestamp: "2026-11-08T12:00:00Z" } }, "a").events);
		applyProviderEvents(ctx, mapSesEvent({ eventType: "Delivery", mail: { ...MAIL, messageId: "p6", tags: {} }, delivery: { recipients: ["a@x.example"], timestamp: "2026-11-08T12:00:00Z" } }, "b").events);
		applyProviderEvents(ctx, mapResendEvent({ type: "email.complained", created_at: "2026-11-08T12:30:00Z", data: { email_id: "p6", from: "support@ses.example", to: ["a@x.example"] } }, "c").events);
		const stats = getSendingStats(ctx, { start: "2026-11-01T00:00:00Z", end: "2026-11-09T00:00:00Z" }) as Record<string, any>;
		expect(stats.delivered).toBe(2);
		expect(stats.complaints).toBe(1);
	});
});

describe("SES threading fallback", () => {
	beforeEach(() => {
		db = new DatabaseSync(":memory:");
		ctx = sqlStorage(db);
		applyMigrations(ctx.storage.sql as unknown as SqlStorage, mailboxMigrations, ctx.storage as never);
		seedSent("row-1", { message_id: "0100sesid-000000@eu-west-1.amazonses.com", provider_message_id: "0100sesid-000000" });
	});

	it("matches the stored RFC id exactly", () => {
		expect(findThreadByMessageIds(ctx, ["0100sesid-000000@eu-west-1.amazonses.com"])).toBe("thread-row-1");
	});

	it("matches the local part when SES used a different amazonses.com domain", () => {
		expect(findThreadByMessageIds(ctx, ["0100sesid-000000@email.amazonses.com"])).toBeNull();
		expect(findThreadByProviderLocalPart(ctx, ["<0100sesid-000000@email.amazonses.com>"])).toBe("thread-row-1");
	});

	it("never falls back for a domain that isn't amazonses.com", () => {
		expect(findThreadByProviderLocalPart(ctx, ["0100sesid-000000@evil.example", "0100sesid-000000@amazonses.com.evil.example"])).toBeNull();
	});
});

// -- routes ----------------------------------------------------------------------------------------

const WEBHOOK_ID = "0123456789abcdef0123456789abcdef";
const AUTH_SECRET = "webhook-test-auth-secret-0123456789";

interface Harness {
	call: (path: string, body: string, headers?: Record<string, string>) => Promise<Response>;
	applied: ProviderEventInput[][];
	bounces: string[];
	complaints: string[];
	seen: Set<string>;
	lastEvents: unknown[];
	confirmFetches: string[];
}

async function harness(rec: Partial<DomainSendingRecord>): Promise<Harness> {
	const seen = new Set<string>();
	const h: Harness = { call: null as never, applied: [], bounces: [], complaints: [], seen, lastEvents: [], confirmFetches: [] };
	const record: DomainSendingRecord = {
		hostname: "ses.example",
		provider: "ses",
		region: "us-east-1",
		accessKeyId: null,
		secretEnc: null,
		configurationSet: "cloudmail",
		snsTopicArn: TOPIC,
		webhookId: WEBHOOK_ID,
		resendKeyEnc: null,
		resendKeyLast4: null,
		resendWebhookSecretEnc: null,
		lastTest: null,
		lastEvent: null,
		updatedAt: 1,
		updatedBy: null,
		...rec,
	};
	sendingWebhookDeps.now = () => NOW;
	sendingWebhookDeps.rpc = () =>
		({
			getDomainSendingByWebhook: async (id: string) => (id === WEBHOOK_ID ? record : null),
			recordDomainSendingEvent: async (_h: string, e: unknown) => void h.lastEvents.push(e),
			markSendingEventSeen: async (id: string) => (seen.has(id) ? false : (seen.add(id), true)),
			forgetSendingEvent: async (id: string) => void seen.delete(id),
			getOrInitMeta: async () => "x",
		}) as never;
	sendingWebhookDeps.isMailbox = async (_e, a) => a === "support@ses.example";
	sendingWebhookDeps.aliasOwner = async () => null;
	sendingWebhookDeps.mailboxStub = () => ({
		applyProviderEvents: async (events) => {
			h.applied.push(events);
			return { applied: events.length, matched: 1 };
		},
	});
	sendingWebhookDeps.hardBounce = async (_e, a) => void h.bounces.push(a);
	sendingWebhookDeps.complaint = async (_e, a) => void h.complaints.push(a) as never;
	sendingWebhookDeps.fetchImpl = (async (url: string) => {
		h.confirmFetches.push(String(url));
		return new Response("<ConfirmSubscriptionResponse/>", { status: 200 });
	}) as never;
	const app = new Hono<MailboxContext>();
	app.route("/", sendingWebhookRoutes);
	const env = { AUTH_SECRET } as unknown as Env;
	h.call = (path, body, headers = {}) =>
		app.request(path, { method: "POST", headers: { "content-type": "text/plain; charset=UTF-8", ...headers }, body }, env);
	return h;
}

const SES_PATH = `/hooks/ses/${WEBHOOK_ID}`;
const BOUNCE = { eventType: "Bounce", mail: MAIL, bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "gone@x.example" }] } };

describe("POST /hooks/ses/:webhookId", () => {
	it("verifies, maps, suppresses and records a bounce", async () => {
		const h = await harness({});
		const res = await h.call(SES_PATH, JSON.stringify(notification(BOUNCE)));
		expect(res.status).toBe(200);
		expect(h.applied[0]![0]).toMatchObject({ type: "bounced", recipient: "gone@x.example", source: "ses" });
		expect(h.bounces).toEqual(["gone@x.example"]);
		expect(h.lastEvents).toEqual([{ type: "Bounce", at: NOW }]);
	});

	it("a duplicate SNS MessageId is a no-op", async () => {
		const h = await harness({});
		const body = JSON.stringify(notification(BOUNCE));
		await h.call(SES_PATH, body);
		const again = await h.call(SES_PATH, body);
		expect(again.status).toBe(200);
		expect(h.applied).toHaveLength(1);
		expect(h.bounces).toEqual(["gone@x.example"]);
	});

	it("refuses a wrong topic, a bad signature and an unknown webhook id", async () => {
		const h = await harness({ snsTopicArn: "arn:aws:sns:us-east-1:123456789012:mine" });
		expect((await h.call(SES_PATH, JSON.stringify(notification(BOUNCE)))).status).toBe(403);
		const h2 = await harness({});
		const tampered = { ...notification(BOUNCE), Message: JSON.stringify({ ...BOUNCE, mail: { ...MAIL, source: "x@ses.example" } }) };
		expect((await h2.call(SES_PATH, JSON.stringify(tampered))).status).toBe(403);
		expect((await h2.call(`/hooks/ses/${"f".repeat(32)}`, JSON.stringify(notification(BOUNCE)))).status).toBe(404);
		expect(h.applied.length + h2.applied.length).toBe(0);
	});

	it("ignores events for another domain (or a subdomain with its own settings) on the same topic", async () => {
		const h = await harness({});
		for (const source of ["a@other.example", "a@sub.ses.example", "a@evilses.example"]) {
			const res = await h.call(SES_PATH, JSON.stringify(notification({ ...BOUNCE, mail: { ...MAIL, source } }, { MessageId: source })));
			expect(res.status).toBe(200);
		}
		expect(h.applied).toEqual([]);
		expect(h.bounces).toEqual([]);
	});

	it("confirms a subscription only after verification, and only on the topic's host", async () => {
		const h = await harness({});
		const ok = `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC)}&Token=tok`;
		const sub = (url: string, id: string) =>
			signSns({ Type: "SubscriptionConfirmation", MessageId: id, TopicArn: TOPIC, Message: "confirm", Timestamp: "2026-11-08T12:00:00Z", SignatureVersion: "2", SigningCertURL: CERT_URL, SubscribeURL: url, Token: "tok" });
		const evil = sub("https://169.254.169.254/latest/meta-data/", "s-1");
		expect((await h.call(SES_PATH, JSON.stringify(evil))).status).toBe(400);
		expect(h.confirmFetches).toEqual([]);
		// Unsigned (tampered) confirmation with a valid-looking URL: refused before any fetch.
		const forged = { ...sub(ok, "s-2"), SubscribeURL: ok.replace("tok", "tok2") };
		expect((await h.call(SES_PATH, JSON.stringify(forged))).status).toBe(403);
		expect(h.confirmFetches).toEqual([]);
		expect((await h.call(SES_PATH, JSON.stringify(sub(ok, "s-3")))).status).toBe(200);
		expect(h.confirmFetches).toEqual([ok]);
		expect(h.lastEvents.at(-1)).toMatchObject({ subscription: "confirmed" });
	});

	it("refuses a body over the size cap", async () => {
		const h = await harness({});
		expect((await h.call(SES_PATH, "x".repeat(300 * 1024))).status).toBe(413);
	});

	it("a storage failure answers 500 and the retry is processed", async () => {
		const h = await harness({});
		let fail = true;
		sendingWebhookDeps.mailboxStub = () => ({
			applyProviderEvents: async (events) => {
				if (fail) throw new Error("DO down");
				h.applied.push(events);
				return { applied: 1, matched: 1 };
			},
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const body = JSON.stringify(notification(BOUNCE));
		expect((await h.call(SES_PATH, body)).status).toBe(500);
		fail = false;
		expect((await h.call(SES_PATH, body)).status).toBe(200);
		expect(h.applied).toHaveLength(1);
	});
});

describe("POST /hooks/resend/:webhookId", () => {
	const path = `/hooks/resend/${WEBHOOK_ID}`;
	async function resendHarness() {
		const enc = await sealResendWebhookSecret(WHSEC, AUTH_SECRET, "ses.example");
		return harness({ provider: "resend", snsTopicArn: null, resendWebhookSecretEnc: enc });
	}
	const payload = JSON.stringify({
		type: "email.bounced",
		created_at: "2026-11-08T12:00:00Z",
		data: { email_id: "re-1", from: "support@ses.example", to: ["gone@x.example"], bounce: { type: "Permanent" }, tags: { cm_send: "row-1" } },
	});
	const ts = String(Math.floor(NOW / 1000));

	it("verifies the Svix signature and files the event", async () => {
		const h = await resendHarness();
		sendingWebhookDeps.mailboxStub = () => ({
			applyProviderEvents: async (events) => {
				h.applied.push(events);
				return { applied: 1, matched: 1, soleRecipients: ["gone@x.example"] };
			},
		});
		const res = await h.call(path, payload, { "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": svixSign("msg_1", ts, payload) });
		expect(res.status).toBe(200);
		expect(h.applied[0]![0]).toMatchObject({ type: "bounced", source: "resend", providerId: "re-1", sendTag: "row-1", recipient: null });
		expect(h.bounces).toEqual(["gone@x.example"]);
	});

	it("refuses a bad signature and a stale timestamp; a repeated svix-id is a no-op", async () => {
		const h = await resendHarness();
		expect((await h.call(path, payload, { "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": svixSign("msg_1", ts, `${payload} `) })).status).toBe(401);
		const old = String(Math.floor(NOW / 1000) - 600);
		expect((await h.call(path, payload, { "svix-id": "msg_1", "svix-timestamp": old, "svix-signature": svixSign("msg_1", old, payload) })).status).toBe(401);
		const headers = { "svix-id": "msg_2", "svix-timestamp": ts, "svix-signature": svixSign("msg_2", ts, payload) };
		await h.call(path, payload, headers);
		await h.call(path, payload, headers);
		expect(h.applied).toHaveLength(1);
	});

	it("suppresses only the stored message's sole recipient, never a guess from data.to", async () => {
		const h = await resendHarness();
		// The stored row had a Cc, so two recipients: no suppression.
		sendingWebhookDeps.mailboxStub = () => ({ applyProviderEvents: async () => ({ applied: 1, matched: 1, soleRecipients: [] }) });
		const h1 = { "svix-id": "msg_4", "svix-timestamp": ts, "svix-signature": svixSign("msg_4", ts, payload) };
		expect((await h.call(path, payload, h1)).status).toBe(200);
		expect(h.bounces).toEqual([]);
		// Exactly one recipient on the row: that one is suppressed.
		sendingWebhookDeps.mailboxStub = () => ({ applyProviderEvents: async () => ({ applied: 1, matched: 1, soleRecipients: ["gone@x.example"] }) });
		const h2 = { "svix-id": "msg_5", "svix-timestamp": ts, "svix-signature": svixSign("msg_5", ts, payload) };
		expect((await h.call(path, payload, h2)).status).toBe(200);
		expect(h.bounces).toEqual(["gone@x.example"]);
	});

	it("an unknown email id still answers 200 and records nothing", async () => {
		const h = await resendHarness();
		h.applied.length = 0;
		sendingWebhookDeps.mailboxStub = () => ({ applyProviderEvents: async () => ({ applied: 0, matched: 0 }) });
		const body = JSON.stringify({ type: "email.delivered", data: { email_id: "unknown", from: "support@ses.example", to: ["a@x.example"] } });
		const res = await h.call(path, body, { "svix-id": "msg_3", "svix-timestamp": ts, "svix-signature": svixSign("msg_3", ts, body) });
		expect(res.status).toBe(200);
	});
});
