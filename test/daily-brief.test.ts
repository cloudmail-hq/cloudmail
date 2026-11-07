// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The daily brief: DST-aware scheduling, the builder, the per-mailbox SQL
 * (real SQLite), narrowing, the email rendering, and settings validation.
 */

import { describe, expect, it } from "vitest";
import { routerOver } from "./helpers/ai-router";
import {
	briefWindow,
	buildDailyBrief,
	importanceOf,
	narrowBrief,
	nextBriefAt,
	previousBriefAt,
	renderBriefEmail,
	wallTimeIn,
	zonedTimeToUtc,
	type MailboxBriefData,
} from "../shared/daily-brief";
import {
	AssistantPrefsPatchSchema,
	DEFAULT_ASSISTANT_PREFS,
	isValidTimeZone,
	mergeAssistantPrefs,
	normalizeAiConfig,
	normalizeAssistantPrefs,
} from "../shared/ai-settings";
import { collectBriefData } from "../workers/durableObject/brief-data";
import { enqueueSummary, processSummaryQueue } from "../workers/durableObject/summaries";
import { requiredTokenScope } from "../workers/lib/token-scope-guard";
import { mailboxSqlite } from "./helpers/mailbox-sqlite";

const iso = (ms: number) => new Date(ms).toISOString();
const H = 3_600_000;

describe("zonedTimeToUtc / nextBriefAt", () => {
	it("07:00 in UTC, New York and Kolkata", () => {
		const now = Date.parse("2026-06-10T03:00:00Z");
		expect(iso(nextBriefAt(now, "07:00", "UTC"))).toBe("2026-06-10T07:00:00.000Z");
		expect(iso(nextBriefAt(now, "07:00", "America/New_York"))).toBe("2026-06-10T11:00:00.000Z"); // EDT
		// Already past 07:00 IST (01:30Z), so tomorrow.
		expect(iso(nextBriefAt(now, "07:00", "Asia/Kolkata"))).toBe("2026-06-11T01:30:00.000Z");
	});

	it("crosses the US spring-forward: 07:00 stays 07:00 local", () => {
		// 2026-03-08 is the US DST start. 07:00 EST on the 7th is 12:00Z; 07:00 EDT on the 8th is 11:00Z.
		const sat = nextBriefAt(Date.parse("2026-03-07T06:00:00Z"), "07:00", "America/New_York");
		expect(iso(sat)).toBe("2026-03-07T12:00:00.000Z");
		const sun = nextBriefAt(sat + 1000, "07:00", "America/New_York");
		expect(iso(sun)).toBe("2026-03-08T11:00:00.000Z");
		expect(sun - sat).toBe(23 * H);
	});

	it("crosses the EU fall-back: a 25-hour day", () => {
		// 2026-10-25 is the EU DST end. 07:00 CEST on the 24th is 05:00Z; 07:00 CET on the 25th is 06:00Z.
		const sat = nextBriefAt(Date.parse("2026-10-24T00:00:00Z"), "07:00", "Europe/Berlin");
		expect(iso(sat)).toBe("2026-10-24T05:00:00.000Z");
		const sun = nextBriefAt(sat + 1000, "07:00", "Europe/Berlin");
		expect(iso(sun)).toBe("2026-10-25T06:00:00.000Z");
		expect(sun - sat).toBe(25 * H);
	});

	it("a wall time inside the spring-forward gap runs just after it", () => {
		// 02:30 does not exist in New York on 2026-03-08; it runs at 03:30 EDT.
		const at = zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, "America/New_York");
		expect(iso(at)).toBe("2026-03-08T07:30:00.000Z");
		expect(wallTimeIn(at, "America/New_York")).toMatchObject({ hour: 3, minute: 30 });
	});

	it("a repeated wall time in the fall-back overlap runs at the first occurrence", () => {
		// 01:30 happens twice in New York on 2026-11-01: 05:30Z (EDT) then 06:30Z (EST).
		const at = zonedTimeToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, "America/New_York");
		expect(iso(at)).toBe("2026-11-01T05:30:00.000Z");
	});

	it("handles half-hour zones and the date line", () => {
		expect(iso(nextBriefAt(Date.parse("2026-01-01T00:00:00Z"), "07:00", "Asia/Kathmandu"))).toBe("2026-01-01T01:15:00.000Z");
		expect(iso(nextBriefAt(Date.parse("2026-01-01T00:00:00Z"), "07:00", "Pacific/Kiritimati"))).toBe("2026-01-01T17:00:00.000Z");
	});

	it("never returns a time at or before now", () => {
		const now = Date.parse("2026-06-10T07:00:00Z");
		expect(nextBriefAt(now, "07:00", "UTC")).toBe(now + 24 * H);
		expect(previousBriefAt(now, "07:00", "UTC")).toBe(now);
	});
});

describe("briefWindow", () => {
	it("is 24h on an ordinary day and 23h/25h across DST", () => {
		const ordinary = briefWindow(Date.parse("2026-06-10T09:00:00Z"), "07:00", "Europe/Berlin");
		expect(ordinary.until - ordinary.since).toBe(24 * H);
		const spring = briefWindow(Date.parse("2026-03-29T09:00:00Z"), "07:00", "Europe/Berlin");
		expect(spring.until - spring.since).toBe(23 * H);
		const fall = briefWindow(Date.parse("2026-10-25T09:00:00Z"), "07:00", "Europe/Berlin");
		expect(fall.until - fall.since).toBe(25 * H);
		expect(iso(fall.until)).toBe("2026-10-25T06:00:00.000Z");
	});
});

// ── Builder ────────────────────────────────────────────────────────

const msg = (over: Partial<MailboxBriefData["newMessages"][number]>) => ({
	id: Math.random().toString(36).slice(2),
	thread_id: null,
	subject: "Hi",
	sender: "alice@example.com",
	sender_name: "Alice",
	date: "2026-10-26T05:00:00Z",
	read: false,
	starred: false,
	priority: null,
	bulk: false,
	summary_line: null,
	...over,
});

describe("buildDailyBrief", () => {
	it("groups by importance, counts top senders and totals", () => {
		const data: MailboxBriefData[] = [
			{
				mailbox: "support@example.com",
				newMessages: [
					msg({ priority: "high", subject: "Outage" }),
					msg({ starred: true }),
					msg({ sender: "bob@example.com", sender_name: null }),
					msg({ sender: "news@example.com", bulk: true }),
					msg({ sender: "news@example.com", bulk: true }),
					msg({ sender: "news@example.com", bulk: true }),
				],
				newTruncated: false,
				needsReply: [{ id: "n1", thread_id: "t", subject: "Q", who: "carol@example.com", who_name: null, date: "2026-10-25T00:00:00Z", summary_line: "Carol asks" }],
				waitingOn: [],
				waitingSource: "derived",
			},
		];
		const brief = buildDailyBrief({ data, now: Date.parse("2026-10-26T07:00:00Z"), time: "07:00", timeZone: "UTC" });
		const m = brief.mailboxes[0]!;
		expect(m.newByImportance.important).toHaveLength(2);
		expect(m.newByImportance.people).toHaveLength(1);
		expect(m.newByImportance.updates).toHaveLength(3);
		expect(m.topSenders[0]).toMatchObject({ address: "news@example.com", count: 3 });
		expect(m.topSenders[1]).toMatchObject({ address: "alice@example.com", count: 2 });
		expect(brief.totals).toEqual({ new: 6, needsReply: 1, waitingOn: 0 });
		expect(brief.since).toBe("2026-10-25T07:00:00.000Z");
		expect(brief.until).toBe("2026-10-26T07:00:00.000Z");
		expect(brief.dateLabel).toBe("Monday 26 October");
	});

	it("lists each conversation once, at its highest importance", () => {
		const brief = buildDailyBrief({
			data: [
				{
					mailbox: "s@x.com",
					newMessages: [
						msg({ thread_id: "t1", date: "2026-10-26T05:00:00Z", subject: "latest" }),
						msg({ thread_id: "t1", date: "2026-10-26T04:00:00Z", priority: "high" }),
						msg({ thread_id: "t1", date: "2026-10-26T03:00:00Z" }),
						msg({ thread_id: "t2" }),
					],
					newTruncated: false,
					needsReply: [],
					waitingOn: [],
					waitingSource: "derived",
				},
			],
			now: Date.parse("2026-10-26T07:00:00Z"),
			time: "07:00",
			timeZone: "UTC",
		});
		const m = brief.mailboxes[0]!;
		expect(m.newCount).toBe(2);
		expect(m.newMessageCount).toBe(4);
		expect(m.newCounts).toEqual({ important: 1, people: 1, updates: 0 });
		expect(m.newByImportance.important[0]!.subject).toBe("latest");
	});

	it("an on-demand brief runs through now", () => {
		const now = Date.parse("2026-10-26T14:00:00Z");
		const brief = buildDailyBrief({ data: [], now, time: "07:00", timeZone: "UTC", throughNow: true });
		expect(brief.since).toBe("2026-10-25T07:00:00.000Z");
		expect(brief.until).toBe("2026-10-26T14:00:00.000Z");
	});

	it("importanceOf", () => {
		expect(importanceOf({ priority: "high", starred: false, bulk: true })).toBe("important");
		expect(importanceOf({ priority: null, starred: false, bulk: true })).toBe("updates");
		expect(importanceOf({ priority: null, starred: false, bulk: false })).toBe("people");
	});

	it("narrowBrief drops mailboxes and recomputes totals", () => {
		const one = (mailbox: string): MailboxBriefData => ({
			mailbox,
			newMessages: [msg({})],
			newTruncated: false,
			needsReply: [],
			waitingOn: [],
			waitingSource: "derived",
		});
		const brief = buildDailyBrief({ data: [one("a@x.com"), one("b@x.com")], now: Date.now(), time: "07:00", timeZone: "UTC" });
		const narrowed = narrowBrief(brief, (m) => m === "a@x.com");
		expect(narrowed.mailboxes.map((m) => m.mailbox)).toEqual(["a@x.com"]);
		expect(narrowed.totals.new).toBe(1);
	});

	it("renders an email with every value escaped", () => {
		const brief = buildDailyBrief({
			data: [
				{
					mailbox: "s@x.com",
					newMessages: [msg({ subject: "<img src=x onerror=alert(1)>", sender_name: "<b>Eve</b>", summary_line: "a & b" })],
					newTruncated: false,
					needsReply: [],
					waitingOn: [],
					waitingSource: "derived",
				},
			],
			now: Date.now(),
			time: "07:00",
			timeZone: "UTC",
		});
		const { html, text, subject } = renderBriefEmail(brief, "https://mail.example.com");
		expect(html).not.toContain("<img");
		expect(html).not.toContain("<b>Eve");
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(html).toContain("a &amp; b");
		expect(text).toContain("<img src=x"); // plain text part is not HTML
		expect(subject).toMatch(/1 new, 0 to reply/);
	});
});

// ── Per-mailbox SQL ────────────────────────────────────────────────

describe("collectBriefData", () => {
	const MB = "support@example.com";

	it("reads the window from the inbox, flags bulk, attaches summaries, and derives waiting-on", async () => {
		const { ctx, insert } = mailboxSqlite();
		const now = Date.parse("2026-10-26T07:00:00Z");
		// In window
		insert({ thread_id: "a", date: "2026-10-26T06:00:00Z", subject: "In" });
		insert({ thread_id: "b", date: "2026-10-25T08:00:00Z", raw_headers: [{ key: "List-Id", value: "<l>" }] });
		// Out of window, and in Spam
		insert({ thread_id: "c", date: "2026-10-24T08:00:00Z" });
		insert({ thread_id: "d", date: "2026-10-26T06:30:00Z", folder: "spam" });
		// Waiting on others: our sent message is the latest, 3 days old.
		insert({ thread_id: "w", folder: "sent", sender: MB, recipient: "dan@example.com", date: "2026-10-23T07:00:00Z" });
		// Not waiting: they replied after us.
		insert({ thread_id: "r", folder: "sent", sender: MB, date: "2026-10-22T07:00:00Z" });
		insert({ thread_id: "r", folder: "inbox", date: "2026-10-22T09:00:00Z" });
		// Not waiting yet: under 24h old.
		insert({ thread_id: "fresh", folder: "sent", sender: MB, date: "2026-10-26T01:00:00Z" });
		// Bulk send of ours: not waiting.
		insert({ thread_id: "blast", folder: "sent", sender: MB, date: "2026-10-23T07:00:00Z", raw_headers: [{ key: "List-Unsubscribe", value: "<https://x>" }] });

		enqueueSummary(ctx, "a");
		await processSummaryQueue(ctx, {
			ai: routerOver({ run: async () => ({ response: "NO" }) }),
			mailboxAddress: MB,
			ignoreDebounce: true,
		});

		const data = collectBriefData(ctx, {
			mailbox: MB,
			since: "2026-10-25T07:00:00Z",
			until: "2026-10-26T07:00:00Z",
			now,
			needsReply: [],
		});
		expect(data.newMessages.map((m) => m.thread_id).sort()).toEqual(["a", "b"]);
		expect(data.newMessages.find((m) => m.thread_id === "b")!.bulk).toBe(true);
		expect(data.newMessages.find((m) => m.thread_id === "a")!.summary_line).toBe("NO");
		expect(data.waitingSource).toBe("derived");
		expect(data.waitingOn.map((w) => w.thread_id)).toEqual(["w"]);
		expect(data.waitingOn[0]!.who).toBe("dan@example.com");
	});

	it("puts follow-up reminders (migration 32) first and fills in derived threads", () => {
		const { ctx, insert, db } = mailboxSqlite();
		const now = Date.parse("2026-10-26T07:00:00Z");
		// A reminder the user set on a fresh send (too new to be derived).
		const id = insert({ thread_id: "f", folder: "sent", date: "2026-10-26T06:00:00Z", recipient: "erin@example.com" });
		const fire = (emailId: string, thread: string, status: string) =>
			db
				.prepare(
					`INSERT INTO followups (email_id, thread_id, followup_at, status, created_at, updated_at)
					 VALUES (?, ?, '2026-10-29T00:00:00Z', ?, '2026-10-26T06:00:00Z', '2026-10-26T06:00:00Z')`,
				)
				.run(emailId, thread, status);
		fire(id, "f", "pending");
		// A reminder already answered: not waiting.
		const done = insert({ thread_id: "g", folder: "sent", date: "2026-10-20T06:00:00Z", recipient: "gus@example.com" });
		fire(done, "g", "replied");
		// Derived: our message is the latest, 3 days old, no reminder.
		insert({ thread_id: "d", folder: "sent", date: "2026-10-23T06:00:00Z", recipient: "dora@example.com" });
		// A reminder thread that would also be derived is listed once.
		const both = insert({ thread_id: "b", folder: "sent", date: "2026-10-22T06:00:00Z", recipient: "bo@example.com" });
		fire(both, "b", "fired");

		const data = collectBriefData(ctx, {
			mailbox: "support@example.com",
			since: "2026-10-25T07:00:00Z",
			until: "2026-10-26T07:00:00Z",
			now,
			needsReply: [],
		});
		expect(data.waitingSource).toBe("mixed");
		expect(data.waitingOn.map((w) => w.who)).toEqual(["erin@example.com", "bo@example.com", "dora@example.com"]);
	});
});

// ── Settings ───────────────────────────────────────────────────────

describe("settings", () => {
	it("brief is off by default, 07:00", () => {
		expect(DEFAULT_ASSISTANT_PREFS).toEqual({
			listSummaries: true,
			brief: { enabled: false, time: "07:00", timeZone: "UTC", email: false },
		});
	});

	it("validates time and zone", () => {
		expect(isValidTimeZone("Europe/Berlin")).toBe(true);
		expect(isValidTimeZone("Mars/Olympus")).toBe(false);
		expect(AssistantPrefsPatchSchema.safeParse({ brief: { time: "7:00" } }).success).toBe(false);
		expect(AssistantPrefsPatchSchema.safeParse({ brief: { time: "24:00" } }).success).toBe(false);
		expect(AssistantPrefsPatchSchema.safeParse({ brief: { timeZone: "Nope/Zone" } }).success).toBe(false);
		expect(AssistantPrefsPatchSchema.safeParse({ brief: { enabled: true, time: "06:30", timeZone: "Asia/Tokyo" } }).success).toBe(true);
		expect(AssistantPrefsPatchSchema.safeParse({ extra: 1 }).success).toBe(false);
	});

	it("merges a patch group-wise and tolerates junk on read", () => {
		const next = mergeAssistantPrefs(DEFAULT_ASSISTANT_PREFS, { brief: { enabled: true } });
		expect(next.brief).toEqual({ enabled: true, time: "07:00", timeZone: "UTC", email: false });
		expect(normalizeAssistantPrefs({ brief: { time: "bad", timeZone: "Europe/Paris" } }).brief).toMatchObject({
			time: "07:00",
			timeZone: "Europe/Paris",
		});
		expect(normalizeAiConfig({ dailyCapPerMailbox: -5, summaries: false })).toEqual({
			summaries: false,
			bulkSummaries: true,
			dailyCapPerMailbox: 300,
			semantic: true,
			embedDailyCapPerMailbox: 500,
		});
	});

	it("token scopes for the new routes", () => {
		expect(requiredTokenScope("GET", "/api/v1/me/brief")).toBe("mail:read");
		expect(requiredTokenScope("PUT", "/api/v1/me/assistant")).toBe("mail:read");
		expect(requiredTokenScope("GET", "/api/v1/ai/settings")).toBe("any");
		expect(requiredTokenScope("PUT", "/api/v1/ai/settings")).toBe("admin");
		expect(requiredTokenScope("GET", "/api/v1/mailboxes/a@b.com/threads/t/summary")).toBe("mail:read");
	});
});
