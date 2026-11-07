// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Idempotent Cloudflare provisioning for one domain.
 *
 * Each step reads the current state first and only writes when something is
 * missing, so pressing "Provision" twice is harmless. Steps run in order and
 * a failure stops the steps that depend on it but is reported, not thrown:
 * the caller gets a per-step list and persists whatever was learned.
 *
 *   zone        find the zone (or trust the stored zone id)
 *   routing     enable Email Routing DNS when it is not ready
 *   catch_all   point the catch-all at this Worker. An existing catch-all to
 *               somewhere else is left alone unless `overwriteCatchAll`.
 *   sending     find or create the Email Sending subdomain for the hostname
 *   sending_dns read the records Email Sending expects (DKIM selector/value)
 *
 * Nothing is rolled back: every step is additive and safe to leave in place.
 */

import {
	CloudflareApiError,
	type CloudflareClient,
	type CfDnsRecord,
	type CfRoutingRule,
	type CfSendingSubdomain,
} from "./cloudflare-api";
import type { DkimInfo, DnsRecordSpec, DomainPatch, DomainStatus } from "./domain-store";

export type ProvisionStepName = "zone" | "routing" | "catch_all" | "sending" | "sending_dns";
export type ProvisionStepStatus = "ok" | "skipped" | "warn" | "error";

export interface ProvisionStep {
	step: ProvisionStepName;
	status: ProvisionStepStatus;
	detail: string;
}

export interface ProvisionResult {
	ok: boolean;
	ranAt: number;
	steps: ProvisionStep[];
}

export interface ProvisionOutcome {
	result: ProvisionResult;
	/** What to write back to the domain row. */
	patch: DomainPatch;
	/** The catch-all rule that was replaced, when this run overwrote one (for the change log). */
	previousCatchAll?: CfRoutingRule | null;
	/** The catch-all rule this run wrote, if any. */
	newCatchAll?: CfRoutingRule;
}

export interface ProvisionOptions {
	overwriteCatchAll?: boolean;
	now?: number;
	/**
	 * Run only these steps (others are reported "skipped"). Onboarding apply
	 * uses it to run one step per plan item after the planner has already
	 * decided the MX/SPF question (`./setup-plan.ts`). Default: every step.
	 */
	only?: ProvisionStepName[];
}

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function toSpec(record: CfDnsRecord): DnsRecordSpec | null {
	const type = record.type?.toUpperCase();
	if (type !== "MX" && type !== "TXT" && type !== "CNAME") return null;
	return {
		purpose: /_dmarc\./i.test(record.name) ? "dmarc" : "sending",
		type,
		name: record.name,
		value: record.content,
		...(typeof record.priority === "number" ? { priority: record.priority } : {}),
	};
}

/** DKIM selector, name and value from a sending subdomain and its records. */
export function dkimFromSending(
	hostname: string,
	subdomain: CfSendingSubdomain | null,
	records: CfDnsRecord[],
): DkimInfo | null {
	const dkimRecord = records.find((r) => r.type?.toUpperCase() === "TXT" && /_domainkey/i.test(r.name));
	const selector =
		subdomain?.dkim_selector ||
		(dkimRecord ? dkimRecord.name.split("._domainkey")[0] : undefined);
	if (!selector) return null;
	return {
		selector,
		name: dkimRecord?.name || `${selector}._domainkey.${hostname}`,
		value: dkimRecord?.content ?? null,
	};
}

/** One sentence describing an existing catch-all rule. */
export function describeCatchAll(rule: CfRoutingRule): string {
	const target = (rule.actions ?? [])
		.map((a) => `${a.type}${a.value?.length ? ` ${a.value.join(", ")}` : ""}`)
		.join("; ") || "nothing";
	return rule.enabled ? `Catch-all is enabled and goes to ${target}.` : `Catch-all is disabled (${target}), so unknown addresses bounce.`;
}

/** Pick the sending subdomain for `hostname` out of a zone's list. */
export function findSendingSubdomain(list: CfSendingSubdomain[], hostname: string): CfSendingSubdomain | null {
	const host = hostname.toLowerCase();
	return list.find((s) => s.name?.toLowerCase() === host) ?? null;
}

/** Status a domain row should carry after provisioning. */
export function statusAfterProvision(steps: ProvisionStep[]): DomainStatus {
	if (steps.some((s) => s.status === "error")) return "error";
	if (steps.every((s) => s.status === "ok")) return "active";
	return "pending";
}

export async function provisionDomain(
	client: CloudflareClient,
	domain: { hostname: string; zoneId: string | null; sendingSubdomainId: string | null },
	options: ProvisionOptions = {},
): Promise<ProvisionOutcome> {
	const hostname = domain.hostname.toLowerCase();
	const steps: ProvisionStep[] = [];
	const patch: DomainPatch = {};
	const want = (step: ProvisionStepName) => !options.only || options.only.includes(step);
	let previousCatchAll: CfRoutingRule | null | undefined;
	let newCatchAll: CfRoutingRule | undefined;
	const push = (step: ProvisionStepName, status: ProvisionStepStatus, detail: string) =>
		steps.push({ step, status, detail });

	// -- zone
	let zoneId = domain.zoneId;
	let zoneName = hostname;
	try {
		if (zoneId) {
			push("zone", "ok", `Using zone ${zoneId}.`);
		} else {
			const zone = await client.findZone(hostname);
			if (!zone) {
				push("zone", "error", `No Cloudflare zone for ${hostname} is visible to this token. Add the domain to Cloudflare, or grant the token Zone Read on it.`);
			} else {
				zoneId = zone.id;
				zoneName = zone.name;
				patch.zoneId = zone.id;
				push("zone", "ok", `Found zone ${zone.name} (${zone.id}).`);
			}
		}
	} catch (e) {
		push("zone", "error", message(e));
	}

	if (!zoneId) {
		for (const s of ["routing", "catch_all", "sending", "sending_dns"] as const) {
			push(s, "skipped", "Needs the zone.");
		}
		return finish();
	}
	const isApex = hostname === zoneName.toLowerCase();

	// -- routing
	let routingReady = false;
	if (!want("routing")) push("routing", "skipped", "Not requested.");
	else try {
		const settings = await client.getRoutingSettings(zoneId).catch((e) => {
			// A zone that never enabled routing may 404 here; treat as unconfigured.
			if (e instanceof CloudflareApiError && e.status === 404) return { status: "unconfigured", enabled: false };
			throw e;
		});
		if (settings.enabled && settings.status === "ready") {
			routingReady = true;
			patch.routingStatus = "ready";
			push("routing", "ok", "Email Routing is already enabled and ready.");
		} else {
			const enabled = await client.enableRoutingDns(zoneId, isApex ? undefined : hostname);
			const status = enabled?.status ?? "ready";
			patch.routingStatus = status;
			routingReady = status === "ready";
			push(
				"routing",
				routingReady ? "ok" : "warn",
				routingReady
					? "Enabled Email Routing and added its DNS records."
					: `Enabled Email Routing; Cloudflare reports "${status}". Existing MX records for another provider may need removing.`,
			);
		}
	} catch (e) {
		patch.routingStatus = "misconfigured";
		push("routing", "error", message(e));
	}

	// -- catch-all
	if (!want("catch_all")) {
		push("catch_all", "skipped", "Not requested.");
	} else if (!isApex) {
		push("catch_all", "warn", `Catch-all rules only apply to the zone apex (${zoneName}). Add literal routing rules for ${hostname} addresses in the dashboard.`);
	} else {
		try {
			const current = await client.getCatchAll(zoneId);
			if (client.isRuleToWorker(current)) {
				push("catch_all", "ok", `Catch-all already delivers to ${client.workerScriptName}.`);
			} else if (current && !options.overwriteCatchAll) {
				/**
				 * Any existing rule is left alone without explicit consent, including
				 * a disabled one or a drop. Those are a choice too: with the catch-all
				 * off, Cloudflare rejects mail to unknown addresses so the sender gets
				 * a bounce. Switching it on routes every unknown address into this
				 * Worker, which drops what has no mailbox, alias or catch-all mailbox.
				 */
				push("catch_all", "warn", `${describeCatchAll(current)} Left unchanged. Provision again with "overwrite catch-all" to send every unknown address on ${hostname} to ${client.workerScriptName}; set a catch-all mailbox first or that mail is dropped instead of bounced.`);
			} else {
				previousCatchAll = current;
				newCatchAll = await client.putCatchAllToWorker(zoneId);
				push("catch_all", "ok", `Catch-all now delivers to ${client.workerScriptName}.`);
			}
		} catch (e) {
			push("catch_all", "error", message(e));
		}
	}

	// -- sending
	let subdomain: CfSendingSubdomain | null = null;
	if (!want("sending")) push("sending", "skipped", "Not requested.");
	else try {
		if (domain.sendingSubdomainId) {
			subdomain = await client.getSendingSubdomain(zoneId, domain.sendingSubdomainId).catch((e) => {
				if (e instanceof CloudflareApiError && e.status === 404) return null;
				throw e;
			});
		}
		if (!subdomain) subdomain = findSendingSubdomain(await client.listSendingSubdomains(zoneId), hostname);
		if (subdomain) {
			push("sending", "ok", `Sending domain ${subdomain.name} already exists.`);
		} else {
			subdomain = await client.createSendingSubdomain(zoneId, hostname);
			push("sending", "ok", `Created sending domain ${subdomain.name}.`);
		}
		patch.sendingSubdomainId = subdomain.tag;
		patch.sendingStatus = subdomain.enabled === false ? "disabled" : "enabled";
	} catch (e) {
		patch.sendingStatus = "missing";
		const hint =
			e instanceof CloudflareApiError && e.errors.some((x) => x.code === 2036)
				? " Cloudflare refuses while another provider's MX records are on this hostname."
				: "";
		push("sending", "error", message(e) + hint);
	}

	// -- sending dns
	if (!want("sending_dns")) {
		push("sending_dns", "skipped", "Not requested.");
	} else if (!subdomain) {
		push("sending_dns", "skipped", "Needs the sending domain.");
	} else {
		try {
			const records = await client.getSendingSubdomainDns(zoneId, subdomain.tag);
			patch.sendingDns = records.map(toSpec).filter((r): r is DnsRecordSpec => !!r);
			patch.dkim = dkimFromSending(hostname, subdomain, records);
			push("sending_dns", "ok", `Cloudflare expects ${records.length} sending record(s).`);
		} catch (e) {
			patch.dkim = dkimFromSending(hostname, subdomain, []);
			push("sending_dns", "warn", message(e));
		}
	}

	return finish();

	function finish(): ProvisionOutcome {
		const ranAt = options.now ?? Date.now();
		const result: ProvisionResult = { ok: !steps.some((s) => s.status === "error"), ranAt, steps };
		const firstError = steps.find((s) => s.status === "error");
		patch.status = statusAfterProvision(steps);
		patch.lastError = firstError ? `${firstError.step}: ${firstError.detail}` : null;
		patch.lastProvision = result;
		return {
			result,
			patch,
			...(previousCatchAll !== undefined ? { previousCatchAll } : {}),
			...(newCatchAll ? { newCatchAll } : {}),
		};
	}
}
