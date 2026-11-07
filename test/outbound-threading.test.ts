// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * A Gmail reply to mail we sent lands in the same conversation.
 *
 * Cloudflare Email Service refuses a caller-set `Message-ID` and assigns its
 * own; `send()` returns it as `messageId`. Checked against production on
 * 2026-10-25: a message sent from tech@tapetide.com arrived in Gmail with
 *
 *     Message-ID: <YETKMAanSUygiYOrC7Hr9jPqcj2Qs1lhsKax@tapetide.com>
 *
 * and the mailbox's stored `message_id` for that row was exactly
 * `YETKMAanSUygiYOrC7Hr9jPqcj2Qs1lhsKax@tapetide.com`. (The `VmtA…@tapetide.com`
 * id seen in the audit is the same shape — Cloudflare's, not one we minted; ours
 * are `<uuid>@domain` and only live on the row until `recordDelivery` replaces
 * them.)
 *
 * This test walks the whole loop on real SQLite: write the Sent row with our
 * provisional id, record the provider's id, then parse a Gmail-shaped reply
 * with postal-mime and resolve its thread the way `receiveEmail` does.
 */

import { DatabaseSync } from "node:sqlite";
import PostalMime from "postal-mime";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, mailboxMigrations } from "../workers/durableObject/migrations";
import { recordDelivery } from "../workers/durableObject/features";
import { findThreadByMessageIds } from "../workers/durableObject/references";
import { parseMessageIdList, threadCandidates } from "../shared/message-ids";
import { buildOutgoingHeaders, buildReferencesChain, generateMessageId } from "../workers/lib/email-helpers";
import type { EmailFull } from "../workers/lib/schemas";

const PROVIDER_ID = "YETKMAanSUygiYOrC7Hr9jPqcj2Qs1lhsKax@tapetide.com";

function makeCtx(db: DatabaseSync): DurableObjectState {
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

let db: DatabaseSync;
let ctx: DurableObjectState;

beforeEach(() => {
	db = new DatabaseSync(":memory:");
	ctx = makeCtx(db);
	applyMigrations(ctx.storage.sql as never, mailboxMigrations, ctx.storage as never);
});

function insertSent(id: string, messageId: string, threadId = id) {
	db.prepare(
		`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, message_id, thread_id, delivery_status)
		 VALUES (?, 'sent', 'Tapetide QA test', 'tech@tapetide.com', 'alex@example.net',
		         '2026-10-25T13:01:10.578Z', '<p>Hi</p>', ?, ?, 'queued')`,
	).run(id, messageId, threadId);
}

/** A reply as Gmail composes it: CRLF, folded References, its own Message-ID. */
function gmailReply(inReplyTo: string, references: string[]): string {
	return [
		"Delivered-To: tech@tapetide.com",
		"From: Hitesh <alex@example.net>",
		"To: Tapetide tech team <tech@tapetide.com>",
		"Subject: Re: Tapetide QA test",
		"Date: Sun, 25 Oct 2026 19:02:11 +0530",
		"Message-ID: <CAF=x9q+reply01@mail.gmail.com>",
		`In-Reply-To: <${inReplyTo}>`,
		`References: ${references.map((r) => `<${r}>`).join("\r\n ")}`,
		"MIME-Version: 1.0",
		'Content-Type: text/plain; charset="UTF-8"',
		"",
		"Got it, thanks.",
		"",
		`On Sun, 25 Oct 2026 at 18:31, Tapetide tech team <tech@tapetide.com> wrote:`,
		"> Hi",
		"",
	].join("\r\n");
}

async function threadOfReply(raw: string): Promise<string | null> {
	const parsed = await PostalMime.parse(raw);
	const { candidates } = threadCandidates({
		inReplyTo: parsed.inReplyTo,
		references: parsed.references,
	});
	return findThreadByMessageIds(ctx, candidates);
}

describe("outbound Message-ID round trip", () => {
	it("a Gmail reply to our sent mail joins its thread once the provider id is recorded", async () => {
		const { messageId, outgoingMessageId } = generateMessageId("tapetide.com");
		insertSent(messageId, outgoingMessageId);

		// Before the write-back, Gmail's citation matches nothing we hold.
		expect(await threadOfReply(gmailReply(PROVIDER_ID, [PROVIDER_ID]))).toBeNull();

		// `send()` returned the id Cloudflare put in the Message-ID header.
		recordDelivery(ctx, messageId, { providerMessageId: PROVIDER_ID });
		const row = db
			.prepare(`SELECT message_id, delivery_status FROM emails WHERE id = ?`)
			.get(messageId) as { message_id: string; delivery_status: string };
		expect(row).toEqual({ message_id: PROVIDER_ID, delivery_status: "sent" });

		expect(await threadOfReply(gmailReply(PROVIDER_ID, [PROVIDER_ID]))).toBe(messageId);
	});

	it("accepts the provider id with or without angle brackets", async () => {
		insertSent("row-1", "provisional@tapetide.com");
		recordDelivery(ctx, "row-1", { providerMessageId: `<${PROVIDER_ID}>` });
		expect(await threadOfReply(gmailReply(PROVIDER_ID, [PROVIDER_ID]))).toBe("row-1");
	});

	it("threads a reply-to-a-reply onto the original conversation", async () => {
		// Our first message, then our reply in the same thread.
		insertSent("first", "VmtAYZlN7shOZrY09XG4aCgFQEya5C1aawAZ@tapetide.com", "thread-1");
		insertSent("second", "provisional@tapetide.com", "thread-1");
		recordDelivery(ctx, "second", { providerMessageId: PROVIDER_ID });

		const raw = gmailReply(PROVIDER_ID, [
			"VmtAYZlN7shOZrY09XG4aCgFQEya5C1aawAZ@tapetide.com",
			"CAF=earlier@mail.gmail.com",
			PROVIDER_ID,
		]);
		expect(await threadOfReply(raw)).toBe("thread-1");
	});

	it("falls back to an older ancestor when the parent is unknown", async () => {
		insertSent("first", "VmtAYZlN7shOZrY09XG4aCgFQEya5C1aawAZ@tapetide.com", "thread-1");
		const raw = gmailReply("unknown@mail.gmail.com", [
			"VmtAYZlN7shOZrY09XG4aCgFQEya5C1aawAZ@tapetide.com",
			"unknown@mail.gmail.com",
		]);
		expect(await threadOfReply(raw)).toBe("thread-1");
	});
});

describe("our replies cite the right ids", () => {
	it("a reply to an inbound Gmail message sends its Message-ID and full chain", () => {
		const original: EmailFull = {
			id: "local-row",
			message_id: "CAF=x9q+reply01@mail.gmail.com",
			email_references: JSON.stringify([PROVIDER_ID]),
			thread_id: "thread-1",
			subject: "Re: Tapetide QA test",
			sender: "alex@example.net",
			recipient: "tech@tapetide.com",
			date: "2026-10-25T13:32:11.000Z",
			read: true,
			starred: false,
		};
		const { originalMsgId, references, threadId } = buildReferencesChain(original);
		const headers = buildOutgoingHeaders({ inReplyTo: originalMsgId, references });
		expect(headers).toEqual({
			"In-Reply-To": "<CAF=x9q+reply01@mail.gmail.com>",
			References: `<${PROVIDER_ID}> <CAF=x9q+reply01@mail.gmail.com>`,
		});
		expect(threadId).toBe("thread-1");
		expect(headers).not.toHaveProperty("Message-ID");
	});

	it("a follow-up to our own sent message cites the provider id, not our provisional one", () => {
		const { messageId, outgoingMessageId } = generateMessageId("tapetide.com");
		insertSent(messageId, outgoingMessageId);
		recordDelivery(ctx, messageId, { providerMessageId: PROVIDER_ID });
		const stored = db.prepare(`SELECT * FROM emails WHERE id = ?`).get(messageId) as unknown as EmailFull;
		const { originalMsgId } = buildReferencesChain(stored);
		expect(originalMsgId).toBe(PROVIDER_ID);
		expect(originalMsgId).not.toBe(outgoingMessageId);
	});
});

describe("parseMessageIdList", () => {
	it("reads unspaced, folded and bracketless lists", () => {
		expect(parseMessageIdList("<a@b><c@d>")).toEqual(["a@b", "c@d"]);
		expect(parseMessageIdList("<a@b>\r\n <c@d>")).toEqual(["a@b", "c@d"]);
		expect(parseMessageIdList("a@b c@d")).toEqual(["a@b", "c@d"]);
		expect(parseMessageIdList("")).toEqual([]);
	});

	it("orders candidates nearest first, without duplicates", () => {
		expect(
			threadCandidates({ inReplyTo: "<p@x>", references: "<root@x> <mid@x> <p@x>" }).candidates,
		).toEqual(["p@x", "mid@x", "root@x"]);
	});
});
