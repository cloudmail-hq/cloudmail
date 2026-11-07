/**
 * Tracker blocking, link cleaning, and the iframe's image policy.
 */

import { describe, expect, it } from "vitest";
import {
	cleanLinksInHtml,
	cleanTrackingParams,
	isPixelShaped,
	isTrackerUrl,
	isTrackingImage,
	isTrackingParam,
} from "../shared/email-privacy";
import { buildEmailDocument } from "../app/lib/email-document";

describe("tracker detection", () => {
	it("knows the big open-tracking hosts, including subdomains", () => {
		for (const url of [
			"https://us5.list-manage.com/track/open.php?u=1&id=2",
			"https://mandrillapp.com/track/open.php?u=1",
			"https://t.hubspotemail.net/e2t/to/abc",
			"https://u123.ct.sendgrid.net/wf/open?upn=abc",
			"https://mailtrack.io/trace/mail/abc.png",
			"https://track.customer.io/e/o/abc",
		]) {
			expect(isTrackerUrl(url), url).toBe(true);
		}
	});

	it("knows tracker paths on a sender's own subdomain", () => {
		expect(isTrackerUrl("https://email.shop.example/o/eyJhbGciOiJIUzI1NiJ9abc")).toBe(true);
		expect(isTrackerUrl("https://news.shop.example/wf/open?upn=x")).toBe(true);
		expect(isTrackerUrl("https://shop.example/track/open?id=1")).toBe(true);
	});

	it("does not mistake content images for trackers", () => {
		expect(isTrackerUrl("https://mcusercontent.com/abc/images/hero.jpg")).toBe(false);
		expect(isTrackerUrl("https://cdn.shop.example/products/open-box.png")).toBe(false);
		expect(isTrackerUrl("https://cdn.example/logo.png")).toBe(false);
		expect(isTrackerUrl("data:image/png;base64,AAA")).toBe(false);
	});

	it("recognises pixel-shaped images", () => {
		expect(isPixelShaped('<img src="x" width="1" height="1">')).toBe(true);
		expect(isPixelShaped("<img src=x width=0 height=0>")).toBe(true);
		expect(isPixelShaped('<img src="x" height="1">')).toBe(true);
		expect(isPixelShaped('<img src="x" style="display:none">')).toBe(true);
		expect(isPixelShaped('<img src="x" style="width: 1px; height: 1px;">')).toBe(true);
		expect(isPixelShaped('<img src="x" style="opacity: 0">')).toBe(true);
	});

	it("leaves real images alone", () => {
		expect(isPixelShaped('<img src="x" width="600" height="200">')).toBe(false);
		expect(isPixelShaped('<img src="x" width="1" height="40">')).toBe(false); // a rule line
		expect(isPixelShaped('<img src="x">')).toBe(false);
		expect(isPixelShaped('<img src="x" style="opacity: 0.5">')).toBe(false);
		expect(isTrackingImage('<img src="https://cdn.example/a.png" width="300">', "https://cdn.example/a.png")).toBe(false);
	});
});

describe("link cleaning", () => {
	it("strips utm_*, click ids and ESP subscriber ids", () => {
		expect(
			cleanTrackingParams(
				"https://shop.example/p?id=7&utm_source=news&utm_medium=email&utm_campaign=x&fbclid=a&gclid=b&mc_eid=c&mc_cid=d&_hsenc=e",
			),
		).toBe("https://shop.example/p?id=7");
	});

	it("drops the ? when nothing is left, and keeps the fragment", () => {
		expect(cleanTrackingParams("https://shop.example/p?utm_source=x#reviews")).toBe("https://shop.example/p#reviews");
		expect(cleanTrackingParams("https://shop.example/p?utm_source=x")).toBe("https://shop.example/p");
	});

	it("leaves URLs with nothing to strip byte for byte", () => {
		for (const url of ["https://a.example/x?b=2&a=1", "https://a.example/x?sig=abc%2Fdef", "mailto:a@b.com?subject=utm_source", "/relative?utm_source=x"]) {
			expect(cleanTrackingParams(url)).toBe(url);
		}
	});

	it("is case-insensitive on names and does not strip look-alike names", () => {
		expect(isTrackingParam("UTM_Source")).toBe(true);
		expect(isTrackingParam("FBCLID")).toBe(true);
		expect(isTrackingParam("utmost")).toBe(false);
		expect(isTrackingParam("id")).toBe(false);
	});

	it("rewrites hrefs in HTML, decoding and re-encoding entities", () => {
		const { html, cleaned } = cleanLinksInHtml(
			'<a href="https://a.example/?x=1&amp;utm_source=n">a</a> <a href=\'https://b.example/\'>b</a>',
		);
		expect(cleaned).toBe(1);
		expect(html).toContain('href="https://a.example/?x=1"');
		expect(html).toContain("href='https://b.example/'");
	});

	it("does not touch image sources or text", () => {
		const src = '<img src="https://a.example/i.png?utm_source=x"> utm_source=y';
		expect(cleanLinksInHtml(src).html).toBe(src);
	});
});

describe("email iframe CSP", () => {
	const imgSrcOf = (doc: string) => /img-src ([^;]*);/.exec(doc)?.[1] ?? "";

	it("never allows a remote host, with images blocked or allowed", () => {
		for (const allowRemoteImages of [false, true]) {
			const imgSrc = imgSrcOf(buildEmailDocument({ cleanBody: "<p>x</p>", allowRemoteImages, theme: "light" }));
			expect(imgSrc).toContain("data:");
			expect(imgSrc).toContain("blob:");
			expect(imgSrc).toContain("'self'");
			expect(imgSrc).not.toContain("https:");
			expect(imgSrc).not.toContain("http:");
			expect(imgSrc).not.toContain("*");
		}
	});

	it("keeps the rest of the iframe policy locked down", () => {
		const doc = buildEmailDocument({ cleanBody: "<p>x</p>", theme: "dark" });
		expect(doc).toContain("default-src 'none'");
		expect(doc).toContain('<meta name="referrer" content="no-referrer">');
	});
});
