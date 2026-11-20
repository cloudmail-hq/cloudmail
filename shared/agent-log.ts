// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Grouping the agent chat log for display.
 *
 * Every inbound email the agent auto-drafts for appends two messages to the
 * chat: a user-role "[Auto-triggered] New email from …" line and the agent's
 * one-line outcome. On a busy mailbox those pairs buried the actual
 * conversation, rendered as if the operator had typed them. The panel now
 * collapses each consecutive run of them into one quiet summary row
 * ("Agent drafted 3 replies"), which this module computes.
 *
 * Pure and structural (no `ai` import) so it is unit-tested in Node.
 */

export const AUTO_TRIGGER_PREFIX = "[Auto-triggered]";

export interface LogPart {
	type: string;
	text?: string;
}

export interface LogMessage {
	id: string;
	role: string;
	parts: readonly LogPart[];
}

export type AutoOutcome = "drafted" | "blocked" | "handled";

/** One auto-triggered email and what the agent did about it. */
export interface AutoRun<M extends LogMessage = LogMessage> {
	trigger: M;
	replies: M[];
	sender: string | null;
	subject: string | null;
	outcome: AutoOutcome;
}

export type AgentLogItem<M extends LogMessage = LogMessage> =
	| { kind: "message"; message: M }
	| { kind: "auto"; id: string; runs: AutoRun<M>[] };

function firstText(message: LogMessage): string {
	for (const part of message.parts) {
		if (part.type === "text" && typeof part.text === "string" && part.text.trim()) return part.text;
	}
	return "";
}

export function isAutoTrigger(message: LogMessage): boolean {
	return message.role === "user" && firstText(message).trimStart().startsWith(AUTO_TRIGGER_PREFIX);
}

const TRIGGER_RE = /^\s*\[Auto-triggered\]\s*New email from\s+(.+?):\s*"([\s\S]*)"\s*$/;

/** Sender and subject out of the trigger line, when it has the usual shape. */
export function parseTrigger(message: LogMessage): { sender: string | null; subject: string | null } {
	const m = TRIGGER_RE.exec(firstText(message));
	return m ? { sender: m[1]!.trim(), subject: m[2]! } : { sender: null, subject: null };
}

function hasDraftTool(message: LogMessage): boolean {
	return message.parts.some(
		(p) => p.type === "tool-draft_reply" || p.type === "tool-draft_email",
	);
}

/** What the agent's replies to one trigger amount to. */
export function autoOutcome(replies: readonly LogMessage[]): AutoOutcome {
	const text = replies.map(firstText).join("\n");
	if (/blocked auto-draft/i.test(text)) return "blocked";
	if (replies.some(hasDraftTool) || /^\s*Created draft reply/im.test(text)) return "drafted";
	return "handled";
}

/**
 * Display items for a chat log.
 *
 * An auto trigger owns the assistant messages directly after it. Consecutive
 * runs merge into one `auto` item; any operator-typed message ends the run.
 */
export function groupAgentLog<M extends LogMessage>(messages: readonly M[]): AgentLogItem<M>[] {
	const items: AgentLogItem<M>[] = [];
	let current: AutoRun<M> | null = null;
	let group: { kind: "auto"; id: string; runs: AutoRun<M>[] } | null = null;

	const closeRun = () => {
		if (current) {
			current.outcome = autoOutcome(current.replies);
			current = null;
		}
	};

	for (const message of messages) {
		if (isAutoTrigger(message)) {
			closeRun();
			current = { trigger: message, replies: [], ...parseTrigger(message), outcome: "handled" };
			if (!group) {
				group = { kind: "auto", id: `auto-${message.id}`, runs: [] };
				items.push(group);
			}
			group.runs.push(current);
			continue;
		}
		if (current && message.role !== "user") {
			current.replies.push(message);
			continue;
		}
		closeRun();
		group = null;
		items.push({ kind: "message", message });
	}
	closeRun();
	return items;
}

export interface AutoSummary {
	drafted: number;
	blocked: number;
	handled: number;
	total: number;
}

export function summarizeRuns(runs: readonly AutoRun[]): AutoSummary {
	const s: AutoSummary = { drafted: 0, blocked: 0, handled: 0, total: runs.length };
	for (const r of runs) s[r.outcome] += 1;
	return s;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Agent drafted 3 replies", "Agent handled 2 new emails · 1 blocked". */
export function autoSummaryLabel(runs: readonly AutoRun[]): string {
	const s = summarizeRuns(runs);
	const head =
		s.drafted > 0
			? `Agent drafted ${plural(s.drafted, "reply", "replies")}`
			: `Agent handled ${plural(s.total, "new email", "new emails")}`;
	const extra: string[] = [];
	// Only spell out the rest when the head did not already count them.
	if (s.drafted > 0 && s.handled > 0) extra.push(`${s.handled} without a draft`);
	if (s.blocked > 0) extra.push(`${s.blocked} blocked`);
	return extra.length ? `${head} · ${extra.join(" · ")}` : head;
}
