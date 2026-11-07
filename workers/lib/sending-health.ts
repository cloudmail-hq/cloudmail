// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The spam-rate circuit breaker, Worker side: gather 7-day complaint and
 * delivery counts per sending domain, evaluate them (`shared/sending-health.ts`),
 * store the result in the AuthDO, and notify on a rising level.
 *
 * ## Where the counts come from
 *
 * - **Local**: each mailbox's delivery ledger (`getSendingAnalytics`), which
 *   holds the reconciler's `delivered` verdicts and every `complained` event
 *   (reconciler, feedback-loop report). Always available.
 * - **Cloudflare**: `emailSendingAdaptiveGroups` (delivered) and
 *   `emailComplaintsAdaptiveGroups` per `sendingDomain`, plus the account
 *   reputation status over REST, when `CF_ANALYTICS_TOKEN` is set. These cover
 *   every sender on the zone, which is what mailbox providers judge.
 *
 * Per domain, the worse of the two evaluations wins, so a domain whose own app
 * mail is clean but whose other senders are not still gets the warning.
 *
 * Runs on the five-minute cron, at most once an hour (an AuthDO meta key holds
 * the last run), and on demand from `POST /api/v1/sending-health/evaluate`.
 */

import {
	SPAM_RATE_WINDOW_DAYS,
	evaluateSpamRate,
	formatRate,
	levelRank,
	type HealthNotification,
	type SendingDomainHealth,
	type SpamRateEvaluation,
} from "../../shared/sending-health";
import { sendingDomainOf } from "../../shared/suppressions";
import type { AuthDO } from "../auth/store";
import type { Env } from "../types";
import { analyticsAccountId, analyticsClient, analyticsZoneTags, type CfAnalyticsClient } from "./cf-analytics";
import { sendingBucket, weight } from "./analytics-aggregate";
import { listMailboxes } from "./email-helpers";
import { webhookStub } from "./webhooks";
import type { EnqueueInput } from "./webhooks-store";
import { loadStoredDomains } from "../routes/domains";
import { handleComplaint } from "./suppressions";

/** The AuthDO surface the breaker uses. */
export interface BulkPauseApi {
	isBulkPaused(domain: string): Promise<{ paused: boolean; reason: string | null }>;
}

export interface SendingHealthApi extends BulkPauseApi {
	listSendingHealth(): Promise<SendingDomainHealth[]>;
	recordSendingHealth(
		domain: string,
		evaluation: SpamRateEvaluation & { source: string; providerStatus?: string | null },
		now: number,
	): Promise<{ health: SendingDomainHealth; notify: HealthNotification }>;
	resumeBulkSending(domain: string, by: string | null, now: number): Promise<SendingDomainHealth | null>;
	pauseBulkSending(domain: string, reason: string, now: number): Promise<SendingDomainHealth>;
	claimSendingHealthRun(now: number, intervalMs: number): Promise<boolean>;
}

/** The AuthDO stub typed to the breaker surface, or null without the binding. */
export function sendingHealthStore(env: Env): SendingHealthApi | null {
	const ns = (env as { AUTH_STORE?: unknown }).AUTH_STORE as DurableObjectNamespace<AuthDO> | undefined;
	if (!ns) return null;
	return ns.get(ns.idFromName("global")) as unknown as SendingHealthApi;
}

export function bulkPauseStore(env: Env): BulkPauseApi | null {
	return sendingHealthStore(env);
}

// ── Counting ────────────────────────────────────────────────────────

export interface DomainCounts {
	delivered: number;
	complaints: number;
}

interface SendingStatsStub {
	getSendingAnalytics(window: { start: string; end: string }): Promise<{ delivered: number; complaints: number }>;
}

/** Local ledger counts per sending domain over the window. */
export async function localDomainCounts(
	env: Env,
	window: { start: string; end: string },
	mailboxes?: string[],
): Promise<Map<string, DomainCounts>> {
	const ids = mailboxes ?? (await listMailboxes(env.BUCKET)).map((m) => m.email);
	const out = new Map<string, DomainCounts>();
	await Promise.all(
		ids.map(async (mailbox) => {
			try {
				const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailbox)) as unknown as SendingStatsStub;
				const stats = await stub.getSendingAnalytics(window);
				const domain = sendingDomainOf(mailbox);
				if (!domain) return;
				const cur = out.get(domain) ?? { delivered: 0, complaints: 0 };
				cur.delivered += stats.delivered;
				cur.complaints += stats.complaints;
				out.set(domain, cur);
			} catch (e) {
				console.error(`sending health: stats for ${mailbox} failed:`, (e as Error).message);
			}
		}),
	);
	return out;
}

const PROVIDER_QUERY = `
query SendingHealth($zones: [string!], $start: Time!, $end: Time!) {
  viewer {
    zones(filter: { zoneTag_in: $zones }) {
      sending: emailSendingAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end }) {
        count
        dimensions { status sendingDomain sampleInterval }
      }
      complaints: emailComplaintsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end, isEmailSending: 1 }) {
        count
        dimensions { sendingDomain }
      }
    }
  }
}`.trim();

/** Cloudflare's counts per sending domain, and the account status. Null when unavailable. */
export async function providerDomainCounts(
	client: CfAnalyticsClient,
	zones: string[],
	window: { start: string; end: string },
	accountId: string | null,
): Promise<{ counts: Map<string, DomainCounts>; status: string | null } | null> {
	if (!client.hasGraphql || zones.length === 0) return null;
	const data = await client.graphql<{
		viewer: {
			zones: {
				sending: { count: number; dimensions: { status: string; sendingDomain: string; sampleInterval: number } }[] | null;
				complaints: { count: number; dimensions: { sendingDomain: string } }[] | null;
			}[];
		};
	}>(PROVIDER_QUERY, { zones: zones.slice(0, 10), start: window.start, end: window.end });
	const counts = new Map<string, DomainCounts>();
	const slot = (d: string) => {
		const key = (d || "").toLowerCase();
		let cur = counts.get(key);
		if (!cur) counts.set(key, (cur = { delivered: 0, complaints: 0 }));
		return cur;
	};
	for (const zone of data.viewer.zones) {
		for (const g of zone.sending ?? []) {
			if (sendingBucket(g.dimensions.status) === "delivered") {
				slot(g.dimensions.sendingDomain).delivered += weight(g.count, g.dimensions.sampleInterval);
			}
		}
		for (const g of zone.complaints ?? []) slot(g.dimensions.sendingDomain).complaints += g.count;
	}
	counts.delete("");

	let status: string | null = null;
	if (client.hasRest && accountId) {
		try {
			status = (await client.reputation(accountId)).status ?? null;
		} catch (e) {
			console.error("sending health: reputation read failed:", (e as Error).message);
		}
	}
	return { counts, status };
}

/**
 * Evaluate one domain from both sources and keep the worse. A Cloudflare
 * sending domain may be a subdomain (`mail.example.com`) of the mailbox
 * domain; those are matched exactly, since the breaker is per From domain.
 */
export function combineEvaluations(
	local: DomainCounts | undefined,
	provider: DomainCounts | undefined,
	providerStatus: string | null,
): SpamRateEvaluation & { source: string; providerStatus: string | null } {
	const a = local ? evaluateSpamRate({ ...local, providerStatus }) : null;
	const b = provider ? evaluateSpamRate({ ...provider, providerStatus }) : null;
	if (a && b) {
		const worse = levelRank(b.level) > levelRank(a.level) || (levelRank(b.level) === levelRank(a.level) && (b.rate ?? 0) > (a.rate ?? 0)) ? b : a;
		return { ...worse, source: "local+cloudflare", providerStatus };
	}
	const only = a ?? b ?? evaluateSpamRate({ complaints: 0, delivered: 0, providerStatus });
	return { ...only, source: b ? "cloudflare" : "local", providerStatus };
}

// ── Notifying ───────────────────────────────────────────────────────

export interface DeliverabilityWarningPayload {
	id: string;
	type: "deliverability.warning";
	created_at: string;
	mailbox: string;
	data: {
		domain: string;
		level: SendingDomainHealth["level"];
		spam_rate: number | null;
		complaints: number;
		delivered: number;
		window_days: number;
		bulk_paused: boolean;
		reason: string;
		source: string | null;
	};
}

export function buildDeliverabilityPayload(
	health: SendingDomainHealth,
	mailbox: string,
	eventId: string,
	now: number,
): DeliverabilityWarningPayload {
	return {
		id: eventId,
		type: "deliverability.warning",
		created_at: new Date(now).toISOString(),
		mailbox,
		data: {
			domain: health.domain,
			level: health.level,
			spam_rate: health.spam_rate,
			complaints: health.complaints,
			delivered: health.delivered,
			window_days: SPAM_RATE_WINDOW_DAYS,
			bulk_paused: health.bulk_paused,
			reason: health.bulk_paused
				? health.paused_reason ?? "Bulk sending paused"
				: `Spam complaint rate ${formatRate(health.spam_rate)} over ${SPAM_RATE_WINDOW_DAYS} days`,
			source: health.source,
		},
	};
}

/**
 * Enqueue `deliverability.warning` for every mailbox on the domain. One event
 * id for all of them: the webhook store skips an event already queued for an
 * endpoint, so an all-mailbox endpoint gets it once.
 */
export async function notifyDeliverability(
	env: Env,
	health: SendingDomainHealth,
	mailboxes: string[],
	now: number,
): Promise<number> {
	const hooks = webhookStub(env);
	if (!hooks) return 0;
	const onDomain = mailboxes.filter((m) => sendingDomainOf(m) === health.domain);
	if (onDomain.length === 0) return 0;
	const eventId = `evt_deliv_${health.domain}_${health.level}_${health.bulk_paused ? "paused" : "warn"}_${now}`;
	const events: EnqueueInput[] = onDomain.map((mailbox) => ({
		eventId,
		type: "deliverability.warning",
		mailbox,
		payload: JSON.stringify(buildDeliverabilityPayload(health, mailbox, eventId, now)),
		now,
	}));
	const { queued } = await hooks.enqueue(events);
	return queued;
}

// ── The run ─────────────────────────────────────────────────────────

/** The cron runs every 5 minutes; evaluating hourly is plenty for a 7-day rate. */
export const EVALUATE_INTERVAL_MS = 60 * 60 * 1000;

export interface EvaluateResult {
	evaluated: number;
	notified: number;
	paused: string[];
	domains: SendingDomainHealth[];
	provider: "used" | "unavailable" | "error";
}

export interface EvaluateDeps {
	store?: SendingHealthApi | null;
	client?: CfAnalyticsClient | null;
	now?: number;
	mailboxes?: string[];
	local?: Map<string, DomainCounts>;
}

/** Evaluate every sending domain once and apply the results. */
export async function evaluateSendingHealth(env: Env, deps: EvaluateDeps = {}): Promise<EvaluateResult> {
	const now = deps.now ?? Date.now();
	const store = deps.store === undefined ? sendingHealthStore(env) : deps.store;
	if (!store) return { evaluated: 0, notified: 0, paused: [], domains: [], provider: "unavailable" };

	const window = {
		start: new Date(now - SPAM_RATE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString(),
		end: new Date(now).toISOString(),
	};
	const mailboxes = deps.mailboxes ?? (await listMailboxes(env.BUCKET)).map((m) => m.email);
	const local = deps.local ?? (await localDomainCounts(env, window, mailboxes));

	let provider: Awaited<ReturnType<typeof providerDomainCounts>> = null;
	let providerState: EvaluateResult["provider"] = "unavailable";
	const client = deps.client === undefined ? await analyticsClient(env) : deps.client;
	if (client) {
		try {
			await loadStoredDomains(env).catch(() => {});
			const zones = analyticsZoneTags(env);
			const accountId = (await analyticsAccountId(env)) || (zones[0] && client.hasRest ? await client.accountIdFor(zones[0]).catch(() => null) : null);
			provider = await providerDomainCounts(client, zones, window, accountId);
			providerState = provider ? "used" : "unavailable";
		} catch (e) {
			providerState = "error";
			console.error("sending health: Cloudflare counts failed; using local only:", (e as Error).message);
		}
	}

	// Only domains this deployment sends from: mailbox domains.
	const domains = [...new Set(mailboxes.map(sendingDomainOf).filter(Boolean))].sort();
	const result: EvaluateResult = { evaluated: 0, notified: 0, paused: [], domains: [], provider: providerState };
	for (const domain of domains) {
		const evaluation = combineEvaluations(local.get(domain), provider?.counts.get(domain), provider?.status ?? null);
		const { health, notify } = await store.recordSendingHealth(domain, evaluation, now);
		result.evaluated += 1;
		result.domains.push(health);
		if (notify === "paused") result.paused.push(domain);
		if (notify) {
			try {
				result.notified += await notifyDeliverability(env, health, mailboxes, now);
			} catch (e) {
				console.error(`sending health: webhook for ${domain} failed:`, (e as Error).message);
			}
			console.warn(
				`sending health: ${domain} is ${health.level} (${formatRate(health.spam_rate)} on ${health.delivered} delivered)` +
					(health.bulk_paused ? "; bulk sends paused" : ""),
			);
		}
	}
	return result;
}

/**
 * Copy Cloudflare's `complaint` suppressions (validated feedback-loop reports,
 * never expiring) into the local list as `complaint` entries.
 *
 * `emailComplaintsAdaptiveGroups` only has counts; this list is where
 * Cloudflare records WHO complained. A `sending_domain` scope maps to that
 * domain, an `account` scope to global. Idempotent: repeats are ignored, and a
 * local `unsubscribed` entry for the same scope is escalated to `complaint`.
 * Needs a REST analytics token (`CF_ANALYTICS_TOKEN` or the Cloudflare
 * connection); a no-op without one.
 */
export async function mirrorProviderComplaints(
	env: Env,
	deps: { client?: CfAnalyticsClient | null; accountId?: string | null } = {},
): Promise<number> {
	const client = deps.client === undefined ? await analyticsClient(env) : deps.client;
	if (!client?.hasRest) return 0;
	let accountId = deps.accountId ?? (await analyticsAccountId(env));
	if (!accountId) {
		const zone = analyticsZoneTags(env)[0];
		if (!zone) return 0;
		accountId = await client.accountIdFor(zone);
	}
	const entries = (await client.suppressions(accountId)).filter((s) => s.reason === "complaint");
	let added = 0;
	for (const entry of entries) {
		const domain = entry.scope?.type === "sending_domain" ? entry.scope.value?.toLowerCase() : null;
		// `handleComplaint` scopes by the From domain; a synthetic From on the
		// scope domain gives exactly that scope, and global for account scope.
		const ok = await handleComplaint(env, {
			address: entry.email,
			fromAddress: domain ? `postmaster@${domain}` : "",
			source: "provider-suppression:complaint",
		});
		if (ok) added += 1;
	}
	return added;
}

/** The cron entry: at most once per {@link EVALUATE_INTERVAL_MS}. */
export async function maybeEvaluateSendingHealth(env: Env, now = Date.now()): Promise<EvaluateResult | null> {
	const store = sendingHealthStore(env);
	if (!store) return null;
	if (!(await store.claimSendingHealthRun(now, EVALUATE_INTERVAL_MS))) return null;
	return evaluateSendingHealth(env, { store, now });
}
