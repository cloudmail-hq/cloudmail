// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * List headers on bulk mail, and the unsubscribe processing SLA.
 *
 * - `List-Id: <slug.domain>` (RFC 2919) on sequence and template sends, so
 *   Gmail can group feedback per stream; RFC 8058 one-click on every bulk path.
 * - Gmail and Yahoo require unsubscribes to take effect within 48 hours. Ours
 *   take effect at once: the one-click POST writes the suppression before it
 *   answers, needs no session or CSRF token, and the next send is refused.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildListId, bulkCompliance } from "../workers/lib/send-compliance";
import { dispatchDueSequenceEmails } from "../workers/lib/sequence-dispatch";
import { handleUnsubscribePost } from "../workers/lib/unsubscribe-endpoint";
import { buildUnsubscribeLink } from "../workers/lib/suppressions";
import { checkCsrf } from "../workers/lib/csrf";
import { preSend } from "../workers/lib/pre-send";
import { authStoreBinding, fakeBucket } from "./helpers/suppression-store";
import type { Env } from "../workers/types";

beforeEach(() => {
	vi.restoreAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("List-Id", () => {
	it("is <slug.domain>, with a slug safe for RFC 2919", () => {
		expect(buildListId("welcome", "hello@product.dev")).toBe("<welcome.product.dev>");
		expect(buildListId("Onboarding Drip #2", "hello@product.dev", "Onboarding")).toBe('"Onboarding" <onboarding-drip-2.product.dev>');
		expect(buildListId("x", "not-an-address")).toBeNull();
	});

	it("comes with the one-click pair from bulkCompliance", async () => {
		const { AUTH_STORE } = authStoreBinding();
		const env = { AUTH_STORE, UNSUBSCRIBE_SECRET: "s", APP_URL: "https://mailer.example.com" } as unknown as Env;
		const out = await bulkCompliance(env, { recipient: "r@x.com", fromAddress: "hello@product.dev", listSlug: "welcome", html: "<p>Hi</p>" });
		expect(out.headers).toMatchObject({
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
			"List-Id": "<welcome.product.dev>",
		});
		expect(out.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/mailer\.example\.com\/u\//);
		expect(out.html).toContain("Unsubscribe");
	});

	it("is on every sequence step", async () => {
		const { AUTH_STORE } = authStoreBinding();
		const bucket = fakeBucket();
		const now = Math.floor(Date.now() / 1000);
		bucket.store.set("sequences/seq-1.json", JSON.stringify({ id: "seq-1", name: "Onboarding", steps: [], createdAt: 0, updatedAt: 0 }));
		bucket.store.set("templates/welcome.json", JSON.stringify({ id: "w", slug: "welcome", name: "w", subject: "Hi", bodyHtml: "<p>Hello</p>", createdAt: 0, updatedAt: 0 }));
		bucket.store.set("sequence-enrollments/enr-1.json", JSON.stringify({ id: "enr-1", sequenceId: "seq-1", personId: "p", personEmail: "reader@example.org", personName: null, fromAddress: "hello@product.dev", status: "active", variables: {}, enrolledAt: now, cancelledAt: null }));
		bucket.store.set("sequence-emails/s1.json", JSON.stringify({ id: "s1", enrollmentId: "enr-1", stepOrder: 1, templateSlug: "welcome", scheduledAt: now - 60, status: "pending", sentAt: null, sentEmailId: null }));
		const sent: any[] = [];
		const env = {
			AUTH_STORE,
			BUCKET: bucket,
			UNSUBSCRIBE_SECRET: "s",
			APP_URL: "https://mailer.example.com",
			MAILBOX: { idFromName: (n: string) => n, get: () => ({ checkSendRateLimit: async () => null, createEmail: async () => {}, recordDelivery: async () => {} }) },
			EMAIL: { send: async (m: unknown) => (sent.push(m), { messageId: "p" }) },
		} as unknown as Env;
		expect((await dispatchDueSequenceEmails(env)).sent).toBe(1);
		expect(sent[0].headers["List-Id"]).toBe('"Onboarding" <onboarding.product.dev>');
		expect(sent[0].headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
	});

	it("template-sends (REST) build List-Id and one-click through bulkCompliance", () => {
		const route = readFileSync(join(__dirname, "../workers/routes/suppressions.ts"), "utf8");
		expect(route).toMatch(/bulkCompliance\(c\.env, \{[\s\S]*?listSlug: template\.slug/);
	});
});

describe("unsubscribe SLA: immediate, unauthenticated, 200", () => {
	it("Gmail's cross-site one-click POST passes the CSRF guard", () => {
		const headers = new Headers({
			"content-type": "application/x-www-form-urlencoded",
			"sec-fetch-site": "cross-site",
			origin: "https://mail.google.com",
		});
		expect(checkCsrf({ method: "POST", headers, url: "https://mailer.example.com/u/abc.def" }).allowed).toBe(true);
	});

	it("/u/:token is mounted before the auth gate", () => {
		const app = readFileSync(join(__dirname, "../workers/app.ts"), "utf8");
		const route = app.indexOf('app.post("/u/:token"');
		const gate = app.indexOf("createAuthGate(authDeps)");
		expect(route).toBeGreaterThan(-1);
		expect(gate).toBeGreaterThan(route);
	});

	it("answers 200 after the suppression is written, and the next bulk send is refused", async () => {
		const { store, AUTH_STORE } = authStoreBinding();
		const env = { AUTH_STORE, BUCKET: fakeBucket(), UNSUBSCRIBE_SECRET: "s", APP_URL: "https://mailer.example.com" } as unknown as Env;
		const link = await buildUnsubscribeLink(env, { recipient: "reader@example.org", fromAddress: "hello@product.dev" });
		const token = link!.url.split("/u/")[1];

		const started = Date.now();
		const res = await handleUnsubscribePost(token, env, () => {});
		expect(res.status).toBe(200);
		expect(Date.now() - started).toBeLessThan(1000);
		expect(await store.findSuppressions(["reader@example.org"], "product.dev")).toHaveLength(1);

		const next = await preSend(env, { kind: "bulk", from: "hello@product.dev", mailboxId: "hello@product.dev", to: "reader@example.org" }, { quota: () => ({ checkSendRateLimit: async () => null }) });
		expect(next).toMatchObject({ ok: false, code: "all_suppressed" });
	});
});
