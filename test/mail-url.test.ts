// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The open message and list filters in the URL: deep links, reload, and Back
 * closing the reader on a phone.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_MAIL_FILTERS } from "../app/lib/mail-filters";
import {
	decideSelectionSync,
	filtersFromParams,
	readSelectedId,
	withFilters,
	withSelectedId,
} from "../app/lib/mail-url";

const qs = (s: string) => new URLSearchParams(s);

describe("readSelectedId / withSelectedId", () => {
	it("reads ?m=", () => {
		expect(readSelectedId(qs("m=abc-123"))).toBe("abc-123");
		expect(readSelectedId(qs(""))).toBeNull();
		expect(readSelectedId(qs("m="))).toBeNull();
	});

	it("ignores ids with unexpected characters", () => {
		expect(readSelectedId(qs("m=%3Cscript%3E"))).toBeNull();
		expect(readSelectedId(qs(`m=${"a".repeat(201)}`))).toBeNull();
	});

	it("sets and clears without touching other keys", () => {
		expect(withSelectedId(qs("q=invoice"), "id1").toString()).toBe("q=invoice&m=id1");
		expect(withSelectedId(qs("q=invoice&m=id1"), null).toString()).toBe("q=invoice");
	});
});

describe("filtersFromParams / withFilters", () => {
	it("defaults to an unfiltered newest-first list", () => {
		expect(filtersFromParams(qs(""))).toEqual(DEFAULT_MAIL_FILTERS);
	});

	it("round-trips every filter", () => {
		const filters = {
			unread: true,
			starred: true,
			hasAttachment: true,
			sortKey: "subject" as const,
			sortDirection: "DESC" as const,
		};
		const params = withFilters(qs(""), filters);
		expect(params.toString()).toBe("unread=1&starred=1&attach=1&sort=subject&dir=desc");
		expect(filtersFromParams(params)).toEqual(filters);
	});

	it("omits defaults so a plain folder keeps a plain URL", () => {
		expect(withFilters(qs("m=x"), DEFAULT_MAIL_FILTERS).toString()).toBe("m=x");
		// Subject's natural direction is A→Z, so `dir` is not written.
		expect(
			withFilters(qs(""), { ...DEFAULT_MAIL_FILTERS, sortKey: "subject", sortDirection: "ASC" }).toString(),
		).toBe("sort=subject");
	});

	it("falls back on unknown values", () => {
		const f = filtersFromParams(qs("sort=bogus&dir=sideways&unread=maybe"));
		expect(f).toEqual(DEFAULT_MAIL_FILTERS);
	});

	it("uses the natural direction for a sort key without dir", () => {
		expect(filtersFromParams(qs("sort=sender")).sortDirection).toBe("ASC");
	});
});

describe("decideSelectionSync", () => {
	const snap = (path: string, urlId: string | null, storeId: string | null) => ({
		urlKey: `${path}?${urlId ?? ""}`,
		urlId,
		storeId,
	});

	it("opens the linked message on first load", () => {
		expect(decideSelectionSync(null, snap("/mail/a/inbox", "m1", null), false)).toEqual({
			kind: "store",
			id: "m1",
		});
	});

	it("does nothing when both agree", () => {
		expect(decideSelectionSync(null, snap("/mail/a/inbox", null, null), false)).toEqual({
			kind: "none",
		});
	});

	it("pushes when a message is opened from the list", () => {
		const prev = snap("/mail/a/inbox", null, null);
		expect(decideSelectionSync(prev, snap("/mail/a/inbox", null, "m1"), false)).toEqual({
			kind: "url",
			id: "m1",
			mode: "push",
		});
	});

	it("replaces when stepping to the next message", () => {
		const prev = snap("/mail/a/inbox", "m1", "m1");
		expect(decideSelectionSync(prev, snap("/mail/a/inbox", "m1", "m2"), true)).toEqual({
			kind: "url",
			id: "m2",
			mode: "replace",
		});
	});

	it("goes back when closing a message we pushed", () => {
		const prev = snap("/mail/a/inbox", "m1", "m1");
		expect(decideSelectionSync(prev, snap("/mail/a/inbox", "m1", null), true)).toEqual({
			kind: "url",
			id: null,
			mode: "back",
		});
	});

	it("replaces when closing a message opened from a link", () => {
		const prev = snap("/mail/a/inbox", "m1", "m1");
		expect(decideSelectionSync(prev, snap("/mail/a/inbox", "m1", null), false)).toEqual({
			kind: "url",
			id: null,
			mode: "replace",
		});
	});

	it("closes the reader when Back removes ?m=", () => {
		const prev = snap("/mail/a/inbox", "m1", "m1");
		expect(decideSelectionSync(prev, snap("/mail/a/inbox", null, "m1"), false)).toEqual({
			kind: "store",
			id: null,
		});
	});

	it("follows the URL on a folder change", () => {
		const prev = snap("/mail/a/inbox", "m1", "m1");
		expect(decideSelectionSync(prev, snap("/mail/a/sent", null, "m1"), false)).toEqual({
			kind: "store",
			id: null,
		});
	});

	it("settles once the URL catches up with the store", () => {
		const prev = snap("/mail/a/inbox", null, "m1");
		expect(decideSelectionSync(prev, snap("/mail/a/inbox", "m1", "m1"), true)).toEqual({
			kind: "none",
		});
	});
});
