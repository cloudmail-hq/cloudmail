// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Hono middleware to handle repetitive Mailbox Durable Object instantiation.
 * Checks if the mailbox exists in R2, then instantiates the DO stub
 * and attaches it to the Hono context (`c.var.mailboxStub`).
 */
import { createMiddleware } from "hono/factory";
import type { MailboxDO } from "../durableObject";
import type { Env } from "../types";
import {
	applyTokenRestriction,
	canAccessMailbox,
	canDo,
	isAdmin,
	isAdminEmailsMisconfigured,
	isAdminFor,
	resolvePrincipalFor,
	type AccessIdentity,
	type CredentialInfo,
	type Principal,
} from "./authz";
import type { MailboxCapability } from "./capabilities";
import { effectiveTokenScopes, mayAutoSend, type TokenScope } from "../../shared/token-scopes";
import { resolveAuthMode } from "../auth/config";
import { mailboxExists } from "./mailbox-exists";
import { timed } from "./server-timing";
import type { ApiTokenInfo, AuthUser, OAuthGrantInfo } from "../auth/types";

/** How the current request proved who it is. */
export type AuthMethod = "session" | "token" | "oauth" | "access" | "dev";

export type MailboxContext = {
	Bindings: Env;
	Variables: {
		mailboxStub: DurableObjectStub<MailboxDO>;
		/**
		 * Set by the Access middleware in `workers/app.ts` from the verified JWT —
		 * a person (`email`) or an Access service token (`common_name`). Undefined
		 * in development, where Access validation is skipped, and also when a
		 * verified token names neither.
		 */
		accessIdentity?: AccessIdentity;
		/**
		 * Set by `workers/app.ts` on the local-development path only, where there
		 * is no Access token to authorize against.
		 *
		 * Carried as an explicit flag rather than inferred from a missing
		 * `accessIdentity`: in production a verified token that carries neither an
		 * `email` nor a `common_name` claim also leaves `accessIdentity` unset, and
		 * treating that as "local development" would hand it administrator rights.
		 */
		developmentBypass?: boolean;
		/**
		 * The signed-in built-in account, in password mode only. Set by
		 * `authenticate` in `workers/auth/middleware.ts` alongside an
		 * `accessIdentity` derived from it.
		 */
		authUser?: AuthUser;
		/** sha256 of the session token when authenticated by cookie, else null. */
		authSessionHash?: string | null;
		/** Public id of that session, so the session list can mark "this device". */
		authSessionId?: string | null;
		authMethod?: AuthMethod;
		/**
		 * The API token the request authenticated with (`authMethod === "token"`).
		 * Its scopes and mailbox allowlist are folded into `principal` by
		 * `resolvePrincipal`.
		 */
		authToken?: ApiTokenInfo;
		/** The OAuth grant the request authenticated with (`authMethod === "oauth"`). */
		authOAuthGrant?: OAuthGrantInfo;
		/**
		 * An OAuth bearer was presented on `/mcp` and refused, so the `401`
		 * challenge can say `invalid_token` and the client refreshes instead of
		 * starting over.
		 */
		authBearerRejected?: boolean;
		/** Whether `authenticate` answered from the credential cache, for `Server-Timing`. */
		authCacheStatus?: "hit" | "miss";
		/**
		 * What the caller is allowed to do, resolved once per request by
		 * `resolvePrincipal`. See `workers/lib/authz.ts`.
		 */
		principal: Principal;
	};
};

/**
 * Describe the credential behind a request. `sendAuto` is true only for a token
 * holding `mail:send` + `mail:send:auto`, or an OAuth grant the user marked as
 * trusted; never for a session, Access or a legacy unscoped token.
 */
export function credentialFor(
	method: AuthMethod | undefined,
	token: ApiTokenInfo | undefined,
	grant: OAuthGrantInfo | undefined,
): CredentialInfo | null {
	if (!method) return null;
	if (method === "token" && token) {
		return {
			method,
			tokenId: token.id,
			tokenName: token.name,
			sendAuto: mayAutoSend(effectiveTokenScopes(token)),
		};
	}
	if (method === "oauth" && grant) {
		return {
			method,
			oauthGrantId: grant.id,
			oauthClientId: grant.clientId,
			oauthClientName: grant.clientName,
			sendAuto: grant.sendAuto === true,
		};
	}
	return { method, sendAuto: false };
}

/**
 * Resolve the caller's authority and attach it to the request.
 *
 * Mounted ahead of the route table so every handler can read `c.var.principal`
 * without repeating the lookup. The stored grant is only fetched when it can
 * change the answer — an unenforced deployment and a configured administrator
 * are both decided from configuration alone, so the common paths add no R2 read.
 */
export const resolvePrincipal = createMiddleware<MailboxContext>(
	async (c, next) => {
		/**
		 * A configured-but-unusable value leaves enforcement off, which looks
		 * exactly like not configuring it. Say so on every request until it is
		 * fixed: an authorization switch that silently did nothing is the failure
		 * this whole module exists to avoid.
		 */
		const passwordMode = resolveAuthMode(c.env) === "password";
		if (!passwordMode && isAdminEmailsMisconfigured(c.env.ADMIN_EMAILS)) {
			console.error(
				"ADMIN_EMAILS is set but no valid addresses were parsed from it, so " +
					"per-mailbox authorization is NOT being enforced. Expected a " +
					"comma-separated list, e.g. \"owner@example.com,ops@example.com\".",
			);
		}
		/**
		 * Password mode is always enforced: the owner account is the administrator
		 * an Access deployment would have named in ADMIN_EMAILS, so "no ADMIN_EMAILS"
		 * must not mean "everyone is admin" there. The owner is added by flag from
		 * the already-loaded account rather than by an extra AuthDO read.
		 */
		const authUser = c.var.authUser;
		const userPrincipal = await resolvePrincipalFor({
			adminEmailsRaw: c.env.ADMIN_EMAILS,
			bucket: c.env.BUCKET,
			identity: c.var.accessIdentity ?? null,
			developmentBypass: c.var.developmentBypass === true,
			forceEnforced: passwordMode,
			extraAdminEmails: passwordMode && authUser?.isOwner ? [authUser.email] : [],
		});
		/**
		 * A scoped API token narrows the user's authority: user grants ∩ token
		 * scopes ∩ token mailboxes. Applied here, once, so every route, MCP tool
		 * and agent socket sees the same narrowed principal. An unscoped token
		 * comes back unchanged.
		 */
		const token = c.var.authMethod === "token" ? c.var.authToken : undefined;
		const restricted = applyTokenRestriction(userPrincipal, token);
		const credential = credentialFor(c.var.authMethod, token, c.var.authOAuthGrant);
		c.set("principal", credential ? { ...restricted, credential } : restricted);
		return next();
	},
);

/**
 * Refuse a caller who is not an administrator.
 *
 * Used for instance-wide operations — creating and destroying mailboxes,
 * editing branding, managing grants — as opposed to
 * acting within a mailbox, which `requireMailbox` covers.
 */
export const requireAdmin = createMiddleware<MailboxContext>(async (c, next) => {
	if (!isAdmin(c.var.principal)) {
		return c.json({ error: "Administrator access required" }, 403);
	}
	return next();
});

/**
 * Like {@link requireAdmin}, for an admin area with its own token scope: an
 * administrator whose token (if scoped) holds `scope` or `admin`.
 */
export function requireAdminScope(scope: TokenScope) {
	return createMiddleware<MailboxContext>(async (c, next) => {
		if (!isAdminFor(c.var.principal, scope)) {
			return c.json({ error: "Administrator access required", scope }, 403);
		}
		return next();
	});
}

export const requireMailbox = createMiddleware<MailboxContext>(async (c, next) => {
	const rawId = c.req.param("mailboxId");
	if (!rawId) return c.json({ error: "Mailbox ID required" }, 400);
	const mailboxId = decodeURIComponent(rawId);

	// Verify mailbox exists. Reads may use a few-second per-isolate memo of a
	// positive answer; writes always ask R2. See ./mailbox-exists.ts.
	const key = `mailboxes/${mailboxId}.json`;
	const exists = await timed(c, "mailbox", () =>
		mailboxExists(mailboxId, {
			method: c.req.method,
			head: () => c.env.BUCKET.head(key),
			waitUntil: (p) => {
				// Hono throws when there is no execution context (unit tests).
				try {
					c.executionCtx.waitUntil(p);
				} catch {
					/* the promise still runs; nothing needs to keep it alive */
				}
			},
		}),
	);
	if (!exists) {
		return c.json({ error: "Not found" }, 404);
	}

	/**
	 * Authorization, at the one place every per-mailbox route passes through.
	 *
	 * This middleware is mounted on `/api/v1/mailboxes/:mailboxId/*`, and Hono's
	 * trailing wildcard matches the bare `/api/v1/mailboxes/:mailboxId` too, so
	 * reading, updating and deleting the mailbox itself are covered by the same
	 * check as its messages, folders, rules and attachments.
	 *
	 * 403 rather than 404: the mailbox list already only shows what the caller
	 * may see, so hiding existence here buys nothing and costs a support ticket
	 * every time a member wonders why their colleague's inbox "does not exist".
	 */
	if (!canAccessMailbox(c.var.principal, mailboxId)) {
		return c.json({ error: "You do not have access to this mailbox" }, 403);
	}

	// Instantiate DO stub
	const ns = c.env.MAILBOX;
	const id = ns.idFromName(mailboxId);
	const stub = ns.get(id);

	c.set("mailboxStub", stub);

	// Everything downstream: capability gates, the Durable Object call and
	// serialising its answer.
	await timed(c, "handler", next);
});

/**
 * Refuse a caller who can reach the mailbox but may not do this to it.
 *
 * Chained after `requireMailbox`, so by the time this runs the mailbox is known
 * to exist and to be reachable; the only remaining question is how far the
 * caller's authority goes inside it. Answers 403 rather than 404 for the same
 * reason `requireMailbox` does: they already know the mailbox is there, so
 * hiding it would only be confusing.
 *
 * Declared as path middleware at the call site rather than wrapped around each
 * handler, so a route added under an already-gated path inherits the gate
 * instead of being unprotected until someone remembers to add it.
 */
export function requireCapability(capability: MailboxCapability) {
	return requireAnyCapability([capability]);
}

/**
 * Refuse a caller holding none of `capabilities`.
 *
 * Exists for sending, where `sendAs` and `sendOnBehalf` differ in attribution
 * rather than in power and are independently grantable. A gate naming only one of
 * them refuses a grant that legitimately holds the other — and since the handler
 * asks `sendAttributionFor` which to use anyway, the gate's job is only to
 * establish that *some* authority to send exists.
 *
 * The refusal names every capability that would have been enough, because "you
 * need sendOnBehalf" is misleading advice when sendAs would also have done.
 */
export function requireAnyCapability(capabilities: MailboxCapability[]) {
	return createMiddleware<MailboxContext>(async (c, next) => {
		const rawId = c.req.param("mailboxId");
		// No mailbox in the path means this gate was mounted somewhere it cannot
		// decide anything. Refuse rather than wave the request through.
		if (!rawId) return c.json({ error: "Mailbox ID required" }, 400);

		const mailboxId = decodeURIComponent(rawId);
		if (capabilities.some((capability) => canDo(c.var.principal, mailboxId, capability))) {
			return next();
		}

		const named = capabilities.join(" or ");
		return c.json(
			{
				error: `You do not have permission to do this in this mailbox (${named})`,
				// Singular when there is one, so an existing client reading this field
				// keeps working; the array is additive.
				capability: capabilities[0],
				capabilities,
			},
			403,
		);
	});
}
