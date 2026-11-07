// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for per-mailbox forwarding.
 *
 * Two areas carry real risk. Loop prevention: a missed rule means a mail loop
 * that amplifies until a provider cuts the domain off. And display-name
 * sanitisation: the name comes from an attacker-controlled `From` header and is
 * interpolated into an address field, so an unescaped quote or newline is header
 * injection.
 */

import { describe, expect, it } from "vitest";
import {
	FORWARDED_HEADER,
	buildForwardDisplayName,
	buildForwardHeaderBlock,
	decideForward,
	normalizeAddress,
	selectForwardAttachments,
} from "../shared/forwarding";

const base = {
	mailboxId: "support@acme.com",
	localMailboxes: ["support@acme.com", "sales@acme.com"],
	inboundHeaderKeys: ["from", "to", "subject"],
};

describe("decideForward", () => {
	it("skips when forwarding is off", () => {
		expect(decideForward({ ...base, settings: { enabled: false, email: "ops@x.com" } })).toEqual({
			skip: "disabled",
		});
	});

	it("skips when settings are absent entirely", () => {
		expect(decideForward({ ...base, settings: undefined })).toEqual({ skip: "disabled" });
	});

	it("skips an enabled toggle with no address, rather than sending nowhere", () => {
		expect(decideForward({ ...base, settings: { enabled: true, email: "  " } })).toEqual({
			skip: "no-target",
		});
	});

	it("rejects a malformed address", () => {
		for (const email of ["not-an-email", "missing@tld", "@example.com", "a b@c.com"]) {
			expect(decideForward({ ...base, settings: { enabled: true, email } }).skip).toBe(
				"invalid-target",
			);
		}
	});

	it("forwards to a valid external address", () => {
		expect(
			decideForward({ ...base, settings: { enabled: true, email: "Ops@Example.COM" } }),
		).toEqual({ target: "ops@example.com", skip: null });
	});

	it("refuses a mailbox pointed at itself", () => {
		expect(
			decideForward({ ...base, settings: { enabled: true, email: "SUPPORT@acme.com" } }).skip,
		).toBe("loop-self");
	});

	it("refuses a target that is another mailbox on this deployment", () => {
		expect(
			decideForward({ ...base, settings: { enabled: true, email: "sales@acme.com" } }).skip,
		).toBe("loop-local-mailbox");
	});

	it("refuses a message this deployment already forwarded", () => {
		expect(
			decideForward({
				...base,
				settings: { enabled: true, email: "ops@example.com" },
				inboundHeaderKeys: ["from", FORWARDED_HEADER.toLowerCase()],
			}).skip,
		).toBe("loop-already-forwarded");
	});

	it("matches the forwarded marker regardless of header case", () => {
		expect(
			decideForward({
				...base,
				settings: { enabled: true, email: "ops@example.com" },
				inboundHeaderKeys: ["X-TAPETIDE-FORWARDED-FOR"],
			}).skip,
		).toBe("loop-already-forwarded");
	});

	it("checks the loop marker before the address, so a loop can't be masked", () => {
		// A self-forward that is also already-forwarded must report the marker:
		// that is the rule which stops loops arriving via an external hop.
		expect(
			decideForward({
				...base,
				settings: { enabled: true, email: "support@acme.com" },
				inboundHeaderKeys: [FORWARDED_HEADER],
			}).skip,
		).toBe("loop-already-forwarded");
	});

	it("never returns a target alongside a skip reason", () => {
		const decision = decideForward({
			...base,
			settings: { enabled: true, email: "sales@acme.com" },
		});
		expect(decision.skip).not.toBeNull();
		expect(decision.target).toBeUndefined();
	});
});

describe("normalizeAddress", () => {
	it("trims and lowercases", () => {
		expect(normalizeAddress("  Ops@Example.COM ")).toBe("ops@example.com");
	});

	it("maps nullish to empty rather than throwing", () => {
		expect(normalizeAddress(undefined)).toBe("");
		expect(normalizeAddress(null)).toBe("");
	});
});

describe("buildForwardDisplayName", () => {
	it("names the sender and the mailbox it came through", () => {
		expect(
			buildForwardDisplayName({
				originalName: "Jane Customer",
				originalAddress: "jane@example.com",
				mailboxName: "Acme Support",
			}),
		).toBe("Jane Customer (via Acme Support)");
	});

	it("falls back to the address when there is no name", () => {
		expect(
			buildForwardDisplayName({
				originalAddress: "jane@example.com",
				mailboxName: "Acme Support",
			}),
		).toBe("jane@example.com (via Acme Support)");
	});

	it("omits the via clause when the mailbox has no display name", () => {
		expect(
			buildForwardDisplayName({ originalName: "Jane", mailboxName: "" }),
		).toBe("Jane");
	});

	it("says so rather than rendering an empty name", () => {
		expect(buildForwardDisplayName({})).toBe("Unknown sender");
	});

	it("strips quotes and angle brackets that would break out of the header", () => {
		const name = buildForwardDisplayName({
			originalName: 'Evil" <attacker@evil.com>, x',
			mailboxName: "Support",
		});
		expect(name).not.toMatch(/["<>,]/);
		expect(name).toContain("(via Support)");
	});

	it("strips newlines that would inject a header", () => {
		const name = buildForwardDisplayName({
			originalName: "Bad\r\nBcc: victim@example.com",
			mailboxName: "Support",
		});
		expect(name).not.toMatch(/[\r\n]/);
	});

	it("truncates an absurdly long name", () => {
		const name = buildForwardDisplayName({
			originalName: "a".repeat(500),
			mailboxName: "Support",
		});
		expect(name.length).toBeLessThanOrEqual(120);
		expect(name.endsWith("…")).toBe(true);
	});
});

describe("buildForwardHeaderBlock", () => {
	it("restates the original envelope", () => {
		const { html, text } = buildForwardHeaderBlock({
			from: "Jane <jane@example.com>",
			date: "Fri, 14 Aug 2026 10:00:00 GMT",
			subject: "Help with my order",
			to: "support@acme.com",
			cc: "boss@example.com",
		});

		for (const field of ["From", "Date", "Subject", "To", "Cc"]) {
			expect(html).toContain(field);
			expect(text).toContain(field);
		}
		expect(text).toContain("Help with my order");
	});

	it("omits rows it has no value for", () => {
		const { html } = buildForwardHeaderBlock({ subject: "Hi" });
		expect(html).not.toContain("Cc");
		expect(html).toContain("Subject");
	});

	it("summarises authentication verdicts", () => {
		const { text } = buildForwardHeaderBlock({
			auth: { spf: "pass", dkim: "pass", dmarc: "fail", viaArc: false },
		});
		expect(text).toContain("SPF pass");
		expect(text).toContain("DMARC fail");
	});

	it("marks verdicts that only came from ARC", () => {
		const { text } = buildForwardHeaderBlock({
			auth: { spf: "pass", viaArc: true },
		});
		expect(text).toContain("via ARC");
	});

	it("says nothing about authentication when there are no verdicts", () => {
		const { text } = buildForwardHeaderBlock({ auth: { viaArc: false } });
		expect(text).not.toContain("Authentication");
	});

	it("escapes HTML in header values", () => {
		const { html } = buildForwardHeaderBlock({
			subject: "<img src=x onerror=alert(1)>",
		});
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img");
	});

	it("names attachments it had to leave out", () => {
		const { text } = buildForwardHeaderBlock({
			omittedAttachments: ["huge.zip (9.0 MB)"],
		});
		expect(text).toContain("huge.zip");
		expect(text).toContain("omitted");
	});
});

describe("selectForwardAttachments", () => {
	const file = (filename: string, size: number) => ({ filename, size });

	it("includes everything that fits", () => {
		const result = selectForwardAttachments(
			[file("a.pdf", 1000), file("b.pdf", 2000)],
			0,
			1_000_000,
		);
		expect(result.included).toHaveLength(2);
		expect(result.omitted).toEqual([]);
	});

	it("omits what doesn't fit, naming it with its size", () => {
		const result = selectForwardAttachments([file("huge.zip", 10_000)], 0, 1_000);
		expect(result.included).toEqual([]);
		expect(result.omitted).toHaveLength(1);
		expect(result.omitted[0]).toContain("huge.zip");
	});

	it("keeps smaller files behind an oversized one", () => {
		// The point of not stopping at the first miss: three of four files plus a
		// note beats none.
		const result = selectForwardAttachments(
			[file("huge.zip", 10_000), file("small.txt", 100)],
			0,
			1_000,
		);
		expect(result.included.map((a) => a.filename)).toEqual(["small.txt"]);
		expect(result.omitted[0]).toContain("huge.zip");
	});

	it("counts the body against the budget", () => {
		// 900 bytes of body leaves no room for a 400-byte attachment in a 1000
		// byte budget, even though the attachment alone would fit.
		const result = selectForwardAttachments([file("a.pdf", 400)], 900, 1_000);
		expect(result.included).toEqual([]);
	});

	it("accounts for base64 expansion rather than raw size", () => {
		// 750 raw bytes encode to over 1000, so a 1000-byte budget cannot take it.
		const result = selectForwardAttachments([file("a.bin", 750)], 0, 1_000);
		expect(result.included).toEqual([]);
	});

	it("handles an empty attachment list", () => {
		expect(selectForwardAttachments([], 0, 1_000)).toEqual({
			included: [],
			omitted: [],
		});
	});
});
