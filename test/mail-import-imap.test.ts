// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The IMAP client and the IMAP import against scripted servers.
 *
 * Transcripts follow what Dovecot and Gmail send (greeting with CAPABILITY,
 * literals for bodies, special-use LIST attributes), with synthetic content.
 * The scripted server asserts each command it receives, so a client that
 * sends something unexpected (a STORE, a SELECT, BODY[] instead of
 * BODY.PEEK[]) fails the test.
 */

import { describe, expect, it } from "vitest";
import {
	ImapClient,
	ImapError,
	decodeModifiedUtf7,
	parseFetchResponse,
	parseImapResponse,
	parseListResponse,
	tokenizeImap,
	uidSet,
	type ImapTransport,
} from "../workers/lib/imap";
import * as store from "../workers/durableObject/mail-import";
import { runImportStep } from "../workers/lib/mail-import";
import { openImportPassword, sealImportPassword, ImportCredentialStore } from "../workers/lib/import-credential-store";
import { memoryBucket, message } from "./helpers/import-fixtures";
import { mailboxSqlite } from "./helpers/mailbox-sqlite";
import { DatabaseSync } from "node:sqlite";
import { AuthStore } from "../workers/auth/store-core";

const enc = new TextEncoder();
const dec = new TextDecoder();

type Handler = (line: string, tag: string) => string | string[] | null;

/**
 * A scripted IMAP server. Each step matches one client line (regex on the
 * command after the tag) and replies; `{TAG}` in a reply is the client's tag.
 * Replies are delivered in small chunks to exercise buffering.
 */
function scriptedServer(greeting: string, steps: [RegExp, string | ((tag: string, line: string) => string)][]) {
	const sent: string[] = [];
	const queue: Uint8Array[] = [enc.encode(greeting)];
	let waiting: ((v: Uint8Array | null) => void) | null = null;
	let closed = false;
	let pendingLiteral = 0;
	let raw = new Uint8Array(0);
	/** A command split by literals, reassembled with each literal quoted. */
	let command = "";
	const push = (s: string) => {
		const b = enc.encode(s);
		// Chunk at odd sizes so lines and literals straddle reads.
		for (let i = 0; i < b.length; i += 37) queue.push(b.subarray(i, i + 37));
		flush();
	};
	const flush = () => {
		if (waiting && queue.length) {
			const w = waiting;
			waiting = null;
			w(queue.shift()!);
		} else if (waiting && closed) {
			const w = waiting;
			waiting = null;
			w(null);
		}
	};
	const handle = (line: string) => {
		sent.push(line);
		const m = /^(\S+) (.*)$/.exec(line);
		if (!m) throw new Error(`bad client line: ${line}`);
		const [, tag, rest] = m;
		const step = steps.shift();
		if (!step) throw new Error(`unexpected command: ${line}`);
		if (!step[0].test(rest)) throw new Error(`expected ${step[0]} but got: ${rest}`);
		const reply = typeof step[1] === "function" ? step[1](tag, rest) : step[1];
		push(reply.replaceAll("{TAG}", tag));
	};
	const transport: ImapTransport = {
		async read() {
			if (queue.length) return queue.shift()!;
			if (closed) return null;
			return new Promise((resolve) => {
				waiting = resolve;
			});
		},
		async write(chunk) {
			const merged = new Uint8Array(raw.length + chunk.length);
			merged.set(raw);
			merged.set(chunk, raw.length);
			raw = merged;
			for (;;) {
				if (pendingLiteral > 0) {
					if (raw.length < pendingLiteral) return;
					command += `"${dec.decode(raw.subarray(0, pendingLiteral))}"`;
					raw = raw.subarray(pendingLiteral);
					pendingLiteral = 0;
				}
				const i = raw.indexOf(0x0a);
				if (i === -1) return;
				const line = dec.decode(raw.subarray(0, i)).replace(/\r$/, "");
				raw = raw.subarray(i + 1);
				const lit = /\{(\d+)\}$/.exec(line);
				if (lit) {
					// A synchronising literal: the command continues after it.
					sent.push(line);
					command += line.slice(0, lit.index);
					pendingLiteral = Number(lit[1]);
					push("+ go ahead\r\n");
					continue;
				}
				const full = command + line;
				command = "";
				handle(full);
			}
		},
		async close() {
			closed = true;
			flush();
		},
	};
	return { transport, sent, remaining: () => steps.length };
}

const literal = (s: string) => `{${enc.encode(s).length}}\r\n${s}`;

describe("tokenizer and parsers", () => {
	it("tokenizes lists, quoted strings, NIL and sections", () => {
		expect(tokenizeImap('LIST (\\HasNoChildren \\Sent) "/" "[Gmail]/Sent Mail"')).toEqual([
			"LIST",
			["\\HasNoChildren", "\\Sent"],
			"/",
			"[Gmail]/Sent Mail",
		]);
		expect(tokenizeImap('1 FETCH (UID 7 BODY[HEADER.FIELDS (FROM TO)] NIL "a \\"q\\"")')).toEqual([
			"1",
			"FETCH",
			["UID", "7", "BODY[HEADER.FIELDS (FROM TO)]", null, 'a "q"'],
		]);
	});

	it("parses LIST with modified UTF-7 names", () => {
		const entry = parseListResponse(parseImapResponse('* LIST (\\HasNoChildren) "." "Entw&APw-rfe"'));
		expect(entry).toMatchObject({ name: "Entw&APw-rfe", display: "Entwürfe", delimiter: "." });
		expect(decodeModifiedUtf7("&ZeVnLIqe-")).toBe("日本語");
		expect(decodeModifiedUtf7("A&-B")).toBe("A&B");
	});

	it("parses FETCH with a literal body", () => {
		const body = enc.encode("Subject: x\r\n\r\nhi\r\n");
		const r = parseImapResponse("* 1 FETCH (UID 42 FLAGS (\\Seen) INTERNALDATE \"14-Jan-2014 10:00:00 +0000\" BODY[] \u0000LIT)", [body]);
		const item = parseFetchResponse(r)!;
		expect(item).toMatchObject({ uid: 42, flags: ["\\Seen"], internalDate: "14-Jan-2014 10:00:00 +0000" });
		expect(item.body).toEqual(body);
	});

	it("compresses UID sets", () => {
		expect(uidSet([5, 1, 2, 3, 9, 10, 3])).toBe("1:3,5,9:10");
	});
});

describe("ImapClient", () => {
	const GREETING = "* OK [CAPABILITY IMAP4rev1 SASL-IR LOGIN-REFERRALS ID ENABLE IDLE LITERAL+ AUTH=PLAIN] Dovecot ready.\r\n";

	it("logs in with LOGIN, quoting the password", async () => {
		const s = scriptedServer(GREETING, [[/^LOGIN "user@example\.com" "p\\"w\\\\d"$/, "{TAG} OK [CAPABILITY IMAP4rev1 MOVE] Logged in\r\n"]]);
		const c = new ImapClient(s.transport);
		await c.greet();
		expect(c.capabilities.has("AUTH=PLAIN")).toBe(true);
		await c.login("user@example.com", 'p"w\\d');
		expect(c.capabilities.has("MOVE")).toBe(true);
	});

	it("uses AUTHENTICATE PLAIN for non-ASCII credentials", async () => {
		const token = Buffer.from("\0josé\0pässword").toString("base64");
		const s = scriptedServer(GREETING, [[new RegExp(`^AUTHENTICATE PLAIN ${token.replace(/[+/=]/g, "\\$&")}$`), "{TAG} OK Logged in\r\n"]]);
		const c = new ImapClient(s.transport);
		await c.greet();
		await c.login("josé", "pässword");
		expect(s.remaining()).toBe(0);
	});

	it("reports a refused login as an auth error", async () => {
		const s = scriptedServer(GREETING, [[/^LOGIN/, "{TAG} NO [AUTHENTICATIONFAILED] Authentication failed.\r\n"]]);
		const c = new ImapClient(s.transport);
		await c.greet();
		await expect(c.login("u", "bad")).rejects.toMatchObject({ kind: "auth" });
	});

	it("refuses a literal over the limit", async () => {
		const s = scriptedServer(GREETING, [[/^UID FETCH/, "* 1 FETCH (UID 1 BODY[] {999999}\r\n"]]);
		const c = new ImapClient(s.transport, { maxLiteralBytes: 1000 });
		await c.greet();
		await expect(c.fetchBodies([1])).rejects.toBeInstanceOf(ImapError);
	});

	it("times out a silent server", async () => {
		const s = scriptedServer("", []);
		const c = new ImapClient(s.transport, { timeoutMs: 20 });
		await expect(c.greet()).rejects.toMatchObject({ kind: "timeout" });
	});

	it("treats an untagged BYE as closed", async () => {
		const s = scriptedServer(GREETING, [[/^LIST/, "* BYE Server shutting down\r\n"]]);
		const c = new ImapClient(s.transport);
		await c.greet();
		await expect(c.list()).rejects.toMatchObject({ kind: "closed" });
	});

	it("uses EXAMINE and BODY.PEEK[], never SELECT or STORE", async () => {
		const m1 = message({ messageId: "i1@x", subject: "One", eol: "\r\n" });
		const s = scriptedServer(GREETING, [
			[/^EXAMINE "INBOX"$/, "* 1 EXISTS\r\n* OK [UIDVALIDITY 1700000000] UIDs valid\r\n* OK [UIDNEXT 2] Predicted next UID\r\n{TAG} OK [READ-ONLY] Examine completed\r\n"],
			[/^UID SEARCH UID 1:\*$/, "* SEARCH 1\r\n{TAG} OK Search completed\r\n"],
			[/^UID FETCH 1 \(UID FLAGS INTERNALDATE BODY\.PEEK\[\]\)$/, `* 1 FETCH (UID 1 FLAGS () INTERNALDATE "14-Jan-2014 10:00:00 +0000" BODY[] ${literal(m1)})\r\n{TAG} OK Fetch completed\r\n`],
		]);
		const c = new ImapClient(s.transport);
		await c.greet();
		expect(await c.examine("INBOX")).toEqual({ exists: 1, uidValidity: 1700000000, uidNext: 2 });
		expect(await c.uidsAfter(0)).toEqual([1]);
		const [item] = await c.fetchBodies([1]);
		expect(dec.decode(item.body!)).toBe(m1);
		expect(s.sent.some((l) => /\b(SELECT|STORE|EXPUNGE|COPY|MOVE)\b/.test(l))).toBe(false);
	});

	it("filters the always-included highest UID from UID SEARCH n:*", async () => {
		const s = scriptedServer(GREETING, [[/^UID SEARCH UID 11:\*$/, "* SEARCH 10\r\n{TAG} OK\r\n"]]);
		const c = new ImapClient(s.transport);
		await c.greet();
		expect(await c.uidsAfter(10)).toEqual([]);
	});

	it("sends a non-ASCII mailbox name as a synchronising literal", async () => {
		const s = scriptedServer(GREETING, [[/^EXAMINE "Entwürfe"$/, "* 0 EXISTS\r\n{TAG} OK\r\n"]]);
		const c = new ImapClient(s.transport);
		await c.greet();
		await c.examine("Entwürfe");
		// 9 bytes in UTF-8, announced and acknowledged before the bytes are sent.
		expect(s.sent[0]).toMatch(/^T\d+ EXAMINE \{9\}$/);
		expect(s.remaining()).toBe(0);
	});
});

// ── Full IMAP import ────────────────────────────────────────────────

function gmailLike(
	messages: Record<string, { uid: number; raw: string; flags?: string; reportSize?: number }[]>,
	opts: { failAfterFetches?: number } = {},
) {
	let fetches = 0;
	const sessions: string[][] = [];
	const connect = async () => {
		const box: { name: string | null } = { name: null };
		const steps: [RegExp, string | ((tag: string, line: string) => string)][] = [];
		const handler = (tag: string, line: string): string => {
			if (/^CAPABILITY$/.test(line)) return `* CAPABILITY IMAP4rev1 UNSELECT ID IDLE AUTH=PLAIN SASL-IR\r\n${tag} OK Thats all she wrote!\r\n`;
			if (/^CAPABILITY$/.test(line)) return `* CAPABILITY IMAP4rev1 UNSELECT ID IDLE AUTH=PLAIN SASL-IR\r\n${tag} OK Thats all she wrote!\r\n`;
			if (/^LOGIN /.test(line)) return `${tag} OK [CAPABILITY IMAP4rev1] Logged in\r\n`;
			if (/^LIST "" "\*"$/.test(line)) {
				return [
					'* LIST (\\HasNoChildren) "/" "INBOX"',
					'* LIST (\\HasChildren \\Noselect) "/" "[Gmail]"',
					'* LIST (\\All \\HasNoChildren) "/" "[Gmail]/All Mail"',
					'* LIST (\\Drafts \\HasNoChildren) "/" "[Gmail]/Drafts"',
					'* LIST (\\HasNoChildren \\Sent) "/" "[Gmail]/Sent Mail"',
					'* LIST (\\Flagged \\HasNoChildren) "/" "[Gmail]/Starred"',
					'* LIST (\\HasNoChildren) "/" "Receipts"',
					`${tag} OK Success\r\n`,
				].join("\r\n");
			}
			const status = /^STATUS "(.+)" \(MESSAGES UIDNEXT UIDVALIDITY\)$/.exec(line);
			if (status) {
				const n = (messages[status[1]] ?? []).length;
				return `* STATUS "${status[1]}" (MESSAGES ${n} UIDNEXT ${n + 1} UIDVALIDITY 1)\r\n${tag} OK\r\n`;
			}
			const ex = /^EXAMINE "(.+)"$/.exec(line);
			if (ex) {
				box.name = ex[1];
				const n = (messages[ex[1]] ?? []).length;
				if (!(ex[1] in messages)) return `${tag} NO [NONEXISTENT] Unknown Mailbox\r\n`;
				return `* ${n} EXISTS\r\n* OK [UIDVALIDITY 1] UIDs valid.\r\n${tag} OK [READ-ONLY] ${ex[1]} selected.\r\n`;
			}
			const search = /^UID SEARCH UID (\d+):\*$/.exec(line);
			if (search) {
				const from = Number(search[1]);
				const all = (messages[box.name!] ?? []).map((m) => m.uid);
				const hits = all.filter((u) => u >= from);
				if (hits.length === 0 && all.length) hits.push(Math.max(...all));
				return `* SEARCH ${hits.join(" ")}\r\n${tag} OK SEARCH completed\r\n`;
			}
			const meta = /^UID FETCH ([\d:,]+) \(UID FLAGS RFC822\.SIZE\)$/.exec(line);
			const body = /^UID FETCH ([\d:,]+) \(UID FLAGS INTERNALDATE BODY\.PEEK\[\]\)$/.exec(line);
			if (meta || body) {
				const set = expand((meta ?? body)![1]);
				const list = (messages[box.name!] ?? []).filter((m) => set.has(m.uid));
				if (body) {
					fetches++;
					if (opts.failAfterFetches !== undefined && fetches > opts.failAfterFetches) return "* BYE connection reset\r\n";
				}
				const lines = list.map((m, i) =>
					meta
						? `* ${i + 1} FETCH (UID ${m.uid} FLAGS (${m.flags ?? ""}) RFC822.SIZE ${m.reportSize ?? enc.encode(m.raw).length})`
						: `* ${i + 1} FETCH (UID ${m.uid} FLAGS (${m.flags ?? ""}) INTERNALDATE "14-Jan-2014 10:00:00 +0000" BODY[] ${literal(m.raw)})`,
				);
				return `${lines.join("\r\n")}${lines.length ? "\r\n" : ""}${tag} OK Success\r\n`;
			}
			if (/^LOGOUT$/.test(line)) return `* BYE LOGOUT Requested\r\n${tag} OK 73 good day\r\n`;
			throw new Error(`unexpected IMAP command: ${line}`);
		};
		for (let i = 0; i < 500; i++) steps.push([/.*/, handler]);
		const s = scriptedServer("* OK Gimap ready\r\n", steps);
		sessions.push(s.sent);
		return s.transport;
	};
	return { connect, sessions };
}

function expand(set: string): Set<number> {
	const out = new Set<number>();
	for (const part of set.split(",")) {
		const [a, b] = part.split(":").map(Number);
		for (let u = a; u <= (b ?? a); u++) out.add(u);
	}
	return out;
}

describe("IMAP import", () => {
	const mk = (id: string, extra: Partial<Parameters<typeof message>[0]> = {}) => message({ messageId: id, eol: "\r\n", ...extra });

	function setup(mailboxes: Parameters<typeof gmailLike>[0], opts?: Parameters<typeof gmailLike>[1]) {
		const db = mailboxSqlite();
		const bucket = memoryBucket();
		const server = gmailLike(mailboxes, opts);
		store.createJob(db.ctx, {
			id: "imp_imap",
			source: "imap",
			status: "queued",
			label: "me@imap.example.com",
			mailbox: "me@example.com",
			imapHost: "imap.example.com",
			imapUsername: "me@example.com",
		});
		let password: string | null = "app-password";
		const deps = {
			ctx: db.ctx,
			bucket,
			mailbox: "me@example.com",
			imap: { connect: server.connect, password: async () => password, timeoutMs: 2000 },
		};
		return { ...db, bucket, server, deps, dropPassword: () => (password = null) };
	}

	it("imports Inbox, user folders, Sent and All Mail; labels duplicates; skips Drafts and Starred", async () => {
		const env = setup({
			INBOX: [
				{ uid: 1, raw: mk("g1@x", { subject: "Inbox unread" }) },
				{ uid: 2, raw: mk("g2@x", { subject: "Inbox read" }), flags: "\\Seen \\Flagged" },
			],
			Receipts: [{ uid: 5, raw: mk("g2@x") }, { uid: 6, raw: mk("g3@x", { subject: "Receipt only" }) }],
			"[Gmail]/Sent Mail": [{ uid: 1, raw: mk("g4@x", { from: "me@example.com" }), flags: "\\Seen" }],
			"[Gmail]/All Mail": [
				{ uid: 1, raw: mk("g1@x") },
				{ uid: 2, raw: mk("g2@x") },
				{ uid: 3, raw: mk("g3@x") },
				{ uid: 4, raw: mk("g4@x", { from: "me@example.com" }) },
				{ uid: 9, raw: mk("g5@x", { subject: "Archived only" }), flags: "\\Seen" },
			],
		});
		for (let i = 0; i < 20; i++) {
			const r = await runImportStep(env.deps);
			if (!r.more) break;
		}
		const job = store.getJob(env.ctx, "imp_imap")!;
		expect([job.status, job.last_error]).toEqual(["completed", null]);
		expect(job.imported).toBe(5);
		expect(job.duplicates).toBe(5);
		const rows = env.db.prepare(`SELECT message_id, folder_id, read, starred, imported FROM emails ORDER BY message_id`).all();
		expect(rows).toEqual([
			{ message_id: "g1@x", folder_id: "inbox", read: 0, starred: 0, imported: 1 },
			{ message_id: "g2@x", folder_id: "inbox", read: 1, starred: 1, imported: 1 },
			{ message_id: "g3@x", folder_id: "archive", read: 0, starred: 0, imported: 1 },
			{ message_id: "g4@x", folder_id: "sent", read: 1, starred: 0, imported: 1 },
			{ message_id: "g5@x", folder_id: "archive", read: 1, starred: 0, imported: 1 },
		]);
		const labelled = env.db
			.prepare(`SELECT e.message_id AS mid FROM email_labels el JOIN labels l ON l.id = el.label_id JOIN emails e ON e.id = el.email_id WHERE l.name = 'Receipts' ORDER BY mid`)
			.all();
		expect(labelled).toEqual([{ mid: "g2@x" }, { mid: "g3@x" }]);
		// Read-only: no SELECT/STORE ever sent; Drafts and Starred never examined.
		const all = env.server.sessions.flat();
		expect(all.some((l) => /\b(SELECT|STORE|EXPUNGE)\b/.test(l))).toBe(false);
		expect(all.some((l) => /Drafts|Starred/.test(l) && /EXAMINE/.test(l))).toBe(false);
		expect(all.filter((l) => /LOGOUT/.test(l)).length).toBe(env.server.sessions.length);
		const view = store.toJobView(job);
		expect(view.imap).toMatchObject({ host: "imap.example.com", folders_total: 4, folders_done: 4, current_folder: null });
	});

	it("resumes from the saved UID after the connection drops", async () => {
		const inbox = Array.from({ length: 60 }, (_, i) => ({ uid: i + 1, raw: mk(`r${i}@x`) }));
		const env = setup({ INBOX: inbox }, { failAfterFetches: 1 });
		const first = await runImportStep(env.deps);
		// The BYE fails the step after the first batch of 25 was stored.
		const job = store.getJob(env.ctx, "imp_imap")!;
		expect(first.finished?.status).toBe("failed");
		expect(job.imported).toBe(25);
		const state = store.jobState<{ folders: { name: string; lastUid: number }[] }>(job)!;
		expect(state.folders.find((f) => f.name === "INBOX")!.lastUid).toBe(25);
		// A fresh run (same cursor, a healthy server) finishes without duplicates.
		env.db.prepare(`UPDATE import_jobs SET status = 'queued', finished_at = NULL WHERE id = 'imp_imap'`).run();
		const healthy = gmailLike({ INBOX: inbox });
		for (let i = 0; i < 10; i++) {
			const r = await runImportStep({ ...env.deps, imap: { ...env.deps.imap, connect: healthy.connect } });
			if (!r.more) break;
		}
		expect(store.getJob(env.ctx, "imp_imap")).toMatchObject({ status: "completed", imported: 60, duplicates: 0 });
		expect(healthy.sessions[0].some((l) => /UID SEARCH UID 26:\*/.test(l))).toBe(true);
	});

	it("skips messages over the size cap without fetching them", async () => {
		// The server reports UID 2 as 30 MB: it is counted and never fetched.
		const env = setup({
			INBOX: [
				{ uid: 1, raw: mk("small@x") },
				{ uid: 2, raw: mk("huge@x"), reportSize: 30 * 1024 * 1024 },
				{ uid: 3, raw: mk("after@x") },
			],
		});
		for (let i = 0; i < 5; i++) {
			const r = await runImportStep(env.deps);
			if (!r.more) break;
		}
		const job = store.getJob(env.ctx, "imp_imap")!;
		expect(job.status).toBe("completed");
		expect(job).toMatchObject({ imported: 2, skipped: 1 });
		const fetched = env.server.sessions.flat().filter((l) => /BODY\.PEEK/.test(l));
		expect(fetched.every((l) => !/\b2\b/.test(l.split(" ")[3]))).toBe(true);
	});

	it("fails with a clear message when the password is gone", async () => {
		const env = setup({ INBOX: [] });
		env.dropPassword();
		const r = await runImportStep(env.deps);
		expect(r.finished?.status).toBe("failed");
		expect(r.finished?.last_error).toMatch(/password/i);
	});
});

// ── Credential at rest ──────────────────────────────────────────────

function authSql() {
	const db = new DatabaseSync(":memory:");
	const sql = {
		exec(query: string, ...bindings: unknown[]) {
			const stmt = db.prepare(query);
			if (/^\s*(select|with|pragma)/i.test(query) || /\breturning\b/i.test(query)) {
				const rows = stmt.all(...(bindings as never[]));
				return { toArray: () => rows };
			}
			stmt.run(...(bindings as never[]));
			return { toArray: () => [] };
		},
	};
	const tx = <T>(fn: () => T) => fn();
	new AuthStore(sql, tx);
	return { db, sql, tx };
}

describe("IMAP password at rest", () => {
	it("is encrypted, bound to the job, and deleted", async () => {
		const { db, sql, tx } = authSql();
		const s = new ImportCredentialStore(sql, tx);
		const secret = "k".repeat(32);
		const enc1 = await sealImportPassword("hunter2 app pw", secret, "imp_a");
		expect(enc1).toMatch(/^v1\./);
		expect(enc1).not.toContain("hunter2");
		s.put({ jobId: "imp_a", mailboxId: "me@example.com", secretEnc: enc1, now: 1 });
		const raw = db.prepare(`SELECT secret_enc FROM import_credentials`).get() as { secret_enc: string };
		expect(raw.secret_enc).toBe(enc1);
		expect(await openImportPassword(s.get("imp_a", "me@example.com")!, secret, "imp_a")).toBe("hunter2 app pw");
		// Another mailbox cannot read it; another job id cannot decrypt it; nor can the wrong key.
		expect(s.get("imp_a", "other@example.com")).toBeNull();
		await expect(openImportPassword(enc1, secret, "imp_b")).rejects.toThrow();
		await expect(openImportPassword(enc1, "x".repeat(32), "imp_a")).rejects.toThrow();
		// Not interchangeable with a TOTP ciphertext.
		const { decryptSecret } = await import("../workers/auth/crypto");
		await expect(decryptSecret(enc1, secret)).rejects.toThrow();
		expect(s.delete("imp_a")).toBe(true);
		expect(s.get("imp_a", "me@example.com")).toBeNull();
		expect(db.prepare(`SELECT COUNT(*) AS n FROM import_credentials`).get()).toEqual({ n: 0 });
	});
});
