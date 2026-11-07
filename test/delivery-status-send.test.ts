// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * `delivery_status` on a fresh send: queued → sent (with the provider id) or
 * failed (with a friendly reason and the `E_*` code), through the real reply /
 * forward route handler and the real `recordDelivery` SQL.
 *
 * The production audit found `delivery_status` NULL on freshly sent mail, so an
 * API caller could not tell "accepted by Cloudflare" from "never attempted".
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, mailboxMigrations } from "../workers/durableObject/migrations";
import { recordDelivery } from "../workers/durableObject/features";
import { handleReplyEmail } from "../workers/routes/reply-forward";
import type { EmailFull } from "../workers/lib/schemas";

const ORIGINAL: EmailFull = {
	id: "orig",
	message_id: "CAF=orig@mail.gmail.com",
	subject: "Question",
	sender: "alice@example.com",
	recipient: "hello@tapetide.com",
	date: "2026-10-25T09:00:00.000Z",
	read: true,
	starred: false,
	thread_id: "orig",
	folder_id: "inbox",
	body: "<p>Hi</p>",
};

let db: DatabaseSync;
let ctx: DurableObjectState;

function makeCtx(): DurableObjectState {
	const cursor = (rows: Record<string, unknown>[], rowsWritten = 0) => ({
		toArray: () => rows,
		one: () => rows[0],
		rowsWritten,
		[Symbol.iterator]: () => rows[Symbol.iterator](),
	});
	return {
		storage: {
			sql: {
				exec(query: string, ...bindings: unknown[]) {
					if (bindings.length === 0 && /;\s*\S/.test(query)) {
						db.exec(query);
						return cursor([]);
					}
					const stmt = db.prepare(query);
					if (/^\s*(SELECT|WITH)\b/i.test(query)) {
						return cursor(stmt.all(...(bindings as never[])) as Record<string, unknown>[]);
					}
					return cursor([], Number(stmt.run(...(bindings as never[])).changes ?? 0));
				},
			},
			transactionSync: <T>(fn: () => T) => fn(),
		},
	} as unknown as DurableObjectState;
}

beforeEach(() => {
	db = new DatabaseSync(":memory:");
	ctx = makeCtx();
	applyMigrations(ctx.storage.sql as never, mailboxMigrations, ctx.storage as never);
});

/**
 * A stub whose `createEmail` and `recordDelivery` write to real SQLite with the
 * same columns the Durable Object writes, so the status the test reads is what
 * a list or detail request would return.
 */
function stub() {
	return {
		getEmail: vi.fn(async () => ORIGINAL),
		markThreadRead: vi.fn(async () => undefined),
		checkSendRateLimit: vi.fn(async () => null),
		createEmail: vi.fn(async (folder: string, email: Record<string, unknown>) => {
			db.prepare(
				`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, message_id, thread_id, delivery_status)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				email.id as string,
				folder,
				email.subject as string,
				email.sender as string,
				email.recipient as string,
				email.date as string,
				email.body as string,
				email.message_id as string,
				email.thread_id as string,
				(email.delivery_status as string | undefined) ?? null,
			);
		}),
		recordDelivery: vi.fn(async (id: string, outcome: { providerMessageId?: string; error?: string }) =>
			recordDelivery(ctx, id, outcome),
		),
	};
}

function context(body: Record<string, unknown>, send: (m: unknown) => Promise<{ messageId: string }>) {
	const pending: Promise<unknown>[] = [];
	const s = stub();
	const c = {
		req: {
			param: (name: string) => ({ mailboxId: "hello@tapetide.com", id: ORIGINAL.id })[name],
			json: async () => body,
		},
		var: {
			mailboxStub: s,
			principal: {
				identity: { kind: "user", id: "owner@tapetide.com", subject: "u" },
				role: "admin",
				mailboxes: null,
				access: null,
				enforced: false,
				developmentBypass: false,
			},
		},
		env: { BUCKET: { put: vi.fn() }, EMAIL: { send: vi.fn(send) } },
		executionCtx: { waitUntil: (p: Promise<unknown>) => pending.push(p) },
		json: (payload: unknown, status?: number) => ({ payload, status }),
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return { c: c as any, stub: s, settle: () => Promise.all(pending) };
}

const BODY = {
	to: "alice@example.com",
	from: { email: "hello@tapetide.com", name: "Tapetide" },
	subject: "Re: Question",
	html: "<p>Answer</p>",
};

function rowFor(id: string) {
	return db
		.prepare(`SELECT folder_id, message_id, delivery_status, delivery_error FROM emails WHERE id = ?`)
		.get(id) as {
		folder_id: string;
		message_id: string;
		delivery_status: string | null;
		delivery_error: string | null;
	};
}

describe("fresh send delivery_status", () => {
	it("is queued before the provider answers, then sent with Cloudflare's messageId", async () => {
		let release!: (v: { messageId: string }) => void;
		const ctxt = context(BODY, () => new Promise((r) => (release = r)));
		const res = (await handleReplyEmail(ctxt.c)) as { payload: { id: string }; status: number };
		expect(res.status).toBe(202);

		const id = res.payload.id;
		expect(rowFor(id).delivery_status).toBe("queued");
		expect(rowFor(id).message_id).toMatch(/@tapetide\.com$/);

		release({ messageId: "<YETKMAanSUygiYOrC7Hr9jPqcj2Qs1lhsKax@tapetide.com>" });
		await ctxt.settle();
		expect(rowFor(id)).toEqual({
			folder_id: "sent",
			message_id: "YETKMAanSUygiYOrC7Hr9jPqcj2Qs1lhsKax@tapetide.com",
			delivery_status: "sent",
			delivery_error: null,
		});
		const events = db
			.prepare(`SELECT event_type, provider_message_id FROM delivery_events WHERE email_id = ?`)
			.all(id);
		expect(events).toEqual([
			{ event_type: "sent", provider_message_id: "YETKMAanSUygiYOrC7Hr9jPqcj2Qs1lhsKax@tapetide.com" },
		]);
	});

	it("is failed with a friendly reason and the code when the binding throws", async () => {
		const ctxt = context(BODY, async () => {
			throw Object.assign(new Error("recipient suppressed"), { code: "E_RECIPIENT_SUPPRESSED" });
		});
		const res = (await handleReplyEmail(ctxt.c)) as { payload: { id: string }; status: number };
		await ctxt.settle();

		const row = rowFor(res.payload.id);
		expect(row.delivery_status).toBe("failed");
		expect(row.delivery_error).toBe(
			"A recipient is on the suppression list after an earlier bounce or complaint, so Cloudflare didn't send to them. (E_RECIPIENT_SUPPRESSED)",
		);
		// Still in Sent, where the user watched it go.
		expect(row.folder_id).toBe("sent");
	});

	it("refuses 51 recipients with a 400 before storing or sending", async () => {
		const send = vi.fn(async () => ({ messageId: "x" }));
		const ctxt = context(
			{
				...BODY,
				to: Array.from({ length: 40 }, (_, i) => `t${i}@example.com`),
				cc: Array.from({ length: 11 }, (_, i) => `c${i}@example.com`),
			},
			send,
		);
		const res = (await handleReplyEmail(ctxt.c)) as {
			payload: { error: string; code: string };
			status: number;
		};
		expect(res.status).toBe(400);
		expect(res.payload.code).toBe("E_TOO_MANY_RECIPIENTS");
		expect(ctxt.stub.createEmail).not.toHaveBeenCalled();
		expect(ctxt.stub.checkSendRateLimit).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});

	it("refuses 33 attachments with a 400", async () => {
		const ctxt = context(
			{
				...BODY,
				attachments: Array.from({ length: 33 }, (_, i) => ({
					content: "QQ==",
					filename: `f${i}.txt`,
					type: "text/plain",
					disposition: "attachment",
				})),
			},
			async () => ({ messageId: "x" }),
		);
		const res = (await handleReplyEmail(ctxt.c)) as { payload: { code: string }; status: number };
		expect(res.status).toBe(400);
		expect(res.payload.code).toBe("E_TOO_MANY_ATTACHMENTS");
	});
});
