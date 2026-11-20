// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Senders whose remote images may load without being asked each time.
 *
 * Blocking remote images by default is the right call — a bare `<img src>` in a
 * newsletter is usually a tracking pixel — but "click Show images, every time,
 * on every message" turns a one-off trust decision into a recurring chore. The
 * reader has already decided they trust Devpost's newsletter; the app should
 * remember that instead of asking again.
 *
 * The grammar is deliberately the same as blocked/allowed senders: a full
 * address (`support@devpost.com`) or a domain suffix (`@devpost.com`). Same
 * strings the user already sees in those lists, so one mental model covers all
 * three, and the settings input accepts what they'd expect it to.
 *
 * Domain rules match the domain *exactly*, not its subdomains, which mirrors
 * `matchPatternsFor` in the Durable Object. Widening `@devpost.com` to cover
 * `news.devpost.com` would silently trust hosts the reader never saw and never
 * approved, and trust that grows on its own is the one property a
 * tracking-protection control must not have.
 *
 * Pure functions, no store and no React, so the matching rules are testable on
 * their own.
 */

/** A rule as stored: `sam@example.com` or `@example.com`, lowercased. */
export type RemoteImagePattern = string;

/**
 * Bare address out of a From header.
 *
 * Headers arrive as either `Name <addr@host>` or a raw address, and comparing
 * the display-name form against a stored address would never match.
 */
export function senderAddress(sender: string | null | undefined): string {
	const value = (sender ?? "").trim();
	if (!value) return "";
	const angled = value.match(/<([^>]+)>/);
	return (angled ? angled[1] : value).trim().toLowerCase();
}

/**
 * Domain suffix for a sender, in rule form (`@example.com`).
 *
 * Empty when the address has no domain, which keeps callers from offering an
 * "always for this domain" option that could never match anything.
 */
export function senderDomainPattern(sender: string | null | undefined): string {
	const address = senderAddress(sender);
	const at = address.lastIndexOf("@");
	if (at === -1) return "";
	const domain = address.slice(at + 1);
	return domain ? `@${domain}` : "";
}

/**
 * Coerce free text into a storable pattern, or null when it isn't one.
 *
 * Accepts more shapes than it stores, because the settings field is typed into
 * by hand: a display-name form gets unwrapped, a bare `example.com` is read as
 * the domain rule the user clearly meant, and a stray leading `*` (as in
 * `*@example.com`) is dropped rather than saved as a rule that silently matches
 * nothing.
 */
export function normalizeRemoteImagePattern(value: string): string | null {
	let candidate = value.trim().toLowerCase();
	if (!candidate) return null;

	const angled = candidate.match(/<([^>]+)>/);
	if (angled) candidate = angled[1].trim();

	// `*@example.com` and `*.example.com` are both attempts at "the whole
	// domain", which this grammar spells `@example.com`. Stripping the leading
	// asterisks covers both: what's left is either `@example.com` or a bare
	// `example.com`, and the bare form is read as a domain rule below.
	candidate = candidate.replace(/^\*+\.?/, "");

	if (!candidate || /\s/.test(candidate)) return null;

	const at = candidate.lastIndexOf("@");

	// No `@` at all: read it as a domain. Requiring a dot keeps typos like
	// "devpost" out of the list, where they would sit looking effective.
	if (at === -1) {
		return candidate.includes(".") ? `@${candidate}` : null;
	}

	const local = candidate.slice(0, at);
	const domain = candidate.slice(at + 1);
	if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith("."))
		return null;
	// Split on the *last* `@`, so a second one can only be in the local part —
	// `a@b@example.com` is not an address, and storing it would be a rule that
	// never fires.
	if (local.includes("@")) return null;

	return local ? `${local}@${domain}` : `@${domain}`;
}

/** True when one stored pattern covers this sender. */
export function patternMatchesSender(
	pattern: RemoteImagePattern,
	sender: string | null | undefined,
): boolean {
	const normalized = pattern.trim().toLowerCase();
	if (!normalized) return false;

	const address = senderAddress(sender);
	if (!address) return false;

	if (normalized.startsWith("@")) {
		return senderDomainPattern(address) === normalized;
	}
	return address === normalized;
}

/**
 * Whether this sender's remote images may load without asking.
 *
 * Both sides are normalised on every check rather than trusting the stored
 * list: these patterns live in `localStorage`, so a value written by an older
 * build or edited by hand can arrive in any case. Comparing raw would show up
 * as a rule that is visibly listed in settings and quietly does nothing.
 */
export function allowsRemoteImages(
	patterns: RemoteImagePattern[],
	sender: string | null | undefined,
): boolean {
	return patterns.some((pattern) => patternMatchesSender(pattern, sender));
}

/** The patterns in the list that cover this sender, for showing what applied. */
export function matchingPatterns(
	patterns: RemoteImagePattern[],
	sender: string | null | undefined,
): RemoteImagePattern[] {
	return patterns.filter((pattern) => patternMatchesSender(pattern, sender));
}

/**
 * Add a pattern, de-duplicating and keeping the list sorted.
 *
 * Returns the original array when nothing changed, so a repeated "always for
 * this sender" doesn't re-render every subscriber.
 */
export function addRemoteImagePattern(
	patterns: RemoteImagePattern[],
	value: string,
): RemoteImagePattern[] {
	const normalized = normalizeRemoteImagePattern(value);
	if (!normalized) return patterns;

	const existing = patterns.map((p) => p.trim().toLowerCase());
	if (existing.includes(normalized)) return patterns;

	return [...existing, normalized].sort(comparePatterns);
}

/** Remove a pattern. Returns the original array when it wasn't there. */
export function removeRemoteImagePattern(
	patterns: RemoteImagePattern[],
	value: string,
): RemoteImagePattern[] {
	const target = value.trim().toLowerCase();
	const next = patterns.filter((p) => p.trim().toLowerCase() !== target);
	return next.length === patterns.length ? patterns : next;
}

/**
 * Replace one pattern with another, in place.
 *
 * Editing rather than delete-then-add so a typo fix keeps its position in the
 * list, and so an edit to something invalid leaves the original alone instead of
 * dropping it.
 */
export function replaceRemoteImagePattern(
	patterns: RemoteImagePattern[],
	from: string,
	to: string,
): RemoteImagePattern[] {
	const normalized = normalizeRemoteImagePattern(to);
	if (!normalized) return patterns;

	const target = from.trim().toLowerCase();
	if (!patterns.some((p) => p.trim().toLowerCase() === target)) return patterns;

	const withoutTarget = patterns.filter(
		(p) => p.trim().toLowerCase() !== target,
	);
	return addRemoteImagePattern(withoutTarget, normalized);
}

/**
 * Domain rules first, then alphabetically.
 *
 * A domain rule subsumes any address rule under it, so listing them together at
 * the top is what makes an entry like `support@devpost.com` sitting below
 * `@devpost.com` legible as redundant rather than mysterious.
 */
function comparePatterns(a: string, b: string): number {
	const aDomain = a.startsWith("@");
	const bDomain = b.startsWith("@");
	if (aDomain !== bDomain) return aDomain ? -1 : 1;
	return a.localeCompare(b);
}

/** Human label for a rule, for banners and confirmation copy. */
export function describePattern(pattern: RemoteImagePattern): string {
	return pattern.startsWith("@")
		? `everyone at ${pattern.slice(1)}`
		: pattern;
}
