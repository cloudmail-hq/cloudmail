// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The analytics tabs (`/analytics/<section>`): which a viewer sees, which
 * Worker endpoint each one reads, and where the old single-page anchors
 * (`/analytics#dmarc`) now live.
 */

export type AnalyticsSectionId = "overview" | "sending" | "engagement" | "inbound" | "dmarc" | "suppressions" | "usage";

/** The four analytics endpoints. A tab fetches only the ones it lists. */
export type AnalyticsQuery = "overview" | "engagement" | "inbound" | "dmarc";

export interface AnalyticsSectionMeta {
	id: AnalyticsSectionId;
	label: string;
	/** Zone-wide Cloudflare data: hidden from members. */
	adminOnly: boolean;
	queries: readonly AnalyticsQuery[];
	/** Reads the overview with the app / whole-zone scope (and domain filter). */
	scoped: boolean;
}

const ALL: readonly AnalyticsSectionMeta[] = [
	{ id: "overview", label: "Overview", adminOnly: false, queries: ["overview"], scoped: true },
	{ id: "sending", label: "Sending", adminOnly: false, queries: ["overview"], scoped: true },
	{ id: "engagement", label: "Engagement", adminOnly: false, queries: ["engagement"], scoped: false },
	{ id: "inbound", label: "Inbound", adminOnly: true, queries: ["inbound"], scoped: false },
	{ id: "dmarc", label: "DMARC", adminOnly: true, queries: ["dmarc"], scoped: false },
	{ id: "suppressions", label: "Suppressions", adminOnly: false, queries: ["overview"], scoped: false },
	// Month to date from its own endpoint (`/api/v1/usage`), so no range or scope.
	{ id: "usage", label: "Usage", adminOnly: true, queries: [], scoped: false },
];

export const DEFAULT_ANALYTICS_SECTION: AnalyticsSectionId = "overview";

export function visibleAnalyticsSections(viewer: { isAdmin: boolean }): AnalyticsSectionMeta[] {
	return ALL.filter((s) => viewer.isAdmin || !s.adminOnly);
}

export function isAnalyticsSectionId(value: string | undefined | null): value is AnalyticsSectionId {
	return !!value && ALL.some((s) => s.id === value);
}

/** An unknown or hidden section falls back to the first visible one (Overview). */
export function resolveAnalyticsSection(
	requested: string | undefined,
	visible: readonly AnalyticsSectionMeta[],
): AnalyticsSectionMeta {
	return visible.find((s) => s.id === requested) ?? visible[0] ?? ALL[0];
}

/** Section ids from the single scrolling page, mapped to the tab that holds them now. */
const LEGACY_HASH: Record<string, AnalyticsSectionId> = {
	overview: "overview",
	reputation: "sending",
	volume: "sending",
	domains: "sending",
	errors: "sending",
	engagement: "engagement",
	inbound: "inbound",
	dmarc: "dmarc",
	suppressions: "suppressions",
	usage: "usage",
};

export function analyticsSectionForLegacyHash(hash: string): AnalyticsSectionId | null {
	const id = hash.replace(/^#/, "").trim().toLowerCase();
	return LEGACY_HASH[id] ?? null;
}

/** Whether a tab needs a given endpoint. */
export function sectionNeeds(id: AnalyticsSectionId, query: AnalyticsQuery): boolean {
	return (ALL.find((s) => s.id === id)?.queries ?? []).includes(query);
}

export function sectionIsScoped(id: AnalyticsSectionId): boolean {
	return ALL.find((s) => s.id === id)?.scoped ?? false;
}

/** A product as the analytics filter needs it. */
export interface FilterProduct {
	id: string;
	slug: string;
	name: string;
	domains: string[];
}

/**
 * The overview's sending filter from the URL's `product=` and `domain=`.
 *
 * `product` narrows to every domain of one product; `domain` narrows further
 * to one of that product's domains, and is only offered when the product has
 * more than one. The Worker unions the two, so a chosen domain is sent alone.
 * A domain that doesn't belong to the chosen product is ignored.
 */
export function analyticsFilter(
	products: readonly FilterProduct[],
	productParam: string | null,
	domainParam: string | null,
): {
	product: FilterProduct | null;
	/** Domains offered by the sub-filter: empty unless the product has 2+. */
	domainOptions: string[];
	domain: string | null;
	query: { product?: string; domain?: string };
} {
	const product = productParam ? (products.find((p) => p.slug === productParam || p.id === productParam) ?? null) : null;
	if (!product) return { product: null, domainOptions: [], domain: null, query: {} };
	const domainOptions = product.domains.length > 1 ? [...product.domains].sort() : [];
	const d = (domainParam ?? "").toLowerCase();
	const domain = d && domainOptions.includes(d) ? d : null;
	return { product, domainOptions, domain, query: domain ? { domain } : { product: product.slug } };
}
