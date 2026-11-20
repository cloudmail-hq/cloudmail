// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for `resolveThreadedSend`, which decides how an outgoing message
 * attaches to an existing conversation.
 *
 * This matters most on the scheduled-send path, because Undo Send routes every
 * ordinary send through it. A dropped `References` chain is invisible locally —
 * the thread still looks right in our own Sent folder — and only shows up as the
 * recipient seeing each reply as a brand new conversation.
 */

import { describe, expect, it, vi } from "vitest";
import { resolveThreadedSend } from "../workers/lib/email-helpers";
import type { EmailFull } from "../workers/lib/schemas";

/**
 * Second message in an existing conversation, so it already carries a chain we
 * have to extend rather than replace.
 */
const ORIGINAL: EmailFull = {
	id: "local-uuid-original",
	message_id: "original@sender.example",
	subject: "Q3 budget",
	sender: "alice@sender.example",
	recipient: "hello@tapetide.com",
	cc: null,
	bcc: null,
	date: "2026-08-10T09:30:00.000Z",
	read: false,
	starred: false,
	in_reply_to: "root@sender.example",
	email_references: JSON.stringify(["root@sender.example"]),
	thread_id: "root@sender.example",
	folder_id: "inbox",
	body: "<p>Numbers attached.</p>",
};

/**
 * Stub of the one Durable Object method this path uses, answering the queued
 * emails in call order.
 *
 * `getEmailByRef` rather than `getEmail`: a reference can name its target by row
 * id or by RFC `Message-ID`, and the resolver has to accept both — see
 * workers/durableObject/references.ts. Which one is stubbed here is what tells
 * these tests apart from a resolver that only ever looked up row ids.
 */
function makeStub(...emails: (EmailFull | null)[]) {
	const getEmailByRef = vi.fn();
	for (const email of emails) getEmailByRef.mockResolvedValueOnce(email);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return { getEmailByRef } as any;
}

describe("resolveThreadedSend", () => {
	it("extends the existing References chain rather than restarting it", async () => {
		const result = await resolveThreadedSend(
			makeStub(ORIGINAL),
			ORIGINAL.id,
			"reply",
		);

		expect(result).not.toBeNull();
		expect(result?.inReplyTo).toBe("original@sender.example");
		// Ancestry must be oldest-first and include the message being answered.
		expect(result?.references).toEqual([
			"root@sender.example",
			"original@sender.example",
		]);
		expect(result?.threadId).toBe("root@sender.example");
	});

	it("marks the thread read for a reply", async () => {
		const result = await resolveThreadedSend(
			makeStub(ORIGINAL),
			ORIGINAL.id,
			"reply",
		);
		expect(result?.markThreadRead).toBe("root@sender.example");
	});

	it("does not mark the thread read for a forward", async () => {
		// Forwarding a message says nothing about having read the conversation.
		const result = await resolveThreadedSend(
			makeStub(ORIGINAL),
			ORIGINAL.id,
			"forward",
		);
		expect(result?.markThreadRead).toBeNull();
		// Threading is still applied — a forward stays in the source conversation.
		expect(result?.threadId).toBe("root@sender.example");
	});

	it("threads against the real original when handed a draft reply", async () => {
		// Drafts point at what they answer via in_reply_to. Threading against the
		// draft itself would attach the message to a conversation of one.
		const draft: EmailFull = {
			...ORIGINAL,
			id: "local-uuid-draft",
			message_id: null,
			folder_id: "draft",
			in_reply_to: ORIGINAL.id,
			email_references: null,
			thread_id: "local-uuid-draft",
		};

		const stub = makeStub(draft, ORIGINAL);
		const result = await resolveThreadedSend(stub, draft.id, "reply");

		expect(stub.getEmailByRef).toHaveBeenCalledTimes(2);
		expect(result?.inReplyTo).toBe("original@sender.example");
		expect(result?.threadId).toBe("root@sender.example");
	});

	it("starts a chain when the original has no ancestry of its own", async () => {
		const firstInThread: EmailFull = {
			...ORIGINAL,
			in_reply_to: null,
			email_references: null,
			thread_id: null,
		};

		const result = await resolveThreadedSend(
			makeStub(firstInThread),
			firstInThread.id,
			"reply",
		);

		expect(result?.references).toEqual(["original@sender.example"]);
		// With no thread_id recorded, the original's local id anchors the thread.
		expect(result?.threadId).toBe(firstInThread.id);
	});

	it("tolerates a malformed references column", async () => {
		const corrupt: EmailFull = {
			...ORIGINAL,
			email_references: "{not json",
		};

		const result = await resolveThreadedSend(
			makeStub(corrupt),
			corrupt.id,
			"reply",
		);

		// Better to send a shorter chain than to fail the send outright.
		expect(result?.references).toEqual(["original@sender.example"]);
	});

	it("reports a missing original instead of sending unthreaded", async () => {
		const result = await resolveThreadedSend(makeStub(null), "gone", "reply");
		expect(result).toBeNull();
	});
});
