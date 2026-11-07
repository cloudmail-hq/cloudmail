// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Re-validating event stream connections: the {@link Revalidator} EventsDO
 * uses, and the credential reference the Worker route attaches to a grant.
 *
 * The same checks the request path makes, run again against live state:
 *
 * - session: `validateSession` (expiry, revocation, disabled user)
 * - token: `validateApiToken` (expiry, revocation, cascade, disabled user),
 *   then the token's scopes and mailboxes narrow the principal again
 * - Access / development: no AuthDO credential exists, so only the R2 grant is
 *   re-read; the connection's lifetime bounds the Access JWT as before
 *
 * Then the readable mailbox set is recomputed from the current R2 grants and
 * mailbox list, exactly as the route computed it at the handshake.
 */

import type { Context } from "hono";
import type { Env } from "../types";
import type { AuthUser, ApiTokenInfo } from "../auth/types";
import { resolveAuthMode } from "../auth/config";
import { parseBearerToken, principalForUser } from "../auth/middleware";
import { sha256Hex } from "../auth/crypto";
import { applyTokenRestriction, resolvePrincipalFor, type Principal } from "./authz";
import { listMailboxes } from "./email-helpers";
import { readableMailboxes } from "./events";
import { credentialKey, type CredentialRef, type RevalidationResult, type Revalidator } from "./events-hub";
import type { MailboxContext } from "./mailbox";

/** The AuthDO methods revalidation calls. */
export interface RevalidationStore {
	getAuthEpoch(): Promise<number>;
	validateSession(tokenHash: string, now: number): Promise<{ user: AuthUser; session: { expiresAt?: number } } | null>;
	validateApiToken(
		tokenId: string,
		secretHash: string,
		now: number,
		ip?: string | null,
	): Promise<{ user: AuthUser; token: ApiTokenInfo } | null>;
}

function authStoreOf(env: Env): RevalidationStore {
	const ns = env.AUTH_STORE as unknown as DurableObjectNamespace;
	return ns.get(ns.idFromName("global")) as unknown as RevalidationStore;
}

/**
 * The credential the request authenticated with, as a hash reference. Never
 * the secret: the token's secret is hashed here, as the middleware does.
 */
export async function credentialRefFor(c: Context<MailboxContext>): Promise<CredentialRef> {
	const method = c.var.authMethod;
	if (method === "token") {
		const bearer = parseBearerToken(c.req.header("authorization"));
		if (bearer) return { kind: "token", id: bearer.id, hash: await sha256Hex(bearer.secret) };
	}
	if (method === "session" && c.var.authSessionHash) {
		return { kind: "session", hash: c.var.authSessionHash };
	}
	const identity = c.var.principal.identity;
	return {
		kind: "identity",
		identity: identity ? { kind: identity.kind, id: identity.id, subject: identity.subject ?? null } : null,
		developmentBypass: c.var.principal.developmentBypass === true,
	};
}

/**
 * Build the object's revalidator. `deps` replaces the AuthDO and the mailbox
 * list (tests).
 */
export function createRevalidator(
	env: Env,
	deps: { store?: RevalidationStore; mailboxes?: () => Promise<string[]> } = {},
): Revalidator {
	const store = () => deps.store ?? authStoreOf(env);
	const allMailboxes = deps.mailboxes ?? (async () => (await listMailboxes(env.BUCKET)).map((m) => m.email));
	return {
		epoch: () => store().getAuthEpoch(),
		async validate(credentials, now) {
			const out = new Map<string, RevalidationResult>();
			// One mailbox list for the batch; R2 reads per principal are the grants.
			const all = await allMailboxes();
			await Promise.all(
				credentials.map(async (ref) => {
					// Any throw propagates: the hub fails closed on it.
					const result = await validateOne(env, store(), ref, now, all);
					out.set(credentialKey(ref), result);
				}),
			);
			return out;
		},
	};
}

async function validateOne(
	env: Env,
	store: RevalidationStore,
	ref: CredentialRef,
	now: number,
	all: string[],
): Promise<RevalidationResult> {
	let principal: Principal;
	let expiresAt: number | null = null;
	if (ref.kind === "session") {
		const hit = await store.validateSession(ref.hash, now);
		if (!hit) return { ok: false, reason: "revoked" };
		principal = await principalForUser(env, hit.user);
	} else if (ref.kind === "token") {
		const hit = await store.validateApiToken(ref.id, ref.hash, now, null);
		if (!hit) return { ok: false, reason: "revoked" };
		principal = applyTokenRestriction(await principalForUser(env, hit.user), hit.token);
		expiresAt = hit.token.expiresAt;
	} else {
		const passwordMode = resolveAuthMode(env) === "password";
		principal = await resolvePrincipalFor({
			adminEmailsRaw: env.ADMIN_EMAILS,
			bucket: env.BUCKET,
			identity: ref.identity,
			developmentBypass: ref.developmentBypass,
			forceEnforced: passwordMode,
		});
	}
	return { ok: true, readable: readableMailboxes(principal, all), expiresAt };
}
