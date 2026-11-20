// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The MCP tools for held sends, sequences, suppressions and templates.
 *
 * Approval rows live in real SQLite with the production MailboxDO migrations,
 * suppressions in a real AuthStore, the way `agent-send-approval.test.ts`
 * runs them. Gating is pinned by the source tables in
 * `capability-non-http.test.ts` and `mcp-token-scopes.test.ts`.
 */

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as approvals from "../workers/durableObject/approvals";
import { applyMigrations, mailboxMigrations } from "../workers/durableObject/migrations";
import { isRequester } from "../workers/lib/agent-send-gate";
import type { CredentialInfo, Principal } from "../workers/lib/authz";
import type { SendActor } from "../workers/lib/pre-send";
import {
	pendingSendView,
	toolCheckSuppressions,
	toolCreateTemplate,
	toolEnrollInSequence,
	toolGetPendingSend,
	toolListPendingSends,
	toolUpdateTemplate,
} from "../workers/lib/tools";
import type { Env } from "../workers/types";
import { authStoreBinding, sqliteAuthStore } from "./helpers/suppression-store";

vi.mock("agents/mcp", () => ({ McpAgent: class {} }));
const { MCP_GATED_SEND_TOOLS } = await import("../workers/mcp/index");

const MB = "support@tapetide.com";

function doContext(db: DatabaseSync): DurableObjectState {
	const exec = (query: string, ...bindings: unknown[]) => {
		const trimmed = query.trim();
		if (/^(select|with)/i.test(trimmed) || /\breturning\b/i.test(trimmed)) {
			const rows = db.prepare(trimmed).all(...(bindings as never[])) as Record<string, unknown>[];
			return { toArray: () => rows, rowsWritten: 0, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
		}
		if (bindings.length === 0) db.exec(trimmed);
		else db.prepare(trimmed).run(...(bindings as never[]));
		return { toArray: () => [], rowsWritten: 0, one: () => undefined, [Symbol.iterator]: () => [][Symbol.iterator]() };
	};
	return { storage: { sql: { exec }, transactionSync: <T>(fn: () => T) => fn() } } as unknown as DurableObjectState;
}

function bucket(entries: Record<string, unknown> = {}) {
	const store = new Map<string, string>([[`mailboxes/${MB}.json`, "{}"]]);
	for (const [k, v] of Object.entries(entries)) store.set(k, JSON.stringify(v));
	return {
		store,
		async get(key: string) {
			const v = store.get(key);
			return v === undefined ? null : { json: async () => JSON.parse(v), text: async () => v };
		},
		async head(key: string) {
			return store.has(key) ? {} : null;
		},
		async put(key: string, value: string | Uint8Array) {
			store.set(key, typeof value === "string" ? value : new TextDecoder().decode(value));
		},
		async delete(keys: string | string[]) {
			for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
		},
		async list({ prefix = "" }: { prefix?: string } = {}) {
			return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
		},
	};
}

let ctx: DurableObjectState;
let auth: ReturnType<typeof sqliteAuthStore>;

beforeEach(() => {
	ctx = doContext(new DatabaseSync(":memory:"));
	applyMigrations(ctx.storage.sql, mailboxMigrations, ctx.storage);
	auth = sqliteAuthStore();
});

function makeEnv(entries: Record<string, unknown> = {}) {
	const b = bucket(entries);
	const stub = {
		createSendApproval: async (i: approvals.CreateApprovalInput) => approvals.createApproval(ctx, i),
		getSendApproval: async (id: string) => approvals.getApproval(ctx, id),
		listSendApprovals: async (o: Parameters<typeof approvals.listApprovals>[1]) => approvals.listApprovals(ctx, o),
		rejectSendApproval: async (id: string, o: Parameters<typeof approvals.rejectApproval>[2]) => approvals.rejectApproval(ctx, id, o),
	};
	const env = {
		BUCKET: b,
		MAILBOX: { idFromName: (name: string) => ({ name }), get: () => stub },
		...authStoreBinding(auth),
	} as unknown as Env;
	return { env, bucket: b };
}

function principal(credential: CredentialInfo): Principal {
	return {
		identity: { kind: "user", id: "owner@tapetide.com", subject: "u1" },
		role: "admin",
		mailboxes: null,
		access: null,
		enforced: true,
		developmentBypass: false,
		credential,
	};
}

const agentToken: CredentialInfo = { method: "token", tokenId: "tokAgent0001", tokenName: "agent", sendAuto: false };
const otherToken: CredentialInfo = { method: "token", tokenId: "tokOther0001", tokenName: "other", sendAuto: false };
const mcpActor = (cred: CredentialInfo = agentToken): SendActor => ({
	principal: principal(cred),
	credential: { method: cred.method, tokenId: cred.tokenId ?? null },
	via: "mcp",
});

const SEQUENCE = {
	id: "seq1",
	name: "Onboarding",
	steps: [
		{ order: 1, templateSlug: "welcome", delayHours: 0 },
		{ order: 2, templateSlug: "tips", delayHours: 48 },
	],
	createdAt: 1,
	updatedAt: 1,
};
const TEMPLATES = {
	"templates/welcome.json": { id: "t1", slug: "welcome", name: "Welcome", subject: "Hi {{name}}", bodyHtml: "<p>Welcome {{name}}</p>", createdAt: 1, updatedAt: 1 },
	"templates/tips.json": { id: "t2", slug: "tips", name: "Tips", subject: "Tips", bodyHtml: "<p>Tips</p>", createdAt: 1, updatedAt: 1 },
};

describe("enroll_in_sequence", () => {
	it("an MCP session's enrollment is held for approval with every rendered step, and nothing is enrolled", async () => {
		const { env, bucket: b } = makeEnv({ "sequences/seq1.json": SEQUENCE, ...TEMPLATES });
		const result = await toolEnrollInSequence(env, MB, { sequenceId: "seq1", personEmail: "Ada@Example.org", personName: "Ada" }, mcpActor());
		expect(result).toMatchObject({ status: "pending_approval", approval_id: expect.stringMatching(/^apr_/) });
		expect([...b.store.keys()].some((k) => k.startsWith("sequence-enrollments/"))).toBe(false);
		const [held] = approvals.listApprovals(ctx);
		expect(held).toMatchObject({ kind: "sequence_enroll", subject: "Sequence: Onboarding", recipients: ["ada@example.org"] });
		const enrollment = (held!.payload as { enrollment: { steps: { subject: string }[]; enroll: Record<string, unknown> } }).enrollment;
		expect(enrollment.steps.map((s) => s.subject)).toEqual(["Hi Ada", "Tips"]);
		expect(enrollment.enroll).toMatchObject({ personId: "ada@example.org", fromAddress: MB });
	});

	it("refuses a recipient who unsubscribed (bulk mail), before anything is held", async () => {
		await auth.addSuppressions([{ address: "gone@example.org", scope: "global", reason: "unsubscribed", source: "t" }], Date.now());
		const { env } = makeEnv({ "sequences/seq1.json": SEQUENCE, ...TEMPLATES });
		const result = await toolEnrollInSequence(env, MB, { sequenceId: "seq1", personEmail: "gone@example.org" }, mcpActor());
		expect(result).toMatchObject({ error: expect.stringMatching(/suppression list/) });
		expect(approvals.listApprovals(ctx)).toHaveLength(0);
	});

	it("reports an unknown sequence and an already-enrolled person without holding anything", async () => {
		const { env } = makeEnv({
			"sequences/seq1.json": SEQUENCE,
			...TEMPLATES,
			"sequence-enrollments/e1.json": { id: "e1", sequenceId: "seq1", personId: "ada@example.org", personEmail: "ada@example.org", status: "active" },
		});
		expect(await toolEnrollInSequence(env, MB, { sequenceId: "nope", personEmail: "x@example.org" }, mcpActor())).toMatchObject({
			error: expect.stringMatching(/not found/),
		});
		expect(await toolEnrollInSequence(env, MB, { sequenceId: "seq1", personEmail: "ada@example.org" }, mcpActor())).toMatchObject({
			error: expect.stringMatching(/already enrolled/),
		});
		expect(approvals.listApprovals(ctx)).toHaveLength(0);
	});
});

describe("list_pending_sends / get_pending_send", () => {
	async function hold(cred: CredentialInfo, to: string) {
		const actor = mcpActor(cred);
		const record = approvals.createApproval(ctx, {
			kind: "send_email",
			reason: "approval_required",
			recipients: [to],
			subject: "Quote",
			payload: {
				type: "batch",
				batch: { messages: [{ to: [to], from: MB, subject: "Quote", html: "<p>Here is the <b>quote</b></p>", row: { threadId: null, inReplyTo: null, references: [], rawHeaders: null } }] },
			},
			actor: { user: "owner@tapetide.com", via: "mcp", method: "token", tokenId: cred.tokenId ?? null, tokenName: cred.tokenName ?? null },
		});
		return { record, actor };
	}

	it("marks the session's own sends and filters to them by default", async () => {
		const { env } = makeEnv();
		await hold(agentToken, "a@example.org");
		await hold(otherToken, "b@example.org");
		const me = principal(agentToken);
		const isYours = (a: approvals.ApprovalRecord) => isRequester(me, a.actor, "mcp");
		const mine = await toolListPendingSends(env, MB, { status: "all", onlyYours: true, isYours, limit: 20, page: 1 });
		expect(mine.pending_sends.map((p) => p.recipients)).toEqual([["a@example.org"]]);
		expect(mine.pending_sends[0]).toMatchObject({ yours: true, revisable: true, status: "pending" });
		expect(mine.next_page).toBeNull();
		const all = await toolListPendingSends(env, MB, { status: "all", onlyYours: false, isYours, limit: 1, page: 1 });
		expect(all.pending_sends).toHaveLength(1);
		expect(all.next_page).toBe(2);
		// Lists never carry the body.
		expect(JSON.stringify(all)).not.toContain("quote</b>");
	});

	it("shows a rejection with the reviewer's note, and is no longer revisable", async () => {
		const { env } = makeEnv();
		const { record } = await hold(agentToken, "a@example.org");
		approvals.rejectApproval(ctx, record.id, { decidedBy: "owner@tapetide.com", note: "Wrong price" });
		const view = await toolGetPendingSend(env, MB, record.id, { isYours: () => true });
		expect(view).toMatchObject({ status: "rejected", rejection_note: "Wrong price", revisable: false, to: ["a@example.org"] });
		expect((view as { body_text: string }).body_text).toContain("quote");
	});

	it("reports an expired pending item as expired", () => {
		const view = pendingSendView(
			{ ...approvals.createApproval(ctx, { kind: "send_email", reason: "r", recipients: ["a@x.org"], subject: "s", payload: {}, actor: { user: null, via: "mcp", method: null } }), expiresAt: 1 },
			{ yours: true },
		);
		expect(view).toMatchObject({ status: "expired", revisable: false });
	});

	it("names an unknown id as an error", async () => {
		const { env } = makeEnv();
		expect(await toolGetPendingSend(env, MB, "apr_00000000000000000000", { isYours: () => true })).toMatchObject({
			error: expect.stringMatching(/list_pending_sends/),
		});
	});
});

describe("check_suppressions", () => {
	it("says what each entry blocks, the way the pre-send gate applies it", async () => {
		await auth.addSuppressions(
			[
				{ address: "left@example.org", scope: "global", reason: "unsubscribed", source: "t" },
				{ address: "bounced@example.org", scope: "global", reason: "hard_bounce", source: "t" },
				{ address: "other@example.org", scope: "elsewhere.com", reason: "manual", source: "t" },
			],
			Date.now(),
		);
		const { env } = makeEnv();
		const out = await toolCheckSuppressions(env, MB, ["Left@Example.org", "bounced@example.org", "other@example.org", "fine@example.org", "junk"]);
		expect(out.results).toEqual([
			expect.objectContaining({ address: "left@example.org", suppressed: true, blocks: "bulk mail (templates, sequences)" }),
			expect.objectContaining({ address: "bounced@example.org", suppressed: true, blocks: "all mail" }),
			// Scoped to another sending domain: does not apply to mail from tapetide.com.
			{ address: "other@example.org", suppressed: false },
			{ address: "fine@example.org", suppressed: false },
			{ address: "junk", error: "not an email address" },
		]);
	});
});

describe("create_template / update_template", () => {
	it("removes remote images and unsafe links from a model-written body", async () => {
		const { env, bucket: b } = makeEnv();
		const out = await toolCreateTemplate(env, {
			slug: "promo",
			name: "Promo",
			subject: "Hi {{name}}",
			bodyHtml: '<p>Hi {{name}} <img src="https://evil.example/p.gif"><a href="javascript:alert(1)">x</a></p>',
		});
		expect(out).toMatchObject({ status: "created", variables: ["name"] });
		const stored = b.store.get("templates/promo.json")!;
		expect(stored).not.toContain("evil.example");
		expect(stored).not.toContain("javascript:");
	});

	it("refuses to edit or claim a template a sequence sends, and reports duplicates and unknown slugs", async () => {
		const { env } = makeEnv({ "sequences/seq1.json": SEQUENCE, ...TEMPLATES });
		expect(await toolUpdateTemplate(env, "welcome", { subject: "Changed" })).toMatchObject({ error: expect.stringMatching(/sequence/) });
		const orphanStep = { ...SEQUENCE, id: "seq2", steps: [{ order: 1, templateSlug: "later", delayHours: 0 }] };
		const { env: env2 } = makeEnv({ "sequences/seq2.json": orphanStep });
		expect(await toolCreateTemplate(env2, { slug: "later", name: "L", subject: "s", bodyHtml: "<p>x</p>" })).toMatchObject({
			error: expect.stringMatching(/sequence already refers/),
		});
		const { env: env3 } = makeEnv(TEMPLATES);
		expect(await toolCreateTemplate(env3, { slug: "tips", name: "T", subject: "s", bodyHtml: "<p>x</p>" })).toMatchObject({
			error: expect.stringMatching(/already exists/),
		});
		expect(await toolUpdateTemplate(env, "missing", { name: "x" })).toMatchObject({ error: expect.stringMatching(/not found/) });
	});
});

describe("MCP wiring of the new tools", () => {
	const src = readFileSync(new URL("../workers/mcp/index.ts", import.meta.url), "utf8");
	const block = (name: string) => {
		const start = src.indexOf(`this.server.tool(\n\t\t\t"${name}",`);
		expect(start, name).toBeGreaterThan(-1);
		const next = src.indexOf("this.server.tool(", start + 10);
		return src.slice(start, next === -1 ? undefined : next);
	};

	it("enroll_in_sequence is a gated send: approval rule, send annotation, policy note", () => {
		expect(MCP_GATED_SEND_TOOLS.has("enroll_in_sequence")).toBe(true);
		const body = block("enroll_in_sequence");
		expect(body).toMatch(/toolEnrollInSequence\(env, mailboxId, [\s\S]*?sendActor\(who\.principal\)\)/);
		expect(body).toContain("ANNOTATIONS.send");
		expect(body).toContain("SEND_POLICY_NOTE");
	});

	it("the held-send tools only read, and mark what they return as untrusted", () => {
		for (const name of ["list_pending_sends", "get_pending_send"]) {
			const body = block(name);
			expect(body).toContain("ANNOTATIONS.readOnly");
			expect(body).not.toMatch(/approveHeld|rejectHeld|editHeld|claimSendApproval|reopenSendApproval/);
		}
		expect(block("list_pending_sends")).toContain("markUntrustedRows");
		expect(block("get_pending_send")).toMatch(/scanForInjection[\s\S]*markUntrustedEmail/);
	});

	it("template writes need mail:draft, and admin for a mailbox-limited token", () => {
		for (const name of ["create_template", "update_template"]) {
			const body = block(name);
			expect(body).toContain('hasTokenScope(who.principal, "mail:draft")');
			expect(body).toContain("sharedDefinitionRefusal(who.principal)");
		}
		expect(src).toMatch(/principal\.token\.mailboxes !== null && !hasTokenScope\(principal, "admin"\)/);
	});

	it("thread summaries and analytics are marked untrusted", () => {
		expect(block("get_thread_summary")).toMatch(/scanForInjection[\s\S]*wrapUntrusted[\s\S]*untrusted: true/);
		expect(block("get_pending_send")).toMatch(/scanForInjection\(\s*\[view\.subject, view\.body_text\]/);
		expect(block("get_analytics")).toContain("markUntrustedRows");
	});
});
