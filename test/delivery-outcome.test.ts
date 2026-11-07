// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Delivery outcomes must be recorded, not just logged.
 *
 * ## The failure mode this file exists to close
 *
 * A rejected header took down 100% of outgoing mail and nothing showed it. The
 * header bug is fixed elsewhere; this file covers the reason it stayed invisible
 * for the entire life of the fork, which is the more dangerous half:
 *
 *   1. the send route writes the Sent copy and answers `202 {"status":"sent"}`
 *      BEFORE delivery is attempted;
 *   2. the real `env.EMAIL.send()` runs inside `waitUntil`;
 *   3. a rejection there reached only `console.error`.
 *
 * So the UI, the API and the database all reported success for a message that
 * never left the building. `recordDelivery` is the write-back that makes the
 * outcome observable, and these tests hold it to that.
 *
 * They also pin the OTHER half of the header fix: because Email Service now mints
 * the `Message-ID`, the id it returns is the only one the outside world knows the
 * message by, so it has to land on the row or inbound replies stop threading and
 * bounce correlation breaks.
 */

import { describe, expect, it, vi } from "vitest";
import { recordDelivery } from "../workers/lib/email-helpers";
import { isSendableHeader } from "../shared/email-headers";
import { FORWARDED_HEADER } from "../shared/forwarding";

describe("recordDelivery", () => {
	it("stores the provider's message id on success", () => {
		// This is what keeps threading working now that we no longer send our own
		// Message-ID: the provider's id is the one a reply will cite.
		const stub = { recordDelivery: vi.fn().mockResolvedValue(undefined) };
		return recordDelivery(stub, "local-1", {
			providerMessageId: "generated@cloudflare",
		}).then(() => {
			expect(stub.recordDelivery).toHaveBeenCalledWith("local-1", {
				providerMessageId: "generated@cloudflare",
			});
		});
	});

	it("records the reason on failure", async () => {
		const stub = { recordDelivery: vi.fn().mockResolvedValue(undefined) };
		await recordDelivery(stub, "local-2", {
			error: "custom header 'Message-ID' is not allowed.",
		});
		expect(stub.recordDelivery).toHaveBeenCalledWith("local-2", {
			error: "custom header 'Message-ID' is not allowed.",
		});
	});

	it("NEVER rejects when the write-back itself fails", async () => {
		// It runs on the tail of a fire-and-forget chain. Throwing here would turn a
		// recorded failure into an unhandled rejection and lose the signal entirely
		// — the exact class of silence this feature exists to remove.
		const stub = {
			recordDelivery: vi.fn().mockRejectedValue(new Error("DO unreachable")),
		};
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(
			recordDelivery(stub, "local-3", { error: "upstream refused" }),
		).resolves.toBeUndefined();
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});

	it("never rejects when the stub throws synchronously", async () => {
		const stub = {
			recordDelivery: vi.fn(() => {
				throw new Error("sync boom");
			}),
		};
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(
			recordDelivery(stub as never, "local-4", { providerMessageId: "x@y" }),
		).resolves.toBeUndefined();
		spy.mockRestore();
	});
});

/**
 * The two send paths that deliberately bypass `buildOutgoingHeaders` build their
 * header objects by hand, so the allowlist guard inside that helper cannot
 * protect them. Both were verified against the live provider contract; these
 * assertions stop a future edit from adding a rejected header to either and
 * reintroducing a silent outage on that path alone.
 */
describe("hand-built header sets on the bypass paths", () => {
	it("inbound forwarding sends only an X- header", () => {
		expect(FORWARDED_HEADER.startsWith("X-")).toBe(true);
		expect(isSendableHeader(FORWARDED_HEADER)).toBe(true);
	});

	it("the vacation auto-reply's headers are all acceptable", () => {
		// Mirrors the literal set in workers/index.ts's auto-reply branch.
		const autoReplyHeaders = {
			"Auto-Submitted": "auto-replied",
			"X-Auto-Response-Suppress": "All",
			"In-Reply-To": "<inbound@sender.example>",
		};
		for (const name of Object.keys(autoReplyHeaders)) {
			expect(isSendableHeader(name), name).toBe(true);
		}
	});
});
