// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tracking controls: recipient opt-outs, the per-message "Don't track this
 * message" switch (composer and scheduled delivery), and the disclosure line.
 *
 * The scheduled-delivery cases run the real migration list on `node:sqlite`,
 * so they also prove migration 38 adds the `track` column delivery reads.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, mailboxMigrations } from "../workers/durableObject/migrations";
import {
	getTrackingSettings,
	processDueScheduledSends,
	recordScheduledSend,
	updateTrackingSettings,
} from "../workers/durableObject/features";
import {
	appendDisclosure,
	trackOutgoingHtml,
	type TrackingOptOutLookup,
	type TrackingStub,
} from "../workers/lib/tracking-send";
import { trackFieldFor } from "../shared/compose-tracking";
import { DEFAULT_TRACKING_DISCLOSURE } from "../shared/privacy";
import type { Env } from "../workers/types";

const SECRET = "e".repeat(64);
const BASE = "https://mailer.tapetide.com";
const HTML = '<body><p>Hi</p><a href="https://tapetide.com/x">x</a></body>';

function stub(settings: Partial<Awaited<ReturnType<TrackingStub["getTrackingSettings"]>>> = {}): TrackingStub {
	return {
		async getTrackingSettings() {
			return { openTracking: true, clickTracking: true, attachmentTracking: true, ...settings };
		},
		async getOrCreateTrackingSecret() {
			return SECRET;
		},
	};
}

function optOuts(entries: { address: string; scope: string }[], calls: unknown[][] = []): TrackingOptOutLookup {
	return {
		async findTrackingOptOuts(addresses, domain) {
			calls.push([addresses, domain]);
			return entries.filter(
				(e) => addresses.includes(e.address) && (e.scope === "global" || e.scope === domain),
			);
		},
	};
}

const isTracked = (html: string | undefined) => !!html && /\/t\/[oc]\//.test(html);

describe("recipient opt-out", () => {
	it("sends untracked when the recipient opted out for the sending domain", async () => {
		const calls: unknown[][] = [];
		const out = await trackOutgoingHtml({
			stub: stub(),
			mailboxId: "support@tapetide.com",
			emailId: "m1",
			html: HTML,
			baseUrl: BASE,
			to: "Reader <Reader@Example.org>",
			optOuts: optOuts([{ address: "reader@example.org", scope: "tapetide.com" }], calls),
			fromAddress: "support@tapetide.com",
		});
		expect(out).toBe(HTML);
		// Normalised address and the From domain reach the lookup.
		expect(calls).toEqual([[["reader@example.org"], "tapetide.com"]]);
	});

	it("honours a global opt-out", async () => {
		const out = await trackOutgoingHtml({
			stub: stub(),
			mailboxId: "support@tapetide.com",
			emailId: "m1",
			html: HTML,
			baseUrl: BASE,
			to: "reader@example.org",
			optOuts: optOuts([{ address: "reader@example.org", scope: "global" }]),
		});
		expect(out).toBe(HTML);
	});

	it("still tracks when the opt-out is for a different sending domain", async () => {
		const out = await trackOutgoingHtml({
			stub: stub(),
			mailboxId: "support@tapetide.com",
			emailId: "m1",
			html: HTML,
			baseUrl: BASE,
			to: "reader@example.org",
			optOuts: optOuts([{ address: "reader@example.org", scope: "other-product.com" }]),
		});
		expect(isTracked(out)).toBe(true);
	});

	it("leaves the whole message untracked when any one of several recipients opted out", async () => {
		const out = await trackOutgoingHtml({
			stub: stub(),
			mailboxId: "support@tapetide.com",
			emailId: "m1",
			html: HTML,
			baseUrl: BASE,
			to: ["a@example.org"],
			cc: "b@example.org",
			bcc: ["optout@example.org"],
			optOuts: optOuts([{ address: "optout@example.org", scope: "global" }]),
		});
		expect(out).toBe(HTML);
	});

	it("fails closed: a lookup error sends untracked rather than tracked", async () => {
		const out = await trackOutgoingHtml({
			stub: stub(),
			mailboxId: "support@tapetide.com",
			emailId: "m1",
			html: HTML,
			baseUrl: BASE,
			to: "reader@example.org",
			optOuts: { findTrackingOptOuts: async () => Promise.reject(new Error("AuthDO down")) },
		});
		expect(out).toBe(HTML);
	});

	it("skips the lookup for plain-text mail", async () => {
		const calls: unknown[][] = [];
		await trackOutgoingHtml({
			stub: stub(),
			mailboxId: "support@tapetide.com",
			emailId: "m1",
			html: "just text",
			baseUrl: BASE,
			to: "reader@example.org",
			optOuts: optOuts([], calls),
		});
		expect(calls).toEqual([]);
	});
});

describe("per-message switch (track: false)", () => {
	it("sends untracked whatever the mailbox setting, and never asks for the secret", async () => {
		let secretAsked = false;
		const out = await trackOutgoingHtml({
			stub: {
				...stub(),
				async getOrCreateTrackingSecret() {
					secretAsked = true;
					return SECRET;
				},
			},
			mailboxId: "support@tapetide.com",
			emailId: "m1",
			html: HTML,
			baseUrl: BASE,
			to: "reader@example.org",
			track: false,
		});
		expect(out).toBe(HTML);
		expect(secretAsked).toBe(false);
	});

	it("track: true cannot turn tracking on for a mailbox that has it off", async () => {
		const out = await trackOutgoingHtml({
			stub: stub({ openTracking: false, clickTracking: false }),
			mailboxId: "support@tapetide.com",
			emailId: "m1",
			html: HTML,
			baseUrl: BASE,
			to: "reader@example.org",
			track: true,
		});
		expect(out).toBe(HTML);
	});

	it("the composer sends track:false only when the switch is on", () => {
		expect(trackFieldFor(true)).toEqual({ track: false });
		expect(trackFieldFor(false)).toEqual({});
		// Spread into the payload exactly like buildOutgoing does.
		expect({ subject: "x", ...trackFieldFor(false) }).not.toHaveProperty("track");
	});
});

describe("disclosure line", () => {
	it("is appended to tracked mail when enabled, with the default wording", async () => {
		const out = await trackOutgoingHtml({
			stub: stub({ disclosureEnabled: true, disclosureText: null }),
			mailboxId: "support@tapetide.com",
			emailId: "m1",
			html: HTML,
			baseUrl: BASE,
			to: "reader@example.org",
		});
		expect(out).toContain(DEFAULT_TRACKING_DISCLOSURE);
		expect(out!.indexOf(DEFAULT_TRACKING_DISCLOSURE)).toBeLessThan(out!.indexOf("</body>"));
	});

	it("is absent when disabled (the default) and when the message is not tracked", async () => {
		const off = await trackOutgoingHtml({
			stub: stub(),
			mailboxId: "support@tapetide.com",
			emailId: "m1",
			html: HTML,
			baseUrl: BASE,
			to: "reader@example.org",
		});
		expect(off).not.toContain("data-tt-disclosure");
		const untracked = await trackOutgoingHtml({
			stub: stub({ disclosureEnabled: true }),
			mailboxId: "support@tapetide.com",
			emailId: "m1",
			html: HTML,
			baseUrl: BASE,
			to: "reader@example.org",
			track: false,
		});
		expect(untracked).toBe(HTML);
	});

	it("escapes custom text and is idempotent", () => {
		const once = appendDisclosure("<p>x</p>", "Opens <tracked> & clicks");
		expect(once).toContain("Opens &lt;tracked&gt; &amp; clicks");
		expect(appendDisclosure(once, "Opens <tracked> & clicks")).toBe(once);
	});
});

// ── storage + scheduled delivery ────────────────────────────────────

function sqlStorage(db: DatabaseSync): DurableObjectState {
	const exec = (query: string, ...bindings: unknown[]) => {
		const trimmed = query.trim();
		if (bindings.length === 0 && !/^(select|with)/i.test(trimmed)) {
			db.exec(trimmed);
			return { toArray: () => [], rowsWritten: 0, one: () => undefined, [Symbol.iterator]: () => [][Symbol.iterator]() };
		}
		const rows = db.prepare(trimmed).all(...(bindings as never[])) as Record<string, unknown>[];
		const changes = Number((db.prepare("SELECT changes() AS n").get() as { n: number }).n ?? 0);
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

describe("mailbox tracking settings (migration 38)", () => {
	it("existing defaults are kept: tracking on, disclosure off", () => {
		expect(getTrackingSettings(ctx)).toEqual({
			openTracking: true,
			clickTracking: true,
			attachmentTracking: true,
			disclosureEnabled: false,
			disclosureText: null,
		});
	});

	it("patches only the fields given and trims the disclosure text", () => {
		updateTrackingSettings(ctx, { clickTracking: false, disclosureEnabled: true, disclosureText: "  Measured.  " });
		expect(getTrackingSettings(ctx)).toMatchObject({
			openTracking: true,
			clickTracking: false,
			disclosureEnabled: true,
			disclosureText: "Measured.",
		});
	});
});

function fakeEnv(optOutList: { address: string; scope: string }[] = []) {
	const sent: Record<string, unknown>[] = [];
	const store = optOuts(optOutList);
	const env = {
		EMAIL: {
			send: async (message: Record<string, unknown>) => {
				sent.push(message);
				return { messageId: `provider-${sent.length}` };
			},
		},
		BUCKET: { get: async () => null },
		AUTH_STORE: { idFromName: () => "global", get: () => store },
	} as unknown as Env;
	return { env, sent };
}

function queue(id: string, recipient: string, track?: boolean) {
	db.prepare(
		`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, read)
		 VALUES (?, 'scheduled', 'Hi', 'support@tapetide.com', ?, '2026-10-26T09:00:00.000Z', ?, 1)`,
	).run(id, recipient, HTML);
	recordScheduledSend(ctx, id, "2026-10-26T09:00:00.000Z", {
		trackingBaseUrl: BASE,
		mailboxId: "support@tapetide.com",
		track,
	});
}

const deliver = (env: Env) => processDueScheduledSends(ctx, env, { now: new Date("2026-10-26T09:05:00.000Z") });

describe("scheduled delivery (every composer send)", () => {
	it("a message queued with track:false is delivered untracked", async () => {
		const { env, sent } = fakeEnv();
		queue("q1", "reader@example.org", false);
		await deliver(env);
		expect(sent).toHaveLength(1);
		expect(isTracked(sent[0].html as string)).toBe(false);
	});

	it("a message queued without the flag is tracked", async () => {
		const { env, sent } = fakeEnv();
		queue("q2", "reader@example.org");
		await deliver(env);
		expect(isTracked(sent[0].html as string)).toBe(true);
	});

	it("a recipient opt-out applies at delivery time", async () => {
		const { env, sent } = fakeEnv([{ address: "reader@example.org", scope: "tapetide.com" }]);
		queue("q3", "reader@example.org");
		await deliver(env);
		expect(isTracked(sent[0].html as string)).toBe(false);
	});
});
