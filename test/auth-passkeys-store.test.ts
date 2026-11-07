// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Passkey storage in `AuthStore` against real SQLite: challenge single use,
 * expiry and binding, the counter compare-and-set, and the cascades. These are
 * query semantics, so a fake would assert nothing.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
	AuthStore,
	PASSKEY_MAX_PER_USER,
	WEBAUTHN_CHALLENGE_MS,
	type AuthSql,
} from "../workers/auth/store-core";

const T0 = Date.UTC(2026, 5, 1);

function open(): AuthStore {
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

beforeEach(() => {
	store = open();
});

async function owner() {
	const r = await store.createOwner({ email: "owner@example.com", name: "Owner", passwordHash: "h", now: T0 });
	if (!r.ok) throw new Error("setup failed");
	return r.user;
}

async function member(email = "member@example.com") {
	await store.createInvite({
		tokenHash: `inv-${email}`,
		email,
		role: "member",
		mailboxes: [],
		createdBy: null,
		expiresAt: T0 + 86_400_000,
		now: T0,
	});
	const r = await store.acceptInvite({ tokenHash: `inv-${email}`, name: "M", passwordHash: "h", now: T0 });
	if (!r.ok) throw new Error(r.reason);
	return r.user;
}

function passkey(userId: string, credentialId = "cred-1", counter = 0) {
	return store.addPasskey({
		userId,
		credentialId,
		publicKey: "pk-bytes",
		counter,
		transports: ["internal", "hybrid"],
		aaguid: "00000000-0000-0000-0000-000000000000",
		deviceType: "multiDevice",
		backedUp: true,
		name: "Laptop",
		now: T0,
	});
}

describe("WebAuthn challenges", () => {
	it("works once", async () => {
		const u = await owner();
		expect(await store.createWebAuthnChallenge({ challengeHash: "c1", purpose: "register", userId: u.id, now: T0 })).toBe(true);
		expect(await store.consumeWebAuthnChallenge("c1", "register", u.id, T0 + 1000)).toBe(true);
		expect(await store.consumeWebAuthnChallenge("c1", "register", u.id, T0 + 1000)).toBe(false);
	});

	it("expires after five minutes", async () => {
		const u = await owner();
		await store.createWebAuthnChallenge({ challengeHash: "c1", purpose: "register", userId: u.id, now: T0 });
		expect(await store.consumeWebAuthnChallenge("c1", "register", u.id, T0 + WEBAUTHN_CHALLENGE_MS)).toBe(false);
		await store.createWebAuthnChallenge({ challengeHash: "c2", purpose: "register", userId: u.id, now: T0 });
		expect(await store.consumeWebAuthnChallenge("c2", "register", u.id, T0 + WEBAUTHN_CHALLENGE_MS - 1)).toBe(true);
	});

	it("is bound to its purpose, and a mismatch burns it", async () => {
		const u = await owner();
		await store.createWebAuthnChallenge({ challengeHash: "c1", purpose: "register", userId: u.id, now: T0 });
		expect(await store.consumeWebAuthnChallenge("c1", "authenticate", u.id, T0)).toBe(false);
		// Burnt by the wrong use, so the right one cannot follow.
		expect(await store.consumeWebAuthnChallenge("c1", "register", u.id, T0)).toBe(false);
	});

	it("is bound to the user it was issued to", async () => {
		const u = await owner();
		const m = await member();
		await store.createWebAuthnChallenge({ challengeHash: "c1", purpose: "register", userId: u.id, now: T0 });
		expect(await store.consumeWebAuthnChallenge("c1", "register", m.id, T0)).toBe(false);
		// A usernameless challenge only works as one.
		await store.createWebAuthnChallenge({ challengeHash: "c2", purpose: "authenticate", userId: null, now: T0 });
		expect(await store.consumeWebAuthnChallenge("c2", "authenticate", u.id, T0)).toBe(false);
		await store.createWebAuthnChallenge({ challengeHash: "c3", purpose: "authenticate", userId: null, now: T0 });
		expect(await store.consumeWebAuthnChallenge("c3", "authenticate", null, T0)).toBe(true);
	});

	it("ends with the user's sessions (disable)", async () => {
		await owner();
		const m = await member();
		await store.createWebAuthnChallenge({ challengeHash: "c1", purpose: "register", userId: m.id, now: T0 });
		await store.setDisabled(m.id, true);
		expect(await store.consumeWebAuthnChallenge("c1", "register", m.id, T0)).toBe(false);
	});
});

describe("passkeys", () => {
	it("stores what sign-in needs and lists without key material", async () => {
		const u = await owner();
		const added = await passkey(u.id);
		expect(added).toMatchObject({ name: "Laptop", deviceType: "multiDevice", backedUp: true, lastUsedAt: null });
		expect(added.transports).toEqual(["internal", "hybrid"]);

		const [listed] = await store.listPasskeys(u.id);
		expect(listed).not.toHaveProperty("publicKey");
		expect(listed).not.toHaveProperty("credentialId");

		const found = await store.getPasskeyByCredentialId("cred-1");
		expect(found?.user.id).toBe(u.id);
		expect(found?.passkey).toMatchObject({ publicKey: "pk-bytes", counter: 0 });
	});

	it("refuses a credential that is already registered, to anyone", async () => {
		const u = await owner();
		const m = await member();
		await passkey(u.id);
		await expect(passkey(m.id)).rejects.toThrow("passkey_exists");
	});

	it("caps passkeys per user", async () => {
		const u = await owner();
		for (let i = 0; i < PASSKEY_MAX_PER_USER; i++) await passkey(u.id, `cred-${i}`);
		await expect(passkey(u.id, "one-too-many")).rejects.toThrow("passkey_limit");
	});

	it("advances the counter and refuses one that goes backwards or repeats", async () => {
		const u = await owner();
		await passkey(u.id, "cred-1", 5);
		expect(await store.recordPasskeyUse({ credentialId: "cred-1", newCounter: 6, backedUp: true, now: T0 + 1 })).toBe(true);
		expect(await store.recordPasskeyUse({ credentialId: "cred-1", newCounter: 6, backedUp: true, now: T0 + 2 })).toBe(false);
		expect(await store.recordPasskeyUse({ credentialId: "cred-1", newCounter: 3, backedUp: true, now: T0 + 3 })).toBe(false);
		const found = await store.getPasskeyByCredentialId("cred-1");
		expect(found?.passkey.counter).toBe(6);
		expect(found?.passkey.lastUsedAt).toBe(T0 + 1);
	});

	it("always accepts authenticators that do not count (counter stays 0)", async () => {
		const u = await owner();
		await passkey(u.id, "cred-1", 0);
		expect(await store.recordPasskeyUse({ credentialId: "cred-1", newCounter: 0, backedUp: true, now: T0 })).toBe(true);
		expect(await store.recordPasskeyUse({ credentialId: "cred-1", newCounter: 0, backedUp: true, now: T0 })).toBe(true);
		// Once it starts counting, zero is a regression.
		expect(await store.recordPasskeyUse({ credentialId: "cred-1", newCounter: 4, backedUp: true, now: T0 })).toBe(true);
		expect(await store.recordPasskeyUse({ credentialId: "cred-1", newCounter: 0, backedUp: true, now: T0 })).toBe(false);
	});

	it("renames and deletes only the owner's own passkeys", async () => {
		const u = await owner();
		const m = await member();
		const p = await passkey(u.id);
		expect(await store.renamePasskey(m.id, p.id, "stolen")).toBeNull();
		expect(await store.deletePasskey(m.id, p.id)).toBe(false);
		expect((await store.renamePasskey(u.id, p.id, "Phone"))?.name).toBe("Phone");
		expect(await store.deletePasskey(u.id, p.id)).toBe(true);
		expect(await store.listPasskeys(u.id)).toEqual([]);
	});

	it("are removed when the user is disabled or deleted", async () => {
		await owner();
		const a = await member("a@example.com");
		const b = await member("b@example.com");
		await passkey(a.id, "cred-a");
		await passkey(b.id, "cred-b");
		await store.setDisabled(a.id, true);
		expect(await store.getPasskeyByCredentialId("cred-a")).toBeNull();
		await store.deleteUser(b.id);
		expect(await store.getPasskeyByCredentialId("cred-b")).toBeNull();
	});

	it("survive owner recovery, while the owner's sessions do not", async () => {
		const u = await owner();
		await passkey(u.id);
		await store.createSession({ userId: u.id, tokenHash: "s1", ip: null, userAgent: null, now: T0 });
		await store.recoverOwner({ passwordHash: "new", now: T0 + 1 });
		expect(await store.listPasskeys(u.id)).toHaveLength(1);
		expect(await store.validateSession("s1", T0 + 2)).toBeNull();
	});
});

describe("session freshness", () => {
	it("is the sign-in time until a step-up moves it", async () => {
		const u = await owner();
		await store.createSession({ userId: u.id, tokenHash: "s1", ip: null, userAgent: null, now: T0 });
		expect(await store.getSessionAuthenticatedAt("s1")).toBe(T0);
		expect(await store.markSessionAuthenticated("s1", T0 + 60_000)).toBe(true);
		expect(await store.getSessionAuthenticatedAt("s1")).toBe(T0 + 60_000);
		expect(await store.getSessionAuthenticatedAt("unknown")).toBeNull();
		expect(await store.markSessionAuthenticated("unknown", T0)).toBe(false);
	});
});
