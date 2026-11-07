// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Settings → Cloudflare connection.
 *
 *   GET    /api/v1/cloudflare/connection          state, account, last 4, capabilities, template link
 *   PUT    /api/v1/cloudflare/connection          { token, accountId? }: verify, probe, store
 *   POST   /api/v1/cloudflare/connection/verify   re-run the probe, update capabilities
 *   DELETE /api/v1/cloudflare/connection          forget the stored token
 *
 * Admin-only (`domains:manage`). PUT, verify and DELETE also need a browser
 * session that re-confirmed its password or passkey in the last 15 minutes,
 * like account export and deletion (`workers/routes/privacy.ts`): a token
 * that can rewrite DNS and mail routing should not be swapped by an API
 * token or a stolen, idle session.
 *
 * The token is never returned, logged or audited; only its last 4 characters.
 * `CF_API_TOKEN` in env wins over a stored connection, so PUT refuses with
 * `env_token_active` while it is set.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { authSecret } from "../auth/config";
import { PASSKEY_REAUTH_MS } from "../auth/passkeys";
import type { AuthStoreApi } from "../auth/types";
import type { CfCapability, CfConnectionView } from "../../shared/cf-connection";
import { cfTokenTemplateUrl } from "../../shared/cf-token-template";
import { auditActorRole, recordAuditDeferred } from "../lib/audit";
import {
	invalidateCloudflareConnectionCache,
	loadCloudflareConnection,
	resolveWorkerScriptName,
	tokenLast4,
} from "../lib/cf-connection";
import {
	sealCloudflareToken,
	type CloudflareConnectionPatch,
	type CloudflareConnectionRecord,
	type PutCloudflareConnectionInput,
} from "../lib/cf-connection-store";
import { probeCloudflareCapabilities, verifyCloudflareToken } from "../lib/cf-token-verify";
import { requireAdminScope, type MailboxContext } from "../lib/mailbox";

type AppContext = Context<MailboxContext>;

/** The AuthDO methods these routes call. */
export interface CloudflareConnectionRpc extends Pick<AuthStoreApi, "getOrInitMeta" | "getSessionAuthenticatedAt"> {
	getCloudflareConnection(): Promise<CloudflareConnectionRecord | null>;
	putCloudflareConnection(input: PutCloudflareConnectionInput): Promise<CloudflareConnectionRecord>;
	updateCloudflareConnection(patch: CloudflareConnectionPatch, now: number): Promise<CloudflareConnectionRecord | null>;
	deleteCloudflareConnection(): Promise<boolean>;
}

/** Overridable in tests. */
export const cloudflareRouteDeps = {
	store: (c: AppContext): CloudflareConnectionRpc => {
		const ns = c.env.AUTH_STORE as unknown as DurableObjectNamespace;
		return ns.get(ns.idFromName("global")) as unknown as CloudflareConnectionRpc;
	},
	fetchImpl: undefined as typeof fetch | undefined,
	now: () => Date.now(),
};

const P = "/api/v1/cloudflare/connection";

export const cloudflareRoutes = new Hono<MailboxContext>();
cloudflareRoutes.use(P, requireAdminScope("domains:manage"));
cloudflareRoutes.use(`${P}/*`, requireAdminScope("domains:manage"));

/** A browser session that re-confirmed its user in the last 15 minutes. Same rule as privacy.ts. */
export async function needsFreshSession(
	c: AppContext,
	store: Pick<AuthStoreApi, "getSessionAuthenticatedAt">,
	now: number = cloudflareRouteDeps.now(),
): Promise<Response | null> {
	if (c.var.authMethod !== "session" || !c.var.authSessionHash) {
		return c.json(
			{ error: "This action requires a signed-in browser session, not an API token.", code: "session_required" },
			403,
		);
	}
	const at = await store.getSessionAuthenticatedAt(c.var.authSessionHash);
	if (at === null || now - at >= PASSKEY_REAUTH_MS) {
		return c.json({ error: "Confirm it's you with your password or a passkey first.", code: "reauth_required" }, 403);
	}
	return null;
}

function envTokenSet(c: AppContext): boolean {
	return !!(c.env as { CF_API_TOKEN?: string }).CF_API_TOKEN?.trim();
}

async function view(c: AppContext, store: CloudflareConnectionRpc): Promise<CfConnectionView> {
	const loaded = await loadCloudflareConnection(c.env, store);
	const record = loaded.record;
	const fromEnv = loaded.resolved?.source === "env";
	const accountId = fromEnv ? loaded.resolved!.accountId : (record?.accountId ?? null);
	return {
		connected: loaded.resolved !== null,
		state: loaded.state,
		source: loaded.resolved?.source ?? null,
		accountId,
		// The env token was never verified here; the stored row's metadata
		// would describe a different token.
		accountName: fromEnv ? null : (record?.accountName ?? null),
		tokenKind: fromEnv ? null : (record?.tokenKind ?? null),
		last4: fromEnv ? tokenLast4(loaded.resolved!.token) : (record?.last4 ?? null),
		verifiedAt: fromEnv ? null : (record?.verifiedAt ?? null),
		workerScriptName: await resolveWorkerScriptName(c.env, store),
		capabilities: fromEnv ? [] : (record?.capabilities ?? []),
		templateUrl: cfTokenTemplateUrl({ accountId }),
	};
}

cloudflareRoutes.get(P, async (c: AppContext) => {
	return c.json(await view(c, cloudflareRouteDeps.store(c)));
});

const PutBody = z
	.object({
		token: z.string().trim().min(20, "That doesn't look like a Cloudflare API token.").max(512),
		accountId: z
			.string()
			.trim()
			.regex(/^[a-f0-9]{32}$/i, "accountId must be a 32-character account id")
			.optional(),
	})
	.strict();

function audit(c: AppContext, action: "cloudflare.connect" | "cloudflare.disconnect", detail: Record<string, string | null>) {
	return recordAuditDeferred(c, {
		action,
		actor: c.var.principal.identity?.id ?? null,
		actorRole: auditActorRole(c.var.principal, null),
		mailboxId: null,
		detail,
	});
}

cloudflareRoutes.put(P, async (c: AppContext) => {
	const store = cloudflareRouteDeps.store(c);
	const stale = await needsFreshSession(c, store);
	if (stale) return stale;
	if (envTokenSet(c)) {
		return c.json(
			{
				error: "CF_API_TOKEN is set on this Worker and always wins, so a token saved here would be ignored. Remove that secret first.",
				code: "env_token_active",
			},
			409,
		);
	}
	const parsed = PutBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) {
		return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid body", code: "invalid_token" }, 400);
	}
	const { token, accountId } = parsed.data;
	const fetchImpl = cloudflareRouteDeps.fetchImpl;

	const verified = await verifyCloudflareToken(token, { accountId, fetchImpl });
	if (!verified.ok) {
		if (verified.code === "multiple_accounts") {
			return c.json({ error: verified.error, code: verified.code, accounts: verified.accounts }, 409);
		}
		return c.json({ error: verified.error, code: verified.code }, 400);
	}

	const now = cloudflareRouteDeps.now();
	const probe = await probeCloudflareCapabilities(token, {
		accountId: verified.accountId,
		workerScriptName: await resolveWorkerScriptName(c.env, store),
		fetchImpl,
		now,
	});
	await store.putCloudflareConnection({
		tokenEnc: await sealCloudflareToken(token, await authSecret(c.env, store)),
		last4: tokenLast4(token),
		accountId: verified.accountId,
		accountName: verified.accountName,
		tokenKind: verified.tokenKind,
		capabilities: probe.capabilities,
		verifiedAt: now,
		createdBy: c.var.principal.identity?.id ?? null,
		now,
	});
	invalidateCloudflareConnectionCache();
	await audit(c, "cloudflare.connect", {
		last4: tokenLast4(token),
		account: verified.accountId,
		kind: verified.tokenKind,
	});
	return c.json(await view(c, store));
});

cloudflareRoutes.post(`${P}/verify`, async (c: AppContext) => {
	const store = cloudflareRouteDeps.store(c);
	const stale = await needsFreshSession(c, store);
	if (stale) return stale;
	const loaded = await loadCloudflareConnection(c.env, store);
	if (loaded.resolved?.source === "env") {
		return c.json({ error: "CF_API_TOKEN is set on this Worker; there is no stored connection to check.", code: "env_token_active" }, 409);
	}
	if (!loaded.record) return c.json({ error: "Not connected", code: "not_connected" }, 404);
	if (!loaded.resolved) {
		return c.json(
			{ error: "The saved token can't be read any more (AUTH_SECRET changed). Paste a token again.", code: "reconnect_required" },
			409,
		);
	}
	const token = loaded.resolved.token;
	const fetchImpl = cloudflareRouteDeps.fetchImpl;
	const verified = await verifyCloudflareToken(token, { accountId: loaded.record.accountId, fetchImpl });
	const now = cloudflareRouteDeps.now();
	let capabilities: CfCapability[];
	let accountName = loaded.record.accountName;
	if (verified.ok) {
		accountName = verified.accountName ?? accountName;
		capabilities = (
			await probeCloudflareCapabilities(token, {
				accountId: verified.accountId,
				workerScriptName: await resolveWorkerScriptName(c.env, store),
				fetchImpl,
				now,
			})
		).capabilities;
	} else {
		// Revoked or expired: every capability is gone. Kept stored so the
		// page explains it; the admin pastes a new token or disconnects.
		capabilities = loaded.record.capabilities.map((cap) => ({ name: cap.name, status: "missing", detail: "token not active" }));
	}
	await store.updateCloudflareConnection({ capabilities, verifiedAt: now, accountName }, now);
	invalidateCloudflareConnectionCache();
	const body = await view(c, store);
	if (!verified.ok) return c.json({ ...body, error: verified.error, code: "invalid_token" }, 400);
	return c.json(body);
});

cloudflareRoutes.delete(P, async (c: AppContext) => {
	const store = cloudflareRouteDeps.store(c);
	const stale = await needsFreshSession(c, store);
	if (stale) return stale;
	const prev = await store.getCloudflareConnection();
	const removed = await store.deleteCloudflareConnection();
	invalidateCloudflareConnectionCache();
	if (removed) await audit(c, "cloudflare.disconnect", { last4: prev?.last4 ?? null, account: prev?.accountId ?? null });
	return c.json(await view(c, store));
});
