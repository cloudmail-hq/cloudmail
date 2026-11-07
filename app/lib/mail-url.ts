// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The parts of the mail view that live in the URL: the open message (`?m=`)
 * and the list filters and sort (`?unread=1&starred=1&attach=1&sort=subject&dir=asc`).
 *
 * In the URL so a message can be linked, reloaded and bookmarked, and so the
 * browser's Back closes the reader on a phone instead of leaving the app.
 * Pure string work here; `useMailUrlSync` wires it to the router and store.
 */

import {
	DEFAULT_MAIL_FILTERS,
	type MailListFilters,
	type MailSortDirection,
	type MailSortKey,
	NATURAL_DIRECTION,
} from "./mail-filters";

/** Query key for the open message. */
export const MESSAGE_PARAM = "m";

const FILTER_KEYS = ["unread", "starred", "attach", "sort", "dir"] as const;
const SORT_KEYS: readonly MailSortKey[] = ["date", "subject", "sender"];

/** Ids are opaque but bounded; anything else in `?m=` is ignored. */
const ID_PATTERN = /^[A-Za-z0-9._:@+-]{1,200}$/;

/** The open message id from a query string, or null. */
export function readSelectedId(params: URLSearchParams): string | null {
	const raw = params.get(MESSAGE_PARAM);
	if (!raw) return null;
	const id = raw.trim();
	return ID_PATTERN.test(id) ? id : null;
}

/** A copy of `params` with the open message set (or removed for null). */
export function withSelectedId(
	params: URLSearchParams,
	id: string | null,
): URLSearchParams {
	const next = new URLSearchParams(params);
	if (id) next.set(MESSAGE_PARAM, id);
	else next.delete(MESSAGE_PARAM);
	return next;
}

function flag(value: string | null): boolean {
	return value === "1" || value === "true";
}

/** List filters and sort from a query string; unknown values fall back to defaults. */
export function filtersFromParams(params: URLSearchParams): MailListFilters {
	const sortRaw = params.get("sort");
	const sortKey = SORT_KEYS.includes(sortRaw as MailSortKey)
		? (sortRaw as MailSortKey)
		: DEFAULT_MAIL_FILTERS.sortKey;
	const dirRaw = params.get("dir")?.toUpperCase();
	const sortDirection: MailSortDirection =
		dirRaw === "ASC" || dirRaw === "DESC" ? dirRaw : NATURAL_DIRECTION[sortKey];
	return {
		unread: flag(params.get("unread")),
		starred: flag(params.get("starred")),
		hasAttachment: flag(params.get("attach")),
		sortKey,
		sortDirection,
	};
}

/**
 * A copy of `params` carrying `filters`. Defaults are omitted so a plain folder
 * keeps a plain URL; other keys (`?m=`, `?q=`) are kept.
 */
export function withFilters(
	params: URLSearchParams,
	filters: MailListFilters,
): URLSearchParams {
	const next = new URLSearchParams(params);
	for (const key of FILTER_KEYS) next.delete(key);
	if (filters.unread) next.set("unread", "1");
	if (filters.starred) next.set("starred", "1");
	if (filters.hasAttachment) next.set("attach", "1");
	if (filters.sortKey !== DEFAULT_MAIL_FILTERS.sortKey) next.set("sort", filters.sortKey);
	if (filters.sortDirection !== NATURAL_DIRECTION[filters.sortKey]) {
		next.set("dir", filters.sortDirection.toLowerCase());
	}
	return next;
}

/** What the URL ↔ store sync should do after a change on either side. */
export type SelectionSync =
	| { kind: "none" }
	/** The URL changed (Back, a link, a reload): make the store match it. */
	| { kind: "store"; id: string | null }
	/** The store changed (a click, `j`/`k`): make the URL match it. */
	| { kind: "url"; id: string | null; mode: "push" | "replace" | "back" };

export interface SelectionSnapshot {
	/** `pathname` plus the `?m=` value: a folder change counts as a URL change. */
	urlKey: string;
	urlId: string | null;
	storeId: string | null;
}

/**
 * Decide which side wins after a render.
 *
 * The URL wins when it moved (Back/Forward, a shared link, a folder change);
 * otherwise a store change is written to the URL. Opening a message from the
 * list pushes an entry so Back closes it; stepping between messages replaces
 * it so Back does not walk through every message read; closing a message that
 * we pushed goes back, so the next Back does not reopen it.
 */
export function decideSelectionSync(
	previous: SelectionSnapshot | null,
	current: SelectionSnapshot,
	openedByPush: boolean,
): SelectionSync {
	if (!previous || previous.urlKey !== current.urlKey) {
		return current.urlId === current.storeId
			? { kind: "none" }
			: { kind: "store", id: current.urlId };
	}
	if (previous.storeId === current.storeId) return { kind: "none" };
	if (current.storeId === current.urlId) return { kind: "none" };

	if (current.storeId === null) {
		return { kind: "url", id: null, mode: openedByPush ? "back" : "replace" };
	}
	return {
		kind: "url",
		id: current.storeId,
		mode: current.urlId === null ? "push" : "replace",
	};
}
