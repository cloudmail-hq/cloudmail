// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Migration 27 heals the outbound rows the delivery reconciler could never
 * match in production: bracketed `message_id`s from the agent/MCP send paths,
 * and delivered rows whose cache was written back as NULL before `delivered`
 * existed. Runs the real migration list against node:sqlite.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyMigrations, mailboxMigrations } from "../workers/durableObject/migrations";

function storage(db: DatabaseSync) {
	const exec = (query: string, ...bindings: unknown[]) => {
		const trimmed = query.trim();
		if (/^(select|with)/i.test(trimmed)) {
			const rows = db.prepare(trimmed).all(...(bindings as never[])) as Record<string, unknown>[];
			return { toArray: () => rows, rowsWritten: 0, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
		}
		if (bindings.length === 0) {
			db.exec(trimmed);
			return { toArray: () => [], rowsWritten: 0, one: () => undefined, [Symbol.iterator]: () => [][Symbol.iterator]() };
		}
		const info = db.prepare(trimmed).run(...(bindings as never[]));
		return { toArray: () => [], rowsWritten: Number(info.changes ?? 0), one: () => undefined, [Symbol.iterator]: () => [][Symbol.iterator]() };
	};
	return { sql: { exec }, transactionSync: <T>(fn: () => T) => fn() };
}

const HEAL = "27_heal_outbound_delivery_cache";

describe(`migration ${HEAL}`, () => {
	it("sits after 26, before 28, and leaves every earlier migration in place", () => {
		const names = mailboxMigrations.map((m) => m.name);
		expect(names[names.indexOf(HEAL) + 1]).toBe("28_add_engagement_cache");
		expect(names.indexOf("26_add_snippet_and_sender_name")).toBe(names.indexOf(HEAL) - 1);
	});

	it("strips brackets on outbound ids and promotes delivered NULL caches only", () => {
		const db = new DatabaseSync(":memory:");
		const s = storage(db);
		const before = mailboxMigrations.slice(0, mailboxMigrations.findIndex((m) => m.name === HEAL));
		applyMigrations(s.sql as unknown as SqlStorage, before, s as never);

		const insert = db.prepare(
			`INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, message_id, delivery_status)
			 VALUES (?, ?, 's', 'support@example.com', 'a@example.org', '2026-10-20T00:00:00Z', '', ?, ?)`,
		);
		const ev = db.prepare(`INSERT INTO delivery_events (email_id, event_type, source, occurred_at) VALUES (?, ?, 'send', ?)`);

		insert.run("agent", "sent", "<abc@example.com>", "sent"); // agent tool send
		ev.run("agent", "sent", "2026-10-20T00:00:01Z");
		insert.run("inbound", "inbox", "<keep@example.net>", null); // inbound: untouched
		insert.run("old", "sent", "old@example.com", null); // pre-#103 reconciled delivery
		ev.run("old", "sent", "2026-10-20T00:00:01Z");
		ev.run("old", "delivered", "2026-10-20T00:01:00Z");
		insert.run("bounced", "sent", "b@example.com", null); // latest terminal is a bounce
		ev.run("bounced", "delivered", "2026-10-20T00:01:00Z");
		ev.run("bounced", "bounced", "2026-10-20T00:02:00Z");
		insert.run("tie", "sent", "t@example.com", null); // same-instant tie: failure wins
		ev.run("tie", "delivered", "2026-10-20T00:01:00Z");
		ev.run("tie", "bounced", "2026-10-20T00:01:00Z");
		insert.run("pending", "sent", "p@example.com", "sent"); // nothing terminal yet
		insert.run("inbound-ev", "inbox", "i@example.net", null); // inbound with a stray terminal event
		ev.run("inbound-ev", "delivered", "2026-10-20T00:01:00Z");

		applyMigrations(s.sql as unknown as SqlStorage, mailboxMigrations, s as never);

		const row = (id: string) =>
			db.prepare(`SELECT message_id, delivery_status FROM emails WHERE id = ?`).get(id) as {
				message_id: string | null;
				delivery_status: string | null;
			};
		expect(row("agent")).toEqual({ message_id: "abc@example.com", delivery_status: "sent" });
		expect(row("inbound")).toEqual({ message_id: "<keep@example.net>", delivery_status: null });
		expect(row("old").delivery_status).toBe("delivered");
		expect(row("bounced").delivery_status).toBeNull();
		expect(row("tie").delivery_status).toBeNull();
		expect(row("pending").delivery_status).toBe("sent");
		expect(row("inbound-ev").delivery_status).toBeNull();
	});
});
