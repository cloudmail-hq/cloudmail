/**
 * Reader warnings and the domain comparisons under them.
 *
 * Every case is an impersonation shape that works on people, plus the
 * legitimate look-alike that must not trip it.
 */

import { describe, expect, it } from "vitest";
import {
	decodePunycode,
	editDistance,
	findLookalike,
	isMixedScript,
	registrableDomain,
	sameOrganization,
	skeleton,
	toUnicodeHost,
} from "../shared/domain-safety";
import {
	assessSenderWarnings,
	detectDisplayNameSpoof,
	detectFirstTimeSender,
	detectLinkMismatch,
	detectLookalikeSender,
	findLinkMismatches,
	type SenderWarningInput,
} from "../shared/sender-warnings";
import { parseSenderWarnings, serializeSenderWarnings } from "../shared/sender-warning-types";

const base: SenderWarningInput = {
	from: "alice@vendor.example",
	fromName: "Alice",
	html: "<p>Hello</p>",
	ownDomains: ["tapetide.com"],
	ownMailboxes: ["support@tapetide.com", "govind@tapetide.com"],
	knownNames: new Map([
		["govind sharma", ["govind@tapetide.com"]],
		["stripe", ["notifications@stripe.com"]],
	]),
	frequentDomains: ["stripe.com", "github.com"],
	hasHistory: true,
};

describe("domain-safety", () => {
	it("uses the public suffix list for the registrable domain", () => {
		expect(registrableDomain("a.b.example.co.uk")).toBe("example.co.uk");
		expect(registrableDomain("news.github.com")).toBe("github.com");
		// Private suffixes: two github.io sites are different organisations.
		expect(sameOrganization("alice.github.io", "bob.github.io")).toBe(false);
		expect(sameOrganization("mail.example.co.uk", "example.co.uk")).toBe(true);
	});

	it("decodes punycode labels", () => {
		expect(decodePunycode("pypal-4ve")).toBe("pаypal");
		expect(toUnicodeHost("xn--pypal-4ve.com")).toBe("pаypal.com");
		expect(toUnicodeHost("xn--mnchen-3ya.de")).toBe("münchen.de");
		expect(decodePunycode("!!!")).toBeNull();
	});

	it("flags mixed-script labels and leaves single-script IDNs alone", () => {
		expect(isMixedScript("xn--pypal-4ve.com")).toBe(true);
		expect(isMixedScript("xn--mnchen-3ya.de")).toBe(false);
		expect(isMixedScript("example.com")).toBe(false);
	});

	it("reduces lookalikes to the same skeleton", () => {
		expect(skeleton("xn--pypal-4ve.com")).toBe(skeleton("paypal.com"));
		expect(skeleton("rnicrosoft.com")).toBe(skeleton("microsoft.com"));
		expect(skeleton("g00gle.com")).toBe(skeleton("google.com"));
	});

	it("measures edit distance with transpositions", () => {
		expect(editDistance("tapetide", "tapetide")).toBe(0);
		expect(editDistance("tapetide", "tapetlde")).toBe(1);
		expect(editDistance("tapetide", "taeptide")).toBe(1);
		expect(editDistance("tapetide", "tapetidee")).toBe(1);
		expect(editDistance("a", "abcdef", 2)).toBe(3);
	});

	it("finds typo, homograph, suffix-swap and embedded lookalikes", () => {
		const trusted = ["tapetide.com", "stripe.com"];
		expect(findLookalike("tapetlde.com", trusted)).toMatchObject({ reason: "typo", imitates: "tapetide.com" });
		expect(findLookalike("xn--strpe-p2e.com", ["stripe.com"])?.imitates).toBe("stripe.com");
		expect(findLookalike("tapetide.co", trusted)).toMatchObject({ reason: "suffix_swap" });
		expect(findLookalike("stripe.com.billing-update.xyz", trusted)).toMatchObject({ reason: "embedded", imitates: "stripe.com" });
	});

	it("does not flag our own subdomains or unrelated domains", () => {
		const trusted = ["tapetide.com", "stripe.com"];
		expect(findLookalike("mail.tapetide.com", trusted)).toBeNull();
		expect(findLookalike("example.org", trusted)).toBeNull();
		// Short names: one edit apart is a different word, not a lookalike.
		expect(findLookalike("ab.com", ["ac.com"])).toBeNull();
	});
});

describe("display-name spoofing", () => {
	it("flags an address in the name that differs from the sender", () => {
		const w = detectDisplayNameSpoof({ ...base, fromName: "support@paypal.com", from: "x@evil.test" });
		expect(w?.kind).toBe("display_name_spoof");
		expect(w?.detail?.shown).toBe("support@paypal.com");
	});

	it("flags a domain in the name that differs from the sender", () => {
		expect(detectDisplayNameSpoof({ ...base, fromName: "PayPal.com Security", from: "x@evil.test" })?.kind).toBe("display_name_spoof");
	});

	it("does not flag a name that matches the sending organisation", () => {
		expect(detectDisplayNameSpoof({ ...base, fromName: "billing@stripe.com", from: "receipts@mail.stripe.com" })).toBeNull();
		expect(detectDisplayNameSpoof({ ...base, fromName: "Stripe.com", from: "notifications@stripe.com" })).toBeNull();
	});

	it("does not flag a known name from another address at the same organisation", () => {
		const names = new Map([["cloudflare", ["connectevent@cloudflare.com"]]]);
		expect(
			detectDisplayNameSpoof({ ...base, knownNames: names, fromName: "Cloudflare", from: "noreply@notify.cloudflare.com" }),
		).toBeNull();
		// A different organisation using the name is still flagged.
		expect(
			detectDisplayNameSpoof({ ...base, knownNames: names, fromName: "Cloudflare", from: "noreply@cloudflare-billing.example" })?.kind,
		).toBe("display_name_spoof");
	});

	it("does not mistake an ordinary name with a dot for a domain", () => {
		expect(detectDisplayNameSpoof({ ...base, fromName: "J.R. Smith", from: "jr@x.example" })).toBeNull();
	});

	it("flags our own mailbox's name from an outside address (CEO fraud)", () => {
		const w = detectDisplayNameSpoof({ ...base, fromName: "Govind Sharma", from: "govind.sharma.ceo@gmail.com" });
		expect(w?.message).toContain("your own mailboxes");
	});

	it("flags a known contact's name from a different address", () => {
		const w = detectDisplayNameSpoof({ ...base, fromName: "Stripe", from: "stripe-billing@evil.test" });
		expect(w?.detail?.usual).toBe("notifications@stripe.com");
	});

	it("does not flag the known contact writing from their own address", () => {
		expect(detectDisplayNameSpoof({ ...base, fromName: "Stripe", from: "notifications@stripe.com" })).toBeNull();
	});
});

describe("lookalike sender", () => {
	it("flags a sender one letter off our own domain", () => {
		const w = detectLookalikeSender({ ...base, from: "ceo@tapetlde.com" });
		expect(w?.kind).toBe("lookalike_domain");
		expect(w?.detail?.imitates).toBe("tapetide.com");
	});

	it("flags an IDN homograph of a frequent correspondent and shows it decoded", () => {
		const w = detectLookalikeSender({ ...base, from: "billing@xn--strpe-p2e.com" });
		expect(w?.kind).toBe("lookalike_domain");
		expect(w?.detail?.decoded).toBeDefined();
	});

	it("flags a mixed-script domain that imitates nothing we know", () => {
		expect(detectLookalikeSender({ ...base, from: "a@xn--pypal-4ve.com" })?.detail?.reason).toMatch(/homograph|mixed_script/);
	});

	it("leaves the real domain alone", () => {
		expect(detectLookalikeSender({ ...base, from: "notifications@stripe.com" })).toBeNull();
	});
});

describe("first-time sender", () => {
	it("flags a stranger", () => {
		expect(detectFirstTimeSender({ ...base, hasHistory: false })?.kind).toBe("first_time_sender");
	});

	it("does not flag known history, a known thread, or a colleague", () => {
		expect(detectFirstTimeSender({ ...base, hasHistory: true })).toBeNull();
		expect(detectFirstTimeSender({ ...base, hasHistory: false, inKnownThread: true })).toBeNull();
		expect(detectFirstTimeSender({ ...base, hasHistory: false, from: "new@tapetide.com" })).toBeNull();
	});
});

describe("link mismatch", () => {
	it("flags anchor text showing one domain while the href goes elsewhere", () => {
		const html = '<a href="https://evil.test/login">https://www.paypal.com/signin</a>';
		expect(findLinkMismatches(html)).toEqual([{ shown: "www.paypal.com", actual: "evil.test" }]);
		expect(detectLinkMismatch({ html })?.message).toContain("www.paypal.com");
	});

	it("reads bare domains, entities and nested markup in the text", () => {
		expect(findLinkMismatches('<a href="https://evil.test/">  <b>paypal.com</b> </a>')).toHaveLength(1);
		expect(findLinkMismatches('<a href="https://evil.test/?a=1&amp;b=2">paypal&#46;com</a>')).toHaveLength(1);
	});

	it("ignores ordinary link text and same-organisation redirects", () => {
		expect(findLinkMismatches('<a href="https://evil.test">Click here</a>')).toEqual([]);
		expect(findLinkMismatches('<a href="https://click.github.com/x">github.com/settings</a>')).toEqual([]);
		// A sentence ending in a period is not a domain.
		expect(findLinkMismatches('<a href="https://evil.test">Read more.</a>')).toEqual([]);
		expect(findLinkMismatches('<a href="mailto:a@b.com">paypal.com</a>')).toEqual([]);
	});

	it("reports each domain pair once", () => {
		const html = '<a href="https://evil.test">paypal.com</a><a href="https://evil.test/2">paypal.com</a>';
		expect(findLinkMismatches(html)).toHaveLength(1);
	});
});

describe("assessSenderWarnings", () => {
	it("returns nothing for a known, clean sender", () => {
		expect(assessSenderWarnings(base)).toEqual([]);
	});

	it("combines warnings, most serious first", () => {
		const kinds = assessSenderWarnings({
			...base,
			from: "ceo@tapetlde.com",
			fromName: "Govind Sharma",
			html: '<a href="https://evil.test">tapetide.com/invoice</a>',
			hasHistory: false,
		}).map((w) => w.kind);
		expect(kinds).toEqual(["lookalike_domain", "display_name_spoof", "link_mismatch", "first_time_sender"]);
	});

	it("round-trips through storage and tolerates junk", () => {
		const w = assessSenderWarnings({ ...base, hasHistory: false });
		expect(parseSenderWarnings(serializeSenderWarnings(w))).toEqual(w);
		expect(serializeSenderWarnings([])).toBeNull();
		expect(parseSenderWarnings("not json")).toEqual([]);
		expect(parseSenderWarnings('[{"kind":"bogus","message":"x"},7]')).toEqual([]);
	});
});
