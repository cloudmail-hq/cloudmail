// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Signature removal for the `display.hideSignaturesInChat` preference.
 *
 * The behaviour that matters is what it refuses to do: a signature wraps nested
 * markup, so a naive cut to the next `</div>` would leave half a signature behind
 * and take a chunk of the message with it.
 */

import { describe, expect, it } from "vitest";
import { stripSignatureBlocks } from "../shared/signature-block";
import { renderSignatureBlock } from "~/lib/utils";

describe("stripSignatureBlocks", () => {
	it("removes the block this app actually writes", () => {
		const body = `<p>Hello</p>${renderSignatureBlock("<p>— Ada</p>")}`;
		expect(stripSignatureBlocks(body)).toBe("<p>Hello</p>");
	});

	it("keeps a body with no signature byte-identical", () => {
		const body = "<p>Hello</p><div>Not a signature</div>";
		expect(stripSignatureBlocks(body)).toBe(body);
	});

	it("keeps the message that follows a signature", () => {
		const body = `<p>Hi</p>${renderSignatureBlock("<p>— Ada</p>")}<p>PS</p>`;
		expect(stripSignatureBlocks(body)).toBe("<p>Hi</p><p>PS</p>");
	});

	it("removes a signature containing nested elements whole", () => {
		// The failure this guards against: stopping at the first `</div>` leaves
		// the outer signature's tail in the body as orphaned markup.
		const signature = renderSignatureBlock(
			'<div><table><tr><td><div>Ada Lovelace</div></td></tr></table></div>',
		);
		const result = stripSignatureBlocks(`<p>Hi</p>${signature}<p>Bye</p>`);
		expect(result).toBe("<p>Hi</p><p>Bye</p>");
		expect(result).not.toContain("table");
		expect(result).not.toContain("</div>");
	});

	it("removes every signature in a body, not only the first", () => {
		// A thread replied to several times inside one body carries one per round.
		const body = [
			"<p>Latest</p>",
			renderSignatureBlock("<p>— Ada</p>"),
			"<blockquote><p>Earlier</p>",
			renderSignatureBlock("<p>— Grace</p>"),
			"</blockquote>",
		].join("");
		const result = stripSignatureBlocks(body);
		expect(result).not.toContain("email-signature");
		expect(result).toContain("Latest");
		expect(result).toContain("Earlier");
	});

	it("matches the class on any element, not just div", () => {
		const body =
			'<p>Hi</p><section class="email-signature"><p>— Ada</p></section>';
		expect(stripSignatureBlocks(body)).toBe("<p>Hi</p>");
	});

	it("matches the class among others, in either quote style", () => {
		expect(
			stripSignatureBlocks(
				`<p>Hi</p><div class="sig email-signature trailing"><p>x</p></div>`,
			),
		).toBe("<p>Hi</p>");
		expect(
			stripSignatureBlocks(
				`<p>Hi</p><div class='email-signature'><p>x</p></div>`,
			),
		).toBe("<p>Hi</p>");
	});

	it("does not match a class that merely starts with the name", () => {
		// `email-signature-preview` is a different thing, and eating it would hide
		// content the reader asked to see.
		const body = '<p>Hi</p><div class="email-signature-preview">x</div>';
		expect(stripSignatureBlocks(body)).toBe(body);
	});

	it("leaves the body alone when the signature is never closed", () => {
		// Removing to end-of-document would take the rest of the message with it.
		// A visible signature is a far better outcome than a truncated message.
		const body = '<p>Hi</p><div class="email-signature"><p>— Ada</p>';
		expect(stripSignatureBlocks(body)).toBe(body);
	});

	it("handles an empty or missing body", () => {
		expect(stripSignatureBlocks("")).toBe("");
		expect(stripSignatureBlocks(null)).toBe("");
		expect(stripSignatureBlocks(undefined)).toBe("");
	});

	it("survives a self-closing wrapper without looping", () => {
		// Degenerate but cheap to be safe about: a self-closing tag encloses
		// nothing, so treating it as an opener would never find a close and could
		// spin. The tag is dropped and the scan moves on.
		const body = '<p>Hi</p><div class="email-signature" /><p>Bye</p>';
		expect(stripSignatureBlocks(body)).toBe("<p>Hi</p><p>Bye</p>");
	});
});
