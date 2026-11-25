/**
 * Sender pictures: the settings, the lookup order and the DNS record parsing.
 *
 * The picture next to a sender is the first of these that exists:
 *
 * 1. The brand's own logo, published in DNS (BIMI), with a certificate.
 * 2. The same record without a certificate.
 * 3. The website icon of the sender's domain, for a company domain.
 * 4. The sender's own public picture (Gravatar), which is what covers
 *    personal addresses at Gmail, Outlook and the like. Google publishes no
 *    open API for a person's profile picture.
 * 5. A generated face, the same one every time for the same address.
 *
 * Steps 1 to 4 show something that says "this is them", so they run only for
 * a message whose sender was authenticated (see `shared/auth-results.ts`). A
 * forged message from a bank's domain must not arrive wearing the bank's logo.
 *
 * Pure and dependency-free: the client reads the settings and builds URLs from
 * here, the Worker does the lookups (`workers/lib/sender-pictures.ts`).
 */

/** Which sources may be used. Everything is on unless the operator turns it off. */
export interface SenderPictureSettings {
	/** Master switch. Off means initials everywhere and no lookups at all. */
	enabled: boolean;
	/** Brand logos from the sender's DNS (BIMI). */
	brandLogos: boolean;
	/** Website icons, fetched through Google's favicon service. */
	websiteIcons: boolean;
	/** The sender's own public picture, from Gravatar. */
	gravatar: boolean;
	/** A generated face when nothing else exists. Made on this deployment. */
	generated: boolean;
}

export const DEFAULT_SENDER_PICTURES: SenderPictureSettings = {
	enabled: true,
	brandLogos: true,
	websiteIcons: true,
	gravatar: true,
	generated: true,
};

export const SENDER_PICTURE_KEYS = ["enabled", "brandLogos", "websiteIcons", "gravatar", "generated"] as const;

/** A stored record with every switch present. Anything not a boolean is "on". */
export function normalizeSenderPictures(raw: unknown): SenderPictureSettings {
	const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const out = { ...DEFAULT_SENDER_PICTURES };
	for (const key of SENDER_PICTURE_KEYS) {
		if (typeof v[key] === "boolean") out[key] = v[key] as boolean;
	}
	return out;
}

/**
 * The switches as one short string, part of the picture URL and the cache key.
 * Changing a setting changes the URL, so no browser or edge copy made under the
 * old settings is shown afterwards.
 */
export function senderPictureMask(s: SenderPictureSettings): string {
	return [s.brandLogos, s.websiteIcons, s.gravatar, s.generated].map((on) => (on ? "1" : "0")).join("");
}

/** Read a mask back. Null when it is not four 0/1 characters. */
export function parseSenderPictureMask(mask: string): Omit<SenderPictureSettings, "enabled"> | null {
	if (!/^[01]{4}$/.test(mask)) return null;
	return {
		brandLogos: mask[0] === "1",
		websiteIcons: mask[1] === "1",
		gravatar: mask[2] === "1",
		generated: mask[3] === "1",
	};
}

/** Where a picture came from. Sent back in a response header, for support. */
export type SenderPictureSource = "bimi-certified" | "bimi" | "favicon" | "gravatar" | "generated";

/**
 * The URL of a sender's picture, or null when pictures are off or there is no
 * usable address. `verified` is the stored authentication verdict of the
 * message being drawn: without it only a generated face is ever returned.
 */
export function senderPictureUrl(
	address: string | null | undefined,
	verified: boolean,
	settings: SenderPictureSettings,
): string | null {
	if (!settings.enabled) return null;
	const clean = normalizeAddress(address);
	if (!clean) return null;
	const anySource = settings.brandLogos || settings.websiteIcons || settings.gravatar || settings.generated;
	if (!anySource) return null;
	// With no verdict only the generated face applies; skip the request when
	// that is off too.
	if (!verified && !settings.generated) return null;
	const params = new URLSearchParams({ a: clean, m: senderPictureMask(settings) });
	if (verified) params.set("v", "1");
	return `/api/v1/sender-picture?${params.toString()}`;
}

/** Lowercased `local@domain`, or "" when the text is not one address. */
export function normalizeAddress(address: string | null | undefined): string {
	const text = (address ?? "").trim().toLowerCase();
	if (text.length > 320 || /\s/.test(text)) return "";
	const at = text.lastIndexOf("@");
	if (at <= 0 || at === text.length - 1) return "";
	const domain = text.slice(at + 1);
	if (!/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(domain) || domain.includes("..")) return "";
	return text;
}

export function domainOf(address: string): string {
	return address.slice(address.lastIndexOf("@") + 1);
}

/**
 * Mailbox providers whose domain says nothing about the sender. A logo or a
 * website icon for these would put Google's "G" on every Gmail user, so they
 * skip straight to the person's own picture.
 */
const FREE_MAIL = new Set([
	"gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
	"yahoo.com", "ymail.com", "rocketmail.com", "yahoo.co.uk", "yahoo.co.in", "yahoo.in",
	"icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me",
	"zoho.com", "zohomail.com", "zohomail.in", "gmx.com", "gmx.net", "gmx.de", "web.de",
	"mail.com", "yandex.com", "yandex.ru", "mail.ru", "fastmail.com", "fastmail.fm",
	"hey.com", "tutanota.com", "tuta.io", "tuta.com", "rediffmail.com", "qq.com", "163.com",
	"126.com", "naver.com", "hotmail.co.uk", "hotmail.fr", "live.co.uk", "outlook.in",
	"duck.com", "skiff.com", "hushmail.com", "comcast.net", "verizon.net", "att.net",
	"btinternet.com", "orange.fr", "free.fr", "t-online.de", "libero.it",
]);

export function isFreeMailDomain(domain: string): boolean {
	return FREE_MAIL.has(domain.trim().toLowerCase());
}

// ── DNS records ───────────────────────────────────────────────────

export interface BimiRecord {
	/** `l=`: where the SVG logo is. Always https. */
	logoUrl: string;
	/** `a=`: where the mark certificate is, when the brand has one. */
	certificateUrl: string | null;
}

function tags(record: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const part of record.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		const key = part.slice(0, eq).trim().toLowerCase();
		if (key && !out.has(key)) out.set(key, part.slice(eq + 1).trim());
	}
	return out;
}

function httpsUrl(value: string | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" ? url.toString() : null;
	} catch {
		return null;
	}
}

/**
 * Read a `default._bimi` TXT record. Null for anything that is not a BIMI
 * record with an https logo, including the "no logo" record (`l=` empty) a
 * brand publishes to opt out.
 */
export function parseBimiRecord(txt: string): BimiRecord | null {
	const t = tags(txt);
	if ((t.get("v") ?? "").toUpperCase() !== "BIMI1") return null;
	const logoUrl = httpsUrl(t.get("l"));
	if (!logoUrl) return null;
	return { logoUrl, certificateUrl: httpsUrl(t.get("a")) };
}

/**
 * Whether a `_dmarc` TXT record enforces: `p=quarantine` or `p=reject`, not
 * limited to a sample of mail. BIMI asks for this, and it is what makes a
 * domain's logo mean anything: with `p=none` anyone can send as the domain.
 */
export function dmarcEnforces(txt: string): boolean {
	const t = tags(txt);
	if ((t.get("v") ?? "").toUpperCase() !== "DMARC1") return false;
	const policy = (t.get("p") ?? "").toLowerCase();
	if (policy !== "quarantine" && policy !== "reject") return false;
	const pct = t.get("pct");
	return pct === undefined || pct === "100";
}

/** Largest logo accepted. The BIMI guidance is 32 KB; real ones run larger. */
export const SVG_LOGO_MAX_BYTES = 256 * 1024;

/**
 * Whether an SVG is safe to hand to an `<img>`. An image element never runs
 * script or loads sub-resources, and the response carries a sandbox policy as
 * well, so this is a third layer: it refuses anything a logo has no use for.
 */
export function isSafeSvgLogo(svg: string): boolean {
	if (svg.length > SVG_LOGO_MAX_BYTES) return false;
	if (!/<svg[\s>]/i.test(svg)) return false;
	if (/<\s*(script|foreignObject|iframe|embed|object|audio|video|image|use\s[^>]*href\s*=\s*["']?https?:)/i.test(svg)) {
		return false;
	}
	if (/\son[a-z]+\s*=/i.test(svg)) return false;
	if (/javascript:/i.test(svg)) return false;
	if (/<!ENTITY/i.test(svg)) return false;
	return true;
}
