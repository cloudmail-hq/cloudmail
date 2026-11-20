// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Reading stored headers, and addressing a reply from them.
 *
 * The fixtures matter more than usual here. `emails.raw_headers` holds a JSON
 * array — `JSON.stringify(parsedEmail.headers)` on the inbound path — and the
 * consumers that regex-matched it as a block of RFC 5322 lines were only ever
 * tested against hand-written header strings, which is why they passed while
 * finding nothing on real mail. So the tests below use `storedHeaders()`, which
 * produces exactly what the inbound path writes.
 */

import { describe, expect, it } from "vitest";
import {
	formatHeaderLines,
	headerValue,
	headerValues,
	parseAddressList,
	parseHeaderLines,
	parseStoredHeaders,
	replyRecipients,
	replyToDiffersFromSender,
} from "../shared/headers";
import { parseUnsubscribe, toEmlBlob } from "../app/lib/email-html";
import { toolDraftReply } from "../workers/lib/tools";
import type { Env } from "../workers/types";

/** What `workers/index.ts` actually stores for an inbound message. */
function storedHeaders(fields: Record<string, string>): string {
	return JSON.stringify(
		Object.entries(fields).map(([key, value]) => ({ key, value })),
	);
}

describe("parseStoredHeaders", () => {
	it("reads the JSON array the inbound path writes", () => {
		const raw = storedHeaders({
			From: "News <news@example.com>",
			"Reply-To": "support@example.com",
		});

		expect(parseStoredHeaders(raw)).toEqual([
			{ key: "From", value: "News <news@example.com>" },
			{ key: "Reply-To", value: "support@example.com" },
		]);
	});

	it("reads a block of header lines too", () => {
		expect(
			parseStoredHeaders("From: a@example.com\r\nSubject: Hello"),
		).toEqual([
			{ key: "From", value: "a@example.com" },
			{ key: "Subject", value: "Hello" },
		]);
	});

	it("returns nothing for absent, empty or unreadable input", () => {
		expect(parseStoredHeaders(null)).toEqual([]);
		expect(parseStoredHeaders(undefined)).toEqual([]);
		expect(parseStoredHeaders("   ")).toEqual([]);
		// Looks like JSON, is not. Must not throw.
		expect(parseStoredHeaders("[{oops")).toEqual([]);
		// Valid JSON of the wrong shape.
		expect(parseStoredHeaders('["From: a@example.com"]')).toEqual([]);
		expect(parseStoredHeaders('{"key":"From"}')).toEqual([]);
	});

	it("keeps a header whose value is missing", () => {
		// An empty header value is legal, and dropping the field would make
		// `headerValue` say "absent" for something that is present.
		expect(parseStoredHeaders('[{"key":"X-Spam"}]')).toEqual([
			{ key: "X-Spam", value: "" },
		]);
	});
});

describe("parseHeaderLines", () => {
	it("unfolds a continued value", () => {
		// RFC 5322 §2.2.3. `List-Unsubscribe` with two targets wraps in practice, and
		// truncating at the fold loses the second one.
		const parsed = parseHeaderLines(
			"List-Unsubscribe: <mailto:stop@example.com>,\r\n <https://example.com/unsub>",
		);
		expect(parsed).toEqual([
			{
				key: "List-Unsubscribe",
				value: "<mailto:stop@example.com>, <https://example.com/unsub>",
			},
		]);
	});

	it("stops at the blank line that ends the header section", () => {
		const parsed = parseHeaderLines(
			"Subject: Hi\r\n\r\nBody: not a header\r\n",
		);
		expect(parsed).toEqual([{ key: "Subject", value: "Hi" }]);
	});

	it("ignores lines that are not fields", () => {
		expect(parseHeaderLines("not a header\r\n: empty name\r\nTo: b@x.com")).toEqual([
			{ key: "To", value: "b@x.com" },
		]);
	});
});

describe("headerValue", () => {
	const headers = parseStoredHeaders(
		storedHeaders({ "REPLY-TO": "a@example.com", "X-Blank": "" }),
	);

	it("matches case-insensitively", () => {
		expect(headerValue(headers, "Reply-To")).toBe("a@example.com");
		expect(headerValue(headers, "reply-to")).toBe("a@example.com");
	});

	it("treats an empty value as absent", () => {
		expect(headerValue(headers, "X-Blank")).toBeNull();
		expect(headerValue(headers, "Nope")).toBeNull();
	});

	it("collects every value for a repeated field", () => {
		const received = parseStoredHeaders(
			'[{"key":"Received","value":"one"},{"key":"received","value":"two"}]',
		);
		expect(headerValues(received, "Received")).toEqual(["one", "two"]);
	});
});

describe("parseAddressList", () => {
	it("pulls addresses out of display-name form", () => {
		expect(parseAddressList("Ada <ada@example.com>, bob@example.com")).toEqual([
			"ada@example.com",
			"bob@example.com",
		]);
	});

	it("de-duplicates case-insensitively, keeping the first spelling", () => {
		expect(parseAddressList("Ada@example.com, ada@example.com")).toEqual([
			"Ada@example.com",
		]);
	});

	it("discards fragments that are not addresses", () => {
		expect(parseAddressList("undisclosed-recipients:;")).toEqual([]);
		expect(parseAddressList("")).toEqual([]);
		expect(parseAddressList(null)).toEqual([]);
	});
});

// -- The bug this branch is about ----------------------------------

describe("replyRecipients", () => {
	it("prefers Reply-To over From", () => {
		const email = {
			raw_headers: storedHeaders({
				From: "no-reply@tickets.example.com",
				"Reply-To": "support@example.com",
			}),
			sender: "no-reply@tickets.example.com",
		};

		expect(replyRecipients(email)).toEqual(["support@example.com"]);
	});

	it("returns every Reply-To address, because the sender named them all", () => {
		const email = {
			raw_headers: storedHeaders({
				From: "chair@example.com",
				"Reply-To": "list@example.com, chair@example.com",
			}),
			sender: "chair@example.com",
		};

		expect(replyRecipients(email)).toEqual([
			"list@example.com",
			"chair@example.com",
		]);
	});

	it("falls back to From when there is no Reply-To", () => {
		const email = {
			raw_headers: storedHeaders({ From: "Ada <ada@example.com>" }),
			sender: "ada@example.com",
		};

		expect(replyRecipients(email)).toEqual(["ada@example.com"]);
	});

	it("falls back to the stored sender column when there are no headers", () => {
		// Rows written before headers were kept, and anything this app sent.
		expect(replyRecipients({ sender: "ada@example.com" })).toEqual([
			"ada@example.com",
		]);
		expect(replyRecipients({ raw_headers: "[]", sender: "ada@example.com" })).toEqual([
			"ada@example.com",
		]);
	});

	it("ignores a Reply-To with no usable address", () => {
		const email = {
			raw_headers: storedHeaders({
				From: "ada@example.com",
				"Reply-To": "undisclosed-recipients:;",
			}),
			sender: "ada@example.com",
		};

		expect(replyRecipients(email)).toEqual(["ada@example.com"]);
	});

	it("yields nothing when there is nothing to reply to", () => {
		expect(replyRecipients({})).toEqual([]);
	});
});

describe("replyToDiffersFromSender", () => {
	it("is true when replies go somewhere else entirely", () => {
		expect(
			replyToDiffersFromSender({
				raw_headers: storedHeaders({
					From: "no-reply@example.com",
					"Reply-To": "elsewhere@other.example",
				}),
				sender: "no-reply@example.com",
			}),
		).toBe(true);
	});

	it("is true when Reply-To adds recipients beyond the author", () => {
		// `Reply-To: list, author` reaches the author *and* the list. Suppressing the
		// warning here would hide the added recipient — which is the case most likely
		// to put a confidential reply somewhere it should not go.
		expect(
			replyToDiffersFromSender({
				raw_headers: storedHeaders({
					From: "chair@example.com",
					"Reply-To": "list@example.com, Chair@example.com",
				}),
				sender: "chair@example.com",
			}),
		).toBe(true);
	});

	it("is false when Reply-To names exactly the author", () => {
		// Says nothing the From line does not, so a banner would be noise.
		expect(
			replyToDiffersFromSender({
				raw_headers: storedHeaders({
					From: "Ada <ada@example.com>",
					"Reply-To": "ADA@example.com",
				}),
				sender: "ada@example.com",
			}),
		).toBe(false);
	});

	it("is false with no Reply-To at all", () => {
		expect(
			replyToDiffersFromSender({
				raw_headers: storedHeaders({ From: "ada@example.com" }),
				sender: "ada@example.com",
			}),
		).toBe(false);
	});
});

// -- The two consumers that were reading the column wrongly --------

describe("parseUnsubscribe against real stored headers", () => {
	it("finds the target in the JSON the inbound path writes", () => {
		// The regression: this returned null for every real message, so the
		// unsubscribe control never appeared.
		const parsed = parseUnsubscribe(
			storedHeaders({
				From: "news@example.com",
				"List-Unsubscribe": "<https://example.com/unsub?id=1>",
				"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
			}),
		);

		expect(parsed).toEqual({
			url: "https://example.com/unsub?id=1",
			mailto: undefined,
			oneClick: true,
		});
	});

	it("prefers https over mailto", () => {
		const parsed = parseUnsubscribe(
			storedHeaders({
				"List-Unsubscribe":
					"<mailto:stop@example.com>, <https://example.com/unsub>",
			}),
		);

		expect(parsed?.url).toBe("https://example.com/unsub");
		expect(parsed?.mailto).toBe("mailto:stop@example.com");
		// No `List-Unsubscribe-Post`, so not one-click.
		expect(parsed?.oneClick).toBe(false);
	});

	it("still reads a plain header block", () => {
		const parsed = parseUnsubscribe(
			[
				"List-Unsubscribe: <https://example.com/unsub>",
				"List-Unsubscribe-Post: List-Unsubscribe=One-Click",
			].join("\r\n"),
		);
		expect(parsed?.oneClick).toBe(true);
	});

	it("returns null when the header is absent or unusable", () => {
		expect(parseUnsubscribe(undefined)).toBeNull();
		expect(parseUnsubscribe(storedHeaders({ Subject: "hello" }))).toBeNull();
		expect(
			parseUnsubscribe(storedHeaders({ "List-Unsubscribe": "nonsense" })),
		).toBeNull();
	});
});

describe("toEmlBlob against real stored headers", () => {
	it("writes header lines, not the stored JSON", async () => {
		const text = await toEmlBlob({
			raw_headers: storedHeaders({
				From: "Ada <ada@example.com>",
				Subject: "Stored",
			}),
			body: "<p>Hi</p>",
		}).text();

		expect(text).toContain("From: Ada <ada@example.com>");
		expect(text).toContain("Subject: Stored");
		// The regression: the header section was a line of JSON, which no mail
		// client can open.
		expect(text).not.toContain('{"key"');
		// Headers, blank line, body — RFC 5322 §2.1.
		expect(text.split("\r\n\r\n")[1]).toBe("<p>Hi</p>");
	});

	it("falls back to a minimal block when nothing was stored", async () => {
		const text = await toEmlBlob({
			sender: "ada@example.com",
			recipient: "bob@example.com",
			subject: "No headers",
			body: "hi",
		}).text();

		expect(text).toContain("From: ada@example.com");
		expect(text).toContain("To: bob@example.com");
		expect(text).toContain("Subject: No headers");
	});
});

describe("formatHeaderLines", () => {
	it("round-trips through the line parser", () => {
		const original = parseStoredHeaders(
			storedHeaders({ From: "a@example.com", Subject: "Round trip" }),
		);
		expect(parseHeaderLines(formatHeaderLines(original))).toEqual(original);
	});

	it("drops a field with no name", () => {
		expect(formatHeaderLines([{ key: "", value: "orphan" }])).toBe("");
	});
});

// -- The draft tool overrides the model ----------------------------

/**
 * `toolDraftReply` decides the recipient rather than trusting its caller.
 *
 * The prompt tells the model the right address, but a prompt is guidance. An MCP
 * client calling the tool directly, or a model that ignores the instruction, would
 * otherwise address a draft at a no-reply robot.
 */
describe("toolDraftReply recipient", () => {
	function stub(original: Record<string, unknown> | null) {
		const created: Record<string, unknown>[] = [];
		const env = {
			AI: {},
			MAILBOX: {
				idFromName: (name: string) => ({ name }),
				get: () => ({
					async getEmail() {
						return original;
					},
					async createEmail(_folder: string, row: Record<string, unknown>) {
						created.push(row);
						return row;
					},
				}),
			},
		} as unknown as Env;
		return { env, created };
	}

	it("addresses the draft at Reply-To, not the model's suggestion", async () => {
		const { env, created } = stub({
			id: "e1",
			thread_id: "t1",
			sender: "no-reply@tickets.example.com",
			date: "2026-09-01T09:00:00.000Z",
			body: "<p>Ticket opened</p>",
			raw_headers: storedHeaders({
				From: "no-reply@tickets.example.com",
				"Reply-To": "support@example.com",
			}),
		});

		const result = await toolDraftReply(env, "desk@tapetide.com", {
			originalEmailId: "e1",
			// What a model reading only the From line would send.
			to: "no-reply@tickets.example.com",
			subject: "Re: Ticket",
			body: "On it.",
			isPlainText: true,
			runVerifyDraft: false,
		});

		expect(created[0]!.recipient).toBe("support@example.com");
		expect((result as { draft: { to: string } }).draft.to).toBe("support@example.com");
	});

	it("keeps the caller's address when the original cannot be read", async () => {
		// Nothing better to go on, so the model's answer stands rather than the draft
		// failing outright.
		const { env, created } = stub(null);

		await toolDraftReply(env, "desk@tapetide.com", {
			originalEmailId: "missing",
			to: "someone@example.com",
			subject: "Re: Hi",
			body: "Hello.",
			isPlainText: true,
			runVerifyDraft: false,
		});

		expect(created[0]!.recipient).toBe("someone@example.com");
	});
});
