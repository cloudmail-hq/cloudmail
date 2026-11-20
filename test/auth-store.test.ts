// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * AuthStore semantics against real SQLite (`node:sqlite`).
 *
 * The guarantees that matter here are query semantics — single-use tokens,
 * compare-and-set replay protection, "only while no users exist" — so a fake
 * returning canned rows would assert nothing. The transaction adapter uses real
 * BEGIN/COMMIT/ROLLBACK, so a throw inside a transaction leaves no partial rows,
 * as `transactionSync` guarantees in the Durable Object.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
	AUTH_MIGRATION_NAMES,
	AuthStore,
	ACCOUNT_ALERT_THRESHOLD,
	LOCKOUT_THRESHOLD,
	RECOVERY_LOCK_MS,
	RECOVERY_MAX_FAILURES,
	MFA_CHALLENGE_MS,
	MFA_MAX_ATTEMPTS,
	SESSION_ABSOLUTE_MS,
	SESSION_IDLE_MS,
	TOUCH_INTERVAL_MS,
	lockoutDuration,
	type AuthSql,
} from "../workers/auth/store-core";

const T0 = Date.UTC(2026, 5, 1);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function adapter(db: DatabaseSync): { sql: AuthSql; tx: <T>(fn: () => T) => T } {
	return {
		sql: {
			exec(query: string, ...bindings: unknown[]) {
				const stmt = db.prepare(query);
				const rows = stmt.all(...(bindings as never[])) as any[];
				return { toArray: () => rows };
			},
		},
		tx<T>(fn: () => T): T {
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
		},
	};
}

let db: DatabaseSync;
let store: AuthStore;

beforeEach(() => {
	db = new DatabaseSync(":memory:");
	const { sql, tx } = adapter(db);
	store = new AuthStore(sql, tx);
});

async function owner() {
	const r = await store.createOwner({
		email: "  Owner@Example.com ",
		name: "Owner",
		passwordHash: "hash-owner",
		now: T0,
	});
	if (!r.ok) throw new Error("setup failed");
	return r.user;
}

async function member(email = "member@example.com") {
	await store.createInvite({
		tokenHash: `inv-${email}`,
		email,
		role: "member",
		mailboxes: ["box@example.com"],
		createdBy: null,
		expiresAt: T0 + 7 * DAY,
		now: T0,
	});
	const r = await store.acceptInvite({
		tokenHash: `inv-${email}`,
		name: "Member",
		passwordHash: "hash-member",
		now: T0,
	});
	if (!r.ok) throw new Error(r.reason);
	return r.user;
}

function session(userId: string, tokenHash = "sess-1", now = T0) {
	return store.createSession({ userId, tokenHash, ip: "203.0.113.1", userAgent: "test", now });
}

/** Applied migration names, in the order they ran. */
function appliedNames(db: DatabaseSync): string[] {
	return (db.prepare(`SELECT name FROM applied_migrations ORDER BY rowid`).all() as { name: string }[]).map(
		(row) => row.name,
	);
}

describe("schema", () => {
	it("upgrades a database created by the first shipped migration", async () => {
		// Recreate the v1 shape: run the current store, then roll the version and
		// the v2 objects back, and reopen.
		const old = new DatabaseSync(":memory:");
		const { sql, tx } = adapter(old);
		const first = new AuthStore(sql, tx);
		const created = await first.createOwner({ email: "o@example.com", name: "O", passwordHash: "h", now: T0 });
		if (!created.ok) throw new Error("setup failed");
		old.exec(`DROP TABLE login_attempts`);
		old.exec(`DROP TABLE failure_windows`);
		old.exec(`ALTER TABLE users DROP COLUMN mfa_failures`);
		old.exec(`ALTER TABLE users DROP COLUMN mfa_locked_until`);
		// Rewind to how a build from before named migrations left it: one ran.
		old.exec(`DROP TABLE applied_migrations`);
		old.exec(`INSERT INTO meta (key, value) VALUES ('schema_version', '1')`);

		const upgraded = new AuthStore(sql, tx);
		expect(appliedNames(old)).toEqual(AUTH_MIGRATION_NAMES);
		expect(old.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()).toBeUndefined();
		expect((await upgraded.recordMfaFailure(created.user.id, T0)).lockedUntil).toBe(0);
		expect((await upgraded.recordLoginFailure("o@example.com", "198.51.100.1", T0)).lockedUntil).toBe(0);
		expect((await upgraded.getUser(created.user.id))!.email).toBe("o@example.com");
	});

	it("does not re-run migrations a numbered deployment already applied", async () => {
		// What production holds today: both shipped migrations recorded as a count.
		const live = new DatabaseSync(":memory:");
		const { sql, tx } = adapter(live);
		const first = new AuthStore(sql, tx);
		const created = await first.createOwner({ email: "o@example.com", name: "O", passwordHash: "h", now: T0 });
		if (!created.ok) throw new Error("setup failed");
		await first.recordLoginFailure("o@example.com", "198.51.100.1", T0);
		live.exec(`DROP TABLE applied_migrations`);
		live.exec(`INSERT INTO meta (key, value) VALUES ('schema_version', '2')`);

		// Re-running 0002 would fail on its ALTER TABLE ADD COLUMN; reaching here
		// with the data intact is the assertion.
		const reopened = new AuthStore(sql, tx);
		expect(appliedNames(live)).toEqual(AUTH_MIGRATION_NAMES);
		expect((await reopened.getUser(created.user.id))!.email).toBe("o@example.com");
		const attempts = live.prepare(`SELECT failures FROM login_attempts`).get() as { failures: number };
		expect(attempts.failures).toBe(1);
	});

	it("records each migration by name and is idempotent on reopen", () => {
		expect(appliedNames(db)).toEqual(AUTH_MIGRATION_NAMES);
		expect(new Set(AUTH_MIGRATION_NAMES).size).toBe(AUTH_MIGRATION_NAMES.length);
		const { sql, tx } = adapter(db);
		expect(() => new AuthStore(sql, tx)).not.toThrow();
	});
});

describe("setup", () => {
	it("creates the owner once; the second attempt fails", async () => {
		expect(await store.isSetupRequired()).toBe(true);
		const user = await owner();
		expect(user.email).toBe("owner@example.com");
		expect(user.isOwner).toBe(true);
		expect(user.id).toMatch(/^usr_[A-Za-z0-9]{22}$/);
		expect(await store.isSetupRequired()).toBe(false);

		const second = await store.createOwner({
			email: "attacker@example.com",
			name: "X",
			passwordHash: "h",
			now: T0,
		});
		expect(second).toEqual({ ok: false, reason: "already_setup" });
		expect(await store.listUsers()).toHaveLength(1);
	});

	it("concurrent setup attempts yield exactly one owner", async () => {
		const results = await Promise.all(
			[1, 2, 3].map((i) =>
				store.createOwner({ email: `o${i}@example.com`, name: "O", passwordHash: "h", now: T0 }),
			),
		);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
	});

	it("persists the generated setup token", async () => {
		const a = await store.ensureGeneratedSetupToken();
		expect(a.length).toBeGreaterThanOrEqual(43);
		expect(await store.ensureGeneratedSetupToken()).toBe(a);
	});

	it("getOrInitMeta stores the first fallback only", async () => {
		expect(await store.getOrInitMeta("auth_secret", "first")).toBe("first");
		expect(await store.getOrInitMeta("auth_secret", "second")).toBe("first");
	});
});

describe("login lockout", () => {
	it("computes exponential backoff capped at 15 minutes", () => {
		expect(lockoutDuration(4)).toBe(0);
		expect(lockoutDuration(5)).toBe(30_000);
		expect(lockoutDuration(6)).toBe(60_000);
		expect(lockoutDuration(9)).toBe(480_000);
		expect(lockoutDuration(10)).toBe(15 * MIN);
		expect(lockoutDuration(1000)).toBe(15 * MIN);
	});

	it("locks an (email, ip) pair after the threshold and resets on success", async () => {
		const u = await owner();
		const IP = "198.51.100.1";
		for (let i = 1; i < LOCKOUT_THRESHOLD; i++) {
			expect((await store.recordLoginFailure("owner@example.com", IP, T0)).lockedUntil).toBe(0);
		}
		expect((await store.recordLoginFailure("OWNER@example.com", IP, T0)).lockedUntil).toBe(T0 + 30_000);
		expect((await store.recordLoginFailure("owner@example.com", IP, T0)).lockedUntil).toBe(T0 + 60_000);
		expect(await store.getLoginLock(" Owner@Example.com", IP, T0)).toEqual({ lockedUntil: T0 + 60_000 });
		// Expired locks read as 0.
		expect(await store.getLoginLock("owner@example.com", IP, T0 + 60_000)).toEqual({ lockedUntil: 0 });

		await store.recordLoginSuccess(u.id, IP, T0 + HOUR);
		expect(await store.getLoginLock("owner@example.com", IP, T0 + HOUR)).toEqual({ lockedUntil: 0 });
		const c = await store.getLoginCandidate("owner@example.com");
		expect(c!.passwordHash).toBe("hash-owner");
		expect(c!.user.lastLoginAt).toBe(T0 + HOUR);
		expect((await store.recordLoginFailure("owner@example.com", IP, T0 + HOUR)).lockedUntil).toBe(0);
	});

	it("does not let one address lock the account for everyone else", async () => {
		await owner();
		for (let i = 0; i < 20; i++) await store.recordLoginFailure("owner@example.com", "198.51.100.66", T0);
		expect((await store.getLoginLock("owner@example.com", "198.51.100.66", T0)).lockedUntil).toBeGreaterThan(T0);
		expect(await store.getLoginLock("owner@example.com", "203.0.113.7", T0)).toEqual({ lockedUntil: 0 });
	});

	it("locks unknown emails exactly like real ones", async () => {
		await owner();
		const real: number[] = [];
		const unknown: number[] = [];
		for (let i = 0; i < 7; i++) {
			real.push((await store.recordLoginFailure("owner@example.com", "198.51.100.1", T0)).lockedUntil);
			unknown.push((await store.recordLoginFailure("nobody@example.com", "198.51.100.1", T0)).lockedUntil);
		}
		expect(unknown).toEqual(real);
		expect(await store.getLoginLock("nobody@example.com", "198.51.100.1", T0)).toEqual(
			await store.getLoginLock("owner@example.com", "198.51.100.1", T0),
		);
	});

	it("raises an account-wide alert once past 100 failures in an hour, without locking", async () => {
		await owner();
		const alerts: number[] = [];
		for (let i = 1; i <= 130; i++) {
			const r = await store.recordLoginFailure("owner@example.com", `10.0.${i >> 8}.${i & 255}`, T0 + i);
			if (r.accountAlert) alerts.push(i);
			// One failure per IP: none of them is locked.
			expect(r.lockedUntil).toBe(0);
		}
		expect(alerts).toEqual([ACCOUNT_ALERT_THRESHOLD + 1]);
		// A new window can alert again.
		let again = false;
		for (let i = 0; i <= ACCOUNT_ALERT_THRESHOLD; i++) {
			again ||= (await store.recordLoginFailure("owner@example.com", `10.9.0.${i & 255}`, T0 + HOUR + 1)).accountAlert;
		}
		expect(again).toBe(true);
	});

	it("purges stale attempt rows opportunistically", async () => {
		await owner();
		await store.recordLoginFailure("a@example.com", "198.51.100.1", T0);
		await store.recordLoginFailure("b@example.com", "198.51.100.1", T0 + 2 * DAY);
		const rows = db.prepare(`SELECT email FROM login_attempts ORDER BY email`).all() as any[];
		expect(rows.map((r) => r.email)).toEqual(["b@example.com"]);
	});

	it("returns null for unknown emails", async () => {
		expect(await store.getLoginCandidate("nobody@example.com")).toBeNull();
	});
});

describe("sessions", () => {
	it("validates, slides at most hourly, and reports the earlier deadline", async () => {
		const u = await owner();
		const s = await session(u.id);
		expect(s.id).toMatch(/^ses_/);
		expect(s.expiresAt).toBe(T0 + SESSION_IDLE_MS);

		const early = await store.validateSession("sess-1", T0 + 10 * MIN);
		expect(early!.user.id).toBe(u.id);
		expect(early!.session.lastSeenAt).toBe(T0);

		const later = await store.validateSession("sess-1", T0 + TOUCH_INTERVAL_MS);
		expect(later!.session.lastSeenAt).toBe(T0 + TOUCH_INTERVAL_MS);
		expect(later!.session.expiresAt).toBe(T0 + TOUCH_INTERVAL_MS + SESSION_IDLE_MS);
	});

	it("expires after the idle window", async () => {
		const u = await owner();
		await session(u.id);
		expect(await store.validateSession("sess-1", T0 + SESSION_IDLE_MS)).toBeNull();
		// And the row is gone, not just hidden.
		expect(await store.validateSession("sess-1", T0)).toBeNull();
	});

	it("expires at the absolute deadline even when kept active", async () => {
		const u = await owner();
		await session(u.id);
		let t = T0;
		while (t < T0 + SESSION_ABSOLUTE_MS - DAY) {
			t += DAY;
			expect(await store.validateSession("sess-1", t)).not.toBeNull();
		}
		const last = await store.validateSession("sess-1", t);
		expect(last!.session.expiresAt).toBe(T0 + SESSION_ABSOLUTE_MS);
		expect(await store.validateSession("sess-1", T0 + SESSION_ABSOLUTE_MS)).toBeNull();
	});

	it("lists, revokes by id (scoped to user), and revokes others", async () => {
		const o = await owner();
		const m = await member();
		const a = await session(o.id, "a");
		await session(o.id, "b");
		await session(o.id, "c");
		await session(m.id, "m");

		expect(await store.listSessions(o.id, T0)).toHaveLength(3);
		expect(await store.revokeSession(m.id, a.id)).toBe(false);
		expect(await store.revokeSession(o.id, a.id)).toBe(true);
		expect(await store.revokeOtherSessions(o.id, "b")).toBe(1);
		expect((await store.listSessions(o.id, T0)).map((s) => s.userId)).toEqual([o.id]);
		expect(await store.revokeOtherSessions(o.id, null)).toBe(1);
		expect(await store.validateSession("m", T0)).not.toBeNull();

		await store.deleteSession("m");
		expect(await store.validateSession("m", T0)).toBeNull();
	});

	it("purges expired sessions when a new one is created", async () => {
		const u = await owner();
		await session(u.id, "old");
		await session(u.id, "new", T0 + SESSION_ABSOLUTE_MS);
		const n = db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as any;
		expect(Number(n.n)).toBe(1);
	});

	it("rejects sessions of disabled users", async () => {
		await owner();
		const m = await member();
		await session(m.id, "m");
		expect(await store.setDisabled(m.id, true)).toBe(true);
		expect(await store.validateSession("m", T0)).toBeNull();
		// Disabling deleted the session; re-enabling does not resurrect it.
		await store.setDisabled(m.id, false);
		expect(await store.validateSession("m", T0)).toBeNull();
		await session(m.id, "m2");
		expect(await store.validateSession("m2", T0)).not.toBeNull();
	});
});

describe("MFA challenges", () => {
	it("allows five attempts, then dies", async () => {
		const u = await owner();
		await store.createMfaChallenge({ userId: u.id, challengeHash: "ch", now: T0 });
		for (let i = 0; i < MFA_MAX_ATTEMPTS; i++) {
			expect(await store.useMfaChallenge("ch", T0)).toEqual({ userId: u.id });
		}
		expect(await store.useMfaChallenge("ch", T0)).toBeNull();
		expect(await store.useMfaChallenge("ch", T0)).toBeNull();
	});

	it("expires after five minutes and can be deleted", async () => {
		const u = await owner();
		await store.createMfaChallenge({ userId: u.id, challengeHash: "ch", now: T0 });
		expect(await store.useMfaChallenge("ch", T0 + MFA_CHALLENGE_MS)).toBeNull();
		await store.createMfaChallenge({ userId: u.id, challengeHash: "ch2", now: T0 });
		await store.deleteMfaChallenge("ch2");
		expect(await store.useMfaChallenge("ch2", T0)).toBeNull();
		expect(await store.useMfaChallenge("unknown", T0)).toBeNull();
	});
});

describe("second-factor lockout", () => {
	it("counts failures per account across challenges, with exponential backoff", async () => {
		const u = await owner();
		// Five challenges, one wrong code each: the per-challenge cap never trips.
		for (let i = 1; i < LOCKOUT_THRESHOLD; i++) {
			await store.createMfaChallenge({ userId: u.id, challengeHash: `ch${i}`, now: T0 });
			expect(await store.useMfaChallenge(`ch${i}`, T0)).not.toBeNull();
			expect((await store.recordMfaFailure(u.id, T0)).lockedUntil).toBe(0);
		}
		expect((await store.recordMfaFailure(u.id, T0)).lockedUntil).toBe(T0 + 30_000);
		expect(await store.getMfaLock(u.id, T0 + 1)).toEqual({ lockedUntil: T0 + 30_000 });
		expect((await store.recordMfaFailure(u.id, T0 + 30_000)).lockedUntil).toBe(T0 + 90_000);
		for (let i = 0; i < 20; i++) await store.recordMfaFailure(u.id, T0);
		expect((await store.recordMfaFailure(u.id, T0)).lockedUntil).toBe(T0 + 15 * MIN);
		expect(await store.getMfaLock(u.id, T0 + 15 * MIN)).toEqual({ lockedUntil: 0 });
	});

	it("resets on a successful sign-in and when 2FA is turned off", async () => {
		const u = await owner();
		for (let i = 0; i < 6; i++) await store.recordMfaFailure(u.id, T0);
		await store.recordLoginSuccess(u.id, "198.51.100.1", T0);
		expect(await store.getMfaLock(u.id, T0)).toEqual({ lockedUntil: 0 });
		expect((await store.recordMfaFailure(u.id, T0)).lockedUntil).toBe(0);

		for (let i = 0; i < 6; i++) await store.recordMfaFailure(u.id, T0);
		await store.disableTotp(u.id);
		expect(await store.getMfaLock(u.id, T0)).toEqual({ lockedUntil: 0 });
	});
});

describe("recovery limit", () => {
	it("closes recovery for an hour after 10 failures within an hour", async () => {
		for (let i = 1; i < RECOVERY_MAX_FAILURES; i++) {
			expect(await store.recordRecoveryFailure(T0 + i)).toEqual({ lockedUntil: 0, failures: i });
		}
		const t = T0 + RECOVERY_MAX_FAILURES;
		expect((await store.recordRecoveryFailure(t)).lockedUntil).toBe(t + RECOVERY_LOCK_MS);
		expect(await store.getRecoveryLock(t + 1)).toEqual({ lockedUntil: t + RECOVERY_LOCK_MS });
		expect(await store.getRecoveryLock(t + RECOVERY_LOCK_MS)).toEqual({ lockedUntil: 0 });
	});

	it("starts a new window after an hour", async () => {
		for (let i = 0; i < RECOVERY_MAX_FAILURES - 1; i++) await store.recordRecoveryFailure(T0);
		expect(await store.recordRecoveryFailure(T0 + HOUR)).toEqual({ lockedUntil: 0, failures: 1 });
	});
});

describe("TOTP state", () => {
	it("goes pending -> enabled -> disabled", async () => {
		const u = await owner();
		expect(await store.getTotp(u.id)).toEqual({ secretEnc: null, enabled: false, lastStep: null });
		await expect(store.enableTotp(u.id, 1, [])).rejects.toThrow("no_pending_totp");

		await store.setPendingTotp(u.id, "v1.enc");
		expect(await store.getTotp(u.id)).toEqual({ secretEnc: "v1.enc", enabled: false, lastStep: null });
		await store.enableTotp(u.id, 100, ["r1", "r2"]);
		expect(await store.getTotp(u.id)).toEqual({ secretEnc: "v1.enc", enabled: true, lastStep: 100 });
		expect((await store.getUser(u.id))!.totpEnabled).toBe(true);
		expect(await store.countRecoveryCodes(u.id)).toBe(2);

		// The active secret cannot be swapped without disabling first.
		await expect(store.setPendingTotp(u.id, "v1.other")).rejects.toThrow("totp_enabled");

		await store.disableTotp(u.id);
		expect(await store.getTotp(u.id)).toEqual({ secretEnc: null, enabled: false, lastStep: null });
		expect(await store.countRecoveryCodes(u.id)).toBe(0);
	});

	it("refuses replayed and older steps", async () => {
		const u = await owner();
		await store.setPendingTotp(u.id, "v1.enc");
		await store.enableTotp(u.id, 100, []);
		// The enrolment code's step cannot be reused to sign in.
		expect(await store.recordTotpStep(u.id, 100)).toBe(false);
		expect(await store.recordTotpStep(u.id, 101)).toBe(true);
		expect(await store.recordTotpStep(u.id, 101)).toBe(false);
		expect(await store.recordTotpStep(u.id, 99)).toBe(false);
		expect(await store.recordTotpStep(u.id, 102)).toBe(true);
	});

	it("consumes recovery codes exactly once", async () => {
		const u = await owner();
		await store.setPendingTotp(u.id, "v1.enc");
		await store.enableTotp(u.id, 1, ["r1", "r2", "r3"]);
		expect(await store.consumeRecoveryCode(u.id, "r1")).toBe(true);
		expect(await store.consumeRecoveryCode(u.id, "r1")).toBe(false);
		expect(await store.consumeRecoveryCode(u.id, "nope")).toBe(false);
		expect(await store.countRecoveryCodes(u.id)).toBe(2);

		await store.replaceRecoveryCodes(u.id, ["n1"]);
		expect(await store.consumeRecoveryCode(u.id, "r2")).toBe(false);
		expect(await store.consumeRecoveryCode(u.id, "n1")).toBe(true);
	});

	it("scopes recovery codes to their user", async () => {
		const o = await owner();
		const m = await member();
		await store.replaceRecoveryCodes(o.id, ["shared"]);
		expect(await store.consumeRecoveryCode(m.id, "shared")).toBe(false);
	});
});

describe("invites", () => {
	const base = {
		email: " New@Example.com ",
		role: "member" as const,
		mailboxes: ["a@example.com"],
		createdBy: "usr_x",
		now: T0,
	};

	it("creates, lists and accepts atomically", async () => {
		await owner();
		const inv = await store.createInvite({ ...base, tokenHash: "t1", expiresAt: T0 + DAY });
		expect(inv).toMatchObject({ email: "new@example.com", role: "member", mailboxes: ["a@example.com"] });
		expect(inv.id).toMatch(/^inv_/);
		expect(await store.getInvite("t1", T0)).toEqual(inv);
		expect(await store.listInvites(T0)).toEqual([inv]);

		const r = await store.acceptInvite({ tokenHash: "t1", name: "New", passwordHash: "h", now: T0 + 1 });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.user).toMatchObject({ email: "new@example.com", name: "New", isOwner: false });
		expect(r.invite.id).toBe(inv.id);

		// Used: no longer resolvable, listed or acceptable.
		expect(await store.getInvite("t1", T0)).toBeNull();
		expect(await store.listInvites(T0)).toEqual([]);
		expect(
			await store.acceptInvite({ tokenHash: "t1", name: "Again", passwordHash: "h", now: T0 + 2 }),
		).toEqual({ ok: false, reason: "invalid" });
	});

	it("only one of two concurrent accepts succeeds", async () => {
		await store.createInvite({ ...base, tokenHash: "t1", expiresAt: T0 + DAY });
		const rs = await Promise.all([
			store.acceptInvite({ tokenHash: "t1", name: "A", passwordHash: "h", now: T0 }),
			store.acceptInvite({ tokenHash: "t1", name: "B", passwordHash: "h", now: T0 }),
		]);
		expect(rs.filter((r) => r.ok)).toHaveLength(1);
		expect(await store.listUsers()).toHaveLength(1);
	});

	it("rejects expired and unknown invites", async () => {
		await store.createInvite({ ...base, tokenHash: "t1", expiresAt: T0 + DAY });
		expect(await store.getInvite("t1", T0 + DAY)).toBeNull();
		expect(
			await store.acceptInvite({ tokenHash: "t1", name: "N", passwordHash: "h", now: T0 + DAY }),
		).toEqual({ ok: false, reason: "invalid" });
		expect(
			await store.acceptInvite({ tokenHash: "missing", name: "N", passwordHash: "h", now: T0 }),
		).toEqual({ ok: false, reason: "invalid" });
	});

	it("refuses to invite an existing user, and reports email_taken on accept", async () => {
		await owner();
		await expect(
			store.createInvite({ ...base, email: "OWNER@example.com", tokenHash: "t0", expiresAt: T0 + DAY }),
		).rejects.toThrow("email_taken");

		// A user created after the invite was issued (e.g. via another invite).
		await store.createInvite({ ...base, tokenHash: "t1", expiresAt: T0 + DAY });
		db.prepare(
			`INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('usr_y', 'new@example.com', 'Y', 'h', 0)`,
		).run();
		expect(
			await store.acceptInvite({ tokenHash: "t1", name: "N", passwordHash: "h", now: T0 }),
		).toEqual({ ok: false, reason: "email_taken" });
		expect(await store.getInvite("t1", T0)).not.toBeNull();
	});

	it("re-inviting supersedes the earlier link; revoke works once", async () => {
		await store.createInvite({ ...base, tokenHash: "t1", expiresAt: T0 + DAY });
		const second = await store.createInvite({ ...base, tokenHash: "t2", expiresAt: T0 + DAY });
		expect(await store.getInvite("t1", T0)).toBeNull();
		expect(await store.revokeInvite(second.id)).toBe(true);
		expect(await store.revokeInvite(second.id)).toBe(false);
		expect(await store.getInvite("t2", T0)).toBeNull();
	});
});

describe("password resets", () => {
	it("is single-use, sets the password, clears lockout and revokes all sessions", async () => {
		await owner();
		const m = await member();
		await session(m.id, "s1");
		await session(m.id, "s2");
		for (let i = 0; i < 6; i++) await store.recordLoginFailure("member@example.com", `198.51.100.${i % 2}`, T0);

		await store.createPasswordReset({ userId: m.id, tokenHash: "r1", expiresAt: T0 + HOUR, now: T0 });
		expect(await store.getPasswordReset("r1", T0)).toEqual({ userId: m.id, email: "member@example.com" });

		expect(
			await store.consumePasswordReset({ tokenHash: "r1", passwordHash: "new-hash", now: T0 + MIN }),
		).toEqual({ userId: m.id });
		const c = await store.getLoginCandidate("member@example.com");
		expect(c!.passwordHash).toBe("new-hash");
		// Cleared on every IP.
		expect(await store.getLoginLock("member@example.com", "198.51.100.0", T0 + MIN)).toEqual({ lockedUntil: 0 });
		expect(await store.getLoginLock("member@example.com", "198.51.100.1", T0 + MIN)).toEqual({ lockedUntil: 0 });
		expect(c!.user.passwordChangedAt).toBe(T0 + MIN);
		expect(await store.listSessions(m.id, T0)).toEqual([]);

		expect(
			await store.consumePasswordReset({ tokenHash: "r1", passwordHash: "again", now: T0 + MIN }),
		).toBeNull();
		expect(await store.getPasswordReset("r1", T0)).toBeNull();
	});

	it("a new link invalidates the older one; links expire", async () => {
		const u = await owner();
		await store.createPasswordReset({ userId: u.id, tokenHash: "r1", expiresAt: T0 + HOUR, now: T0 });
		await store.createPasswordReset({ userId: u.id, tokenHash: "r2", expiresAt: T0 + HOUR, now: T0 });
		expect(await store.getPasswordReset("r1", T0)).toBeNull();
		expect(await store.getPasswordReset("r2", T0 + HOUR)).toBeNull();
		expect(
			await store.consumePasswordReset({ tokenHash: "r2", passwordHash: "x", now: T0 + HOUR }),
		).toBeNull();
	});
});

describe("API tokens", () => {
	async function token(userId: string, expiresAt: number | null = null) {
		return store.createApiToken({
			id: "abcDEF123456",
			userId,
			name: "CI",
			secretHash: "secret-hash",
			expiresAt,
			now: T0,
		});
	}

	it("validates and touches lastUsedAt at most hourly", async () => {
		const u = await owner();
		const t = await token(u.id);
		expect(t).toMatchObject({ id: "abcDEF123456", name: "CI", lastUsedAt: null, expiresAt: null });

		const a = await store.validateApiToken(t.id, "secret-hash", T0 + MIN);
		expect(a!.user.id).toBe(u.id);
		expect(a!.token.lastUsedAt).toBe(T0 + MIN);
		const b = await store.validateApiToken(t.id, "secret-hash", T0 + 30 * MIN);
		expect(b!.token.lastUsedAt).toBe(T0 + MIN);
		const c = await store.validateApiToken(t.id, "secret-hash", T0 + MIN + HOUR);
		expect(c!.token.lastUsedAt).toBe(T0 + MIN + HOUR);
		expect(await store.listApiTokens(u.id)).toHaveLength(1);
	});

	it("rejects hash mismatch, unknown id and expiry", async () => {
		const u = await owner();
		const t = await token(u.id, T0 + DAY);
		expect(await store.validateApiToken(t.id, "secret-hasH", T0)).toBeNull();
		expect(await store.validateApiToken("nope", "secret-hash", T0)).toBeNull();
		expect(await store.validateApiToken(t.id, "secret-hash", T0 + DAY)).toBeNull();
	});

	it("revokes (scoped to user)", async () => {
		const o = await owner();
		const m = await member();
		const t = await token(o.id);
		expect(await store.revokeApiToken(m.id, t.id)).toBe(false);
		expect(await store.revokeApiToken(o.id, t.id)).toBe(true);
		expect(await store.revokeApiToken(o.id, t.id)).toBe(false);
		expect(await store.validateApiToken(t.id, "secret-hash", T0)).toBeNull();
		expect(await store.listApiTokens(o.id)).toEqual([]);
	});

	it("disabling the user revokes their tokens", async () => {
		await owner();
		const m = await member();
		const t = await token(m.id);
		await store.setDisabled(m.id, true);
		expect(await store.validateApiToken(t.id, "secret-hash", T0)).toBeNull();
		await store.setDisabled(m.id, false);
		expect(await store.validateApiToken(t.id, "secret-hash", T0)).toBeNull();
	});
});

describe("account management", () => {
	it("setDisabled and deleteUser refuse the owner", async () => {
		const o = await owner();
		expect(await store.setDisabled(o.id, true)).toBe(false);
		expect(await store.deleteUser(o.id)).toBe(false);
		expect((await store.getUser(o.id))!.disabled).toBe(false);
		expect(await store.setDisabled("usr_missing", true)).toBe(false);
		expect(await store.deleteUser("usr_missing")).toBe(false);
	});

	it("deleteUser cascades", async () => {
		await owner();
		const m = await member();
		await session(m.id, "m");
		await store.replaceRecoveryCodes(m.id, ["r"]);
		await store.createPasswordReset({ userId: m.id, tokenHash: "rr", expiresAt: T0 + HOUR, now: T0 });
		await store.createApiToken({
			id: "tok123456789",
			userId: m.id,
			name: "x",
			secretHash: "h",
			expiresAt: null,
			now: T0,
		});
		await store.createMfaChallenge({ userId: m.id, challengeHash: "ch", now: T0 });

		expect(await store.deleteUser(m.id)).toBe(true);
		expect(await store.getUser(m.id)).toBeNull();
		for (const table of ["sessions", "recovery_codes", "password_resets", "api_tokens", "mfa_challenges"]) {
			const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(m.id) as any;
			expect(Number(n.n), table).toBe(0);
		}
		// The address is free to be invited again.
		await expect(
			store.createInvite({
				tokenHash: "again",
				email: "member@example.com",
				role: "member",
				mailboxes: [],
				createdBy: null,
				expiresAt: T0 + DAY,
				now: T0,
			}),
		).resolves.toBeTruthy();
	});

	it("updates password, profile, and looks users up by email", async () => {
		const o = await owner();
		await store.updatePassword(o.id, "h2", T0 + 5);
		const c = await store.getLoginCandidate("owner@example.com");
		expect(c!.passwordHash).toBe("h2");
		expect(c!.user.passwordChangedAt).toBe(T0 + 5);

		expect((await store.updateProfile(o.id, { name: "Renamed" }))!.name).toBe("Renamed");
		expect((await store.updateProfile(o.id, {}))!.name).toBe("Renamed");
		expect(await store.updateProfile("usr_missing", { name: "x" })).toBeNull();
		expect((await store.getUserByEmail(" OWNER@EXAMPLE.COM"))!.id).toBe(o.id);
	});
});

describe("recoverOwner", () => {
	it("returns null before setup", async () => {
		expect(await store.recoverOwner({ passwordHash: "x", now: T0 })).toBeNull();
	});

	it("resets password, disables 2FA, burns codes, revokes sessions and clears lockout", async () => {
		const o = await owner();
		const m = await member();
		await store.setPendingTotp(o.id, "v1.enc");
		await store.enableTotp(o.id, 5, ["r1"]);
		await session(o.id, "o");
		await session(m.id, "m");
		for (let i = 0; i < 8; i++) await store.recordLoginFailure("owner@example.com", "198.51.100.1", T0);
		for (let i = 0; i < 8; i++) await store.recordMfaFailure(o.id, T0);
		for (let i = 0; i < 4; i++) await store.recordRecoveryFailure(T0);

		expect(await store.recoverOwner({ passwordHash: "recovered", now: T0 + 1 })).toEqual({
			email: "owner@example.com",
		});
		const c = await store.getLoginCandidate("owner@example.com");
		expect(c!.passwordHash).toBe("recovered");
		expect(await store.getLoginLock("owner@example.com", "198.51.100.1", T0 + 1)).toEqual({ lockedUntil: 0 });
		expect(await store.getMfaLock(o.id, T0 + 1)).toEqual({ lockedUntil: 0 });
		// The recovery counter starts over: it took 10 more failures to lock.
		for (let i = 0; i < RECOVERY_MAX_FAILURES - 1; i++) {
			expect((await store.recordRecoveryFailure(T0 + 2)).lockedUntil).toBe(0);
		}
		expect(c!.user.totpEnabled).toBe(false);
		expect(await store.getTotp(o.id)).toEqual({ secretEnc: null, enabled: false, lastStep: null });
		expect(await store.countRecoveryCodes(o.id)).toBe(0);
		expect(await store.validateSession("o", T0)).toBeNull();
		// Other users are untouched.
		expect(await store.validateSession("m", T0)).not.toBeNull();
	});
});

describe("MCP OAuth grants", () => {
	const grant = (userId: string, clientId = "client-1", now = T0) =>
		store.createOAuthGrant({ userId, clientId, clientName: "Claude Code", redirectHost: "127.0.0.1", now });

	it("validates only for the owning, enabled user and touches lastUsedAt hourly", async () => {
		const m = await member();
		const g = await grant(m.id);
		expect((await store.validateOAuthGrant(g.id, m.id, T0))?.user.email).toBe("member@example.com");
		expect(await store.validateOAuthGrant(g.id, "usr_someone_else", T0)).toBeNull();
		expect((await store.listOAuthGrants(m.id))[0].lastUsedAt).toBe(T0);
		await store.validateOAuthGrant(g.id, m.id, T0 + MIN);
		expect((await store.listOAuthGrants(m.id))[0].lastUsedAt).toBe(T0);
		await store.validateOAuthGrant(g.id, m.id, T0 + TOUCH_INTERVAL_MS);
		expect((await store.listOAuthGrants(m.id))[0].lastUsedAt).toBe(T0 + TOUCH_INTERVAL_MS);
	});

	it("replaces an earlier approval of the same client", async () => {
		const m = await member();
		const first = await grant(m.id);
		await grant(m.id);
		await grant(m.id, "client-2");
		expect(await store.listOAuthGrants(m.id)).toHaveLength(2);
		expect(await store.validateOAuthGrant(first.id, m.id, T0)).toBeNull();
	});

	it("refuses to record an approval for a disabled user", async () => {
		await owner();
		const m = await member();
		await store.setDisabled(m.id, true);
		await expect(grant(m.id)).rejects.toThrow("user_unavailable");
	});

	it.each([
		["disabling the user", async (id: string) => void (await store.setDisabled(id, true))],
		["deleting the user", async (id: string) => void (await store.deleteUser(id))],
		["signing out everywhere else", async (id: string) => void (await store.revokeOtherSessions(id, "keep"))],
		[
			"resetting the password",
			async (id: string) => {
				await store.createPasswordReset({ userId: id, tokenHash: "r1", expiresAt: T0 + HOUR, now: T0 });
				await store.consumePasswordReset({ tokenHash: "r1", passwordHash: "h2", now: T0 });
			},
		],
	])("is revoked by %s", async (_label, act) => {
		await owner();
		const m = await member();
		const g = await grant(m.id);
		await act(m.id);
		expect(await store.validateOAuthGrant(g.id, m.id, T0)).toBeNull();
		expect(await store.listOAuthGrants(m.id)).toHaveLength(0);
	});

	it("is revoked for the owner by break-glass recovery", async () => {
		const o = await owner();
		const g = await grant(o.id);
		await store.recoverOwner({ passwordHash: "new", now: T0 });
		expect(await store.validateOAuthGrant(g.id, o.id, T0)).toBeNull();
	});

	it("revokes one grant only for its owner", async () => {
		const m = await member();
		const g = await grant(m.id);
		expect(await store.revokeOAuthGrant("usr_other", g.id)).toBe(false);
		expect(await store.revokeOAuthGrant(m.id, g.id)).toBe(true);
		expect(await store.listOAuthGrants(m.id)).toHaveLength(0);
	});
});
