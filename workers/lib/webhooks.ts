// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Worker-side glue for outbound webhooks: reaching the webhook object, deciding
 * who may manage which endpoint, and the input schema the API and CLI share.
 *
 * See `./webhooks-do.ts` for delivery and `../durableObject/webhook-events.ts`
 * for how events are produced.
 */

import { z } from "zod";
import type { Env } from "../types";
import type { WebhookDO } from "./webhooks-do";
import type { WebhookEndpoint } from "./webhooks-store";
import { hasTokenScope, isAdminFor, normalizeAddress, type Principal } from "./authz";
import { accessCapabilities } from "./capabilities";
import { WEBHOOK_EVENT_TYPES, validateWebhookUrl } from "../../shared/webhooks";

/**
 * The single global webhook object, or null on a deployment that has not
 * picked up the binding yet. Every caller treats null as "webhooks are off".
 */
export function webhookStub(env: Env): DurableObjectStub<WebhookDO> | null {
	const ns = (env as { WEBHOOKS?: DurableObjectNamespace<WebhookDO> }).WEBHOOKS;
	if (!ns) return null;
	return ns.get(ns.idFromName("global"));
}

// ── Authorization ───────────────────────────────────────────────────
//
// Kept in one place so a scoped-token check can slot in later: each function
// below is the whole decision for one question, and a `webhooks:manage` scope
// would be one more clause in `canManageWebhooks`.

/** The capability a non-admin needs, on their grant, for every mailbox an endpoint names. */
export const WEBHOOK_MAILBOX_CAPABILITY = "manageSettings" as const;

/** A scoped token holds `webhooks:manage` (or `admin`). Unrestricted callers always do. */
function tokenMayManageWebhooks(principal: Principal): boolean {
	return hasTokenScope(principal, "webhooks:manage") || hasTokenScope(principal, "admin");
}

/**
 * Whether the user's own grant (not the token's narrowing) holds settings
 * authority over `mailbox`. The token is checked separately: it must hold
 * `webhooks:manage` and reach the mailbox, but it does not also need
 * `mailboxes:manage`, which is a different area.
 */
function grantManagesMailbox(principal: Principal, mailbox: string): boolean {
	const address = normalizeAddress(mailbox);
	if (principal.access === null) return true;
	const entry = principal.access.find((candidate) => candidate.id === address);
	return !!entry && accessCapabilities(entry).has(WEBHOOK_MAILBOX_CAPABILITY);
}

/** The token (if any) may reach `mailbox` at all. */
function tokenReaches(principal: Principal, mailbox: string): boolean {
	const allow = principal.token?.mailboxes;
	return allow === null || allow === undefined || allow.includes(normalizeAddress(mailbox));
}

/**
 * Whether the caller may use the webhooks API at all.
 *
 * The token needs `webhooks:manage`. Then: an administrator (via `isAdminFor`,
 * so a `webhooks:manage` token of an admin qualifies without full `admin`), or
 * a member whose grant holds settings authority over some mailbox the token
 * can reach, since a mailbox-filtered endpoint is a mailbox setting.
 */
export function canManageWebhooks(principal: Principal): boolean {
	if (!tokenMayManageWebhooks(principal)) return false;
	if (isAdminFor(principal, "webhooks:manage")) return true;
	if (principal.access === null) return true;
	return principal.access.some(
		(entry) => accessCapabilities(entry).has(WEBHOOK_MAILBOX_CAPABILITY) && tokenReaches(principal, entry.id),
	);
}

/**
 * Whether the caller may see and change this endpoint (or create one with this
 * mailbox filter).
 *
 * An all-mailbox endpoint hears about every mailbox, so it needs an
 * administrator whose token (if any) is not limited to particular mailboxes: a
 * token restricted to mailbox A must not hold a hook that reports mailbox B.
 * A filtered endpoint needs, for every mailbox it names, settings authority on
 * the user's grant (or admin) and a token that reaches it.
 */
export function canManageEndpoint(principal: Principal, mailboxes: string[] | null): boolean {
	if (!tokenMayManageWebhooks(principal)) return false;
	const admin = isAdminFor(principal, "webhooks:manage");
	if (mailboxes === null || mailboxes.length === 0) {
		// A mailbox-limited token cannot hold a hook that reports other mailboxes.
		return admin && !principal.token?.mailboxes;
	}
	return mailboxes.every(
		(mailbox) => tokenReaches(principal, mailbox) && (admin || grantManagesMailbox(principal, mailbox)),
	);
}

export function visibleEndpoints(principal: Principal, endpoints: WebhookEndpoint[]): WebhookEndpoint[] {
	return endpoints.filter((endpoint) => canManageEndpoint(principal, endpoint.mailboxes));
}

// ── Input ───────────────────────────────────────────────────────────

const urlSchema = z.string().superRefine((value, ctx) => {
	const check = validateWebhookUrl(value);
	if (!check.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: check.error });
});

const mailboxesSchema = z
	.array(z.string().trim().min(3).max(320))
	.max(100)
	.nullable()
	.transform((list) => {
		if (list === null) return null;
		const normalized = [...new Set(list.map(normalizeAddress).filter(Boolean))];
		return normalized.length > 0 ? normalized : null;
	});

const eventsSchema = z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1, "Pick at least one event").max(WEBHOOK_EVENT_TYPES.length);

export const CreateWebhookSchema = z.object({
	name: z.string().trim().min(1, "Give it a name").max(100),
	url: urlSchema,
	events: eventsSchema,
	/** Omitted or null: every mailbox. */
	mailboxes: mailboxesSchema.optional().default(null),
	enabled: z.boolean().optional().default(true),
});

export const UpdateWebhookSchema = z
	.object({
		name: z.string().trim().min(1).max(100).optional(),
		url: urlSchema.optional(),
		events: eventsSchema.optional(),
		mailboxes: mailboxesSchema.optional(),
		enabled: z.boolean().optional(),
	})
	.refine((patch) => Object.keys(patch).length > 0, "Nothing to change");

/** Normalised URL, after the schema has accepted it. */
export function normalizeWebhookUrl(url: string): string {
	const check = validateWebhookUrl(url);
	return check.ok ? check.url : url;
}
