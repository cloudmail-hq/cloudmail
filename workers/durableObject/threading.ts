// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * SQL for the conversation-grouped ("threaded") message list.
 *
 * This lives outside the Durable Object on purpose. The queries are the most
 * intricate SQL in the codebase — six chained CTEs, window functions, and a
 * list query that must group *identically* to its own count query or the pager
 * offers pages the list cannot fill. While the text was embedded in private
 * methods on `MailboxDO` there was no way to execute it in a test without
 * standing up a whole workerd runtime, so it was only ever exercised by hand.
 *
 * As plain functions returning SQL strings, the same text can be run against a
 * real SQLite database in `test/threading.test.ts`. The list/count pairs below
 * share their grouping CTEs through `conversationCtes` for the same reason: the
 * duplication used to be two copy-pasted blocks that could drift silently.
 *
 * Every function here is a pure string builder. No caller-supplied value is
 * interpolated — filters and sort keys are resolved through allow-lists, and
 * the folder is always bound as parameter `?1`.
 */

import { Folders } from "../../shared/folders";
import { engagementColumnsSql } from "./engagement";

/**
 * Normalize a subject for conversation grouping by stripping reply/forward
 * prefixes (Re:, Fwd:, FW:, AW:, WG:, Réf:, SV:). Hardcoded to the `subject`
 * column, so it can only be used where that column is in scope.
 */
export const NORMALIZED_SUBJECT_SQL = `LOWER(TRIM(
	REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
		LOWER(subject),
		'aw: ', ''), 'wg: ', ''), 'réf: ', ''), 'sv: ', ''),
		're: ', ''), 'fwd: ', ''), 'fw: ', '')
))`;

export const ALLOWED_SORT_COLUMNS = [
	"id",
	"subject",
	"sender",
	"recipient",
	"date",
	"read",
	"starred",
] as const;

export type SortColumn = (typeof ALLOWED_SORT_COLUMNS)[number];

/**
 * List filters shared by the flat and threaded list queries.
 *
 * All three are opt-in: `undefined` means "don't filter", and only `true`
 * narrows. There is deliberately no `read: false` form — the UI offers
 * "Unread" as a toggle, not a tri-state, and an explicit `false` would read as
 * "only read mail", which nothing asks for.
 *
 * In threaded mode these apply to the *conversation*, not the individual
 * message: a thread matches `unread` when any of its messages in the folder is
 * unread. Filtering the underlying rows instead would change which message is
 * "latest" and make the thread counts disagree with the row representing them.
 */
export interface ListFilterOptions {
	unread?: boolean;
	starred?: boolean;
	has_attachment?: boolean;
}

/**
 * Whether a message has a real attachment.
 *
 * Inline parts are excluded everywhere this appears: a `cid:` image embedded in
 * the body is not an attachment to the person who ticked "Has attachment", and
 * the list's paperclip indicator uses the same rule.
 */
export function hasAttachmentSql(emailIdExpr: string): string {
	return `EXISTS (SELECT 1 FROM attachments a WHERE a.email_id = ${emailIdExpr} AND (a.disposition IS NULL OR a.disposition != 'inline'))`;
}

/**
 * SQL literal for a system folder id.
 *
 * `emails.folder_id` stores the canonical lowercase id — the same value
 * `shared/folders.ts` exports — so a system folder can be compared directly and
 * no lookup is needed.
 *
 * This exists because the obvious-looking
 * `(SELECT id FROM folders WHERE name = 'draft')` is *always NULL*: the seeded
 * rows are `('draft', 'Drafts')`, so the id is lowercase and the name is
 * capitalised for display. Comparing a folder_id against that subquery matched
 * nothing and failed silently — which is why the list's "Draft" chip never
 * appeared, `needs_reply` was never set, and the Trash/Spam exclusions did not
 * exclude anything.
 *
 * Only ever called with a `Folders` constant, never with request input.
 */
export function folderIdLiteral(folderId: string): string {
	if (!/^[a-z]+$/.test(folderId)) {
		// A guard, not validation: the only callers pass Folders constants, and
		// this keeps it that way if someone reaches for a dynamic value later.
		throw new Error(`folderIdLiteral: unexpected folder id "${folderId}"`);
	}
	return `'${folderId}'`;
}

/** The two folders where a message is there because someone got rid of it. */
const TERMINAL_FOLDER_LITERALS = `${folderIdLiteral(Folders.TRASH)}, ${folderIdLiteral(Folders.SPAM)}`;

/**
 * Which messages of a conversation belong in the view being rendered.
 *
 * A conversation spans folders, so "how big is this thread" and "which of its
 * messages do I show" both need a rule, and the two have to be the same rule or
 * the count disagrees with what expanding the thread reveals.
 *
 * The rule mirrors what every mail client does:
 *
 *   - **In Trash or Spam, show only what is in that folder.** A conversation
 *     appearing in Trash is not a conversation that was trashed; it is a
 *     conversation with a trashed message in it.
 *   - **Everywhere else, show everything except Trash and Spam.** An Inbox row
 *     should report the whole exchange including the replies in Sent, which is
 *     what the count next to a subject means — but not the parts someone deleted.
 *
 * ## What this fixes
 *
 * The previous clause was `folder_id NOT IN (trash, spam) OR folder_id = ?1`.
 * Listing Trash makes `?1` Trash, and the disjunction then admits every row in
 * the conversation, so deleting a single draft out of a five-message thread
 * produced a Trash row reading "5 messages" — and `getThreadEmails`, which had no
 * folder filter at all, rendered all five inside the Trash pane. Nothing had been
 * trashed but the draft; the product simply asserted otherwise, twice, while the
 * other four messages sat in the Inbox as well. It read exactly like a delete
 * that had taken the conversation with it.
 *
 * Note this only changes terminal-folder views. For any other folder the old
 * disjunction was already redundant — `?1` is not Trash or Spam, so the left side
 * subsumed the right.
 *
 * `folderParam` is the placeholder holding the folder being viewed, matched by
 * name or id the way the rest of these queries do it. `column` lets a caller
 * qualify the column when several tables are in scope.
 */
export function conversationScopeSql(
	folderParam: string,
	column = "folder_id",
): string {
	const viewed = `(SELECT id FROM folders WHERE name = ${folderParam} OR id = ${folderParam} LIMIT 1)`;
	return `(
				CASE WHEN ${viewed} IN (${TERMINAL_FOLDER_LITERALS})
					THEN ${column} = ${viewed}
					ELSE ${column} NOT IN (${TERMINAL_FOLDER_LITERALS})
				END
			)`;
}

/**
 * The messages of one conversation, for the reading pane.
 *
 * Lives here rather than inline in `MailboxDO.getThreadEmails` so it shares
 * `conversationScopeSql` with the list's `conversation_stats` — the count on a row
 * and the messages behind it have to agree — and so it is testable against real
 * SQLite without standing up a Durable Object.
 *
 * Binds `?1` thread, `?2` limit, and `?3` the folder being viewed when `scoped`.
 * Unscoped keeps the whole conversation, for callers with no view to narrow to
 * (the people-centric panel, and API consumers).
 *
 * Ordered newest-first for the limit so a long conversation keeps its most recent
 * messages, then re-sorted ascending for reading order.
 */
export function threadMessagesSql(scoped: boolean): string {
	return `SELECT * FROM (
				SELECT * FROM emails
				 WHERE thread_id = ?1
				 ${scoped ? `AND ${conversationScopeSql("?3")}` : ""}
				 ORDER BY date DESC, id DESC
				 LIMIT ?2
			) ORDER BY date ASC, id ASC`;
}

/**
 * ORDER BY clause for the threaded queries.
 *
 * The threaded SQL is hand-written, so the column cannot be a Drizzle
 * reference — it is resolved through an allow-list here instead, and the
 * direction is narrowed to two literals. Nothing from the request reaches the
 * query string.
 */
export function threadedOrderBy(
	alias: string,
	sortColumn: SortColumn | undefined,
	sortDirection: "ASC" | "DESC" | undefined,
): string {
	const column = ALLOWED_SORT_COLUMNS.includes(sortColumn as SortColumn)
		? (sortColumn as SortColumn)
		: "date";
	const direction = sortDirection === "ASC" ? "ASC" : "DESC";
	// `date` stays the tiebreaker for every other key so equal values order
	// identically on every call — an unstable order makes a conversation appear
	// on two pages while another is never returned at all.
	const tiebreak = column === "date" ? "" : `, ${alias}.date DESC`;
	return `ORDER BY ${alias}.${column} ${direction}${tiebreak}`;
}

/**
 * Filter clause for the threaded queries, applied to per-conversation stats
 * rather than to individual messages.
 *
 * Returns a fragment beginning with `AND`, or the empty string. Takes no
 * parameters, so callers can append it without renumbering their own.
 */
export function threadedFilterClause(
	filters: ListFilterOptions,
	alias: string,
): string {
	const clauses: string[] = [];
	if (filters.unread) clauses.push(`${alias}.thread_unread_count > 0`);
	if (filters.starred) clauses.push(`${alias}.thread_starred_count > 0`);
	if (filters.has_attachment) {
		clauses.push(`${alias}.thread_attachment_count > 0`);
	}
	return clauses.length > 0 ? `AND ${clauses.join(" AND ")}` : "";
}

/** Bare SQL conditions for the flat list filters, for the non-threaded count. */
export function flatFilterConditions(filters: ListFilterOptions): string[] {
	const conditions: string[] = [];
	if (filters.unread) conditions.push("read = 0");
	if (filters.starred) conditions.push("starred = 1");
	if (filters.has_attachment) conditions.push(hasAttachmentSql("emails.id"));
	return conditions;
}

/**
 * The grouping CTEs shared by the threaded list and its count.
 *
 * Emitted as one string so the two queries cannot drift. `columns` controls
 * what `folder_emails` selects: the list needs whole rows (it returns the
 * latest message per conversation), the count only needs the few columns the
 * grouping and filtering touch.
 *
 * Binds `?1` as the folder, matched by name or id.
 */
function conversationCtes(columns: string): string {
	return `
			folder_emails AS (
				SELECT ${columns},
					COALESCE(thread_id, id) as raw_thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
				FROM emails
				WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
			),
			-- Exactly one row per raw_thread_id. This is load-bearing: the CTEs
			-- below LEFT JOIN on raw_thread_id, so a thread appearing more than
			-- once here fans every one of its messages out into several
			-- conversation partitions, and each copy then survives the rn = 1
			-- filter — the same mail rendered once per phantom thread.
			thread_meta AS (
				SELECT
					raw_thread_id,
					MAX(CASE WHEN thread_id IS NOT NULL THEN 1 ELSE 0 END) as has_thread_id,
					MIN(normalized_subject) as normalized_subject
				FROM folder_emails
				GROUP BY raw_thread_id
			),
			-- Subject fallback for legacy rows with no threading headers: pin them
			-- to one representative thread per subject, preferring a thread that
			-- does have real headers so the legacy rows join the real conversation.
			subject_anchor AS (
				SELECT normalized_subject, raw_thread_id as anchor_id
				FROM (
					SELECT
						normalized_subject,
						raw_thread_id,
						ROW_NUMBER() OVER (
							PARTITION BY normalized_subject
							ORDER BY has_thread_id DESC, raw_thread_id
						) as srn
					FROM thread_meta
					WHERE normalized_subject != ''
				)
				WHERE srn = 1
			),
			thread_to_conversation AS (
				SELECT
					tm.raw_thread_id,
					CASE
						-- Real threading headers are authoritative: never merge two
						-- header-threaded conversations just because subjects match.
						WHEN tm.has_thread_id = 1 THEN tm.raw_thread_id
						WHEN tm.normalized_subject != ''
							THEN COALESCE(sa.anchor_id, tm.raw_thread_id)
						ELSE tm.raw_thread_id
					END as conversation_id
				FROM thread_meta tm
				LEFT JOIN subject_anchor sa
					ON sa.normalized_subject = tm.normalized_subject
			),
			-- Stats used for *filtering*, computed from this folder's rows only.
			-- Kept separate from conversation_stats, which spans folders to report
			-- conversation size: "Unread" has to mean "unread in the folder I am
			-- looking at", or ticking it in Inbox would surface threads whose only
			-- unread message sits in Archive.
			conversation_filter_stats AS (
				SELECT
					COALESCE(tc.conversation_id, fe.raw_thread_id) as conversation_id,
					SUM(CASE WHEN fe.read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
					SUM(CASE WHEN fe.starred = 1 THEN 1 ELSE 0 END) as thread_starred_count,
					SUM(CASE WHEN ${hasAttachmentSql("fe.id")} THEN 1 ELSE 0 END) as thread_attachment_count
				FROM folder_emails fe
				LEFT JOIN thread_to_conversation tc
					ON fe.raw_thread_id = tc.raw_thread_id
				GROUP BY COALESCE(tc.conversation_id, fe.raw_thread_id)
			)`;
}

/**
 * The threaded list: one row per conversation, carrying the latest message in
 * the folder plus aggregates for the whole conversation.
 *
 * Binds `?1` folder, `?2` limit, `?3` offset.
 */
export function threadedListSql(
	filters: ListFilterOptions,
	sortColumn: SortColumn | undefined,
	sortDirection: "ASC" | "DESC" | undefined,
): string {
	return `${threadedListBody(filters)}
			${threadedOrderBy("lif", sortColumn, sortDirection)}
			LIMIT ?2 OFFSET ?3`;
}

/**
 * The threaded list for the unified inbox: newest first, resuming strictly
 * after a (date, id) high-water mark rather than at an offset.
 *
 * Keyset rather than offset because the caller merges several mailboxes: an
 * offset into one mailbox means nothing once its rows are interleaved with
 * another's. (date DESC, id DESC) is a total order, so ties on date are split
 * by id the same way on every call and no row is skipped or repeated.
 *
 * Binds `?1` folder, `?2` limit, `?3` mark date (NULL for the first page),
 * `?4` mark id.
 */
export function unifiedListSql(filters: ListFilterOptions): string {
	return `SELECT * FROM (${threadedListBody(filters)}) page
			WHERE ?3 IS NULL OR COALESCE(page.date, '') < ?3 OR (COALESCE(page.date, '') = ?3 AND page.id < ?4)
			ORDER BY COALESCE(page.date, '') DESC, page.id DESC
			LIMIT ?2`;
}

/** The threaded list without ORDER BY or LIMIT. Binds `?1` folder. */
function threadedListBody(filters: ListFilterOptions): string {
	return `WITH ${conversationCtes("*")},
			all_emails_with_conversation AS (
				SELECT
					e.*,
					COALESCE(tc.conversation_id, COALESCE(e.thread_id, e.id)) as conversation_id
				FROM emails e
				LEFT JOIN thread_to_conversation tc
					ON COALESCE(e.thread_id, e.id) = tc.raw_thread_id
			),
			-- Per-conversation aggregates, deliberately spanning folders so an
			-- Inbox row reports the size of the whole conversation including the
			-- replies sitting in Sent — that is what the count next to a subject
			-- means in every mail client.
			--
			-- Trash and Spam are the exception: counting them produced phantom
			-- unread dots on Inbox rows (a deleted message stayed unread forever)
			-- and thread counts that disagreed with what expanding the thread
			-- showed. They are excluded unless they are the folder being listed,
			-- so opening Trash still reports sensible numbers.
			conversation_stats AS (
				SELECT
					conversation_id,
					COUNT(*) as thread_count,
					-- Drafts are excluded from the unread tally. A draft row is stored
					-- unread, so a thread you had started replying to rendered an
					-- unread dot and a bold subject forever: your own unsent work is
					-- not unread mail. It still contributes to thread_count, and the
					-- separate has_draft flag is what surfaces it.
					SUM(CASE WHEN read = 0 AND folder_id != ${folderIdLiteral(Folders.DRAFT)} THEN 1 ELSE 0 END) as thread_unread_count,
					SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END) as thread_read_count,
					SUM(CASE WHEN ${hasAttachmentSql("all_emails_with_conversation.id")} THEN 1 ELSE 0 END) as thread_attachment_count,
					GROUP_CONCAT(DISTINCT sender) as participants,
					-- Display names alongside, as a JSON object of address → name, so
					-- the row can say "Priya Sharma" instead of a title-cased local
					-- part. JSON because a display name may contain any character,
					-- commas included. A repeated key is harmless: JSON.parse keeps the
					-- last. Rows without a name contribute nothing.
					json_group_object(
						COALESCE(sender, ''),
						sender_name
					) FILTER (WHERE sender_name IS NOT NULL AND sender_name != '') as participant_names,
					SUM(CASE WHEN folder_id = ${folderIdLiteral(Folders.DRAFT)} THEN 1 ELSE 0 END) as has_draft
				FROM all_emails_with_conversation
				WHERE conversation_id IN (
					SELECT DISTINCT conversation_id FROM all_emails_with_conversation
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				)
				AND ${conversationScopeSql("?1")}
				GROUP BY conversation_id
			),
			latest_message_per_conversation AS (
				SELECT
					conversation_id,
					folder_id,
					ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY date DESC) as rn
				FROM all_emails_with_conversation
			),
			latest_in_folder AS (
				SELECT
					fe.*,
					COALESCE(tc.conversation_id, fe.raw_thread_id) as conversation_id,
					ROW_NUMBER() OVER (
						PARTITION BY COALESCE(tc.conversation_id, fe.raw_thread_id)
						ORDER BY fe.date DESC
					) as rn
				FROM folder_emails fe
				LEFT JOIN thread_to_conversation tc
					ON fe.raw_thread_id = tc.raw_thread_id
			)
			SELECT
				lif.id, lif.subject, lif.sender, lif.recipient, lif.date,
				lif.read, lif.starred, lif.thread_id, lif.folder_id,
				lif.in_reply_to, lif.email_references,
				lif.delivery_status, lif.delivery_error,
				${engagementColumnsSql("lif")},
				COALESCE(lif.snippet, SUBSTR(lif.body, 1, 300)) as snippet, lif.sender_name, lif.security_warnings,
				cs.thread_count, cs.thread_unread_count, cs.participants,
				cs.participant_names,
				CASE WHEN lmc.folder_id != ${folderIdLiteral(Folders.SENT)}
					AND lmc.folder_id != ${folderIdLiteral(Folders.DRAFT)}
					AND cs.thread_read_count > 0
					THEN 1 ELSE 0 END as needs_reply,
				CASE WHEN cs.has_draft > 0 THEN 1 ELSE 0 END as has_draft,
				CASE WHEN cs.thread_attachment_count > 0 THEN 1 ELSE 0 END as has_attachment
			FROM latest_in_folder lif
			JOIN conversation_stats cs ON lif.conversation_id = cs.conversation_id
			JOIN conversation_filter_stats cfs ON lif.conversation_id = cfs.conversation_id
			LEFT JOIN latest_message_per_conversation lmc
				ON lmc.conversation_id = lif.conversation_id AND lmc.rn = 1
			WHERE lif.rn = 1 ${threadedFilterClause(filters, "cfs")}`;
}

/**
 * Count of conversations the threaded list would return.
 *
 * Shares `conversationCtes` with `threadedListSql`, so the grouping and the
 * filter can only ever agree. Binds `?1` folder.
 */
export function threadedCountSql(filters: ListFilterOptions): string {
	return `WITH ${conversationCtes("id, read, starred, thread_id, subject")}
			SELECT COUNT(*) as total
			FROM conversation_filter_stats cfs
			WHERE 1 = 1 ${threadedFilterClause(filters, "cfs")}`;
}

/**
 * Drafts do not group at all. One row per draft.
 *
 * ## Why the grouping went
 *
 * The key used to be `COALESCE(in_reply_to, id)`, chosen so that reply-drafts
 * aimed at different messages stayed separate even when they shared a thread_id
 * or a subject — grouping drafts *by thread* would have collapsed two unrelated
 * replies-in-progress into one row and hidden one of them.
 *
 * That reasoning was right about the failure mode and did not go far enough. Two
 * drafts replying to the *same* parent share `in_reply_to`, so they landed in one
 * group and the list showed only the newer: the older was unreachable, and
 * deleting the visible one made the row reappear showing its sibling, which reads
 * exactly like a delete that did not work. Multiple drafts against one parent is
 * not unusual — two tabs, or the agent's `draft_reply` running twice.
 *
 * There is nothing to group in the first place. A conversation is a sequence of
 * messages that were sent; a draft is one message that was not. Grouping them
 * could only ever hide one, and every consumer of a Drafts row — Send, Edit,
 * Discard — acts on exactly one message.
 *
 * So the stats are per-row, and `thread_count` is always 1. The column stays for
 * the shape the list contract expects; the list renders no count badge for 1.
 *
 * Binds `?1` as the folder.
 */
function draftCtes(columns: string): string {
	return `
			folder_emails AS (
				SELECT ${columns}
				FROM emails
				WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
			),
			draft_stats AS (
				SELECT
					id as draft_id,
					1 as thread_count,
					CASE WHEN read = 0 THEN 1 ELSE 0 END as thread_unread_count,
					CASE WHEN starred = 1 THEN 1 ELSE 0 END as thread_starred_count,
					CASE WHEN ${hasAttachmentSql("folder_emails.id")} THEN 1 ELSE 0 END as thread_attachment_count,
					sender as participants
				FROM folder_emails
			)`;
}

/**
 * The Drafts list: one row per draft. Binds `?1` folder, `?2` limit, `?3` offset.
 *
 * No window function, because there is no longer a group to pick a representative
 * from — which is the point. A row's id is the draft, so acting on it acts on what
 * the user is looking at.
 */
export function draftListSql(
	filters: ListFilterOptions,
	sortColumn: SortColumn | undefined,
	sortDirection: "ASC" | "DESC" | undefined,
): string {
	return `WITH ${draftCtes("*")}
			SELECT
				fe.id, fe.subject, fe.sender, fe.recipient, fe.date,
				fe.read, fe.starred, fe.thread_id, fe.folder_id,
				fe.in_reply_to, fe.email_references,
				fe.delivery_status, fe.delivery_error,
				${engagementColumnsSql("fe")},
				COALESCE(fe.snippet, SUBSTR(fe.body, 1, 300)) as snippet, fe.sender_name, fe.security_warnings,
				ds.thread_count, ds.thread_unread_count, ds.participants,
				CASE WHEN ds.thread_attachment_count > 0 THEN 1 ELSE 0 END as has_attachment
			FROM folder_emails fe
			JOIN draft_stats ds ON ds.draft_id = fe.id
			WHERE 1 = 1 ${threadedFilterClause(filters, "ds")}
			${threadedOrderBy("fe", sortColumn, sortDirection)}
			LIMIT ?2 OFFSET ?3`;
}

/**
 * Count of drafts the list would return.
 *
 * Shares `draftCtes` with `draftListSql` so the two cannot disagree about which
 * rows the filters admit — a mismatch here shows up as an empty last page.
 * Binds `?1` folder.
 */
export function draftCountSql(filters: ListFilterOptions): string {
	return `WITH ${draftCtes("id, read, starred, date, sender, in_reply_to")}
			SELECT COUNT(*) as total
			FROM draft_stats ds
			WHERE 1 = 1 ${threadedFilterClause(filters, "ds")}`;
}
