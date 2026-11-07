import { describe, expect, it } from "vitest";
import {
	APIConnectionError,
	AuthenticationError,
	ConflictError,
	IDEMPOTENT_POST_PATHS,
	NotFoundError,
	PermissionDeniedError,
	RateLimitError,
	ServerError,
	TapetideError,
	ValidationError,
	buildQuery,
	isPendingApproval,
	retryAfterMs,
	type PendingApproval,
	type SendAccepted,
} from "../src/index.js";
import { client, json, mockFetch } from "./helpers.js";

const SENT: SendAccepted = { id: "m_1", status: "sent" };
const HELD: PendingApproval = {
	status: "pending_approval",
	approval_id: "apr_1",
	approval_url: "https://mail.example.com/mailbox/support%40example.com/approvals/apr_1",
	reason: "approval_required",
};

describe("request shapes", () => {
	it("sends mail with auth, JSON body, default from, and an encoded mailbox", async () => {
		const m = mockFetch(() => json(202, SENT));
		const res = await client(m.fetch).mail.send("support@example.com", { to: "a@b.com", subject: "Hi", text: "Hello" });
		expect(res).toEqual(SENT);
		const [call] = m.calls;
		expect(call!.method).toBe("POST");
		expect(call!.url).toBe("https://mail.example.com/api/v1/mailboxes/support%40example.com/emails");
		expect(call!.headers.authorization).toBe("Bearer ttk_abc_secret");
		expect(call!.headers["content-type"]).toBe("application/json");
		expect(call!.headers["user-agent"]).toMatch(/^cloudmail-typescript\//);
		expect(call!.body).toEqual({ to: "a@b.com", subject: "Hi", text: "Hello", from: "support@example.com" });
	});

	it("keeps an explicit from", async () => {
		const m = mockFetch(() => json(202, SENT));
		await client(m.fetch).mail.send("s@example.com", { to: ["a@b.com"], subject: "x", html: "<p>x</p>", from: { email: "s@example.com", name: "Support" } });
		expect((m.calls[0]!.body as { from: unknown }).from).toEqual({ email: "s@example.com", name: "Support" });
	});

	it("replies and forwards on the message's path", async () => {
		const m = mockFetch(() => json(202, SENT));
		const t = client(m.fetch);
		await t.mail.reply("s@example.com", "msg/1", { to: "a@b.com", subject: "Re: x", text: "y" });
		await t.mail.forward("s@example.com", "msg_2", { to: "c@d.com", subject: "Fwd: x", text: "y" });
		expect(m.calls.map((c) => c.url)).toEqual([
			"https://mail.example.com/api/v1/mailboxes/s%40example.com/emails/msg%2F1/reply",
			"https://mail.example.com/api/v1/mailboxes/s%40example.com/emails/msg_2/forward",
		]);
	});

	it("lists a folder with filters, and normalises a bare array", async () => {
		const m = mockFetch(
			() => json(200, { emails: [], totalCount: 0 }),
			() => json(200, [{ id: "1", subject: "s", sender: "a", recipient: "b", date: "d", read: false, starred: false }]),
		);
		const t = client(m.fetch);
		await t.mail.list("s@example.com", { folder: "sent", page: 2, limit: 10, unread: true });
		expect(m.calls[0]!.url).toBe("https://mail.example.com/api/v1/mailboxes/s%40example.com/emails?folder=sent&page=2&limit=10&unread=true");
		const page = await t.mail.list("s@example.com");
		expect(page.totalCount).toBe(1);
	});

	it("gets and searches", async () => {
		const m = mockFetch(() => json(200, { emails: [], totalCount: 0 }));
		const t = client(m.fetch);
		await t.mail.get("s@example.com", "m1");
		await t.mail.search("s@example.com", "from:alice has:attachment", { limit: 5 });
		expect(m.calls[0]!.method).toBe("GET");
		expect(m.calls[0]!.url).toBe("https://mail.example.com/api/v1/mailboxes/s%40example.com/emails/m1");
		expect(m.calls[1]!.url).toBe("https://mail.example.com/api/v1/mailboxes/s%40example.com/search?query=from%3Aalice+has%3Aattachment&limit=5");
		expect(m.calls[0]!.headers["idempotency-key"]).toBeUndefined();
	});

	it("creates an agent inbox with an idempotency key", async () => {
		const m = mockFetch(() => json(201, { address: "agent-x@example.com", warnings: [] }));
		const res = await client(m.fetch).agentInboxes.create({ domain: "example.com", purpose: "triage", send_mode: "approve", ttl_hours: 24 });
		expect(res.address).toBe("agent-x@example.com");
		expect(m.calls[0]!.url).toBe("https://mail.example.com/api/v1/agent-inboxes");
		expect(m.calls[0]!.body).toEqual({ domain: "example.com", purpose: "triage", send_mode: "approve", ttl_hours: 24 });
		expect(m.calls[0]!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{32,36}$/);
	});

	it("covers mailboxes, webhooks and approvals paths", async () => {
		const m = mockFetch((call) => {
			if (call.url.endsWith("/approvals/count")) return json(200, { pending: 3 });
			if (call.url.includes("/approvals")) return json(200, { approvals: [], approval: { id: "a1" } });
			if (call.url.includes("/webhooks")) return json(200, { webhooks: [], webhook: { id: "w1" }, deliveries: [], delivery: null, secret: "whsec_x" });
			return json(200, []);
		});
		const t = client(m.fetch);
		await t.mailboxes.list({ domain: "example.com", includeSettings: true });
		await t.mailboxes.create({ email: "n@example.com", name: "N" });
		await t.mailboxes.update("n@example.com", { fromName: "N" });
		await t.webhooks.create({ name: "x", url: "https://hooks.example.com/t", events: ["message.received"] });
		await t.webhooks.update("w1", { enabled: false });
		await t.webhooks.rotateSecret("w1");
		await t.webhooks.deliveries("w1", { limit: 5 });
		expect(await t.approvals.count("s@example.com")).toBe(3);
		await t.approvals.approve("s@example.com", "a1");
		await t.approvals.reject("s@example.com", "a2", { note: "no" });
		const seen = m.calls.map((c) => `${c.method} ${c.url.replace("https://mail.example.com", "")}${c.headers["idempotency-key"] ? " [key]" : ""}`);
		expect(seen).toEqual([
			"GET /api/v1/mailboxes?domain=example.com&include=settings",
			"POST /api/v1/mailboxes [key]",
			"PUT /api/v1/mailboxes/n%40example.com",
			"POST /api/v1/webhooks [key]",
			"PATCH /api/v1/webhooks/w1",
			"POST /api/v1/webhooks/w1/rotate-secret",
			"GET /api/v1/webhooks/w1/deliveries?limit=5",
			"GET /api/v1/mailboxes/s%40example.com/approvals/count",
			"POST /api/v1/mailboxes/s%40example.com/approvals/a1/approve [key]",
			"POST /api/v1/mailboxes/s%40example.com/approvals/a2/reject",
		]);
		expect(m.calls[2]!.body).toEqual({ settings: { fromName: "N" } });
		expect(m.calls.at(-1)!.body).toEqual({ note: "no" });
	});

	it("matches the server's list of idempotent routes", async () => {
		const { MAILBOX_IDEMPOTENT_PATHS, INSTANCE_IDEMPOTENT_PATHS } = await import("../../../workers/lib/idempotency-routes");
		const server = [...MAILBOX_IDEMPOTENT_PATHS, ...INSTANCE_IDEMPOTENT_PATHS].map((p) => p.replace(/:([A-Za-z0-9_]+)/g, "{$1}"));
		expect([...IDEMPOTENT_POST_PATHS].sort()).toEqual(server.sort());
	});

	it("builds repeated query params and skips empties", () => {
		expect(buildQuery({ mailbox: ["a@x", "b@x"], since: 3, none: undefined, nil: null })).toBe("?mailbox=a%40x&mailbox=b%40x&since=3");
		expect(buildQuery({})).toBe("");
	});
});

describe("idempotency and retries", () => {
	it("retries a 5xx on a keyed create with the same key", async () => {
		const MBX = { id: "s@example.com", email: "s@example.com", name: "S" };
		const m = mockFetch(
			() => json(503, { error: "busy" }),
			() => json(502, { error: "bad gateway" }),
			() => json(201, MBX),
		);
		const res = await client(m.fetch, { idempotencyKey: () => "key-1" }).mailboxes.create({ email: "s@example.com", name: "S" });
		expect(res).toEqual(MBX);
		expect(m.calls).toHaveLength(3);
		expect(m.calls.map((c) => c.headers["idempotency-key"])).toEqual(["key-1", "key-1", "key-1"]);
	});

	it("does not retry a 5xx or 408 on a send (it may have gone out)", async () => {
		for (const status of [500, 502, 503, 408]) {
			const m = mockFetch(() => json(status, { error: "upstream" }));
			const err = await client(m.fetch).mail.send("s@example.com", { to: "a@b.com", subject: "x", text: "y" }).catch((e) => e);
			expect(err.status).toBe(status);
			if (status >= 500) expect(err).toBeInstanceOf(ServerError);
			expect(m.calls).toHaveLength(1);
		}
	});

	it("retries a send's 503 that the server returns before running it", async () => {
		const m = mockFetch(
			() => json(503, { error: "storage", code: "idempotency_unavailable" }, { "Retry-After": "1" }),
			() => json(202, SENT),
		);
		const res = await client(m.fetch, { idempotencyKey: () => "k" }).mail.send("s@example.com", { to: "a@b.com", subject: "x", text: "y" });
		expect(res).toEqual(SENT);
		expect(m.calls.map((c) => c.headers["idempotency-key"])).toEqual(["k", "k"]);
	});

	it("still retries a send's transport error and 429 with the same key", async () => {
		const m = mockFetch(
			() => new TypeError("reset"),
			() => json(429, { error: "slow down" }, { "Retry-After": "2" }),
			() => json(202, SENT),
		);
		await client(m.fetch).mail.send("s@example.com", { to: "a@b.com", subject: "x", text: "y" });
		expect(m.calls).toHaveLength(3);
		expect(new Set(m.calls.map((c) => c.headers["idempotency-key"])).size).toBe(1);
	});

	it("retries a transport error with the same key", async () => {
		const m = mockFetch(
			() => new TypeError("fetch failed"),
			() => json(202, SENT, { "Idempotent-Replayed": "true" }),
		);
		const t = client(m.fetch);
		const raw = await t.http.request({ method: "POST", path: "/api/v1/mailboxes/{mailboxId}/emails", params: { mailboxId: "s@example.com" }, body: {} });
		expect(raw.replayed).toBe(true);
		expect(m.calls).toHaveLength(2);
		expect(m.calls[0]!.headers["idempotency-key"]).toBe(m.calls[1]!.headers["idempotency-key"]);
		expect(raw.idempotencyKey).toBe(m.calls[0]!.headers["idempotency-key"]);
	});

	it("uses a caller-supplied key", async () => {
		const m = mockFetch(() => json(202, SENT));
		await client(m.fetch).mail.send("s@example.com", { to: "a@b.com", subject: "x", text: "y" }, { idempotencyKey: "job-42" });
		expect(m.calls[0]!.headers["idempotency-key"]).toBe("job-42");
	});

	it("generates a new key per logical call", async () => {
		const m = mockFetch(() => json(202, SENT));
		const t = client(m.fetch);
		await t.mail.send("s@example.com", { to: "a@b.com", subject: "x", text: "y" });
		await t.mail.send("s@example.com", { to: "a@b.com", subject: "x", text: "y" });
		expect(m.calls[0]!.headers["idempotency-key"]).not.toBe(m.calls[1]!.headers["idempotency-key"]);
	});

	it("waits Retry-After and retries 409 idempotency_request_in_progress", async () => {
		const sleeps: number[] = [];
		const m = mockFetch(
			() => json(409, { error: "in progress", code: "idempotency_request_in_progress" }, { "Retry-After": "1" }),
			() => json(202, SENT),
		);
		await client(m.fetch, { sleep: async (ms) => void sleeps.push(ms) }).mail.send("s@example.com", { to: "a@b.com", subject: "x", text: "y" });
		expect(sleeps).toEqual([1000]);
		expect(m.calls).toHaveLength(2);
	});

	it("does not retry idempotency_key_reused", async () => {
		const m = mockFetch(() => json(409, { error: "reused", code: "idempotency_key_reused" }));
		const err = await client(m.fetch).mail.send("s@example.com", { to: "a@b.com", subject: "x", text: "y" }).catch((e) => e);
		expect(err).toBeInstanceOf(ConflictError);
		expect(err.code).toBe("idempotency_key_reused");
		expect(m.calls).toHaveLength(1);
	});

	it("does not retry a 4xx", async () => {
		const m = mockFetch(() => json(400, { error: "bad" }));
		await expect(client(m.fetch).mail.send("s@example.com", { to: "a@b.com", subject: "x", text: "y" })).rejects.toBeInstanceOf(ValidationError);
		expect(m.calls).toHaveLength(1);
	});

	it("stops after maxRetries and reports the last error", async () => {
		const m = mockFetch(() => json(503, { error: "down" }));
		const err = await client(m.fetch, { maxRetries: 3 }).mail.list("s@example.com").catch((e) => e);
		expect(err).toBeInstanceOf(TapetideError);
		expect(err.status).toBe(503);
		expect(m.calls).toHaveLength(4);
	});

	it("never retries an unkeyed write", async () => {
		const m = mockFetch(() => new TypeError("socket hang up"));
		const err = await client(m.fetch).mailboxes.update("s@example.com", { fromName: "x" }).catch((e) => e);
		expect(err).toBeInstanceOf(APIConnectionError);
		expect(err.status).toBe(0);
		expect(m.calls).toHaveLength(1);
	});

	it("does not retry a 5xx from approve (it may have sent), but retries its transport errors", async () => {
		const m502 = mockFetch(() => json(502, { error: "sent_unconfirmed" }));
		await expect(client(m502.fetch).approvals.approve("s@example.com", "a1")).rejects.toMatchObject({ status: 502 });
		expect(m502.calls).toHaveLength(1);

		const net = mockFetch(() => new TypeError("reset"), () => json(200, { approval: { id: "a1", status: "sent" } }));
		await client(net.fetch).approvals.approve("s@example.com", "a1");
		expect(net.calls).toHaveLength(2);
		expect(net.calls[0]!.headers["idempotency-key"]).toBe(net.calls[1]!.headers["idempotency-key"]);
	});

	it("parses Retry-After in seconds and dates, capped", () => {
		expect(retryAfterMs("2")).toBe(2000);
		expect(retryAfterMs("999")).toBe(30_000);
		expect(retryAfterMs(new Date(10_000).toUTCString(), 5000)).toBe(5000);
		expect(retryAfterMs(null)).toBeNull();
	});
});

describe("202 pending_approval", () => {
	it("returns a typed PendingApproval instead of throwing", async () => {
		const m = mockFetch(() => json(202, HELD));
		const res = await client(m.fetch).mail.send("s@example.com", { to: "a@b.com", subject: "x", text: "y" });
		expect(isPendingApproval(res)).toBe(true);
		if (isPendingApproval(res)) {
			// Narrowed: these are PendingApproval fields.
			const id: string = res.approval_id;
			expect(id).toBe("apr_1");
			expect(res.approval_url).toContain("/approvals/apr_1");
		} else {
			const _sent: SendAccepted = res;
			throw new Error(`expected pending, got ${_sent.status}`);
		}
		expect(m.calls).toHaveLength(1);
	});

	it("is false for an accepted send", async () => {
		const m = mockFetch(() => json(202, SENT));
		const res = await client(m.fetch).mail.reply("s@example.com", "m1", { to: "a@b.com", subject: "x", text: "y" });
		expect(isPendingApproval(res)).toBe(false);
		expect(isPendingApproval(null)).toBe(false);
	});
});

describe("errors", () => {
	it.each([
		[401, AuthenticationError],
		[403, PermissionDeniedError],
		[404, NotFoundError],
		[409, ConflictError],
		[422, ValidationError],
		[429, RateLimitError],
	])("maps %i", async (status, cls) => {
		const m = mockFetch(() => json(status, { error: "nope", code: "some_code" }));
		const err = await client(m.fetch, { maxRetries: 0 }).mail.get("s@example.com", "x").catch((e) => e);
		expect(err).toBeInstanceOf(cls);
		expect(err).toBeInstanceOf(TapetideError);
		expect(err.message).toBe("nope");
		expect(err.code).toBe("some_code");
		expect(err.status).toBe(status);
	});

	it("keeps SDK_VERSION in step with package.json", async () => {
		const { SDK_VERSION } = await import("../src/index.js");
		const { readFile } = await import("node:fs/promises");
		const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
		expect(SDK_VERSION).toBe(pkg.version);
		expect(pkg.private).toBe(false);
	});

	it("rejects a missing token or base URL", () => {
		expect(() => client(async () => json(200, {}), { token: "" })).toThrow(/token/);
		expect(() => client(async () => json(200, {}), { baseUrl: "" })).toThrow(/baseUrl/);
	});
});
