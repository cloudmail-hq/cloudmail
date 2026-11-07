// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Resolving what a draft is replying to.
 *
 * `emails.in_reply_to` names the parent, but not in one consistent form. Four
 * write paths store the parent's RFC `Message-ID` — inbound delivery, the reply
 * and forward routes, the scheduled-send path and the agent's auto-reply — and
 * three store our own row UUID: the composer's draft saves, `draft_reply` and
 * the auto-drafter. Every consumer that resolved it with a row-id lookup alone
 * therefore worked or failed depending on which path had written the row.
 *
 * The reproducible case is Undo Send. Cancelling drops the queued message back
 * into Drafts, and the row it lands as carries an RFC-form `in_reply_to`, so:
 *
 *   - `resolveOriginalEmail` missed the parent and returned the *draft*, which
 *     made `buildReferencesChain` rebuild the ancestry from a conversation of
 *     one — the reply arrived at the far end detached from its thread.
 *   - `resolveThreadedSend` 404'd, which the composer surfaced as "Original
 *     email not found". The send simply failed.
 *
 * These failures are near-invisible from inside the app: our own Sent folder
 * still groups by `thread_id`, so the split only shows up in the recipient's
 * client. Hence tests at the resolution boundary rather than on the UI.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildReferencesChain,
	resolveOriginalEmail,
	resolveThreadedSend,
} from "../workers/lib/email-helpers";
import { findIdByMessageId } from "../workers/durableObject/references";
import type { EmailFull } from "../workers/lib/schemas";
import {
	findThreadParent,
	replyTargetForDraft,
} from "../app/lib/thread-parent";

/** A received message: `message_id` is the counterparty's, `id` is ours. */
const PARENT: EmailFull = {
	id: "row-parent",
	message_id: "parent@sender.example",
	subject: "Q3 budget",
	sender: "alice@sender.example",
	recipient: "hello@tapetide.com",
	cc: null,
	bcc: null,
	date: "2026-08-10T09:30:00.000Z",
	read: true,
	starred: false,
	in_reply_to: "root@sender.example",
	email_references: JSON.stringify(["root@sender.example"]),
	thread_id: "root@sender.example",
	folder_id: "inbox",
	body: "<p>Numbers attached.</p>",
};

/**
 * A draft as Undo Send leaves it: demoted out of Scheduled, naming its parent by
 * Message-ID because the send path wrote the row, not the composer.
 */
const DEMOTED_DRAFT: EmailFull = {
	...PARENT,
	id: "row-draft",
	message_id: "ours@tapetide.com",
	sender: "hello@tapetide.com",
	recipient: "alice@sender.example",
	folder_id: "draft",
	in_reply_to: "parent@sender.example",
	email_references: null,
	thread_id: "root@sender.example",
	body: "<p>Reply in progress.</p>",
};

/** A draft as the composer writes it: parent named by row id. */
const COMPOSER_DRAFT: EmailFull = {
	...DEMOTED_DRAFT,
	id: "row-draft-2",
	message_id: null,
	in_reply_to: "row-parent",
};

/**
 * Stub whose `getEmailByRef` resolves the way the Durable Object does: row id
 * first, then `message_id`.
 *
 * Modelling both lookups is the point — a stub that matched on id alone would
 * pass against the old code and prove nothing.
 */
function makeStub(...rows: EmailFull[]) {
	const getEmailByRef = vi.fn(async (ref: string) => {
		return (
			rows.find((r) => r.id === ref) ??
			rows.find((r) => !!r.message_id && r.message_id === ref) ??
			null
		);
	});
	const getEmail = vi.fn(async (id: string) => {
		return rows.find((r) => r.id === id) ?? null;
	});
	return { getEmailByRef, getEmail } as never;
}

// ── The server-side resolution ─────────────────────────────────────

describe("resolveOriginalEmail", () => {
	it("follows a draft that names its parent by Message-ID", async () => {
		// The Undo Send case. This used to return the draft itself.
		const resolved = await resolveOriginalEmail(
			makeStub(PARENT, DEMOTED_DRAFT),
			DEMOTED_DRAFT,
		);

		expect(resolved.id).toBe("row-parent");
	});

	it("still follows a draft that names its parent by row id", async () => {
		const resolved = await resolveOriginalEmail(
			makeStub(PARENT, COMPOSER_DRAFT),
			COMPOSER_DRAFT,
		);

		expect(resolved.id).toBe("row-parent");
	});

	it("returns the draft unchanged when the parent is genuinely gone", async () => {
		// Deleted parent. Threading against the draft is the only thing left, and
		// it must not throw.
		const resolved = await resolveOriginalEmail(
			makeStub(DEMOTED_DRAFT),
			DEMOTED_DRAFT,
		);

		expect(resolved.id).toBe("row-draft");
	});

	it("leaves a non-draft alone without a lookup", async () => {
		const stub = makeStub(PARENT);
		const resolved = await resolveOriginalEmail(stub, PARENT);

		expect(resolved.id).toBe("row-parent");
		expect(
			(stub as unknown as { getEmailByRef: ReturnType<typeof vi.fn> })
				.getEmailByRef,
		).not.toHaveBeenCalled();
	});
});

describe("resolveThreadedSend", () => {
	it("threads a demoted draft onto the real conversation", async () => {
		// The regression, stated as the outcome that matters: the reply has to carry
		// the parent's ancestry, not start a new chain.
		const result = await resolveThreadedSend(
			makeStub(PARENT, DEMOTED_DRAFT),
			DEMOTED_DRAFT.id,
			"reply",
		);

		expect(result).not.toBeNull();
		expect(result?.inReplyTo).toBe("parent@sender.example");
		expect(result?.references).toEqual([
			"root@sender.example",
			"parent@sender.example",
		]);
		expect(result?.threadId).toBe("root@sender.example");
	});

	it("accepts a Message-ID where a row id used to be required", async () => {
		// What the composer posts for a demoted draft. This returned null, which the
		// route turned into 404 "Original email not found" and the user saw as a
		// failed send.
		const result = await resolveThreadedSend(
			makeStub(PARENT),
			"parent@sender.example",
			"reply",
		);

		expect(result).not.toBeNull();
		expect(result?.threadId).toBe("root@sender.example");
	});

	it("still accepts a row id", async () => {
		const result = await resolveThreadedSend(
			makeStub(PARENT),
			"row-parent",
			"reply",
		);

		expect(result?.inReplyTo).toBe("parent@sender.example");
	});

	it("returns null for a reference that matches nothing", async () => {
		// Must stay a 404 rather than silently sending unthreaded.
		expect(
			await resolveThreadedSend(makeStub(PARENT), "nothing@nowhere", "reply"),
		).toBeNull();
	});

	it("does not mark the thread read for a forward", async () => {
		const result = await resolveThreadedSend(
			makeStub(PARENT, DEMOTED_DRAFT),
			DEMOTED_DRAFT.id,
			"forward",
		);

		expect(result?.markThreadRead).toBeNull();
		// Threading still applies: a forward stays in the source conversation.
		expect(result?.threadId).toBe("root@sender.example");
	});

});

// ── The Message-ID half of the resolver, against real SQLite ───────

/**
 * `findIdByMessageId` runs real SQL, so it is tested against real SQLite via
 * `node:sqlite` — the same engine behind Durable Object storage. The tie-break is
 * an `ORDER BY`, and a fake returning canned rows would confirm nothing about it.
 *
 * The row-id-first precedence lives in `MailboxDO.getEmailByRef`, which cannot be
 * imported here (`cloudflare:workers` does not resolve in Node); the stub above
 * mirrors it, and the two-line delegate is what the module split exists to keep
 * trivial.
 */
describe("findIdByMessageId", () => {
	let db: DatabaseSync;

	const seed = (id: string, messageId: string | null, date: string) =>
		db
			.prepare(
				`INSERT INTO emails (id, folder_id, message_id, date) VALUES (?, 'inbox', ?, ?)`,
			)
			.run(id, messageId, date);

	beforeEach(() => {
		db = new DatabaseSync(":memory:");
		db.exec(`CREATE TABLE emails (
			id TEXT PRIMARY KEY,
			folder_id TEXT NOT NULL,
			message_id TEXT,
			date TEXT
		)`);
	});

	const ctx = () =>
		({
			storage: {
				sql: {
					exec(sql: string, ...params: unknown[]) {
						const rows = db.prepare(sql).all(...(params as never[]));
						return { toArray: () => rows, rowsWritten: 0 };
					},
				},
			},
		}) as unknown as DurableObjectState;

	it("finds the message carrying a Message-ID", () => {
		seed("row-a", "a@sender.example", "2026-08-10T09:00:00.000Z");

		expect(findIdByMessageId(ctx(), "a@sender.example")).toBe("row-a");
	});

	it("returns null when nothing carries it", () => {
		seed("row-a", "a@sender.example", "2026-08-10T09:00:00.000Z");

		expect(findIdByMessageId(ctx(), "b@sender.example")).toBeNull();
	});

	it("picks the newest when a Message-ID is duplicated", () => {
		// `message_id` is indexed but deliberately not UNIQUE — see dedupe.ts — so
		// duplicates are possible and the choice has to be deterministic. A reply
		// belongs on the most recent copy.
		seed("row-old", "dup@sender.example", "2026-08-01T09:00:00.000Z");
		seed("row-new", "dup@sender.example", "2026-08-20T09:00:00.000Z");

		expect(findIdByMessageId(ctx(), "dup@sender.example")).toBe("row-new");
	});

	it("breaks a tie on identical dates deterministically", () => {
		// Stable across calls, rather than whatever the index happens to return.
		seed("row-a", "dup@sender.example", "2026-08-10T09:00:00.000Z");
		seed("row-b", "dup@sender.example", "2026-08-10T09:00:00.000Z");

		expect(findIdByMessageId(ctx(), "dup@sender.example")).toBe("row-b");
		expect(findIdByMessageId(ctx(), "dup@sender.example")).toBe("row-b");
	});

	it("never matches a row with no Message-ID", () => {
		// Otherwise a draft with no parent would resolve to an arbitrary message.
		seed("row-a", null, "2026-08-10T09:00:00.000Z");

		for (const ref of [null, undefined, "", "   "]) {
			expect(findIdByMessageId(ctx(), ref)).toBeNull();
		}
	});

	it("ignores surrounding whitespace on the reference", () => {
		seed("row-a", "a@sender.example", "2026-08-10T09:00:00.000Z");

		expect(findIdByMessageId(ctx(), "  a@sender.example  ")).toBe("row-a");
	});
});

describe("buildReferencesChain", () => {
	it("uses the Message-ID, falling back to the row id", () => {
		// Pinned because the fallback is what makes a locally-composed message with
		// no Message-ID yet still citable.
		expect(buildReferencesChain(PARENT).originalMsgId).toBe(
			"parent@sender.example",
		);
		expect(
			buildReferencesChain({ ...PARENT, message_id: null }).originalMsgId,
		).toBe("row-parent");
	});
});

// ── The client-side lookup ─────────────────────────────────────────

/** Only the two fields the helper reads. */
const THREAD = [
	{ id: "row-parent", message_id: "parent@sender.example" },
	{ id: "row-older", message_id: "root@sender.example" },
	{ id: "row-draft", message_id: null },
];

describe("findThreadParent", () => {
	it("matches on row id", () => {
		expect(findThreadParent(THREAD, "row-parent")?.id).toBe("row-parent");
	});

	it("matches on Message-ID", () => {
		// The Undo Send case, in the reading pane: without this, Edit opened a reply
		// composer with no original attached.
		expect(findThreadParent(THREAD, "parent@sender.example")?.id).toBe(
			"row-parent",
		);
	});

	it("prefers a row id over a Message-ID, matching the server", () => {
		const ambiguous = [
			{ id: "b", message_id: "a" },
			{ id: "a", message_id: "z" },
		];
		expect(findThreadParent(ambiguous, "a")?.id).toBe("a");
	});

	it("picks the newest of duplicate Message-IDs, as the server does", () => {
		// `message_id` is not unique by index, so duplicates are reachable. Taking
		// array order instead resolved to a different row than `findIdByMessageId`
		// would, and this helper exists precisely to agree with it.
		const duplicated = [
			{ id: "old", message_id: "dup@x", date: "2026-01-01T10:00:00Z" },
			{ id: "new", message_id: "dup@x", date: "2026-02-01T10:00:00Z" },
		];
		expect(findThreadParent(duplicated, "dup@x")?.id).toBe("new");
	});

	it("breaks a same-date tie by id descending, as the server does", () => {
		// The case the old array-order lookup got backwards: `getThreadEmails`
		// returns same-dated rows id-ascending, so `find` took the lower id while
		// the server took the higher.
		const sameDate = [
			{ id: "row-a", message_id: "dup@x", date: "2026-01-01T10:00:00Z" },
			{ id: "row-b", message_id: "dup@x", date: "2026-01-01T10:00:00Z" },
		];
		expect(findThreadParent(sameDate, "dup@x")?.id).toBe("row-b");
		// Stable regardless of the order they arrive in.
		expect(findThreadParent([...sameDate].reverse(), "dup@x")?.id).toBe("row-b");
	});

	it("still resolves a single Message-ID match with no date at all", () => {
		// List projections and hand-built fixtures need not carry `date`.
		expect(findThreadParent(THREAD, "parent@sender.example")?.id).toBe(
			"row-parent",
		);
	});

	it("returns undefined for an absent or empty reference", () => {
		expect(findThreadParent(THREAD, null)).toBeUndefined();
		expect(findThreadParent(THREAD, undefined)).toBeUndefined();
		expect(findThreadParent(THREAD, "")).toBeUndefined();
		expect(findThreadParent(THREAD, "unknown")).toBeUndefined();
	});

	it("does not match a null message_id against a null reference", () => {
		// `row-draft` has message_id null; a null ref must not select it.
		expect(findThreadParent(THREAD, null)).toBeUndefined();
	});
});

describe("replyTargetForDraft", () => {
	it("resolves a visible parent to its row id", () => {
		expect(
			replyTargetForDraft(THREAD, { in_reply_to: "parent@sender.example" }),
		).toBe("row-parent");
	});

	it("passes an unresolvable reference through for the server to resolve", () => {
		// The capped-thread-window case. `getThreadEmails` is limited to
		// MAX_THREAD_MESSAGES, so in a long conversation the parent may not be
		// loaded — and returning nothing here dropped In-Reply-To and References
		// entirely, starting a fresh conversation at the far end.
		expect(
			replyTargetForDraft(THREAD, { in_reply_to: "not-loaded@sender.example" }),
		).toBe("not-loaded@sender.example");
	});

	it("returns undefined for a draft that answers nothing", () => {
		// A brand-new draft must not acquire threading it never had.
		expect(replyTargetForDraft(THREAD, { in_reply_to: null })).toBeUndefined();
		expect(replyTargetForDraft(THREAD, {})).toBeUndefined();
	});
});
