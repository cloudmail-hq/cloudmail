import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	handleForwardEmail,
	handleReplyEmail,
} from "../workers/routes/reply-forward";
import type { EmailFull } from "../workers/lib/schemas";
import { isSendableHeader } from "../shared/email-headers";

/**
 * The original inbound message we reply to / forward. It is already the second
 * message in a conversation, so it carries a references chain we must extend
 * rather than discard.
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

type Captured = {
	folder?: string;
	email?: Record<string, unknown>;
	sent?: Record<string, unknown>;
	threadsMarkedRead: string[];
	status?: number;
};

function makeContext(body: Record<string, unknown>) {
	const captured: Captured = { threadsMarkedRead: [] };

	const stub = {
		getEmail: vi.fn(async () => ORIGINAL),
		createEmail: vi.fn(async (folder: string, email: Record<string, unknown>) => {
			captured.folder = folder;
			captured.email = email;
		}),
		markThreadRead: vi.fn(async (threadId: string) => {
			captured.threadsMarkedRead.push(threadId);
		}),
		checkSendRateLimit: vi.fn(async () => null),
	};

	const c = {
		req: {
			param: (name: string) =>
				({ mailboxId: "hello@tapetide.com", id: ORIGINAL.id })[name],
			json: async () => body,
		},
		var: {
			mailboxStub: stub,
			/**
			 * These tests predate per-mailbox capabilities and exercise threading,
			 * not authorization. An unrestricted principal is what an admin — or any
			 * caller on a deployment with enforcement off — resolves to, so the send
			 * paths behave exactly as they did before capabilities existed.
			 */
			principal: {
				identity: { kind: "user", id: "owner@tapetide.com", subject: "uuid-1" },
				role: "admin",
				mailboxes: null,
				access: null,
				enforced: false,
				developmentBypass: false,
			},
		},
		env: {
			BUCKET: { put: vi.fn(async () => undefined) },
			EMAIL: {
				send: vi.fn(async (message: Record<string, unknown>) => {
					captured.sent = message;
					return { messageId: "provider-id" };
				}),
			},
		},
		executionCtx: { waitUntil: (p: Promise<unknown>) => p },
		json: (payload: unknown, status?: number) => {
			captured.status = status;
			return { payload, status };
		},
	};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return { c: c as any, captured, stub };
}

const BASE_BODY = {
	to: "bob@other.example",
	from: "hello@tapetide.com",
	subject: "Fwd: Q3 budget",
	html: "<p>FYI</p>",
};

describe("forward", () => {
	let ctx: ReturnType<typeof makeContext>;

	beforeEach(async () => {
		ctx = makeContext(BASE_BODY);
		await handleForwardEmail(ctx.c);
	});

	it("stays in the original conversation instead of starting a new thread", () => {
		// Regression: previously wrote thread_id = <its own new id>, splitting
		// every forward into an orphan thread in the Sent folder.
		expect(ctx.captured.email?.thread_id).toBe("root@sender.example");
		expect(ctx.captured.email?.thread_id).not.toBe(ctx.captured.email?.id);
	});

	it("records the local threading columns", () => {
		expect(ctx.captured.email?.in_reply_to).toBe("original@sender.example");
		expect(JSON.parse(String(ctx.captured.email?.email_references))).toEqual([
			"root@sender.example",
			"original@sender.example",
		]);
	});

	it("sends RFC 5322 threading headers so the recipient's client threads it", () => {
		// Regression: forward previously sent no headers at all.
		expect(ctx.captured.sent?.headers).toMatchObject({
			"In-Reply-To": "<original@sender.example>",
			References: "<root@sender.example> <original@sender.example>",
		});
	});

	it("does NOT send a Message-ID — the provider rejects one and fails the send", () => {
		/**
		 * This test previously asserted the opposite, and that is what took outgoing
		 * mail down completely. Sending our own `Message-ID` looked like the fix for
		 * a real threading problem, but Email Service generates that header itself
		 * and refuses any attempt to set it, failing the entire message:
		 *
		 *     custom header 'Message-ID' is not allowed.
		 *
		 * Threading is preserved a different way: the provider's id is written back
		 * onto the row by `recordDelivery` once `send()` returns, so the id an
		 * inbound reply cites is the id we hold. See the delivery-outcome tests.
		 */
		expect(ctx.captured.sent?.headers ?? {}).not.toHaveProperty("Message-ID");
	});

	it("sends only headers Email Service will accept", () => {
		// The invariant that generalises past this one header: anything this path
		// puts on the wire must survive the provider's allowlist.
		for (const name of Object.keys(ctx.captured.sent?.headers ?? {})) {
			expect(isSendableHeader(name), `${name} would be rejected`).toBe(true);
		}
	});

	it("persists the same threading headers on the stored copy", () => {
		const headers = JSON.parse(String(ctx.captured.email?.raw_headers)) as {
			key: string;
			value: string;
		}[];
		const byKey = Object.fromEntries(headers.map((h) => [h.key, h.value]));
		expect(byKey["in-reply-to"]).toBe("<original@sender.example>");
		expect(byKey.references).toBe(
			"<root@sender.example> <original@sender.example>",
		);
	});

	it("files the copy in Sent and returns 202", () => {
		expect(ctx.captured.folder).toBe("sent");
		expect(ctx.captured.status).toBe(202);
	});

	it("does not mark the conversation read", () => {
		// Forwarding a message says nothing about having read the thread.
		expect(ctx.captured.threadsMarkedRead).toEqual([]);
	});
});

describe("reply", () => {
	it("threads onto the original and marks the conversation read", async () => {
		const ctx = makeContext({ ...BASE_BODY, subject: "Re: Q3 budget" });
		await handleReplyEmail(ctx.c);

		expect(ctx.captured.email?.thread_id).toBe("root@sender.example");
		expect(ctx.captured.sent?.headers).toMatchObject({
			"In-Reply-To": "<original@sender.example>",
			References: "<root@sender.example> <original@sender.example>",
		});
		// No Message-ID on the wire: the provider generates it and rejects ours.
		expect(ctx.captured.sent?.headers ?? {}).not.toHaveProperty("Message-ID");
		expect(ctx.captured.threadsMarkedRead).toEqual(["root@sender.example"]);
	});
});

describe("shared send guards", () => {
	it("returns 404 when the original is gone", async () => {
		const ctx = makeContext(BASE_BODY);
		ctx.stub.getEmail.mockResolvedValueOnce(null as unknown as EmailFull);
		const res = await handleForwardEmail(ctx.c);
		expect(res.status).toBe(404);
	});

	it("rejects a from address that is not the mailbox", async () => {
		const ctx = makeContext({ ...BASE_BODY, from: "spoofed@elsewhere.example" });
		const res = await handleForwardEmail(ctx.c);
		expect(res.status).toBe(400);
	});

	it("surfaces the rate limit before sending", async () => {
		const ctx = makeContext(BASE_BODY);
		ctx.stub.checkSendRateLimit.mockResolvedValueOnce("Rate limit exceeded");
		const res = await handleForwardEmail(ctx.c);
		expect(res.status).toBe(429);
		expect(ctx.captured.sent).toBeUndefined();
	});

	it("rejects an oversized message with 413 and never files it in Sent", async () => {
		// The critical part: nothing is written to Sent and nothing is handed to
		// the email binding. Previously the message was stored, 202 returned, and
		// the platform rejection only appeared in Worker logs.
		const ctx = makeContext({
			...BASE_BODY,
			attachments: [
				{
					content: "A".repeat(6 * 1024 * 1024),
					filename: "huge.pdf",
					type: "application/pdf",
					disposition: "attachment",
				},
			],
		});
		const res = await handleForwardEmail(ctx.c);
		expect(res.status).toBe(413);
		expect(ctx.stub.createEmail).not.toHaveBeenCalled();
		expect(ctx.captured.sent).toBeUndefined();
	});

	it("checks size before consuming the rate limit budget", async () => {
		const ctx = makeContext({
			...BASE_BODY,
			attachments: [
				{
					content: "A".repeat(6 * 1024 * 1024),
					filename: "huge.pdf",
					type: "application/pdf",
					disposition: "attachment",
				},
			],
		});
		await handleForwardEmail(ctx.c);
		expect(ctx.stub.checkSendRateLimit).not.toHaveBeenCalled();
	});
});
