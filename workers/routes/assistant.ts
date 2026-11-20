// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * AI summaries and the daily brief over HTTP.
 *
 *   GET  /api/v1/mailboxes/:mailboxId/threads/:threadId/summary          reader summary
 *   POST /api/v1/mailboxes/:mailboxId/threads/:threadId/summary/refresh  queue a regeneration
 *   POST /api/v1/mailboxes/:mailboxId/threads/:threadId/summary/generate generate now, within the cap
 *   GET  /api/v1/ai/settings                 instance AI settings (any caller)
 *   PUT  /api/v1/ai/settings                 change them (admin)
 *   GET  /api/v1/me/assistant                my list-summary + brief preferences
 *   PUT  /api/v1/me/assistant                change them
 *   GET  /api/v1/me/brief                    my latest brief ("Today" card)
 *   POST /api/v1/me/brief/generate           build it now
 *   POST /api/v1/me/brief/:briefId/dismiss   hide the card until the next brief
 *
 * The mailbox routes sit under `requireMailbox` and the `read` gate in
 * `workers/index.ts`. The `/me` routes act only on the caller's own
 * AssistantDO, and the brief is narrowed again to what the caller may read now
 * (a scoped token sees only its mailboxes even though the stored brief was
 * built with the user's full reach).
 */

import { Hono, type Context } from "hono";
import { AiConfigPatchSchema, AssistantPrefsPatchSchema } from "../../shared/ai-settings";
import { narrowBrief, type DailyBrief } from "../../shared/daily-brief";
import { canDo, type Principal } from "../lib/authz";
import { getAiConfig, updateAiConfig } from "../lib/ai-config";
import { assistantStub, type BriefOwner } from "../lib/daily-brief";
import { requireAdminScope, type MailboxContext } from "../lib/mailbox";

type AppContext = Context<MailboxContext>;

export const assistantRoutes = new Hono<MailboxContext>();

const MB = "/api/v1/mailboxes/:mailboxId/threads/:threadId";

assistantRoutes.get(`${MB}/summary`, async (c: AppContext) => {
	const stub = c.var.mailboxStub as unknown as {
		getThreadSummary(id: string): Promise<unknown>;
	};
	const summary = await stub.getThreadSummary(c.req.param("threadId")!);
	return c.json({ summary: summary ?? null });
});

assistantRoutes.post(`${MB}/summary/refresh`, async (c: AppContext) => {
	const stub = c.var.mailboxStub as unknown as {
		requestThreadSummary(id: string): Promise<{ queued: boolean }>;
	};
	return c.json(await stub.requestThreadSummary(c.req.param("threadId")!), 202);
});

/**
 * The reader's "Summarize" button: generate now, within the mailbox's daily
 * cap. 200 with the summary (possibly null when there is too little text),
 * 429 when the cap is spent, 404 when nothing in the conversation is countable
 * (Spam/Trash only, or unknown), 503 when summaries are off (`summaries_off`) or the model failed (`summary_failed`, still queued for the alarm).
 */
assistantRoutes.post(`${MB}/summary/generate`, async (c: AppContext) => {
	const stub = c.var.mailboxStub as unknown as {
		summarizeThreadNow(id: string): Promise<
			| { kind: "ok"; summary: unknown }
			| { kind: "capped" }
			| { kind: "not_found" }
			| { kind: "unavailable" }
			| { kind: "failed" }
		>;
	};
	const outcome = await stub.summarizeThreadNow(c.req.param("threadId")!);
	switch (outcome.kind) {
		case "ok":
			return c.json({ summary: outcome.summary ?? null });
		case "capped":
			return c.json(
				{ error: "Today's summary limit for this mailbox is used up. It resets at 00:00 UTC.", code: "summary_cap" },
				429,
			);
		case "not_found":
			return c.json({ error: "Nothing to summarise in this conversation.", code: "not_found" }, 404);
		case "failed":
			// Still queued: the alarm retries it with back-off.
			return c.json({ error: "The summary model is unavailable. It will be retried shortly.", code: "summary_failed" }, 503);
		default:
			return c.json({ error: "AI summaries are turned off.", code: "summaries_off" }, 503);
	}
});

// ── Instance settings ──────────────────────────────────────────────

assistantRoutes.get("/api/v1/ai/settings", async (c) => c.json(await getAiConfig(c.env.BUCKET, { fresh: true })));

assistantRoutes.put("/api/v1/ai/settings", requireAdminScope("admin"), async (c) => {
	const patch = AiConfigPatchSchema.parse(await c.req.json());
	return c.json(await updateAiConfig(c.env.BUCKET, patch));
});

// ── Per user ───────────────────────────────────────────────────────

function ownerOf(c: AppContext): BriefOwner | null {
	const identity = c.var.principal?.identity;
	if (!identity) return null;
	return {
		identity,
		isOwner: c.var.authUser?.isOwner ?? false,
		email: identity.kind === "user" ? identity.id : null,
	};
}

/** Briefs, narrowed to what this request may read. */
function visibleBrief(principal: Principal, brief: DailyBrief | null): DailyBrief | null {
	if (!brief) return null;
	return narrowBrief(brief, (mailbox) => canDo(principal, mailbox, "read"));
}

const NO_IDENTITY = {
	error: "The assistant needs a signed-in identity (none in local development without auth).",
	code: "no_identity",
};

function stubFor(c: AppContext) {
	const owner = ownerOf(c);
	if (!owner) return { owner: null, stub: null } as const;
	return { owner, stub: assistantStub(c.env, owner.identity.id) } as const;
}

assistantRoutes.get("/api/v1/me/assistant", async (c: AppContext) => {
	const { stub } = stubFor(c);
	if (!stub) return c.json({ error: NO_IDENTITY.error, code: NO_IDENTITY.code }, 409);
	return c.json(await stub.getPrefs());
});

assistantRoutes.put("/api/v1/me/assistant", async (c: AppContext) => {
	const { owner, stub } = stubFor(c);
	if (!owner || !stub) return c.json({ error: NO_IDENTITY.error, code: NO_IDENTITY.code }, 409);
	const patch = AssistantPrefsPatchSchema.parse(await c.req.json());
	return c.json(await stub.updatePrefs(owner, patch));
});

assistantRoutes.get("/api/v1/me/brief", async (c: AppContext) => {
	const { stub } = stubFor(c);
	if (!stub) return c.json({ brief: null, dismissed: false, nextRunAt: null });
	const state = await stub.getBriefState();
	return c.json({ ...state, brief: visibleBrief(c.var.principal, state.brief as DailyBrief | null) });
});

assistantRoutes.post("/api/v1/me/brief/generate", async (c: AppContext) => {
	const { owner, stub } = stubFor(c);
	if (!owner || !stub) return c.json({ error: NO_IDENTITY.error, code: NO_IDENTITY.code }, 409);
	const brief = await stub.generateBrief(owner);
	return c.json({ brief: visibleBrief(c.var.principal, brief as DailyBrief | null), dismissed: false }, 201);
});

assistantRoutes.post("/api/v1/me/brief/:briefId/dismiss", async (c: AppContext) => {
	const { stub } = stubFor(c);
	if (!stub) return c.json({ error: NO_IDENTITY.error, code: NO_IDENTITY.code }, 409);
	const ok = await stub.dismissBrief(c.req.param("briefId")!);
	return ok ? c.json({ status: "dismissed" }) : c.json({ error: "Brief not found" }, 404);
});
