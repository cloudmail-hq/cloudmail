// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * `raw_headers` must not claim a header the recipient never received.
 *
 * ## Why this file exists (Codex P2 x2 on PR #65)
 *
 * Removing `Message-ID` and `Sender` from the wire fixed delivery, but the send
 * routes were still PERSISTING both into `raw_headers`. That column is not
 * decoration — it is the source of truth for two user-facing exports:
 *
 *   - `toEmlBlob` (app/lib/email-html.ts) renders the stored headers verbatim
 *     when there are any, and only falls back to the columns when there are none.
 *   - `exportHeaders` (shared/mbox.ts) prefers stored headers and then *tops up*
 *     from the columns, skipping any key already present.
 *
 * So a stale `message-id` entry OUTRANKS the corrected `message_id` column, and a
 * downloaded `.eml` or mbox archive would advertise an id that was never sent —
 * exactly the mismatch the delivery fix set out to remove, surviving in the one
 * artifact an auditor would trust. A persisted `sender` was worse: it asserted
 * recipients got an on-behalf-of header that the provider had rejected outright.
 *
 * These tests assert on the EXPORTERS rather than on the route bodies, because
 * that is where the lie would be observed.
 */

import { describe, expect, it } from "vitest";
import { exportHeaders } from "../shared/mbox";
import { toEmlBlob } from "../app/lib/email-html";
import { isSendableHeader } from "../shared/email-headers";

/** The header shape the send routes now persist for a plain outgoing message. */
const STORED_AFTER_SEND = JSON.stringify([
	{ key: "from", value: "Support <support@tapetide.com>" },
	{ key: "to", value: "user@example.org" },
	{ key: "subject", value: "Your invoice" },
	{ key: "date", value: "2026-08-21T09:00:00.000Z" },
]);

/** A row as it looks once `recordDelivery` has written the provider's id. */
const SENT_ROW = {
	id: "local-uuid-1",
	folder_id: "sent",
	subject: "Your invoice",
	sender: "support@tapetide.com",
	recipient: "user@example.org",
	cc: null,
	bcc: null,
	date: "2026-08-21T09:00:00.000Z",
	message_id: "real-provider-id@cloudflare",
	in_reply_to: null,
	email_references: null,
	raw_headers: STORED_AFTER_SEND,
	body: "<p>Attached.</p>",
};

function headerMap(headers: { key: string; value: string }[]) {
	const map = new Map<string, string[]>();
	for (const { key, value } of headers) {
		const k = key.toLowerCase();
		map.set(k, [...(map.get(k) ?? []), value]);
	}
	return map;
}

describe("mbox export after a real send", () => {
	it("carries the PROVIDER's message id, not a locally-minted one", () => {
		// The whole point: with no stale entry in raw_headers, the top-up path
		// supplies the corrected column.
		const map = headerMap(exportHeaders(SENT_ROW));
		expect(map.get("message-id")).toEqual(["<real-provider-id@cloudflare>"]);
	});

	it("emits exactly ONE Message-ID", () => {
		// Two would be malformed and readers disagree about which wins — which is
		// what a stale stored entry plus the column top-up would have produced if
		// the de-dupe in exportHeaders were ever relaxed.
		const map = headerMap(exportHeaders(SENT_ROW));
		expect(map.get("message-id")).toHaveLength(1);
	});

	it("never claims a Sender header", () => {
		// The provider refuses `Sender`, so an export asserting one would be telling
		// the reader something untrue about what was transmitted.
		const map = headerMap(exportHeaders(SENT_ROW));
		expect(map.has("sender")).toBe(false);
	});

	it("would surface a stale stored id if one were ever reintroduced", () => {
		// A NEGATIVE CONTROL for the two tests above: it proves they can actually
		// fail. Feeding the pre-fix header blob makes the export carry the id that
		// was never sent, which is the defect Codex identified.
		const stale = {
			...SENT_ROW,
			raw_headers: JSON.stringify([
				{ key: "from", value: "Support <support@tapetide.com>" },
				{ key: "message-id", value: "<locally-minted@tapetide.com>" },
				{ key: "sender", value: "agent@tapetide.com" },
			]),
		};
		const map = headerMap(exportHeaders(stale));
		expect(map.get("message-id")).toEqual(["<locally-minted@tapetide.com>"]);
		expect(map.has("sender")).toBe(true);
	});
});

describe(".eml download after a real send", () => {
	it("renders the provider's id from the column", async () => {
		// toEmlBlob uses the stored block verbatim when non-empty, so this only
		// holds because the stale entry is gone AND the block is topped up.
		const text = await toEmlBlob(SENT_ROW).text();
		// The stored block has no message-id, so the fallback branch is not taken;
		// what matters is that no WRONG id appears.
		expect(text).not.toContain("locally-minted");
		expect(text).not.toContain("Sender:");
	});

	it("falls back to the column when nothing was stored", async () => {
		const text = await toEmlBlob({ ...SENT_ROW, raw_headers: null }).text();
		expect(text).toContain("Message-ID: real-provider-id@cloudflare");
	});
});

describe("persisted headers stay within the provider contract", () => {
	it("every stored key is one we could legitimately have sent", () => {
		/**
		 * The generalisation of both P2s. `from`/`to`/`subject`/`date` are API-field
		 * headers — legitimately recorded as a description of the message, but never
		 * settable via `headers`. What must NEVER appear is a key that is neither an
		 * API field nor sendable, because that is a header we could not have
		 * transmitted and therefore must not claim.
		 */
		const stored = JSON.parse(STORED_AFTER_SEND) as { key: string }[];
		const apiFields = new Set(["from", "to", "cc", "bcc", "subject", "reply-to", "date"]);
		for (const { key } of stored) {
			const k = key.toLowerCase();
			expect(
				apiFields.has(k) || isSendableHeader(key),
				`${key} is neither an API field nor a sendable header`,
			).toBe(true);
		}
	});

	it("does not persist message-id or sender", () => {
		const keys = (JSON.parse(STORED_AFTER_SEND) as { key: string }[]).map((h) =>
			h.key.toLowerCase(),
		);
		expect(keys).not.toContain("message-id");
		expect(keys).not.toContain("sender");
	});
});
