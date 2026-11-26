/**
 * The demo's mail, held in memory.
 *
 * It starts from the recorded snapshot (app/demo/data/snapshot.json) and
 * applies the visitor's changes to plain objects. Nothing is written to
 * browser storage and nothing is sent anywhere, so a reload starts again from
 * the snapshot.
 *
 * The rules here follow the server's (workers/durableObject): what a threaded
 * list row is, which folders a conversation spans, what delete, restore, move
 * and snooze do. They are kept in one file so they can be tested without a
 * browser (test/demo-store.test.ts).
 */

import { includesEverywhere, parseSearchQuery, type SearchNode } from "../../shared/search-query";
import { revive } from "./time";

export type Row = Record<string, any>;

export interface DemoSnapshot {
	owner: string;
	mailboxOrder: string[];
	fixed: Record<string, unknown>;
	boxes: Record<string, Row>;
}

export interface Folder {
	id: string;
	name: string;
}

export interface Summary {
	thread_id: string;
	line: string | null;
	bullets: string[] | null;
	message_count: number;
	status: "ok" | "blocked" | "skipped";
	generated_at: string;
	stale: boolean;
}

interface Box {
	id: string;
	mailbox: Row;
	folders: Folder[];
	labels: Row[];
	emails: Map<string, Row>;
	/** email id -> label id -> who applied it. */
	emailLabels: Map<string, Map<string, "ai" | "user">>;
	summaries: Map<string, Summary>;
	muted: Set<string>;
	deliveryEvents: Record<string, Row[]>;
	followups: Record<string, Row>;
	/** Scheduled time per queued message. */
	sendAt: Map<string, string>;
	extra: Record<string, any>;
	version: number;
}

export class DemoError extends Error {
	constructor(
		public status: number,
		message: string,
		public code?: string,
	) {
		super(message);
	}
}

const TERMINAL = new Set(["trash", "spam"]);
const SYSTEM_FOLDERS = new Set(["inbox", "sent", "draft", "archive", "trash", "spam", "snoozed", "scheduled", "screener"]);
/** Folders mail cannot be moved into by hand. */
const NOT_A_TARGET = new Set(["draft", "scheduled", "snoozed", "screener"]);
const HEAVY = new Set(["body", "raw_headers", "attachments", "warnings"]);
const HIT_OPEN = "\u0011";
const HIT_CLOSE = "\u0012";

const lower = (v: unknown) => String(v ?? "").toLowerCase();
const byDateDesc = (a: Row, b: Row) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1);
const byDateAsc = (a: Row, b: Row) => -byDateDesc(a, b);
const conversationOf = (e: Row): string => e.thread_id ?? e.id;

export function htmlToText(html: string): string {
	return String(html ?? "")
		.replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

let counter = 0;
/** Ids for rows made in the page. Not secret, only unique within the page. */
export function demoId(prefix = "demo"): string {
	counter += 1;
	return `${prefix}-${counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export class DemoStore {
	readonly owner: string;
	readonly order: string[];
	readonly fixed: Record<string, any>;
	private boxes = new Map<string, Box>();
	private text = new Map<string, string>();

	constructor(snapshot: DemoSnapshot, private clock: () => number = Date.now) {
		const data = revive<DemoSnapshot>(snapshot, clock());
		this.owner = data.owner;
		this.order = data.mailboxOrder;
		this.fixed = data.fixed;
		for (const id of data.mailboxOrder) {
			const b = data.boxes[id];
			const emailLabels = new Map<string, Map<string, "ai" | "user">>();
			for (const [emailId, labels] of Object.entries<Row[]>(b.emailLabels ?? {})) {
				emailLabels.set(emailId, new Map(labels.map((l) => [l.id, l.source === "ai" ? "ai" : "user"])));
			}
			this.boxes.set(id.toLowerCase(), {
				id,
				mailbox: b.mailbox,
				folders: b.folders,
				labels: b.labels,
				emails: new Map((b.emails as Row[]).map((e) => [e.id, e])),
				emailLabels,
				summaries: new Map(Object.entries<Summary>(b.summaries ?? {})),
				muted: new Set<string>(b.extra?.["muted-threads"] ?? []),
				deliveryEvents: b.deliveryEvents ?? {},
				followups: b.followups ?? {},
				sendAt: new Map((b.extra?.["scheduled-sends"] ?? []).map((s: Row) => [s.email_id, s.send_at])),
				extra: b.extra ?? {},
				version: 1,
			});
		}
	}

	now(): string {
		return new Date(this.clock()).toISOString();
	}

	box(mailboxId: string): Box {
		const box = this.boxes.get(mailboxId.toLowerCase());
		if (!box) throw new DemoError(404, "Mailbox not found");
		return box;
	}

	has(mailboxId: string): boolean {
		return this.boxes.has(mailboxId.toLowerCase());
	}

	mailboxes(withSettings = false): Row[] {
		return this.order.map((id) => {
			const { settings, ...rest } = this.box(id).mailbox;
			return withSettings ? { ...rest, settings } : rest;
		});
	}

	private touch(box: Box) {
		box.version += 1;
	}

	private email(box: Box, id: string): Row {
		const e = box.emails.get(id);
		if (!e) throw new DemoError(404, "Email not found");
		return e;
	}

	private bodyText(e: Row): string {
		const key = `${e.id}:${e.body?.length ?? 0}`;
		let t = this.text.get(key);
		if (t === undefined) {
			t = htmlToText(e.body ?? "");
			this.text.set(key, t);
		}
		return t;
	}

	// ── rows ────────────────────────────────────────────────────────

	/** A list row: every column except the heavy ones the reader loads on open. */
	private listRow(box: Box, e: Row): Row {
		const row: Row = {};
		for (const [k, v] of Object.entries(e)) if (!HEAVY.has(k)) row[k] = v;
		row.has_attachment = (e.attachments?.length ?? 0) > 0;
		const summary = box.summaries.get(conversationOf(e));
		if (summary?.status === "ok" && summary.line) row.summary_line = summary.line;
		return row;
	}

	/** Which messages count as part of a conversation when `folder` is on screen. */
	private inScope(folder: string, e: Row): boolean {
		return TERMINAL.has(folder) ? e.folder_id === folder : !TERMINAL.has(e.folder_id);
	}

	private conversationStats(box: Box, folder: string, conversation: string) {
		const all = [...box.emails.values()].filter((e) => conversationOf(e) === conversation);
		const scoped = all.filter((e) => this.inScope(folder, e)).sort(byDateAsc);
		const names: Record<string, string> = {};
		const participants: string[] = [];
		for (const e of scoped) {
			if (!participants.includes(e.sender)) participants.push(e.sender);
			if (e.sender_name && !names[e.sender]) names[e.sender] = e.sender_name;
		}
		const latest = [...all].sort(byDateDesc)[0];
		return {
			thread_count: scoped.length,
			thread_unread_count: scoped.filter((e) => !e.read && e.folder_id !== "draft").length,
			participants: participants.join(","),
			participant_names: names,
			needs_reply: !!latest && latest.folder_id !== "sent" && latest.folder_id !== "draft" && scoped.some((e) => e.read),
			has_draft: scoped.some((e) => e.folder_id === "draft"),
			has_attachment: scoped.some((e) => (e.attachments?.length ?? 0) > 0),
		};
	}

	private threadedRows(box: Box, folder: string, filters: ListFilters = {}): Row[] {
		const inFolder = [...box.emails.values()].filter((e) => e.folder_id === folder);
		if (folder === "draft") {
			// One row per draft: two replies to the same thread are two drafts.
			return inFolder
				.filter((e) => passes(e, filters))
				.map((e) => ({
					...this.listRow(box, e),
					thread_count: 1,
					thread_unread_count: e.read ? 0 : 1,
					participants: e.sender,
					needs_reply: false,
					has_draft: false,
				}));
		}
		const groups = new Map<string, Row[]>();
		for (const e of inFolder) {
			const key = conversationOf(e);
			const list = groups.get(key);
			if (list) list.push(e);
			else groups.set(key, [e]);
		}
		const rows: Row[] = [];
		for (const [conversation, list] of groups) {
			// Filters look at this folder's messages only, as the server's do.
			if (filters.unread && !list.some((e) => !e.read)) continue;
			if (filters.starred && !list.some((e) => e.starred)) continue;
			if (filters.has_attachment && !list.some((e) => (e.attachments?.length ?? 0) > 0)) continue;
			const latest = [...list].sort(byDateDesc)[0];
			rows.push({ ...this.listRow(box, latest), ...this.conversationStats(box, folder, conversation) });
		}
		return rows;
	}

	listEmails(mailboxId: string, q: ListQuery): { emails: Row[]; totalCount: number } | Row[] {
		const box = this.box(mailboxId);
		const filters: ListFilters = { unread: q.unread, starred: q.starred, has_attachment: q.has_attachment };
		if (!q.folder) {
			return [...box.emails.values()].sort(byDateDesc).slice(0, clampLimit(q.limit)).map((e) => this.listRow(box, e));
		}
		const folder = this.folderId(box, q.folder);
		const rows = q.threaded
			? this.threadedRows(box, folder, filters)
			: [...box.emails.values()].filter((e) => e.folder_id === folder && passes(e, filters)).map((e) => this.listRow(box, e));
		sortRows(rows, q.sortColumn, q.sortDirection);
		return { emails: paginate(rows, q.page, q.limit), totalCount: rows.length };
	}

	getEmail(mailboxId: string, id: string): Row {
		return this.email(this.box(mailboxId), id);
	}

	getThread(mailboxId: string, threadId: string, folder?: string): Row[] {
		const box = this.box(mailboxId);
		const viewed = folder ? this.folderId(box, folder) : "inbox";
		return [...box.emails.values()]
			.filter((e) => conversationOf(e) === threadId && this.inScope(viewed, e))
			.sort(byDateAsc);
	}

	// ── folders and labels ──────────────────────────────────────────

	private folderId(box: Box, idOrName: string): string {
		const wanted = lower(idOrName);
		return box.folders.find((f) => lower(f.id) === wanted || lower(f.name) === wanted)?.id ?? idOrName;
	}

	listFolders(mailboxId: string): Row[] {
		const box = this.box(mailboxId);
		const emails = [...box.emails.values()];
		return box.folders.map((f) => {
			const mine = emails.filter((e) => e.folder_id === f.id);
			return { id: f.id, name: f.name, unreadCount: mine.filter((e) => !e.read).length, totalCount: mine.length };
		});
	}

	createFolder(mailboxId: string, name: string): Row {
		const box = this.box(mailboxId);
		const id = lower(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
		if (!id) throw new DemoError(400, "Folder name must contain alphanumeric characters");
		if (box.folders.some((f) => f.id === id || lower(f.name) === lower(name))) {
			throw new DemoError(409, "Folder with this name already exists");
		}
		box.folders.push({ id, name: name.trim() });
		this.touch(box);
		return { id, name: name.trim(), unreadCount: 0, totalCount: 0 };
	}

	renameFolder(mailboxId: string, id: string, name: string): Row {
		const box = this.box(mailboxId);
		const folder = box.folders.find((f) => f.id === id);
		if (!folder || SYSTEM_FOLDERS.has(id)) throw new DemoError(404, "Folder not found");
		folder.name = name.trim() || folder.name;
		this.touch(box);
		return this.listFolders(mailboxId).find((f) => f.id === id)!;
	}

	deleteFolder(mailboxId: string, id: string): Row {
		const box = this.box(mailboxId);
		if (!box.folders.some((f) => f.id === id)) throw new DemoError(404, "Folder not found");
		if (SYSTEM_FOLDERS.has(id)) throw new DemoError(400, "That folder cannot be deleted");
		// Mail in a deleted folder goes back to the inbox, never away.
		let relocated = 0;
		for (const e of box.emails.values()) {
			if (e.folder_id !== id) continue;
			e.folder_id = "inbox";
			relocated += 1;
		}
		box.folders = box.folders.filter((f) => f.id !== id);
		this.touch(box);
		return { status: "deleted", relocated, movedTo: "inbox" };
	}

	listLabels(mailboxId: string): Row[] {
		const box = this.box(mailboxId);
		return box.labels.map((l) => {
			const mine = this.labelled(box, l.id);
			return { ...l, email_count: mine.length, unread_count: mine.filter((e) => !e.read).length };
		});
	}

	private labelled(box: Box, labelId: string): Row[] {
		const out: Row[] = [];
		for (const [emailId, labels] of box.emailLabels) {
			if (!labels.has(labelId)) continue;
			const e = box.emails.get(emailId);
			if (e && !TERMINAL.has(e.folder_id)) out.push(e);
		}
		return out;
	}

	createLabel(mailboxId: string, input: Row): Row {
		const box = this.box(mailboxId);
		const name = String(input.name ?? "").trim();
		if (!name) throw new DemoError(400, "A label needs a name");
		if (box.labels.some((l) => lower(l.name) === lower(name))) throw new DemoError(409, "A label with this name already exists");
		const label = {
			id: demoId("label"),
			name,
			color: input.color ?? "#64748b",
			parent_id: input.parent_id ?? null,
			sort_order: box.labels.length,
			prompt: null,
			auto_archive: false,
			show_tab: false,
		};
		box.labels.push(label);
		this.touch(box);
		return { ...label, email_count: 0, unread_count: 0 };
	}

	updateLabel(mailboxId: string, id: string, patch: Row): Row {
		const box = this.box(mailboxId);
		const label = box.labels.find((l) => l.id === id);
		if (!label) throw new DemoError(404, "Label not found");
		for (const key of ["name", "color", "parent_id", "sort_order", "auto_archive", "show_tab"]) {
			if (patch[key] !== undefined) label[key] = patch[key];
		}
		this.touch(box);
		return this.listLabels(mailboxId).find((l) => l.id === id)!;
	}

	deleteLabel(mailboxId: string, id: string): void {
		const box = this.box(mailboxId);
		box.labels = box.labels.filter((l) => l.id !== id);
		for (const labels of box.emailLabels.values()) labels.delete(id);
		this.touch(box);
	}

	labelEmails(mailboxId: string, labelId: string, q: ListQuery): { emails: Row[]; totalCount: number } {
		const box = this.box(mailboxId);
		const rows = this.labelled(box, labelId).map((e) => this.listRow(box, e));
		sortRows(rows, q.sortColumn, q.sortDirection);
		return { emails: paginate(rows, q.page, q.limit), totalCount: rows.length };
	}

	emailLabels(mailboxId: string, emailId: string): Row[] {
		const box = this.box(mailboxId);
		const mine = box.emailLabels.get(emailId);
		if (!mine) return [];
		return box.labels
			.filter((l) => mine.has(l.id))
			.map((l) => ({ id: l.id, name: l.name, color: l.color, source: mine.get(l.id) }));
	}

	setEmailLabels(mailboxId: string, emailId: string, labelIds: string[]): Row[] {
		const box = this.box(mailboxId);
		this.email(box, emailId);
		const before = box.emailLabels.get(emailId) ?? new Map<string, "ai" | "user">();
		const next = new Map<string, "ai" | "user">();
		for (const id of labelIds) {
			if (box.labels.some((l) => l.id === id)) next.set(id, before.get(id) ?? "user");
		}
		box.emailLabels.set(emailId, next);
		this.touch(box);
		return this.emailLabels(mailboxId, emailId);
	}

	// ── changes to messages ─────────────────────────────────────────

	updateEmail(mailboxId: string, id: string, patch: { read?: boolean; starred?: boolean }): Row {
		const box = this.box(mailboxId);
		const e = this.email(box, id);
		if (typeof patch.read === "boolean") e.read = patch.read;
		if (typeof patch.starred === "boolean") e.starred = patch.starred;
		this.touch(box);
		return e;
	}

	private toTrash(e: Row) {
		e.trashed_from = e.folder_id;
		e.trashed_at = this.now();
		e.folder_id = "trash";
		e.snoozed_until = null;
		e.snooze_return_folder = null;
	}

	private destroy(box: Box, id: string) {
		box.emails.delete(id);
		box.emailLabels.delete(id);
		box.sendAt.delete(id);
	}

	/** Trash first. Only mail already in Trash or Spam, or `permanent`, is destroyed. */
	deleteEmail(mailboxId: string, id: string, permanent = false): "trashed" | "deleted" {
		const box = this.box(mailboxId);
		const e = this.email(box, id);
		this.touch(box);
		if (permanent || TERMINAL.has(e.folder_id)) {
			this.destroy(box, id);
			return "deleted";
		}
		this.toTrash(e);
		return "trashed";
	}

	restoreEmail(mailboxId: string, id: string): void {
		const box = this.box(mailboxId);
		const e = this.email(box, id);
		if (e.folder_id !== "trash") throw new DemoError(404, "Not in Trash");
		const back = e.trashed_from && box.folders.some((f) => f.id === e.trashed_from) ? e.trashed_from : "inbox";
		e.folder_id = back;
		e.trashed_from = null;
		e.trashed_at = null;
		this.touch(box);
	}

	emptyTrash(mailboxId: string): number {
		const box = this.box(mailboxId);
		const ids = [...box.emails.values()].filter((e) => e.folder_id === "trash").map((e) => e.id);
		for (const id of ids) this.destroy(box, id);
		this.touch(box);
		return ids.length;
	}

	moveEmail(mailboxId: string, id: string, folderId: string): void {
		const box = this.box(mailboxId);
		const e = this.email(box, id);
		const target = this.folderId(box, folderId);
		if (!box.folders.some((f) => f.id === target)) throw new DemoError(404, "Folder not found");
		if (NOT_A_TARGET.has(target)) throw new DemoError(400, `Messages cannot be moved into ${target}`);
		if (e.folder_id === "draft" || e.folder_id === "scheduled") {
			throw new DemoError(400, "Drafts and scheduled messages cannot be moved");
		}
		if (target === "trash") this.toTrash(e);
		else {
			e.folder_id = target;
			e.trashed_from = null;
			e.trashed_at = null;
			e.snoozed_until = null;
			e.snooze_return_folder = null;
		}
		this.touch(box);
	}

	markThreadRead(mailboxId: string, threadId: string): void {
		const box = this.box(mailboxId);
		for (const e of box.emails.values()) if (conversationOf(e) === threadId) e.read = true;
		this.touch(box);
	}

	bulk(mailboxId: string, body: Row): Row {
		const box = this.box(mailboxId);
		const ids: string[] = Array.isArray(body.ids) ? body.ids.filter((id: unknown) => box.emails.has(String(id))) : [];
		let affected = 0;
		let trashed = 0;
		let deleted = 0;
		const each = (fn: (e: Row) => boolean) => {
			for (const id of ids) if (fn(box.emails.get(id)!)) affected += 1;
		};
		switch (body.action) {
			case "read":
			case "unread": {
				const read = body.action === "read";
				each((e) => (e.read === read ? false : ((e.read = read), true)));
				break;
			}
			case "star":
			case "unstar": {
				const starred = body.action === "star";
				each((e) => (e.starred === starred ? false : ((e.starred = starred), true)));
				break;
			}
			case "delete":
			case "delete_permanently":
				for (const id of ids) {
					const result = this.deleteEmail(mailboxId, id, body.action === "delete_permanently");
					if (result === "trashed") trashed += 1;
					else deleted += 1;
				}
				this.touch(box);
				return { affected: trashed + deleted, trashed, deleted };
			case "restore":
				each((e) => {
					if (e.folder_id !== "trash") return false;
					this.restoreEmail(mailboxId, e.id);
					return true;
				});
				break;
			case "move":
				each((e) => {
					if (e.folder_id === this.folderId(box, body.folder_id)) return false;
					this.moveEmail(mailboxId, e.id, body.folder_id);
					return true;
				});
				break;
			case "label":
			case "unlabel": {
				if (!box.labels.some((l) => l.id === body.label_id)) throw new DemoError(404, "Label not found");
				each((e) => {
					const mine = box.emailLabels.get(e.id) ?? new Map<string, "ai" | "user">();
					box.emailLabels.set(e.id, mine);
					if (body.action === "label") return mine.has(body.label_id) ? false : (mine.set(body.label_id, "user"), true);
					return mine.delete(body.label_id);
				});
				break;
			}
			default:
				throw new DemoError(400, "Unknown bulk action");
		}
		this.touch(box);
		return { affected };
	}

	markAllRead(mailboxId: string, scope: { folder?: string; label_id?: string }): number {
		const box = this.box(mailboxId);
		let affected = 0;
		const folder = scope.folder ? this.folderId(box, scope.folder) : null;
		const inLabel = scope.label_id ? new Set(this.labelled(box, scope.label_id).map((e) => e.id)) : null;
		for (const e of box.emails.values()) {
			if (e.read || e.folder_id === "draft") continue;
			if (folder && e.folder_id !== folder) continue;
			if (inLabel && !inLabel.has(e.id)) continue;
			e.read = true;
			affected += 1;
		}
		this.touch(box);
		return affected;
	}

	snooze(mailboxId: string, id: string, when: { until?: string; delay_seconds?: number }): Row {
		const box = this.box(mailboxId);
		const e = this.email(box, id);
		const until = when.until ? Date.parse(when.until) : this.clock() + Number(when.delay_seconds ?? 0) * 1000;
		if (!Number.isFinite(until) || until <= this.clock()) throw new DemoError(400, "Pick a time in the future");
		if (e.folder_id !== "snoozed") e.snooze_return_folder = e.folder_id;
		e.snoozed_until = new Date(until).toISOString();
		e.folder_id = "snoozed";
		this.touch(box);
		return e;
	}

	unsnooze(mailboxId: string, id: string): Row {
		const box = this.box(mailboxId);
		const e = this.email(box, id);
		if (e.folder_id === "snoozed") e.folder_id = e.snooze_return_folder ?? "inbox";
		e.snoozed_until = null;
		e.snooze_return_folder = null;
		this.touch(box);
		return e;
	}

	setPriority(mailboxId: string, id: string, priority: string | null): Row {
		const box = this.box(mailboxId);
		const e = this.email(box, id);
		e.priority = priority === "high" || priority === "low" ? priority : null;
		this.touch(box);
		return e;
	}

	notSpam(mailboxId: string, id: string): Row {
		const box = this.box(mailboxId);
		const e = this.email(box, id);
		e.folder_id = "inbox";
		this.touch(box);
		return { folder: "inbox", unblocked: [], allowed: null };
	}

	mute(mailboxId: string, threadId: string, muted: boolean): Row {
		const box = this.box(mailboxId);
		if (muted) box.muted.add(threadId);
		else box.muted.delete(threadId);
		this.touch(box);
		return { muted };
	}

	mutedThreads(mailboxId: string): string[] {
		return [...this.box(mailboxId).muted];
	}

	// ── drafts and the send queue ───────────────────────────────────

	/** Create or update a draft. Attachment bytes are kept by the caller (files.ts). */
	saveDraft(mailboxId: string, input: Row, attachments?: Row[]): { row: Row; created: boolean } {
		const box = this.box(mailboxId);
		const existing = input.draft_id ? box.emails.get(String(input.draft_id)) : undefined;
		const draft = existing && existing.folder_id === "draft" ? existing : null;
		const body = String(input.body ?? "");
		const id = draft?.id ?? (input.draft_id ? String(input.draft_id) : demoId("draft"));
		const row: Row = draft ?? {
			id,
			folder_id: "draft",
			sender: box.mailbox.email,
			sender_name: null,
			sender_auth: 0,
			read: false,
			starred: false,
			thread_id: input.thread_id ?? id,
			message_id: `${id}@${box.mailbox.domain ?? "demo.example"}`,
			email_references: null,
			raw_headers: null,
			snoozed_until: null,
			snooze_return_folder: null,
			priority: null,
			trashed_from: null,
			trashed_at: null,
			spam_score: 0,
			spam_signals: null,
			security_warnings: null,
			delivery_status: null,
			delivery_error: null,
			provider_message_id: null,
			opened_at: null,
			last_opened_at: null,
			open_count: 0,
			open_proxy_count: 0,
			clicked_at: null,
			click_count: 0,
			attachments: [],
			warnings: [],
		};
		row.subject = String(input.subject ?? "");
		row.recipient = String(input.to ?? "");
		row.cc = input.cc ? String(input.cc) : null;
		row.bcc = input.bcc ? String(input.bcc) : null;
		row.body = body;
		row.snippet = htmlToText(body).slice(0, 300);
		row.in_reply_to = input.in_reply_to ?? row.in_reply_to ?? null;
		if (input.thread_id) row.thread_id = input.thread_id;
		row.date = this.now();
		if (attachments) row.attachments = attachments.map((a) => ({ ...a, email_id: id }));
		box.emails.set(id, row);
		this.touch(box);
		return { row, created: !draft };
	}

	scheduledSends(mailboxId: string): Row[] {
		const box = this.box(mailboxId);
		return [...box.emails.values()]
			.filter((e) => e.folder_id === "scheduled")
			.map((e) => ({
				email_id: e.id,
				send_at: box.sendAt.get(e.id) ?? e.date,
				status: "pending",
				attempts: 0,
				last_error: null,
				subject: e.subject,
				sender: e.sender,
				recipient: e.recipient,
				cc: e.cc ?? null,
				bcc: e.bcc ?? null,
				snippet: e.snippet ?? null,
			}))
			.sort((a, b) => (a.send_at < b.send_at ? -1 : 1));
	}

	/** Cancelling a queued message puts it back in Drafts, as the server does. */
	cancelScheduled(mailboxId: string, emailId: string): Row {
		const box = this.box(mailboxId);
		const e = box.emails.get(emailId);
		if (!e || e.folder_id !== "scheduled") throw new DemoError(404, "Scheduled send not found");
		e.folder_id = "draft";
		e.read = false;
		e.date = this.now();
		box.sendAt.delete(emailId);
		this.touch(box);
		return { status: "cancelled" };
	}

	// ── summaries ───────────────────────────────────────────────────

	summary(mailboxId: string, threadId: string): Summary | null {
		return this.box(mailboxId).summaries.get(threadId) ?? null;
	}

	setSummary(mailboxId: string, threadId: string, line: string, bullets: string[]): Summary {
		const box = this.box(mailboxId);
		const summary: Summary = {
			thread_id: threadId,
			line,
			bullets,
			message_count: this.getThread(mailboxId, threadId).length,
			status: "ok",
			generated_at: this.now().replace("T", " ").slice(0, 19),
			stale: false,
		};
		box.summaries.set(threadId, summary);
		this.touch(box);
		return summary;
	}

	// ── counts and search ───────────────────────────────────────────

	state(mailboxId: string): Row {
		const box = this.box(mailboxId);
		const unread = [...box.emails.values()].filter((e) => e.folder_id === "inbox" && !e.read);
		return {
			version: box.version,
			inboxUnread: unread.length,
			inboxUnreadHighPriority: unread.filter((e) => e.priority === "high").length,
		};
	}

	deliveryEvents(mailboxId: string, emailId: string): Row[] {
		return this.box(mailboxId).deliveryEvents[emailId] ?? [];
	}

	followup(mailboxId: string, emailId: string): Row | null {
		return this.box(mailboxId).followups[emailId] ?? null;
	}

	extra(mailboxId: string, key: string): unknown {
		return this.box(mailboxId).extra[key];
	}

	/** Senders waiting in the Screener, newest first, one row each. */
	screenerSenders(mailboxId: string): Row[] {
		const box = this.box(mailboxId);
		// The AI's guess at each sender was recorded with the snapshot.
		const recorded = new Map<string, Row>((box.extra.screener?.senders ?? []).map((s: Row) => [lower(s.sender), s]));
		const bySender = new Map<string, Row[]>();
		for (const e of box.emails.values()) {
			if (e.folder_id !== "screener") continue;
			const key = lower(e.sender);
			bySender.set(key, [...(bySender.get(key) ?? []), e]);
		}
		return [...bySender.entries()]
			.map(([sender, list]) => {
				const latest = [...list].sort(byDateDesc)[0];
				const was = recorded.get(sender);
				return {
					sender,
					sender_name: latest.sender_name ?? null,
					count: list.length,
					unread: list.filter((e) => !e.read).length,
					latest_date: latest.date,
					latest_subject: latest.subject ?? null,
					latest_id: latest.id,
					sender_kind: was?.sender_kind ?? null,
					sender_confidence: was?.sender_confidence ?? null,
					verdict: was?.verdict ?? null,
				};
			})
			.sort((a, b) => (a.latest_date < b.latest_date ? 1 : -1));
	}

	/**
	 * Yes or No for one sender. Yes moves their waiting mail to the Inbox and
	 * allows them; No moves it to Spam or Trash and blocks them.
	 */
	screen(mailboxId: string, senderRaw: string, decision: "allow" | "block", target: "spam" | "trash" = "spam"): Row {
		const box = this.box(mailboxId);
		const sender = lower(senderRaw).trim();
		if (!sender.includes("@")) throw new DemoError(400, "Not an email address");
		const folder = decision === "allow" ? "inbox" : target;
		let moved = 0;
		for (const e of box.emails.values()) {
			if (e.folder_id !== "screener" || lower(e.sender) !== sender) continue;
			if (folder === "trash") this.toTrash(e);
			else e.folder_id = folder;
			moved += 1;
		}
		const key = decision === "allow" ? "allowed-senders" : "blocked-senders";
		const other = decision === "allow" ? "blocked-senders" : "allowed-senders";
		const list: Row[] = Array.isArray(box.extra[key]) ? box.extra[key] : [];
		const listed = !list.some((r) => lower(r.pattern) === sender);
		if (listed) list.push({ id: demoId(key.slice(0, 3)), pattern: sender, reason: `Screener: ${decision === "allow" ? "yes" : "no"}`, created_at: this.now() });
		box.extra[key] = list;
		// Like the app: a Yes clears a block on the address or on its whole domain; a No
		// removes only the exact allow, because a domain-wide allow is a broader decision.
		const domain = sender.slice(sender.lastIndexOf("@"));
		if (Array.isArray(box.extra[other])) {
			box.extra[other] = box.extra[other].filter((r: Row) => lower(r.pattern) !== sender && (decision === "block" || lower(r.pattern) !== domain));
		}
		this.touch(box);
		return { sender, decision, folder, moved, listed };
	}

	private matches(box: Box, e: Row, node: SearchNode): boolean {
		switch (node.type) {
			case "and":
				return node.children.every((c) => this.matches(box, e, c));
			case "or":
				return node.children.some((c) => this.matches(box, e, c));
			case "not":
				return !this.matches(box, e, node.child);
			case "term": {
				const needle = lower(node.value);
				if (!needle) return true;
				return [e.subject, e.sender, e.sender_name, e.recipient, e.cc, this.bodyText(e)].some((f) => lower(f).includes(needle));
			}
			case "operator":
				switch (node.field) {
					case "from":
						return lower(e.sender).includes(lower(node.value)) || lower(e.sender_name).includes(lower(node.value));
					case "to":
						return lower(e.recipient).includes(lower(node.value));
					case "cc":
						return lower(e.cc).includes(lower(node.value));
					case "bcc":
						return lower(e.bcc).includes(lower(node.value));
					case "subject":
						return lower(e.subject).includes(lower(node.value));
					case "filename":
						return (e.attachments ?? []).some((a: Row) => lower(a.filename).includes(lower(node.value)));
					case "label": {
						const mine = box.emailLabels.get(e.id);
						return !!mine && box.labels.some((l) => mine.has(l.id) && lower(l.name).includes(lower(node.value)));
					}
					case "folder":
						return lower(node.value) === "anywhere" || e.folder_id === this.folderId(box, node.value);
					case "flag":
						switch (node.value) {
							case "read":
								return !!e.read;
							case "unread":
								return !e.read;
							case "starred":
								return !!e.starred;
							case "unstarred":
								return !e.starred;
							case "attachment":
								return (e.attachments?.length ?? 0) > 0;
							case "muted":
								return box.muted.has(conversationOf(e));
							case "important":
								return e.priority === "high";
							case "snoozed":
								return e.folder_id === "snoozed";
						}
						return false;
					case "date":
						return node.cmp === ">=" ? e.date >= node.value : e.date <= node.value;
					case "size": {
						const size = (e.body?.length ?? 0) + (e.attachments ?? []).reduce((n: number, a: Row) => n + (a.size ?? 0), 0);
						return node.cmp === ">=" ? size >= node.bytes : size <= node.bytes;
					}
				}
		}
		return false;
	}

	private hits(mailboxId: string, query: string): { box: Box; rows: Row[]; terms: string[] } {
		const box = this.box(mailboxId);
		const ast = parseSearchQuery(query, { now: new Date(this.clock()) });
		if (!ast) return { box, rows: [], terms: [] };
		const everywhere = includesEverywhere(ast) || namesFolder(ast);
		const terms: string[] = [];
		collectTerms(ast, terms);
		const rows = [...box.emails.values()]
			.filter((e) => (everywhere || !TERMINAL.has(e.folder_id)) && this.matches(box, e, ast))
			.sort(byDateDesc);
		return { box, rows, terms };
	}

	private hitSnippet(e: Row, terms: string[]): string {
		const text = this.bodyText(e);
		const hay = text.toLowerCase();
		for (const term of terms) {
			const at = hay.indexOf(term.toLowerCase());
			if (at < 0) continue;
			const from = Math.max(0, at - 40);
			const to = Math.min(text.length, at + term.length + 40);
			return `${from > 0 ? "…" : ""}${text.slice(from, at)}${HIT_OPEN}${text.slice(at, at + term.length)}${HIT_CLOSE}${text.slice(at + term.length, to)}${to < text.length ? "…" : ""}`;
		}
		return e.snippet ?? text.slice(0, 160);
	}

	/** A search hit: the message itself with its matching text, not its conversation's summary. */
	private searchRow(box: Box, e: Row, terms: string[]): Row {
		const { summary_line: _summary, ...row } = this.listRow(box, e);
		return {
			...row,
			folder_name: box.folders.find((f) => f.id === e.folder_id)?.name ?? e.folder_id,
			snippet: this.hitSnippet(e, terms),
		};
	}

	search(mailboxId: string, query: string, page?: number, limit?: number): { emails: Row[]; totalCount: number } {
		const { box, rows, terms } = this.hits(mailboxId, query);
		const emails = paginate(rows, page, limit).map((e) => this.searchRow(box, e, terms));
		return { emails, totalCount: rows.length };
	}

	private crossHit(mailboxId: string, e: Row, terms: string[], matched: "fts" | "vector"): Row {
		return {
			mailboxId,
			id: e.id,
			thread_id: e.thread_id,
			folder_id: e.folder_id,
			subject: e.subject,
			sender: e.sender,
			sender_name: e.sender_name,
			sender_auth: e.sender_auth,
			recipient: e.recipient,
			date: e.date,
			read: e.read,
			starred: e.starred,
			snippet: this.hitSnippet(e, terms),
			matched: [matched],
			score: 0,
		};
	}

	private crossResults(results: Row[], limit?: number): Row {
		const top = results.slice(0, clampLimit(limit));
		top.forEach((r, i) => {
			r.score = Number((1 / (60 + i)).toFixed(6));
		});
		return { results: top, semantic: true, mailboxes: this.order, truncated: [], mode: "hybrid" };
	}

	searchAll(query: string, limit = 25): Row {
		const results: Row[] = [];
		for (const id of this.order) {
			const { rows, terms } = this.hits(id, query);
			for (const e of rows) results.push(this.crossHit(id, e, terms, "fts"));
		}
		return this.crossResults(results.sort(byDateDesc), limit);
	}

	/**
	 * Search results for messages chosen by the caller, in the order given: the
	 * demo's stand-in for meaning-based hits when a plain-language query matches
	 * no message word for word (see ai.ts).
	 */
	related(mailboxId: string, picks: { email: Row }[], terms: string[]): { emails: Row[]; totalCount: number } {
		const box = this.box(mailboxId);
		const emails = picks.map(({ email: e }) => this.searchRow(box, e, terms));
		return { emails, totalCount: emails.length };
	}

	relatedAll(picks: { mailboxId: string; email: Row }[], terms: string[], limit?: number): Row {
		return this.crossResults(picks.map((p) => this.crossHit(p.mailboxId, p.email, terms, "vector")), limit);
	}

	/** The newest matching messages across mailboxes, for the stored "Ask" answers. */
	find(query: string, limit = 3): { mailboxId: string; email: Row }[] {
		const out: { mailboxId: string; email: Row }[] = [];
		for (const id of this.order) {
			for (const e of this.hits(id, query).rows) out.push({ mailboxId: id, email: e });
		}
		return out.sort((a, b) => byDateDesc(a.email, b.email)).slice(0, limit);
	}

	/** Messages whose subject contains `fragment`, oldest first, across mailboxes. */
	bySubject(fragment: string): { mailboxId: string; email: Row }[] {
		const needle = lower(fragment);
		const out: { mailboxId: string; email: Row }[] = [];
		for (const id of this.order) {
			for (const e of this.box(id).emails.values()) {
				if (!TERMINAL.has(e.folder_id) && lower(e.subject).includes(needle)) out.push({ mailboxId: id, email: e });
			}
		}
		return out.sort((a, b) => byDateAsc(a.email, b.email));
	}

	/** Every conversation of a mailbox outside Trash and Spam, oldest message first. */
	conversations(mailboxId: string): Row[][] {
		const groups = new Map<string, Row[]>();
		for (const e of this.box(mailboxId).emails.values()) {
			if (TERMINAL.has(e.folder_id)) continue;
			const key = conversationOf(e);
			const list = groups.get(key);
			if (list) list.push(e);
			else groups.set(key, [e]);
		}
		return [...groups.values()].map((list) => list.sort(byDateAsc));
	}

	unifiedInbox(q: { folder?: string; limit?: number; cursor?: string; product?: string[]; unread?: boolean }): Row {
		const folder = q.folder || "inbox";
		const products: Row[] = this.fixed["/api/v1/products"]?.products ?? [];
		const productOf = (mailboxId: string) => {
			const domain = mailboxId.slice(mailboxId.lastIndexOf("@") + 1);
			const p = products.find((x) => (x.domains ?? []).includes(domain));
			return p ? { id: p.id, name: p.name, slug: p.slug, accentColor: p.accentColor ?? null } : null;
		};
		const rows: Row[] = [];
		const unreadByMailbox: Record<string, number> = {};
		const included: string[] = [];
		for (const id of this.order) {
			const box = this.box(id);
			const product = productOf(id);
			unreadByMailbox[id] = [...box.emails.values()].filter((e) => e.folder_id === folder && !e.read).length;
			if (q.product?.length && !(product && q.product.some((p) => p === product.id || p === product.slug))) continue;
			included.push(id);
			for (const row of this.threadedRows(box, this.folderId(box, folder), { unread: q.unread })) {
				rows.push({ ...row, mailboxId: id, product });
			}
		}
		rows.sort(byDateDesc);
		const limit = clampLimit(q.limit);
		const offset = Math.max(0, Number(q.cursor ?? 0) || 0);
		const page = rows.slice(offset, offset + limit);
		return {
			emails: page,
			nextCursor: offset + limit < rows.length ? String(offset + limit) : null,
			unread: included.reduce((n, id) => n + unreadByMailbox[id], 0),
			unreadByMailbox,
			mailboxes: included,
			truncated: [],
			degraded: [],
		};
	}
}

export interface ListFilters {
	unread?: boolean;
	starred?: boolean;
	has_attachment?: boolean;
}

export interface ListQuery extends ListFilters {
	folder?: string;
	threaded?: boolean;
	page?: number;
	limit?: number;
	sortColumn?: string;
	sortDirection?: string;
}

function passes(e: Row, f: ListFilters): boolean {
	if (f.unread && e.read) return false;
	if (f.starred && !e.starred) return false;
	if (f.has_attachment && !(e.attachments?.length > 0)) return false;
	return true;
}

function clampLimit(limit?: number): number {
	const n = Number(limit);
	return Number.isFinite(n) && n > 0 ? Math.min(100, Math.floor(n)) : 25;
}

function paginate<T>(rows: T[], page?: number, limit?: number): T[] {
	const size = clampLimit(limit);
	const p = Number.isFinite(Number(page)) && Number(page) > 0 ? Math.floor(Number(page)) : 1;
	return rows.slice((p - 1) * size, p * size);
}

const SORTABLE = new Set(["id", "subject", "sender", "recipient", "date", "read", "starred"]);

function sortRows(rows: Row[], column?: string, direction?: string) {
	const key = column && SORTABLE.has(column) ? column : "date";
	const sign = String(direction).toUpperCase() === "ASC" ? 1 : -1;
	rows.sort((a, b) => {
		const x = key === "date" ? a.date : lower(a[key]);
		const y = key === "date" ? b.date : lower(b[key]);
		if (x < y) return -sign;
		if (x > y) return sign;
		// Newest first among equals, so pages never repeat or skip a row.
		return byDateDesc(a, b);
	});
}

function collectTerms(node: SearchNode, out: string[]) {
	if (node.type === "term") {
		if (node.value) out.push(node.value);
	} else if (node.type === "and" || node.type === "or") {
		for (const c of node.children) collectTerms(c, out);
	}
}

function namesFolder(node: SearchNode): boolean {
	if (node.type === "operator") return node.field === "folder";
	if (node.type === "and" || node.type === "or") return node.children.some(namesFolder);
	if (node.type === "not") return namesFolder(node.child);
	return false;
}
