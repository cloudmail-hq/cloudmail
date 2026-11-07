// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The outgoing-HTML tracking rewrite. Signing is faked (the real crypto is
 * covered in tracking-token.test.ts), so these pin exactly which links get
 * wrapped, which are left alone, and where the pixel lands.
 */

import { describe, expect, it } from "vitest";
import { injectTracking } from "../shared/tracking-inject";

const base = {
	baseUrl: "https://mailer.tapetide.com",
	openTracking: true,
	clickTracking: true,
	// Fake signers: the "token" encodes what was signed, so assertions can read it.
	signOpen: async () => "OPEN_TOKEN",
	signClick: async (url: string) => `CLICK_${encodeURIComponent(url)}`,
};

describe("click rewriting", () => {
	it("wraps an http(s) link in a signed redirect carrying the real URL", async () => {
		const out = await injectTracking(
			'<a href="https://tapetide.com/pricing">Pricing</a>',
			{ ...base, openTracking: false },
		);
		expect(out).toContain(
			`href="https://mailer.tapetide.com/t/c/CLICK_${encodeURIComponent("https://tapetide.com/pricing")}"`,
		);
		expect(out).toContain(">Pricing</a>");
	});

	it("leaves mailto, tel and anchor links untouched", async () => {
		const html =
			'<a href="mailto:x@y.com">mail</a><a href="tel:+15551234">call</a><a href="#top">top</a>';
		const out = await injectTracking(html, { ...base, openTracking: false });
		expect(out).toBe(html);
	});

	it("leaves relative links untouched — no host to redirect to", async () => {
		const html = '<a href="/local/path">here</a>';
		const out = await injectTracking(html, { ...base, openTracking: false });
		expect(out).toBe(html);
	});

	it("leaves protocol-relative links untouched", async () => {
		// The click endpoint validates the signed destination with `new URL(url)`
		// and no base, which cannot parse `//host/path` — so wrapping one turned a
		// working link into a 400. Better untracked than broken.
		const html = '<a href="//example.com/path">x</a>';
		const out = await injectTracking(html, { ...base, openTracking: false });
		expect(out).toBe(html);
	});

	it("decodes every valid ampersand entity spelling before signing", async () => {
		// Only decoding lowercase `&amp;` left numeric forms literal inside the
		// signed URL, where they read as path text rather than a query separator —
		// so parameters were silently lost after the redirect.
		for (const entity of ["&amp;", "&AMP;", "&#38;", "&#x26;", "&#X26;"]) {
			const out = await injectTracking(
				`<a href="https://x.com/a?b=1${entity}c=2">q</a>`,
				{ ...base, openTracking: false },
			);
			expect(out).toContain(
				`CLICK_${encodeURIComponent("https://x.com/a?b=1&c=2")}`,
			);
		}
	});

	it("decodes entity ampersands so the signed URL is the true destination", async () => {
		const out = await injectTracking(
			'<a href="https://x.com/a?b=1&amp;c=2">q</a>',
			{ ...base, openTracking: false },
		);
		expect(out).toContain(
			`CLICK_${encodeURIComponent("https://x.com/a?b=1&c=2")}`,
		);
	});

	it("signs a repeated destination only once but rewrites both links", async () => {
		let calls = 0;
		const out = await injectTracking(
			'<a href="https://x.com/p">1</a><a href="https://x.com/p">2</a>',
			{
				...base,
				openTracking: false,
				signClick: async (url) => {
					calls += 1;
					return `CLICK_${encodeURIComponent(url)}`;
				},
			},
		);
		expect(calls).toBe(1);
		expect(out.match(/\/t\/c\//g)).toHaveLength(2);
	});

	it("does not wrap links when click tracking is off", async () => {
		const html = '<a href="https://x.com/p">p</a>';
		const out = await injectTracking(html, {
			...base,
			clickTracking: false,
			openTracking: false,
		});
		expect(out).toBe(html);
	});
});

describe("open pixel", () => {
	it("inserts the pixel just before </body>", async () => {
		const out = await injectTracking("<body><p>Hi</p></body>", {
			...base,
			clickTracking: false,
		});
		expect(out).toBe(
			'<body><p>Hi</p><img data-tt-open="1" src="https://mailer.tapetide.com/t/o/OPEN_TOKEN" alt="" width="1" height="1" style="display:none;max-width:1px;max-height:1px;border:0" /></body>',
		);
	});

	it("appends the pixel at the end when there is no body tag", async () => {
		const out = await injectTracking("<p>Hi</p>", {
			...base,
			clickTracking: false,
		});
		expect(out.endsWith("/t/o/OPEN_TOKEN\" alt=\"\" width=\"1\" height=\"1\" style=\"display:none;max-width:1px;max-height:1px;border:0\" />")).toBe(
			true,
		);
	});

	it("adds exactly one pixel", async () => {
		const out = await injectTracking("<body>a</body>", {
			...base,
			clickTracking: false,
		});
		expect(out.match(/\/t\/o\//g)).toHaveLength(1);
	});

	it("does not add a pixel when open tracking is off", async () => {
		const out = await injectTracking("<body>a</body>", {
			...base,
			openTracking: false,
			clickTracking: false,
		});
		expect(out).toBe("<body>a</body>");
	});

	it("never wraps its own pixel as a link", async () => {
		// Click runs first, then the pixel is added — so the pixel URL is never a
		// candidate for click rewriting.
		const out = await injectTracking("<body><a href='https://x.com'>x</a></body>", base);
		// One click redirect (the real link) and one open pixel, no more.
		expect(out.match(/\/t\/c\//g)).toHaveLength(1);
		expect(out.match(/\/t\/o\//g)).toHaveLength(1);
	});
});
