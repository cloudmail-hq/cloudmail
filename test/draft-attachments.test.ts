// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Tests for carrying attachments through drafts and forwards.
 *
 * Both paths used to lose files silently. Drafts had no attachment field on the
 * route at all, so anything staged in the composer vanished the moment autosave
 * ran; forwards explicitly reset the composer's attachment list, so the
 * originals never went out. Silent loss is the failure mode worth pinning, since
 * the user only discovers it after the message has been sent.
 *
 * `stageStoredAttachments` is the shared fix, and `attachmentsSignature` is what
 * stops autosave re-uploading unchanged bytes on a timer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	attachmentsSignature,
	loadAttachmentsForSend,
	prepareAttachmentsForApi,
	stageStoredAttachments,
} from "../app/lib/attachment-transfer";
import type { Attachment } from "../app/types";

/** Minimal stand-in for the staged-file shape the composer holds. */
function stagedFile(name: string, size: number, lastModified = 1) {
	return {
		id: `id-${name}`,
		file: { name, size, lastModified } as File,
	};
}

const PDF: Attachment = {
	id: "att-1",
	filename: "invoice.pdf",
	mimetype: "application/pdf",
	size: 1024,
};

const INLINE_IMAGE: Attachment = {
	id: "att-2",
	filename: "logo.png",
	mimetype: "image/png",
	size: 256,
	content_id: "<logo@example>",
	disposition: "inline",
};

beforeEach(() => {
	vi.restoreAllMocks();
	// jsdom is not in play here; the module only needs these two globals.
	vi.stubGlobal("crypto", { randomUUID: () => Math.random().toString(36) });
	vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
});

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
	const fetchMock = vi.fn((url: string) => Promise.resolve(handler(url)));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

describe("stageStoredAttachments", () => {
	it("fetches a stored attachment and stages it as a real File", async () => {
		mockFetch(() => new Response(new Blob(["pdf-bytes"])));

		const { files, failed } = await stageStoredAttachments("box", "email-1", [PDF]);

		expect(failed).toEqual([]);
		expect(files).toHaveLength(1);
		// A real File, so the existing validation, size accounting and base64
		// encoding in the send path all work unchanged.
		expect(files[0].file).toBeInstanceOf(File);
		expect(files[0].file.name).toBe("invoice.pdf");
		expect(files[0].file.type).toBe("application/pdf");
	});

	it("reads from the attachment endpoint for the owning message", async () => {
		const fetchMock = mockFetch(() => new Response(new Blob(["x"])));

		await stageStoredAttachments("box@example.com", "email-1", [PDF]);

		const url = fetchMock.mock.calls[0][0] as string;
		expect(url).toContain(encodeURIComponent("box@example.com"));
		expect(url).toContain("email-1");
		expect(url).toContain("att-1");
	});

	it("skips inline images so a forward doesn't duplicate embedded artwork", async () => {
		// Inline parts are cid: references inside the quoted body; re-attaching
		// them shows the reader the same image twice.
		const fetchMock = mockFetch(() => new Response(new Blob(["x"])));

		const { files } = await stageStoredAttachments("box", "email-1", [
			PDF,
			INLINE_IMAGE,
		]);

		expect(files.map((f) => f.file.name)).toEqual(["invoice.pdf"]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("treats a non-inline image as a normal attachment", async () => {
		mockFetch(() => new Response(new Blob(["x"])));
		const attached: Attachment = { ...INLINE_IMAGE, disposition: "attachment" };

		const { files } = await stageStoredAttachments("box", "email-1", [attached]);
		expect(files).toHaveLength(1);
	});

	it("reports a missing blob instead of failing the whole composer", async () => {
		// Losing one of several attachments is worth completing; refusing to open
		// the composer over a single missing blob is not.
		mockFetch((url) =>
			url.includes("att-1")
				? new Response("nope", { status: 404 })
				: new Response(new Blob(["ok"])),
		);

		const { files, failed } = await stageStoredAttachments("box", "email-1", [
			PDF,
			{ ...INLINE_IMAGE, disposition: "attachment", content_id: undefined },
		]);

		expect(failed).toEqual(["invoice.pdf"]);
		expect(files.map((f) => f.file.name)).toEqual(["logo.png"]);
	});

	it("reports a network failure rather than throwing", async () => {
		vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));

		const { files, failed } = await stageStoredAttachments("box", "email-1", [PDF]);

		expect(files).toEqual([]);
		expect(failed).toEqual(["invoice.pdf"]);
	});

	it("does nothing when the message has no attachments", async () => {
		const fetchMock = mockFetch(() => new Response(new Blob(["x"])));

		expect(await stageStoredAttachments("box", "e", [])).toEqual({
			files: [],
			failed: [],
		});
		expect(await stageStoredAttachments("box", "e", undefined)).toEqual({
			files: [],
			failed: [],
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

/**
 * Sending a draft from the reading pane or the Drafts list has no composer to
 * stage files into, so it needs the bytes in API form directly. That path used
 * to build its payload from the row's text fields alone, which meant the same
 * draft went out with its attachments from the composer and without them from
 * the list.
 */
describe("loadAttachmentsForSend", () => {
	it("returns stored attachments encoded for the send route", async () => {
		mockFetch(() => new Response(new Blob(["pdf-bytes"])));

		const { attachments, failed } = await loadAttachmentsForSend(
			"box",
			"draft-1",
			[PDF],
		);

		expect(failed).toEqual([]);
		expect(attachments).toEqual([
			{
				content: Buffer.from("pdf-bytes").toString("base64"),
				filename: "invoice.pdf",
				type: "application/pdf",
				disposition: "attachment",
			},
		]);
	});

	it("reads from the draft's own attachment endpoint", async () => {
		const fetchMock = mockFetch(() => new Response(new Blob(["x"])));

		await loadAttachmentsForSend("box@example.com", "draft-1", [PDF]);

		const url = fetchMock.mock.calls[0][0] as string;
		expect(url).toContain(encodeURIComponent("box@example.com"));
		expect(url).toContain("draft-1");
		expect(url).toContain("att-1");
	});

	it("skips inline parts, which are already embedded in the body", async () => {
		const fetchMock = mockFetch(() => new Response(new Blob(["x"])));

		const { attachments } = await loadAttachmentsForSend("box", "draft-1", [
			PDF,
			INLINE_IMAGE,
		]);

		expect(attachments.map((a) => a.filename)).toEqual(["invoice.pdf"]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("names the files it could not load so the caller can refuse to send", async () => {
		// Unlike opening a composer, a send is not recoverable after the fact:
		// the caller stops rather than delivering a message missing its files.
		mockFetch((url) =>
			url.includes("att-1")
				? new Response("nope", { status: 404 })
				: new Response(new Blob(["ok"])),
		);

		const { attachments, failed } = await loadAttachmentsForSend(
			"box",
			"draft-1",
			[PDF, { ...INLINE_IMAGE, disposition: "attachment", content_id: undefined }],
		);

		expect(failed).toEqual(["invoice.pdf"]);
		expect(attachments.map((a) => a.filename)).toEqual(["logo.png"]);
	});

	it("makes no request for a draft with no attachments", async () => {
		const fetchMock = mockFetch(() => new Response(new Blob(["x"])));

		expect(await loadAttachmentsForSend("box", "d", [])).toEqual({
			attachments: [],
			failed: [],
		});
		expect(await loadAttachmentsForSend("box", "d", undefined)).toEqual({
			attachments: [],
			failed: [],
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("prepareAttachmentsForApi", () => {
	it("base64-encodes staged files with a default mimetype", async () => {
		const files = [
			{ id: "1", file: new File(["hello"], "notes.txt", { type: "text/plain" }) },
			{ id: "2", file: new File(["raw"], "blob.bin") },
		];

		expect(await prepareAttachmentsForApi(files as any)).toEqual([
			{
				content: Buffer.from("hello").toString("base64"),
				filename: "notes.txt",
				type: "text/plain",
				disposition: "attachment",
			},
			{
				content: Buffer.from("raw").toString("base64"),
				filename: "blob.bin",
				type: "application/octet-stream",
				disposition: "attachment",
			},
		]);
	});
});

describe("attachmentsSignature", () => {
	it("is stable across calls for the same files", () => {
		// Autosave compares this to decide whether to re-upload; instability would
		// re-encode and re-store the same bytes on every idle save.
		const files = [stagedFile("a.pdf", 10), stagedFile("b.png", 20)];
		expect(attachmentsSignature(files as any)).toBe(
			attachmentsSignature(files as any),
		);
	});

	it("changes when a file is added or removed", () => {
		const one = [stagedFile("a.pdf", 10)];
		const two = [stagedFile("a.pdf", 10), stagedFile("b.png", 20)];
		expect(attachmentsSignature(one as any)).not.toBe(
			attachmentsSignature(two as any),
		);
	});

	it("changes when a file is replaced by a different one of the same name", () => {
		const before = [stagedFile("report.pdf", 10, 100)];
		const after = [stagedFile("report.pdf", 999, 200)];
		expect(attachmentsSignature(before as any)).not.toBe(
			attachmentsSignature(after as any),
		);
	});

	it("is empty for no attachments, matching the initial saved state", () => {
		expect(attachmentsSignature([])).toBe("");
	});

	it("distinguishes order changes", () => {
		const a = [stagedFile("a.pdf", 1), stagedFile("b.pdf", 2)];
		const b = [stagedFile("b.pdf", 2), stagedFile("a.pdf", 1)];
		expect(attachmentsSignature(a as any)).not.toBe(attachmentsSignature(b as any));
	});
});
