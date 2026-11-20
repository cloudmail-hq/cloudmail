import { describe, expect, it } from "vitest";
import {
	MAX_ATTACHMENT_TOTAL_RAW_BYTES,
	MAX_MESSAGE_BYTES,
	base64EncodedSize,
	estimateMessageBytes,
	isMessageWithinLimit,
	utf8Size,
} from "../shared/limits";
import {
	MessageTooLargeError,
	assertMessageWithinSizeLimit,
} from "../workers/lib/email-helpers";

/** A base64 payload of `n` characters — length is what the estimator reads. */
const encodedPayload = (n: number) => "A".repeat(n);

describe("size arithmetic", () => {
	it("matches the documented Cloudflare ceiling", () => {
		expect(MAX_MESSAGE_BYTES).toBe(5 * 1024 * 1024);
	});

	it("expands base64 by 4/3 plus MIME line folding", () => {
		// 3 raw bytes -> 4 base64 chars, plus ~2.6% CRLF overhead.
		expect(base64EncodedSize(3)).toBe(5);
		expect(base64EncodedSize(3 * 1024)).toBeGreaterThan(4 * 1024);
		expect(base64EncodedSize(3 * 1024)).toBeLessThan(4.3 * 1024);
	});

	it("counts UTF-8 bytes, not code units", () => {
		expect(utf8Size("abc")).toBe(3);
		expect(utf8Size("€")).toBe(3);
		expect(utf8Size("👍")).toBe(4);
		expect(utf8Size(undefined)).toBe(0);
	});

	it("leaves the raw attachment budget under the wire limit once encoded", () => {
		const encoded = base64EncodedSize(MAX_ATTACHMENT_TOTAL_RAW_BYTES);
		expect(encoded).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
	});

	it("keeps the raw budget meaningfully below the naive 5 MiB figure", () => {
		// The old UI advertised 25 MB; reality is closer to 3.6 MiB of raw files.
		expect(MAX_ATTACHMENT_TOTAL_RAW_BYTES).toBeLessThan(4 * 1024 * 1024);
		expect(MAX_ATTACHMENT_TOTAL_RAW_BYTES).toBeGreaterThan(3 * 1024 * 1024);
	});

	it("reserves headroom for headers even on an empty message", () => {
		expect(estimateMessageBytes({})).toBeGreaterThan(0);
	});
});

describe("assertMessageWithinSizeLimit", () => {
	it("accepts an ordinary message", () => {
		expect(() =>
			assertMessageWithinSizeLimit({ html: "<p>hello</p>" }),
		).not.toThrow();
	});

	it("accepts a message just inside the limit", () => {
		expect(
			isMessageWithinLimit({ encodedAttachmentSizes: [4 * 1024 * 1024] }),
		).toBe(true);
	});

	it("rejects an oversized attachment", () => {
		expect(() =>
			assertMessageWithinSizeLimit({
				html: "<p>invoice</p>",
				attachments: [{ content: encodedPayload(6 * 1024 * 1024) }],
			}),
		).toThrow(MessageTooLargeError);
	});

	it("rejects attachments that are individually fine but collectively too big", () => {
		expect(() =>
			assertMessageWithinSizeLimit({
				attachments: [
					{ content: encodedPayload(2 * 1024 * 1024) },
					{ content: encodedPayload(2 * 1024 * 1024) },
					{ content: encodedPayload(2 * 1024 * 1024) },
				],
			}),
		).toThrow(MessageTooLargeError);
	});

	it("counts the body, so a huge quoted thread alone can trip the limit", () => {
		expect(() =>
			assertMessageWithinSizeLimit({ html: "x".repeat(6 * 1024 * 1024) }),
		).toThrow(MessageTooLargeError);
	});

	it("explains the base64 overhead in the error message", () => {
		try {
			assertMessageWithinSizeLimit({
				attachments: [{ content: encodedPayload(6 * 1024 * 1024) }],
			});
			throw new Error("expected a MessageTooLargeError");
		} catch (e) {
			expect(e).toBeInstanceOf(MessageTooLargeError);
			expect((e as MessageTooLargeError).message).toMatch(/too large/i);
			expect((e as MessageTooLargeError).message).toContain("5.0 MB");
			expect((e as MessageTooLargeError).estimatedBytes).toBeGreaterThan(
				MAX_MESSAGE_BYTES,
			);
		}
	});
});
