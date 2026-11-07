// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Storage for inbound filter rules, and for the two smaller pieces of inbound
 * state that shape delivery: muted conversations and the auto-reply log.
 *
 * The interesting logic — what a rule matches and what it does — lives in
 * `shared/rules.ts` and is pure. This module only reads and writes rows, plus
 * the one thing that genuinely needs storage: deciding whether an auto-reply
 * has already gone to this correspondent recently.
 *
 * Plain functions over `DurableObjectState`, matching ./bulk.ts and
 * ./features.ts. `MailboxDO` keeps thin delegating methods because only class
 * methods are reachable over RPC.
 */

import {
	MAX_RULE_CLAUSES,
	MAX_RULE_VALUE_LENGTH,
	MAX_RULES,
	type Rule,
	type RuleAction,
	type RuleCondition,
} from "../../shared/rules";

interface RuleRow {
	id: string;
	name: string;
	enabled: number;
	sort_order: number;
	match_type: string;
	conditions: string;
	actions: string;
	stop_processing: number;
	created_at: string;
	updated_at: string;
}

export class RuleLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuleLimitError";
	}
}

/**
 * Parse a stored rule.
 *
 * A rule whose JSON no longer parses is returned disabled with no clauses
 * rather than thrown away: dropping it silently would make a mailbox's mail
 * quietly stop being filed, while a visible dead rule can be fixed.
 */
function toRule(row: RuleRow): Rule {
	let conditions: RuleCondition[] = [];
	let actions: RuleAction[] = [];
	let corrupt = false;

	try {
		const parsed = JSON.parse(row.conditions);
		if (Array.isArray(parsed)) conditions = parsed;
		else corrupt = true;
	} catch {
		corrupt = true;
	}

	try {
		const parsed = JSON.parse(row.actions);
		if (Array.isArray(parsed)) actions = parsed;
		else corrupt = true;
	} catch {
		corrupt = true;
	}

	return {
		id: row.id,
		name: row.name,
		enabled: !corrupt && row.enabled === 1,
		sort_order: row.sort_order,
		match_type: row.match_type === "any" ? "any" : "all",
		conditions,
		actions,
		stop_processing: row.stop_processing === 1,
	};
}

export function getRules(ctx: DurableObjectState): Rule[] {
	const rows = ctx.storage.sql
		.exec(
			`SELECT id, name, enabled, sort_order, match_type, conditions, actions,
			        stop_processing, created_at, updated_at
			   FROM rules
			  ORDER BY sort_order ASC, created_at ASC`,
		)
		.toArray() as unknown as RuleRow[];

	return rows.map(toRule);
}

/** Only the rules worth evaluating on an inbound message. */
export function getEnabledRules(ctx: DurableObjectState): Rule[] {
	return getRules(ctx).filter(
		(rule) => rule.enabled && rule.conditions.length > 0,
	);
}

export function getRule(ctx: DurableObjectState, id: string): Rule | null {
	const rows = ctx.storage.sql
		.exec(
			`SELECT id, name, enabled, sort_order, match_type, conditions, actions,
			        stop_processing, created_at, updated_at
			   FROM rules WHERE id = ?`,
			id,
		)
		.toArray() as unknown as RuleRow[];

	return rows.length > 0 ? toRule(rows[0]) : null;
}

/**
 * Reject clause lists that would make inbound evaluation unbounded.
 *
 * Rules run on the delivery path, so a mailbox with a thousand rules each
 * carrying a megabyte of pattern would turn every inbound message into a
 * timeout. These limits are far above real usage.
 */
function assertClausesWithinLimits(
	conditions: RuleCondition[],
	actions: RuleAction[],
): void {
	if (conditions.length > MAX_RULE_CLAUSES) {
		throw new RuleLimitError(
			`A rule may have at most ${MAX_RULE_CLAUSES} conditions`,
		);
	}
	if (actions.length > MAX_RULE_CLAUSES) {
		throw new RuleLimitError(
			`A rule may have at most ${MAX_RULE_CLAUSES} actions`,
		);
	}
	for (const condition of conditions) {
		if ((condition.value ?? "").length > MAX_RULE_VALUE_LENGTH) {
			throw new RuleLimitError(
				`Condition values are limited to ${MAX_RULE_VALUE_LENGTH} characters`,
			);
		}
	}
}

export interface RuleInput {
	name: string;
	enabled?: boolean;
	match_type?: "all" | "any";
	conditions: RuleCondition[];
	actions: RuleAction[];
	stop_processing?: boolean;
	sort_order?: number;
}

export function createRule(ctx: DurableObjectState, input: RuleInput): Rule {
	const count = (
		ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM rules`).one() as {
			n: number;
		}
	).n;
	if (count >= MAX_RULES) {
		throw new RuleLimitError(`A mailbox may have at most ${MAX_RULES} rules`);
	}
	assertClausesWithinLimits(input.conditions, input.actions);

	const id = crypto.randomUUID();
	// New rules land at the end of the list, which is where someone adding one
	// expects it: existing behaviour keeps precedence.
	const nextOrder =
		input.sort_order ??
		((
			ctx.storage.sql
				.exec(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM rules`)
				.one() as { m: number }
		).m +
			1);

	ctx.storage.sql.exec(
		`INSERT INTO rules (id, name, enabled, sort_order, match_type, conditions,
		                    actions, stop_processing)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
		id,
		input.name.trim() || "Untitled rule",
		input.enabled === false ? 0 : 1,
		nextOrder,
		input.match_type === "any" ? "any" : "all",
		JSON.stringify(input.conditions),
		JSON.stringify(input.actions),
		input.stop_processing ? 1 : 0,
	);

	const created = getRule(ctx, id);
	if (!created) throw new Error("createRule: row vanished after insert");
	return created;
}

export function updateRule(
	ctx: DurableObjectState,
	id: string,
	patch: Partial<RuleInput>,
): Rule | null {
	if (!getRule(ctx, id)) return null;
	if (patch.conditions || patch.actions) {
		assertClausesWithinLimits(patch.conditions ?? [], patch.actions ?? []);
	}

	const assignments: string[] = [];
	const values: (string | number)[] = [];
	const set = (column: string, value: string | number) => {
		assignments.push(`${column} = ?${values.length + 1}`);
		values.push(value);
	};

	if (patch.name !== undefined) set("name", patch.name.trim() || "Untitled rule");
	if (patch.enabled !== undefined) set("enabled", patch.enabled ? 1 : 0);
	if (patch.match_type !== undefined) {
		set("match_type", patch.match_type === "any" ? "any" : "all");
	}
	if (patch.conditions !== undefined) {
		set("conditions", JSON.stringify(patch.conditions));
	}
	if (patch.actions !== undefined) set("actions", JSON.stringify(patch.actions));
	if (patch.stop_processing !== undefined) {
		set("stop_processing", patch.stop_processing ? 1 : 0);
	}
	if (patch.sort_order !== undefined) set("sort_order", patch.sort_order);

	if (assignments.length > 0) {
		assignments.push(`updated_at = datetime('now')`);
		ctx.storage.sql.exec(
			`UPDATE rules SET ${assignments.join(", ")} WHERE id = ?${values.length + 1}`,
			...values,
			id,
		);
	}

	return getRule(ctx, id);
}

export function deleteRule(ctx: DurableObjectState, id: string): boolean {
	return (
		ctx.storage.sql.exec(`DELETE FROM rules WHERE id = ?`, id).rowsWritten > 0
	);
}

/**
 * Rewrite the order of the whole list.
 *
 * Takes the full id sequence rather than a move instruction so the client can
 * present drag-and-drop without the server having to reason about gaps, and so
 * a stale id simply drops out instead of corrupting the order.
 */
export function reorderRules(ctx: DurableObjectState, ids: unknown): number {
	if (!Array.isArray(ids)) return 0;

	const known = new Set(getRules(ctx).map((rule) => rule.id));
	let order = 0;
	let updated = 0;

	for (const id of ids) {
		if (typeof id !== "string" || !known.has(id)) continue;
		ctx.storage.sql.exec(
			`UPDATE rules SET sort_order = ?1, updated_at = datetime('now') WHERE id = ?2`,
			order,
			id,
		);
		order += 1;
		updated += 1;
	}

	return updated;
}

// ── Muted conversations ────────────────────────────────────────────

export function isThreadMuted(
	ctx: DurableObjectState,
	threadId: string | null | undefined,
): boolean {
	if (!threadId) return false;
	return (
		ctx.storage.sql
			.exec(`SELECT 1 FROM muted_threads WHERE thread_id = ?`, threadId)
			.toArray().length > 0
	);
}

export function muteThread(ctx: DurableObjectState, threadId: string): void {
	ctx.storage.sql.exec(
		`INSERT OR IGNORE INTO muted_threads (thread_id) VALUES (?)`,
		threadId,
	);
}

export function unmuteThread(ctx: DurableObjectState, threadId: string): boolean {
	return (
		ctx.storage.sql.exec(
			`DELETE FROM muted_threads WHERE thread_id = ?`,
			threadId,
		).rowsWritten > 0
	);
}

export function listMutedThreads(ctx: DurableObjectState): string[] {
	return (
		ctx.storage.sql
			.exec(`SELECT thread_id FROM muted_threads ORDER BY created_at DESC`)
			.toArray() as unknown as { thread_id: string }[]
	).map((row) => row.thread_id);
}

// ── Auto-reply bookkeeping ─────────────────────────────────────────

/**
 * How long before the same correspondent may receive another auto-reply.
 *
 * Four days matches what other mail providers use: long enough that a
 * back-and-forth does not generate a wall of identical notices, short enough
 * that someone writing next week still learns you are away.
 */
export const AUTO_REPLY_COOLDOWN_MS = 4 * 24 * 60 * 60 * 1000;

/**
 * Claim the right to auto-reply to an address.
 *
 * Returns true at most once per cooldown window, and records the send in the
 * same call. Doing both together is what stops two messages arriving in the
 * same second from each deciding they are the first.
 */
export function claimAutoReply(
	ctx: DurableObjectState,
	recipient: string,
	now: Date = new Date(),
): boolean {
	const key = recipient.trim().toLowerCase();
	if (!key) return false;

	const rows = ctx.storage.sql
		.exec(
			`SELECT last_sent_at FROM auto_reply_log WHERE recipient = ?`,
			key,
		)
		.toArray() as unknown as { last_sent_at: string }[];

	if (rows.length > 0) {
		const last = Date.parse(rows[0].last_sent_at);
		if (
			Number.isFinite(last) &&
			now.getTime() - last < AUTO_REPLY_COOLDOWN_MS
		) {
			return false;
		}
	}

	ctx.storage.sql.exec(
		`INSERT INTO auto_reply_log (recipient, last_sent_at) VALUES (?1, ?2)
		 ON CONFLICT(recipient) DO UPDATE SET last_sent_at = ?2`,
		key,
		now.toISOString(),
	);

	return true;
}
