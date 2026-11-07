// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Person-centric inbox aggregation.
 *
 * The storage model is mailbox-centric: one Durable Object per mailbox
 * address, each holding that mailbox's messages. The person-centric inbox
 * inverts that — it groups by *counterparty* and therefore has to span every
 * mailbox the deployment serves.
 *
 * Each DO can only aggregate its own rows, so the cross-mailbox merge, sort,
 * filter and pagination all happen here, in pure functions, shared by the
 * Worker and the frontend.
 */

/** Per-mailbox aggregate for one counterparty, as returned by a MailboxDO. */
export interface MailboxPersonRow {
	/** Counterparty address, already lowercased by the DO query. */
	email: string;
	/** Raw `From` header of that person's most recent message, if stored. */
	fromHeader: string | null;
	/** ISO 8601 date of their most recent message in this mailbox. */
	lastEmailAt: string | null;
	unreadCount: number;
	totalCount: number;
	/** 1 when any of their messages in this mailbox carries an attachment. */
	hasAttachment: number;
}

/** One counterparty, merged across every mailbox they have written to. */
export interface GroupedPerson {
	type: "person";
	/** Stable identity: the lowercased counterparty address. */
	id: string;
	email: string;
	name: string | null;
	/** Unix seconds. The UI formats relative times from this. */
	lastEmailAt: number;
	unreadCount: number;
	totalCount: number;
	/** How many of our mailboxes this person has written to. */
	recipientCount: number;
	/** Which of our mailboxes they have written to. */
	recipients: string[];
	hasAttachment: number;
}

export interface PeopleFilters {
	search?: string;
	unread?: boolean;
	hasAttachment?: boolean;
	/** Narrow to people who wrote to this mailbox address. */
	recipient?: string;
}

export type PeopleSortKey = "recency" | "unread" | "inbox" | "attachments";
export type SortDirection = "asc" | "desc";

export interface PeopleSortSpec {
	key: PeopleSortKey;
	direction: SortDirection;
}

/**
 * Display name from a `From` header.
 *
 * Inbound mail stores `sender` as a bare lowercased address, so the friendly
 * name only survives in the raw headers. Returns null when the header carries
 * no name, or when the "name" is just the address repeated — showing
 * `a@b.com <a@b.com>` as a display name is noise.
 */
export function parseDisplayName(fromHeader: string | null | undefined): string | null {
	if (!fromHeader) return null;

	const trimmed = fromHeader.trim();
	if (!trimmed) return null;

	// `Display Name <addr@host>` — take everything before the angle bracket.
	const angle = trimmed.indexOf("<");
	const raw = angle > 0 ? trimmed.slice(0, angle) : "";

	// Strip surrounding quotes and collapse internal whitespace.
	const name = raw
		.trim()
		.replace(/^["']|["']$/g, "")
		.replace(/\s+/g, " ")
		.trim();

	if (!name) return null;

	// A name that is itself an address adds nothing over the address we show.
	if (name.includes("@") && !name.includes(" ")) return null;

	return name;
}

/** Unix seconds from an ISO date, or 0 when absent/unparseable. */
function toEpochSeconds(iso: string | null | undefined): number {
	if (!iso) return 0;
	const ms = new Date(iso).getTime();
	return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

/**
 * Merge per-mailbox aggregates into one row per person.
 *
 * Counts sum, recency takes the maximum, and `recipients` becomes the set of
 * our mailboxes that person has written to — which is what drives the
 * "N inboxes" badge and the recipient filter.
 */
export function mergePeople(
	perMailbox: { mailbox: string; people: MailboxPersonRow[] }[],
): GroupedPerson[] {
	// Track the newest row per person so the display name comes from their
	// most recent message rather than whichever mailbox sorted first.
	const merged = new Map<
		string,
		{ person: GroupedPerson; newestHeaderAt: number; fromHeader: string | null }
	>();

	for (const { mailbox, people } of perMailbox) {
		for (const row of people) {
			const email = row.email.trim().toLowerCase();
			if (!email) continue;

			const lastEmailAt = toEpochSeconds(row.lastEmailAt);
			const existing = merged.get(email);

			if (!existing) {
				merged.set(email, {
					newestHeaderAt: lastEmailAt,
					fromHeader: row.fromHeader,
					person: {
						type: "person",
						id: email,
						email,
						name: parseDisplayName(row.fromHeader),
						lastEmailAt,
						unreadCount: row.unreadCount,
						totalCount: row.totalCount,
						recipientCount: 1,
						recipients: [mailbox],
						hasAttachment: row.hasAttachment ? 1 : 0,
					},
				});
				continue;
			}

			const p = existing.person;
			p.unreadCount += row.unreadCount;
			p.totalCount += row.totalCount;
			p.lastEmailAt = Math.max(p.lastEmailAt, lastEmailAt);
			p.hasAttachment = p.hasAttachment || (row.hasAttachment ? 1 : 0);

			if (!p.recipients.includes(mailbox)) {
				p.recipients.push(mailbox);
				p.recipientCount = p.recipients.length;
			}

			if (lastEmailAt >= existing.newestHeaderAt) {
				existing.newestHeaderAt = lastEmailAt;
				existing.fromHeader = row.fromHeader;
				p.name = parseDisplayName(row.fromHeader) ?? p.name;
			}
		}
	}

	for (const entry of merged.values()) {
		entry.person.recipients.sort();
	}

	return [...merged.values()].map((entry) => entry.person);
}

/** Apply search and the toolbar's filters. */
export function filterPeople(
	people: GroupedPerson[],
	filters: PeopleFilters = {},
): GroupedPerson[] {
	let result = people;

	const search = filters.search?.trim().toLowerCase();
	if (search) {
		result = result.filter(
			(p) =>
				p.email.toLowerCase().includes(search) ||
				(p.name?.toLowerCase().includes(search) ?? false),
		);
	}

	if (filters.unread) result = result.filter((p) => p.unreadCount > 0);
	if (filters.hasAttachment) result = result.filter((p) => p.hasAttachment === 1);

	if (filters.recipient) {
		const recipient = filters.recipient.toLowerCase();
		result = result.filter((p) =>
			p.recipients.some((r) => r.toLowerCase() === recipient),
		);
	}

	return result;
}

/**
 * Sort people for the list. Ties always fall back to recency so ordering is
 * stable and predictable when counts match.
 */
export function sortPeople(
	people: GroupedPerson[],
	spec: PeopleSortSpec = { key: "recency", direction: "desc" },
): GroupedPerson[] {
	const factor = spec.direction === "asc" ? -1 : 1;

	const primary = (p: GroupedPerson): number => {
		switch (spec.key) {
			case "unread":
				return p.unreadCount;
			case "inbox":
				return p.recipientCount;
			case "attachments":
				return p.hasAttachment;
			case "recency":
			default:
				return p.lastEmailAt;
		}
	};

	// Copy: callers pass cached query data that must not be mutated.
	return [...people].sort((a, b) => {
		const diff = primary(b) - primary(a);
		if (diff !== 0) return diff * factor;
		return (b.lastEmailAt - a.lastEmailAt) * factor;
	});
}

export interface Page<T> {
	items: T[];
	total: number;
	page: number;
	pageSize: number;
}

/** Clamp `page` into range and slice. Pages are 1-based. */
export function paginate<T>(items: T[], page: number, pageSize: number): Page<T> {
	const size = Math.max(1, pageSize);
	const totalPages = Math.max(1, Math.ceil(items.length / size));
	const current = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
	const start = (current - 1) * size;

	return {
		items: items.slice(start, start + size),
		total: items.length,
		page: current,
		pageSize: size,
	};
}
