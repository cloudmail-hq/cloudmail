// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Self-open filtering, the privacy-proxy flag, and the status wording shared
 * by the list, the reading pane and the MCP `engagement` object.
 */

import { describe, expect, it } from "vitest";
import {
	engagementMetadata,
	handleClickRedirect,
	handleOpenPixel,
} from "../workers/lib/tracking-endpoint";
import { trackingRequestContext } from "../workers/lib/tracking-self-open";
import { signTrackingToken } from "../shared/tracking-token";
import { classifyOpenProxy } from "../shared/open-proxy";
import {
	engagementSummary,
	OPENED_CAVEAT,
	outboundState,
	outboundStatusDescription,
	outboundStatusLine,
} from "../shared/engagement";
import { compactEmail } from "../workers/lib/tools";
import { sha256Hex } from "../workers/auth/crypto";
import type { AuthStoreApi } from "../workers/auth/types";
import type { Env } from "../workers/types";

const SECRET = "c".repeat(64);
const MAILBOX = "support@tapetide.com";

function fakeEnv(recorded: unknown[]) {
	const stub = {
		getTrackingSecret: async () => SECRET,
		recordEngagement: async (event: unknown) => {
			recorded.push(event);
			return true;
		},
	};
	return {
		BUCKET: { head: async (key: string) => ({ key }), get: async () => null },
		MAILBOX: { idFromName: (name: string) => ({ name }), get: () => stub },
		ADMIN_EMAILS: "owner@tapetide.com",
		AUTH_MODE: "password",
	} as unknown as Env;
}

function flusher() {
	const pending: Promise<unknown>[] = [];
	return { waitUntil: (p: Promise<unknown>) => pending.push(p), flush: () => Promise.all(pending) };
}

const openToken = () =>
	signTrackingToken({ mailboxId: MAILBOX, emailId: "e1", recipient: null, kind: "opened" }, SECRET);

describe("self-open filter", () => {
	it("records nothing when the request is the sender's own session", async () => {
		const recorded: unknown[] = [];
		const wu = flusher();
		const res = await handleOpenPixel(await openToken(), fakeEnv(recorded), wu.waitUntil, {
			isOwnSession: async (mailbox) => mailbox === MAILBOX,
		});
		await wu.flush();
		expect(res.headers.get("Content-Type")).toBe("image/gif"); // still the pixel
		expect(recorded).toHaveLength(0);
	});

	it("still records a real recipient's open", async () => {
		const recorded: unknown[] = [];
		const wu = flusher();
		await handleOpenPixel(await openToken(), fakeEnv(recorded), wu.waitUntil, {
			isOwnSession: async () => false,
		});
		await wu.flush();
		expect(recorded).toHaveLength(1);
	});

	it("records the open when the session check itself fails", async () => {
		const recorded: unknown[] = [];
		const wu = flusher();
		await handleOpenPixel(await openToken(), fakeEnv(recorded), wu.waitUntil, {
			isOwnSession: async () => {
				throw new Error("AuthDO down");
			},
		});
		await wu.flush();
		expect(recorded).toHaveLength(1);
	});

	it("redirects but does not count the sender's own click", async () => {
		const recorded: unknown[] = [];
		const wu = flusher();
		const token = await signTrackingToken(
			{ mailboxId: MAILBOX, emailId: "e1", recipient: null, kind: "clicked", url: "https://tapetide.com" },
			SECRET,
		);
		const res = await handleClickRedirect(token, fakeEnv(recorded), wu.waitUntil, {
			isOwnSession: async () => true,
		});
		await wu.flush();
		expect(res.status).toBe(302);
		expect(recorded).toHaveLength(0);
	});

	describe("trackingRequestContext (session cookie → mailbox access)", () => {
		const sessionToken = "s".repeat(32);
		async function storeFor(email: string, valid = true): Promise<(env: Env) => AuthStoreApi> {
			const hash = await sha256Hex(sessionToken);
			const store = {
				validateSession: async (h: string) =>
					valid && h === hash
						? { user: { id: "u1", email, isOwner: false, disabled: false }, session: { id: "s1" } }
						: null,
			};
			return () => store as unknown as AuthStoreApi;
		}
		const request = (cookie?: string) =>
			new Request("https://mailer.tapetide.com/t/o/x", {
				headers: { ...(cookie ? { cookie } : {}), "user-agent": "Mozilla/5.0" },
			});

		it("no cookie: no check at all", async () => {
			const ctx = trackingRequestContext(request(), fakeEnv([]), await storeFor("owner@tapetide.com"));
			expect(ctx.isOwnSession).toBeUndefined();
		});

		it("a valid session for an admin of the mailbox is a self-open", async () => {
			const ctx = trackingRequestContext(
				request(`__Host-tt_session=${sessionToken}`),
				fakeEnv([]),
				await storeFor("owner@tapetide.com"),
			);
			expect(await ctx.isOwnSession!(MAILBOX)).toBe(true);
		});

		it("an expired or revoked session is not", async () => {
			const ctx = trackingRequestContext(
				request(`__Host-tt_session=${sessionToken}`),
				fakeEnv([]),
				await storeFor("owner@tapetide.com", false),
			);
			expect(await ctx.isOwnSession!(MAILBOX)).toBe(false);
		});

		it("a signed-in user without access to the mailbox is not", async () => {
			const env = fakeEnv([]);
			// No grants file in the bucket: a non-admin can reach nothing.
			const ctx = trackingRequestContext(
				request(`__Host-tt_session=${sessionToken}`),
				env,
				await storeFor("stranger@example.org"),
			);
			expect(await ctx.isOwnSession!(MAILBOX)).toBe(false);
		});
	});
});

describe("privacy-proxy flag", () => {
	it.each([
		["Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)", {}, "google"],
		["YahooMailProxy; https://help.yahoo.com/kb/yahoo-mail-proxy-SLN28749.html", {}, "yahoo"],
		["Mozilla/5.0", { asn: 714 }, "apple"],
		["Mozilla/5.0", { asOrganization: "Apple Inc." }, "apple"],
		["Mozilla/5.0 (Windows NT 10.0) Microsoft Office/16.0", {}, "microsoft"],
		["Mozilla/5.0", { asn: 8075 }, "microsoft"],
		["Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko)", { asn: 7922 }, null],
	] as const)("%s → %s", (ua, network, want) => {
		expect(classifyOpenProxy(ua, network)).toBe(want);
	});

	it("is recorded in the event metadata with the user agent", async () => {
		const recorded: { metadata: Record<string, unknown> | null }[] = [];
		const wu = flusher();
		await handleOpenPixel(await openToken(), fakeEnv(recorded as unknown[]), wu.waitUntil, {
			userAgent: "Mozilla/5.0 (via ggpht.com GoogleImageProxy)",
		});
		await wu.flush();
		expect(recorded[0].metadata).toEqual({
			ua: "Mozilla/5.0 (via ggpht.com GoogleImageProxy)",
			proxy: "google",
		});
	});

	it("truncates a long user agent and keeps click URLs", () => {
		const meta = engagementMetadata({ userAgent: "x".repeat(1000) }, { url: "https://a" });
		expect((meta!.ua as string).length).toBe(300);
		expect(meta!.url).toBe("https://a");
		expect(engagementMetadata(undefined)).toBeNull();
	});
});

describe("status wording", () => {
	const NOW = Date.parse("2026-10-26T12:00:00.000Z");

	it("picks the most advanced state, with failures winning", () => {
		expect(outboundState({ delivery_status: "queued" })).toBe("queued");
		expect(outboundState({ delivery_status: null })).toBe("sent");
		expect(outboundState({ delivery_status: "delivered" })).toBe("delivered");
		expect(outboundState({ delivery_status: "sent", open_count: 1 })).toBe("opened");
		expect(outboundState({ delivery_status: "delivered", open_count: 1, click_count: 1 })).toBe("clicked");
		expect(outboundState({ delivery_status: "bounced", open_count: 4 })).toBe("bounced");
	});

	it("says Opened with counts and recency, never Read", () => {
		const row = {
			delivery_status: "delivered",
			open_count: 3,
			last_opened_at: "2026-10-26T10:00:00.000Z",
			click_count: 1,
		};
		const text = outboundStatusDescription(row, NOW);
		expect(text).toBe("Delivered. Opened 3×, last 2h ago. Clicked 1 link.");
		expect(text).not.toMatch(/\bread\b/i);
		expect(outboundStatusLine(row, () => "10:00")).toBe(
			"Delivered · Opened 3× · clicked 1 link · last opened 10:00",
		);
	});

	it("hedges when every open came through a privacy proxy", () => {
		expect(
			outboundStatusDescription({ open_count: 1, open_proxy_count: 1, last_opened_at: "2026-10-26T11:59:30Z" }, NOW),
		).toContain("likely via a mail-privacy proxy");
	});

	it("MCP gets an engagement object on sent mail only, with the caveat", () => {
		const sent = compactEmail({
			id: "s",
			folder_id: "sent",
			delivery_status: "delivered",
			open_count: 2,
			opened_at: "2026-10-26T10:00:00.000Z",
			last_opened_at: "2026-10-26T11:00:00.000Z",
			click_count: 0,
		});
		expect(sent.engagement).toEqual({
			...engagementSummary({
				delivery_status: "delivered",
				open_count: 2,
				opened_at: "2026-10-26T10:00:00.000Z",
				last_opened_at: "2026-10-26T11:00:00.000Z",
			}),
			note: OPENED_CAVEAT,
		});
		expect((sent.engagement as { status: string }).status).toBe("opened");
		const inbound = compactEmail({ id: "i", folder_id: "inbox", open_count: 0 });
		expect(inbound.engagement).toBeUndefined();
	});
});
