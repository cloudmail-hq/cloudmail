/**
 * The analytics tabs: `/analytics/:section` routing, which tabs a member sees,
 * which endpoints each tab fetches, the shared side-nav layout, the ⓘ tips
 * and the palette entries.
 */

import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
	analyticsFilter,
	analyticsSectionForLegacyHash,
	isAnalyticsSectionId,
	resolveAnalyticsSection,
	sectionIsScoped,
	sectionNeeds,
	visibleAnalyticsSections,
	type AnalyticsQuery,
} from "../shared/analytics-sections";
import { buildPaletteItems, type PaletteSource } from "../app/lib/command-palette";
import { Folders } from "../shared/folders";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("analytics routes", () => {
	it("routes /analytics/:section with an optional section", () => {
		const routes = read("app/routes.ts");
		expect(routes).toContain('route("analytics/:section?", "routes/analytics.tsx")');
		expect(routes).not.toMatch(/route\("analytics", /);
	});

	it("redirects a bare /analytics to the resolved tab, keeping the query string", () => {
		const page = read("app/routes/analytics.tsx");
		expect(page).toMatch(/<Navigate to=\{`\/analytics\/\$\{current\.id\}\$\{location\.search\}`\} replace \/>/);
	});

	it("resolves a bare /analytics to Overview", () => {
		const visible = visibleAnalyticsSections({ isAdmin: true });
		expect(resolveAnalyticsSection(undefined, visible).id).toBe("overview");
		expect(resolveAnalyticsSection("nope", visible).id).toBe("overview");
		expect(resolveAnalyticsSection("dmarc", visible).id).toBe("dmarc");
	});

	it("maps the old single-page anchors to their tab", () => {
		expect(analyticsSectionForLegacyHash("#dmarc")).toBe("dmarc");
		expect(analyticsSectionForLegacyHash("#reputation")).toBe("sending");
		expect(analyticsSectionForLegacyHash("#volume")).toBe("sending");
		expect(analyticsSectionForLegacyHash("#domains")).toBe("sending");
		expect(analyticsSectionForLegacyHash("#errors")).toBe("sending");
		expect(analyticsSectionForLegacyHash("#Inbound")).toBe("inbound");
		expect(analyticsSectionForLegacyHash("")).toBeNull();
		expect(analyticsSectionForLegacyHash("#nothing")).toBeNull();
	});

	it("knows its section ids", () => {
		expect(isAnalyticsSectionId("engagement")).toBe(true);
		expect(isAnalyticsSectionId("reputation")).toBe(false);
		expect(isAnalyticsSectionId(undefined)).toBe(false);
	});
});

describe("analytics tab visibility", () => {
	it("shows admins every tab, in order", () => {
		expect(ids(visibleAnalyticsSections({ isAdmin: true }))).toEqual([
			"overview",
			"sending",
			"engagement",
			"inbound",
			"dmarc",
			"suppressions",
			"usage",
		]);
	});

	it("hides the zone-wide Inbound and DMARC tabs from members", () => {
		const member = ids(visibleAnalyticsSections({ isAdmin: false }));
		expect(member).toEqual(["overview", "sending", "engagement", "suppressions"]);
		expect(member).not.toContain("inbound");
		expect(member).not.toContain("dmarc");
		expect(member).not.toContain("usage");
	});

	it("sends a member who deep-links to an admin tab back to Overview", () => {
		const member = visibleAnalyticsSections({ isAdmin: false });
		expect(resolveAnalyticsSection("dmarc", member).id).toBe("overview");
		expect(resolveAnalyticsSection("inbound", member).id).toBe("overview");
	});
});

describe("analytics fetching", () => {
	const needs = (id: Parameters<typeof sectionNeeds>[0]) =>
		(["overview", "engagement", "inbound", "dmarc"] as AnalyticsQuery[]).filter((q) => sectionNeeds(id, q));

	it("fetches only the endpoint each tab reads", () => {
		expect(needs("overview")).toEqual(["overview"]);
		expect(needs("sending")).toEqual(["overview"]);
		expect(needs("engagement")).toEqual(["engagement"]);
		expect(needs("inbound")).toEqual(["inbound"]);
		expect(needs("dmarc")).toEqual(["dmarc"]);
		expect(needs("suppressions")).toEqual(["overview"]);
		// Usage reads its own endpoint, gated on the tab and the role.
		expect(needs("usage")).toEqual([]);
		expect(read("app/routes/analytics.tsx")).toContain('useUsage(isAdmin && tab === "usage")');
	});

	it("gates every query on the active tab", () => {
		const page = read("app/routes/analytics.tsx");
		expect(page).toContain('useAnalyticsOverview({ days, scope, ...filter.query }, settled && sectionNeeds(tab, "overview"))');
		expect(page).toMatch(/useAnalyticsEngagement\(\{ days \}, sectionNeeds\(tab, "engagement"\)\)/);
		expect(page).toMatch(/useAnalyticsInbound\(\{ days \}, isAdmin && sectionNeeds\(tab, "inbound"\)\)/);
		expect(page).toMatch(/useAnalyticsDmarc\(\{ days \}, isAdmin && sectionNeeds\(tab, "dmarc"\)\)/);
	});

	it("offers the scope switch only on the tabs it changes", () => {
		expect(sectionIsScoped("overview")).toBe(true);
		expect(sectionIsScoped("sending")).toBe(true);
		for (const id of ["engagement", "inbound", "dmarc", "suppressions", "usage"] as const) expect(sectionIsScoped(id)).toBe(false);
	});
});

describe("shared side-nav layout", () => {
	it("renders Analytics with the same nav as Settings, carrying the query string", async () => {
		const { SideNavLayout } = await import("~/components/ui/SideNavLayout");
		const html = renderToStaticMarkup(
			h(
				MemoryRouter,
				{ initialEntries: ["/analytics/sending?days=7"] },
				h(SideNavLayout, {
					basePath: "/analytics",
					active: "sending",
					navLabel: "Analytics sections",
					pickerLabel: "Analytics section",
					title: "Analytics",
					search: "?days=7",
					items: [
						{ id: "overview", label: "Overview", content: "O" },
						{ id: "sending", label: "Sending", content: "S" },
					],
				}),
			),
		);
		expect(html).toContain('aria-label="Analytics sections"');
		expect(html).toContain('href="/analytics/overview?days=7"');
		expect(html).toContain('aria-current="page"');
		// On a phone, the same 44px module bar as Settings and Mail, naming the section.
		expect(html).toContain("data-module-bar");
		expect(html).toContain('aria-label="Analytics section: Analytics · Sending"');
		expect(html).toContain("h-11");
		// Only the active tab renders.
		expect(html).toContain(">S<");
		expect(html).not.toContain(">O<");
	});

	it("is the layout Settings uses too", () => {
		expect(read("app/components/settings/SettingsLayout.tsx")).toContain("<SideNavLayout");
		expect(read("app/routes/analytics.tsx")).toContain("<SideNavLayout");
	});
});

describe("info tips", () => {
	it("are focusable buttons described by their tooltip", async () => {
		const { InfoTip } = await import("~/components/analytics/primitives");
		const html = renderToStaticMarkup(h(InfoTip, { label: "About Sent" }, "Counted in recipients."));
		const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1];
		expect(html).toMatch(/^<span[^>]*><button type="button"/);
		expect(html).toContain('aria-label="About Sent"');
		expect(describedBy).toBeTruthy();
		// The text is in the DOM (for screen readers), hidden until shown.
		expect(html).toContain(`role="tooltip" id="${describedBy}" hidden=""`);
		expect(html).toContain("Counted in recipients.");
	});

	it("carry the explanations that used to be paragraphs", () => {
		const src = read("app/components/analytics/sections.tsx") + read("app/components/analytics/sending.tsx");
		// Privacy proxy caveat, units, the "Handled by worker" relabel, stored vs handled, DMARC coverage.
		expect(src).toContain("${data.note}");
		expect(src).toContain("a message to 3 people counts 3");
		expect(src).toContain("Handled by worker");
		expect(src).toContain("storedGapText(rec)");
		expect(src).toContain("Coverage: ");
	});
});

describe("analytics in the command palette", () => {
	const base = (isAdmin: boolean): PaletteSource => ({
		mailboxId: undefined,
		shortcutContext: {
			rows: [],
			cursorId: null,
			openId: null,
			isComposing: false,
			isHelpOpen: false,
			prefix: null,
			folder: Folders.INBOX,
			hasMailbox: false,
		},
		mailboxes: [],
		folders: [],
		labels: [],
		people: [],
		templates: [],
		recentThreads: [],
		canInsertTemplate: false,
		viewer: { isAdmin, passwordMode: true, managesSomeMailbox: false },
		query: "",
	});

	it("lists every analytics tab the viewer can see", () => {
		const items = buildPaletteItems(base(true));
		for (const id of ["sending", "engagement", "inbound", "dmarc", "suppressions", "usage"]) {
			const item = items.find((i) => i.id === `go:analytics:${id}`);
			expect(item, id).toBeTruthy();
			expect(item!.run).toEqual({ kind: "navigate", to: `/analytics/${id}` });
		}
		// "Analytics" itself lands on Overview.
		expect(items.find((i) => i.id === "go:page:analytics")).toBeTruthy();
	});

	it("leaves admin-only tabs out for members", () => {
		const all = ids(buildPaletteItems(base(false)));
		expect(all).toContain("go:analytics:engagement");
		expect(all).not.toContain("go:analytics:inbound");
		expect(all).not.toContain("go:analytics:dmarc");
		expect(all).not.toContain("go:analytics:usage");
	});
});

describe("product filter", () => {
	const products = [
		{ id: "p1", slug: "tapetide", name: "Tapetide", domains: ["tapetide.com", "mail.tapetide.com"] },
		{ id: "p2", slug: "acme", name: "Acme", domains: ["acme.dev"] },
	];

	it("is off without a product", () => {
		expect(analyticsFilter(products, null, null)).toMatchObject({ product: null, domainOptions: [], query: {} });
		// A bare domain= without a product is not applied.
		expect(analyticsFilter(products, null, "acme.dev").query).toEqual({});
	});

	it("sends the product, by slug or id", () => {
		expect(analyticsFilter(products, "acme", null).query).toEqual({ product: "acme" });
		expect(analyticsFilter(products, "p2", null).query).toEqual({ product: "acme" });
		expect(analyticsFilter(products, "nope", null).product).toBeNull();
	});

	it("offers a domain sub-filter only for a product with more than one domain", () => {
		expect(analyticsFilter(products, "acme", null).domainOptions).toEqual([]);
		expect(analyticsFilter(products, "tapetide", null).domainOptions).toEqual(["mail.tapetide.com", "tapetide.com"]);
	});

	it("narrows to one of the product's domains, sent alone", () => {
		expect(analyticsFilter(products, "tapetide", "mail.tapetide.com").query).toEqual({ domain: "mail.tapetide.com" });
		// A domain from another product is ignored, not unioned in.
		expect(analyticsFilter(products, "tapetide", "acme.dev").query).toEqual({ product: "tapetide" });
	});

	it("replaces the old domain-only filter on the page", () => {
		const page = read("app/routes/analytics.tsx");
		expect(page).toContain("useProducts()");
		expect(page).toContain("...filter.query");
		expect(page).toContain("All products");
	});
});
