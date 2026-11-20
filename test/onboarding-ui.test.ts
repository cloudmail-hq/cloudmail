// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Pure rules behind the Cloudflare onboarding wizard. */

import { describe, expect, it } from "vitest";
import type { CfPlanResponse, PlanItem, ZoneDiscovery } from "../shared/cf-setup";
import { applyCount, applySelection, groupPlanByDomain, groupPlanByTier, planAfterStale, retrySelection, shouldShowOnboardingBanner, zoneStatusLine } from "../app/components/onboarding/logic";

const zone = (over: Partial<ZoneDiscovery> = {}): ZoneDiscovery => ({
	zoneId: "a".repeat(32), name: "example.com", status: "active", managed: false, envDomain: false,
	detail: "summary", routing: null, catchAll: null, catchAllToUs: false, sending: [],
	dns: { mx: [], spf: [], dmarc: [], tlsRpt: [], mtaSts: [] }, mxProvider: "none", spfLookups: 0, denied: [], ...over,
});
const item = (id: string, tier: PlanItem["tier"], over: Partial<PlanItem> = {}): PlanItem => ({
	id, zoneId: zone().zoneId, hostname: "example.com", kind: "add_domain", tier, title: id, detail: `${id} detail`, ...over,
});
const plan = (items: PlanItem[]): CfPlanResponse => ({
	items, planHash: "old", zones: [zone()], worker: { configured: "mail", source: "default", found: true, mailboxScripts: [], canPersist: false },
	vectorize: { indexName: "mail", index: "present", metadataIndex: "present" },
});

describe("zoneStatusLine", () => {
	it("explains current mail and nameserver states in plain words", () => {
		expect(zoneStatusLine(zone({ status: "pending" }))).toBe("Nameservers not switched yet");
		expect(zoneStatusLine(zone({ mxProvider: "google" }))).toBe("Gmail handles mail here today");
		expect(zoneStatusLine(zone())).toBe("Ready for mail");
		expect(zoneStatusLine(zone({ managed: true, routing: { enabled: true, status: "ready" }, catchAllToUs: true }))).toBe("Already set up");
	});
});

describe("plan grouping and selection", () => {
	const items = [item("auto", "auto"), item("confirm", "confirm"), item("manual", "manual"), item("done", "done")];
	it("groups every tier without changing order", () => {
		const groups = groupPlanByTier(items);
		expect(Object.fromEntries(Object.entries(groups).map(([key, values]) => [key, values.map((value) => value.id)]))).toEqual({
			auto: ["auto"], confirm: ["confirm"], manual: ["manual"], done: ["done"],
		});
	});
	it("counts and sends auto plus explicitly confirmed changes", () => {
		expect(applyCount(items, new Set())).toBe(1);
		expect(applyCount(items, new Set(["confirm"]))).toBe(2);
		expect(applySelection(items, new Set(["confirm"]))).toEqual([{ id: "auto" }, { id: "confirm", confirm: true }]);
	});
	it("puts zone items first and account items last", () => {
		const account = item("account", "auto", { zoneId: null, hostname: null, kind: "vectorize_metadata_index" });
		expect(groupPlanByDomain([...items, account], [zone()]).map((group) => [group.label, group.items.map((value) => value.id)]))
			.toEqual([["example.com", ["auto", "confirm", "manual", "done"]], ["Cloudflare account", ["account"]]]);
	});
});

describe("planAfterStale", () => {
	it("replaces review items and hash without changing the selected zones", () => {
		const current = plan([item("old", "auto")]);
		const fresh = item("fresh", "confirm");
		expect(planAfterStale(current, { code: "plan_stale", items: [fresh], planHash: "new" }))
			.toEqual({ ...current, items: [fresh], planHash: "new" });
	});
	it("ignores unrelated or malformed errors", () => {
		expect(planAfterStale(plan([]), { code: "confirm_required" })).toBeNull();
		expect(planAfterStale(plan([]), { code: "plan_stale", items: [] })).toBeNull();
	});
});

describe("shouldShowOnboardingBanner", () => {
	it("shows only to admins with loaded domains, none active, and no dismissal", () => {
		expect(shouldShowOnboardingBanner({ isAdmin: true, dismissed: false, domains: [{ status: "pending" }] })).toBe(true);
		expect(shouldShowOnboardingBanner({ isAdmin: true, dismissed: false, domains: [{ status: "active" }] })).toBe(false);
		expect(shouldShowOnboardingBanner({ isAdmin: false, dismissed: false, domains: [] })).toBe(false);
		expect(shouldShowOnboardingBanner({ isAdmin: true, dismissed: true, domains: [] })).toBe(false);
		expect(shouldShowOnboardingBanner({ isAdmin: true, dismissed: false, domains: undefined })).toBe(false);
	});
});

describe("retrySelection", () => {
	const mx = [{ type: "MX", name: "a.com", content: "aspmx.l.google.com", priority: 1 }];
	const item = (tier: PlanItem["tier"], before?: PlanItem["before"]) =>
		({ id: "z:mx_replace", zoneId: "z", hostname: "a.com", kind: "mx_replace", tier, title: "t", detail: "d", ...(before ? { before } : {}) }) as PlanItem;

	it("retries an auto item without confirming", () => {
		expect(retrySelection(item("auto"), item("auto"), new Set())).toEqual({ id: "z:mx_replace" });
	});
	it("re-confirms only what the admin confirmed, with the same records", () => {
		expect(retrySelection(item("confirm", mx), item("confirm", mx), new Set(["z:mx_replace"]))).toEqual({ id: "z:mx_replace", confirm: true });
	});
	it("sends an item that became confirm back to review", () => {
		expect(retrySelection(item("auto"), item("confirm", mx), new Set(["z:mx_replace"]))).toBeNull();
	});
	it("sends an unconfirmed or changed confirm item back to review", () => {
		expect(retrySelection(item("confirm", mx), item("confirm", mx), new Set())).toBeNull();
		const other = [{ ...mx[0]!, content: "mx.zoho.com" }];
		expect(retrySelection(item("confirm", mx), item("confirm", other), new Set(["z:mx_replace"]))).toBeNull();
	});
	it("never applies manual or done items", () => {
		expect(retrySelection(item("manual"), item("manual"), new Set(["z:mx_replace"]))).toBeNull();
	});
});
