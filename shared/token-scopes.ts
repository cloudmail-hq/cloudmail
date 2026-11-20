// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * API token scopes: the vocabulary shared by the Worker, the settings screen and
 * the OpenAPI document.
 *
 * A `ttk_` token used to act with its user's full authority. A scope list narrows
 * that: the token's effective permission is the intersection of what the user is
 * granted, what its scopes allow, and (optionally) which mailboxes it is limited
 * to. Scopes never widen anything — a scope a user's grant does not back is inert.
 *
 * `null` scopes is the legacy, unrestricted token, and stays that way: tokens
 * minted before scopes existed keep working exactly as they did.
 *
 * Pure module (no Worker imports) so the browser bundle can use the same list.
 */

export const TOKEN_SCOPES = [
	"mail:read",
	"mail:send",
	"mail:send:auto",
	"approvals:manage",
	"mail:draft",
	"mail:organize",
	"mailboxes:manage",
	"domains:manage",
	"webhooks:manage",
	"admin",
] as const;

export type TokenScope = (typeof TOKEN_SCOPES)[number];

const SCOPE_LOOKUP: Record<string, true> = Object.fromEntries(TOKEN_SCOPES.map((s) => [s, true]));

export function isTokenScope(value: unknown): value is TokenScope {
	return typeof value === "string" && SCOPE_LOOKUP[value] === true;
}

export const TOKEN_SCOPE_LABELS: Record<TokenScope, string> = {
	"mail:read": "Read mail",
	"mail:send": "Send mail",
	"mail:send:auto": "Send without approval",
	"approvals:manage": "Approve held sends",
	"mail:draft": "Write drafts",
	"mail:organize": "Organize mail",
	"mailboxes:manage": "Manage mailboxes",
	"domains:manage": "Manage domains",
	"webhooks:manage": "Manage webhooks",
	admin: "Administration",
};

export const TOKEN_SCOPE_DESCRIPTIONS: Record<TokenScope, string> = {
	"mail:read": "List, read and search messages, attachments, people and analytics.",
	"mail:send": "Send, reply, forward and schedule mail, and run sequences.",
	"mail:send:auto":
		"With Send mail: agent and MCP sends from this token skip Pending approval on mailboxes set to send automatically. Only give this to integrations you trust.",
	"approvals:manage":
		"Approve or reject agent sends waiting for approval (for the CLI). Never for sends this token, its parent or its children asked for. Only give it to a token a person uses.",
	"mail:draft": "Create and edit drafts and templates.",
	"mail:organize": "Move, label, flag, snooze and delete messages.",
	"mailboxes:manage": "Mailbox settings, rules, sender lists and delegates; create or delete mailboxes (admins).",
	"domains:manage": "Domains, DNS checks, catch-all and aliases (admins).",
	"webhooks:manage": "Create and manage webhooks.",
	admin: "Instance administration: users, access grants, branding, preferences, migration.",
};

/**
 * Scopes no preset includes: they must be ticked deliberately.
 *
 * `mail:send:auto` lets an agent send without a person approving, so even "Full
 * access" leaves it off. It only means anything alongside `mail:send`; see
 * {@link mayAutoSend}.
 */
export const EXPLICIT_ONLY_SCOPES: readonly TokenScope[] = ["mail:send:auto", "approvals:manage"];

/**
 * Whether a token's scope list allows agent sends without approval: it must
 * hold BOTH `mail:send` and `mail:send:auto`. `null` (a legacy, unscoped token)
 * does not qualify, because "send without approval" has to be granted on
 * purpose and a legacy token was never asked.
 */
export function mayAutoSend(scopes: readonly TokenScope[] | null): boolean {
	return scopes !== null && scopes.includes("mail:send") && scopes.includes("mail:send:auto");
}

export interface TokenScopePreset {
	id: "read" | "send" | "full";
	label: string;
	scopes: TokenScope[];
}

export const TOKEN_SCOPE_PRESETS: TokenScopePreset[] = [
	{ id: "read", label: "Read only", scopes: ["mail:read"] },
	{ id: "send", label: "Send only", scopes: ["mail:send"] },
	{ id: "full", label: "Full access", scopes: TOKEN_SCOPES.filter((s) => !EXPLICIT_ONLY_SCOPES.includes(s)) },
];

/**
 * Normalize a stored or submitted scope list.
 *
 * Unknown strings are dropped rather than trusted: a scope this build does not
 * know must never be read as granting anything. `null`/`undefined` stays `null`
 * (unrestricted). An array that is empty after filtering stays empty, which
 * grants nothing beyond identity-level reads — never "everything".
 */
export function normalizeTokenScopes(value: unknown): TokenScope[] | null {
	if (value === null || value === undefined) return null;
	if (!Array.isArray(value)) return [];
	const out: TokenScope[] = [];
	for (const scope of value) {
		if (isTokenScope(scope) && !out.includes(scope)) out.push(scope);
	}
	// Canonical order, so equal sets compare and display identically.
	return TOKEN_SCOPES.filter((s) => out.includes(s));
}

/** Lower-case, trim and de-duplicate a mailbox allowlist; `null` = every mailbox. */
export function normalizeTokenMailboxes(value: unknown): string[] | null {
	if (value === null || value === undefined) return null;
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const raw of value) {
		if (typeof raw !== "string") continue;
		const address = raw.trim().toLowerCase();
		if (address && !out.includes(address)) out.push(address);
	}
	return out;
}

/**
 * Scopes for reading and working with mail. A token restricted only by mailbox
 * (scopes left null) holds these, and nothing admin-class: limiting a token to
 * one mailbox must never leave it able to administer the instance.
 */
export const MAIL_SCOPES: readonly TokenScope[] = ["mail:read", "mail:send", "mail:draft", "mail:organize"];

/**
 * The scopes a token actually holds.
 *
 * - `null`: a fully legacy token (no scopes, no mailboxes) with the user's full
 *   authority, unchanged from before scopes existed.
 * - Mailboxes set, scopes null: {@link MAIL_SCOPES} only.
 * - Scopes set: exactly those.
 *
 * Every check on a token's scopes goes through this, so "restricted" always
 * means admin-class scopes must be listed explicitly.
 */
export function effectiveTokenScopes(token: { scopes: unknown; mailboxes: unknown }): TokenScope[] | null {
	const scopes = normalizeTokenScopes(token.scopes);
	if (scopes !== null) return scopes;
	return normalizeTokenMailboxes(token.mailboxes) === null ? null : [...MAIL_SCOPES];
}

/** True when `inner` grants nothing `outer` does not (null = everything). */
export function isScopeSubset(inner: readonly TokenScope[] | null, outer: readonly TokenScope[] | null): boolean {
	if (outer === null) return true;
	if (inner === null) return false;
	return inner.every((s) => outer.includes(s));
}

/** True when the mailbox allowlist `inner` is within `outer` (null = every mailbox). */
export function isMailboxSubset(inner: readonly string[] | null, outer: readonly string[] | null): boolean {
	if (outer === null) return true;
	if (inner === null) return false;
	return inner.every((m) => outer.includes(m));
}
