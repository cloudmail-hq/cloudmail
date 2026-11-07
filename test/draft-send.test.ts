// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Sending a draft.
 *
 * The regression this file exists for: pressing Send on a draft used to be two
 * requests — queue the message, then `DELETE /emails/:id?permanent=1` to remove
 * the draft it came from. That second request needs `deletePermanently`, which
 * the `agent` preset deliberately does not hold. So an agent grant queued the
 * message, was refused the cleanup, and saw "Could not send that draft" for a
 * message that was already on its way. The obvious response — press Send again —
 * queued a second copy.
 *
 * Superseding the draft now happens inside the send, which gives three
 * properties worth pinning down:
 *
 *   - **Authority.** Sending a draft must not require the authority to destroy
 *     arbitrary mail. It requires `draft`, which is what writing the row needed.
 *   - **Scope.** Because the send path can now destroy a row, it must only ever
 *     be able to destroy a *draft*. A caller who passes a received message's id
 *     must not get it deleted.
 *   - **Order.** A refusal must arrive before anything is queued. A 403 after a
 *     201 is the bug above, reappearing from the other side.
 *
 * Part one runs `destroySupersededDraft` against real SQLite via `node:sqlite`,
 * the same engine behind Durable Object storage, because the scoping property is
 * a JOIN and a fake returning canned rows would confirm nothing about it. Part
 * two drives the real route from `workers/index.ts`.
 */

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../workers/index";
import { destroySupersededDraft } from "../workers/durableObject/trash";
import { bulkMove } from "../workers/durableObject/bulk";
import { toolMoveEmail } from "../workers/lib/tools";
import { canMoveInto, Folders } from "../shared/folders";
import type { Env } from "../workers/types";

/**
 * Minimal `DurableObjectState`, matching the harness in bulk.test.ts: queued row
 * sets are handed out one per `exec`, as are the `rowsWritten` counts.
 */
function fakeCtx(options: { rows?: unknown[][]; rowsWritten?: number[] } = {}) {
	const queuedRows = [...(options.rows ?? [])];
	const queuedWrites = [...(options.rowsWritten ?? [])];
	const calls: { sql: string; params: unknown[] }[] = [];

	const ctx = {
		storage: {
			sql: {
				exec(sql: string, ...params: unknown[]) {
					calls.push({ sql, params });
					const rows = queuedRows.shift() ?? [];
					const rowsWritten = queuedWrites.shift() ?? rows.length;
					return { toArray: () => rows, rowsWritten };
				},
			},
			transactionSync: <T>(fn: () => T) => fn(),
		},
	};

	return { ctx: ctx as unknown as DurableObjectState, calls };
}

// ── Part one: the scoped destroy ───────────────────────────────────

/**
 * Folder ids and display names as `migrations.ts` seeds them.
 *
 * The split is load-bearing here: the seeded row is `('draft', 'Drafts')`, so a
 * lookup by name alone finds nothing and the delete silently does nothing. That
 * exact mistake already cost this codebase every autosave creating a new draft
 * row, so the fixture keeps id and name distinct to make it reproducible.
 */
const FOLDERS: [id: string, name: string][] = [
	["inbox", "Inbox"],
	["sent", "Sent"],
	["draft", "Drafts"],
	["trash", "Trash"],
];

const SCHEMA = `
	CREATE TABLE folders (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL UNIQUE,
		is_deletable INTEGER NOT NULL DEFAULT 1
	);
	CREATE TABLE emails (
		id TEXT PRIMARY KEY,
		folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
		subject TEXT,
		sender TEXT,
		recipient TEXT,
		date TEXT,
		body TEXT,
		in_reply_to TEXT,
		thread_id TEXT,
		message_id TEXT
	);
	CREATE TABLE attachments (
		id TEXT PRIMARY KEY,
		email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
		filename TEXT NOT NULL,
		mimetype TEXT NOT NULL,
		size INTEGER NOT NULL
	);
`;

let db: DatabaseSync;

/** `DurableObjectState` over a real SQLite database. */
function sqliteCtx(database: DatabaseSync) {
	return {
		storage: {
			sql: {
				exec(sql: string, ...params: unknown[]) {
					const statement = database.prepare(sql);
					// `run` reports changes; `all` returns rows. SQLite will not let us
					// read rows out of a DELETE, so the two are dispatched on the verb,
					// matching what the real binding does for `rowsWritten`.
					if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) {
						const result = statement.run(...(params as never[]));
						return {
							toArray: () => [],
							rowsWritten: Number(result.changes),
						};
					}
					const rows = statement.all(...(params as never[]));
					return { toArray: () => rows, rowsWritten: 0 };
				},
			},
			transactionSync: <T>(fn: () => T): T => {
				database.exec("BEGIN");
				try {
					const out = fn();
					database.exec("COMMIT");
					return out;
				} catch (e) {
					database.exec("ROLLBACK");
					throw e;
				}
			},
		},
	} as unknown as DurableObjectState;
}

function seedEmail(id: string, folder: string) {
	db.prepare(
		`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body)
		 VALUES (?, ?, 'Subject', 'me@tapetide.com', 'them@example.com', '2026-08-20T10:00:00.000Z', 'text')`,
	).run(id, folder);
}

function seedAttachment(emailId: string, attachmentId: string, filename: string) {
	db.prepare(
		`INSERT INTO attachments (id, email_id, filename, mimetype, size)
		 VALUES (?, ?, ?, 'application/pdf', 10)`,
	).run(attachmentId, emailId, filename);
}

const remainingIds = () =>
	(db.prepare(`SELECT id FROM emails ORDER BY id`).all() as { id: string }[]).map(
		(r) => r.id,
	);

describe("destroySupersededDraft", () => {
	beforeEach(() => {
		db = new DatabaseSync(":memory:");
		db.exec("PRAGMA foreign_keys = ON");
		db.exec(SCHEMA);
		const insert = db.prepare(`INSERT INTO folders (id, name) VALUES (?, ?)`);
		for (const [id, name] of FOLDERS) insert.run(id, name);
	});

	it("destroys the draft the send replaced", () => {
		seedEmail("d1", "draft");

		const result = destroySupersededDraft(sqliteCtx(db), "d1");

		expect(result.deleted).toBe(1);
		expect(remainingIds()).toEqual([]);
	});

	it("hands back the draft's attachment keys before the rows cascade away", () => {
		// Collected before the DELETE, or the cascade removes the attachment rows
		// first and the blobs leak with no way to sweep them later.
		seedEmail("d1", "draft");
		seedAttachment("d1", "att1", "quote.pdf");

		const result = destroySupersededDraft(sqliteCtx(db), "d1");

		expect(result.attachmentKeys).toEqual(["attachments/d1/att1/quote.pdf"]);
		expect(db.prepare(`SELECT COUNT(*) AS n FROM attachments`).get()).toEqual({
			n: 0,
		});
	});

	it("refuses to destroy a message that is not a draft", () => {
		// The security property. The send path holds `draft`, not
		// `deletePermanently`, so it must not be usable to destroy received mail by
		// passing its id as the draft being superseded.
		seedEmail("inbox-1", "inbox");

		const result = destroySupersededDraft(sqliteCtx(db), "inbox-1");

		expect(result).toEqual({ deleted: 0, attachmentKeys: [] });
		expect(remainingIds()).toEqual(["inbox-1"]);
	});

	it("refuses a sent message, which is what a replayed request would name", () => {
		// Re-posting a send whose draft is long gone must not reach the Sent copy
		// that took its place.
		seedEmail("sent-1", "sent");

		expect(destroySupersededDraft(sqliteCtx(db), "sent-1").deleted).toBe(0);
		expect(remainingIds()).toEqual(["sent-1"]);
	});

	it("leaves a draft already in Trash alone", () => {
		// It is no longer a draft: it is a binned message, and destroying it here
		// would skip the bin's undo.
		seedEmail("d1", "trash");

		expect(destroySupersededDraft(sqliteCtx(db), "d1").deleted).toBe(0);
		expect(remainingIds()).toEqual(["d1"]);
	});

	it("reports zero for an unknown id rather than raising", () => {
		// The message is already queued by the time this runs. A draft tidied up in
		// another tab is not a reason to fail a send that has happened.
		expect(destroySupersededDraft(sqliteCtx(db), "nope")).toEqual({
			deleted: 0,
			attachmentKeys: [],
		});
	});

	it("ignores a missing or non-string id", () => {
		for (const id of [undefined, null, "", 42, {}]) {
			expect(destroySupersededDraft(sqliteCtx(db), id)).toEqual({
				deleted: 0,
				attachmentKeys: [],
			});
		}
	});

	it("destroys only the draft it was given", () => {
		seedEmail("d1", "draft");
		seedEmail("d2", "draft");
		seedEmail("inbox-1", "inbox");

		destroySupersededDraft(sqliteCtx(db), "d1");

		expect(remainingIds()).toEqual(["d2", "inbox-1"]);
	});

	it("finds the Drafts folder even when the row is named rather than ided", () => {
		// Defensive, matching `updateDraft`: a mailbox whose folder row is keyed on
		// the display name still has its drafts superseded.
		db.exec(`DELETE FROM folders WHERE id = 'draft'`);
		db.prepare(`INSERT INTO folders (id, name) VALUES ('folder-x', 'draft')`).run();
		seedEmail("d1", "folder-x");

		expect(destroySupersededDraft(sqliteCtx(db), "d1").deleted).toBe(1);
	});
});

// ── Part two: through the real send route ──────────────────────────

const ADMIN = "owner@tapetide.com";
const AGENT = "agent@tapetide.com";
const SUPPORT = "support@tapetide.com";

/**
 * Bucket double covering what the send path touches: mailbox records, grants,
 * attachment writes and deletes.
 */
function fakeBucket(initial: Record<string, unknown> = {}) {
	const store = new Map<string, string>(
		Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]),
	);
	const deleted: string[] = [];
	const written: string[] = [];

	return {
		async head(key: string) {
			return store.has(key) ? { key } : null;
		},
		async get(key: string) {
			const raw = store.get(key);
			return raw === undefined ? null : { json: async () => JSON.parse(raw) };
		},
		async put(key: string) {
			written.push(key);
			store.set(key, "blob");
		},
		async delete(key: string | string[]) {
			for (const k of Array.isArray(key) ? key : [key]) {
				deleted.push(k);
				store.delete(k);
			}
		},
		async list() {
			return { objects: [], truncated: false as const };
		},
		_deleted: deleted,
		/** Keys written, so a refused request can be shown to have written none. */
		_written: written,
	};
}

/**
 * The real API app behind a stand-in for the Access middleware, with the mailbox
 * Durable Object recorded rather than run.
 *
 * `role` is the grant the caller acts under, so the same request can be replayed
 * as an agent (no `deletePermanently`, and the case that was broken) or an owner.
 */
function buildApp(
	options: {
		role?: string;
		/** Capabilities withheld from the preset, for the "can send, cannot draft" case. */
		revoked?: string[];
		identity?: string;
		/** What the DO reports the supersede did. */
		supersede?: { deleted: number; attachmentKeys: string[] };
	} = {},
) {
	const identity = options.identity ?? AGENT;
	const bucket = fakeBucket({
		[`mailboxes/${SUPPORT}.json`]: { fromName: "Support" },
		...(identity === ADMIN
			? {}
			: {
					[`access/users/${identity}.json`]: {
						id: identity,
						kind: "user",
						role: "member",
						mailboxes: [
							{
								id: SUPPORT,
								role: options.role ?? "agent",
								...(options.revoked ? { revoked: options.revoked } : {}),
							},
						],
						updatedAt: "2026-08-01T00:00:00.000Z",
					},
				}),
	});

	const calls = {
		createScheduledEmail: vi.fn(async () => ({ id: "queued" })),
		destroySupersededDraft: vi.fn(
			async () => options.supersede ?? { deleted: 1, attachmentKeys: [] },
		),
		markThreadRead: vi.fn(async () => ({ threadId: "t", markedRead: true })),
		// Threading resolves references by row id or Message-ID; see
		// workers/durableObject/references.ts.
		getEmailByRef: vi.fn(async () => null),
	};

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
				...calls,
			}),
		},
	} as unknown as Env;

	const outer = new Hono();
	outer.use("*", async (c, next) => {
		c.set("accessIdentity", { kind: "user", id: identity, subject: "uuid-1" });
		return next();
	});
	outer.route("/", app);

	const deferred: Promise<unknown>[] = [];
	const executionCtx = {
		waitUntil: (p: Promise<unknown>) => {
			deferred.push(p);
		},
		passThroughOnException: () => undefined,
	} as unknown as ExecutionContext;

	const send = async (body: Record<string, unknown>) => {
		const res = await outer.fetch(
			new Request(
				`https://mailer.tapetide.com/api/v1/mailboxes/${SUPPORT}/scheduled-sends`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Sec-Fetch-Site": "same-origin",
					},
					body: JSON.stringify({
						to: "them@example.com",
						from: SUPPORT,
						subject: "Re: Q3 budget",
						html: "<p>Numbers attached.</p>",
						delay_seconds: 30,
						...body,
					}),
				},
			),
			bindings,
			executionCtx,
		);
		await Promise.all(deferred.splice(0));
		return res;
	};

	return { send, calls, bucket };
}

describe("POST /scheduled-sends supersedes the draft it was composed from", () => {
	it("lets an agent grant send a draft, which used to be refused", async () => {
		// The reported bug, end to end. `agent` holds sendOnBehalf, draft and delete
		// but not deletePermanently, so the old follow-up DELETE 403'd and the
		// composer reported a send that had in fact been queued.
		const { send, calls } = buildApp({ role: "agent" });

		const res = await send({ supersedes_draft_id: "draft-1" });

		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({
			status: "scheduled",
			superseded_draft: true,
		});
		expect(calls.destroySupersededDraft).toHaveBeenCalledWith("draft-1");
	});

	it("does not require deletePermanently", async () => {
		// Stated directly, because this is the entanglement that broke it: revoking
		// the destroy authority must make no difference to sending a draft.
		const { send, calls } = buildApp({
			role: "manager",
			revoked: ["deletePermanently"],
		});

		const res = await send({ supersedes_draft_id: "draft-1" });

		expect(res.status).toBe(201);
		expect(calls.destroySupersededDraft).toHaveBeenCalledWith("draft-1");
	});

	it("queues the message before removing the draft", async () => {
		// Order matters in this direction too: if storing the outgoing copy fails,
		// the user's text has to still be in Drafts.
		const { send, calls } = buildApp({ role: "agent" });

		await send({ supersedes_draft_id: "draft-1" });

		const queuedAt = calls.createScheduledEmail.mock.invocationCallOrder[0];
		const destroyedAt = calls.destroySupersededDraft.mock.invocationCallOrder[0];
		expect(queuedAt).toBeLessThan(destroyedAt);
	});

	it("refuses a grant that can send but cannot write drafts", async () => {
		// An agent with `draft` revoked: allowed through the send gate, so this
		// reaches the new check rather than the path middleware. Removing a row is
		// the draft authority, and a grant that cannot write one must not be able to
		// destroy one either.
		const { send, calls } = buildApp({ role: "agent", revoked: ["draft"] });

		const res = await send({ supersedes_draft_id: "draft-1" });

		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ capability: "draft" });
		expect(calls.destroySupersededDraft).not.toHaveBeenCalled();
		// The refusal lands before anything is queued. A 403 after a 201 is the
		// original bug arriving from the other side: the message goes out and the
		// caller is told it did not.
		expect(calls.createScheduledEmail).not.toHaveBeenCalled();
	});

	it("still lets that grant send an ordinary message", async () => {
		// The guard is scoped to superseding a draft; revoking `draft` must not
		// quietly take away sending.
		const { send, calls } = buildApp({ role: "agent", revoked: ["draft"] });

		const res = await send({});

		expect(res.status).toBe(201);
		expect(calls.createScheduledEmail).toHaveBeenCalled();
	});

	it("sends without touching any draft when none is named", async () => {
		const { send, calls } = buildApp({ role: "agent" });

		const res = await send({});

		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({ superseded_draft: false });
		expect(calls.destroySupersededDraft).not.toHaveBeenCalled();
	});

	it("still reports success when the draft was already gone", async () => {
		// Two tabs, or a retry. The message is queued; saying the send failed
		// because the cleanup found nothing is the bug this file is about.
		const { send } = buildApp({
			role: "agent",
			supersede: { deleted: 0, attachmentKeys: [] },
		});

		const res = await send({ supersedes_draft_id: "draft-1" });

		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({ superseded_draft: false });
	});

	it("deletes the destroyed draft's attachment blobs", async () => {
		// The DO has no bucket binding, so it reports keys and the Worker sweeps
		// them. Missing this leaks bytes that cannot be found again: the bucket is
		// shared across mailboxes and cannot be listed by mailbox prefix.
		const { send, bucket } = buildApp({
			role: "agent",
			supersede: {
				deleted: 1,
				attachmentKeys: ["attachments/draft-1/att1/quote.pdf"],
			},
		});

		await send({ supersedes_draft_id: "draft-1" });

		expect(bucket._deleted).toContain("attachments/draft-1/att1/quote.pdf");
	});

	it("supersedes the draft on a threaded reply too", async () => {
		// The reply path resolves threading server-side and marks the thread read;
		// the draft still has to go.
		const { send, calls } = buildApp({ role: "agent" });
		calls.getEmailByRef.mockResolvedValue({
			id: "parent-1",
			message_id: "parent@example.com",
			thread_id: "root@example.com",
			email_references: null,
			folder_id: "inbox",
			in_reply_to: null,
		} as never);

		const res = await send({
			supersedes_draft_id: "draft-1",
			reply_to_email_id: "parent-1",
			threaded_mode: "reply",
		});

		expect(res.status).toBe(201);
		expect(calls.markThreadRead).toHaveBeenCalled();
		expect(calls.destroySupersededDraft).toHaveBeenCalledWith("draft-1");
	});

	it("reports a queued send even when superseding the draft fails", async () => {
		// The message is already on its way by this point. A transient RPC or SQL
		// failure must not surface as a failed send: the composer cannot tell that
		// from a genuine one, and the retry queues a duplicate — the very bug this
		// route exists to remove, one step further along.
		const { send, calls } = buildApp({ role: "agent" });
		calls.destroySupersededDraft.mockRejectedValue(new Error("RPC dropped"));

		const res = await send({ supersedes_draft_id: "draft-1" });

		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({
			status: "scheduled",
			superseded_draft: false,
		});
		expect(calls.createScheduledEmail).toHaveBeenCalled();
	});

	it("refuses before storing attachments, so nothing is left in R2", async () => {
		// `storeAttachments` runs early and writes under a freshly minted message id.
		// A guard placed after it left objects no message references and nothing
		// deletes, and every rejected retry leaked another copy.
		const { send, bucket, calls } = buildApp({
			role: "agent",
			revoked: ["draft"],
		});

		const res = await send({
			supersedes_draft_id: "draft-1",
			attachments: [
				{
					filename: "quote.pdf",
					type: "application/pdf",
					disposition: "attachment" as const,
					content: "QUJD",
				},
			],
		});

		expect(res.status).toBe(403);
		expect(bucket._written.filter((k) => k.startsWith("attachments/"))).toEqual(
			[],
		);
		expect(calls.createScheduledEmail).not.toHaveBeenCalled();
	});

	it("does not queue the message when threading cannot be resolved", async () => {
		// A 404 here must not leave the draft destroyed and nothing sent.
		const { send, calls } = buildApp({ role: "agent" });
		calls.getEmailByRef.mockResolvedValue(null);

		const res = await send({
			supersedes_draft_id: "draft-1",
			reply_to_email_id: "missing",
		});

		expect(res.status).toBe(404);
		expect(calls.createScheduledEmail).not.toHaveBeenCalled();
		expect(calls.destroySupersededDraft).not.toHaveBeenCalled();
	});
});

// ── Part three: the folder the supersede trusts ────────────────────

/**
 * `destroySupersededDraft` treats "sitting in Drafts" as proof that a row is a
 * draft the caller composed, and the send path is allowed to destroy it on that
 * basis without holding `deletePermanently`.
 *
 * That inference is only sound if membership of Drafts cannot be granted by
 * request. It could: `moveEmail` accepted any existing folder id and is gated on
 * `organise`, which the `agent` preset holds alongside `draft`. So an agent grant
 * could move any received or sent message into Drafts and then name its id as
 * `supersedes_draft_id` — a permanent delete of arbitrary mail, assembled from two
 * capabilities that deliberately do not include the authority to destroy anything.
 *
 * Refusing the move closes it, and is right on its own terms regardless: a
 * received message in Drafts acquires Send and Edit buttons, so Send would put
 * someone else's incoming mail back on the wire under this mailbox's name.
 */
describe("canMoveInto", () => {
	it("refuses Drafts, which is what made the escalation possible", () => {
		expect(canMoveInto(Folders.DRAFT)).toBe(false);
	});

	it("refuses Scheduled, where a move would forge a queued send", () => {
		// A row there with no `scheduled_sends` entry and no alarm looks like it is
		// about to go out, offers to cancel a send that does not exist, and never
		// sends.
		expect(canMoveInto(Folders.SCHEDULED)).toBe(false);
	});

	it("still allows every folder filing a message is meant to reach", () => {
		for (const folder of [
			Folders.INBOX,
			Folders.ARCHIVE,
			Folders.TRASH,
			Folders.SPAM,
			Folders.SENT,
		]) {
			expect(canMoveInto(folder)).toBe(true);
		}
	});

	it("allows custom folders", () => {
		expect(canMoveInto("project-acme")).toBe(true);
	});

	it("ignores casing, so a capitalised id cannot slip past", () => {
		expect(canMoveInto("Draft")).toBe(false);
		expect(canMoveInto("SCHEDULED")).toBe(false);
	});
});

describe("the move routes refuse Drafts", () => {
	/** Drives a move as an agent grant, which holds both `organise` and `draft`. */
	function buildMoveApp() {
		const bucket = fakeBucket({
			[`mailboxes/${SUPPORT}.json`]: { fromName: "Support" },
			[`access/users/${AGENT}.json`]: {
				id: AGENT,
				kind: "user",
				role: "member",
				mailboxes: [{ id: SUPPORT, role: "agent" }],
				updatedAt: "2026-08-01T00:00:00.000Z",
			},
		});

		const calls = {
			moveEmail: vi.fn(async () => true),
			bulkMoveEmails: vi.fn(async () => 1),
		};

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
					...calls,
				}),
			},
		} as unknown as Env;

		const outer = new Hono();
		outer.use("*", async (c, next) => {
			c.set("accessIdentity", { kind: "user", id: AGENT, subject: "uuid-1" });
			return next();
		});
		outer.route("/", app);

		const executionCtx = {
			waitUntil: () => undefined,
			passThroughOnException: () => undefined,
		} as unknown as ExecutionContext;

		const post = (path: string, body: unknown) =>
			outer.fetch(
				new Request(`https://mailer.tapetide.com${path}`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Sec-Fetch-Site": "same-origin",
					},
					body: JSON.stringify(body),
				}),
				bindings,
				executionCtx,
			);

		return { post, calls };
	}

	it("refuses a single move into Drafts without reaching the mailbox", async () => {
		const { post, calls } = buildMoveApp();

		const res = await post(
			`/api/v1/mailboxes/${SUPPORT}/emails/inbox-1/move`,
			{ folderId: Folders.DRAFT },
		);

		expect(res.status).toBe(400);
		expect(calls.moveEmail).not.toHaveBeenCalled();
	});

	it("refuses a bulk move into Drafts, so a selection is not a way around it", async () => {
		const { post, calls } = buildMoveApp();

		const res = await post(`/api/v1/mailboxes/${SUPPORT}/emails/bulk`, {
			action: "move",
			ids: ["inbox-1", "inbox-2"],
			folder_id: Folders.DRAFT,
		});

		expect(res.status).toBe(400);
		expect(calls.bulkMoveEmails).not.toHaveBeenCalled();
	});

	it("says the folder is not a destination rather than that it is missing", async () => {
		// "Folder not found" would be a lie about a folder that plainly exists, and
		// would send someone looking for a seeding bug.
		const { post } = buildMoveApp();

		const res = await post(
			`/api/v1/mailboxes/${SUPPORT}/emails/inbox-1/move`,
			{ folderId: Folders.DRAFT },
		);

		expect((await res.json()) as { error: string }).toMatchObject({
			error: expect.stringContaining("cannot be moved into"),
		});
	});

	it("still allows an ordinary move", async () => {
		const { post, calls } = buildMoveApp();

		const res = await post(
			`/api/v1/mailboxes/${SUPPORT}/emails/inbox-1/move`,
			{ folderId: Folders.ARCHIVE },
		);

		expect(res.status).toBe(200);
		expect(calls.moveEmail).toHaveBeenCalledWith("inbox-1", Folders.ARCHIVE);
	});
});

describe("bulkMove", () => {
	it("refuses Drafts at the data layer too", () => {
		// The agent tool and MCP reach `bulkMove`/`moveEmail` directly, without
		// passing the route guard, so the refusal has to live here as well.
		const { ctx, calls } = fakeCtx({ rows: [[{ id: "draft" }]] });

		expect(bulkMove(ctx, ["inbox-1"], Folders.DRAFT)).toBeNull();
		expect(calls.some((c) => /UPDATE emails/.test(c.sql))).toBe(false);
	});

	it("still moves into an ordinary folder", () => {
		const { ctx } = fakeCtx({
			rows: [[{ id: "archive" }]],
			rowsWritten: [0, 1],
		});

		expect(bulkMove(ctx, ["inbox-1"], Folders.ARCHIVE)).toBe(1);
	});
});

describe("the move_email tool refuses Drafts", () => {
	it("tells the model why, and points it at the draft tools", async () => {
		// A bare "Failed to move email" invites a retry of the same call. The agent
		// reaches `moveEmail` directly, so this is the surface that needs to say no.
		const env = {
			MAILBOX: {
				idFromName: (name: string) => ({ name }),
				get: () => ({
					moveEmail: async () => {
						throw new Error("should not be reached");
					},
				}),
			},
		} as unknown as Env;

		const result = await toolMoveEmail(env, SUPPORT, "inbox-1", Folders.DRAFT);

		expect(result).toMatchObject({ emailId: "inbox-1" });
		expect((result as { error: string }).error).toContain(
			"cannot be moved into",
		);
	});

	it("still moves into an ordinary folder", async () => {
		const env = {
			MAILBOX: {
				idFromName: (name: string) => ({ name }),
				get: () => ({ moveEmail: async () => true }),
			},
		} as unknown as Env;

		expect(
			await toolMoveEmail(env, SUPPORT, "inbox-1", Folders.ARCHIVE),
		).toMatchObject({ status: "moved", folder: Folders.ARCHIVE });
	});
});
