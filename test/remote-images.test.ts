// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Remote-image trust rules.
 *
 * These decide whether a tracking pixel loads, so the interesting cases are the
 * ones where a rule must *not* match: a domain rule must not stretch to
 * subdomains, and a pattern that came back from `localStorage` in odd case must
 * still match rather than sit in settings doing nothing.
 */

import { describe, expect, it } from "vitest";
import {
	addRemoteImagePattern,
	allowsRemoteImages,
	describePattern,
	matchingPatterns,
	normalizeRemoteImagePattern,
	removeRemoteImagePattern,
	replaceRemoteImagePattern,
	senderAddress,
	senderDomainPattern,
} from "~/lib/remote-images";

describe("senderAddress", () => {
	it("unwraps the display-name form", () => {
		expect(senderAddress("Devpost <support@devpost.com>")).toBe(
			"support@devpost.com",
		);
	});

	it("passes a bare address through, lowercased", () => {
		expect(senderAddress("  Support@Devpost.com ")).toBe("support@devpost.com");
	});

	it("returns empty for nothing", () => {
		expect(senderAddress(null)).toBe("");
		expect(senderAddress("   ")).toBe("");
	});
});

describe("senderDomainPattern", () => {
	it("returns the domain in rule form", () => {
		expect(senderDomainPattern("Devpost <support@devpost.com>")).toBe(
			"@devpost.com",
		);
	});

	it("returns empty when there is no domain to offer", () => {
		expect(senderDomainPattern("postmaster")).toBe("");
		expect(senderDomainPattern("")).toBe("");
	});
});

describe("normalizeRemoteImagePattern", () => {
	it("keeps a full address", () => {
		expect(normalizeRemoteImagePattern("Sam <SAM@Example.com>")).toBe(
			"sam@example.com",
		);
	});

	it("keeps a domain rule", () => {
		expect(normalizeRemoteImagePattern(" @Example.com ")).toBe("@example.com");
	});

	it("reads a bare domain as a domain rule", () => {
		expect(normalizeRemoteImagePattern("example.com")).toBe("@example.com");
	});

	it("folds wildcard spellings into the @domain form", () => {
		expect(normalizeRemoteImagePattern("*@example.com")).toBe("@example.com");
		expect(normalizeRemoteImagePattern("*.example.com")).toBe("@example.com");
	});

	it("rejects input that would sit in the list matching nothing", () => {
		expect(normalizeRemoteImagePattern("")).toBeNull();
		expect(normalizeRemoteImagePattern("example")).toBeNull();
		expect(normalizeRemoteImagePattern("sam@example")).toBeNull();
		expect(normalizeRemoteImagePattern("sam@example.com extra")).toBeNull();
		expect(normalizeRemoteImagePattern("a@b@example.com")).toBeNull();
		expect(normalizeRemoteImagePattern("sam@.com")).toBeNull();
	});
});

describe("allowsRemoteImages", () => {
	it("matches an address rule exactly", () => {
		expect(
			allowsRemoteImages(["support@devpost.com"], "Devpost <support@devpost.com>"),
		).toBe(true);
		expect(allowsRemoteImages(["support@devpost.com"], "noreply@devpost.com")).toBe(
			false,
		);
	});

	it("matches every address at a trusted domain", () => {
		expect(allowsRemoteImages(["@devpost.com"], "anyone@devpost.com")).toBe(true);
	});

	/**
	 * The security-relevant case. A domain rule must cover exactly the domain the
	 * reader saw, because widening it to subdomains would trust hosts they never
	 * approved and trust would grow on its own.
	 */
	it("does not stretch a domain rule to subdomains", () => {
		expect(allowsRemoteImages(["@devpost.com"], "news@mail.devpost.com")).toBe(
			false,
		);
		expect(allowsRemoteImages(["@devpost.com"], "spoof@devpost.com.evil.test")).toBe(
			false,
		);
	});

	it("matches stored patterns whatever case they arrive in", () => {
		expect(allowsRemoteImages([" @DevPost.com "], "a@devpost.com")).toBe(true);
	});

	it("is false for an empty list or an unusable sender", () => {
		expect(allowsRemoteImages([], "a@devpost.com")).toBe(false);
		expect(allowsRemoteImages(["@devpost.com"], null)).toBe(false);
	});
});

describe("matchingPatterns", () => {
	it("reports every rule covering a sender, so all of them can be withdrawn", () => {
		expect(
			matchingPatterns(
				["@devpost.com", "support@devpost.com", "other@example.com"],
				"support@devpost.com",
			),
		).toEqual(["@devpost.com", "support@devpost.com"]);
	});
});

describe("addRemoteImagePattern", () => {
	it("adds and sorts domains ahead of addresses", () => {
		let list = addRemoteImagePattern([], "sam@example.com");
		list = addRemoteImagePattern(list, "@example.com");
		expect(list).toEqual(["@example.com", "sam@example.com"]);
	});

	it("returns the same array when nothing changed", () => {
		const list = addRemoteImagePattern([], "@example.com");
		expect(addRemoteImagePattern(list, "@EXAMPLE.com")).toBe(list);
		expect(addRemoteImagePattern(list, "nonsense")).toBe(list);
	});
});

describe("removeRemoteImagePattern", () => {
	it("removes case-insensitively", () => {
		expect(removeRemoteImagePattern(["@example.com"], "@Example.com")).toEqual([]);
	});

	it("returns the same array when the pattern wasn't listed", () => {
		const list = ["@example.com"];
		expect(removeRemoteImagePattern(list, "@other.com")).toBe(list);
	});
});

describe("replaceRemoteImagePattern", () => {
	it("swaps one pattern for another", () => {
		expect(
			replaceRemoteImagePattern(["sam@example.com"], "sam@example.com", "sue@example.com"),
		).toEqual(["sue@example.com"]);
	});

	it("leaves the original in place when the edit is unusable", () => {
		const list = ["sam@example.com"];
		expect(replaceRemoteImagePattern(list, "sam@example.com", "nonsense")).toBe(list);
		expect(replaceRemoteImagePattern(list, "missing@example.com", "a@b.com")).toBe(
			list,
		);
	});
});

describe("describePattern", () => {
	it("spells out a domain rule", () => {
		expect(describePattern("@example.com")).toBe("everyone at example.com");
		expect(describePattern("sam@example.com")).toBe("sam@example.com");
	});
});
