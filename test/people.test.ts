// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import {
	filterPeople,
	mergePeople,
	paginate,
	parseDisplayName,
	sortPeople,
	type MailboxPersonRow,
} from "../shared/people";

function row(overrides: Partial<MailboxPersonRow> = {}): MailboxPersonRow {
	return {
		email: "john@example.com",
		fromHeader: null,
		lastEmailAt: "2026-08-01T10:00:00.000Z",
		unreadCount: 0,
		totalCount: 1,
		hasAttachment: 0,
		...overrides,
	};
}

describe("parseDisplayName", () => {
	it("extracts a display name from a From header", () => {
		expect(parseDisplayName("John Smith <john@example.com>")).toBe("John Smith");
	});

	it("strips surrounding quotes", () => {
		expect(parseDisplayName('"Smith, John" <john@example.com>')).toBe(
			"Smith, John",
		);
	});

	it("collapses internal whitespace", () => {
		expect(parseDisplayName("John    Smith <john@example.com>")).toBe(
			"John Smith",
		);
	});

	it("returns null for a bare address", () => {
		expect(parseDisplayName("john@example.com")).toBeNull();
		expect(parseDisplayName("<john@example.com>")).toBeNull();
	});

	it("returns null when the name is just the address repeated", () => {
		// Showing "john@example.com" as a name adds nothing over the address.
		expect(parseDisplayName("john@example.com <john@example.com>")).toBeNull();
	});

	it("keeps a name that merely contains an address-like token", () => {
		expect(parseDisplayName("John (john@example.com) <john@example.com>")).toBe(
			"John (john@example.com)",
		);
	});

	it("handles missing and empty headers", () => {
		expect(parseDisplayName(null)).toBeNull();
		expect(parseDisplayName(undefined)).toBeNull();
		expect(parseDisplayName("   ")).toBeNull();
	});
});

describe("mergePeople", () => {
	it("sums counts for a person who wrote to several mailboxes", () => {
		const merged = mergePeople([
			{
				mailbox: "support@tapetide.com",
				people: [row({ totalCount: 10, unreadCount: 3 })],
			},
			{
				mailbox: "sales@tapetide.com",
				people: [row({ totalCount: 5, unreadCount: 1 })],
			},
		]);

		expect(merged).toHaveLength(1);
		expect(merged[0].totalCount).toBe(15);
		expect(merged[0].unreadCount).toBe(4);
		expect(merged[0].recipientCount).toBe(2);
		expect(merged[0].recipients).toEqual([
			"sales@tapetide.com",
			"support@tapetide.com",
		]);
	});

	it("takes the most recent timestamp across mailboxes", () => {
		const merged = mergePeople([
			{ mailbox: "a@t.com", people: [row({ lastEmailAt: "2026-08-01T00:00:00Z" })] },
			{ mailbox: "b@t.com", people: [row({ lastEmailAt: "2026-08-05T00:00:00Z" })] },
		]);

		expect(merged[0].lastEmailAt).toBe(
			Math.floor(Date.parse("2026-08-05T00:00:00Z") / 1000),
		);
	});

	it("takes the display name from the most recent message", () => {
		const merged = mergePeople([
			{
				mailbox: "a@t.com",
				people: [
					row({
						lastEmailAt: "2026-08-01T00:00:00Z",
						fromHeader: "Old Name <john@example.com>",
					}),
				],
			},
			{
				mailbox: "b@t.com",
				people: [
					row({
						lastEmailAt: "2026-08-05T00:00:00Z",
						fromHeader: "New Name <john@example.com>",
					}),
				],
			},
		]);

		expect(merged[0].name).toBe("New Name");
	});

	it("keeps an older name when the newest message has none", () => {
		const merged = mergePeople([
			{
				mailbox: "a@t.com",
				people: [
					row({
						lastEmailAt: "2026-08-01T00:00:00Z",
						fromHeader: "John Smith <john@example.com>",
					}),
				],
			},
			{
				mailbox: "b@t.com",
				people: [row({ lastEmailAt: "2026-08-05T00:00:00Z", fromHeader: null })],
			},
		]);

		expect(merged[0].name).toBe("John Smith");
	});

	it("treats addresses case-insensitively", () => {
		const merged = mergePeople([
			{ mailbox: "a@t.com", people: [row({ email: "John@Example.com" })] },
			{ mailbox: "a@t.com", people: [row({ email: "john@example.com" })] },
		]);

		expect(merged).toHaveLength(1);
		expect(merged[0].email).toBe("john@example.com");
		expect(merged[0].id).toBe("john@example.com");
	});

	it("does not double-count a mailbox listed twice", () => {
		const merged = mergePeople([
			{ mailbox: "a@t.com", people: [row()] },
			{ mailbox: "a@t.com", people: [row()] },
		]);

		expect(merged[0].recipientCount).toBe(1);
		expect(merged[0].recipients).toEqual(["a@t.com"]);
	});

	it("sets hasAttachment when any mailbox reports one", () => {
		const merged = mergePeople([
			{ mailbox: "a@t.com", people: [row({ hasAttachment: 0 })] },
			{ mailbox: "b@t.com", people: [row({ hasAttachment: 1 })] },
		]);

		expect(merged[0].hasAttachment).toBe(1);
	});

	it("skips blank sender addresses", () => {
		const merged = mergePeople([
			{ mailbox: "a@t.com", people: [row({ email: "   " }), row()] },
		]);

		expect(merged).toHaveLength(1);
		expect(merged[0].email).toBe("john@example.com");
	});

	it("tolerates a missing or unparseable timestamp", () => {
		const merged = mergePeople([
			{ mailbox: "a@t.com", people: [row({ lastEmailAt: null })] },
			{ mailbox: "b@t.com", people: [row({ lastEmailAt: "not a date" })] },
		]);

		expect(merged[0].lastEmailAt).toBe(0);
	});
});

describe("filterPeople", () => {
	const people = mergePeople([
		{
			mailbox: "support@t.com",
			people: [
				row({
					email: "john@example.com",
					fromHeader: "John Smith <john@example.com>",
					unreadCount: 2,
					hasAttachment: 1,
				}),
			],
		},
		{
			mailbox: "sales@t.com",
			people: [row({ email: "mike@startup.io", unreadCount: 0 })],
		},
	]);

	it("matches on address and on display name", () => {
		expect(filterPeople(people, { search: "startup" })).toHaveLength(1);
		expect(filterPeople(people, { search: "john smith" })).toHaveLength(1);
		expect(filterPeople(people, { search: "SMITH" })).toHaveLength(1);
	});

	it("filters to unread only", () => {
		const result = filterPeople(people, { unread: true });
		expect(result.map((p) => p.email)).toEqual(["john@example.com"]);
	});

	it("filters to people with attachments", () => {
		const result = filterPeople(people, { hasAttachment: true });
		expect(result.map((p) => p.email)).toEqual(["john@example.com"]);
	});

	it("filters by which mailbox they wrote to, case-insensitively", () => {
		expect(filterPeople(people, { recipient: "SALES@T.com" })).toHaveLength(1);
		expect(filterPeople(people, { recipient: "nobody@t.com" })).toHaveLength(0);
	});

	it("returns everything when no filters are given", () => {
		expect(filterPeople(people)).toHaveLength(2);
		expect(filterPeople(people, { search: "  " })).toHaveLength(2);
	});
});

describe("sortPeople", () => {
	const people = mergePeople([
		{
			mailbox: "a@t.com",
			people: [
				row({ email: "old@x.com", lastEmailAt: "2026-01-01T00:00:00Z", unreadCount: 9 }),
			],
		},
		{
			mailbox: "a@t.com",
			people: [
				row({ email: "new@x.com", lastEmailAt: "2026-08-01T00:00:00Z", unreadCount: 1 }),
			],
		},
	]);

	it("sorts by recency descending by default", () => {
		expect(sortPeople(people).map((p) => p.email)).toEqual([
			"new@x.com",
			"old@x.com",
		]);
	});

	it("honours ascending direction", () => {
		expect(
			sortPeople(people, { key: "recency", direction: "asc" }).map((p) => p.email),
		).toEqual(["old@x.com", "new@x.com"]);
	});

	it("sorts by unread count", () => {
		expect(
			sortPeople(people, { key: "unread", direction: "desc" }).map((p) => p.email),
		).toEqual(["old@x.com", "new@x.com"]);
	});

	it("breaks ties by recency", () => {
		const tied = mergePeople([
			{
				mailbox: "a@t.com",
				people: [
					row({ email: "a@x.com", lastEmailAt: "2026-01-01T00:00:00Z", unreadCount: 5 }),
					row({ email: "b@x.com", lastEmailAt: "2026-08-01T00:00:00Z", unreadCount: 5 }),
				],
			},
		]);

		expect(
			sortPeople(tied, { key: "unread", direction: "desc" }).map((p) => p.email),
		).toEqual(["b@x.com", "a@x.com"]);
	});

	it("does not mutate the input array", () => {
		const before = people.map((p) => p.email);
		sortPeople(people, { key: "unread", direction: "asc" });
		expect(people.map((p) => p.email)).toEqual(before);
	});
});

describe("paginate", () => {
	const items = Array.from({ length: 95 }, (_, i) => i);

	it("slices the requested page", () => {
		const result = paginate(items, 2, 40);
		expect(result.items[0]).toBe(40);
		expect(result.items).toHaveLength(40);
		expect(result.total).toBe(95);
		expect(result.page).toBe(2);
	});

	it("returns a short final page", () => {
		expect(paginate(items, 3, 40).items).toHaveLength(15);
	});

	it("clamps a page beyond the end instead of returning nothing", () => {
		// A narrowing filter can leave the UI requesting a page that no longer
		// exists; an empty list would look like "no results".
		const result = paginate(items, 99, 40);
		expect(result.page).toBe(3);
		expect(result.items).toHaveLength(15);
	});

	it("clamps non-positive and non-numeric pages to the first page", () => {
		expect(paginate(items, 0, 40).page).toBe(1);
		expect(paginate(items, -5, 40).page).toBe(1);
		expect(paginate(items, Number.NaN, 40).page).toBe(1);
	});

	it("handles an empty list", () => {
		const result = paginate([], 1, 40);
		expect(result.items).toEqual([]);
		expect(result.total).toBe(0);
		expect(result.page).toBe(1);
	});
});
