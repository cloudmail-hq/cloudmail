// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Coarse classification of who fetched an open pixel.
 *
 * A pixel load is not a person reading. Several large mailbox providers fetch
 * remote images themselves, through their own proxy, either when the message
 * is rendered (Gmail, Yahoo, Outlook on the web) or ahead of time whether or not
 * anyone looks at it (Apple Mail Privacy Protection). The ledger records which
 * of these an open came through so the UI can say "opened (likely via a mail
 * privacy proxy)" instead of overstating it.
 *
 * Deliberately lightweight: user-agent and network-owner heuristics only, no IP
 * lists to maintain. A wrong guess costs a hedge word in a tooltip, not data.
 *
 *   - Gmail: `GoogleImageProxy` in the UA (via `ggpht.com`).
 *   - Yahoo: `YahooMailProxy` in the UA.
 *   - Outlook.com / OWA: requests from Microsoft's network, or the
 *     `Microsoft Office` / `ms-office` / `OutlookImageProxy`-style UA tokens.
 *   - Apple MPP: Apple's relay fetches with a deliberately generic Safari-ish UA
 *     (`Mozilla/5.0` and no browser product token), from Apple's network
 *     (AS714/AS6185). The UA alone is not enough, so the network owner is what
 *     decides it.
 */

export type OpenProxy = "google" | "apple" | "yahoo" | "microsoft";

/** Cloudflare's per-request network facts, the subset this reads. */
export interface RequestNetwork {
	asn?: number | null;
	asOrganization?: string | null;
}

const APPLE_ASNS = new Set([714, 6185]);
const MICROSOFT_ASNS = new Set([8075, 8068, 8069]);

/** Which proxy fetched the pixel, or null when it looks like a real client. */
export function classifyOpenProxy(
	userAgent: string | null | undefined,
	network: RequestNetwork = {},
): OpenProxy | null {
	const ua = userAgent ?? "";
	if (/GoogleImageProxy/i.test(ua) || /\bvia ggpht\.com\b/i.test(ua)) return "google";
	if (/YahooMailProxy/i.test(ua)) return "yahoo";
	if (/OutlookImageProxy|ms-office|Microsoft Office|\bOWA\b/i.test(ua)) return "microsoft";

	const asn = network.asn ?? null;
	const org = network.asOrganization ?? "";
	if ((asn !== null && APPLE_ASNS.has(asn)) || /^apple\b/i.test(org)) return "apple";
	if ((asn !== null && MICROSOFT_ASNS.has(asn)) || /^microsoft\b/i.test(org)) return "microsoft";
	return null;
}

/** Human name for the tooltip. */
export function openProxyLabel(proxy: OpenProxy): string {
	switch (proxy) {
		case "google":
			return "Gmail image proxy";
		case "apple":
			return "Apple Mail Privacy Protection";
		case "yahoo":
			return "Yahoo Mail proxy";
		case "microsoft":
			return "Outlook image proxy";
	}
}

/** Longest user agent stored in event metadata. */
export const MAX_STORED_UA = 300;
