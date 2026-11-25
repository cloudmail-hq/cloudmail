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
	TRUSTED_BROWSER_MAX_PER_USER,
	TRUSTED_BROWSER_MS,
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

	it("go with owner recovery, as a second factor the owner may have lost", async () => {
		const u = await owner();
		await passkey(u.id);
		await store.createSession({ userId: u.id, tokenHash: "s1", ip: null, userAgent: null, now: T0 });
		await store.recoverOwner({ passwordHash: "new", now: T0 + 1 });
		expect(await store.listPasskeys(u.id)).toHaveLength(0);
		expect((await store.getUser(u.id))!.hasPasskey).toBe(false);
		expect(await store.validateSession("s1", T0 + 2)).toBeNull();
	});

	it("keep recovery codes while a passkey remains, and drop them with the last one", async () => {
		const u = await owner();
		const a = await passkey(u.id);
		await store.replaceRecoveryCodes(u.id, ["r1", "r2"]);
		await store.setPendingTotp(u.id, "v1.enc");
		await store.enableTotp(u.id, 1, null);
		// Enabling the app with null keeps the codes the passkey brought.
		expect(await store.countRecoveryCodes(u.id)).toBe(2);
		// Turning the app off keeps them: the passkey still makes it two-factor.
		await store.disableTotp(u.id);
		expect(await store.countRecoveryCodes(u.id)).toBe(2);
		// Removing the last passkey leaves no second factor, so they go.
		expect(await store.deletePasskey(u.id, a.id)).toBe(true);
		expect(await store.countRecoveryCodes(u.id)).toBe(0);
	});

	it("resets every second factor and session for an admin reset", async () => {
		const u = await owner();
		await passkey(u.id);
		await store.setPendingTotp(u.id, "v1.enc");
		await store.enableTotp(u.id, 1, ["r1"]);
		for (let i = 0; i < 6; i++) await store.recordMfaFailure(u.id, T0);
		await store.createSession({ userId: u.id, tokenHash: "s1", ip: null, userAgent: null, now: T0 });
		expect(await store.resetSecondFactors(u.id)).toBe(true);
		const after = (await store.getUser(u.id))!;
		expect(after.totpEnabled).toBe(false);
		expect(after.hasPasskey).toBe(false);
		expect(await store.countRecoveryCodes(u.id)).toBe(0);
		expect(await store.getMfaFailureCount(u.id)).toBe(0);
		expect(await store.validateSession("s1", T0 + 1)).toBeNull();
		expect(await store.resetSecondFactors("usr_nobody")).toBe(false);
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

	it("records a second-factor proof only when one was shown, and drops it with the session", async () => {
		const u = await owner();
		await store.createSession({ userId: u.id, tokenHash: "s1", ip: null, userAgent: null, now: T0 });
		await store.createSession({ userId: u.id, tokenHash: "s2", ip: null, userAgent: null, now: T0, secondFactor: true });
		expect(await store.getSessionSecondFactorAt("s1")).toBeNull();
		expect(await store.getSessionSecondFactorAt("s2")).toBe(T0);
		// A password step-up moves the sign-in time only.
		await store.markSessionAuthenticated("s1", T0 + 1_000);
		expect(await store.getSessionSecondFactorAt("s1")).toBeNull();
		await store.markSessionAuthenticated("s1", T0 + 2_000, { secondFactor: true });
		expect(await store.getSessionSecondFactorAt("s1")).toBe(T0 + 2_000);
		expect(await store.getSessionAuthenticatedAt("s1")).toBe(T0 + 2_000);
		expect(await store.getSessionSecondFactorAt("unknown")).toBeNull();
		await store.resetSecondFactors(u.id);
		expect(await store.getSessionSecondFactorAt("s2")).toBeNull();
	});
});

describe("two-factor changes that race each other", () => {
	it("refuse to remove the last factor inside the transaction that removes it", async () => {
		const u = await owner();
		const a = await passkey(u.id, "cred-a");
		const b = await passkey(u.id, "cred-b");
		// Two passkeys, no app: the first goes, the last is refused.
		expect(await store.deletePasskey(u.id, a.id, { requireOneLeft: true })).toBe(true);
		await expect(store.deletePasskey(u.id, b.id, { requireOneLeft: true })).rejects.toThrow("last_factor");
		expect(await store.listPasskeys(u.id)).toHaveLength(1);
		// With the app on, the last passkey can go; then the app cannot.
		await store.setPendingTotp(u.id, "v1.enc");
		await store.enableTotp(u.id, 1, ["r1"]);
		expect(await store.deletePasskey(u.id, b.id, { requireOneLeft: true })).toBe(true);
		await expect(store.disableTotp(u.id, { requireOneLeft: true })).rejects.toThrow("last_factor");
		expect((await store.getUser(u.id))!.totpEnabled).toBe(true);
		// Someone else's passkey id is not a "last factor" question: plain false.
		expect(await store.deletePasskey(u.id, "pk_nope", { requireOneLeft: true })).toBe(false);
	});

	it("store a first set of recovery codes only once", async () => {
		const u = await owner();
		expect(await store.addRecoveryCodesIfNone(u.id, ["a1", "a2"])).toBe(true);
		expect(await store.addRecoveryCodesIfNone(u.id, ["b1"])).toBe(false);
		expect(await store.countRecoveryCodes(u.id)).toBe(2);
		expect(await store.consumeRecoveryCode(u.id, "a1")).toBe(true);
	});

	it("drop a passkey-only member's codes when disabling removes their passkeys", async () => {
		const m = await member();
		await passkey(m.id);
		await store.replaceRecoveryCodes(m.id, ["r1"]);
		await store.setDisabled(m.id, true);
		expect(await store.countRecoveryCodes(m.id)).toBe(0);
	});
});

describe("second-step challenges", () => {
	it("can be read without spending an attempt", async () => {
		const u = await owner();
		await store.createMfaChallenge({ userId: u.id, challengeHash: "c1", now: T0 });
		for (let i = 0; i < 10; i++) expect(await store.peekMfaChallenge("c1", T0)).toEqual({ userId: u.id });
		// Still all five real attempts left.
		for (let i = 0; i < 5; i++) expect(await store.useMfaChallenge("c1", T0)).toEqual({ userId: u.id });
		expect(await store.useMfaChallenge("c1", T0)).toBeNull();
		expect(await store.peekMfaChallenge("c1", T0)).toBeNull();
		expect(await store.peekMfaChallenge("unknown", T0)).toBeNull();
	});
});

describe("app-code suspension", () => {
	it("starts at 100 wrong codes in a row and lifts a day after the last", async () => {
		const u = await owner();
		for (let i = 0; i < 99; i++) await store.recordMfaFailure(u.id, T0);
		expect(await store.isTotpSuspended(u.id, T0)).toBe(false);
		await store.recordMfaFailure(u.id, T0);
		expect(await store.isTotpSuspended(u.id, T0)).toBe(true);
		const lockEnds = T0 + 15 * 60_000;
		expect(await store.isTotpSuspended(u.id, lockEnds + 23 * 3_600_000)).toBe(true);
		expect(await store.isTotpSuspended(u.id, lockEnds + 24 * 3_600_000)).toBe(false);
		expect(await store.isTotpSuspended("usr_nobody", T0)).toBe(false);
	});
});

describe("trusted browsers", () => {
	const trust = (userId: string, tokenHash: string, now = T0, replaceTokenHash: string | null = null) =>
		store.trustBrowser({ userId, tokenHash, replaceTokenHash, ip: "203.0.113.7", userAgent: "UA", now });

	it("works for its own user until 30 days after it was trusted, and records use", async () => {
		const u = await owner();
		const m = await member();
		await trust(u.id, "t1");
		expect(await store.useTrustedBrowser(m.id, "t1", T0 + 1000)).toBe(false);
		expect(await store.useTrustedBrowser(u.id, "t1", T0 + 1000)).toBe(true);
		const [row] = await store.listTrustedBrowsers(u.id, T0 + 1000, "t1");
		expect(row).toMatchObject({ current: true, lastUsedAt: T0 + 1000, expiresAt: T0 + TRUSTED_BROWSER_MS });
		expect(await store.useTrustedBrowser(u.id, "t1", T0 + TRUSTED_BROWSER_MS - 1)).toBe(true);
		expect(await store.useTrustedBrowser(u.id, "t1", T0 + TRUSTED_BROWSER_MS)).toBe(false);
		expect(await store.listTrustedBrowsers(u.id, T0 + TRUSTED_BROWSER_MS)).toEqual([]);
	});

	it("replaces the browser's previous token and keeps only the newest", async () => {
		const u = await owner();
		await trust(u.id, "old");
		await trust(u.id, "new", T0 + 1, "old");
		expect(await store.useTrustedBrowser(u.id, "old", T0 + 2)).toBe(false);
		expect(await store.useTrustedBrowser(u.id, "new", T0 + 2)).toBe(true);

		for (let i = 0; i < TRUSTED_BROWSER_MAX_PER_USER + 3; i++) await trust(u.id, `t${i}`, T0 + 10 + i);
		const list = await store.listTrustedBrowsers(u.id, T0 + 100);
		expect(list).toHaveLength(TRUSTED_BROWSER_MAX_PER_USER);
		expect(await store.useTrustedBrowser(u.id, "t0", T0 + 100)).toBe(false);
		expect(await store.useTrustedBrowser(u.id, `t${TRUSTED_BROWSER_MAX_PER_USER + 2}`, T0 + 100)).toBe(true);
	});

	it("keeps the new browser even when the others were trusted at the same moment", async () => {
		const u = await owner();
		for (let i = 0; i < TRUSTED_BROWSER_MAX_PER_USER + 2; i++) await trust(u.id, `s${i}`, T0 + 5);
		expect(await store.useTrustedBrowser(u.id, `s${TRUSTED_BROWSER_MAX_PER_USER + 1}`, T0 + 6)).toBe(true);
		expect(await store.listTrustedBrowsers(u.id, T0 + 6)).toHaveLength(TRUSTED_BROWSER_MAX_PER_USER);
	});

	it("forgets the browser a session ran in when that session is signed out", async () => {
		const u = await owner();
		await trust(u.id, "t1");
		const plain = await store.createSession({ userId: u.id, tokenHash: "s-plain", ip: null, userAgent: null, now: T0 + 1 });
		const linked = await store.createSession({
			userId: u.id,
			tokenHash: "s-linked",
			ip: null,
			userAgent: null,
			now: T0 + 1,
			trustTokenHash: "t1",
		});
		// A session from another browser leaves t1 alone.
		expect(await store.revokeSession(u.id, plain.id)).toBe(true);
		expect(await store.useTrustedBrowser(u.id, "t1", T0 + 2)).toBe(true);
		// Plain sign-out keeps it too.
		await store.deleteSession("s-linked");
		expect(await store.useTrustedBrowser(u.id, "t1", T0 + 2)).toBe(true);
		// Signed out from Settings: forgotten.
		const again = await store.createSession({
			userId: u.id,
			tokenHash: "s-again",
			ip: null,
			userAgent: null,
			now: T0 + 3,
			trustTokenHash: "t1",
		});
		expect(linked.id).not.toBe(again.id);
		expect(await store.revokeSession(u.id, again.id)).toBe(true);
		expect(await store.useTrustedBrowser(u.id, "t1", T0 + 4)).toBe(false);
	});

	it("goes with owner recovery, account deletion and scheduled deletion", async () => {
		const u = await owner();
		await trust(u.id, "t1");
		await store.recoverOwner({ passwordHash: "h2", now: T0 + 1 });
		expect(await store.listTrustedBrowsers(u.id, T0 + 2)).toEqual([]);

		const m = await member();
		await trust(m.id, "t2");
		await store.deleteUser(m.id);
		expect(await store.listTrustedBrowsers(m.id, T0 + 2)).toEqual([]);

		const m2 = await member("m2@example.com");
		await trust(m2.id, "t3");
		const scheduled = await store.scheduleAccountDeletion({ userId: m2.id, now: T0 + 1, graceMs: 1000, mailboxes: [] });
		expect(scheduled.ok).toBe(true);
		expect(await store.listTrustedBrowsers(m2.id, T0 + 2)).toEqual([]);
	});

	it("revokes by id only for its user", async () => {
		const u = await owner();
		const m = await member();
		const b = await trust(u.id, "t1");
		expect(await store.revokeTrustedBrowser(m.id, b.id)).toBe(false);
		expect(await store.revokeTrustedBrowser(u.id, b.id)).toBe(true);
		expect(await store.useTrustedBrowser(u.id, "t1", T0 + 1)).toBe(false);
	});

	it("goes when the last second factor goes, and stays while one remains", async () => {
		const u = await owner();
		const first = await passkey(u.id, "cred-a");
		const second = await passkey(u.id, "cred-b");
		await trust(u.id, "t1");
		await store.deletePasskey(u.id, first.id);
		expect(await store.useTrustedBrowser(u.id, "t1", T0 + 1)).toBe(true);
		await store.deletePasskey(u.id, second.id);
		expect(await store.useTrustedBrowser(u.id, "t1", T0 + 2)).toBe(false);
	});

	it("goes when the app was the last factor, and stays while a passkey remains", async () => {
		const u = await owner();
		await store.setPendingTotp(u.id, "v1.enc");
		await store.enableTotp(u.id, 1, ["r1"]);
		await trust(u.id, "t1");
		await store.disableTotp(u.id);
		expect(await store.useTrustedBrowser(u.id, "t1", T0 + 1)).toBe(false);

		await passkey(u.id, "cred-kept");
		await store.setPendingTotp(u.id, "v1.enc");
		await store.enableTotp(u.id, 2, null);
		await trust(u.id, "t2");
		await store.disableTotp(u.id);
		// A passkey still makes it two-factor: the store keeps it (the route forgets the others).
		expect(await store.useTrustedBrowser(u.id, "t2", T0 + 2)).toBe(true);
	});

	it("goes with every session on disable and admin two-factor reset", async () => {
		const m = await member();
		await passkey(m.id);
		await trust(m.id, "t1");
		await store.resetSecondFactors(m.id);
		expect(await store.listTrustedBrowsers(m.id, T0 + 1)).toEqual([]);

		await passkey(m.id, "cred-2");
		await trust(m.id, "t2");
		await store.setDisabled(m.id, true);
		expect(await store.listTrustedBrowsers(m.id, T0 + 1)).toEqual([]);
	});
});
