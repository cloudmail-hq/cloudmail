// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * MCP admin tools over managed domains: `list_domains` and
 * `get_domain_status`. Read-only. The admin gate lives here, not only at
 * registration, so a principal that is not an administrator gets a refusal
 * whatever path reaches it.
 */

import { isAdminFor, type Principal } from "./authz";
import { getEnvZones } from "./zones";
import { domainRpc, loadStoredDomains } from "../routes/domains";
import { expectedRecords } from "./dns-audit";
import type { Env } from "../types";
import { resolveCloudflareToken } from "./cf-connection";

export const ADMIN_REQUIRED = "Not permitted: domain tools are for administrators only. Do not retry.";

export async function toolListDomains(env: Env, principal: Principal) {
	if (!isAdminFor(principal, "domains:manage")) return { error: ADMIN_REQUIRED };
	await loadStoredDomains(env);
	const envHosts = new Set(getEnvZones(env).map((z) => z.domain));
	const rows = await domainRpc(env).listDomains();
	return {
		domains: rows.map((d) => ({
			id: d.id,
			hostname: d.hostname,
			displayName: d.displayName,
			status: d.status,
			routingStatus: d.routingStatus,
			sendingStatus: d.sendingStatus,
			catchAllMailbox: d.catchAllMailbox,
			source: envHosts.has(d.hostname) ? "env" : "api",
			lastCheckedAt: d.lastCheckedAt,
		})),
		cloudflareConfigured: (await resolveCloudflareToken(env)) !== null,
	};
}

export async function toolGetDomainStatus(env: Env, principal: Principal, domain: string) {
	if (!isAdminFor(principal, "domains:manage")) return { error: ADMIN_REQUIRED };
	await loadStoredDomains(env);
	const d = await domainRpc(env).getDomain(domain);
	if (!d) return { error: `Domain "${domain}" not found. Use list_domains to see managed domains.` };
	return {
		id: d.id,
		hostname: d.hostname,
		displayName: d.displayName,
		status: d.status,
		routingStatus: d.routingStatus,
		sendingStatus: d.sendingStatus,
		zoneId: d.zoneId,
		dkim: d.dkim,
		catchAllMailbox: d.catchAllMailbox,
		lastError: d.lastError,
		lastCheckedAt: d.lastCheckedAt,
		// The cached audit; an admin re-runs it with POST /api/v1/domains/:id/verify.
		audit: d.lastAudit,
		provision: d.lastProvision,
		records: expectedRecords(d.hostname, { sendingDkimSelector: d.dkim?.selector, sendingDns: d.sendingDns }),
	};
}
