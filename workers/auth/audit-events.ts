// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Account-security events for the audit log (sign-in, sign-out, password, 2FA,
 * passkeys, sessions, tokens, connected apps).
 *
 * Written to the deployment scope, where the admin-only access log reads them.
 * The client IP and user agent go into `detail` because "where was this from"
 * is the first question about a sign-in. Never a password, code or secret.
 *
 * Off the request path and never throws (see `recordAuditDeferred`): a logging
 * outage must not lock anyone out.
 */

import type { Context } from "hono";
import { recordAuditDeferred, type AuditAction } from "../lib/audit";
import type { MailboxContext } from "../lib/mailbox";
import type { AuthUser } from "./types";

type C = Context<MailboxContext>;

export function authAudit(
	c: C,
	action: AuditAction,
	options: {
		/** Who did it; defaults to the signed-in user. */
		user?: Pick<AuthUser, "email"> | null;
		/** Who or what was acted upon (an address tried, a token id). */
		target?: string | null;
		detail?: Record<string, string | number | boolean | null>;
	} = {},
): Promise<void> {
	const user = options.user === undefined ? c.var.authUser ?? null : options.user;
	const ip = c.req.header("cf-connecting-ip") ?? null;
	const ua = c.req.header("user-agent")?.slice(0, 160) ?? null;
	return recordAuditDeferred(c, {
		action,
		actor: user?.email ?? null,
		// A person acting on their own account is its owner; no user means a
		// failed sign-in, which has nobody verified behind it.
		actorRole: user ? "owner" : "system",
		mailboxId: null,
		...(options.target ? { target: options.target } : {}),
		detail: {
			...(ip ? { ip } : {}),
			...(ua ? { userAgent: ua } : {}),
			...(c.var.authMethod ? { auth: c.var.authMethod } : {}),
			...(c.var.authToken ? { token: c.var.authToken.id } : {}),
			...options.detail,
		},
	});
}
