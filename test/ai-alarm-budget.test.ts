// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The alarm's wall-clock AI budget against the real queues (SQLite): each of
 * triage, summaries and semantic indexing stops starting new items once the
 * budget is spent, leaves the rest queued, and reports a next run so the
 * alarm re-arms, instead of relying on batch counts alone.
 */

import { describe, expect, it, vi } from "vitest";
import { routerOver } from "./helpers/ai-router";
import { mailboxSqlite } from "./helpers/mailbox-sqlite";
import { AiWorkBudget } from "../workers/lib/ai-budget";
import { enqueueSummary, pendingSummaryCount, processSummaryQueue } from "../workers/durableObject/summaries";
import { enqueueSemantic, pendingSemanticCount, processSemanticQueue, type VectorizeIndexLike } from "../workers/durableObject/semantic";
import * as triage from "../workers/durableObject/triage";
import { drainTriageQueue, type TriageStub } from "../workers/lib/triage";
import { parseStoredMailboxSettings } from "../shared/mailbox-settings";
import { DEFAULT_AI_CONFIG } from "../shared/ai-settings";
import { SUMMARY_SYSTEM_PROMPT } from "../shared/ai-summary";
import { EMBEDDING_DIMENSIONS } from "../shared/semantic";

/** A clock the model calls advance, so "slow calls" spend the budget. */
function slowClock(msPerCall: number) {
	let now = 0;
	return {
		now: () => now,
		tick: () => {
			now += msPerCall;
		},
	};
}

describe("alarm wall-clock budget, real queues", () => {
	it("summaries: stops after the budget, keeps the rest queued, asks for a prompt re-run", async () => {
		const { ctx, insert } = mailboxSqlite();
		for (let t = 0; t < 6; t++) {
			insert({ thread_id: `t${t}`, body: `<p>Thread ${t}: can you resend invoice ${t} before Friday, please?</p>` });
			enqueueSummary(ctx, `t${t}`);
		}
		// Each conversation costs two calls (scan + summary) of 5 s each.
		const clock = slowClock(5_000);
		const run = vi.fn(async (_m: string, input: { messages: { content: string }[] }) => {
			clock.tick();
			if (input.messages[0]!.content === SUMMARY_SYSTEM_PROMPT) {
				return { response: { line: "Asks to resend an invoice", bullets: ["Resend the invoice", "By Friday", "Reply with the PDF"] } };
			}
			return { response: "NO" };
		});
		const budget = new AiWorkBudget(25_000, clock.now);
		const r = await processSummaryQueue(ctx, {
			ai: routerOver({ run }),
			config: DEFAULT_AI_CONFIG,
			mailboxAddress: "support@example.com",
			ignoreDebounce: true,
			budget,
		});
		// 10 s per conversation: the third starts at 20 s, the fourth would start at 30 s.
		expect(r.generated).toBe(3);
		expect(r.processed).toBe(3);
		expect(pendingSummaryCount(ctx)).toBe(3);
		expect(r.remaining).toBe(3);
		expect(r.nextRunAt).not.toBeNull();
		expect(r.failed).toBe(0);
	});

	it("summaries: without a budget the batch count is the only bound (unchanged)", async () => {
		const { ctx, insert } = mailboxSqlite();
		for (let t = 0; t < 3; t++) {
			insert({ thread_id: `t${t}` });
			enqueueSummary(ctx, `t${t}`);
		}
		const run = vi.fn(async () => ({ response: "NO" }));
		const r = await processSummaryQueue(ctx, {
			ai: routerOver({ run }),
			mailboxAddress: "support@example.com",
			ignoreDebounce: true,
		});
		expect(r.processed).toBe(3);
	});

	it("semantic: stops after the budget and keeps the rest queued", async () => {
		const { ctx, insert } = mailboxSqlite();
		const ids = Array.from({ length: 5 }, (_, i) =>
			insert({ subject: `Note ${i}`, body: `<p>A message with enough words to embed, number ${i}.</p>` }),
		);
		for (const id of ids) enqueueSemantic(ctx, id, "support@example.com");
		const clock = slowClock(10_000);
		const run = vi.fn(async (_m: string, input: { text: string[] }) => {
			clock.tick();
			return { data: input.text.map(() => new Array(EMBEDDING_DIMENSIONS).fill(0.01)) };
		});
		const index: VectorizeIndexLike = {
			upsert: vi.fn(async () => ({})),
			deleteByIds: vi.fn(async () => ({})),
			query: vi.fn(async () => ({ matches: [], count: 0 }) as never),
		};
		const r = await processSemanticQueue(ctx, {
			ai: routerOver({ run }),
			index,
			config: DEFAULT_AI_CONFIG,
			ignoreDebounce: true,
			budget: new AiWorkBudget(25_000, clock.now),
		});
		// Starts at 0, 10 and 20 s; the fourth would start at 30 s.
		expect(r.indexed).toBe(3);
		expect(pendingSemanticCount(ctx)).toBe(2);
		expect(r.nextRunAt).not.toBeNull();
	});

	it("triage: stops after the budget, and untried rows keep their attempts", async () => {
		const { ctx, insert } = mailboxSqlite();
		for (let i = 0; i < 5; i++) {
			insert({ id: `e${i}` });
			triage.enqueueTriage(ctx, `e${i}`, "support@example.com", new Date(Date.UTC(2026, 9, 27, 10, 0, i)));
		}
		const clock = slowClock(0);
		let calls = 0;
		const stub = {
			getEmail: async (id: string) => {
				calls++;
				clock.tick();
				return { id, folder_id: "inbox", sender: "a@example.com", subject: "s", body: "<p>x</p>" };
			},
			markTriaged: async () => {},
		} as unknown as TriageStub;
		const attempts = () =>
			Object.fromEntries(
				(ctx.storage.sql.exec(`SELECT email_id, attempts FROM triage_queue ORDER BY email_id`).toArray() as {
					email_id: string;
					attempts: number;
				}[]).map((r) => [r.email_id, r.attempts]),
			);

		// Budget already spent after the second message.
		let n = 0;
		const budget = { exhausted: () => n++ >= 2, remainingMs: () => 0 } as unknown as AiWorkBudget;
		const r = await drainTriageQueue(
			{},
			stub,
			{
				take: (limit) => triage.takeTriageBatch(ctx, limit),
				release: (ids) => triage.releaseTriage(ctx, ids),
				finish: (id, outcome) => triage.finishTriage(ctx, id, outcome),
			},
			// Triage off: each message resolves without a model call, as "disabled".
			parseStoredMailboxSettings({}),
			undefined,
			budget,
		);
		expect(r).toMatchObject({ processed: 2, outOfTime: true });
		expect(calls).toBe(2);
		// e0 and e1 were handled and left the queue; the rest wait for the next run.
		const left = attempts();
		expect(Object.keys(left)).toEqual(["e2", "e3", "e4"]);
		// Never tried: the attempt `take` counted was given back.
		expect(Object.values(left)).toEqual([0, 0, 0]);
	});
});
