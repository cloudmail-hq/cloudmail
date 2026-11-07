// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The scope a scoped API token needs for routes that are not decided by a
 * mailbox capability.
 *
 * Mailbox work (`/api/v1/mailboxes/:mailboxId/...`) is narrowed where it is
 * authorized — `canDo` / `mailboxCapabilities` in `workers/lib/authz.ts` already
 * intersect the user's grant with the token's scopes, so the capability gates in
 * `workers/index.ts` and the MCP tools need nothing extra. What remains are
 * instance-level routes (people, analytics, templates, admin screens), which no
 * mailbox capability describes. This table covers them, in one place, and is
 * mounted once on `/api/*`.
 *
 * Fails closed: a route this table does not recognise needs `admin`, so a route
 * added later is unreachable to a narrowly scoped token until someone decides
 * which scope it belongs to. Sessions, OAuth, Access and legacy unscoped tokens
 * are never affected.
 */

import { createMiddleware } from "hono/factory";
import type { TokenScope } from "../../shared/token-scopes";
import { hasTokenScope, type Principal } from "./authz";
import type { MailboxContext } from "./mailbox";

/**
 * - a scope: the token must hold it
 * - `"any"`: every authenticated token (the route filters by authority itself,
 *   or reveals nothing a token could misuse)
 * - `"mailbox"`: decided by the mailbox capability gates; nothing to add here
 */
export type RouteScopeRequirement = TokenScope | "any" | "mailbox";

const MAILBOX_SUBTREE = /^\/api\/v1\/mailboxes\/[^/]+\/.+$/;
const MAILBOX_ROOT = /^\/api\/v1\/mailboxes\/[^/]+\/?$/;

const ANY_READ = new Set([
	"/api/v1/me",
	"/api/v1/config",
	"/api/v1/branding",
	"/api/v1/branding/logo",
	"/api/v1/preferences",
	"/api/v1/openapi.json",
	"/api/v1/mailboxes",
]);

/** Scopes for admin-only areas, which an `admin`-scoped token also satisfies. */
const ADMIN_AREAS = new Set<RouteScopeRequirement>(["domains:manage"]);

function under(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(`${prefix}/`);
}

/** What a scoped token needs for `method path`. Pure; exported for tests and the spec. */
export function requiredTokenScope(method: string, rawPath: string): RouteScopeRequirement {
	const m = method.toUpperCase();
	const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") : rawPath;
	const read = m === "GET" || m === "HEAD" || m === "OPTIONS";

	if (read && ANY_READ.has(path)) return "any";

	// Aliases are domain configuration: admin-only, own scope.
	if (/^\/api\/v1\/mailboxes\/[^/]+\/aliases$/.test(path) && !read) return "domains:manage";
	// Send caps bound how much of the account quota a mailbox may spend: an
	// instance-wide decision, so admin-only rather than a mailbox capability.
	if (/^\/api\/v1\/mailboxes\/[^/]+\/send-limits$/.test(path) && !read) return "admin";

	if (MAILBOX_SUBTREE.test(path)) {
		// Every way to look inside a mailbox is reading it. Writes are decided by
		// the capability gates, which already see the token's scopes.
		if (read) return "mail:read";
		// Delegates are configuration, gated by `manageDelegates`, which only
		// `mailboxes:manage` carries — so the capability gate covers it.
		return "mailbox";
	}

	if (MAILBOX_ROOT.test(path)) {
		if (read) return "any";
		if (m === "PUT" || m === "PATCH") return "mailbox"; // manageSettings
		if (m === "DELETE") return "mailboxes:manage";
	}
	if (path === "/api/v1/mailboxes" && m === "POST") return "mailboxes:manage";

	if (under(path, "/api/v1/people") || under(path, "/api/v1/analytics")) {
		return read ? "mail:read" : "admin";
	}
	// The unified inbox reads mail; products are shared identity, managed with mailboxes.
	if (path === "/api/v1/inbox") return read ? "mail:read" : "admin";
	if (under(path, "/api/v1/products")) return read ? "mail:read" : "mailboxes:manage";
	if (under(path, "/api/v1/templates")) return read ? "mail:read" : "mail:draft";
	if (under(path, "/api/v1/sequences")) return read ? "mail:read" : "mail:send";
	if (under(path, "/api/v1/domains")) return "domains:manage";
	// The Cloudflare token provisions domains: the same admin area.
	if (under(path, "/api/v1/cloudflare")) return "domains:manage";
	// The suppression list. `check` is a POST only to carry an address list;
	// it changes nothing, so it reads like the list.
	if (under(path, "/api/v1/suppressions")) {
		return read || path === "/api/v1/suppressions/check" ? "mail:read" : "mailboxes:manage";
	}
	if (under(path, "/api/v1/webhooks")) return "webhooks:manage";
	// Agent inboxes mint mailboxes and tokens: admin-only, mailbox management.
	if (under(path, "/api/v1/agent-inboxes")) return "mailboxes:manage";
	// The realtime stream reads mail; it filters to mailboxes the caller may read.
	if (under(path, "/api/v1/events")) return "mail:read";
	// The caller's own assistant: their brief is mail they could read anyway
	// (narrowed per request), and their preferences are theirs to change.
	if (path === "/api/v1/me/assistant" || under(path, "/api/v1/me/brief")) return "mail:read";
	// Web Push devices and preferences are the caller's own, and a push only
	// ever carries mail they may read; the routes refuse tokens anyway.
	if (under(path, "/api/v1/push")) return "mail:read";
	if (path === "/api/v1/ai/settings") return read ? "any" : "admin";
	// Cross-mailbox search and Ask read mail; both narrow to readable mailboxes.
	// Ask is a POST only to carry the question; it changes nothing.
	if (path === "/api/v1/search" || path === "/api/v1/ask") return "mail:read";
	if (path === "/api/v1/ai/semantic" && read) return "any";
	// Spam-rate breaker state: readable like analytics; resuming is admin-only.
	if (under(path, "/api/v1/sending-health")) return read ? "mail:read" : "admin";
	// Account-wide bills: admin-only, reading included.
	if (under(path, "/api/v1/usage")) return "admin";
	// The privacy notice is public text; editing it is admin.
	if (path === "/api/v1/privacy") return read ? "any" : "admin";
	// Your own account's export and deletion: the account itself, which no
	// scope describes, so a scoped token needs `admin` (and the handlers want
	// a browser session anyway).

	// Access grants, the audit log, branding and preference writes, migration,
	// and anything not listed above.
	return "admin";
}

/**
 * Shared definitions every mailbox uses: writing them from a token confined to
 * some mailboxes would reach the others, so such a token needs `admin`.
 */
function isSharedDefinitionWrite(method: string, path: string): boolean {
	if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
	if (under(path, "/api/v1/templates")) return true;
	// Sequence definitions, not enrollments (those are per-mailbox and checked
	// with `canDo` on their `fromAddress`).
	return /^\/api\/v1\/sequences(\/[^/]+)?$/.test(path) && path !== "/api/v1/sequences/enrollments";
}

/**
 * The scope check for `method path`, or null when the caller may proceed.
 * Pure, so the rules can be tested without HTTP.
 */
export function tokenScopeDecision(principal: Principal, method: string, rawPath: string): RouteScopeRequirement | null {
	// Only a fully legacy token (or a session) has no restriction. Any restricted
	// token, including one limited by mailbox alone, is checked: its scopes were
	// normalized so admin-class scopes count only when listed explicitly.
	if (!principal.token) return null;
	const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") : rawPath;

	if (principal.token.mailboxes !== null && isSharedDefinitionWrite(method.toUpperCase(), path)) {
		return hasTokenScope(principal, "admin") ? null : "admin";
	}

	const required = requiredTokenScope(method, path);
	if (required === "any" || required === "mailbox" || hasTokenScope(principal, required)) return null;
	// `admin` covers every admin-only area, including those with their own
	// scope (domains). It never covers ordinary mail scopes.
	if (ADMIN_AREAS.has(required) && hasTokenScope(principal, "admin")) return null;
	// Suppression writes are an admin area too (`requireAdminScope` in
	// routes/suppressions.ts). Scoped here rather than by adding
	// `mailboxes:manage` to ADMIN_AREAS, which would also widen mailbox routes.
	if (under(path, "/api/v1/suppressions") && hasTokenScope(principal, "admin")) return null;
	if (under(path, "/api/v1/agent-inboxes") && hasTokenScope(principal, "admin")) return null;
	return required;
}

/** Refuse a scoped token calling a route its scopes do not cover. */
export const tokenScopeGuard = createMiddleware<MailboxContext>(async (c, next) => {
	const principal = c.var.principal;
	if (!principal) return next();
	const required = tokenScopeDecision(principal, c.req.method, new URL(c.req.url).pathname);
	if (required === null) return next();
	return c.json(
		{
			error: `This API token does not have the "${required}" scope.`,
			code: "insufficient_scope",
			scope: required,
		},
		403,
	);
});
