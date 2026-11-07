// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Open/click tracking on every outgoing path, the engagement cache, and the
 * list projection.
 *
 * The scheduled-delivery and engagement tests run the REAL migration list on
 * `node:sqlite`, so they also prove migration 28 adds every column the code
 * reads. The tokens are verified with the real verifier against the mailbox's
 * own secret, so "the token names the stored row" is checked end to end.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetNoOriginWarning } from "../workers/lib/deployment-origin";
import { applyMigrations, mailboxMigrations } from "../workers/durableObject/migrations";
import {
	getOrCreateTrackingSecret,
	processDueScheduledSends,
	recordEngagement,
	recordScheduledSend,
	updateTrackingSettings,
} from "../workers/durableObject/features";
import {
	backfillEngagementCache,
	engagementColumnsSql,
	hasPendingEngagement,
} from "../workers/durableObject/engagement";
import {
	countOwnPixels,
	injectTracking,
	stripTrackingPixelsForDisplay,
} from "../shared/tracking-inject";
import { verifyTrackingToken } from "../shared/tracking-token";
import {
	trackOutgoingHtml,
	trackingBaseUrl,
	trackingRecipientFor,
	type TrackingStub,
} from "../workers/lib/tracking-send";
import { prepareEmailHtml } from "../app/lib/email-html";
import type { Env } from "../workers/types";
import { prepareOutgoingHtml } from "../shared/outgoing-html";

// ── harness ─────────────────────────────────────────────────────────

function sqlStorage(db: DatabaseSync): DurableObjectState {
	const exec = (query: string, ...bindings: unknown[]) => {
		const trimmed = query.trim();
		if (bindings.length === 0 && !/^(select|with)/i.test(trimmed)) {
			db.exec(trimmed);
			return { toArray: () => [], rowsWritten: 0, one: () => undefined, [Symbol.iterator]: () => [][Symbol.iterator]() };
		}
		const rows = db.prepare(trimmed).all(...(bindings as never[])) as Record<string, unknown>[];
		const changes = Number(
			(db.prepare("SELECT changes() AS n").get() as { n: number | bigint })?.n ?? 0,
		);
		return {
			toArray: () => rows,
			rowsWritten: /^(select|with)/i.test(trimmed) ? 0 : changes,
			one: () => rows[0],
			[Symbol.iterator]: () => rows[Symbol.iterator](),
		};
	};
	return {
		id: { name: "support@tapetide.com" },
		storage: {
			sql: { exec },
			transactionSync: <T>(fn: () => T) => fn(),
			getAlarm: async () => null,
			setAlarm: async () => {},
		},
	} as unknown as DurableObjectState;
}

let db: DatabaseSync;
let ctx: DurableObjectState;

beforeEach(() => {
	db = new DatabaseSync(":memory:");
	ctx = sqlStorage(db);
	applyMigrations(ctx.storage.sql as unknown as SqlStorage, mailboxMigrations, ctx.storage as never);
});

function fakeEnv(appUrl?: string) {
	const sent: Record<string, unknown>[] = [];
	const env = {
		APP_URL: appUrl,
		EMAIL: {
			send: async (message: Record<string, unknown>) => {
				sent.push(message);
				return { messageId: `provider-${sent.length}` };
			},
		},
		BUCKET: { get: async () => null },
	} as unknown as Env;
	return { env, sent };
}

function queue(
	id: string,
	body: string,
	options: { recipient?: string; cc?: string | null; baseUrl?: string | null } = {},
) {
	db.prepare(
		`INSERT INTO emails (id, folder_id, subject, sender, recipient, cc, date, body, read)
		 VALUES (?, 'scheduled', 'Hi', 'support@tapetide.com', ?, ?, '2026-10-26T09:00:00.000Z', ?, 1)`,
	).run(id, options.recipient ?? "user@example.org", options.cc ?? null, body);
	recordScheduledSend(ctx, id, "2026-10-26T09:00:00.000Z", {
		trackingBaseUrl: options.baseUrl === undefined ? "https://mailer.tapetide.com" : options.baseUrl,
		mailboxId: "support@tapetide.com",
	});
}

const deliver = (env: Env) =>
	processDueScheduledSends(ctx, env, { now: new Date("2026-10-26T09:05:00.000Z") });

const storedBody = (id: string) =>
	(db.prepare(`SELECT body FROM emails WHERE id = ?`).get(id) as { body: string }).body;

function tokens(html: string, kind: "o" | "c"): string[] {
	return [...html.matchAll(new RegExp(`/t/${kind}/([A-Za-z0-9_.-]+)`, "g"))].map((m) => m[1]);
}

// ── scheduled / undo-window delivery (every UI send) ────────────────

describe("scheduled delivery (UI sends, undo window, schedule_send)", () => {
	it("instruments the outgoing copy with tokens naming the stored row", async () => {
		const { env, sent } = fakeEnv();
		queue("local-1", '<p>See <a href="https://tapetide.com/x">this</a></p>');
		await deliver(env);

		expect(sent).toHaveLength(1);
		const html = sent[0].html as string;
		const secret = getOrCreateTrackingSecret(ctx);
		const [open] = tokens(html, "o");
		const [click] = tokens(html, "c");
		const openPayload = await verifyTrackingToken(open, secret);
		const clickPayload = await verifyTrackingToken(click, secret);
		expect(openPayload).toMatchObject({ emailId: "local-1", mailboxId: "support@tapetide.com", kind: "opened" });
		expect(openPayload?.recipient).toBe("user@example.org");
		expect(clickPayload).toMatchObject({ emailId: "local-1", url: "https://tapetide.com/x" });
		expect(html).toContain("https://mailer.tapetide.com/t/o/");
	});

	it("keeps the stored Sent copy clean of the pixel and rewritten links", async () => {
		const { env } = fakeEnv();
		const original = '<p>See <a href="https://tapetide.com/x">this</a></p>';
		queue("local-2", original);
		await deliver(env);
		expect(storedBody("local-2")).toBe(original);
		const row = db.prepare(`SELECT folder_id FROM emails WHERE id = 'local-2'`).get() as { folder_id: string };
		expect(row.folder_id).toBe("sent");
	});

	it("never double-instruments a body that was already instrumented", async () => {
		const { env, sent } = fakeEnv();
		// A body that already passed through injection (e.g. a draft that was
		// instrumented once and then scheduled) must still leave with one pixel.
		const already = await injectTracking('<body><a href="https://tapetide.com/y">y</a></body>', {
			baseUrl: "https://mailer.tapetide.com",
			openTracking: true,
			clickTracking: true,
			signOpen: async () => "OLD.TOKEN",
			signClick: async () => "OLDCLICK.TOKEN",
		});
		queue("local-3", already);
		await deliver(env);
		const html = sent[0].html as string;
		expect(countOwnPixels(html)).toBe(1);
		expect(html).not.toContain("OLD.TOKEN");
		// The already-wrapped link is not wrapped a second time.
		expect(tokens(html, "c")).toEqual(["OLDCLICK.TOKEN"]);
	});

	it("attributes a multi-recipient message to the message, not a recipient", async () => {
		const { env, sent } = fakeEnv();
		queue("local-4", "<p>Hello all</p>", { recipient: "a@example.org, b@example.org", cc: "c@example.org" });
		await deliver(env);
		const [open] = tokens(sent[0].html as string, "o");
		const payload = await verifyTrackingToken(open, getOrCreateTrackingSecret(ctx));
		expect(payload?.recipient).toBeNull();
	});

	it("skips plain-text mail", async () => {
		const { env, sent } = fakeEnv();
		queue("local-5", "Just text, no markup.\nhttps://tapetide.com");
		await deliver(env);
		expect(sent[0].html).toBe("Just text, no markup.\nhttps://tapetide.com");
	});

	it("respects the mailbox's toggles", async () => {
		const { env, sent } = fakeEnv();
		updateTrackingSettings(ctx, { openTracking: false, clickTracking: false });
		queue("local-6", '<p><a href="https://tapetide.com/z">z</a></p>');
		await deliver(env);
		expect(sent[0].html).toBe(prepareOutgoingHtml('<p><a href="https://tapetide.com/z">z</a></p>'));
	});

	it("falls back to APP_URL when no origin was captured", async () => {
		const { env, sent } = fakeEnv("https://mail.example.dev/");
		queue("local-7", "<p>Hi</p>", { baseUrl: null });
		await deliver(env);
		expect(sent[0].html).toContain("https://mail.example.dev/t/o/");
	});

	it("sends untracked, with one warning, when no deployment origin is known", async () => {
		resetNoOriginWarning();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { env, sent } = fakeEnv();
			const body = '<p>See <a href="https://example.org/x">this</a></p>';
			queue("local-8", body, { baseUrl: null });
			queue("local-9", body, { baseUrl: null });
			await deliver(env);
			expect(sent).toHaveLength(2);
			for (const m of sent) {
				expect(m.html).toBe(prepareOutgoingHtml(body));
				expect(String(m.html)).not.toContain("/t/");
			}
			expect(warn.mock.calls.filter((c) => String(c[0]).includes("No deployment origin"))).toHaveLength(1);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("trackingBaseUrl / attribution helpers", () => {
	it("prefers the stored origin, then APP_URL, then nothing (never another host)", async () => {
		const env = (vars: Record<string, string>) => vars as unknown as Env;
		expect(await trackingBaseUrl(env({ APP_URL: "https://a.dev" }), "https://b.dev/x")).toBe("https://b.dev");
		expect(await trackingBaseUrl(env({ APP_URL: "https://a.dev/path" }))).toBe("https://a.dev");
		expect(await trackingBaseUrl(env({ APP_URL: "not a url" }))).toBeNull();
		expect(await trackingBaseUrl(env({}))).toBeNull();
	});

	it("names a recipient only when there is exactly one", () => {
		expect(trackingRecipientFor("A@x.org")).toBe("a@x.org");
		expect(trackingRecipientFor("a@x.org", ["b@x.org"])).toBeNull();
		expect(trackingRecipientFor("a@x.org", null, "bcc@x.org")).toBeNull();
		expect(trackingRecipientFor("a@x.org, b@x.org")).toBeNull();
	});
});

// ── request-path and agent sends (shared helper) ─────────────────────

describe("trackOutgoingHtml (API, reply/forward, sequences, templates, agent tools)", () => {
	const SECRET = "e".repeat(64);
	const stub = (open = true, click = true): TrackingStub => ({
		getTrackingSettings: async () => ({ openTracking: open, clickTracking: click, attachmentTracking: true }),
		getOrCreateTrackingSecret: async () => SECRET,
	});

	it("drops tracking rather than push a message over the size limit", async () => {
		const html = `<p>${"x".repeat(100)}</p><a href="https://t.co/a">a</a>`;
		const out = await trackOutgoingHtml({
			stub: stub(),
			mailboxId: "m@x.org",
			emailId: "e1",
			html,
			baseUrl: "https://mailer.tapetide.com",
			to: "u@x.org",
			// Just under the limit before instrumenting.
			attachments: [{ content: "A".repeat(5 * 1024 * 1024 - 32 * 1024) }],
		});
		expect(out).toBe(html);
	});

	it("leaves text-only and empty bodies alone", async () => {
		for (const html of [undefined, "", "plain text only"]) {
			const out = await trackOutgoingHtml({
				stub: stub(),
				mailboxId: "m@x.org",
				emailId: "e1",
				html,
				baseUrl: "https://mailer.tapetide.com",
				to: "u@x.org",
			});
			expect(out).toBe(html);
		}
	});

	/**
	 * Every outgoing route must go through the helper. A static guard, because
	 * the routes need a real Worker to run: a new send path that calls
	 * `sendEmail` without instrumenting is exactly the regression this catches.
	 */
	it.each([
		["workers/index.ts", "trackOutgoingHtml("],
		["workers/routes/reply-forward.ts", "trackOutgoingHtml("],
		["workers/lib/sequence-dispatch.ts", "trackOutgoingHtml("],
		["workers/routes/suppressions.ts", "trackOutgoingHtml("],
		["workers/durableObject/features.ts", "trackOutgoingHtml("],
	])("%s instruments its send", (file, needle) => {
		expect(readFileSync(file, "utf8")).toContain(needle);
	});

	it("the agent/MCP send tools instrument send_email, send_reply and forward_email", () => {
		const src = readFileSync("workers/lib/tools.ts", "utf8");
		for (const fn of ["toolSendReply", "toolSendEmail", "toolForwardEmail"]) {
			const start = src.indexOf(`export async function ${fn}(`);
			const end = src.indexOf("\nexport ", start + 1);
			expect(src.slice(start, end), fn).toContain("trackAgentSend(");
		}
		// send_template delegates to toolSendEmail; schedule_send to the alarm.
		expect(src).toMatch(/toolSendTemplate[\s\S]*return toolSendEmail\(/);
	});

	it("auto-replies and automatic forwards are deliberately NOT tracked", () => {
		const index = readFileSync("workers/index.ts", "utf8");
		const autoReply = index.slice(index.indexOf("Vacation auto-reply."), index.indexOf("if (!autoDraftEnabled)"));
		expect(autoReply).toContain("sendEmail(");
		expect(autoReply).not.toContain("trackOutgoingHtml");
		expect(readFileSync("workers/lib/forwarding.ts", "utf8")).not.toContain("trackOutgoingHtml");
	});
});

// ── reading-pane guard (sender never fires their own pixel) ──────────

describe("own pixels are never shown in the app", () => {
	it("strips our pixel from a quoted reply even with remote images allowed", () => {
		const quoted =
			'<p>Thanks!</p><blockquote><img data-tt-open="1" src="https://mailer.tapetide.com/t/o/abc.def" width="1" height="1"></blockquote>';
		// The marker alone is enough, whatever the token looks like.
		const prepared = prepareEmailHtml(quoted, {
			mailboxId: "m",
			emailId: "e",
			allowRemoteImages: true,
		});
		expect(prepared.html).not.toContain("/t/o/");
		expect(prepared.html).toContain("Thanks!");
	});

	it("recognises a pixel whose marker attribute a client dropped", () => {
		const html = `<img src="https://preview.example.dev/t/o/${"a".repeat(60)}.${"b".repeat(43)}" alt="">`;
		expect(stripTrackingPixelsForDisplay(html)).toBe("");
		// An unrelated image under some /t/o/ path without a token shape stays.
		const other = '<img src="https://cdn.example.com/t/o/logo.png">';
		expect(stripTrackingPixelsForDisplay(other)).toBe(other);
	});
});

// ── engagement cache + backfill + list projection ────────────────────

function seedSent(id: string, date = "2026-10-26T09:00:00.000Z") {
	db.prepare(
		`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, delivery_status)
		 VALUES (?, 'sent', 'Hi', 'support@tapetide.com', 'u@example.org', ?, '<p>Hi</p>', 'delivered')`,
	).run(id, date);
}

const cache = (id: string) =>
	db
		.prepare(
			`SELECT opened_at, last_opened_at, open_count, open_proxy_count, clicked_at, click_count, engagement_v
			   FROM emails WHERE id = ?`,
		)
		.get(id) as Record<string, unknown>;

const version = () =>
	(db.prepare(`SELECT version FROM mailbox_state WHERE id = 1`).get() as { version: number }).version;

describe("engagement cache", () => {
	it("is updated when an open or click is recorded, and bumps the change counter", () => {
		seedSent("s1");
		const before = version();
		recordEngagement(ctx, { emailId: "s1", type: "opened", source: "pixel", occurredAt: "2026-10-26T10:00:00.000Z" });
		recordEngagement(ctx, {
			emailId: "s1",
			type: "opened",
			source: "pixel",
			occurredAt: "2026-10-26T11:00:00.000Z",
			metadata: { proxy: "apple", ua: "Mozilla/5.0" },
		});
		recordEngagement(ctx, {
			emailId: "s1",
			type: "clicked",
			source: "redirect",
			occurredAt: "2026-10-26T11:05:00.000Z",
			metadata: { url: "https://x" },
		});
		expect(cache("s1")).toEqual({
			opened_at: "2026-10-26T10:00:00.000Z",
			last_opened_at: "2026-10-26T11:00:00.000Z",
			open_count: 2,
			open_proxy_count: 1,
			clicked_at: "2026-10-26T11:05:00.000Z",
			click_count: 1,
			engagement_v: 1,
		});
		// Live updates: the list refetches when this counter moves.
		expect(version()).toBeGreaterThan(before);
	});

	it("backfills rows that had engagement before the migration, bounded and newest first", () => {
		seedSent("old-a", "2026-10-01T00:00:00.000Z");
		seedSent("old-b", "2026-10-02T00:00:00.000Z");
		seedSent("never-opened", "2026-10-03T00:00:00.000Z");
		// Ledger history written directly, as it would exist pre-migration.
		const ev = db.prepare(
			`INSERT INTO delivery_events (email_id, event_type, source, occurred_at) VALUES (?, ?, 'pixel', ?)`,
		);
		ev.run("old-a", "opened", "2026-10-01T01:00:00.000Z");
		ev.run("old-b", "opened", "2026-10-02T01:00:00.000Z");
		ev.run("old-b", "clicked", "2026-10-02T02:00:00.000Z");

		// Newest first, one bounded batch at a time.
		expect(backfillEngagementCache(ctx, 2)).toBe(2);
		expect(cache("never-opened")).toMatchObject({ open_count: 0, opened_at: null, engagement_v: 1 });
		expect(cache("old-b")).toMatchObject({ open_count: 1, click_count: 1, engagement_v: 1 });
		expect(cache("old-a").engagement_v).toBe(0); // not reached yet: bounded
		expect(hasPendingEngagement(ctx)).toBe(true);
		expect(backfillEngagementCache(ctx, 10)).toBe(1);
		expect(cache("old-a").open_count).toBe(1);
		expect(backfillEngagementCache(ctx, 10)).toBe(0); // done
		expect(hasPendingEngagement(ctx)).toBe(false);
	});

	it("uses the partial index, and survives malformed metadata", () => {
		const plan = db
			.prepare(`EXPLAIN QUERY PLAN SELECT id FROM emails WHERE engagement_v < 1 ORDER BY date DESC LIMIT 5`)
			.all() as { detail: string }[];
		expect(plan.map((p) => p.detail).join(" ")).toContain("idx_emails_engagement_pending");

		seedSent("bad-json");
		db.prepare(
			`INSERT INTO delivery_events (email_id, event_type, source, metadata, occurred_at)
			 VALUES ('bad-json', 'opened', 'pixel', '{not json', '2026-10-26T10:00:00.000Z')`,
		).run();
		recordEngagement(ctx, { emailId: "bad-json", type: "opened", source: "pixel" });
		expect(cache("bad-json")).toMatchObject({ open_count: 2, open_proxy_count: 0 });
	});

	it("is part of the list projections", () => {
		seedSent("p1");
		recordEngagement(ctx, { emailId: "p1", type: "opened", source: "pixel" });
		const row = db
			.prepare(`SELECT id, ${engagementColumnsSql("e")} FROM emails e WHERE e.id = 'p1'`)
			.get() as Record<string, unknown>;
		expect(row.open_count).toBe(1);
		expect(row.opened_at).toBeTruthy();
		for (const file of [
			"workers/durableObject/threading.ts",
			"workers/durableObject/search.ts",
		]) {
			expect(readFileSync(file, "utf8")).toContain("engagementColumnsSql(");
		}
		const index = readFileSync("workers/durableObject/index.ts", "utf8");
		const getEmails = index.slice(index.indexOf("async getEmails("), index.indexOf("#listFilterConditions(filters"));
		for (const col of ["opened_at", "last_opened_at", "open_count", "clicked_at"]) {
			expect(getEmails).toContain(`${col}: schema.emails.${col}`);
		}
	});
});
