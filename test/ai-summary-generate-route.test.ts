// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * `POST /api/v1/mailboxes/:mailboxId/threads/:threadId/summary/generate`, the
 * reader's "Summarize" button, over HTTP: the real API app and authz
 * middleware, a mailbox stub backed by real SQLite (every migration applied)
 * and a mocked `AI` binding.
 *
 * Assembled like `test/mailbox-delegates.test.ts`: an Access identity with
 * `ADMIN_EMAILS` set, so per-mailbox grants are enforced.
 */

import { describe, expect, it, vi } from "vitest";
import { routerOver } from "./helpers/ai-router";
import { Hono } from "hono";
import { app } from "../workers/index";
import { DEFAULT_AI_CONFIG, type AiConfig } from "../shared/ai-settings";
import { SUMMARY_SYSTEM_PROMPT } from "../shared/ai-summary";
import { getThreadSummary, summarizeThreadNow } from "../workers/durableObject/summaries";
import { requiredTokenScope } from "../workers/lib/token-scope-guard";
import type { Env } from "../workers/types";
import { mailboxSqlite } from "./helpers/mailbox-sqlite";

const ADMIN = "owner@tapetide.com";
const VIEWER = "viewer@tapetide.com";
const NO_READ = "noread@tapetide.com";
const STRANGER = "stranger@tapetide.com";
const SUPPORT = "support@tapetide.com";

function fakeBucket(initial: Record<string, unknown>) {
	const store = new Map<string, string>(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
	return {
		async head(key: string) {
			return store.has(key) ? { key } : null;
		},
		async get(key: string) {
			const raw = store.get(key);
			return raw === undefined ? null : { json: async () => JSON.parse(raw) };
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async delete(key: string | string[]) {
			for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
		},
		async list({ prefix = "" }: { prefix?: string } = {}) {
			return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false as const };
		},
	};
}

const grant = (id: string, mailboxes: unknown[]) => ({
	id,
	kind: "user",
	role: "member",
	mailboxes,
	updatedAt: "2026-01-01T00:00:00.000Z",
});

function build(options: { identity: string; config?: Partial<AiConfig> }) {
	const { ctx, insert, db } = mailboxSqlite();
	insert({ thread_id: "t1", body: "<p>Hi, could you resend invoice 42? Our auditor needs it by Friday.</p>" });

	const run = vi.fn(async (_model: string, input: { messages: { content: string }[]; response_format?: unknown }) => {
		const system = input.messages[0]!.content;
		if (system.includes("security scanner")) return { response: "NO" };
		if (system === SUMMARY_SYSTEM_PROMPT) {
			return {
				response: {
					line: "Asks you to resend invoice 42 before Friday",
					bullets: ["The sender needs invoice 42 again", "Their auditor needs it by Friday", "Reply with the PDF attached"],
				},
			};
		}
		throw new Error("unexpected call");
	});
	const ai = routerOver({ run });
	const config: AiConfig = { ...DEFAULT_AI_CONFIG, ...options.config };

	// The MailboxDO method, minus the RPC hop and the R2 config read.
	const stub = {
		summarizeThreadNow: (threadId: string) =>
			summarizeThreadNow(ctx, threadId, { ai, config, mailboxAddress: SUPPORT, now: new Date("2026-10-27T10:00:00Z") }),
	};

	const bindings = {
		ADMIN_EMAILS: ADMIN,
		DOMAINS: "tapetide.com",
		BUCKET: fakeBucket({
			[`mailboxes/${SUPPORT}.json`]: { fromName: "Support" },
			[`access/users/${VIEWER}.json`]: grant(VIEWER, [{ id: SUPPORT, role: "viewer" }]),
			[`access/users/${NO_READ}.json`]: grant(NO_READ, [{ id: SUPPORT, role: "viewer", revoked: ["read"] }]),
			[`access/users/${STRANGER}.json`]: grant(STRANGER, []),
		}),
		MAILBOX: { idFromName: (name: string) => ({ name }), get: () => stub },
		AI: ai,
	} as unknown as Env;

	const outer = new Hono();
	outer.use("*", async (c, next) => {
		c.set("accessIdentity", { kind: "user", id: options.identity, subject: "uuid-1" });
		return next();
	});
	outer.route("/", app);
	const executionCtx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

	const generate = (thread = "t1", mailbox = SUPPORT) =>
		Promise.resolve(
			outer.fetch(
				new Request(
					`https://mailer.tapetide.com/api/v1/mailboxes/${encodeURIComponent(mailbox)}/threads/${thread}/summary/generate`,
					{ method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" } },
				),
				bindings,
				executionCtx,
			),
		);
	return { generate, run, ctx, db, insert };
}

const summaryCalls = (run: ReturnType<typeof build>["run"]) =>
	run.mock.calls.filter((c) => c[1].messages[0]!.content === SUMMARY_SYSTEM_PROMPT);

describe("POST …/summary/generate", () => {
	it("generates the summary now for a reader: line + 3 bullets, one summary call", async () => {
		const h = build({ identity: VIEWER });
		const res = await h.generate();
		expect(res.status).toBe(200);
		const body = (await res.json()) as { summary: { line: string; bullets: string[]; status: string } };
		expect(body.summary).toMatchObject({
			line: "Asks you to resend invoice 42 before Friday",
			bullets: ["The sender needs invoice 42 again", "Their auditor needs it by Friday", "Reply with the PDF attached"],
			status: "ok",
		});
		expect(summaryCalls(h.run)).toHaveLength(1);
		expect(getThreadSummary(h.ctx, "t1")?.bullets).toHaveLength(3);
	});

	it("respects the daily cap: 429 and no model call", async () => {
		const h = build({ identity: ADMIN, config: { dailyCapPerMailbox: 2 } });
		h.db.prepare(`INSERT INTO summary_usage (day, generated) VALUES (?, ?)`).run("2026-10-27", 2);
		const res = await h.generate();
		expect(res.status).toBe(429);
		expect(await res.json()).toMatchObject({ code: "summary_cap" });
		expect(h.run).not.toHaveBeenCalled();
	});

	it("authz: no access to the mailbox, or read revoked, is refused before any model call", async () => {
		for (const identity of [STRANGER, NO_READ]) {
			const h = build({ identity });
			const res = await h.generate();
			expect({ identity, status: res.status }).toEqual({ identity, status: 403 });
			expect(h.run).not.toHaveBeenCalled();
		}
	});

	it("404 for a conversation with nothing countable (Spam only), 503 when summaries are off", async () => {
		const spam = build({ identity: ADMIN });
		spam.insert({ thread_id: "s1", folder: "spam" });
		expect((await spam.generate("s1")).status).toBe(404);

		const off = build({ identity: ADMIN, config: { summaries: false } });
		expect((await off.generate()).status).toBe(503);
		expect(spam.run).not.toHaveBeenCalled();
		expect(off.run).not.toHaveBeenCalled();
	});

	it("a scoped token needs no more than reading, and the capability gate still applies", () => {
		// Writes inside a mailbox are decided by the capability gate (`read` here).
		expect(requiredTokenScope("POST", `/api/v1/mailboxes/${SUPPORT}/threads/t1/summary/generate`)).toBe("mailbox");
	});
});
