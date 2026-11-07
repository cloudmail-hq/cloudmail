// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Server-side approval for agent and MCP sends.
 *
 * The approval rows live in real SQLite with the production MailboxDO
 * migrations applied; suppressions in a real AuthStore. What is faked is the
 * send itself, so "sent exactly once" is counted rather than assumed.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	agentSendPolicyFrom,
	collectRecipients,
	decideAgentSend,
	DEFAULT_AGENT_SEND_MODE,
	isAllowlisted,
	normalizeAllowlist,
	normalizeAllowlistEntry,
	type AgentSendPolicy,
} from "../shared/agent-send-policy";
import { MailboxSettingsPatchSchema, parseStoredMailboxSettings } from "../shared/mailbox-settings";
import { EXPLICIT_ONLY_SCOPES, mayAutoSend, TOKEN_SCOPE_PRESETS, type TokenScope } from "../shared/token-scopes";
import * as approvals from "../workers/durableObject/approvals";
import { applyMigrations, mailboxMigrations } from "../workers/durableObject/migrations";
import {
	actorNeedsGate,
	agentApprovalRule,
	approveHeld,
	editHeld,
	isRequester,
	rejectHeld,
	reviseHeld,
	type EditVerifier,
	type EnrollExecutor,
	type HoldPayload,
} from "../workers/lib/agent-send-gate";
import { classifySendFailure, type ComposedDraft, type HeldEnrollment } from "../workers/lib/held-send";
import { preSend, refusalBody, type SendActor } from "../workers/lib/pre-send";
import type { CredentialInfo, Principal } from "../workers/lib/authz";
import { credentialFor } from "../workers/lib/mailbox";
import { toolSendEmail } from "../workers/lib/tools";
import type { Env } from "../workers/types";
import { authStoreBinding, sqliteAuthStore } from "./helpers/suppression-store";
import { prepareOutgoingHtml } from "../shared/outgoing-html";

const MB = "support@tapetide.com";

// ── Harness ───────────────────────────────────────────────────────

function doContext(db: DatabaseSync): DurableObjectState {
	const exec = (query: string, ...bindings: unknown[]) => {
		const trimmed = query.trim();
		if (/^(select|with)/i.test(trimmed) || /\breturning\b/i.test(trimmed)) {
			const rows = db.prepare(trimmed).all(...(bindings as never[])) as Record<string, unknown>[];
			return { toArray: () => rows, rowsWritten: 0, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
		}
		if (bindings.length === 0) {
			db.exec(trimmed);
			return { toArray: () => [], rowsWritten: 0, one: () => undefined, [Symbol.iterator]: () => [][Symbol.iterator]() };
		}
		db.prepare(trimmed).run(...(bindings as never[]));
		return { toArray: () => [], rowsWritten: 0, one: () => undefined, [Symbol.iterator]: () => [][Symbol.iterator]() };
	};
	return { storage: { sql: { exec }, transactionSync: <T>(fn: () => T) => fn() } } as unknown as DurableObjectState;
}

/** The MailboxDO approval RPCs, over real SQLite. */
function approvalStub(ctx: DurableObjectState) {
	return {
		createSendApproval: async (i: approvals.CreateApprovalInput) => approvals.createApproval(ctx, i),
		getSendApproval: async (id: string) => approvals.getApproval(ctx, id),
		listSendApprovals: async (o: Parameters<typeof approvals.listApprovals>[1]) => approvals.listApprovals(ctx, o),
		countPendingSendApprovals: async () => approvals.countPendingApprovals(ctx),
		claimSendApproval: async (id: string, o: Parameters<typeof approvals.claimApproval>[2]) => approvals.claimApproval(ctx, id, o),
		finishSendApproval: async (id: string, fence: string, o: approvals.FinishOutcome) => approvals.finishApproval(ctx, id, fence, o),
		updatePendingSendApproval: async (id: string, u: Parameters<typeof approvals.updatePendingApproval>[2]) => approvals.updatePendingApproval(ctx, id, u),
		reopenSendApproval: async (id: string) => approvals.reopenApproval(ctx, id),
		rejectSendApproval: async (id: string, o: Parameters<typeof approvals.rejectApproval>[2]) => approvals.rejectApproval(ctx, id, o),
	};
}

function bucket(settings: Record<string, unknown> = {}) {
	const store = new Map<string, string>([[`mailboxes/${MB}.json`, JSON.stringify(settings)]]);
	return {
		store,
		async get(key: string) {
			const v = store.get(key);
			return v === undefined ? null : { json: async () => JSON.parse(v) };
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

let db: DatabaseSync;
let ctx: DurableObjectState;
let auth: ReturnType<typeof sqliteAuthStore>;

function makeEnv(settings: Record<string, unknown> = {}, extraStub: Record<string, unknown> = {}) {
	const b = bucket(settings);
	const stub = { ...approvalStub(ctx), ...extraStub };
	const env = {
		BUCKET: b,
		MAILBOX: { idFromName: (name: string) => ({ name }), get: () => stub },
		...authStoreBinding(auth),
	} as unknown as Env;
	return { env, bucket: b, stub };
}

function principal(credential: CredentialInfo | null = null): Principal {
	return {
		identity: { kind: "user", id: "owner@tapetide.com", subject: "u1" },
		role: "admin",
		mailboxes: null,
		access: null,
		enforced: true,
		developmentBypass: false,
		...(credential ? { credential } : {}),
	};
}

const hermesToken: CredentialInfo = { method: "token", tokenId: "tokHermes0001", tokenName: "hermes", sendAuto: false };
const trustedToken: CredentialInfo = { method: "token", tokenId: "tokTrusted01", tokenName: "billing-bot", sendAuto: true };

function auditEntries(b: ReturnType<typeof bucket>) {
	return [...b.store.entries()].filter(([k]) => k.startsWith("audit/")).map(([, v]) => JSON.parse(v));
}

beforeEach(() => {
	db = new DatabaseSync(":memory:");
	ctx = doContext(db);
	applyMigrations(ctx.storage.sql, mailboxMigrations, ctx.storage);
	auth = sqliteAuthStore();
});

// ── Pure policy ───────────────────────────────────────────────────

describe("decideAgentSend", () => {
	const policy = (p: Partial<AgentSendPolicy> = {}): AgentSendPolicy => ({ mode: "approve", allowlist: [], ...p });

	it("approve mode holds by default", () => {
		expect(decideAgentSend({ policy: policy(), recipients: ["a@x.com"], credentialMayAutoSend: false })).toEqual({
			action: "hold",
			reason: "approval_required",
		});
	});

	it("draft_only refuses, whatever the credential", () => {
		expect(decideAgentSend({ policy: policy({ mode: "draft_only" }), recipients: ["a@x.com"], credentialMayAutoSend: true }).action).toBe(
			"refuse",
		);
	});

	it("auto sends only for a credential that may auto-send", () => {
		expect(decideAgentSend({ policy: policy({ mode: "auto" }), recipients: ["a@x.com"], credentialMayAutoSend: true })).toEqual({
			action: "send",
			reason: "auto",
		});
		expect(decideAgentSend({ policy: policy({ mode: "auto" }), recipients: ["a@x.com"], credentialMayAutoSend: false }).action).toBe("hold");
	});

	it("the allowlist lets a send through only when every recipient is on it", () => {
		const p = policy({ allowlist: ["@partner.example", "ops@tapetide.com"] });
		expect(decideAgentSend({ policy: p, recipients: ["a@partner.example", "ops@tapetide.com"], credentialMayAutoSend: false })).toEqual({
			action: "send",
			reason: "allowlist",
		});
		expect(decideAgentSend({ policy: p, recipients: ["a@partner.example", "x@evil.example"], credentialMayAutoSend: false }).action).toBe(
			"hold",
		);
	});

	it("suspected injection never sends directly, not even allowlisted or auto", () => {
		expect(
			decideAgentSend({
				policy: policy({ mode: "auto", allowlist: ["@partner.example"] }),
				recipients: ["a@partner.example"],
				credentialMayAutoSend: true,
				injectionSuspected: true,
			}),
		).toEqual({ action: "hold", reason: "injection_suspected" });
	});
});

describe("allowlist normalisation", () => {
	it("accepts addresses and domains, rejects junk", () => {
		expect(normalizeAllowlistEntry("Ops@Tapetide.com")).toBe("ops@tapetide.com");
		expect(normalizeAllowlistEntry("partner.example")).toBe("@partner.example");
		expect(normalizeAllowlistEntry("@partner.example")).toBe("@partner.example");
		expect(normalizeAllowlistEntry("not a domain")).toBeNull();
		expect(normalizeAllowlistEntry("a@b@c.com")).toBeNull();
		expect(normalizeAllowlist(["x.com", "X.com", 3, "bad"])).toEqual(["@x.com"]);
	});

	it("a domain entry does not cover its subdomains", () => {
		expect(isAllowlisted("a@mail.partner.example", ["@partner.example"])).toBe(false);
		expect(isAllowlisted("Name <A@Partner.example>", ["@partner.example"])).toBe(true);
	});

	it("collects recipients from strings, comma lists and arrays", () => {
		expect(collectRecipients("a@x.com, B <b@x.com>", ["c@x.com"], undefined, "a@x.com")).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
	});
});

describe("mailbox setting", () => {
	it("defaults to approve for every existing mailbox", () => {
		expect(DEFAULT_AGENT_SEND_MODE).toBe("approve");
		expect(parseStoredMailboxSettings({ fromName: "Support" }).agentSend).toEqual({ mode: "approve", allowlist: [] });
		expect(agentSendPolicyFrom(parseStoredMailboxSettings({ agentSend: { mode: "yolo" } })).mode).toBe("approve");
	});

	it("the settings API validates the mode and allowlist", () => {
		expect(MailboxSettingsPatchSchema.safeParse({ agentSend: { mode: "auto", allowlist: ["x.com"] } }).success).toBe(true);
		expect(MailboxSettingsPatchSchema.safeParse({ agentSend: { mode: "always" } }).success).toBe(false);
		expect(MailboxSettingsPatchSchema.safeParse({ agentSend: { allowlist: ["not valid"] } }).success).toBe(false);
	});
});

describe("mail:send:auto scope", () => {
	it("needs both mail:send and mail:send:auto", () => {
		expect(mayAutoSend(["mail:send", "mail:send:auto"])).toBe(true);
		expect(mayAutoSend(["mail:send:auto"])).toBe(false);
		expect(mayAutoSend(["mail:send"])).toBe(false);
		// A legacy unscoped token was never asked, so it does not qualify.
		expect(mayAutoSend(null)).toBe(false);
	});

	it("is never in a preset, not even Full access", () => {
		expect(EXPLICIT_ONLY_SCOPES).toContain("mail:send:auto");
		for (const preset of TOKEN_SCOPE_PRESETS) expect(preset.scopes).not.toContain("mail:send:auto");
	});

	it("the credential carries it only for a token holding both scopes", () => {
		const token = (scopes: TokenScope[] | null) => ({ id: "t1", userId: "u", name: "n", createdAt: 0, lastUsedAt: null, lastUsedIp: null, expiresAt: null, scopes, mailboxes: null, parentId: null });
		expect(credentialFor("token", token(["mail:send", "mail:send:auto"]) as never, undefined)?.sendAuto).toBe(true);
		expect(credentialFor("token", token(["mail:send"]) as never, undefined)?.sendAuto).toBe(false);
		expect(credentialFor("token", token(null) as never, undefined)?.sendAuto).toBe(false);
		expect(credentialFor("session", undefined, undefined)?.sendAuto).toBe(false);
		const grant = (sendAuto: boolean) => ({ id: "ogr_1", userId: "u", clientId: "c1", clientName: "Hermes", redirectHost: "h", createdAt: 0, lastUsedAt: null, sendAuto });
		expect(credentialFor("oauth", undefined, grant(true))?.sendAuto).toBe(true);
		expect(credentialFor("oauth", undefined, grant(false))).toMatchObject({ sendAuto: false, oauthClientName: "Hermes" });
	});
});

// ── The pre-send rule ─────────────────────────────────────────────

const draft = (over: Partial<ComposedDraft> = {}): ComposedDraft => ({
	kind: "transactional",
	to: ["customer@example.org"],
	from: MB,
	subject: "Hello",
	html: "<p>Hi there, your order shipped.</p>",
	row: { threadId: null, inReplyTo: null, references: [], rawHeaders: null },
	trackingBaseUrl: "https://app.tapetide.com",
	...over,
});

/** Run the real pre-send gate (built-ins + the approval rule) for one send. */
function gate(
	env: Env,
	actor: SendActor | undefined,
	over: { draft?: ComposedDraft; kind?: "transactional" | "bulk"; payload?: HoldPayload | null } = {},
) {
	const d = over.draft ?? draft();
	return preSend(
		env,
		{
			kind: over.kind ?? d.kind ?? "transactional",
			from: MB,
			mailboxId: MB,
			to: d.to,
			cc: d.cc,
			html: d.html,
			quotaChecked: true,
			actor,
			...(over.payload === null ? {} : { hold: { action: "send_email", subject: d.subject, payload: over.payload ?? { composed: [d] } } }),
		},
		{ rules: [agentApprovalRule], breaker: { isBulkPaused: async () => ({ paused: false, reason: null }) } as never },
	);
}

const tokenActor = (cred: CredentialInfo = hermesToken, via: SendActor["via"] = "rest", extra: Partial<SendActor> = {}): SendActor => ({
	principal: principal(cred),
	credential: { method: cred.method, tokenId: cred.tokenId ?? null },
	via,
	...extra,
});

describe("actorNeedsGate (per credential, not per transport)", () => {
	it("holds tokens and OAuth on REST, every MCP/agent call, never a session, cron or a release", () => {
		expect(actorNeedsGate(tokenActor(hermesToken, "rest"))).toBe(true);
		expect(actorNeedsGate(tokenActor({ method: "oauth", oauthClientName: "Hermes", sendAuto: false }, "rest"))).toBe(true);
		expect(actorNeedsGate(tokenActor(hermesToken, "mcp"))).toBe(true);
		expect(actorNeedsGate({ principal: principal({ method: "session", sendAuto: false }), credential: { method: "session" }, via: "rest" })).toBe(false);
		expect(actorNeedsGate({ via: "cron" })).toBe(false);
		expect(actorNeedsGate(undefined)).toBe(false);
		expect(actorNeedsGate(tokenActor(hermesToken, "rest", { released: true }))).toBe(false);
	});
});

describe("agentApprovalRule in preSend", () => {
	it("holds a token's send in approve mode, storing the composed message, and does not clear it", async () => {
		const { env, bucket: b } = makeEnv({});
		const result = await gate(env, tokenActor());
		expect(result.ok).toBe(false);
		expect(result).toMatchObject({ outcome: "hold_for_approval", status: 202 });
		const body = refusalBody(result as never);
		expect(body).toMatchObject({ status: "pending_approval" });
		expect(String(body.approval_id)).toMatch(/^apr_/);
		expect(String(body.approval_url)).toContain(`/mail/${encodeURIComponent(MB)}/approvals?id=`);

		const [held] = approvals.listApprovals(ctx, { status: "pending" });
		expect(held).toMatchObject({ kind: "rest_send", recipients: ["customer@example.org"], subject: "Hello" });
		// WYSIWYG: the stored message is the composed one, byte for byte.
		expect((held!.payload as { batch: { messages: { html: string }[] } }).batch.messages[0]!.html).toBe("<p>Hi there, your order shipped.</p>");
		expect(held!.actor).toMatchObject({ user: "owner@tapetide.com", via: "api", method: "token", tokenId: "tokHermes0001", tokenName: "hermes" });

		const audit = auditEntries(b).find((e) => e.action === "agent.send_held");
		expect(audit).toMatchObject({ actor: "owner@tapetide.com", mailboxId: MB, target: "customer@example.org" });
		expect(audit.detail).toMatchObject({ via: "api", token: "tokHermes0001", tokenName: "hermes" });
	});

	it("lets a browser session through untouched", async () => {
		const { env } = makeEnv({ agentSend: { mode: "draft_only" } });
		const result = await gate(env, { principal: principal({ method: "session", sendAuto: false }), credential: { method: "session" }, via: "rest" });
		expect(result.ok).toBe(true);
		expect(approvals.listApprovals(ctx)).toHaveLength(0);
	});

	it("an allowlisted recipient passes in approve mode", async () => {
		const { env } = makeEnv({ agentSend: { mode: "approve", allowlist: ["example.org"] } });
		expect((await gate(env, tokenActor())).ok).toBe(true);
		expect(approvals.listApprovals(ctx)).toHaveLength(0);
	});

	it("auto mode sends only for a mail:send:auto credential", async () => {
		const { env } = makeEnv({ agentSend: { mode: "auto", allowlist: [] } });
		expect((await gate(env, tokenActor(trustedToken))).ok).toBe(true);
		expect((await gate(env, tokenActor(hermesToken))).ok).toBe(false);
	});

	it("draft_only refuses with 403 and holds nothing", async () => {
		const { env } = makeEnv({ agentSend: { mode: "draft_only" } });
		const result = await gate(env, tokenActor(trustedToken, "mcp"));
		expect(result).toMatchObject({ ok: false, outcome: "block", status: 403, ruleCode: "draft_only" });
		expect(approvals.listApprovals(ctx)).toHaveLength(0);
	});

	it("an injection trip holds even an allowlisted, auto-capable send", async () => {
		const { env } = makeEnv({ agentSend: { mode: "auto", allowlist: ["example.org"] } });
		const result = await gate(env, tokenActor(trustedToken, "mcp", { injectionSuspected: true }));
		expect(refusalBody(result as never)).toMatchObject({ status: "pending_approval", reason: "injection_suspected" });
	});

	it("fails closed when a held path has no composed payload", async () => {
		const { env } = makeEnv({});
		const noPayload = await gate(env, tokenActor(), { payload: null });
		expect(noPayload).toMatchObject({ ok: false, outcome: "block" });
		expect(approvals.listApprovals(ctx)).toHaveLength(0);
	});

	it("a released send (a person approved it) passes the rule", async () => {
		const { env } = makeEnv({});
		expect((await gate(env, tokenActor(hermesToken, "rest", { released: true }))).ok).toBe(true);
	});

	it("suppressions run first: a suppressed recipient is refused, never held (MCP sends check suppressions)", async () => {
		await auth.addSuppressions([{ address: "customer@example.org", scope: "global", reason: "hard_bounce", source: "test" }], Date.now());
		const { env } = makeEnv({});
		const result = await gate(env, tokenActor(hermesToken, "mcp"));
		expect(result).toMatchObject({ ok: false, code: "all_suppressed" });
		expect(approvals.listApprovals(ctx)).toHaveLength(0);
	});

	it("stores only the recipients that survive suppression", async () => {
		await auth.addSuppressions([{ address: "gone@example.org", scope: "global", reason: "unsubscribed", source: "t" }], Date.now());
		const { env } = makeEnv({});
		const d = draft({ kind: "bulk", to: ["customer@example.org"] });
		const gone = draft({ kind: "bulk", to: ["gone@example.org"] });
		const result = await preSend(
			env,
			{ kind: "bulk", from: MB, mailboxId: MB, to: ["customer@example.org", "gone@example.org"], quotaChecked: true, actor: tokenActor(), hold: { action: "send_template", subject: "x", payload: { composed: [d, gone] } } },
			{ rules: [agentApprovalRule], breaker: { isBulkPaused: async () => ({ paused: false, reason: null }) } as never },
		);
		expect(result).toMatchObject({ outcome: "hold_for_approval" });
		const [held] = approvals.listApprovals(ctx);
		expect((held!.payload as { batch: { messages: unknown[] } }).batch.messages).toHaveLength(1);
		expect(held!.kind).toBe("rest_template");
	});
});

describe("send tools pass the gate on the composed message", () => {
	it("toolSendEmail refuses a suppressed address and never calls the provider", async () => {
		await auth.addSuppressions([{ address: "gone@example.org", scope: "global", reason: "complaint", source: "test" }], Date.now());
		const send = vi.fn();
		const { env } = makeEnv({}, { checkSendRateLimit: async () => null });
		(env as unknown as { EMAIL: unknown }).EMAIL = { send };
		const result = await toolSendEmail(env, MB, { to: "gone@example.org", subject: "x", bodyHtml: "<p>x</p>", verify: false });
		expect(result).toMatchObject({ error: expect.stringMatching(/hard-bounced or reported/) });
		expect(send).not.toHaveBeenCalled();
	});

	it("toolSendEmail with an MCP token actor is held, never sent, and the hold carries the neutralised body", async () => {
		const send = vi.fn();
		const { env } = makeEnv({}, { checkSendRateLimit: async () => null });
		(env as unknown as { EMAIL: unknown }).EMAIL = { send };
		const result = await toolSendEmail(
			env,
			MB,
			// Short enough that the verifier passes it through without the model.
			{ to: "customer@example.org", subject: "x", bodyHtml: '<p>Hi <img src="https://evil.example/p.gif"></p>' },
			tokenActor(hermesToken, "mcp"),
		);
		expect(result).toMatchObject({ status: "pending_approval" });
		expect(send).not.toHaveBeenCalled();
		const [held] = approvals.listApprovals(ctx);
		expect(held!.kind).toBe("send_email");
		expect(JSON.stringify(held!.payload)).not.toContain("evil.example");
	});
});

// ── Approving, editing, rejecting ────────────────────────────────

/** A provider binding double that records every message. Install with `useProvider`. */
function provider(impl?: () => Promise<{ messageId: string }>) {
	return vi.fn(async (_message: unknown) => (impl ? impl() : { messageId: "<prov-1@x>" }));
}

function useDeps(env: Env, send: ReturnType<typeof provider>) {
	useProvider(env, send);
	return {};
}

function useProvider(env: Env, send: ReturnType<typeof provider>) {
	(env as unknown as { EMAIL: unknown }).EMAIL = { send };
	return send;
}

const deliveryStub = {
	checkSendRateLimit: async () => null,
	getTrackingSettings: async () => ({ openTracking: false, clickTracking: false, attachmentTracking: false }),
	getOrCreateTrackingSecret: async () => "s",
	createEmail: vi.fn(async () => null),
	createScheduledEmail: vi.fn(async () => null),
	recordDelivery: vi.fn(async () => null),
	markThreadRead: vi.fn(async () => null),
	finishSendApproval: async (id: string, fence: string, o: approvals.FinishOutcome) => approvals.finishApproval(ctx, id, fence, o),
	updatePendingSendApproval: async (id: string, u: Parameters<typeof approvals.updatePendingApproval>[2]) => approvals.updatePendingApproval(ctx, id, u),
};

async function holdOne(env: Env, d: ComposedDraft = draft()) {
	const r = await gate(env, tokenActor(), { draft: d });
	return String(refusalBody(r as never).approval_id);
}

const session = () => principal({ method: "session", sendAuto: false });
const enroll = vi.fn<EnrollExecutor>(async () => ({ enrollment_id: "e1" }));

describe("approveHeld", () => {
	it("sends exactly the stored bytes, exactly once, however many times it is approved", async () => {
		const { env, bucket: b } = makeEnv({}, deliveryStub);
		const id = await holdOne(env);
		const send = provider();
		const run = () => approveHeld({ env, mailboxId: MB, id, approver: session(), enroll, deps: useDeps(env, send) });
		const [first, second] = await Promise.all([run(), run()]);
		const third = await run();

		expect(send).toHaveBeenCalledTimes(1);
		// What the preview showed is what went out (tracking is off here).
		expect(send.mock.calls[0]![0]).toMatchObject({ to: ["customer@example.org"], subject: "Hello", html: prepareOutgoingHtml("<p>Hi there, your order shipped.</p>") });
		expect([first, second, third].filter((o) => o.ok)).toHaveLength(1);
		expect(approvals.getApproval(ctx, id)).toMatchObject({ status: "sent", decidedBy: "owner@tapetide.com" });

		const approved = auditEntries(b).filter((e) => e.action === "approval.approve");
		expect(approved).toHaveLength(1);
		expect(approved[0].detail).toMatchObject({ approval: id, outcome: "sent" });
		expect(String(approved[0].detail.requestedBy)).toContain("hermes");
	});

	it("never calls the AI verifier at approve time", async () => {
		const { env } = makeEnv({}, deliveryStub);
		const run = vi.fn();
		(env as unknown as { AI: unknown }).AI = { run };
		const id = await holdOne(env);
		await approveHeld({ env, mailboxId: MB, id, approver: session(), enroll, deps: useDeps(env, provider()) });
		expect(run).not.toHaveBeenCalled();
	});

	it("a definite provider refusal is failed and can be retried", async () => {
		const { env } = makeEnv({}, deliveryStub);
		const id = await holdOne(env);
		const send = provider(async () => {
			throw Object.assign(new Error("sender not verified"), { code: "E_SENDER_NOT_VERIFIED" });
		});
		const outcome = await approveHeld({ env, mailboxId: MB, id, approver: session(), enroll, deps: useDeps(env, send) });
		expect(outcome).toMatchObject({ ok: false, status: 502 });
		expect(approvals.getApproval(ctx, id)?.status).toBe("failed");
		expect(approvals.reopenApproval(ctx, id)?.status).toBe("pending");
	});

	it("an ambiguous provider error is sent_unconfirmed and can never be reopened", async () => {
		const { env } = makeEnv({}, deliveryStub);
		const id = await holdOne(env);
		const send = provider(async () => {
			throw new Error("network timeout");
		});
		await approveHeld({ env, mailboxId: MB, id, approver: session(), enroll, deps: useDeps(env, send) });
		expect(approvals.getApproval(ctx, id)?.status).toBe("sent_unconfirmed");
		expect(approvals.reopenApproval(ctx, id)?.status).toBe("sent_unconfirmed");
		const again = await approveHeld({ env, mailboxId: MB, id, approver: session(), enroll, deps: useDeps(env, send) });
		expect(again).toMatchObject({ ok: false, status: 409 });
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("a crash after the claim leaves it sending, shown as unconfirmed once stale, never retryable", async () => {
		const { env } = makeEnv({}, deliveryStub);
		const id = await holdOne(env);
		const claim = approvals.claimApproval(ctx, id, { decidedBy: "x" });
		expect(claim.ok).toBe(true);
		// No finish: the worker died. A second claim loses.
		expect(approvals.claimApproval(ctx, id, { decidedBy: "y" })).toMatchObject({ ok: false, reason: "already_decided" });
		db.prepare(`UPDATE send_approvals SET decided_at = ? WHERE id = ?`).run(Date.now() - approvals.SENDING_STALE_MS - 1, id);
		expect(approvals.listApprovals(ctx, { status: "all" })[0]?.status).toBe("sent_unconfirmed");
		expect(approvals.listApprovals(ctx, { status: "sent_unconfirmed" })).toHaveLength(1);
		// Reopen refuses: the row stays sending (reported as unconfirmed).
		approvals.reopenApproval(ctx, id);
		expect(db.prepare(`SELECT status FROM send_approvals WHERE id = ?`).get(id)).toMatchObject({ status: "sending" });
		// A stale fence cannot record an outcome either.
		approvals.finishApproval(ctx, id, "not-the-fence", { status: "failed", error: "x" });
		expect(db.prepare(`SELECT status FROM send_approvals WHERE id = ?`).get(id)).toMatchObject({ status: "sending" });
	});

	it("re-checks suppressions at release; a newly suppressed recipient is not sent", async () => {
		const { env } = makeEnv({}, deliveryStub);
		const id = await holdOne(env);
		await auth.addSuppressions([{ address: "customer@example.org", scope: "global", reason: "hard_bounce", source: "t" }], Date.now());
		const send = provider();
		const outcome = await approveHeld({ env, mailboxId: MB, id, approver: session(), enroll, deps: useDeps(env, send) });
		expect(outcome.ok).toBe(false);
		expect(send).not.toHaveBeenCalled();
		expect(approvals.getApproval(ctx, id)?.status).toBe("failed");
	});

	it("refuses an expired approval", async () => {
		const { env } = makeEnv({}, deliveryStub);
		const id = await holdOne(env);
		db.prepare(`UPDATE send_approvals SET expires_at = 1 WHERE id = ?`).run(id);
		const send = provider();
		expect(await approveHeld({ env, mailboxId: MB, id, approver: session(), enroll, deps: useDeps(env, send) })).toMatchObject({ ok: false, status: 410 });
		expect(send).not.toHaveBeenCalled();
	});

	it("a held scheduled send is queued at its time on approval, not sent", async () => {
		const { env } = makeEnv({}, deliveryStub);
		const sendAt = new Date(Date.now() + 3_600_000).toISOString();
		const id = await holdOne(env, draft({ sendAt }));
		const send = provider();
		deliveryStub.createScheduledEmail.mockClear();
		const outcome = await approveHeld({ env, mailboxId: MB, id, approver: session(), enroll, deps: useDeps(env, send) });
		expect(outcome.ok).toBe(true);
		expect(send).not.toHaveBeenCalled();
		expect(deliveryStub.createScheduledEmail).toHaveBeenCalledTimes(1);
		expect(deliveryStub.createScheduledEmail.mock.calls[0]![2]).toBe(sendAt);
	});

	it("a held enrollment enrolls on approval", async () => {
		const { env } = makeEnv({});
		const enrollment: HeldEnrollment = {
			sequenceId: "seq1",
			sequenceName: "Onboarding",
			steps: [{ order: 1, delayHours: 0, subject: "Welcome", bodyHtml: "<p>Hi</p>" }],
			enroll: { personId: "p1", personEmail: "new@example.org", personName: null, fromAddress: MB },
		};
		const held = await preSend(
			env,
			{ kind: "bulk", from: MB, mailboxId: MB, to: "new@example.org", quotaChecked: true, actor: tokenActor(), hold: { action: "sequence_enroll", subject: "Sequence: Onboarding", payload: { enrollment } } },
			{ rules: [agentApprovalRule], breaker: { isBulkPaused: async () => ({ paused: false, reason: null }) } as never },
		);
		const id = String(refusalBody(held as never).approval_id);
		expect(approvals.getApproval(ctx, id)).toMatchObject({ kind: "sequence_enroll", subject: "Sequence: Onboarding" });
		const run = vi.fn<EnrollExecutor>(async () => ({ enrollment_id: "e9" }));
		const outcome = await approveHeld({ env, mailboxId: MB, id, approver: session(), enroll: run });
		expect(outcome.ok).toBe(true);
		expect(run.mock.calls[0]![1]).toEqual(enrollment);
	});
});

describe("editHeld", () => {
	it("re-runs the verifier and replaces the stored message", async () => {
		const { env } = makeEnv({}, deliveryStub);
		const id = await holdOne(env);
		const verify = vi.fn<EditVerifier>(async (html) => ({ ok: true, html: `${html}<!--v-->` }));
		const edited = await editHeld({ env, mailboxId: MB, id, edits: { subject: "Edited\r\nBcc: x", html: "<p>Better</p>" }, verify });
		expect(edited.ok).toBe(true);
		expect(verify).toHaveBeenCalledWith("<p>Better</p>");
		const m = (approvals.getApproval(ctx, id)!.payload as { batch: { messages: { subject: string; html: string }[] } }).batch.messages[0]!;
		expect(m).toMatchObject({ subject: "Edited Bcc: x", html: "<p>Better</p><!--v-->" });
	});

	it("a verifier refusal changes nothing", async () => {
		const { env } = makeEnv({}, deliveryStub);
		const id = await holdOne(env);
		const out = await editHeld({ env, mailboxId: MB, id, edits: { html: "x" }, verify: async () => ({ ok: false, error: "no" }) });
		expect(out).toMatchObject({ ok: false, status: 422 });
		expect(JSON.stringify(approvals.getApproval(ctx, id)!.payload)).toContain("your order shipped");
	});
});

describe("reviseHeld (the agent revises its own held send)", () => {
	const verify: EditVerifier = async (html) => ({ ok: true, html });
	const allow = async () => null;
	const revise = (env: Env, id: string, who: Principal, edits: Parameters<typeof reviseHeld>[0]["edits"], extra: Partial<Parameters<typeof reviseHeld>[0]> = {}) =>
		reviseHeld({ env, mailboxId: MB, id, principal: who, via: "api", edits, verify, checkRecipients: allow, ...extra });

	it("replaces the same item in place, bumps the revision and stays pending", async () => {
		const { env, bucket: b } = makeEnv({}, deliveryStub);
		const id = await holdOne(env);
		expect(approvals.getApproval(ctx, id)!.revision).toBe(1);
		const out = await revise(env, id, principal(hermesToken), { subject: "Hello again", html: "<p>Second draft</p>" });
		expect(out.ok).toBe(true);
		const row = approvals.getApproval(ctx, id)!;
		expect(row).toMatchObject({ status: "pending", revision: 2, revisedBy: "requester", subject: "Hello again" });
		expect(JSON.stringify(row.payload)).toContain("Second draft");
		expect(approvals.listApprovals(ctx)).toHaveLength(1);
		expect(auditEntries(b).find((e) => e.action === "agent.send_revised")?.detail).toMatchObject({ approval: id, revision: 2 });
	});

	it("only the requesting credential may revise", async () => {
		const { env } = makeEnv({}, deliveryStub);
		const id = await holdOne(env);
		expect(await revise(env, id, principal(trustedToken), { html: "<p>x</p>" })).toMatchObject({ ok: false, status: 403 });
		expect(await revise(env, id, session(), { html: "<p>x</p>" })).toMatchObject({ ok: false, status: 403 });
		expect(approvals.getApproval(ctx, id)!.revision).toBe(1);
	});

	it("cannot revise once decided", async () => {
		const { env } = makeEnv({}, deliveryStub);
		const id = await holdOne(env);
		await rejectHeld({ env, mailboxId: MB, id, approver: session() });
		expect(await revise(env, id, principal(hermesToken), { html: "<p>x</p>" })).toMatchObject({ ok: false, status: 409 });
	});

	it("new recipients face the same limits as a new send", async () => {
		const { env } = makeEnv({}, deliveryStub);
		const id = await holdOne(env);
		const out = await revise(env, id, principal(hermesToken), { to: ["stranger@else.example"] }, { checkRecipients: async () => "not allowed" });
		expect(out).toMatchObject({ ok: false, status: 422, error: "not allowed" });
		expect(approvals.getApproval(ctx, id)!.recipients).toEqual(["customer@example.org"]);
	});

	it("an approve of the version the person saw is refused after a revision, and sends nothing", async () => {
		const { env } = makeEnv({}, deliveryStub);
		const id = await holdOne(env);
		await revise(env, id, principal(hermesToken), { html: "<p>Second draft</p>" });
		const send = provider();
		const stale = await approveHeld({ env, mailboxId: MB, id, approver: session(), enroll, deps: useDeps(env, send), expectedRevision: 1 });
		expect(stale).toMatchObject({ ok: false, status: 409 });
		expect(send).not.toHaveBeenCalled();
		expect(approvals.getApproval(ctx, id)!.status).toBe("pending");
		const fresh = await approveHeld({ env, mailboxId: MB, id, approver: session(), enroll, deps: useDeps(env, send), expectedRevision: 2 });
		expect(fresh.ok).toBe(true);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]![0]).toMatchObject({ html: prepareOutgoingHtml("<p>Second draft</p>") });
	});

	it("a revision from a session that tripped the injection check marks the item, and an edit never clears it", async () => {
		const { env } = makeEnv({}, deliveryStub);
		const id = await holdOne(env);
		expect(approvals.getApproval(ctx, id)!.reason).toBe("approval_required");
		await revise(env, id, principal(hermesToken), { html: "<p>v2</p>" }, { injectionSuspected: true });
		expect(approvals.getApproval(ctx, id)!.reason).toBe("injection_suspected");
		await revise(env, id, principal(hermesToken), { html: "<p>v3</p>" });
		expect(approvals.getApproval(ctx, id)!.reason).toBe("injection_suspected");
	});

	it("a reviewer edit is recorded as such", async () => {
		const { env } = makeEnv({}, deliveryStub);
		const id = await holdOne(env);
		await editHeld({ env, mailboxId: MB, id, edits: { subject: "Fixed" }, verify });
		expect(approvals.getApproval(ctx, id)).toMatchObject({ revision: 2, revisedBy: "reviewer" });
	});

	it("isRequester compares the token, the OAuth app, or (for the in-app agent) the user", () => {
		const actor = { user: "owner@tapetide.com", via: "mcp" as const, method: "token" as const, tokenId: "tokHermes0001" };
		expect(isRequester(principal(hermesToken), actor, "mcp")).toBe(true);
		expect(isRequester(principal(trustedToken), actor, "mcp")).toBe(false);
		const app = { user: "owner@tapetide.com", via: "mcp" as const, method: "oauth" as const, oauthClientId: "c1" };
		expect(isRequester(principal({ method: "oauth", oauthClientId: "c1", sendAuto: false }), app, "mcp")).toBe(true);
		expect(isRequester(principal({ method: "oauth", oauthClientId: "c2", sendAuto: false }), app, "mcp")).toBe(false);
		const agent = { user: "owner@tapetide.com", via: "agent" as const, method: "session" as const };
		expect(isRequester(session(), agent, "agent")).toBe(true);
		expect(isRequester(session(), agent, "api")).toBe(false);
	});
});

describe("classifySendFailure", () => {
	it("only definite pre-acceptance codes are rejections", () => {
		expect(classifySendFailure(Object.assign(new Error("x"), { code: "E_VALIDATION_ERROR" }))).toBe("rejected");
		expect(classifySendFailure(Object.assign(new Error("x"), { code: "E_DELIVERY_FAILED" }))).toBe("unconfirmed");
		expect(classifySendFailure(new Error("socket hang up"))).toBe("unconfirmed");
		expect(classifySendFailure("weird")).toBe("unconfirmed");
	});
});

describe("rejectHeld", () => {
	it("rejects without sending, and cannot then be approved", async () => {
		const { env, bucket: b } = makeEnv({}, deliveryStub);
		const id = await holdOne(env);
		const rejected = await rejectHeld({ env, mailboxId: MB, id, approver: session(), note: "wrong customer" });
		expect(rejected.ok).toBe(true);
		expect(approvals.getApproval(ctx, id)).toMatchObject({ status: "rejected", error: "wrong customer" });
		const send = provider();
		expect(await approveHeld({ env, mailboxId: MB, id, approver: session(), enroll, deps: useDeps(env, send) })).toMatchObject({ ok: false, status: 409 });
		expect(send).not.toHaveBeenCalled();
		expect(auditEntries(b).some((e) => e.action === "approval.reject")).toBe(true);
	});

	it("reports a second reject as already decided", async () => {
		const { env } = makeEnv({}, deliveryStub);
		const id = await holdOne(env);
		await rejectHeld({ env, mailboxId: MB, id, approver: session() });
		expect(await rejectHeld({ env, mailboxId: MB, id, approver: session() })).toMatchObject({ ok: false, status: 409 });
	});
});

describe("approvals store", () => {
	it("counts only live pending items", () => {
		approvals.createApproval(ctx, { kind: "send_email", reason: "approval_required", recipients: ["a@x.com"], subject: "s", payload: {}, actor: { user: null, via: "mcp", method: null } });
		const old = approvals.createApproval(ctx, { kind: "send_email", reason: "approval_required", recipients: ["b@x.com"], subject: "s", payload: {}, actor: { user: null, via: "mcp", method: null }, now: 1 });
		expect(approvals.countPendingApprovals(ctx)).toBe(1);
		approvals.sweepApprovals(ctx);
		expect(approvals.getApproval(ctx, old.id)).toBeNull();
	});
});
