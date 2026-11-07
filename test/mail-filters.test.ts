// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for the message list's filter and sort state.
 *
 * The risk here is the encoding boundary, not the toggles. The Worker reads
 * these flags as opt-in and treats any non-empty string as "on", so emitting
 * `unread=false` would filter the list to unread mail while the chip showed as
 * off. `filtersToParams` must therefore omit keys rather than send falsey ones,
 * and `filtersKey` must change whenever the request would, or pagination would
 * survive a filter change and land the user past the end of the filtered set.
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAIL_FILTERS,
	NATURAL_DIRECTION,
	filtersKey,
	filtersToParams,
	hasActiveFilters,
	isDefaultFilters,
	withFiltersCleared,
	withSortKey,
	withToggledDirection,
	type MailListFilters,
	type MailSortKey,
} from "../app/lib/mail-filters";

const SORT_KEYS: MailSortKey[] = ["date", "subject", "sender"];

describe("filtersToParams", () => {
	it("omits filters that are off rather than sending false", () => {
		// `?unread=false` arrives at the Worker as a non-empty string and reads as
		// "on", which would silently filter a list whose chip appears unset.
		const params = filtersToParams(DEFAULT_MAIL_FILTERS);
		expect(params).not.toHaveProperty("unread");
		expect(params).not.toHaveProperty("starred");
		expect(params).not.toHaveProperty("has_attachment");
	});

	it("always sends the sort, since the server default need not match ours", () => {
		expect(filtersToParams(DEFAULT_MAIL_FILTERS)).toMatchObject({
			sortColumn: "date",
			sortDirection: "DESC",
		});
	});

	it("emits each active filter under the name the Worker reads", () => {
		const params = filtersToParams({
			...DEFAULT_MAIL_FILTERS,
			unread: true,
			starred: true,
			hasAttachment: true,
		});
		expect(params.unread).toBe("true");
		expect(params.starred).toBe("true");
		// Snake case: the query key the emails route reads is `has_attachment`,
		// not the camelCase used in component state.
		expect(params.has_attachment).toBe("true");
	});

	it("produces only string values, as URLSearchParams requires", () => {
		const params = filtersToParams({
			...DEFAULT_MAIL_FILTERS,
			unread: true,
			sortKey: "subject",
			sortDirection: "ASC",
		});
		for (const value of Object.values(params)) {
			expect(typeof value).toBe("string");
		}
	});
});

describe("sort selection", () => {
	it("adopts each key's natural direction when first selected", () => {
		// One click should give the order people expect: newest-first for dates,
		// A-Z for names.
		for (const key of SORT_KEYS) {
			expect(withSortKey(DEFAULT_MAIL_FILTERS, key).sortDirection).toBe(
				NATURAL_DIRECTION[key],
			);
		}
		expect(withSortKey(DEFAULT_MAIL_FILTERS, "date").sortDirection).toBe("DESC");
		expect(withSortKey(DEFAULT_MAIL_FILTERS, "subject").sortDirection).toBe("ASC");
	});

	it("keeps the active filters when the sort changes", () => {
		const filters: MailListFilters = {
			...DEFAULT_MAIL_FILTERS,
			unread: true,
			hasAttachment: true,
		};
		const next = withSortKey(filters, "sender");
		expect(next.unread).toBe(true);
		expect(next.hasAttachment).toBe(true);
	});

	it("toggles direction without changing the key", () => {
		const once = withToggledDirection(DEFAULT_MAIL_FILTERS);
		expect(once.sortDirection).toBe("ASC");
		expect(once.sortKey).toBe(DEFAULT_MAIL_FILTERS.sortKey);
		expect(withToggledDirection(once).sortDirection).toBe("DESC");
	});
});

describe("clearing", () => {
	it("clears the narrowing filters but keeps the chosen sort", () => {
		// Clear means "show me everything again", not "forget how I ordered it".
		const filters: MailListFilters = {
			unread: true,
			starred: true,
			hasAttachment: true,
			sortKey: "subject",
			sortDirection: "ASC",
		};
		const cleared = withFiltersCleared(filters);
		expect(hasActiveFilters(cleared)).toBe(false);
		expect(cleared.sortKey).toBe("subject");
		expect(cleared.sortDirection).toBe("ASC");
	});

	it("reports active state from the narrowing filters only", () => {
		expect(hasActiveFilters(DEFAULT_MAIL_FILTERS)).toBe(false);
		expect(
			hasActiveFilters({ ...DEFAULT_MAIL_FILTERS, sortKey: "sender" }),
		).toBe(false);
		expect(hasActiveFilters({ ...DEFAULT_MAIL_FILTERS, starred: true })).toBe(true);
	});

	it("distinguishes default state from merely unfiltered state", () => {
		expect(isDefaultFilters(DEFAULT_MAIL_FILTERS)).toBe(true);
		expect(
			isDefaultFilters({ ...DEFAULT_MAIL_FILTERS, sortKey: "sender" }),
		).toBe(false);
	});
});

describe("filtersKey", () => {
	it("changes whenever the request would change", () => {
		// The list uses this in its collection key to reset pagination. A key that
		// missed a change would leave the user on page 4 of a set with one page.
		const variants: MailListFilters[] = [
			DEFAULT_MAIL_FILTERS,
			{ ...DEFAULT_MAIL_FILTERS, unread: true },
			{ ...DEFAULT_MAIL_FILTERS, starred: true },
			{ ...DEFAULT_MAIL_FILTERS, hasAttachment: true },
			{ ...DEFAULT_MAIL_FILTERS, sortKey: "subject" },
			{ ...DEFAULT_MAIL_FILTERS, sortDirection: "ASC" },
			{ ...DEFAULT_MAIL_FILTERS, unread: true, starred: true },
		];
		const keys = variants.map(filtersKey);
		expect(new Set(keys).size).toBe(variants.length);
	});

	it("is stable for equal state", () => {
		expect(filtersKey({ ...DEFAULT_MAIL_FILTERS, unread: true })).toBe(
			filtersKey({ ...DEFAULT_MAIL_FILTERS, unread: true }),
		);
	});

	it("agrees with the params it will produce", () => {
		// Two states with the same key must issue the same request, or the cache
		// would serve one filter's results for another.
		const a: MailListFilters = { ...DEFAULT_MAIL_FILTERS, unread: true };
		const b: MailListFilters = { ...DEFAULT_MAIL_FILTERS, unread: true };
		expect(filtersKey(a)).toBe(filtersKey(b));
		expect(filtersToParams(a)).toEqual(filtersToParams(b));
	});
});
