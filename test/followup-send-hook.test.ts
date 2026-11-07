// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The follow-up send hook, composed the way workers/index.ts composes it: the
 * idempotency middleware, then the hook, then a send handler that consumes the
 * body itself.
 *
 * Pinned: the hook still sees the `followup` field after the handler read the
 * body; it sets nothing for a failed send; a replayed idempotent response does
 * not re-arm a reminder; a queued send's reminder counts from `send_at`; and
 * the real app mounts it on every send route.
 */

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { followupSendHook, FOLLOWUP_SEND_PATHS } from "../workers/routes/followups";
import { idempotency, type IdempotencyBackend } from "../workers/lib/idempotency";
import {
	IDEMPOTENCY_TABLE_SQL,
	beginIdempotent,
	completeIdempotent,
	releaseIdempotent,
	type IdempotencySql,
} from "../workers/lib/idempotency-store";

function sqlOver(db: DatabaseSync): IdempotencySql {
	return {
		exec(query: string, ...bindings: unknown[]) {
			const trimmed = query.trim();
			if (bindings.length === 0 && !/^(select|with)/i.test(trimmed)) {
				db.exec(trimmed);
				return { toArray: () => [] };
			}
			const rows = db.prepare(trimmed).all(...(bindings as never[])) as Record<string, unknown>[];
			return { toArray: () => rows };
		},
	} as unknown as IdempotencySql;
}

function harness(respond: (n: number) => Response = (n) => Response.json({ id: `msg-${n}`, status: "sent" }, { status: 202 })) {
	const setFollowup = vi.fn(async (args: { emailId: string; followupAt: string }) => ({
		email_id: args.emailId,
		followup_at: args.followupAt,
	}));
	const pending: Promise<unknown>[] = [];
	const db = new DatabaseSync(":memory:");
	db.exec(IDEMPOTENCY_TABLE_SQL);
	const sql = sqlOver(db);
	const backend: IdempotencyBackend = {
		idempotencyBegin: async (input) => beginIdempotent(sql, input),
		idempotencyComplete: async (input) => completeIdempotent(sql, input),
		idempotencyRelease: async (input) => releaseIdempotent(sql, input),
	};

	const app = new Hono<any>();
	let runs = 0;
	app.use("*", async (c, next) => {
		c.set("principal", { identity: { kind: "email", email: "founder@tapetide.com" }, token: null } as never);
		c.set("mailboxStub", { setFollowup } as never);
		return next();
	});
	const path = "/api/v1/mailboxes/:mailboxId/emails";
	app.on(["POST"], path, idempotency({ route: `POST ${path}`, backend: () => backend as never }));
	app.on(["POST"], path, followupSendHook);
	app.post(path, async (c) => {
		runs += 1;
		await c.req.json();
		return respond(runs);
	});

	const env = {
		BUCKET: { get: async () => null },
		AI: { run: async () => ({ response: "YES" }) },
	};
	const send = async (body: unknown, headers: Record<string, string> = {}) => {
		const res = await app.request(
			"/api/v1/mailboxes/founder%40tapetide.com/emails",
			{ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) },
			env,
			{ waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} } as never,
		);
		await Promise.all(pending.splice(0));
		return res;
	};
	return { send, setFollowup, runs: () => runs };
}

const MAIL = { to: "customer@example.org", subject: "Pricing", html: "<p>Could you confirm by Friday?</p>" };

describe("followupSendHook", () => {
	it("sets the reminder the body asks for after a successful send", async () => {
		const { send, setFollowup } = harness();
		const before = Date.now();
		await send({ ...MAIL, followup: { mode: "manual", delay_seconds: 86400 } });
		expect(setFollowup).toHaveBeenCalledTimes(1);
		const args = setFollowup.mock.calls[0]![0] as { emailId: string; followupAt: string };
		expect(args.emailId).toBe("msg-1");
		expect(Date.parse(args.followupAt) - before).toBeGreaterThanOrEqual(86400_000 - 50);
	});

	it("runs auto mode through the classifier", async () => {
		const { send, setFollowup } = harness();
		await send({ ...MAIL, followup: { mode: "auto" } });
		expect(setFollowup).toHaveBeenCalledWith(expect.objectContaining({ mode: "auto" }));
	});

	it("sets nothing for a failed send", async () => {
		const { send, setFollowup } = harness(() => Response.json({ error: "nope" }, { status: 429 }));
		await send({ ...MAIL, followup: { mode: "manual", delay_seconds: 86400 } });
		expect(setFollowup).not.toHaveBeenCalled();
	});

	it("does not re-arm on an idempotent replay", async () => {
		const { send, setFollowup, runs } = harness();
		const body = { ...MAIL, followup: { mode: "manual", delay_seconds: 86400 } };
		const key = { "Idempotency-Key": "send-1" };
		await send(body, key);
		const replay = await send(body, key);
		expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
		expect(runs()).toBe(1);
		expect(setFollowup).toHaveBeenCalledTimes(1);
	});

	it("counts a queued send's reminder from its send_at", async () => {
		const sendAt = "2026-12-01T09:00:00.000Z";
		const { send, setFollowup } = harness(() =>
			Response.json({ id: "q-1", status: "scheduled", send_at: sendAt }, { status: 201 }),
		);
		await send({ ...MAIL, followup: { mode: "manual", delay_seconds: 3600 } });
		expect(setFollowup).toHaveBeenCalledWith(
			expect.objectContaining({ emailId: "q-1", followupAt: "2026-12-01T10:00:00.000Z" }),
		);
	});

	it("is mounted on every send route of the real app", async () => {
		const { app } = await import("../workers/index");
		for (const path of FOLLOWUP_SEND_PATHS) {
			const hooked = app.routes.some(
				(r) => r.method === "POST" && r.path === path && r.handler === followupSendHook,
			);
			expect(hooked, path).toBe(true);
		}
	});
});
