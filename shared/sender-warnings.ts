// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Reader warnings for inbound mail: the impersonation patterns a person falls
 * for, in words a person can act on.
 *
 * The spam score already notices some of these, but a score decides a folder.
 * A phishing message that passes DMARC from a lookalike domain lands in the
 * inbox with a perfect score, and that is exactly the message the reader needs
 * to be told about.
 *
 * Computed once at delivery by the Worker (which has the contacts, the domain
 * list and the public-suffix list), stored on the row as JSON, and read back by
 * the reading pane, the list and the MCP `get_email` tool, so all three agree.
 * Pure: everything it knows arrives in `SenderWarningInput`.
 */

import {
	findLookalike,
	isRealHostname,
	normalizeHost,
	registrableDomain,
	sameOrganization,
	toUnicodeHost,
	type LookalikeMatch,
} from "./domain-safety";

import type { SenderWarning } from "./sender-warning-types";

export * from "./sender-warning-types";

export interface SenderWarningInput {
	/** Envelope/header From address. */
	from: string;
	fromName?: string | null;
	/** HTML body if present, else text. Used for link-mismatch detection. */
	html?: string | null;
	/** Domains this deployment owns (mailbox domains). */
	ownDomains: readonly string[];
	/** Addresses of this deployment's own mailboxes. */
	ownMailboxes: readonly string[];
	/**
	 * Display names that belong to known people, keyed by lowercased name, with
	 * the addresses that legitimately use them: the mailboxes' own send names
	 * and the names of frequent correspondents.
	 */
	knownNames: ReadonlyMap<string, readonly string[]>;
	/** Domains of frequent correspondents, for lookalike comparison. */
	frequentDomains: readonly string[];
	/**
	 * Whether this mailbox has any history with the sender: mail received from
	 * them before, or mail sent to them.
	 */
	hasHistory: boolean;
	/** Whether the message continues a thread the mailbox already has. */
	inKnownThread?: boolean;
}

function domainOf(address: string): string {
	const at = address.lastIndexOf("@");
	return at === -1 ? "" : normalizeHost(address.slice(at + 1));
}

const ADDRESS_RE = /[\w.+-]+@((?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]{2,})/u;
const DOMAIN_RE = /(?:^|[\s(<"'[])((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}]{2,63})(?=$|[\s)>"'\].,:;!?/])/u;

/** Collapse a display name for comparison: case, spacing and quotes. */
export function normalizeDisplayName(name: string): string {
	return name
		.normalize("NFKC")
		.toLowerCase()
		.replace(/["'`]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Display-name spoofing.
 *
 * Two shapes:
 * - The name carries an address or domain unrelated to the real sender:
 *   `"support@paypal.com" <x@evil.test>` or `"PayPal.com" <x@evil.test>`.
 * - The name is one the reader already knows from a different address: their
 *   own mailbox's send name, or a regular correspondent's. This is CEO fraud:
 *   `"Jane Smith (CEO)" <jane.smith.ceo@gmail.com>`.
 */
export function detectDisplayNameSpoof(input: Pick<SenderWarningInput, "from" | "fromName" | "knownNames" | "ownMailboxes">): SenderWarning | null {
	const name = (input.fromName ?? "").trim();
	const from = input.from.trim().toLowerCase();
	const fromDomain = domainOf(from);
	if (!name || !from) return null;

	const embeddedAddress = ADDRESS_RE.exec(name);
	if (embeddedAddress) {
		const shown = normalizeHost(embeddedAddress[1]!);
		if (embeddedAddress[0].toLowerCase() !== from && !sameOrganization(shown, fromDomain)) {
			return {
				kind: "display_name_spoof",
				message: `The sender's name shows ${embeddedAddress[0]}, but the message came from ${from}.`,
				detail: { shown: embeddedAddress[0], actual: from },
			};
		}
	}

	if (!embeddedAddress) {
		const embeddedDomain = DOMAIN_RE.exec(` ${name} `);
		if (embeddedDomain && isRealHostname(embeddedDomain[1]!)) {
			const shown = normalizeHost(embeddedDomain[1]!);
			if (!sameOrganization(shown, fromDomain)) {
				return {
					kind: "display_name_spoof",
					message: `The sender's name says ${shown}, but the message came from ${fromDomain || from}.`,
					detail: { shown, actual: from },
				};
			}
		}
	}

	const normalized = normalizeDisplayName(name.replace(/\s*\([^)]*\)\s*$/, ""));
	if (normalized.length >= 3) {
		const legit = input.knownNames.get(normalized);
		// Another address at the same organisation is not impersonation:
		// "Cloudflare" writes from both connectevent@cloudflare.com and
		// noreply@notify.cloudflare.com. A lookalike domain is caught separately.
		const sameOrg = legit?.some((a) => sameOrganization(domainOf(a), fromDomain)) ?? false;
		if (legit && legit.length > 0 && !sameOrg && !legit.map((a) => a.toLowerCase()).includes(from)) {
			const own = legit.some((a) => input.ownMailboxes.map((m) => m.toLowerCase()).includes(a.toLowerCase()));
			return {
				kind: "display_name_spoof",
				message: own
					? `"${name}" is the name one of your own mailboxes sends as, but this came from ${from}.`
					: `"${name}" usually writes from ${legit[0]}, but this came from ${from}.`,
				detail: { name, actual: from, usual: legit[0]! },
			};
		}
	}
	return null;
}

function lookalikeMessage(match: LookalikeMatch, host: string): string {
	switch (match.reason) {
		case "homograph":
			return match.imitates
				? `${host} is written with look-alike characters to resemble ${match.imitates}.`
				: `${host} uses characters from another alphabet that imitate Latin letters.`;
		case "mixed_script":
			return `${host} mixes letters from different alphabets, a common way to imitate a familiar domain.`;
		case "typo":
			return `${host} is one or two letters away from ${match.imitates}.`;
		case "suffix_swap":
			return `${host} has the same name as ${match.imitates} but a different ending.`;
		case "embedded":
			return `${host} puts ${match.imitates} in front of an unrelated domain.`;
	}
}

/** Lookalike or homograph sender domain. */
export function detectLookalikeSender(input: Pick<SenderWarningInput, "from" | "ownDomains" | "frequentDomains">): SenderWarning | null {
	const domain = domainOf(input.from);
	if (!domain) return null;
	const match = findLookalike(domain, [...input.ownDomains, ...input.frequentDomains]);
	if (!match) return null;
	const shown = match.display === domain ? domain : `${match.display} (${domain})`;
	return {
		kind: "lookalike_domain",
		message: lookalikeMessage(match, shown),
		detail: {
			domain,
			reason: match.reason,
			...(match.imitates ? { imitates: match.imitates } : {}),
			...(match.display !== domain ? { decoded: match.display } : {}),
		},
	};
}

/** First message from an address this mailbox has never dealt with. */
export function detectFirstTimeSender(input: Pick<SenderWarningInput, "from" | "hasHistory" | "inKnownThread" | "ownDomains">): SenderWarning | null {
	if (input.hasHistory || input.inKnownThread) return null;
	const from = input.from.trim().toLowerCase();
	if (!from) return null;
	// Colleagues on our own domains are not strangers.
	if (input.ownDomains.some((d) => sameOrganization(d, domainOf(from)))) return null;
	return {
		kind: "first_time_sender",
		message: `This is the first message from ${from}.`,
		detail: { address: from },
	};
}

// ── Link mismatch ────────────────────────────────────────────────────

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
		if (code[0] === "#") {
			const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
			try {
				return Number.isFinite(n) ? String.fromCodePoint(n) : m;
			} catch {
				return m;
			}
		}
		return ENTITY[code.toLowerCase()] ?? m;
	});
}

export interface LinkMismatch {
	/** Domain the anchor text shows. */
	shown: string;
	/** Domain the link actually opens. */
	actual: string;
}

/** The hostname anchor text presents itself as, or null when it is not a URL/domain. */
function hostShownBy(text: string): string | null {
	const t = text.trim().replace(/[\s​]+/g, " ");
	if (!t || t.length > 200) return null;
	const url = /^(?:https?:\/\/)?((?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,63})(?::\d+)?(?:[/?#][^\s]*)?$/iu.exec(t);
	if (url && (/^https?:\/\//i.test(t) || isRealHostname(url[1]!))) return normalizeHost(url[1]!);
	return null;
}

function hrefHost(href: string): string | null {
	try {
		const u = new URL(decodeEntities(href).trim());
		if (u.protocol !== "http:" && u.protocol !== "https:") return null;
		return normalizeHost(u.hostname);
	} catch {
		return null;
	}
}

/**
 * Anchors whose visible text is a URL or domain different from where they go.
 *
 * Only text that *looks like a destination* counts. "Click here" pointing
 * anywhere is normal; "www.paypal.com" pointing at `evil.test` is the attack.
 * Tracking redirects make legitimate newsletters trip this too, which is why it
 * is a warning and not a spam signal.
 */
export function findLinkMismatches(html: string | null | undefined, limit = 5): LinkMismatch[] {
	if (!html) return [];
	const found: LinkMismatch[] = [];
	const seen = new Set<string>();
	const re = /<a\b[^>]*?\shref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi;
	for (const m of html.matchAll(re)) {
		const actual = hrefHost(m[2]!);
		if (!actual) continue;
		const text = decodeEntities(m[3]!.replace(/<[^>]*>/g, ""));
		const shown = hostShownBy(text);
		if (!shown) continue;
		if (sameOrganization(shown, actual)) continue;
		const key = `${registrableDomain(shown)}>${registrableDomain(actual)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		found.push({ shown, actual });
		if (found.length >= limit) break;
	}
	return found;
}

export function detectLinkMismatch(input: Pick<SenderWarningInput, "html">): SenderWarning | null {
	const mismatches = findLinkMismatches(input.html);
	if (mismatches.length === 0) return null;
	const first = mismatches[0]!;
	const more = mismatches.length > 1 ? ` (and ${mismatches.length - 1} more)` : "";
	return {
		kind: "link_mismatch",
		message: `A link shows ${toUnicodeHost(first.shown)} but opens ${toUnicodeHost(first.actual)}${more}.`,
		detail: { shown: first.shown, actual: first.actual, count: String(mismatches.length) },
	};
}

/** Every warning that applies, most serious first. */
export function assessSenderWarnings(input: SenderWarningInput): SenderWarning[] {
	return [
		detectLookalikeSender(input),
		detectDisplayNameSpoof(input),
		detectLinkMismatch(input),
		detectFirstTimeSender(input),
	].filter((w): w is SenderWarning => w !== null);
}
