// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Which mailboxes the dashboard shows.
 *
 * A deployment can serve a dozen addresses — support@, billing@, a personal
 * one, a couple of aliases nobody reads — and until now every screen listed all
 * of them with no way to narrow it down. The domain selector looked like it
 * might help but does something else: it filters by zone, single-select, and it
 * is a property of the deployment rather than a preference.
 *
 * The state is stored as the set of mailboxes to HIDE, not the set to show.
 * That inversion is the important decision here: a mailbox created after the
 * preference was saved has to appear on its own, because the alternative is mail
 * arriving somewhere the user cannot see and has no reason to suspect exists.
 * Storing an allowlist would make every new address invisible by default, and
 * "why am I not getting mail" is a much worse failure than a list that is one
 * row longer than someone wanted.
 *
 * Kept as pure functions so the rules are testable without a store or a render.
 */

/** The minimum this module needs to know about a mailbox. */
export interface VisibilityCandidate {
	id: string;
}

/** Ids compare case-insensitively: a mailbox id is an email address. */
function normalize(id: string): string {
	return id.trim().toLowerCase();
}

/**
 * Both sides are normalised, not just the id being looked up.
 *
 * The store only ever writes lowercase, so this is about what arrives from
 * `localStorage`: a value written by an older build or edited by hand. Comparing
 * a normalised id against a raw list would silently stop matching, which shows
 * up as a checkbox that ticks but changes nothing.
 */
export function isMailboxHidden(hidden: string[], id: string): boolean {
	const target = normalize(id);
	return hidden.some((entry) => normalize(entry) === target);
}

/**
 * Filter a mailbox list down to what should be on screen.
 *
 * `alwaysInclude` is the mailbox currently open. Hiding the one you are looking
 * at would empty the switcher and leave no way back to it, so an open mailbox
 * stays listed however the preference is set — the checkbox reflects the
 * preference, the list reflects reality.
 */
export function visibleMailboxes<T extends VisibilityCandidate>(
	mailboxes: T[],
	hidden: string[],
	alwaysInclude?: string,
): T[] {
	const keep = alwaysInclude ? normalize(alwaysInclude) : null;
	const visible = mailboxes.filter(
		(box) => !isMailboxHidden(hidden, box.id) || normalize(box.id) === keep,
	);

	// Hiding everything leaves a dashboard with nothing on it and no obvious way
	// out, which reads as a broken app rather than a setting. `toggleMailboxHidden`
	// refuses to get here, but a preference saved before a mailbox was deleted can
	// arrive in this state on its own.
	return visible.length > 0 ? visible : mailboxes;
}

/**
 * Add or remove a mailbox from the hidden set.
 *
 * Refuses to hide the last visible mailbox: there would be nothing left to look
 * at, and no row still on screen whose checkbox could undo it.
 */
export function toggleMailboxHidden<T extends VisibilityCandidate>(
	hidden: string[],
	mailboxes: T[],
	id: string,
): string[] {
	const target = normalize(id);

	if (isMailboxHidden(hidden, target)) {
		return hidden.filter((entry) => normalize(entry) !== target);
	}

	const remaining = mailboxes.filter(
		(box) => normalize(box.id) !== target && !isMailboxHidden(hidden, box.id),
	);
	if (remaining.length === 0) return hidden;

	return [...hidden, target];
}

/**
 * Whether hiding this mailbox is allowed, for disabling its checkbox.
 *
 * Mirrors `toggleMailboxHidden` rather than reimplementing the rule, so a
 * control can never offer a toggle the store will then ignore.
 */
export function canHideMailbox<T extends VisibilityCandidate>(
	hidden: string[],
	mailboxes: T[],
	id: string,
): boolean {
	if (isMailboxHidden(hidden, id)) return true;
	return toggleMailboxHidden(hidden, mailboxes, id) !== hidden;
}

/**
 * Drop ids that no longer exist.
 *
 * Without this a deleted mailbox's id lingers in the preference forever, and a
 * later mailbox reusing that address — recreating `support@` after deleting it —
 * would come back invisible for no reason the user could see.
 */
export function pruneHidden<T extends VisibilityCandidate>(
	hidden: string[],
	mailboxes: T[],
): string[] {
	const known = new Set(mailboxes.map((box) => normalize(box.id)));
	return hidden.filter((id) => known.has(normalize(id)));
}
