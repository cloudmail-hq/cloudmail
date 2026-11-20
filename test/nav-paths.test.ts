import { describe, expect, it } from "vitest";
import { MANAGE_MAILBOXES_PATH, isManageRequest, startsGroup } from "~/lib/app-nav";
import { canonicalMailPath } from "~/lib/mail-url";
import { isApplePlatform } from "~/hooks/useModKeyLabel";

describe("canonicalMailPath", () => {
	it("encodes a raw @ in the mailbox segment and keeps the rest", () => {
		expect(canonicalMailPath("/mail/dana@acme.test/sent", "dana@acme.test")).toBe("/mail/dana%40acme.test/sent");
		expect(canonicalMailPath("/mail/dana@acme.test", "dana@acme.test")).toBe("/mail/dana%40acme.test");
	});

	it("leaves an already-encoded path alone", () => {
		expect(canonicalMailPath("/mail/dana%40acme.test/inbox", "dana@acme.test")).toBeNull();
	});

	it("ignores paths that are not this mailbox's", () => {
		expect(canonicalMailPath("/mail/other@acme.test/inbox", "dana@acme.test")).toBeNull();
		expect(canonicalMailPath("/settings", "dana@acme.test")).toBeNull();
		expect(canonicalMailPath("/mail/%E0%A4%A/inbox", "dana@acme.test")).toBeNull();
	});
});

describe("manage mailboxes link", () => {
	it("opens the chooser in a mode that does not forward to the only mailbox", () => {
		const url = new URL(MANAGE_MAILBOXES_PATH, "https://x.test");
		expect(url.pathname).toBe("/");
		expect(isManageRequest(url.searchParams)).toBe(true);
		expect(isManageRequest(new URLSearchParams(""))).toBe(false);
	});
});

describe("startsGroup", () => {
	const items = [{ group: "You" }, { group: "You" }, { group: "Workspace" }, { group: "Workspace" }, { group: "Sending" }];
	it("marks the first item of each run", () => {
		expect(items.map((_, i) => startsGroup(items, i))).toEqual([true, false, true, false, true]);
	});
	it("draws no heading when everything is in one group", () => {
		const one = [{ group: "You" }, { group: "You" }];
		expect(one.map((_, i) => startsGroup(one, i))).toEqual([false, false]);
	});
	it("ignores ungrouped items", () => {
		expect(startsGroup([{}, {}], 0)).toBe(false);
	});
});

describe("isApplePlatform", () => {
	it("uses ⌘ only on Apple platforms", () => {
		expect(isApplePlatform("MacIntel")).toBe(true);
		expect(isApplePlatform("macOS")).toBe(true);
		expect(isApplePlatform("iPhone")).toBe(true);
		expect(isApplePlatform("Linux x86_64")).toBe(false);
		expect(isApplePlatform("Win32")).toBe(false);
	});
});
