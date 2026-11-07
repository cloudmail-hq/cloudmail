// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Who did what, in whose mailbox.
 *
 * ## Why this exists
 *
 * Delegated access without a record of its use is the gap every mature mail
 * product closes. Once someone other than the owner can read and send from a
 * mailbox, "who purged the support inbox" and "who sent that as us" stop being
 * answerable from the mailbox itself: a delegated send leaves the mailbox's own
 * address in `From:`, and a deleted message leaves nothing at all.
 *
 * Exchange's mailbox audit log answers this by classifying every entry by the
 * *kind* of actor — owner, delegate, or admin — rather than only naming them,
 * because the interesting question is not who acted but whether they were acting
 * on their own mailbox or on someone else's. {@link AuditActorRole} mirrors that.
 * https://learn.microsoft.com/en-us/purview/audit-mailboxes
 *
 * ## Shape
 *
 * One R2 object per entry, under a key that sorts newest-last by time. Append-only
 * by construction: entries are never rewritten, so two concurrent writers cannot
 * lose each other's record — which matters more here than anywhere else in the
 * app, since a lost audit line is indistinguishable from an action that never
 * happened.
 *
 * Keys are `audit/<mailbox-or-_instance>/<inverted-timestamp>-<random>.json`.
 * Two properties come out of that layout:
 *
 * - **Scoped by mailbox**, so reading one mailbox's log is a prefix list rather
 *   than a scan of every entry ever written. A shared support inbox generates
 *   most of the volume, and the owner of a quiet mailbox should not pay for it.
 * - **Inverted timestamp**, so R2's lexicographic key order *is* newest-first.
 *   Listing a page of recent activity therefore reads one page of keys instead of
 *   every key under the prefix, which is the difference between a log that stays
 *   usable at a million entries and one that does not.
 *
 * ## What is not recorded
 *
 * Reads. Exchange can audit them and mostly does not by default, for the reason
 * that applies here too: a mail client reads constantly, so recording every
 * message opened would bury the entries an operator is actually looking for and
 * cost an R2 write per message view. This log records the things that change
 * something or that reach outside the mailbox — sends, deletes, settings, grants.
 */

import { isAdmin, normalizeAddress, type Principal } from "./authz";
import { FULL_ACCESS_ROLE } from "./capabilities";

export const AUDIT_PREFIX = "audit/";

/**
 * Bucket for entries that belong to the deployment rather than one mailbox —
 * grant changes, mailbox creation and deletion.
 *
 * Leading underscore so it cannot collide with a mailbox address: `@` is required
 * in one and absent here.
 */
export const INSTANCE_SCOPE = "_instance";

/**
 * How the actor stood in relation to the mailbox they acted on.
 *
 * Mirrors Exchange's owner/delegate/admin classification. `system` covers the
 * paths with no human behind them at all — inbound delivery, the cron tick — which
 * would otherwise have to be attributed to whoever happened to be signed in.
 */
export type AuditActorRole = "owner" | "delegate" | "admin" | "system";

/**
 * What happened.
 *
 * A closed set rather than free text, so the log can be filtered and so a typo
 * cannot silently create a category nobody looks at. Grouped by what they answer:
 * `mail.*` for messages leaving or being destroyed, `mailbox.*` for configuration,
 * `access.*` for who may do any of it.
 */
export const AUDIT_ACTIONS = [
	/** A message was sent. `detail.attribution` records as-whom. */
	"mail.send",
	/** A message was moved to Trash. Recoverable, but worth knowing about. */
	"mail.delete",
	/** A message was destroyed, or Trash was emptied. Not recoverable. */
	"mail.destroy",
	/** Mailbox settings were written — identity, forwarding, auto-reply. */
	"mailbox.settings",
	/** A mailbox was created. */
	"mailbox.create",
	/** A mailbox was deleted, taking its mail with it. */
	"mailbox.delete",
	/** A grant was created or replaced. */
	"access.grant",
	/** A grant was removed. */
	"access.revoke",
	/** A domain was added, edited, provisioned or deleted. `detail.op` says which. */
	"domain.change",
	/** A mailbox's alias addresses were replaced. */
	"mailbox.aliases",
	/** A product was created, edited, given a logo or deleted. `detail.op` says which. */
	"product.change",
	/** A user asked to delete their account (`detail.phase`), or it was purged. */
	"account.delete",
	/** The privacy notice or retention periods were edited. */
	"privacy.settings",
	/** A mailbox's tracking toggles were changed. */
	"mailbox.tracking",
	/** A mailbox's outbound send caps were changed. `detail` has the new caps. */
	"mailbox.send_limits",
	/** Bulk sending from a domain was resumed after the spam-rate breaker paused it. */
	"sending.resume",
	/** Bulk sending from a domain was paused by hand. */
	"sending.pause",
	/** The usage budget thresholds were changed. `detail` has old and new. */
	"usage.budget",
	/** An agent inbox (mailbox + scoped token + optional webhook) was created. */
	"agent_inbox.create",
	/** An agent inbox reached its TTL and was archived and removed. */
	"agent_inbox.expire",
	/** An agent inbox was ended early, or its mailbox was deleted. */
	"agent_inbox.delete",
	/** An agent inbox's recipient restriction was changed or cleared (`detail.allowed_recipients`). */
	"agent_inbox.update",

	// ── Account security (deployment scope) ──
	/** Sign-in succeeded. `detail.method`: password, mfa, passkey. */
	"auth.login",
	/** Sign-in failed. `target` is the address tried; `detail.reason` says why. */
	"auth.login_failed",
	"auth.logout",
	"auth.password_change",
	/** Password set from a reset link or the recovery flow. */
	"auth.password_reset",
	"auth.2fa_enable",
	"auth.2fa_disable",
	"auth.recovery_codes",
	"auth.passkey_add",
	"auth.passkey_remove",
	"auth.session_revoke",
	"auth.token_create",
	"auth.token_revoke",
	"auth.oauth_revoke",
	/** An OAuth app's "send without approval" flag changed. */
	"auth.oauth_send_auto",

	// ── Agent and MCP writes (mailbox scope) ──
	/**
	 * A write made by an MCP client or the in-app agent. `detail.tool` names the
	 * tool, `detail.via` is `mcp` or `agent`, `detail.token`/`detail.oauthClient`
	 * name the credential, and `target` the message, recipient or rule.
	 */
	"agent.write",
	/** An agent send was held for approval. */
	"agent.send_held",
	/** The agent revised its own held send (`detail.revision`, `detail.fields`). */
	"agent.send_revised",
	/** An agent send went out without approval (`detail.reason`: auto, allowlist). */
	"agent.send",
	/** An agent send was refused (`detail.reason`: draft_only, suppressed, injection). */
	"agent.send_refused",
	/** A person approved a held send; `detail.outcome` is sent or failed. */
	"approval.approve",
	"approval.reject",
	/** A mail import was started (`detail.source`; for IMAP also `host`, never the password). */
	"mailbox.import",
	/**
	 * AI gateway providers and routing (Settings → AI providers). `detail` has
	 * the provider id, host, wire and header names, never a token or header value.
	 */
	"ai.provider_create",
	"ai.provider_update",
	"ai.provider_delete",
	"ai.routing",
	/**
	 * Settings → Cloudflare connection: a token was saved or removed.
	 * `detail` has the token's last 4 characters and the account id, never the token.
	 */
	"cloudflare.connect",
	"cloudflare.disconnect",
	/** Settings → Licence: activated or deactivated. `detail` has the plan, never the key or token. */
	"licence.activate",
	"licence.deactivate",
	/**
	 * Cloudflare onboarding apply changed a DNS record, catch-all rule, the
	 * semantic search metadata index or the catch-all Worker name. `detail` has
	 * the plan item, record type, name and the change log id.
	 */
	"cloudflare.dns_change",
	/** A logged change was reverted. `detail.change` is the change log id. */
	"cloudflare.revert",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
	id: string;
	/** Unix seconds. */
	at: number;
	action: AuditAction;
	/** Address or service-token Client ID of whoever acted; null for `system`. */
	actor: string | null;
	actorRole: AuditActorRole;
	/** Mailbox acted on, or null for a deployment-wide action. */
	mailboxId: string | null;
	/** Who or what was acted upon, when that differs from the actor. */
	target?: string;
	/**
	 * Action-specific context — the attribution of a send, the number of messages
	 * destroyed, the role in a grant.
	 *
	 * Deliberately not the message body or subject: an audit log that quoted mail
	 * would become a second copy of the mailbox, readable by anyone who can read
	 * the log.
	 */
	detail?: Record<string, string | number | boolean | null>;
}

/**
 * Widest timestamp the inversion below can represent, in milliseconds.
 *
 * 10^13 ms is the year 2286. Subtracting from it keeps every key the same width
 * — which is what makes lexicographic order match reverse-chronological order,
 * since a shorter number would otherwise sort before a longer one regardless of
 * value.
 */
const TIMESTAMP_CEILING = 10_000_000_000_000;

/** Digits in `TIMESTAMP_CEILING`, so every key pads to the same width. */
const TIMESTAMP_WIDTH = 14;

function invertedTimestamp(atMs: number): string {
	const bounded = Math.max(0, Math.min(atMs, TIMESTAMP_CEILING));
	return String(TIMESTAMP_CEILING - bounded).padStart(TIMESTAMP_WIDTH, "0");
}

/** The prefix every entry for one scope shares. */
export function auditScopePrefix(mailboxId: string | null): string {
	return `${AUDIT_PREFIX}${mailboxId ? normalizeAddress(mailboxId) : INSTANCE_SCOPE}/`;
}

/**
 * How to classify a principal in the log for the mailbox they are acting on.
 *
 * An `owner` entry for a mailbox means the person whose mailbox it is; any
 * narrower grant is a `delegate`; reaching a mailbox with no grant at all means
 * instance-wide authority, so `admin`. This is the distinction that makes the log
 * answerable: the same person is an owner on their own mail and a delegate on the
 * shared inbox, and only the second needs explaining.
 */
export function auditActorRole(
	principal: Principal,
	mailboxId: string | null,
): AuditActorRole {
	if (!principal.identity) return "system";
	if (!mailboxId) return isAdmin(principal) ? "admin" : "delegate";

	const entry = principal.access?.find(
		(candidate) => candidate.id === normalizeAddress(mailboxId),
	);
	if (entry) return entry.role === FULL_ACCESS_ROLE ? "owner" : "delegate";

	// No entry, yet they reached the mailbox: their authority is instance-wide.
	return "admin";
}

export interface RecordAuditInput {
	action: AuditAction;
	actor: string | null;
	actorRole: AuditActorRole;
	mailboxId?: string | null;
	target?: string;
	detail?: AuditEntry["detail"];
}

/**
 * Append one entry.
 *
 * Never throws. A failure to write the log must not fail the operation being
 * logged — refusing a send because its audit line could not be stored would turn
 * a logging outage into a mail outage — but it is reported to the console so the
 * gap is explainable rather than mysterious.
 *
 * Callers should not await this on the request path where latency matters; pass it
 * to `waitUntil` instead. It is still safe to await, which keeps tests simple.
 */
export async function recordAudit(
	bucket: R2Bucket,
	input: RecordAuditInput,
): Promise<void> {
	const atMs = Date.now();
	const mailboxId = input.mailboxId ? normalizeAddress(input.mailboxId) : null;
	// Random suffix so two entries written in the same millisecond cannot collide
	// on the key and silently overwrite one another.
	const id = `${invertedTimestamp(atMs)}-${crypto.randomUUID().slice(0, 8)}`;

	const entry: AuditEntry = {
		id,
		at: Math.floor(atMs / 1000),
		action: input.action,
		actor: input.actor ? normalizeAddress(input.actor) : null,
		actorRole: input.actorRole,
		mailboxId,
		...(input.target ? { target: normalizeAddress(input.target) } : {}),
		...(input.detail ? { detail: input.detail } : {}),
	};

	try {
		await bucket.put(`${auditScopePrefix(mailboxId)}${id}.json`, JSON.stringify(entry), {
			httpMetadata: { contentType: "application/json" },
		});
	} catch (e) {
		console.error(
			`Failed to record audit entry ${input.action}:`,
			(e as Error).message,
		);
	}
}

/**
 * Record an entry off the request path, without letting the attempt break the
 * request.
 *
 * `recordAudit` already swallows a failed *write*, but reaching `waitUntil` is
 * itself fallible: Hono throws when `c.executionCtx` is unavailable, which is the
 * case wherever a handler is driven directly rather than by the Workers runtime.
 * Since the whole point of this log is that it never affects the thing it
 * records, that has to be caught too — otherwise adding an audit line to a route
 * changes the route's behaviour, which is exactly the failure mode the module
 * documents itself against.
 *
 * Falls back to awaiting the write inline when there is no context to defer to,
 * so the entry is still recorded.
 */
export async function recordAuditDeferred(
	context: { env: { BUCKET: R2Bucket }; executionCtx?: { waitUntil(p: Promise<unknown>): void } },
	input: RecordAuditInput,
): Promise<void> {
	const write = recordAudit(context.env.BUCKET, input);
	try {
		// Reading `executionCtx` is what throws, so it has to be inside the try.
		context.executionCtx?.waitUntil(write);
	} catch {
		await write;
	}
}

/**
 * Attribution detail for a principal's credential, for merging into `detail`.
 * Names the token or OAuth app, never a secret.
 */
export function credentialDetail(principal: Principal): Record<string, string | boolean> {
	const cred = principal.credential;
	if (!cred) return {};
	const out: Record<string, string | boolean> = { auth: cred.method };
	if (cred.tokenId) out.token = cred.tokenId;
	if (cred.tokenName) out.tokenName = cred.tokenName;
	if (cred.oauthClientId) out.oauthClient = cred.oauthClientId;
	if (cred.oauthClientName) out.oauthClientName = cred.oauthClientName;
	return out;
}

/** Audit families the access log UI filters by. */
export const AUDIT_CATEGORIES = {
	mail: ["mail.send", "mail.delete", "mail.destroy"],
	settings: [
		"mailbox.settings",
		"mailbox.create",
		"mailbox.delete",
		"mailbox.aliases",
		"domain.change",
		"ai.provider_create",
		"ai.provider_update",
		"ai.provider_delete",
		"ai.routing",
		"cloudflare.connect",
		"cloudflare.disconnect",
		"licence.activate",
		"licence.deactivate",
		"cloudflare.dns_change",
		"cloudflare.revert",
	],
	access: ["access.grant", "access.revoke"],
	security: AUDIT_ACTIONS.filter((a) => a.startsWith("auth.")),
	agent: AUDIT_ACTIONS.filter((a) => a.startsWith("agent.") || a.startsWith("agent_inbox.") || a.startsWith("approval.")),
} as const satisfies Record<string, readonly AuditAction[]>;

export type AuditCategory = keyof typeof AUDIT_CATEGORIES;

export function isAuditCategory(value: unknown): value is AuditCategory {
	return typeof value === "string" && Object.prototype.hasOwnProperty.call(AUDIT_CATEGORIES, value);
}

/** Entries returned when a caller names no limit. */
export const AUDIT_PAGE_SIZE = 50;

/** Ceiling on a caller-supplied limit, so one request cannot read the whole log. */
export const AUDIT_MAX_PAGE_SIZE = 200;

function parseEntry(value: unknown): AuditEntry | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Partial<AuditEntry>;
	if (typeof record.id !== "string" || typeof record.at !== "number") return null;
	if (typeof record.action !== "string") return null;
	return {
		id: record.id,
		at: record.at,
		action: record.action as AuditAction,
		actor: typeof record.actor === "string" ? record.actor : null,
		actorRole:
			record.actorRole === "owner" ||
			record.actorRole === "delegate" ||
			record.actorRole === "admin"
				? record.actorRole
				: "system",
		mailboxId: typeof record.mailboxId === "string" ? record.mailboxId : null,
		...(typeof record.target === "string" ? { target: record.target } : {}),
		...(record.detail && typeof record.detail === "object"
			? { detail: record.detail }
			: {}),
	};
}

/**
 * A page of entries for one mailbox, or for the deployment when `mailboxId` is
 * null. Newest first.
 *
 * Reads only as many keys as it returns: the inverted-timestamp key order means
 * the first page of the R2 listing already *is* the newest entries, so this does
 * not grow more expensive as the log does. That is the whole reason the keys are
 * shaped the way they are.
 */
/** Most keys a filtered read will look through before returning what it found. */
export const AUDIT_FILTER_SCAN_LIMIT = 2000;

export interface AuditFilter {
	/** Only these actions (or the actions of a category). */
	category?: AuditCategory;
	action?: AuditAction;
	/** Substring of the actor address, target, or credential (token / OAuth client). */
	actor?: string;
}

/** Whether an entry passes a filter. Pure; exported for tests. */
export function auditEntryMatches(entry: AuditEntry, filter: AuditFilter): boolean {
	if (filter.action && entry.action !== filter.action) return false;
	if (filter.category && !(AUDIT_CATEGORIES[filter.category] as readonly string[]).includes(entry.action)) {
		return false;
	}
	if (filter.actor) {
		const needle = filter.actor.trim().toLowerCase();
		if (needle) {
			const haystack = [
				entry.actor,
				entry.target,
				entry.detail?.token,
				entry.detail?.tokenName,
				entry.detail?.oauthClient,
				entry.detail?.oauthClientName,
			]
				.filter((v) => typeof v === "string")
				.join(" ")
				.toLowerCase();
			if (!haystack.includes(needle)) return false;
		}
	}
	return true;
}

async function readEntries(bucket: R2Bucket, keys: string[]): Promise<AuditEntry[]> {
	const entries = await Promise.all(
		keys.map(async (key) => {
			const stored = await bucket.get(key);
			if (!stored) return null;
			try {
				return parseEntry(await stored.json());
			} catch {
				// One unreadable entry must not make the log unreadable.
				return null;
			}
		}),
	);
	return entries.filter((entry): entry is AuditEntry => entry !== null);
}

export async function listAudit(
	bucket: R2Bucket,
	options: { mailboxId?: string | null; limit?: number; filter?: AuditFilter } = {},
): Promise<AuditEntry[]> {
	const limit = Math.min(
		Math.max(1, Math.floor(options.limit ?? AUDIT_PAGE_SIZE)),
		AUDIT_MAX_PAGE_SIZE,
	);
	const prefix = auditScopePrefix(options.mailboxId ?? null);
	const filter = options.filter;
	const filtered = Boolean(filter && (filter.action || filter.category || filter.actor?.trim()));

	if (!filtered) {
		const page = await bucket.list({ prefix, limit });
		return readEntries(bucket, page.objects.map((o) => o.key));
	}

	/**
	 * A filter cannot be pushed into R2's key listing, so walk newest-first in
	 * pages until enough matches are found or the scan budget is spent. The
	 * budget keeps one request bounded on a very large log; older matches are
	 * reached by narrowing the filter.
	 */
	const out: AuditEntry[] = [];
	let cursor: string | undefined;
	let scanned = 0;
	do {
		const page = await bucket.list({ prefix, limit: AUDIT_MAX_PAGE_SIZE, cursor });
		scanned += page.objects.length;
		for (const entry of await readEntries(bucket, page.objects.map((o) => o.key))) {
			if (auditEntryMatches(entry, filter!)) out.push(entry);
			if (out.length >= limit) return out;
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor && scanned < AUDIT_FILTER_SCAN_LIMIT);
	return out;
}

/** Parse the `?category=&action=&actor=` query of an audit route. */
export function auditFilterFromQuery(query: (name: string) => string | undefined): AuditFilter {
	const category = query("category");
	const action = query("action");
	const actor = query("actor");
	return {
		...(isAuditCategory(category) ? { category } : {}),
		...((AUDIT_ACTIONS as readonly string[]).includes(action ?? "") ? { action: action as AuditAction } : {}),
		...(actor && actor.trim() ? { actor: actor.trim().slice(0, 200) } : {}),
	};
}

/**
 * Every audit key for a mailbox, so deleting it can take its log too.
 *
 * Called from the mailbox purge path. Leaving the entries behind would mean a
 * re-created address inherited the previous mailbox's history, which reads as
 * activity that never happened in it.
 */
export async function listAuditKeysForMailbox(
	bucket: R2Bucket,
	mailboxId: string,
): Promise<string[]> {
	const prefix = auditScopePrefix(mailboxId);
	const keys: string[] = [];
	let cursor: string | undefined;

	do {
		const page = await bucket.list({ prefix, limit: 1000, cursor });
		for (const object of page.objects) keys.push(object.key);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	return keys;
}

/**
 * Delete audit entries older than `cutoffMs`, across every scope, in bounded
 * batches. Returns how many were removed and whether more remain.
 *
 * The inverted-timestamp key makes this cheap: within a scope, every entry
 * older than the cutoff sorts after `<scope>/<inverted(cutoff)>`, so a list
 * with `startAfter` reads only expired keys. At most `maxDeletes` keys go per
 * call; the next cron tick continues.
 */
export async function purgeExpiredAudit(
	bucket: R2Bucket,
	cutoffMs: number,
	options: { maxDeletes?: number } = {},
): Promise<{ deleted: number; more: boolean }> {
	const max = options.maxDeletes ?? 1000;
	const boundary = invertedTimestamp(cutoffMs);

	// Scopes are the first path segment under `audit/`.
	const scopes: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix: AUDIT_PREFIX, delimiter: "/", cursor, limit: 1000 });
		scopes.push(...(page.delimitedPrefixes ?? []));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	let deleted = 0;
	for (const scope of scopes) {
		if (deleted >= max) return { deleted, more: true };
		const page = await bucket.list({
			prefix: scope,
			// Keys are `<scope><inverted>-<rand>.json`; everything strictly older
			// than the cutoff has a larger inverted stamp, so it sorts after this.
			startAfter: `${scope}${boundary}~`,
			limit: Math.min(1000, max - deleted),
		});
		const keys = page.objects.map((o) => o.key);
		if (keys.length > 0) {
			await bucket.delete(keys);
			deleted += keys.length;
		}
		if (page.truncated) return { deleted, more: true };
	}
	return { deleted, more: false };
}
