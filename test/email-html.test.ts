// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Reading-pane HTML preparation.
 *
 * Two behaviours worth pinning down: `cid:` images have to resolve to the
 * attachment endpoint (otherwise embedded images render broken), and remote
 * images must not load until the reader asks (otherwise a tracking pixel
 * reports the open).
 */

import { describe, expect, it } from "vitest";
import {
	parseUnsubscribe,
	prepareEmailHtml,
	toEmlBlob,
} from "~/lib/email-html";
import type { Attachment } from "~/types";

const inlineImage: Attachment = {
	id: "att-1",
	filename: "logo.png",
	mimetype: "image/png",
	size: 1024,
	content_id: "<logo@example.com>",
	disposition: "inline",
};

const options = {
	mailboxId: "hello@example.com",
	emailId: "email-1",
	attachments: [inlineImage],
	allowRemoteImages: false,
};

describe("prepareEmailHtml", () => {
	it("resolves cid: references to the attachment endpoint", () => {
		const { html } = prepareEmailHtml(
			'<p><img src="cid:logo@example.com" alt="Logo"></p>',
			options,
		);

		expect(html).toContain(
			"/api/v1/mailboxes/hello%40example.com/emails/email-1/attachments/att-1",
		);
		expect(html).not.toContain("cid:");
	});

	it("matches a Content-ID wrapped in angle brackets, case-insensitively", () => {
		const { html } = prepareEmailHtml('<img SRC="cid:LOGO@example.com">', {
			...options,
		});
		expect(html).toContain("attachments/att-1");
	});

	it("leaves an unknown cid alone rather than pointing at nothing", () => {
		const { html } = prepareEmailHtml('<img src="cid:missing@example.com">', {
			...options,
		});
		expect(html).toContain("cid:missing@example.com");
	});

	it("withholds remote images and reports how many", () => {
		const { html, blockedRemoteCount } = prepareEmailHtml(
			'<img src="https://cdn.example/b.gif"><img src="http://cdn.example/a.png">',
			options,
		);

		expect(blockedRemoteCount).toBe(2);
		// The URL survives in data-blocked-src so "Show images" is a re-render,
		// but nothing loadable may point at it.
		expect(html).toContain('data-blocked-src="https://cdn.example/b.gif"');
		expect(html).not.toMatch(/\ssrc="https?:\/\//);
		expect(html).toContain("data:image/gif;base64,");
	});

	it("strips srcset while blocking, so it cannot reintroduce the fetch", () => {
		const { html } = prepareEmailHtml(
			'<img src="https://cdn.example/a.png" srcset="https://cdn.example/a2.png 2x">',
			options,
		);
		expect(html).not.toContain("srcset");
	});

	it("routes remote images through the signed proxy once the reader opts in", () => {
		const { html, blockedRemoteCount } = prepareEmailHtml(
			'<img src="https://cdn.example/a.png">',
			{
				...options,
				allowRemoteImages: true,
				imageProxy: { "https://cdn.example/a.png": "/img/SIG?u=https%3A%2F%2Fcdn.example%2Fa.png" },
			},
		);

		expect(blockedRemoteCount).toBe(0);
		expect(html).toContain('src="/img/SIG?u=https%3A%2F%2Fcdn.example%2Fa.png"');
		// Never loaded directly from the sender.
		expect(html).not.toMatch(/\ssrc="https?:\/\//);
	});

	it("withholds an allowed image the server did not sign, rather than loading it directly", () => {
		const { html } = prepareEmailHtml('<img src="https://cdn.example/a.png">', {
			...options,
			allowRemoteImages: true,
		});
		expect(html).not.toMatch(/\ssrc="https?:\/\//);
		expect(html).toContain('data-blocked-src="https://cdn.example/a.png"');
	});

	it("keeps tracking pixels blocked after images are allowed, and counts them", () => {
		const proxy = {
			"https://cdn.example/hero.png": "/img/A?u=hero",
			"https://cdn.example/p.gif": "/img/B?u=p",
			"https://abc.list-manage.com/track/open.php?u=1": "/img/C?u=t",
		};
		const { html, trackerCount, remoteImageCount } = prepareEmailHtml(
			'<img src="https://cdn.example/hero.png" width="600">' +
				'<img width="1" height="1" src="https://cdn.example/p.gif">' +
				'<img src="https://abc.list-manage.com/track/open.php?u=1">',
			{ ...options, allowRemoteImages: true, imageProxy: proxy },
		);
		expect(trackerCount).toBe(2);
		expect(remoteImageCount).toBe(1);
		expect(html).toContain('src="/img/A?u=hero"');
		expect(html).not.toContain("/img/B");
		expect(html).not.toContain("/img/C");
		expect(html.match(/data-tracker/g)?.length).toBe(2);
	});

	it("removes remote url() from inline styles, which the proxy does not cover", () => {
		const { html } = prepareEmailHtml(
			'<td style="background-image: url(\x27https://t.example/bg.png\x27); color: red">x</td>',
			{ ...options, allowRemoteImages: true },
		);
		expect(html).not.toContain("t.example");
		expect(html).toContain("color: red");
	});

	it("strips tracking parameters from links unless turned off", () => {
		const source = '<a href="https://shop.example/p?id=7&amp;utm_source=news&amp;fbclid=abc">Shop</a>';
		const on = prepareEmailHtml(source, options);
		expect(on.cleanedLinkCount).toBe(1);
		expect(on.html).toContain('href="https://shop.example/p?id=7"');
		const off = prepareEmailHtml(source, { ...options, cleanLinks: false });
		expect(off.cleanedLinkCount).toBe(0);
		expect(off.html).toContain("utm_source=news");
	});

	it("leaves data: images untouched in either mode", () => {
		const source = '<img src="data:image/png;base64,AAA">';
		expect(prepareEmailHtml(source, options).blockedRemoteCount).toBe(0);
		expect(prepareEmailHtml(source, options).html).toContain(source);
	});

	it("returns empty output for a message with no body", () => {
		expect(prepareEmailHtml(null, options)).toEqual({
			html: "",
			blockedRemoteCount: 0,
			remoteImageCount: 0,
			trackerCount: 0,
			cleanedLinkCount: 0,
		});
	});

	/**
	 * Counted in both modes so the reading pane can tell a trusted sender whose
	 * message has images from one that has none — which is what decides whether
	 * to offer an undo for the saved trust rule.
	 */
	it("counts remote images even when they are allowed through", () => {
		const source = '<img src="https://cdn.example/a.png"><img src="cid:logo@example.com">';

		expect(prepareEmailHtml(source, options).remoteImageCount).toBe(1);
		expect(
			prepareEmailHtml(source, { ...options, allowRemoteImages: true }),
		).toMatchObject({ blockedRemoteCount: 0, remoteImageCount: 1 });
	});
});

describe("parseUnsubscribe", () => {
	it("prefers the https target over mailto", () => {
		const parsed = parseUnsubscribe(
			"List-Unsubscribe: <mailto:stop@example.com>, <https://example.com/unsub?id=1>",
		);
		expect(parsed?.url).toBe("https://example.com/unsub?id=1");
		expect(parsed?.mailto).toBe("mailto:stop@example.com");
	});

	it("detects one-click support", () => {
		const parsed = parseUnsubscribe(
			[
				"List-Unsubscribe: <https://example.com/unsub>",
				"List-Unsubscribe-Post: List-Unsubscribe=One-Click",
			].join("\r\n"),
		);
		expect(parsed?.oneClick).toBe(true);
	});

	it("returns null when the header is absent or has no usable target", () => {
		expect(parseUnsubscribe(undefined)).toBeNull();
		expect(parseUnsubscribe("Subject: hello")).toBeNull();
		expect(parseUnsubscribe("List-Unsubscribe: nonsense")).toBeNull();
	});
});

describe("toEmlBlob", () => {
	it("uses stored headers when present", async () => {
		const blob = toEmlBlob({
			raw_headers: "From: a@example.com\r\nSubject: Stored",
			body: "<p>Hi</p>",
		});
		const text = await blob.text();

		expect(blob.type).toBe("message/rfc822");
		expect(text).toContain("Subject: Stored");
		expect(text).toContain("<p>Hi</p>");
	});

	it("synthesises a header block when none were stored", async () => {
		const text = await toEmlBlob({
			sender: "a@example.com",
			recipient: "b@example.com",
			subject: "Generated",
			date: "2026-01-02T03:04:05.000Z",
			body: "body",
		}).text();

		expect(text).toContain("From: a@example.com");
		expect(text).toContain("To: b@example.com");
		expect(text).toContain("Subject: Generated");
		expect(text).toContain("MIME-Version: 1.0");
	});
});

describe("buildEmailDocument plain-text bodies", () => {
	it("keeps the line breaks of a body with no markup", async () => {
		const { buildEmailDocument } = await import("../app/lib/email-document");
		const doc = buildEmailDocument({ cleanBody: "Hi team,\n\nNotes below.\n\nPriya" });
		expect(doc).toMatch(/#tt-mail-body \{[^}]*white-space: pre-wrap;/);
	});

	it("leaves HTML bodies to their own markup", async () => {
		const { buildEmailDocument } = await import("../app/lib/email-document");
		const doc = buildEmailDocument({ cleanBody: "<p>Hi team,</p><p>Priya</p>" });
		expect(doc).not.toContain("white-space: pre-wrap");
	});
});

describe("buildEmailDocument blocked images", () => {
	it("collapses a blocked image that has no declared height", async () => {
		const { buildEmailDocument } = await import("../app/lib/email-document");
		const doc = buildEmailDocument({ cleanBody: "<p>x</p>" });
		expect(doc).toContain("img[data-blocked-src]:not([height]) { height: 0 !important; }");
	});
});
