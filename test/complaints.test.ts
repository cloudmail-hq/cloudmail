// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Spam complaints become permanent `complaint` suppressions, from:
 *
 *   - feedback-loop (ARF, RFC 5965) reports arriving inbound, matched against
 *     the Sent row they name, so a forged report cannot suppress strangers;
 *   - the delivery reconciler's `complained` verdicts.
 *
 * And a complaint over an existing `unsubscribed` entry escalates it, so it
 * starts blocking transactional mail too.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isComplaintFeedback, isFeedbackReport, parseFeedbackReport } from "../shared/feedback-report";
import { lifecycleFromProviderStatus } from "../shared/delivery-events";
import { applyMigrations, mailboxMigrations } from "../workers/durableObject/migrations";
import { recordComplaint } from "../workers/durableObject/features";
import { onFeedbackReportForCompliance } from "../workers/lib/inbound-compliance";
import { reconcileDeliveryEvents } from "../workers/lib/email-reconciler";
import { handleComplaint } from "../workers/lib/suppressions";
import { preSend } from "../workers/lib/pre-send";
import { authStoreBinding, fakeBucket } from "./helpers/suppression-store";
import type { Env } from "../workers/types";

beforeEach(() => {
	vi.restoreAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

const ARF = (opts: { rcpt?: string | null; id?: string; type?: string; to?: string } = {}) =>
	[
		"From: staff@hotmail.example",
		"To: abuse@product.dev",
		"Subject: complaint about message",
		"MIME-Version: 1.0",
		'Content-Type: multipart/report; report-type=feedback-report; boundary="b1"',
		"",
		"--b1",
		"Content-Type: text/plain",
		"",
		"This is an email abuse report. Original-Rcpt-To: decoy@x.com",
		"",
		"--b1",
		"Content-Type: message/feedback-report",
		"",
		`Feedback-Type: ${opts.type ?? "abuse"}`,
		"User-Agent: SomeGenerator/1.0",
		"Version: 1",
		...(opts.rcpt === null ? [] : [`Original-Rcpt-To: ${opts.rcpt ?? "reader@example.org"}`]),
		"Reporting-MTA: dns; mail.hotmail.example",
		"",
		"--b1",
		"Content-Type: message/rfc822",
		"",
		"From: hello@product.dev",
		`To: ${opts.to ?? "redacted"}`,
		"Subject: Welcome",
		`Message-ID: <${opts.id ?? "prov-1@cf"}>`,
		"",
		"body",
		"--b1--",
		"",
	].join("\r\n");

describe("ARF parsing", () => {
	it("recognises a feedback report from the header or a part type", () => {
		expect(isFeedbackReport({ headers: { "content-type": 'multipart/report; report-type="feedback-report"; boundary=x' } })).toBe(true);
		expect(isFeedbackReport({ headers: {}, contentTypes: ["message/feedback-report"] })).toBe(true);
		expect(isFeedbackReport({ headers: { "content-type": "multipart/report; report-type=delivery-status" } })).toBe(false);
	});

	it("reads the complainer and the original Message-ID, not text in the human part", () => {
		const r = parseFeedbackReport(ARF());
		expect(r).toMatchObject({ feedbackType: "abuse", recipient: "reader@example.org", originalMessageId: "prov-1@cf", userAgent: "SomeGenerator/1.0" });
		expect(isComplaintFeedback(r)).toBe(true);
	});

	it("never falls back to the original's To: (it may not be the complainer)", () => {
		expect(parseFeedbackReport(ARF({ rcpt: null, to: "Reader <reader@example.org>" })).recipient).toBeNull();
		expect(parseFeedbackReport(ARF({ rcpt: null })).recipient).toBeNull();
	});

	it("accepts the RFC 5965 rfc822; prefix and reads the original sender", () => {
		const r = parseFeedbackReport(ARF({ rcpt: "rfc822;Reader@Example.org" }));
		expect(r.recipient).toBe("reader@example.org");
		expect(r.originalFrom).toBe("hello@product.dev");
	});

	it("does not count not-spam reports", () => {
		expect(isComplaintFeedback(parseFeedbackReport(ARF({ type: "not-spam" })))).toBe(false);
	});
});

// ── recordComplaint (MailboxDO) ────────────────────────────────────

function mailboxCtx() {
	const db = new DatabaseSync(":memory:");
	const exec = (query: string, ...bindings: unknown[]) => {
		const trimmed = query.trim();
		if (bindings.length === 0 && !/^(select|with)/i.test(trimmed)) {
			db.exec(trimmed);
			return { toArray: () => [], rowsWritten: 0, one: () => undefined, [Symbol.iterator]: () => [][Symbol.iterator]() };
		}
		const rows = db.prepare(trimmed).all(...(bindings as never[])) as Record<string, unknown>[];
		const changes = Number((db.prepare("SELECT changes() AS n").get() as { n: number }).n ?? 0);
		return { toArray: () => rows, rowsWritten: /^(select|with)/i.test(trimmed) ? 0 : changes, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
	};
	const ctx = {
		id: { name: "hello@product.dev" },
		storage: { sql: { exec }, transactionSync: <T>(fn: () => T) => fn(), getAlarm: async () => null, setAlarm: async () => {} },
	} as unknown as DurableObjectState;
	applyMigrations(ctx.storage.sql as unknown as SqlStorage, mailboxMigrations, ctx.storage as never);
	const sent = (id: string, messageId: string, recipient: string, cc: string | null = null) =>
		db
			.prepare(
				`INSERT INTO emails (id, folder_id, subject, sender, recipient, cc, date, body, read, message_id)
				 VALUES (?, 'sent', 'Welcome', 'hello@product.dev', ?, ?, '2026-10-20T00:00:00.000Z', '<p>x</p>', 1, ?)`,
			)
			.run(id, recipient, cc, messageId);
	const events = () => db.prepare(`SELECT event_type, recipient FROM delivery_events`).all();
	const status = (id: string) => (db.prepare(`SELECT delivery_status FROM emails WHERE id = ?`).get(id) as { delivery_status: string | null }).delivery_status;
	return { ctx, sent, events, status };
}

describe("recordComplaint", () => {
	it("matches the Sent row, records a complained ledger event once, and updates the status", () => {
		const m = mailboxCtx();
		m.sent("e1", "prov-1@cf", "reader@example.org");
		expect(recordComplaint(m.ctx, "<prov-1@cf>", "reader@example.org", "fbl")).toEqual({ emailId: "e1", recipient: "reader@example.org" });
		recordComplaint(m.ctx, "prov-1@cf", "reader@example.org", "fbl");
		expect(m.events()).toEqual([{ event_type: "complained", recipient: "reader@example.org" }]);
		expect(m.status("e1")).toBe("failed");
	});

	it("attributes a redacted report only to a single-recipient message", () => {
		const m = mailboxCtx();
		m.sent("e1", "one@cf", "reader@example.org");
		m.sent("e2", "many@cf", "a@x.com", "b@x.com");
		expect(recordComplaint(m.ctx, "one@cf", null, null)?.recipient).toBe("reader@example.org");
		expect(recordComplaint(m.ctx, "many@cf", null, null)).toBeNull();
	});

	it("refuses a report naming someone the message was not sent to, or a message we did not send", () => {
		const m = mailboxCtx();
		m.sent("e1", "prov-1@cf", "reader@example.org");
		expect(recordComplaint(m.ctx, "prov-1@cf", "stranger@x.com", null)).toBeNull();
		expect(recordComplaint(m.ctx, "unknown@cf", "reader@example.org", null)).toBeNull();
		expect(m.events()).toEqual([]);
	});
});

describe("inbound feedback reports", () => {
	it("suppress the complainer for the sending domain, permanently, and block transactional mail", async () => {
		const { store, AUTH_STORE } = authStoreBinding();
		const env = { AUTH_STORE, BUCKET: fakeBucket() } as unknown as Env;
		const m = mailboxCtx();
		m.sent("e1", "prov-1@cf", "reader@example.org");
		const stub = { recordComplaint: async (id: string | null, r: string | null, d: string | null) => recordComplaint(m.ctx, id, r, d) };

		const outcome = await onFeedbackReportForCompliance(env, {
			mailboxId: "hello@product.dev",
			headers: { "content-type": "multipart/report; report-type=feedback-report; boundary=b1" },
			contentTypes: [],
			raw: ARF(),
			senderAuthenticated: true,
			stubFor: (mb) => (mb === "hello@product.dev" ? stub : null),
		});
		expect(outcome).toBe("complaint");
		const rows = await store.findSuppressions(["reader@example.org"], "product.dev");
		expect(rows).toMatchObject([{ reason: "complaint", scope: "product.dev", source: "fbl:hello@product.dev" }]);

		// Transactional mail to them is now refused too.
		const gate = await preSend(env, { kind: "transactional", from: "hello@product.dev", mailboxId: "hello@product.dev", to: "reader@example.org" }, { quota: () => ({ checkSendRateLimit: async () => null }) });
		expect(gate).toMatchObject({ ok: false, code: "all_suppressed" });
	});

	it("store a forged report without suppressing anyone", async () => {
		const { store, AUTH_STORE } = authStoreBinding();
		const env = { AUTH_STORE, BUCKET: fakeBucket() } as unknown as Env;
		const m = mailboxCtx();
		const stub = { recordComplaint: async (id: string | null, r: string | null, d: string | null) => recordComplaint(m.ctx, id, r, d) };
		const outcome = await onFeedbackReportForCompliance(env, {
			mailboxId: "hello@product.dev",
			headers: { "content-type": "multipart/report; report-type=feedback-report; boundary=b1" },
			contentTypes: [],
			raw: ARF({ rcpt: "victim@x.com", id: "made-up@cf" }),
			senderAuthenticated: true,
			stubFor: () => stub,
		});
		expect(outcome).toBe("unmatched");
		expect(await store.findSuppressions(["victim@x.com"])).toEqual([]);
	});

	it("are ignored unless our MX authenticated the sender", async () => {
		const { store, AUTH_STORE } = authStoreBinding();
		const env = { AUTH_STORE, BUCKET: fakeBucket() } as unknown as Env;
		const m = mailboxCtx();
		m.sent("e1", "prov-1@cf", "reader@example.org");
		const stub = { recordComplaint: vi.fn(async (id: string | null, r: string | null, d: string | null) => recordComplaint(m.ctx, id, r, d)) };
		const outcome = await onFeedbackReportForCompliance(env, {
			mailboxId: "hello@product.dev",
			headers: { "content-type": "multipart/report; report-type=feedback-report; boundary=b1" },
			contentTypes: [],
			raw: ARF(),
			stubFor: () => stub,
		});
		expect(outcome).toBe("unauthenticated");
		expect(stub.recordComplaint).not.toHaveBeenCalled();
		expect(await store.findSuppressions(["reader@example.org"])).toEqual([]);
	});

	it("delivered to a central abuse@ mailbox, match the sending mailbox from the original's From", async () => {
		const { store, AUTH_STORE } = authStoreBinding();
		const env = { AUTH_STORE, BUCKET: fakeBucket() } as unknown as Env;
		const sender = mailboxCtx();
		sender.sent("e1", "prov-1@cf", "reader@example.org");
		const senderStub = { recordComplaint: async (id: string | null, r: string | null, d: string | null) => recordComplaint(sender.ctx, id, r, d) };
		const abuseStub = { recordComplaint: vi.fn(async () => null) };
		const outcome = await onFeedbackReportForCompliance(env, {
			mailboxId: "abuse@product.dev",
			headers: { "content-type": "multipart/report; report-type=feedback-report; boundary=b1" },
			contentTypes: [],
			raw: ARF(),
			senderAuthenticated: true,
			stubFor: (mb) => (mb === "hello@product.dev" ? senderStub : mb === "abuse@product.dev" ? abuseStub : null),
		});
		expect(outcome).toBe("complaint");
		expect(abuseStub.recordComplaint).not.toHaveBeenCalled();
		expect(await store.findSuppressions(["reader@example.org"], "product.dev")).toMatchObject([{ reason: "complaint", source: "fbl:hello@product.dev" }]);
	});

	it("ignore ordinary mail", async () => {
		const stub = { recordComplaint: vi.fn() };
		const outcome = await onFeedbackReportForCompliance({} as Env, {
			mailboxId: "hello@product.dev",
			headers: { "content-type": "text/plain" },
			contentTypes: [],
			raw: "hi",
			senderAuthenticated: true,
			stubFor: () => stub,
		});
		expect(outcome).toBe("none");
		expect(stub.recordComplaint).not.toHaveBeenCalled();
	});
});

describe("reconciler complaints", () => {
	it("maps the provider's complained status", () => {
		expect(lifecycleFromProviderStatus("complained")).toBe("complained");
		expect(lifecycleFromProviderStatus("complaint")).toBe("complained");
	});

	it("reports each complaining recipient to onComplaint", async () => {
		const events = [
			{ status: "complained", to: "angry@x.com" },
			{ status: "complained", to: "angry@x.com" },
			{ status: "delivered", to: "ok@x.com" },
		].map((e, i) => ({
			datetime: "2026-10-25T00:00:00Z",
			messageId: `<m${i}@x>`,
			from: "hello@product.dev",
			eventType: "",
			sendingDomain: "product.dev",
			errorCause: "",
			errorDetail: "",
			...e,
		}));
		const fetchImpl = (async () =>
			new Response(JSON.stringify({ data: { viewer: { zones: [{ emailSendingAdaptive: events }] } } }))) as unknown as typeof fetch;
		const complained: [string, string][] = [];
		const result = await reconcileDeliveryEvents(
			{ apiToken: "t", zoneTag: "z" },
			() => ({ reconcileProviderEvents: async () => ({ applied: 0 }) }),
			{ fetchImpl, onComplaint: async (address, mailbox) => { complained.push([address, mailbox]); } },
		);
		expect(complained).toEqual([["angry@x.com", "hello@product.dev"]]);
		expect(result.complaints).toBe(1);
	});
});

describe("handleComplaint", () => {
	it("escalates an existing unsubscribe to a complaint and stops sequences once", async () => {
		const { store, AUTH_STORE } = authStoreBinding();
		const bucket = fakeBucket();
		bucket.store.set(
			"sequence-enrollments/e.json",
			JSON.stringify({ id: "e", sequenceId: "s", personId: "p", personEmail: "a@x.com", personName: null, fromAddress: "hello@product.dev", status: "active", variables: {}, enrolledAt: 0, cancelledAt: null }),
		);
		const env = { AUTH_STORE, BUCKET: bucket } as unknown as Env;
		await store.addSuppressions([{ address: "a@x.com", scope: "product.dev", reason: "unsubscribed", source: "link" }], 1);
		expect(await handleComplaint(env, { address: "A@x.com", fromAddress: "hello@product.dev", source: "t" })).toBe(true);
		expect((await store.findSuppressions(["a@x.com"]))[0]).toMatchObject({ reason: "complaint" });
		expect(JSON.parse(bucket.store.get("sequence-enrollments/e.json")!).status).toBe("cancelled");
		// A repeat is a no-op.
		expect(await handleComplaint(env, { address: "a@x.com", fromAddress: "hello@product.dev", source: "t" })).toBe(false);
	});
});
