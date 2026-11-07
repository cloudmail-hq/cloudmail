// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Pure helpers behind the Domains settings, aliases and the From picker. */

import { describe, expect, it } from "vitest";
import {
	addressesIn,
	bareAddress,
	buildFromOptions,
	checkAlias,
	checkHostname,
	domainOf,
	mailboxesOnDomain,
	pickDefaultFrom,
	statusTone,
	withFromEmail,
} from "../shared/domains-ui";

describe("bareAddress / addressesIn", () => {
	it("extracts and lower-cases plain and angled addresses", () => {
		expect(bareAddress("Sam@Acme.com")).toBe("sam@acme.com");
		expect(bareAddress('"Sam, Jr" <Sam@Acme.com>')).toBe("sam@acme.com");
		expect(bareAddress("not an address")).toBeNull();
		expect(bareAddress(null)).toBeNull();
	});

	it("splits lists and drops junk", () => {
		expect(addressesIn("a@x.com, B <b@x.com>, junk")).toEqual(["a@x.com", "b@x.com"]);
		expect(addressesIn(undefined)).toEqual([]);
	});
});

describe("buildFromOptions", () => {
	it("puts the mailbox first and de-duplicates", () => {
		expect(buildFromOptions("Hi@acme.com", ["billing@acme.com", "HI@acme.com", "billing@acme.com"])).toEqual([
			"hi@acme.com",
			"billing@acme.com",
		]);
	});

	it("is just the mailbox with no aliases", () => {
		expect(buildFromOptions("hi@acme.com")).toEqual(["hi@acme.com"]);
	});
});

describe("pickDefaultFrom", () => {
	const aliases = ["billing@acme.com", "sales@acme.com"];

	it("uses the alias the original was addressed to", () => {
		expect(pickDefaultFrom("hi@acme.com", aliases, { recipient: "Billing <Billing@acme.com>" })).toBe(
			"billing@acme.com",
		);
	});

	it("checks cc too", () => {
		expect(pickDefaultFrom("hi@acme.com", aliases, { recipient: "x@y.com", cc: "sales@acme.com" })).toBe(
			"sales@acme.com",
		);
	});

	it("prefers the primary address when it was addressed directly", () => {
		expect(
			pickDefaultFrom("hi@acme.com", aliases, { recipient: "billing@acme.com, hi@acme.com" }),
		).toBe("hi@acme.com");
	});

	it("falls back to the mailbox", () => {
		expect(pickDefaultFrom("Hi@acme.com", aliases, { recipient: "other@acme.com" })).toBe("hi@acme.com");
		expect(pickDefaultFrom("hi@acme.com", aliases, null)).toBe("hi@acme.com");
		expect(pickDefaultFrom("hi@acme.com", [], { recipient: "billing@acme.com" })).toBe("hi@acme.com");
	});
});

describe("withFromEmail", () => {
	it("keeps the payload shape", () => {
		expect(withFromEmail("hi@acme.com", "billing@acme.com")).toBe("billing@acme.com");
		expect(withFromEmail({ email: "hi@acme.com", name: "Acme" }, "billing@acme.com")).toEqual({
			email: "billing@acme.com",
			name: "Acme",
		});
	});
});

describe("checkAlias", () => {
	const ctx = { mailboxEmail: "hi@acme.com", existing: ["billing@acme.com"], domains: ["acme.com", "acme.io"] };

	it("accepts a new alias on a known domain, normalised", () => {
		expect(checkAlias("  Sales@ACME.io ", ctx)).toEqual({ ok: true, alias: "sales@acme.io" });
	});

	it("rejects empty, invalid, own address, duplicates and foreign domains", () => {
		expect(checkAlias("", ctx).ok).toBe(false);
		expect(checkAlias("nope", ctx).ok).toBe(false);
		expect(checkAlias("HI@acme.com", ctx).ok).toBe(false);
		expect(checkAlias("Billing@acme.com", ctx).ok).toBe(false);
		expect(checkAlias("x@other.com", ctx)).toEqual({ ok: false, error: "@other.com isn't one of your domains." });
	});

	it("skips the domain check with no domain list", () => {
		expect(checkAlias("x@other.com", { ...ctx, domains: [] }).ok).toBe(true);
	});
});

describe("checkHostname", () => {
	it("normalises valid hostnames", () => {
		expect(checkHostname(" Mail.Example.COM. ")).toEqual({ ok: true, hostname: "mail.example.com" });
		expect(checkHostname("@example.com")).toEqual({ ok: true, hostname: "example.com" });
	});

	it("rejects bad ones", () => {
		for (const bad of ["", "localhost", "exa mple.com", "-a.com", "a-.com", "a..com", "http://a.com"]) {
			expect(checkHostname(bad).ok).toBe(false);
		}
	});
});

describe("domainOf / mailboxesOnDomain", () => {
	it("matches on the exact domain, case-insensitively", () => {
		const boxes = [{ email: "a@Acme.com" }, { email: "b@sub.acme.com" }, { email: "c@acme.com" }];
		expect(domainOf("a@Acme.com")).toBe("acme.com");
		expect(mailboxesOnDomain(boxes, "ACME.com").map((b) => b.email)).toEqual(["a@Acme.com", "c@acme.com"]);
	});
});

describe("statusTone", () => {
	it("maps statuses to tones", () => {
		expect(statusTone("active")).toBe("success");
		expect(statusTone("pass")).toBe("success");
		expect(statusTone("pending")).toBe("warning");
		expect(statusTone("warn")).toBe("warning");
		expect(statusTone("fail")).toBe("danger");
		expect(statusTone("misconfigured")).toBe("danger");
		expect(statusTone(null)).toBe("muted");
		expect(statusTone("whatever")).toBe("muted");
	});
});
