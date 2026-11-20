// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Outbound webhooks: signing, payload shape, URL guard, backoff, and the
 * store's scheduling decisions against real SQLite.
 */

import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	WEBHOOK_DISABLE_AFTER_FAILURES,
	WEBHOOK_DISABLE_MIN_STREAK_MS,
	WEBHOOK_MAX_ATTEMPTS,
	buildEmailSummary,
	buildWebhookPayload,
	generateWebhookSecret,
	shouldAutoDisable,
	signWebhook,
	validateWebhookUrl,
	verifyWebhookSignature,
	webhookRetryDelayMs,
	webhookSnippet,
	webhookTypeForLedgerEvent,
} from "../shared/webhooks";
import { toPlainSnippet } from "../shared/plain-snippet";
import {
	CLAIM_LEASE_MS,
	DELIVERIES_KEPT_PER_ENDPOINT,
	WebhookStore,
	type WebhookSql,
} from "../workers/lib/webhooks-store";
import { attemptDelivery } from "../workers/lib/webhooks-deliver";
import { canManageEndpoint, canManageWebhooks, CreateWebhookSchema } from "../workers/lib/webhooks";
import { flushLedgerToWebhooks } from "../workers/durableObject/webhook-events";
import type { Principal } from "../workers/lib/authz";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 25, 12);

// ── Signing ─────────────────────────────────────────────────────────

describe("signWebhook", () => {
	it("is v1= hex HMAC-SHA256 of `${timestamp}.${body}`, matching node:crypto", async () => {
		const body = JSON.stringify({ hello: "world" });
		const sig = await signWebhook("whsec_test", 1_700_000_000, body);
		const expected = createHmac("sha256", "whsec_test").update(`1700000000.${body}`).digest("hex");
		expect(sig).toBe(`v1=${expected}`);
	});

	it("verifies its own signature and rejects tampering, wrong secret and stale timestamps", async () => {
		const body = '{"a":1}';
		const ts = 1_700_000_000;
		const sig = await signWebhook("s1", ts, body);
		const base = { secret: "s1", timestamp: ts, body, signatureHeader: sig, nowSeconds: ts + 10 };
		expect(await verifyWebhookSignature(base)).toBe(true);
		expect(await verifyWebhookSignature({ ...base, body: '{"a":2}' })).toBe(false);
		expect(await verifyWebhookSignature({ ...base, secret: "s2" })).toBe(false);
		expect(await verifyWebhookSignature({ ...base, nowSeconds: ts + 3600 })).toBe(false);
		expect(await verifyWebhookSignature({ ...base, timestamp: ts + 1 })).toBe(false);
		// Several signatures in one header (secret rotation) are accepted.
		expect(await verifyWebhookSignature({ ...base, signatureHeader: `v1=deadbeef, ${sig}` })).toBe(true);
	});

	it("generates distinct, prefixed secrets", () => {
		const a = generateWebhookSecret();
		const b = generateWebhookSecret();
		expect(a).toMatch(/^whsec_[0-9a-f]{64}$/);
		expect(a).not.toBe(b);
	});
});

// ── Payload ─────────────────────────────────────────────────────────

describe("payload shape", () => {
	const row = {
		id: "m1",
		thread_id: "t1",
		sender: "Alice@Example.com",
		recipient: "support@tapetide.com, Bob@Example.org",
		cc: null,
		subject: "Invoice",
		body: "<p>Hello&nbsp;<b>there</b></p><script>x()</script><p>Second &amp; last</p>",
		folder_id: "inbox",
	};

	it("summarises a message with a plain-text snippet and no body", () => {
		const summary = buildEmailSummary(row, ["Billing"], 2);
		expect(summary).toEqual({
			id: "m1",
			thread_id: "t1",
			from: "alice@example.com",
			from_name: null,
			to: ["support@tapetide.com", "bob@example.org"],
			cc: [],
			subject: "Invoice",
			snippet: "Hello there Second & last",
			has_attachments: true,
			labels: ["Billing"],
			folder: "inbox",
			spam: false,
		});
		expect(buildEmailSummary({ ...row, folder_id: "spam" }, [], 0)).toMatchObject({ folder: "spam", spam: true });
		expect(JSON.stringify(summary)).not.toContain("<");
	});

	it("prefers the stored snippet and sender name, deriving the snippet only for legacy rows", () => {
		const stored = buildEmailSummary(
			{ ...row, snippet: "Stored preview", sender_name: "  Alice Example  " },
			[],
			0,
		);
		expect(stored.snippet).toBe("Stored preview");
		expect(stored.from_name).toBe("Alice Example");
		// NULL means "not yet backfilled": derive with the same function the backfill uses.
		expect(webhookSnippet(null, "<p>Hi&nbsp;there</p>")).toBe(toPlainSnippet("<p>Hi&nbsp;there</p>"));
		// An empty stored snippet is a processed row with no text, not a missing one.
		expect(webhookSnippet("", "<p>ignored</p>")).toBe("");
	});

	it("wraps it in {id, type, created_at, mailbox, data} and drops empty detail", () => {
		const summary = buildEmailSummary(row, [], 0);
		const payload = buildWebhookPayload({
			id: "evt_1",
			type: "message.bounced",
			createdAt: "2026-10-25T12:00:00.000Z",
			mailbox: "support@tapetide.com",
			data: summary,
			detail: { recipient: "bob@example.org", reason: "550 no such user", url: null, cause: "" },
		});
		expect(Object.keys(payload)).toEqual(["id", "type", "created_at", "mailbox", "data"]);
		expect(payload.data.detail).toEqual({ recipient: "bob@example.org", reason: "550 no such user" });
		const plain = buildWebhookPayload({ id: "e", type: "message.received", createdAt: "x", mailbox: "m", data: summary });
		expect(plain.data).not.toHaveProperty("detail");
		expect(plain).not.toHaveProperty("test");
	});

	it("maps ledger events to webhook types", () => {
		expect(webhookTypeForLedgerEvent("sent")).toBe("message.sent");
		expect(webhookTypeForLedgerEvent("failed")).toBe("message.delivery_failed");
		expect(webhookTypeForLedgerEvent("rejected")).toBe("message.delivery_failed");
		expect(webhookTypeForLedgerEvent("bounced")).toBe("message.bounced");
		expect(webhookTypeForLedgerEvent("opened")).toBe("message.opened");
		expect(webhookTypeForLedgerEvent("clicked")).toBe("message.clicked");
		expect(webhookTypeForLedgerEvent("soft_bounced")).toBeNull();
		expect(webhookTypeForLedgerEvent("delivered")).toBeNull();
		expect(webhookTypeForLedgerEvent("queued")).toBeNull();
	});
});

// ── URL guard ───────────────────────────────────────────────────────

describe("validateWebhookUrl (SSRF guard)", () => {
	it.each([
		"https://hooks.example.com/tapetide",
		"https://api.example.co.uk:8443/in?x=1",
		"https://8.8.8.8/hook",
		"https://[2606:4700:4700::1111]/hook",
	])("accepts %s", (url) => {
		expect(validateWebhookUrl(url).ok).toBe(true);
	});

	it.each([
		["http://hooks.example.com/", "https"],
		["ftp://example.com/", "https"],
		["not a url", "valid"],
		["", "Enter"],
		["https://user:pass@example.com/", "credentials"],
		["https://localhost/", "Local"],
		["https://app.localhost/", "Local"],
		["https://printer.local/", "Local"],
		["https://metadata.google.internal/", "Local"],
		["https://intranet/", "fully qualified"],
		["https://127.0.0.1/", "Private"],
		["https://127.1/", "Private"],
		["https://2130706433/", "Private"],
		["https://0x7f.0.0.1/", "Private"],
		["https://0.0.0.0/", "Private"],
		["https://10.1.2.3/", "Private"],
		["https://172.16.0.1/", "Private"],
		["https://172.31.255.255/", "Private"],
		["https://192.168.1.1/", "Private"],
		["https://169.254.169.254/latest/meta-data", "Private"],
		["https://100.64.0.1/", "Private"],
		["https://224.0.0.1/", "Private"],
		["https://[::1]/", "Private"],
		["https://[::]/", "Private"],
		["https://[fc00::1]/", "Private"],
		["https://[fd12:3456::1]/", "Private"],
		["https://[fe80::1]/", "Private"],
		["https://[::ffff:127.0.0.1]/", "Private"],
		["https://[::ffff:10.0.0.1]/", "Private"],
		["https://[64:ff9b::192.168.0.1]/", "Private"],
		["https://[64:ff9b:1::1]/", "Private"],
		["https://[::ffff:0:127.0.0.1]/", "Private"],
		["https://[2002:7f00:1::]/", "Private"],
		["https://[2002:c0a8:101::1]/", "Private"],
		["https://[2001:db8::1]/", "Private"],
		["https://abcdef.onion/", "Local"],
	])("refuses %s", (url, fragment) => {
		const result = validateWebhookUrl(url);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain(fragment);
	});

	it("does not mistake public neighbours of private ranges for private", () => {
		expect(validateWebhookUrl("https://172.32.0.1/").ok).toBe(true);
		expect(validateWebhookUrl("https://100.128.0.1/").ok).toBe(true);
		expect(validateWebhookUrl("https://11.0.0.1/").ok).toBe(true);
		expect(validateWebhookUrl("https://[::ffff:8.8.8.8]/").ok).toBe(true);
		expect(validateWebhookUrl("https://[2002:808:808::1]/").ok).toBe(true);
	});

	it("is enforced by the create schema", () => {
		const bad = CreateWebhookSchema.safeParse({ name: "x", url: "https://10.0.0.1/", events: ["message.sent"] });
		expect(bad.success).toBe(false);
		const good = CreateWebhookSchema.safeParse({
			name: "x",
			url: "https://hooks.example.com/",
			events: ["message.sent"],
			mailboxes: ["Support@Tapetide.com"],
		});
		expect(good.success).toBe(true);
		if (good.success) expect(good.data.mailboxes).toEqual(["support@tapetide.com"]);
		expect(CreateWebhookSchema.safeParse({ name: "x", url: "https://a.example.com", events: [] }).success).toBe(false);
		expect(
			CreateWebhookSchema.safeParse({ name: "x", url: "https://a.example.com", events: ["message.nope"] }).success,
		).toBe(false);
	});
});

// ── Backoff ─────────────────────────────────────────────────────────

describe("backoff schedule", () => {
	it("waits 1m, 5m, 30m, 2h, 6h, then gives up after 6 attempts", () => {
		expect(WEBHOOK_MAX_ATTEMPTS).toBe(6);
		expect([1, 2, 3, 4, 5].map(webhookRetryDelayMs)).toEqual([MIN, 5 * MIN, 30 * MIN, 2 * HOUR, 6 * HOUR]);
		expect(webhookRetryDelayMs(6)).toBeNull();
		expect(webhookRetryDelayMs(7)).toBeNull();
	});

	it("auto-disables only after many failures spread over time", () => {
		const n = WEBHOOK_DISABLE_AFTER_FAILURES;
		expect(shouldAutoDisable(n - 1, T0 - 2 * WEBHOOK_DISABLE_MIN_STREAK_MS, T0)).toBe(false);
		expect(shouldAutoDisable(n, T0 - MIN, T0)).toBe(false);
		expect(shouldAutoDisable(n, T0 - WEBHOOK_DISABLE_MIN_STREAK_MS, T0)).toBe(true);
	});
});

// ── Store ───────────────────────────────────────────────────────────

function sqliteAdapter(db: DatabaseSync): { sql: WebhookSql; tx: <T>(fn: () => T) => T } {
	return {
		sql: {
			exec(query: string, ...bindings: unknown[]) {
				const rows = db.prepare(query).all(...(bindings as never[])) as any[];
				return { toArray: () => rows };
			},
		},
		tx<T>(fn: () => T): T {
			db.exec("SAVEPOINT tx");
			try {
				const out = fn();
				db.exec("RELEASE tx");
				return out;
			} catch (e) {
				db.exec("ROLLBACK TO tx");
				db.exec("RELEASE tx");
				throw e;
			}
		},
	};
}

describe("WebhookStore", () => {
	let store: WebhookStore;

	beforeEach(() => {
		const { sql, tx } = sqliteAdapter(new DatabaseSync(":memory:"));
		store = new WebhookStore(sql, tx);
	});

	function endpoint(overrides: Partial<Parameters<WebhookStore["createEndpoint"]>[0]> = {}) {
		return store.createEndpoint({
			name: "Backend",
			url: "https://hooks.example.com/",
			secret: "whsec_abcd1234",
			events: ["message.received", "message.sent"],
			mailboxes: null,
			enabled: true,
			createdBy: "owner@tapetide.com",
			now: T0,
			...overrides,
		});
	}

	function event(id: string, type: "message.received" | "message.sent" = "message.received", mailbox = "a@x.com") {
		return { eventId: id, type, mailbox, payload: `{"id":"${id}"}`, now: T0 };
	}

	it("never exposes the secret on reads, only a hint", () => {
		const ep = endpoint();
		expect(ep.secretHint).toBe("1234");
		expect(JSON.stringify(store.listEndpoints())).not.toContain("whsec_abcd1234");
	});

	it("enqueues once per matching endpoint and ignores a replayed event", () => {
		endpoint();
		endpoint({ events: ["message.sent"] });
		endpoint({ mailboxes: ["other@x.com"] });
		endpoint({ enabled: false });
		expect(store.enqueue(event("e1"))).toBe(1);
		expect(store.enqueue(event("e1"))).toBe(0);
		expect(store.enqueue(event("e2", "message.sent"))).toBe(2);
		expect(store.enqueue(event("e3", "message.sent", "OTHER@x.com"))).toBe(3);
	});

	it("reports which types a mailbox has subscribers for", () => {
		endpoint({ events: ["message.bounced"], mailboxes: ["a@x.com"] });
		endpoint({ events: ["message.opened"] });
		expect(store.wantedTypes("A@x.com").sort()).toEqual(["message.bounced", "message.opened"]);
		expect(store.wantedTypes("b@x.com")).toEqual(["message.opened"]);
	});

	it("leases claimed deliveries so they are not sent twice", () => {
		endpoint();
		store.enqueue(event("e1"));
		const first = store.claimDue(T0, 10);
		expect(first).toHaveLength(1);
		expect(first[0].attempt).toBe(1);
		expect(store.claimDue(T0 + 1000, 10)).toHaveLength(0);
		// An abandoned lease is picked up again once it expires.
		expect(store.claimDue(T0 + CLAIM_LEASE_MS + 1, 10)).toHaveLength(1);
	});

	it("retries on the backoff schedule and fails after the last attempt", () => {
		endpoint();
		store.enqueue(event("e1"));
		let now = T0;
		const delays = [MIN, 5 * MIN, 30 * MIN, 2 * HOUR, 6 * HOUR];
		for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
			const [due] = store.claimDue(now, 10);
			expect(due?.attempt).toBe(attempt);
			const { delivery } = store.recordAttempt(due.id, { statusCode: 500, durationMs: 12, error: null }, now)!;
			if (attempt < WEBHOOK_MAX_ATTEMPTS) {
				expect(delivery.status).toBe("retrying");
				expect(delivery.nextAttemptAt).toBe(now + delays[attempt - 1]);
				// Not due one millisecond early.
				expect(store.claimDue(delivery.nextAttemptAt! - 1, 10)).toHaveLength(0);
				now = delivery.nextAttemptAt!;
			} else {
				expect(delivery.status).toBe("failed");
				expect(delivery.nextAttemptAt).toBeNull();
				expect(delivery.lastError).toBe("HTTP 500");
			}
		}
		const [logged] = store.listDeliveries(store.listEndpoints()[0].id);
		expect(logged.attemptLog?.map((a) => a.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(store.nextWakeAt()).toBeNull();
	});

	it("marks success delivered and resets the failure streak", () => {
		const ep = endpoint();
		store.enqueue(event("e1"));
		store.enqueue(event("e2"));
		const [a, b] = store.claimDue(T0, 10);
		store.recordAttempt(a.id, { statusCode: null, durationMs: 10_000, error: "Timed out after 10s" }, T0);
		expect(store.getEndpoint(ep.id)!.consecutiveFailures).toBe(1);
		const { delivery } = store.recordAttempt(b.id, { statusCode: 204, durationMs: 40, error: null }, T0);
		expect(delivery.status).toBe("delivered");
		expect(store.getEndpoint(ep.id)!.consecutiveFailures).toBe(0);
	});

	it("allows a manual retry during a long backoff, but not while an attempt is in flight", () => {
		endpoint();
		store.enqueue(event("e1"));
		let [due] = store.claimDue(T0, 10);
		store.recordAttempt(due.id, { statusCode: 500, durationMs: 1, error: null }, T0);
		[due] = store.claimDue(T0 + MIN, 10);
		store.recordAttempt(due.id, { statusCode: 500, durationMs: 1, error: null }, T0 + MIN);
		// Now waiting 30 minutes. A person pressing Retry is not a concurrent send.
		const manual = store.claimOne(due.id, T0 + 2 * MIN);
		expect(manual).not.toBeNull();
		// While that attempt is in flight, neither path may take it again.
		expect(store.claimOne(due.id, T0 + 2 * MIN + 1)).toBeNull();
		// Once it finishes, the next manual retry is accepted again.
		store.recordAttempt(due.id, { statusCode: 200, durationMs: 1, error: null }, T0 + 2 * MIN + 5);
		expect(store.getDelivery(due.id)!.status).toBe("delivered");
		expect(store.claimOne(due.id, T0 + 3 * MIN)).not.toBeNull();
	});

	it("keeps the lease when the endpoint is disabled mid-attempt", () => {
		const ep = endpoint();
		store.enqueue(event("e1"));
		const [due] = store.claimDue(T0, 10);
		store.updateEndpoint(ep.id, { enabled: false, now: T0 + 1 });
		expect(store.claimOne(due.id, T0 + 2)).toBeNull();
	});

	it("wakes for an abandoned lease when it expires", () => {
		endpoint();
		store.enqueue(event("e1"));
		store.claimDue(T0, 10);
		expect(store.nextWakeAt()).toBe(T0 + CLAIM_LEASE_MS);
	});

	it("does not retry a failed test delivery", () => {
		const ep = endpoint();
		const id = store.createTestDelivery(ep.id, event("t1"))!;
		const due = store.claimOne(id, T0)!;
		const { delivery } = store.recordAttempt(due.id, { statusCode: 404, durationMs: 5, error: null }, T0)!;
		expect(delivery.status).toBe("failed");
		expect(delivery.test).toBe(true);
	});

	it("auto-disables a dead endpoint and abandons its queue; re-enabling clears the streak", () => {
		const ep = endpoint();
		let disabled = false;
		let now = T0;
		const step = Math.ceil(WEBHOOK_DISABLE_MIN_STREAK_MS / (WEBHOOK_DISABLE_AFTER_FAILURES - 1));
		for (let i = 0; i < WEBHOOK_DISABLE_AFTER_FAILURES; i++) {
			store.enqueue({ ...event(`e${i}`), now });
			const due = store.claimOne(store.listDeliveries(ep.id, 1)[0].id, now)!;
			disabled = store.recordAttempt(due.id, { statusCode: 503, durationMs: 1, error: null }, now)!.endpointDisabled;
			if (i < WEBHOOK_DISABLE_AFTER_FAILURES - 1) expect(disabled).toBe(false);
			now += step;
		}
		expect(disabled).toBe(true);
		const off = store.getEndpoint(ep.id)!;
		expect(off.enabled).toBe(false);
		expect(off.disabledReason).toMatch(/automatically/);
		expect(store.listDeliveries(ep.id, 100).every((d) => d.status === "failed")).toBe(true);
		expect(store.enqueue(event("after"))).toBe(0);

		const on = store.updateEndpoint(ep.id, { enabled: true, now })!;
		expect(on.enabled).toBe(true);
		expect(on.disabledReason).toBeNull();
		expect(on.consecutiveFailures).toBe(0);
	});

	it("keeps only the newest deliveries per endpoint", () => {
		const ep = endpoint();
		for (let i = 0; i < DELIVERIES_KEPT_PER_ENDPOINT + 5; i++) {
			store.enqueue({ ...event(`e${i}`), now: T0 + i });
			const [due] = store.claimDue(T0 + i, 1);
			store.recordAttempt(due.id, { statusCode: 200, durationMs: 1, error: null }, T0 + i);
		}
		const kept = store.listDeliveries(ep.id, 500);
		expect(kept).toHaveLength(DELIVERIES_KEPT_PER_ENDPOINT);
		expect(kept[0].eventId).toBe(`e${DELIVERIES_KEPT_PER_ENDPOINT + 4}`);
	});

	it("deletes an endpoint with its deliveries", () => {
		const ep = endpoint();
		store.enqueue(event("e1"));
		expect(store.deleteEndpoint(ep.id)).toBe(true);
		expect(store.listEndpoints()).toHaveLength(0);
		expect(store.nextWakeAt()).toBeNull();
		expect(store.deleteEndpoint(ep.id)).toBe(false);
	});
});

// ── Delivery attempt ────────────────────────────────────────────────

describe("attemptDelivery", () => {
	const due = {
		id: "whd_1",
		endpointId: "wh_1",
		url: "https://hooks.example.com/in",
		secret: "whsec_k",
		eventType: "message.sent" as const,
		payload: '{"id":"evt_1"}',
		attempt: 2,
	};

	it("POSTs the body with the signed headers and no redirects", async () => {
		const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
		const outcome = await attemptDelivery(due, { fetch: fetchMock as never, now: () => T0 });
		expect(outcome).toEqual({ statusCode: 200, durationMs: 0, error: null });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://hooks.example.com/in");
		expect(init.method).toBe("POST");
		expect(init.redirect).toBe("manual");
		expect(init.body).toBe(due.payload);
		const headers = init.headers as Record<string, string>;
		const ts = String(Math.floor(T0 / 1000));
		expect(headers["X-Tapetide-Event"]).toBe("message.sent");
		expect(headers["X-Tapetide-Delivery"]).toBe("whd_1");
		expect(headers["X-Tapetide-Timestamp"]).toBe(ts);
		expect(headers["X-Tapetide-Attempt"]).toBe("2");
		expect(headers["X-Tapetide-Signature"]).toBe(
			`v1=${createHmac("sha256", "whsec_k").update(`${ts}.${due.payload}`).digest("hex")}`,
		);
	});

	it("reports non-2xx, redirects and network errors as failures", async () => {
		const r500 = await attemptDelivery(due, { fetch: (async () => new Response("boom", { status: 500 })) as never });
		expect(r500).toMatchObject({ statusCode: 500, error: "HTTP 500: boom" });
		const r302 = await attemptDelivery(due, {
			fetch: (async () => new Response(null, { status: 302, headers: { Location: "https://10.0.0.1/" } })) as never,
		});
		expect(r302.error).toMatch(/redirects are not followed/);
		const net = await attemptDelivery(due, {
			fetch: (async () => {
				throw new TypeError("connection refused");
			}) as never,
		});
		expect(net).toMatchObject({ statusCode: null, error: "connection refused" });
	});

	it("times out a slow endpoint", async () => {
		const slow = (async (_url: string, init: RequestInit) =>
			new Promise((_, reject) => {
				init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
			})) as never;
		const outcome = await attemptDelivery(due, { fetch: slow, timeoutMs: 20 });
		expect(outcome.error).toMatch(/Timed out/);
	});

	it("refuses a private URL without sending", async () => {
		const fetchMock = vi.fn();
		const outcome = await attemptDelivery({ ...due, url: "https://192.168.0.10/" }, { fetch: fetchMock as never });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(outcome.error).toMatch(/^Refused/);
	});
});

// ── Authorization ───────────────────────────────────────────────────

describe("webhook authorization", () => {
	const admin: Principal = {
		identity: { kind: "user", id: "owner@x.com", subject: null },
		role: "admin",
		mailboxes: null,
		access: null,
		enforced: true,
		developmentBypass: false,
	};
	const owner: Principal = {
		identity: { kind: "user", id: "a@x.com", subject: null },
		role: "member",
		mailboxes: ["a@x.com", "b@x.com"],
		access: [
			{ id: "a@x.com", role: "owner" },
			{ id: "b@x.com", role: "viewer" },
		],
		enforced: true,
		developmentBypass: false,
	};
	const viewer: Principal = { ...owner, access: [{ id: "b@x.com", role: "viewer" }], mailboxes: ["b@x.com"] };

	it("lets admins manage everything", () => {
		expect(canManageWebhooks(admin)).toBe(true);
		expect(canManageEndpoint(admin, null)).toBe(true);
	});

	it("lets a mailbox owner manage hooks filtered to mailboxes they own, only", () => {
		expect(canManageWebhooks(owner)).toBe(true);
		expect(canManageEndpoint(owner, ["a@x.com"])).toBe(true);
		expect(canManageEndpoint(owner, ["a@x.com", "b@x.com"])).toBe(false);
		expect(canManageEndpoint(owner, null)).toBe(false);
	});

	it("refuses a member without settings authority anywhere", () => {
		expect(canManageWebhooks(viewer)).toBe(false);
	});

	const withToken = (p: Principal, scopes: string[], mailboxes: string[] | null = null): Principal =>
		({ ...p, token: { id: "tok", scopes, mailboxes } }) as Principal;

	it("requires webhooks:manage (or admin) on a scoped token", () => {
		expect(canManageWebhooks(withToken(admin, ["mail:read"]))).toBe(false);
		expect(canManageEndpoint(withToken(admin, ["mail:read"]), null)).toBe(false);
		expect(canManageWebhooks(withToken(admin, ["webhooks:manage"]))).toBe(true);
		expect(canManageEndpoint(withToken(admin, ["webhooks:manage"]), null)).toBe(true);
		expect(canManageEndpoint(withToken(admin, ["admin"]), null)).toBe(true);
		// A mailbox owner's webhooks:manage token covers their own mailbox only.
		expect(canManageEndpoint(withToken(owner, ["webhooks:manage"]), ["a@x.com"])).toBe(true);
		expect(canManageEndpoint(withToken(owner, ["webhooks:manage"]), ["b@x.com"])).toBe(false);
	});

	it("keeps a mailbox-restricted token off all-mailbox and out-of-reach endpoints", () => {
		const limited = withToken(admin, ["webhooks:manage"], ["a@x.com"]);
		expect(canManageEndpoint(limited, null)).toBe(false);
		expect(canManageEndpoint(limited, ["a@x.com"])).toBe(true);
		expect(canManageEndpoint(limited, ["a@x.com", "c@x.com"])).toBe(false);
		const ownerLimited = withToken(owner, ["webhooks:manage"], ["b@x.com"]);
		// The grant owns A, but the token cannot reach it; it reaches B, which the grant only views.
		expect(canManageEndpoint(ownerLimited, ["a@x.com"])).toBe(false);
		expect(canManageWebhooks(ownerLimited)).toBe(false);
	});
});

// ── Ledger flush ────────────────────────────────────────────────────

describe("flushLedgerToWebhooks", () => {
	let db: DatabaseSync;
	let ctx: DurableObjectState;
	let kv: Map<string, unknown>;

	beforeEach(() => {
		db = new DatabaseSync(":memory:");
		db.exec(`
			CREATE TABLE emails (id TEXT PRIMARY KEY, folder_id TEXT, subject TEXT, sender TEXT,
				recipient TEXT, cc TEXT, date TEXT, body TEXT, thread_id TEXT,
				snippet TEXT, sender_name TEXT);
			CREATE TABLE attachments (id TEXT, email_id TEXT);
			CREATE TABLE labels (id TEXT, name TEXT, sort_order INTEGER DEFAULT 0);
			CREATE TABLE email_labels (email_id TEXT, label_id TEXT);
			CREATE TABLE delivery_events (id INTEGER PRIMARY KEY AUTOINCREMENT, email_id TEXT,
				recipient TEXT, event_type TEXT, source TEXT, provider_message_id TEXT,
				error_cause TEXT, error_detail TEXT, metadata TEXT, dedupe_key TEXT,
				occurred_at TEXT, created_at TEXT DEFAULT (datetime('now')));
		`);
		db.prepare(
			`INSERT INTO emails VALUES ('m1','sent','Hi','support@tapetide.com','bob@example.org',NULL,'d','<p>Hello</p>','t1','Hello','Support Team')`,
		).run();
		kv = new Map();
		ctx = {
			storage: {
				sql: {
					exec(query: string, ...bindings: unknown[]) {
						const rows = db.prepare(query).all(...(bindings as never[])) as any[];
						return { toArray: () => rows };
					},
				},
				get: async (k: string) => kv.get(k),
				put: async (k: string, v: unknown) => void kv.set(k, v),
			},
		} as unknown as DurableObjectState;
	});

	function ledger(type: string, extra: Record<string, string | null> = {}) {
		db.prepare(
			`INSERT INTO delivery_events (email_id, event_type, source, recipient, metadata, error_detail, occurred_at)
			 VALUES ('m1', ?, 'send', ?, ?, ?, '2026-10-25T12:00:00Z')`,
		).run(type, extra.recipient ?? null, extra.metadata ?? null, extra.error ?? null);
	}

	it("forwards only new, wanted events and advances the cursor", async () => {
		const enqueue = vi.fn(async () => ({ queued: 1 }));
		const sink = { enqueue, wantedTypes: async () => [] };
		const wanted = async () => ["message.sent", "message.clicked"] as never;

		ledger("sent");
		ledger("delivered");
		ledger("clicked", { metadata: JSON.stringify({ url: "https://example.com/x" }) });
		expect(await flushLedgerToWebhooks(ctx, "support@tapetide.com", sink, wanted)).toBe(2);

		const events = (enqueue.mock.calls[0] as unknown as [any[]])[0];
		expect(events.map((e) => e.type)).toEqual(["message.sent", "message.clicked"]);
		const clicked = JSON.parse(events[1].payload);
		expect(clicked.mailbox).toBe("support@tapetide.com");
		expect(clicked.data.snippet).toBe("Hello");
		expect(clicked.data.from_name).toBe("Support Team");
		expect(clicked.data.detail.url).toBe("https://example.com/x");
		expect(events[0].eventId).not.toBe(events[1].eventId);

		// Nothing new: no second hand-off.
		expect(await flushLedgerToWebhooks(ctx, "support@tapetide.com", sink, wanted)).toBe(0);
		expect(enqueue).toHaveBeenCalledTimes(1);
	});

	it("keeps the cursor when the hand-off fails, so the next flush retries", async () => {
		const sink = {
			enqueue: vi.fn(async () => {
				throw new Error("down");
			}),
			wantedTypes: async () => [],
		};
		ledger("bounced", { recipient: "bob@example.org", error: "550" });
		await expect(
			flushLedgerToWebhooks(ctx, "support@tapetide.com", sink, async () => ["message.bounced"] as never),
		).rejects.toThrow("down");
		const ok = vi.fn(async () => ({ queued: 1 }));
		expect(
			await flushLedgerToWebhooks(ctx, "support@tapetide.com", { ...sink, enqueue: ok }, async () => ["message.bounced"] as never),
		).toBe(1);
	});

	it("does not replay old history the first time it runs", async () => {
		db.prepare(
			`INSERT INTO delivery_events (email_id, event_type, source, occurred_at, created_at)
			 VALUES ('m1','sent','send','2026-01-01T00:00:00Z', datetime('now','-2 days'))`,
		).run();
		const enqueue = vi.fn(async () => ({ queued: 0 }));
		expect(
			await flushLedgerToWebhooks(ctx, "support@tapetide.com", { enqueue, wantedTypes: async () => [] }, async () => ["message.sent"] as never),
		).toBe(0);
		expect(enqueue).not.toHaveBeenCalled();
	});
});
