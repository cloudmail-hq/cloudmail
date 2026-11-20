// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for which mailboxes the dashboard shows.
 *
 * The failure modes here are all "mail the user cannot see and has no reason to
 * suspect exists", which is why the rules are pure functions with tests rather
 * than conditions scattered through two components:
 *
 *   - a mailbox created after the preference was saved must appear on its own,
 *     which is the whole reason this stores a hide-list rather than a show-list;
 *   - the mailbox currently open must stay in the switcher, or there is no way
 *     back to it;
 *   - hiding everything must be impossible, since an empty dashboard has no
 *     control left on it to undo the setting;
 *   - a deleted mailbox's id must not linger and silently hide a later mailbox
 *     that reuses the address.
 */

import { describe, expect, it } from "vitest";
import {
	canHideMailbox,
	isMailboxHidden,
	pruneHidden,
	toggleMailboxHidden,
	visibleMailboxes,
} from "../app/lib/mailbox-visibility";

const SUPPORT = { id: "support@example.com" };
const BILLING = { id: "billing@example.com" };
const HELLO = { id: "hello@example.com" };
const ALL = [SUPPORT, BILLING, HELLO];

describe("visibleMailboxes", () => {
	it("shows everything when nothing is hidden", () => {
		expect(visibleMailboxes(ALL, [])).toEqual(ALL);
	});

	it("drops hidden mailboxes", () => {
		expect(visibleMailboxes(ALL, ["billing@example.com"])).toEqual([
			SUPPORT,
			HELLO,
		]);
	});

	it("shows a mailbox the preference has never heard of", () => {
		// The reason this is a hide-list. A newly created address must not be
		// invisible by default — "why am I not getting mail" is the worst outcome
		// available here.
		const withNew = [...ALL, { id: "new@example.com" }];
		expect(visibleMailboxes(withNew, ["billing@example.com"])).toContainEqual({
			id: "new@example.com",
		});
	});

	it("keeps the open mailbox listed even when it is hidden", () => {
		// Reached by an old bookmark or a link from the people view. Omitting it
		// would leave a switcher that does not contain the mailbox on screen.
		expect(
			visibleMailboxes(ALL, ["billing@example.com"], "billing@example.com"),
		).toEqual(ALL);
	});

	it("compares ids case-insensitively", () => {
		// A mailbox id is an email address, and these arrive from URLs and config.
		expect(visibleMailboxes(ALL, ["BILLING@EXAMPLE.COM"])).toEqual([
			SUPPORT,
			HELLO,
		]);
		expect(
			visibleMailboxes(ALL, ["billing@example.com"], "BILLING@example.com"),
		).toEqual(ALL);
	});

	it("falls back to showing everything rather than nothing", () => {
		// `toggleMailboxHidden` will not produce this, but a preference saved
		// before mailboxes were deleted can arrive in it. An empty dashboard reads
		// as a broken app.
		const hidden = ALL.map((box) => box.id);
		expect(visibleMailboxes(ALL, hidden)).toEqual(ALL);
	});

	it("has nothing to show for no mailboxes", () => {
		expect(visibleMailboxes([], ["x@example.com"])).toEqual([]);
	});
});

describe("toggleMailboxHidden", () => {
	it("hides a visible mailbox", () => {
		expect(toggleMailboxHidden([], ALL, "billing@example.com")).toEqual([
			"billing@example.com",
		]);
	});

	it("shows a hidden one again", () => {
		expect(
			toggleMailboxHidden(["billing@example.com"], ALL, "billing@example.com"),
		).toEqual([]);
	});

	it("normalises the id it stores", () => {
		// So a later `isMailboxHidden` on the lowercase form still matches.
		expect(toggleMailboxHidden([], ALL, "BILLING@Example.com")).toEqual([
			"billing@example.com",
		]);
	});

	it("refuses to hide the last visible mailbox", () => {
		const hidden = ["support@example.com", "hello@example.com"];
		expect(toggleMailboxHidden(hidden, ALL, "billing@example.com")).toBe(hidden);
	});

	it("still allows unhiding when only one is visible", () => {
		const hidden = ["support@example.com", "hello@example.com"];
		expect(toggleMailboxHidden(hidden, ALL, "support@example.com")).toEqual([
			"hello@example.com",
		]);
	});

	it("refuses to hide the only mailbox there is", () => {
		expect(toggleMailboxHidden([], [SUPPORT], SUPPORT.id)).toEqual([]);
	});
});

describe("canHideMailbox", () => {
	it("agrees with toggleMailboxHidden about the last visible mailbox", () => {
		// Checked against the same rule rather than a copy of it, so a control can
		// never offer a toggle the store then ignores.
		const hidden = ["support@example.com", "hello@example.com"];
		expect(canHideMailbox(hidden, ALL, "billing@example.com")).toBe(false);
		expect(canHideMailbox([], ALL, "billing@example.com")).toBe(true);
	});

	it("always allows unhiding", () => {
		const hidden = ["support@example.com", "hello@example.com"];
		expect(canHideMailbox(hidden, ALL, "support@example.com")).toBe(true);
	});
});

describe("pruneHidden", () => {
	it("forgets ids whose mailbox is gone", () => {
		// Otherwise recreating `support@` later brings it back invisible, for no
		// reason the user could see.
		expect(
			pruneHidden(["gone@example.com", "billing@example.com"], ALL),
		).toEqual(["billing@example.com"]);
	});

	it("leaves a still-valid preference alone", () => {
		expect(pruneHidden(["billing@example.com"], ALL)).toEqual([
			"billing@example.com",
		]);
	});

	it("matches regardless of case", () => {
		expect(pruneHidden(["billing@example.com"], [{ id: "BILLING@EXAMPLE.COM" }]))
			.toEqual(["billing@example.com"]);
	});
});

describe("isMailboxHidden", () => {
	it("is case-insensitive in both directions", () => {
		expect(isMailboxHidden(["billing@example.com"], "BILLING@EXAMPLE.COM")).toBe(
			true,
		);
		expect(isMailboxHidden(["billing@example.com"], "other@example.com")).toBe(
			false,
		);
	});
});
