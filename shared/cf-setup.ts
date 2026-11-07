// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Cloudflare discovery, setup plan and apply: the shapes the worker
 * (`workers/routes/cloudflare-setup.ts`) returns and the onboarding UI reads.
 *
 *   GET  /api/v1/cloudflare/discover         → CfDiscovery
 *   POST /api/v1/cloudflare/plan             → CfPlanResponse
 *   POST /api/v1/cloudflare/apply            → CfApplyResponse
 *   GET  /api/v1/cloudflare/changes          → { changes: CfDnsChange[] }
 *   POST /api/v1/cloudflare/changes/:id/revert → { change: CfDnsChange }
 */

import type { CfCapabilityName } from "./cf-connection";

/**
 * One DNS record (or, with type `CATCH_ALL`, the zone's catch-all rule) as
 * the plan shows it. `id` is Cloudflare's record id when the record exists.
 */
export interface DnsRecordLite {
	id?: string;
	type: string;
	name: string;
	content: string;
	priority?: number;
	ttl?: number;
}

export type MxProvider = "cloudflare" | "google" | "microsoft" | "zoho" | "other" | "none";

export interface CfRoutingRuleLite {
	enabled: boolean;
	matchers: { type: string; field?: string; value?: string }[];
	actions: { type: string; value?: string[] }[];
	name?: string;
}

export interface CfSendingLite {
	tag: string;
	name: string;
	enabled: boolean;
}

/**
 * What discovery found on one zone. `detail`:
 *   - `list`: only the zone listing (past the summary cap; nothing else read).
 *   - `summary`: plus one read of the apex records (MX, SPF), for the zone list.
 *   - `full`: everything below (chosen zones, plan and apply).
 */
export interface ZoneDiscovery {
	zoneId: string;
	name: string;
	status: string;
	plan?: string;
	nameServers?: string[];
	/** Already a stored or env domain in this app. */
	managed: boolean;
	/** From DOMAINS/ZONES: live in production, so every change needs a confirm. */
	envDomain: boolean;
	detail: "list" | "summary" | "full";
	routing: { enabled: boolean; status: string } | null;
	catchAll: CfRoutingRuleLite | null;
	catchAllToUs: boolean;
	sending: CfSendingLite[];
	/** Set when listing sending subdomains failed because of the account's plan. */
	sendingPlanError?: string;
	/** Listing sending subdomains failed for another reason. */
	sendingError?: string;
	dns: {
		mx: DnsRecordLite[];
		/** TXT `v=spf1` at the apex. */
		spf: DnsRecordLite[];
		/** TXT `v=DMARC1` at `_dmarc`. */
		dmarc: DnsRecordLite[];
		/** TXT at `_smtp._tls`. */
		tlsRpt: DnsRecordLite[];
		/** TXT at `_mta-sts`. */
		mtaSts: DnsRecordLite[];
	};
	mxProvider: MxProvider;
	/**
	 * DNS lookups the single apex SPF record needs, includes followed
	 * recursively (RFC 7208 §4.6.4). Null when there is not exactly one SPF
	 * record or an include could not be resolved.
	 */
	spfLookups: number | null;
	/** Capabilities a call on this zone was refused for (403). */
	denied: CfCapabilityName[];
	/** Something could not be read; the zone gets a manual item. */
	error?: string;
}

export interface WorkerDiscovery {
	/** The name the catch-all targets today (`WORKER_SCRIPT_NAME` env → stored → default). */
	configured: string;
	source: "env" | "connection" | "default";
	/** Whether `configured` is a script on the account; null when scripts could not be listed. */
	found: boolean | null;
	/** Scripts with a `MailboxDO` Durable Object binding, when `configured` was not found. */
	mailboxScripts: string[] | null;
	/** Whether a detected name can be saved (only on a stored connection, not with `CF_API_TOKEN`). */
	canPersist: boolean;
}

export interface VectorizeDiscovery {
	indexName: string;
	index: "present" | "missing" | "unknown";
	metadataIndex: "present" | "missing" | "unknown";
}

export interface CfDiscovery {
	accountId: string | null;
	tokenSource: "env" | "connection";
	zones: ZoneDiscovery[];
	/** Zones the token sees in total (may exceed `zones.length` when capped). */
	zoneCount: number;
	truncated: boolean;
	worker: WorkerDiscovery;
	vectorize: VectorizeDiscovery;
	/** Capabilities the stored connection's probe marked missing. */
	missingCapabilities: CfCapabilityName[];
	/** Account-level read failures (zone list, scripts), never fatal. */
	errors: string[];
	discoveredAt: number;
}

export const PLAN_ITEM_KINDS = [
	"add_domain",
	"enable_routing",
	"catch_all",
	"sending_domain",
	"dmarc_create",
	"dmarc_tighten",
	"spf_merge",
	"mx_replace",
	"vectorize_metadata_index",
	"worker_name",
	"zone_pending",
	"zone_error",
	"plan_upgrade",
	"mta_sts",
	"tls_rpt",
	"dmarc_reports",
	"token_permission",
] as const;

export type PlanItemKind = (typeof PLAN_ITEM_KINDS)[number];
export type PlanTier = "auto" | "confirm" | "manual" | "done";

export interface PlanItem {
	/** Stable: `${zoneId}:${kind}`, `account:${kind}` or `account:token_permission:${capability}`. */
	id: string;
	zoneId: string | null;
	hostname: string | null;
	kind: PlanItemKind;
	tier: PlanTier;
	/** Plain sentence. */
	title: string;
	/** Why, and what happens. */
	detail: string;
	/** Exact current records this touches. */
	before?: DnsRecordLite[];
	/** Exact records after. */
	after?: DnsRecordLite[];
	/** For tier manual: exact dashboard steps. */
	manualSteps?: string[];
	/** Item ids that must be applied (or already done) first. */
	dependsOn?: string[];
}

export interface CfPlanResponse {
	items: PlanItem[];
	/** Send back with apply; a mismatch means the state changed (409 plan_stale). */
	planHash: string;
	zones: ZoneDiscovery[];
	worker: WorkerDiscovery;
	vectorize: VectorizeDiscovery;
}

export type ApplyItemStatus = "ok" | "skipped" | "error";

export interface ApplyItemResult {
	id: string;
	status: ApplyItemStatus;
	detail: string;
	/** dns_change_log ids written by this item. */
	changeIds?: string[];
}

export interface CfApplyResponse {
	ok: boolean;
	results: ApplyItemResult[];
}

export interface CfDnsChange {
	id: string;
	zoneId: string;
	zoneName: string | null;
	/** DNS type (MX, TXT…) or `catch_all`. */
	recordType: string;
	name: string;
	action: "create" | "update" | "delete";
	before: unknown | null;
	after: unknown | null;
	planItem: string | null;
	appliedAt: number;
	appliedBy: string | null;
	revertedAt: number | null;
	revertedBy: string | null;
}
