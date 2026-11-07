// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The pre-send gate's semantics, and each send path refusing a suppressed
 * address within the same request (RFC/Gmail: unsubscribes honoured within 48
 * hours; ours take effect on the next send).
 *
 * Suppressions run on the real `AuthStore` over `node:sqlite`; the breaker on
 * the real `SendingHealthStore` over the same database.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	PRE_SEND_RULES,
	PreSendRefusedError,
	TRANSACTIONAL_BLOCKING_REASONS,
	httpRefusal,
	preSend,
	type PreSendRule,
} from "../workers/lib/pre-send";
import { SendingHealthStore } from "../workers/lib/sending-health-store";
import { AuthStore, type AuthSql } from "../workers/auth/store-core";
import { toolSendEmail, toolSendReply, toolSendTemplate, toolForwardEmail } from "../workers/lib/tools";
import { forwardInboundMessage } from "../workers/lib/forwarding";
import { applyMigrations, mailboxMigrations } from "../workers/durableObject/migrations";
import { processDueScheduledSends, recordScheduledSend } from "../workers/durableObject/features";
import { dispatchDueSequenceEmails } from "../workers/lib/sequence-dispatch";
import { sendResetEmail } from "../workers/auth/reset-email";
import { fakeBucket } from "./helpers/suppression-store";
import type { Env } from "../workers/types";

const MB = "support@product.dev";

function stores() {
	const db = new DatabaseSync(":memory:");
	const sql: AuthSql = {
		exec(query: string, ...bindings: unknown[]) {
			const rows = db.prepare(query).all(...(bindings as never[])) as any[];
			return { toArray: () => rows };
		},
	};
	const tx = <T>(fn: () => T): T => {
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
	};
	const auth = new AuthStore(sql, tx);
	const health = new SendingHealthStore(sql, tx);
	// One object answering both surfaces, as the AuthDO does.
	const authDo = Object.assign(Object.create(auth), {
		isBulkPaused: async (d: string) => health.isBulkPaused(d),
		listSendingHealth: async () => health.list(),
	});
	return { auth, health, AUTH_STORE: { idFromName: (n: string) => n, get: () => authDo } };
}

async function suppress(auth: AuthStore, address: string, reason: string, scope = "global") {
	await auth.addSuppressions([{ address, scope, reason, source: "test" }], 1);
}

const quota = (limit: string | null = null) => () => ({ checkSendRateLimit: async () => limit });

beforeEach(() => {
	vi.restoreAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("preSend semantics", () => {
	it("transactional: hard bounces and complaints block, unsubscribes only warn", async () => {
		const s = stores();
		await suppress(s.auth, "dead@x.com", "hard_bounce");
		await suppress(s.auth, "angry@x.com", "complaint", "product.dev");
		await suppress(s.auth, "left@x.com", "unsubscribed", "product.dev");
		const env = { AUTH_STORE: s.AUTH_STORE } as unknown as Env;
		const r = await preSend(
			env,
			{ kind: "transactional", from: MB, mailboxId: MB, to: ["ok@x.com", "dead@x.com", "left@x.com"], cc: "angry@x.com", html: "x" },
			{ quota: quota() },
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.to).toEqual(["ok@x.com", "left@x.com"]);
		expect(r.cc).toEqual([]);
		expect(r.suppressed.map((x) => x.address).sort()).toEqual(["angry@x.com", "dead@x.com"]);
		expect(r.warnings).toEqual([{ address: "left@x.com", reason: "unsubscribed", scope: "product.dev" }]);
		expect([...TRANSACTIONAL_BLOCKING_REASONS].sort()).toEqual(["complaint", "hard_bounce", "manual"]);
		expect(r.outcome).toBe("warn");
	});

	it("bulk: every suppression blocks", async () => {
		const s = stores();
		await suppress(s.auth, "left@x.com", "unsubscribed", "product.dev");
		await suppress(s.auth, "manual@x.com", "manual");
		const env = { AUTH_STORE: s.AUTH_STORE } as unknown as Env;
		const r = await preSend(env, { kind: "bulk", from: MB, mailboxId: MB, to: ["left@x.com", "manual@x.com", "ok@x.com"] }, { quota: quota() });
		expect(r.ok && r.to).toEqual(["ok@x.com"]);
	});

	it("a suppression scoped to another domain does not apply", async () => {
		const s = stores();
		await suppress(s.auth, "left@x.com", "unsubscribed", "other.app");
		const env = { AUTH_STORE: s.AUTH_STORE } as unknown as Env;
		const r = await preSend(env, { kind: "bulk", from: MB, mailboxId: MB, to: "left@x.com" }, { quota: quota() });
		expect(r.ok).toBe(true);
	});

	it("automated: an unsubscribe stops it", async () => {
		const s = stores();
		await suppress(s.auth, "left@x.com", "unsubscribed", "product.dev");
		const env = { AUTH_STORE: s.AUTH_STORE } as unknown as Env;
		const r = await preSend(env, { kind: "automated", from: MB, mailboxId: MB, to: "left@x.com" }, { quota: quota() });
		expect(r).toMatchObject({ ok: false, code: "all_suppressed", status: 422 });
	});

	it("system: never filtered and never capped", async () => {
		const s = stores();
		await suppress(s.auth, "owner@x.com", "complaint");
		const env = { AUTH_STORE: s.AUTH_STORE } as unknown as Env;
		const capped = vi.fn(async () => "over");
		const r = await preSend(env, { kind: "system", from: "noreply@product.dev", mailboxId: null, to: "owner@x.com" }, { quota: () => ({ checkSendRateLimit: capped }) });
		expect(r.ok).toBe(true);
		expect(capped).not.toHaveBeenCalled();
	});

	it("enforces Cloudflare's per-message limits with the provider's code", async () => {
		const to = Array.from({ length: 51 }, (_, i) => `r${i}@x.com`);
		const r = await preSend({} as Env, { kind: "transactional", from: MB, mailboxId: MB, to }, { quota: quota() });
		expect(r).toMatchObject({ ok: false, code: "invalid_message", status: 400, providerCode: "E_TOO_MANY_RECIPIENTS" });
		const h = await preSend({} as Env, { kind: "transactional", from: MB, mailboxId: MB, to: "a@x.com", headers: { "Message-ID": "<a@b>" } }, { quota: quota() });
		expect(h).toMatchObject({ ok: false, code: "invalid_message", status: 400 });
	});

	it("enforces the mailbox send cap, unless already checked", async () => {
		const r = await preSend({} as Env, { kind: "transactional", from: MB, mailboxId: MB, to: "a@x.com" }, { quota: quota("Rate limit exceeded: max 20 emails per hour per mailbox") });
		expect(r).toMatchObject({ ok: false, code: "rate_limited", status: 429 });
		const skip = await preSend({} as Env, { kind: "transactional", from: MB, mailboxId: MB, to: "a@x.com", quotaChecked: true }, { quota: quota("over") });
		expect(skip.ok).toBe(true);
	});

	it("refuses bulk from a paused domain, and only bulk", async () => {
		const s = stores();
		s.health.pause("product.dev", "Spam complaint rate 0.40% is above 0.30%", 1);
		const env = { AUTH_STORE: s.AUTH_STORE } as unknown as Env;
		const bulk = await preSend(env, { kind: "bulk", from: MB, mailboxId: MB, to: "a@x.com" }, { quota: quota() });
		expect(bulk).toMatchObject({ ok: false, code: "bulk_paused", status: 423, domain: "product.dev" });
		const tx = await preSend(env, { kind: "transactional", from: MB, mailboxId: MB, to: "a@x.com" }, { quota: quota() });
		expect(tx.ok).toBe(true);
		const other = await preSend(env, { kind: "bulk", from: "hi@other.app", mailboxId: "hi@other.app", to: "a@x.com" }, { quota: quota() });
		expect(other.ok).toBe(true);
	});

	it("fails open when the stores are unreachable", async () => {
		const broken = { findSuppressions: async () => { throw new Error("down"); } };
		const breaker = { isBulkPaused: async () => { throw new Error("down"); } };
		const r = await preSend({} as Env, { kind: "bulk", from: MB, mailboxId: MB, to: "a@x.com" }, { quota: quota(), suppressions: broken, breaker });
		expect(r.ok).toBe(true);
	});

	it("rules run after the built-ins and can block or hold for approval", async () => {
		const seen: unknown[] = [];
		const hold: PreSendRule = {
			name: "approval",
			check: async (ctx) => {
				seen.push({ via: ctx.input.actor?.via, method: ctx.input.actor?.credential?.method, to: ctx.to });
				return ctx.input.actor?.credential?.method === "token"
					? { outcome: "hold_for_approval", approvalId: "apr_1", approvalUrl: "https://x/approvals?id=apr_1" }
					: null;
			},
		};
		const base = { kind: "transactional" as const, from: MB, mailboxId: MB, to: "a@x.com", hold: { action: "send_email", payload: {}, subject: "s" } };
		const held = await preSend({} as Env, { ...base, actor: { via: "mcp", credential: { method: "token", tokenId: "tok_1" } } }, { quota: quota(), rules: [hold] });
		expect(held).toMatchObject({ ok: false, outcome: "hold_for_approval", status: 202, approvalId: "apr_1" });
		if (held.ok) return;
		expect(httpRefusal(held)).toEqual([{ status: "pending_approval", approval_id: "apr_1", approval_url: "https://x/approvals?id=apr_1" }, 202]);

		const allowed = await preSend({} as Env, { ...base, actor: { via: "rest", credential: { method: "session" } } }, { quota: quota(), rules: [hold] });
		expect(allowed).toMatchObject({ ok: true, outcome: "allow" });
		expect(seen).toEqual([
			{ via: "mcp", method: "token", to: ["a@x.com"] },
			{ via: "rest", method: "session", to: ["a@x.com"] },
		]);

		// Not reached when a built-in already refused.
		const capped = await preSend({} as Env, { ...base, actor: { via: "mcp" } }, { quota: quota("over"), rules: [hold] });
		expect(capped).toMatchObject({ outcome: "block", code: "rate_limited" });
		expect(seen).toHaveLength(2);

		// A hold without a replayable request blocks; a throwing rule fails closed.
		const noHold = await preSend({} as Env, { ...base, hold: undefined, actor: { via: "mcp", credential: { method: "token" } } }, { quota: quota(), rules: [hold] });
		expect(noHold).toMatchObject({ outcome: "block", code: "rule", ruleCode: "hold_unavailable" });
		const broken: PreSendRule = { name: "broken", check: async () => { throw new Error("x"); } };
		expect(await preSend({} as Env, base, { quota: quota(), rules: [broken] })).toMatchObject({ outcome: "block", status: 503 });
		const blocker: PreSendRule = { name: "b", check: async () => ({ outcome: "block", code: "draft_only", status: 403, error: "Drafts only" }) };
		expect(await preSend({} as Env, base, { quota: quota(), rules: [blocker] })).toMatchObject({ outcome: "block", ruleCode: "draft_only", status: 403 });
		// The only built-in rule is the agent inbox policy (workers/lib/agent-send-rule.ts).
		expect(PRE_SEND_RULES.map((r) => r.name)).toEqual(["agent-inbox-policy"]);
	});

	it("a refusal thrown carries a machine code", () => {
		const e = new PreSendRefusedError({ outcome: "block", code: "bulk_paused", status: 423, error: "paused", domain: "d.com" });
		expect(e.code).toBe("E_BULK_PAUSED");
	});
});

// ── Each path refuses a suppressed recipient ───────────────────────

function toolEnv(s: ReturnType<typeof stores>, extra: Record<string, unknown> = {}) {
	const send = vi.fn(async () => ({ messageId: "p1" }));
	const stub = {
		checkSendRateLimit: async () => null,
		createEmail: vi.fn(async () => undefined),
		appendDeliveryEvent: async () => undefined,
		getEmail: async () => ({ id: "o", subject: "Q", sender: "dead@x.com", recipient: MB, date: "2026-10-01", body: "<p>x</p>", thread_id: "t", message_id: "m@x", email_references: null, attachments: [] }),
		getEmailByRef: async () => ({ id: "o", subject: "Q", sender: "a@x.com", recipient: MB, date: "2026-10-01", body: "<p>x</p>", thread_id: "t", message_id: "m@x", email_references: null, attachments: [] }),
		getTrackingSettings: async () => ({ open_tracking: false, click_tracking: false }),
		getOrCreateTrackingSecret: async () => "s",
		...extra,
	};
	const env = {
		AUTH_STORE: s.AUTH_STORE,
		MAILBOX: { idFromName: (n: string) => n, get: () => stub },
		EMAIL: { send },
		AI: { run: async () => ({ response: "UNCHANGED" }) },
		BUCKET: fakeBucket(),
		UNSUBSCRIBE_SECRET: "secret",
		APP_URL: "https://mailer.example.com",
	} as unknown as Env;
	return { env, send, stub };
}

describe("every path refuses a suppressed recipient", () => {
	it("agent/MCP send_email refuses a complaint, sends to an unsubscribe", async () => {
		const s = stores();
		await suppress(s.auth, "angry@x.com", "complaint", "product.dev");
		await suppress(s.auth, "left@x.com", "unsubscribed", "product.dev");
		const { env, send } = toolEnv(s);
		expect(await toolSendEmail(env, MB, { to: "angry@x.com", subject: "s", bodyHtml: "<p>hi</p>", verify: false })).toHaveProperty("error");
		expect(send).not.toHaveBeenCalled();
		expect(await toolSendEmail(env, MB, { to: "left@x.com", subject: "s", bodyHtml: "<p>hi</p>", verify: false })).toMatchObject({ status: "sent" });
	});

	it("agent/MCP send_reply refuses a hard bounce", async () => {
		const s = stores();
		await suppress(s.auth, "dead@x.com", "hard_bounce");
		const { env, send } = toolEnv(s);
		const r = await toolSendReply(env, MB, { originalEmailId: "o", to: "dead@x.com", subject: "Re", bodyHtml: "<p>x</p>" });
		expect(r).toHaveProperty("error");
		expect(send).not.toHaveBeenCalled();
	});

	it("agent/MCP forward_email refuses a suppressed Cc rather than dropping it silently", async () => {
		const s = stores();
		await suppress(s.auth, "dead@x.com", "hard_bounce");
		const { env, send } = toolEnv(s);
		const r = await toolForwardEmail(env, MB, { emailId: "o", to: "ok@x.com", cc: "dead@x.com", includeAttachments: false });
		expect(r).toHaveProperty("error");
		expect(send).not.toHaveBeenCalled();
	});

	it("MCP send_template is bulk: an unsubscribe blocks, and sends carry one-click + List-Id", async () => {
		const s = stores();
		const { env, send } = toolEnv(s);
		(env.BUCKET as any).store.set(
			"templates/welcome.json",
			JSON.stringify({ id: "w", slug: "welcome", name: "Welcome", subject: "Hi {{name}}", bodyHtml: "<p>Hi {{name}}</p>", createdAt: 0, updatedAt: 0 }),
		);
		await suppress(s.auth, "left@x.com", "unsubscribed", "product.dev");
		expect(await toolSendTemplate(env, MB, { slug: "welcome", to: "left@x.com", variables: { name: "A" } })).toHaveProperty("error");
		expect(send).not.toHaveBeenCalled();

		expect(await toolSendTemplate(env, MB, { slug: "welcome", to: "ok@x.com", variables: { name: "A" } })).toMatchObject({ status: "sent" });
		const message = send.mock.calls[0]![0] as unknown as { headers: Record<string, string>; html: string };
		expect(message.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/mailer\.example\.com\/u\/[^>]+>/);
		expect(message.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
		expect(message.headers["List-Id"]).toBe("<welcome.product.dev>");
		expect(message.html).toContain("/u/");
	});

	it("MCP send_template is refused while the domain's bulk sending is paused", async () => {
		const s = stores();
		s.health.pause("product.dev", "test", 1);
		const { env, send } = toolEnv(s);
		(env.BUCKET as any).store.set(
			"templates/welcome.json",
			JSON.stringify({ id: "w", slug: "welcome", name: "Welcome", subject: "Hi", bodyHtml: "<p>Hi</p>", createdAt: 0, updatedAt: 0 }),
		);
		const r = await toolSendTemplate(env, MB, { slug: "welcome", to: "ok@x.com", variables: {} });
		expect(String((r as { error?: string }).error)).toContain("paused");
		expect(send).not.toHaveBeenCalled();
	});

	it("automatic forwarding is not sent to a suppressed target", async () => {
		const s = stores();
		await suppress(s.auth, "me@gmail.example", "unsubscribed", "product.dev");
		const send = vi.fn();
		const env = { AUTH_STORE: s.AUTH_STORE } as unknown as Env;
		await expect(
			forwardInboundMessage({
				binding: { send } as unknown as SendEmail,
				env,
				gateDeps: { quota: quota() },
				mailboxId: MB,
				target: "me@gmail.example",
				parsed: { from: { address: "c@x.com", name: "C" }, subject: "S", html: "<p>x</p>", headers: [], attachments: [] } as never,
				to: [MB],
				cc: [],
			}),
		).rejects.toBeInstanceOf(PreSendRefusedError);
		expect(send).not.toHaveBeenCalled();
	});

	it("password resets go through the gate as system mail and are never filtered", async () => {
		const send = vi.fn(async () => ({ messageId: "x" }));
		await sendResetEmail({ send } as unknown as SendEmail, { email: "noreply@product.dev", name: "P" }, "owner@x.com", { subject: "Reset", text: "t", html: "<p>t</p>" }, "App");
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("scheduled delivery drops a recipient who hard-bounced after it was queued", async () => {
		const s = stores();
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
			id: { name: MB },
			storage: { sql: { exec }, transactionSync: <T>(fn: () => T) => fn(), getAlarm: async () => null, setAlarm: async () => {} },
		} as unknown as DurableObjectState;
		applyMigrations(ctx.storage.sql as unknown as SqlStorage, mailboxMigrations, ctx.storage as never);
		db.prepare(
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, cc, date, body, read)
			 VALUES ('e1', 'scheduled', 'Hi', ?, 'ok@x.com, dead@x.com', NULL, '2026-10-26T09:00:00.000Z', '<p>x</p>', 1)`,
		).run(MB);
		recordScheduledSend(ctx, "e1", "2026-10-26T09:00:00.000Z", { trackingBaseUrl: null, mailboxId: MB });
		await suppress(s.auth, "dead@x.com", "hard_bounce");

		const sent: Record<string, unknown>[] = [];
		const env = {
			AUTH_STORE: s.AUTH_STORE,
			EMAIL: { send: async (m: Record<string, unknown>) => (sent.push(m), { messageId: "p" }) },
			BUCKET: { get: async () => null },
		} as unknown as Env;
		await processDueScheduledSends(ctx, env, { now: new Date("2026-10-26T09:05:00.000Z") });
		expect(sent).toHaveLength(1);
		expect(sent[0].to).toEqual(["ok@x.com"]);
	});

	it("sequence steps are deferred, not cancelled, while bulk is paused", async () => {
		const s = stores();
		s.health.pause("product.dev", "test", 1);
		const bucket = fakeBucket();
		const nowSec = Math.floor(Date.now() / 1000);
		bucket.store.set("templates/welcome.json", JSON.stringify({ id: "w", slug: "welcome", name: "w", subject: "Hi", bodyHtml: "<p>Hello</p>", createdAt: 0, updatedAt: 0 }));
		bucket.store.set("sequence-enrollments/enr-1.json", JSON.stringify({ id: "enr-1", sequenceId: "seq-1", personId: "p", personEmail: "reader@example.org", personName: null, fromAddress: MB, status: "active", variables: {}, enrolledAt: nowSec, cancelledAt: null }));
		bucket.store.set("sequence-emails/step-1.json", JSON.stringify({ id: "step-1", enrollmentId: "enr-1", stepOrder: 1, templateSlug: "welcome", scheduledAt: nowSec - 60, status: "pending", sentAt: null, sentEmailId: null }));
		const send = vi.fn();
		const env = {
			AUTH_STORE: s.AUTH_STORE,
			BUCKET: bucket,
			UNSUBSCRIBE_SECRET: "x",
			MAILBOX: { idFromName: (n: string) => n, get: () => ({ checkSendRateLimit: async () => null, createEmail: async () => {} }) },
			EMAIL: { send },
		} as unknown as Env;
		const result = await dispatchDueSequenceEmails(env);
		expect(result).toMatchObject({ sent: 0, skipped: 1 });
		expect(send).not.toHaveBeenCalled();
		expect(JSON.parse(bucket.store.get("sequence-emails/step-1.json")!).status).toBe("pending");
		expect(JSON.parse(bucket.store.get("sequence-enrollments/enr-1.json")!).status).toBe("active");
	});
});
