// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import {
	looksLikeHtml,
	splitQuotedBody,
	splitQuotedHtml,
	splitQuotedText,
} from "../shared/quoted-text";

describe("splitQuotedHtml", () => {
	it("splits at a Gmail attribution line", () => {
		const html =
			"<div>Thanks, sounds good.</div><br><div>On Fri, Aug 14, 2026 at 9:14 AM, alex@workorai.com wrote:</div><blockquote>Original text</blockquote>";

		const { visible, quoted, hasQuote } = splitQuotedHtml(html);

		expect(hasQuote).toBe(true);
		expect(visible).toContain("Thanks, sounds good.");
		expect(visible).not.toContain("Original text");
		expect(quoted).toContain("On Fri, Aug 14, 2026");
		expect(quoted).toContain("Original text");
	});

	it("splits at a gmail_quote container", () => {
		const html =
			'<div dir="ltr">Reply body</div><div class="gmail_quote"><div>On Mon, 1 Jan 2026 at 10:00, a@b.com wrote:</div><blockquote class="gmail_quote">Older</blockquote></div>';

		const { visible, quoted } = splitQuotedHtml(html);

		expect(visible).toContain("Reply body");
		expect(quoted).toContain("Older");
		expect(visible).not.toContain("Older");
	});

	it("splits at an Outlook From/Sent header block", () => {
		const html =
			"<p>Here you go.</p><div id=\"divRplyFwdMsg\">From: Alex &lt;alex@b.com&gt;<br>Sent: Friday, August 14, 2026 9:14 AM<br>To: Me</div><div>Body</div>";

		const { visible, quoted } = splitQuotedHtml(html);

		expect(visible).toContain("Here you go.");
		expect(quoted).toContain("Sent: Friday");
	});

	it("splits at an -----Original Message----- separator", () => {
		const html =
			"<div>Short answer: yes.</div>-----Original Message-----<div>From: a@b.com on 1/1/2026</div>";

		const { visible, quoted } = splitQuotedHtml(html);

		expect(visible).toContain("Short answer: yes.");
		expect(quoted).toContain("Original Message");
	});

	it("splits our own blockquote-based reply block", () => {
		const html =
			'<p>Sending the details now.</p><blockquote style="border-left: 2px solid #ddd;"><p>On Thu, Aug 6, 2026, 1:49 PM, rutuja@cloudthat.com wrote:</p><div>Please share the account ID.</div></blockquote>';

		const { visible, quoted } = splitQuotedHtml(html);

		expect(visible).toContain("Sending the details now.");
		expect(visible).not.toContain("account ID");
		expect(quoted).toContain("account ID");
	});

	it("keeps the body intact when nothing was written above the quote", () => {
		const html =
			"<blockquote>On Fri, Aug 14, 2026 at 9:14 AM, a@b.com wrote:<br>Everything</blockquote>";

		const { visible, quoted, hasQuote } = splitQuotedHtml(html);

		expect(hasQuote).toBe(false);
		expect(quoted).toBe("");
		expect(visible).toBe(html);
	});

	it("leaves a message with no quote untouched", () => {
		const html = "<p>Hi Alex,</p><p>Yes, I'm interested. Hitesh</p>";

		expect(splitQuotedHtml(html)).toEqual({
			visible: html,
			quoted: "",
			hasQuote: false,
		});
	});

	it("does not treat prose containing 'wrote:' as an attribution", () => {
		const html =
			"<p>The style guide we wrote: keep sentences short and direct.</p>";

		expect(splitQuotedHtml(html).hasQuote).toBe(false);
	});

	it("reports a quote even when it holds no text, so nothing is dropped", () => {
		// The toggle only renders when hasQuote is true; if it were false here
		// the trimmed image would disappear from the thread entirely.
		const html =
			'<div>See the chart.</div><div class="gmail_quote"><img src="cid:chart"></div>';

		const { visible, quoted, hasQuote } = splitQuotedHtml(html);

		expect(hasQuote).toBe(true);
		expect(visible).toContain("See the chart.");
		expect(quoted).toContain("cid:chart");
	});

	it("does not split inside a tag when a pattern matches an attribute", () => {
		const html =
			'<div title="On Fri, Aug 14, 2026 at 9:14 AM, a@b.com wrote:">Body text</div>';

		const { visible, quoted, hasQuote } = splitQuotedHtml(html);

		// Either it declines to split, or it splits before the tag — never
		// halfway through one.
		expect(hasQuote).toBe(false);
		expect(visible).toBe(html);
		expect(quoted).toBe("");
	});

	it("ignores an underscore rule that is not followed by mail headers", () => {
		const html = `<div>Notes below.</div><div>${"_".repeat(40)}</div><div>Just a divider.</div>`;

		expect(splitQuotedHtml(html).hasQuote).toBe(false);
	});

	it("splits at an underscore rule that introduces mail headers", () => {
		const html = `<div>Passing this on.</div><div>${"_".repeat(40)}</div><div>From: alex@b.com<br>Sent: 14 Aug 2026 09:14</div>`;

		const { visible, quoted } = splitQuotedHtml(html);

		expect(visible).toContain("Passing this on.");
		expect(quoted).toContain("From: alex@b.com");
	});

	it("keeps a Gmail signature visible instead of hiding it with the quote", () => {
		const html =
			'<div dir="ltr">Thanks!</div><div class="gmail_extra"><div class="gmail_signature">Hitesh Sisara</div><div class="gmail_quote">On Fri, Aug 14, 2026 at 9:14 AM, a@b.com wrote:<blockquote>Older</blockquote></div></div>';

		const { visible, quoted } = splitQuotedHtml(html);

		expect(visible).toContain("Hitesh Sisara");
		expect(quoted).toContain("Older");
		expect(visible).not.toContain("Older");
	});

	it("removes only one quote chain, keeping nested history in the quote", () => {
		const html =
			"<div>Newest</div><div>On Fri, Aug 14, 2026 at 9:14 AM, a@b.com wrote:</div><blockquote>Middle<br>On Thu, Aug 13, 2026 at 8:00 AM, c@d.com wrote:<br>Oldest</blockquote>";

		const { visible, quoted } = splitQuotedHtml(html);

		expect(visible).toContain("Newest");
		expect(quoted).toContain("Middle");
		expect(quoted).toContain("Oldest");
	});
});

describe("splitQuotedText", () => {
	it("splits at a '>' quoted region", () => {
		const text = "Yes, that works.\n\n> Can you confirm?\n> Thanks";

		const { visible, quoted, hasQuote } = splitQuotedText(text);

		expect(hasQuote).toBe(true);
		expect(visible.trim()).toBe("Yes, that works.");
		expect(quoted).toContain("Can you confirm?");
	});

	it("splits at a wrapped attribution line", () => {
		const text =
			"Sounds good.\n\nOn Fri, Aug 14, 2026 at 9:14 AM\nalex@workorai.com wrote:\nOriginal";

		const { visible, quoted } = splitQuotedText(text);

		expect(visible.trim()).toBe("Sounds good.");
		expect(quoted).toContain("Original");
	});

	it("splits at a plain-text mail header block", () => {
		const text =
			"See below.\n\nFrom: alex@b.com\nSent: 14 Aug 2026 09:14\nSubject: Hello";

		const { visible } = splitQuotedText(text);

		expect(visible.trim()).toBe("See below.");
	});

	it("leaves unquoted text untouched", () => {
		const text = "Just a short note.";

		expect(splitQuotedText(text)).toEqual({
			visible: text,
			quoted: "",
			hasQuote: false,
		});
	});
});

describe("splitQuotedBody", () => {
	it("routes HTML and text bodies to the right splitter", () => {
		expect(looksLikeHtml("<p>hi</p>")).toBe(true);
		expect(looksLikeHtml("hi there")).toBe(false);

		expect(splitQuotedBody("Reply\n> quoted").quoted).toBe("> quoted");
		expect(
			splitQuotedBody(
				"<p>Reply</p><div>On Fri, Aug 14, 2026 at 9:14 AM, a@b.com wrote:</div><blockquote>q</blockquote>",
			).hasQuote,
		).toBe(true);
	});

	it("handles empty input", () => {
		expect(splitQuotedBody("")).toEqual({
			visible: "",
			quoted: "",
			hasQuote: false,
		});
		expect(splitQuotedBody(null)).toEqual({
			visible: "",
			quoted: "",
			hasQuote: false,
		});
	});
});

describe("buildQuotedReplyBlock", () => {
	it("quotes only the newest message, so the chain stops growing", async () => {
		const { buildQuotedReplyBlock } = await import(
			"../workers/lib/email-helpers"
		);

		// A reply that already carries the message it answered.
		const previousReply =
			"<div>Please send the details across.</div><br><div>On Fri, Aug 14, 2026 at 9:14 AM, alex@workorai.com wrote:</div><blockquote>Would it be worth sending you the details?</blockquote>";

		const block = buildQuotedReplyBlock({
			date: "2026-08-15T00:56:00.000Z",
			sender: "devops@tapetide.com",
			body: previousReply,
		});

		expect(block).toContain("Please send the details across.");
		expect(block).not.toContain("Would it be worth sending you the details?");
		// One level of quoting only.
		expect(block.match(/<blockquote/g)).toHaveLength(1);
	});

	it("keeps line breaks instead of flattening the body into one run", async () => {
		const { buildQuotedReplyBlock } = await import(
			"../workers/lib/email-helpers"
		);

		const block = buildQuotedReplyBlock({
			date: "2026-08-15T00:56:00.000Z",
			sender: "a@b.com",
			body: "<p>Hi Alex,</p><p>Thanks for reaching out.</p>",
		});

		expect(block).toContain("Hi Alex,<br>");
		expect(block).toContain("Thanks for reaching out.");
	});
});
