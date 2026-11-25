import { describe, expect, it } from "vitest";
import {
	attachmentKey,
	canServeInline,
	sanitizeAttachmentFilename,
} from "../workers/lib/attachments";

describe("sanitizeAttachmentFilename", () => {
	it("leaves ordinary names alone", () => {
		expect(sanitizeAttachmentFilename("invoice-2026.pdf")).toBe(
			"invoice-2026.pdf",
		);
	});

	it("neutralises path traversal", () => {
		expect(sanitizeAttachmentFilename("../../etc/passwd")).toBe(
			".._.._etc_passwd",
		);
		expect(sanitizeAttachmentFilename("..\\..\\windows\\system32")).toBe(
			".._.._windows_system32",
		);
	});

	it("strips characters that break R2 keys", () => {
		expect(sanitizeAttachmentFilename('re:port*"<>|.txt')).toBe(
			"re_port_____.txt",
		);
	});

	it("strips control characters", () => {
		expect(sanitizeAttachmentFilename("re\u0000port\u001f.txt")).toBe(
			"re_port_.txt",
		);
	});

	it("falls back for missing names", () => {
		expect(sanitizeAttachmentFilename(undefined)).toBe("untitled");
		expect(sanitizeAttachmentFilename(null)).toBe("untitled");
		expect(sanitizeAttachmentFilename("")).toBe("untitled");
	});

	it("is idempotent, so an accidental second pass cannot move the key", () => {
		const once = sanitizeAttachmentFilename("../weird:name?.pdf");
		expect(sanitizeAttachmentFilename(once)).toBe(once);
	});
});

/**
 * The write/read contract for attachment blobs.
 *
 * Sanitisation happens exactly once, on write, before the name is persisted.
 * Every later key reconstruction — download, single-email delete, mailbox purge —
 * uses the stored column verbatim.
 */
describe("attachmentKey round-trip", () => {
	/** What the write path does: sanitise, build the key, persist the safe name. */
	function write(rawFilename: string) {
		const storedFilename = sanitizeAttachmentFilename(rawFilename);
		return {
			storedFilename,
			key: attachmentKey("email-1", "att-1", storedFilename),
		};
	}

	/** What download / delete / purge do: read the column, rebuild the key. */
	function rebuild(storedFilename: string) {
		return attachmentKey("email-1", "att-1", storedFilename);
	}

	it.each([
		"invoice.pdf",
		"../../etc/passwd",
		're:port*"<>|.txt',
		"re\u0000port\u001f.txt",
		"héllo wörld 👍.pdf",
	])("reconstructs the exact written key for %j", (raw) => {
		const { storedFilename, key } = write(raw);
		expect(rebuild(storedFilename)).toBe(key);
	});

	it("would break if a reader re-sanitised under a widened deny-list", () => {
		// Guards the invariant documented on sanitizeAttachmentFilename: a reader
		// that re-derives the name is coupled to the sanitiser's current rules,
		// whereas the stored column is stable. Simulate a future stricter rule.
		const { storedFilename, key } = write("report v2.pdf");
		const widenedSanitiser = (name: string) => name.replace(/[ ]/g, "_");

		expect(rebuild(storedFilename)).toBe(key);
		expect(rebuild(widenedSanitiser(storedFilename))).not.toBe(key);
	});
});

describe("attachmentKey", () => {
	it("builds the canonical key layout", () => {
		expect(attachmentKey("email-1", "att-1", "invoice.pdf")).toBe(
			"attachments/email-1/att-1/invoice.pdf",
		);
	});

	it("is namespaced per email, so a shared bucket cannot be swept by prefix", () => {
		// Mailbox deletion depends on this: keys carry no mailbox segment, so the
		// key list must come from the mailbox's own attachment rows.
		const key = attachmentKey("email-1", "att-1", "invoice.pdf");
		expect(key.startsWith("attachments/")).toBe(true);
		expect(key.split("/")).toHaveLength(4);
	});
});

/**
 * Which attachment types the download route is willing to render inside the
 * app's own origin.
 *
 * This was a deny-list of executable types, which is the wrong shape: it has to
 * enumerate every type a browser might sniff as a document, and anything it
 * misses is served inline. Inbound mail carries attacker-controlled parts, so a
 * miss is stored XSS against every mailbox in the deployment. These cases pin
 * the inversion — an unrecognised type must download, not render.
 */
describe("canServeInline", () => {
	/** The six the reader actually needs: `cid:` images, and the preview overlay. */
	it.each([
		"image/png",
		"image/jpeg",
		"image/gif",
		"image/webp",
		"application/pdf",
		"text/plain",
	])("serves %s inline when the caller asks for it", (mimetype) => {
		expect(canServeInline(mimetype, "inline")).toBe(true);
	});

	/** The old deny-list's members. Still refused, now by omission. */
	it.each([
		"text/html",
		"application/xhtml+xml",
		"image/svg+xml",
		"application/xml",
		"text/xml",
	])("forces %s to download", (mimetype) => {
		expect(canServeInline(mimetype, "inline")).toBe(false);
	});

	/**
	 * The whole point of the inversion. None of these were on the deny-list, so
	 * every one of them used to render inline in this app's origin on request.
	 */
	it.each([
		"application/octet-stream",
		"application/x-msdownload",
		"message/rfc822",
		"multipart/related",
		"application/xslt+xml",
		"image/svg",
		"text/x-unknown",
		"application/vnd.ms-excel",
	])("forces unrecognised type %s to download", (mimetype) => {
		expect(canServeInline(mimetype, "inline")).toBe(false);
	});

	it("never serves inline when the caller did not ask", () => {
		expect(canServeInline("image/png", undefined)).toBe(false);
		expect(canServeInline("image/png", null)).toBe(false);
		expect(canServeInline("image/png", "attachment")).toBe(false);
		expect(canServeInline("image/png", "")).toBe(false);
	});

	/**
	 * A stored mimetype comes from the inbound message, so its formatting is the
	 * sender's choice. Parameters and casing must not change the decision either
	 * way: `TEXT/HTML; charset=utf-8` has to be refused, and a legitimately
	 * parameterised `text/plain; charset=utf-8` has to still preview.
	 */
	it("normalises parameters and casing before deciding", () => {
		expect(canServeInline("text/plain; charset=utf-8", "inline")).toBe(true);
		expect(canServeInline("  IMAGE/PNG  ", "inline")).toBe(true);
		expect(canServeInline("TEXT/HTML; charset=utf-8", "inline")).toBe(false);
		expect(canServeInline("Image/SVG+XML", "inline")).toBe(false);
	});

	it("forces a download for a missing or empty mimetype", () => {
		expect(canServeInline(undefined, "inline")).toBe(false);
		expect(canServeInline(null, "inline")).toBe(false);
		expect(canServeInline("", "inline")).toBe(false);
	});

	/**
	 * `Object.prototype` keys must not read as allowlisted. The lookup table is a
	 * plain object, so a mimetype of `constructor` would find an inherited value
	 * under a truthiness check.
	 */
	it("does not treat inherited object keys as allowlisted", () => {
		expect(canServeInline("constructor", "inline")).toBe(false);
		expect(canServeInline("toString", "inline")).toBe(false);
		expect(canServeInline("__proto__", "inline")).toBe(false);
	});
});
