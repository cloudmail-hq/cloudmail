// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * AI triage and Screener API.
 *
 *   GET  /api/v1/mailboxes/:mailboxId/label-prompts            labels, presets, usage
 *   PUT  /api/v1/mailboxes/:mailboxId/labels/:labelId/prompt   set a label's prompt, tab, auto-archive
 *   PUT  /api/v1/mailboxes/:mailboxId/triage/presets/:key      turn a preset on or off
 *   POST /api/v1/mailboxes/:mailboxId/triage/backfill          one bounded step over the last 14 days
 *   GET  /api/v1/mailboxes/:mailboxId/inbox-tabs               the split-inbox tabs as saved searches
 *   GET  /api/v1/mailboxes/:mailboxId/screener                 senders waiting for a decision
 *   POST /api/v1/mailboxes/:mailboxId/screener/:sender         Yes (allow) or No (block)
 *
 * Mounted at the root, behind `requireMailbox`. The capability gates are the
 * path-scoped ones in workers/index.ts: reading needs `read`; prompts, presets
 * and Yes/No need `manageRules` (they decide what arrives where and write the
 * sender lists); backfill needs `organise`.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import {
	LABEL_PROMPT_MAX_LENGTH,
	TRIAGE_PRESET_KEYS,
	inboxTabs,
	verdictLabel,
	type TriagePresetKey,
} from "../../shared/ai-triage";
import type { MailboxContext } from "../lib/mailbox";
import { readMailboxSettings, runBackfillStep, type TriageStub } from "../lib/triage";

type AppContext = Context<MailboxContext>;

const MB = "/api/v1/mailboxes/:mailboxId";

export const triageRoutes = new Hono<MailboxContext>();

/** The DO methods these routes call, typed once. */
interface TriageRouteStub extends TriageStub {
	listLabelPrompts(): Promise<unknown[]>;
	triagePresets(): Promise<unknown[]>;
	triageStatus(): Promise<{ ai_calls_today: number; corrections: number; backfill_remaining: number }>;
	setLabelPrompt(
		labelId: string,
		patch: { prompt?: string | null; autoArchive?: boolean; showTab?: boolean },
	): Promise<unknown | null>;
	setTriagePreset(
		key: TriagePresetKey,
		options: { enabled: boolean; autoArchive?: boolean; showTab?: boolean },
	): Promise<unknown | null>;
	tabLabels(): Promise<{ id: string; name: string; color: string; auto_archive: boolean }[]>;
	listScreener(limit?: number): Promise<
		{ sender: string; sender_kind: string | null; sender_confidence: string | null }[]
	>;
	screenSender(sender: string, decision: "allow" | "block", target?: "spam" | "trash"): Promise<unknown | null>;
}

const stubOf = (c: AppContext) => c.var.mailboxStub as unknown as TriageRouteStub;
const mailboxIdOf = (c: AppContext) => decodeURIComponent(c.req.param("mailboxId") ?? "");

const LabelPromptBody = z
	.object({
		prompt: z.string().max(LABEL_PROMPT_MAX_LENGTH).nullable().optional(),
		auto_archive: z.boolean().optional(),
		show_tab: z.boolean().optional(),
	})
	.strict();

const PresetBody = z
	.object({
		enabled: z.boolean(),
		auto_archive: z.boolean().optional(),
		show_tab: z.boolean().optional(),
	})
	.strict();

const BackfillBody = z.object({ limit: z.number().int().min(1).max(25).optional() }).strict();

const ScreenBody = z
	.object({
		decision: z.enum(["allow", "block"]),
		/** Where a No sends the backlog. */
		target: z.enum(["spam", "trash"]).optional(),
	})
	.strict();

/** The settings and limits the UI and agents need beside the label list. */
export async function labelPromptsView(stub: TriageRouteStub, settings: Awaited<ReturnType<typeof readMailboxSettings>>) {
	const [labels, presets, status] = await Promise.all([
		stub.listLabelPrompts(),
		stub.triagePresets(),
		stub.triageStatus(),
	]);
	return {
		enabled: settings.triage.enabled,
		screener: settings.screener,
		daily_ai_cap: settings.triage.dailyAiCap,
		...status,
		labels,
		presets,
	};
}

triageRoutes.get(`${MB}/label-prompts`, async (c: AppContext) => {
	const settings = await readMailboxSettings(c.env, mailboxIdOf(c));
	return c.json(await labelPromptsView(stubOf(c), settings));
});

triageRoutes.put(`${MB}/labels/:labelId/prompt`, async (c: AppContext) => {
	const body = LabelPromptBody.parse(await c.req.json());
	try {
		const label = await stubOf(c).setLabelPrompt(c.req.param("labelId")!, {
			prompt: body.prompt,
			autoArchive: body.auto_archive,
			showTab: body.show_tab,
		});
		return label ? c.json(label) : c.json({ error: "Label not found" }, 404);
	} catch (e) {
		const message = (e as Error).message;
		if (message.includes("inbox tabs")) return c.json({ error: message }, 400);
		throw e;
	}
});

triageRoutes.put(`${MB}/triage/presets/:key`, async (c: AppContext) => {
	const key = c.req.param("key")!;
	if (!(TRIAGE_PRESET_KEYS as readonly string[]).includes(key)) {
		return c.json({ error: `Unknown preset. One of: ${TRIAGE_PRESET_KEYS.join(", ")}` }, 404);
	}
	const body = PresetBody.parse(await c.req.json());
	try {
		const label = await stubOf(c).setTriagePreset(key as TriagePresetKey, {
			enabled: body.enabled,
			autoArchive: body.auto_archive,
			showTab: body.show_tab,
		});
		return c.json({ key, enabled: body.enabled, label });
	} catch (e) {
		const message = (e as Error).message;
		if (message.includes("inbox tabs")) return c.json({ error: message }, 400);
		throw e;
	}
});

triageRoutes.post(`${MB}/triage/backfill`, async (c: AppContext) => {
	const body = BackfillBody.parse(await c.req.json().catch(() => ({})));
	const settings = await readMailboxSettings(c.env, mailboxIdOf(c));
	if (!settings.triage.enabled) {
		return c.json({ error: "AI triage is off for this mailbox. Turn it on in settings first." }, 409);
	}
	return c.json(await runBackfillStep(c.env, stubOf(c), settings, body.limit));
});

triageRoutes.get(`${MB}/inbox-tabs`, async (c: AppContext) => {
	const labels = await stubOf(c).tabLabels();
	return c.json({
		tabs: inboxTabs(labels.map((l) => ({ id: l.id, name: l.name, color: l.color, autoArchive: l.auto_archive }))),
	});
});

triageRoutes.get(`${MB}/screener`, async (c: AppContext) => {
	const limit = Number(c.req.query("limit") ?? "") || undefined;
	const senders = await stubOf(c).listScreener(limit);
	return c.json({
		senders: senders.map((s) => ({ ...s, verdict: verdictLabel(s.sender_kind, s.sender_confidence) })),
	});
});

triageRoutes.post(`${MB}/screener/:sender`, async (c: AppContext) => {
	const body = ScreenBody.parse(await c.req.json());
	const sender = c.req.param("sender")!;
	const result = await stubOf(c).screenSender(sender, body.decision, body.target ?? "spam");
	return result ? c.json(result) : c.json({ error: "Not an email address" }, 400);
});
