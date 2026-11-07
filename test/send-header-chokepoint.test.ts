// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * `sendEmail` is the chokepoint, and it must refuse a header the provider will
 * reject.
 *
 * ## Why this file is separate from outgoing-headers.test.ts
 *
 * That file covers the helper most send paths use. This one covers the boundary
 * EVERY path crosses, including the two that build header objects by hand
 * (inbound forwarding and the vacation auto-reply) and so never reach the
 * helper's own guard.
 *
 * The distinction is what the original outage turned on. `Message-ID` was set in
 * one shared helper, so one bad line disabled delivery everywhere — and because
 * the rejection surfaced inside a `waitUntil`, no test and no user-visible
 * symptom ever pointed at it. Guarding the chokepoint means a future addition on
 * ANY path fails here, synchronously, with the header named.
 */

import { describe, expect, it, vi } from "vitest";
import { sendEmail } from "../workers/email-sender";
import { clearanceForTest } from "../workers/lib/pre-send";

const CLEAR = clearanceForTest();
import { UnsendableHeaderError } from "../shared/email-headers";

/** A binding that records what it was handed and reports a provider id. */
function fakeBinding() {
	const send = vi.fn().mockResolvedValue({ messageId: "provider-generated@cf" });
	return { binding: { send } as unknown as Parameters<typeof sendEmail>[0], send };
}

const BASE = {
	to: "someone@example.com",
	from: "support@tapetide.com",
	subject: "Hello",
	html: "<p>Hi</p>",
};

describe("sendEmail header guard", () => {
	it("returns the provider's message id, which is now the only id in play", async () => {
		// The caller stores this so inbound replies still thread — see recordDelivery.
		const { binding, send } = fakeBinding();
		await expect(sendEmail(binding, BASE, CLEAR)).resolves.toEqual({
			messageId: "provider-generated@cf",
		});
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("refuses Message-ID before it reaches the provider", async () => {
		// The regression, at the boundary. It must fail here rather than being sent
		// and rejected asynchronously where only console.error would see it.
		const { binding, send } = fakeBinding();
		await expect(
			sendEmail(binding, { ...BASE, headers: { "Message-ID": "<a@b>" } }, CLEAR),
		).rejects.toBeInstanceOf(UnsendableHeaderError);
		// Nothing was handed to the provider: a refused set is not a partial send.
		expect(send).not.toHaveBeenCalled();
	});

	it("refuses Sender, the other header that was failing every delegated send", async () => {
		const { binding, send } = fakeBinding();
		await expect(
			sendEmail(binding, { ...BASE, headers: { Sender: "agent@tapetide.com" } }, CLEAR),
		).rejects.toBeInstanceOf(UnsendableHeaderError);
		expect(send).not.toHaveBeenCalled();
	});

	it("refuses a lowercase message-id, since matching is case-insensitive", async () => {
		const { binding, send } = fakeBinding();
		await expect(
			sendEmail(binding, { ...BASE, headers: { "message-id": "<a@b>" } }, CLEAR),
		).rejects.toBeInstanceOf(UnsendableHeaderError);
		expect(send).not.toHaveBeenCalled();
	});

	it("refuses a set where only ONE header is bad", async () => {
		// One rejected header fails the whole message at the provider, so a set that
		// starts out valid must not slip through.
		const { binding, send } = fakeBinding();
		await expect(
			sendEmail(binding, {
				...BASE,
				headers: { "In-Reply-To": "<a@b>", Date: "now" },
			}, CLEAR),
		).rejects.toBeInstanceOf(UnsendableHeaderError);
		expect(send).not.toHaveBeenCalled();
	});

	it("allows the threading headers, which are what we actually need", async () => {
		const { binding, send } = fakeBinding();
		await sendEmail(binding, {
			...BASE,
			headers: {
				"In-Reply-To": "<parent@example.com>",
				References: "<root@example.com> <parent@example.com>",
			},
		}, CLEAR);
		expect(send).toHaveBeenCalledTimes(1);
		expect((send.mock.calls[0][0] as { headers: unknown }).headers).toEqual({
			"In-Reply-To": "<parent@example.com>",
			References: "<root@example.com> <parent@example.com>",
		});
	});

	it("allows the hand-built auto-reply and forwarding header sets", async () => {
		// The two bypass paths, asserted through the real chokepoint rather than by
		// inspecting their literals.
		const { binding, send } = fakeBinding();
		await sendEmail(binding, {
			...BASE,
			headers: {
				"Auto-Submitted": "auto-replied",
				"X-Auto-Response-Suppress": "All",
				"In-Reply-To": "<inbound@sender.example>",
			},
		}, CLEAR);
		await sendEmail(binding, {
			...BASE,
			headers: { "X-Tapetide-Forwarded-For": "support@tapetide.com" },
		}, CLEAR);
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("sends no headers key at all when there are none", async () => {
		// A brand-new message now produces an empty header set, so the guard must
		// not turn that into a rejection — this is the commonest send in the product.
		const { binding, send } = fakeBinding();
		await sendEmail(binding, { ...BASE, headers: {} }, CLEAR);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0][0]).not.toHaveProperty("headers");
	});
});
