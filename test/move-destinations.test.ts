// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Where a message may be moved, by direction. Received mail filed into Sent
 * reads as outgoing; anything moved into Snoozed never wakes up.
 */

import { describe, expect, it } from "vitest";
import {
	canMoveInto,
	canMoveMessageInto,
	folderCountKind,
	formatBadgeCount,
	Folders,
	isOutboundFrom,
} from "../shared/folders";

describe("canMoveInto", () => {
	it("refuses Snoozed, which only Snooze can reach", () => {
		expect(canMoveInto(Folders.SNOOZED)).toBe(false);
		expect(canMoveInto("Snoozed")).toBe(false);
	});
});

describe("canMoveMessageInto", () => {
	const inbound = { outbound: false };
	const outbound = { outbound: true };

	it.each([Folders.SENT, Folders.DRAFT, Folders.SCHEDULED, Folders.SNOOZED])(
		"refuses %s for received mail",
		(folder) => {
			expect(canMoveMessageInto(folder, inbound)).toBe(false);
		},
	);

	it.each([Folders.INBOX, Folders.ARCHIVE, Folders.SPAM, Folders.TRASH, "project-x"])(
		"allows %s for received mail",
		(folder) => {
			expect(canMoveMessageInto(folder, inbound)).toBe(true);
		},
	);

	it("lets sent mail go back to Sent", () => {
		expect(canMoveMessageInto(Folders.SENT, outbound)).toBe(true);
	});

	it("still refuses Drafts, Scheduled and Snoozed for sent mail", () => {
		for (const f of [Folders.DRAFT, Folders.SCHEDULED, Folders.SNOOZED]) {
			expect(canMoveMessageInto(f, outbound)).toBe(false);
		}
	});

	it("allows Sent when direction is unknown", () => {
		expect(canMoveMessageInto(Folders.SENT, { outbound: null })).toBe(true);
	});
});

describe("isOutboundFrom", () => {
	it("compares bare and angled addresses case-insensitively", () => {
		expect(isOutboundFrom("Support@Acme.example", "support@acme.example")).toBe(true);
		expect(isOutboundFrom("Acme <support@acme.example>", "support@acme.example")).toBe(true);
		expect(isOutboundFrom("alice@customer.example", "support@acme.example")).toBe(false);
	});

	it("is unknown without a mailbox address", () => {
		expect(isOutboundFrom("alice@x.example", null)).toBeNull();
	});
});

describe("count badges", () => {
	it("counts unread for mail folders and totals for Drafts and Scheduled", () => {
		expect(folderCountKind(Folders.INBOX)).toBe("unread");
		expect(folderCountKind(Folders.ARCHIVE)).toBe("unread");
		expect(folderCountKind(Folders.DRAFT)).toBe("total");
		expect(folderCountKind(Folders.SCHEDULED)).toBe("total");
	});

	it("shows exact counts up to 999", () => {
		expect(formatBadgeCount(0)).toBe("");
		expect(formatBadgeCount(undefined)).toBe("");
		expect(formatBadgeCount(1)).toBe("1");
		expect(formatBadgeCount(521)).toBe("521");
		expect(formatBadgeCount(999)).toBe("999");
		expect(formatBadgeCount(1000)).toBe("999+");
	});
});
