// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Agent inboxes: create, list, end, expire, and the send-time policy check.
 *
 * An agent inbox is three things tied together: a real mailbox (R2 settings
 * object + MailboxDO), a scoped `ttk_` token confined to that mailbox, and
 * optionally a webhook endpoint filtered to it. The record that ties them
 * together lives in R2 at `agent-inboxes/<address>.json`, next to the mailbox
 * settings it describes, so the send-time policy check is one R2 read and the
 * expiry sweep is one list. It never holds a secret: the token's secret is only
 * hashed in AuthDO and the webhook secret only lives in WebhookDO.
 *
 * Ending one (DELETE, TTL expiry, or the mailbox being deleted) runs the same
 * cleanup: revoke the token, disable the webhook, archive the mail to R2 as
 * mbox, delete the mailbox, write the audit entry. Each step tolerates the
 * previous run having done it already, so a sweep that died half-way finishes
 * on the next tick.
 *
 * Cloudflare Email Routing is never changed from here. If the domain's
 * catch-all already delivers to this Worker the new address works at once;
 * otherwise the create response carries a warning naming what to add.
 */

import type { Env } from "../types";
import {
	AGENT_INBOX_ARCHIVE_PREFIX,
	AGENT_INBOX_PREFIX,
	agentInboxKey,
	agentInboxView,
	type AgentInboxRecord,
	type AgentInboxView,
} from "../../shared/agent-inboxes";
import { messageToMbox, type ExportableMessage } from "../../shared/mbox";
import { recordAudit } from "./audit";
import { listJsonUnderPrefix } from "./r2";
import { purgeMailbox, purgeMailboxAuditLog } from "./mailbox-purge";
import { webhookStub } from "./webhooks";
import { cloudflareClient } from "./cf-connection";
import { domainRpc } from "../routes/domains";

// ── Storage ─────────────────────────────────────────────────────────

export async function getAgentInbox(bucket: R2Bucket, address: string): Promise<AgentInboxRecord | null> {
	const object = await bucket.get(agentInboxKey(address));
	if (!object) return null;
	try {
		return (await object.json()) as AgentInboxRecord;
	} catch {
		return null;
	}
}

export async function putAgentInbox(bucket: R2Bucket, record: AgentInboxRecord): Promise<void> {
	await bucket.put(agentInboxKey(record.address), JSON.stringify(record), {
		httpMetadata: { contentType: "application/json" },
	});
}

export async function listAgentInboxes(bucket: R2Bucket): Promise<AgentInboxRecord[]> {
	const all = await listJsonUnderPrefix<AgentInboxRecord>(bucket, AGENT_INBOX_PREFIX);
	return all
		.filter((r) => r && typeof r.address === "string")
		.sort((a, b) => b.created_at - a.created_at);
}

export function viewsOf(records: AgentInboxRecord[], now = Date.now()): AgentInboxView[] {
	return records.map((r) => agentInboxView(r, now));
}

// ── Send policy ─────────────────────────────────────────────────────
//
// Enforced by the pre-send gate rule in ./agent-send-rule.ts, which every
// outbound path passes. The decision itself is in shared/agent-inboxes.ts.

export { decideAgentSendPolicy as decideAgentSend, type AgentSendDecision } from "../../shared/agent-inboxes";

// ── Routing ─────────────────────────────────────────────────────────

export interface RoutingCheck {
	/** True when inbound mail for the new address will reach this Worker. */
	routed: boolean;
	/** How that was decided: a read of the zone's catch-all, or the stored provision result. */
	source: "catch_all_rule" | "provision_record" | "unknown";
	warning: string | null;
}

/**
 * Whether mail to a new address on `domain` already reaches this Worker.
 * Read-only: looks at the zone's catch-all rule (with a Cloudflare token), or at
 * the last provision result stored for the domain. Never writes.
 */
export async function checkInboundRouting(env: Env, domain: string, address: string): Promise<RoutingCheck> {
	const advice = `Mail to ${address} will not arrive until Email Routing sends it to this Worker: add a routing rule for ${address} (or point the catch-all for ${domain} at the Worker) in the Cloudflare dashboard.`;
	let record: { zoneId: string | null; lastProvision?: unknown } | null = null;
	try {
		record = (env as { AUTH_STORE?: unknown }).AUTH_STORE ? await domainRpc(env).getDomain(domain) : null;
	} catch {
		record = null;
	}

	const client = await cloudflareClient(env);
	if (client && record?.zoneId) {
		try {
			const rule = await client.getCatchAll(record.zoneId);
			if (client.isRuleToWorker(rule)) return { routed: true, source: "catch_all_rule", warning: null };
			return { routed: false, source: "catch_all_rule", warning: advice };
		} catch {
			// Fall through to the stored result.
		}
	}

	const steps = (record?.lastProvision as { steps?: { step: string; status: string; detail?: string }[] } | null)?.steps;
	const catchAll = steps?.find((s) => s.step === "catch_all");
	if (catchAll?.status === "ok") return { routed: true, source: "provision_record", warning: null };
	if (catchAll) return { routed: false, source: "provision_record", warning: advice };
	return {
		routed: false,
		source: "unknown",
		warning: `Could not confirm that Email Routing delivers ${domain} to this Worker. If the catch-all for ${domain} does not point at the Worker, ${advice.charAt(0).toLowerCase()}${advice.slice(1)}`,
	};
}

// ── Ending ──────────────────────────────────────────────────────────

/** The AuthDO token method this needs. */
interface TokenRevoker {
	revokeApiToken(userId: string, tokenId: string): Promise<boolean>;
}

function tokenRevoker(env: Env): TokenRevoker | null {
	const ns = (env as unknown as { AUTH_STORE?: DurableObjectNamespace }).AUTH_STORE;
	if (!ns) return null;
	return ns.get(ns.idFromName("global")) as unknown as TokenRevoker;
}

type ExportPage = {
	messages: Record<string, unknown>[];
	attachments: Record<string, { filename: string; mimetype: string; size: number }[]>;
	done: boolean;
	cursor?: { date: string; id: string };
};

/**
 * Write the mailbox's mail to R2 as one mbox file. Returns the key, or null
 * when the mailbox holds nothing. Built in memory: an agent inbox is short
 * lived and small, and a multipart upload needs a 5 MiB minimum part anyway.
 * Capped at 100 MiB; past that the archive is truncated and says so.
 */
export async function archiveMailboxToR2(env: Env, mailbox: string, now: number): Promise<{ key: string; messages: number; truncated: boolean } | null> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailbox)) as unknown as {
		exportPage(o: { limit?: number; afterDate?: string; afterId?: string }): Promise<ExportPage>;
	};
	const CAP = 100 * 1024 * 1024;
	const parts: string[] = [];
	let bytes = 0;
	let messages = 0;
	let truncated = false;
	let cursor: { date: string; id: string } | undefined;
	for (;;) {
		const page = await stub.exportPage(cursor ? { limit: 50, afterDate: cursor.date, afterId: cursor.id } : { limit: 50 });
		for (const message of page.messages) {
			const row = message as unknown as ExportableMessage;
			const chunk = messageToMbox(row, page.attachments[row.id] ?? []);
			if (bytes + chunk.length > CAP) {
				truncated = true;
				break;
			}
			parts.push(chunk);
			bytes += chunk.length;
			messages += 1;
		}
		if (truncated || page.done || !page.cursor) break;
		cursor = page.cursor;
	}
	if (messages === 0) return null;
	const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
	const key = `${AGENT_INBOX_ARCHIVE_PREFIX}${mailbox}-${stamp}.mbox`;
	await env.BUCKET.put(key, parts.join(""), {
		httpMetadata: { contentType: "application/mbox" },
		customMetadata: { mailbox, messages: String(messages), truncated: String(truncated) },
	});
	return { key, messages, truncated };
}

export type EndReason = "expired" | "deleted" | "mailbox_deleted";

export interface EndResult {
	address: string;
	token_revoked: boolean;
	webhook_disabled: boolean;
	archive: { key: string; messages: number; truncated: boolean } | null;
	mailbox_deleted: boolean;
}

/**
 * End an agent inbox: revoke the token, disable the webhook, archive the mail,
 * delete the mailbox, record it. `options.purge: false` skips the archive and
 * mailbox steps (used when the mailbox itself is already being deleted).
 *
 * The record is removed last, so a failure part-way leaves it in place for the
 * next sweep to finish. Every step is safe to repeat.
 */
export async function endAgentInbox(
	env: Env,
	record: AgentInboxRecord,
	reason: EndReason,
	actor: { id: string | null; role: "admin" | "system" },
	options: { purge?: boolean; now?: number } = {},
): Promise<EndResult> {
	const now = options.now ?? Date.now();
	const address = record.address;
	const result: EndResult = { address, token_revoked: false, webhook_disabled: false, archive: null, mailbox_deleted: false };

	if (record.token_id && record.token_user_id) {
		const revoker = tokenRevoker(env);
		if (revoker) {
			await revoker.revokeApiToken(record.token_user_id, record.token_id);
			result.token_revoked = true;
		}
	}

	if (record.webhook_id) {
		const hooks = webhookStub(env);
		if (hooks) {
			// Disabled, then deleted: deleting alone would also do, but a disable that
			// lands when the delete fails still stops deliveries.
			await hooks.updateEndpoint(record.webhook_id, { enabled: false, now }).catch(() => null);
			await hooks.deleteEndpoint(record.webhook_id).catch(() => false);
			result.webhook_disabled = true;
		}
	}

	if (options.purge !== false && (await env.BUCKET.head(`mailboxes/${address}.json`))) {
		result.archive = await archiveMailboxToR2(env, address, now);
		await purgeMailbox(env, address);
		result.mailbox_deleted = true;
	}

	await recordAudit(env.BUCKET, {
		action: reason === "expired" ? "agent_inbox.expire" : "agent_inbox.delete",
		actor: actor.id,
		actorRole: actor.role,
		mailboxId: null,
		target: address,
		detail: {
			reason,
			token_revoked: result.token_revoked,
			webhook_disabled: result.webhook_disabled,
			archive: result.archive?.key ?? null,
			archived_messages: result.archive?.messages ?? 0,
		},
	});
	if (result.mailbox_deleted) await purgeMailboxAuditLog(env.BUCKET, address);
	await env.BUCKET.delete(agentInboxKey(address));
	return result;
}

/**
 * The plain mailbox delete route removed an agent inbox's mailbox: end the
 * rest of it (token, webhook, record). Never throws.
 */
export async function forgetAgentInboxForMailbox(env: Env, mailbox: string): Promise<void> {
	try {
		const record = await getAgentInbox(env.BUCKET, mailbox.toLowerCase());
		if (!record) return;
		await endAgentInbox(env, record, "mailbox_deleted", { id: null, role: "system" }, { purge: false });
	} catch (e) {
		console.error(`agent inbox cleanup for ${mailbox} failed:`, (e as Error).message);
	}
}

/**
 * Cron: end every agent inbox whose TTL has passed. Isolated per inbox, so
 * one failure is retried next tick without holding up the rest.
 */
export async function expireAgentInboxes(env: Env, now = Date.now()): Promise<{ expired: number; failed: number }> {
	const all = await listAgentInboxes(env.BUCKET);
	let expired = 0;
	let failed = 0;
	for (const record of all) {
		const due = record.expires_at !== null && record.expires_at <= now;
		try {
			// A mailbox removed by a path that does not know about agent inboxes
			// (account deletion, say): end the token, webhook and record too.
			// Only checked for older records, so a create in flight is not reaped.
			const orphan =
				!due && now - record.created_at > 10 * 60_000 && !(await env.BUCKET.head(`mailboxes/${record.address}.json`));
			if (!due && !orphan) continue;
			await endAgentInbox(env, record, due ? "expired" : "mailbox_deleted", { id: null, role: "system" }, { now, purge: due });
			expired += 1;
		} catch (e) {
			failed += 1;
			console.error(`agent inbox expiry for ${record.address} failed:`, (e as Error).message);
		}
	}
	return { expired, failed };
}
