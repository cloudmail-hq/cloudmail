// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Writing a mailbox out as mbox.
 *
 * The acceptance criterion for an archive format is not "it looks right" but
 * "reading it back yields the messages that went in". So the centrepiece here is
 * `splitMbox`, a minimal reader that splits on `From ` lines exactly as a real
 * mbox parser does, used to assert that a body containing a `From ` line does not
 * silently become two messages.
 *
 * The paged export query is exercised against real `node:sqlite`, because the
 * property that matters — that a cursor page cannot skip or duplicate a row while
 * mail is arriving — is a property of the SQL, not of the helper around it.
 */

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
	exportHeaders,
	mboxFromLine,
	messageToMbox,
	quoteFromLines,
	type ExportableMessage,
} from "../shared/mbox";
import { headerValue, parseHeaderLines } from "../shared/headers";

/** What the inbound path stores in `raw_headers`. */
function storedHeaders(fields: Record<string, string>): string {
	return JSON.stringify(
		Object.entries(fields).map(([key, value]) => ({ key, value })),
	);
}

/**
 * A minimal mbox reader, of the kind this format has to survive.
 *
 * Splits on a line beginning `From ` at the start of a message, which is all the
 * format offers and exactly why body lines have to be quoted.
 */
function splitMbox(text: string): { fromLine: string; headers: string; body: string }[] {
	const out: { fromLine: string; headers: string; body: string }[] = [];
	const lines = text.split("\r\n");

	let current: { fromLine: string; lines: string[] } | null = null;
	for (const line of lines) {
		if (line.startsWith("From ")) {
			if (current) out.push(finish(current));
			current = { fromLine: line, lines: [] };
			continue;
		}
		current?.lines.push(line);
	}
	if (current) out.push(finish(current));

	return out;

	function finish(entry: { fromLine: string; lines: string[] }) {
		const blank = entry.lines.indexOf("");
		const headers = (blank === -1 ? entry.lines : entry.lines.slice(0, blank)).join("\r\n");
		const body = blank === -1 ? "" : entry.lines.slice(blank + 1).join("\r\n");
		return { fromLine: entry.fromLine, headers, body: body.replace(/(\r\n)+$/, "") };
	}
}

describe("mboxFromLine", () => {
	it("uses asctime, which is the shape readers expect", () => {
		// "Mon Jan  2 15:04:05 2006" — day of month space-padded, not zero-padded.
		expect(mboxFromLine("ada@example.com", "2026-09-01T09:05:00.000Z")).toBe(
			"From ada@example.com Tue Sep  1 09:05:00 2026",
		);
	});

	it("falls back to MAILER-DAEMON when there is no sender", () => {
		// The line is structural, so it has to exist even for a row with no sender.
		expect(mboxFromLine(null, "2026-09-01T09:05:00.000Z")).toMatch(
			/^From MAILER-DAEMON /,
		);
		expect(mboxFromLine("   ", "2026-09-01T09:05:00.000Z")).toMatch(
			/^From MAILER-DAEMON /,
		);
	});

	it("never emits whitespace inside the address, which would split the line", () => {
		expect(mboxFromLine("Ada Lovelace <ada@example.com>", null)).toBe(
			"From AdaLovelace<ada@example.com> Thu Jan  1 00:00:00 1970",
		);
	});

	it("survives an unparseable date", () => {
		expect(mboxFromLine("ada@example.com", "not a date")).toMatch(/1970$/);
		expect(mboxFromLine("ada@example.com", null)).toMatch(/1970$/);
	});
});

describe("quoteFromLines", () => {
	it("quotes a body line that would be read as a separator", () => {
		// The corruption this prevents: without the `>`, a reader splits the archive
		// here and misattributes every message after it.
		expect(quoteFromLines("Hello\r\nFrom the desk of the CEO:\r\nRegards")).toBe(
			"Hello\r\n>From the desk of the CEO:\r\nRegards",
		);
	});

	it("quotes already-quoted forms so the transformation is reversible", () => {
		// mboxrd. Stripping exactly one `>` from any `>+From ` line recovers the
		// original, which mboxo cannot do.
		expect(quoteFromLines(">From quoted")).toBe(">>From quoted");
		expect(quoteFromLines(">>From twice")).toBe(">>>From twice");
	});

	it("leaves text alone that only resembles a separator", () => {
		// No trailing space, so not a separator.
		expect(quoteFromLines("Fromage is cheese")).toBe("Fromage is cheese");
		// Not at the start of a line.
		expect(quoteFromLines("a note From me")).toBe("a note From me");
	});
});

describe("exportHeaders", () => {
	const message: ExportableMessage = {
		id: "e1",
		subject: "Quarterly planning",
		sender: "ada@example.com",
		recipient: "grace@example.com",
		cc: "alan@example.com",
		date: "2026-09-01T09:05:00.000Z",
		body: "<p>Hi</p>",
		message_id: "abc@example.com",
		in_reply_to: "parent@example.com",
		email_references: JSON.stringify(["root@example.com", "parent@example.com"]),
		folder_id: "inbox",
		read: 1,
		starred: 1,
	};

	it("reconstructs the headers a reader needs", () => {
		const headers = exportHeaders(message);

		expect(headerValue(headers, "From")).toBe("ada@example.com");
		expect(headerValue(headers, "To")).toBe("grace@example.com");
		expect(headerValue(headers, "Cc")).toBe("alan@example.com");
		expect(headerValue(headers, "Subject")).toBe("Quarterly planning");
		expect(headerValue(headers, "Date")).toBe("Tue, 01 Sep 2026 09:05:00 GMT");
	});

	it("brackets message ids and joins References per RFC 5322", () => {
		const headers = exportHeaders(message);
		expect(headerValue(headers, "Message-ID")).toBe("<abc@example.com>");
		expect(headerValue(headers, "In-Reply-To")).toBe("<parent@example.com>");
		expect(headerValue(headers, "References")).toBe(
			"<root@example.com> <parent@example.com>",
		);
	});

	it("does not double-bracket ids that already carry brackets", () => {
		const headers = exportHeaders({ ...message, message_id: "<abc@example.com>" });
		expect(headerValue(headers, "Message-ID")).toBe("<abc@example.com>");
	});

	it("prefers the sender's own headers and does not duplicate them", () => {
		// A field appearing twice is malformed and readers disagree about which wins,
		// so the stored value has to suppress the reconstructed one.
		const headers = exportHeaders({
			...message,
			raw_headers: storedHeaders({
				Subject: "What the sender actually wrote",
				From: "Ada Lovelace <ada@example.com>",
			}),
		});

		expect(headers.filter((h) => h.key.toLowerCase() === "subject")).toHaveLength(1);
		expect(headerValue(headers, "Subject")).toBe("What the sender actually wrote");
		expect(headerValue(headers, "From")).toBe("Ada Lovelace <ada@example.com>");
		// Still topped up with the fields the stored blob lacked.
		expect(headerValue(headers, "To")).toBe("grace@example.com");
	});

	it("records the folder and the read/starred flags", () => {
		const headers = exportHeaders(message);
		expect(headerValue(headers, "X-Tapetide-Folder")).toBe("inbox");
		// `R` read, `O` old — what mutt and Thunderbird read.
		expect(headerValue(headers, "Status")).toBe("RO");
		expect(headerValue(headers, "X-Status")).toBe("F");
	});

	it("marks an unread message as unread", () => {
		const headers = exportHeaders({ ...message, read: 0, starred: 0 });
		expect(headerValue(headers, "Status")).toBe("O");
		expect(headerValue(headers, "X-Status")).toBeNull();
	});

	it("keeps Bcc, because this is the owner's own archive", () => {
		const headers = exportHeaders({ ...message, bcc: "secret@example.com" });
		expect(headerValue(headers, "Bcc")).toBe("secret@example.com");
	});

	it("omits fields it has no value for rather than emitting empty ones", () => {
		const headers = exportHeaders({ id: "e2", body: "hi" });
		expect(headerValue(headers, "Subject")).toBeNull();
		expect(headerValue(headers, "To")).toBeNull();
		expect(headerValue(headers, "References")).toBeNull();
		// Structural headers are still present.
		expect(headerValue(headers, "MIME-Version")).toBe("1.0");
	});

	it("ignores a malformed References blob instead of throwing", () => {
		expect(headerValue(exportHeaders({ ...message, email_references: "{oops" }), "References")).toBeNull();
		expect(headerValue(exportHeaders({ ...message, email_references: '"str"' }), "References")).toBeNull();
	});
});

describe("MIME headers", () => {
	it("drops the original structure headers, which describe bytes that are gone", () => {
		// The stored body is decoded and de-multiparted, so the original
		// `multipart/alternative; boundary=...` describes a structure the exported
		// message does not have — a reader looking for that boundary shows a blank
		// message. A retained `base64` is worse: the client decodes plain text.
		const headers = exportHeaders({
			id: "e1",
			sender: "a@example.com",
			body: "<p>Hi</p>",
			raw_headers: storedHeaders({
				From: "a@example.com",
				Subject: "Kept",
				"Content-Type": 'multipart/alternative; boundary="XYZ"',
				"Content-Transfer-Encoding": "base64",
				"Content-Length": "99999",
				"MIME-Version": "1.0",
			}),
		});

		expect(headerValue(headers, "Content-Type")).toBe('text/html; charset="utf-8"');
		expect(headerValue(headers, "Content-Transfer-Encoding")).toBe("8bit");
		// The stale byte count is gone, not carried over.
		expect(headerValue(headers, "Content-Length")).toBeNull();
		// Exactly one of each, not the original plus the replacement.
		expect(headers.filter((h) => h.key.toLowerCase() === "content-type")).toHaveLength(1);
		expect(
			headers.filter((h) => h.key.toLowerCase() === "mime-version"),
		).toHaveLength(1);
		// Everything descriptive survives.
		expect(headerValue(headers, "Subject")).toBe("Kept");
	});

	it("declares a plain-text body as text/plain", () => {
		// Declaring plain text as HTML makes a client swallow the line breaks and
		// render one run-on paragraph.
		const headers = exportHeaders({
			id: "e1",
			sender: "a@example.com",
			body: "Line one\nLine two",
		});
		expect(headerValue(headers, "Content-Type")).toBe('text/plain; charset="utf-8"');
	});

	it("always declares the three MIME headers, even with no stored headers", () => {
		const headers = exportHeaders({ id: "e1", body: "<p>hi</p>" });
		expect(headerValue(headers, "MIME-Version")).toBe("1.0");
		expect(headerValue(headers, "Content-Type")).toBe('text/html; charset="utf-8"');
		expect(headerValue(headers, "Content-Transfer-Encoding")).toBe("8bit");
	});
});

// -- Round trip ----------------------------------------------------

describe("messageToMbox", () => {
	it("round-trips a message through a reader", () => {
		const text = messageToMbox({
			id: "e1",
			subject: "Hello",
			sender: "ada@example.com",
			recipient: "grace@example.com",
			date: "2026-09-01T09:05:00.000Z",
			body: "<p>First line</p>",
			read: 1,
		});

		const parsed = splitMbox(text);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]!.fromLine).toBe("From ada@example.com Tue Sep  1 09:05:00 2026");
		expect(headerValue(parseHeaderLines(parsed[0]!.headers), "Subject")).toBe("Hello");
		expect(parsed[0]!.body).toBe("<p>First line</p>");
	});

	it("does not let a body From line split one message into two", () => {
		// The whole reason quoting exists. A reader must see one message.
		const text = messageToMbox({
			id: "e1",
			sender: "ada@example.com",
			date: "2026-09-01T09:05:00.000Z",
			subject: "Note",
			body: "Hello\nFrom the desk of the CEO:\nRegards",
		});

		const parsed = splitMbox(text);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]!.body).toBe("Hello\r\n>From the desk of the CEO:\r\nRegards");
	});

	it("keeps consecutive messages separable", () => {
		const text =
			messageToMbox({
				id: "e1",
				sender: "ada@example.com",
				date: "2026-09-01T09:00:00.000Z",
				subject: "One",
				body: "first",
			}) +
			messageToMbox({
				id: "e2",
				sender: "grace@example.com",
				date: "2026-09-02T09:00:00.000Z",
				subject: "Two",
				body: "second",
			});

		const parsed = splitMbox(text);
		expect(parsed).toHaveLength(2);
		expect(parsed.map((m) => m.body)).toEqual(["first", "second"]);
		expect(
			parsed.map((m) => headerValue(parseHeaderLines(m.headers), "Subject")),
		).toEqual(["One", "Two"]);
	});

	it("normalises line endings to CRLF", () => {
		const text = messageToMbox({
			id: "e1",
			sender: "a@example.com",
			date: "2026-09-01T09:00:00.000Z",
			body: "one\ntwo\r\nthree\rfour",
		});
		expect(splitMbox(text)[0]!.body).toBe("one\r\ntwo\r\nthree\r\nfour");
	});

	it("names attachments rather than inlining them", () => {
		// Bodies are exported; blobs are not. Naming them is what stops an
		// attachment being silently absent from the archive.
		const text = messageToMbox(
			{ id: "e1", sender: "a@example.com", date: "2026-09-01T09:00:00.000Z", body: "hi" },
			[{ filename: "budget.pdf", mimetype: "application/pdf", size: 12345 }],
		);

		expect(headerValue(parseHeaderLines(splitMbox(text)[0]!.headers), "X-Tapetide-Attachment")).toBe(
			"budget.pdf; type=application/pdf; size=12345",
		);
	});

	it("handles an empty body", () => {
		const parsed = splitMbox(
			messageToMbox({ id: "e1", sender: "a@example.com", date: "2026-09-01T09:00:00.000Z" }),
		);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]!.body).toBe("");
	});
});

// -- The paged query, against real SQLite --------------------------

/**
 * The export's cursor paging, run against a real database.
 *
 * Keyset paging rather than OFFSET is the point: a message arriving mid-export
 * shifts every later offset, so an offset-paged export drops rows from the archive
 * — silently, and only on a busy mailbox. These assert the property directly.
 */
function exportQuery(
	db: DatabaseSync,
	limit: number,
	after?: { date: string; id: string },
) {
	return after === undefined
		? db.prepare(`SELECT id, date FROM emails ORDER BY date ASC, id ASC LIMIT ?`).all(limit)
		: db
				.prepare(
					`SELECT id, date FROM emails
					 WHERE (date > ?) OR (date = ? AND id > ?)
					 ORDER BY date ASC, id ASC LIMIT ?`,
				)
				.all(after.date, after.date, after.id, limit);
}

function seed(rows: { id: string; date: string }[]): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec(`CREATE TABLE emails (id TEXT PRIMARY KEY, date TEXT)`);
	const insert = db.prepare(`INSERT INTO emails (id, date) VALUES (?, ?)`);
	for (const row of rows) insert.run(row.id, row.date);
	return db;
}

/** Page through everything, as the streaming endpoint does. */
function pageAll(db: DatabaseSync, limit: number): string[] {
	const seen: string[] = [];
	let cursor: { date: string; id: string } | undefined;

	for (let guard = 0; guard < 100; guard += 1) {
		const page = exportQuery(db, limit, cursor) as { id: string; date: string }[];
		if (page.length === 0) break;
		seen.push(...page.map((row) => row.id));
		const last = page[page.length - 1]!;
		cursor = { date: last.date, id: last.id };
		if (page.length < limit) break;
	}

	return seen;
}

// -- The streaming response ----------------------------------------

/**
 * The export endpoint's streaming behaviour, reproduced against a stub stub.
 *
 * Mounted as a local Hono route mirroring `workers/index.ts` rather than importing
 * the real app, which needs Worker bindings. What is asserted is what the streaming
 * shape has to guarantee and a helper test cannot see: that pages are pulled
 * lazily rather than all at once, that the whole mailbox arrives, and — the one
 * that matters most — that a failure partway through aborts rather than closing.
 * A closed stream is a complete file, so an error that closes produces a truncated
 * archive the reader would keep.
 */
function exportApp(pages: (
	| { messages: ExportableMessage[]; done: boolean; cursor?: { date: string; id: string } }
	| { throws: true }
)[]) {
	const pulls: number[] = [];
	const app = new Hono();

	app.get("/export", (c) => {
		const encoder = new TextEncoder();
		let index = 0;

		const stream = new ReadableStream<Uint8Array>({
			async pull(controller) {
				pulls.push(index);
				const page = pages[index];
				index += 1;

				if (!page || "throws" in page) {
					controller.error(new Error("read failed"));
					return;
				}

				for (const message of page.messages) {
					controller.enqueue(encoder.encode(messageToMbox(message, [])));
				}
				if (page.done || !page.cursor) controller.close();
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "application/mbox",
				"Content-Disposition": 'attachment; filename="mailbox.mbox"',
			},
		});
	});

	return {
		pulls,
		fetch: () => app.fetch(new Request("https://mailer.tapetide.com/export")),
	};
}

function message(id: string, subject: string, date: string): ExportableMessage {
	return { id, subject, sender: `${id}@example.com`, date, body: `body of ${id}` };
}

describe("export response", () => {
	it("serves application/mbox as an attachment", async () => {
		const { fetch } = exportApp([
			{ messages: [message("e1", "One", "2026-09-01T09:00:00.000Z")], done: true },
		]);
		const res = await fetch();

		// RFC 4155 registers this media type for the format.
		expect(res.headers.get("Content-Type")).toBe("application/mbox");
		expect(res.headers.get("Content-Disposition")).toContain("attachment");
		// No Content-Length: the size is not known until the last page is read, and a
		// wrong one truncates the download.
		expect(res.headers.get("Content-Length")).toBeNull();
	});

	it("streams every page into one archive", async () => {
		const { fetch } = exportApp([
			{
				messages: [message("e1", "One", "2026-09-01T09:00:00.000Z")],
				done: false,
				cursor: { date: "2026-09-01T09:00:00.000Z", id: "e1" },
			},
			{ messages: [message("e2", "Two", "2026-09-02T09:00:00.000Z")], done: true },
		]);

		const parsed = splitMbox(await (await fetch()).text());
		expect(
			parsed.map((m) => headerValue(parseHeaderLines(m.headers), "Subject")),
		).toEqual(["One", "Two"]);
	});

	it("does not read the whole mailbox before sending anything", async () => {
		// Lazy pulls are the property that keeps peak memory at one page. If the
		// stream eagerly drained every page this would show all three pulls before
		// the first byte was consumed.
		const { pulls, fetch } = exportApp([
			{
				messages: [message("e1", "One", "2026-09-01T09:00:00.000Z")],
				done: false,
				cursor: { date: "2026-09-01T09:00:00.000Z", id: "e1" },
			},
			{
				messages: [message("e2", "Two", "2026-09-02T09:00:00.000Z")],
				done: false,
				cursor: { date: "2026-09-02T09:00:00.000Z", id: "e2" },
			},
			{ messages: [message("e3", "Three", "2026-09-03T09:00:00.000Z")], done: true },
		]);

		const res = await fetch();
		const reader = res.body!.getReader();
		await reader.read();
		// One page produced the first chunk; the rest are still unread.
		expect(pulls.length).toBeLessThan(3);
		await reader.cancel();
	});

	it("aborts rather than truncating when a page fails", async () => {
		// The failure mode this guards: `controller.close()` on error would deliver a
		// short file that looks like a successful download.
		const { fetch } = exportApp([
			{
				messages: [message("e1", "One", "2026-09-01T09:00:00.000Z")],
				done: false,
				cursor: { date: "2026-09-01T09:00:00.000Z", id: "e1" },
			},
			{ throws: true },
		]);

		const res = await fetch();
		await expect(res.text()).rejects.toThrow();
	});
});

describe("export paging", () => {
	it("visits every message exactly once", () => {
		const db = seed(
			Array.from({ length: 10 }, (_, i) => ({
				id: `e${i}`,
				date: `2026-09-${String(i + 1).padStart(2, "0")}T09:00:00.000Z`,
			})),
		);

		const seen = pageAll(db, 3);
		expect(seen).toHaveLength(10);
		expect(new Set(seen).size).toBe(10);
		db.close();
	});

	it("does not stall or repeat when many messages share a timestamp", () => {
		// A bulk send lands many rows on one timestamp. Paging on `date` alone would
		// either loop forever on the same page or skip the rest of the group; the
		// `id` tiebreak is what prevents both.
		const db = seed(
			Array.from({ length: 7 }, (_, i) => ({
				id: `e${i}`,
				date: "2026-09-01T09:00:00.000Z",
			})),
		);

		const seen = pageAll(db, 2);
		expect(seen).toEqual(["e0", "e1", "e2", "e3", "e4", "e5", "e6"]);
		db.close();
	});

	it("does not drop a message when new mail arrives mid-export", () => {
		// The failure an OFFSET-paged export has: inserting a row before the cursor
		// shifts everything after it, so a message is skipped entirely.
		const db = seed([
			{ id: "e1", date: "2026-09-01T09:00:00.000Z" },
			{ id: "e2", date: "2026-09-02T09:00:00.000Z" },
			{ id: "e3", date: "2026-09-03T09:00:00.000Z" },
			{ id: "e4", date: "2026-09-04T09:00:00.000Z" },
		]);

		const first = exportQuery(db, 2) as { id: string; date: string }[];
		expect(first.map((r) => r.id)).toEqual(["e1", "e2"]);

		// Older mail arrives — a backdated message, which is what a delayed delivery
		// looks like. It sorts before the cursor and is legitimately missed by this
		// run; what must not happen is losing one of the messages still to come.
		db.prepare(`INSERT INTO emails (id, date) VALUES (?, ?)`).run(
			"late",
			"2026-09-01T08:00:00.000Z",
		);

		const last = first[first.length - 1]!;
		const rest = exportQuery(db, 10, { date: last.date, id: last.id }) as {
			id: string;
		}[];
		expect(rest.map((r) => r.id)).toEqual(["e3", "e4"]);
		db.close();
	});

	/**
	 * The byte budget, reproduced over the same loop the DO runs.
	 *
	 * A row limit alone does not bound memory: a body may approach the 5 MiB message
	 * limit, so 50 rows can be 250 MiB — which defeats the streaming the export
	 * exists to do.
	 */
	function budgetPage(
		bodies: number[],
		limit: number,
		budget: number,
	): { kept: number; done: boolean } {
		const all = bodies.slice(0, limit);
		const kept: number[] = [];
		let bytes = 0;
		for (const size of all) {
			if (kept.length > 0 && bytes + size > budget) break;
			kept.push(size);
			bytes += size;
		}
		return {
			kept: kept.length,
			done: all.length < limit && kept.length === all.length,
		};
	}

	it("shortens a page of large messages instead of shipping all of it", () => {
		// Five 3 MiB bodies against an 8 MiB budget: two fit, the rest wait.
		const mib = 1024 * 1024;
		const page = budgetPage([3 * mib, 3 * mib, 3 * mib, 3 * mib, 3 * mib], 50, 8 * mib);
		expect(page.kept).toBe(2);
		// Crucially not the end: reporting done here would truncate the archive at
		// the first large message while looking complete.
		expect(page.done).toBe(false);
	});

	it("always keeps one row, even when it alone exceeds the budget", () => {
		// A page of zero rows reads as the end of the mailbox, so a single oversized
		// message would silently stop the export.
		const page = budgetPage([50 * 1024 * 1024], 50, 8 * 1024 * 1024);
		expect(page.kept).toBe(1);
	});

	it("reports the end only when the query itself ran dry", () => {
		// Three small rows against a limit of 50: genuinely the end.
		expect(budgetPage([10, 10, 10], 50, 8 * 1024 * 1024).done).toBe(true);
		// A full page is not assumed to be the end.
		expect(budgetPage([10, 10, 10], 3, 8 * 1024 * 1024).done).toBe(false);
	});

	it("returns nothing for an empty mailbox", () => {
		const db = seed([]);
		expect(pageAll(db, 5)).toEqual([]);
		db.close();
	});
});


// -- Follow-ups from review on #55 ---------------------------------

describe("synthesized headers are not duplicated", () => {
	it("replaces a stored Status rather than appending beside it", () => {
		// An inbound message can arrive carrying `Status`, and a message imported from
		// another archive carries whatever that archive wrote. Keeping both leaves the
		// export claiming two different read states, and clients disagree about which
		// duplicate wins — so the stale one is dropped.
		const headers = exportHeaders({
			id: "e1",
			sender: "a@example.com",
			body: "hi",
			read: 1,
			starred: 0,
			folder_id: "inbox",
			raw_headers: storedHeaders({
				From: "a@example.com",
				Status: "O",
				"X-Status": "F",
				"X-Tapetide-Folder": "archive",
			}),
		});

		expect(headers.filter((h) => h.key.toLowerCase() === "status")).toHaveLength(1);
		expect(headerValue(headers, "Status")).toBe("RO");
		// Not starred now, so no X-Status at all — the stored `F` must not survive.
		expect(headerValue(headers, "X-Status")).toBeNull();
		// And the folder is the one the row says, not the one the blob remembered.
		expect(headerValue(headers, "X-Tapetide-Folder")).toBe("inbox");
	});

	it("drops a stored attachment header, since those are rebuilt", () => {
		const headers = exportHeaders(
			{
				id: "e1",
				sender: "a@example.com",
				body: "hi",
				raw_headers: storedHeaders({ "X-Tapetide-Attachment": "ghost.pdf; type=x; size=1" }),
			},
		);
		expect(headerValue(headers, "X-Tapetide-Attachment")).toBeNull();
	});
});

describe("null-dated messages in cursor paging", () => {
	/**
	 * `emails.date` is nullable, and a bare `date > ?` comparison is false for every
	 * NULL. So once a cursor was taken from a null-dated row, the next page skipped
	 * the rest of them and resumed at dated rows — losing them from the archive.
	 *
	 * Run against real SQLite, because the bug is in the SQL's null semantics.
	 */
	function coalescedPage(
		db: DatabaseSync,
		limit: number,
		after?: { date: string; id: string },
	) {
		return after === undefined
			? db
					.prepare(
						`SELECT id, COALESCE(date, '') AS sort_date FROM emails
						  ORDER BY sort_date ASC, id ASC LIMIT ?`,
					)
					.all(limit)
			: db
					.prepare(
						`SELECT id, COALESCE(date, '') AS sort_date FROM emails
						  WHERE (COALESCE(date, '') > ?) OR (COALESCE(date, '') = ? AND id > ?)
						  ORDER BY sort_date ASC, id ASC LIMIT ?`,
					)
					.all(after.date, after.date, after.id, limit);
	}

	function pageAllCoalesced(db: DatabaseSync, limit: number): string[] {
		const seen: string[] = [];
		let cursor: { date: string; id: string } | undefined;
		for (let guard = 0; guard < 100; guard += 1) {
			const page = coalescedPage(db, limit, cursor) as {
				id: string;
				sort_date: string;
			}[];
			if (page.length === 0) break;
			seen.push(...page.map((row) => row.id));
			const last = page[page.length - 1]!;
			cursor = { date: last.sort_date, id: last.id };
			if (page.length < limit) break;
		}
		return seen;
	}

	it("visits every null-dated message across pages", () => {
		const db = new DatabaseSync(":memory:");
		db.exec(`CREATE TABLE emails (id TEXT PRIMARY KEY, date TEXT)`);
		const insert = db.prepare(`INSERT INTO emails (id, date) VALUES (?, ?)`);
		// Five undated messages, then two dated ones.
		for (const id of ["n1", "n2", "n3", "n4", "n5"]) insert.run(id, null);
		insert.run("d1", "2026-09-01T09:00:00.000Z");
		insert.run("d2", "2026-09-02T09:00:00.000Z");

		// Page size 2, so the undated rows span three pages.
		expect(pageAllCoalesced(db, 2)).toEqual(["n1", "n2", "n3", "n4", "n5", "d1", "d2"]);
		db.close();
	});

	it("shows the bug the coalesce fixes", () => {
		// Same data, the old predicate: `date > ''` is NULL — not true — for a null
		// row, so everything after the first page vanishes.
		const db = new DatabaseSync(":memory:");
		db.exec(`CREATE TABLE emails (id TEXT PRIMARY KEY, date TEXT)`);
		const insert = db.prepare(`INSERT INTO emails (id, date) VALUES (?, ?)`);
		for (const id of ["n1", "n2", "n3"]) insert.run(id, null);

		const rest = db
			.prepare(
				`SELECT id FROM emails WHERE (date > ?) OR (date = ? AND id > ?)
				  ORDER BY date ASC, id ASC LIMIT 10`,
			)
			.all("", "", "n1") as { id: string }[];

		// n2 and n3 are silently lost.
		expect(rest).toEqual([]);
		db.close();
	});
});

describe("byte budget runs before bodies are loaded", () => {
	/**
	 * The order is the whole point.
	 *
	 * An earlier version selected `*` and trimmed the array afterwards, so every full
	 * body was already in memory before the budget could discard any — the page it
	 * dropped had already cost exactly what the budget existed to prevent.
	 *
	 * Asserted by reading the source: the size query must precede the body query.
	 */
	it("selects sizes first, then only the chosen bodies", () => {
		const source = readFileSync(
			new URL("../workers/durableObject/index.ts", import.meta.url),
			"utf8",
		);
		const fn = source.slice(
			source.indexOf("async exportPage("),
			source.indexOf("async countAllEmails("),
		);

		const sizeQuery = fn.indexOf("body_bytes");
		const budget = fn.indexOf("bytes + size > BYTE_BUDGET");
		const bodyQuery = fn.indexOf("SELECT * FROM emails WHERE id IN");

		expect(sizeQuery).toBeGreaterThan(-1);
		expect(budget).toBeGreaterThan(sizeQuery);
		// The bodies are fetched only after the budget has chosen the page.
		expect(bodyQuery).toBeGreaterThan(budget);
		// And `SELECT *` is never used to drive the page.
		expect(fn).not.toContain("SELECT * FROM emails ORDER BY");
	});

	it("measures bytes, not characters", () => {
		// `LENGTH()` on text counts code points, so a CJK body would report a fraction
		// of its real cost and slip past the budget.
		const source = readFileSync(
			new URL("../workers/durableObject/index.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain("LENGTH(CAST(COALESCE(body, '') AS BLOB))");
	});
});
