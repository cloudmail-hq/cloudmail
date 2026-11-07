// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Self-service account deletion and export, and recipient tracking opt-outs.
 *
 * The store cases run the real `AuthStore` on `node:sqlite`, so the grace
 * period, the revocation and the sole-owner guard are the production SQL. The
 * export case builds a real ZIP across several bounded ticks into a fake R2
 * (with multipart), then reads it back and checks every entry's CRC.
 */

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthStore, type AuthSql } from "../workers/auth/store-core";
import {
	ACCOUNT_DELETION_GRACE_MS,
	advanceExport,
	initialExportState,
	runAccountDeletionTick,
	solelyOwnedMailboxes,
	type ExportMailboxStub,
	type ExportState,
} from "../workers/lib/account-privacy";
import { crc32Update } from "../shared/zip";
import { privacyDeps, privacyRoutes } from "../workers/routes/privacy";
import type { ExportJobRecord } from "../workers/auth/types";
import type { MailboxContext } from "../workers/lib/mailbox";
import type { Env } from "../workers/types";

const T0 = Date.UTC(2026, 9, 26, 12);
const DAY = 24 * 60 * 60 * 1000;

function sqliteStore(): AuthStore {
	const db = new DatabaseSync(":memory:");
	const sql: AuthSql = {
		exec(query: string, ...bindings: unknown[]) {
			const rows = db.prepare(query).all(...(bindings as never[])) as unknown[];
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
	return new AuthStore(sql, tx);
}

let store: AuthStore;

async function owner() {
	const r = await store.createOwner({ email: "owner@example.com", name: "Owner", passwordHash: "h", now: T0 });
	if (!r.ok) throw new Error("setup");
	return r.user;
}

async function member(email = "member@example.com") {
	await store.createInvite({
		tokenHash: `inv-${email}`,
		email,
		role: "member",
		mailboxes: [],
		createdBy: null,
		expiresAt: T0 + 7 * DAY,
		now: T0,
	});
	const r = await store.acceptInvite({ tokenHash: `inv-${email}`, name: "Member", passwordHash: "h", now: T0 });
	if (!r.ok) throw new Error(r.reason);
	return r.user;
}

beforeEach(() => {
	store = sqliteStore();
});

// ── deletion ───────────────────────────────────────────────────────

describe("account deletion: sole-owner guard", () => {
	it("refuses the owner, who is always the sole owner", async () => {
		const o = await owner();
		const result = await store.scheduleAccountDeletion({ userId: o.id, now: T0, graceMs: ACCOUNT_DELETION_GRACE_MS, mailboxes: [] });
		expect(result).toEqual({ ok: false, reason: "sole_owner" });
		expect(await store.getAccountDeletion(o.id)).toBeNull();
	});

	it("completion re-checks the guard too", async () => {
		const o = await owner();
		expect(await store.completeAccountDeletion(o.id, T0 + 30 * DAY)).toBe(false);
		expect(await store.getUser(o.id)).not.toBeNull();
	});
});

describe("account deletion: revocation and grace period", () => {
	it("revokes sessions, API tokens and OAuth grants at once, but keeps the account for 7 days", async () => {
		await owner();
		const m = await member();
		await store.createSession({ userId: m.id, tokenHash: "sess", ip: null, userAgent: null, now: T0 });
		await store.createApiToken({ id: "tok1", userId: m.id, name: "cli", secretHash: "sh", expiresAt: null, now: T0 });
		await store.createOAuthGrant({ userId: m.id, clientId: "c", clientName: "C", redirectHost: "h", now: T0 });
		expect(await store.validateSession("sess", T0)).not.toBeNull();
		expect(await store.validateApiToken("tok1", "sh", T0)).not.toBeNull();

		const result = await store.scheduleAccountDeletion({
			userId: m.id,
			now: T0,
			graceMs: ACCOUNT_DELETION_GRACE_MS,
			mailboxes: ["solo@example.com"],
		});
		expect(result).toEqual({ ok: true, requestedAt: T0, purgeAfter: T0 + 7 * DAY });

		expect(await store.validateSession("sess", T0 + 1)).toBeNull();
		expect(await store.validateApiToken("tok1", "sh", T0 + 1)).toBeNull();
		expect(await store.listOAuthGrants(m.id)).toEqual([]);
		// The account itself is still there, so the user can sign in and cancel.
		expect(await store.getUser(m.id)).not.toBeNull();
	});

	it("is not purged one millisecond early, and is purged once the grace period passes", async () => {
		await owner();
		const m = await member();
		await store.scheduleAccountDeletion({ userId: m.id, now: T0, graceMs: ACCOUNT_DELETION_GRACE_MS, mailboxes: ["solo@example.com"] });

		expect(await store.listDueAccountDeletions(T0 + 7 * DAY - 1)).toEqual([]);
		expect(await store.completeAccountDeletion(m.id, T0 + 7 * DAY - 1)).toBe(false);
		expect(await store.getUser(m.id)).not.toBeNull();

		const due = await store.listDueAccountDeletions(T0 + 7 * DAY);
		expect(due).toEqual([{ userId: m.id, email: m.email, mailboxes: ["solo@example.com"], purgeAfter: T0 + 7 * DAY }]);
		expect(await store.completeAccountDeletion(m.id, T0 + 7 * DAY)).toBe(true);
		expect(await store.getUser(m.id)).toBeNull();
		expect(await store.getAccountDeletion(m.id)).toBeNull();
	});

	it("a repeat request keeps the original deadline", async () => {
		await owner();
		const m = await member();
		await store.scheduleAccountDeletion({ userId: m.id, now: T0, graceMs: ACCOUNT_DELETION_GRACE_MS, mailboxes: [] });
		const again = await store.scheduleAccountDeletion({ userId: m.id, now: T0 + 3 * DAY, graceMs: ACCOUNT_DELETION_GRACE_MS, mailboxes: [] });
		expect(again).toMatchObject({ ok: true, purgeAfter: T0 + 7 * DAY });
	});

	it("cancelling stops the purge", async () => {
		await owner();
		const m = await member();
		await store.scheduleAccountDeletion({ userId: m.id, now: T0, graceMs: ACCOUNT_DELETION_GRACE_MS, mailboxes: [] });
		expect(await store.cancelAccountDeletion(m.id)).toBe(true);
		expect(await store.listDueAccountDeletions(T0 + 30 * DAY)).toEqual([]);
		expect(await store.completeAccountDeletion(m.id, T0 + 30 * DAY)).toBe(false);
		expect(await store.getUser(m.id)).not.toBeNull();
	});
});

// ── opt-outs ───────────────────────────────────────────────────────

describe("tracking opt-outs", () => {
	it("records once per address and scope, and finds global and domain-scoped entries", async () => {
		expect(await store.addTrackingOptOut({ address: " Reader@Example.org ", scope: "tapetide.com", source: "u", now: T0 })).toBe(true);
		expect(await store.addTrackingOptOut({ address: "reader@example.org", scope: "tapetide.com", source: "u", now: T0 })).toBe(false);
		await store.addTrackingOptOut({ address: "other@example.org", scope: "global", source: "u", now: T0 });

		expect(await store.findTrackingOptOuts(["reader@example.org"], "tapetide.com")).toHaveLength(1);
		expect(await store.findTrackingOptOuts(["reader@example.org"], "elsewhere.com")).toHaveLength(0);
		expect(await store.findTrackingOptOuts(["other@example.org"], "anything.com")).toHaveLength(1);
	});
});

// ── fake R2 ─────────────────────────────────────────────────────────

function fakeBucket(initial: Record<string, unknown> = {}) {
	const objects = new Map<string, Uint8Array>();
	const enc = new TextEncoder();
	for (const [k, v] of Object.entries(initial)) objects.set(k, enc.encode(JSON.stringify(v)));
	const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
	const toBytes = (v: unknown): Uint8Array =>
		typeof v === "string" ? enc.encode(v) : v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer);
	const obj = (bytes: Uint8Array) => ({
		size: bytes.length,
		body: bytes,
		arrayBuffer: async () => bytes.slice().buffer,
		json: async () => JSON.parse(new TextDecoder().decode(bytes)),
	});
	let nextUpload = 0;
	const bucket = {
		objects,
		async get(key: string) {
			const b = objects.get(key);
			return b ? obj(b) : null;
		},
		async head(key: string) {
			return objects.has(key) ? { key } : null;
		},
		async put(key: string, value: unknown) {
			objects.set(key, toBytes(value));
		},
		async delete(keys: string | string[]) {
			for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
		},
		async list({ prefix = "" }: { prefix?: string } = {}) {
			return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
		},
		async createMultipartUpload(key: string) {
			const uploadId = `up-${nextUpload++}`;
			uploads.set(uploadId, { key, parts: new Map() });
			return bucket.resumeMultipartUpload(key, uploadId);
		},
		resumeMultipartUpload(key: string, uploadId: string) {
			return {
				key,
				uploadId,
				async uploadPart(n: number, value: Uint8Array) {
					uploads.get(uploadId)!.parts.set(n, value.slice());
					return { partNumber: n, etag: `e${n}` };
				},
				async complete(parts: { partNumber: number }[]) {
					const u = uploads.get(uploadId)!;
					const all = parts.map((p) => u.parts.get(p.partNumber)!);
					const total = all.reduce((n, p) => n + p.length, 0);
					const out = new Uint8Array(total);
					let at = 0;
					for (const p of all) {
						out.set(p, at);
						at += p.length;
					}
					objects.set(u.key, out);
					return { key: u.key };
				},
				async abort() {
					uploads.delete(uploadId);
				},
			};
		},
	};
	return bucket;
}

/** Read every entry out of a STORED zip through its central directory, checking CRCs. */
function readZip(bytes: Uint8Array): Record<string, string> {
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let eocd = bytes.length - 22;
	while (eocd >= 0 && v.getUint32(eocd, true) !== 0x06054b50) eocd--;
	if (eocd < 0) throw new Error("no end record");
	const count = v.getUint16(eocd + 10, true);
	let at = v.getUint32(eocd + 16, true);
	const out: Record<string, string> = {};
	const dec = new TextDecoder();
	for (let i = 0; i < count; i++) {
		expect(v.getUint32(at, true)).toBe(0x02014b50);
		const crc = v.getUint32(at + 16, true);
		const size = v.getUint32(at + 20, true);
		const nameLen = v.getUint16(at + 28, true);
		const offset = v.getUint32(at + 42, true);
		const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
		expect(v.getUint32(offset, true)).toBe(0x04034b50);
		const localName = v.getUint16(offset + 26, true);
		const dataStart = offset + 30 + localName + v.getUint16(offset + 28, true);
		const data = bytes.subarray(dataStart, dataStart + size);
		expect(crc32Update(0, data)).toBe(crc);
		// Data descriptor follows with the same CRC and size.
		expect(v.getUint32(dataStart + size, true)).toBe(0x08074b50);
		expect(v.getUint32(dataStart + size + 4, true)).toBe(crc);
		out[name] = dec.decode(data);
		at += 46 + nameLen;
	}
	return out;
}

function fakeMailbox(messages: { id: string; date: string; subject: string; body: string }[]): ExportMailboxStub {
	return {
		async exportPage(options) {
			const sorted = [...messages].sort((a, b) => (a.date + a.id).localeCompare(b.date + b.id));
			const after = options.afterDate
				? sorted.filter((m) => m.date > options.afterDate! || (m.date === options.afterDate && m.id > (options.afterId ?? "")))
				: sorted;
			const page = after.slice(0, 2); // tiny pages force several ticks
			const last = page[page.length - 1];
			return {
				messages: page.map((m) => ({ ...m, sender: "a@example.org", recipient: "box@tapetide.com", folder_id: "inbox" })),
				attachments: {},
				done: after.length <= 2,
				cursor: last ? { date: last.date, id: last.id } : undefined,
			};
		},
	};
}

// ── export ─────────────────────────────────────────────────────────

describe("account export contents", () => {
	it("builds account.json plus one mbox per owned mailbox, across bounded ticks and multipart parts", async () => {
		const bucket = fakeBucket();
		const big = "x".repeat(3000);
		const mailboxes: Record<string, ExportMailboxStub> = {
			"a@tapetide.com": fakeMailbox(
				Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, date: `2026-10-0${i + 1}T00:00:00Z`, subject: `A${i}`, body: `${big}${i}` })),
			),
			"b@tapetide.com": fakeMailbox([{ id: "b0", date: "2026-10-01T00:00:00Z", subject: "Only", body: "hello" }]),
		};
		const job: ExportJobRecord = {
			id: "job1",
			userId: "usr_1",
			status: "pending",
			objectKey: null,
			size: null,
			error: null,
			state: null,
			createdAt: T0,
			completedAt: null,
			expiresAt: T0 + DAY,
		};
		let state: ExportState = initialExportState("member@example.com", Object.keys(mailboxes));
		const account = { profile: { email: "member@example.com" }, apiTokens: [{ id: "tok1", name: "cli" }] };
		let ticks = 0;
		let done = false;
		while (!done) {
			ticks++;
			// Round-trip the state through JSON, as the job row does between ticks.
			state = JSON.parse(JSON.stringify(state));
			const result = await advanceExport(job, state, {
				bucket: bucket as unknown as R2Bucket,
				mailbox: (id) => mailboxes[id],
				accountJson: async () => account,
				now: () => T0,
				partBytes: 4096,
				pagesPerTick: 1,
			});
			state = result.state;
			done = result.done;
			if (ticks > 20) throw new Error("export never finished");
		}
		expect(ticks).toBeGreaterThan(2);
		expect(state.parts.length).toBeGreaterThan(1); // really used multipart
		expect(bucket.objects.has("exports/usr_1/job1.pending")).toBe(false);

		const zip = readZip(bucket.objects.get("exports/usr_1/job1.zip")!);
		expect(Object.keys(zip).sort()).toEqual(["account.json", "mailboxes/a@tapetide.com.mbox", "mailboxes/b@tapetide.com.mbox"]);
		expect(JSON.parse(zip["account.json"])).toEqual(account);
		const a = zip["mailboxes/a@tapetide.com.mbox"];
		expect(a.match(/^From /gm)).toHaveLength(5);
		for (let i = 0; i < 5; i++) expect(a).toContain(`Subject: A${i}`);
		expect(zip["mailboxes/b@tapetide.com.mbox"]).toContain("hello");
	});

	it("never puts token secrets in account.json", async () => {
		const { buildAccountJson } = await import("../workers/lib/account-privacy");
		await owner();
		const m = await member();
		await store.createApiToken({ id: "tok1", userId: m.id, name: "cli", secretHash: "SECRET-HASH", expiresAt: null, now: T0 });
		const env = {
			BUCKET: fakeBucket(),
			MAILBOX: { idFromName: (n: string) => n, get: () => ({ getTrackingSettings: async () => ({ openTracking: true }) }) },
		} as unknown as Env;
		const json = JSON.stringify(await buildAccountJson(env, store, m, [], T0));
		expect(json).toContain('"name":"cli"');
		expect(json).not.toContain("SECRET-HASH");
	});
});

// ── which mailboxes go with the account ────────────────────────────

describe("solelyOwnedMailboxes", () => {
	it("keeps mailboxes anyone else is granted", async () => {
		const bucket = fakeBucket({
			"access/users/member@example.com.json": {
				id: "member@example.com",
				role: "member",
				mailboxes: ["solo@tapetide.com", "shared@tapetide.com", { id: "viewonly@tapetide.com", role: "viewer" }],
			},
			"access/users/other@example.com.json": { id: "other@example.com", role: "member", mailboxes: ["shared@tapetide.com"] },
		});
		const env = { BUCKET: bucket } as unknown as Env;
		expect(await solelyOwnedMailboxes(env, "member@example.com")).toEqual(["solo@tapetide.com"]);
	});
});

describe("the purge tick", () => {
	it("destroys the solely owned mailbox and the account once due, and records it", async () => {
		await owner();
		const m = await member();
		const bucket = fakeBucket({
			"mailboxes/solo@tapetide.com.json": {},
			"mailboxes/keep@tapetide.com.json": {},
			[`access/users/${m.email}.json`]: { id: m.email, role: "member", mailboxes: ["solo@tapetide.com"] },
		});
		bucket.objects.set(`exports/${m.id}/old.zip`, new Uint8Array([1]));
		const purged: string[] = [];
		const env = {
			BUCKET: bucket,
			MAILBOX: { idFromName: (n: string) => n, get: (n: string) => ({ purge: async () => (purged.push(n), []) }) },
			EMAIL_AGENT: { idFromName: (n: string) => n, get: () => ({ purge: async () => {} }) },
		} as unknown as Env;
		await store.scheduleAccountDeletion({ userId: m.id, now: T0, graceMs: ACCOUNT_DELETION_GRACE_MS, mailboxes: ["solo@tapetide.com"] });

		expect(await runAccountDeletionTick(env, store, { now: T0 + DAY })).toBe(0);
		expect(purged).toEqual([]);

		expect(await runAccountDeletionTick(env, store, { now: T0 + 7 * DAY })).toBe(1);
		expect(purged).toEqual(["solo@tapetide.com"]);
		expect(bucket.objects.has("mailboxes/solo@tapetide.com.json")).toBe(false);
		expect(bucket.objects.has("mailboxes/keep@tapetide.com.json")).toBe(true);
		expect(bucket.objects.has(`access/users/${m.email}.json`)).toBe(false);
		expect(bucket.objects.has(`exports/${m.id}/old.zip`)).toBe(false);
		expect(await store.getUser(m.id)).toBeNull();
		const audit = [...bucket.objects.keys()].filter((k) => k.startsWith("audit/_instance/"));
		expect(audit).toHaveLength(1);
	});
});

// ── routes ─────────────────────────────────────────────────────────

function routeApp(user: { id: string; email: string; isOwner: boolean }, options: { method?: "session" | "token"; authenticatedAt?: number | null } = {}) {
	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => {
		c.set("authUser", { ...user, name: "U", disabled: false, totpEnabled: false, createdAt: T0, lastLoginAt: null, passwordChangedAt: null });
		c.set("authMethod", options.method ?? "session");
		c.set("authSessionHash", "sess");
		c.set("principal", { identity: { kind: "user", id: user.email, subject: null }, role: "member", mailboxes: [], access: [], enforced: true, developmentBypass: false });
		return next();
	});
	app.route("/", privacyRoutes);
	const env = {
		BUCKET: fakeBucket(),
		AUTH_STORE: {},
	} as unknown as Env;
	return { app, env };
}

describe("DELETE /api/v1/account", () => {
	it("refuses the sole owner with 409, before asking for a password", async () => {
		const o = await owner();
		privacyDeps.store = () => store as never;
		privacyDeps.now = () => T0;
		const { app, env } = routeApp({ id: o.id, email: o.email, isOwner: true });
		const res = await app.request("/api/v1/account", { method: "DELETE" }, env);
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ code: "sole_owner" });
	});

	it("needs a recent re-auth, then schedules the deletion and revokes the session", async () => {
		await owner();
		const m = await member();
		await store.createSession({ userId: m.id, tokenHash: "sess", ip: null, userAgent: null, now: T0 });
		privacyDeps.store = () => store as never;

		// Signed in an hour ago: stale.
		privacyDeps.now = () => T0 + 60 * 60 * 1000;
		const { app, env } = routeApp({ id: m.id, email: m.email, isOwner: false });
		const stale = await app.request("/api/v1/account", { method: "DELETE" }, env);
		expect(stale.status).toBe(403);
		expect(await stale.json()).toMatchObject({ code: "reauth_required" });

		// Re-confirmed just now.
		await store.markSessionAuthenticated("sess", T0 + 60 * 60 * 1000 - 1000);
		const ok = await app.request("/api/v1/account", { method: "DELETE" }, env);
		expect(ok.status).toBe(202);
		expect(await ok.json()).toMatchObject({ status: "scheduled", purgeAfter: T0 + 60 * 60 * 1000 + 7 * DAY });
		expect(await store.validateSession("sess", T0 + 60 * 60 * 1000)).toBeNull();
	});

	it("refuses an API token", async () => {
		await owner();
		const m = await member();
		privacyDeps.store = () => store as never;
		const { app, env } = routeApp({ id: m.id, email: m.email, isOwner: false }, { method: "token" });
		const res = await app.request("/api/v1/account", { method: "DELETE" }, env);
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ code: "session_required" });
	});
});
