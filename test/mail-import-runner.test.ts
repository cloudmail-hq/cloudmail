// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The import job runner against the real MailboxDO schema (node:sqlite) and an
 * in-memory R2: mbox, zip and eml jobs, Takeout labels, dedupe, threading,
 * resume after interruption, pause/cancel, and that an import triggers none of
 * inbound mail's side effects.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Every module receiveEmail's side effects run through. Import must reach none.
const sideEffects = vi.hoisted(() => ({
	forward: vi.fn(),
	sendEmail: vi.fn(),
	webhookStub: vi.fn(() => null),
	eventsStub: vi.fn(() => null),
	publishToStream: vi.fn(),
	onEmailStored: vi.fn(),
	enqueueSummary: vi.fn(),
	enqueueTriage: vi.fn(),
	onInboundForCompliance: vi.fn(),
	onFeedbackReportForCompliance: vi.fn(),
	notifyNewMail: vi.fn(),
	schedulePushForNewMail: vi.fn(),
	parkPush: vi.fn(),
	enqueueSemantic: vi.fn(),
}));
vi.mock("../workers/lib/push", async (orig) => ({
	...(await orig<typeof import("../workers/lib/push")>()),
	notifyNewMail: sideEffects.notifyNewMail,
	schedulePushForNewMail: sideEffects.schedulePushForNewMail,
}));
vi.mock("../workers/durableObject/push-queue", async (orig) => ({
	...(await orig<typeof import("../workers/durableObject/push-queue")>()),
	parkPush: sideEffects.parkPush,
}));
vi.mock("../workers/durableObject/semantic", async (orig) => ({
	...(await orig<typeof import("../workers/durableObject/semantic")>()),
	enqueueSemantic: sideEffects.enqueueSemantic,
}));
vi.mock("../workers/lib/forwarding", () => ({ forwardInboundMessage: sideEffects.forward }));
vi.mock("../workers/email-sender", () => ({ sendEmail: sideEffects.sendEmail }));
vi.mock("../workers/lib/webhooks", () => ({ webhookStub: sideEffects.webhookStub }));
vi.mock("../workers/lib/events", () => ({ eventsStub: sideEffects.eventsStub, publishToStream: sideEffects.publishToStream }));
vi.mock("../workers/lib/inbound-compliance", () => ({
	onInboundForCompliance: sideEffects.onInboundForCompliance,
	onFeedbackReportForCompliance: sideEffects.onFeedbackReportForCompliance,
}));
vi.mock("../workers/durableObject/followups", async (orig) => ({
	...(await orig<typeof import("../workers/durableObject/followups")>()),
	onEmailStored: sideEffects.onEmailStored,
}));
vi.mock("../workers/durableObject/summaries", async (orig) => ({
	...(await orig<typeof import("../workers/durableObject/summaries")>()),
	enqueueSummary: sideEffects.enqueueSummary,
}));
vi.mock("../workers/durableObject/triage", async (orig) => ({
	...(await orig<typeof import("../workers/durableObject/triage")>()),
	enqueueTriage: sideEffects.enqueueTriage,
}));

import * as store from "../workers/durableObject/mail-import";
import { ingestRawMessage, runImportStep, type StepDeps } from "../workers/lib/mail-import";
import { bytes, mbox, memoryBucket, message, zip } from "./helpers/import-fixtures";
import { mailboxSqlite } from "./helpers/mailbox-sqlite";

const MAILBOX = "me@example.com";

function setup() {
	const db = mailboxSqlite();
	const bucket = memoryBucket();
	return { ...db, bucket };
}

type Env = ReturnType<typeof setup>;

function fileJob(env: Env, source: "mbox" | "zip" | "eml", data: Uint8Array, opts: Record<string, unknown> | null = null) {
	const id = `imp_${Math.random().toString(36).slice(2)}`;
	const key = `imports/${MAILBOX}/${id}`;
	env.bucket.objects.set(key, data);
	store.createJob(env.ctx, {
		id,
		source,
		status: "queued",
		label: `file.${source}`,
		mailbox: MAILBOX,
		r2Key: key,
		sizeBytes: data.length,
		options: opts,
	});
	return id;
}

function deps(env: Env, extra: Partial<StepDeps> = {}): StepDeps {
	return { ctx: env.ctx, bucket: env.bucket, mailbox: MAILBOX, ...extra };
}

async function drain(env: Env, extra: Partial<StepDeps> = {}, maxSteps = 100) {
	for (let i = 0; i < maxSteps; i++) {
		const r = await runImportStep(deps(env, extra));
		if (!r.more) return;
	}
	throw new Error("import did not finish");
}

const rows = (env: Env, sql = `SELECT * FROM emails ORDER BY date, id`) => env.db.prepare(sql).all() as Record<string, any>[];

beforeEach(() => {
	for (const fn of Object.values(sideEffects)) fn.mockClear();
});

describe("mbox import", () => {
	it("imports every message with its original Date and Message-ID, flagged imported", async () => {
		const env = setup();
		const file = mbox([
			message({ messageId: "a@x", subject: "First", date: "Mon, 13 Jan 2014 09:00:00 +0000" }),
			message({ messageId: "b@x", subject: "Second", date: "Tue, 14 Jan 2014 09:00:00 +0000" }),
		]);
		const id = fileJob(env, "mbox", bytes(file));
		await drain(env);
		const job = store.getJob(env.ctx, id)!;
		expect(job.status).toBe("completed");
		expect(job.imported).toBe(2);
		expect(job.cursor).toBe(bytes(file).length);
		const stored = rows(env);
		expect(stored.map((r) => r.message_id)).toEqual(["a@x", "b@x"]);
		expect(stored[0].date).toBe("2014-01-13T09:00:00.000Z");
		expect(stored.every((r) => r.imported === 1)).toBe(true);
		// No Gmail labels: the default folder, Archive, and read.
		expect(stored.every((r) => r.folder_id === "archive" && r.read === 1)).toBe(true);
		const view = store.toJobView(job);
		expect(view.progress).toEqual({ done: bytes(file).length, total: bytes(file).length, unit: "bytes" });
	});

	it("maps Takeout X-Gmail-Labels onto folders, labels and flags", async () => {
		const env = setup();
		const file = mbox([
			message({ messageId: "in@x", gmailLabels: "Inbox,Unread,Category Updates,Receipts" }),
			message({ messageId: "sent@x", from: MAILBOX, gmailLabels: "Sent,Opened" }),
			message({ messageId: "star@x", gmailLabels: "Archived,Starred,Opened,\"Work, Clients\"" }),
			message({ messageId: "spam@x", gmailLabels: "Spam" }),
			message({ messageId: "trash@x", gmailLabels: "Trash,Inbox" }),
		]);
		fileJob(env, "mbox", bytes(file));
		await drain(env);
		const by = Object.fromEntries(rows(env).map((r) => [r.message_id, r]));
		expect(by["in@x"]).toMatchObject({ folder_id: "inbox", read: 0, starred: 0 });
		expect(by["sent@x"]).toMatchObject({ folder_id: "sent", read: 1 });
		expect(by["star@x"]).toMatchObject({ folder_id: "archive", starred: 1, read: 1 });
		expect(by["spam@x"].folder_id).toBe("spam");
		expect(by["trash@x"]).toMatchObject({ folder_id: "trash", trashed_from: "archive" });
		expect(by["trash@x"].trashed_at).toBeTruthy();
		const labels = env.db
			.prepare(
				`SELECT e.message_id AS mid, l.name AS name FROM email_labels el JOIN labels l ON l.id = el.label_id JOIN emails e ON e.id = el.email_id ORDER BY l.name`,
			)
			.all() as { mid: string; name: string }[];
		expect(labels).toEqual([
			{ mid: "in@x", name: "Receipts" },
			{ mid: "in@x", name: "Updates" },
			{ mid: "star@x", name: "Work, Clients" },
		]);
	});

	it("reuses an existing label case-insensitively", async () => {
		const env = setup();
		env.db.prepare(`INSERT INTO labels (id, name, color) VALUES ('lbl1', 'receipts', '#000')`).run();
		fileJob(env, "mbox", bytes(mbox([message({ gmailLabels: "Receipts" })])));
		await drain(env);
		expect(env.db.prepare(`SELECT COUNT(*) AS n FROM labels`).get()).toEqual({ n: 1 });
		expect(env.db.prepare(`SELECT label_id FROM email_labels`).get()).toEqual({ label_id: "lbl1" });
	});

	it("threads replies by Message-ID even when imported before their parent", async () => {
		const env = setup();
		const file = mbox([
			message({ messageId: "r2@x", subject: "Re: Plan", inReplyTo: "r1@x", references: "<root@x> <r1@x>" }),
			message({ messageId: "root@x", subject: "Plan" }),
			message({ messageId: "r1@x", subject: "Re: Plan", inReplyTo: "root@x", references: "<root@x>" }),
			message({ messageId: "other@x", subject: "Plan" }),
		]);
		fileJob(env, "mbox", bytes(file));
		await drain(env);
		const by = Object.fromEntries(rows(env).map((r) => [r.message_id, r.thread_id]));
		expect(by["r2@x"]).toBe("root@x");
		expect(by["root@x"]).toBe("root@x");
		expect(by["r1@x"]).toBe("root@x");
		// Same subject, no references: its own thread (no subject fallback for old mail).
		expect(by["other@x"]).not.toBe("root@x");
	});

	it("joins an existing local thread", async () => {
		const env = setup();
		env.insert({ id: "local1", thread_id: "thread-local" });
		env.db.prepare(`UPDATE emails SET message_id = 'orig@x' WHERE id = 'local1'`).run();
		fileJob(env, "mbox", bytes(mbox([message({ messageId: "reply@x", inReplyTo: "orig@x" })])));
		await drain(env);
		expect(env.db.prepare(`SELECT thread_id FROM emails WHERE message_id = 'reply@x'`).get()).toEqual({ thread_id: "thread-local" });
	});

	it("stores attachments in R2 and records blocked ones without a blob", async () => {
		const env = setup();
		const file = mbox([
			message({ messageId: "att@x", attachment: { filename: "notes.txt", content: "hello", type: "text/plain" } }),
			message({ messageId: "exe@x", attachment: { filename: "run.exe", content: "MZ" } }),
		]);
		fileJob(env, "mbox", bytes(file));
		await drain(env);
		const atts = env.db.prepare(`SELECT email_id, id, filename, blocked, size FROM attachments ORDER BY filename`).all() as any[];
		expect(atts.map((a) => [a.filename, a.blocked])).toEqual([
			["notes.txt", 0],
			["run.exe", 1],
		]);
		const keys = [...env.bucket.objects.keys()].filter((k) => k.startsWith("attachments/"));
		expect(keys).toHaveLength(1);
		expect(keys[0]).toBe(`attachments/${atts[0].email_id}/${atts[0].id}/notes.txt`);
		expect(new TextDecoder().decode(env.bucket.objects.get(keys[0]))).toBe("hello");
	});

	it("counts a message that will not parse as failed and carries on", async () => {
		const env = setup();
		const file = `From x@example.com Tue Jan 14 10:00:00 2014\n\n\nFrom y@example.com Tue Jan 14 10:00:00 2014\n${message({ messageId: "ok@x" })}`;
		const id = fileJob(env, "mbox", bytes(file));
		await drain(env);
		const job = store.getJob(env.ctx, id)!;
		expect(job.imported).toBe(1);
		expect(job.failed + job.skipped).toBe(1);
		expect(job.status).toBe("completed");
	});

	it("fails clearly on a file with no messages", async () => {
		const env = setup();
		const id = fileJob(env, "mbox", bytes("this is not an mbox\n"));
		await drain(env);
		const job = store.getJob(env.ctx, id)!;
		expect(job.status).toBe("failed");
		expect(job.last_error).toMatch(/does not look like an mbox/);
	});
});

describe("dedupe", () => {
	it("skips messages the mailbox already holds, in any folder including Sent", async () => {
		const env = setup();
		env.insert({ id: "existing-sent", folder: "sent" });
		env.db.prepare(`UPDATE emails SET message_id = 'dup-sent@x' WHERE id = 'existing-sent'`).run();
		const file = mbox([message({ messageId: "dup-sent@x" }), message({ messageId: "new@x" })]);
		const id = fileJob(env, "mbox", bytes(file));
		await drain(env);
		const job = store.getJob(env.ctx, id)!;
		expect(job).toMatchObject({ imported: 1, duplicates: 1 });
		expect(env.db.prepare(`SELECT COUNT(*) AS n FROM emails WHERE message_id = 'dup-sent@x'`).get()).toEqual({ n: 1 });
	});

	it("re-importing the same file adds nothing, including messages without a Message-ID", async () => {
		const env = setup();
		const file = bytes(mbox([message({ messageId: "one@x" }), message({ messageId: null, subject: "No id" })]));
		fileJob(env, "mbox", file);
		await drain(env);
		const second = fileJob(env, "mbox", file);
		await drain(env);
		expect(store.getJob(env.ctx, second)).toMatchObject({ imported: 0, duplicates: 2 });
		expect(env.db.prepare(`SELECT COUNT(*) AS n FROM emails`).get()).toEqual({ n: 2 });
	});

	it("does not leave attachment blobs behind for a duplicate", async () => {
		const env = setup();
		const msg = message({ messageId: "a@x", attachment: { filename: "a.txt", content: "x" } });
		fileJob(env, "mbox", bytes(mbox([msg])));
		await drain(env);
		fileJob(env, "mbox", bytes(mbox([msg])));
		await drain(env);
		expect([...env.bucket.objects.keys()].filter((k) => k.startsWith("attachments/"))).toHaveLength(1);
	});
});

describe("side effects", () => {
	it("an import triggers no webhook, event, forward, send, auto-reply, follow-up, summary, triage or AI call", async () => {
		const env = setup();
		const ai = { run: vi.fn() };
		const file = mbox([
			message({ messageId: "s1@x", gmailLabels: "Inbox,Unread" }),
			message({ messageId: "s2@x", inReplyTo: "s1@x", gmailLabels: "Inbox" }),
			message({ messageId: "s3@x", from: MAILBOX, gmailLabels: "Sent" }),
			message({
				messageId: "dsn@x",
				from: "MAILER-DAEMON@example.com",
				subject: "Undelivered Mail Returned to Sender",
				extraHeaders: ["Auto-Submitted: auto-replied"],
				gmailLabels: "Inbox",
			}),
		]);
		fileJob(env, "mbox", bytes(file));
		await drain(env, { ...({ env: { AI: ai } } as object) });
		for (const [name, fn] of Object.entries(sideEffects)) {
			expect(fn, name).not.toHaveBeenCalled();
		}
		expect(ai.run).not.toHaveBeenCalled();
		// Nothing queued for the post-ingest jobs or reminders.
		expect(env.db.prepare(`SELECT COUNT(*) AS n FROM summary_queue`).get()).toEqual({ n: 0 });
		expect(env.db.prepare(`SELECT COUNT(*) AS n FROM triage_queue`).get()).toEqual({ n: 0 });
		expect(env.db.prepare(`SELECT COUNT(*) AS n FROM followups`).get()).toEqual({ n: 0 });
		expect(env.db.prepare(`SELECT COUNT(*) AS n FROM delivery_events`).get()).toEqual({ n: 0 });
		expect(env.db.prepare(`SELECT COUNT(*) AS n FROM auto_reply_log`).get()).toEqual({ n: 0 });
		// Triage's backfill never picks imported mail up.
		expect(env.db.prepare(`SELECT COUNT(*) AS n FROM emails WHERE triage_state IS NULL`).get()).toEqual({ n: 0 });
		// Not indexed at ingest, and no push parked.
		expect(env.db.prepare(`SELECT COUNT(*) AS n FROM semantic_queue`).get()).toEqual({ n: 0 });
		expect(env.db.prepare(`SELECT COUNT(*) AS n FROM push_queue`).get()).toEqual({ n: 0 });
	});

	it("queues a finished import for semantic search as low-priority backfill, skipping Spam and Trash", async () => {
		const env = setup();
		fileJob(
			env,
			"mbox",
			bytes(
				mbox([
					message({ messageId: "k1@x", gmailLabels: "Inbox", date: "Mon, 13 Jan 2014 09:00:00 +0000" }),
					message({ messageId: "k2@x", gmailLabels: "Archived", date: "Tue, 14 Jan 2014 09:00:00 +0000" }),
					message({ messageId: "k3@x", gmailLabels: "Spam" }),
					message({ messageId: "k4@x", gmailLabels: "Trash" }),
				]),
			),
		);
		await drain(env);
		env.insert({ id: "live-one" });
		const { queueImportedForSemantic } = await import("../workers/durableObject/mail-import");
		expect(queueImportedForSemantic(env.ctx, "Me@Example.com")).toBe(2);
		const queued = env.db
			.prepare(`SELECT e.message_id AS mid, q.source, q.mailbox_id FROM semantic_queue q JOIN emails e ON e.id = q.email_id ORDER BY mid`)
			.all();
		expect(queued).toEqual([
			{ mid: "k1@x", source: "backfill", mailbox_id: "me@example.com" },
			{ mid: "k2@x", source: "backfill", mailbox_id: "me@example.com" },
		]);
		// Idempotent, and capped by `limit`.
		expect(queueImportedForSemantic(env.ctx, MAILBOX)).toBe(0);
	});

	it("imported unread inbox mail is not counted by the notification poll or the send cap", async () => {
		const env = setup();
		const now = new Date();
		fileJob(
			env,
			"mbox",
			bytes(
				mbox([
					message({ messageId: "u@x", gmailLabels: "Inbox,Unread", date: now.toUTCString() }),
					message({ messageId: "sent-now@x", from: MAILBOX, gmailLabels: "Sent", date: now.toUTCString() }),
				]),
			),
		);
		await drain(env);
		expect(env.db.prepare(`SELECT COUNT(*) AS n FROM emails WHERE folder_id = 'inbox' AND read = 0`).get()).toEqual({ n: 1 });
		const { getSendUsage, checkSendQuota } = await import("../workers/durableObject/rate-limit");
		expect(getSendUsage(env.ctx).sent_last_hour).toBe(0);
		expect(checkSendQuota(env.ctx)).toBeNull();
		const { inboxUnreadCounts } = await import("../workers/durableObject/mail-import");
		expect(inboxUnreadCounts(env.ctx)).toEqual({ n: 0, high: 0 });
		// A normally delivered unread message still counts.
		env.insert({ id: "live", folder: "inbox" });
		expect(inboxUnreadCounts(env.ctx).n).toBe(1);
	});
});

describe("resume and control", () => {
	it("resumes after an interruption without duplicating or losing mail", async () => {
		const env = setup();
		const list = Array.from({ length: 30 }, (_, i) => message({ messageId: `m${i}@x`, subject: `M${i}`, body: "x".repeat(i * 50) }));
		const id = fileJob(env, "mbox", bytes(mbox(list)));
		// A step that is cut off after 7 messages (eviction): budget hit.
		await runImportStep(deps(env, { budgetMessages: 7 }));
		const mid = store.getJob(env.ctx, id)!;
		expect(mid.imported).toBe(7);
		expect(mid.status).toBe("running");
		// Simulate a crash after the 8th insert but before its cursor save:
		// re-run from the saved cursor; the 8th is deduplicated.
		const cursor = mid.cursor;
		await runImportStep(deps(env, { budgetMessages: 1 }));
		env.db.prepare(`UPDATE import_jobs SET cursor = ?, imported = imported - 1 WHERE id = ?`).run(cursor, id);
		await drain(env, { budgetMessages: 5 });
		const done = store.getJob(env.ctx, id)!;
		expect(done.status).toBe("completed");
		expect(done.imported + done.duplicates).toBe(30);
		expect(env.db.prepare(`SELECT COUNT(*) AS n FROM emails`).get()).toEqual({ n: 30 });
	});

	it("reads a large mbox in bounded windows", async () => {
		const env = setup();
		const big = Array.from({ length: 12 }, (_, i) => message({ messageId: `big${i}@x`, body: "y".repeat(600_000) }));
		const data = bytes(mbox(big));
		fileJob(env, "mbox", data);
		await drain(env);
		expect(env.db.prepare(`SELECT COUNT(*) AS n FROM emails`).get()).toEqual({ n: 12 });
		const ranged = env.bucket.reads.filter((r) => r.key.startsWith("imports/"));
		expect(ranged.every((r) => (r.length ?? Infinity) <= 4 * 1024 * 1024)).toBe(true);
		expect(data.length).toBeGreaterThan(4 * 1024 * 1024);
	});

	it("pause stops the job, resume continues from the cursor, cancel ends it", async () => {
		const env = setup();
		const id = fileJob(env, "mbox", bytes(mbox(Array.from({ length: 10 }, (_, i) => message({ messageId: `p${i}@x` })))));
		await runImportStep(deps(env, { budgetMessages: 3 }));
		expect(store.transitionJob(env.ctx, id, "pause")).toHaveProperty("job.status", "paused");
		expect((await runImportStep(deps(env))).jobId).toBeNull();
		expect(store.getJob(env.ctx, id)!.imported).toBe(3);
		expect(store.transitionJob(env.ctx, id, "pause")).toMatchObject({ status: 409 });
		expect(store.transitionJob(env.ctx, id, "resume")).toHaveProperty("job.status", "queued");
		await runImportStep(deps(env, { budgetMessages: 3 }));
		expect(store.getJob(env.ctx, id)!.imported).toBe(6);
		expect(store.transitionJob(env.ctx, id, "cancel")).toHaveProperty("job.status", "cancelled");
		expect((await runImportStep(deps(env))).jobId).toBeNull();
		expect(store.transitionJob(env.ctx, id, "resume")).toMatchObject({ status: 409 });
		expect(store.getJob(env.ctx, id)!.finished_at).toBeTruthy();
	});

	it("a pause during a step wins over the step's own status update", async () => {
		const env = setup();
		const id = fileJob(env, "mbox", bytes(mbox(Array.from({ length: 5 }, (_, i) => message({ messageId: `w${i}@x` })))));
		let n = 0;
		const ctx = env.ctx;
		const bucket = {
			...env.bucket,
			put: async (k: string, v: any) => env.bucket.put(k, v),
			get: async (k: string, o?: any) => {
				if (n++ === 0) store.transitionJob(ctx, id, "pause");
				return env.bucket.get(k, o);
			},
		};
		const r = await runImportStep({ ctx, bucket, mailbox: MAILBOX });
		expect(r.finished).toBeNull();
		expect(store.getJob(ctx, id)!.status).toBe("paused");
	});
});

describe("zip and eml", () => {
	it("imports a zip of .eml files and counts progress in messages", async () => {
		const env = setup();
		const archive = zip(
			[
				{ name: "a.eml", data: message({ messageId: "z1@x", subject: "Z1" }) },
				{ name: "nested/b.eml", data: message({ messageId: "z2@x", subject: "Z2" }) },
				{ name: "notes.txt", data: "ignored" },
			],
			{ deflate: true },
		);
		const id = fileJob(env, "zip", archive, { folder: "inbox" });
		await drain(env);
		const job = store.getJob(env.ctx, id)!;
		expect(job).toMatchObject({ status: "completed", imported: 2, total_messages: 2, cursor: 2 });
		expect(rows(env, `SELECT * FROM emails ORDER BY message_id`).map((r) => [r.message_id, r.folder_id])).toEqual([
			["z1@x", "inbox"],
			["z2@x", "inbox"],
		]);
		expect(store.toJobView(job).progress).toEqual({ done: 2, total: 2, unit: "messages" });
	});

	it("explains a Takeout zip that holds an mbox", async () => {
		const env = setup();
		const id = fileJob(env, "zip", zip([{ name: "Takeout/Mail/All mail.mbox", data: mbox([message()]) }]));
		await drain(env);
		expect(store.getJob(env.ctx, id)!.last_error).toMatch(/\.mbox/);
	});

	it("imports a single .eml", async () => {
		const env = setup();
		const id = fileJob(env, "eml", bytes(message({ messageId: "single@x", eol: "\r\n" })));
		await drain(env);
		expect(store.getJob(env.ctx, id)).toMatchObject({ status: "completed", imported: 1 });
	});
});

describe("migrations", () => {
	it("43_add_mail_import and 0020_import_credentials are appended after every earlier migration", async () => {
		const { mailboxMigrations } = await import("../workers/durableObject/migrations");
		const { AUTH_MIGRATION_NAMES } = await import("../workers/auth/store-core");
		// Later PRs append after it (44_semantic_embedding_model, 45_send_approval_revisions).
		const names = mailboxMigrations.map((m) => m.name);
		expect(names.indexOf("43_add_mail_import")).toBeGreaterThan(names.indexOf("40_semantic_search"));
		expect(names.indexOf("44_semantic_embedding_model")).toBeGreaterThan(names.indexOf("43_add_mail_import"));
		expect(names.at(-1)).toBe("45_send_approval_revisions");
		// Later PRs append after it (0021_ai_usage_by_provider, 0022_cloudflare_connection); it stays after 0019.
		const at = AUTH_MIGRATION_NAMES.indexOf("0020_import_credentials");
		expect(at).toBeGreaterThan(AUTH_MIGRATION_NAMES.indexOf("0019_ai_usage_and_budget"));
		expect(AUTH_MIGRATION_NAMES.indexOf("0021_ai_usage_by_provider")).toBe(at + 1);
	});
});

describe("ingestRawMessage", () => {
	it("falls back to the given arrival date when the Date header is missing", async () => {
		const env = setup();
		const raw = bytes(message({ messageId: "nodate@x" }).replace(/^Date: .*\n/m, ""));
		const r = await ingestRawMessage(raw, {
			ctx: env.ctx,
			bucket: env.bucket,
			mailbox: MAILBOX,
			defaultFolder: "archive",
			fallbackDate: new Date("2011-05-05T05:05:05Z"),
		});
		expect(r.outcome).toBe("imported");
		expect(rows(env)[0].date).toBe("2011-05-05T05:05:05.000Z");
	});
});
