// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The agent-first MCP tools in `workers/lib/tools.ts`.
 *
 * Each test drives the real tool function against a hand-rolled Durable Object
 * stub, the same way `test/capability-non-http.test.ts` and
 * `test/draft-send.test.ts` do: `EmailMCP` itself needs a DO runtime, but the
 * logic worth pinning lives in these functions. Gating is covered by the
 * source-parsing table in `capability-non-http.test.ts`.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { trashOnly } from "../workers/durableObject/trash";
import {
	BULK_TOOL_ACTIONS,
	BULK_TOOL_CAPABILITIES,
	compactEmail,
	folderSlug,
	forwardSubject,
	isTextLikeMime,
	pageOf,
	renderTemplateForSend,
	snippetText,
	toolApplyLabel,
	toolArchiveEmail,
	toolBulkUpdate,
	toolCancelScheduled,
	toolCreateFolder,
	toolCreateLabel,
	toolCreateRule,
	toolForwardEmail,
	toolGetAttachment,
	toolGetEmailCompact,
	toolGetPersonHistory,
	toolGetThreadCompact,
	toolListAttachments,
	toolListEmailsCompact,
	toolListFolders,
	toolListLabels,
	toolListPeople,
	toolListRules,
	toolListScheduled,
	toolListSignatures,
	toolListTemplates,
	toolMailboxSummary,
	toolMarkNotSpam,
	toolRemoveLabel,
	toolRestoreEmail,
	toolScheduleSend,
	toolSendTemplate,
	toolSetPriority,
	toolSnoozeEmail,
	toolStarEmail,
	toolTrashEmail,
	toolUnsnoozeEmail,
	ATTACHMENT_DEFAULT_MAX_BYTES,
} from "../workers/lib/tools";
import { MAILBOX_CAPABILITIES } from "../workers/lib/capabilities";
import { Folders } from "../shared/folders";
import type { EmailTemplate } from "../workers/lib/templates";
import type { Env } from "../workers/types";
import { prepareOutgoingHtml } from "../shared/outgoing-html";

const MB = "support@tapetide.com";

/** An env whose MAILBOX binding returns `stub` for every address. */
function envWith(
	stub: Record<string, unknown>,
	extra: Partial<Record<"BUCKET" | "EMAIL" | "AI", unknown>> = {},
) {
	return {
		MAILBOX: {
			idFromName: (name: string) => ({ name }),
			get: () => stub,
		},
		...extra,
	} as unknown as Env;
}

/** An env that hands each mailbox its own stub. */
function envPerMailbox(stubs: Record<string, Record<string, unknown>>) {
	return {
		MAILBOX: {
			idFromName: (name: string) => ({ name }),
			get: (id: { name: string }) => stubs[id.name],
		},
	} as unknown as Env;
}

/** An R2-shaped bucket backed by a Map. */
function bucket(entries: Record<string, string | Uint8Array> = {}) {
	const store = new Map<string, Uint8Array>(
		Object.entries(entries).map(([k, v]) => [
			k,
			typeof v === "string" ? new TextEncoder().encode(v) : v,
		]),
	);
	return {
		store,
		async get(key: string, _options?: unknown) {
			const value = store.get(key);
			if (!value) return null;
			return {
				arrayBuffer: async () =>
					value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
				json: async () => JSON.parse(new TextDecoder().decode(value)),
			};
		},
		async put(key: string, value: Uint8Array | string) {
			store.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value);
		},
		async head(key: string) {
			return store.has(key) ? {} : null;
		},
		async list(options: { prefix?: string } = {}) {
			return {
				objects: [...store.keys()]
					.filter((k) => k.startsWith(options.prefix ?? ""))
					.map((key) => ({ key })),
				truncated: false,
			};
		},
	};
}

/** Workers AI stub that leaves bodies unchanged. */
const passthroughAI = {
	run: vi.fn(async () => ({ response: "UNCHANGED" })),
};

/** Workers AI stub that is down. */
const brokenAI = {
	run: vi.fn(async () => {
		throw new Error("AI down");
	}),
};

// ── Output shaping ───────────────────────────────────────────────────

describe("snippetText", () => {
	it("returns plain text, not HTML", () => {
		expect(snippetText("<p>Hello <b>world</b></p>")).toBe("Hello world");
	});

	it("drops a tag cut off by the 300-character SUBSTR", () => {
		expect(snippetText('<p>Hi there</p><a href="https://exa')).toBe("Hi there");
	});

	it("decodes entities and caps the length", () => {
		expect(snippetText("Fish &amp; chips")).toBe("Fish & chips");
		const long = snippetText(`<p>${"x".repeat(500)}</p>`, 50);
		expect(long).toHaveLength(50);
		expect(long.endsWith("…")).toBe(true);
	});

	it("treats non-strings as empty", () => {
		expect(snippetText(null)).toBe("");
		expect(snippetText(42)).toBe("");
	});
});

describe("compactEmail", () => {
	it("keeps metadata, converts the snippet, and omits empty extras", () => {
		const row = compactEmail({
			id: "e1",
			thread_id: "t1",
			folder_id: "inbox",
			subject: "Invoice",
			sender: "billing@stripe.com",
			recipient: MB,
			date: "2026-10-01T00:00:00Z",
			read: 0,
			starred: 1,
			snippet: "<div>Your <i>invoice</i></div>",
			body: "<html>should not leak</html>",
			raw_headers: "[]",
		});
		expect(row).toEqual({
			id: "e1",
			thread_id: "t1",
			folder: "inbox",
			subject: "Invoice",
			from: "billing@stripe.com",
			to: MB,
			date: "2026-10-01T00:00:00Z",
			read: false,
			starred: true,
			snippet: "Your invoice",
		});
	});

	it("surfaces the triage signals when set", () => {
		const row = compactEmail({
			id: "e1",
			needs_reply: true,
			has_attachment: true,
			priority: "high",
			thread_count: 3,
		});
		expect(row).toMatchObject({
			needs_reply: true,
			has_attachment: true,
			priority: "high",
			thread_count: 3,
		});
	});
});

describe("pageOf", () => {
	it("offers a next page only when the page was full", () => {
		expect(pageOf([1, 2], 1, 2).next_page).toBe(2);
		expect(pageOf([1], 1, 2).next_page).toBeNull();
		expect(pageOf([], 3, 2)).toEqual({ items: [], page: 3, next_page: null });
	});
});

// ── Reading ──────────────────────────────────────────────────────────

describe("toolListEmailsCompact", () => {
	it("passes filters and pagination through and returns compact rows", async () => {
		const getEmails = vi.fn(async () => [
			{ id: "a", snippet: "<p>one</p>" },
			{ id: "b", snippet: "<p>two</p>" },
		]);
		const result = await toolListEmailsCompact(envWith({ getEmails }), MB, {
			folder: "inbox",
			limit: 2,
			page: 3,
			unread: true,
		});
		expect(getEmails).toHaveBeenCalledWith(
			expect.objectContaining({ folder: "inbox", limit: 2, page: 3, unread: true }),
		);
		expect(result.next_page).toBe(4);
		expect(result.emails.map((e) => e.snippet)).toEqual(["one", "two"]);
	});
});

describe("toolGetEmailCompact", () => {
	const email = {
		id: "e1",
		subject: "Hi",
		sender: "a@b.com",
		body: "<p>Line one</p><p>Line two</p>",
		attachments: [
			{ id: "att1", filename: "a.pdf", mimetype: "application/pdf", size: 10, disposition: "attachment" },
			{ id: "att2", filename: "setup.exe", mimetype: "application/octet-stream", size: 10, disposition: "attachment" },
		],
	};

	it("returns body_text and no HTML by default", async () => {
		const result = (await toolGetEmailCompact(envWith({ getEmail: async () => email }), MB, "e1")) as Record<string, unknown>;
		expect(result.body_text).toBe("Line one\nLine two");
		expect(result).not.toHaveProperty("body_html");
		expect(result.attachments).toEqual([
			{ id: "att1", filename: "a.pdf", mimetype: "application/pdf", size: 10, inline: false },
			{ id: "att2", filename: "setup.exe", mimetype: "application/octet-stream", size: 10, inline: false, blocked: true },
		]);
	});

	it("includes HTML on request and truncates long bodies", async () => {
		const long = { ...email, body: `<p>${"y".repeat(5000)}</p>` };
		const result = (await toolGetEmailCompact(envWith({ getEmail: async () => long }), MB, "e1", {
			includeBody: true,
			maxChars: 1000,
		})) as Record<string, unknown>;
		expect(result.body_html).toBe(long.body);
		expect(result.body_truncated).toBe(true);
		expect(String(result.body_text).length).toBeLessThanOrEqual(1001);
	});

	it("reports a missing email", async () => {
		expect(await toolGetEmailCompact(envWith({ getEmail: async () => null }), MB, "x")).toEqual({
			error: "Email not found",
			emailId: "x",
		});
	});
});

describe("toolGetThreadCompact", () => {
	it("sorts oldest first and shares the budget", async () => {
		const getThreadEmails = async () => [
			{ id: "2", date: "2026-10-02T00:00:00Z", body: `<p>${"b".repeat(3000)}</p>` },
			{ id: "1", date: "2026-10-01T00:00:00Z", body: `<p>${"a".repeat(3000)}</p>` },
		];
		const result = await toolGetThreadCompact(envWith({ getThreadEmails }), MB, "t", {
			maxChars: 2000,
		});
		expect(result.messages.map((m) => m.id)).toEqual(["1", "2"]);
		// 2000 across two messages, floored at 1000 each.
		for (const m of result.messages) {
			expect(m.body_truncated).toBe(true);
			expect(String(m.body_text).length).toBeLessThanOrEqual(1001);
		}
	});
});

// ── Folders and labels ───────────────────────────────────────────────

describe("folders", () => {
	it("slugs names the way POST /folders does", () => {
		expect(folderSlug("Client Work!")).toBe("client-work");
		expect(folderSlug("  --a  b-- ")).toBe("a-b");
		expect(folderSlug("!!!")).toBe("");
	});

	it("lists folders with movability", async () => {
		const env = envWith({
			getFolders: async () => [
				{ id: "inbox", name: "Inbox", unreadCount: 3 },
				{ id: "draft", name: "Drafts", unreadCount: 0 },
			],
		});
		expect(await toolListFolders(env, MB)).toEqual({
			folders: [
				{ id: "inbox", name: "Inbox", unread: 3, movable_into: true },
				{ id: "draft", name: "Drafts", unread: 0, movable_into: false },
			],
		});
	});

	it("creates a folder under its slug, and reports duplicates", async () => {
		const createFolder = vi.fn(async (id: string, name: string) => ({ id, name, unreadCount: 0 }));
		expect(await toolCreateFolder(envWith({ createFolder }), MB, "Client Work")).toEqual({
			status: "created",
			folder: { id: "client-work", name: "Client Work" },
		});
		expect(createFolder).toHaveBeenCalledWith("client-work", "Client Work");

		const dup = await toolCreateFolder(envWith({ createFolder: async () => null }), MB, "Client Work");
		expect(dup).toMatchObject({ folderId: "client-work" });
		expect((dup as { error: string }).error).toContain("already exists");
	});

	it("refuses a name with no usable characters before reaching the DO", async () => {
		const createFolder = vi.fn();
		expect(await toolCreateFolder(envWith({ createFolder }), MB, "???")).toHaveProperty("error");
		expect(createFolder).not.toHaveBeenCalled();
	});
});

describe("labels", () => {
	it("lists labels without bookkeeping columns", async () => {
		const env = envWith({
			getLabels: async () => [
				{ id: "l1", name: "VIP", color: "#f00", parent_id: null, sort_order: 0, created_at: 1, updated_at: 2 },
			],
		});
		expect(await toolListLabels(env, MB)).toEqual({
			labels: [{ id: "l1", name: "VIP", color: "#f00", parent_id: null }],
		});
	});

	it("creates, applies and removes", async () => {
		const createLabel = vi.fn(async () => ({ id: "l1", name: "VIP", color: "#f00" }));
		const addEmailLabel = vi.fn(async () => true);
		const removeEmailLabel = vi.fn(async () => true);
		const env = envWith({ createLabel, addEmailLabel, removeEmailLabel });

		expect(await toolCreateLabel(env, MB, { name: " VIP ", color: "#f00" })).toEqual({
			status: "created",
			label: { id: "l1", name: "VIP", color: "#f00" },
		});
		expect(createLabel).toHaveBeenCalledWith("VIP", "#f00", null, 0);

		expect(await toolApplyLabel(env, MB, "e1", "l1")).toEqual({ status: "labelled", emailId: "e1", labelId: "l1" });
		expect(await toolRemoveLabel(env, MB, "e1", "l1")).toEqual({ status: "unlabelled", emailId: "e1", labelId: "l1" });
	});

	it("points the model at list_labels when a label is unknown", async () => {
		const result = await toolApplyLabel(envWith({ addEmailLabel: async () => false }), MB, "e1", "nope");
		expect((result as { error: string }).error).toContain("list_labels");
	});

	it("reports a duplicate label name", async () => {
		const result = await toolCreateLabel(envWith({ createLabel: async () => null }), MB, { name: "VIP" });
		expect(result).toEqual({ error: "A label with that name already exists" });
	});
});

// ── Per-message state ────────────────────────────────────────────────

describe("star / priority", () => {
	it("stars through updateEmail", async () => {
		const updateEmail = vi.fn(async () => ({ id: "e1" }));
		expect(await toolStarEmail(envWith({ updateEmail }), MB, "e1", true)).toEqual({
			status: "updated",
			emailId: "e1",
			starred: true,
		});
		expect(updateEmail).toHaveBeenCalledWith("e1", { starred: true });
	});

	it("reports a missing message", async () => {
		expect(await toolStarEmail(envWith({ updateEmail: async () => null }), MB, "x", false)).toHaveProperty("error");
		expect(await toolSetPriority(envWith({ setEmailPriority: async () => null }), MB, "x", "high")).toHaveProperty("error");
	});

	it("clears priority with null", async () => {
		const setEmailPriority = vi.fn(async () => ({ id: "e1" }));
		await toolSetPriority(envWith({ setEmailPriority }), MB, "e1", null);
		expect(setEmailPriority).toHaveBeenCalledWith("e1", null);
	});
});

describe("snooze", () => {
	const NOW = Date.parse("2026-10-25T12:00:00Z");

	it("snoozes by delay", async () => {
		const snoozeEmail = vi.fn(async () => ({ id: "e1" }));
		const result = await toolSnoozeEmail(envWith({ snoozeEmail }), MB, "e1", {
			delaySeconds: 3600,
			now: NOW,
		});
		expect(result).toEqual({ status: "snoozed", emailId: "e1", until: "2026-10-25T13:00:00.000Z" });
		expect(snoozeEmail).toHaveBeenCalledWith("e1", "2026-10-25T13:00:00.000Z");
	});

	it("refuses ambiguous, past, invalid and far-future times without calling the DO", async () => {
		const snoozeEmail = vi.fn();
		const env = envWith({ snoozeEmail });
		for (const params of [
			{},
			{ until: "2026-11-01T00:00:00Z", delaySeconds: 60 },
			{ until: "2026-10-01T00:00:00Z" },
			{ until: "next tuesday" },
			{ until: "2028-01-01T00:00:00Z" },
		]) {
			expect(await toolSnoozeEmail(env, MB, "e1", { ...params, now: NOW })).toHaveProperty("error");
		}
		expect(snoozeEmail).not.toHaveBeenCalled();
	});

	it("unsnoozes and reports where the message went", async () => {
		const env = envWith({ unsnoozeEmail: async () => ({ folder_id: "inbox" }) });
		expect(await toolUnsnoozeEmail(env, MB, "e1")).toEqual({ status: "unsnoozed", emailId: "e1", folder: "inbox" });
		expect(await toolUnsnoozeEmail(envWith({ unsnoozeEmail: async () => null }), MB, "e1")).toHaveProperty("error");
	});
});

// ── Archive / trash / restore / not spam ─────────────────────────────

describe("archive / trash / restore", () => {
	it("archives through moveEmail", async () => {
		const moveEmail = vi.fn(async () => true);
		expect(await toolArchiveEmail(envWith({ moveEmail }), MB, "e1")).toMatchObject({ status: "archived" });
		expect(moveEmail).toHaveBeenCalledWith("e1", Folders.ARCHIVE);
	});

	it("trashes through the trash-only DO path", async () => {
		const trashEmailsOnly = vi.fn(async () => ({ trashed: ["e1"], alreadyBinned: [], missing: [] }));
		const deleteEmail = vi.fn();
		const env = envWith({ trashEmailsOnly, deleteEmail });
		expect(await toolTrashEmail(env, MB, "e1")).toMatchObject({ status: "trashed" });
		expect(trashEmailsOnly).toHaveBeenCalledWith(["e1"]);
		// Never the escalating delete.
		expect(deleteEmail).not.toHaveBeenCalled();
	});

	it("refuses a message already in Trash or Spam, and reports a missing one", async () => {
		const binned = envWith({ trashEmailsOnly: async () => ({ trashed: [], alreadyBinned: ["e1"], missing: [] }) });
		expect(((await toolTrashEmail(binned, MB, "e1")) as { error: string }).error).toContain("already in Trash or Spam");

		const missing = envWith({ trashEmailsOnly: async () => ({ trashed: [], alreadyBinned: [], missing: ["e1"] }) });
		expect(await toolTrashEmail(missing, MB, "e1")).toEqual({ error: "Email not found", emailId: "e1" });
	});

	it("restores and reports the folder", async () => {
		const env = envWith({ restoreEmails: async () => 1, getEmailFolder: async () => "archive" });
		expect(await toolRestoreEmail(env, MB, "e1")).toEqual({ status: "restored", emailId: "e1", folder: "archive" });
		expect(await toolRestoreEmail(envWith({ restoreEmails: async () => 0 }), MB, "e1")).toHaveProperty("error");
	});

	it("marks not spam", async () => {
		const env = envWith({
			markNotSpam: async () => ({ folder: "inbox", unblocked: ["x@y.com"], allowed: "x@y.com" }),
		});
		expect(await toolMarkNotSpam(env, MB, "e1")).toEqual({
			status: "not_spam",
			emailId: "e1",
			folder: "inbox",
			unblocked: ["x@y.com"],
			allowed: "x@y.com",
		});
	});
});

// ── bulk_update ──────────────────────────────────────────────────────

describe("toolBulkUpdate", () => {
	it("maps every action to a real capability, and none to deletePermanently", () => {
		for (const action of BULK_TOOL_ACTIONS) {
			const capability = BULK_TOOL_CAPABILITIES[action];
			expect(MAILBOX_CAPABILITIES).toContain(capability);
			expect(capability).not.toBe("deletePermanently");
		}
		expect(BULK_TOOL_CAPABILITIES.trash).toBe("delete");
		expect(BULK_TOOL_CAPABILITIES.archive).toBe("organise");
	});

	it("dedupes ids and sets flags", async () => {
		const bulkUpdateFlags = vi.fn(async (ids: string[]) => ids.length);
		const result = await toolBulkUpdate(envWith({ bulkUpdateFlags }), MB, {
			ids: ["a", "b", "a"],
			action: "star",
		});
		expect(result).toEqual({ action: "star", affected: 2 });
		expect(bulkUpdateFlags).toHaveBeenCalledWith(["a", "b"], { starred: true });
	});

	it("archives via bulkMoveEmails", async () => {
		const bulkMoveEmails = vi.fn(async () => 2);
		const result = await toolBulkUpdate(envWith({ bulkMoveEmails }), MB, { ids: ["a", "b"], action: "archive" });
		expect(result).toEqual({ action: "archive", folder: Folders.ARCHIVE, affected: 2 });
	});

	it("refuses a move into Drafts and a move without a folder", async () => {
		const bulkMoveEmails = vi.fn();
		const env = envWith({ bulkMoveEmails });
		expect(await toolBulkUpdate(env, MB, { ids: ["a"], action: "move", folderId: Folders.DRAFT })).toHaveProperty("error");
		expect(await toolBulkUpdate(env, MB, { ids: ["a"], action: "move" })).toHaveProperty("error");
		expect(bulkMoveEmails).not.toHaveBeenCalled();
	});

	it("needs a labelId to label", async () => {
		expect(await toolBulkUpdate(envWith({}), MB, { ids: ["a"], action: "label" })).toHaveProperty("error");
	});

	it("trash uses the trash-only path and reports what it skipped", async () => {
		const trashEmailsOnly = vi.fn(async () => ({
			trashed: ["a"],
			alreadyBinned: ["b", "c"],
			missing: ["d"],
		}));
		const bulkDeleteEmails = vi.fn();
		const env = envWith({ trashEmailsOnly, bulkDeleteEmails });
		const result = await toolBulkUpdate(env, MB, { ids: ["a", "b", "c", "d"], action: "trash" });
		expect(trashEmailsOnly).toHaveBeenCalledWith(["a", "b", "c", "d"]);
		expect(bulkDeleteEmails).not.toHaveBeenCalled();
		expect(result).toEqual({
			action: "trash",
			affected: 1,
			skipped_already_binned: ["b", "c"],
			not_found: ["d"],
		});
	});

	it("caps the id list", async () => {
		const ids = Array.from({ length: 101 }, (_, i) => `id${i}`);
		expect(await toolBulkUpdate(envWith({}), MB, { ids, action: "read" })).toHaveProperty("error");
	});
});

// ── forward_email ────────────────────────────────────────────────────

describe("toolForwardEmail", () => {
	const original = {
		id: "orig",
		subject: "Quarterly report",
		sender: "alice@example.com",
		recipient: MB,
		date: "2026-10-01T10:00:00Z",
		body: "<p>See attached.</p>",
		thread_id: "t1",
		message_id: "m1@example.com",
		email_references: null,
		attachments: [
			{ id: "att1", filename: "report.csv", mimetype: "text/csv", size: 5, disposition: "attachment" },
			{ id: "att2", filename: "evil.exe", mimetype: "application/octet-stream", size: 5, disposition: "attachment" },
		],
	};

	function forwardEnv() {
		const send = vi.fn(async () => ({ messageId: "provider-1" }));
		const createEmail = vi.fn(async () => undefined);
		const appendDeliveryEvent = vi.fn(async () => undefined);
		const r2 = bucket({ "attachments/orig/att1/report.csv": "a,b\n1,2" });
		const env = envWith(
			{
				checkSendRateLimit: async () => null,
				getEmailByRef: async (ref: string) => (ref === "orig" ? original : null),
				getEmail: async () => original,
				createEmail,
				appendDeliveryEvent,
			},
			{ EMAIL: { send }, BUCKET: r2, AI: passthroughAI },
		);
		return { env, send, createEmail, r2 };
	}

	it("sends a threaded forward with safe attachments and stores it in Sent", async () => {
		const { env, send, createEmail, r2 } = forwardEnv();
		const result = await toolForwardEmail(env, MB, { emailId: "orig", to: "bob@example.com" });

		expect(result).toMatchObject({ status: "sent" });
		const message = send.mock.calls[0]![0] as Record<string, any>;
		expect(message.subject).toBe("Fwd: Quarterly report");
		expect(message.from).toBe(MB);
		expect(message.headers["In-Reply-To"]).toBe("<m1@example.com>");
		// The executable is never re-sent.
		expect(message.attachments.map((a: { filename: string }) => a.filename)).toEqual(["report.csv"]);
		expect(atob(message.attachments[0].content)).toBe("a,b\n1,2");
		expect(message.html).toContain("Forwarded message");
		expect(message.html).toContain("alice@example.com");

		const [folder, row] = createEmail.mock.calls[0]! as unknown as [string, Record<string, unknown>];
		expect(folder).toBe(Folders.SENT);
		expect(row).toMatchObject({ thread_id: "t1", message_id: "provider-1", in_reply_to: "m1@example.com" });
		// A copy of the forwarded attachment is stored under the new message.
		expect([...r2.store.keys()].some((k) => k.startsWith(`attachments/${row.id}/`))).toBe(true);
	});

	it("can leave attachments out", async () => {
		const { env, send } = forwardEnv();
		await toolForwardEmail(env, MB, { emailId: "orig", to: "bob@example.com", includeAttachments: false });
		expect((send.mock.calls[0]![0] as Record<string, unknown>).attachments).toBeUndefined();
	});

	it("reports a missing original without sending", async () => {
		const { env, send } = forwardEnv();
		expect(await toolForwardEmail(env, MB, { emailId: "nope", to: "bob@example.com" })).toEqual({
			error: "Original email not found",
		});
		expect(send).not.toHaveBeenCalled();
	});

	it("honours the send rate limit", async () => {
		const send = vi.fn();
		const env = envWith({ checkSendRateLimit: async () => "Hourly limit reached" }, { EMAIL: { send } });
		expect(await toolForwardEmail(env, MB, { emailId: "orig", to: "bob@example.com" })).toEqual({
			error: "Hourly limit reached",
		});
		expect(send).not.toHaveBeenCalled();
	});

	it("does not send an unverified note when the verifier is down", async () => {
		const { env, send } = forwardEnv();
		(env as unknown as { AI: unknown }).AI = brokenAI;
		const result = await toolForwardEmail(env, MB, {
			emailId: "orig",
			to: "bob@example.com",
			note: "Bob, please review this report before Friday's meeting.",
		});
		expect(result).toHaveProperty("error");
		expect(send).not.toHaveBeenCalled();
	});

	it("prefixes the subject once", () => {
		expect(forwardSubject("Fwd: x")).toBe("Fwd: x");
		expect(forwardSubject("fw: x")).toBe("fw: x");
		expect(forwardSubject("x")).toBe("Fwd: x");
		expect(forwardSubject("")).toBe("Fwd:");
	});
});

// ── Scheduled sends ──────────────────────────────────────────────────

describe("scheduled sends", () => {
	const NOW = Date.parse("2026-10-25T12:00:00Z");

	it("queues a message with the row shape the dispatcher reads", async () => {
		const createScheduledEmail = vi.fn(async () => undefined);
		const env = envWith({ createScheduledEmail }, { AI: passthroughAI });
		const result = await toolScheduleSend(env, MB, {
			to: ["a@x.com", "b@x.com"],
			cc: "c@x.com",
			subject: "Hello",
			bodyHtml: "<p>Hi</p>",
			delaySeconds: 3600,
			now: NOW,
		});
		expect(result).toMatchObject({ status: "scheduled", send_at: "2026-10-25T13:00:00.000Z" });

		const [row, attachments, sendAt] = createScheduledEmail.mock.calls[0]! as unknown as [
			Record<string, string>,
			unknown[],
			string,
		];
		expect(sendAt).toBe("2026-10-25T13:00:00.000Z");
		expect(attachments).toEqual([]);
		expect(row.recipient).toBe("a@x.com, b@x.com");
		expect(row.cc).toBe("c@x.com");
		const headers = JSON.parse(row.raw_headers) as { key: string; value: string }[];
		expect(headers).toContainEqual({ key: "cc", value: "c@x.com" });
		expect(headers.find((h) => h.key === "message-id")).toBeUndefined();
	});

	it("threads a scheduled reply and marks the thread read", async () => {
		const createScheduledEmail = vi.fn(async () => undefined);
		const markThreadRead = vi.fn(async () => undefined);
		const env = envWith(
			{
				createScheduledEmail,
				markThreadRead,
				getEmailByRef: async () => ({ id: "orig", thread_id: "t9", message_id: "m9@x", email_references: null }),
				getEmail: async () => null,
			},
			{ AI: passthroughAI },
		);
		await toolScheduleSend(env, MB, {
			to: "a@x.com",
			subject: "Re: hi",
			bodyHtml: "<p>Yes</p>",
			sendAt: "2026-10-26T09:00:00Z",
			replyToEmailId: "orig",
			now: NOW,
		});
		const row = createScheduledEmail.mock.calls[0]![0] as unknown as Record<string, string>;
		expect(row.thread_id).toBe("t9");
		expect(row.in_reply_to).toBe("m9@x");
		expect(markThreadRead).toHaveBeenCalledWith("t9");
	});

	it("refuses bad timing without queueing", async () => {
		const createScheduledEmail = vi.fn();
		const env = envWith({ createScheduledEmail }, { AI: passthroughAI });
		const base = { to: "a@x.com", subject: "s", bodyHtml: "<p>b</p>", now: NOW };
		for (const timing of [
			{},
			{ sendAt: "2026-10-01T00:00:00Z" },
			{ sendAt: "soon" },
			{ delaySeconds: 91 * 24 * 3600 },
		]) {
			expect(await toolScheduleSend(env, MB, { ...base, ...timing })).toHaveProperty("error");
		}
		expect(createScheduledEmail).not.toHaveBeenCalled();
	});

	it("lists pending sends compactly, and all on request", async () => {
		const rows = [
			{ email_id: "s1", send_at: "2026-10-26T00:00:00Z", status: "pending", subject: "A", recipient: "a@x.com", snippet: "<p>hi</p>" },
			{ email_id: "s2", send_at: "2026-10-20T00:00:00Z", status: "sent", subject: "B", recipient: "b@x.com", snippet: "" },
		];
		const env = envWith({ listScheduledSends: async () => rows });
		const pending = await toolListScheduled(env, MB);
		expect(pending.scheduled).toEqual([
			{ id: "s1", send_at: "2026-10-26T00:00:00Z", status: "pending", subject: "A", to: "a@x.com", snippet: "hi" },
		]);
		expect((await toolListScheduled(env, MB, { status: "all" })).scheduled).toHaveLength(2);
	});

	it("cancels, and explains when it is too late", async () => {
		expect(
			await toolCancelScheduled(envWith({ cancelScheduledSend: async () => ({ cancelled: true, status: "cancelled" }) }), MB, "s1"),
		).toMatchObject({ status: "cancelled" });
		expect(
			await toolCancelScheduled(envWith({ cancelScheduledSend: async () => ({ cancelled: false, status: "sent" }) }), MB, "s1"),
		).toEqual({ error: "Cannot cancel: already sent", emailId: "s1" });
		expect(await toolCancelScheduled(envWith({ cancelScheduledSend: async () => null }), MB, "s1")).toHaveProperty("error");
	});
});

// ── Attachments ──────────────────────────────────────────────────────

describe("attachments", () => {
	it("classifies text-like types", () => {
		for (const t of ["text/plain", "text/csv; charset=utf-8", "application/json", "application/vnd.api+json", "image/svg+xml", "message/rfc822"]) {
			expect(isTextLikeMime(t)).toBe(true);
		}
		for (const t of ["application/pdf", "image/png", "application/octet-stream", "", null]) {
			expect(isTextLikeMime(t)).toBe(false);
		}
	});

	function attachmentEnv(row: Record<string, unknown> | null, blobs: Record<string, string | Uint8Array> = {}) {
		return envWith({ getAttachment: async () => row }, { BUCKET: bucket(blobs) });
	}

	it("returns text for text-like attachments", async () => {
		const env = attachmentEnv(
			{ id: "a1", email_id: "e1", filename: "notes.txt", mimetype: "text/plain", size: 5 },
			{ "attachments/e1/a1/notes.txt": "hello" },
		);
		expect(await toolGetAttachment(env, MB, "e1", "a1")).toEqual({
			id: "a1",
			filename: "notes.txt",
			mimetype: "text/plain",
			size: 5,
			encoding: "text",
			text: "hello",
		});
	});

	it("reads only the head of a large text attachment", async () => {
		const r2 = bucket({ "attachments/e1/a1/log.txt": "z".repeat(10) });
		const get = vi.spyOn(r2, "get");
		const env = envWith(
			{ getAttachment: async () => ({ id: "a1", email_id: "e1", filename: "log.txt", mimetype: "text/plain", size: 5_000_000 }) },
			{ BUCKET: r2 },
		);
		const result = await toolGetAttachment(env, MB, "e1", "a1");
		expect(get).toHaveBeenCalledWith("attachments/e1/a1/log.txt", { range: { offset: 0, length: 400_000 } });
		expect(result).toMatchObject({ encoding: "text", truncated: true });
	});

	it("returns small binaries as base64", async () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		const env = attachmentEnv(
			{ id: "a1", email_id: "e1", filename: "x.png", mimetype: "image/png", size: 4 },
			{ "attachments/e1/a1/x.png": bytes },
		);
		const result = await toolGetAttachment(env, MB, "e1", "a1");
		expect(result).toMatchObject({ encoding: "base64", base64: "iVBORw==" });
	});

	it("returns only metadata for binaries over the cap, without reading the blob", async () => {
		const env = attachmentEnv({
			id: "a1",
			email_id: "e1",
			filename: "big.pdf",
			mimetype: "application/pdf",
			size: ATTACHMENT_DEFAULT_MAX_BYTES + 1,
		});
		const result = await toolGetAttachment(env, MB, "e1", "a1");
		expect(result).toMatchObject({ encoding: "none", size: ATTACHMENT_DEFAULT_MAX_BYTES + 1 });
		expect(result).not.toHaveProperty("base64");
	});

	it("refuses blocked files and attachments of another message", async () => {
		const blocked = attachmentEnv({ id: "a1", email_id: "e1", filename: "setup.exe", mimetype: "application/octet-stream", size: 1 });
		expect(await toolGetAttachment(blocked, MB, "e1", "a1")).toMatchObject({ blocked: true });

		const other = attachmentEnv({ id: "a1", email_id: "OTHER", filename: "a.txt", mimetype: "text/plain", size: 1 });
		expect(await toolGetAttachment(other, MB, "e1", "a1")).toEqual({ error: "Attachment not found" });
	});

	it("lists attachments for a message", async () => {
		const env = envWith({
			getEmail: async () => ({
				id: "e1",
				attachments: [{ id: "a1", filename: "logo.png", mimetype: "image/png", size: 9, disposition: "inline", content_id: "c1" }],
			}),
		});
		expect(await toolListAttachments(env, MB, "e1")).toEqual({
			emailId: "e1",
			attachments: [{ id: "a1", filename: "logo.png", mimetype: "image/png", size: 9, inline: true }],
		});
	});
});

// ── Templates ────────────────────────────────────────────────────────

describe("templates", () => {
	const template: EmailTemplate = {
		id: "t1",
		slug: "welcome",
		name: "Welcome",
		subject: "Welcome, {{name}}",
		bodyHtml: "<p>Hi {{name}}, your plan is {{plan}}.</p>",
		createdAt: 1,
		updatedAt: 1,
	};

	it("escapes variables into the body but not the subject", () => {
		const rendered = renderTemplateForSend(template, { name: "<Ada & co>", plan: "Pro" });
		expect(rendered).toEqual({
			subject: "Welcome, <Ada & co>",
			bodyHtml: "<p>Hi &lt;Ada &amp; co&gt;, your plan is Pro.</p>",
		});
	});

	it("flattens line breaks in subject values", () => {
		const rendered = renderTemplateForSend(template, { name: "Ada\r\nBcc: x@evil.com", plan: "Pro" });
		expect((rendered as { subject: string }).subject).toBe("Welcome, Ada Bcc: x@evil.com");
	});

	it("refuses to send with a placeholder left unfilled", () => {
		expect(renderTemplateForSend(template, { name: "Ada" })).toEqual({
			error: "Missing template variables: plan",
			missing: ["plan"],
		});
	});

	it("lists templates with their variables", async () => {
		const env = envWith({}, { BUCKET: bucket({ "templates/welcome.json": JSON.stringify(template) }) });
		expect(await toolListTemplates(env)).toEqual({
			templates: [{ slug: "welcome", name: "Welcome", subject: "Welcome, {{name}}", variables: ["name", "plan"] }],
		});
	});

	it("sends a rendered template without the AI verifier", async () => {
		const send = vi.fn(async () => ({ messageId: "p1" }));
		const createEmail = vi.fn(async () => undefined);
		const env = envWith(
			{ checkSendRateLimit: async () => null, createEmail, appendDeliveryEvent: async () => undefined },
			{
				EMAIL: { send },
				BUCKET: bucket({ "templates/welcome.json": JSON.stringify(template) }),
				AI: brokenAI,
			},
		);
		const result = await toolSendTemplate(env, MB, {
			slug: "welcome",
			to: "ada@example.com",
			variables: { name: "Ada", plan: "Pro" },
		});
		expect(result).toMatchObject({ status: "sent" });
		expect(send.mock.calls[0]![0]).toMatchObject({
			to: "ada@example.com",
			subject: "Welcome, Ada",
			html: prepareOutgoingHtml("<p>Hi Ada, your plan is Pro.</p>"),
		});
	});

	it("reports an unknown template", async () => {
		const env = envWith({}, { BUCKET: bucket() });
		const result = await toolSendTemplate(env, MB, { slug: "nope", to: "a@b.com", variables: {} });
		expect((result as { error: string }).error).toContain("list_templates");
	});
});

// ── People ───────────────────────────────────────────────────────────

describe("people", () => {
	const row = (email: string, unread: number, last: string) => ({
		email,
		fromHeader: null,
		lastEmailAt: last,
		unreadCount: unread,
		totalCount: unread + 1,
		hasAttachment: 0,
	});

	it("merges across mailboxes, paginates, and reports a failed mailbox", async () => {
		const env = envPerMailbox({
			"a@t.com": { getPeople: async () => [row("x@y.com", 1, "2026-10-02T00:00:00Z"), row("z@y.com", 0, "2026-10-01T00:00:00Z")] },
			"b@t.com": { getPeople: async () => [row("x@y.com", 2, "2026-10-03T00:00:00Z")] },
			"c@t.com": {
				getPeople: async () => {
					throw new Error("down");
				},
			},
		});
		const result = await toolListPeople(env, ["a@t.com", "b@t.com", "c@t.com"], { page: 1, limit: 1 });
		expect(result.total).toBe(2);
		expect(result.next_page).toBe(2);
		expect(result.people[0]).toMatchObject({ email: "x@y.com", unread: 3, mailboxes: ["a@t.com", "b@t.com"] });
		expect(result.degraded).toEqual(["c@t.com"]);
	});

	it("only fans out to the mailboxes it is given", async () => {
		const seen: string[] = [];
		const env = {
			MAILBOX: {
				idFromName: (name: string) => ({ name }),
				get: (id: { name: string }) => ({
					getPersonEmails: async () => {
						seen.push(id.name);
						return [{ id: `${id.name}-1`, date: "2026-10-01T00:00:00Z", snippet: "<p>hi</p>" }];
					},
				}),
			},
		} as unknown as Env;
		const result = await toolGetPersonHistory(env, ["a@t.com"], { person: " X@Y.com ", limit: 10 });
		expect(seen).toEqual(["a@t.com"]);
		expect(result).toMatchObject({ person: "x@y.com", count: 1 });
		expect((result as { emails: Record<string, unknown>[] }).emails[0]).toMatchObject({ mailboxId: "a@t.com", snippet: "hi" });
	});
});

// ── Rules, signatures, summary ───────────────────────────────────────

describe("rules", () => {
	it("lists and creates", async () => {
		const rule = { id: "r1", name: "Receipts" };
		const createRule = vi.fn(async () => rule);
		const env = envWith({ getRules: async () => [rule], createRule });
		expect(await toolListRules(env, MB)).toEqual({ rules: [rule] });
		const input = {
			name: "Receipts",
			conditions: [{ field: "from" as const, operator: "domain_is" as const, value: "stripe.com" }],
			actions: [{ type: "apply_label" as const, value: "l1" }],
		};
		expect(await toolCreateRule(env, MB, input)).toEqual({ status: "created", rule });
		expect(createRule).toHaveBeenCalledWith(input);
	});

	it("turns the rule limit into a tool error", async () => {
		const err = Object.assign(new Error("A mailbox may have at most 100 rules"), { name: "RuleLimitError" });
		const env = envWith({
			createRule: async () => {
				throw err;
			},
		});
		expect(
			await toolCreateRule(env, MB, { name: "x", conditions: [{ field: "from", operator: "contains", value: "a" }], actions: [{ type: "star" }] }),
		).toEqual({ error: "A mailbox may have at most 100 rules" });
	});
});

describe("toolListSignatures", () => {
	it("returns text and only returns HTML on request", async () => {
		const env = envWith({
			getSignatures: async () => [{ id: "s1", name: "Main", body_html: "<p>Ada<br>CEO</p>", is_default: 1 }],
		});
		expect(await toolListSignatures(env, MB)).toEqual({
			signatures: [{ id: "s1", name: "Main", is_default: true, text: "Ada\nCEO" }],
		});
		const withBody = await toolListSignatures(env, MB, { includeBody: true });
		expect(withBody.signatures[0]).toHaveProperty("body_html", "<p>Ada<br>CEO</p>");
	});
});

describe("toolMailboxSummary", () => {
	it("aggregates folders, needs-reply, scheduled, snoozed and top senders", async () => {
		const getThreadedEmails = vi.fn(async () => [{ needs_reply: true }, { needs_reply: false }, { needs_reply: true }]);
		const env = envWith({
			getFolders: async () => [
				{ id: "inbox", name: "Inbox", unreadCount: 4 },
				{ id: "spam", name: "Spam", unreadCount: 1 },
			],
			getThreadedEmails,
			getPeople: async () => [
				{ email: "quiet@x.com", fromHeader: null, lastEmailAt: null, unreadCount: 0, totalCount: 9, hasAttachment: 0 },
				{ email: "loud@x.com", fromHeader: "Loud Person <loud@x.com>", lastEmailAt: "2026-10-01", unreadCount: 3, totalCount: 3, hasAttachment: 0 },
			],
			listScheduledSends: async () => [{ status: "pending" }, { status: "sent" }],
			getSnoozedEmails: async () => [{}, {}],
		});
		const summary = await toolMailboxSummary(env, MB, { topSenders: 1 });
		expect(summary).toMatchObject({
			mailboxId: MB,
			unread_by_folder: { inbox: 4, spam: 1 },
			inbox_unread: 4,
			needs_reply: 2,
			scheduled_pending: 1,
			snoozed: 2,
			top_senders: [{ email: "loud@x.com", name: "Loud Person", unread: 3, total: 3 }],
		});
		expect(getThreadedEmails).toHaveBeenCalledWith({ folder: Folders.INBOX, limit: 100 });
	});
});

// ── trashOnly, against real SQLite ───────────────────────────────────

describe("trashOnly", () => {
	function setup() {
		const db = new DatabaseSync(":memory:");
		db.exec(`
			CREATE TABLE emails (
				id TEXT PRIMARY KEY,
				folder_id TEXT NOT NULL,
				trashed_from TEXT,
				trashed_at TEXT,
				snoozed_until TEXT,
				snooze_return_folder TEXT
			);
		`);
		const ctx = {
			storage: {
				sql: {
					exec(sql: string, ...params: unknown[]) {
						const statement = db.prepare(sql);
						if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) {
							const result = statement.run(...(params as never[]));
							return { toArray: () => [], rowsWritten: Number(result.changes) };
						}
						return { toArray: () => statement.all(...(params as never[])), rowsWritten: 0 };
					},
				},
				transactionSync: <T>(fn: () => T): T => {
					db.exec("BEGIN");
					try {
						const out = fn();
						db.exec("COMMIT");
						return out;
					} catch (e) {
						db.exec("ROLLBACK");
						throw e;
					}
				},
			},
		} as unknown as DurableObjectState;
		const seed = (id: string, folder: string) =>
			db.prepare(`INSERT INTO emails (id, folder_id, snoozed_until) VALUES (?, ?, '2030-01-01')`).run(id, folder);
		const folderOf = (id: string) =>
			(db.prepare(`SELECT folder_id, trashed_from, snoozed_until FROM emails WHERE id = ?`).get(id) ?? null) as
				| { folder_id: string; trashed_from: string | null; snoozed_until: string | null }
				| null;
		return { ctx, seed, folderOf };
	}

	it("bins ordinary mail and never removes a row", () => {
		const { ctx, seed, folderOf } = setup();
		seed("inbox-1", "inbox");
		seed("archive-1", "archive");
		seed("trash-1", "trash");
		seed("spam-1", "spam");

		const result = trashOnly(ctx, ["inbox-1", "archive-1", "trash-1", "spam-1", "ghost", "inbox-1"], {
			now: "2026-10-25T00:00:00Z",
		});

		expect(result).toEqual({
			trashed: ["inbox-1", "archive-1"],
			alreadyBinned: ["trash-1", "spam-1"],
			missing: ["ghost"],
		});
		expect(folderOf("inbox-1")).toEqual({ folder_id: "trash", trashed_from: "inbox", snoozed_until: null });
		expect(folderOf("archive-1")).toMatchObject({ folder_id: "trash", trashed_from: "archive" });
		// The binned ones are untouched, and still exist.
		expect(folderOf("trash-1")).toMatchObject({ folder_id: "trash", trashed_from: null });
		expect(folderOf("spam-1")).toMatchObject({ folder_id: "spam" });
	});

	it("handles an empty or junk id list", () => {
		const { ctx } = setup();
		expect(trashOnly(ctx, [])).toEqual({ trashed: [], alreadyBinned: [], missing: [] });
		expect(trashOnly(ctx, "nope")).toEqual({ trashed: [], alreadyBinned: [], missing: [] });
	});
});
