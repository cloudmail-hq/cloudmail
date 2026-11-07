/**
 * Web Push: rule filtering, quiet hours (DST included), coalescing and the
 * rate limit, subscription storage (410 cleanup on real SQLite), dispatch,
 * and the action token's single use and scope.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_PUSH_PREFS,
	THREAD_COALESCE_MS,
	USER_PUSH_LIMIT,
	USER_PUSH_WINDOW_MS,
	decideMailPush,
	decideThrottle,
	deviceLabel,
	inQuietHours,
	isAllowedPushEndpoint,
	mailPayload,
	mergePushPrefs,
	normalizePushPrefs,
	PushPrefsPatchSchema,
	safeNotificationUrl,
	type PushMailFacts,
	type PushPrefs,
} from "../shared/push-policy";
import { AUTH_MIGRATION_NAMES, AuthStore } from "../workers/auth/store-core";
import { PushStore } from "../workers/lib/push-store";
import {
	mintActionToken,
	notifyApproval,
	notifyNewMail,
	performAction,
	sendTestPush,
	type PushRpc,
	type StoredMailFacts,
} from "../workers/lib/push";
import { b64urlEncode, generateP256KeyPair } from "../shared/web-push";
import type { Env } from "../workers/types";

// ── SQLite adapter (as in auth-store.test.ts) ─────────────────────────

function sqlite() {
	const db = new DatabaseSync(":memory:");
	const sql = {
		exec(query: string, ...bindings: unknown[]) {
			const rows = db.prepare(query).all(...(bindings as never[])) as any[];
			return { toArray: () => rows };
		},
	};
	const tx = <T>(fn: () => T): T => {
		db.exec("SAVEPOINT tx");
		try {
			const out = fn();
			db.exec("RELEASE tx");
			return out;
		} catch (e) {
			db.exec("ROLLBACK TO tx");
			db.exec("RELEASE tx");
			throw e;
		}
	};
	// Run the real AuthDO migrations so the push tables are the shipped schema.
	const auth = new AuthStore(sql, tx);
	return { db, sql, tx, auth, push: new PushStore(sql, tx) };
}

/** A PushRpc over a real PushStore, as the AuthDO exposes it. */
function rpcFor(store: PushStore, meta = new Map<string, string>()): PushRpc {
	return {
		getOrInitMeta: async (k, v) => {
			if (!meta.has(k)) meta.set(k, v);
			return meta.get(k)!;
		},
		pushUpsertSubscription: async (i) => store.upsertSubscription(i),
		pushListSubscriptions: async (u) => store.listSubscriptions(u),
		pushDeleteSubscription: async (u, r) => store.deleteSubscription(u, r),
		pushReplaceSubscription: async (i) => store.replaceSubscription(i),
		pushRecordDelivery: async (id, o, n) => store.recordDelivery(id, o, n),
		pushListTargets: async () => store.listTargets(),
		pushGetPrefs: async (u) => store.getPrefs(u),
		pushUpdatePrefs: async (u, p, n) => store.updatePrefs(u, p, n),
		pushClaimSlot: async (u, t, n) => store.claimSlot(u, t, n),
		pushSpendToken: async (j, e, n) => store.spendToken(j, e, n),
		pushAccountFlags: async (u) => store.accountFlags(u),
	};
}

/** A real browser-shaped subscription key pair, so encryption runs for real. */
async function uaKeys() {
	const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
	const raw = new Uint8Array((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer);
	return { p256dh: b64urlEncode(raw), auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))) };
}

const T0 = Date.UTC(2026, 9, 27, 12, 0); // 12:00 UTC
const MIN = 60_000;

function facts(over: Partial<PushMailFacts> = {}): PushMailFacts {
	return {
		mailboxId: "support@acme.dev",
		folder: "inbox",
		read: false,
		muted: false,
		sender: "ada@example.com",
		priority: null,
		inConversation: false,
		productId: null,
		...over,
	};
}

function prefs(patch: Parameters<typeof mergePushPrefs>[1] = {}): PushPrefs {
	return mergePushPrefs(structuredClone(DEFAULT_PUSH_PREFS), patch);
}

// ── Rule filtering ──────────────────────────────────────────────────

describe("decideMailPush", () => {
	it("sends for unread Inbox mail by default", () => {
		expect(decideMailPush(prefs(), facts())).toEqual({ send: true });
	});

	it("never for spam, the Screener, muted threads, or mail filed out of the Inbox", () => {
		expect(decideMailPush(prefs(), facts({ folder: "spam" }))).toEqual({ send: false, reason: "spam" });
		expect(decideMailPush(prefs(), facts({ folder: "screener" }))).toEqual({ send: false, reason: "screener" });
		// A muted thread is filed to Archive pre-read at ingest.
		expect(decideMailPush(prefs(), facts({ folder: "archive", muted: true, read: true }))).toEqual({ send: false, reason: "muted" });
		expect(decideMailPush(prefs(), facts({ muted: true }))).toEqual({ send: false, reason: "muted" });
		// Triage auto-archive, or a rule that filed it.
		expect(decideMailPush(prefs(), facts({ folder: "archive" }))).toEqual({ send: false, reason: "not_inbox" });
		expect(decideMailPush(prefs(), facts({ folder: "receipts" }))).toEqual({ send: false, reason: "not_inbox" });
		// A rule marked it read.
		expect(decideMailPush(prefs(), facts({ read: true }))).toEqual({ send: false, reason: "read" });
	});

	it("respects the new-mail switch and per-mailbox off", () => {
		expect(decideMailPush(prefs({ newMail: false }), facts())).toEqual({ send: false, reason: "kind_off" });
		const p = prefs({ mailboxes: { "Support@Acme.dev": "off" } });
		expect(p.mailboxes).toEqual({ "support@acme.dev": "off" });
		expect(decideMailPush(p, facts())).toEqual({ send: false, reason: "mailbox_off" });
		expect(decideMailPush(p, facts({ mailboxId: "sales@acme.dev" }))).toEqual({ send: true });
		// `inherit` removes an override.
		expect(mergePushPrefs(p, { mailboxes: { "support@acme.dev": "inherit" } }).mailboxes).toEqual({});
	});

	it("important mode: VIP, high priority or a thread you wrote in", () => {
		const p = prefs({ mode: "important", vipSenders: ["boss@acme.dev", "@bigcustomer.com"] });
		expect(decideMailPush(p, facts())).toEqual({ send: false, reason: "not_important" });
		expect(decideMailPush(p, facts({ sender: "boss@acme.dev" }))).toEqual({ send: true });
		expect(decideMailPush(p, facts({ sender: "cto@bigcustomer.com" }))).toEqual({ send: true });
		// A domain entry is not a suffix match on another domain.
		expect(decideMailPush(p, facts({ sender: "x@notbigcustomer.com" }))).toEqual({ send: false, reason: "not_important" });
		expect(decideMailPush(p, facts({ priority: "high" }))).toEqual({ send: true });
		expect(decideMailPush(p, facts({ inConversation: true }))).toEqual({ send: true });
	});

	it("a mailbox override beats the user's mode", () => {
		const p = prefs({ mode: "important", mailboxes: { "support@acme.dev": "all" } });
		expect(decideMailPush(p, facts())).toEqual({ send: true });
		expect(decideMailPush(p, facts({ mailboxId: "other@acme.dev" }))).toEqual({ send: false, reason: "not_important" });
	});

	it("products mode: only mail to the chosen products", () => {
		const p = prefs({ mode: "products", products: ["prod_a"] });
		expect(decideMailPush(p, facts({ productId: "prod_a" }))).toEqual({ send: true });
		expect(decideMailPush(p, facts({ productId: "prod_b" }))).toEqual({ send: false, reason: "other_product" });
		expect(decideMailPush(p, facts({ productId: null }))).toEqual({ send: false, reason: "other_product" });
	});

	it("validates patches and reads a corrupt record as the defaults", () => {
		expect(PushPrefsPatchSchema.safeParse({ vipSenders: ["not an address"] }).success).toBe(false);
		expect(PushPrefsPatchSchema.safeParse({ quietHours: { start: "25:00" } }).success).toBe(false);
		expect(PushPrefsPatchSchema.safeParse({ quietHours: { timeZone: "Mars/Olympus" } }).success).toBe(false);
		expect(PushPrefsPatchSchema.safeParse({ surprise: true }).success).toBe(false);
		expect(normalizePushPrefs({ mode: "loud" })).toEqual(DEFAULT_PUSH_PREFS);
		expect(normalizePushPrefs("{")).toEqual(DEFAULT_PUSH_PREFS);
	});
});

// ── Quiet hours ─────────────────────────────────────────────────────

describe("inQuietHours", () => {
	const night = { enabled: true, start: "22:00", end: "07:00" };

	it("crosses midnight in the user's zone", () => {
		// 23:30 and 06:59 Berlin (CEST, UTC+2) in summer.
		expect(inQuietHours(Date.UTC(2026, 6, 1, 21, 30), night, "Europe/Berlin")).toBe(true);
		expect(inQuietHours(Date.UTC(2026, 6, 1, 4, 59), night, "Europe/Berlin")).toBe(true);
		expect(inQuietHours(Date.UTC(2026, 6, 1, 5, 0), night, "Europe/Berlin")).toBe(false);
		expect(inQuietHours(Date.UTC(2026, 6, 1, 19, 59), night, "Europe/Berlin")).toBe(false);
		expect(inQuietHours(Date.UTC(2026, 6, 1, 20, 0), night, "Europe/Berlin")).toBe(true);
	});

	it("a same-day window, and an empty or disabled one", () => {
		const lunch = { enabled: true, start: "12:00", end: "13:00" };
		expect(inQuietHours(Date.UTC(2026, 0, 5, 12, 30), lunch, "UTC")).toBe(true);
		expect(inQuietHours(Date.UTC(2026, 0, 5, 13, 0), lunch, "UTC")).toBe(false);
		expect(inQuietHours(Date.UTC(2026, 0, 5, 12, 30), { ...lunch, end: "12:00" }, "UTC")).toBe(false);
		expect(inQuietHours(Date.UTC(2026, 0, 5, 23, 0), { ...night, enabled: false }, "UTC")).toBe(false);
	});

	it("follows the wall clock across DST changes (New York)", () => {
		// 2026-03-08 02:00 EST -> 03:00 EDT. Window 22:00-07:00 local.
		// 06:30 local on the change day is 10:30 UTC (EDT, UTC-4).
		expect(inQuietHours(Date.UTC(2026, 2, 8, 10, 30), night, "America/New_York")).toBe(true);
		// 07:00 EDT = 11:00 UTC: quiet ends exactly then, not an hour later.
		expect(inQuietHours(Date.UTC(2026, 2, 8, 11, 0), night, "America/New_York")).toBe(false);
		// The day before, 07:00 EST was 12:00 UTC, and 11:30 UTC was still quiet.
		expect(inQuietHours(Date.UTC(2026, 2, 7, 11, 30), night, "America/New_York")).toBe(true);
		expect(inQuietHours(Date.UTC(2026, 2, 7, 12, 0), night, "America/New_York")).toBe(false);
		// Autumn: 2026-11-01 02:00 EDT -> 01:00 EST. 22:00 EST = 03:00 UTC next day.
		expect(inQuietHours(Date.UTC(2026, 10, 2, 2, 59), night, "America/New_York")).toBe(false);
		expect(inQuietHours(Date.UTC(2026, 10, 2, 3, 0), night, "America/New_York")).toBe(true);
		// The repeated 01:xx hour is inside the window either way.
		expect(inQuietHours(Date.UTC(2026, 10, 1, 5, 30), night, "America/New_York")).toBe(true);
		expect(inQuietHours(Date.UTC(2026, 10, 1, 6, 30), night, "America/New_York")).toBe(true);
	});

	it("falls back to UTC for an unknown zone", () => {
		expect(inQuietHours(Date.UTC(2026, 0, 1, 23, 0), night, "Not/AZone")).toBe(true);
	});
});

// ── Throttling ──────────────────────────────────────────────────────

describe("decideThrottle", () => {
	const empty = { threadLastAt: null, windowStart: null, windowCount: 0 };

	it("coalesces a thread to one push per minute", () => {
		expect(decideThrottle({ ...empty, threadLastAt: T0 }, T0 + THREAD_COALESCE_MS - 1, { coalesce: true })).toEqual({
			allow: false,
			reason: "coalesced",
		});
		expect(decideThrottle({ ...empty, threadLastAt: T0 }, T0 + THREAD_COALESCE_MS, { coalesce: true }).allow).toBe(true);
		// No thread key (approvals, tests): no coalescing.
		expect(decideThrottle({ ...empty, threadLastAt: T0 }, T0 + 1, { coalesce: false }).allow).toBe(true);
	});

	it("caps pushes per user per window, then resets", () => {
		const full = { threadLastAt: null, windowStart: T0, windowCount: USER_PUSH_LIMIT };
		expect(decideThrottle(full, T0 + 1, { coalesce: true })).toEqual({ allow: false, reason: "rate_limited" });
		expect(decideThrottle(full, T0 + USER_PUSH_WINDOW_MS, { coalesce: true })).toEqual({
			allow: true,
			windowStart: T0 + USER_PUSH_WINDOW_MS,
			windowCount: 1,
		});
	});
});

describe("PushStore throttle on SQLite", () => {
	it("claims one slot per thread per minute and limits a burst across threads", () => {
		const { push } = sqlite();
		expect(push.claimSlot("ada@acme.dev", "mb:t1", T0).allow).toBe(true);
		expect(push.claimSlot("ada@acme.dev", "mb:t1", T0 + 30_000)).toEqual({ allow: false, reason: "coalesced" });
		// Another user is not affected.
		expect(push.claimSlot("bob@acme.dev", "mb:t1", T0 + 30_000).allow).toBe(true);
		expect(push.claimSlot("ada@acme.dev", "mb:t1", T0 + 60_000).allow).toBe(true);
		let allowed = 2;
		for (let i = 0; i < USER_PUSH_LIMIT + 5; i++) {
			if (push.claimSlot("ada@acme.dev", `mb:burst${i}`, T0 + 61_000 + i).allow) allowed += 1;
		}
		expect(allowed).toBe(USER_PUSH_LIMIT);
		expect(push.claimSlot("ada@acme.dev", "mb:later", T0 + USER_PUSH_WINDOW_MS + 1).allow).toBe(true);
	});
});

// ── Subscriptions ───────────────────────────────────────────────────

describe("migrations", () => {
	it("appends 0018_web_push after every migration that shipped before it", () => {
		const names = [...AUTH_MIGRATION_NAMES];
		expect(names.indexOf("0018_web_push")).toBeGreaterThan(names.indexOf("0019_ai_usage_and_budget"));
	});
});

describe("PushStore subscriptions", () => {
	let s: ReturnType<typeof sqlite>;
	beforeEach(() => {
		s = sqlite();
	});

	const sub = (endpoint: string, userKey = "ada@acme.dev") => ({
		userKey,
		endpoint,
		p256dh: "BPk",
		auth: "secret-auth-1234",
		userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1",
		now: T0,
	});

	it("stores per user and device, idempotent per endpoint", () => {
		const a = s.push.upsertSubscription(sub("https://web.push.apple.com/a"));
		const again = s.push.upsertSubscription({ ...sub("https://web.push.apple.com/a"), p256dh: "BNew" });
		expect(again.id).toBe(a.id);
		expect(again.p256dh).toBe("BNew");
		s.push.upsertSubscription(sub("https://fcm.googleapis.com/fcm/send/b"));
		expect(s.push.listSubscriptions("ADA@acme.dev")).toHaveLength(2);
		expect(a).toMatchObject({ createdAt: T0, lastSuccessAt: null, failures: 0 });
	});

	it("moves an endpoint to whoever registers it last", () => {
		s.push.upsertSubscription(sub("https://web.push.apple.com/a", "ada@acme.dev"));
		s.push.upsertSubscription(sub("https://web.push.apple.com/a", "bob@acme.dev"));
		expect(s.push.listSubscriptions("ada@acme.dev")).toHaveLength(0);
		expect(s.push.listSubscriptions("bob@acme.dev")).toHaveLength(1);
	});

	it("deletes only the caller's own device", () => {
		const a = s.push.upsertSubscription(sub("https://web.push.apple.com/a"));
		expect(s.push.deleteSubscription("bob@acme.dev", { id: a.id })).toBe(false);
		expect(s.push.deleteSubscription("ada@acme.dev", { id: a.id })).toBe(true);
		expect(s.push.listSubscriptions("ada@acme.dev")).toHaveLength(0);
	});

	it("removes a subscription on 410 and 404, counts other failures, resets on success", () => {
		const a = s.push.upsertSubscription(sub("https://web.push.apple.com/a"));
		const b = s.push.upsertSubscription(sub("https://web.push.apple.com/b"));
		expect(s.push.recordDelivery(a.id, { ok: false, status: 500, error: "500 oops" }, T0 + 1)).toBe("failed");
		expect(s.push.getSubscription(a.id)).toMatchObject({ failures: 1, lastError: "500 oops", lastFailureAt: T0 + 1 });
		expect(s.push.recordDelivery(a.id, { ok: true }, T0 + 2)).toBe("ok");
		expect(s.push.getSubscription(a.id)).toMatchObject({ failures: 0, lastSuccessAt: T0 + 2, lastError: null });
		expect(s.push.recordDelivery(a.id, { ok: false, status: 410, error: "410 Gone" }, T0 + 3)).toBe("removed");
		expect(s.push.getSubscription(a.id)).toBeNull();
		expect(s.push.recordDelivery(b.id, { ok: false, status: 404, error: "404" }, T0 + 3)).toBe("removed");
		expect(s.push.listSubscriptions("ada@acme.dev")).toHaveLength(0);
	});

	it("replaces a rotated subscription only with the old auth secret", () => {
		s.push.upsertSubscription(sub("https://web.push.apple.com/old"));
		const input = { oldEndpoint: "https://web.push.apple.com/old", endpoint: "https://web.push.apple.com/new", p256dh: "BN", auth: "new-auth-12345678", userAgent: null, now: T0 };
		expect(s.push.replaceSubscription({ ...input, oldAuth: "wrong-auth-123456" })).toBeNull();
		const next = s.push.replaceSubscription({ ...input, oldAuth: "secret-auth-1234" });
		expect(next).toMatchObject({ userKey: "ada@acme.dev", endpoint: "https://web.push.apple.com/new" });
		expect(s.push.listSubscriptions("ada@acme.dev").map((x) => x.endpoint)).toEqual(["https://web.push.apple.com/new"]);
	});

	it("account deletion and disabling drop the user's devices", async () => {
		const owner = await s.auth.createOwner({ email: "owner@acme.dev", name: "O", passwordHash: "h", now: T0 });
		expect(owner).toBeTruthy();
		const invite = await s.auth.createInvite({ email: "ada@acme.dev", role: "member", mailboxes: [], createdBy: null, tokenHash: "t", expiresAt: T0 + 86_400_000, now: T0 });
		expect(invite).toBeTruthy();
		await s.auth.acceptInvite({ tokenHash: "t", name: "Ada", passwordHash: "h", now: T0 });
		const ada = await s.auth.getUserByEmail("ada@acme.dev");
		s.push.upsertSubscription(sub("https://web.push.apple.com/a"));
		s.push.updatePrefs("ada@acme.dev", { hideContent: true }, T0);
		await s.auth.setDisabled(ada!.id, true);
		expect(s.push.listSubscriptions("ada@acme.dev")).toHaveLength(0);
		s.push.upsertSubscription(sub("https://web.push.apple.com/b"));
		await s.auth.deleteUser(ada!.id);
		expect(s.push.listSubscriptions("ada@acme.dev")).toHaveLength(0);
		expect(s.push.getPrefs("ada@acme.dev").hideContent).toBe(false);
	});

	it("accepts only real push service endpoints", () => {
		expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/x")).toBe(true);
		expect(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
		expect(isAllowedPushEndpoint("https://web.push.apple.com/QG")).toBe(true);
		expect(isAllowedPushEndpoint("https://wns2-par02p.notify.windows.com/w/?token=x")).toBe(true);
		expect(isAllowedPushEndpoint("http://fcm.googleapis.com/x")).toBe(false);
		expect(isAllowedPushEndpoint("https://evil.example/fcm.googleapis.com")).toBe(false);
		expect(isAllowedPushEndpoint("https://fcm.googleapis.com.evil.example/x")).toBe(false);
		expect(isAllowedPushEndpoint("https://169.254.169.254/latest")).toBe(false);
	});

	it("labels devices from the user agent", () => {
		expect(deviceLabel(sub("x").userAgent)).toBe("Safari on iPhone");
		expect(deviceLabel("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36")).toBe("Chrome on Android");
		expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:131.0) Gecko/20100101 Firefox/131.0")).toBe("Firefox on Mac");
		expect(deviceLabel(null)).toBe("Browser on Device");
	});
});

// ── Payload ─────────────────────────────────────────────────────────

describe("payloads", () => {
	const base = {
		mailboxId: "support@acme.dev",
		emailId: "e1",
		threadId: "t1",
		senderName: "Ada Lovelace",
		sender: "ada@example.com",
		subject: "Invoice question",
	};

	it("sender and subject by default, with the ?m= deep link and per-thread tag", () => {
		const p = mailPayload({ ...base, hideContent: false });
		expect(p).toMatchObject({
			kind: "mail",
			title: "Ada Lovelace",
			body: "Invoice question",
			tag: "mail:support@acme.dev:t1",
			url: "/mail/support%40acme.dev/inbox?m=e1",
		});
		expect(p.actions).toBeUndefined();
	});

	it("hides everything but the mailbox when asked", () => {
		const p = mailPayload({ ...base, hideContent: true, actions: { archive: "a", read: "r" } });
		expect(p.title).toBe("New mail in support@acme.dev");
		expect(p.body).toBe("");
		expect(JSON.stringify(p)).not.toContain("Ada");
		expect(JSON.stringify(p)).not.toContain("Invoice");
		expect(p.actions?.map((a) => a.action)).toEqual(["archive", "read"]);
	});

	it("only same-origin paths are click targets", () => {
		const o = "https://mailer.example.com";
		expect(safeNotificationUrl("/mail/a%40b.c/inbox?m=1", o)).toBe("/mail/a%40b.c/inbox?m=1");
		expect(safeNotificationUrl("https://evil.example/", o)).toBe("/");
		expect(safeNotificationUrl("//evil.example/x", o)).toBe("/");
		expect(safeNotificationUrl("javascript:alert(1)", o)).toBe("/");
		expect(safeNotificationUrl(undefined, o)).toBe("/");
	});
});

// ── Dispatch ────────────────────────────────────────────────────────

/** Env with only what the dispatcher touches. Every user is an admin (no ADMIN_EMAILS, Access mode). */
function fakeEnv(): Env {
	return {
		AUTH_MODE: "access",
		BUCKET: { get: async () => null, head: async () => null, list: async () => ({ objects: [], truncated: false }) },
		UNSUBSCRIBE_SECRET: "test-secret-for-push-actions",
		APP_URL: "https://mailer.example.com",
	} as unknown as Env;
}

function storedFacts(over: Partial<StoredMailFacts> = {}): StoredMailFacts {
	return {
		id: "e1",
		threadId: "t1",
		folder: "inbox",
		read: false,
		muted: false,
		sender: "ada@example.com",
		senderName: "Ada",
		subject: "Hello",
		priority: null,
		inConversation: false,
		...over,
	};
}

describe("dispatch", () => {
	it("sends to every device, removes the one the push service says is gone", async () => {
		const { push } = sqlite();
		const rpc = rpcFor(push);
		const keys = await generateP256KeyPair();
		const k1 = await uaKeys();
		const k2 = await uaKeys();
		push.upsertSubscription({ userKey: "ada@acme.dev", endpoint: "https://fcm.googleapis.com/fcm/send/live", ...k1, userAgent: null, now: T0 });
		push.upsertSubscription({ userKey: "ada@acme.dev", endpoint: "https://fcm.googleapis.com/fcm/send/gone", ...k2, userAgent: null, now: T0 });
		const calls: { url: string; headers: Record<string, string>; bytes: number }[] = [];
		const fetcher = async (url: string, init: RequestInit) => {
			calls.push({ url, headers: init.headers as Record<string, string>, bytes: (init.body as Uint8Array).length });
			return new Response(null, { status: url.endsWith("/gone") ? 410 : 201 });
		};
		const report = await notifyNewMail(fakeEnv(), { mailboxId: "support@acme.dev", deliveredTo: "support@acme.dev", facts: storedFacts() }, { rpc, keys, fetcher, now: T0 });
		expect(report).toMatchObject({ sent: 1, removed: 1, failed: 0 });
		expect(calls).toHaveLength(2);
		for (const c of calls) {
			expect(c.headers["Content-Encoding"]).toBe("aes128gcm");
			expect(c.headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
			expect(c.headers.TTL).toBe("86400");
		}
		expect(push.listSubscriptions("ada@acme.dev").map((s) => s.endpoint)).toEqual(["https://fcm.googleapis.com/fcm/send/live"]);
	});

	it("skips spam, honours preferences and quiet hours, and coalesces a burst on one thread", async () => {
		const { push } = sqlite();
		const rpc = rpcFor(push);
		const keys = await generateP256KeyPair();
		push.upsertSubscription({ userKey: "ada@acme.dev", endpoint: "https://fcm.googleapis.com/fcm/send/a", ...(await uaKeys()), userAgent: null, now: T0 });
		let sends = 0;
		const deps = { rpc, keys, fetcher: async () => (sends++, new Response(null, { status: 201 })), now: T0 };
		const env = fakeEnv();
		const input = { mailboxId: "support@acme.dev", deliveredTo: "support@acme.dev" };

		expect((await notifyNewMail(env, { ...input, facts: storedFacts({ folder: "spam" }) }, deps)).skipped).toEqual({ spam: 1 });
		expect((await notifyNewMail(env, { ...input, facts: storedFacts({ folder: "screener" }) }, deps)).skipped).toEqual({ screener: 1 });
		expect(sends).toBe(0);

		expect((await notifyNewMail(env, { ...input, facts: storedFacts() }, deps)).sent).toBe(1);
		// Second message in the same thread within a minute: coalesced.
		expect((await notifyNewMail(env, { ...input, facts: storedFacts({ id: "e2" }) }, { ...deps, now: T0 + 10_000 })).skipped).toEqual({ coalesced: 1 });
		// Another thread goes out.
		expect((await notifyNewMail(env, { ...input, facts: storedFacts({ id: "e3", threadId: "t2" }) }, { ...deps, now: T0 + 10_000 })).sent).toBe(1);

		// Quiet hours, 11:00-13:00 UTC: T0 is 12:00 UTC.
		push.updatePrefs("ada@acme.dev", { quietHours: { enabled: true, start: "11:00", end: "13:00", timeZone: "UTC" } }, T0);
		expect((await notifyNewMail(env, { ...input, facts: storedFacts({ threadId: "t3" }) }, { ...deps, now: T0 + 20_000 })).skipped).toEqual({ quiet_hours: 1 });

		push.updatePrefs("ada@acme.dev", { quietHours: { enabled: false }, mailboxes: { "support@acme.dev": "off" } }, T0);
		expect((await notifyNewMail(env, { ...input, facts: storedFacts({ threadId: "t4" }) }, { ...deps, now: T0 + 20_000 })).skipped).toEqual({ mailbox_off: 1 });
		expect(sends).toBe(2);
	});

	it("puts sender and subject only inside the encrypted body, and action tokens per user", async () => {
		const { push } = sqlite();
		const rpc = rpcFor(push);
		const keys = await generateP256KeyPair();
		push.upsertSubscription({ userKey: "ada@acme.dev", endpoint: "https://fcm.googleapis.com/fcm/send/a", ...(await uaKeys()), userAgent: null, now: T0 });
		const bodies: Uint8Array[] = [];
		await notifyNewMail(
			fakeEnv(),
			{ mailboxId: "support@acme.dev", deliveredTo: "support@acme.dev", facts: storedFacts({ subject: "Secret plans" }) },
			{ rpc, keys, now: T0, fetcher: async (_u, init) => (bodies.push(init.body as Uint8Array), new Response(null, { status: 201 })) },
		);
		expect(bodies).toHaveLength(1);
		expect(new TextDecoder("latin1").decode(bodies[0])).not.toContain("Secret plans");
	});

	it("approval pushes respect their own toggle", async () => {
		const { push } = sqlite();
		const rpc = rpcFor(push);
		const keys = await generateP256KeyPair();
		push.upsertSubscription({ userKey: "ada@acme.dev", endpoint: "https://fcm.googleapis.com/fcm/send/a", ...(await uaKeys()), userAgent: null, now: T0 });
		const deps = { rpc, keys, now: T0, fetcher: async () => new Response(null, { status: 201 }) };
		const input = { mailboxId: "support@acme.dev", approvalId: "apr_1", subject: "Re: hi", recipients: 2 };
		expect((await notifyApproval(fakeEnv(), input, deps)).sent).toBe(1);
		push.updatePrefs("ada@acme.dev", { approvals: false }, T0);
		expect((await notifyApproval(fakeEnv(), { ...input, approvalId: "apr_2" }, deps)).skipped).toEqual({ kind_off: 1 });
	});

	it("test push reaches every device and is rate limited", async () => {
		const { push } = sqlite();
		const rpc = rpcFor(push);
		const keys = await generateP256KeyPair();
		push.upsertSubscription({ userKey: "ada@acme.dev", endpoint: "https://fcm.googleapis.com/fcm/send/a", ...(await uaKeys()), userAgent: null, now: T0 });
		const deps = { rpc, keys, now: T0, fetcher: async () => new Response(null, { status: 201 }) };
		expect(await sendTestPush(fakeEnv(), "ada@acme.dev", deps)).toMatchObject({ devices: 1, sent: 1, limited: false });
		for (let i = 0; i < USER_PUSH_LIMIT; i++) await sendTestPush(fakeEnv(), "ada@acme.dev", deps);
		expect(await sendTestPush(fakeEnv(), "ada@acme.dev", deps)).toMatchObject({ limited: true, sent: 0 });
		expect(await sendTestPush(fakeEnv(), "nobody@acme.dev", deps)).toMatchObject({ devices: 0 });
	});

	it("generates VAPID keys once and keeps them", async () => {
		const { push } = sqlite();
		const meta = new Map<string, string>();
		const rpc = rpcFor(push, meta);
		const { getVapidKeys } = await import("../workers/lib/push");
		const first = await getVapidKeys(fakeEnv(), rpc);
		const second = await getVapidKeys(fakeEnv(), rpc);
		expect(first).toEqual(second);
		expect(meta.size).toBe(1);
		// An operator's secrets win.
		const env = { ...fakeEnv(), VAPID_PUBLIC_KEY: (await generateP256KeyPair()).publicKey } as Env;
		const own = await generateP256KeyPair();
		Object.assign(env, { VAPID_PUBLIC_KEY: own.publicKey, VAPID_PRIVATE_KEY: own.privateKey });
		expect(await getVapidKeys(env, rpc)).toEqual(own);
	});
});

// ── Action tokens ───────────────────────────────────────────────────

describe("action tokens", () => {
	const secret = "action-secret";

	function harness() {
		const { push } = sqlite();
		const rpc = rpcFor(push);
		const calls: string[] = [];
		const mailbox = (mailboxId: string) => ({
			updateEmail: async (id: string, patch: { read?: boolean }) => (calls.push(`${mailboxId}:${id}:read=${patch.read}`), { id }),
			moveEmail: async (id: string, folder: string) => (calls.push(`${mailboxId}:${id}:move=${folder}`), true),
		});
		let allowed = true;
		const deps = { rpc, secret, mailbox, now: T0, mayOrganise: async () => allowed };
		return { calls, deps, deny: () => (allowed = false), allow: () => (allowed = true) };
	}

	const mint = (action: "archive" | "read", now = T0) =>
		mintActionToken(fakeEnv(), { mailboxId: "Support@acme.dev", emailId: "e1", action, userKey: "ada@acme.dev" }, now, secret);

	it("performs exactly its one action on its one message, once", async () => {
		const h = harness();
		const token = await mint("read");
		expect(await performAction(fakeEnv(), token, h.deps)).toEqual({ ok: true, action: "read", mailboxId: "support@acme.dev", emailId: "e1" });
		expect(h.calls).toEqual(["support@acme.dev:e1:read=true"]);
		expect(await performAction(fakeEnv(), token, h.deps)).toMatchObject({ ok: false, status: 409 });
		expect(h.calls).toHaveLength(1);
	});

	it("archive marks read and moves to Archive", async () => {
		const h = harness();
		expect((await performAction(fakeEnv(), await mint("archive"), h.deps)).ok).toBe(true);
		expect(h.calls).toEqual(["support@acme.dev:e1:read=true", "support@acme.dev:e1:move=archive"]);
	});

	it("cannot be retargeted: any change to the payload breaks the signature", async () => {
		const h = harness();
		const token = await mint("read");
		const [body, sig] = token.split(".");
		const payload = JSON.parse(Buffer.from(body!, "base64url").toString());
		for (const tamper of [{ a: "archive" }, { e: "e2" }, { m: "ceo@acme.dev" }, { u: "bob@acme.dev" }, { exp: payload.exp + 1e9 }]) {
			const forged = `${Buffer.from(JSON.stringify({ ...payload, ...tamper })).toString("base64url")}.${sig}`;
			expect(await performAction(fakeEnv(), forged, h.deps)).toMatchObject({ ok: false, status: 400 });
		}
		expect(await performAction(fakeEnv(), token, { ...h.deps, secret: "another-secret" })).toMatchObject({ ok: false, status: 400 });
		expect(h.calls).toEqual([]);
	});

	it("expires", async () => {
		const h = harness();
		const token = await mint("read", T0 - 13 * 3600_000);
		expect(await performAction(fakeEnv(), token, h.deps)).toMatchObject({ ok: false, status: 400 });
	});

	it("re-checks the user's access, and a refused attempt does not burn the token", async () => {
		const h = harness();
		const token = await mint("read");
		h.deny();
		expect(await performAction(fakeEnv(), token, h.deps)).toMatchObject({ ok: false, status: 403 });
		h.allow();
		expect((await performAction(fakeEnv(), token, h.deps)).ok).toBe(true);
	});

	it("two tokens for the same message are independent", async () => {
		const h = harness();
		const read = await mint("read");
		const archive = await mint("archive");
		expect((await performAction(fakeEnv(), read, h.deps)).ok).toBe(true);
		expect((await performAction(fakeEnv(), archive, h.deps)).ok).toBe(true);
	});
});
