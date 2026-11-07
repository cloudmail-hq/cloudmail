import { describe, expect, it, vi } from "vitest";
import {
	OUTGOING_BODY_MARKER,
	dropAbsoluteTextColors,
	prepareOutgoingHtml,
} from "../shared/outgoing-html";
import { sendEmail } from "../workers/email-sender";
import { clearanceForTest } from "../workers/lib/pre-send";

describe("prepareOutgoingHtml", () => {
	it("wraps a fragment once, with color-scheme meta and a font wrapper without colour", () => {
		const out = prepareOutgoingHtml("<p>Hi</p>")!;
		expect(out).toContain('<meta name="color-scheme" content="light dark">');
		expect(out).toContain('<meta name="supported-color-schemes" content="light dark">');
		expect(out).toMatch(new RegExp(`<div ${OUTGOING_BODY_MARKER}="1" style="font-family:[^"]+"><p>Hi</p></div>`));
		const wrapper = /<div [^>]*>/.exec(out)![0];
		expect(wrapper).not.toMatch(/color|background/);
		expect(out.match(/font-family/g)).toHaveLength(1);
	});

	it("is idempotent", () => {
		const once = prepareOutgoingHtml("<p>Hi</p>");
		expect(prepareOutgoingHtml(once)).toBe(once);
	});

	it("only adds the meta to a full document", () => {
		const doc = '<!DOCTYPE html><html><head><title>x</title></head><body style="background:#f6f6f6"><p>Reset</p></body></html>';
		const out = prepareOutgoingHtml(doc)!;
		expect(out).toContain('<head><meta name="color-scheme" content="light dark">');
		expect(out).toContain('<body style="background:#f6f6f6"><p>Reset</p></body>');
		expect(out).not.toContain(OUTGOING_BODY_MARKER);
	});

	it("leaves empty and missing bodies alone", () => {
		expect(prepareOutgoingHtml(undefined)).toBeUndefined();
		expect(prepareOutgoingHtml("")).toBe("");
	});

	it("drops absolute black and white text, keeps chosen colours and paired backgrounds", () => {
		expect(dropAbsoluteTextColors('<span style="color: #000000">a</span>')).toBe("<span>a</span>");
		expect(dropAbsoluteTextColors('<span style="color:rgb(255, 255, 255); font-weight:bold">a</span>')).toBe('<span style="font-weight:bold">a</span>');
		expect(dropAbsoluteTextColors('<p style="color: black">a</p>')).toBe("<p>a</p>");
		expect(dropAbsoluteTextColors('<span style="color: #d93025">a</span>')).toBe('<span style="color: #d93025">a</span>');
		expect(dropAbsoluteTextColors('<mark style="background-color: #fff59d; color: #000">a</mark>')).toBe(
			'<mark style="background-color: #fff59d; color: #000">a</mark>',
		);
		// A highlight alone does not stop the cleanup of the rest.
		expect(dropAbsoluteTextColors('<mark style="background-color: #fff59d">a</mark><p style="color:#000">b</p>')).toBe(
			'<mark style="background-color: #fff59d">a</mark><p>b</p>',
		);
	});

	it("keeps white text on a dark container's background (review finding)", () => {
		const html = '<div style="background-color: #000000; padding: 20px;"><p style="color: #ffffff;">Important notice</p></div>';
		expect(dropAbsoluteTextColors(html)).toBe(html);
		const legacy = '<table bgcolor="#000"><tr><td><font style="color:#fff">x</font></td></tr></table>';
		expect(dropAbsoluteTextColors(legacy)).toBe(legacy);
	});

	it("does not rewrite a code sample that shows a style attribute as text", () => {
		const html = "<pre><code>&lt;span style=\"color: black\"&gt;hi&lt;/span&gt;</code></pre>";
		expect(dropAbsoluteTextColors(html)).toBe(html);
	});
});

describe("sendEmail applies it to every send", () => {
	it("sends the prepared HTML", async () => {
		const send = vi.fn().mockResolvedValue({ messageId: "m1" });
		await sendEmail(
			{ send } as unknown as SendEmail,
			{ to: "a@example.com", from: "b@example.com", subject: "s", html: '<p style="color:#fff">Hi</p>', text: "Hi" },
			clearanceForTest(),
		);
		const html = send.mock.calls[0]![0].html as string;
		expect(html).toContain("color-scheme");
		expect(html).toContain("<p>Hi</p>");
	});
});
