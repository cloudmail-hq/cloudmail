// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Capability enforcement on the two surfaces that are not the REST API.
 *
 * `test/capabilities.test.ts` covers the vocabulary and the HTTP gates. This
 * file covers the ways into a mailbox that bypass them entirely:
 *
 * - **MCP** (`/mcp`), whose tools take a `mailboxId` argument and include
 *   `send_email` and `delete_email`. Its gate is `verifyMailbox`, not Hono
 *   middleware, so nothing in `capabilities.test.ts` reaches it.
 * - **The agent socket** (`/agents/*`), which upgrades to a WebSocket. Once open,
 *   every message on it is invisible to HTTP middleware, so the connection is the
 *   only thing that can be gated.
 *
 * Both used to check reachability alone. That made the narrowing enforced on the
 * REST API decorative: a `viewer` grant — read and nothing else — could connect
 * over MCP and call `send_email`, because holding the mailbox at all was the
 * whole test. These tests exist to keep that shut.
 *
 * The MCP tests drive `toolDeleteEmail` and the attribution helper directly
 * rather than standing up an MCP server, because the `McpAgent` base class needs
 * a Durable Object runtime. What they assert is the part that was wrong: which
 * capability each tool demands, and what the tool does when the answer is no.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
	canAccessMailbox,
	canDo,
	sendAttributionFor,
	type AccessIdentity,
	type Principal,
} from "../workers/lib/authz";
import { TERMINAL_FOLDERS } from "../workers/durableObject/trash";
import { AGENT_SOCKET_CAPABILITIES } from "../workers/lib/capabilities";
import { toolDeleteEmail } from "../workers/lib/tools";
import { Folders } from "../shared/folders";
import type { Env } from "../workers/types";

const SUPPORT = "support@tapetide.com";
const OPERATOR = "agent@tapetide.com";

function identity(id = OPERATOR): AccessIdentity {
	return { kind: "user", id, subject: "uuid-1" };
}

/** A member holding exactly one mailbox, at the given role. */
function member(role: string, mailboxId = SUPPORT): Principal {
	return {
		identity: identity(),
		role: "member",
		mailboxes: [mailboxId],
		access: [{ id: mailboxId, role: role as never }],
		enforced: true,
		developmentBypass: false,
	};
}

/** An admin, or an unenforced deployment: unrestricted everywhere. */
function unrestricted(): Principal {
	return {
		identity: identity(),
		role: "admin",
		mailboxes: null,
		access: null,
		enforced: true,
		developmentBypass: false,
	};
}

// -- MCP: which capability each tool demands ------------------------
//
// The table is asserted rather than the server, because the defect was the
// mapping. Each row is the capability `verifyMailbox` is called with in
// `workers/mcp/index.ts`, and the test is that a role which should not reach the
// tool does not hold that capability.

const MCP_TOOL_CAPABILITIES = {
	list_emails: "read",
	get_email: "read",
	get_thread: "read",
	search_emails: "read",
	// With one mailbox named; "*" narrows to readableMailboxes instead.
	semantic_search: "read",
	ask_inbox: "read",
	draft_reply: "draft",
	create_draft: "draft",
	update_draft: "draft",
	delete_email: "delete",
	send_reply: "sendAs|sendOnBehalf",
	send_email: "sendAs|sendOnBehalf",
	revise_pending_send: "sendAs|sendOnBehalf",
	mark_email_read: "organise",
	move_email: "organise",
	get_mailbox_summary: "read",
	// Optional mailbox, gated when given; the fan-out is narrowed to readable ones.
	get_daily_brief: "read",
	list_folders: "read",
	list_labels: "read",
	list_scheduled: "read",
	list_attachments: "read",
	get_attachment: "read",
	list_rules: "read",
	list_signatures: "read",
	// The mailbox is optional on these two; when given it is gated, and the
	// fan-out is narrowed to readable mailboxes either way.
	list_people: "read",
	get_person_history: "read",
	create_folder: "organise",
	create_label: "organise",
	apply_label: "organise",
	remove_label: "organise",
	star_email: "organise",
	snooze_email: "organise",
	unsnooze_email: "organise",
	list_awaiting_reply: "read",
	set_followup: "organise",
	list_label_prompts: "read",
	set_label_prompt: "manageRules",
	list_screener: "read",
	screen_sender: "manageRules",
	set_priority: "organise",
	archive_email: "organise",
	mark_not_spam: "organise",
	trash_email: "delete",
	restore_email: "delete",
	create_rule: "manageRules",
	forward_email: "sendAs|sendOnBehalf",
	schedule_send: "sendAs|sendOnBehalf",
	cancel_scheduled: "sendAs|sendOnBehalf",
	send_template: "sendAs|sendOnBehalf",
	// Enrolling sends every step from the mailbox, as on POST /sequences/:id/enroll.
	enroll_in_sequence: "sendAs|sendOnBehalf",
	// Reading the approval queue is reading, as on GET /approvals; there is no
	// tool that decides one.
	list_pending_sends: "read",
	get_pending_send: "read",
	check_suppressions: "read",
	get_thread_summary: "read",
	get_analytics: "read",
	list_imports: "read",
	// Signatures are outgoing identity: POST /signatures needs manageSettings.
	create_signature: "manageSettings",
} as const;

describe("MCP tool gating", () => {
	it("lets a viewer read and nothing else", () => {
		const viewer = member("viewer");

		for (const [tool, gate] of Object.entries(MCP_TOOL_CAPABILITIES)) {
			// A `|`-joined gate means any one of them is enough.
			const allowed = gate
				.split("|")
				.some((capability) => canDo(viewer, SUPPORT, capability as never));
			// Read tools pass; everything that changes or sends mail does not.
			expect({ tool, allowed }).toEqual({ tool, allowed: gate === "read" });
		}
	});

	it("refuses a viewer the send tools specifically", () => {
		const viewer = member("viewer");
		expect(canDo(viewer, SUPPORT, "sendOnBehalf")).toBe(false);
		expect(canDo(viewer, SUPPORT, "sendAs")).toBe(false);
		// The regression this file exists for: reachable, but may not send.
		expect(canAccessMailbox(viewer, SUPPORT)).toBe(true);
	});

	it("lets an agent draft and send on behalf, but not purge", () => {
		const agent = member("agent");
		expect(canDo(agent, SUPPORT, "draft")).toBe(true);
		expect(canDo(agent, SUPPORT, "sendOnBehalf")).toBe(true);
		expect(canDo(agent, SUPPORT, "delete")).toBe(true);
		expect(canDo(agent, SUPPORT, "deletePermanently")).toBe(false);
		expect(canDo(agent, SUPPORT, "manageSettings")).toBe(false);
	});

	it("gives every tool a capability no weaker than what it does", () => {
		// A tool that sends must not be gated on a read, and so on. Catches a
		// future tool being added with a copy-pasted gate.
		expect(MCP_TOOL_CAPABILITIES.send_email).toBe("sendAs|sendOnBehalf");
		expect(MCP_TOOL_CAPABILITIES.send_reply).toBe("sendAs|sendOnBehalf");
		expect(MCP_TOOL_CAPABILITIES.create_draft).toBe("draft");
		expect(MCP_TOOL_CAPABILITIES.delete_email).toBe("delete");
		// No send tool is gated on `sendAs` *alone*. Both are accepted, because they
		// are independently grantable and differ in attribution rather than power;
		// which one is used is `sendAttributionFor`'s decision inside the tool.
		expect(Object.values(MCP_TOOL_CAPABILITIES)).not.toContain("sendAs");
	});

	it("refuses a mailbox the session does not hold at all", () => {
		const agent = member("agent", SUPPORT);
		expect(canAccessMailbox(agent, "sales@tapetide.com")).toBe(false);
		// And the capability check agrees, so a missing reachability check upstream
		// does not leave the tool open.
		expect(canDo(agent, "sales@tapetide.com", "read")).toBe(false);
	});

	/**
	 * The table above is a transcription, and a transcription can drift from what
	 * it describes. This reads the real module and checks the two agree, so a tool
	 * added or re-gated without updating the table fails here rather than being
	 * quietly untested.
	 *
	 * Source text rather than the module itself because `EmailMCP` extends
	 * `McpAgent`, which needs a Durable Object runtime to import.
	 */
	it("matches the gates actually written in workers/mcp/index.ts", () => {
		const source = readFileSync(
			new URL("../workers/mcp/index.ts", import.meta.url),
			"utf8",
		);

		// Each tool registration, paired with the capability its handler gates on.
		const found: Record<string, string> = {};
		const toolPattern = /this\.server\.tool\(\s*"([a-z_]+)"/g;
		// Two forms: a single capability, or an array meaning "any of these".
		// Normalised to a `|`-joined string so the table stays one line per tool.
		const gatePattern =
			/verifyMailbox\(mailboxId,\s*(?:"([A-Za-z]+)"|\[([^\]]+)\])\)/g;

		const tools = [...source.matchAll(toolPattern)].map((m) => ({
			name: m[1]!,
			at: m.index!,
		}));
		for (const gate of source.matchAll(gatePattern)) {
			// The tool this gate sits inside is the last one registered before it.
			const owner = tools.filter((t) => t.at < gate.index!).pop();
			expect(owner, `gate at ${gate.index} belongs to no tool`).toBeDefined();
			found[owner!.name] =
				gate[1] ??
				[...gate[2]!.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]!).join("|");
		}

		expect(found).toEqual(MCP_TOOL_CAPABILITIES);

		// Instance-wide tools have no `mailboxId`; they must gate on admin instead.
		const adminGated = new Set<string>();
		// `isAdminFor(..., "domains:manage")`: admin, and a scoped token holds
		// domains:manage or admin.
		for (const gate of source.matchAll(/if \(!isAdminFor\(who\.principal, "domains:manage"\)\)/g)) {
			const owner = tools.filter((t) => t.at < gate.index!).pop();
			if (owner) adminGated.add(owner.name);
		}
		expect([...adminGated].sort()).toEqual(["get_domain_status", "list_domains"]);
		// Agent inbox tools: admin, and a scoped token holds mailboxes:manage or admin.
		for (const gate of source.matchAll(/if \(!isAdminFor\(who\.principal, "mailboxes:manage"\)\)/g)) {
			const owner = tools.filter((t) => t.at < gate.index!).pop();
			if (owner) adminGated.add(owner.name);
		}
		expect([...adminGated].filter((n) => n.includes("agent_inbox")).sort()).toEqual([
			"create_agent_inbox",
			"delete_agent_inbox",
			"list_agent_inboxes",
		]);
		// The whole suppression list: admin, as writing it is (requireAdminScope("mailboxes:manage")).
		expect(adminGated.has("list_suppressions")).toBe(true);
		// Usage: admin with the admin scope, as GET /api/v1/usage.
		for (const gate of source.matchAll(/if \(!isAdminFor\(who\.principal, "admin"\)\)/g)) {
			const owner = tools.filter((t) => t.at < gate.index!).pop();
			if (owner) adminGated.add(owner.name);
		}
		expect(adminGated.has("get_usage")).toBe(true);

		// And every mailbox-scoped tool is gated. `list_mailboxes` is the only one
		// without a `mailboxId`, and it filters its own output instead.
		//
		// `list_templates` reads instance-wide templates, not a mailbox, matching
		// GET /api/v1/templates. `bulk_update` gates on a capability computed from
		// its action, which the regex cannot see; it has its own test below.
		// Admin-gated (instance-wide) tools are checked above. The webhook tools
		// gate on `canManageEndpoint` (workers/lib/webhooks.ts), asserted below.
		// `list_products` is instance-wide identity (like templates); the mailboxes it
		// names per product come from `readableMailboxes`.
		// Sequences and template writes are instance-wide definitions, gated on
		// token scopes like their REST routes (asserted in mcp-token-scopes.test.ts).
		const NOT_MAILBOX_GATED = [
			"list_mailboxes",
			"list_templates",
			"list_products",
			"bulk_update",
			"list_webhooks",
			"test_webhook",
			"list_sequences",
			"create_template",
			"update_template",
		];
		const ungated = tools
			.map((t) => t.name)
			.filter((name) => !NOT_MAILBOX_GATED.includes(name) && !(name in found) && !adminGated.has(name));
		expect(ungated).toEqual([]);

		// The exceptions really are gated the way the comment says.
		expect(source).toMatch(
			/verifyMailbox\(mailboxId, BULK_TOOL_CAPABILITIES\[action\]\)/,
		);
		expect(source).toMatch(/canManageWebhooks\(who\.principal\)/);
		expect(source).toMatch(/canManageEndpoint\(who\.principal, endpoint\.mailboxes\)/);
	});

	it("never exposes permanent deletion over MCP", () => {
		const source = readFileSync(
			new URL("../workers/mcp/index.ts", import.meta.url),
			"utf8",
		);
		// No tool gates on `deletePermanently`, and delete_email never asks to
		// destroy.
		expect(source).not.toMatch(/verifyMailbox\([^)]*deletePermanently/);
		expect(source).not.toMatch(/toolDeleteEmail|bulkDeleteEmails/);
		expect(source).not.toMatch(/"empty_trash"|emptyTrash/);
	});
});

// -- MCP: attribution on the send tools ----------------------------

describe("MCP send attribution", () => {
	it("names the operator when the grant is send-on-behalf", () => {
		const attribution = sendAttributionFor(member("agent"), SUPPORT);
		expect(attribution).toEqual({ mode: "onBehalfOf", sender: OPERATOR });
	});

	it("sends as the mailbox when the grant allows it", () => {
		// `manager` holds both; Send As wins, so no `Sender:` is emitted.
		expect(sendAttributionFor(member("manager"), SUPPORT)).toEqual({ mode: "as" });
		expect(sendAttributionFor(unrestricted(), SUPPORT)).toEqual({ mode: "as" });
	});

	it("refuses rather than sending unattributed", () => {
		expect(sendAttributionFor(member("viewer"), SUPPORT)).toBeNull();
		// A send-on-behalf grant with nobody to attribute it to is also a refusal,
		// not a silent send as the mailbox.
		const anonymous = { ...member("agent"), identity: null };
		expect(sendAttributionFor(anonymous, SUPPORT)).toBeNull();
	});
});

// -- MCP: delete_email escalates with the folder --------------------
//
// `delete_email` bins a message in an ordinary folder and destroys one already in
// Trash or Spam, so the authority it needs is not knowable from the call — only
// from where the message sits. These drive the real helper against a stub stub.

function deleteEnv(folder: string | null) {
	const calls: { deleted: string[] } = { deleted: [] };
	const env = {
		MAILBOX: {
			idFromName: (name: string) => ({ name }),
			get: () => ({
				async getEmailFolder() {
					return folder;
				},
				async deleteEmail(id: string) {
					calls.deleted.push(id);
					return folder && TERMINAL_FOLDERS.includes(folder)
						? { trashed: 0, deleted: 1, attachmentKeys: [] }
						: { trashed: 1, deleted: 0, attachmentKeys: [] };
				},
			}),
		},
	} as unknown as Env;
	return { env, calls };
}

describe("toolDeleteEmail", () => {
	it("bins an inbox message for a caller who may only bin", async () => {
		const { env, calls } = deleteEnv(Folders.INBOX);
		const result = await toolDeleteEmail(env, SUPPORT, "e1", { mayDestroy: false });

		expect(result).toEqual({
			status: "trashed",
			emailId: "e1",
			message: "Moved to Trash.",
		});
		expect(calls.deleted).toEqual(["e1"]);
	});

	it("refuses to destroy a binned message without deletePermanently", async () => {
		const { env, calls } = deleteEnv(Folders.TRASH);
		const result = await toolDeleteEmail(env, SUPPORT, "e1", { mayDestroy: false });

		expect(result).toMatchObject({ emailId: "e1" });
		expect(result).toHaveProperty("error");
		expect((result as { error: string }).error).toContain("deletePermanently");
		// The important half: it did not fall through and destroy it anyway, and it
		// did not report success having done nothing.
		expect(calls.deleted).toEqual([]);
	});

	it("treats Spam as terminal too", async () => {
		const { env, calls } = deleteEnv(Folders.SPAM);
		const result = await toolDeleteEmail(env, SUPPORT, "e1", { mayDestroy: false });

		expect(result).toHaveProperty("error");
		expect(calls.deleted).toEqual([]);
	});

	it("destroys a binned message when the caller may", async () => {
		const { env, calls } = deleteEnv(Folders.TRASH);
		const result = await toolDeleteEmail(env, SUPPORT, "e1", { mayDestroy: true });

		expect(result).toEqual({
			status: "deleted",
			emailId: "e1",
			message: "Permanently deleted.",
		});
		expect(calls.deleted).toEqual(["e1"]);
	});

	it("reports an unknown id as not found, not as a permission problem", async () => {
		const { env, calls } = deleteEnv(null);
		const result = await toolDeleteEmail(env, SUPPORT, "nope", { mayDestroy: false });

		expect(result).toEqual({ error: "Email not found", emailId: "nope" });
		expect(calls.deleted).toEqual([]);
	});

	it("skips the folder lookup entirely when the caller may destroy", async () => {
		// `mayDestroy: true` needs no pre-check, so an owner pays no extra DO call.
		let looked = 0;
		const env = {
			MAILBOX: {
				idFromName: (name: string) => ({ name }),
				get: () => ({
					async getEmailFolder() {
						looked += 1;
						return Folders.INBOX;
					},
					async deleteEmail() {
						return { trashed: 1, deleted: 0, attachmentKeys: [] };
					},
				}),
			},
		} as unknown as Env;

		await toolDeleteEmail(env, SUPPORT, "e1", { mayDestroy: true });
		expect(looked).toBe(0);
	});
});

// -- The agent socket ----------------------------------------------
//
// Mirrors the real gate in `workers/app.ts`: reachability, then `draft`, because
// every tool the agent has either writes a draft or files mail and there is no
// send tool at all.

function agentApp(principal: Principal) {
	const app = new Hono<{ Variables: { principal: Principal } }>();

	app.use("*", async (c, next) => {
		c.set("principal", principal);
		return next();
	});

	app.all("/agents/*", async (c) => {
		const target = new URL(c.req.url).pathname.split("/")[3] ?? null;

		if (target && !canAccessMailbox(c.var.principal, target)) {
			return c.text("You do not have access to this mailbox", 403);
		}
		if (target) {
			const missing = AGENT_SOCKET_CAPABILITIES.filter(
				(capability) => !canDo(c.var.principal, target, capability),
			);
			if (missing.length > 0) {
				return c.text(
					`You do not have permission to use the agent in this mailbox (${missing.join(", ")})`,
					403,
				);
			}
		}
		return c.json({ reached: "agent" });
	});

	return (path: string) =>
		app.fetch(new Request(`https://mailer.tapetide.com${path}`));
}

describe("agent socket gating", () => {
	it("lets an agent-role member open the socket", async () => {
		const res = await agentApp(member("agent"))(`/agents/email-agent/${SUPPORT}`);
		expect(res.status).toBe(200);
	});

	it("refuses a viewer, and names every capability they lack", async () => {
		const res = await agentApp(member("viewer"))(`/agents/email-agent/${SUPPORT}`);
		expect(res.status).toBe(403);
		const body = await res.text();
		expect(body).toContain("draft");
		expect(body).toContain("organise");
	});

	it("refuses a grant holding draft but not organise", async () => {
		// The hole this closes: gating on `draft` alone opened a socket whose
		// `move_email` tool then walked around the `organise` revocation.
		const restricted: Principal = {
			identity: identity(),
			role: "member",
			mailboxes: [SUPPORT],
			access: [{ id: SUPPORT, role: "agent", revoked: ["organise"] }],
			enforced: true,
			developmentBypass: false,
		};

		const res = await agentApp(restricted)(`/agents/email-agent/${SUPPORT}`);
		expect(res.status).toBe(403);
		expect(await res.text()).toContain("organise");
	});

	it("requires read, draft and organise — the span of its tools", () => {
		// Asserted against the exported list the gate itself uses, so a tool added
		// under a fourth capability without widening this fails here.
		expect([...AGENT_SOCKET_CAPABILITIES].sort()).toEqual([
			"draft",
			"organise",
			"read",
		]);
	});

	it("refuses a mailbox the caller does not hold, without naming the capability", async () => {
		const res = await agentApp(member("agent", SUPPORT))(
			"/agents/email-agent/sales@tapetide.com",
		);
		expect(res.status).toBe(403);
		// Reachability fails first, so the message is about access rather than about
		// which capability is missing.
		expect(await res.text()).toBe("You do not have access to this mailbox");
	});

	it("lets an unrestricted principal through", async () => {
		const res = await agentApp(unrestricted())(`/agents/email-agent/${SUPPORT}`);
		expect(res.status).toBe(200);
	});
});
