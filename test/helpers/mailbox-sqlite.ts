// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * A `DurableObjectState` over in-memory `node:sqlite` with every MailboxDO
 * migration applied, so per-mailbox SQL modules run against the real schema.
 * Only the surface those modules use is provided: `storage.sql.exec`,
 * `transactionSync`, and an alarm slot.
 */

import { DatabaseSync } from "node:sqlite";
import { applyMigrations, mailboxMigrations } from "../../workers/durableObject/migrations";

export function mailboxSqlite() {
	const db = new DatabaseSync(":memory:");
	const exec = (query: string, ...bindings: unknown[]) => {
		const trimmed = query.trim();
		const isRead = /^(select|with|pragma)/i.test(trimmed) || /\breturning\b/i.test(trimmed);
		if (isRead) {
			const rows = db.prepare(trimmed).all(...(bindings as never[])) as Record<string, unknown>[];
			return { toArray: () => rows, rowsWritten: 0, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
		}
		if (bindings.length === 0) {
			db.exec(trimmed);
			return { toArray: () => [], rowsWritten: 0, one: () => undefined, [Symbol.iterator]: () => [][Symbol.iterator]() };
		}
		const info = db.prepare(trimmed).run(...(bindings as never[]));
		return {
			toArray: () => [],
			rowsWritten: Number(info.changes ?? 0),
			one: () => undefined,
			[Symbol.iterator]: () => [][Symbol.iterator](),
		};
	};
	let alarm: number | null = null;
	const storage = {
		sql: { exec },
		transactionSync: <T>(fn: () => T) => fn(),
		getAlarm: async () => alarm,
		setAlarm: async (at: number) => {
			alarm = at;
		},
		deleteAlarm: async () => {
			alarm = null;
		},
	};
	applyMigrations(storage.sql as unknown as SqlStorage, mailboxMigrations, storage as never);
	const ctx = { storage, waitUntil: () => {} } as unknown as DurableObjectState;

	let seq = 0;
	const insert = (row: {
		id?: string;
		folder?: string;
		thread_id?: string | null;
		sender?: string;
		sender_name?: string | null;
		recipient?: string;
		subject?: string;
		body?: string;
		date?: string;
		raw_headers?: unknown[] | null;
		read?: boolean;
		starred?: boolean;
		priority?: string | null;
	}) => {
		seq++;
		const id = row.id ?? `m${seq}`;
		db.prepare(
			`INSERT INTO emails (id, folder_id, thread_id, subject, sender, sender_name, recipient, date, body, raw_headers, read, starred, priority)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			row.folder ?? "inbox",
			row.thread_id === undefined ? "t1" : row.thread_id,
			row.subject ?? "Subject",
			row.sender ?? "alice@example.com",
			row.sender_name ?? null,
			row.recipient ?? "support@example.com",
			row.date ?? new Date(Date.UTC(2026, 9, 20, 10, seq)).toISOString(),
			row.body ?? `<p>Message body number ${seq} with enough text to read.</p>`,
			row.raw_headers ? JSON.stringify(row.raw_headers) : null,
			row.read ? 1 : 0,
			row.starred ? 1 : 0,
			row.priority ?? null,
		);
		return id;
	};

	return { db, ctx, insert, getAlarm: () => alarm };
}
