// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Agent inboxes: the vocabulary and the pure decisions.
 *
 * An agent inbox is a real mailbox minted for one automated worker, with a
 * scoped `ttk_` token limited to that mailbox, an optional webhook, a send
 * policy and an optional expiry. The I/O lives in `workers/lib/agent-inboxes.ts`;
 * this file has none, so the Worker, the settings screen and the tests share it.
 *
 * `send_mode` is the mailbox's agent send mode (`agentSend.mode`, see
 * `shared/agent-send-policy.ts`), one to one:
 *
 *   - `draft_only`: the token can read, organise and write drafts. No send scope.
 *   - `approve`:    the token also holds `mail:send`, and every send it makes is
 *                   held in the mailbox's Pending approval queue
 *                   (`workers/lib/agent-send-gate.ts`) until a person approves it.
 *   - `auto`:       the token holds `mail:send` and `mail:send:auto`, so its sends
 *                   go out directly.
 *
 * `allowed_recipients` is optional, and absent by default: an agent inbox may
 * send to and receive from anyone. Set it only to deliberately restrict who
 * the inbox may send to; then it is a hard limit in every mode: a recipient
 * outside it is refused (422), never held for approval. Clear it with
 * `PATCH /api/v1/agent-inboxes/:address {"allowed_recipients": null}`.
 */

import type { TokenScope } from "./token-scopes";

export const AGENT_SEND_MODES = ["draft_only", "approve", "auto"] as const;
export type AgentSendMode = (typeof AGENT_SEND_MODES)[number];

export function isAgentSendMode(value: unknown): value is AgentSendMode {
	return typeof value === "string" && (AGENT_SEND_MODES as readonly string[]).includes(value);
}

export const AGENT_SEND_MODE_LABELS: Record<AgentSendMode, string> = {
	draft_only: "Drafts only",
	approve: "Needs approval",
	auto: "Sends on its own",
};

/** Longest TTL accepted: 90 days. Longer-lived agents should use a normal mailbox. */
export const AGENT_INBOX_MAX_TTL_HOURS = 24 * 90;
/** Most entries in `allowed_recipients`. */
export const AGENT_INBOX_MAX_ALLOWED_RECIPIENTS = 200;
/** Characters in the generated part of `agent-<xxxxxx>`. */
export const AGENT_LOCAL_PART_RANDOM_LENGTH = 6;

/** R2 prefix for agent inbox records; one JSON object per address. */
export const AGENT_INBOX_PREFIX = "agent-inboxes/";
/** R2 prefix for mbox archives written when an agent inbox ends. */
export const AGENT_INBOX_ARCHIVE_PREFIX = "archives/agent-inboxes/";

export function agentInboxKey(address: string): string {
	return `${AGENT_INBOX_PREFIX}${address.toLowerCase()}.json`;
}

/** What is stored per agent inbox. Never holds a secret. */
export interface AgentInboxRecord {
	address: string;
	purpose: string;
	display_name: string | null;
	send_mode: AgentSendMode;
	/** Exact addresses and `@domain` patterns; null means no restriction. */
	allowed_recipients: string[] | null;
	/** The scoped token minted for it, or null where none could be (Access mode). */
	token_id: string | null;
	/** The AuthDO user that owns the token, needed to revoke it. */
	token_user_id: string | null;
	scopes: TokenScope[];
	webhook_id: string | null;
	webhook_url: string | null;
	created_by: string | null;
	/** Unix ms. */
	created_at: number;
	/** Unix ms, or null for no expiry. */
	expires_at: number | null;
}

/** The token scopes a send mode grants. Always confined to the one mailbox. */
export function scopesForSendMode(mode: AgentSendMode): TokenScope[] {
	if (mode === "auto") return ["mail:read", "mail:send", "mail:send:auto", "mail:draft", "mail:organize"];
	if (mode === "approve") return ["mail:read", "mail:send", "mail:draft", "mail:organize"];
	return ["mail:read", "mail:draft", "mail:organize"];
}

/** Strictest first: a stricter mode always wins when two sources disagree. */
const MODE_STRICTNESS: Record<AgentSendMode, number> = { draft_only: 2, approve: 1, auto: 0 };

/** The stricter of two send modes. */
export function stricterSendMode(a: AgentSendMode, b: AgentSendMode): AgentSendMode {
	return MODE_STRICTNESS[a] >= MODE_STRICTNESS[b] ? a : b;
}

const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;

/** A lowercase local part, or null when it is not one we will create. */
export function normalizeLocalPart(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const v = value.trim().toLowerCase();
	if (!LOCAL_PART.test(v) || v.includes("..")) return null;
	return v;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** `agent-<6 random lowercase alphanumerics>`. `random` is injectable for tests. */
export function generateAgentLocalPart(
	random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
	// Rejection sampling keeps the distribution uniform over 36 symbols.
	let out = "";
	while (out.length < AGENT_LOCAL_PART_RANDOM_LENGTH) {
		for (const b of random(16)) {
			if (b >= 252) continue; // 252 = 7 * 36
			out += ALPHABET[b % 36];
			if (out.length === AGENT_LOCAL_PART_RANDOM_LENGTH) break;
		}
	}
	return `agent-${out}`;
}

const ADDRESS = /^[^\s@,;<>"]+@[^\s@,;<>".]+(?:\.[^\s@,;<>".]+)+$/;
const DOMAIN_PATTERN = /^\*?@([^\s@,;<>".]+(?:\.[^\s@,;<>".]+)+)$/;

/**
 * Normalise one `allowed_recipients` entry: a full address, or `@domain` /
 * `*@domain` for a whole domain (exact domain, not its subdomains). Returns
 * null for anything else.
 */
export function normalizeRecipientPattern(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const v = value.trim().toLowerCase();
	if (v.length === 0 || v.length > 320) return null;
	const domain = v.match(DOMAIN_PATTERN);
	if (domain) return `@${domain[1]}`;
	return ADDRESS.test(v) ? v : null;
}

/** The bare lowercase address in `Name <a@b>` or `a@b`. */
export function bareAddress(value: string): string {
	const angled = value.match(/<([^>]+)>/);
	return (angled ? angled[1] : value).trim().toLowerCase();
}

/** Whether `recipient` is allowed by `patterns` (null = no restriction). */
export function recipientAllowed(patterns: readonly string[] | null, recipient: string): boolean {
	if (patterns === null) return true;
	const address = bareAddress(recipient);
	const at = address.lastIndexOf("@");
	const domain = at >= 0 ? address.slice(at) : "";
	return patterns.some((p) => p === address || (p.startsWith("@") && p === domain));
}

/** Recipients `patterns` refuses, deduplicated, in input order. */
export function disallowedRecipients(patterns: readonly string[] | null, recipients: readonly string[]): string[] {
	if (patterns === null) return [];
	const out: string[] = [];
	for (const r of recipients) {
		const address = bareAddress(r);
		if (!address || recipientAllowed(patterns, address) || out.includes(address)) continue;
		out.push(address);
	}
	return out;
}

/** Split a recipient field (string, comma list or array) into entries. */
export function recipientList(value: string | string[] | null | undefined): string[] {
	if (!value) return [];
	return (Array.isArray(value) ? value : value.split(","))
		.map((v) => v.trim())
		.filter(Boolean);
}

/** The record as the API returns it, with a computed `expires_in_ms`. */
export interface AgentInboxView extends AgentInboxRecord {
	expired: boolean;
	expires_in_ms: number | null;
}

export function agentInboxView(record: AgentInboxRecord, now: number): AgentInboxView {
	const remaining = record.expires_at === null ? null : record.expires_at - now;
	return {
		...record,
		expired: remaining !== null && remaining <= 0,
		expires_in_ms: remaining === null ? null : Math.max(0, remaining),
	};
}

/** "3d 4h", "2h 5m", "4m", "expired": the settings screen's countdown. */
export function formatCountdown(ms: number | null): string {
	if (ms === null) return "no expiry";
	if (ms <= 0) return "expired";
	const minutes = Math.floor(ms / 60_000);
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${mins}m`;
	return `${Math.max(mins, 1)}m`;
}

// ── Send policy ─────────────────────────────────────────────────────

export type AgentSendDecision =
	| { ok: true }
	| {
			ok: false;
			status: 403 | 422;
			code: "recipient_not_allowed" | "drafts_only";
			error: string;
			recipients?: string[];
	  };

/**
 * Whether an outbound message from an agent inbox to these recipients may go
 * out. Applied by the pre-send gate (`workers/lib/agent-send-rule.ts`).
 *
 * `allowed_recipients` binds every send from the address, whoever makes it:
 * the address's correspondents were promised that list. A recipient outside it
 * is refused (422), and never parked for approval: approving cannot widen it.
 *
 * `draft_only` binds the agent's own token (`viaAgentToken`): its scopes lack
 * `mail:send`, and this is the second lock. `approve` passes here: the next
 * rule (`agentApprovalRule`, `workers/lib/agent-send-gate.ts`) holds the send
 * for a person. A person sending a draft the agent wrote is the approval, so it
 * is not refused.
 */
export function decideAgentSendPolicy(
	record: Pick<AgentInboxRecord, "send_mode" | "allowed_recipients"> | null,
	recipients: string[],
	viaAgentToken = true,
): AgentSendDecision {
	if (!record) return { ok: true };
	if (viaAgentToken && record.send_mode === "draft_only") {
		return {
			ok: false,
			status: 403,
			code: "drafts_only",
			error: "This agent inbox can only write drafts. A person has to send them, or change its send mode.",
		};
	}
	const refused = disallowedRecipients(record.allowed_recipients, recipients);
	if (refused.length > 0) {
		return {
			ok: false,
			status: 422,
			code: "recipient_not_allowed",
			error: `This agent inbox may not send to ${refused.join(", ")}. Allowed: ${(record.allowed_recipients ?? []).join(", ")}.`,
			recipients: refused,
		};
	}
	return { ok: true };
}
