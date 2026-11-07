// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Storage for AI triage and the Screener (migration 35).
 *
 * Plain functions over `DurableObjectState`, like ./features.ts and ./bulk.ts,
 * so they run against real SQLite in tests. The model call itself happens in
 * the Worker (workers/lib/triage.ts); this module only reads and writes rows.
 *
 * Invariants:
 *   - A label applied by triage carries `source = 'ai' | 'heuristic'`. A
 *     person's label has `source` NULL or 'user', a rule's 'rule'.
 *   - Triage never touches a message a rule filed or labelled, nor one in
 *     Spam or Trash.
 *   - The daily AI budget is checked and spent in one statement, so two
 *     concurrent messages cannot both take the last call.
 *   - Corrections are bounded to `CORRECTIONS_KEPT` rows.
 */

import { Folders } from "../../shared/folders";
import {
	AI_CALLS_PER_MESSAGE,
	BACKFILL_MAX_MESSAGES,
	CORRECTIONS_KEPT,
	FEW_SHOT_EXAMPLES,
	MAX_ACTIVE_PROMPTS,
	MAX_INBOX_TABS,
	TRIAGE_PRESETS,
	backfillSince,
	isAutoLabelSource,
	presetByKey,
	sanitizeLabelPrompt,
	usageDay,
	type ActiveLabelPrompt,
	type LabelSource,
	type TriageCorrection,
	type TriagePresetKey,
} from "../../shared/ai-triage";
import { BULK_LIMIT, chunkIds, placeholders } from "./bulk";
import { trashOnly } from "./trash";
import * as features from "./features";

export interface LabelPromptRow {
	id: string;
	name: string;
	color: string;
	prompt: string | null;
	preset_key: string | null;
	auto_archive: boolean;
	show_tab: boolean;
}

function readLabelRows(ctx: DurableObjectState, where = "", ...params: unknown[]): LabelPromptRow[] {
	const rows = ctx.storage.sql
		.exec(
			`SELECT id, name, color, prompt, preset_key, auto_archive, show_tab
			   FROM labels ${where}
			  ORDER BY sort_order ASC, name ASC`,
			...(params as never[]),
		)
		.toArray() as unknown as (Omit<LabelPromptRow, "auto_archive" | "show_tab"> & {
		auto_archive: number;
		show_tab: number;
	})[];
	return rows.map((r) => ({ ...r, auto_archive: !!r.auto_archive, show_tab: !!r.show_tab }));
}

/** Every label with its triage settings. */
export function listLabelPrompts(ctx: DurableObjectState): LabelPromptRow[] {
	return readLabelRows(ctx);
}

/** Labels the classifier is asked about: those with a prompt. */
export function activeLabelPrompts(ctx: DurableObjectState): ActiveLabelPrompt[] {
	return readLabelRows(ctx, "WHERE prompt IS NOT NULL AND TRIM(prompt) != ''")
		.slice(0, MAX_ACTIVE_PROMPTS)
		.map((l) => ({ id: l.id, name: l.name, prompt: l.prompt! }));
}

/** Labels shown as inbox tabs, with what the tab bar needs. */
export function tabLabels(ctx: DurableObjectState): LabelPromptRow[] {
	return readLabelRows(ctx, "WHERE show_tab = 1").slice(0, MAX_INBOX_TABS);
}

export interface LabelPromptPatch {
	/** `null` clears the prompt, which stops auto-labelling with it. */
	prompt?: string | null;
	autoArchive?: boolean;
	showTab?: boolean;
}

/** Returns null when the label does not exist. */
export function setLabelPrompt(
	ctx: DurableObjectState,
	labelId: string,
	patch: LabelPromptPatch,
): LabelPromptRow | null {
	if (readLabelRows(ctx, "WHERE id = ?", labelId).length === 0) return null;
	if (patch.prompt !== undefined) {
		const prompt = patch.prompt === null ? null : sanitizeLabelPrompt(patch.prompt) || null;
		ctx.storage.sql.exec(`UPDATE labels SET prompt = ? WHERE id = ?`, prompt, labelId);
	}
	if (patch.autoArchive !== undefined) {
		ctx.storage.sql.exec(`UPDATE labels SET auto_archive = ? WHERE id = ?`, patch.autoArchive ? 1 : 0, labelId);
	}
	if (patch.showTab !== undefined) {
		if (patch.showTab && tabLabels(ctx).filter((l) => l.id !== labelId).length >= MAX_INBOX_TABS) {
			throw new TriageLimitError(`At most ${MAX_INBOX_TABS} inbox tabs`);
		}
		ctx.storage.sql.exec(`UPDATE labels SET show_tab = ? WHERE id = ?`, patch.showTab ? 1 : 0, labelId);
	}
	return readLabelRows(ctx, "WHERE id = ?", labelId)[0] ?? null;
}

export class TriageLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TriageLimitError";
	}
}

/**
 * Turn a preset on or off.
 *
 * On: reuse the preset's label (by `preset_key`, then by name, so a label the
 * user already made called "Billing" is adopted rather than duplicated), give
 * it the preset prompt, and apply the tab and auto-archive choices. Off: clear
 * the prompt and the tab and archive flags, keep the label and what it carries.
 */
export function setPreset(
	ctx: DurableObjectState,
	key: TriagePresetKey,
	options: { enabled: boolean; autoArchive?: boolean; showTab?: boolean },
): LabelPromptRow | null {
	const preset = presetByKey(key);
	if (!preset) return null;
	let label =
		readLabelRows(ctx, "WHERE preset_key = ?", key)[0] ??
		readLabelRows(ctx, "WHERE name = ? COLLATE NOCASE", preset.name)[0] ??
		null;

	if (!options.enabled) {
		if (!label) return null;
		ctx.storage.sql.exec(
			`UPDATE labels SET prompt = NULL, auto_archive = 0, show_tab = 0 WHERE id = ?`,
			label.id,
		);
		return readLabelRows(ctx, "WHERE id = ?", label.id)[0] ?? null;
	}

	if (!label) {
		const id = crypto.randomUUID();
		ctx.storage.sql.exec(
			`INSERT INTO labels (id, name, color, sort_order) VALUES (?, ?, ?, 0)`,
			id,
			preset.name,
			preset.color,
		);
		label = readLabelRows(ctx, "WHERE id = ?", id)[0]!;
	}
	ctx.storage.sql.exec(
		`UPDATE labels SET prompt = COALESCE(NULLIF(TRIM(prompt), ''), ?), preset_key = ? WHERE id = ?`,
		preset.prompt,
		key,
		label.id,
	);
	return setLabelPrompt(ctx, label.id, {
		autoArchive: options.autoArchive ?? preset.suggestAutoArchive,
		showTab: options.showTab ?? preset.suggestTab,
	});
}

/** Preset state for the settings screen and `list_label_prompts`. */
export function presetStatus(ctx: DurableObjectState) {
	const labels = listLabelPrompts(ctx);
	return TRIAGE_PRESETS.map((preset) => {
		const label = labels.find((l) => l.preset_key === preset.key) ?? null;
		return {
			key: preset.key,
			name: preset.name,
			prompt: preset.prompt,
			enabled: !!label?.prompt,
			label_id: label?.id ?? null,
			auto_archive: label?.auto_archive ?? false,
			show_tab: label?.show_tab ?? false,
		};
	});
}

/** The label id a preset maps to in this mailbox, only while it is enabled. */
export function presetLabelId(ctx: DurableObjectState, key: TriagePresetKey): string | null {
	const row = ctx.storage.sql
		.exec(
			`SELECT id FROM labels WHERE preset_key = ? AND prompt IS NOT NULL AND TRIM(prompt) != '' LIMIT 1`,
			key,
		)
		.toArray()[0] as { id: string } | undefined;
	return row?.id ?? null;
}

// ── Applying labels ───────────────────────────────────────────────

export interface ApplyOutcome {
	applied: string[];
	archived: boolean;
	skipped?: "missing" | "excluded" | "rule";
}

/**
 * Apply triage labels to a stored message, then auto-archive if any of them
 * asks for it.
 *
 * Refused for messages in Spam, Trash, Sent, Drafts or Scheduled, and for
 * messages a rule already labelled: rules win, and a person's own labels are
 * never removed. Only an Inbox message is moved by auto-archive, so a message
 * the user already filed somewhere stays there. Marks `triage_state` done.
 */
export function applyTriage(
	ctx: DurableObjectState,
	emailId: string,
	labelIds: readonly string[],
	source: Extract<LabelSource, "ai" | "heuristic">,
	verdict?: { kind: string | null; confidence: string | null },
): ApplyOutcome {
	const row = ctx.storage.sql
		.exec(`SELECT folder_id FROM emails WHERE id = ?`, emailId)
		.toArray()[0] as { folder_id: string } | undefined;
	if (!row) return { applied: [], archived: false, skipped: "missing" };

	const excluded: string[] = [Folders.SPAM, Folders.TRASH, Folders.SENT, Folders.DRAFT, Folders.SCHEDULED];
	if (excluded.includes(row.folder_id)) return { applied: [], archived: false, skipped: "excluded" };

	const ruleLabelled =
		ctx.storage.sql
			.exec(`SELECT 1 FROM email_labels WHERE email_id = ? AND source = 'rule' LIMIT 1`, emailId)
			.toArray().length > 0;
	if (ruleLabelled) {
		markTriaged(ctx, emailId, "rule");
		return { applied: [], archived: false, skipped: "rule" };
	}

	const applied: string[] = [];
	let archived = false;
	ctx.storage.transactionSync(() => {
		for (const labelId of new Set(labelIds)) {
			const label = ctx.storage.sql
				.exec(`SELECT id, auto_archive FROM labels WHERE id = ?`, labelId)
				.toArray()[0] as { id: string; auto_archive: number } | undefined;
			if (!label) continue;
			// A label the user removed from this message before is not put back.
			const corrected =
				ctx.storage.sql
					.exec(
						`SELECT 1 FROM triage_corrections c JOIN emails e ON e.sender = c.sender
						  WHERE e.id = ? AND c.label_id = ? AND c.action != 'added' AND c.subject = COALESCE(e.subject, '') LIMIT 1`,
						emailId,
						labelId,
					)
					.toArray().length > 0;
			if (corrected) continue;
			const wrote = ctx.storage.sql.exec(
				`INSERT OR IGNORE INTO email_labels (email_id, label_id, source) VALUES (?, ?, ?)`,
				emailId,
				labelId,
				source,
			).rowsWritten;
			if (wrote > 0) applied.push(labelId);
			if (label.auto_archive && row.folder_id === Folders.INBOX && !archived) {
				ctx.storage.sql.exec(
					`UPDATE emails SET folder_id = ? WHERE id = ? AND folder_id = ?`,
					Folders.ARCHIVE,
					emailId,
					Folders.INBOX,
				);
				archived = true;
			}
		}
		if (verdict && (verdict.kind || verdict.confidence)) {
			ctx.storage.sql.exec(
				`UPDATE emails SET sender_kind = ?, sender_confidence = ? WHERE id = ?`,
				verdict.kind,
				verdict.confidence,
				emailId,
			);
		}
		markTriaged(ctx, emailId, "done");
	});
	return { applied, archived };
}

/** Record that triage has looked at a message, whatever it decided. */
export function markTriaged(ctx: DurableObjectState, emailId: string, state: string): void {
	ctx.storage.sql.exec(`UPDATE emails SET triage_state = ? WHERE id = ?`, state, emailId);
}

/** Tag labels applied by a rule, so triage and the feedback loop leave them alone. */
export function markRuleLabels(ctx: DurableObjectState, emailId: string, labelIds: readonly string[]): void {
	for (const labelId of labelIds) {
		ctx.storage.sql.exec(
			`UPDATE email_labels SET source = 'rule' WHERE email_id = ? AND label_id = ?`,
			emailId,
			labelId,
		);
	}
}

// ── Budget ─────────────────────────────────────────────────────────

/**
 * Spend `calls` from today's budget if it fits under `cap`. Atomic: one
 * conditional upsert, so the last call cannot be taken twice.
 */
export function consumeAiBudget(
	ctx: DurableObjectState,
	cap: number,
	calls = AI_CALLS_PER_MESSAGE,
	now: Date = new Date(),
): boolean {
	if (cap <= 0 || calls > cap) return false;
	const day = usageDay(now);
	ctx.storage.sql.exec(`INSERT OR IGNORE INTO ai_usage (day, calls) VALUES (?, 0)`, day);
	const wrote = ctx.storage.sql.exec(
		`UPDATE ai_usage SET calls = calls + ?1 WHERE day = ?2 AND calls + ?1 <= ?3`,
		calls,
		day,
		cap,
	).rowsWritten;
	// Old days are only ever read for today; keep a week for the settings screen.
	ctx.storage.sql.exec(`DELETE FROM ai_usage WHERE day < ?`, usageDay(new Date(now.getTime() - 7 * 86_400_000)));
	return wrote > 0;
}

export function aiUsageToday(ctx: DurableObjectState, now: Date = new Date()): number {
	const row = ctx.storage.sql
		.exec(`SELECT calls FROM ai_usage WHERE day = ?`, usageDay(now))
		.toArray()[0] as { calls: number } | undefined;
	return row?.calls ?? 0;
}

// ── Feedback loop ──────────────────────────────────────────────────

interface LabelOnMessage {
	label_id: string;
	label_name: string;
	source: string | null;
	prompt: string | null;
	auto_archive: number;
}

function labelsOn(ctx: DurableObjectState, emailId: string): LabelOnMessage[] {
	return ctx.storage.sql
		.exec(
			`SELECT el.label_id, l.name AS label_name, el.source, l.prompt, l.auto_archive
			   FROM email_labels el JOIN labels l ON l.id = el.label_id
			  WHERE el.email_id = ?`,
			emailId,
		)
		.toArray() as unknown as LabelOnMessage[];
}

function messageKey(ctx: DurableObjectState, emailId: string): { sender: string; subject: string } | null {
	const row = ctx.storage.sql
		.exec(`SELECT sender, subject FROM emails WHERE id = ?`, emailId)
		.toArray()[0] as { sender: string | null; subject: string | null } | undefined;
	if (!row) return null;
	return { sender: (row.sender ?? "").toLowerCase(), subject: row.subject ?? "" };
}

export function recordCorrection(
	ctx: DurableObjectState,
	input: { sender: string; subject: string; labelId: string | null; labelName: string; action: TriageCorrection["action"] },
	now: Date = new Date(),
): void {
	if (!input.sender) return;
	// One row per (sender, subject, label): the latest decision is the one that counts.
	ctx.storage.sql.exec(
		`DELETE FROM triage_corrections WHERE sender = ? AND subject = ? AND label_name = ?`,
		input.sender,
		input.subject,
		input.labelName,
	);
	ctx.storage.sql.exec(
		`INSERT INTO triage_corrections (id, sender, subject, label_id, label_name, action, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		crypto.randomUUID(),
		input.sender,
		input.subject.slice(0, 200),
		input.labelId,
		input.labelName,
		input.action,
		now.toISOString(),
	);
	ctx.storage.sql.exec(
		`DELETE FROM triage_corrections WHERE id NOT IN (
			SELECT id FROM triage_corrections ORDER BY created_at DESC, id DESC LIMIT ?
		)`,
		CORRECTIONS_KEPT,
	);
}

/** Newest corrections, as few-shot examples for the classifier. */
export function recentCorrections(ctx: DurableObjectState, limit = FEW_SHOT_EXAMPLES): TriageCorrection[] {
	const rows = ctx.storage.sql
		.exec(
			`SELECT sender, subject, label_name, action FROM triage_corrections
			  ORDER BY created_at DESC, id DESC LIMIT ?`,
			limit,
		)
		.toArray() as unknown as { sender: string; subject: string; label_name: string; action: TriageCorrection["action"] }[];
	return rows.map((r) => ({ sender: r.sender, subject: r.subject, labelName: r.label_name, action: r.action }));
}

export function correctionCount(ctx: DurableObjectState): number {
	const row = ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM triage_corrections`).toArray()[0] as { n: number } | undefined;
	return row?.n ?? 0;
}

/**
 * Called before a label comes off a message. Learns from a person undoing an
 * automatic label; ignores everything else.
 */
export function noteLabelRemoved(ctx: DurableObjectState, emailId: string, labelId: string): void {
	const label = labelsOn(ctx, emailId).find((l) => l.label_id === labelId);
	if (!label || !isAutoLabelSource(label.source)) return;
	const key = messageKey(ctx, emailId);
	if (!key) return;
	recordCorrection(ctx, { ...key, labelId, labelName: label.label_name, action: "removed" });
}

/** Called after a person adds a label. A prompt label added by hand is a positive example. */
export function noteLabelAdded(ctx: DurableObjectState, emailId: string, labelId: string): void {
	const label = labelsOn(ctx, emailId).find((l) => l.label_id === labelId);
	if (!label || !label.prompt || isAutoLabelSource(label.source) || label.source === "rule") return;
	const key = messageKey(ctx, emailId);
	if (!key) return;
	recordCorrection(ctx, { ...key, labelId, labelName: label.label_name, action: "added" });
}

/** `setEmailLabels` replaces a set; learn from the difference. */
export function noteLabelSetReplaced(ctx: DurableObjectState, emailId: string, next: readonly string[]): void {
	const keep = new Set(next);
	for (const label of labelsOn(ctx, emailId)) {
		if (!keep.has(label.label_id)) noteLabelRemoved(ctx, emailId, label.label_id);
	}
}

/**
 * Called before a message moves. Pulling an auto-archived message back into
 * the Inbox says the archiving label was wrong: record it and take the label
 * off, so the message shows in Primary.
 */
export function noteMoved(ctx: DurableObjectState, emailIds: readonly string[], folderId: string): void {
	if (folderId !== Folders.INBOX) return;
	for (const emailId of emailIds) {
		const row = ctx.storage.sql
			.exec(`SELECT folder_id FROM emails WHERE id = ?`, emailId)
			.toArray()[0] as { folder_id: string } | undefined;
		if (row?.folder_id !== Folders.ARCHIVE) continue;
		const key = messageKey(ctx, emailId);
		if (!key) continue;
		for (const label of labelsOn(ctx, emailId)) {
			if (!isAutoLabelSource(label.source) || !label.auto_archive) continue;
			recordCorrection(ctx, { ...key, labelId: label.label_id, labelName: label.label_name, action: "moved" });
			ctx.storage.sql.exec(
				`DELETE FROM email_labels WHERE email_id = ? AND label_id = ?`,
				emailId,
				label.label_id,
			);
		}
	}
}

// ── Backfill ───────────────────────────────────────────────────────

export interface BackfillCandidate {
	id: string;
	sender: string;
	sender_name: string | null;
	subject: string | null;
	body: string | null;
	raw_headers: string | null;
	folder_id: string;
}

/**
 * The next messages backfill should look at.
 *
 * Bounded three ways: the last `BACKFILL_DAYS`, the newest
 * `BACKFILL_MAX_MESSAGES` of those, and `limit` per step. Only Inbox and
 * Screener mail that triage has never seen and nobody has labelled, so a
 * person's own labels and every rule decision are left alone.
 */
export function backfillCandidates(ctx: DurableObjectState, limit: number, now: Date = new Date()): BackfillCandidate[] {
	return ctx.storage.sql
		.exec(
			`SELECT id, sender, sender_name, subject, body, raw_headers, folder_id FROM (
				SELECT * FROM emails
				 WHERE folder_id IN (?1, ?2) AND date >= ?3
				 ORDER BY date DESC, id DESC
				 LIMIT ?4
			 ) recent
			 WHERE triage_state IS NULL
			   AND NOT EXISTS (SELECT 1 FROM email_labels el WHERE el.email_id = recent.id)
			 ORDER BY date DESC, id DESC
			 LIMIT ?5`,
			Folders.INBOX,
			Folders.SCREENER,
			backfillSince(now),
			BACKFILL_MAX_MESSAGES,
			limit,
		)
		.toArray() as unknown as BackfillCandidate[];
}

export function backfillRemaining(ctx: DurableObjectState, now: Date = new Date()): number {
	const row = ctx.storage.sql
		.exec(
			`SELECT COUNT(*) AS n FROM (
				SELECT * FROM emails
				 WHERE folder_id IN (?1, ?2) AND date >= ?3
				 ORDER BY date DESC, id DESC
				 LIMIT ?4
			 ) recent
			 WHERE triage_state IS NULL
			   AND NOT EXISTS (SELECT 1 FROM email_labels el WHERE el.email_id = recent.id)`,
			Folders.INBOX,
			Folders.SCREENER,
			backfillSince(now),
			BACKFILL_MAX_MESSAGES,
		)
		.toArray()[0] as { n: number } | undefined;
	return row?.n ?? 0;
}

// ── Post-ingest queue ──────────────────────────────────────────────
//
// Inbound mail is queued here and classified by the mailbox alarm, in the
// same run that drains `summary_queue` (./summaries.ts). One post-ingest job,
// durable across a lost `waitUntil`, and bounded per run.

/** Messages classified per alarm run. Each is up to two short model calls. */
export const TRIAGE_BATCH = 5;
/** Attempts before a message that keeps failing is dropped from the queue. */
export const TRIAGE_MAX_ATTEMPTS = 3;
/** How soon after delivery the alarm picks a message up. No debounce: tabs and the Screener verdict should be prompt. */
export const TRIAGE_DELAY_MS = 1_000;

export function enqueueTriage(
	ctx: DurableObjectState,
	emailId: string,
	mailboxId: string,
	now: Date = new Date(),
): void {
	ctx.storage.sql.exec(
		`INSERT INTO triage_queue (email_id, mailbox_id, enqueued_at, attempts) VALUES (?1, ?2, ?3, 0)
		 ON CONFLICT(email_id) DO NOTHING`,
		emailId,
		mailboxId.trim().toLowerCase(),
		now.toISOString(),
	);
}

/** The mailbox the queued rows belong to (one DO is one mailbox). */
export function queuedMailboxId(ctx: DurableObjectState): string | null {
	const row = ctx.storage.sql
		.exec(`SELECT mailbox_id FROM triage_queue ORDER BY enqueued_at ASC LIMIT 1`)
		.toArray()[0] as { mailbox_id: string } | undefined;
	return row?.mailbox_id ?? null;
}

export function pendingTriageCount(ctx: DurableObjectState): number {
	try {
		const row = ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM triage_queue`).toArray()[0] as { n: number } | undefined;
		return Number(row?.n ?? 0);
	} catch {
		return 0;
	}
}

/** The oldest queued message ids, and the attempt that this run is. */
export function takeTriageBatch(ctx: DurableObjectState, limit = TRIAGE_BATCH): string[] {
	const rows = ctx.storage.sql
		.exec(`SELECT email_id FROM triage_queue ORDER BY enqueued_at ASC LIMIT ?1`, limit)
		.toArray() as { email_id: string }[];
	for (const r of rows) {
		ctx.storage.sql.exec(`UPDATE triage_queue SET attempts = attempts + 1 WHERE email_id = ?1`, r.email_id);
	}
	return rows.map((r) => r.email_id);
}

/** Give back the attempt `takeTriageBatch` counted, for rows a run never reached. */
export function releaseTriage(ctx: DurableObjectState, emailIds: string[]): void {
	for (const id of emailIds) {
		ctx.storage.sql.exec(`UPDATE triage_queue SET attempts = MAX(attempts - 1, 0) WHERE email_id = ?1`, id);
	}
}

/** Done with a message: classified, skipped, or failed too often. */
export function finishTriage(ctx: DurableObjectState, emailId: string, outcome: "done" | "retry"): void {
	if (outcome === "done") {
		ctx.storage.sql.exec(`DELETE FROM triage_queue WHERE email_id = ?1`, emailId);
		return;
	}
	ctx.storage.sql.exec(`DELETE FROM triage_queue WHERE email_id = ?1 AND attempts >= ?2`, emailId, TRIAGE_MAX_ATTEMPTS);
}

/** The pipeline's view of this DO, for running it inside the alarm. */
export function localTriageStub(ctx: DurableObjectState) {
	return {
		getEmail: async (id: string) =>
			(ctx.storage.sql.exec(`SELECT * FROM emails WHERE id = ?1`, id).toArray()[0] as Record<string, unknown> | undefined) ?? null,
		activeLabelPrompts: async () => activeLabelPrompts(ctx),
		presetLabelId: async (key: TriagePresetKey) => presetLabelId(ctx, key),
		recentCorrections: async () => recentCorrections(ctx),
		consumeAiBudget: async (cap: number, calls: number) => consumeAiBudget(ctx, cap, calls),
		applyTriage: async (
			id: string,
			labelIds: string[],
			source: "ai" | "heuristic",
			verdict?: { kind: string | null; confidence: string | null },
		) => applyTriage(ctx, id, labelIds, source, verdict),
		markTriaged: async (id: string, state: string) => markTriaged(ctx, id, state),
		backfillCandidates: async (limit: number) => backfillCandidates(ctx, limit),
		backfillRemaining: async () => backfillRemaining(ctx),
	};
}

// ── Screener ───────────────────────────────────────────────────────

export interface ScreenerSender {
	sender: string;
	sender_name: string | null;
	count: number;
	unread: number;
	latest_date: string;
	latest_subject: string | null;
	latest_id: string;
	sender_kind: string | null;
	sender_confidence: string | null;
}

/** Senders waiting in the Screener, newest first, one row each. */
export function listScreener(ctx: DurableObjectState, limit = 100): ScreenerSender[] {
	const rows = ctx.storage.sql
		.exec(
			`WITH s AS (
				SELECT id, LOWER(sender) AS sender, sender_name, date, subject, read, sender_kind, sender_confidence,
				       ROW_NUMBER() OVER (PARTITION BY LOWER(sender) ORDER BY date DESC, id DESC) AS rn,
				       COUNT(*) OVER (PARTITION BY LOWER(sender)) AS cnt,
				       SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) OVER (PARTITION BY LOWER(sender)) AS unread
				  FROM emails WHERE folder_id = ?1
			)
			SELECT sender, sender_name, cnt AS count, unread, date AS latest_date, subject AS latest_subject,
			       id AS latest_id, sender_kind, sender_confidence
			  FROM s WHERE rn = 1
			 ORDER BY date DESC
			 LIMIT ?2`,
			Folders.SCREENER,
			Math.max(1, Math.min(500, limit)),
		)
		.toArray() as unknown as ScreenerSender[];
	return rows.map((r) => ({ ...r, count: Number(r.count), unread: Number(r.unread ?? 0) }));
}

/** Ids of a sender's messages waiting in the Screener. */
export function screenerBacklog(ctx: DurableObjectState, sender: string): string[] {
	return (
		ctx.storage.sql
			.exec(
				`SELECT id FROM emails WHERE folder_id = ? AND LOWER(sender) = ? ORDER BY date DESC`,
				Folders.SCREENER,
				sender.trim().toLowerCase(),
			)
			.toArray() as { id: string }[]
	).map((r) => r.id);
}

/** Conversation keys of a sender's Screener backlog (as ./summaries.ts keys them). */
export function screenerThreadKeys(ctx: DurableObjectState, sender: string): string[] {
	return (
		ctx.storage.sql
			.exec(
				`SELECT DISTINCT COALESCE(thread_id, id) AS k FROM emails WHERE folder_id = ? AND LOWER(sender) = ?`,
				Folders.SCREENER,
				sender.trim().toLowerCase(),
			)
			.toArray() as { k: string }[]
	).map((r) => r.k);
}

export type ScreenDecision = "allow" | "block";

export interface ScreenResult {
	sender: string;
	decision: ScreenDecision;
	folder: string;
	moved: number;
	listed: boolean;
}

/**
 * Yes or No for one sender.
 *
 * Yes: allowlist the address, move their Screener backlog to the Inbox, and
 * clear any block on them. No: blocklist the address and move the backlog to
 * Spam, or to Trash (recording where it came from, so it can be restored).
 * The list write and the move happen in one transaction.
 */
export function screenSender(
	ctx: DurableObjectState,
	senderRaw: string,
	decision: ScreenDecision,
	target: "spam" | "trash" = "spam",
	lists: {
		allow: (pattern: string, reason: string) => unknown;
		block: (pattern: string, reason: string) => unknown;
		unblock: (address: string) => unknown;
		disallow: (address: string) => unknown;
	},
): ScreenResult | null {
	const sender = senderRaw.trim().toLowerCase();
	if (!sender || !sender.includes("@")) return null;

	// The backlog is read inside the transaction and every move is guarded on
	// the Screener folder, so a message moved elsewhere in between stays put.
	return ctx.storage.transactionSync(() => {
		const ids = screenerBacklog(ctx, sender);
		let listed: boolean;
		let folder: string;
		let moved = 0;
		if (decision === "allow") {
			lists.unblock(sender);
			listed = !!lists.allow(sender, "Screener: yes");
			folder = Folders.INBOX;
			moved = moveFromScreener(ctx, ids, Folders.INBOX);
		} else {
			lists.disallow(sender);
			listed = !!lists.block(sender, "Screener: no");
			if (target === "trash") {
				folder = Folders.TRASH;
				for (let i = 0; i < ids.length; i += BULK_LIMIT) {
					moved += trashOnly(ctx, ids.slice(i, i + BULK_LIMIT)).trashed.length;
				}
			} else {
				folder = Folders.SPAM;
				moved = moveFromScreener(ctx, ids, Folders.SPAM);
			}
		}
		return { sender, decision, folder, moved, listed };
	});
}

/** The existing allow/block list operations, as `screenSender` takes them. */
export function senderListOps(ctx: DurableObjectState) {
	return {
		allow: (pattern: string, reason: string) => features.allowSender(ctx, pattern, reason),
		block: (pattern: string, reason: string) => features.blockSender(ctx, pattern, reason),
		unblock: (address: string) => features.unblockSenderMatching(ctx, address),
		// Only the exact address: a domain-wide allow is a broader decision than
		// one No about one sender.
		disallow: (address: string) => {
			for (const row of features.getAllowedSenders(ctx)) {
				if (row.pattern === address) features.disallowSender(ctx, row.id);
			}
		},
	};
}

function moveFromScreener(ctx: DurableObjectState, ids: string[], folderId: string): number {
	let moved = 0;
	for (const chunk of chunkIds([...new Set(ids)], 2)) {
		moved += ctx.storage.sql.exec(
			`UPDATE emails SET folder_id = ?1
			  WHERE folder_id = ?2 AND id IN (${placeholders(chunk.length, 2)})`,
			folderId,
			Folders.SCREENER,
			...chunk,
		).rowsWritten;
	}
	return moved;
}
