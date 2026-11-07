import { describe, expect, it } from "vitest";
import { ApprovalChangedError, ConflictError, RateLimitError, ServerError, isPendingApproval } from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

const MBX = "agent@example.com";
const BASE = "https://mail.example.com/api/v1/mailboxes/agent%40example.com";

describe("approvals: revise and approve with a revision", () => {
	it("revises with the PATCH body and returns the approval", async () => {
		const m = mockFetch(() => json(200, { approval: { id: "a1", status: "pending", revision: 2, revised_by: "requester" } }));
		const a = await client(m.fetch).approvals.revise(MBX, "a1", { subject: "Fixed", html: "<p>v2</p>", to: ["x@y.com"] });
		expect(a.revision).toBe(2);
		expect(m.calls[0]!.method).toBe("POST");
		expect(m.calls[0]!.url).toBe(`${BASE}/approvals/a1/revise`);
		expect(m.calls[0]!.body).toEqual({ subject: "Fixed", html: "<p>v2</p>", to: ["x@y.com"] });
		expect(m.calls[0]!.headers["idempotency-key"]).toBeUndefined();
	});

	it("does not retry a revise (it is not keyed)", async () => {
		const m = mockFetch(() => json(503, { error: "down" }));
		await expect(client(m.fetch).approvals.revise(MBX, "a1", { subject: "x" })).rejects.toBeInstanceOf(ServerError);
		expect(m.calls).toHaveLength(1);
	});

	it("sends the revision on approve and no body without one", async () => {
		const m = mockFetch(() => json(200, { approval: { id: "a1", status: "sent" }, result: {} }));
		const t = client(m.fetch);
		await t.approvals.approve(MBX, "a1", { revision: 3 });
		await t.approvals.approve(MBX, "a1");
		expect(m.calls[0]!.body).toEqual({ revision: 3 });
		expect(m.calls[1]!.body).toBeUndefined();
		expect(m.calls[0]!.headers["idempotency-key"]).toBeDefined();
	});

	it("throws ApprovalChangedError when a newer revision exists, with the new version", async () => {
		const m = mockFetch(() =>
			json(409, { error: "It was changed after you opened it. Nothing was sent.", approval: { id: "a1", status: "pending", revision: 4 } }),
		);
		const err = await client(m.fetch).approvals.approve(MBX, "a1", { revision: 3 }).catch((e) => e);
		expect(err).toBeInstanceOf(ApprovalChangedError);
		expect(err).toBeInstanceOf(ConflictError);
		expect(err.status).toBe(409);
		expect(err.approval.revision).toBe(4);
		expect(m.calls).toHaveLength(1);
	});

	it("keeps a plain ConflictError for an already-decided approval", async () => {
		const m = mockFetch(() => json(409, { error: "Already sent; nothing was sent again.", approval: { id: "a1", status: "sent" } }));
		const err = await client(m.fetch).approvals.approve(MBX, "a1").catch((e) => e);
		expect(err).toBeInstanceOf(ConflictError);
		expect(err).not.toBeInstanceOf(ApprovalChangedError);
	});

	it("runs the agent flow: send, held, revise, poll until decided", async () => {
		const pending = { id: "a1", status: "pending", revision: 1 };
		const m = mockFetch(
			() => json(202, { status: "pending_approval", approval_id: "a1", approval_url: "https://mail.example.com/x", reason: "approval_required" }),
			() => json(200, { approval: { ...pending, revision: 2 } }),
			() => json(200, { approval: { ...pending, revision: 2 } }),
			() => json(200, { approval: { ...pending, revision: 2, status: "sent" } }),
		);
		const t = client(m.fetch);
		const res = await t.mail.send(MBX, { to: "c@d.com", subject: "Hi", html: "<p>v1</p>" });
		expect(isPendingApproval(res)).toBe(true);
		if (!isPendingApproval(res)) return;
		await t.approvals.revise(MBX, res.approval_id, { html: "<p>v2</p>" });
		const sleeps: number[] = [];
		const final = await t.approvals.waitForDecision(MBX, res.approval_id, { intervalMs: 7, sleep: async (ms) => void sleeps.push(ms) });
		expect(final.status).toBe("sent");
		expect(sleeps).toEqual([7]);
		expect(m.calls.map((c) => `${c.method} ${new URL(c.url).pathname.split("/").slice(-2).join("/")}`)).toEqual([
			"POST agent%40example.com/emails",
			"POST a1/revise",
			"GET approvals/a1",
			"GET approvals/a1",
		]);
	});

	it("waitForDecision stops at the timeout with the pending approval", async () => {
		const m = mockFetch(() => json(200, { approval: { id: "a1", status: "pending" } }));
		const a = await client(m.fetch).approvals.waitForDecision(MBX, "a1", { timeoutMs: 0, sleep: async () => {} });
		expect(a.status).toBe("pending");
		expect(m.calls).toHaveLength(1);
	});
});

describe("errors", () => {
	it("exposes retryAfter on a 429 that ran out of retries", async () => {
		const m = mockFetch(() => json(429, { error: "Over the hourly send cap", code: "send_cap" }, { "Retry-After": "120" }));
		const err = await client(m.fetch, { maxRetries: 0 }).labels.list(MBX).catch((e) => e);
		expect(err).toBeInstanceOf(RateLimitError);
		expect(err.retryAfter).toBe(120);
		expect(err.code).toBe("send_cap");
		expect(err.message).toBe("Over the hourly send cap");
	});

	it("is null without a header", async () => {
		const m = mockFetch(() => json(429, { error: "slow" }));
		const err = await client(m.fetch, { maxRetries: 0 }).labels.list(MBX).catch((e) => e);
		expect(err.retryAfter).toBeNull();
	});
});

describe("new resources", () => {
	it("encodes path params and query", async () => {
		const m = mockFetch(() => json(200, { emails: [], totalCount: 0 }));
		await client(m.fetch).labels.emails(MBX, "lbl/1", { unread: true, page: 2 });
		expect(m.calls[0]!.url).toBe(`${BASE}/labels/lbl%2F1/emails?unread=true&page=2`);
	});

	it("returns void for 204 deletes", async () => {
		const m = mockFetch(() => new Response(null, { status: 204 }));
		await expect(client(m.fetch).rules.delete(MBX, "r1")).resolves.toBeUndefined();
		expect(m.calls[0]!.method).toBe("DELETE");
	});

	it("uploads an import part as raw bytes", async () => {
		const seen: { type?: string; body?: unknown } = {};
		const fetch = async (_url: string, init: RequestInit) => {
			seen.type = new Headers(init.headers).get("content-type") ?? undefined;
			seen.body = init.body;
			return json(200, { id: "i1", status: "uploading" });
		};
		const bytes = new Uint8Array([1, 2, 3]);
		await client(fetch).imports.uploadPart(MBX, "i1", 2, bytes);
		expect(seen.type).toBe("application/octet-stream");
		expect(seen.body).toBe(bytes);
	});

	it("hands back a download unread", async () => {
		const m = mockFetch(() => new Response("From x\n", { status: 200, headers: { "Content-Type": "application/mbox" } }));
		const res = await client(m.fetch).mailboxes.export(MBX);
		expect(res.headers.get("content-type")).toBe("application/mbox");
		expect(await res.text()).toBe("From x\n");
	});

	it("throws on a failed download", async () => {
		const m = mockFetch(() => json(404, { error: "Attachment not found" }));
		await expect(client(m.fetch).mail.attachment(MBX, "e1", "att1")).rejects.toMatchObject({ status: 404, message: "Attachment not found" });
	});

	it("keys and does not retry 5xx on scheduled, template and sequence sends", async () => {
		const m = mockFetch(() => json(502, { error: "upstream" }));
		const t = client(m.fetch);
		await t.scheduledSends.schedule(MBX, { to: "a@b.com", subject: "x", text: "y", delay_seconds: 60 }).catch(() => {});
		await t.templates.send(MBX, { template: "welcome", recipients: [{ email: "a@b.com" }] }).catch(() => {});
		await t.sequences.enroll("seq1", { personId: "p", personEmail: "a@b.com", fromAddress: MBX }).catch(() => {});
		await t.scheduledSends.sendNow(MBX, "e1").catch(() => {});
		expect(m.calls).toHaveLength(4);
		for (const c of m.calls) expect(c.headers["idempotency-key"]).toBeDefined();
		expect((m.calls[0]!.body as { from: string }).from).toBe(MBX);
	});

	it("sends the migration token header", async () => {
		const m = mockFetch(() => json(200, { mailboxId: MBX }));
		await client(m.fetch).migration.status(MBX, { migrationToken: "mig" });
		expect(m.calls[0]!.headers["x-migration-token"]).toBe("mig");
	});
});
