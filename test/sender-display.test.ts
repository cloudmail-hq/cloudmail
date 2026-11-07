import { describe, expect, it } from "vitest";
import {
	senderAvatarTint,
	senderDisplayName,
	senderInitials,
} from "../app/lib/sender-display";

describe("senderDisplayName", () => {
	it("title-cases a personal local part", () => {
		expect(senderDisplayName("priya@acme.io")).toBe("Priya");
		expect(senderDisplayName("priya.sharma@acme.io")).toBe("Priya Sharma");
		expect(senderDisplayName("marcus_chen@x.co")).toBe("Marcus Chen");
	});

	it("names role mailboxes after the domain", () => {
		expect(senderDisplayName("noreply@github.com")).toBe("GitHub");
		expect(senderDisplayName("health@aws.com")).toBe("AWS");
		expect(senderDisplayName("team@makenotion.com")).toBe("Notion");
		expect(senderDisplayName("receipts@stripe.com")).toBe("Stripe");
		expect(senderDisplayName("cloudplatform-noreply@google.com")).toBe("Google");
		expect(senderDisplayName("hello@mail.notion.so")).toBe("Notion");
		expect(senderDisplayName("info@shop.co.uk")).toBe("Shop");
	});

	it("drops plus-addressing before deciding", () => {
		expect(senderDisplayName("noreply+bounce@github.com")).toBe("GitHub");
	});

	it("leaves opaque local parts alone", () => {
		expect(senderDisplayName("u12345678@example.com")).toBe("u12345678");
	});

	it("passes through something that is not an address", () => {
		expect(senderDisplayName("Team Tapetide")).toBe("Team Tapetide");
	});
});

describe("senderInitials", () => {
	it("uses first and last word", () => {
		expect(senderInitials("priya.sharma@acme.io")).toBe("PS");
		expect(senderInitials("noreply@github.com")).toBe("G");
		expect(senderInitials("health@aws.com")).toBe("A");
	});
});

describe("senderAvatarTint", () => {
	it("is stable and case-insensitive", () => {
		expect(senderAvatarTint("A@b.com")).toBe(senderAvatarTint("a@b.com"));
	});
});
