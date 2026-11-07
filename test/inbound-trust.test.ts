/**
 * The trust decision `receiveEmail` acts on: whether to honour an
 * unsubscribe-by-email, send an auto-reply, or forward. Built from the stored
 * header array exactly as postal-mime hands it over.
 */

import { describe, expect, it } from "vitest";
import { assessInboundTrust, buildKnownNames, computeSenderWarnings } from "../workers/lib/inbound-trust";

const h = (...pairs: [string, string][]) => pairs.map(([key, value]) => ({ key: key.toLowerCase(), value }));

describe("assessInboundTrust", () => {
	it("authenticates a DMARC pass from our MX", () => {
		const t = assessInboundTrust(h(["Authentication-Results", "mx.cloudflare.net; dmarc=pass header.from=x.com"]), "a@x.com");
		expect(t).toMatchObject({ authenticated: true, failed: false });
	});

	it("authenticates an aligned DKIM pass under the public suffix list", () => {
		const t = assessInboundTrust(h(["Authentication-Results", "mx.cloudflare.net; dkim=pass header.d=mail.example.co.uk"]), "a@example.co.uk");
		expect(t.authenticated).toBe(true);
	});

	it("does not authenticate a DKIM pass for a different co.uk organisation", () => {
		const t = assessInboundTrust(h(["Authentication-Results", "mx.cloudflare.net; dkim=pass header.d=attacker.co.uk"]), "a@victim.co.uk");
		expect(t.authenticated).toBe(false);
	});

	it("treats a forged pass as not authenticated and not failed", () => {
		// Unsubscribe and auto-reply refuse; forwarding still goes, since Routing
		// has already rejected outright failures.
		const forged = assessInboundTrust(
			h(["ARC-Authentication-Results", "i=1; mx.cloudflare.net; dmarc=pass"], ["Authentication-Results", "mx.google.com; dmarc=pass"]),
			"ceo@x.com",
		);
		expect(forged).toMatchObject({ auth: null, authenticated: false, failed: false });
	});

	it("marks a DMARC failure as failed", () => {
		const t = assessInboundTrust(h(["Authentication-Results", "mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail"]), "a@x.com");
		expect(t).toMatchObject({ authenticated: false, failed: true });
	});

	it("handles absent headers", () => {
		expect(assessInboundTrust(undefined, "a@x.com")).toMatchObject({ auth: null, authenticated: false, failed: false });
	});
});

describe("computeSenderWarnings", () => {
	const sources = {
		mailboxId: "govind@tapetide.com",
		mailboxName: "Govind",
		localMailboxes: ["govind@tapetide.com", "support@tapetide.com"],
		ownDomains: ["tapetide.com"],
		frequent: [{ address: "billing@stripe.com", name: "Stripe Billing" }],
	};

	it("builds known names from the mailbox and frequent correspondents", () => {
		const names = buildKnownNames(sources);
		expect(names.get("govind")).toEqual(["govind@tapetide.com"]);
		expect(names.get("stripe billing")).toEqual(["billing@stripe.com"]);
	});

	it("warns about a lookalike of a frequent correspondent's domain", () => {
		const kinds = computeSenderWarnings({
			from: "billing@str1pe.com",
			fromName: "Stripe Billing",
			html: null,
			hasHistory: false,
			inKnownThread: false,
			sources,
		}).map((w) => w.kind);
		expect(kinds).toContain("lookalike_domain");
		expect(kinds).toContain("display_name_spoof");
		expect(kinds).toContain("first_time_sender");
	});
});
