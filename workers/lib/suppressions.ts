// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Sending compliance: the suppression list, unsubscribe links, and the hooks
 * that keep both up to date.
 *
 * ## What is enforced where
 *
 * Suppressions block NON-TRANSACTIONAL mail only:
 *
 *   - sequence steps (`sequence-dispatch.ts`) — always;
 *   - template sends (`POST /api/v1/mailboxes/:id/template-sends`) — always;
 *   - `POST /api/v1/mailboxes/:id/emails` when the body sets
 *     `transactional: false` or `list: true`.
 *
 * A one-to-one reply from the UI is transactional and is never blocked: someone
 * who unsubscribed from a drip campaign and then writes to support still gets
 * an answer. The composer shows a warning chip instead (`GET .../check`).
 *
 * ## Where the list comes from
 *
 *   - the `/u/:token` page (`unsubscribed`, scoped to the sending domain);
 *   - permanent, address-level DSNs and provider verdicts (`hard_bounce`, global);
 *   - Email Service refusing a recipient with `E_RECIPIENT_SUPPRESSED`
 *     (`hard_bounce`, global — the platform already will not deliver);
 *   - the API, the Settings page and the CLI (`manual`, any scope), and CSV import.
 *
 * Storage is the global AuthDO (`0008_suppressions`): one table for the whole
 * deployment, with transactional bulk import.
 */

import {
	GLOBAL_SCOPE,
	isRecipientSuppressedError,
	sendingDomainOf,
	type SuppressionInput,
} from "../../shared/suppressions";
import { buildListUnsubscribeHeaders } from "../../shared/list-unsubscribe";
import { signUnsubscribeToken } from "../../shared/unsubscribe-token";
import type {
	SuppressionRecord,
	SuppressionStoreApi,
} from "../auth/types";
import type { AuthDO } from "../auth/store";
import type { Env } from "../types";
import * as sequences from "./sequences";
import { configuredOrigin, deploymentOrigin, warnNoDeploymentOrigin } from "./deployment-origin";

/** The AuthDO stub, typed to the suppression surface only. */
export function suppressionStore(env: Env): SuppressionStoreApi {
	const ns = env.AUTH_STORE as unknown as DurableObjectNamespace<AuthDO> | undefined;
	if (!ns) {
		// Every deployment binds AUTH_STORE; this only guards hand-built test envs
		// so a missing binding reads as "nothing suppressed" instead of a throw.
		const missing = () => Promise.reject(new Error("AUTH_STORE binding is missing"));
		return {
			listSuppressions: missing,
			addSuppressions: missing,
			deleteSuppression: missing,
			findSuppressions: missing,
		};
	}
	return ns.get(ns.idFromName("global")) as unknown as SuppressionStoreApi;
}

/**
 * Which of `recipients` are suppressed for mail from `fromAddress`.
 *
 * Returns a map of address to the blocking entry. Fails OPEN on a store error
 * (logs, returns empty): a broken suppression lookup should not take down every
 * sequence, and the provider's own suppression list still backs it up.
 */
export async function findBlockingSuppressions(
	store: Pick<SuppressionStoreApi, "findSuppressions">,
	recipients: string[],
	fromAddress: string,
): Promise<Map<string, SuppressionRecord>> {
	const blocked = new Map<string, SuppressionRecord>();
	const domain = sendingDomainOf(fromAddress);
	try {
		const rows = await store.findSuppressions(recipients, domain || null);
		for (const row of rows) if (!blocked.has(row.address)) blocked.set(row.address, row);
	} catch (e) {
		console.error("Suppression lookup failed; sending unfiltered:", (e as Error).message);
	}
	return blocked;
}

/** Add one entry, swallowing errors. For the automatic (bounce/unsub) paths. */
export async function recordSuppression(
	store: Pick<SuppressionStoreApi, "addSuppressions" | "escalateSuppression">,
	entry: SuppressionInput,
	now = Date.now(),
): Promise<boolean> {
	try {
		const full = { ...entry, scope: entry.scope ?? GLOBAL_SCOPE };
		const result = await store.addSuppressions([full], now);
		if (result.added > 0) return true;
		// Already listed: a stronger reason (complaint over unsubscribed) wins, so
		// the entry starts blocking transactional mail too.
		if (entry.reason === "complaint" || entry.reason === "hard_bounce") {
			return (await store.escalateSuppression?.(full)) ?? false;
		}
		return false;
	} catch (e) {
		console.error(
			`Could not record suppression for ${entry.address}:`,
			(e as Error).message,
		);
		return false;
	}
}

// ── Unsubscribe links ──────────────────────────────────────────────

/** Meta key for the generated signing secret, when no Worker secret is set. */
const UNSUBSCRIBE_SECRET_META_KEY = "unsubscribe_secret";

/**
 * The HMAC key for unsubscribe tokens.
 *
 * `UNSUBSCRIBE_SECRET` when configured. Otherwise one is generated once and
 * kept in the AuthDO meta table, so links keep working across deploys without
 * the operator having to set anything.
 */
export async function getUnsubscribeSecret(env: Env): Promise<string> {
	const configured = env.UNSUBSCRIBE_SECRET?.trim();
	if (configured) return configured;
	const ns = env.AUTH_STORE as unknown as DurableObjectNamespace<AuthDO>;
	const stub = ns.get(ns.idFromName("global")) as unknown as {
		getOrInitMeta(key: string, fallback: string): Promise<string>;
	};
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const fallback = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
	return stub.getOrInitMeta(UNSUBSCRIBE_SECRET_META_KEY, fallback);
}

/**
 * Origin the unsubscribe URL points at: `APP_URL` when set, else the request
 * origin, else the deployment origin recorded from signed-in requests
 * (`workers/lib/deployment-origin.ts`). Cron sends have no request. `null`
 * when none is known: the caller then sends without a link rather than one
 * pointing at another host.
 */
export async function unsubscribeBaseUrl(env: Env, requestUrl?: string): Promise<string | null> {
	const configured = configuredOrigin(env);
	if (configured) return configured;
	if (requestUrl) {
		try {
			return new URL(requestUrl).origin;
		} catch {
			/* fall through */
		}
	}
	return deploymentOrigin(env);
}

export interface UnsubscribeLink {
	url: string;
	headers: Record<string, string>;
}

/**
 * Mint the signed URL and the RFC 8058 header pair for one recipient.
 *
 * Returns null on any failure. The caller sends without the header rather than
 * not sending: an unsubscribe link is required for bulk mail, but a broken
 * secret lookup is not a reason to drop the mail on the floor. The token is
 * scoped to the sending domain, so unsubscribing from one product's sequence
 * does not silence the others on the same deployment.
 */
export async function buildUnsubscribeLink(
	env: Env,
	args: { recipient: string; fromAddress: string; requestUrl?: string },
): Promise<UnsubscribeLink | null> {
	try {
		const base = await unsubscribeBaseUrl(env, args.requestUrl);
		if (!base) {
			warnNoDeploymentOrigin("bulk mail is going out");
			return null;
		}
		const secret = await getUnsubscribeSecret(env);
		const fromAddress = args.fromAddress.toLowerCase();
		const token = await signUnsubscribeToken(
			{
				address: args.recipient,
				domain: sendingDomainOf(fromAddress),
				mailbox: fromAddress,
			},
			secret,
		);
		const url = `${base}/u/${token}`;
		return {
			url,
			headers: buildListUnsubscribeHeaders({ url, mailto: fromAddress }),
		};
	} catch (e) {
		console.error("Could not build unsubscribe link:", (e as Error).message);
		return null;
	}
}

/**
 * Whether bulk sends get the visible footer as well as the headers. On by
 * default; `UNSUBSCRIBE_FOOTER=off` turns it off for operators who place
 * `{{unsubscribe_url}}` in their templates themselves.
 */
export function unsubscribeFooterEnabled(env: Pick<Env, "UNSUBSCRIBE_FOOTER">): boolean {
	const raw = (env.UNSUBSCRIBE_FOOTER ?? "").trim().toLowerCase();
	return !(raw === "off" || raw === "false" || raw === "0" || raw === "no");
}

// ── Sequence stop rules ────────────────────────────────────────────

/**
 * Cancel every active enrollment for `address`, optionally only those sending
 * from `fromAddress` (stop-on-reply is per mailbox) or from `domain` (an
 * unsubscribe is per sending domain). Returns how many were cancelled.
 */
export async function cancelEnrollmentsFor(
	bucket: R2Bucket,
	address: string,
	filter: { fromAddress?: string; domain?: string } = {},
): Promise<number> {
	const target = address.trim().toLowerCase();
	if (!target) return 0;
	const enrollments = await sequences.listEnrollments(bucket);
	let cancelled = 0;
	for (const enrollment of enrollments) {
		if (enrollment.status !== "active") continue;
		if (enrollment.personEmail.trim().toLowerCase() !== target) continue;
		const from = enrollment.fromAddress.trim().toLowerCase();
		if (filter.fromAddress && from !== filter.fromAddress.trim().toLowerCase()) continue;
		if (filter.domain && sendingDomainOf(from) !== filter.domain.toLowerCase()) continue;
		if (await sequences.cancelEnrollment(bucket, enrollment.id)) cancelled += 1;
	}
	return cancelled;
}

/**
 * Stop-on-reply: an inbound message from someone enrolled in a sequence sent
 * from this mailbox cancels that enrollment.
 *
 * Auto-replies and bounces are not replies. An out-of-office notice must not
 * end someone's onboarding sequence, so mail flagged as automated is ignored
 * (the caller passes `automated` from the same header checks the auto-responder
 * uses).
 */
export async function stopSequencesOnReply(
	env: Env,
	args: { mailboxId: string; sender: string; automated: boolean },
): Promise<number> {
	if (args.automated || !args.sender) return 0;
	try {
		const cancelled = await cancelEnrollmentsFor(env.BUCKET, args.sender, {
			fromAddress: args.mailboxId,
		});
		if (cancelled > 0) {
			console.log(
				`Stopped ${cancelled} sequence enrollment(s) for ${args.sender}: they replied to ${args.mailboxId}.`,
			);
		}
		return cancelled;
	} catch (e) {
		console.error("Stop-on-reply failed:", (e as Error).message);
		return 0;
	}
}

/**
 * Record a hard bounce: global suppression, and stop every sequence still
 * mailing the address.
 */
export async function handleHardBounce(
	env: Env,
	args: { address: string; source: string },
): Promise<void> {
	const address = args.address.trim().toLowerCase();
	if (!address.includes("@")) return;
	await recordSuppression(suppressionStore(env), {
		address,
		scope: GLOBAL_SCOPE,
		reason: "hard_bounce",
		source: args.source,
	});
	try {
		await cancelEnrollmentsFor(env.BUCKET, address);
	} catch (e) {
		console.error(`Could not stop sequences for bounced ${address}:`, (e as Error).message);
	}
}

/**
 * Record a spam complaint: a permanent `complaint` suppression for the sending
 * domain complained about, and every sequence from that domain stopped.
 *
 * Scoped to the domain, as Cloudflare scopes its own complaint suppressions:
 * reporting one product's mail as spam is a verdict on that product. It
 * blocks even transactional mail from the domain (see `pre-send.ts`), because
 * mailing someone who has reported us is what raises the spam rate. Nothing
 * ever expires it; an administrator can delete it by hand.
 */
export async function handleComplaint(
	env: Env,
	args: { address: string; fromAddress: string; source: string },
): Promise<boolean> {
	const address = args.address.trim().toLowerCase();
	if (!address.includes("@")) return false;
	const domain = sendingDomainOf(args.fromAddress);
	const added = await recordSuppression(suppressionStore(env), {
		address,
		scope: domain || GLOBAL_SCOPE,
		reason: "complaint",
		source: args.source,
	});
	// Only when the entry is new (or newly escalated): an existing complaint has
	// already stopped its sequences, and the hourly provider mirror would
	// otherwise re-list every enrollment for every known complainer.
	if (!added) return false;
	try {
		await cancelEnrollmentsFor(env.BUCKET, address, domain ? { domain } : {});
	} catch (e) {
		console.error(`Could not stop sequences for complaining ${address}:`, (e as Error).message);
	}
	return added;
}

/**
 * Whether a header set marks an inbound message as machine-generated, for
 * stop-on-reply. Mirrors the checks in `shared/auto-reply.ts`.
 */
export function isAutomatedInbound(header: (name: string) => string | undefined): boolean {
	const autoSubmitted = header("auto-submitted");
	if (autoSubmitted && autoSubmitted.trim().toLowerCase() !== "no") return true;
	if (header("x-autoreply") || header("x-autorespond") || header("x-autoresponder")) return true;
	const precedence = header("precedence")?.trim().toLowerCase();
	if (precedence && ["bulk", "list", "junk", "auto_reply"].includes(precedence)) return true;
	const returnPath = header("return-path");
	return !!returnPath && returnPath.trim() === "<>";
}

/**
 * React to a send that Email Service refused with `E_RECIPIENT_SUPPRESSED`.
 *
 * The platform keeps its own account-level list and will not deliver to an
 * address on it, so mirroring the entry locally lets the UI warn and the bulk
 * paths skip it instead of failing on every attempt. Only acted on for a
 * single-recipient send: the error does not say which of several recipients
 * was refused, and guessing would suppress a working address.
 *
 * Never throws. Returns whether the error was this one.
 */
export async function noteProviderSuppression(
	env: Env,
	recipients: string[],
	error: unknown,
): Promise<boolean> {
	if (!isRecipientSuppressedError(error)) return false;
	const unique = [...new Set(recipients.map((r) => r.trim().toLowerCase()).filter(Boolean))];
	if (unique.length === 1) {
		await handleHardBounce(env, { address: unique[0], source: "provider:E_RECIPIENT_SUPPRESSED" });
	}
	return true;
}

