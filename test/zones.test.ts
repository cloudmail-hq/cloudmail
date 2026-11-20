import { describe, expect, it } from "vitest";
import {
	domainOfAddress,
	getDomains,
	getZones,
	isAddressAllowed,
	isDomainAllowed,
	normalizeDomain,
} from "../workers/lib/zones";
import type { Env } from "../workers/types";

/** Build a minimal Env carrying only the zone-related vars. */
const env = (vars: { DOMAINS?: string; ZONES?: string }) => vars as unknown as Env;

describe("domainOfAddress", () => {
	it("extracts and normalises the domain", () => {
		expect(domainOfAddress("Hitesh@Tapetide.COM")).toBe("tapetide.com");
		expect(domainOfAddress(" devops@example.org ")).toBe("example.org");
	});

	it("uses the last @ so quoted local parts still resolve", () => {
		expect(domainOfAddress('"weird@local"@example.com')).toBe("example.com");
	});

	it("returns empty for malformed input rather than guessing", () => {
		expect(domainOfAddress("no-at-sign")).toBe("");
		expect(domainOfAddress("trailing@")).toBe("");
		expect(domainOfAddress("")).toBe("");
	});
});

describe("normalizeDomain", () => {
	it("strips casing, whitespace and stray leading punctuation", () => {
		expect(normalizeDomain("  Example.COM ")).toBe("example.com");
		expect(normalizeDomain("@example.com")).toBe("example.com");
		expect(normalizeDomain(".example.com")).toBe("example.com");
	});
});

describe("getZones", () => {
	it("reads a comma-separated DOMAINS list", () => {
		const zones = getZones(env({ DOMAINS: "tapetide.com, example.org" }));
		expect(zones.map((z) => z.domain)).toEqual([
			"tapetide.com",
			"example.org",
		]);
		// Display name falls back to the domain when none is supplied.
		expect(zones[0].name).toBe("tapetide.com");
	});

	it("reads ZONES JSON with display names and zone IDs", () => {
		const zones = getZones(
			env({
				ZONES: JSON.stringify([
					{ domain: "tapetide.com", name: "Tapetide", zoneId: "b8f81bfc" },
					{ domain: "example.org", name: "Example Org" },
				]),
			}),
		);
		expect(zones).toEqual([
			{ id: "tapetide.com", domain: "tapetide.com", name: "Tapetide", zoneId: "b8f81bfc" },
			{ id: "example.org", domain: "example.org", name: "Example Org" },
		]);
	});

	it("lets ZONES add a display name to a domain already in DOMAINS", () => {
		const zones = getZones(
			env({
				DOMAINS: "tapetide.com,example.org",
				ZONES: JSON.stringify([{ domain: "tapetide.com", name: "Tapetide" }]),
			}),
		);
		expect(zones).toHaveLength(2);
		expect(zones.find((z) => z.domain === "tapetide.com")?.name).toBe("Tapetide");
		// The DOMAINS-only entry survives.
		expect(zones.find((z) => z.domain === "example.org")?.name).toBe(
			"example.org",
		);
	});

	it("de-duplicates a domain listed in both sources", () => {
		const zones = getZones(
			env({
				DOMAINS: "tapetide.com",
				ZONES: JSON.stringify([{ domain: "tapetide.com", name: "Tapetide" }]),
			}),
		);
		expect(zones).toHaveLength(1);
	});

	it("falls back to DOMAINS when ZONES is malformed, rather than throwing", () => {
		expect(getDomains(env({ DOMAINS: "tapetide.com", ZONES: "{not json" }))).toEqual(
			["tapetide.com"],
		);
		expect(getDomains(env({ DOMAINS: "tapetide.com", ZONES: '"a string"' }))).toEqual(
			["tapetide.com"],
		);
	});

	it("ignores zone entries with no usable domain", () => {
		const zones = getZones(
			env({ ZONES: JSON.stringify([{ name: "Nameless" }, { domain: "  " }]) }),
		);
		expect(zones).toEqual([]);
	});

	it("returns nothing when neither var is set", () => {
		expect(getZones(env({}))).toEqual([]);
	});
});

describe("isDomainAllowed", () => {
	const configured = env({ DOMAINS: "tapetide.com,example.org" });

	it("accepts configured domains regardless of casing", () => {
		expect(isDomainAllowed(configured, "tapetide.com")).toBe(true);
		expect(isDomainAllowed(configured, "Example.ORG")).toBe(true);
	});

	it("rejects unconfigured domains", () => {
		expect(isDomainAllowed(configured, "qrfiletransfer.app")).toBe(false);
		expect(isDomainAllowed(configured, "attacker.example")).toBe(false);
	});

	it("does not treat a subdomain as its parent zone", () => {
		// Email Routing is configured per hostname, so mail.tapetide.com is a
		// separate zone entry and must be listed explicitly.
		expect(isDomainAllowed(configured, "mail.tapetide.com")).toBe(false);
	});

	it("is permissive when nothing is configured, so local dev still works", () => {
		expect(isDomainAllowed(env({}), "anything.example")).toBe(true);
	});
});

describe("isAddressAllowed", () => {
	const configured = env({ DOMAINS: "tapetide.com" });

	it("accepts an address on a served domain", () => {
		expect(isAddressAllowed(configured, "hitesh@tapetide.com")).toBe(true);
	});

	it("rejects an address on an unserved domain", () => {
		expect(isAddressAllowed(configured, "devops@example.org")).toBe(false);
	});

	it("rejects a malformed address even with no domains configured", () => {
		// A missing domain is a bad address, not an unconfigured deployment.
		expect(isAddressAllowed(env({}), "not-an-address")).toBe(false);
	});
});
