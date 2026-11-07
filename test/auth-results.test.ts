import { describe, expect, it } from "vitest";
import {
	assessSenderTrust,
	didAuthenticationFail,
	extractAuthenticationResults,
	isSenderAuthenticated,
	isSenderTrustAlarming,
	parseAuthenticationResults,
} from "../shared/auth-results";

const headers = (entries: Record<string, string>) =>
	JSON.stringify(
		Object.entries(entries).map(([key, value]) => ({ key, value })),
	);

describe("parseAuthenticationResults", () => {
	it("parses a typical three-method header", () => {
		const r = parseAuthenticationResults(
			"mx.cloudflare.net; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=example.com; dmarc=pass header.from=example.com",
		);
		expect(r.authservId).toBe("mx.cloudflare.net");
		expect(r.dkim).toBe("pass");
		expect(r.spf).toBe("pass");
		expect(r.dmarc).toBe("pass");
		expect(r.dkimDomain).toBe("example.com");
		expect(r.spfMailfrom).toBe("example.com");
		expect(r.dmarcDomain).toBe("example.com");
		expect(r.viaArc).toBe(false);
	});

	it("does not mistake ptype.property pairs for methods", () => {
		// `smtp.mailfrom=example.com` must not be read as a method named
		// "smtp.mailfrom" with result "example".
		const r = parseAuthenticationResults(
			"mx.example.net; spf=softfail smtp.mailfrom=bounce.example.com",
		);
		expect(r.spf).toBe("softfail");
		expect(r.spfMailfrom).toBe("bounce.example.com");
	});

	it("handles method versions", () => {
		const r = parseAuthenticationResults("mx.example.net; dkim/1=pass header.d=a.com");
		expect(r.dkim).toBe("pass");
	});

	it("matches property names literally, dots included", () => {
		// The property lookup builds a RegExp, so the dot in "smtp.mailfrom" has to
		// be escaped: unescaped it matches any character, and a header carrying an
		// unrelated `smtpxmailfrom` would be read as the envelope sender.
		const r = parseAuthenticationResults(
			"mx.example.net; spf=pass smtpxmailfrom=attacker.example.com",
		);
		expect(r.spf).toBe("pass");
		expect(r.spfMailfrom).toBeUndefined();
	});

	it("strips comments", () => {
		const r = parseAuthenticationResults(
			"mx.example.net; spf=pass (mailfrom: sender ok) smtp.mailfrom=example.com; dmarc=fail (p=reject)",
		);
		expect(r.spf).toBe("pass");
		expect(r.dmarc).toBe("fail");
	});

	it("keeps a passing DKIM signature when another signature fails", () => {
		// Multi-signature mail is common with mailing lists; one valid signature
		// authenticates the message, so a later failure must not overwrite it.
		const r = parseAuthenticationResults(
			"mx.example.net; dkim=pass header.d=good.com; dkim=fail header.d=bad.com",
		);
		expect(r.dkim).toBe("pass");
		expect(r.dkimDomain).toBe("good.com");
	});

	it("keeps a passing signature that appears after a failing one", () => {
		const r = parseAuthenticationResults(
			"mx.example.net; dkim=fail header.d=bad.com; dkim=pass header.d=good.com",
		);
		expect(r.dkim).toBe("pass");
		expect(r.dkimDomain).toBe("good.com");
	});

	it("skips the ARC instance number when reading the authserv-id", () => {
		const r = parseAuthenticationResults("i=1; mx.google.com; spf=fail", {
			viaArc: true,
		});
		expect(r.authservId).toBeUndefined();
		expect(r.spf).toBe("fail");
		expect(r.viaArc).toBe(true);
	});

	it("maps unrecognised result tokens to unknown", () => {
		const r = parseAuthenticationResults("mx.example.net; spf=weird");
		expect(r.spf).toBe("unknown");
	});

	it("tolerates a bare authserv-id with no methods", () => {
		const r = parseAuthenticationResults("mx.example.net; none");
		expect(r.authservId).toBe("mx.example.net");
		expect(r.spf).toBeUndefined();
		expect(r.dkim).toBeUndefined();
		expect(r.dmarc).toBeUndefined();
	});

	it("returns an empty result for an empty header", () => {
		expect(parseAuthenticationResults("")).toEqual({ viaArc: false });
	});
});

describe("extractAuthenticationResults", () => {
	it("finds the header case-insensitively", () => {
		const r = extractAuthenticationResults(
			headers({ "authentication-results": "mx.cloudflare.net; dmarc=pass" }),
		);
		expect(r?.dmarc).toBe("pass");
	});

	it("prefers Authentication-Results over the ARC variant", () => {
		const r = extractAuthenticationResults(
			headers({
				"ARC-Authentication-Results": "i=1; upstream.example; dmarc=fail",
				"Authentication-Results": "mx.cloudflare.net; dmarc=pass",
			}),
		);
		expect(r?.dmarc).toBe("pass");
		expect(r?.viaArc).toBe(false);
	});

	it("never derives a pass from ARC, even a well-formed Cloudflare-sealed set", () => {
		const r = extractAuthenticationResults(
			headers({
				"ARC-Seal": "i=1; a=rsa-sha256; cv=none; d=cloudflare.net; s=arc-2022; b=x",
				"ARC-Authentication-Results": "i=1; mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass",
			}),
		);
		expect(r).toBeNull();
		expect(assessSenderTrust(r).level).toBe("unknown");
	});

	it("keeps an ARC failure from a trusted sealer, flagged as ARC", () => {
		const r = extractAuthenticationResults(
			headers({
				"ARC-Seal": "i=1; a=rsa-sha256; cv=none; d=cloudflare.net; s=arc-2022; b=x",
				"ARC-Authentication-Results": "i=1; mx.cloudflare.net; spf=pass; dkim=fail; dmarc=fail",
			}),
		);
		expect(r?.viaArc).toBe(true);
		expect(r?.dmarc).toBe("fail");
		expect(r?.spf).toBeUndefined();
	});

	it("returns null when no verdicts are present", () => {
		expect(extractAuthenticationResults(headers({ Subject: "hi" }))).toBeNull();
	});

	it("returns null for absent, malformed, or non-array raw_headers", () => {
		expect(extractAuthenticationResults(null)).toBeNull();
		expect(extractAuthenticationResults(undefined)).toBeNull();
		expect(extractAuthenticationResults("")).toBeNull();
		expect(extractAuthenticationResults("not json")).toBeNull();
		expect(extractAuthenticationResults('{"key":"value"}')).toBeNull();
	});

	it("survives header entries with missing fields", () => {
		expect(
			extractAuthenticationResults(JSON.stringify([{}, { key: null }, 7])),
		).toBeNull();
	});
});

describe("assessSenderTrust", () => {
	const parse = (v: string) => assessSenderTrust(parseAuthenticationResults(v));

	it("treats a DMARC failure as forged", () => {
		const t = parse("mx.example.net; spf=pass; dkim=pass; dmarc=fail");
		expect(t.level).toBe("failed");
		expect(isSenderTrustAlarming(t.level)).toBe(true);
	});

	it("treats SPF and DKIM both failing as forged even without a DMARC verdict", () => {
		expect(parse("mx.example.net; spf=fail; dkim=fail").level).toBe("failed");
	});

	it("reports verified on a DMARC pass and names the signer", () => {
		const t = parse("mx.example.net; dkim=pass header.d=example.com; dmarc=pass");
		expect(t.level).toBe("verified");
		expect(t.summary).toContain("example.com");
		expect(isSenderTrustAlarming(t.level)).toBe(false);
	});

	it("reports partial when DKIM passes but DMARC is silent", () => {
		const t = parse("mx.example.net; dkim=pass header.d=example.com");
		expect(t.level).toBe("partial");
		expect(t.summary).toContain("DKIM");
	});

	it("reports partial when only SPF passes", () => {
		expect(parse("mx.example.net; spf=pass").summary).toContain("SPF");
	});

	it("reports unverified when checks ran but nothing passed", () => {
		expect(parse("mx.example.net; spf=neutral; dkim=none").level).toBe(
			"unverified",
		);
	});

	it("reports unknown rather than implying safety when nothing was recorded", () => {
		// Sent mail and pre-existing rows have no verdicts. Showing "verified"
		// there would be actively misleading.
		expect(assessSenderTrust(null).level).toBe("unknown");
		expect(parse("mx.example.net").level).toBe("unknown");
	});

	it("does not treat softfail alone as an outright failure", () => {
		// softfail is advisory; DMARC is the authority. Escalating it would flag
		// large amounts of legitimately forwarded mail.
		expect(parse("mx.example.net; spf=softfail").level).toBe("unverified");
	});

	it("does not escalate a temporary error to a failure", () => {
		expect(parse("mx.example.net; spf=temperror; dkim=temperror").level).toBe(
			"unverified",
		);
	});
});

/**
 * A sender writes every header except the ones our MX prepends, so any header
 * claiming a pass can be forged. These are the shapes a phisher would try.
 */
describe("forged authentication headers", () => {
	const raw = (pairs: [string, string][]) =>
		JSON.stringify(pairs.map(([key, value]) => ({ key, value })));
	const trustOf = (pairs: [string, string][]) =>
		assessSenderTrust(extractAuthenticationResults(raw(pairs))).level;

	it("ignores a forged dmarc=pass from an unknown authserv-id", () => {
		expect(trustOf([["Authentication-Results", "mx.google.com; spf=pass; dkim=pass header.d=paypal.com; dmarc=pass header.from=paypal.com"]])).toBe("unknown");
	});

	it("ignores a forged ARC-Authentication-Results when our A-R is missing", () => {
		expect(trustOf([["ARC-Authentication-Results", "i=1; mx.google.com; dmarc=pass"]])).toBe("unknown");
	});

	it("ignores a forged ARC chain claiming Cloudflare as the sealer", () => {
		expect(
			trustOf([
				["ARC-Seal", "i=1; a=rsa-sha256; cv=none; d=cloudflare.net; s=arc; b=forged"],
				["ARC-Message-Signature", "i=1; a=rsa-sha256; d=cloudflare.net; s=arc; b=forged"],
				["ARC-Authentication-Results", "i=1; mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass"],
			]),
		).toBe("unknown");
	});

	it("uses the topmost A-R, never a forged one further down that names our MX", () => {
		// Ours (top) says fail; the sender-written one below claims pass.
		expect(
			trustOf([
				["Authentication-Results", "mx.cloudflare.net; spf=fail; dkim=none; dmarc=fail header.from=paypal.com"],
				["Authentication-Results", "mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass"],
			]),
		).toBe("failed");
	});

	it("does not reach past an untrusted topmost A-R to a trusted-looking one below", () => {
		// No header from our MX on top: the lower mx.cloudflare.net line is the forgery.
		expect(
			trustOf([
				["Authentication-Results", "relay.example; spf=none"],
				["Authentication-Results", "mx.cloudflare.net; dmarc=pass"],
			]),
		).toBe("unknown");
	});

	it("only reads ARC at the highest instance", () => {
		// i=2 is ours (no verdict worth keeping beyond fail); i=1 is pre-forged.
		const r = extractAuthenticationResults(
			raw([
				["ARC-Seal", "i=2; cv=pass; d=cloudflare.net; s=arc; b=x"],
				["ARC-Authentication-Results", "i=2; mx.cloudflare.net; dmarc=fail"],
				["ARC-Seal", "i=1; cv=none; d=cloudflare.net; s=arc; b=forged"],
				["ARC-Authentication-Results", "i=1; mx.cloudflare.net; dmarc=pass"],
			]),
		);
		expect(r?.dmarc).toBe("fail");
	});

	it("rejects ARC with a sealer outside the allowlist", () => {
		expect(
			extractAuthenticationResults(
				raw([
					["ARC-Seal", "i=1; cv=none; d=evil.example; s=arc; b=x"],
					["ARC-Authentication-Results", "i=1; mx.cloudflare.net; dmarc=fail"],
				]),
			),
		).toBeNull();
	});

	it("rejects ARC with duplicate sets at the top instance", () => {
		expect(
			extractAuthenticationResults(
				raw([
					["ARC-Seal", "i=1; cv=none; d=cloudflare.net; b=x"],
					["ARC-Seal", "i=1; cv=none; d=cloudflare.net; b=y"],
					["ARC-Authentication-Results", "i=1; mx.cloudflare.net; dmarc=fail"],
				]),
			),
		).toBeNull();
	});

	it("matches the authserv-id case-insensitively and tolerates a trailing dot", () => {
		expect(trustOf([["Authentication-Results", "MX.Cloudflare.NET.; dmarc=pass"]])).toBe("verified");
	});

	it("accepts a configured authserv-id", () => {
		const r = extractAuthenticationResults(raw([["Authentication-Results", "mx.custom.example; dmarc=pass"]]), {
			trustedAuthservIds: ["mx.custom.example"],
		});
		expect(assessSenderTrust(r).level).toBe("verified");
	});
});

describe("isSenderAuthenticated", () => {
	const sameOrg = (a: string, b: string) => a.split(".").slice(-2).join(".") === b.split(".").slice(-2).join(".");
	const parse = (v: string) => parseAuthenticationResults(v);

	it("accepts a DMARC pass", () => {
		expect(isSenderAuthenticated(parse("mx.cloudflare.net; dmarc=pass"), "a@x.com", sameOrg)).toBe(true);
	});

	it("accepts a DKIM pass aligned with From", () => {
		expect(isSenderAuthenticated(parse("mx.cloudflare.net; dkim=pass header.d=mail.x.com"), "a@x.com", sameOrg)).toBe(true);
	});

	it("accepts an SPF pass aligned with From", () => {
		expect(isSenderAuthenticated(parse("mx.cloudflare.net; spf=pass smtp.mailfrom=bounce@x.com"), "a@x.com", sameOrg)).toBe(true);
	});

	it("refuses an unaligned pass: DKIM signed by someone else", () => {
		expect(isSenderAuthenticated(parse("mx.cloudflare.net; dkim=pass header.d=evil.test"), "ceo@x.com", sameOrg)).toBe(false);
	});

	it("refuses a DMARC fail even with an aligned DKIM pass", () => {
		expect(isSenderAuthenticated(parse("mx.cloudflare.net; dkim=pass header.d=x.com; dmarc=fail"), "a@x.com", sameOrg)).toBe(false);
	});

	it("refuses null and ARC-derived results", () => {
		expect(isSenderAuthenticated(null, "a@x.com", sameOrg)).toBe(false);
		expect(isSenderAuthenticated({ viaArc: true, dmarc: "pass" }, "a@x.com", sameOrg)).toBe(false);
	});
});

describe("didAuthenticationFail", () => {
	it("is true for DMARC fail or SPF+DKIM both failing, and false for unknown", () => {
		expect(didAuthenticationFail(parseAuthenticationResults("mx.cloudflare.net; dmarc=fail"))).toBe(true);
		expect(didAuthenticationFail(parseAuthenticationResults("mx.cloudflare.net; spf=fail; dkim=fail"))).toBe(true);
		expect(didAuthenticationFail(parseAuthenticationResults("mx.cloudflare.net; spf=fail; dkim=pass"))).toBe(false);
		expect(didAuthenticationFail(null)).toBe(false);
	});
});
