// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Privacy transforms for *received* mail, applied when it is displayed.
 *
 * - Tracker detection: open-tracking pixels are blocked even after the reader
 *   allows images, because "show me the pictures" is not consent to report the
 *   open. Detected by shape (a declared 1×1 or 0×0 image, or one hidden with
 *   CSS) and by host (a short list of the big open-tracking services).
 * - Link cleaning: `utm_*`, `fbclid`, `gclid`, `mc_eid` and friends are
 *   stripped from link targets. They identify the reader to the destination and
 *   do nothing for them.
 *
 * Never used on outbound mail: our own click tracking (`shared/tracking-inject`)
 * wraps links before sending, and this module only runs in the reading pane.
 *
 * Pure string functions so they run the same in the browser and in tests.
 */

/**
 * Hosts that exist to record opens. Matched on the hostname and every parent
 * domain, so `list-manage.com` covers `xyz.list-manage.com`.
 *
 * Deliberately short: each entry is a service whose image endpoint is only
 * ever a pixel. A content CDN (`mcusercontent.com` for Mailchimp's real images)
 * is not on it, or newsletters would lose their pictures.
 */
export const TRACKER_HOSTS: readonly string[] = [
	// Mailchimp / Mandrill
	"list-manage.com",
	"mandrillapp.com",
	// HubSpot
	"t.hubspotemail.net",
	"t.hubspotfree.net",
	"track.hubspot.com",
	"t.sidekickopen.com",
	// SendGrid / Twilio
	"sendgrid.net",
	"wf.sendgrid.net",
	// Mailgun, Postmark, SparkPost, Mailjet, Customer.io, Klaviyo, Braze
	"email.mg.mailgun.org",
	"pstmrk.it",
	"spgo.io",
	"mjt.lu",
	"track.customer.io",
	"trk.klclick.com",
	"trk.klclick1.com",
	"links.iterable.com",
	// Salesforce Marketing Cloud, Marketo, Pardot, Intercom
	"cl.exct.net",
	"open.exct.net",
	"mktoresp.com",
	"pi.pardot.com",
	"via.intercom.io",
	// Sales tools that track one-to-one mail
	"mailtrack.io",
	"yesware.com",
	"t.yesware.com",
	"mixmax.com",
	"track.mixmax.com",
	"getnotify.com",
	"bananatag.com",
	"t.superhuman.com",
	"r.superhuman.com",
];

/**
 * URL path patterns that are open pixels on any host. Covers ESPs that send
 * from a customer's own tracking subdomain (`email.customer.com/o/...`).
 */
const TRACKER_PATHS: readonly RegExp[] = [
	/\/(?:track|trk|tracking)\/open\b/i,
	/\/wf\/open\b/i, // SendGrid
	/\/e\/o\//i, // HubSpot-style
	/\/o\/[A-Za-z0-9_-]{16,}(?:\.gif|\.png)?$/i, // Mailgun / generic opaque id
	/\/open\.(?:gif|png|php|aspx?)\b/i,
	/\/pixel(?:\.gif|\.png)?(?:\?|$)/i,
	/\/beacon(?:\.gif|\.png)?(?:\?|$)/i,
];

function hostMatches(host: string, list: readonly string[]): boolean {
	const h = host.toLowerCase().replace(/\.$/, "");
	return list.some((entry) => h === entry || h.endsWith(`.${entry}`));
}

/** Whether a URL points at a known open-tracking endpoint. */
export function isTrackerUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url.startsWith("//") ? `https:${url}` : url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
	if (hostMatches(parsed.hostname, TRACKER_HOSTS)) return true;
	return TRACKER_PATHS.some((re) => re.test(parsed.pathname));
}

function attr(tag: string, name: string): string | null {
	const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
	return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

function tinyDimension(value: string | null): boolean {
	if (value === null) return false;
	const n = Number.parseFloat(value);
	return Number.isFinite(n) && n <= 2;
}

/**
 * Whether an `<img>` tag is shaped like a tracking pixel: a declared size of
 * at most 2×2 (one tiny side is enough when the other is absent), or styled to
 * be invisible.
 */
export function isPixelShaped(imgTag: string): boolean {
	const width = attr(imgTag, "width");
	const height = attr(imgTag, "height");
	if (tinyDimension(width) && (height === null || tinyDimension(height))) return true;
	if (tinyDimension(height) && width === null) return true;
	const style = (attr(imgTag, "style") ?? "").toLowerCase().replace(/\s+/g, "");
	if (/display:none|visibility:hidden|opacity:0?\.?0*(?:;|$)/.test(style)) return true;
	const sw = /(?:^|;)(?:max-)?width:([\d.]+)px/.exec(style);
	const sh = /(?:^|;)(?:max-)?height:([\d.]+)px/.exec(style);
	if (sw && sh && Number(sw[1]) <= 2 && Number(sh[1]) <= 2) return true;
	return false;
}

/** Whether an `<img>` with this tag and source is a tracker. */
export function isTrackingImage(imgTag: string, src: string): boolean {
	return isTrackerUrl(src) || isPixelShaped(imgTag);
}

// ── Link cleaning ────────────────────────────────────────────────────

/** Exact parameter names that only identify the reader or the campaign. */
const TRACKING_PARAMS = new Set([
	"fbclid",
	"gclid",
	"gclsrc",
	"dclid",
	"gbraid",
	"wbraid",
	"msclkid",
	"yclid",
	"twclid",
	"ttclid",
	"li_fat_id",
	"igshid",
	"mc_eid",
	"mc_cid",
	"_hsenc",
	"_hsmi",
	"__hssc",
	"__hstc",
	"__hsfp",
	"hsctatracking",
	"mkt_tok",
	"oly_enc_id",
	"oly_anon_id",
	"vero_id",
	"vero_conv",
	"_kx",
	"ck_subscriber_id",
	"s_cid",
	"ml_subscriber",
	"ml_subscriber_hash",
	"rb_clickid",
	"wickedid",
	"_openstat",
	"ref_src",
]);

/** Prefixes: every `utm_*`, `pk_*` (Matomo), `mtm_*`, `hsa_*`. */
const TRACKING_PREFIXES = ["utm_", "pk_", "mtm_", "hsa_"];

export function isTrackingParam(name: string): boolean {
	const n = name.toLowerCase();
	return TRACKING_PARAMS.has(n) || TRACKING_PREFIXES.some((p) => n.startsWith(p));
}

/**
 * The URL with tracking parameters removed. Anything that is not an http(s)
 * URL, or has nothing to strip, comes back unchanged (byte for byte, so a
 * signed URL whose signature covers its query is not disturbed needlessly).
 */
export function cleanTrackingParams(url: string): string {
	if (!/^https?:\/\//i.test(url.trim())) return url;
	let parsed: URL;
	try {
		parsed = new URL(url.trim());
	} catch {
		return url;
	}
	const names = [...parsed.searchParams.keys()];
	if (!names.some(isTrackingParam)) return url;
	for (const name of new Set(names)) {
		if (isTrackingParam(name)) parsed.searchParams.delete(name);
	}
	let out = parsed.toString();
	// `URL` leaves a bare `?` when every parameter went.
	if (!parsed.search) out = out.replace(/\?(?=#|$)/, "");
	return out;
}

const decodeAmp = (s: string) => s.replace(/&amp;/gi, "&");
const encodeAmp = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * Strip tracking parameters from every `<a href>` in `html`.
 *
 * Returns the rewritten HTML and how many links changed, so the reader can be
 * told it happened.
 */
export function cleanLinksInHtml(html: string): { html: string; cleaned: number } {
	let cleaned = 0;
	const out = html.replace(
		/(<a\b[^>]*?\shref\s*=\s*)(["'])(.*?)\2/gi,
		(match, prefix: string, quote: string, href: string) => {
			const decoded = decodeAmp(href);
			const next = cleanTrackingParams(decoded);
			if (next === decoded) return match;
			cleaned += 1;
			return `${prefix}${quote}${encodeAmp(next)}${quote}`;
		},
	);
	return { html: out, cleaned };
}
