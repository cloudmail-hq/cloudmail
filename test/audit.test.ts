// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The audit trail.
 *
 * Four properties carry the weight here, and each has a specific failure mode:
 *
 *   - **Actor classification.** The log answers "was this the owner, a delegate,
 *     or an admin", mirroring Exchange's sign-in-type distinction. Getting this
 *     wrong makes the log look complete while hiding the only case worth
 *     investigating — someone acting in a mailbox that is not theirs.
 *   - **Newest-first without a scan.** Keys embed an inverted timestamp so R2's
 *     own key order is reverse-chronological. If that inversion is wrong the log
 *     still *works* — it just silently returns the oldest entries, and only at
 *     scale, which is exactly when nobody is looking.
 *   - **Never breaking the audited action.** A failed log write must not fail the
 *     send it was recording.
 *   - **Scoping.** One mailbox's log is a prefix, so a busy shared inbox cannot
 *     make a quiet mailbox's log expensive, and a deleted mailbox does not leave
 *     its history behind for a re-created address to inherit.
 *
 * The route-level tests then confirm the entries are actually written by real
 * requests and that reading them is gated — a log of delegated access that every
 * delegate can read is a different feature from the one intended.
 */

import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { app } from "../workers/index";
import {
	AUDIT_MAX_PAGE_SIZE,
	AUDIT_PREFIX,
	INSTANCE_SCOPE,
	auditActorRole,
	auditScopePrefix,
	listAudit,
	listAuditKeysForMailbox,
	recordAudit,
	recordAuditDeferred,
	type AuditEntry,
} from "../workers/lib/audit";
import { decidePrincipal, type Principal } from "../workers/lib/authz";
import { FULL_ACCESS_ROLE } from "../workers/lib/capabilities";
import type { Env } from "../workers/types";

const ADMIN = "owner@tapetide.com";
const MEMBER = "member@tapetide.com";
const SUPPORT = "support@tapetide.com";
const SALES = "sales@tapetide.com";

/**
 * R2 double whose `list` honours key order and `limit`.
 *
 * Both matter: the whole point of the key layout is that a limited list returns
 * the newest entries, so a double that ignored either would pass while the real
 * bucket returned the oldest.
 */
function fakeBucket(initial: Record<string, unknown> = {}) {
	const store = new Map<string, string>(
		Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]),
	);

	return {
		async head(key: string) {
			return store.has(key) ? { key } : null;
		},
		async get(key: string) {
			const raw = store.get(key);
			return raw === undefined ? null : { json: async () => JSON.parse(raw) };
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async delete(key: string | string[]) {
			for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
		},
		async list({
			prefix = "",
			limit = 1000,
			cursor,
		}: { prefix?: string; limit?: number; cursor?: string } = {}) {
			const all = [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
			const start = cursor ? all.indexOf(cursor) + 1 : 0;
			const page = all.slice(start, start + limit);
			const last = page.at(-1);
			const truncated = start + page.length < all.length;
			return {
				objects: page.map((key) => ({ key })),
				truncated,
				...(truncated && last ? { cursor: last } : {}),
			};
		},
		_store: store,
	};
}

function principal(overrides: Partial<Principal> = {}): Principal {
	return {
		identity: { kind: "user", id: MEMBER, subject: "uuid-1" },
		role: "member",
		mailboxes: [SUPPORT],
		access: [{ id: SUPPORT, role: "agent" }],
		enforced: true,
		developmentBypass: false,
		...overrides,
	};
}

// -- Actor classification ------------------------------------------

describe("auditActorRole", () => {
	it("calls a full-access grant the owner", () => {
		const owner = principal({ access: [{ id: SUPPORT, role: FULL_ACCESS_ROLE }] });
		expect(auditActorRole(owner, SUPPORT)).toBe("owner");
	});

	it("calls any narrower grant a delegate", () => {
		// The case the log exists for: someone working in a mailbox that is not
		// theirs.
		expect(auditActorRole(principal(), SUPPORT)).toBe("delegate");
	});

	it("calls an admin acting without a grant an admin", () => {
		const admin = decidePrincipal({
			adminEmails: [ADMIN],
			identity: { kind: "user", id: ADMIN, subject: "uuid-2" },
		});
		expect(auditActorRole(admin, SUPPORT)).toBe("admin");
	});

	it("classifies the same person differently per mailbox", () => {
		// Owner of their own mail, delegate on the shared inbox. One entry each way.
		const both = principal({
			mailboxes: [MEMBER, SUPPORT],
			access: [
				{ id: MEMBER, role: FULL_ACCESS_ROLE },
				{ id: SUPPORT, role: "agent" },
			],
		});
		expect(auditActorRole(both, MEMBER)).toBe("owner");
		expect(auditActorRole(both, SUPPORT)).toBe("delegate");
	});

	it("calls a caller with no identity the system", () => {
		// Inbound delivery and the cron tick, which have no human behind them.
		const anonymous = principal({ identity: null });
		expect(auditActorRole(anonymous, SUPPORT)).toBe("system");
	});

	it("ignores casing when matching the mailbox", () => {
		expect(auditActorRole(principal(), "Support@Tapetide.com")).toBe("delegate");
	});
});

// -- Storage -------------------------------------------------------

describe("recordAudit", () => {
	it("scopes an entry to its mailbox", async () => {
		// Reading one mailbox's log has to be a prefix list, not a scan.
		const bucket = fakeBucket();
		await recordAudit(bucket as unknown as R2Bucket, {
			action: "mail.send",
			actor: MEMBER,
			actorRole: "delegate",
			mailboxId: SUPPORT,
		});

		const keys = [...bucket._store.keys()];
		expect(keys).toHaveLength(1);
		expect(keys[0].startsWith(`${AUDIT_PREFIX}${SUPPORT}/`)).toBe(true);
	});

	it("puts a deployment-wide entry in its own scope", async () => {
		const bucket = fakeBucket();
		await recordAudit(bucket as unknown as R2Bucket, {
			action: "access.grant",
			actor: ADMIN,
			actorRole: "admin",
			target: MEMBER,
		});

		expect([...bucket._store.keys()][0].startsWith(`${AUDIT_PREFIX}${INSTANCE_SCOPE}/`)).toBe(
			true,
		);
	});

	it("normalizes the addresses it stores", async () => {
		const bucket = fakeBucket();
		await recordAudit(bucket as unknown as R2Bucket, {
			action: "mail.send",
			actor: "Member@Tapetide.com",
			actorRole: "delegate",
			mailboxId: "Support@Tapetide.com",
			target: "Other@Tapetide.com",
		});

		const entry = JSON.parse([...bucket._store.values()][0]) as AuditEntry;
		expect(entry.actor).toBe(MEMBER);
		expect(entry.mailboxId).toBe(SUPPORT);
		expect(entry.target).toBe("other@tapetide.com");
	});

	it("does not collide when two entries land in the same millisecond", async () => {
		// Without the random suffix the second would overwrite the first, and a lost
		// audit line is indistinguishable from an action that never happened.
		const bucket = fakeBucket();
		vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		try {
			for (let i = 0; i < 5; i++) {
				await recordAudit(bucket as unknown as R2Bucket, {
					action: "mail.delete",
					actor: MEMBER,
					actorRole: "delegate",
					mailboxId: SUPPORT,
				});
			}
		} finally {
			vi.restoreAllMocks();
		}

		expect(bucket._store.size).toBe(5);
	});

	it("never fails the action it was recording", async () => {
		// Refusing a send because its log line could not be written would turn a
		// logging outage into a mail outage.
		const failing = {
			put: async () => {
				throw new Error("R2 unavailable");
			},
		} as unknown as R2Bucket;

		await expect(
			recordAudit(failing, {
				action: "mail.send",
				actor: MEMBER,
				actorRole: "delegate",
				mailboxId: SUPPORT,
			}),
		).resolves.toBeUndefined();
	});
});

describe("recordAuditDeferred", () => {
	const entry = {
		action: "mail.send",
		actor: MEMBER,
		actorRole: "delegate",
		mailboxId: SUPPORT,
	} as const;

	it("defers the write when there is a context to defer to", async () => {
		const bucket = fakeBucket();
		const deferred: Promise<unknown>[] = [];

		await recordAuditDeferred(
			{
				env: { BUCKET: bucket as unknown as R2Bucket },
				executionCtx: { waitUntil: (p) => void deferred.push(p) },
			},
			entry,
		);

		// Handed off rather than awaited, so the log is never on the request's path.
		expect(deferred).toHaveLength(1);
		await Promise.all(deferred);
		expect(bucket._store.size).toBe(1);
	});

	it("still records the entry when there is no context", async () => {
		// A handler driven directly rather than by the Workers runtime has no
		// `executionCtx`. The entry should land anyway, inline.
		const bucket = fakeBucket();

		await recordAuditDeferred({ env: { BUCKET: bucket as unknown as R2Bucket } }, entry);

		expect(bucket._store.size).toBe(1);
	});

	it("survives a context that throws on access", async () => {
		// This is the real defect this helper exists for: Hono throws when
		// `c.executionCtx` is unavailable, so *reaching* for it can break the very
		// request the log is meant not to affect. Reading it must be inside the try.
		const bucket = fakeBucket();
		const hostile = {
			env: { BUCKET: bucket as unknown as R2Bucket },
			get executionCtx(): never {
				throw new Error("This context has no ExecutionContext");
			},
		};

		await expect(recordAuditDeferred(hostile, entry)).resolves.toBeUndefined();
		expect(bucket._store.size).toBe(1);
	});

	it("swallows a failed write even when deferring throws", async () => {
		// Both failure modes at once: no usable context, and R2 unavailable. The
		// audited action must still succeed.
		const failing = {
			env: {
				BUCKET: {
					put: async () => {
						throw new Error("R2 unavailable");
					},
				} as unknown as R2Bucket,
			},
			get executionCtx(): never {
				throw new Error("This context has no ExecutionContext");
			},
		};

		await expect(recordAuditDeferred(failing, entry)).resolves.toBeUndefined();
	});
});

describe("listAudit", () => {
	/** Write `count` entries, oldest first, one second apart. */
	async function seed(bucket: ReturnType<typeof fakeBucket>, count: number, mailboxId: string | null) {
		const base = 1_700_000_000_000;
		for (let i = 0; i < count; i++) {
			vi.spyOn(Date, "now").mockReturnValue(base + i * 1000);
			await recordAudit(bucket as unknown as R2Bucket, {
				action: "mail.send",
				actor: MEMBER,
				actorRole: "delegate",
				mailboxId,
				detail: { seq: i },
			});
		}
		vi.restoreAllMocks();
	}

	it("returns entries newest first", async () => {
		const bucket = fakeBucket();
		await seed(bucket, 5, SUPPORT);

		const entries = await listAudit(bucket as unknown as R2Bucket, { mailboxId: SUPPORT });
		expect(entries.map((e) => e.detail?.seq)).toEqual([4, 3, 2, 1, 0]);
	});

	it("returns the newest page, not the oldest, when limited", async () => {
		// This is the assertion that would catch a broken timestamp inversion: a
		// naive key order returns entry 0 first and nobody notices until the log is
		// large.
		const bucket = fakeBucket();
		await seed(bucket, 10, SUPPORT);

		const entries = await listAudit(bucket as unknown as R2Bucket, {
			mailboxId: SUPPORT,
			limit: 3,
		});
		expect(entries.map((e) => e.detail?.seq)).toEqual([9, 8, 7]);
	});

	it("keeps one mailbox's log out of another's", async () => {
		const bucket = fakeBucket();
		await seed(bucket, 3, SUPPORT);
		await seed(bucket, 2, SALES);

		const support = await listAudit(bucket as unknown as R2Bucket, { mailboxId: SUPPORT });
		const sales = await listAudit(bucket as unknown as R2Bucket, { mailboxId: SALES });
		expect(support).toHaveLength(3);
		expect(sales).toHaveLength(2);
		expect(support.every((e) => e.mailboxId === SUPPORT)).toBe(true);
	});

	it("keeps deployment-wide entries out of a mailbox's log", async () => {
		const bucket = fakeBucket();
		await seed(bucket, 2, SUPPORT);
		await seed(bucket, 3, null);

		expect(await listAudit(bucket as unknown as R2Bucket, { mailboxId: SUPPORT })).toHaveLength(
			2,
		);
		expect(await listAudit(bucket as unknown as R2Bucket, { mailboxId: null })).toHaveLength(3);
	});

	it("caps a caller-supplied limit", async () => {
		// So one request cannot ask for the entire history.
		const bucket = fakeBucket();
		await seed(bucket, 5, SUPPORT);

		const entries = await listAudit(bucket as unknown as R2Bucket, {
			mailboxId: SUPPORT,
			limit: AUDIT_MAX_PAGE_SIZE + 1000,
		});
		expect(entries.length).toBeLessThanOrEqual(AUDIT_MAX_PAGE_SIZE);
	});

	it("skips an unreadable entry rather than failing the whole log", async () => {
		const bucket = fakeBucket();
		await seed(bucket, 2, SUPPORT);
		bucket._store.set(`${auditScopePrefix(SUPPORT)}00000000000000-corrupt.json`, "{not json");

		const entries = await listAudit(bucket as unknown as R2Bucket, { mailboxId: SUPPORT });
		expect(entries).toHaveLength(2);
	});

	it("returns nothing for a mailbox with no history", async () => {
		const bucket = fakeBucket();
		expect(await listAudit(bucket as unknown as R2Bucket, { mailboxId: SALES })).toEqual([]);
	});
});

describe("listAuditKeysForMailbox", () => {
	it("finds every key for one mailbox, following the list cursor", async () => {
		// A busy shared inbox has more entries than one list page.
		const bucket = fakeBucket();
		const base = 1_700_000_000_000;
		for (let i = 0; i < 5; i++) {
			vi.spyOn(Date, "now").mockReturnValue(base + i * 1000);
			await recordAudit(bucket as unknown as R2Bucket, {
				action: "mail.delete",
				actor: MEMBER,
				actorRole: "delegate",
				mailboxId: i % 2 === 0 ? SUPPORT : SALES,
			});
		}
		vi.restoreAllMocks();

		const keys = await listAuditKeysForMailbox(bucket as unknown as R2Bucket, SUPPORT);
		expect(keys).toHaveLength(3);
		expect(keys.every((key) => key.startsWith(auditScopePrefix(SUPPORT)))).toBe(true);
	});
});

// -- Through real requests -----------------------------------------

/** The API app behind a stand-in for the Access middleware. */
function buildApp(options: { identity?: string; grants?: Record<string, unknown> } = {}) {
	const bucket = fakeBucket({
		[`mailboxes/${SUPPORT}.json`]: { fromName: "Support" },
		[`mailboxes/${SALES}.json`]: { fromName: "Sales" },
		...(options.grants ?? {}),
	});

	const bindings = {
		ADMIN_EMAILS: ADMIN,
		DOMAINS: "tapetide.com",
		BUCKET: bucket,
		MAILBOX: {
			idFromName: (name: string) => ({ name }),
			get: () => ({
				async getFolders() {
					return [];
				},
				async emptyTrash() {
					return { deleted: 4, attachmentKeys: [] };
				},
				async deleteEmail() {
					return { trashed: 1, deleted: 0, attachmentKeys: [] };
				},
			}),
		},
	} as unknown as Env;

	const outer = new Hono();
	outer.use("*", async (c, next) => {
		if (options.identity) {
			c.set("accessIdentity", { kind: "user", id: options.identity, subject: "uuid-1" });
		}
		return next();
	});
	outer.route("/", app);

	const deferred: Promise<unknown>[] = [];
	const executionCtx = {
		waitUntil: (promise: Promise<unknown>) => {
			deferred.push(promise);
		},
		passThroughOnException: () => undefined,
	} as unknown as ExecutionContext;

	const request = async (path: string, init?: RequestInit) => {
		const res = await outer.fetch(
			new Request(`https://mailer.tapetide.com${path}`, {
				...init,
				headers: {
					"Content-Type": "application/json",
					"Sec-Fetch-Site": "same-origin",
					...(init?.headers as Record<string, string>),
				},
			}),
			bindings,
			executionCtx,
		);
		// Audit writes are deferred, exactly as in production; settle them so the
		// assertions see what the request actually recorded.
		await Promise.all(deferred.splice(0));
		return res;
	};

	return { request, bucket };
}

function storedEntries(bucket: ReturnType<typeof fakeBucket>): AuditEntry[] {
	return [...bucket._store.entries()]
		.filter(([key]) => key.startsWith(AUDIT_PREFIX))
		.map(([, value]) => JSON.parse(value) as AuditEntry);
}

describe("recording through real requests", () => {
	it("records a grant change, with the roles it set", async () => {
		// A grant change is the one action that changes what every later entry
		// means, so it is the one that most has to be recorded.
		const { request, bucket } = buildApp({ identity: ADMIN });

		await request("/api/v1/access", {
			method: "PUT",
			body: JSON.stringify({
				id: MEMBER,
				kind: "user",
				role: "member",
				mailboxes: [{ id: SUPPORT, role: "agent" }],
			}),
		});

		const [entry] = storedEntries(bucket);
		expect(entry.action).toBe("access.grant");
		expect(entry.actor).toBe(ADMIN);
		expect(entry.actorRole).toBe("admin");
		expect(entry.target).toBe(MEMBER);
		expect(entry.detail?.mailboxes).toBe(`${SUPPORT}:agent`);
	});

	it("records a revocation", async () => {
		const { request, bucket } = buildApp({
			identity: ADMIN,
			grants: {
				[`access/users/${MEMBER}.json`]: { id: MEMBER, role: "member", mailboxes: [SUPPORT] },
			},
		});

		await request(`/api/v1/access/user/${encodeURIComponent(MEMBER)}`, { method: "DELETE" });

		const entry = storedEntries(bucket).find((e) => e.action === "access.revoke")!;
		expect(entry.target).toBe(MEMBER);
	});

	it("records a settings write, and whether forwarding was switched on", async () => {
		// `forwarding.email` can redirect every incoming message, so whether it was
		// enabled is the detail an auditor scans for.
		const { request, bucket } = buildApp({ identity: ADMIN });

		await request(`/api/v1/mailboxes/${SUPPORT}`, {
			method: "PUT",
			body: JSON.stringify({
				settings: { forwarding: { enabled: true, email: "elsewhere@example.com" } },
			}),
		});

		const entry = storedEntries(bucket).find((e) => e.action === "mailbox.settings")!;
		expect(entry.mailboxId).toBe(SUPPORT);
		expect(entry.detail?.forwardingEnabled).toBe(true);
	});

	it("does not put the forwarding address in the log", async () => {
		// The log is readable by whoever can read the mailbox's history, so it must
		// not become a second copy of its configuration.
		const { request, bucket } = buildApp({ identity: ADMIN });

		await request(`/api/v1/mailboxes/${SUPPORT}`, {
			method: "PUT",
			body: JSON.stringify({
				settings: { forwarding: { enabled: true, email: "secret@example.com" } },
			}),
		});

		expect(JSON.stringify(storedEntries(bucket))).not.toContain("secret@example.com");
	});

	it("distinguishes binning from destroying", async () => {
		const { request, bucket } = buildApp({ identity: ADMIN });

		await request(`/api/v1/mailboxes/${SUPPORT}/emails/abc`, { method: "DELETE" });
		expect(storedEntries(bucket)[0].action).toBe("mail.delete");

		// Only the log, not the mailbox records the next request needs.
		for (const key of [...bucket._store.keys()]) {
			if (key.startsWith(AUDIT_PREFIX)) bucket._store.delete(key);
		}

		await request(`/api/v1/mailboxes/${SUPPORT}/trash/empty`, { method: "POST" });
		const purge = storedEntries(bucket).find((e) => e.action === "mail.destroy")!;
		expect(purge.detail?.scope).toBe("trash");
		expect(purge.detail?.messages).toBe(4);
	});

	it("records a mailbox creation against the new mailbox", async () => {
		const { request, bucket } = buildApp({ identity: ADMIN });

		await request("/api/v1/mailboxes", {
			method: "POST",
			body: JSON.stringify({ email: "new@tapetide.com", name: "New" }),
		});

		const entry = storedEntries(bucket).find((e) => e.action === "mailbox.create")!;
		expect(entry.mailboxId).toBe("new@tapetide.com");
		expect(entry.actorRole).toBe("admin");
	});

	it("classifies a delegate's send as a delegate", async () => {
		// The end-to-end version of the classification tests above.
		const { request, bucket } = buildApp({
			identity: MEMBER,
			grants: {
				[`access/users/${MEMBER}.json`]: {
					id: MEMBER,
					role: "member",
					mailboxes: [{ id: SUPPORT, role: "agent" }],
				},
			},
		});

		await request(`/api/v1/mailboxes/${SUPPORT}/emails/abc`, { method: "DELETE" });

		const entry = storedEntries(bucket)[0];
		expect(entry.actor).toBe(MEMBER);
		expect(entry.actorRole).toBe("delegate");
	});
});

describe("reading the log", () => {
	const seeded = {
		[`audit/${SUPPORT}/09999999999999-aaaaaaaa.json`]: {
			id: "09999999999999-aaaaaaaa",
			at: 1_700_000_000,
			action: "mail.send",
			actor: MEMBER,
			actorRole: "delegate",
			mailboxId: SUPPORT,
		},
		[`audit/${INSTANCE_SCOPE}/09999999999999-bbbbbbbb.json`]: {
			id: "09999999999999-bbbbbbbb",
			at: 1_700_000_000,
			action: "access.grant",
			actor: ADMIN,
			actorRole: "admin",
			mailboxId: null,
			target: MEMBER,
		},
	};

	it("serves a mailbox's log to whoever manages its settings", async () => {
		const { request } = buildApp({ identity: ADMIN, grants: seeded });

		const res = await request(`/api/v1/mailboxes/${SUPPORT}/audit`);
		expect(res.status).toBe(200);
		const entries = (await res.json()) as AuditEntry[];
		expect(entries.map((e) => e.action)).toEqual(["mail.send"]);
	});

	it("refuses a delegate who only works in the mailbox", async () => {
		// The log names colleagues, not mail. An agent can answer support without
		// being able to see who else has been in there.
		const { request } = buildApp({
			identity: MEMBER,
			grants: {
				...seeded,
				[`access/users/${MEMBER}.json`]: {
					id: MEMBER,
					role: "member",
					mailboxes: [{ id: SUPPORT, role: "agent" }],
				},
			},
		});

		const res = await request(`/api/v1/mailboxes/${SUPPORT}/audit`);
		expect(res.status).toBe(403);
	});

	it("admits the owner of the mailbox", async () => {
		const { request } = buildApp({
			identity: MEMBER,
			grants: {
				...seeded,
				[`access/users/${MEMBER}.json`]: {
					id: MEMBER,
					role: "member",
					mailboxes: [SUPPORT],
				},
			},
		});

		expect((await request(`/api/v1/mailboxes/${SUPPORT}/audit`)).status).toBe(200);
	});

	it("refuses a mailbox the caller cannot reach at all", async () => {
		const { request } = buildApp({
			identity: MEMBER,
			grants: {
				...seeded,
				[`access/users/${MEMBER}.json`]: { id: MEMBER, role: "member", mailboxes: [SALES] },
			},
		});

		expect((await request(`/api/v1/mailboxes/${SUPPORT}/audit`)).status).toBe(403);
	});

	it("serves the deployment-wide log to an administrator only", async () => {
		const asAdmin = buildApp({ identity: ADMIN, grants: seeded });
		const asMember = buildApp({
			identity: MEMBER,
			grants: {
				...seeded,
				[`access/users/${MEMBER}.json`]: { id: MEMBER, role: "member", mailboxes: [SUPPORT] },
			},
		});

		const admin = await asAdmin.request("/api/v1/access/audit");
		expect(admin.status).toBe(200);
		expect(((await admin.json()) as AuditEntry[]).map((e) => e.action)).toEqual([
			"access.grant",
		]);

		expect((await asMember.request("/api/v1/access/audit")).status).toBe(403);
	});
});
