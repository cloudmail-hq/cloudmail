/**
 * Cover for the reading pane's typography rules.
 *
 * The point of these tests is the *gating*: a measure cap and a recolour are both
 * improvements on a plain reply and both damaging on a fixed-width newsletter, so
 * what matters is that each rule can tell the two apart.
 */

import { describe, expect, it } from "vitest";

import {
	BODY_FONT_SIZE_PX,
	BODY_LINE_HEIGHT,
	bringsOwnLayout,
	declaresOwnColors,
	paintsOwnSurface,
	readingMeasureCh,
} from "../app/lib/reading-typography";

describe("declaresOwnColors", () => {
	it("detects a colour declared first in the attribute", () => {
		// The regression this function was written for: anchoring `(?:^|;)` against
		// the whole document misses the first declaration in an attribute.
		expect(declaresOwnColors('<p style="color:#333">hi</p>')).toBe(true);
	});

	it("detects a colour declared after another property", () => {
		expect(declaresOwnColors('<p style="margin:0;color:#333">hi</p>')).toBe(true);
	});

	it("detects background and background-color", () => {
		expect(declaresOwnColors('<div style="background:#fff"></div>')).toBe(true);
		expect(declaresOwnColors('<div style="background-color:#fff"></div>')).toBe(
			true,
		);
	});

	it("detects the legacy presentational attributes", () => {
		expect(declaresOwnColors('<td bgcolor="#ffffff">x</td>')).toBe(true);
		expect(declaresOwnColors('<font color="red">x</font>')).toBe(true);
	});

	it("leaves an ordinary reply alone so it can render dark", () => {
		expect(declaresOwnColors("<p>Hi Hitesh,</p><p>Thanks!</p>")).toBe(false);
	});

	it("does not fire on an unrelated property that merely contains the word", () => {
		// `border-color` is not a text or background colour; treating it as one
		// would keep a plain message on a light canvas for no reason.
		expect(declaresOwnColors('<p style="border-color:#eee">hi</p>')).toBe(false);
	});
});

describe("bringsOwnLayout", () => {
	it("treats a multi-column table row as sender layout", () => {
		expect(
			bringsOwnLayout("<table><tr><td>left</td><td>right</td></tr></table>"),
		).toBe(true);
	});

	it("treats an explicitly sized table as sender layout", () => {
		expect(bringsOwnLayout('<table width="600"><tr><td>x</td></tr></table>')).toBe(
			true,
		);
		expect(
			bringsOwnLayout('<table style="width:600px"><tr><td>x</td></tr></table>'),
		).toBe(true);
	});

	it("treats a max-width wrapper as sender layout", () => {
		expect(bringsOwnLayout('<div style="max-width:600px">hi</div>')).toBe(true);
	});

	it("does NOT treat a single-cell wrapper table as layout", () => {
		// A one-cell table is a container, not a column layout, and capping the
		// measure inside it is still the right call.
		expect(bringsOwnLayout("<table><tr><td>just text</td></tr></table>")).toBe(
			false,
		);
	});

	it("does not fire on a plain reply", () => {
		expect(bringsOwnLayout("<p>Hi Hitesh,</p><p>Thanks!</p>")).toBe(false);
	});
});

describe("readingMeasureCh", () => {
	it("caps a plain reply to a readable measure", () => {
		expect(readingMeasureCh("<p>Hi Hitesh, thanks for writing.</p>")).toBe(70);
	});

	it("caps plain text with no markup at all", () => {
		expect(readingMeasureCh("just a line of text")).toBe(70);
	});

	it("leaves a laid-out newsletter at its authored width", () => {
		expect(
			readingMeasureCh(
				'<table width="600"><tr><td>a</td><td>b</td></tr></table>',
			),
		).toBeNull();
	});

	it("returns null for an empty body rather than styling nothing", () => {
		expect(readingMeasureCh("")).toBeNull();
		expect(readingMeasureCh("   ")).toBeNull();
	});

	it("stays within the range long-form reading research supports", () => {
		const measure = readingMeasureCh("<p>text</p>");
		expect(measure).not.toBeNull();
		expect(measure!).toBeGreaterThanOrEqual(60);
		expect(measure!).toBeLessThanOrEqual(80);
	});
});

describe("body type scale", () => {
	it("is at least the 15px mail clients settle on", () => {
		// 14px was the old value and read small at arm's length.
		expect(BODY_FONT_SIZE_PX).toBeGreaterThanOrEqual(15);
	});

	it("gives long paragraphs enough leading to track", () => {
		expect(BODY_LINE_HEIGHT).toBeGreaterThanOrEqual(1.65);
		expect(BODY_LINE_HEIGHT).toBeLessThanOrEqual(1.8);
	});
});

/**
 * The gating that decides whether the reading pane's own gutter is dropped.
 *
 * Both directions are damaging, which is why they are covered here. Keeping the
 * gutter on a newsletter wastes a sixth of a narrow pane and forces the message
 * to be scaled down further to fit; dropping it on a plain message puts the text
 * flat against the frame edge.
 *
 * The false positive worth guarding hardest is a message with a coloured patch
 * *inside* it rather than a surface of its own — our own forwards are exactly
 * that shape, and an earlier version of this predicate matched a background
 * anywhere in the document and got them wrong.
 */
describe("paintsOwnSurface", () => {
	it("keeps the gutter on a forward, whose shaded block is nested", () => {
		// The shape `buildForwardBody` emits: leading paragraph and signature, then
		// the original inset in a shaded block.
		const forward =
			'<p><br></p><div class="sig">Regards,<br>Hitesh</div><br>' +
			'<div style="border: 1px solid #ddd; padding: 1em; background-color: #f9f9f9; margin: 1em 0;">' +
			"<strong>Forwarded message:</strong><br>original text</div>";
		expect(paintsOwnSurface(forward)).toBe(false);
	});

	it("keeps the gutter on a reply holding one highlighted callout", () => {
		const reply =
			"<p>Hi,</p><p>See the note below.</p>" +
			'<p style="background:#fee;padding:6px">Careful with this.</p>';
		expect(paintsOwnSurface(reply)).toBe(false);
	});

	it("keeps the gutter on a plain reply", () => {
		expect(paintsOwnSurface("<p>Hi,</p><p>Plain text.</p>")).toBe(false);
	});

	it("keeps the gutter where only a text colour is set", () => {
		// The distinction from `declaresOwnColors`: a type colour is not a surface.
		expect(paintsOwnSurface('<p style="color:#333">Hi,</p>')).toBe(false);
	});

	it("treats an outer background as the message's own surface", () => {
		const newsletter =
			'<div style="background:#bfff00;padding:24px"><h1>NEBIUS</h1></div>' +
			"<div><p>Body</p></div>";
		expect(paintsOwnSurface(newsletter)).toBe(true);
	});

	it("looks past a tracking pixel and a hidden preheader to find it", () => {
		// Both are conventionally the first thing in a newsletter, and neither is
		// the surface it is painted on.
		const newsletter =
			'<img src="data:," width="1" height="1">' +
			'<div style="display:none">Preheader text</div>' +
			'<div bgcolor="#f4f4f4"><p>Body</p></div>';
		expect(paintsOwnSurface(newsletter)).toBe(true);
	});

	it("does not count a background that paints nothing", () => {
		expect(paintsOwnSurface('<div style="background:none"><p>Hi</p></div>')).toBe(
			false,
		);
		expect(
			paintsOwnSurface('<div style="background-color:transparent">x</div>'),
		).toBe(false);
	});

	it("still covers the fixed-width table newsletter", () => {
		expect(
			paintsOwnSurface('<table width="600"><tr><td>a</td><td>b</td></tr></table>'),
		).toBe(true);
	});

	it("keeps the gutter on an empty or text-only message", () => {
		expect(paintsOwnSurface("")).toBe(false);
		expect(paintsOwnSurface("just text")).toBe(false);
	});
});
