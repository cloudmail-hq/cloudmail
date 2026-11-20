// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Suppression list: storage semantics, enforcement on every bulk path,
 * unsubscribe headers on sequence mail, the public `/u/` endpoint, bounce
 * auto-suppression and sequence stop-on-reply.
 *
 * The store runs on real SQLite (`node:sqlite`) through `AuthStore`, and the
 * R2 bucket is an in-memory map, so the assertions are about what actually
 * lands where.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	isAddressLevelBounce,
	isMailtoUnsubscribeRequest,
	isRecipientSuppressedError,
	normalizeSuppressionAddress,
	normalizeSuppressionScope,
	parseSuppressionCsv,
} from "../shared/suppressions";
import { dispatchDueSequenceEmails } from "../workers/lib/sequence-dispatch";
import { applySendCompliance } from "../workers/lib/send-compliance";
import { onInboundForCompliance } from "../workers/lib/inbound-compliance";
import {
	handleUnsubscribePage,
	handleUnsubscribePost,
} from "../workers/lib/unsubscribe-endpoint";
import { buildUnsubscribeLink } from "../workers/lib/suppressions";
import { reconcileDeliveryEvents } from "../workers/lib/email-reconciler";
import { signUnsubscribeToken } from "../shared/unsubscribe-token";
import { checkCsrf } from "../workers/lib/csrf";
import { AUTH_MIGRATION_NAMES } from "../workers/auth/store-core";
import type { Env } from "../workers/types";
import { authStoreBinding, fakeBucket } from "./helpers/suppression-store";

const SECRET = "unsubscribe-test-secret";
const nowSec = () => Math.floor(Date.now() / 1000);

function harness(options: { sendError?: Error & { code?: string } } = {}) {
	const bucket = fakeBucket();
	const { store, AUTH_STORE } = authStoreBinding();
	const sent: any[] = [];
	const deliveries: any[] = [];
	const stub = {
		createEmail: async () => {},
		recordDelivery: async (id: string, outcome: unknown) => {
			deliveries.push({ id, outcome });
		},
	};
	const env = {
		BUCKET: bucket,
		AUTH_STORE,
		UNSUBSCRIBE_SECRET: SECRET,
		APP_URL: "https://mailer.example.com",
		MAILBOX: { idFromName: (n: string) => n, get: () => stub },
		EMAIL: {
			send: async (message: unknown) => {
				if (options.sendError) throw options.sendError;
				sent.push(message);
				return { messageId: `msg-${sent.length}` };
			},
		},
	} as unknown as Env;
	return { env, bucket, store, sent, deliveries };
}

type H = ReturnType<typeof harness>;

function putSequence(h: H, opts: { enrollment?: Record<string, unknown> } = {}) {
	h.bucket.store.set(
		"templates/welcome.json",
		JSON.stringify({ id: "welcome", slug: "welcome", name: "w", subject: "Hi {{name}}", bodyHtml: "<p>Hello</p>", createdAt: 0, updatedAt: 0 }),
	);
	h.bucket.store.set(
		"sequence-enrollments/enr-1.json",
		JSON.stringify({
			id: "enr-1",
			sequenceId: "seq-1",
			personId: "p-1",
			personEmail: "reader@example.org",
			personName: "Reader",
			fromAddress: "hello@product.dev",
			status: "active",
			variables: {},
			enrolledAt: nowSec(),
			cancelledAt: null,
			...opts.enrollment,
		}),
	);
	for (const [id, offset] of [["step-1", -60], ["step-2", 3600]] as const) {
		h.bucket.store.set(
			`sequence-emails/${id}.json`,
			JSON.stringify({
				id,
				enrollmentId: "enr-1",
				stepOrder: id === "step-1" ? 1 : 2,
				templateSlug: "welcome",
				scheduledAt: nowSec() + offset,
				status: "pending",
				sentAt: null,
				sentEmailId: null,
			}),
		);
	}
}

const enrollmentStatus = (h: H) =>
	JSON.parse(h.bucket.store.get("sequence-enrollments/enr-1.json")!).status;
const stepStatus = (h: H, id: string) =>
	JSON.parse(h.bucket.store.get(`sequence-emails/${id}.json`)!).status;

beforeEach(() => {
	vi.restoreAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

// ── Pure helpers ───────────────────────────────────────────────────

describe("normalisation", () => {
	it("normalises addresses and scopes", () => {
		expect(normalizeSuppressionAddress(" Ada <ADA@Example.ORG> ")).toBe("ada@example.org");
		expect(normalizeSuppressionAddress("nope")).toBeNull();
		expect(normalizeSuppressionScope(undefined)).toBe("global");
		expect(normalizeSuppressionScope("")).toBe("global");
		expect(normalizeSuppressionScope("@Product.Dev")).toBe("product.dev");
		expect(normalizeSuppressionScope("not a domain")).toBeNull();
	});

	it("only treats address-level DSN codes as hard bounces", () => {
		expect(isAddressLevelBounce("5.1.1")).toBe(true);
		expect(isAddressLevelBounce("5.2.1")).toBe(true);
		// Policy rejections and full mailboxes are not "this address is dead".
		expect(isAddressLevelBounce("5.7.1")).toBe(false);
		expect(isAddressLevelBounce("5.2.2")).toBe(false);
		expect(isAddressLevelBounce("4.1.1")).toBe(false);
		expect(isAddressLevelBounce(null)).toBe(false);
	});

	it("recognises E_RECIPIENT_SUPPRESSED by code or message", () => {
		expect(isRecipientSuppressedError(Object.assign(new Error("x"), { code: "E_RECIPIENT_SUPPRESSED" }))).toBe(true);
		expect(isRecipientSuppressedError(new Error("send failed: E_RECIPIENT_SUPPRESSED"))).toBe(true);
		expect(isRecipientSuppressedError(new Error("E_RATE_LIMIT_EXCEEDED"))).toBe(false);
	});

	it("matches only an exact 'unsubscribe' subject for mailto requests", () => {
		expect(isMailtoUnsubscribeRequest(" Unsubscribe ")).toBe(true);
		expect(isMailtoUnsubscribeRequest("Re: please unsubscribe me")).toBe(false);
	});
});

describe("CSV import parsing", () => {
	it("accepts a bare list", () => {
		const { entries, errors } = parseSuppressionCsv("a@x.com\nB@X.com\n\n# comment\n");
		expect(entries.map((e) => e.address)).toEqual(["a@x.com", "b@x.com"]);
		expect(entries.every((e) => e.scope === "global" && e.reason === "manual")).toBe(true);
		expect(errors).toEqual([]);
	});

	it("reads a header row with email/scope/reason columns", () => {
		const csv = 'reason,email,scope\nunsubscribed,"a@x.com",product.dev\nhard_bounce,b@x.com,\n';
		const { entries } = parseSuppressionCsv(csv);
		expect(entries).toEqual([
			{ address: "a@x.com", scope: "product.dev", reason: "unsubscribed", source: "csv" },
			{ address: "b@x.com", scope: "global", reason: "hard_bounce", source: "csv" },
		]);
	});

	it("reports bad rows by line and keeps the good ones", () => {
		const { entries, errors } = parseSuppressionCsv("address,scope,reason\nok@x.com\nnope\nc@x.com,bad scope\nd@x.com,,spam\nok@x.com\n");
		expect(entries.map((e) => e.address)).toEqual(["ok@x.com"]);
		expect(errors.map((e) => e.line)).toEqual([3, 4, 5]);
	});
});

// ── Store ──────────────────────────────────────────────────────────

describe("AuthStore suppressions", () => {
	it("registers the migration", () => {
		expect(AUTH_MIGRATION_NAMES).toContain("0008_suppressions");
		const at = AUTH_MIGRATION_NAMES.indexOf("0008_suppressions");
		expect(AUTH_MIGRATION_NAMES[at + 1]).toBe("0009_idempotency_keys");
	});

	it("is unique per address and scope, and idempotent", async () => {
		const { store } = harness();
		const first = await store.addSuppressions(
			[
				{ address: "a@x.com", scope: "global", reason: "manual", source: "t" },
				{ address: "a@x.com", scope: "product.dev", reason: "unsubscribed", source: "t" },
			],
			1,
		);
		expect(first.added).toBe(2);
		const again = await store.addSuppressions([{ address: "a@x.com", scope: "global", reason: "hard_bounce", source: "t" }], 2);
		expect(again).toMatchObject({ added: 0, existing: 1 });
		// The original reason is kept.
		expect(again.items[0].reason).toBe("manual");
	});

	it("matches global entries and the sending domain's own entries only", async () => {
		const { store } = harness();
		await store.addSuppressions(
			[
				{ address: "a@x.com", scope: "product.dev", reason: "unsubscribed", source: "t" },
				{ address: "b@x.com", scope: "global", reason: "hard_bounce", source: "t" },
			],
			1,
		);
		const fromProduct = await store.findSuppressions(["a@x.com", "b@x.com"], "product.dev");
		expect(fromProduct.map((r) => r.address).sort()).toEqual(["a@x.com", "b@x.com"]);
		const fromOther = await store.findSuppressions(["a@x.com", "b@x.com"], "other.app");
		expect(fromOther.map((r) => r.address)).toEqual(["b@x.com"]);
	});

	it("searches and paginates, escaping LIKE wildcards", async () => {
		const { store } = harness();
		await store.addSuppressions(
			Array.from({ length: 30 }, (_, i) => ({ address: `user${i}@x.com`, scope: "global", reason: "manual", source: "t" })),
			1,
		);
		await store.addSuppressions([{ address: "under_score@x.com", scope: "global", reason: "manual", source: "t" }], 2);
		const page = await store.listSuppressions({ limit: 10, offset: 0 });
		expect(page.total).toBe(31);
		expect(page.items).toHaveLength(10);
		expect((await store.listSuppressions({ query: "user1" })).total).toBe(11);
		// `_` would match any character if unescaped.
		expect((await store.listSuppressions({ query: "r_s" })).total).toBe(1);
	});

	it("deletes by id", async () => {
		const { store } = harness();
		const { items } = await store.addSuppressions([{ address: "a@x.com", scope: "global", reason: "manual", source: "t" }], 1);
		expect(await store.deleteSuppression(items[0].id)).toBe(true);
		expect(await store.deleteSuppression(items[0].id)).toBe(false);
	});
});

// ── Enforcement ────────────────────────────────────────────────────

describe("sequence dispatch enforcement", () => {
	it("adds RFC 8058 headers and a footer to sequence mail", async () => {
		const h = harness();
		putSequence(h);
		await dispatchDueSequenceEmails(h.env);
		expect(h.sent).toHaveLength(1);
		const headers = h.sent[0].headers;
		expect(headers["List-Unsubscribe"]).toMatch(
			/^<https:\/\/mailer\.example\.com\/u\/[\w-]+\.[\w-]+>, <mailto:hello@product\.dev\?subject=unsubscribe>$/,
		);
		expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
		expect(h.sent[0].html).toContain("Unsubscribe</a>");
	});

	it("fills {{unsubscribe_url}} with the signed link even if a variable tries to override it", async () => {
		const h = harness();
		putSequence(h, { enrollment: { variables: { unsubscribe_url: "https://evil.example/" } } });
		h.bucket.store.set(
			"templates/welcome.json",
			JSON.stringify({ id: "welcome", slug: "welcome", name: "w", subject: "Hi", bodyHtml: '<a href="{{unsubscribe_url}}">out</a>', createdAt: 0, updatedAt: 0 }),
		);
		await dispatchDueSequenceEmails(h.env);
		expect(h.sent[0].html).not.toContain("evil.example");
		expect(h.sent[0].html).toMatch(/href="https:\/\/mailer\.example\.com\/u\/[\w-]+\.[\w-]+"/);
	});

	it("does not send to a suppressed recipient and stops the enrollment", async () => {
		const h = harness();
		putSequence(h);
		await h.store.addSuppressions([{ address: "reader@example.org", scope: "product.dev", reason: "unsubscribed", source: "t" }], 1);
		const result = await dispatchDueSequenceEmails(h.env);
		expect(result).toMatchObject({ sent: 0, suppressed: 1 });
		expect(h.sent).toHaveLength(0);
		expect(enrollmentStatus(h)).toBe("cancelled");
		expect(stepStatus(h, "step-2")).toBe("cancelled");
	});

	it("ignores a suppression scoped to a different sending domain", async () => {
		const h = harness();
		putSequence(h);
		await h.store.addSuppressions([{ address: "reader@example.org", scope: "other.app", reason: "unsubscribed", source: "t" }], 1);
		expect((await dispatchDueSequenceEmails(h.env)).sent).toBe(1);
	});

	it("handles E_RECIPIENT_SUPPRESSED by suppressing locally instead of retrying", async () => {
		const err = Object.assign(new Error("recipient suppressed"), { code: "E_RECIPIENT_SUPPRESSED" });
		const h = harness({ sendError: err });
		putSequence(h);
		const result = await dispatchDueSequenceEmails(h.env);
		expect(result).toMatchObject({ suppressed: 1, failed: 0 });
		const hits = await h.store.findSuppressions(["reader@example.org"]);
		expect(hits).toMatchObject([{ scope: "global", reason: "hard_bounce" }]);
		expect(enrollmentStatus(h)).toBe("cancelled");
		expect(h.deliveries[0].outcome.error).toContain("E_RECIPIENT_SUPPRESSED");
	});
});

describe("non-transactional API send compliance", () => {
	it("drops suppressed recipients and reports them", async () => {
		const h = harness();
		await h.store.addSuppressions([{ address: "gone@x.com", scope: "global", reason: "hard_bounce", source: "t" }], 1);
		const result = await applySendCompliance(h.env, {
			to: ["ok@x.com", "Gone@X.com"],
			cc: "gone@x.com",
			fromEmail: "hello@product.dev",
			html: "<p>hi</p>",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.to).toEqual(["ok@x.com"]);
		expect(result.cc).toEqual([]);
		expect(result.suppressed).toEqual([{ address: "gone@x.com", reason: "hard_bounce", scope: "global" }]);
		// One recipient left, so it gets a personal unsubscribe link.
		expect(result.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
	});

	it("refuses when every To recipient is suppressed", async () => {
		const h = harness();
		await h.store.addSuppressions([{ address: "gone@x.com", scope: "global", reason: "hard_bounce", source: "t" }], 1);
		const result = await applySendCompliance(h.env, { to: "gone@x.com", fromEmail: "hello@product.dev", text: "hi" });
		expect(result.ok).toBe(false);
	});

	it("omits the per-person header on a multi-recipient send", async () => {
		const h = harness();
		const result = await applySendCompliance(h.env, { to: ["a@x.com", "b@x.com"], fromEmail: "hello@product.dev", text: "hi" });
		// No per-person unsubscribe header, but the stream's List-Id.
		expect(result.ok && result.headers).toEqual({ "List-Id": "<api.product.dev>" });
	});
});

// ── Unsubscribe endpoint ───────────────────────────────────────────

describe("/u/:token", () => {
	async function tokenFor(h: H) {
		const link = await buildUnsubscribeLink(h.env, { recipient: "reader@example.org", fromAddress: "hello@product.dev" });
		return link!.url.split("/u/")[1];
	}

	it("GET shows a confirmation page and records nothing", async () => {
		const h = harness();
		const res = await handleUnsubscribePage(await tokenFor(h), h.env);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('<form method="post">');
		expect((await h.store.listSuppressions()).total).toBe(0);
	});

	it("POST suppresses for the sending domain and stops that domain's sequences", async () => {
		const h = harness();
		putSequence(h);
		const pending: Promise<unknown>[] = [];
		const res = await handleUnsubscribePost(await tokenFor(h), h.env, (p) => pending.push(p));
		await Promise.all(pending);
		expect(res.status).toBe(200);
		const rows = (await h.store.listSuppressions()).items;
		expect(rows).toMatchObject([
			{ address: "reader@example.org", scope: "product.dev", reason: "unsubscribed", source: "unsubscribe-link:hello@product.dev" },
		]);
		expect(enrollmentStatus(h)).toBe("cancelled");
	});

	it("the page offers the tracking opt-out, unticked", async () => {
		const h = harness();
		const html = await (await handleUnsubscribePage(await tokenFor(h), h.env)).text();
		expect(html).toContain('name="stop_tracking" value="1"');
		expect(html).not.toMatch(/stop_tracking[^>]*checked/);
		expect(html).toContain('href="/privacy"');
	});

	it("a ticked box records a per-recipient no-track flag for the sending domain", async () => {
		const h = harness();
		const req = new Request("https://mailer.example.com/u/x", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "stop_tracking=1",
		});
		const res = await handleUnsubscribePost(await tokenFor(h), h.env, () => {}, undefined, req);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("will no longer be tracked");
		expect(await h.store.findTrackingOptOuts(["reader@example.org"], "product.dev")).toHaveLength(1);
		expect(await h.store.findTrackingOptOuts(["reader@example.org"], "other.dev")).toHaveLength(0);
	});

	it("an RFC 8058 one-click POST unsubscribes but never opts out of tracking", async () => {
		const h = harness();
		const req = new Request("https://mailer.example.com/u/x", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "List-Unsubscribe=One-Click",
		});
		await handleUnsubscribePost(await tokenFor(h), h.env, () => {}, undefined, req);
		expect((await h.store.listSuppressions()).total).toBe(1);
		expect(await h.store.findTrackingOptOuts(["reader@example.org"], "product.dev")).toHaveLength(0);
	});

	it("rejects a forged token with a uniform page", async () => {
		const h = harness();
		const forged = await signUnsubscribeToken({ address: "victim@x.com", domain: "product.dev", mailbox: "m@product.dev" }, "wrong");
		const res = await handleUnsubscribePost(forged, h.env, () => {});
		expect(res.status).toBe(400);
		expect((await h.store.listSuppressions()).total).toBe(0);
	});

	it("is exempt from the CSRF guard so RFC 8058 one-click POSTs work", () => {
		const crossSite = (path: string) =>
			checkCsrf({
				method: "POST",
				url: `https://mailer.example.com${path}`,
				headers: new Headers({ "sec-fetch-site": "cross-site", origin: "https://mail.google.com" }),
			});
		expect(crossSite("/u/abc.def").allowed).toBe(true);
		// Nothing else rides the exemption.
		expect(crossSite("/u/abc.def/extra").allowed).toBe(false);
		expect(crossSite("/api/v1/suppressions").allowed).toBe(false);
	});
});

// ── Bounces and replies ────────────────────────────────────────────

describe("inbound compliance", () => {
	const noHeaders = () => undefined;

	it("suppresses globally on an address-level DSN for mail we sent", async () => {
		const h = harness();
		putSequence(h);
		const outcome = await onInboundForCompliance(h.env, {
			mailboxId: "hello@product.dev",
			sender: "mailer-daemon@example.org",
			subject: "Undelivered",
			header: noHeaders,
			bounce: { status: "5.1.1", recipient: "reader@example.org", matchedSentRow: true },
		});
		expect(outcome).toBe("hard_bounce");
		expect(await h.store.findSuppressions(["reader@example.org"])).toMatchObject([{ scope: "global", reason: "hard_bounce" }]);
		expect(enrollmentStatus(h)).toBe("cancelled");
	});

	it("ignores a bounce that matches no Sent row, or is a policy rejection", async () => {
		const h = harness();
		for (const bounce of [
			{ status: "5.1.1", recipient: "victim@example.org", matchedSentRow: false },
			{ status: "5.7.1", recipient: "reader@example.org", matchedSentRow: true },
		]) {
			await onInboundForCompliance(h.env, { mailboxId: "hello@product.dev", sender: "mailer-daemon@x", subject: "", header: noHeaders, bounce });
		}
		expect((await h.store.listSuppressions()).total).toBe(0);
	});

	it("stops the sequence when the enrolled person replies to the same mailbox", async () => {
		const h = harness();
		putSequence(h);
		const outcome = await onInboundForCompliance(h.env, {
			mailboxId: "hello@product.dev",
			sender: "Reader@Example.org",
			subject: "Re: Hi",
			header: noHeaders,
		});
		expect(outcome).toBe("stopped_sequence");
		expect(enrollmentStatus(h)).toBe("cancelled");
		expect(stepStatus(h, "step-2")).toBe("cancelled");
		// A reply is not an unsubscribe.
		expect((await h.store.listSuppressions()).total).toBe(0);
	});

	it("does not stop on a reply to a different mailbox", async () => {
		const h = harness();
		putSequence(h);
		await onInboundForCompliance(h.env, { mailboxId: "support@product.dev", sender: "reader@example.org", subject: "Q", header: noHeaders });
		expect(enrollmentStatus(h)).toBe("active");
	});

	it("does not stop on an out-of-office auto-reply", async () => {
		const h = harness();
		putSequence(h);
		await onInboundForCompliance(h.env, {
			mailboxId: "hello@product.dev",
			sender: "reader@example.org",
			subject: "Out of office",
			header: (name) => (name === "auto-submitted" ? "auto-replied" : undefined),
		});
		expect(enrollmentStatus(h)).toBe("active");
	});

	it("ignores a mailto unsubscribe whose sender is not authenticated", async () => {
		// A forged From would otherwise suppress any address an attacker names.
		const h = harness();
		putSequence(h);
		for (const senderAuthenticated of [undefined, false]) {
			const outcome = await onInboundForCompliance(h.env, {
				mailboxId: "hello@product.dev",
				sender: "victim@example.org",
				subject: "unsubscribe",
				header: noHeaders,
				senderAuthenticated,
			});
			expect(outcome).toBe("none");
		}
		expect((await h.store.listSuppressions()).total).toBe(0);
	});

	it("treats an authenticated mailto unsubscribe as an unsubscribe for the sending domain", async () => {
		const h = harness();
		putSequence(h);
		const outcome = await onInboundForCompliance(h.env, {
			mailboxId: "hello@product.dev",
			sender: "reader@example.org",
			subject: "unsubscribe",
			header: noHeaders,
			senderAuthenticated: true,
		});
		expect(outcome).toBe("unsubscribed");
		expect(await h.store.findSuppressions(["reader@example.org"])).toMatchObject([{ scope: "product.dev", reason: "unsubscribed" }]);
		expect(enrollmentStatus(h)).toBe("cancelled");
	});
});

describe("delivery reconciler hard bounces", () => {
	it("reports address-level provider bounces once per recipient", async () => {
		const events = [
			{ status: "deliveryFailed", errorCause: "user_unknown", to: "dead@x.com" },
			{ status: "deliveryFailed", errorCause: "user_unknown", to: "dead@x.com" },
			{ status: "deliveryFailed", errorCause: "mailbox_full", to: "full@x.com" },
			{ status: "delivered", errorCause: "", to: "ok@x.com" },
		].map((e, i) => ({
			datetime: "2026-10-25T00:00:00Z",
			messageId: `<m${i}@x>`,
			from: "hello@product.dev",
			eventType: "",
			sendingDomain: "product.dev",
			errorDetail: "",
			...e,
		}));
		const fetchImpl = (async () =>
			new Response(JSON.stringify({ data: { viewer: { zones: [{ emailSendingAdaptive: events }] } } }), {
				headers: { "Content-Type": "application/json" },
			})) as unknown as typeof fetch;
		const bounced: string[] = [];
		const result = await reconcileDeliveryEvents(
			{ apiToken: "t", zoneTag: "z" },
			() => ({ reconcileProviderEvents: async () => ({ applied: 0 }) }),
			{ fetchImpl, onHardBounce: async (address) => { bounced.push(address); } },
		);
		expect(bounced).toEqual(["dead@x.com"]);
		expect(result.hardBounces).toBe(1);
	});
});
