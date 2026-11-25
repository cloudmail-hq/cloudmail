/** Helpers behind editing a held send on the Pending approval screen. */

import { describe, expect, it } from "vitest";
import {
	draftFromMessage,
	draftProblem,
	editsFromDraft,
	needsHtmlMode,
	parseAddressList,
	tabForStatus,
	textToHtml,
} from "~/lib/approval-edit";
import type { HeldMessage } from "~/services/api";

function held(over: Partial<HeldMessage> = {}): HeldMessage {
	return {
		to: ["a@example.com"],
		cc: [],
		bcc: [],
		from: "support@example.com",
		subject: "Hello",
		html: "<p>Hi</p>",
		text: null,
		attachments: [],
		send_at: null,
		bulk: false,
		...over,
	};
}

describe("textToHtml", () => {
	it("turns blank-line paragraphs and single newlines into HTML", () => {
		expect(textToHtml("Hi Rajeev,\n\nThanks.\nRegards")).toBe("<p>Hi Rajeev,</p><p>Thanks.<br>Regards</p>");
	});
	it("escapes markup and handles CRLF and empty input", () => {
		expect(textToHtml("a < b & c\r\n\r\nd")).toBe("<p>a &lt; b &amp; c</p><p>d</p>");
		expect(textToHtml(null)).toBe("");
		expect(textToHtml("   ")).toBe("");
	});
});

describe("draftFromMessage", () => {
	it("keeps HTML bodies and joins recipients", () => {
		expect(draftFromMessage(held({ to: ["a@x.com", "b@x.com"], cc: ["c@x.com"] }))).toEqual({
			to: "a@x.com, b@x.com",
			cc: "c@x.com",
			subject: "Hello",
			html: "<p>Hi</p>",
		});
	});
	it("opens a plain-text message with its text, not an empty body", () => {
		expect(draftFromMessage(held({ html: null, text: "Line one\n\nLine two" })).html).toBe("<p>Line one</p><p>Line two</p>");
	});
});

describe("editsFromDraft", () => {
	const m = held({ to: ["a@x.com", "b@x.com"] });
	const base = draftFromMessage(m);

	it("is null when nothing changed, including the editor's own normalisation", () => {
		expect(editsFromDraft(m, base, [base.html])).toBeNull();
		// The editor re-serialised the stored body; that rendering is a baseline too.
		expect(editsFromDraft(m, { ...base, html: "<p>Hi</p>\n" }, [base.html, "<p>Hi</p>\n"])).toBeNull();
	});
	it("ignores whitespace and separator changes in recipient lists", () => {
		expect(editsFromDraft(m, { ...base, to: "a@x.com;  b@x.com" }, [base.html])).toBeNull();
	});
	it("returns only the fields that changed", () => {
		expect(editsFromDraft(m, { ...base, subject: "Re: Hello", html: "<p>Hi there</p>" }, [base.html])).toEqual({
			subject: "Re: Hello",
			html: "<p>Hi there</p>",
		});
		expect(editsFromDraft(m, { ...base, to: "a@x.com", cc: "z@x.com" }, [base.html])).toEqual({ to: ["a@x.com"], cc: ["z@x.com"] });
	});
});

describe("draftProblem", () => {
	const ok = { to: "a@x.com", cc: "", subject: "Hi", html: "<p>Body</p>" };
	it("accepts a complete draft", () => {
		expect(draftProblem(ok)).toBeNull();
	});
	it("names what is missing or wrong", () => {
		expect(draftProblem({ ...ok, to: "" })).toMatch(/at least one recipient/);
		expect(draftProblem({ ...ok, cc: "not-an-address" })).toBe("Not an email address: not-an-address");
		expect(draftProblem({ ...ok, subject: "  " })).toMatch(/subject/);
		expect(draftProblem({ ...ok, html: "<p></p><p>&nbsp;</p>" })).toMatch(/empty/);
	});
	it("accepts a body that is only an image", () => {
		expect(draftProblem({ ...ok, html: '<p><img src="https://x.com/a.png"></p>' })).toBeNull();
	});
});

describe("needsHtmlMode", () => {
	it("keeps simple bodies in the visual editor", () => {
		expect(needsHtmlMode('<p>Hi <strong>there</strong></p><ul><li><a href="https://x.com">x</a></li></ul>')).toBe(false);
	});
	it("opens styled or layout HTML in HTML mode", () => {
		expect(needsHtmlMode('<p style="color:red">x</p>')).toBe(true);
		expect(needsHtmlMode("<div><p>x</p></div>")).toBe(true);
		expect(needsHtmlMode('<img src="https://x.com/a.png">')).toBe(true);
		expect(needsHtmlMode("<style>p{}</style><p>x</p>")).toBe(true);
	});
});

describe("parseAddressList and tabForStatus", () => {
	it("splits on commas, semicolons and spaces", () => {
		expect(parseAddressList(" a@x.com,b@x.com; c@x.com  d@x.com ")).toEqual(["a@x.com", "b@x.com", "c@x.com", "d@x.com"]);
	});
	it("maps a status to the tab that lists it", () => {
		expect(tabForStatus("failed")).toBe("failed");
		expect(tabForStatus("sending")).toBe("all");
	});
});
