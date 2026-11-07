// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Pure presentation rules behind the Cloudflare onboarding wizard. */

import type { ApplyItemResult, CfPlanResponse, PlanItem, PlanTier, ZoneDiscovery } from "../../../shared/cf-setup";

export const ONBOARDING_DISMISS_KEY = "tapetide:onboarding-dismissed";

export function zoneStatusLine(zone: ZoneDiscovery): string {
	if (zone.status !== "active") return "Nameservers not switched yet";
	if (zone.managed && zone.routing?.status === "ready" && zone.catchAllToUs) return "Already set up";
	if (zone.error) return "Some settings couldn't be checked";
	switch (zone.mxProvider) {
		case "google": return "Gmail handles mail here today";
		case "microsoft": return "Microsoft handles mail here today";
		case "zoho": return "Zoho handles mail here today";
		case "other": return "Another provider handles mail here today";
		case "cloudflare": return zone.catchAllToUs ? "Already set up" : "Cloudflare Email Routing is on";
		default: return "Ready for mail";
	}
}

export function groupPlanByTier(items: readonly PlanItem[]): Record<PlanTier, PlanItem[]> {
	return {
		auto: items.filter((item) => item.tier === "auto"),
		confirm: items.filter((item) => item.tier === "confirm"),
		manual: items.filter((item) => item.tier === "manual"),
		done: items.filter((item) => item.tier === "done"),
	};
}

export function applyCount(items: readonly PlanItem[], confirmed: ReadonlySet<string>): number {
	return items.filter((item) => item.tier === "auto" || (item.tier === "confirm" && confirmed.has(item.id))).length;
}

export function applySelection(items: readonly PlanItem[], confirmed: ReadonlySet<string>): { id: string; confirm?: true }[] {
	return items.flatMap((item) => {
		if (item.tier === "auto") return [{ id: item.id }];
		if (item.tier === "confirm" && confirmed.has(item.id)) return [{ id: item.id, confirm: true as const }];
		return [];
	});
}

/**
 * What to send when retrying one failed item against a fresh plan, or null
 * when the admin has to review it again. A confirm item is only re-confirmed
 * if the admin confirmed it before and the records it touches are the ones
 * they saw: an item that was auto (or showed other records) when they
 * approved the plan has not been approved in its new form.
 */
export function retrySelection(
	previous: PlanItem | undefined,
	fresh: PlanItem,
	confirmed: ReadonlySet<string>,
): { id: string; confirm?: true } | null {
	if (fresh.tier === "auto") return { id: fresh.id };
	if (fresh.tier !== "confirm") return null;
	if (!previous || previous.tier !== "confirm" || !confirmed.has(fresh.id)) return null;
	const same = JSON.stringify(previous.before ?? []) === JSON.stringify(fresh.before ?? []);
	return same ? { id: fresh.id, confirm: true } : null;
}

export function groupPlanByDomain(items: readonly PlanItem[], selectedZones: readonly ZoneDiscovery[]) {
	const zones = new Map(selectedZones.map((zone) => [zone.zoneId, zone.name]));
	const grouped: { key: string; label: string; items: PlanItem[] }[] = selectedZones.map((zone) => ({
		key: zone.zoneId,
		label: zone.name,
		items: items.filter((item) => item.zoneId === zone.zoneId),
	}));
	const account = items.filter((item) => item.zoneId === null || !zones.has(item.zoneId));
	if (account.length) grouped.push({ key: "account", label: "Cloudflare account", items: account });
	return grouped;
}

export function planAfterStale(current: CfPlanResponse, body: Record<string, unknown>): CfPlanResponse | null {
	if (body.code !== "plan_stale" || !Array.isArray(body.items) || typeof body.planHash !== "string") return null;
	return { ...current, items: body.items as PlanItem[], planHash: body.planHash };
}

export function resultFor(results: readonly ApplyItemResult[], id: string): ApplyItemResult | undefined {
	return results.find((result) => result.id === id);
}

export function shouldShowOnboardingBanner(input: {
	isAdmin: boolean;
	dismissed: boolean;
	domains: readonly { status: string }[] | undefined;
}): boolean {
	return input.isAdmin && !input.dismissed && input.domains !== undefined && !input.domains.some((domain) => domain.status === "active");
}
