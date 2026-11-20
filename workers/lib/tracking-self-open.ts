// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Build the per-request context the public tracking endpoints use: the user
 * agent and network facts for the proxy flag, and a self-open check.
 *
 * ## The self-open check
 *
 * An open recorded because the SENDER loaded the pixel is noise, and it is the
 * most misleading kind: "opened 2 minutes after sending" when nobody but you
 * looked. The tracking routes are public, so they never resolve an identity on
 * their own; this looks only at the app's session cookie, and only when one is
 * present:
 *
 *   1. no session cookie → not a self-open (the common case costs nothing);
 *   2. the session must validate in the auth store (expired / revoked → not us);
 *   3. the session's user must be able to read the mailbox the token names.
 *
 * The cookie is `SameSite=Lax`, so it rides along only on a same-site request
 * (the sender opening a tracked link or pixel URL in the app's own browser
 * profile). Image loads from the sandboxed reading pane are cross-site and
 * carry no cookie, which is why the reading pane also refuses to load our own
 * pixels at all (see `app/lib/email-html.ts`); the two together cover both ways
 * the sender's own browser can reach the pixel.
 *
 * Password mode only: in Access mode there is no app session to read, and the
 * reading-pane guard is the protection.
 */

import { resolveAuthMode } from "../auth/config";
import { readSessionCookie } from "../auth/cookies";
import { sha256Hex } from "../auth/crypto";
import { principalForUser } from "../auth/middleware";
import type { AuthStoreApi } from "../auth/types";
import type { Env } from "../types";
import { canAccessMailbox } from "./authz";
import type { TrackingRequestContext } from "./tracking-endpoint";

export function trackingRequestContext(
	request: Request,
	env: Env,
	getStore: (env: Env) => AuthStoreApi,
	now: () => number = Date.now,
): TrackingRequestContext {
	const cf = (request as { cf?: { asn?: number; asOrganization?: string } }).cf;
	const cookie = request.headers.get("cookie");
	const sessionToken =
		resolveAuthMode(env) === "password" ? readSessionCookie(cookie, request.url) : null;

	return {
		userAgent: request.headers.get("user-agent"),
		network: { asn: cf?.asn ?? null, asOrganization: cf?.asOrganization ?? null },
		isOwnSession: sessionToken
			? async (mailboxId) => {
					const store = getStore(env);
					const session = await store.validateSession(await sha256Hex(sessionToken), now());
					if (!session) return false;
					const principal = await principalForUser(env, session.user);
					return canAccessMailbox(principal, mailboxId);
				}
			: undefined,
	};
}
