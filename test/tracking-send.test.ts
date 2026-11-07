// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The send-side tracking bridge: reading settings, minting real tokens against
 * a fake stub's secret, and the no-op / fail-open paths. The tokens produced
 * here are verified with the real verifier, so this also proves the send path
 * and the public endpoint agree on the token format end to end.
 */

import { describe, expect, it } from "vitest";
import {
	applyTrackingToOutgoingHtml,
	trackingBaseUrlFromRequest,
	type TrackingStub,
} from "../workers/lib/tracking-send";
import { verifyTrackingToken } from "../shared/tracking-token";

const SECRET = "d".repeat(64);

function stub(
	settings: {
		openTracking: boolean;
		clickTracking: boolean;
		attachmentTracking?: boolean;
	},
	overrides: Partial<TrackingStub> = {},
): TrackingStub {
	return {
		async getTrackingSettings() {
			return {
				attachmentTracking: true,
				...settings,
			};
		},
		async getOrCreateTrackingSecret() {
			return SECRET;
		},
		...overrides,
	};
}

const baseArgs = {
	mailboxId: "support@tapetide.com",
	emailId: "local-1",
	recipient: "user@example.org",
	baseUrl: "https://mailer.tapetide.com",
};

describe("applyTrackingToOutgoingHtml", () => {
	it("wraps links and adds a pixel whose tokens verify end to end", async () => {
		const out = await applyTrackingToOutgoingHtml({
			...baseArgs,
			stub: stub({ openTracking: true, clickTracking: true }),
			html: '<body><a href="https://tapetide.com/x">x</a></body>',
		});

		expect(out).toBeDefined();
		const clickToken = out!.match(/\/t\/c\/([^"]+)"/)?.[1];
		const openToken = out!.match(/\/t\/o\/([^"]+)"/)?.[1];
		expect(clickToken).toBeTruthy();
		expect(openToken).toBeTruthy();

		// The endpoint would verify these with the same secret; prove they do.
		const click = await verifyTrackingToken(clickToken!, SECRET);
		expect(click?.kind).toBe("clicked");
		expect(click?.url).toBe("https://tapetide.com/x");
		expect(click?.emailId).toBe("local-1");

		const open = await verifyTrackingToken(openToken!, SECRET);
		expect(open?.kind).toBe("opened");
		expect(open?.recipient).toBe("user@example.org");
	});

	it("returns the html unchanged when both toggles are off", async () => {
		const html = '<body><a href="https://x.com">x</a></body>';
		const out = await applyTrackingToOutgoingHtml({
			...baseArgs,
			stub: stub({ openTracking: false, clickTracking: false }),
			html,
		});
		expect(out).toBe(html);
	});

	it("returns undefined html untouched (a text-only send)", async () => {
		const out = await applyTrackingToOutgoingHtml({
			...baseArgs,
			stub: stub({ openTracking: true, clickTracking: true }),
			html: undefined,
		});
		expect(out).toBeUndefined();
	});

	it("fails open: on a stub error it returns the original html, not a throw", async () => {
		const html = "<body>Hi</body>";
		const out = await applyTrackingToOutgoingHtml({
			...baseArgs,
			stub: stub(
				{ openTracking: true, clickTracking: true },
				{
					async getOrCreateTrackingSecret() {
						throw new Error("DO unreachable");
					},
				},
			),
			html,
		});
		expect(out).toBe(html);
	});
});

describe("trackingBaseUrlFromRequest", () => {
	it("uses the request's own origin so callbacks reach this worker", () => {
		expect(
			trackingBaseUrlFromRequest(
				"https://mailer.tapetide.com/api/v1/mailboxes/x/emails",
			),
		).toBe("https://mailer.tapetide.com");
	});
});
