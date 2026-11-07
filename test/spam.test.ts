// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for spam classification and the sender lists behind it.
 *
 * Two things are worth pinning down, and they fail in opposite directions.
 *
 * The scorer's job is to be *reluctant*. A false positive hides mail the user
 * may never go looking for, so the tests below assert not just that junk is
 * caught but that ordinary business mail — a forwarded message, a helpdesk with
 * a different Reply-To, a newsletter, an all-caps ticket subject — stays in the
 * inbox. Those are the cases that lose a user's trust in a filter.
 *
 * The sender lists are tested against real SQLite via `node:sqlite`, driving the
 * actual migrations, because the interesting behaviour is in the matching: a
 * block stored as "@example.com" has to catch every address at that domain, and
 * "Not spam" has to clear whichever form of rule caught the message. The bug
 * this replaces was exactly that — "Not spam" moved the message and left the
 * block in place, so the next one went straight back to Spam.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
	SPAM_SCORE_THRESHOLD,
	classifySpam,
	parseSpamSignals,
	serializeSpamSignals,
} from "../shared/spam";
import type { AuthenticationResults } from "../shared/auth-results";
import { applyMigrations, mailboxMigrations } from "../workers/durableObject/migrations";
import {
	allowSender,
	blockSender,
	disallowSender,
	getAllowedSenders,
	getBlockedSenders,
	hasSentTo,
	isSenderAllowed,
	isSenderBlocked,
	markNotSpam,
	unblockSender,
	unblockSenderMatching,
} from "../workers/durableObject/features";

function auth(partial: Partial<AuthenticationResults>): AuthenticationResults {
	return { viaArc: false, ...partial };
}

/** The shape of an ordinary message from a stranger that nothing is wrong with. */
const CLEAN = {
	from: "sam@partner.example",
	fromName: "Sam Patel",
	subject: "Contract for review",
	body: "Hi, attaching the contract we discussed. Let me know your thoughts.",
	auth: auth({ spf: "pass", dkim: "pass", dmarc: "pass" }),
};

describe("classifySpam — authentication", () => {
	it("files a DMARC failure as spam on its own", () => {
		// The sending domain's own published policy says this is forged. Nothing
		// else available is a stronger signal, so it does not need corroboration.
		const verdict = classifySpam({
			...CLEAN,
			auth: auth({ spf: "fail", dkim: "fail", dmarc: "fail" }),
		});

		expect(verdict.isSpam).toBe(true);
		expect(verdict.signals.map((s) => s.id)).toContain("dmarc-fail");
	});

	it("files a message where both SPF and DKIM failed", () => {
		const verdict = classifySpam({
			...CLEAN,
			auth: auth({ spf: "fail", dkim: "fail" }),
		});

		expect(verdict.isSpam).toBe(true);
		expect(verdict.signals.map((s) => s.id)).toContain("spf-dkim-fail");
	});

	it("does not file a message on an SPF failure alone", () => {
		// This is what a plainly forwarded message looks like. Forwarding is
		// common and legitimate, so on its own it must not be enough.
		const verdict = classifySpam({
			...CLEAN,
			auth: auth({ spf: "fail", dkim: "pass" }),
		});

		expect(verdict.isSpam).toBe(false);
	});

	it("does not file a message that was never authenticated", () => {
		// No verdicts means we know nothing, which is not the same as knowing
		// something is wrong.
		expect(classifySpam({ ...CLEAN, auth: null }).isSpam).toBe(false);
		expect(classifySpam({ from: "x@y.example" }).isSpam).toBe(false);
	});

	it("keeps a fully authenticated message at zero", () => {
		const verdict = classifySpam(CLEAN);
		expect(verdict.score).toBe(0);
		expect(verdict.isSpam).toBe(false);
	});
});

describe("classifySpam — identity mismatches", () => {
	it("scores a display name impersonating another domain", () => {
		const verdict = classifySpam({
			...CLEAN,
			fromName: "billing@yourbank.example",
			from: "attacker@evil.test",
		});

		expect(verdict.signals.map((s) => s.id)).toContain("display-name-spoof");
	});

	it("ignores a display name showing the sender's own address", () => {
		const verdict = classifySpam({
			...CLEAN,
			fromName: "sam@partner.example",
			from: "sam@partner.example",
		});

		expect(verdict.signals.map((s) => s.id)).not.toContain("display-name-spoof");
	});

	it("treats a subdomain as the same organisation", () => {
		// `mail.partner.example` sending as `partner.example` is routine.
		const verdict = classifySpam({
			...CLEAN,
			fromName: "noreply@partner.example",
			from: "noreply@mail.partner.example",
		});

		expect(verdict.signals.map((s) => s.id)).not.toContain("display-name-spoof");
	});

	it("does not file a helpdesk that redirects replies", () => {
		// A different Reply-To is how every ticketing system works. It counts for
		// something, but nowhere near enough on its own.
		const verdict = classifySpam({
			...CLEAN,
			replyTo: "support@helpdesk.example",
		});

		expect(verdict.signals.map((s) => s.id)).toContain("reply-to-mismatch");
		expect(verdict.isSpam).toBe(false);
	});
});

describe("classifySpam — attachments", () => {
	it("scores an executable attachment", () => {
		const verdict = classifySpam({
			...CLEAN,
			attachmentNames: ["invoice.exe"],
		});

		expect(verdict.signals.map((s) => s.id)).toContain("dangerous-attachment");
	});

	it("sees through a benign-looking double extension", () => {
		const verdict = classifySpam({
			...CLEAN,
			attachmentNames: ["invoice.pdf.exe"],
		});

		expect(verdict.signals.map((s) => s.id)).toContain("dangerous-attachment");
	});

	it("leaves ordinary business attachments alone", () => {
		const verdict = classifySpam({
			...CLEAN,
			attachmentNames: ["contract.pdf", "figures.xlsx", "logo.png", "notes"],
		});

		expect(verdict.score).toBe(0);
	});
});

describe("classifySpam — restraint on legitimate mail", () => {
	it("does not file a newsletter", () => {
		// Marketing the user signed up for is not spam, and scoring it as such is
		// how a filter starts eating wanted mail.
		const verdict = classifySpam({
			from: "news@retailer.example",
			fromName: "Retailer Weekly",
			subject: "Your weekly deals are here",
			body:
				"<p>Big savings this week on everything in store. " +
				"Read our guide to the season, browse the new arrivals, " +
				"and check out what other customers are buying.</p>" +
				"<a href='https://retailer.example/1'>one</a>" +
				"<a href='https://retailer.example/2'>two</a>" +
				"<a href='https://retailer.example/unsubscribe'>unsubscribe</a>",
			auth: auth({ spf: "pass", dkim: "pass", dmarc: "pass" }),
		});

		expect(verdict.isSpam).toBe(false);
	});

	it("does not file an urgent invoice from an authenticated sender", () => {
		// Money, urgency and the word "invoice" are all deliberately unscored:
		// they describe most of a small business's inbox.
		const verdict = classifySpam({
			...CLEAN,
			subject: "URGENT: invoice #4021 overdue - payment required",
			body: "Your invoice for $4,200 is overdue. Please pay immediately.",
		});

		expect(verdict.isSpam).toBe(false);
	});

	it("does not file on an all-caps subject alone", () => {
		const verdict = classifySpam({
			...CLEAN,
			subject: "ACTION REQUIRED BEFORE FRIDAY",
		});

		expect(verdict.signals.map((s) => s.id)).toContain("shouting-subject");
		expect(verdict.isSpam).toBe(false);
	});

	it("does not treat a short acronym subject as shouting", () => {
		expect(
			classifySpam({ ...CLEAN, subject: "RE: API v2" }).signals.map((s) => s.id),
		).not.toContain("shouting-subject");
	});

	it("needs several independent signals to reach the threshold", () => {
		// The calibration claim: no combination of soft signals files a message
		// unless it looks wrong in genuinely different ways.
		const verdict = classifySpam({
			from: "no-reply@sketchy.test",
			fromName: "accounts@yourbank.example",
			replyTo: "collect@another.test",
			subject: "YOUR ACCOUNT IS SUSPENDED",
			attachmentNames: ["statement.pdf.scr"],
			auth: auth({ spf: "softfail" }),
		});

		expect(verdict.isSpam).toBe(true);
	});
});

describe("classifySpam — ham overrides", () => {
	const forged = {
		from: "attacker@evil.test",
		fromName: "accounts@yourbank.example",
		replyTo: "collect@another.test",
		subject: "YOUR ACCOUNT IS SUSPENDED NOW",
		attachmentNames: ["statement.scr"],
		auth: auth({ spf: "softfail" }),
	};

	it("holds a message in the inbox when it continues a known thread", () => {
		expect(classifySpam(forged).isSpam).toBe(true);
		expect(classifySpam({ ...forged, inKnownThread: true }).isSpam).toBe(false);
	});

	it("holds a message from someone the user has written to", () => {
		expect(
			classifySpam({ ...forged, isKnownCorrespondent: true }).isSpam,
		).toBe(false);
	});

	it("records why it was held", () => {
		const verdict = classifySpam({ ...forged, inKnownThread: true });
		expect(verdict.signals.map((s) => s.id)).toContain("known-thread");
	});

	it("still files a forged message from a known correspondent", () => {
		// The override is about familiarity, and a familiar-looking sender failing
		// authentication is precisely the case it must not rescue: that is what a
		// compromised or spoofed contact looks like.
		const verdict = classifySpam({
			...forged,
			auth: auth({ dmarc: "fail" }),
			inKnownThread: true,
			isKnownCorrespondent: true,
		});

		expect(verdict.isSpam).toBe(true);
	});

	it("keeps the scored signals rather than zeroing the score", () => {
		// Capped, not cancelled: the reasons survive so the UI can still explain
		// what the filter noticed.
		const verdict = classifySpam({ ...forged, inKnownThread: true });
		expect(verdict.score).toBe(SPAM_SCORE_THRESHOLD - 1);
		expect(verdict.signals.filter((s) => s.weight > 0).length).toBeGreaterThan(0);
	});
});

describe("spam signal serialisation", () => {
	it("round-trips the signals that scored", () => {
		const { signals } = classifySpam({
			...CLEAN,
			auth: auth({ dmarc: "fail" }),
		});

		const stored = serializeSpamSignals(signals);
		expect(parseSpamSignals(stored).map((s) => s.id)).toEqual(["dmarc-fail"]);
	});

	it("stores nothing when no signal fired", () => {
		expect(serializeSpamSignals(classifySpam(CLEAN).signals)).toBeNull();
	});

	it("omits zero-weight explanatory signals", () => {
		const { signals } = classifySpam({ from: "a@b.example", inKnownThread: true });
		expect(serializeSpamSignals(signals)).toBeNull();
	});

	it("survives anything else in the column", () => {
		// Older rows, or a hand-edited value; a malformed blob must not break the
		// reading pane.
		expect(parseSpamSignals(null)).toEqual([]);
		expect(parseSpamSignals("not json")).toEqual([]);
		expect(parseSpamSignals('{"id":"x"}')).toEqual([]);
		// Entries missing either field are dropped rather than rendered blank.
		expect(parseSpamSignals('[{"id":"x"},{"nope":1}]')).toEqual([]);
		expect(parseSpamSignals('[{"id":"x","label":"why"}]')).toEqual([
			{ id: "x", label: "why" },
		]);
	});
});

/**
 * Real SQLite, real migrations. `node:sqlite` is the same engine behind Durable
 * Object storage, so `RETURNING`, numbered parameters and the `datetime('now')`
 * defaults all behave as they do in production.
 */
function fakeCtx() {
	const db = new DatabaseSync(":memory:");

	const ctx = {
		storage: {
			sql: {
				exec(sql: string, ...params: unknown[]) {
					// Migration scripts are several statements in one string, which
					// `prepare` refuses; everything else is a single statement, which
					// `exec` cannot return rows from. Tell them apart by looking for a
					// statement separator with something after it.
					const isScript = /;\s*\S/.test(sql);
					const rows = isScript
						? (db.exec(sql), [] as unknown[])
						: (db.prepare(sql).all(...(params as never[])) as unknown[]);

					// The real cursor is iterable *and* has `toArray`; the migration
					// runner spreads it, the feature helpers call `toArray`.
					return {
						toArray: () => rows,
						rowsWritten: rows.length,
						[Symbol.iterator]: () => rows[Symbol.iterator](),
					};
				},
			},
			transactionSync: <T>(fn: () => T) => fn(),
		},
	};

	applyMigrations(ctx.storage.sql as never, mailboxMigrations);
	return ctx as unknown as DurableObjectState;
}

function insertEmail(
	ctx: DurableObjectState,
	id: string,
	sender: string,
	folder: string,
) {
	ctx.storage.sql.exec(
		`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, spam_score)
		 VALUES (?, ?, 'Subject', ?, 'me@example.com', '2026-01-01T00:00:00.000Z', 'Body', 9.5)`,
		id,
		folder,
		sender,
	);
}

describe("sender lists", () => {
	let ctx: DurableObjectState;

	beforeEach(() => {
		ctx = fakeCtx();
	});

	it("applies migration 20, so scoring has somewhere to write", () => {
		// Also the guard that the migration runner accepted the new entry at all.
		insertEmail(ctx, "e1", "a@b.example", "inbox");
		const [row] = ctx.storage.sql
			.exec(`SELECT spam_score FROM emails WHERE id = ?`, "e1")
			.toArray() as { spam_score: number }[];
		expect(row.spam_score).toBe(9.5);
	});

	it("matches a blocked address exactly", () => {
		blockSender(ctx, "spam@bad.test");

		expect(isSenderBlocked(ctx, "spam@bad.test")).toBe(true);
		expect(isSenderBlocked(ctx, "other@bad.test")).toBe(false);
		// Case is normalised on the way in and on the way through.
		expect(isSenderBlocked(ctx, "SPAM@BAD.TEST")).toBe(true);
	});

	it("matches every address at a blocked domain", () => {
		blockSender(ctx, "@bad.test");

		expect(isSenderBlocked(ctx, "anyone@bad.test")).toBe(true);
		expect(isSenderBlocked(ctx, "someone@good.test")).toBe(false);
	});

	it("rejects a duplicate rather than listing a sender twice", () => {
		expect(blockSender(ctx, "spam@bad.test")).not.toBeNull();
		expect(blockSender(ctx, "spam@bad.test")).toBeNull();
		expect(getBlockedSenders(ctx)).toHaveLength(1);
	});

	it("keeps the two lists independent", () => {
		blockSender(ctx, "spam@bad.test");
		allowSender(ctx, "sam@partner.example");

		expect(isSenderBlocked(ctx, "sam@partner.example")).toBe(false);
		expect(isSenderAllowed(ctx, "spam@bad.test")).toBe(false);
		expect(getBlockedSenders(ctx)).toHaveLength(1);
		expect(getAllowedSenders(ctx)).toHaveLength(1);
	});

	it("removes a rule by id, and reports an unknown id", () => {
		const rule = blockSender(ctx, "spam@bad.test")!;
		expect(unblockSender(ctx, rule.id)).toBe(true);
		expect(unblockSender(ctx, rule.id)).toBe(false);
		expect(isSenderBlocked(ctx, "spam@bad.test")).toBe(false);

		const allow = allowSender(ctx, "sam@partner.example")!;
		expect(disallowSender(ctx, allow.id)).toBe(true);
		expect(disallowSender(ctx, allow.id)).toBe(false);
	});

	it("clears both forms of block rule for one address", () => {
		// The user gesture names a sender, not a rule. Clearing only the exact
		// address would leave a domain-wide block still filing their mail.
		blockSender(ctx, "spam@bad.test");
		blockSender(ctx, "@bad.test");
		blockSender(ctx, "elsewhere@other.test");

		const removed = unblockSenderMatching(ctx, "spam@bad.test");

		expect(removed.sort()).toEqual(["@bad.test", "spam@bad.test"]);
		expect(isSenderBlocked(ctx, "spam@bad.test")).toBe(false);
		// Unrelated rules are untouched.
		expect(isSenderBlocked(ctx, "elsewhere@other.test")).toBe(true);
	});

	it("reports nothing removed for an address that was never blocked", () => {
		expect(unblockSenderMatching(ctx, "stranger@nowhere.test")).toEqual([]);
	});
});

/**
 * The ham signal that keeps replies from customers out of Spam, so its failure
 * mode is a false positive on wanted mail. `recipient` is a comma-joined list,
 * which is where the interesting cases are.
 */
describe("hasSentTo", () => {
	let ctx: DurableObjectState;

	beforeEach(() => {
		ctx = fakeCtx();
	});

	function insertSent(id: string, recipient: string) {
		ctx.storage.sql.exec(
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body)
			 VALUES (?, 'sent', 'Subject', 'me@example.com', ?, '2026-01-01T00:00:00.000Z', 'Body')`,
			id,
			recipient,
		);
	}

	it("finds a sole recipient", () => {
		insertSent("s1", "sam@partner.example");
		expect(hasSentTo(ctx, "sam@partner.example")).toBe(true);
		expect(hasSentTo(ctx, "nobody@partner.example")).toBe(false);
	});

	it("finds an entry anywhere in a recipient list", () => {
		insertSent("s1", "first@a.example, sam@partner.example, last@b.example");

		expect(hasSentTo(ctx, "first@a.example")).toBe(true);
		expect(hasSentTo(ctx, "sam@partner.example")).toBe(true);
		expect(hasSentTo(ctx, "last@b.example")).toBe(true);
	});

	it("does not care how the list was joined", () => {
		// Outbound sends join with ", ", but a caller handing `to` over as a bare
		// comma-separated string produces no spaces at all.
		insertSent("s1", "a@x.example,sam@partner.example,b@y.example");
		expect(hasSentTo(ctx, "sam@partner.example")).toBe(true);
	});

	it("does not match a partial address", () => {
		// The reason entries are compared between delimiters rather than by
		// substring.
		insertSent("s1", "notsam@partner.example");
		expect(hasSentTo(ctx, "sam@partner.example")).toBe(false);
	});

	it("treats an underscore as a literal, not a wildcard", () => {
		// An email address is not a safe LIKE pattern: `_` is legal in a local part
		// and would match any character, so this would pass under LIKE.
		insertSent("s1", "axb@partner.example");
		expect(hasSentTo(ctx, "a_b@partner.example")).toBe(false);

		insertSent("s2", "a_b@partner.example");
		expect(hasSentTo(ctx, "a_b@partner.example")).toBe(true);
	});

	it("ignores case on both sides", () => {
		insertSent("s1", "Sam@Partner.Example");
		expect(hasSentTo(ctx, "sam@partner.example")).toBe(true);
		expect(hasSentTo(ctx, "SAM@PARTNER.EXAMPLE")).toBe(true);
	});

	it("only counts mail that was actually sent", () => {
		// Receiving from someone says nothing about wanting to hear from them, and
		// a draft is not correspondence.
		insertEmail(ctx, "r1", "sam@partner.example", "inbox");
		ctx.storage.sql.exec(
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body)
			 VALUES ('d1', 'draft', 'S', 'me@example.com', ?, '2026-01-01T00:00:00.000Z', 'B')`,
			"drafted@partner.example",
		);

		expect(hasSentTo(ctx, "drafted@partner.example")).toBe(false);
	});

	it("says no for a blank address", () => {
		insertSent("s1", "sam@partner.example");
		expect(hasSentTo(ctx, "   ")).toBe(false);
	});
});

describe("markNotSpam", () => {
	let ctx: DurableObjectState;

	beforeEach(() => {
		ctx = fakeCtx();
	});

	it("moves the message, clears the block and allowlists the sender", () => {
		// The whole point: all three, or the next message comes straight back.
		insertEmail(ctx, "e1", "sam@partner.example", "spam");
		blockSender(ctx, "sam@partner.example");

		const result = markNotSpam(ctx, "e1");

		expect(result).toMatchObject({
			folder: "inbox",
			unblocked: ["sam@partner.example"],
			allowed: "sam@partner.example",
		});
		expect(isSenderBlocked(ctx, "sam@partner.example")).toBe(false);
		expect(isSenderAllowed(ctx, "sam@partner.example")).toBe(true);

		const [row] = ctx.storage.sql
			.exec(`SELECT folder_id, spam_score, spam_signals FROM emails WHERE id = ?`, "e1")
			.toArray() as { folder_id: string; spam_score: number | null; spam_signals: string | null }[];
		expect(row.folder_id).toBe("inbox");
		// Nothing downstream should still describe this as spam.
		expect(row.spam_score).toBeNull();
		expect(row.spam_signals).toBeNull();
	});

	it("clears a domain-wide block that caught the message", () => {
		insertEmail(ctx, "e1", "sam@partner.example", "spam");
		blockSender(ctx, "@partner.example");

		markNotSpam(ctx, "e1");

		expect(isSenderBlocked(ctx, "sam@partner.example")).toBe(false);
	});

	it("works on a message that was scored rather than blocked", () => {
		// The heuristic case, where there is no block rule to clear at all.
		insertEmail(ctx, "e1", "sam@partner.example", "spam");

		const result = markNotSpam(ctx, "e1");

		expect(result).toMatchObject({ unblocked: [], allowed: "sam@partner.example" });
		expect(isSenderAllowed(ctx, "sam@partner.example")).toBe(true);
	});

	it("is idempotent when the sender is already allowlisted", () => {
		insertEmail(ctx, "e1", "sam@partner.example", "spam");
		allowSender(ctx, "sam@partner.example");

		// `allowed` is null because this call was not the one that listed them —
		// which is not a failure, the sender is still allowlisted either way.
		expect(markNotSpam(ctx, "e1")).toMatchObject({ allowed: null });
		expect(isSenderAllowed(ctx, "sam@partner.example")).toBe(true);
		expect(getAllowedSenders(ctx)).toHaveLength(1);
	});

	it("reports an unknown message instead of claiming success", () => {
		expect(markNotSpam(ctx, "missing")).toBeNull();
	});
});
