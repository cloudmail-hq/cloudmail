// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { searchQueryWarnings } from "../shared/search-query";

const now = new Date("2026-10-26T12:00:00Z");

describe("searchQueryWarnings", () => {
	it("is empty for a clean query", () => {
		expect(
			searchQueryWarnings("from:alice is:unread larger:5M before:2026/01/01 invoice", { now }),
		).toEqual([]);
		expect(searchQueryWarnings("", { now })).toEqual([]);
		expect(searchQueryWarnings(null, { now })).toEqual([]);
	});

	it("flags an unparseable size", () => {
		const [w] = searchQueryWarnings("larger:banana", { now });
		expect(w.token).toBe("larger:banana");
		expect(w.message).toContain("as text");
		expect(w.message).toContain("5M");
	});

	it("flags unknown flags, dates and ages", () => {
		const tokens = searchQueryWarnings(
			"is:urgent before:someday newer_than:3w has:pdf",
			{ now },
		).map((w) => w.token);
		expect(tokens).toEqual(["is:urgent", "before:someday", "newer_than:3w", "has:pdf"]);
	});

	it("flags an operator with no value", () => {
		const [w] = searchQueryWarnings("from: invoice", { now });
		expect(w.token).toBe("from:");
		expect(w.message).toContain("no value");
	});

	it("does not flag words with a colon that are not operators", () => {
		expect(searchQueryWarnings("re:meeting 10:30", { now })).toEqual([]);
	});
});
