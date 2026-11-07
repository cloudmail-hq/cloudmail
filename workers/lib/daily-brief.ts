// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Worker-side glue for the daily brief: who the brief is for, which mailboxes
 * they may read *right now*, the fan-out to each MailboxDO, and email delivery.
 *
 * Kept free of `cloudflare:workers` imports so it is unit-testable with fake
 * bindings; the Durable Object that schedules it is `./assistant-do.ts`.
 */

import type { Env } from "../types";
import type { MailboxDO } from "../durableObject";
import { deploymentOrigin } from "./deployment-origin";
import { resolveAuthMode, resolveAuthEmailSender } from "../auth/config";
import { canDo, resolvePrincipalFor, visibleMailboxes, type AccessIdentity, type Principal } from "./authz";
import { listMailboxes } from "./email-helpers";
import { isDomainAllowed } from "./zones";
import { sendEmail } from "../email-sender";
import { preSendOrThrow } from "./pre-send";
import {
	briefRange,
	buildDailyBrief,
	renderBriefEmail,
	type DailyBrief,
	type MailboxBriefData,
} from "../../shared/daily-brief";

/** Who a brief belongs to. Stored in the AssistantDO; never a secret. */
export interface BriefOwner {
	identity: AccessIdentity;
	/** Password-mode owner account: always an administrator. */
	isOwner?: boolean;
	/** Where the brief email goes. Null for service identities. */
	email: string | null;
}

/** The per-user AssistantDO stub, or null where the binding is absent. */
export function assistantStub(env: Env, identityId: string) {
	const ns = (env as { ASSISTANT?: DurableObjectNamespace<import("./assistant-do").AssistantDO> }).ASSISTANT;
	if (!ns) return null;
	return ns.get(ns.idFromName(`user:${identityId.toLowerCase()}`));
}

/**
 * The owner's authority as it stands now. Resolved at build time rather than
 * stored, so a grant revoked yesterday is not in today's brief.
 */
export async function principalForOwner(env: Env, owner: BriefOwner): Promise<Principal> {
	const passwordMode = resolveAuthMode(env) === "password";
	return resolvePrincipalFor({
		adminEmailsRaw: env.ADMIN_EMAILS,
		bucket: env.BUCKET,
		identity: owner.identity,
		forceEnforced: passwordMode,
		extraAdminEmails: passwordMode && owner.isOwner && owner.email ? [owner.email] : [],
	});
}

/** Mailboxes this principal may read, served by this deployment. */
export async function readableMailboxes(env: Env, principal: Principal): Promise<string[]> {
	const all = (await listMailboxes(env.BUCKET)).map((m) => ({ email: (m.email ?? m.id).toLowerCase() }));
	const served = all.filter((m) => isDomainAllowed(env, m.email.split("@")[1] ?? ""));
	return visibleMailboxes(principal, served, (m) => m.email)
		.map((m) => m.email)
		.filter((address) => canDo(principal, address, "read"));
}

/** Most mailboxes one brief covers, so one alarm stays bounded. */
export const BRIEF_MAX_MAILBOXES = 25;

export async function collectForMailboxes(
	env: Env,
	mailboxes: string[],
	window: { since: number; until: number },
): Promise<MailboxBriefData[]> {
	const out: MailboxBriefData[] = [];
	for (const mailbox of mailboxes.slice(0, BRIEF_MAX_MAILBOXES)) {
		try {
			const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailbox)) as unknown as Pick<MailboxDO, "getBriefData">;
			out.push(
				(await stub.getBriefData({
					mailbox,
					since: new Date(window.since).toISOString(),
					until: new Date(window.until).toISOString(),
				})) as MailboxBriefData,
			);
		} catch (e) {
			// One unreachable mailbox must not cost the user the whole brief.
			console.error(`brief: ${mailbox} failed:`, (e as Error).message);
		}
	}
	return out;
}

export async function buildBriefForIdentity(
	env: Env,
	owner: BriefOwner,
	options: { now: number; time: string; timeZone: string; throughNow?: boolean },
): Promise<DailyBrief> {
	const principal = await principalForOwner(env, owner);
	const mailboxes = await readableMailboxes(env, principal);
	const window = briefRange(options.now, options.time, options.timeZone, options.throughNow);
	const data = await collectForMailboxes(env, mailboxes, window);
	return buildDailyBrief({ data, ...options });
}

/** Email the brief to its owner from the instance's auth sender. No-op when either is missing. */
export async function deliverBriefEmail(env: Env, owner: BriefOwner, brief: DailyBrief): Promise<boolean> {
	if (!owner.email) return false;
	const from = resolveAuthEmailSender(env);
	if (!from) return false;
	const { subject, text, html } = renderBriefEmail(brief, await deploymentOrigin(env));
	const headers = { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" };
	// System mail to the account holder, through the shared gate: provider
	// limits only, no mailbox caps, no suppression filter. See ./pre-send.ts.
	const gate = await preSendOrThrow(env, {
		kind: "system",
		from: from.email,
		mailboxId: null,
		to: owner.email,
		text,
		html,
		headers,
		actor: { via: "system" },
	});
	await sendEmail(env.EMAIL, {
		to: owner.email,
		from: from.name ? { email: from.email, name: from.name } : from.email,
		subject,
		text,
		html,
		headers,
	}, gate.clearance);
	return true;
}
