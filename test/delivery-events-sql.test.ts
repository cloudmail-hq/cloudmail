// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The ledger against real SQLite, same harness and reasoning as
 * `record-delivery-sql.test.ts`: the behaviour under test is which rows land and
 * how the derived cache is recomputed, and a fake that records query strings
 * would only prove the SQL contains the right words. These assertions also catch
 * a column missing from the migration, which a fake cannot see.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
	appendDeliveryEvent,
	getDeliveryEvents,
	getSentAnalytics,
	recomputeDeliveryStatus,
	reconcileProviderEvents,
} from "../workers/durableObject/features";

function sqlStorage(db: DatabaseSync): DurableObjectState {
	return {
		storage: {
			sql: {
				exec(query: string, ...bindings: unknown[]) {
					const statement = db.prepare(query);
					const isSelect = /^\s*select/i.test(query);
					if (isSelect) {
						const rows = statement.all(...(bindings as never[])) as Record<
							string,
							unknown
						>[];
						return {
							toArray: () => rows,
							rowsWritten: 0,
							[Symbol.iterator]: () => rows[Symbol.iterator](),
						};
					}
					const info = statement.run(...(bindings as never[]));
					return {
						toArray: () => [],
						rowsWritten: Number(info.changes ?? 0),
						[Symbol.iterator]: () => [][Symbol.iterator](),
					};
				},
			},
		},
	} as unknown as DurableObjectState;
}

let db: DatabaseSync;
let ctx: DurableObjectState;

function seedSent(id: string, deliveryStatus: string | null = null) {
	db.prepare(
		`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, delivery_status)
		 VALUES (?, 'sent', 'Hello', 'support@tapetide.com', 'user@example.org',
		         '2026-08-21T09:00:00.000Z', '<p>Hi</p>', ?)`,
	).run(id, deliveryStatus);
}

function seedSentWithProviderId(
	id: string,
	messageId: string,
	deliveryStatus: string | null = null,
) {
	db.prepare(
		`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, message_id, delivery_status)
		 VALUES (?, 'sent', 'Hello', 'support@tapetide.com', 'user@example.org',
		         '2026-08-21T09:00:00.000Z', '<p>Hi</p>', ?, ?)`,
	).run(id, messageId, deliveryStatus);
}

function readStatus(id: string) {
	return (
		db
			.prepare(`SELECT delivery_status FROM emails WHERE id = ?`)
			.get(id) as { delivery_status: string | null }
	).delivery_status;
}

beforeEach(() => {
	db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE emails (
			id TEXT PRIMARY KEY, folder_id TEXT NOT NULL,
			subject TEXT, sender TEXT, recipient TEXT, date TEXT,
			body TEXT, message_id TEXT, delivery_status TEXT, delivery_error TEXT
		);
		CREATE TABLE delivery_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			email_id TEXT NOT NULL, recipient TEXT,
			event_type TEXT NOT NULL, source TEXT NOT NULL,
			provider_message_id TEXT, error_cause TEXT, error_detail TEXT,
			metadata TEXT, dedupe_key TEXT,
			occurred_at TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE UNIQUE INDEX idx_delivery_events_dedupe
			ON delivery_events(dedupe_key) WHERE dedupe_key IS NOT NULL;
	`);
	ctx = sqlStorage(db);
});

describe("appendDeliveryEvent", () => {
	it("writes an event and reads it back", () => {
		seedSent("m1");
		const wrote = appendDeliveryEvent(ctx, {
			emailId: "m1",
			type: "delivered",
			source: "graphql",
			recipient: "User@Example.ORG",
			occurredAt: "2026-08-21T10:00:00Z",
		});
		expect(wrote).toBe(true);

		const events = getDeliveryEvents(ctx, "m1");
		expect(events).toHaveLength(1);
		expect(events[0].event_type).toBe("delivered");
		// Recipient is normalised to bare lowercased, matching how recipients are
		// stored elsewhere so a later join lines up.
		expect(events[0].recipient).toBe("user@example.org");
	});

	it("dedupes a repeated provider verdict, so the reconciler is idempotent", () => {
		seedSent("m2");
		const key = "graphql:delivered:user@example.org";
		const first = appendDeliveryEvent(ctx, {
			emailId: "m2",
			type: "delivered",
			source: "graphql",
			dedupeKey: key,
			occurredAt: "2026-08-21T10:00:00Z",
		});
		const second = appendDeliveryEvent(ctx, {
			emailId: "m2",
			type: "delivered",
			source: "graphql",
			dedupeKey: key,
			occurredAt: "2026-08-21T10:05:00Z",
		});

		expect(first).toBe(true);
		expect(second).toBe(false); // no row written the second time
		expect(getDeliveryEvents(ctx, "m2")).toHaveLength(1);
	});

	it("never dedupes engagement events — every open is real signal", () => {
		seedSent("m3");
		appendDeliveryEvent(ctx, { emailId: "m3", type: "opened", source: "pixel" });
		appendDeliveryEvent(ctx, { emailId: "m3", type: "opened", source: "pixel" });
		expect(getDeliveryEvents(ctx, "m3")).toHaveLength(2);
	});

	it("stores metadata as JSON for engagement extras", () => {
		seedSent("m4");
		appendDeliveryEvent(ctx, {
			emailId: "m4",
			type: "clicked",
			source: "redirect",
			metadata: { url: "https://tapetide.com/pricing" },
		});
		const events = getDeliveryEvents(ctx, "m4");
		expect(JSON.parse(events[0].metadata!).url).toBe(
			"https://tapetide.com/pricing",
		);
	});

	it("caps an oversized error detail at the shared 500", () => {
		seedSent("m5");
		appendDeliveryEvent(ctx, {
			emailId: "m5",
			type: "bounced",
			source: "dsn",
			errorDetail: "x".repeat(900),
		});
		expect(getDeliveryEvents(ctx, "m5")[0].error_detail).toHaveLength(500);
	});

	it("never throws on a broken storage layer", () => {
		const broken = {
			storage: {
				sql: {
					exec() {
						throw new Error("storage gone");
					},
				},
			},
		} as unknown as DurableObjectState;
		expect(() =>
			appendDeliveryEvent(broken, {
				emailId: "x",
				type: "sent",
				source: "send",
			}),
		).not.toThrow();
	});
});

describe("recomputeDeliveryStatus", () => {
	it("promotes a stale failure to delivered when a reconciled delivery lands", () => {
		// The exact case the reconciler exists for: our send recorded a transient
		// failure, but CF's data shows the recipient's server accepted it.
		seedSent("m6", "failed");
		appendDeliveryEvent(ctx, {
			emailId: "m6",
			type: "failed",
			source: "send",
			occurredAt: "2026-08-21T10:00:00Z",
		});
		appendDeliveryEvent(ctx, {
			emailId: "m6",
			type: "delivered",
			source: "graphql",
			occurredAt: "2026-08-21T10:03:00Z",
		});

		recomputeDeliveryStatus(ctx, "m6");
		expect(readStatus("m6")).toBe("delivered");
	});

	it("records a failure the ledger can see", () => {
		seedSent("m7", null);
		appendDeliveryEvent(ctx, {
			emailId: "m7",
			type: "bounced",
			source: "dsn",
			occurredAt: "2026-08-21T10:00:00Z",
		});
		recomputeDeliveryStatus(ctx, "m7");
		expect(readStatus("m7")).toBe("failed");
	});

	it("leaves the cache untouched when nothing terminal is in the ledger", () => {
		// A message with only a genuine pre-ledger failure must not be wiped by a
		// recompute that sees only queued/sent.
		seedSent("m8", "failed");
		appendDeliveryEvent(ctx, {
			emailId: "m8",
			type: "sent",
			source: "send",
			occurredAt: "2026-08-21T10:00:00Z",
		});
		recomputeDeliveryStatus(ctx, "m8");
		expect(readStatus("m8")).toBe("failed");
	});
});

describe("reconcileProviderEvents", () => {
	it("resolves a provider id to the local row and files the verdict", () => {
		// The join the whole reconciler depends on: match on emails.message_id,
		// which recordDelivery populated with the provider's id on send.
		seedSentWithProviderId("local-1", "provider-abc@cf", "failed");

		const result = reconcileProviderEvents(ctx, [
			{
				emailId: "provider-abc@cf", // reconciler passes the provider id here
				type: "delivered",
				source: "graphql",
				providerMessageId: "provider-abc@cf",
				recipient: "user@example.org",
				occurredAt: "2026-08-21T10:05:00Z",
				dedupeKey: "graphql:delivered:provider-abc@cf:user@example.org",
			},
		]);

		expect(result.applied).toBe(1);
		// The event landed against the LOCAL id, not the provider id.
		const events = getDeliveryEvents(ctx, "local-1");
		expect(events).toHaveLength(1);
		expect(events[0].event_type).toBe("delivered");
		// And the reconciled delivery flipped the stale failure to delivered.
		expect(readStatus("local-1")).toBe("delivered");
	});

	it("skips a verdict whose provider id matches no local row", () => {
		// The zone sends from surfaces other than this app; reconciling only what
		// we sent is correct, and an unmatched verdict is not an error.
		const result = reconcileProviderEvents(ctx, [
			{
				emailId: "nope@cf",
				type: "delivered",
				source: "graphql",
				providerMessageId: "nope@cf",
				dedupeKey: "graphql:delivered:nope@cf:-",
			},
		]);
		expect(result.applied).toBe(0);
	});

	it("is idempotent across re-reads of the same window", () => {
		seedSentWithProviderId("local-2", "provider-xyz@cf");
		const verdict = {
			emailId: "provider-xyz@cf",
			type: "delivered" as const,
			source: "graphql" as const,
			providerMessageId: "provider-xyz@cf",
			recipient: "user@example.org",
			dedupeKey: "graphql:delivered:provider-xyz@cf:user@example.org",
		};

		const first = reconcileProviderEvents(ctx, [verdict]);
		const second = reconcileProviderEvents(ctx, [verdict]);

		expect(first.applied).toBe(1);
		expect(second.applied).toBe(0); // re-read wrote nothing new
		expect(getDeliveryEvents(ctx, "local-2")).toHaveLength(1);
	});

	// The three support@ sends from 2026-10-19..24 that stayed NULL in production.
	const liveVerdict = (providerId: string) => ({
		emailId: providerId,
		type: "delivered" as const,
		source: "graphql" as const,
		providerMessageId: providerId,
		recipient: "user@example.org",
		occurredAt: "2026-10-22T11:03:10Z",
		dedupeKey: `graphql:delivered:${providerId}:user@example.org`,
	});

	it("matches a row whose message_id was stored with angle brackets (agent/MCP send path)", () => {
		// `toolSendReply` stored send()'s messageId verbatim: `<…@tapetide.com>`.
		seedSentWithProviderId("agent-1", "<dtFllLaBeJTT8dNLWcPPzuAls2pVHT43oT91@tapetide.com>", "sent");
		const result = reconcileProviderEvents(ctx, [liveVerdict("dtFllLaBeJTT8dNLWcPPzuAls2pVHT43oT91@tapetide.com")]);
		expect(result).toEqual({ applied: 1, matched: 1 });
		expect(readStatus("agent-1")).toBe("delivered");
	});

	it("matches a sent message the user archived out of Sent", () => {
		db.prepare(
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, message_id)
			 VALUES ('arch-1', 'archive', 'Re: x', 'support@tapetide.com', 'user@example.org', '2026-10-19T04:29:47Z', '', 'ivCE@tapetide.com')`,
		).run();
		appendDeliveryEvent(ctx, { emailId: "arch-1", type: "sent", source: "send", providerMessageId: "ivCE@tapetide.com" });
		expect(reconcileProviderEvents(ctx, [liveVerdict("<ivCE@tapetide.com>")]).applied).toBe(1);
		expect(readStatus("arch-1")).toBe("delivered");
	});

	it("prefers the ledger-proven outbound row over another row in Sent with the same id", () => {
		seedSentWithProviderId("filed-in-sent", "dup@tapetide.com"); // no send event
		db.prepare(
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, message_id)
			 VALUES ('real-send', 'archive', 'x', 'support@tapetide.com', 'user@example.org', '2026-08-20T00:00:00Z', '', 'dup@tapetide.com')`,
		).run();
		appendDeliveryEvent(ctx, { emailId: "real-send", type: "sent", source: "send", providerMessageId: "dup@tapetide.com" });
		reconcileProviderEvents(ctx, [liveVerdict("dup@tapetide.com")]);
		expect(readStatus("real-send")).toBe("delivered");
		expect(getDeliveryEvents(ctx, "filed-in-sent")).toHaveLength(0);
	});

	it("never matches an inbound copy of our own mail (a self-send) by message id", () => {
		db.prepare(
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, message_id)
			 VALUES ('in-1', 'inbox', 'x', 'support@tapetide.com', 'support@tapetide.com', '2026-10-26T04:32:50Z', '', 'self@tapetide.com')`,
		).run();
		expect(reconcileProviderEvents(ctx, [liveVerdict("self@tapetide.com")])).toEqual({ applied: 0, matched: 0 });
		expect(getDeliveryEvents(ctx, "in-1")).toHaveLength(0);
	});

	it("heals a row whose verdict landed before 'delivered' was a cache value", () => {
		// Pre-#103 the reconciler wrote the verdict and set delivery_status NULL.
		// Every later tick dedupes the verdict, which used to skip the recompute
		// forever. A deduped re-read must still bring the cache forward.
		seedSentWithProviderId("old-1", "SM8nQq@tapetide.com", null);
		appendDeliveryEvent(ctx, { ...liveVerdict("SM8nQq@tapetide.com"), emailId: "old-1" });
		const result = reconcileProviderEvents(ctx, [liveVerdict("SM8nQq@tapetide.com")]);
		expect(result).toEqual({ applied: 0, matched: 1 });
		expect(readStatus("old-1")).toBe("delivered");
	});
});

describe("getSentAnalytics", () => {
	const window = { start: "2026-08-01T00:00:00Z", end: "2026-08-31T23:59:59Z" };

	it("counts distinct messages per outcome, not events", () => {
		seedSent("a1");
		seedSent("a2");
		// a1 delivered then opened three times → 1 delivered, 1 opened.
		appendDeliveryEvent(ctx, {
			emailId: "a1",
			type: "delivered",
			source: "graphql",
			occurredAt: "2026-08-21T10:00:00Z",
		});
		for (let i = 0; i < 3; i += 1) {
			appendDeliveryEvent(ctx, {
				emailId: "a1",
				type: "opened",
				source: "pixel",
				occurredAt: `2026-08-21T11:0${i}:00Z`,
			});
		}
		// a2 bounced, recipient's fault.
		appendDeliveryEvent(ctx, {
			emailId: "a2",
			type: "bounced",
			source: "graphql",
			errorCause: "recipient",
			occurredAt: "2026-08-21T10:00:00Z",
		});

		const stats = getSentAnalytics(ctx, window);
		expect(stats.sent).toBe(2);
		expect(stats.delivered).toBe(1);
		expect(stats.opened).toBe(1); // three opens collapse to one message
		expect(stats.failed).toBe(1);
		expect(stats.failedRecipient).toBe(1);
		expect(stats.failedInternal).toBe(0);
	});

	it("counts a retried message as delivered, not failed", () => {
		seedSent("a3");
		appendDeliveryEvent(ctx, {
			emailId: "a3",
			type: "failed",
			source: "send",
			errorCause: "internal",
			occurredAt: "2026-08-21T10:00:00Z",
		});
		appendDeliveryEvent(ctx, {
			emailId: "a3",
			type: "delivered",
			source: "graphql",
			occurredAt: "2026-08-21T10:05:00Z",
		});

		const stats = getSentAnalytics(ctx, window);
		expect(stats.delivered).toBe(1);
		expect(stats.failed).toBe(0); // the delivery supersedes the earlier failure
		expect(stats.failedInternal).toBe(0);
	});

	it("counts a cohort message's outcomes even when they land outside the window", () => {
		// The window selects MESSAGES; their outcomes then count whenever they
		// happened. A delivery reconciled minutes after the window closed, or an
		// open days later, still belongs to the send being measured.
		seedSent("a4");
		appendDeliveryEvent(ctx, {
			emailId: "a4",
			type: "delivered",
			source: "graphql",
			occurredAt: "2026-09-15T10:00:00Z", // AFTER the window ends
		});
		const stats = getSentAnalytics(ctx, window);
		expect(stats.sent).toBe(1);
		expect(stats.delivered).toBe(1);
	});

	it("excludes a message sent outside the window entirely", () => {
		// The cohort bound is the message's own date, so an older message and all of
		// its events stay out — this is what keeps rates from exceeding 100%.
		db.prepare(
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body)
			 VALUES ('old', 'sent', 'Hello', 'support@tapetide.com', 'user@example.org',
			         '2026-06-01T09:00:00.000Z', '<p>Hi</p>')`,
		).run();
		appendDeliveryEvent(ctx, {
			emailId: "old",
			type: "opened",
			source: "pixel",
			occurredAt: "2026-08-21T10:00:00Z", // opened DURING the window
		});
		const stats = getSentAnalytics(ctx, window);
		expect(stats.sent).toBe(0);
		expect(stats.opened).toBe(0); // and its open does not leak in
	});

	it("still counts a sent message after it is archived out of Sent", () => {
		// Outbound membership comes from the immutable `sent` ledger event, not the
		// current folder — archiving must not turn 1 sent/1 delivered into 0/1.
		db.prepare(
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body)
			 VALUES ('arch', 'archive', 'Hello', 'support@tapetide.com', 'user@example.org',
			         '2026-08-21T09:00:00.000Z', '<p>Hi</p>')`,
		).run();
		appendDeliveryEvent(ctx, {
			emailId: "arch",
			type: "sent",
			source: "send",
			occurredAt: "2026-08-21T09:00:01Z",
		});
		appendDeliveryEvent(ctx, {
			emailId: "arch",
			type: "delivered",
			source: "graphql",
			occurredAt: "2026-08-21T09:05:00Z",
		});

		const stats = getSentAnalytics(ctx, window);
		expect(stats.sent).toBe(1);
		expect(stats.delivered).toBe(1);
	});

	it("reports a delivery later followed by a complaint as failed", () => {
		// Matches latestTerminalStatus, so the panel and the reading pane agree —
		// erasing the failure whenever any delivery existed did not.
		seedSent("a5");
		appendDeliveryEvent(ctx, {
			emailId: "a5",
			type: "delivered",
			source: "graphql",
			occurredAt: "2026-08-21T10:00:00Z",
		});
		appendDeliveryEvent(ctx, {
			emailId: "a5",
			type: "complained",
			source: "graphql",
			errorCause: "recipient",
			occurredAt: "2026-08-23T10:00:00Z",
		});

		const stats = getSentAnalytics(ctx, window);
		expect(stats.delivered).toBe(0);
		expect(stats.failed).toBe(1);
		expect(stats.failedRecipient).toBe(1);
	});

	it("attributes a failure to the winning event only, never both buckets", () => {
		// A retry whose attribution changed must not count once as ours and once as
		// theirs; only the latest terminal event's cause is used.
		seedSent("a6");
		appendDeliveryEvent(ctx, {
			emailId: "a6",
			type: "failed",
			source: "send",
			errorCause: "internal",
			occurredAt: "2026-08-21T10:00:00Z",
		});
		appendDeliveryEvent(ctx, {
			emailId: "a6",
			type: "bounced",
			source: "graphql",
			errorCause: "recipient",
			occurredAt: "2026-08-21T10:30:00Z",
		});

		const stats = getSentAnalytics(ctx, window);
		expect(stats.failed).toBe(1);
		expect(stats.failedRecipient).toBe(1);
		expect(stats.failedInternal).toBe(0);
	});
});
