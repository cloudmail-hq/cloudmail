// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The RFC 8058 header builder and the footer.
 *
 * Email Service rejects the whole message for one bad header, so the builder
 * must only ever emit allowlisted names with in-limit values, and must emit
 * nothing at all rather than something invalid.
 */

import { describe, expect, it } from "vitest";
import {
	MAX_HEADER_VALUE_BYTES,
	applyUnsubscribeToHtml,
	applyUnsubscribeToText,
	buildListUnsubscribeHeaders,
} from "../shared/list-unsubscribe";
import { assertSendableHeaders, isSendableHeader } from "../shared/email-headers";

const URL_ = "https://mailer.example.com/u/abc.def";

describe("buildListUnsubscribeHeaders", () => {
	it("emits the RFC 8058 pair with https first and mailto second", () => {
		const headers = buildListUnsubscribeHeaders({ url: URL_, mailto: "Hello@Product.dev" });
		expect(headers).toEqual({
			"List-Unsubscribe": `<${URL_}>, <mailto:hello@product.dev?subject=unsubscribe>`,
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		});
	});

	it("only uses headers Email Service allows", () => {
		const headers = buildListUnsubscribeHeaders({ url: URL_, mailto: "a@b.co" });
		for (const name of Object.keys(headers)) expect(isSendableHeader(name)).toBe(true);
		expect(() => assertSendableHeaders(headers)).not.toThrow();
	});

	it("omits a malformed mailto but keeps the https link", () => {
		const headers = buildListUnsubscribeHeaders({ url: URL_, mailto: "not an address" });
		expect(headers["List-Unsubscribe"]).toBe(`<${URL_}>`);
	});

	it("refuses a non-https URL (RFC 8058 requires https)", () => {
		expect(buildListUnsubscribeHeaders({ url: "http://mailer.example.com/u/x" })).toEqual({});
		expect(buildListUnsubscribeHeaders({ url: "not a url" })).toEqual({});
	});

	it("refuses a URL that would break the angle-bracket syntax", () => {
		expect(buildListUnsubscribeHeaders({ url: "https://x.example/u/a>b" })).toEqual({});
		expect(buildListUnsubscribeHeaders({ url: "https://x.example/u/a,b" })).toEqual({});
	});

	it("never exceeds the 2,048-byte value limit", () => {
		const longToken = "a".repeat(MAX_HEADER_VALUE_BYTES - 40);
		const fits = buildListUnsubscribeHeaders({
			url: `https://x.example/u/${longToken}`,
			mailto: "someone@example.com",
		});
		// Mailto dropped to stay under the limit, the https link kept.
		expect(fits["List-Unsubscribe"]).toBe(`<https://x.example/u/${longToken}>`);

		const tooLong = buildListUnsubscribeHeaders({
			url: `https://x.example/u/${"a".repeat(MAX_HEADER_VALUE_BYTES)}`,
		});
		expect(tooLong).toEqual({});
	});
});

describe("footer", () => {
	it("substitutes {{unsubscribe_url}} in place and adds no footer", () => {
		const html = `<p>Hi</p><a href="{{unsubscribe_url}}">Leave</a>`;
		const out = applyUnsubscribeToHtml(html, URL_, { footer: true });
		expect(out).toBe(`<p>Hi</p><a href="${URL_}">Leave</a>`);
	});

	it("appends a footer inside </body> when the template has no placeholder", () => {
		const out = applyUnsubscribeToHtml("<html><body><p>Hi</p></body></html>", URL_, { footer: true });
		expect(out).toMatch(/Unsubscribe<\/a>\.<\/p><\/body><\/html>$/);
		expect(out).toContain(`href="${URL_}"`);
	});

	it("leaves the body alone when the footer is off", () => {
		expect(applyUnsubscribeToHtml("<p>Hi</p>", URL_, { footer: false })).toBe("<p>Hi</p>");
	});

	it("escapes the URL in the href", () => {
		const out = applyUnsubscribeToHtml("<p>x</p>", 'https://x.example/u/"><script>', { footer: true });
		expect(out).not.toContain("<script>");
	});

	it("adds a plain-text footer", () => {
		expect(applyUnsubscribeToText("Hello\n\n", URL_, { footer: true })).toBe(
			`Hello\n\n--\nUnsubscribe: ${URL_}\n`,
		);
	});
});
