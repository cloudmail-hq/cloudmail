// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Mail import, the job runner: parse a raw message and file it, and advance a
 * job by one bounded step.
 *
 * Driven by the MailboxDO alarm (there is no Queue binding): each run calls
 * `runImportStep`, which works until its message or time budget is spent,
 * saves the cursor after every message, and says whether there is more. An
 * interrupted run (deploy, eviction, crash) loses at most the message it was
 * on, and that one is re-read and deduplicated by Message-ID on the next run.
 *
 * No `cloudflare:*` imports, so the whole runner is tested in Node with an
 * in-memory R2 and a scripted IMAP server. The socket transport lives in
 * ./mail-import-imap.ts.
 */

import PostalMime, { type Email as ParsedEmail } from "postal-mime";
import { isBlockedAttachment } from "../../shared/attachment-types";
import { resolveMessageDate } from "../../shared/dates";
import { Folders } from "../../shared/folders";
import {
	IMPORT_MAX_MESSAGE_BYTES,
	findNextSeparator,
	parseGmailLabels,
	placementFromGmailLabels,
	planImapFolder,
	splitMboxWindow,
	type ImapFolderPlan,
	type ImportPlacement,
} from "../../shared/mail-import";
import { parseMessageId, parseMessageIdList } from "../../shared/message-ids";
import { cleanSenderName } from "../../shared/sender-name";
import * as store from "../durableObject/mail-import";
import { attachmentKey, sanitizeAttachmentFilename, type StoredAttachment } from "./attachments";
import { extractPriority } from "./email-helpers";
import { ImapClient, ImapError, type ImapTransport } from "./imap";
import { isEmlEntry, isMboxEntry, readZipDirectory, readZipEntry, ZipError, type RangeReader } from "./zip-reader";

/** Per-run budget. The alarm re-arms in `IMPORT_RESCHEDULE_MS` while work remains. */
export const IMPORT_STEP_MS = 20_000;
export const IMPORT_STEP_MESSAGES = 250;
export const IMPORT_RESCHEDULE_MS = 1_000;
/** First mbox read; doubled until a whole message fits, up to the message cap. */
export const MBOX_WINDOW_BYTES = 4 * 1024 * 1024;
const MBOX_MAX_WINDOW = IMPORT_MAX_MESSAGE_BYTES + 64 * 1024;
/** IMAP bodies per UID FETCH, and the bytes one fetch may bring back. */
const IMAP_FETCH_COUNT = 25;
const IMAP_FETCH_BYTES = 20 * 1024 * 1024;

/** Where the user wants mail without folder information to land. */
export type DefaultFolder = "inbox" | "archive";

export interface ImportOptions {
	/** Folder for messages that carry no Gmail labels (plain mbox, eml). */
	folder?: DefaultFolder;
	/** IMAP: only these mailbox names (as the server lists them). */
	folders?: string[];
}

/** The R2 surface the runner needs. */
export interface ImportBucket {
	get(key: string, options?: { range?: { offset: number; length: number } }): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
	put(key: string, value: ArrayBuffer | Uint8Array | string): Promise<unknown>;
	delete(keys: string | string[]): Promise<void>;
}

export interface ImapDeps {
	connect(host: string): Promise<ImapTransport>;
	/** The decrypted app password, or null when it is gone (job cancelled). */
	password(): Promise<string | null>;
	timeoutMs?: number;
}

export interface StepDeps {
	ctx: DurableObjectState;
	bucket: ImportBucket;
	/** This mailbox's address, for spotting sent mail. */
	mailbox: string;
	imap?: ImapDeps;
	now?: () => number;
	budgetMs?: number;
	budgetMessages?: number;
}

export interface StepResult {
	jobId: string | null;
	/** More work is waiting: re-arm the alarm soon. */
	more: boolean;
	/** The job reached a terminal status in this step. */
	finished: store.ImportJobRow | null;
}

// ── One message ─────────────────────────────────────────────────────

export interface IngestContext {
	ctx: DurableObjectState;
	bucket: ImportBucket;
	mailbox: string;
	/** Placement from the IMAP folder, overriding the default. */
	imapPlacement?: { plan: ImapFolderPlan; flags: string[] } | null;
	defaultFolder: DefaultFolder;
	/** Arrival time to use when the Date header is missing or implausible. */
	fallbackDate?: Date | null;
	labelCache?: Map<string, string>;
	now?: Date;
}

export type IngestOutcome = "imported" | "duplicate" | "failed" | "skipped";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function addressesOf(list: ParsedEmail["to"]): string[] {
	const out: string[] = [];
	for (const a of list ?? []) {
		if (a.address) out.push(a.address.toLowerCase());
		else if (a.group) for (const m of a.group) if (m.address) out.push(m.address.toLowerCase());
	}
	return out;
}

/** Folder, labels and flags for one parsed message. Exported for tests. */
export function placementFor(
	parsed: Pick<ParsedEmail, "headers" | "from">,
	input: Pick<IngestContext, "imapPlacement" | "defaultFolder" | "mailbox">,
): ImportPlacement {
	const gmail = parsed.headers.find((h) => h.key === "x-gmail-labels")?.value;
	const fromSelf = (parsed.from?.address ?? "").toLowerCase() === input.mailbox.toLowerCase();
	if (input.imapPlacement) {
		const { plan, flags } = input.imapPlacement;
		const lower = flags.map((f) => f.toLowerCase());
		return {
			folder: plan.folder,
			labels: plan.label ? [plan.label] : [],
			read: lower.includes("\\seen"),
			starred: lower.includes("\\flagged"),
		};
	}
	if (gmail !== undefined) return placementFromGmailLabels(parseGmailLabels(gmail));
	return { folder: fromSelf ? "sent" : input.defaultFolder, labels: [], read: true, starred: false };
}

/**
 * Parse one RFC 5322 message and file it. Never throws: a message that will
 * not parse counts as `failed` and the import moves on.
 */
export async function ingestRawMessage(raw: Uint8Array, input: IngestContext): Promise<{ outcome: IngestOutcome; error?: string }> {
	if (raw.byteLength === 0) return { outcome: "skipped" };
	if (raw.byteLength > IMPORT_MAX_MESSAGE_BYTES) return { outcome: "skipped", error: "message larger than 25 MB" };
	let parsed: ParsedEmail;
	try {
		parsed = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
	} catch (e) {
		return { outcome: "failed", error: `could not parse a message: ${(e as Error).message}` };
	}
	if (parsed.headers.length === 0) return { outcome: "failed", error: "a message had no headers" };

	try {
		const messageId = parseMessageId(parsed.messageId ?? null);
		const contentHash = messageId ? `mid:${messageId}` : await sha256Hex(raw);
		const placement = placementFor(parsed, input);

		const existing = store.findExisting(input.ctx, messageId, contentHash);
		if (existing) {
			// Seen in another IMAP folder (Gmail exposes labels as folders): the
			// copy already here gets this folder's label too. Only imported rows,
			// so an import never relabels mail that arrived normally.
			if (placement.labels.length > 0) {
				const row = input.ctx.storage.sql.exec(`SELECT imported FROM emails WHERE id = ?`, existing).toArray()[0] as
					| { imported: number }
					| undefined;
				if (row?.imported === 1) store.applyImportLabels(input.ctx, existing, placement.labels, input.labelCache);
			}
			return { outcome: "duplicate" };
		}

		const now = input.now ?? new Date();
		let date = resolveMessageDate(parsed.date, now);
		if (date === now.toISOString() && input.fallbackDate && !Number.isNaN(input.fallbackDate.getTime())) {
			date = input.fallbackDate.toISOString();
		}

		const emailId = crypto.randomUUID();
		const attachments: StoredAttachment[] = [];
		const written: string[] = [];
		for (const att of parsed.attachments ?? []) {
			const attId = crypto.randomUUID();
			const filename = sanitizeAttachmentFilename(att.filename);
			const content = typeof att.content === "string" ? new TextEncoder().encode(att.content) : new Uint8Array(att.content);
			const base = {
				id: attId,
				email_id: emailId,
				filename,
				mimetype: att.mimeType,
				size: content.byteLength,
				content_id: att.contentId || null,
				disposition: att.disposition || "attachment",
			};
			// Same rule as inbound: an executable part is recorded, never stored.
			if (isBlockedAttachment(filename)) {
				attachments.push({ ...base, blocked: true });
				continue;
			}
			const key = attachmentKey(emailId, attId, filename);
			await input.bucket.put(key, content);
			written.push(key);
			attachments.push(base);
		}

		const references = parseMessageIdList(parsed.references ?? null);
		const result = store.insertImported(
			input.ctx,
			{
				id: emailId,
				folder: placement.folder,
				subject: parsed.subject || "",
				sender: (parsed.from?.address || "").toLowerCase(),
				sender_name: cleanSenderName(parsed.from?.name, parsed.from?.address),
				recipient: addressesOf(parsed.to).join(", "),
				cc: addressesOf(parsed.cc).join(", ") || null,
				bcc: addressesOf(parsed.bcc).join(", ") || null,
				date,
				body: parsed.html || parsed.text || "",
				message_id: messageId,
				in_reply_to: parseMessageId(parsed.inReplyTo ?? null),
				references,
				raw_headers: JSON.stringify(parsed.headers),
				priority: extractPriority(parsed.headers),
				read: placement.read || placement.folder === Folders.SENT,
				starred: placement.starred,
				labels: placement.labels,
				contentHash,
			},
			attachments,
			input.labelCache,
		);
		if (result.outcome === "duplicate") {
			if (written.length > 0) await input.bucket.delete(written).catch(() => {});
			return { outcome: "duplicate" };
		}
		return { outcome: "imported" };
	} catch (e) {
		return { outcome: "failed", error: (e as Error).message };
	}
}

// ── Steps ───────────────────────────────────────────────────────────

class Budget {
	readonly #deadline: number;
	#messages: number;
	constructor(
		private readonly now: () => number,
		ms: number,
		messages: number,
	) {
		this.#deadline = now() + ms;
		this.#messages = messages;
	}
	spend(): void {
		this.#messages--;
	}
	get left(): boolean {
		return this.#messages > 0 && this.now() < this.#deadline;
	}
}

function rangeReader(bucket: ImportBucket, key: string): RangeReader {
	return async (offset, length) => {
		if (length <= 0) return new Uint8Array(0);
		const obj = await bucket.get(key, { range: { offset, length } });
		if (!obj) throw new Error("The uploaded file is missing from storage.");
		return new Uint8Array(await obj.arrayBuffer());
	};
}

type Counters = Partial<Record<"imported" | "duplicates" | "failed" | "skipped", number>>;

function count(c: Counters, outcome: IngestOutcome): Counters {
	const key = outcome === "duplicate" ? "duplicates" : outcome;
	return { ...c, [key]: (c[key] ?? 0) + 1 };
}

/** Whether a person paused or cancelled the job while this step was working. */
function stillRunning(ctx: DurableObjectState, id: string): boolean {
	return store.getJob(ctx, id)?.status === "running";
}

function options(job: store.ImportJobRow): ImportOptions {
	try {
		return (job.options ? JSON.parse(job.options) : {}) as ImportOptions;
	} catch {
		return {};
	}
}

/**
 * Advance the oldest runnable job by one bounded step.
 */
export async function runImportStep(deps: StepDeps): Promise<StepResult> {
	const job = store.nextRunnableJob(deps.ctx);
	if (!job) return { jobId: null, more: false, finished: null };
	const now = deps.now ?? Date.now;
	const budget = new Budget(now, deps.budgetMs ?? IMPORT_STEP_MS, deps.budgetMessages ?? IMPORT_STEP_MESSAGES);
	store.patchJob(deps.ctx, job.id, { status: "running" });

	let outcome: { done: boolean; error?: string };
	try {
		if (job.source === "mbox") outcome = await stepMbox(deps, job, budget);
		else if (job.source === "zip") outcome = await stepZip(deps, job, budget);
		else if (job.source === "eml") outcome = await stepEml(deps, job);
		else outcome = await stepImap(deps, job, budget);
	} catch (e) {
		outcome = { done: true, error: describeFailure(e) };
	}

	const current = store.getJob(deps.ctx, job.id);
	if (!current) return { jobId: job.id, more: store.hasRunnableJob(deps.ctx), finished: null };
	if (current.status !== "running") {
		// Paused or cancelled mid-step: that decision stands.
		const finished = current.status === "cancelled" ? current : null;
		return { jobId: job.id, more: store.hasRunnableJob(deps.ctx), finished };
	}
	if (outcome.done) {
		const finished = store.patchJob(deps.ctx, job.id, {
			status: outcome.error ? "failed" : "completed",
			lastError: outcome.error ?? current.last_error,
		});
		return { jobId: job.id, more: store.hasRunnableJob(deps.ctx), finished };
	}
	return { jobId: job.id, more: true, finished: null };
}

function describeFailure(e: unknown): string {
	if (e instanceof ImapError) {
		if (e.kind === "auth") return `The IMAP server refused the login. Check the username and app password. (${e.message})`;
		if (e.kind === "timeout") return "The IMAP server stopped responding.";
		return e.message;
	}
	if (e instanceof ZipError) return e.message;
	return (e as Error)?.message || "The import failed.";
}

// ── mbox ────────────────────────────────────────────────────────────

interface MboxState {
	/** Skipping past an oversized message: the cursor is mid-message. */
	skipping?: boolean;
}

async function stepMbox(deps: StepDeps, job: store.ImportJobRow, budget: Budget): Promise<{ done: boolean; error?: string }> {
	const size = job.size_bytes ?? 0;
	const read = rangeReader(deps.bucket, job.r2_key!);
	const opts = options(job);
	const labelCache = new Map<string, string>();
	let cursor = job.cursor;
	let state = store.jobState<MboxState>(job) ?? {};
	let window = MBOX_WINDOW_BYTES;
	let sawMessage = job.imported + job.duplicates + job.failed + job.skipped > 0;

	while (budget.left) {
		if (cursor >= size) {
			if (!sawMessage) return { done: true, error: "That file does not look like an mbox: no messages were found." };
			return { done: true };
		}
		if (state.skipping) {
			// Scan forward for the next separator, one chunk at a time.
			const len = Math.min(MBOX_WINDOW_BYTES, size - cursor);
			const chunk = await read(cursor, len);
			const eof = cursor + len >= size;
			const idx = findNextSeparator(chunk, eof);
			if (idx !== -1) {
				cursor += idx;
				state = {};
			} else if (eof) {
				cursor = size;
				state = {};
			} else {
				// Restart at the last complete line, so a separator straddling the edge is still seen.
				const lastLf = chunk.lastIndexOf(0x0a);
				const prevLf = lastLf > 0 ? chunk.lastIndexOf(0x0a, lastLf - 1) : -1;
				cursor += prevLf > 0 ? prevLf + 1 : len;
			}
			store.patchJob(deps.ctx, job.id, { cursor, state });
			continue;
		}

		const len = Math.min(window, size - cursor);
		const eof = cursor + len >= size;
		const bytes = await read(cursor, len);
		const result = splitMboxWindow(bytes, cursor, eof);

		if (result.messages.length === 0) {
			if (result.firstSeparator !== null && result.firstSeparator > cursor) {
				// Junk before the first message (some exporters write a preamble).
				cursor = result.firstSeparator;
				store.patchJob(deps.ctx, job.id, { cursor });
				continue;
			}
			if (eof) {
				cursor = size;
				store.patchJob(deps.ctx, job.id, { cursor });
				continue;
			}
			if (window < MBOX_MAX_WINDOW) {
				window = Math.min(window * 2, MBOX_MAX_WINDOW);
				continue;
			}
			// One message larger than the cap: count it and skip to the next.
			sawMessage = true;
			state = { skipping: true };
			store.patchJob(deps.ctx, job.id, { cursor: cursor + 1, state, add: { skipped: 1 } });
			cursor += 1;
			window = MBOX_WINDOW_BYTES;
			continue;
		}

		window = MBOX_WINDOW_BYTES;
		for (const msg of result.messages) {
			if (!budget.left) break;
			if (!stillRunning(deps.ctx, job.id)) return { done: false };
			sawMessage = true;
			const r = await ingestRawMessage(msg.raw, {
				ctx: deps.ctx,
				bucket: deps.bucket,
				mailbox: deps.mailbox,
				defaultFolder: opts.folder ?? "archive",
				labelCache,
			});
			budget.spend();
			cursor = msg.end;
			store.patchJob(deps.ctx, job.id, {
				cursor,
				add: count({}, r.outcome),
				...(r.outcome === "failed" && r.error ? { lastError: r.error } : {}),
			});
		}
	}
	return { done: false };
}

// ── zip of .eml ─────────────────────────────────────────────────────

async function stepZip(deps: StepDeps, job: store.ImportJobRow, budget: Budget): Promise<{ done: boolean; error?: string }> {
	const read = rangeReader(deps.bucket, job.r2_key!);
	const all = await readZipDirectory(read, job.size_bytes ?? 0);
	const entries = all.filter(isEmlEntry);
	if (entries.length === 0) {
		if (all.some(isMboxEntry)) {
			return { done: true, error: "This zip holds an .mbox file (Google Takeout does this). Unzip it and import the .mbox directly." };
		}
		return { done: true, error: "No .eml files were found in that zip." };
	}
	if (job.total_messages !== entries.length) store.patchJob(deps.ctx, job.id, { totalMessages: entries.length });
	const opts = options(job);
	const labelCache = new Map<string, string>();
	let index = job.cursor;
	while (budget.left && index < entries.length) {
		if (!stillRunning(deps.ctx, job.id)) return { done: false };
		const entry = entries[index];
		let outcome: IngestOutcome;
		let error: string | undefined;
		if (entry.uncompressedSize > IMPORT_MAX_MESSAGE_BYTES) {
			outcome = "skipped";
		} else {
			try {
				const raw = await readZipEntry(read, entry, IMPORT_MAX_MESSAGE_BYTES);
				({ outcome, error } = await ingestRawMessage(raw, {
					ctx: deps.ctx,
					bucket: deps.bucket,
					mailbox: deps.mailbox,
					defaultFolder: opts.folder ?? "archive",
					labelCache,
				}));
			} catch (e) {
				outcome = "failed";
				error = (e as Error).message;
			}
		}
		budget.spend();
		index++;
		store.patchJob(deps.ctx, job.id, { cursor: index, add: count({}, outcome), ...(error && outcome === "failed" ? { lastError: error } : {}) });
	}
	return { done: index >= entries.length };
}

// ── single .eml ─────────────────────────────────────────────────────

async function stepEml(deps: StepDeps, job: store.ImportJobRow): Promise<{ done: boolean; error?: string }> {
	if (job.cursor > 0) return { done: true };
	const obj = await deps.bucket.get(job.r2_key!);
	if (!obj) return { done: true, error: "The uploaded file is missing from storage." };
	const raw = new Uint8Array(await obj.arrayBuffer());
	const r = await ingestRawMessage(raw, {
		ctx: deps.ctx,
		bucket: deps.bucket,
		mailbox: deps.mailbox,
		defaultFolder: options(job).folder ?? "archive",
	});
	store.patchJob(deps.ctx, job.id, { cursor: 1, totalMessages: 1, add: count({}, r.outcome) });
	if (r.outcome === "failed") return { done: true, error: r.error ?? "The message could not be read." };
	return { done: true };
}

// ── IMAP ────────────────────────────────────────────────────────────

export interface ImapFolderState extends ImapFolderPlan {
	uidValidity: number | null;
	lastUid: number;
	total: number | null;
	done: boolean;
}

export interface ImapJobState {
	folders: ImapFolderState[];
}

async function openImap(deps: StepDeps, job: store.ImportJobRow): Promise<ImapClient> {
	if (!deps.imap) throw new Error("IMAP import is not available here.");
	const password = await deps.imap.password();
	if (password === null) throw new Error("The saved IMAP password is gone. Start the import again.");
	const transport = await deps.imap.connect(job.imap_host!);
	const client = new ImapClient(transport, { timeoutMs: deps.imap.timeoutMs ?? 30_000, maxLiteralBytes: IMPORT_MAX_MESSAGE_BYTES + 1024 * 1024 });
	try {
		await client.greet();
		await client.login(job.imap_username!, password);
	} catch (e) {
		await transport.close().catch(() => {});
		throw e;
	}
	return client;
}

/** Plan the folders once, from LIST, and count messages for progress. */
export async function planImapFolders(client: ImapClient, only?: string[]): Promise<ImapFolderState[]> {
	const entries = await client.list();
	const plans: ImapFolderState[] = [];
	for (const entry of entries) {
		if (only && only.length > 0 && !only.includes(entry.name) && !only.includes(entry.display)) continue;
		const plan = planImapFolder(entry.display, entry.attributes, entry.delimiter);
		if (plan.skip) continue;
		plans.push({ ...plan, name: entry.name, label: plan.label, uidValidity: null, lastUid: 0, total: null, done: false });
	}
	plans.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
	for (const p of plans) {
		try {
			const s = await client.status(p.name);
			p.total = s.messages;
		} catch {
			p.total = null;
		}
	}
	return plans;
}

async function stepImap(deps: StepDeps, job: store.ImportJobRow, budget: Budget): Promise<{ done: boolean; error?: string }> {
	const client = await openImap(deps, job);
	try {
		let state = store.jobState<ImapJobState>(job);
		if (!state?.folders) {
			const folders = await planImapFolders(client, options(job).folders);
			if (folders.length === 0) return { done: true, error: "No folders to import were found on that account." };
			state = { folders };
			const total = folders.reduce((n, f) => n + (f.total ?? 0), 0);
			store.patchJob(deps.ctx, job.id, { state, totalMessages: total });
		}
		const labelCache = new Map<string, string>();

		for (const folder of state.folders) {
			if (folder.done) continue;
			if (!budget.left) break;
			let box: Awaited<ReturnType<ImapClient["examine"]>>;
			try {
				box = await client.examine(folder.name);
			} catch (e) {
				// A folder the server lists but will not open (deleted meanwhile,
				// no permission): skip it with a note rather than fail the import.
				if (!(e instanceof ImapError) || e.kind !== "no") throw e;
				folder.done = true;
				store.patchJob(deps.ctx, job.id, { state, lastError: `Skipped folder ${folder.name}: ${e.message}` });
				continue;
			}
			if (folder.uidValidity !== null && box.uidValidity !== null && box.uidValidity !== folder.uidValidity) {
				// The server renumbered the folder: start over (dedupe skips what is here).
				folder.lastUid = 0;
			}
			folder.uidValidity = box.uidValidity;
			const uids = box.exists > 0 ? await client.uidsAfter(folder.lastUid) : [];
			if (uids.length === 0) {
				folder.done = true;
				store.patchJob(deps.ctx, job.id, { state });
				continue;
			}

			let i = 0;
			while (i < uids.length && budget.left) {
				if (!stillRunning(deps.ctx, job.id)) return { done: false };
				const slice = uids.slice(i, i + IMAP_FETCH_COUNT);
				const meta = await client.fetchMeta(slice);
				const sizes = new Map(meta.map((m) => [m.uid!, m.size ?? 0]));
				// Walk the slice in UID order: oversized messages are counted and
				// never fetched; the rest are fetched until the byte cap. `k` is how
				// many UIDs of the slice this round settles, always at least one.
				const wanted: number[] = [];
				let bytes = 0;
				let counters: Counters = {};
				let k = 0;
				for (; k < slice.length; k++) {
					const size = sizes.get(slice[k]) ?? 0;
					if (size > IMPORT_MAX_MESSAGE_BYTES) {
						counters = count(counters, "skipped");
						continue;
					}
					if (wanted.length > 0 && bytes + size > IMAP_FETCH_BYTES) break;
					wanted.push(slice[k]);
					bytes += size;
				}
				const items = await client.fetchBodies(wanted);
				const byUid = new Map(items.map((it) => [it.uid!, it]));
				for (const uid of wanted) {
					const item = byUid.get(uid);
					if (!item?.body) {
						// Expunged between SEARCH and FETCH.
						counters = count(counters, "skipped");
						continue;
					}
					const fallback = item.internalDate ? new Date(item.internalDate) : null;
					const r = await ingestRawMessage(item.body, {
						ctx: deps.ctx,
						bucket: deps.bucket,
						mailbox: deps.mailbox,
						defaultFolder: "archive",
						imapPlacement: { plan: folder, flags: item.flags },
						fallbackDate: fallback,
						labelCache,
					});
					counters = count(counters, r.outcome);
					budget.spend();
				}
				folder.lastUid = slice[k - 1];
				i += k;
				store.patchJob(deps.ctx, job.id, { state, add: counters });
			}
			if (i >= uids.length) {
				folder.done = true;
				store.patchJob(deps.ctx, job.id, { state });
			}
		}
		return { done: state.folders.every((f) => f.done) };
	} finally {
		await client.logout();
	}
}
