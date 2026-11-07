// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Create an agent inbox. Shared by `POST /api/v1/agent-inboxes` and the
 * `create_agent_inbox` MCP tool, so both apply the same checks.
 *
 * The caller has already been checked with `canManageAgentInboxes`.
 */

import { z } from "zod";
import type { Env } from "../types";
import type { Principal } from "./authz";
import { auditActorRole, recordAudit } from "./audit";
import { checkInboundRouting, putAgentInbox } from "./agent-inboxes";
import { purgeMailbox } from "./mailbox-purge";
import { webhookStub } from "./webhooks";
import { domainOfAddress, getZones, isDomainAllowed, normalizeDomain } from "./zones";
import { aliasOwnerOf } from "../routes/domains";
import {
	AGENT_INBOX_MAX_ALLOWED_RECIPIENTS,
	AGENT_INBOX_MAX_TTL_HOURS,
	AGENT_SEND_MODES,
	agentInboxView,
	generateAgentLocalPart,
	normalizeLocalPart,
	normalizeRecipientPattern,
	scopesForSendMode,
	type AgentInboxRecord,
} from "../../shared/agent-inboxes";
import { defaultMailboxSettings } from "../../shared/mailbox-settings";
import { WEBHOOK_EVENT_TYPES, generateWebhookSecret, validateWebhookUrl } from "../../shared/webhooks";
import { isScopeSubset } from "../../shared/token-scopes";
import { randomAlphanumeric, randomToken, sha256Hex } from "../auth/crypto";

export const CreateAgentInboxSchema = z.object({
	domain: z.string().trim().min(3).max(253),
	local_part: z.string().trim().min(1).max(64).optional(),
	purpose: z.string().trim().min(1, "Say what the agent is for").max(500),
	ttl_hours: z.number().positive().max(AGENT_INBOX_MAX_TTL_HOURS).optional(),
	allowed_recipients: z.array(z.string()).max(AGENT_INBOX_MAX_ALLOWED_RECIPIENTS).optional(),
	send_mode: z.enum(AGENT_SEND_MODES),
	webhook_url: z.string().trim().min(1).max(2048).optional(),
	display_name: z.string().trim().min(1).max(100).optional(),
});

export type CreateAgentInboxInput = z.infer<typeof CreateAgentInboxSchema>;

/** The AuthDO token methods this needs. */
interface TokenStore {
	createApiToken(input: {
		id: string;
		userId: string;
		name: string;
		secretHash: string;
		expiresAt: number | null;
		now: number;
		scopes?: string[] | null;
		mailboxes?: string[] | null;
		parentId?: string | null;
	}): Promise<unknown>;
	revokeApiToken(userId: string, tokenId: string): Promise<boolean>;
}

function tokenStore(env: Env): TokenStore {
	const ns = env.AUTH_STORE as unknown as DurableObjectNamespace;
	return ns.get(ns.idFromName("global")) as unknown as TokenStore;
}

export interface CreateContext {
	/** The AuthDO user that will own the token, or null when there is none. */
	ownerUserId: string | null;
	/** The caller's own token's expiry, when the caller is a token. */
	parentExpiresAt: number | null;
}

export type CreateOutcome = { status: 201; body: Record<string, unknown> } | { status: 400 | 403 | 409 | 503; body: { error: string; code?: string } };

function fail(status: 400 | 403 | 409 | 503, error: string, code?: string): CreateOutcome {
	return { status, body: code ? { error, code } : { error } };
}

export async function createAgentInbox(
	env: Env,
	principal: Principal,
	input: CreateAgentInboxInput,
	context: CreateContext,
	now = Date.now(),
): Promise<CreateOutcome> {
	// The token is owned by a built-in account. Access and dev-bypass callers
	// have none, so there is nobody to mint it for.
	if (!context.ownerUserId) {
		return fail(
			409,
			"Agent inboxes mint an API token, which needs a built-in account (AUTH_MODE=password). Sign in with one, or use an API token.",
			"token_owner_required",
		);
	}

	const scopes = scopesForSendMode(input.send_mode);
	// A token caller cannot hand the agent more than it holds, nor reach a
	// mailbox it could not (a new mailbox is outside any mailbox allowlist).
	const callerToken = principal.token ?? null;
	if (callerToken) {
		if (!isScopeSubset(scopes, callerToken.scopes) && !callerToken.scopes.includes("admin")) {
			const missing = scopes.filter((s) => !callerToken.scopes.includes(s));
			return fail(403, `This token cannot create an agent inbox with scopes it does not hold: ${missing.join(", ")}.`, "scope_exceeds_parent");
		}
		if (callerToken.mailboxes !== null) {
			return fail(403, "A token limited to particular mailboxes cannot create new ones.", "mailbox_exceeds_parent");
		}
	}

	const domain = normalizeDomain(input.domain);
	if (!domain || !domain.includes(".") || !isDomainAllowed(env, domain)) {
		return fail(400, `Domain not served by this deployment. Configured domains: ${getZones(env).map((z) => z.domain).join(", ") || "(none)"}`);
	}

	let localPart: string;
	if (input.local_part !== undefined) {
		const normalized = normalizeLocalPart(input.local_part);
		if (!normalized) return fail(400, "local_part: use letters, digits, dot, dash, plus or underscore");
		localPart = normalized;
	} else {
		localPart = generateAgentLocalPart();
	}

	let address = `${localPart}@${domain}`;
	// A generated name that collides is regenerated a few times; a chosen one is a 409.
	for (let attempt = 0; ; attempt++) {
		const taken = (await env.BUCKET.head(`mailboxes/${address}.json`)) || (await aliasOwnerOf(env, address));
		if (!taken) break;
		if (input.local_part !== undefined || attempt >= 4) return fail(409, `${address} already exists as a mailbox or alias`);
		address = `${generateAgentLocalPart()}@${domain}`;
	}
	if (domainOfAddress(address) !== domain) return fail(400, "Invalid address");

	const allowedAddresses = ((env.EMAIL_ADDRESSES ?? []) as string[]).map((a) => a.toLowerCase());
	if (allowedAddresses.length > 0 && !allowedAddresses.includes(address)) {
		return fail(403, "Mailbox creation is restricted to configured EMAIL_ADDRESSES");
	}

	let allowedRecipients: string[] | null = null;
	if (input.allowed_recipients !== undefined) {
		allowedRecipients = [];
		for (const entry of input.allowed_recipients) {
			const pattern = normalizeRecipientPattern(entry);
			if (!pattern) return fail(400, `allowed_recipients: "${entry}" is not an address or @domain`);
			if (!allowedRecipients.includes(pattern)) allowedRecipients.push(pattern);
		}
	}

	let webhookUrl: string | null = null;
	if (input.webhook_url !== undefined) {
		const check = validateWebhookUrl(input.webhook_url);
		if (!check.ok) return fail(400, `webhook_url: ${check.error}`);
		if (!webhookStub(env)) return fail(503, "Webhooks are not configured on this deployment (missing WEBHOOKS binding)");
		webhookUrl = check.url;
	}

	let expiresAt = input.ttl_hours === undefined ? null : now + Math.round(input.ttl_hours * 3_600_000);
	// A child token never outlives its parent, so neither does the inbox's access.
	if (callerToken && context.parentExpiresAt !== null && (expiresAt === null || expiresAt > context.parentExpiresAt)) {
		expiresAt = context.parentExpiresAt;
	}

	const displayName = input.display_name ?? null;
	const store = tokenStore(env);
	const ownerUserId = context.ownerUserId;
	let tokenId: string | null = null;
	let webhookId: string | null = null;
	let mailboxCreated = false;

	try {
		// The mailbox's agent send mode is the inbox's send mode, so the approval
		// rule and the settings screen agree with the inbox from the start.
		await env.BUCKET.put(
			`mailboxes/${address}.json`,
			JSON.stringify({ ...defaultMailboxSettings(displayName ?? localPart), agentSend: { mode: input.send_mode, allowlist: [] } }),
		);
		mailboxCreated = true;
		await env.MAILBOX.get(env.MAILBOX.idFromName(address)).getFolders();

		const id = randomAlphanumeric(12);
		const secret = randomToken(32);
		await store.createApiToken({
			id,
			userId: ownerUserId,
			name: `Agent inbox ${address}`,
			secretHash: await sha256Hex(secret),
			expiresAt,
			now,
			scopes,
			mailboxes: [address],
			// A child of the caller's token: revoking the caller revokes the agent.
			parentId: callerToken ? callerToken.id : null,
		});
		tokenId = id;

		let webhook: { id: string; url: string; events: string[]; secret: string } | null = null;
		if (webhookUrl) {
			const webhookSecret = generateWebhookSecret();
			const endpoint = await webhookStub(env)!.createEndpoint({
				name: `Agent inbox ${address}`,
				url: webhookUrl,
				secret: webhookSecret,
				events: [...WEBHOOK_EVENT_TYPES],
				mailboxes: [address],
				enabled: true,
				createdBy: principal.identity?.id ?? null,
				now,
			});
			webhookId = endpoint.id;
			webhook = { id: endpoint.id, url: endpoint.url, events: endpoint.events, secret: webhookSecret };
		}

		const record: AgentInboxRecord = {
			address,
			purpose: input.purpose,
			display_name: displayName,
			send_mode: input.send_mode,
			allowed_recipients: allowedRecipients,
			token_id: id,
			token_user_id: ownerUserId,
			scopes,
			webhook_id: webhook?.id ?? null,
			webhook_url: webhook?.url ?? null,
			created_by: principal.identity?.id ?? null,
			created_at: now,
			expires_at: expiresAt,
		};
		await putAgentInbox(env.BUCKET, record);

		await recordAudit(env.BUCKET, {
			action: "agent_inbox.create",
			actor: principal.identity?.id ?? null,
			actorRole: auditActorRole(principal, null),
			mailboxId: null,
			target: address,
			detail: { send_mode: input.send_mode, expires_at: expiresAt, webhook: Boolean(webhook) },
		});

		const routing = await checkInboundRouting(env, domain, address);
		const warnings = routing.warning ? [routing.warning] : [];

		return {
			status: 201,
			body: {
				agent_inbox: agentInboxView(record, now),
				address,
				token: { id, secret: `ttk_${id}_${secret}`, scopes, mailboxes: [address], expires_at: expiresAt },
				policy: {
					send_mode: input.send_mode,
					allowed_recipients: allowedRecipients,
					ttl_hours: input.ttl_hours ?? null,
					expires_at: expiresAt,
				},
				webhook,
				routing,
				warnings,
			},
		};
	} catch (e) {
		// Undo what was made, so a retry starts clean rather than hitting a 409.
		if (tokenId) await store.revokeApiToken(ownerUserId, tokenId).catch(() => false);
		if (webhookId) await webhookStub(env)?.deleteEndpoint(webhookId).catch(() => false);
		if (mailboxCreated) await purgeMailbox(env, address).catch(() => undefined);
		if ((e as Error).message?.includes("parent_token_inactive")) {
			return fail(403, "This token has been revoked or has expired.", "parent_token_inactive");
		}
		throw e;
	}
}
