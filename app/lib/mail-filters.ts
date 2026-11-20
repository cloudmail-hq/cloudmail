// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The list's filter and sort state, and its translation to query params.
 *
 * Kept out of the components so the folder and label views cannot disagree on
 * what "unread" serialises to. The Worker reads these flags as opt-in — see
 * `toParams` in `app/services/api.ts`, which drops `false` — so the encoder here
 * only ever emits a key when the filter is actually on.
 */

export type MailSortKey = "date" | "subject" | "sender";
export type MailSortDirection = "ASC" | "DESC";

export interface MailListFilters {
	unread: boolean;
	starred: boolean;
	hasAttachment: boolean;
	sortKey: MailSortKey;
	sortDirection: MailSortDirection;
}

export const DEFAULT_MAIL_FILTERS: MailListFilters = {
	unread: false,
	starred: false,
	hasAttachment: false,
	sortKey: "date",
	sortDirection: "DESC",
};

/**
 * The direction each sort key should take when first selected.
 *
 * Newest-first is what people want from a date sort; A→Z is what they want from
 * a name. Picking a key resets to its natural direction so one click gives the
 * expected order, and the direction toggle can still override it.
 */
export const NATURAL_DIRECTION: Record<MailSortKey, MailSortDirection> = {
	date: "DESC",
	subject: "ASC",
	sender: "ASC",
};

export const SORT_LABELS: Record<MailSortKey, string> = {
	date: "Date",
	subject: "Subject",
	sender: "Sender",
};

/** True when anything is narrowing the list, i.e. a Clear button is worth showing. */
export function hasActiveFilters(filters: MailListFilters): boolean {
	return filters.unread || filters.starred || filters.hasAttachment;
}

/** True when the whole state is at its defaults, sort included. */
export function isDefaultFilters(filters: MailListFilters): boolean {
	return (
		!hasActiveFilters(filters) &&
		filters.sortKey === DEFAULT_MAIL_FILTERS.sortKey &&
		filters.sortDirection === DEFAULT_MAIL_FILTERS.sortDirection
	);
}

/**
 * Encode filters as query params for the emails endpoint.
 *
 * Only truthy filters are emitted: `?unread=false` would arrive at the Worker
 * as a non-empty string and read as "on".
 */
export function filtersToParams(
	filters: MailListFilters,
): Record<string, string> {
	const params: Record<string, string> = {
		sortColumn: filters.sortKey,
		sortDirection: filters.sortDirection,
	};
	if (filters.unread) params.unread = "true";
	if (filters.starred) params.starred = "true";
	if (filters.hasAttachment) params.has_attachment = "true";
	return params;
}

/**
 * A stable identity for the current filter set.
 *
 * Used as part of the list's collection key so changing a filter resets
 * pagination — page 4 of an unfiltered inbox is usually past the end of the
 * filtered one, which would otherwise render an empty list with no explanation.
 */
export function filtersKey(filters: MailListFilters): string {
	return [
		filters.unread ? "u" : "",
		filters.starred ? "s" : "",
		filters.hasAttachment ? "a" : "",
		filters.sortKey,
		filters.sortDirection,
	].join(":");
}

/** Select a sort key, adopting its natural direction. */
export function withSortKey(
	filters: MailListFilters,
	sortKey: MailSortKey,
): MailListFilters {
	return { ...filters, sortKey, sortDirection: NATURAL_DIRECTION[sortKey] };
}

/** Flip the current direction, leaving the key alone. */
export function withToggledDirection(
	filters: MailListFilters,
): MailListFilters {
	return {
		...filters,
		sortDirection: filters.sortDirection === "ASC" ? "DESC" : "ASC",
	};
}

/** Clear the narrowing filters, keeping the chosen sort. */
export function withFiltersCleared(
	filters: MailListFilters,
): MailListFilters {
	return {
		...filters,
		unread: false,
		starred: false,
		hasAttachment: false,
	};
}
