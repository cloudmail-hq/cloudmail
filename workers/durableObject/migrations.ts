// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { PUSH_QUEUE_MIGRATION_SQL } from "./push-queue";

export interface Migration {
	name: string;
	sql: string;
}

/**
 * Minimal migration runner that replaces workers-qb's DOQB.migrations().apply().
 *
 * Uses the `d1_migrations` tracking table for backward compatibility with
 * existing deployments that were managed by workers-qb. New deployments
 * create the same table so the schema is consistent either way.
 */
export function applyMigrations(
	sql: SqlStorage,
	migrations: Migration[],
	storage?: DurableObjectStorage,
): void {
	sql.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL UNIQUE,
		applied_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`);

	for (const migration of migrations) {
		const applied = [
			...sql.exec(
				`SELECT 1 FROM d1_migrations WHERE name = ?`,
				migration.name,
			),
		];
		if (applied.length > 0) continue;

		// Strip any existing BEGIN/COMMIT wrapper from the migration SQL.
		// Cloudflare's DO runtime forbids SQL-level transactions -- must use
		// the JS storage.transactionSync() API instead.
		let migrationSql = migration.sql.trim();
		migrationSql = migrationSql.replace(/^\s*BEGIN\s+TRANSACTION\s*;?\s*/i, "");
		migrationSql = migrationSql.replace(/\s*COMMIT\s*;?\s*$/i, "");

		const escapedName = migration.name.replace(/'/g, "''");
		const run = () => {
			sql.exec(migrationSql);
			sql.exec(
				`INSERT INTO d1_migrations (name) VALUES ('${escapedName}')`,
			);
		};

		if (storage) {
			// Preferred: atomic transaction via the DO JS API
			storage.transactionSync(run);
		} else {
			// Fallback: run without explicit transaction (each exec is auto-committed)
			run();
		}
	}
}

interface DurableObjectStorage {
	transactionSync: <T>(closure: () => T) => T;
}

/**
 * Drop every table this mailbox owns, so `applyMigrations` can rebuild it from
 * scratch.
 *
 * ## Why this is derived instead of listed
 *
 * `purge()` used to name the tables to drop. It listed nine; the schema has
 * grown to fifteen, so `rules`, `muted_threads`, `auto_reply_log`,
 * `mailbox_state`, `allowed_senders` and `emails_fts` were all absent from it.
 * Reading `sqlite_master` cannot drift as migrations are added, which is the
 * point.
 *
 * The omission that would have mattered most is `emails_fts`: an
 * external-content FTS5 index keyed by `emails.rowid`. Left behind while
 * `emails` is rebuilt from rowid 1, its stale entries would resolve to whichever
 * new message inherited a rowid, so a search for a word that only ever appeared
 * in destroyed mail could return an unrelated live message.
 *
 * `purge()` also calls `storage.deleteAll()`, which for a SQLite-backed Durable
 * Object is documented as clearing the object's storage — so in practice that may
 * already remove the schema and this function is belt to its braces. It is kept
 * because the ordering below is what makes the SQL surface *provably* clean, and
 * because being wrong about that in the other direction is silent.
 *
 * ## Order is load-bearing
 *
 * 1. **Triggers first.** `emails` carries `AFTER DELETE` triggers that write to
 *    `emails_fts` and `mailbox_state`. `folders` is a parent of `emails` via
 *    `ON DELETE CASCADE`, so dropping `folders` deletes every `emails` row and
 *    fires those triggers. If the FTS index is already gone, the trigger raises
 *    `no such table: main.emails_fts` and the purge aborts half-done.
 * 2. **Virtual tables next.** FTS5 keeps shadow tables (`emails_fts_data`,
 *    `_idx`, `_docsize`, `_config`) that appear in `sqlite_master` as ordinary
 *    tables but cannot be dropped directly — dropping the virtual table takes
 *    them with it.
 * 3. **Everything else in reverse creation order.** Children were created after
 *    their parents, so reversing drops `attachments` before `emails` before
 *    `folders`, and no cascade ever has rows to delete.
 *
 * Objects owned by the engine or by the runtime are left alone: `sqlite_%` is
 * SQLite's own, and workerd reserves `_cf_%`/`__cf_%` for things like the
 * key-value and alarm state backing this Durable Object. Those appear when
 * listing tables but refuse to be dropped through the SQL API, and `purge()`
 * does not guard this call — so without the filter, deleting a mailbox would
 * throw partway and leave the object half-wiped.
 */
export function dropAllTables(sql: SqlStorage): void {
	const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

	const objects = (type: "trigger" | "table") => [
		...sql.exec<{ name: string; sql: string | null }>(
			`SELECT name, sql FROM sqlite_master
			  WHERE type = ?1
			    AND name NOT LIKE 'sqlite_%'
			    AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
			    AND name NOT LIKE '\\_\\_cf\\_%' ESCAPE '\\'`,
			type,
		),
	];

	const isVirtual = (create: string | null) =>
		/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(create ?? "");

	/**
	 * Drop one object, tolerating a refusal.
	 *
	 * The prefix filter above should already exclude anything reserved, but this
	 * runs against live storage during mailbox deletion and a single unexpected
	 * refusal must not abort the sweep with most tables still standing.
	 */
	const drop = (statement: string, name: string) => {
		try {
			sql.exec(statement);
		} catch (e) {
			console.error(`purge: could not drop ${name}:`, (e as Error).message);
		}
	};

	for (const trigger of objects("trigger")) {
		drop(`DROP TRIGGER IF EXISTS ${quote(trigger.name)}`, trigger.name);
	}

	for (const table of objects("table")) {
		if (isVirtual(table.sql)) {
			drop(`DROP TABLE IF EXISTS ${quote(table.name)}`, table.name);
		}
	}

	// Re-read: the shadow tables belonging to the virtual tables above are gone
	// with them, and dropping one directly is an error. Reversed so children go
	// before parents and no cascade has rows left to delete.
	for (const table of objects("table").reverse()) {
		drop(`DROP TABLE IF EXISTS ${quote(table.name)}`, table.name);
	}
}

/**
 * Wrap SQL in a transaction so multi-statement migrations are atomic.
 *
 * Without this, a migration like `1_initial_setup` (CREATE + INSERT +
 * CREATE + CREATE) could fail mid-way and leave the database in an
 * inconsistent state that the runner considers "applied" but is
 * actually broken.  SQLite transactions guarantee all-or-nothing.
 *
 * Single-statement migrations don't strictly need it but wrapping
 * uniformly costs nothing and avoids accidental omissions.
 */
function txn(sql: string): string {
	const trimmed = sql.trim();
	// Don't double-wrap if someone already added BEGIN/COMMIT
	if (/^\s*BEGIN\b/i.test(trimmed)) return trimmed;
	return `BEGIN TRANSACTION;\n${trimmed}\nCOMMIT;`;
}

export const mailboxMigrations: Migration[] = [
	{
		name: "1_initial_setup",
		sql: txn(`
            CREATE TABLE folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                is_deletable INTEGER NOT NULL DEFAULT 1
            );

            INSERT INTO folders (id, name, is_deletable) VALUES
                ('inbox', 'Inbox', 0),
                ('sent', 'Sent', 0),
                ('trash', 'Trash', 0),
                ('archive', 'Archive', 0),
                ('spam', 'Spam', 0);

            CREATE TABLE emails (
                id TEXT PRIMARY KEY,
                folder_id TEXT NOT NULL,
                subject TEXT,
                sender TEXT,
                recipient TEXT,
                date TEXT,
                read INTEGER DEFAULT 0,
                starred INTEGER DEFAULT 0,
                body TEXT,
                FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE CASCADE
            );

            CREATE TABLE attachments (
                id TEXT PRIMARY KEY,
                email_id TEXT NOT NULL,
                filename TEXT NOT NULL,
                mimetype TEXT NOT NULL,
                size INTEGER NOT NULL,
                content_id TEXT,
                disposition TEXT,
                FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
            );
        `),
	},
	{
		name: "2_add_email_threading",
		sql: txn(`
            ALTER TABLE emails ADD COLUMN in_reply_to TEXT;
            ALTER TABLE emails ADD COLUMN email_references TEXT;
            ALTER TABLE emails ADD COLUMN thread_id TEXT;

            CREATE INDEX idx_emails_thread_id ON emails(thread_id);
            CREATE INDEX idx_emails_in_reply_to ON emails(in_reply_to);
        `),
	},
	{
		name: "3_add_draft_folder",
		sql: txn(`INSERT INTO folders (id, name, is_deletable) VALUES ('draft', 'Drafts', 0);`),
	},
	{
		name: "4_add_message_id",
		sql: txn(`ALTER TABLE emails ADD COLUMN message_id TEXT;`),
	},
	{
		name: "5_add_raw_headers",
		sql: txn(`ALTER TABLE emails ADD COLUMN raw_headers TEXT;`),
	},
	{
		name: "6_mark_sent_emails_as_read",
		sql: txn(`UPDATE emails SET read = 1 WHERE folder_id = 'sent' AND read = 0;`),
	},
	{
		name: "7_add_cc_bcc",
		sql: txn(`
            ALTER TABLE emails ADD COLUMN cc TEXT;
            ALTER TABLE emails ADD COLUMN bcc TEXT;
        `),
	},
	{
		// No txn() wrapper: Cloudflare's DO runtime requires state.storage.transactionSync()
		// instead of SQL-level BEGIN TRANSACTION. These are idempotent CREATE INDEX IF NOT EXISTS
		// statements so they're safe to run without a transaction.
		name: "8_add_folder_date_indexes",
		sql: `
            CREATE INDEX IF NOT EXISTS idx_emails_folder_id ON emails(folder_id);
            CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date);
            CREATE INDEX IF NOT EXISTS idx_emails_folder_date ON emails(folder_id, date DESC);
        `,
	},
	{
		// Labels: many-to-many tagging, independent of the single-folder model.
		// `parent_id` allows nesting; `sort_order` drives sidebar ordering.
		name: "9_add_labels",
		sql: `
            CREATE TABLE IF NOT EXISTS labels (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT '#6b7280',
                parent_id TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_name ON labels(name);
            CREATE INDEX IF NOT EXISTS idx_labels_parent ON labels(parent_id);

            CREATE TABLE IF NOT EXISTS email_labels (
                email_id TEXT NOT NULL,
                label_id TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (email_id, label_id),
                FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE,
                FOREIGN KEY(label_id) REFERENCES labels(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_email_labels_label ON email_labels(label_id);
        `,
	},
	{
		// Signatures are per-mailbox, so they live in the mailbox DO rather than
		// the shared R2 metadata blob. At most one row may have is_default = 1;
		// the DO enforces that invariant on write.
		name: "10_add_signatures",
		sql: `
            CREATE TABLE IF NOT EXISTS signatures (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                body_html TEXT NOT NULL,
                is_default INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_signatures_default ON signatures(is_default);
        `,
	},
	{
		// Snooze parks a message in the Snoozed folder until `snoozed_until`, then
		// the DO alarm returns it to `snooze_return_folder`. Priority is a
		// header-derived hint ('high' | 'low'); NULL means normal.
		name: "11_add_snooze_and_priority",
		sql: `
            ALTER TABLE emails ADD COLUMN snoozed_until TEXT;
            ALTER TABLE emails ADD COLUMN snooze_return_folder TEXT;
            ALTER TABLE emails ADD COLUMN priority TEXT;

            CREATE INDEX IF NOT EXISTS idx_emails_snoozed_until ON emails(snoozed_until);

            INSERT OR IGNORE INTO folders (id, name, is_deletable) VALUES
                ('snoozed', 'Snoozed', 0),
                ('scheduled', 'Scheduled', 0);
        `,
	},
	{
		// Scheduled / undo send. The message itself stays a normal row in the
		// `scheduled` folder so it remains searchable and keeps its attachments;
		// this side table carries only the delivery state.
		name: "12_add_scheduled_sends",
		sql: `
            CREATE TABLE IF NOT EXISTS scheduled_sends (
                email_id TEXT PRIMARY KEY,
                send_at TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_scheduled_sends_due ON scheduled_sends(status, send_at);
        `,
	},
	{
		// Blocked senders. `pattern` is either a full address ("spam@example.com")
		// or a domain suffix ("@example.com"), matched case-insensitively when
		// mail arrives.
		name: "13_add_blocked_senders",
		sql: `
            CREATE TABLE IF NOT EXISTS blocked_senders (
                id TEXT PRIMARY KEY,
                pattern TEXT NOT NULL,
                reason TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_blocked_senders_pattern ON blocked_senders(pattern);
        `,
	},
	{
		// Trash is now a staging area rather than a folder nobody routes to.
		// Deleting records where the message came from so it can be put back,
		// and when it was binned so a retention sweep has something to sort on.
		//
		// Rows already sitting in Trash predate this and have no origin, so a
		// restore falls back to the inbox.
		name: "14_add_trash_provenance",
		sql: `
            ALTER TABLE emails ADD COLUMN trashed_from TEXT;
            ALTER TABLE emails ADD COLUMN trashed_at TEXT;

            CREATE INDEX IF NOT EXISTS idx_emails_trashed_at ON emails(trashed_at);
        `,
	},
	{
		// Inbound filter rules. Conditions and actions are stored as JSON because
		// they are only ever read as a whole rule and evaluated in JS — normalising
		// them into rows would buy nothing and cost a join per inbound message.
		name: "15_add_rules",
		sql: `
            CREATE TABLE IF NOT EXISTS rules (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                sort_order INTEGER NOT NULL DEFAULT 0,
                match_type TEXT NOT NULL DEFAULT 'all',
                conditions TEXT NOT NULL DEFAULT '[]',
                actions TEXT NOT NULL DEFAULT '[]',
                stop_processing INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_rules_order ON rules(enabled, sort_order);
        `,
	},
	{
		// Muted conversations. Keyed by thread rather than message so a mute
		// applies to replies that have not arrived yet, which is the entire point
		// of muting a thread.
		name: "16_add_muted_threads",
		sql: `
            CREATE TABLE IF NOT EXISTS muted_threads (
                thread_id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `,
	},
	{
		// Vacation auto-replies. One row per correspondent per window, so a
		// mailing list or a rapid back-and-forth cannot turn the responder into a
		// mail loop.
		name: "17_add_auto_reply_log",
		sql: `
            CREATE TABLE IF NOT EXISTS auto_reply_log (
                recipient TEXT PRIMARY KEY,
                last_sent_at TEXT NOT NULL
            );
        `,
	},
	{
		// Full-text search over the fields the search box actually queries.
		//
		// `LIKE '%term%'` cannot use an index, so search cost grew linearly with
		// the mailbox. This is an external-content FTS5 table: the index holds no
		// copy of the body, it points back at `emails` by rowid, and triggers keep
		// the two in step. Existing rows are backfilled in the same migration so
		// search does not silently ignore everything received before today.
		name: "18_add_emails_fts",
		sql: `
            CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
                subject,
                body,
                sender,
                recipient,
                content='emails',
                content_rowid='rowid',
                tokenize='porter unicode61'
            );

            INSERT INTO emails_fts (rowid, subject, body, sender, recipient)
                SELECT rowid, COALESCE(subject, ''), COALESCE(body, ''),
                       COALESCE(sender, ''), COALESCE(recipient, '')
                  FROM emails;

            CREATE TRIGGER IF NOT EXISTS emails_fts_insert AFTER INSERT ON emails BEGIN
                INSERT INTO emails_fts (rowid, subject, body, sender, recipient)
                VALUES (new.rowid, COALESCE(new.subject, ''), COALESCE(new.body, ''),
                        COALESCE(new.sender, ''), COALESCE(new.recipient, ''));
            END;

            CREATE TRIGGER IF NOT EXISTS emails_fts_delete AFTER DELETE ON emails BEGIN
                INSERT INTO emails_fts (emails_fts, rowid, subject, body, sender, recipient)
                VALUES ('delete', old.rowid, COALESCE(old.subject, ''), COALESCE(old.body, ''),
                        COALESCE(old.sender, ''), COALESCE(old.recipient, ''));
            END;

            CREATE TRIGGER IF NOT EXISTS emails_fts_update AFTER UPDATE ON emails BEGIN
                INSERT INTO emails_fts (emails_fts, rowid, subject, body, sender, recipient)
                VALUES ('delete', old.rowid, COALESCE(old.subject, ''), COALESCE(old.body, ''),
                        COALESCE(old.sender, ''), COALESCE(old.recipient, ''));
                INSERT INTO emails_fts (rowid, subject, body, sender, recipient)
                VALUES (new.rowid, COALESCE(new.subject, ''), COALESCE(new.body, ''),
                        COALESCE(new.sender, ''), COALESCE(new.recipient, ''));
            END;
        `,
	},
	{
		/**
		 * A version counter the client can poll cheaply.
		 *
		 * The UI used to refetch every list every 30 seconds, which is both slow
		 * to notice new mail and wasteful when nothing has changed. This gives it
		 * a single row to watch instead.
		 *
		 * Maintained by triggers rather than by the write paths themselves:
		 * messages are inserted, moved, flagged and deleted from a dozen places
		 * across the Durable Object, the bulk helpers and the alarm, and any one
		 * of them forgetting to bump a counter would show up as a UI that quietly
		 * stops updating. A trigger cannot be forgotten.
		 */
		name: "19_add_change_counter",
		sql: `
            CREATE TABLE IF NOT EXISTS mailbox_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                version INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            INSERT OR IGNORE INTO mailbox_state (id, version) VALUES (1, 0);

            CREATE TRIGGER IF NOT EXISTS mailbox_state_insert AFTER INSERT ON emails BEGIN
                UPDATE mailbox_state
                   SET version = version + 1, updated_at = datetime('now')
                 WHERE id = 1;
            END;

            CREATE TRIGGER IF NOT EXISTS mailbox_state_update AFTER UPDATE ON emails BEGIN
                UPDATE mailbox_state
                   SET version = version + 1, updated_at = datetime('now')
                 WHERE id = 1;
            END;

            CREATE TRIGGER IF NOT EXISTS mailbox_state_delete AFTER DELETE ON emails BEGIN
                UPDATE mailbox_state
                   SET version = version + 1, updated_at = datetime('now')
                 WHERE id = 1;
            END;
        `,
	},
	{
		/**
		 * Spam filtering: the verdict on each message, and a per-mailbox allowlist.
		 *
		 * `spam_score` and `spam_signals` record why a message was filed where it
		 * was. Storing the reasons rather than recomputing them means the UI can
		 * explain a decision made under rules and heuristics that may since have
		 * changed, and that "Not spam" has something concrete to clear.
		 *
		 * `allowed_senders` mirrors `blocked_senders` (same `pattern` grammar: a
		 * full address, or a domain suffix like "@example.com"). It exists because
		 * without it "Not spam" cannot stick — the heuristics that filed the
		 * message would reach the same conclusion about the next one, and the user
		 * would have to rescue every message from the same sender forever.
		 */
		name: "20_add_spam_filtering",
		sql: `
            ALTER TABLE emails ADD COLUMN spam_score REAL;
            ALTER TABLE emails ADD COLUMN spam_signals TEXT;

            CREATE TABLE IF NOT EXISTS allowed_senders (
                id TEXT PRIMARY KEY,
                pattern TEXT NOT NULL,
                reason TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_allowed_senders_pattern ON allowed_senders(pattern);
        `,
	},
	{
		/**
		 * Indexes for three queries that were scanning, plus a narrower FTS trigger.
		 *
		 * `attachments(email_id)` is the important one. There was no index on the
		 * foreign key, yet `hasAttachmentSql` emits a correlated `EXISTS` against it
		 * in *every* list, count, search, label and thread query — so rendering one
		 * page of mail scanned the whole attachments table once per row.
		 *
		 * `emails(message_id)` is scanned on every inbound reply by
		 * `findThreadByMessageIds`, and now also by the duplicate check that makes
		 * inbound delivery idempotent.
		 *
		 * `emails(folder_id, read)` serves the unread counts in `getFolders` and
		 * `getMailboxState` — the latter polled every few seconds by every open tab.
		 *
		 * The trigger is recreated with an explicit column list. `AFTER UPDATE ON
		 * emails` fired for *any* column, so marking a message read, starring it,
		 * moving it, snoozing it or autosaving a draft re-indexed the entire body
		 * into FTS5 — the most expensive write in the schema, triggered by the
		 * cheapest actions in the UI. Only these four columns are indexed, so only
		 * they need to invalidate it.
		 *
		 * No UNIQUE index on `message_id`: rows violating it may already exist,
		 * courtesy of the duplicate-delivery bug this migration helps close, and a
		 * failing migration throws from the Durable Object constructor and makes the
		 * mailbox permanently unreachable. Uniqueness is enforced in the inbound
		 * path instead, where it can be handled.
		 */
		name: "21_add_missing_indexes_and_narrow_fts_trigger",
		sql: `
            CREATE INDEX IF NOT EXISTS idx_attachments_email_id ON attachments(email_id);
            CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
            CREATE INDEX IF NOT EXISTS idx_emails_folder_read ON emails(folder_id, read);

            DROP TRIGGER IF EXISTS emails_fts_update;

            CREATE TRIGGER emails_fts_update
            AFTER UPDATE OF subject, body, sender, recipient ON emails BEGIN
                INSERT INTO emails_fts (emails_fts, rowid, subject, body, sender, recipient)
                VALUES ('delete', old.rowid, COALESCE(old.subject, ''), COALESCE(old.body, ''),
                        COALESCE(old.sender, ''), COALESCE(old.recipient, ''));
                INSERT INTO emails_fts (rowid, subject, body, sender, recipient)
                VALUES (new.rowid, COALESCE(new.subject, ''), COALESCE(new.body, ''),
                        COALESCE(new.sender, ''), COALESCE(new.recipient, ''));
            END;
        `,
	},
	{
		/**
		 * Why an outbound message never arrived.
		 *
		 * A scheduled send that exhausted its three attempts was demoted back to
		 * Drafts with the reason recorded only in `scheduled_sends.last_error` — a
		 * table the reading pane never reads. From the user's side a draft they had
		 * already sent simply reappeared, with nothing to say why, and the obvious
		 * response is to press Send again into the same wall.
		 *
		 * Inbound bounces were worse: a delivery-status notification is ordinary
		 * mail as far as this app was concerned, so the sent message it reports on
		 * kept looking delivered forever.
		 *
		 * Both columns live on `emails` rather than `scheduled_sends` because the
		 * failure belongs to the message: the schedule row is deleted when a send is
		 * cancelled, does not exist at all for a bounce arriving days later, and is
		 * not joined by any list or detail query. NULL means nothing is known, which
		 * is the state of every message that went out fine.
		 *
		 * The index is partial. Almost every row is NULL, so a full index would be
		 * one entry per message to serve a predicate matching a handful;
		 * `WHERE delivery_status IS NOT NULL` indexes only the failures.
		 */
		name: "22_add_delivery_status",
		sql: `
            ALTER TABLE emails ADD COLUMN delivery_status TEXT;
            ALTER TABLE emails ADD COLUMN delivery_error TEXT;

            CREATE INDEX IF NOT EXISTS idx_emails_delivery_status
                ON emails(delivery_status)
             WHERE delivery_status IS NOT NULL;
        `,
	},
	{
		/**
		 * Record an attachment that was refused rather than stored.
		 *
		 * A blocked part has no blob in R2, so it needs a row to exist at all — and
		 * it needs one, because the alternative is dropping it silently and leaving
		 * the reader to wonder why the sender said "see attached" and there is
		 * nothing there. The row lets the reading pane name the file and say it was
		 * refused, which is the difference between a security control and mail
		 * quietly going missing.
		 *
		 * `NULL` rather than `0` for existing rows would work equally well, but a
		 * default makes every read site simpler: nothing has to distinguish "not
		 * blocked" from "predates blocking", because neither is blocked.
		 *
		 * No index. The column is only ever read alongside the rest of an
		 * attachment row, already fetched by `email_id`, and an index on a column
		 * that is 0 for virtually every row would cost writes and buy nothing.
		 *
		 * Numbered 23 because 22 is the delivery-status migration, merged while this
		 * was in review. Two migrations sharing a number is not something the runner
		 * can resolve — it keys on the name, so a duplicate would apply once and
		 * silently skip the other.
		 */
		name: "23_add_attachment_blocked",
		sql: `
            ALTER TABLE attachments ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0;
        `,
	},
	{
		/**
		 * An append-only ledger of everything that happened to an outbound
		 * message after it left the composer.
		 *
		 * ## Why a table and not more columns on `emails`
		 *
		 * Migration 22 gave `emails` a single `delivery_status` / `delivery_error`
		 * pair, written last-writer-wins by `recordDelivery`. That answers "did the
		 * last thing that touched this row succeed or fail", which was enough to end
		 * the silent-outage bug — but it cannot answer the questions this feature
		 * exists for:
		 *
		 *   - A send that soft-bounced twice and then delivered looks identical to
		 *     one that delivered first try: the intermediate attempts overwrote each
		 *     other and then were overwritten by success.
		 *   - "Delivered" itself was never recordable. A success wrote the provider
		 *     id and set the status back to NULL, so a delivered message and a
		 *     message sent before this code existed are the same NULL.
		 *   - A message to five recipients has one row and therefore one status,
		 *     even when three delivered and two bounced.
		 *   - Opens, clicks and attachment fetches have no shape on `emails` at all,
		 *     and each can happen many times.
		 *
		 * Each of those is an *event* with its own timestamp, recipient and source,
		 * so the honest model is one row per event. `emails.delivery_status` stays as
		 * a derived cache of the latest terminal outcome (see `recordDelivery`), so
		 * every existing list/detail query and the current UI keep working untouched
		 * while the ledger accumulates the detail beside it.
		 *
		 * ## Columns
		 *
		 * - `email_id` — the local `emails.id`, the same id the send path minted and
		 *   `recordDelivery` keys on. Not a foreign key: an event can arrive (a late
		 *   bounce, a click) after the message was hard-deleted, and losing the event
		 *   because the row is gone would recreate the blindness this fixes.
		 * - `recipient` — bare lowercased address the event is about, or NULL for a
		 *   message-level event (a whole-message rejection before any RCPT).
		 * - `event_type` — one of the values in `DELIVERY_EVENT_TYPES`. Text, not an
		 *   enum: SQLite has none, and a new event kind should be a code change here,
		 *   not a migration.
		 * - `source` — which system observed it (`send`, `dsn`, `graphql`, `pixel`,
		 *   `redirect`, `attachment`). Two systems can report the same delivery; the
		 *   source is how they are told apart and de-duplicated.
		 * - `provider_message_id` — the Email Service id, so a `graphql` reconciler
		 *   row can be joined back to the send even before the local id is known.
		 * - `error_cause` — the provider's coarse bucket (`mailbox_full`,
		 *   `bad_reputation`, ...). THIS is the column that answers "our bug or their
		 *   mailbox": an empty/`internal` cause is ours, a recipient-side cause is
		 *   theirs.
		 * - `error_detail` — free text, capped at the shared 500 like every other
		 *   failure string in this app.
		 * - `metadata` — small JSON for event-specific extras (the clicked URL, the
		 *   attachment id, a coarse client hint). Never PII beyond what the message
		 *   already holds.
		 * - `occurred_at` — when the event happened per its source (a bounce carries
		 *   its own time); `created_at` — when we wrote it. They differ for anything
		 *   reconciled after the fact.
		 *
		 * ## De-duplication
		 *
		 * Provider-observed lifecycle events must be idempotent: the GraphQL
		 * reconciler re-reads a rolling window every tick and a DSN can be
		 * redelivered, so "delivered" must not accumulate. `dedupe_key` carries a
		 * caller-computed identity that MUST identify the message as well as the
		 * verdict, because this index is mailbox-wide: a key of only
		 * `<source>:<type>:<recipient>` would make the second message to a given
		 * recipient collide with the first and be silently dropped by
		 * `ON CONFLICT DO NOTHING`. Both writers satisfy that — the reconciler uses
		 * `graphql:<type>:<providerMessageId>:<recipient>` and the DSN path uses
		 * `dsn:bounced:<emailId>:<recipient>` — and the partial
		 * unique index makes a repeat insert a no-op via `ON CONFLICT`. Engagement
		 * events (opens, clicks) are intentionally NOT deduped — every open is real
		 * signal — so they pass `NULL` and the partial index ignores them.
		 *
		 * ## Indexes
		 *
		 * `idx_delivery_events_email` serves the reading pane (all events for one
		 * message) and the derived-status recompute. `idx_delivery_events_type_time`
		 * serves the Sent-analytics aggregates, which group by type over a date
		 * range. The unique index is partial (`WHERE dedupe_key IS NOT NULL`) so the
		 * high-volume engagement rows cost nothing to insert.
		 *
		 * Numbered 24: 23 is attachment-blocked, 22 is delivery-status.
		 */
		name: "24_add_delivery_events",
		sql: txn(`
            CREATE TABLE IF NOT EXISTS delivery_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email_id TEXT NOT NULL,
                recipient TEXT,
                event_type TEXT NOT NULL,
                source TEXT NOT NULL,
                provider_message_id TEXT,
                error_cause TEXT,
                error_detail TEXT,
                metadata TEXT,
                dedupe_key TEXT,
                occurred_at TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_delivery_events_email
                ON delivery_events(email_id);

            CREATE INDEX IF NOT EXISTS idx_delivery_events_type_time
                ON delivery_events(event_type, occurred_at);

            CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_events_dedupe
                ON delivery_events(dedupe_key)
             WHERE dedupe_key IS NOT NULL;
        `),
	},
	{
		/**
		 * Per-mailbox tracking toggles.
		 *
		 * Open and click tracking rewrite outgoing mail (a pixel, wrapped links), so
		 * whether they are on is a property of the mailbox, not a global. Kept in
		 * SQLite beside the mailbox's own data rather than in the R2 settings blob
		 * because the send path — which reads this on every send — already holds the
		 * Durable Object open, and a per-send R2 GET would be a network hop on the
		 * hot path.
		 *
		 * Defaults follow the operator's decision to track by default: both ON. A
		 * mailbox that predates this migration gets the defaults, which is the intent
		 * — tracking should be live everywhere without a per-mailbox action.
		 *
		 * `secret` is a per-mailbox random key used to sign tracking tokens (see the
		 * public tracking endpoint). Generated lazily on first send when NULL, so no
		 * migration has to invent randomness; stored once so every token for a
		 * mailbox verifies against the same key.
		 */
		name: "25_add_tracking_settings",
		sql: txn(`
            CREATE TABLE IF NOT EXISTS tracking_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                open_tracking INTEGER NOT NULL DEFAULT 1,
                click_tracking INTEGER NOT NULL DEFAULT 1,
                attachment_tracking INTEGER NOT NULL DEFAULT 1,
                secret TEXT,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            INSERT OR IGNORE INTO tracking_settings (id) VALUES (1);
        `),
	},
	{
		/**
		 * A plain-text preview and the sender's real display name, both stored.
		 *
		 * `snippet` replaces `SUBSTR(body, 1, 300)` in every list projection. That
		 * expression returned raw HTML for HTML mail, so the REST API and MCP
		 * `list_emails` handed callers `<p>…</p>` (or, for newsletters, the first
		 * 300 characters of a stylesheet). It is computed in the Worker by
		 * `shared/plain-snippet.ts` — SQLite has no HTML parser — so this migration
		 * only adds the column. NULL means "not computed yet"; existing rows are
		 * filled lazily in batches by `backfillDerivedColumns` (see
		 * `workers/durableObject/derived.ts`), and the list projections fall back
		 * to the old expression until a row has been visited.
		 *
		 * `sender_name` is the display name from the `From:` header (inbound) or
		 * the name the mailbox sends under (outbound). `sender` stays a bare,
		 * lowercased address because threading, rules and search join on it.
		 *
		 * `derived_v` records which version of the derivation produced the two
		 * values, so a later improvement to the helpers can re-run the backfill by
		 * bumping a constant instead of shipping another migration.
		 *
		 * Partial index over the rows still to do, so each backfill batch is an
		 * index range rather than a scan of the whole mailbox.
		 */
		name: "26_add_snippet_and_sender_name",
		sql: txn(`
            ALTER TABLE emails ADD COLUMN snippet TEXT;
            ALTER TABLE emails ADD COLUMN sender_name TEXT;
            ALTER TABLE emails ADD COLUMN derived_v INTEGER NOT NULL DEFAULT 0;

            CREATE INDEX IF NOT EXISTS idx_emails_derived_pending
                ON emails(date)
             WHERE derived_v < 1;
        `),
	},
	{
		/**
		 * Heal outbound rows the delivery reconciler could never match.
		 *
		 * 1. The agent/MCP send tools stored `send()`'s `messageId` verbatim, i.e.
		 *    `<…@domain>`, while every join (reconciler, DSN, threading) looks up
		 *    the bare form. Strip the brackets on rows this app sent: those with a
		 *    `sent`/`queued` ledger event. Inbound rows are never touched.
		 * 2. Before `delivered` existed as a cache value, a reconciled delivery was
		 *    written back as `delivery_status = NULL`, and the dedupe on later
		 *    re-reads meant it was never recomputed. Promote outbound rows whose
		 *    latest terminal ledger event is `delivered` and whose cache is still
		 *    NULL/queued/sent. Failures are left to the runtime recompute.
		 */
		name: "27_heal_outbound_delivery_cache",
		sql: txn(`
            UPDATE emails
               SET message_id = SUBSTR(message_id, 2, LENGTH(message_id) - 2)
             WHERE message_id LIKE '<%>'
               AND EXISTS (
                     SELECT 1 FROM delivery_events de
                      WHERE de.email_id = emails.id AND de.event_type IN ('sent', 'queued')
                   );

            UPDATE emails
               SET delivery_status = 'delivered', delivery_error = NULL
             WHERE (delivery_status IS NULL OR delivery_status IN ('queued', 'sent'))
               AND (
                     folder_id = 'sent'
                     OR EXISTS (
                          SELECT 1 FROM delivery_events de
                           WHERE de.email_id = emails.id AND de.event_type IN ('sent', 'queued')
                        )
                   )
               AND (
                     SELECT de.event_type FROM delivery_events de
                      WHERE de.email_id = emails.id
                        AND de.event_type IN ('delivered', 'bounced', 'rejected', 'failed', 'complained')
                      ORDER BY de.occurred_at DESC,
                               CASE de.event_type WHEN 'delivered' THEN 1 ELSE 0 END ASC
                      LIMIT 1
                   ) = 'delivered';
        `),
	},
	{
		/**
		 * Engagement cache on `emails`: first/last open, open count, first click.
		 *
		 * The Sent list draws an "opened" / "clicked" indicator on every row, and
		 * aggregating `delivery_events` per row on each list read would be a
		 * grouped scan per page. These columns are maintained by
		 * `recordEngagement` (see ./engagement.ts), which recomputes them from the
		 * ledger for the one message an event names, so they cannot drift.
		 *
		 * `open_proxy_count` is how many of the opens came through a known
		 * mail-privacy proxy (Apple MPP, Gmail, Yahoo, Outlook), so the UI can say
		 * "likely via privacy proxy" when that is all there is.
		 *
		 * Existing ledger history is NOT aggregated here: a migration runs inside
		 * the Durable Object constructor, so it fills nothing and
		 * `engagement_v = 0` marks a row as not yet computed. The lazy
		 * `backfillEngagementCache` catches up rows that have engagement events, a
		 * bounded batch per list read, exactly like the derived-column backfill.
		 *
		 * Also `scheduled_sends.tracking_base_url`, for open/click tracking of
		 * mail delivered by the alarm (undo-send and scheduled sends).
		 */
		name: "28_add_engagement_cache",
		sql: txn(`
            ALTER TABLE emails ADD COLUMN opened_at TEXT;
            ALTER TABLE emails ADD COLUMN last_opened_at TEXT;
            ALTER TABLE emails ADD COLUMN open_count INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE emails ADD COLUMN open_proxy_count INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE emails ADD COLUMN clicked_at TEXT;
            ALTER TABLE emails ADD COLUMN click_count INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE emails ADD COLUMN engagement_v INTEGER NOT NULL DEFAULT 0;

            -- Rows the lazy engagement backfill still has to visit, so each
            -- batch is an index range rather than a scan of the mailbox.
            CREATE INDEX IF NOT EXISTS idx_emails_engagement_pending
                ON emails(date)
             WHERE engagement_v < 1;

            -- Scheduled delivery runs in the DO alarm with no request, so the
            -- origin the tracking URLs point at is captured when the message is
            -- queued. NULL falls back to APP_URL, then the production host.
            ALTER TABLE scheduled_sends ADD COLUMN tracking_base_url TEXT;
            -- The mailbox id the tokens must name (the DO's own name). Stored
            -- rather than read from ctx.id.name, which a runtime may not expose.
            ALTER TABLE scheduled_sends ADD COLUMN tracking_mailbox_id TEXT;
        `),
	},
	{
		/**
		 * Idempotency keys for sends and creates in this mailbox (`Idempotency-Key`
		 * header, MCP `idempotency_key`). One row per (scope, key); `status` NULL
		 * marks a request still in flight. Rows expire after 24 h, lazily on read
		 * and in the alarm. See workers/lib/idempotency-store.ts.
		 */
		name: "29_add_idempotency_keys",
		sql: txn(`
            CREATE TABLE IF NOT EXISTS idempotency_keys (
                scope TEXT NOT NULL,
                idem_key TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                status INTEGER,
                body TEXT,
                content_type TEXT,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                PRIMARY KEY (scope, idem_key)
            );
            CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires ON idempotency_keys(expires_at);
        `),
	},
	{
		/**
		 * Starred mail, newest first, without reading the table.
		 *
		 * `is:starred` (the Starred view and the search operator) had no index
		 * to use: the count was a full scan of `emails`, and on a cold Durable
		 * Object that means paging in every message to count the few dozen with
		 * a star, which is where the 4 s first search came from. Partial, because
		 * starred rows are a small minority and the predicate the search compiler
		 * emits is exactly `starred = 1`. Ordered like the list so the page is a
		 * walk of the index; `folder_id` rides along so the default "not in
		 * Trash or Spam" filter is answered from the index too.
		 */
		name: "30_add_starred_index",
		sql: `
            CREATE INDEX IF NOT EXISTS idx_emails_starred_date
                ON emails(date DESC, id DESC, folder_id) WHERE starred = 1;
        `,
	},
	{
		/**
		 * Reader warnings (display-name spoofing, lookalike domains, first-time
		 * sender, link mismatch), computed once at delivery by
		 * `shared/sender-warnings.ts` and stored as a JSON array, so the reading
		 * pane, the list icon and MCP `get_email` all report the same thing.
		 *
		 * Nullable with no backfill: messages delivered before this simply carry
		 * no warnings, which is what they showed before.
		 */
		name: "31_add_security_warnings",
		sql: txn(`
            ALTER TABLE emails ADD COLUMN security_warnings TEXT;
        `),
	},
	{
		/**
		 * Follow-up reminders on sent mail. See ./followups.ts.
		 *
		 * One row per watched outbound message. `followup_at` is when the alarm
		 * resurfaces the thread if nobody has replied; `duration_seconds` is kept
		 * so replying again yourself restarts the same clock. `return_folder` and
		 * `surfaced_email_id` record what a fired reminder moved, so a reply or a
		 * dismissal can put it back.
		 *
		 * Not a foreign key to `emails`: a purge drops tables in reverse creation
		 * order, and a deleted message's reminder is cleaned up by the alarm.
		 */
		name: "32_add_followups",
		sql: txn(`
            CREATE TABLE IF NOT EXISTS followups (
                email_id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL,
                followup_at TEXT NOT NULL,
                followup_mode TEXT NOT NULL DEFAULT 'manual',
                status TEXT NOT NULL DEFAULT 'pending',
                duration_seconds INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                fired_at TEXT,
                resolved_at TEXT,
                return_folder TEXT,
                surfaced_email_id TEXT
            );

            -- The alarm's "what is due" read and nextDeadline's MIN.
            CREATE INDEX IF NOT EXISTS idx_followups_pending
                ON followups(followup_at)
             WHERE status = 'pending';

            -- Cancellation looks up the active reminder for a thread on every insert.
            CREATE INDEX IF NOT EXISTS idx_followups_thread
                ON followups(thread_id, status);
        `),
	},
	{
		/**
		 * AI thread summaries and the generation backlog.
		 *
		 * Its own table keyed by `thread_id`, not columns on `emails`: a summary is
		 * a property of the conversation, and writing it onto a message row would
		 * fire the FTS and `mailbox_state` triggers on every regeneration. The
		 * writer bumps `mailbox_state` itself, once, so an open list refetches.
		 *
		 * - `summary_line`       one line (≤120 chars) for the list row
		 * - `summary_bullets`    JSON array of 3–5 strings for the reader, or NULL
		 * - `summary_msg_count`  message count it was generated from; regenerated
		 *                        only when the live count differs
		 * - `summary_v`          recipe version (`SUMMARY_VERSION`)
		 * - `status`             ok | blocked (injection guard) | skipped (bulk)
		 *
		 * `summary_queue` is the backlog the alarm drains: one row per thread,
		 * so a burst of replies to one conversation is one model call.
		 * `summary_usage` counts generations per UTC day for the per-mailbox cap.
		 * See workers/durableObject/summaries.ts.
		 */
		// 34 is the number reserved for this PR; 33 is held for another.
		name: "34_add_thread_summaries",
		sql: txn(`
            CREATE TABLE IF NOT EXISTS thread_summaries (
                thread_id TEXT PRIMARY KEY,
                summary_line TEXT,
                summary_bullets TEXT,
                summary_msg_count INTEGER NOT NULL DEFAULT 0,
                summary_v INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'ok',
                generated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS summary_queue (
                thread_id TEXT PRIMARY KEY,
                enqueued_at TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                source TEXT NOT NULL DEFAULT 'live'
            );
            CREATE INDEX IF NOT EXISTS idx_summary_queue_enqueued ON summary_queue(enqueued_at);

            CREATE TABLE IF NOT EXISTS summary_usage (
                day TEXT PRIMARY KEY,
                generated INTEGER NOT NULL DEFAULT 0
            );
        `),
	},
	{
		/**
		 * Privacy controls. Numbered 38 by reservation (parallel PRs hold 33-37);
		 * names, not numbers, decide whether a migration has run.
		 *
		 * - `tracking_settings.disclosure_*`: an optional footer line on tracked
		 *   mail ("This message may track opens and clicks"). Off by default, so
		 *   nothing changes for an existing mailbox until its owner turns it on.
		 *   Tracking itself keeps its existing per-mailbox values: no default is
		 *   flipped here.
		 * - `scheduled_sends.track`: the per-message "Don't track this message"
		 *   switch, captured at queue time because delivery runs in the alarm.
		 *   NULL means "follow the mailbox"; 0 means send untracked.
		 * - An index on `delivery_events(occurred_at)`, so the retention purge
		 *   walks an index range in bounded batches instead of scanning.
		 */
		name: "38_privacy_controls",
		sql: txn(`
            ALTER TABLE tracking_settings ADD COLUMN disclosure_enabled INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE tracking_settings ADD COLUMN disclosure_text TEXT;
            ALTER TABLE scheduled_sends ADD COLUMN track INTEGER;
            CREATE INDEX IF NOT EXISTS idx_delivery_events_occurred
                ON delivery_events(occurred_at);
        `),
	},
	{
		/**
		 * Per-mailbox outbound send caps, admin-editable (see shared/send-caps.ts).
		 *
		 * One row or none: no row means the defaults (20/hour, 100/day), which is
		 * what every mailbox had before. Numbered 37 by reservation and appended
		 * after 38_privacy_controls, which merged first: list position is run
		 * order and the name records whether it ran, so the gap is harmless.
		 */
		name: "37_add_send_limits",
		sql: txn(`
            CREATE TABLE IF NOT EXISTS send_limits (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                hourly_cap INTEGER NOT NULL,
                daily_cap INTEGER NOT NULL,
                updated_at TEXT NOT NULL,
                updated_by TEXT
            );
        `),
	},
	{
		/**
		 * AI triage and the Screener. See ./triage.ts and shared/ai-triage.ts.
		 *
		 * Numbered 35 by reservation (33 is held for parallel work).
		 *
		 * - `labels.prompt`: a label with a prompt is an auto-label. `preset_key`
		 *   ties it to a built-in preset; `auto_archive` files matches out of the
		 *   Inbox; `show_tab` makes it an inbox tab.
		 * - `email_labels.source`: who applied it (`ai`, `heuristic`, `rule`,
		 *   `user`; NULL on older rows). The feedback loop only learns from a
		 *   person undoing an `ai` or `heuristic` label.
		 * - `emails.triage_state`: NULL until triage has looked at a message, so
		 *   backfill can find what it has not seen. `sender_kind` and
		 *   `sender_confidence` are the Screener's AI pre-verdict.
		 * - `triage_corrections`: bounded few-shot examples, newest first.
		 * - `triage_queue`: per-message backlog the alarm drains, beside
		 *   `summary_queue` (34), so classification and summaries are one job.
		 * - `ai_usage`: Workers AI calls per UTC day, for the per-mailbox cap.
		 * - The `screener` system folder. INSERT OR IGNORE: a custom folder that
		 *   already took the id keeps it and serves as the Screener.
		 */
		name: "35_add_ai_triage",
		sql: txn(`
            ALTER TABLE labels ADD COLUMN prompt TEXT;
            ALTER TABLE labels ADD COLUMN preset_key TEXT;
            ALTER TABLE labels ADD COLUMN auto_archive INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE labels ADD COLUMN show_tab INTEGER NOT NULL DEFAULT 0;

            ALTER TABLE email_labels ADD COLUMN source TEXT;

            ALTER TABLE emails ADD COLUMN triage_state TEXT;
            ALTER TABLE emails ADD COLUMN sender_kind TEXT;
            ALTER TABLE emails ADD COLUMN sender_confidence TEXT;

            CREATE TABLE IF NOT EXISTS triage_corrections (
                id TEXT PRIMARY KEY,
                sender TEXT NOT NULL,
                subject TEXT NOT NULL DEFAULT '',
                label_id TEXT,
                label_name TEXT NOT NULL,
                action TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_triage_corrections_created
                ON triage_corrections(created_at DESC);

            -- Messages waiting for the post-ingest pass, drained by the alarm
            -- next to the summary queue (one job, two queues).
            -- mailbox_id: the alarm has no request, and ctx.id.name is not
            -- exposed there, so the settings key is stored with the row.
            CREATE TABLE IF NOT EXISTS triage_queue (
                email_id TEXT PRIMARY KEY,
                mailbox_id TEXT NOT NULL,
                enqueued_at TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS ai_usage (
                day TEXT PRIMARY KEY,
                calls INTEGER NOT NULL DEFAULT 0
            );

            -- The Screener view groups this folder by sender.
            CREATE INDEX IF NOT EXISTS idx_emails_folder_sender
                ON emails(folder_id, sender);

            INSERT OR IGNORE INTO folders (id, name, is_deletable) VALUES ('screener', 'Screener', 0);
        `),
	},
	{
		/**
		 * Agent and MCP sends waiting for a person (see
		 * `shared/agent-send-policy.ts` and `workers/lib/agent-send-gate.ts`).
		 *
		 * `payload` is the fully composed message (or batch, or sequence
		 * enrollment) as JSON: exactly what a person previews and what is sent, so
		 * nothing model-driven runs after the hold. `actor` is who asked. `status`
		 * moves pending → sending → sent | failed | sent_unconfirmed, or pending →
		 * rejected. pending → sending is a conditional UPDATE that also writes a
		 * fresh `fence`; only the holder of that fence can record the outcome, which
		 * is what makes approve-twice and approve-after-crash send at most once.
		 */
		name: "33_add_send_approvals",
		sql: txn(`
            CREATE TABLE IF NOT EXISTS send_approvals (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                reason TEXT NOT NULL,
                recipients TEXT NOT NULL,
                subject TEXT NOT NULL DEFAULT '',
                payload TEXT NOT NULL,
                actor TEXT NOT NULL,
                result TEXT,
                error TEXT,
                decided_by TEXT,
                created_at INTEGER NOT NULL,
                decided_at INTEGER,
                expires_at INTEGER NOT NULL,
                fence TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_send_approvals_status ON send_approvals(status, created_at);
        `),
	},
	{
		/**
		 * Web Push notifications that wait for triage: a message that an
		 * auto-archiving label might still move out of the Inbox is notified
		 * about after the post-ingest job, from where it ended up. See
		 * `./push-queue.ts`.
		 */
		name: "41_add_push_queue",
		sql: txn(PUSH_QUEUE_MIGRATION_SQL),
	},
	{
		/**
		 * Semantic search (see `./semantic.ts` and `shared/semantic.ts`).
		 *
		 * - `semantic_queue`: messages waiting to be chunked and embedded, drained
		 *   by the alarm next to triage and summaries (one post-ingest job).
		 *   `mailbox_id` is stored with the row because `ctx.id.name` is not
		 *   available in an alarm.
		 * - `semantic_index`: what is in Vectorize for each message (chunk count),
		 *   so a delete knows which vector ids to remove.
		 * - `semantic_deletes`: vector ids to remove from Vectorize. Filled by a
		 *   trigger on every `emails` delete, so Empty Trash, the retention sweep,
		 *   a permanent delete and anything added later all clean up the index
		 *   without each path having to remember to.
		 * - `semantic_usage`: embedding calls per UTC day, for the per-mailbox cap.
		 * - `semantic_mailbox`: this object's address, for the folder trigger.
		 *
		 * Numbered 40 by reservation. Append-only.
		 */
		name: "40_semantic_search",
		sql: txn(`
            CREATE TABLE IF NOT EXISTS semantic_queue (
                email_id TEXT PRIMARY KEY,
                mailbox_id TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'live',
                enqueued_at TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_semantic_queue_due ON semantic_queue(enqueued_at);

            CREATE TABLE IF NOT EXISTS semantic_index (
                email_id TEXT PRIMARY KEY,
                mailbox_id TEXT NOT NULL,
                chunks INTEGER NOT NULL,
                indexed_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS semantic_deletes (
                email_id TEXT PRIMARY KEY,
                mailbox_id TEXT NOT NULL,
                chunks INTEGER NOT NULL,
                enqueued_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS semantic_usage (
                day TEXT PRIMARY KEY,
                embeddings INTEGER NOT NULL DEFAULT 0,
                queries INTEGER NOT NULL DEFAULT 0
            );

            -- This object's mailbox address, written by the first enqueue, so
            -- the folder trigger below can queue work with no request in hand.
            CREATE TABLE IF NOT EXISTS semantic_mailbox (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                mailbox_id TEXT NOT NULL
            );

            CREATE TRIGGER IF NOT EXISTS semantic_on_email_delete AFTER DELETE ON emails BEGIN
                INSERT OR REPLACE INTO semantic_deletes (email_id, mailbox_id, chunks, enqueued_at)
                    SELECT old.id, mailbox_id, chunks, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                      FROM semantic_index WHERE email_id = old.id;
                DELETE FROM semantic_index WHERE email_id = old.id;
                DELETE FROM semantic_queue WHERE email_id = old.id;
            END;

            -- Crossing into or out of a folder that is never indexed (Spam,
            -- Trash, Drafts, Scheduled, Screener) re-queues the message: the
            -- queue drops its vectors or indexes it. Ordinary moves (Archive,
            -- a label folder) cost nothing. Nothing is queued until the first
            -- enqueue has recorded the address (no binding, no work).
            CREATE TRIGGER IF NOT EXISTS semantic_on_folder_change AFTER UPDATE OF folder_id ON emails
            WHEN old.folder_id IS NOT new.folder_id
             AND (new.folder_id IN ('draft', 'scheduled', 'trash', 'spam', 'screener'))
              <> (old.folder_id IN ('draft', 'scheduled', 'trash', 'spam', 'screener'))
            BEGIN
                INSERT OR IGNORE INTO semantic_queue (email_id, mailbox_id, source, enqueued_at, attempts)
                    SELECT new.id, mailbox_id, 'live', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0
                      FROM semantic_mailbox WHERE id = 1;
            END;
        `),
	},
	{
		/**
		 * Mail import (mbox, zip of .eml, single .eml, IMAP). See
		 * ./mail-import.ts and shared/mail-import.ts.
		 *
		 * - `import_jobs`: one row per import, with the resume cursor. File
		 *   imports carry the R2 multipart upload (`upload_id`, `parts` as JSON
		 *   `[{n, etag, size}]`) until `complete`, then `cursor` is the byte offset
		 *   (mbox) or entry index (zip) of the next message. IMAP jobs keep their
		 *   folder plan and per-folder UID cursor in `state` (JSON). The password
		 *   is never here: it lives encrypted in the AuthDO (migration
		 *   0020_import_credentials) and is deleted when the job ends.
		 * - `emails.imported`: 1 for rows written by an import. The ingest path
		 *   that sets it never runs forwarding, auto-reply, webhooks, triage,
		 *   follow-ups or summaries, and the readers that would notify or count
		 *   sends (the unread poll, the send cap) skip it.
		 * - `import_seen`: content hashes of imported messages that carry no
		 *   Message-ID, so re-importing the same file does not duplicate them.
		 *
		 * Number reserved by the coordinator; appended last. Append-only.
		 */
		name: "43_add_mail_import",
		sql: txn(`
            CREATE TABLE IF NOT EXISTS import_jobs (
                id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                status TEXT NOT NULL,
                label TEXT NOT NULL DEFAULT '',
                mailbox TEXT,
                r2_key TEXT,
                upload_id TEXT,
                part_size INTEGER,
                parts TEXT,
                parts_total INTEGER,
                size_bytes INTEGER,
                cursor INTEGER NOT NULL DEFAULT 0,
                state TEXT,
                imported INTEGER NOT NULL DEFAULT 0,
                duplicates INTEGER NOT NULL DEFAULT 0,
                failed INTEGER NOT NULL DEFAULT 0,
                skipped INTEGER NOT NULL DEFAULT 0,
                total_messages INTEGER,
                last_error TEXT,
                imap_host TEXT,
                imap_username TEXT,
                options TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                started_at TEXT,
                finished_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON import_jobs(status, created_at);
            CREATE TABLE IF NOT EXISTS import_seen (
                content_hash TEXT PRIMARY KEY,
                email_id TEXT NOT NULL
            );
            ALTER TABLE emails ADD COLUMN imported INTEGER NOT NULL DEFAULT 0;
        `),
	},
	{
		/**
		 * Which embedding model this mailbox's vectors came from. Empty (no
		 * row) means bge-m3, the only model before it was configurable. When
		 * the admin changes the Workers AI embeddings model, the next semantic
		 * run sees the mismatch, re-queues what was indexed and replaces the
		 * old vectors (./semantic.ts `reconcileEmbeddingModel`), so vectors
		 * from two models are never mixed in one mailbox's namespace.
		 *
		 * Append-only.
		 */
		name: "44_semantic_embedding_model",
		sql: txn(`
            CREATE TABLE IF NOT EXISTS semantic_model (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                model TEXT NOT NULL,
                changed_at TEXT NOT NULL,
                reindexing INTEGER NOT NULL DEFAULT 0
            );
        `),
	},
	{
		/**
		 * Revisions of a held send (see `./approvals.ts`). Every edit of a
		 * pending item, by a reviewer or by the agent that asked for it, bumps
		 * `revision`, so an approve can name the version the person previewed
		 * and is refused if it changed underneath them. `revised_by` says who
		 * made the last edit: `requester` (the agent revising its own send) or
		 * `reviewer`.
		 *
		 * Append-only.
		 */
		name: "45_send_approval_revisions",
		sql: txn(`
            ALTER TABLE send_approvals ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE send_approvals ADD COLUMN revised_at INTEGER;
            ALTER TABLE send_approvals ADD COLUMN revised_by TEXT;
        `),
	},
];
