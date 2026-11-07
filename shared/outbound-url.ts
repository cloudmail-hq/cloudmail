// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The guard for every URL the Worker fetches on someone's say-so: webhook
 * destinations (#102), the remote-image proxy, and AI gateways.
 *
 * Checked on the parsed URL, after the WHATWG parser has normalised the forms
 * people use to sneak past string checks (`https://2130706433`, `0x7f.1`,
 * `[::ffff:127.0.0.1]` all arrive here as canonical literals).
 *
 * This is a syntactic guard. A public hostname that resolves to a private
 * address is not caught here; on Workers outbound fetch cannot reach private
 * networks anyway, and every caller fetches with `redirect: "manual"` so a
 * public endpoint cannot bounce the request somewhere this check would have
 * refused. Callers re-check on every request, not only when the URL is saved.
 *
 * Pure: the settings UI runs the same check as the Worker.
 */

export const OUTBOUND_URL_MAX_LENGTH = 2048;

export function ipv4Octets(host: string): number[] | null {
	const parts = host.split(".");
	if (parts.length !== 4) return null;
	const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
	return octets.every((o) => Number.isInteger(o) && o >= 0 && o <= 255) ? octets : null;
}

export function isPrivateIpv4([a, b, c]: number[]): boolean {
	return (
		a === 0 || // "this" network
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) || // CGNAT
		(a === 169 && b === 254) || // link-local, cloud metadata
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0 && c === 0) ||
		(a === 192 && b === 0 && c === 2) || // TEST-NET-1
		(a === 198 && (b === 18 || b === 19)) || // benchmarking
		(a === 198 && b === 51 && c === 100) || // TEST-NET-2
		(a === 203 && b === 0 && c === 113) || // TEST-NET-3
		a >= 224 // multicast and reserved
	);
}

/**
 * Expand an IPv6 literal to 8 hextets. Input is `URL.hostname` without the
 * brackets, which the URL parser has already serialised to pure hex (an
 * embedded `::ffff:127.0.0.1` arrives as `::ffff:7f00:1`), so no dotted tail.
 */
export function ipv6Hextets(host: string): number[] | null {
	const halves = host.split("::");
	if (halves.length > 2) return null;
	const parse = (s: string) =>
		s === "" ? [] : s.split(":").map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : Number.NaN));
	const head = parse(halves[0]);
	const rest = halves.length === 2 ? parse(halves[1]) : [];
	const total = head.length + rest.length;
	if (halves.length === 1 ? total !== 8 : total > 7) return null;
	const fill = halves.length === 2 ? new Array(8 - total).fill(0) : [];
	const all = [...head, ...fill, ...rest];
	return all.every((x) => Number.isInteger(x)) ? all : null;
}

export function isPrivateIpv6(hextets: number[]): boolean {
	const [h0] = hextets;
	if (hextets.every((x) => x === 0)) return true; // ::
	if (hextets.slice(0, 7).every((x) => x === 0) && hextets[7] === 1) return true; // ::1
	if ((h0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
	if ((h0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
	if ((h0 & 0xff00) === 0xff00) return true; // multicast
	if (h0 === 0x2001 && hextets[1] === 0x0db8) return true; // documentation
	const embedded = (hi: number, lo: number) => isPrivateIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
	const zeros = (from: number, to: number) => hextets.slice(from, to).every((x) => x === 0);
	// IPv4-mapped ::ffff:a.b.c.d, IPv4-compatible ::a.b.c.d, SIIT ::ffff:0:a.b.c.d
	if (zeros(0, 5) && (hextets[5] === 0xffff || hextets[5] === 0)) return embedded(hextets[6], hextets[7]);
	if (zeros(0, 4) && hextets[4] === 0xffff && hextets[5] === 0) return embedded(hextets[6], hextets[7]);
	// NAT64: well-known 64:ff9b::/96 wraps a v4; local-use 64:ff9b:1::/48 is private outright
	if (h0 === 0x64 && hextets[1] === 0xff9b) {
		if (hextets[2] === 1) return true;
		if (zeros(2, 6)) return embedded(hextets[6], hextets[7]);
	}
	// 6to4 2002:AABB:CCDD::/48 carries the v4 in hextets 1-2
	if (h0 === 0x2002) return embedded(hextets[1], hextets[2]);
	return false;
}

const BLOCKED_HOST_SUFFIXES = [
	".localhost",
	".local",
	".internal",
	".lan",
	".home.arpa",
	".intranet",
	".corp",
	".onion",
	".test",
	".invalid",
];

export type OutboundUrlCheck = { ok: true; url: string } | { ok: false; error: string };

export interface OutboundUrlOptions {
	/** Wording only, plus the AI-specific rules below when `"ai-gateway"`. */
	purpose: "webhook" | "image" | "ai-gateway";
	/**
	 * Hostnames that are this deployment (the app host, custom domains,
	 * `*.workers.dev`). A gateway URL pointing back at our own API would carry
	 * the gateway token into it. Compared case-insensitively; a leading `*.`
	 * matches any subdomain.
	 */
	ownHosts?: readonly string[];
	/** Allow a port other than 443. Off for AI gateways unless the admin opts in. */
	allowCustomPorts?: boolean;
	/** The AI Gateway preset is selected, so `api.cloudflare.com/client/v4` is acceptable. */
	allowCloudflareApi?: boolean;
}

const PURPOSE_NAME: Record<OutboundUrlOptions["purpose"], string> = {
	webhook: "Webhook",
	image: "Image",
	"ai-gateway": "Gateway",
};

function hostMatches(host: string, pattern: string): boolean {
	const p = pattern.trim().toLowerCase().replace(/\.$/, "");
	if (!p) return false;
	if (p.startsWith("*.")) return host.endsWith(p.slice(1)) || host === p.slice(2);
	return host === p;
}

/**
 * Refuse a destination that is not plainly a public HTTPS endpoint. With
 * `purpose: "ai-gateway"` three more rules apply: never our own hosts, never
 * the Cloudflare API unless the AI Gateway preset is chosen, and port 443 only
 * unless custom ports are allowed.
 */
export function validatePublicHttpsUrl(raw: string, options: OutboundUrlOptions): OutboundUrlCheck {
	const input = (raw ?? "").trim();
	if (!input) return { ok: false, error: "Enter a URL." };
	if (input.length > OUTBOUND_URL_MAX_LENGTH) return { ok: false, error: "That URL is too long." };

	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return { ok: false, error: "That is not a valid URL." };
	}
	if (url.protocol !== "https:") return { ok: false, error: `${PURPOSE_NAME[options.purpose]} URLs must use https://.` };
	if (url.username || url.password) {
		return { ok: false, error: "Put credentials in a header or the path, not in the URL." };
	}

	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	if (!host) return { ok: false, error: "The URL has no host." };

	const ai = options.purpose === "ai-gateway";
	if (ai) {
		if (url.port && url.port !== "443" && !options.allowCustomPorts) {
			return { ok: false, error: "Only port 443 is allowed. Turn on custom ports to use another." };
		}
		if ((options.ownHosts ?? []).some((p) => hostMatches(host, p)) || host.endsWith(".workers.dev")) {
			return { ok: false, error: "A gateway can't point at this app or a workers.dev host." };
		}
		if (host === "api.cloudflare.com" && url.pathname.toLowerCase().startsWith("/client/v4") && !options.allowCloudflareApi) {
			return { ok: false, error: "The Cloudflare API is not an AI gateway." };
		}
	}

	if (host.startsWith("[") && host.endsWith("]")) {
		const hextets = ipv6Hextets(host.slice(1, -1));
		if (!hextets || isPrivateIpv6(hextets)) {
			return { ok: false, error: "Private, loopback and link-local addresses are not allowed." };
		}
		return { ok: true, url: url.toString() };
	}

	const v4 = ipv4Octets(host);
	if (v4) {
		if (isPrivateIpv4(v4)) {
			return { ok: false, error: "Private, loopback and link-local addresses are not allowed." };
		}
		return { ok: true, url: url.toString() };
	}

	if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
		return { ok: false, error: "Local and internal hostnames are not allowed." };
	}
	if (!host.includes(".")) {
		return { ok: false, error: "Use a fully qualified public hostname." };
	}
	return { ok: true, url: url.toString() };
}
