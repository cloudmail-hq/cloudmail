// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The pure parts of mail import: mbox splitting, Gmail label mapping, IMAP
 * folder planning, the IMAP host guard and the zip reader.
 */

import { describe, expect, it } from "vitest";
import {
	findNextSeparator,
	parseGmailLabels,
	placementFromGmailLabels,
	planImapFolder,
	splitMboxWindow,
	unquoteMboxMessage,
	validateImapHost,
} from "../shared/mail-import";
import { isEmlEntry, readZipDirectory, readZipEntry, ZipError } from "../workers/lib/zip-reader";
import { bytes, mbox, message, zip } from "./helpers/import-fixtures";

const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("splitMboxWindow", () => {
	it("splits LF messages and strips the separator and the blank line before the next one", () => {
		const file = mbox([message({ subject: "One", body: "first" }), message({ subject: "Two", body: "second" })]);
		const { messages, next } = splitMboxWindow(bytes(file), 0, true);
		expect(messages).toHaveLength(2);
		expect(text(messages[0].raw)).toMatch(/^From: Alice/);
		expect(text(messages[0].raw)).toMatch(/first\n$/);
		expect(text(messages[0].raw)).not.toMatch(/\n\n$/);
		expect(text(messages[1].raw)).toContain("Subject: Two");
		expect(next).toBe(bytes(file).length);
	});

	it("handles CRLF line endings", () => {
		const file = mbox([message({ eol: "\r\n", body: "a" }), message({ eol: "\r\n", subject: "B", body: "b" })], { eol: "\r\n" });
		const { messages } = splitMboxWindow(bytes(file), 0, true);
		expect(messages).toHaveLength(2);
		expect(text(messages[0].raw)).toMatch(/^From: Alice/);
		expect(text(messages[0].raw).endsWith("a\r\n")).toBe(true);
		expect(text(messages[1].raw)).toContain("Subject: B\r\n");
	});

	it("keeps a final message that has no trailing newline", () => {
		const file = mbox([message({ body: "one" }), message({ subject: "Last", body: "no newline at the end" })], { trailingNewline: false });
		expect(file.endsWith("no newline at the end")).toBe(true);
		const { messages } = splitMboxWindow(bytes(file), 0, true);
		expect(messages).toHaveLength(2);
		expect(text(messages[1].raw).endsWith("no newline at the end")).toBe(true);
	});

	it("unquotes >From lines (mboxrd) and does not split on them", () => {
		const body = "From the start of a line\n>From already quoted\nnot From here";
		const file = mbox([message({ body }), message({ subject: "Next" })]);
		expect(file).toContain("\n>From the start");
		expect(file).toContain("\n>>From already quoted");
		const { messages } = splitMboxWindow(bytes(file), 0, true);
		expect(messages).toHaveLength(2);
		const first = text(messages[0].raw);
		expect(first).toContain("\nFrom the start of a line\n");
		expect(first).toContain("\n>From already quoted\n");
		expect(first).toContain("not From here");
	});

	it("leaves the last message for the next window when not at EOF", () => {
		const file = bytes(mbox([message({ subject: "A" }), message({ subject: "B" }), message({ subject: "C" })]));
		const cut = text(file).indexOf("Subject: C") + 3;
		const r = splitMboxWindow(file.subarray(0, cut), 0, false);
		expect(r.messages.map((m) => text(m.raw).match(/Subject: (\w)/)![1])).toEqual(["A", "B"]);
		// Resuming at `next` sees C as the first message.
		const rest = splitMboxWindow(file.subarray(r.next), r.next, true);
		expect(rest.messages).toHaveLength(1);
		expect(text(rest.messages[0].raw)).toContain("Subject: C");
		expect(rest.messages[0].start).toBe(r.next);
	});

	it("reports an incomplete window when one message spans it", () => {
		const file = bytes(mbox([message({ body: "x".repeat(5000) }), message()]));
		const r = splitMboxWindow(file.subarray(0, 1000), 0, false);
		expect(r.messages).toHaveLength(0);
		expect(r.incomplete).toBe(true);
		expect(r.next).toBe(0);
	});

	it("skips junk before the first separator", () => {
		const file = bytes(`garbage line\n\n${mbox([message({ subject: "Real" })])}`);
		const r = splitMboxWindow(file, 0, true);
		expect(r.messages).toHaveLength(1);
		expect(text(r.messages[0].raw)).toContain("Subject: Real");
		expect(r.firstSeparator).toBe(14);
	});

	it("accepts a separator without a preceding blank line when it looks like one", () => {
		const raw = `From a@example.com Tue Jan 14 10:00:00 2014\n${message({ subject: "1" })}From b@example.com Wed Jan 15 10:00:00 2014\n${message({ subject: "2" })}`;
		expect(splitMboxWindow(bytes(raw), 0, true).messages).toHaveLength(2);
	});

	it("findNextSeparator finds the separator after the first line", () => {
		const file = bytes(mbox([message(), message({ subject: "Two" })]));
		const i = findNextSeparator(file, true);
		expect(text(file.subarray(i, i + 5))).toBe("From ");
		expect(i).toBeGreaterThan(0);
	});

	it("unquoteMboxMessage only strips one level", () => {
		expect(text(unquoteMboxMessage(bytes(">>>From x\n>Fromage\n")))).toBe(">>From x\n>Fromage\n");
	});
});

describe("Gmail Takeout labels", () => {
	it("parses quoted and encoded labels", () => {
		expect(parseGmailLabels('Inbox,Important,"Work, Clients",=?UTF-8?B?w4lsw6h2ZXM=?=')).toEqual([
			"Inbox",
			"Important",
			"Work, Clients",
			"Élèves",
		]);
	});

	it("maps system labels to folders and flags", () => {
		expect(placementFromGmailLabels(["Inbox", "Unread", "Starred", "Important"])).toEqual({
			folder: "inbox",
			labels: [],
			read: false,
			starred: true,
		});
		expect(placementFromGmailLabels(["Sent", "Opened"]).folder).toBe("sent");
		expect(placementFromGmailLabels(["Spam", "Inbox"]).folder).toBe("spam");
		expect(placementFromGmailLabels(["Trash", "Inbox"]).folder).toBe("trash");
		expect(placementFromGmailLabels(["Archived"]).folder).toBe("archive");
		expect(placementFromGmailLabels([]).folder).toBe("archive");
	});

	it("keeps user labels and maps categories", () => {
		const p = placementFromGmailLabels(["Inbox", "Category Promotions", "Category Personal", "Receipts", "Travel/2014"]);
		expect(p.labels).toEqual(["Promotions", "Receipts", "Travel/2014"]);
		expect(p.read).toBe(true);
	});

	it("files drafts in Archive with a Drafts label, never in Drafts", () => {
		const p = placementFromGmailLabels(["Draft"]);
		expect(p.folder).toBe("archive");
		expect(p.labels).toEqual(["Drafts"]);
	});
});

describe("planImapFolder", () => {
	it("maps special-use folders", () => {
		expect(planImapFolder("INBOX", [], "/")).toMatchObject({ folder: "inbox", label: null, skip: false, order: 0 });
		expect(planImapFolder("[Gmail]/Sent Mail", ["\\HasNoChildren", "\\Sent"], "/")).toMatchObject({ folder: "sent", skip: false });
		expect(planImapFolder("Junk", [], "/")).toMatchObject({ folder: "spam" });
		expect(planImapFolder("Deleted Items", [], "/")).toMatchObject({ folder: "trash" });
		expect(planImapFolder("[Gmail]/All Mail", ["\\All"], "/")).toMatchObject({ folder: "archive", order: 6 });
	});

	it("skips drafts, virtual views and non-selectable folders", () => {
		expect(planImapFolder("Drafts", ["\\Drafts"], "/").skip).toBe(true);
		expect(planImapFolder("[Gmail]/Starred", ["\\Flagged"], "/").skip).toBe(true);
		expect(planImapFolder("[Gmail]/Important", ["\\Important"], "/").skip).toBe(true);
		expect(planImapFolder("[Gmail]", ["\\Noselect"], "/").skip).toBe(true);
	});

	it("turns user folders into labels with / as the separator", () => {
		expect(planImapFolder("Work.Clients", [], ".")).toMatchObject({ folder: "archive", label: "Work/Clients", order: 1 });
	});
});

describe("validateImapHost (SSRF guard)", () => {
	it("accepts public hostnames and lowercases them", () => {
		expect(validateImapHost("IMAP.Example.com")).toEqual({ ok: true, host: "imap.example.com" });
		expect(validateImapHost("imap.gmail.com.")).toEqual({ ok: true, host: "imap.gmail.com" });
		expect(validateImapHost("93.184.216.34")).toEqual({ ok: true, host: "93.184.216.34" });
	});

	it.each([
		"localhost",
		"127.0.0.1",
		"10.0.0.5",
		"192.168.1.1",
		"172.16.0.1",
		"169.254.169.254",
		"100.64.0.1",
		"0.0.0.0",
		"[::1]",
		"[fd00::1]",
		"[::ffff:127.0.0.1]",
		"metadata.google.internal",
		"printer.local",
		"intranet",
	])("rejects %s", (host) => {
		expect(validateImapHost(host).ok).toBe(false);
	});

	it.each(["imap.example.com:143", "https://imap.example.com", "imap.example.com/x", "user@imap.example.com", "", "a b.com"])(
		"rejects a host with extras: %s",
		(host) => {
			expect(validateImapHost(host).ok).toBe(false);
		},
	);
});

describe("zip reader", () => {
	const reader = (data: Uint8Array) => async (offset: number, length: number) => data.slice(offset, offset + length);

	it.each([false, true])("reads .eml entries (deflate=%s)", async (deflate) => {
		const a = message({ subject: "From zip A" });
		const b = message({ subject: "From zip B", body: "é".repeat(2000) });
		const archive = zip(
			[
				{ name: "mail/", data: "" },
				{ name: "mail/a.eml", data: a },
				{ name: "mail/b.EML", data: b },
				{ name: "__MACOSX/mail/._a.eml", data: "junk" },
				{ name: "readme.txt", data: "hi" },
			],
			{ deflate },
		);
		const entries = await readZipDirectory(reader(archive), archive.length);
		expect(entries.map((e) => e.name)).toEqual(["mail/", "mail/a.eml", "mail/b.EML", "__MACOSX/mail/._a.eml", "readme.txt"]);
		const eml = entries.filter(isEmlEntry);
		expect(eml.map((e) => e.name)).toEqual(["mail/a.eml", "mail/b.EML"]);
		expect(text(await readZipEntry(reader(archive), eml[0], 1 << 20))).toBe(a);
		expect(text(await readZipEntry(reader(archive), eml[1], 1 << 20))).toBe(b);
	});

	it("stops inflating at the cap", async () => {
		const archive = zip([{ name: "big.eml", data: "a".repeat(100_000) }], { deflate: true });
		const [entry] = await readZipDirectory(reader(archive), archive.length);
		// Declared size passes a lower check when it lies; force the stream cap.
		await expect(readZipEntry(reader(archive), { ...entry, uncompressedSize: 10 }, 1000)).rejects.toBeInstanceOf(ZipError);
	});

	it("rejects a file that is not a zip", async () => {
		const junk = bytes("definitely not a zip file at all, just text");
		await expect(readZipDirectory(reader(junk), junk.length)).rejects.toBeInstanceOf(ZipError);
	});
});
